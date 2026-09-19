# 语义文档：reze 出片台（dsh-reze-render）

> 版本 v0.1.0 · 2026-09-18 · 作者：爱丽丝 · 状态：**已实现**
> 开发方式：语义文档优先（先写清「是什么/什么关系/怎么裁决」，再让实现逼近，最后用实践回修）

---

## 1 · 定位与反定位

**定位**：把「用 reze-engine 离线出一段 MMD 视频」从一个**临时脚本**变成一个**可反复调用的插件工具**。
输入是一个意图（用哪个模型、哪段动作、多长、多大、什么机位），输出是一个**带判据读数的成品视频**——不是"跑完了"，是"帧数/时长/分辨率/帧间变化都对得上"。

**反定位（本插件不管什么）**：
- 不做**在线预览**（不提供 Web UI 播放器）——出片是离线批处理
- 不管理**资产版权**：模型/动作由调用者自备；本插件**不下载、不分发、不入公开仓**
- 不做视频剪辑/转码流水线（→ `video-generation` 的 ffmpeg 交付门禁）
- 不碰 MMD→UE 路线（→ 技能 `mmd-to-unreal-pipeline`）

## 2 · 术语表

| 术语 | 含义 |
|------|------|
| 资产根（assetRoot） | 一个目录，其下 `models/**/*.pmx` 与 `animations/*.vmd` 是可选用料；**不入版本管理** |
| 出帧页（page） | 在浏览器里跑的出帧程序：加载引擎 → 载模型 → 载动作 → 固定步长逐帧渲染 → 每帧 PNG POST 回本地服务器 |
| 机位（camera） | 只用三个数值旋钮描述：`distance`（距离）/ `alpha`（水平角）/ `beta`（垂直角）；**不使用 `setCameraTarget`**（见 §5 已知陷阱） |
| 试片（sheet） | 一次导航出多张候选机位图，供人眼挑选；不产出视频 |
| 帧间变化（frameVariety） | 视频里**互不相同的帧数 / 总帧数**（ffmpeg `framemd5` 判据）：= 1/总帧数 说明画面静止，接近 1 说明画面一直在动 |
| 就绪（ready） | 环境自检通过：浏览器在位、ffmpeg 在位、引擎 bundle 在位、资产根可读 |

## 3 · 概念模型

```
调用者(爱丽丝)
   │  reze_status / reze_preview / reze_render（三个工具）
   ▼
插件 src/index.ts ──► assets/runner.mjs（编排器，零外部依赖）
                         │ ① 起本地 HTTP 服务器（出帧页 + 引擎 bundle + /media → 资产根）
                         │ ② 起无头浏览器（--headless=new --enable-unsafe-webgpu --no-sandbox）
                         │ ③ CDP 驱动：导航 → 轮询页面状态（小负载）→ 收帧落盘
                         │ ④ ffmpeg 编码 → ffprobe 复核 → framemd5 判帧间变化
                         ▼
                    成品 .mp4 + 判据读数（结构化 JSON）
```

不变量（invariants）：
1. **I1 帧数据不过模型上下文**：帧只经本地 HTTP 落盘，工具只回**读数与路径**
2. **I2 判据必须是实测读数**：帧数/时长/分辨率/帧间变化每项都由 ffprobe/framemd5 现算，不许由"我知道应该没问题"填充
3. **I3 资产只读**：runner 只读资产根，永不写入/改名/下载
4. **I4 进程自清理**：无论成功失败，浏览器进程与服务器句柄必须关闭（失败路径同样清理）
5. **I5 输出目录可隔离**：每次运行在 `outDir/runs/<runId>/` 下工作，互不覆盖

## 4 · 契约

### 4.1 工具（对外接口）

| 工具 | 意图 | 关键参数 | 返回 |
|------|------|---------|------|
| `reze_status` | 这台机器现在能不能出片、手里有哪些料 | — | ready/缺失项/模型清单/动作清单 |
| `reze_preview` | 出一张（或多张候选）静帧看机位 | model, **stage**, motion, at, distances[], width, height, alpha, beta, bg | 图片路径 + 尺寸 + 字节数 |
| `reze_render` | 出一段视频 | model, **stage**, motion, seconds, fps, width, height, distance, start, bg, outName, crf | 视频路径 + 帧数/时长/分辨率/帧间变化/字节数 |

### 4.2 runner CLI（内部契约，可被测试直接调用）

```
node assets/runner.mjs status  --spec '<json>'
node assets/runner.mjs preview --spec '<json>'
node assets/runner.mjs render  --spec '<json>'
```
- `--spec` 是单个 JSON：`{ config: {...}, opts: {...} }`
- **stdout 最后一行必须是单个 JSON**（工具层解析它）；过程日志走 stderr
- 退出码：0 = 成功且判据通过；1 = 失败（JSON 里带 `error`）

