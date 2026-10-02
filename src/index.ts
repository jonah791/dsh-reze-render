/**
 * dsh-reze-render：用 reze-engine 离线出 MMD 视频 / 静帧
 *
 * 把「临时出片脚本」变成插件工具的三件套：
 *   reze_status  —— 这台机器现在能不能出片、手里有哪些料（浏览器/ffmpeg/引擎 bundle/资产根）
 *   reze_preview —— 出一张静帧（或一次出多机位候选）看机位与光照
 *   reze_render  —— 出一段视频，并返回**现算的判据读数**（帧数/时长/分辨率/帧间变化/体积）
 *
 * 语义文档：docs/semantic.md（v0.1.0）—— 本文件是它的实现落点。
 * 编排细节全部在 assets/runner.mjs（零外部依赖：node 内置 + 全局 fetch/WebSocket）。
 * 关键事实：无头浏览器必须 `--no-sandbox` 才有 WebGPU；帧数据走本地 HTTP 落盘，**不进模型上下文**。
 */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'reze-render'
export const inject = ['tools'] as const

export interface Config {
  enabled?: boolean
  /** 资产根：其下需有 models/**\/*.pmx 与 animations/*.vmd（第三方素材，不入版本管理） */
  assetRoot?: string
  /** 产物目录（默认 系统临时目录/reze-render） */
  outDir?: string
  chromePath?: string
  ffmpegPath?: string
  ffprobePath?: string
}
export const Config = z.object({
  enabled: z.boolean().default(true),
  assetRoot: z.string().required(false),
  outDir: z.string().required(false),
  chromePath: z.string().required(false),
  ffmpegPath: z.string().required(false),
  ffprobePath: z.string().required(false),
})

const HERE = dirname(fileURLToPath(import.meta.url))          // <plugin>/lib
const PLUGIN_ROOT = join(HERE, '..')
const RUNNER = join(PLUGIN_ROOT, 'assets', 'runner.mjs')

interface RunnerResult {
  ok: boolean
  error?: string
  [k: string]: unknown
}

/** 调 runner（子进程），解析它 stdout 最后一行 JSON。 */
function runRunner(
  ctx: Context,
  mode: 'status' | 'preview' | 'sheet' | 'render',
  opts: Record<string, unknown>,
  cfg: Config,
  timeoutMs: number,
): Promise<RunnerResult> {
  const spec = JSON.stringify({
    config: {
      assetRoot: cfg.assetRoot ?? '',
      outDir: cfg.outDir ?? '',
      chromePath: cfg.chromePath ?? undefined,
      ffmpegPath: cfg.ffmpegPath ?? undefined,
      ffprobePath: cfg.ffprobePath ?? undefined,
    },
    opts,
  })
  return new Promise((resolve) => {
    if (!existsSync(RUNNER)) {
      resolve({ ok: false, error: 'runner-missing', detail: RUNNER })
      return
    }
    const child = spawn(process.execPath, [RUNNER, mode, '--spec', spec], { windowsHide: true })
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolve({ ok: false, error: 'timeout', detail: `${timeoutMs}ms 内未完成` })
    }, timeoutMs)
    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => {
      err += d
      if (err.length > 20000) err = err.slice(-20000)
    })
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, error: 'spawn', detail: String(e) }) })
    child.on('close', () => {
      clearTimeout(timer)
      const line = out.trim().split('\n').filter(Boolean).pop() ?? ''
      try {
        resolve(JSON.parse(line) as RunnerResult)
      } catch {
        resolve({ ok: false, error: 'runner-output', detail: line.slice(0, 400) || '(空)', stderr: err.slice(-800) })
      }
    })
    ctx.logger('reze-render').debug(`runner ${mode} 启动（timeout=${timeoutMs}ms）`)
  })
}

const failText = (v: any) => `失败：${String(v.error ?? '')}${v.detail ? ' · ' + String(v.detail) : ''}`

