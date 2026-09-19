#!/usr/bin/env node
/**
 * runner.mjs — reze 出片编排器（零外部依赖：node 内置 + 全局 fetch/WebSocket）
 *
 * 用法：
 *   node runner.mjs status  --spec '{"config":{...}}'
 *   node runner.mjs preview --spec '{"config":{...},"opts":{...}}'
 *   node runner.mjs render  --spec '{"config":{...},"opts":{...}}'
 *
 * stdout 最后一行 = 单个 JSON（工具层解析）；过程日志走 stderr。
 * 退出码：0 = 成功且判据通过；1 = 失败（JSON 里带 error）。
 *
 * 关键事实（写死在实现里，别删）：
 *   · 无头浏览器必须 --no-sandbox，否则 navigator.gpu 不存在（WebGPU 拿不到 adapter）
 *   · CDP 导航后立刻读页面状态可能读到上一页 ⇒ 用 t=<时间戳> 对表
 *   · setCameraTarget 传数组会走 Model 重载并崩 ⇒ 出帧页只用数值机位旋钮
 */
import { spawn } from "node:child_process"
import { createServer } from "node:http"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, extname, join, normalize, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const HERE = dirname(fileURLToPath(import.meta.url))
const PAGE_DIR = join(HERE, "page")
const BUNDLE = join(HERE, "engine", "reze-engine.js")

const log = (...a) => console.error("[runner]", ...a)
const argv = process.argv.slice(2)
const MODE = argv[0]
// --spec（内联 JSON，供插件 spawn 用）或 --spec-file（路径，供手工测试用——PowerShell 会吃掉内联引号）
const specFile = argv.includes("--spec-file") ? argv[argv.indexOf("--spec-file") + 1] : null
const specArg = argv.includes("--spec") ? argv[argv.indexOf("--spec") + 1] : null
const SPEC = specFile ? JSON.parse(readFileSync(specFile, "utf8")) : specArg ? JSON.parse(specArg) : {}
const CFG = SPEC.config || {}
const OPTS = SPEC.opts || {}

const DEFAULTS = {
  chromePath: "C:/Program Files/Google/Chrome/Application/chrome.exe",
  ffmpegPath: "ffmpeg",
  ffprobePath: "ffprobe",
  assetRoot: "",
  outDir: "",
}
const conf = { ...DEFAULTS, ...CFG }

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".png": "image/png", ".jpg": "image/jpeg", ".bmp": "image/bmp", ".tga": "application/octet-stream",
  ".pmx": "application/octet-stream", ".vmd": "application/octet-stream", ".dds": "application/octet-stream",
  ".json": "application/json; charset=utf-8",
}

// ─────────────────────────── 小工具 ───────────────────────────
const run = (cmd, args, opts = {}) => new Promise((res) => {
  const p = spawn(cmd, args, { windowsHide: true, ...opts })
  let out = "", err = ""
  p.stdout?.on("data", (d) => (out += d))
  p.stderr?.on("data", (d) => (err += d))
  p.on("error", (e) => res({ code: -1, out, err: String(e) }))
  p.on("close", (code) => res({ code, out, err }))
})
const exists = (p) => { try { return !!p && existsSync(p) } catch { return false } }
const listFiles = (root, sub, ext) => {
  const base = join(root, sub)
  const out = []
  const walk = (d) => {
    if (!exists(d)) return
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name)
      if (e.isDirectory()) walk(p)
      else if (extname(e.name).toLowerCase() === ext) out.push(relative(root, p).split(sep).join("/"))
    }
  }
  walk(base)
  return out.sort()
}
const finish = (obj, code = 0) => { console.log(JSON.stringify(obj)); process.exit(code) }
const fail = (error, extra = {}) => finish({ ok: false, error, ...extra }, 1)