### 4.3 调用点清单 `[MUST]`

| 调用方 | 调用点（文件:符号） | 时机 |
|-------|------------------|------|
| 工具层 | `src/index.ts` `runRunner()` | 每次工具调用（`execFile` 拉起 runner，读最后一行 JSON） |
| 环境探测 | `src/index.ts` `detectEnv()` | `apply` 时不探测（避免启动期副作用）；`reze_status` 与实际运行各探一次 |
| 出帧页 | `assets/page/main.js` | runner 通过 CDP 导航并轮询其 `window.__reze` |
| 服务器 | `assets/runner.mjs` `startServer()` | 每次运行一份，端口 `0`（系统分配），运行结束关闭 |

## 5 · 边界与信任

- **能力边界 ≠ 沙箱**：runner 会**起子进程**（浏览器、ffmpeg）并监听 `127.0.0.1` 上的临时端口；不上外网、不写资产根。
- **已知陷阱（写进实现，不是写在注释里）**：
  1. 无头浏览器必须带 `--no-sandbox`，否则 `navigator.gpu` 不存在（WebGPU 拿不到 adapter）
  2. 引擎 npm 包的 `dist/` 相对 import 无扩展名 ⇒ 必须用预打好的 bundle（本插件 `assets/engine/reze-engine.js`）
  3. `setCameraTarget` 传数组会走 Model 重载 ⇒ 出帧页只用数值机位旋钮
  4. CDP 导航后立刻读页面状态可能读到**上一页**的 ⇒ 用 `t=<时间戳>` 对表
- **失败面**：① 浏览器缺失/起不来 → `error: "browser-launch"` ② WebGPU 无 adapter → `error: "no-adapter"` ③ 资产缺失 → `error: "asset-missing"` ④ 出帧中断 → `error: "render-aborted"`（附已完成帧数）⑤ ffmpeg 失败 → `error: "encode"`（附 stderr 尾部）
- **隐私/版权**：产物默认落在 `outDir`（本机）；**模型与动作不上传、不入公开仓**。

## 6 · 与既有机制的关系

- 技能 `reze-web-mmd`（家族与工具链）、`mmd-to-unreal-pipeline`（UE 路线）——本插件是前者「出片」环节的工具化
- `video-generation`（ffmpeg 交付门禁）：本插件的编码与复核沿用同一套判据风格
- AGENTS.md §5.7「有效的临时工具脚本应该抽象成通用的插件工具」——本插件即该条的产物
- 版权约束来源：引擎仓自带资产的使用规则（请勿二次配布/商用）⇒ 资产只在本地、只在 `outDir` 出片

## 7 · 可证伪验收

| # | 判据 | 证据 | 状态 |
|---|------|------|------|
| A1 | `reze_status` 能报出浏览器/ffmpeg/引擎 bundle 三项就绪 | 工具返回 `ready: true` + 三项路径 | 已实测 |
| A2 | `reze_status` 能列出资产根里的模型与动作 | 返回 4 个模型 + 12 个动作 | 已实测 |
| A3 | `reze_preview` 出一张 PNG 且尺寸与请求一致 | sheet 产物 960×540 PNG，72,234 字节 | 已实测 |
| A4 | `reze_preview` 多机位模式出多张且各不同 | d30=72,234 B / d40=50,251 B（字节数不同） | 已实测 |
| A5 | `reze_render` 出 MP4 且时长 == frames/fps（±1 帧） | 90 帧 @30fps → ffprobe Duration 3s，`durationMatches=✓` | 已实测 |
| A6 | 视频**真的在动**：帧间变化 > 0.5 | `frameVariety = 1`（90/90 帧互不相同） | 已实测 |
| A7 | 帧数据不经过模型上下文 | 工具返回体只有路径 + 读数（约 600 字节 JSON，无 base64） | 已实测 |
| A8 | 失败路径自清理：进程表里无残留 headless Chrome | 运行后按 `reze-profile/--headless` 过滤 = **0** 个残留 | 已实测 |
| A9 | 缺资产时**响亮报错**而不是出黑屏 | 传不存在的 model ⇒ `asset-missing · model 不存在：…` | 已实测 |
| A10 | 传 `stage` 时舞台真的进入画面（不是被静默忽略） | 同机位同模型：无 stage 产物 83,261 B / 有 stage 产物 1,015,705 B（**12.2×**，肉眼见霓虹砖墙+地面）；`pageLog` 记 `stage loaded: …` | 已实测 |
| A11 | `stage` 载入失败**不致命**（fail-soft，角色照常出片） | 代码路径：`try/catch` 只记 `pageLog`，不抛；不传 `stage` 时行为与增强前**逐字节同构**（A3–A6 回归通过） | 已实测（异常分支待真实坏舞台样本触发） |
| A12 | 加了 `stage` 后**旧调用不受影响**（向后兼容） | 不传 `stage` ⇒ query 里 `stage=""` ⇒ `if (STAGE)` 为假 ⇒ 与 0.1.0 路径一致；端到端 1080p/12s/360 帧验收通过 | 已实测 |

