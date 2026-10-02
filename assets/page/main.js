// reze 出帧页（由 runner 通过 CDP 导航并轮询 window.__reze）
// 参数全部走 URL；帧用 canvas.toBlob → POST /frame 落盘（**不经过任何会话上下文**）
import { Engine, Vec3, Quat } from "/reze-engine.js"

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
// 第二舞台槽位（2026-10-01）：普查发现 13 个户外舞台必须「地形 + sky」配套
//   （動く荒野 + 動く荒野sky / 動く海 + 動く海用sky / 自動高速道路 + sky / IceCreamTruck + SkyBox_*…）
//   单槽位时这些舞台背景是空的 ⇒ 补一个 stage2。
const STAGE2 = q.get("stage2") || ""
const VMD = q.get("vmd") || ""
// ★ 多角色同台（2026-10-01 新增）：第二具名槽位 "model2"。
//   引擎的模型是**具名实例**（loadModel(name, path)），名字冲突会自动加后缀 _1，
//   所以两个角色、外加 stage，三个槽位互不干扰。位置用根变换（setPosition）错开。
const MODEL2 = q.get("model2") || ""
const VMD2_RAW = q.get("vmd2") || "" // 缺省 = 与主角色同动作（群舞摆法）
const M2X = num("model2x", 0)
const M2Y = num("model2y", 0)
const M2Z = num("model2z", 0)
const M2RY = num("model2ry", 0) // 绕 Y 旋转（度）：让两人相对而立
const M2SCALE = num("model2scale", 1) // 不同模型身高差可直接观察；需要修正时用这个
// 主模型的根变换（2026-10-01）：让阵列布位对称——否则主模型永远钉在原点。
const M1X = num("modelX", 0)
const M1Y = num("modelY", 0)
const M1Z = num("modelZ", 0)
const M1RY = num("modelRy", 0)
const M1SCALE = num("modelScale", 1)
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
// 构图三轴扫描（2026-10-01 扩展）：alpha=环绕角 · beta=俯仰（直接决定画面下部地面占比）
//   · targetY=相机注视高度。三者独立，可分别扫。
const BETAS = (q.get("betas") || "").split(",").filter(Boolean).map((v) => Number(v) * D2R)
const TARGET_YS = (q.get("targetYs") || "").split(",").filter(Boolean).map(Number)

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

// 模型/舞台的**包围盒自证**（2026-10-01）：换舞台要重扫机位，但「这舞台多大」不该靠肉眼试。
//   顶点布局（引擎 mainPipeline 的 vertexBufferLayout）：arrayStride = 8 float，
//   位置 float32x3 在 offset 0 ⇒ 每 8 个 float 一个顶点，前 3 个是 x,y,z（模型空间绑定位）。
//   舞台无蒙皮 ⇒ 绑定位即实际尺寸；角色是绑定姿势尺寸（够用）。
const bbox = (m) => {
  try {
    const v = m.getVertices()
    if (!v || !v.length) return null
    let mnx = Infinity, mxx = -Infinity, mny = Infinity, mxy = -Infinity, mnz = Infinity, mxz = -Infinity
    for (let i = 0; i + 2 < v.length; i += 8) {
      const x = v[i], y = v[i + 1], z = v[i + 2]
      if (x < mnx) mnx = x; if (x > mxx) mxx = x
      if (y < mny) mny = y; if (y > mxy) mxy = y
      if (z < mnz) mnz = z; if (z > mxz) mxz = z
    }
    if (!isFinite(mnx)) return null
    const f = (n) => Math.round(n * 100) / 100
    return `w=${f(mxx - mnx)} h=${f(mxy - mny)} d=${f(mxz - mnz)} minY=${f(mny)} maxY=${f(mxy)}`
  } catch (e) {
    return null
  }
}
const logBox = (what, m) => {
  const b = bbox(m)
  if (b) log(`bbox ${what}: ${b}`)
}