// ─────────────────────────── status ───────────────────────────
async function status() {
  const chrome = exists(conf.chromePath)
  const ff = await run(conf.ffmpegPath, ["-version"])
  const fp = await run(conf.ffprobePath, ["-version"])
  const bundle = exists(BUNDLE)
  const assetRoot = conf.assetRoot && exists(conf.assetRoot) ? resolve(conf.assetRoot) : ""
  const models = assetRoot ? listFiles(assetRoot, "models", ".pmx") : []
  const motions = assetRoot ? listFiles(assetRoot, "animations", ".vmd") : []
  const ready = chrome && ff.code === 0 && bundle && !!assetRoot
  finish({
    ok: true, ready,
    node: process.version,
    chrome: chrome ? conf.chromePath : null,
    ffmpeg: ff.code === 0 ? (ff.out.split("\n")[0] || conf.ffmpegPath).trim() : null,
    ffprobe: fp.code === 0,
    bundle: bundle ? BUNDLE : null,
    assetRoot: assetRoot || null,
    models, motions,
    missing: [!chrome && "chrome", ff.code !== 0 && "ffmpeg", !bundle && "engine-bundle", !assetRoot && "assetRoot"].filter(Boolean),
  })
}

// ─────────────────────────── 服务器 + 浏览器 + CDP ───────────────────────────
function startServer({ framesDir, assetRoot }) {
  const state = { frames: 0, done: false, errors: [], log: [] }
  return new Promise((resolvePromise) => {
    const srv = createServer((req, res) => {
      const url = new URL(req.url, "http://127.0.0.1")
      const send = (code, type, body) => { res.writeHead(code, { "content-type": type, "cache-control": "no-store" }); res.end(body) }
      const readBody = () => new Promise((r) => { const c = []; req.on("data", (d) => c.push(d)); req.on("end", () => r(Buffer.concat(c))) })
      ;(async () => {
        try {
          if (req.method === "POST" && url.pathname === "/frame") {
            const name = (url.searchParams.get("name") || "f.png").replace(/[^\w.\-]/g, "")
            const body = await readBody()
            writeFileSync(join(framesDir, name), body)
            state.frames++
            return send(200, "text/plain", "ok")
          }
          if (req.method === "POST" && url.pathname === "/done") { state.done = true; log("page DONE " + (await readBody()).toString().slice(0, 200)); return send(200, "text/plain", "ok") }
          if (req.method === "POST" && url.pathname === "/log") { state.log.push((await readBody()).toString().slice(0, 300)); return send(200, "text/plain", "ok") }
          if (req.method === "POST" && url.pathname === "/error") { state.errors.push((await readBody()).toString().slice(0, 1500)); return send(200, "text/plain", "ok") }
          if (url.pathname === "/status") return send(200, "application/json", JSON.stringify(state))

          let p = decodeURIComponent(url.pathname)
          if (p === "/") p = "/index.html"
          let file
          if (p.startsWith("/media/")) {
            file = normalize(join(assetRoot, p.slice("/media/".length)))
            if (assetRoot && !file.startsWith(normalize(assetRoot))) return send(403, "text/plain", "forbidden")
          } else if (p === "/reze-engine.js") {
            file = BUNDLE
          } else {
            file = normalize(join(PAGE_DIR, p))
            if (!file.startsWith(normalize(PAGE_DIR))) return send(403, "text/plain", "forbidden")
          }
          if (!exists(file) || statSync(file).isDirectory()) return send(404, "text/plain", "404")
          return send(200, MIME[extname(file).toLowerCase()] || "application/octet-stream", readFileSync(file))
        } catch (e) {
          state.errors.push(String(e))
          send(500, "text/plain", "500")
        }
      })()
    })
    srv.listen(0, "127.0.0.1", () => resolvePromise({ port: srv.address().port, state, close: () => srv.close() }))
  })
}

async function waitHttp(url, timeoutMs) {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(url); if (r.ok) return await r.json() } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 300))
  }
  return null
}

async function newTarget(cdpPort, url) {
  const endpoint = `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`
  for (const method of ["PUT", "GET"]) {                       // 新版 Chrome 只认 PUT
    try { const r = await fetch(endpoint, { method }); if (r.ok) return await r.json() } catch { /* try next */ }
  }
  return null
}

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl)
    let id = 0
    const pending = new Map()
    ws.addEventListener("open", () => res({
      evaluate: (expression, awaitPromise = true) => new Promise((ok, no) => {
        const mid = ++id
        pending.set(mid, { ok, no })
        ws.send(JSON.stringify({ id: mid, method: "Runtime.evaluate", params: { expression, awaitPromise, returnByValue: true } }))
      }),
      close: () => ws.close(),
    }))
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data)
      const p = pending.get(msg.id)
      if (!p) return
      pending.delete(msg.id)
      if (msg.error) p.no(new Error(msg.error.message))
      else p.ok(msg.result?.result?.value)
    })
    ws.addEventListener("error", (e) => rej(new Error("ws error " + String(e?.message || e))))
  })
}