> 端到端读数（2026-09-18 21:5x，插件挂载后经工具调用）：`reze_status` ready=true · `reze_preview`（sheet 两机位）5.0s · `reze_render` 1280×720 / 3s / 90 帧 → 帧间变化 1.0、产物 257,687 字节、用时 11.3s。
>
> 端到端读数（2026-09-19 10:2x，**加 stage 参数后**）：`reze_preview`（model=美鈴 + stage=neon stage，两机位）9.2s · `reze_render` **1920×1080 / 12s / 360 帧 → 5,199,210 字节、用时 318.4s**（有舞台比无舞台慢约 3.5×——几何量上去了）；生效判据：监听 3080 的 PID 47300 启动时间 `10:22:33` **晚于** `lib/index.js` mtime `09:42:59` ✅。

## 8 · 与实现的关系

- 主实现：`src/index.ts`（三工具 + runner 调用）
- 编排实现：`assets/runner.mjs`（零外部依赖：node 内置 + 全局 fetch/WebSocket）
- 出帧页：`assets/page/index.html` + `assets/page/main.js`
- 引擎 bundle：`assets/engine/reze-engine.js`（`reze-engine@0.56.11` 的 esbuild 打包产物，MIT；**打包命令写在 README**）
- 未实现/未验证部分**显式标注**：① 4K 出片未实测（只测 1080p）② 声音轨未支持（VMD 无音频；要配乐需另加 ffmpeg 混流）③ **单舞台**——只支持一个额外的具名槽位 `stage`（多道具/多角色同场仍未支持）

## 9 · 实践修订记录

- **2026-09-19 实践回修（v0.1.1 · 新增 `stage`）**：出片时发现**库里的舞台资产无从使用**——引擎 `loadModel(name, path)` 本就接受**具名槽位**，但插件只载一个模型，于是 123 个舞台（背景）全是死资产，出片永远是纯色背景。
  - 语义**被补充**：`stage` = **第二个具名槽位**，静态载入（不挂动作），与角色同场；**载入失败 fail-soft**（照出角色，把原因写进 `pageLog`）——因为「没有背景」远比「没有片子」轻。
  - 语义**被补充（判据）**：加参数必须**向后兼容**——不传 `stage` 时 query 为空、`if (STAGE)` 为假，路径与 0.1.0 一致（A12）。
  - 实测代价：有舞台比无舞台**慢约 3.5×**（1080p/12s：318.4s vs 91.3s）——几何量上去了；**这是选件时要预算的**。
  - 落地闭环：改 `src/index.ts`（两工具 schema + opts 透传）+ `assets/page/main.js`（`loadModel("stage")`）+ `assets/runner.mjs`（query 透传）→ tsc 构建 → ES module 语法自检 → 预检 → 哨兵重启 → **生效判据（进程启动时间 > 产物 mtime）** → 出片验收。

- **2026-09-18 首次实践（v0.1.0）**：从 `E:\alice\scripts\reze-render\` 的临时管线抽象成插件。
  - 语义**被澄清**：临时管线用「URL 查询参数 + 人肉导航」，插件化后必须是「一次调用 → 一份结构化读数」，因此把**判据现算**（ffprobe + framemd5）提为不变量 I2。
  - 语义**被补充**：资产根与产物目录必须**可配置**（资产是第三方、体积大且不入库），因此引入 `assetRoot`/`outDir` 两个配置项。

## 10 · 未决问题

- **U1** 是否支持「配乐 + 音轨」？（需要额外的音频源与 ffmpeg 混流；VMD 本身无音频）
- **U2** 是否要把「多机位拼接」（一次调用出多机位并自动剪辑）纳入本插件，还是留给上层编排？
- **U3** 4K/60fps 的实测量级（本机 Intel iGPU 下 1080p 240 帧约 20 秒；4K 预计 4 倍以上）是否值得做缓存/增量？
- **U4** 有舞台后 1080p/12s 要 318s（无舞台 91s）⇒ 是否值得加**降采样预览 + 分段增量渲染**，或按「舞台复杂度」先给用户一个耗时估计？
- **U5** `stage` 只是「一个额外槽位」的临时命名；多道具/多角色同场（真正的 MMD 场景）需要**槽位数组**——是否按 `addModels: [{name, path}]` 泛化？
