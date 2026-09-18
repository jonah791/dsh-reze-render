# dsh-reze-render

**用 [reze-engine](https://github.com/AmyangXYZ/reze-engine) 离线出一段 MMD 视频——一个工具调用，拿回成品与判据。**

爱丽丝（Alice）的自研插件 · DSH（DeepSeek Harness）· v0.1.0

---

## 它做什么

`reze-render` 把「用 WebGPU 引擎离线渲染 MMD」这条链路封成三个工具：

| 工具 | 干什么 |
|------|--------|
| `reze_status` | 这台机器现在能不能出片、手里有哪些料（浏览器 / ffmpeg / 引擎 bundle / 资产根 + 模型与动作清单） |
| `reze_preview` | 出静帧看机位（支持一次出多张候选做机位对照） |
| `reze_render` | 出视频，并返回**现算的判据读数**：帧数 · 期望帧数 · 分辨率 · 时长 · 编码 · 字节数 · **帧间变化** |

**判据不是装饰**：`帧间变化` 来自 `ffmpeg -f framemd5` 的逐帧哈希去重比值——`1.0` 表示每一帧都不同（画面一直在动），接近 `1/总帧数` 则说明画面静止。**"帧数对了"不等于"片子出来了"**。

## 安装

```bash
# 1. 放到 self-plugins 下并挂载（DSH 常规流程）
dsh plugin --profile web add link:<path>/dsh-reze-render

# 2. 准备资产（第三方素材，本仓不含）
#    资产根下需要：models/**/*.pmx 与 animations/*.vmd
#    reze-engine 仓库自带的演示资产可直接用：<engine>/web/public/{models,animations}

# 3. 配置资产根与产物目录（profile 的 cordis.patch.yml 或插件配置）
#    assetRoot: E:/alice/media/reze
#    outDir:    E:/alice/reze-out
```

## 使用

```
reze_status                                  # 先看能不能出片、有哪些料
reze_preview  model=models/reze/reze.pmx motion=animations/IRIS\ OUT.vmd at=6 distance=36
reze_render   model=models/reze/reze.pmx motion=animations/IRIS\ OUT.vmd seconds=8 fps=30 width=1920 height=1080 distance=36 start=6
```

## 配置

| 字段 | 默认 | 说明 |
|------|------|------|
| `assetRoot` | 空（必填才能出片） | 资产根：其下需有 `models/` 与 `animations/` |
| `outDir` | 系统临时目录 `/reze-render` | 产物目录；每次运行在 `runs/<时间戳>/` 下工作 |
| `chromePath` | Chrome 默认安装路径 | 无头浏览器可执行文件 |
| `ffmpegPath` / `ffprobePath` | `ffmpeg` / `ffprobe`（走 PATH） | 编码与探针 |

## 技术要点（踩过的坑，写进实现）

1. **无头浏览器必须带 `--no-sandbox`**：只加 `--enable-unsafe-webgpu` 时 `navigator.gpu` 根本不存在，加 `--no-sandbox` 才拿得到 adapter（本机 Intel gen-12lp 实测）。这条配方来自 reze 引擎自带的 `tools/validate-wgsl.mjs`。
2. **引擎 npm 包不能直接被浏览器 import**：`reze-engine` 的 `dist/` 相对 import 不带扩展名（给打包器看的）。本仓内置 `assets/engine/reze-engine.js`（`reze-engine@0.56.11` 的 esbuild 打包产物）：
   ```bash
   npm i reze-engine@0.56.11 esbuild && echo 'export * from "reze-engine"' > entry.js
   npx esbuild entry.js --bundle --format=esm --outfile=assets/engine/reze-engine.js --loader:.wgsl=text
   ```
3. **`setCameraTarget` 有两个重载、运行时 duck-typing 分派**：传数组会被当成 Model 重载，随后崩在 `m.getBoneWorldPosition is not a function`。本插件只用数值机位旋钮（`distance/alpha/beta`）。
4. **帧数据不经过模型上下文**：出帧页把 PNG `POST` 回本地临时服务器落盘，工具只回路径与读数。一次 240 帧若不这么做，上下文会被烧穿。
5. **进程自清理**：运行结束（含失败路径）按 PID 树 kill 自己启动的浏览器并删临时 profile——**只杀自己启动的那个 PID**，不按进程名清场。

## 语义文档与验收

- 语义文档：`docs/semantic.md`（定位/不变量/契约/边界/可证伪验收/未决问题）
- 端到端实测（本机）：`reze_status` ready=true（Chrome + ffmpeg 8.1 + bundle + 资产根，4 模型 / 12 动作）；`reze_preview` 4.9 s 出 960×540 PNG；`reze_render` 1920×1080 / 4 s / 120 帧，**帧间变化 1.0**、时长与帧数自洽、产物 573 KB，全程 15.4 s

## 版权

- 本插件只处理**调用者自备**的第三方资产（MMD 模型/动作有其自己的使用规约，例如常见条款为「请勿二次配布 / 请勿商用」）——**本仓不含任何模型或动作，也不下载、不分发**。
- 内置的 `assets/engine/reze-engine.js` 是 [reze-engine](https://github.com/AmyangXYZ/reze-engine)（MIT）的构建产物，版权归原作者。

## License

MIT
