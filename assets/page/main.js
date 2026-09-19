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
const DISTANCE = num("distance", 36)
const ALPHA = num("alpha", 0)
const BETA = num("beta", 0)
const BG = (q.get("bg") || "0.09,0.10,0.14").split(",").map(Number).slice(0, 3)
const DISTANCES = (q.get("distances") || "").split(",").filter(Boolean).map(Number)

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
  engine.setCameraDistance(DISTANCE)
  if (ALPHA) engine.setCameraAlpha(ALPHA)
  if (BETA) engine.setCameraBeta(BETA)

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
    const ds = DISTANCES.length ? DISTANCES : [30, 40, 50]
    for (const d of ds) {
      engine.setCameraDistance(d)
      for (let i = 0; i < 12; i++) engine.renderFrame(dt)   // 等相机插值收敛
      await shot(`preview-d${d}.png`)
      S.frames++
      log("sheet d=" + d)
    }
  } else {
    for (let i = 0; i < S.total; i++) {
      engine.renderFrame(dt)
      await shot(String(i).padStart(4, "0") + ".png")
      S.frames = i + 1
      if (i % 30 === 0) log(`frame ${i + 1}/${S.total}`)
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
