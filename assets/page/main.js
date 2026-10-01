// reze 出帧页（由 runner 通过 CDP 导航并轮询 window.__reze）
// 参数全部走 URL；帧用 canvas.toBlob → POST /frame 落盘（**不经过任何会话上下文**）
import { Engine } from "/reze-engine.js"

const q = new URLSearchParams(location.search)
const num = (k, d) => (q.get(k) !== null && q.get(k) !== "" ? Number(q.get(k)) : d)
const W = num("w", 960)
const H = num("h", 540)
const FPS = num("fps", 30)
const SECONDS = num("seconds", 8)
const WARMUP = num("warmup", 45)
const START = num("start", 0)
const MODE = q.get("mode") || "render"
const MODEL = q.get("model") || "model"
const PMX = q.get("pmx") || ""
const STAGE = q.get("stage") || ""
const VMD = q.get("vmd") || ""
// ★★ 单位（2026-10-01 实测确认）：引擎相机角一律**弧度** —— 见 Camera.getPosition()
//     x = target.x + radius*sin(beta)*sin(alpha) · y = target.y + radius*cos(beta)
//     ⇒ beta 是俯仰角：beta=0 ⇒ y=target.y+radius（**正上方**，且 alpha 完全失效 ⇒ 画面钉死）
//     默认 alpha=π(180°) · beta=π/2.5(72°)。
// ⇒ **对外参数一律用「度」**，在此统一转换，避免调用方踩弧度坑。
const D2R = Math.PI / 180
const DISTANCE = num("distance", 36)
const ALPHA = num("alpha", 0) * D2R
const BETA = num("beta", 0) * D2R
const BG = (q.get("bg") || "0.09,0.10,0.14").split(",").map(Number).slice(0, 3)
const DISTANCES = (q.get("distances") || "").split(",").filter(Boolean).map(Number)
const ALPHAS = (q.get("alphas") || "").split(",").filter(Boolean).map((v) => Number(v) * D2R)

// ── 相机关键帧（2026-10-01 爱丽丝新增）：让镜头动起来（推拉摇移）──────────────
// 三个轴各自独立，格式 "t:v,t:v" （t=秒, v=目标值）：
//   camDist=0:36,4:20,8:36   → 推近再拉回
//   camAlpha=0:0,8:35        → 水平环绕
//   camBeta=0:0,8:-18        → 俯仰
// 逐帧设值 + 引擎自带相机插值 ⇒ 得到平滑运动；warmup 已让相机收敛到初始值。
const parseCam = (s, scale = 1) => {
  if (!s) return null
  const kf = s.split(",")
    .map((p) => p.split(":").map(Number))
    .filter((a) => a.length === 2 && a.every((x) => !isNaN(x)))
    .map(([t, v]) => [t, v * scale]) // scale：角度轴传 D2R（度 → 弧度），距离轴传 1
  return kf.length ? kf : null
}
const camAt = (kf, t) => {
  if (!kf) return null
  if (t <= kf[0][0]) return kf[0][1]
  const last = kf[kf.length - 1]
  if (t >= last[0]) return last[1]
  for (let i = 0; i < kf.length - 1; i++) {
    const [t0, v0] = kf[i]
    const [t1, v1] = kf[i + 1]
    if (t >= t0 && t <= t1) {
      const u = t1 === t0 ? 1 : (t - t0) / (t1 - t0)
      return v0 + (v1 - v0) * (u * u * (3 - 2 * u)) // smoothstep：起止平滑
    }
  }
  return last[1]
}
const CAM_DIST = parseCam(q.get("camDist"))
const CAM_ALPHA = parseCam(q.get("camAlpha"), D2R) // 度 → 弧度
const CAM_BETA = parseCam(q.get("camBeta"), D2R) // 度 → 弧度
const CAM_USED = !!(CAM_DIST || CAM_ALPHA || CAM_BETA)
// 相机设置频率：实测每帧调用会冻结画面（见 render 循环内的注释）⇒ 默认每 5 帧设一次。
const CAM_EVERY = Math.max(1, Math.round(num("camEvery", 5)))

