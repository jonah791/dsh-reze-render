/**
 * dsh-reze-render 纯计算部分的回归测试（2026-11-02 首建）
 *
 * 背景：这个插件此前 422 行零测试。`index.ts` 顶层调 `defineTool` 并注册到 ctx，
 * import 它就要有宿主；而「参数怎么拼成 spec」「runner 的 stdout 怎么解析」「超时怎么算」
 * 是纯的输入→输出，抽进 `src/pure.ts` 就能离线测。
 *
 * **引擎渲染本身不测**——那是外部依赖（headless Chrome + WebGPU + ffmpeg），
 * 由 `reze_status` 的体检兜底；在这里假装测它只会造出「恒为真的绿」。
 *
 * 本测试钉住四件事：
 *   ① **等价性**：搬迁后与搬迁前的内联实现**逐字节一致**（把旧逻辑抄进本文件作参照，
 *      只用于证明搬家没改行为；它是快照，不要跟着 src 一起改）；
 *   ② 每个函数的边界（缺省值、空输入、多行、截断）；
 *   ③ **区分力**：把实现改坏时这些断言会红（等价性快照就是那个「坏实现」的对照）。
 *
 * 运行：npm test（= tsc && node --test tests/*.test.mjs）
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { buildRunnerSpec, failText, parseRunnerOutput, renderTimeoutMs } from '../lib/pure.js'

// ── 搬迁前的内联实现（快照，仅作等价性参照）────────────────────────────────
/** 旧版：`index.ts` 里 `runRunner` 开头的 spec 拼装（2026-11-02 搬迁前）。 */
function legacyBuildRunnerSpec(cfg, opts) {
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
/** 旧版：`index.ts` 里 `child.on('close')` 的解析逻辑（2026-11-02 搬迁前）。 */
function legacyParseRunnerOutput(stdout, stderr) {
  const line = stdout.trim().split('\n').filter(Boolean).pop() ?? ''
  try {
    return JSON.parse(line)
  } catch {
    return { ok: false, error: 'runner-output', detail: line.slice(0, 400) || '(空)', stderr: stderr.slice(-800) }
  }
}

test('等价性：buildRunnerSpec 与搬迁前的内联实现逐字节一致', () => {
  const cases = [
    [{ assetRoot: 'A', outDir: 'O', chromePath: 'C', ffmpegPath: 'F', ffprobePath: 'P' }, { model: 'm', seconds: 8 }],
    [{}, {}],
    [{ assetRoot: 'only-root' }, { probe: true }],
    [{}, { extras: [{ pmx: 'a.pmx' }], postfx: { bloom: { intensity: 0.95 } } }],
  ]
  for (const [cfg, opts] of cases) {
    assert.equal(buildRunnerSpec(cfg, opts), legacyBuildRunnerSpec(cfg, opts), '与旧实现不一致：' + JSON.stringify(cfg))
  }
})

test('等价性：parseRunnerOutput 与搬迁前的内联实现逐字段一致', () => {
  const cases = [
    ['{"ok":true,"video":"a.mp4"}', ''],
    ['诊断行\n{"ok":true}\n', 'some stderr'],
    ['', ''],
    ['not json at all', 'E'.repeat(2000)],
    ['{"ok":false,"error":"timeout"}\n\n\n', ''],
  ]
  for (const [out, err] of cases) {
    assert.deepEqual(parseRunnerOutput(out, err), legacyParseRunnerOutput(out, err), '与旧实现不一致：' + JSON.stringify(out).slice(0, 60))
  }
})

test('buildRunnerSpec：缺省时 assetRoot/outDir 是空串，三个路径字段整个不出现', () => {
  const spec = JSON.parse(buildRunnerSpec({}, { model: 'm' }))
  assert.equal(spec.config.assetRoot, '')
  assert.equal(spec.config.outDir, '')
  // 关键：JSON.stringify 省略值为 undefined 的键 ⇒ 下游看到「没有这个键」而不是 null
  assert.ok(!('chromePath' in spec.config), 'chromePath 不该出现在 JSON 里')
  assert.ok(!('ffmpegPath' in spec.config))
  assert.ok(!('ffprobePath' in spec.config))
  assert.deepEqual(spec.opts, { model: 'm' })
})

test('buildRunnerSpec：配置齐全时五个字段都在，opts 原样透传', () => {
  const cfg = { assetRoot: '/a', outDir: '/o', chromePath: '/c', ffmpegPath: '/f', ffprobePath: '/p' }
  const spec = JSON.parse(buildRunnerSpec(cfg, { model: 'm.pmx', fps: 30 }))
  assert.deepEqual(spec.config, cfg)
  assert.deepEqual(spec.opts, { model: 'm.pmx', fps: 30 })
})

test('parseRunnerOutput：取最后一个非空行（前面是诊断）', () => {
  const r = parseRunnerOutput('pageLog: 启动中\npageLog: 就绪\n{"ok":true,"frames":240}')
  assert.equal(r.ok, true)
  assert.equal(r.frames, 240)
})

test('parseRunnerOutput：尾部空行不影响取行', () => {
  const r = parseRunnerOutput('{"ok":true,"a":1}\n\n\n')
  assert.deepEqual(r, { ok: true, a: 1 })
})

test('parseRunnerOutput：空输出 ⇒ runner-output + detail "(空)"', () => {
  const r = parseRunnerOutput('   \n  \n')
  assert.equal(r.ok, false)
  assert.equal(r.error, 'runner-output')
  assert.equal(r.detail, '(空)')
})

test('parseRunnerOutput：非 JSON ⇒ 带原文前 400 字与 stderr 尾巴 800 字', () => {
  const r = parseRunnerOutput('这是崩溃输出', 'S'.repeat(2000))
  assert.equal(r.ok, false)
  assert.equal(r.error, 'runner-output')
  assert.equal(r.detail, '这是崩溃输出')
  assert.equal(r.stderr.length, 800, 'stderr 应截到 800 字')
})

test('renderTimeoutMs：极短片走 180s 下界', () => {
  assert.equal(renderTimeoutMs(1, 30), 180_000)
  assert.equal(renderTimeoutMs(0, 30), 180_000)
})

test('renderTimeoutMs：长片按 seconds×fps×3000 线性增长', () => {
  assert.equal(renderTimeoutMs(8, 30), 8 * 30 * 3000)   // 240 帧 ⇒ 720_000
  assert.equal(renderTimeoutMs(10, 60), 10 * 60 * 3000)
})

test('renderTimeoutMs：下界边界两侧', () => {
  // 60 帧 × 3000 = 180_000，正好等于下界
  assert.equal(renderTimeoutMs(2, 30), 180_000)
  // 61 帧 ⇒ 183_000，越过下界（用整数参数，别依赖 61/30*30 的浮点恰好抵消）
  assert.equal(renderTimeoutMs(3, 21), 189_000)
})

test('failText：四种形态', () => {
  assert.equal(failText({ error: 'timeout' }), '失败：timeout')
  assert.equal(failText({ error: 'timeout', detail: '5000ms 内未完成' }), '失败：timeout · 5000ms 内未完成')
  assert.equal(failText({}), '失败：')
  assert.equal(failText({ detail: '仅有 detail' }), '失败： · 仅有 detail')
})