// ★ 后处理/光照探查（2026-10-02）：**不读源码猜参数形状——让引擎自己报默认值**。
//   URL 加 probe=1 ⇒ 把各 getter 的结果打进日志。形状确定后再用 postfx 施加补丁。
//   引擎公开面（实测导出）：setBloomOptions / setColorGrading / setViewTransformOptions /
//   setDepthOfField / setFilmGrain / setWorld / setSun / setLights / setGroundMirror /
//   setWorldEquirect(HDR) / setBackdropEquirect / setGroundVisible…
const PROBE = q.get("probe") === "1"
const probe = (name, fn) => {
  try {
    const v = fn()
    if (v === undefined) return log(`probe ${name}: undefined`)
    const s = JSON.stringify(v)
    log(`probe ${name}: ${s && s.length > 950 ? s.slice(0, 950) + "…" : s}`)
  } catch (e) {
    log(`probe ${name} FAILED: ` + String((e && e.message) || e))
  }
}

// ★ 后处理/光照补丁（2026-10-02）：形状由 probe 实测得到（**不猜**）。
//   URL postfx = JSON，键即开关；缺的键不动。引擎默认值极保守——
//   bloom.intensity 只有 0.05（泛光几乎关着）· dof.enabled=false · filmGrain=0 · exposure=0.6。
//   施加后**回读自证**（setXxx 是 patch 语义还是整体替换，靠回读裁决，不靠假设）。
const POSTFX = (() => {
  try {
    const raw = q.get("postfx")
    const o = raw ? JSON.parse(raw) : {}
    return o && typeof o === "object" ? o : {}
  } catch (e) {
    log("postfx JSON 解析失败（忽略）: " + String((e && e.message) || e))
    return {}
  }
})()
const POSTFX_ON = Object.keys(POSTFX).length > 0