const canvas = document.getElementById("c")
canvas.width = W
canvas.height = H

const S = (window.__reze = {
  phase: "boot", t: q.get("t") || "", frames: 0,
  total: MODE === "render" ? Math.round(FPS * SECONDS) : 1,
  error: null, log: [],
})
const post = (p, body) => fetch(p, { method: "POST", body }).catch(() => {})
const log = (m) => { S.log.push(m); console.log("[reze] " + m); post("/log", m) }

try {
  const engine = new Engine(canvas, { background: BG })
  await engine.init()
  log(`init ok ${W}x${H}`)

  const model = await engine.loadModel(MODEL, PMX)
  await engine.autoStyleGroups(MODEL)
  log("model + style groups ok")

  // 舞台/背景：作为**第二个具名槽位**载入（静态，不挂动作）。
  // 载入失败**不视为致命**——角色照常出片，只是没有背景（fail-soft，且把原因写进日志）。
  if (STAGE) {
    try {
      await engine.loadModel("stage", STAGE)
      await engine.autoStyleGroups("stage")
      log("stage loaded: " + STAGE)
    } catch (e) {
      log("stage load FAILED（继续出角色）: " + String((e && e.message) || e))
    }
  }

  if (VMD) {
    await model.loadVmd("motion", VMD)
    model.show("motion")
    model.play("motion")
    log("motion loaded")
  }
  // ★ 相机目标（2026-10-01）：治「画面下半是空地面」。
  //   引擎 setCameraTarget 有两种重载（**传 {x,y,z} 对象** 才是静态点；传数组会被 duck-typing
  //   当成 Model 重载而崩）：① `camTargetBone=<骨骼名>` ⇒ 相机**跟随该骨骼**（自动居中）
  //   ② `camTargetY=<高度>` ⇒ 静态目标点 (0, y, 0)。默认骨骼名是「全ての親」。
  const CAM_TARGET_BONE = q.get("camTargetBone") || ""
  const CAM_TARGET_Y = num("camTargetY", NaN)
  if (CAM_TARGET_BONE) {
    try {
      engine.setCameraTarget(model, CAM_TARGET_BONE)
      log("camera target bone: " + CAM_TARGET_BONE)
    } catch (e) {
      log("camera target bone FAILED: " + String((e && e.message) || e))
    }
  } else if (!Number.isNaN(CAM_TARGET_Y)) {
    try {
      engine.setCameraTarget({ x: 0, y: CAM_TARGET_Y, z: 0 })
      log("camera target y=" + CAM_TARGET_Y)
    } catch (e) {
      log("camera target y FAILED: " + String((e && e.message) || e))
    }
  }

  engine.setCameraDistance(DISTANCE)
  if (ALPHA) engine.setCameraAlpha(ALPHA)
  if (BETA) engine.setCameraBeta(BETA)

  // ★★ 专业相机轨道（2026-10-01 新增）：动作包里常带作者配好的镜头 VMD
  //    （CameraMotion.vmd / Camera0 カメラワーク.vmd / …）。引擎原生支持：
  //    loadCameraVmd(url) ⇒ cameraVmdEnabled=true ⇒ refreshCameraDrive()
  //    优先级：外部 pose > VMD track > orbit ⇒ 加载后上面的 orbit 参数自动让位。
  const CAM_VMD = q.get("camVmd") || ""
  if (CAM_VMD) {
    try {
      await engine.loadCameraVmd("/media/" + CAM_VMD)
      log("camera vmd loaded: " + CAM_VMD + " (has=" + String(!!engine.hasCameraVmd?.()) + ")")
    } catch (e) {
      log("camera vmd load FAILED（回退 orbit）: " + String((e && e.message) || e))
    }
  }

  // ★ 关键（2026-10-01 实测根因）：CAM 的**初始值必须在这里就应用**，好让后面的 warmup
  // 45 帧把相机插值收敛到起点。否则相机会从默认 alpha=π（180°，舞台背面）出发，
  // 而插值速度有限 ⇒ 整个 8 秒都在"半路"，画面落在空区（表现为全黑/怪角度）。
  if (CAM_USED) {
    const d0 = camAt(CAM_DIST, START)
    if (d0 !== null) engine.setCameraDistance(d0)
    const a0 = camAt(CAM_ALPHA, START)
    if (a0 !== null) engine.setCameraAlpha(a0)
    const b0 = camAt(CAM_BETA, START)
    if (b0 !== null) engine.setCameraBeta(b0)
  }

  const dt = 1 / FPS
  const warm = WARMUP + (MODE === "render" ? Math.round(START * FPS) : 0)
  for (let i = 0; i < warm; i++) engine.renderFrame(dt)

  const shot = async (name) => {
    const blob = await new Promise((r) => canvas.toBlob(r, "image/png"))
    if (!blob) throw new Error("toBlob null")
    const resp = await fetch(`/frame?name=${name}`, { method: "POST", body: blob })
    if (!resp.ok) throw new Error("frame POST " + resp.status)
  }

  S.phase = "rendering"
  if (MODE === "preview") {
    await shot("preview.png")
    S.frames = 1
  } else if (MODE === "sheet") {
    // 2026-10-01 扩展：除 distances 外，还可扫 alpha（alphas）—— 用于**先找"好看区"再设计动画**。
    // 教训来源：盲设相机动线两版都只有 1 帧好看，且好看的那帧还不在同一处。
    const ds = DISTANCES.length ? DISTANCES : (ALPHAS.length ? [] : [30, 40, 50])
    for (const d of ds) {
      engine.setCameraDistance(d)
      for (let i = 0; i < 12; i++) engine.renderFrame(dt)   // 等相机插值收敛
      await shot(`preview-d${d}.png`)
      S.frames++
      log("sheet d=" + d)
    }
    for (const a of ALPHAS) {
      if (DISTANCE) engine.setCameraDistance(DISTANCE)
      engine.setCameraAlpha(a)
      for (let i = 0; i < 12; i++) engine.renderFrame(dt)
      await shot(`preview-a${a}.png`)
      S.frames++
      log("sheet alpha=" + a)
    }
  } else {
    for (let i = 0; i < S.total; i++) {
      // ⚠ 实测教训（2026-10-01）：**每帧**调用 setCameraXxx 会冻结画面
      // （恒定相机参数下 distinctFrames=1、moving=false、240 帧全同 —— 连角色动作都不推进）。
      // ⇒ 改为**每 CAM_EVERY 帧设一次**，帧间的平滑交给引擎自带的相机插值。
      if (CAM_USED && i % CAM_EVERY === 0) {
        const tSec = (START * FPS + i) / FPS
        const d = camAt(CAM_DIST, tSec)
        if (d !== null) engine.setCameraDistance(d)
        const a = camAt(CAM_ALPHA, tSec)
        if (a !== null) engine.setCameraAlpha(a)
        const b = camAt(CAM_BETA, tSec)
        if (b !== null) engine.setCameraBeta(b)
      }
      engine.renderFrame(dt)
      await shot(String(i).padStart(4, "0") + ".png")
      S.frames = i + 1
      if (i % 30 === 0) {
        // 相机自证据：把引擎里**实际**的相机值打进日志（用于诊断"半天不到目标"这类问题）
        let camInfo = ""
        if (CAM_USED) {
          try {
            const cd = engine.getCameraDistance?.()
            const ca = engine.getCameraAlpha?.()
            const cb = engine.getCameraBeta?.()
            const fmt = (x) => (typeof x === "number" ? x.toFixed(1) : String(x))
            camInfo = ` | cam d=${fmt(cd)} a=${fmt(ca)} b=${fmt(cb)}`
          } catch (e) {
            camInfo = " | cam read failed"
          }
        }
        log(`frame ${i + 1}/${S.total}${camInfo}`)
      }
    }
  }
  S.phase = "done"
  log("ALL DONE " + S.frames)
  await fetch("/done", { method: "POST", body: JSON.stringify({ frames: S.frames, mode: MODE, w: W, h: H, fps: FPS }) })
} catch (e) {
  S.phase = "error"
  S.error = String((e && e.stack) || e)
  console.error(e)
  await post("/error", S.error)
}