export function apply(ctx: Context, config: Config): void {
  const log = ctx.logger('reze-render')

  // ───────────────────────── reze_status ─────────────────────────
  ctx.tools.register(defineTool({
    name: 'reze_status',
    description:
      'reze 出片台自检：这台机器现在能不能出片、手里有哪些料。' +
      '返回浏览器/ffmpeg/ffprobe/引擎 bundle 四项就绪状态 + 资产根里的模型（.pmx）与动作（.vmd）清单。' +
      '出片前先跑它——缺资产或缺 ffmpeg 时这里会说清楚，而不是等你等到渲染到一半才炸。',
    parameters: {},
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          ready: { type: 'boolean' },
          node: { type: 'string' },
          chrome: { type: 'string' },
          ffmpeg: { type: 'string' },
          ffprobe: { type: 'boolean' },
          bundle: { type: 'string' },
          assetRoot: { type: 'string' },
          models: { type: 'json' },
          motions: { type: 'json' },
          missing: { type: 'json' },
          error: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => {
        if (v.ok !== true) return [{ type: 'text', text: `reze 环境自检失败：${failText(v)}` }]
        const models = (v.models ?? []) as string[]
        const motions = (v.motions ?? []) as string[]
        const missing = (v.missing ?? []) as string[]
        const head = v.ready ? '✅ reze 出片台就绪' : `⛔ 还不能出片，缺：${missing.join(' / ')}`
        const lines = [
          head,
          `· node ${String(v.node)} · 浏览器 ${v.chrome ? String(v.chrome) : '（未找到）'}`,
          `· ffmpeg ${v.ffmpeg ? String(v.ffmpeg) : '（未找到）'} · ffprobe ${v.ffprobe ? '有' : '缺'}`,
          `· 引擎 bundle ${v.bundle ? '在' : '（缺）'} · 资产根 ${v.assetRoot ? String(v.assetRoot) : '（未配置）'}`,
          `· 模型 ${models.length} 个${models.length ? '：' + models.slice(0, 6).join(', ') + (models.length > 6 ? ' …' : '') : ''}`,
          `· 动作 ${motions.length} 个${motions.length ? '：' + motions.slice(0, 6).join(', ') + (motions.length > 6 ? ' …' : '') : ''}`,
        ]
        return [{ type: 'text', text: lines.join('\n') }]
      },
    },
    async execute() {
      return await runRunner(ctx, 'status', {}, config, 60_000)
    },
  }))

  // ───────────────────────── reze_preview ─────────────────────────
  ctx.tools.register(defineTool({
    name: 'reze_preview',
    description:
      '出静帧看机位：给模型+动作出一张（或多张候选）PNG，用来定机位与光照——**出片前必须先看一帧**，别等视频出来才发现机位不对。' +
      '传 distances（数组）即一次出多张候选（多机位试片）；返回每张的文件路径与字节数（**不返回像素**，看图用 read_image）。',
    parameters: {
      model: { type: 'string', description: '资产根下的 pmx 相对路径，如 models/reze/reze.pmx', required: true },
      stage: { type: 'string', description: '舞台/背景（可选）：资产根下的 pmx 相对路径，如 stages/neon stage/neon stage.pmx。作为第二个具名槽位载入（静态无动作）；载入失败不致命，会写进 pageLog' },
      motion: { type: 'string', description: '资产根下的 vmd 相对路径（可选，不给则是静止姿态）' },
      distances: { type: 'array', description: '多机位试片：距离数组，如 [30,40,50]；给了就走 sheet 模式' },
      distance: { type: 'number', description: '单张预览的相机距离（默认 36）' },
      at: { type: 'number', description: '从动作第几秒切入（默认 0）' },
      width: { type: 'number', description: '宽（默认 960）' },
      height: { type: 'number', description: '高（默认 540）' },
      alpha: { type: 'number', description: '相机水平角（默认 0）' },
      beta: { type: 'number', description: '相机垂直角（默认 0）' },
      bg: { type: 'string', description: '背景色 sRGB 0-1，逗号分隔（默认 0.09,0.10,0.14）' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string' },
          runDir: { type: 'string' },
          shots: { type: 'json' },
          count: { type: 'number' },
          distinctSizes: { type: 'number' },
          elapsedMs: { type: 'number' },
          pageLog: { type: 'json' },
          framesOnDisk: { type: 'number' },
          error: { type: 'string' },
          detail: { type: 'string' },
        },
      },
      render: (_a: unknown, v: any) => {
        if (v.ok !== true) return [{ type: 'text', text: `试片失败：${failText(v)}` }]
        const shots = (v.shots ?? []) as Array<{ file: string; bytes: number }>
        const list = shots.map((s) => `· ${s.file}（${s.bytes} 字节）`).join('\n')
        return [{
          type: 'text',
          text: `试片完成（${String(v.count)} 张，${String(v.elapsedMs)}ms）· 目录 ${String(v.runDir)}\n${list}\n` +
            `下一步：用 read_image 看这些文件，定好 distance 再出片。`,
        }]
      },
    },
    async execute(args) {
      const sheet = Array.isArray(args.distances) && args.distances.length > 0
      const opts = {
        model: args.model,
        stage: args.stage ?? '',
        motion: args.motion ?? '',
        width: args.width ?? 960,
        height: args.height ?? 540,
        warmup: 45,
        start: args.at ?? 0,
        distance: args.distance ?? 36,
        alpha: args.alpha ?? 0,
        beta: args.beta ?? 0,
        bg: args.bg ?? '0.09,0.10,0.14',
        distances: args.distances ?? [],
      }
      return await runRunner(ctx, sheet ? 'sheet' : 'preview', opts, config, 240_000)
    },
  }))

  // ───────────────────────── reze_render ─────────────────────────
  ctx.tools.register(defineTool({
    name: 'reze_render',
    description:
      '出 MMD 视频：reze-engine 在无头浏览器里按固定步长逐帧渲染（确定性离线导出），ffmpeg 编码，' +
      '返回**现算的判据读数**：帧数/期望帧数/分辨率/时长/编码/字节数/去重帧数。' +
      '⚠ **`frameVariety` 的「1」含义是「每帧都不同」**（去重帧/总帧），**不是**「画面静止」——以 `distinctFrames` 为准。' +
      '支持多角色同台（extras）、相机关键帧（camDist/camAlpha/camBeta）、后处理（postfx）。' +
      '⚠ 舞台之间尺度差异极大（宽 24～86888），**换舞台必须重扫机位**——先用 reze_preview 扫。',
    parameters: {
      model: { type: 'string', description: '资产根下的 pmx 相对路径', required: true },
      stage: { type: 'string', description: '舞台/背景（可选）：资产根下的 pmx 相对路径；作为第二个具名槽位静态载入，载入失败不致命' },
      stage2: { type: 'string', description: '第二舞台（可选）：通常是与 stage 配套的 sky/天空盒（動く荒野sky / 動く海用sky / SkyBox_* 等）——户外舞台给了它背景才不空' },
      motion: { type: 'string', description: '资产根下的 vmd 相对路径（可选）' },
      seconds: { type: 'number', description: '时长（秒，默认 8）' },
      fps: { type: 'number', description: '帧率（默认 30）' },
      width: { type: 'number', description: '宽（默认 1920）' },
      height: { type: 'number', description: '高（默认 1080）' },
      distance: { type: 'number', description: '相机距离（默认 36；先用 reze_preview 定）' },
      alpha: { type: 'number', description: '水平环绕角（度，默认 180=舞台正面）。每个舞台有自己的「好看区」，换舞台要重扫' },
      beta: { type: 'number', description: '俯仰角（度）。90=相机与目标同高；越大相机越低、画面下部地面越少。⚠ beta>90 时若目标点太低，相机会钻到地板下 ⇒ 整帧全黑（安全线 targetY > r·|cos(beta)|）' },
      start: { type: 'number', description: '从动作第几秒切入（默认 0）' },
      bg: { type: 'string', description: '背景色 sRGB 0-1（默认 0.09,0.10,0.14）' },
      crf: { type: 'number', description: 'x264 质量（默认 18，越小越清）' },
      outName: { type: 'string', description: '产物文件名（不含扩展名）' },
      // ── 相机动线（让镜头动起来：推拉摇移）────────────────────────────────
      camDist: { type: 'string', description: '距离关键帧，如 "0:41,4:34,8:40"（t秒:值；smoothstep 插值）' },
      camAlpha: { type: 'string', description: '环绕角关键帧（度），如 "0:203,4:188,8:199"' },
      camBeta: { type: 'string', description: '俯仰角关键帧（度），如 "0:99,4:93,8:100"' },
      // ── 构图锚点 ────────────────────────────────────────────────────────
      camTargetBone: { type: 'string', description: '相机跟随的骨骼名（如 上半身）——治「角色出框 / 画面下半是空地面」' },
      camTargetX: { type: 'number', description: '静态目标点 X（多角色同台时取各人站位的中点；camTargetBone 只能跟一个模型）' },
      camTargetY: { type: 'number', description: '静态目标点 Y（角色约高 19～21 单位；h 40～80 的舞台设 20 左右实测吻合）' },
      camTargetZ: { type: 'number', description: '静态目标点 Z' },
      camVmd: { type: 'string', description: '专业相机 VMD 路径（作者配好的镜头）。⚠ 与作者原环境（同舞台同模型）不匹配时会失配（实测两包都失配：一包差 136 帧、一包是环境失配）' },
      // ── 多角色同台 ──────────────────────────────────────────────────────
      extras: {
        type: 'array',
        description: '多角色同台（N 人）：[{pmx, vmd?, x?, y?, z?, ry?, scale?}, …]。' +
          '引擎只有一个场景时钟 ⇒ 各路 VMD **天然同拍**；根变换与 VMD 骨骼位移可叠加。' +
          '主模型用 modelX/modelY/modelZ/modelRy/modelScale 布位（否则钉在原点）。' +
          '实测 9 人同台（前排 5 间距 15 + 后排 4 z=18 交错）1080p/16s 正常出片。',
      },
      modelX: { type: 'number', description: '主模型 X 位移（阵列布位用）' },
      modelY: { type: 'number', description: '主模型 Y 位移' },
      modelZ: { type: 'number', description: '主模型 Z 位移' },
      modelRy: { type: 'number', description: '主模型绕 Y 旋转（度）' },
      // ── 后处理 / 光照 ───────────────────────────────────────────────────
      postfx: {
        type: 'object',
        additionalProperties: true,
        description: '后处理/光照补丁（**部分合并**语义：只写想改的键，其余保持原值）。' +
          '可用键：bloom{intensity,threshold,radius,knee} · exposure · gamma · transform · saturation · contrast · ' +
          'dof{enabled,focusMode,aperture,maxBlurRadius} · filmGrain · sun{strength,direction} · world · lights · ' +
          'groundMirror{on,blur} · outline · groundVisible · cameraFov · cameraRoll · background。' +
          '⚠ 引擎默认极保守：bloom.intensity 只有 0.05、dof 关着、filmGrain 0、exposure 0.6。' +
          '实测配方 bloom{intensity:0.95,threshold:0.34,radius:6} + exposure 0.88 + saturation 1.28 + contrast 1.08 + dof{aperture:2.2} ⇒ 画面从「平」变「发光」。',
      },
      probe: { type: 'boolean', description: '诊断：把引擎后处理/光照的当前值（含默认值）打进 pageLog——调 getter 让引擎自报，不用读源码猜参数形状' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          mode: { type: 'string' },
          video: { type: 'string' },
          runDir: { type: 'string' },
          frames: { type: 'number' },
          expectedFrames: { type: 'number' },
          width: { type: 'number' },
          height: { type: 'number' },
          duration: { type: 'number' },
          fps: { type: 'string' },
          codec: { type: 'string' },
          bytes: { type: 'number' },
          frameVariety: { type: 'number' },
          distinctFrames: { type: 'number' },
          elapsedMs: { type: 'number' },
          checks: { type: 'json' },
          error: { type: 'string' },
          detail: { type: 'string' },
          framesOnDisk: { type: 'number' },
          pageLog: { type: 'json' },
          diagnostics: { type: 'json' },
        },
      },
      render: (_a: unknown, v: any) => {
        if (v.ok !== true) {
          const pages = Array.isArray(v.pageLog) && v.pageLog.length ? `\n页面日志：${(v.pageLog as string[]).join(' | ')}` : ''
          const diag = Array.isArray(v.diagnostics) && v.diagnostics.length
            ? `\n页面侧诊断（CDP 异常/错误日志）：${(v.diagnostics as string[]).join(' | ')}`
            : ''
          return [{
            type: 'text',
            text: `出片失败：${failText(v)}${v.framesOnDisk !== undefined ? `（已落盘 ${String(v.framesOnDisk)} 帧）` : ''}${diag}${pages}`,
          }]
        }
        const mb = (Number(v.bytes) / 1e6).toFixed(2)
        const checks = (v.checks ?? {}) as Record<string, boolean>
        return [{
          type: 'text',
          text: `✅ 出片完成：${String(v.video)}\n` +
            `· ${String(v.width)}x${String(v.height)} · ${String(v.duration)}s · ${String(v.fps)} · ${String(v.codec)} · ${mb} MB\n` +
            `· 帧数 ${String(v.frames)}（期望 ${String(v.expectedFrames)}）· 帧间变化 ${String(v.frameVariety)}（去重帧 ${String(v.distinctFrames)}）\n` +
            `· 判据 ${Object.entries(checks).map(([k, ok]) => `${k}=${ok ? '✓' : '✗'}`).join(' ')} · 用时 ${String(v.elapsedMs)}ms`,
        }]
      },
    },
    async execute(args) {
      const seconds = args.seconds ?? 8
      const fps = args.fps ?? 30
      const opts = {
        model: args.model,
        stage: args.stage ?? '',
        motion: args.motion ?? '',
        seconds,
        fps,
        width: args.width ?? 1920,
        height: args.height ?? 1080,
        distance: args.distance ?? 36,
        start: args.start ?? 0,
        bg: args.bg ?? '0.09,0.10,0.14',
        crf: args.crf ?? 18,
        outName: args.outName ?? 'reze-mmd',
        warmup: 45,
        // 相机动线 / 构图锚点 / 专业相机
        alpha: args.alpha,
        beta: args.beta,
        camDist: args.camDist,
        camAlpha: args.camAlpha,
        camBeta: args.camBeta,
        camTargetBone: args.camTargetBone,
        camTargetX: args.camTargetX,
        camTargetY: args.camTargetY,
        camTargetZ: args.camTargetZ,
        camVmd: args.camVmd,
        // 多角色同台
        extras: args.extras,
        modelX: args.modelX,
        modelY: args.modelY,
        modelZ: args.modelZ,
        modelRy: args.modelRy,
        // 后处理 / 光照 / 诊断
        stage2: args.stage2,
        postfx: args.postfx,
        probe: args.probe,
      }
      return await runRunner(ctx, 'render', opts, config, Math.max(180_000, seconds * fps * 3000))
    },
  }))

  log.info('reze 出片台就绪（reze_status / reze_preview / reze_render）')
}