// ─────────────────────────── preview / render ───────────────────────────
async function shoot(mode) {
  const t0 = Date.now()
  if (!exists(conf.chromePath)) return fail("browser-launch", { detail: "chrome 不在：" + conf.chromePath })
  if (!exists(BUNDLE)) return fail("engine-bundle-missing", { detail: BUNDLE })
  if (!conf.assetRoot || !exists(conf.assetRoot)) return fail("asset-missing", { detail: "assetRoot 不可读：" + (conf.assetRoot || "(未配置)") })

  const model = OPTS.model || ""
  const motion = OPTS.motion || ""
  if (!model || !exists(join(conf.assetRoot, model))) return fail("asset-missing", { detail: "model 不存在：" + model })
  if (motion && !exists(join(conf.assetRoot, motion))) return fail("asset-missing", { detail: "motion 不存在：" + motion })

  const runId = new Date().toISOString().replace(/[:.]/g, "-")
  const outDir = resolve(conf.outDir || join(tmpdir(), "reze-render"))
  const runDir = join(outDir, "runs", runId)
  const framesDir = join(runDir, "frames")
  mkdirSync(framesDir, { recursive: true })

  const width = OPTS.width || 960
  const height = OPTS.height || 540
  const fps = OPTS.fps || 30
  const tag = String(Date.now())

  const srv = await startServer({ framesDir, assetRoot: resolve(conf.assetRoot) })
  const cdpPort = 9300 + Math.floor(Math.random() * 400)
  const profile = mkdtempSync(join(tmpdir(), "reze-profile-"))
  const chromeArgs = [
    "--headless=new", "--enable-unsafe-webgpu", "--no-sandbox", "--disable-gpu-sandbox",
    `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--no-default-browser-check", "--disable-extensions", "--mute-audio",
    `--window-size=${width},${height}`, "about:blank",
  ]
  const chrome = spawn(conf.chromePath, chromeArgs, { windowsHide: true, stdio: "ignore" })
  const cleanup = () => {
    try { srv.close() } catch { /* ignore */ }
    try { spawn("taskkill", ["/PID", String(chrome.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }) } catch { /* ignore */ }
    try { rmSync(profile, { recursive: true, force: true }) } catch { /* ignore */ }
  }

  try {
    if (!(await waitHttp(`http://127.0.0.1:${cdpPort}/json/version`, 20000))) return fail("browser-launch", { detail: "CDP 未就绪" })

    const q = new URLSearchParams({
      mode, t: tag,
      model: OPTS.modelName || "model", pmx: "/media/" + model,
      stage: OPTS.stage ? "/media/" + OPTS.stage : "",
      vmd: motion ? "/media/" + motion : "",
      w: String(width), h: String(height), fps: String(fps),
      seconds: String(OPTS.seconds || 8), warmup: String(OPTS.warmup ?? 45), start: String(OPTS.start || 0),
      distance: String(OPTS.distance ?? 36), alpha: String(OPTS.alpha ?? 0), beta: String(OPTS.beta ?? 0),
      bg: (OPTS.bg || "0.09,0.10,0.14"),
      distances: (OPTS.distances || []).join(","),
    })
    const pageUrl = `http://127.0.0.1:${srv.port}/?${q.toString()}`
    const target = await newTarget(cdpPort, pageUrl)
    if (!target?.webSocketDebuggerUrl) return fail("browser-launch", { detail: "拿不到页面 target" })

    const page = await connect(target.webSocketDebuggerUrl)
    const budgetMs = Math.max(60000, (OPTS.seconds || 8) * fps * 1200)
    const tWait = Date.now()
    let st = null
    while (Date.now() - tWait < budgetMs) {
      const v = await page.evaluate(`(() => { const s = window.__reze; return s ? { phase: s.phase, t: s.t, frames: s.frames, total: s.total, error: s.error || null, log: s.log.slice(-4) } : null })()`)
      if (v && v.t === tag) {
        st = v
        if (v.phase === "done" || v.phase === "error") break
      }
      await new Promise((r) => setTimeout(r, 700))
    }
    page.close()

    if (!st) return fail("render-aborted", { detail: "页面无对表成功的状态（可能没导航成功）", framesOnDisk: srv.state.frames })
    if (st.phase === "error") return fail("render-aborted", { detail: st.error, framesOnDisk: srv.state.frames, pageLog: st.log })

    const pngs = readdirSync(framesDir).filter((f) => f.endsWith(".png")).sort()
    if (!pngs.length) return fail("render-aborted", { detail: "零帧落盘", pageLog: st.log })

    if (mode === "preview" || mode === "sheet") {
      const shots = pngs.map((f) => {
        const p = join(framesDir, f)
        return { file: p, name: f, bytes: statSync(p).size }
      })
      return finish({
        ok: true, mode, runDir, shots,
        count: shots.length, distinctSizes: new Set(shots.map((s) => s.bytes)).size,
        elapsedMs: Date.now() - t0, pageLog: srv.state.log.slice(-6),
      })
    }

    // render → 编码 + 判据
    const outName = (OPTS.outName || "reze-mmd") + ".mp4"
    const outMp4 = join(runDir, outName)
    const encArgs = ["-y", "-hide_banner", "-loglevel", "error", "-framerate", String(fps),
      "-i", join(framesDir, "%04d.png"), "-c:v", "libx264", "-preset", "medium",
      "-crf", String(OPTS.crf ?? 18), "-pix_fmt", "yuv420p", "-movflags", "+faststart", outMp4]
    const enc = await run(conf.ffmpegPath, encArgs)
    if (enc.code !== 0 || !exists(outMp4)) return fail("encode", { detail: (enc.err || "").split("\n").slice(-4).join(" | ") })

    const probe = await run(conf.ffprobePath, ["-v", "error", "-select_streams", "v:0",
      "-show_entries", "stream=width,height,r_frame_rate,nb_frames,codec_name:format=duration,size",
      "-of", "json", outMp4])
    let meta = {}
    try { meta = JSON.parse(probe.out) } catch { meta = {} }
    const s0 = meta.streams?.[0] || {}
    const duration = Number(meta.format?.duration || 0)
    const bytes = Number(meta.format?.size || statSync(outMp4).size)

    // 帧间变化：framemd5 去重（=1 说明整片静止）
    const md5 = await run(conf.ffmpegPath, ["-v", "error", "-i", outMp4, "-f", "framemd5", "-"])
    const hashes = md5.out.split("\n").filter((l) => l && !l.startsWith("#")).map((l) => l.split(",").pop().trim())
    const distinct = new Set(hashes).size
    const variety = hashes.length ? distinct / hashes.length : 0

    const expected = (OPTS.seconds || 8) * fps
    const okDuration = Math.abs(duration - expected / fps) <= 1 / fps + 0.02
    const pass = variety > 0.5 && okDuration && bytes > 10000

    finish({
      ok: pass, mode: "render", video: outMp4, runDir,
      frames: pngs.length, expectedFrames: expected,
      width: s0.width, height: s0.height, duration, fps: s0.r_frame_rate, codec: s0.codec_name,
      bytes, frameVariety: Number(variety.toFixed(3)), distinctFrames: distinct,
      elapsedMs: Date.now() - t0,
      pageLog: srv.state.log.slice(-6),
      checks: { durationMatches: okDuration, moving: variety > 0.5, nonTrivialSize: bytes > 10000 },
    }, pass ? 0 : 1)
  } finally {
    cleanup()
  }
}

// ─────────────────────────── main ───────────────────────────
try {
  if (MODE === "status") await status()
  else if (MODE === "preview" || MODE === "sheet" || MODE === "render") await shoot(MODE)
  else fail("usage", { detail: "用法：runner.mjs status|preview|sheet|render --spec <json>" })
} catch (e) {
  fail("unexpected", { detail: String((e && e.stack) || e) })
}
