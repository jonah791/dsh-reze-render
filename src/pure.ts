/**
 * dsh-reze-render 的纯计算部分 —— 与 `index.ts` 的宿主耦合无关，可离线测。
 *
 * **为什么单独一个文件**：`index.ts` 顶层调 `defineTool` 并注册到 ctx，import 它就要有宿主；
 * 而「参数怎么拼成 spec」「runner 的 stdout 怎么解析」「超时怎么算」都是纯的输入→输出，
 * 抽出来就能在 `node --test` 里跑（同 `scripts/lib/doc-wrap-core.mjs` 的理由）。
 *
 * **抽的是什么、不是什么**：只抽**无副作用**的四件（拼装 / 解析 / 超时 / 文案）。
 * 引擎渲染本身不测——那是外部依赖（headless Chrome + WebGPU + ffmpeg），由 `reze_status`
 * 的体检兜底；在这里假装测它只会造出「恒为真的绿」。
 */

/** runner 的返回形状：`ok` 必有，其余字段随 mode 变化。 */
export interface RunnerResult {
  ok: boolean
  error?: string
  [k: string]: unknown
}

/** `buildRunnerSpec` 需要的那几个配置字段（窄接口，避免依赖完整的 Config）。 */
export interface RunnerConfig {
  assetRoot?: string
  outDir?: string
  chromePath?: string
  ffmpegPath?: string
  ffprobePath?: string
}

/**
 * 把配置与参数拼成 runner 的 `--spec`。
 *
 * ⚠ `assetRoot` / `outDir` 缺省用空串（runner 侧按空串判「没配置」）；
 * 三个路径字段缺省传 `undefined` —— `JSON.stringify` 会把值为 `undefined` 的键**整个省略**，
 * 所以下游收到的是「没有这个键」而不是 `"chromePath": null`。这个区别是刻意的，
 * 两者在 runner 侧的 `if (cfg.chromePath)` 判断里虽然同效，但省略键保留了「未设置」的语义。
 */
export function buildRunnerSpec(cfg: RunnerConfig, opts: Record<string, unknown>): string {
  return JSON.stringify({
    config: {
      assetRoot: cfg.assetRoot ?? '',
      outDir: cfg.outDir ?? '',
      chromePath: cfg.chromePath ?? undefined,
      ffmpegPath: cfg.ffmpegPath ?? undefined,
      ffprobePath: cfg.ffprobePath ?? undefined,
    },
    opts,
  })
}

/**
 * 解析 runner 的 stdout：**取最后一个非空行**当 JSON。
 *
 * 为什么是最后一行：runner 会把诊断过程打到前面（pageLog / 进度），只有末尾是结果行。
 * 解析失败**不抛**——转成 `{ ok:false, error:'runner-output' }` 并把原始行与 stderr 尾巴带上，
 * 因为「runner 崩了」与「runner 说了话但格式不对」对调用方是同一类失败（都要看到原文才能查）。
 */
export function parseRunnerOutput(stdout: string, stderr = ''): RunnerResult {
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  try {
    return JSON.parse(line) as RunnerResult
  } catch {
    return {
      ok: false,
      error: 'runner-output',
      detail: line.slice(0, 400) || '(空)',
      stderr: stderr.slice(-800),
    }
  }
}

/**
 * 出片超时：`max(180s, seconds × fps × 3s)`。
 *
 * 为什么是这个形状：逐帧渲染的成本随帧数线性增长，而每帧的预算给到 3 秒（1080p + WebGPU 的宽裕值）；
 * 下界 180s 是为了让极短片（<2s）也够覆盖浏览器冷启动与引擎初始化。
 */
export function renderTimeoutMs(seconds: number, fps: number): number {
  return Math.max(180_000, seconds * fps * 3000)
}

/**
 * 失败文案：`失败：<error> · <detail>`。
 *
 * ⚠ 入参保留 `any`：它接的是 runner 的返回值，形状随 mode 变化（status 报缺依赖、
 * render 报超时并带 `framesOnDisk`），用窄类型会逼调用点做无意义的断言。
 */
export function failText(v: any): string {
  return `失败：${String(v?.error ?? '')}${v?.detail ? ' · ' + String(v.detail) : ''}`
}