try {
  const engine = new Engine(canvas, { background: BG })
  await engine.init()
  log(`init ok ${W}x${H}`)

  if (PROBE) {
    probe("bloom", () => engine.getBloomOptions())
    probe("grading", () => engine.getColorGrading())
    probe("viewTransform", () => engine.getViewTransformOptions())
    probe("dof", () => engine.getDepthOfField())
    probe("world", () => engine.getWorld())
    probe("sun", () => engine.getSun())
    probe("worldLighting", () => engine.getWorldLighting())
    probe("lightCount", () => engine.getLightCount())
    probe("filmGrain", () => engine.getFilmGrain())
    probe("bodyFocus", () => engine.getModelBodyFocus?.())
    probe("cameraFov", () => engine.getCameraFov())
    probe("stats", () => engine.getStats())
  }

  // 施加后处理/光照补丁；每一步独立 try（一个键失败不影响其余），并回读自证
  if (POSTFX_ON) {
    const step = (name, fn) => {
      try { fn(); log(`postfx ${name}: applied`) }
      catch (e) { log(`postfx ${name} FAILED: ` + String((e && e.message) || e)) }
    }
    if (POSTFX.bloom) step("bloom", () => engine.setBloomOptions(POSTFX.bloom))
    if (POSTFX.grading) step("grading", () => engine.setColorGrading(POSTFX.grading))
    if (POSTFX.contrast !== undefined || POSTFX.saturation !== undefined) {
      step("contrast/saturation", () => engine.setColorGrading({
        ...(POSTFX.contrast !== undefined ? { contrast: POSTFX.contrast } : {}),
        ...(POSTFX.saturation !== undefined ? { saturation: POSTFX.saturation } : {}),
      }))
    }
    if (POSTFX.exposure !== undefined || POSTFX.gamma !== undefined || POSTFX.transform) {
      step("viewTransform", () => engine.setViewTransformOptions({
        ...(POSTFX.exposure !== undefined ? { exposure: POSTFX.exposure } : {}),
        ...(POSTFX.gamma !== undefined ? { gamma: POSTFX.gamma } : {}),
        ...(POSTFX.transform ? { transform: POSTFX.transform } : {}),
      }))
    }
    if (POSTFX.dof) step("dof", () => engine.setDepthOfField(POSTFX.dof))
    if (POSTFX.sun) step("sun", () => engine.setSun(POSTFX.sun))
    if (POSTFX.world) step("world", () => engine.setWorld(POSTFX.world))
    if (POSTFX.lights) step("lights", () => engine.setLights(POSTFX.lights))
    if (POSTFX.filmGrain !== undefined) step("filmGrain", () => engine.setFilmGrain(POSTFX.filmGrain))
    if (POSTFX.groundMirror) step("groundMirror", () => engine.setGroundMirror(!!POSTFX.groundMirror.on, POSTFX.groundMirror.blur))
    if (POSTFX.outline !== undefined) step("outline", () => engine.setOutlineEnabled(!!POSTFX.outline))
    if (POSTFX.groundVisible !== undefined) step("groundVisible", () => engine.setGroundVisible(!!POSTFX.groundVisible))
    if (POSTFX.cameraFov !== undefined) step("cameraFov", () => engine.setCameraFov(POSTFX.cameraFov))
    if (POSTFX.cameraRoll !== undefined) step("cameraRoll", () => engine.setCameraRoll(POSTFX.cameraRoll))
    if (POSTFX.background) step("background", () => engine.setBackgroundColor(POSTFX.background))

    // 回读自证：patch 语义 vs 整体替换，靠读数裁决
    log("postfx readback bloom: " + JSON.stringify(engine.getBloomOptions()))
    log("postfx readback grading: " + JSON.stringify(engine.getColorGrading()))
    log("postfx readback viewTransform: " + JSON.stringify(engine.getViewTransformOptions()))
    log("postfx readback dof: " + JSON.stringify(engine.getDepthOfField()))
  }

  const model = await engine.loadModel(MODEL, PMX)
  await engine.autoStyleGroups(MODEL)
  // 主模型的根变换（与 extras 对称）：让阵列里任何一个人都能放到任意位置
  model.setPosition(new Vec3(M1X, M1Y, M1Z))
  if (M1RY) model.setRotation(Quat.fromAxisAngle(new Vec3(0, 1, 0), M1RY * D2R))
  if (M1SCALE !== 1) model.setScale(M1SCALE)
  log("model + style groups ok")
  logBox("model", model)

  // 舞台/背景：作为**第二个具名槽位**载入（静态，不挂动作）。
  // 载入失败**不视为致命**——角色照常出片，只是没有背景（fail-soft，且把原因写进日志）。
  if (STAGE) {
    try {
      const stageModel = await engine.loadModel("stage", STAGE)
      await engine.autoStyleGroups("stage")
      log("stage loaded: " + STAGE)
      logBox("stage", stageModel)
    } catch (e) {
      log("stage load FAILED（继续出角色）: " + String((e && e.message) || e))
    }
  }

  // 第二舞台（通常是配套的 sky / 天空盒）。失败同样不致命。
  if (STAGE2) {
    try {
      const stage2Model = await engine.loadModel("stage2", STAGE2)
      await engine.autoStyleGroups("stage2")
      log("stage2 loaded: " + STAGE2)
      logBox("stage2", stage2Model)
    } catch (e) {
      log("stage2 load FAILED（继续）: " + String((e && e.message) || e))
    }
  }

  if (VMD) {
    await model.loadVmd("motion", VMD)
    model.show("motion")
    model.play("motion")
    log("motion loaded")
  }

  // ★ 附加角色（多角色同台，2026-10-01）：`model2` 是单数简写，`extras` 是通用数组。
  //   引擎只有一个场景时钟（renderFrame(dt) 推进全部）⇒ 各路 VMD **天然同拍**，不需要对齐帧。
  //   根变换（setPosition/setRotation/setScale）与 VMD 的「センター」骨骼位移是**两套**，
  //   可叠加不打架。
  //   extras 走 URL JSON：[{"pmx":"models/…","vmd":"…","x":-16,"ry":0,"scale":1}, …]
  let EXTRAS = []
  try {
    const raw = q.get("extras")
    if (raw) EXTRAS = JSON.parse(raw)
    if (!Array.isArray(EXTRAS)) EXTRAS = []
  } catch (e) {
    EXTRAS = []
    log("extras JSON 解析失败（按无附加角色继续）: " + String((e && e.message) || e))
  }
  const cast = []
  if (MODEL2) {
    cast.push({ slot: "model2", pmx: MODEL2, vmd: VMD2_RAW, x: M2X, y: M2Y, z: M2Z, ry: M2RY, scale: M2SCALE })
  }
  EXTRAS.forEach((e, i) => cast.push({
    slot: "model" + (MODEL2 ? 3 + i : 2 + i),
    pmx: e.pmx, vmd: e.vmd || "",
    x: e.x || 0, y: e.y || 0, z: e.z || 0, ry: e.ry || 0, scale: e.scale || 1,
  }))
  const castOk = []
  for (const c of cast) {
    try {
      const m = await engine.loadModel(c.slot, c.pmx)
      await engine.autoStyleGroups(c.slot)
      m.setPosition(new Vec3(c.x, c.y, c.z))
      if (c.ry) m.setRotation(Quat.fromAxisAngle(new Vec3(0, 1, 0), c.ry * D2R))
      if (c.scale !== 1) m.setScale(c.scale)
      const cv = c.vmd || VMD
      if (cv) {
        await m.loadVmd("motion", cv)
        m.show("motion")
        m.play("motion")
      }
      castOk.push(c.slot)
      log(`${c.slot} ok: ${c.pmx} @(${c.x},${c.y},${c.z}) ry=${c.ry} scale=${c.scale} vmd=${cv || "(none)"}`)
    } catch (e) {
      log(`${c.slot} FAILED（跳过该角色，其余照常出片）: ` + String((e && e.message) || e))
    }
  }
  if (cast.length) log(`cast: ${castOk.length}/${cast.length} loaded [${castOk.join(",")}]`)
  // ★ 相机目标（2026-10-01）：治「画面下半是空地面」。
  //   引擎 setCameraTarget 有两种重载（**传 {x,y,z} 对象** 才是静态点；传数组会被 duck-typing
  //   当成 Model 重载而崩）：① `camTargetBone=<骨骼名>` ⇒ 相机**跟随该骨骼**（自动居中）
  //   ② `camTargetY=<高度>` ⇒ 静态目标点 (0, y, 0)。默认骨骼名是「全ての親」。
  const CAM_TARGET_BONE = q.get("camTargetBone") || ""
  const CAM_TARGET_Y = num("camTargetY", NaN)
  const CAM_TARGET_X = num("camTargetX", 0) // 双人同台时取两人中点
  const CAM_TARGET_Z = num("camTargetZ", 0)
  if (CAM_TARGET_BONE) {
    try {
      engine.setCameraTarget(model, CAM_TARGET_BONE)
      log("camera target bone: " + CAM_TARGET_BONE)
    } catch (e) {
      log("camera target bone FAILED: " + String((e && e.message) || e))
    }
  } else if (!Number.isNaN(CAM_TARGET_Y)) {
    try {
      engine.setCameraTarget({ x: CAM_TARGET_X, y: CAM_TARGET_Y, z: CAM_TARGET_Z })
      log(`camera target (${CAM_TARGET_X},${CAM_TARGET_Y},${CAM_TARGET_Z})`)
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
    const anySweep = DISTANCES.length || ALPHAS.length || BETAS.length || TARGET_YS.length
    const ds = DISTANCES.length ? DISTANCES : (anySweep ? [] : [30, 40, 50])
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
    // beta 扫描：俯仰角直接决定画面下部地面占比（beta→90° 相机与目标同高，地面最少）
    for (const b of BETAS) {
      if (DISTANCE) engine.setCameraDistance(DISTANCE)
      engine.setCameraBeta(b)
      for (let i = 0; i < 12; i++) engine.renderFrame(dt)
      await shot(`preview-b${b}.png`)
      S.frames++
      log("sheet beta=" + b)
    }
    // targetY 扫描：抬高注视点 ⇒ 画面内容下移 ⇒ 角色回到画面中央（治「脚下大片空地面」）
    for (const y of TARGET_YS) {
      if (DISTANCE) engine.setCameraDistance(DISTANCE)
      engine.setCameraTarget({ x: CAM_TARGET_X, y, z: CAM_TARGET_Z })
      for (let i = 0; i < 12; i++) engine.renderFrame(dt)
      await shot(`preview-y${y}.png`)
      S.frames++
      log("sheet targetY=" + y)
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
