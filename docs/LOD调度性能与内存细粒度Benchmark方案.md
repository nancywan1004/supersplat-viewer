# LOD 调度性能与内存细粒度 Benchmark 方案

> 目标：针对 Poland 等大场景在不同分块粒度（例如 96k/10m 与 512k/16m）下的帧率差异、调度耗时差异、active splats 口径差异、JS Heap / VRAM 激增，建立可复现实验与判定方法。  
> 范围：viewer 前端 LOD refinement 调度、loader 队列、instance LOD sync、renderer splat 数、内存/VRAM。资产生产侧只作为对比变量，不在本文直接修改。  
> **实测结论与瓶颈归因**见 [`LOD调度性能瓶颈分析.md`](./LOD调度性能瓶颈分析.md)；**移动量分桶样例**见 [`logs/frame-profile-movement-analysis.md`](./logs/frame-profile-movement-analysis.md)。

---

## 1. 要验证的问题

### 1.1 active splats 为什么不是 0

HUD 中的 `Gsplats` / `app.stats.frame.gsplats` 不是“当前视锥中真实有高斯点的区域数量”，而是 renderer 本帧提交/排序的 splat 数。它会受以下因素影响：

- 已放置的 octree instance / file placements 仍然存在。
- `splatBudget` 和 `lodUnderfillLimit` 会影响上屏 LOD，而不是简单按视锥清零。
- 视锥候选节点、当前已上屏节点、renderer 统计三者不是同一口径。
- 画面看起来为空，可能只是可见贡献很小、远处粗层、透明/小 footprint，renderer 仍处理了 splats。

需要同时记录：

| 口径 | 字段 | 说明 |
|------|------|------|
| renderer 提交口径 | `rendererGsplatsM` / HUD `Gsplats` | PlayCanvas frame stats，偏渲染提交口径 |
| LOD 当前上屏口径 | `visibleSplats.currentM` | 当前视锥内已上屏 LOD 的 splat 估算 |
| LOD 理想口径 | `visibleSplats.optimalM` | 按当前视角 optimal LOD 的 splat 估算 |
| LOD target 口径 | `visibleSplats.targetM` | refinement 下一步目标 LOD 的 splat 估算 |

### 1.2 为什么分块粒度会导致调度层差异

即便同屏点数被 `splatBudget` 限制，分块粒度仍会放大 CPU 调度成本：

- leaf 数更多，BVH/PQ traversal 和 leaf 评分更多。
- 可见 leaf 更多，AABB/frustum/edgeFactor 计算更多。
- candidate file refs 更多，去重、排序、tracked missing、foreground/critical 选择更多。
- loader 队列 URL 更多，stale in-flight 软取消、gate、queue reconcile 更多。
- file 落地更碎，instance LOD sync / WebGPU deferred update 更频繁。
- 资源对象、ArrayBuffer、texture、GPU buffer 更碎，JS Heap / VRAM 更容易出现峰值。

### 1.3 内存激增可能来源

内存激增要分 JS Heap 与 GPU VRAM 看：

| 类型 | 常见来源 | 观测字段 |
|------|----------|----------|
| JS Heap | loader asset 对象、URL 映射、队列、tracked/pinned Set、未释放 ArrayBuffer、benchmark 截图 base64 | `jsHeapPeakMb`, `jsHeapAtClearMb`, `trackedMissing`, `queueLen`, `suspended`, `pinnedFiles` |
| GPU VRAM | SOG texture / GPU buffer、WebGPU work buffer / bind group 重建、已加载但未卸载 file resource | `vramTexPeakMb`, `vramTexAtClearMb`, `visibleSplats.currentM`, `staleLoadedNodes` |
| 调度滞留 | stale in-flight、suspended queue、gate hold、pinned refcount | `staleInFlight`, `suspended`, `gateHeld`, `pinnedFiles`, `lastGateUrls` |

---

## 2. refinement 策略与 native 自动 active splats 机制

本项目现在有两条大场景执行路径。它们都使用同一份 octree 资产，但“谁来决定显示哪一档、谁来决定先下载哪些文件”不一样。

### 2.1 我们做的 refinement 策略（代码级流程）

实现入口：`src/loaders/gsplat/lod/octree/refinement-controller.ts` + `bootstrap.ts`。

#### 2.1.1 何时唤醒调度器

**A. 相机变化（bootstrap，每帧 update 后）** — `tryUnlockStreamingOnCameraIdle()`：

| 条件 | 代码阈值 | 位置 |
|------|----------|------|
| 平移 | `distance > 0.03` m（**3 cm**） | `bootstrap.ts` L552 |
| 转向 | `lastFwd·curFwd < 0.985`（约 **9.9°**） | L553 |
| 缩放 | `|Δdist| > max(0.04, dist×0.08)` 或 `|Δfov| > 0.5°` | L554–556 |

→ `refinementController.notifyCameraMoved({ zoom })`

**B. `notifyCameraMoved`（L2679–2705）**：`cameraMovedSinceSettle=true`，`traversalForceDirty=true`，`cameraBurstFrames=max(当前, zoom?36:18)`，清空 tracked/pinned/queue，立即 `runPriorityPrefetch()`。

**C. 每帧 tick**：`app.on('update')` → `runPriorityPrefetch()`（L2615–2619）。

#### 2.1.2 tick 阶段与 scanMode

```text
full/incremental/skip scan → tracked → queue → sync → burst-- → lastTickMetrics
```

| scanMode | 条件（L2168–2192） | leavesEvaluated | scan P50 |
|----------|-------------------|-----------------|----------|
| `full` | moved / burst / dirty | **2048**（cap） | **~1 ms** |
| `incremental` | 静止 + tracked | < full | < full |
| `skip` | 静止 + 无 tracked | 0 | 0 |

#### 2.1.3 tunables（aggressive 桌面，`refinement-tunables.ts`）

| 字段 | 值 | 说明 |
|------|-----|------|
| `burst.moveFrames` | **18** | 平移后 full scan 持续帧数 |
| `burst.zoomFrames` | **36** | 缩放 burst |
| `scan.maxLeafEvaluationsCap` | **2048** | 单次 full scan 上限 |
| `scan.maxLeafEvaluationsRatio` | 0.15 | × leafCount |
| `loader.boostConcurrent` | 8 | boost 下载并发 |
| `loader.foregroundLimit` | 64 | foreground batch |
| `lod.splatBudget` | 4M | 可被 URL `budget=` 覆盖 |

#### 2.1.4 移动量 vs 计算量（v2 实测）

触发后 scan **~1 ms/帧**，与 5 cm / 5 m **无关**；18 帧 burst 累计 **~18–28 ms** CPU。分块变密主要抬高 `candidateFileRefs` 与 queue，而非 scan 墙钟。

#### 2.1.5 benchmark 字段

| 字段 | 含义 |
|------|------|
| `timingsMs.scan/queue/sync` | tick 各阶段墙钟 |
| `leavesEvaluated` / `scanMode` | leaf 数 / scan 类型 |
| `cameraBurstFrames` | burst 剩余帧 |
| `candidateFileRefs` | 分块 fan-out |
| `staleLodNodes` | 显示档粗于 target |
| `visibleSplats.*M` | LOD 口径点数 |

**特点摘要**：中心优先变清晰；分块越细 queue/fan-out 越重；scan 被 2048 cap 钳在 ~1 ms/帧。

### 2.2 native 路径里 active splats 为什么会自动变化

native 路径可以理解成：viewer 首屏加载完成后，把主要控制权交给 PlayCanvas 引擎自己的 octree 高斯渲染系统。引擎内部会根据相机与每个块的距离、当前块是否在视野内、配置的距离曲线，自动决定每个块当前显示哪一档。

这里的 active splats 不是我们单独手写一个变量去加减，而是渲染系统在每帧准备渲染时自然得到的结果：

1. 引擎知道当前相机在哪里、朝向哪里。
2. 引擎知道每个 octree 块的包围盒、每档文件里有多少高斯点。
3. 引擎根据距离曲线判断每个块应该显示粗档还是细档。
4. 离相机近、屏幕里占比大的块，会倾向于使用更细的一档。
5. 离相机远、屏幕里很小、或者只在边缘的块，会倾向于使用更粗的一档。
6. 如果某个细档文件还没下载，引擎通常会先用已经可用的粗档兜底，而不是直接什么都不显示。
7. 最终，当前真正参与渲染的所有块，把各自当前档位的高斯点数加起来，就形成了这一帧的 active splats。
8. 这个数量会被写进 `app.stats.frame.gsplats`，HUD 里的 `Gsplats` 就是读这个统计。

所以 native 的 active splats 会“自动计算”，本质是因为每一帧引擎都已经知道自己提交了哪些块、每个块用了哪一档、每档有多少点。它不是按“屏幕上看起来有没有点”来数，而是按“这一帧渲染器准备处理多少高斯点”来数。

这也解释了两个现象：

- 看向一个肉眼觉得没有点的区域，active splats 仍可能不是 0。原因是视野边缘、远处粗档、或者已放置的粗层块仍然参与了渲染统计。
- 多个实例或大片场景的理论总点数可以很大，但 active splats 不会等于总点数。因为远处块通常会自动降到粗档，近处才使用细档。

native 路径的特点是：

- **优点**：上屏选档主要在引擎内部完成，viewer 前端不需要每帧维护强下载队列和强切档策略，调度开销通常更低。
- **缺点**：下载顺序不一定最符合“先让屏幕中心变清晰”的业务需求。它更像自然加载，未必优先服务用户正在看的中心区域。
- **active splats 更自然**：因为每帧由引擎真实渲染提交得出，所以它能随着相机距离、视野、档位自动变化。
- **内存风险仍然存在**：如果很多块都被判定为需要更细档，或者并发加载过多，显存和 JavaScript 堆内存仍可能增长。

### 2.3 两条路径的关键差别

| 对比项 | refinement 路径 | native 路径 |
|--------|-----------------|-------------|
| 谁决定当前优先下载什么 | viewer 前端调度器主动决定 | 主要由引擎自然请求，viewer 只做少量观察或辅助 |
| 谁决定每个块显示哪一档 | viewer 计算目标档，并催促 instance 更新 | 引擎根据相机和距离曲线自动选档 |
| active splats 来源 | renderer 统计为准；我们额外估算 `visibleSplats.*M` 辅助分析 | renderer 统计为准，由引擎当前选档自然累加 |
| 中心优先变清晰 | 更强，调度器会主动偏向屏幕中心 | 较弱，除非另加轻量预取 |
| 前端计算成本 | 更高，尤其小分块时 | 更低 |
| 队列控制 | 强控制，会重排、拦截、清理旧视角下载 | 弱控制，更多依赖引擎 |
| 内存峰值风险 | 高并发、pin、队列滞留会放大峰值 | 主要取决于引擎请求、资源常驻和可见档位 |

### 2.4 为什么 benchmark 要同时看两类 active splats

只看 HUD 的 `Gsplats` 不够，因为它只能告诉我们“这一帧渲染器处理了多少点”，不能告诉我们这些点是否来自当前视角真正需要的细档，也不能告诉我们调度器为了得到这些点做了多少工作。

因此 refinement benchmark 里要同时看：

- `rendererGsplatsM`：渲染器这一帧处理了多少点。
- `visibleSplats.currentM`：当前视锥内已经上屏的点数估算。
- `visibleSplats.optimalM`：如果所有需要的文件都已到位，当前视角理论上应该显示多少点。
- `visibleSplats.targetM`：调度器下一步正在追的目标点数。
- `candidateFileRefs`：为了追这些目标，调度器产生了多少候选文件。
- `timingsMs.scan` / `timingsMs.queue` / `timingsMs.sync`：为了追这些目标，调度层花了多少时间。

这样才能区分：

| 现象 | 说明 |
|------|------|
| `rendererGsplatsM` 差不多，但 `candidateFileRefs` 和 `scan` 高 | 同屏点数不是主因，调度扇出才是主因 |
| `rendererGsplatsM` 明显高，显存也高 | 渲染和资源常驻也在参与瓶颈 |
| `visibleSplats.optimalM` 高但 `currentM` 低 | 当前视角理论上需要更多细档，但文件或切档没跟上 |
| `currentM` 高但画面仍糊 | 可能显示的是粗档大块，或者 renderer 点数口径不能代表中心清晰度 |

---

## 3. 数据采集：两套 profiling 体系

### 3.1 体系 A — 调度 tick 采样（`debugOctreeRefinement`）

**用途**：看调度 fan-out、队列、sync；**不能**看整帧/GPU。

| URL 参数 | 行为 |
|----------|------|
| `?debugOctreeRefinement=1` | 每 **2000 ms** 最多一条 `[octree-refinement]` |
| `?debugOctreeRefinement=2` | 每 **250 ms** 一条（更高频，有日志开销） |

**采样逻辑**（`refinement-controller.ts` L2446–2542）：

- 仅在 `runPriorityPrefetch()` 内、且 `isRefinementDebugEnabled()` 时写入。
- 环形缓冲 **600 条**：`window.__octreeRefinementSamples`。
- 与 tick **不同步于每一帧**：两次 log 之间可能跨多帧 tick。

**导出**：

```js
copy(JSON.stringify(window.__octreeRefinementSamples, null, 2))
```

**单条 log 核心字段**（与 `lastTickMetrics` + 扩展 loader 字段）：

| 字段 | 类型/单位 | 用途 |
|------|-----------|------|
| `timingsMs.total/scan/tracked/queue/sync` | ms | tick 五段墙钟 |
| `scanMode` | `full`/`incremental`/`skip` | 本轮 scan 类型 |
| `leavesEvaluated` | int | 通常 full=2048 |
| `visibleLeaves` / `scoredLeaves` | int | 视锥 / 评分 leaf |
| `candidateFileRefs` | int | 未去重 fan-out |
| `candidateUniqueFiles` | int | 去重候选文件 |
| `staleLodNodes` / `staleLoadedNodes` | int | blur / 切档滞后 |
| `cameraBurstFrames` | int | burst 剩余帧 |
| `triggerReasons` | string[] | full scan 原因 |
| `movement.movedMeters` / `turnedDegrees` | m / ° | **tick 间**相机 snapshot 差（非单帧） |
| `visibleSplats.currentM/optimalM/targetM` | M | LOD 口径 |
| `rendererGsplatsM` | M | `app.stats.frame.gsplats` |
| `queueLen` / `inFlight` / `suspended` | int | loader 队列 |
| `staleInFlight` / `priorityQueued` / `priorityInFlight` | int | priority 占槽 |
| `pinnedFiles` | int | pin 滞留 |
| `boostActive` / `gateHeld` | bool | boost / gate hold |

`debugOctreeRefinement=2` 额外：`jitterHint.likelyBudgetOscillation` 等。

---

### 3.2 体系 B — 逐帧 frame-profiler（推荐，整帧 + GPU）

**用途**：整帧墙钟、GPU pass、CPU render、相机移动量、每帧 tick 快照。

| URL 参数 | 行为 |
|----------|------|
| `?frameProfile=1` | 初始化 `window.__frameProfiler` 并 **自动 start** |
| `?frameProfile=auto` | 同 `1` |

实现：`src/benchmark/frame-profiler.ts`；在 `index.ts` 中 `initFrameProfiler(global, { autoStart })`。

#### 3.2.1 每帧采样时机

```text
frameupdate  → 记录 frameupdateAt
update()     → PlayCanvas 脚本/动画（stats.scriptUpdate 等）
framerender  → 记录 framerenderAt
render()     → postrender 记录 postrenderAt；GPU pass 写入 stats.gpu
frameend     → 同步快照 app.stats + camera 增量 + 排队 microtask
microtask    → 读 refinement.getLastTickMetrics() + deferredInstUpdateMs
```

**CPU 字段注意**：生产版 PlayCanvas 未设置 `renderStart`，`stats.frame.renderTime` 不可信。profiler 使用：

- `cpu.renderMs` = `postrenderAt − framerenderAt`
- `cpu.updateMs` = `framerenderAt − frameupdateAt`（update 极短时可能为 0）

#### 3.2.2 单帧 JSON 结构（`FrameProfileSample`）

| 字段 | 来源 | 说明 |
|------|------|------|
| `frameMs` | `stats.frame.ms` | 帧间隔墙钟 |
| `fps` | `stats.frame.fps` | 引擎平滑 FPS |
| `cpu.renderMs` | 自测 | render 阶段 |
| `cpu.scriptUpdateMs` 等 | `stats.frame.*` | 脚本/动画分步 |
| `gpu.totalMs` / `gpu.passes` | `stats.gpu` Map | 需 WebGPU gpuProfiler enabled |
| `gsplatsM` | `stats.frame.gsplats / 1e6` | renderer 口径 |
| `jsHeapMb` | `performance.memory` | Chrome only |
| `vramTexMb` | `stats.vram.tex` | 纹理 VRAM |
| `camera.moveSinceLastM` | 相邻帧 camera.position | **单帧**平移（米） |
| `camera.rotateSinceLastDeg` | 相邻帧 forward 夹角 | **单帧**转向（度） |
| `camera.moveTriggersLod` | `moveSinceLastM > 0.03` | 是否越过 bootstrap 阈值 |
| `camera.rotateTriggersLod` | dot < 0.985 | 是否越过转向阈值 |
| `refinement.tick` | `getLastTickMetrics()` | 同 HUD Scheduler 区块 |
| `refinement.deferredInstUpdateMs` | frameend flush | WebGPU inst.update |

默认最多 **7200** 样本/次；超出 FIFO 丢弃最旧。

#### 3.2.3 API

```js
__frameProfiler.start()
__frameProfiler.stop()          // 返回 samples[]
__frameProfiler.clear()
__frameProfiler.getSamples()
__frameProfiler.applyCameraDelta({ moveForwardM: 0.05, yawDeg: 12 })  // 标定移动
__frameProfiler.downloadJson('profile.json')
```

#### 3.2.4 自动交互 profiling 脚本

```bash
npm run develop
node scripts/frame-profile-interaction.mjs
node scripts/analyze-frame-profile-movement.mjs
```

**标定步**（`scripts/frame-profile-interaction.mjs` 内 `CALIBRATED_STEPS`）：

| 步骤 | 参数 | settle |
|------|------|--------|
| idle_baseline | — | 4000 ms |
| move_2cm / 5cm / 20cm / 1m / 5m | `moveForwardM` | 3500–5000 ms |
| yaw_5° / 12° / 30° / 90° | `yawDeg` | 3500–5000 ms |
| combo | 2 m + 20° | 5000 ms |
| organic | WASD + 拖拽 + 滚轮 ~25 s | — |

输出：`docs/logs/refinement_{poland,poland-v2}_v3.txt`（或 native：`native_*_finelod.txt`）；分桶报告（历史）：`docs/logs/frame-profile-movement-analysis.md`；归因报告：`docs/logs/refinement_poland_v3-bottleneck.md`。

---

### 3.3 blur→clear 判定逻辑（animTrack / 静态 benchmark 共用）

代码：`src/benchmark/benchmark-refinement.ts`

| 常量 | 值 | 含义 |
|------|-----|------|
| `REFINEMENT_CLEAR_RATIO` | **0.95** | `refinementRatio ≥ 0.95` 视为清晰 |
| `BENCHMARK_OBSERVE_MS` | **200** | 轮询间隔（只读，不驱动 LOD） |
| `REFINEMENT_STABLE_OBSERVATIONS` | **4** | 连续清晰次数 |
| `REFINEMENT_TIMEOUT_MS` | **45000** | 超时判 fail |

**清晰条件**：`pendingNodes === 0` 且 `refinementRatio ≥ 0.95` 连续 **4 × 200 ms = 800 ms**。

`pendingNodes` 取自 streaming status 的 **stableForegroundPending**（前景 unique 文件缺失数）。

---

### 3.4 两套体系如何配合

| 问题 | 用哪套 |
|------|--------|
| scan/queue 是否 fan-out | A 或 B 的 `refinement.tick` |
| 整帧/GPU 谁慢 | **B**（`frameMs`, `gpu.totalMs`） |
| 移动 5 cm vs 5 m 计算量 | **B**（`camera.*` + tick 分桶） |
| loader 队列滞留 | **A** 字段更全（`suspended`, `gateHeld`） |
| 正式 FPS 不受日志影响 | B 或 `debugOctreeRefinement=0` |

正式对比实验建议：**B 录逐帧 + debug=0**；排查调度细节时短期开 **A level=1**。

---

## 4. Benchmark 变量矩阵

### 4.1 必测资产变量

| 变量 | Case A | Case B | 目的 |
|------|--------|--------|------|
| 分块点数 / extent | 96k / 10m | 512k / 16m | 验证 fan-out 与内存峰值 |
| pack mode | separate | bundled | 分离下载 vs 合包调度差异 |
| LOD levels | 当前档数 | 减少/增加档数 | 验证 ladder 与切档次数 |

### 4.2 必测运行时变量

| 变量 | 建议值 | 目的 |
|------|--------|------|
| renderer | `webgpu`, `webgl` | 区分 WebGPU sync/work buffer 与普通路径 |
| lodRuntime | `refinement`, `native` 路径 | 对比前端 refinement 与引擎 native 调度 |
| lodMode | `performance`, `quality` | 对比 conservative/aggressive tunables |
| splat budget | 1.5M, 3M, 5M, 10M | 区分 renderer 点数瓶颈与调度 fan-out |
| cold/warm | cold, warm | 区分 HTTP/缓存与纯调度 |
| debug level | 0, 1, 2 | 衡量日志本身开销，正式数据以 0/1 为主 |

### 4.3 相机路径变量

至少三类路径；**推荐用 frame-profiler 标定步**（数值可复现）：

| 路径 | 标定参数（`applyCameraDelta`） | 预期调度行为 |
|------|-------------------------------|--------------|
| 微移动 | `moveForwardM: 0.02` | **不触发** burst（< 3 cm） |
| 触发移动 | `0.05 / 0.2 / 1.0 / 5.0` m | 触发 burst **18 帧** full scan |
| 转向 | `yawDeg: 5 / 12 / 30 / 90` | 5° 可能不触发；≥12° 触发（orbit 阻尼下单帧可能 ≤10°） |
| 组合 | `2 m + 20°` | 平移+转向各触发一次 notify |
| 键鼠交互 | Playwright WASD/拖拽/滚轮 | 模拟真实用户 |

**判定移动是否触发 LOD**（与 bootstrap 一致）：

```text
moveTriggersLod  := camera.moveSinceLastM > 0.03
rotateTriggersLod := forward_dot < 0.985   // ~10°
```

**移动量 vs scan 成本**（v2 实测结论）：触发后 **scan ≈ 1 ms/帧 × 18 帧 ≈ 18–28 ms CPU**，与移动 **1 m 还是 5 m 无关**；`leavesEvaluated` 固定 cap **2048**。

---

## 5. 推荐实验设计

### 5.1 Baseline：同路径对比两种粒度

固定：

- 同一个 camera track。
- 同一个 `lodMode=performance`。
- 同一个 renderer，例如 `webgpu`。
- 同一个 `splatBudget`。
- cold start 与 warm start 分开跑。

对比：

- `poland-96k-10m`
- `poland-512k-16m`

输出重点：

| 指标 | 判定 |
|------|------|
| `fpsP50`, `fpsP95`, `fpsMinDuringRefine` | 是否掉帧 |
| `blurToClearMs`, `pendingPeakNodes` | 清晰收敛速度 |
| `timingsMs.scan P50/P95/max` | CPU traversal 是否变重 |
| `timingsMs.queue P50/P95/max` | loader 调度是否变重 |
| `timingsMs.sync P50/P95/max` | instance sync 是否变重 |
| `leavesEvaluated`, `candidateFileRefs` | fan-out 是否随粒度放大 |
| `jsHeapPeakMb`, `vramTexPeakMb` | 内存峰值是否随粒度放大 |

### 5.2 固定同屏 splats，隔离调度层

目的：验证“同屏点数已限制，但调度仍然慢”。

方法：

1. 固定 `splatBudget`，例如 3M。
2. 记录 `rendererGsplatsM` 与 `visibleSplats.currentM`。
3. 如果两组 `rendererGsplatsM` 接近，但 96k 的 `scan/queue/sync` 明显更高，则瓶颈在调度 fan-out，不是 renderer 同屏点数。

判定：

| 现象 | 结论 |
|------|------|
| `rendererGsplatsM` 接近，`timingsMs.scan` 更高 | leaf traversal / LOD scoring 瓶颈 |
| `rendererGsplatsM` 接近，`timingsMs.queue` 更高 | file/URL 调度 fan-out 瓶颈 |
| `rendererGsplatsM` 接近，`timingsMs.sync` 更高 | instance LOD sync / WebGPU update 瓶颈 |
| `rendererGsplatsM` 和 VRAM 都更高 | renderer / resource residency 也参与瓶颈 |

### 5.3 内存激增专项

每个 keyframe 到达后记录：

- 到达瞬间：`jsHeapUsedMb`, `vramTexMb`
- pending peak 时：`jsHeapPeakDuringRefineMb`, `vramTexPeakDuringRefineMb`
- clear 后：`jsHeapAtClearMb`, `vramTexAtClearMb`
- clear 后继续 idle 10s：再次采样 JS Heap / VRAM

判定：

| 现象 | 可能原因 |
|------|----------|
| clear 后 JS Heap 不回落，`queueLen/suspended/trackedMissing` 高 | loader 队列/调度对象滞留 |
| clear 后 JS Heap 不回落，`pinnedFiles` 高 | pin/refcount 资源保活过多 |
| clear 后 VRAM 不回落，`visibleSplats.currentM` 高 | 已上屏资源常驻，预算/underfill 过高 |
| clear 后 VRAM 不回落，`staleLoadedNodes` 高 | 文件加载完成但 LOD sync 或卸载策略滞留 |
| JS Heap 峰值随 `candidateFileRefs` 放大 | 小分块导致候选/URL/asset 对象更多 |
| VRAM 峰值随 pending/in-flight 放大 | 并发加载与资源落地过快，释放跟不上 |

### 5.4 冷启动 vs 热启动

目的：区分 HTTP 下载与纯调度。

运行：

```bash
node scripts/benchmark-playwright.mjs public/benchmark-suites/<suite>.json
BENCHMARK_WARM_START=1 node scripts/benchmark-playwright.mjs public/benchmark-suites/<suite>.json
```

判定：

| 冷启动慢，热启动明显快 | HTTP / CDN / cache / decode 影响大 |
| 冷热都慢 | 前端调度 / renderer / GPU sync 影响大 |
| 冷启动 JS Heap 峰值更高 | 资源加载与解码临时对象影响大 |
| 热启动 VRAM 仍高 | GPU resource residency / LOD sync 影响大 |

---

## 6. 建议输出格式

每组 case 输出一份 `results.json` 和一份汇总表。

### 6.1 总览表

| case | chunk | renderer | lodMode | budget | fpsP50 | fpsMin | blurP90 | gsplatsAvgM | jsHeapPeak | vramPeak | bottleneck |
|------|-------|----------|---------|--------|--------|--------|---------|-------------|------------|----------|------------|
| poland-96k-10m | 96k/10m | webgpu | performance | 3M | | | | | | | |
| poland-512k-16m | 512k/16m | webgpu | performance | 3M | | | | | | | |

### 6.2 调度明细表

| case | scanP95 | queueP95 | syncP95 | leavesEvalP95 | visibleLeavesP95 | candidateRefsP95 | candidateUniqueP95 | staleLodP95 |
|------|---------|----------|---------|----------------|-------------------|-------------------|--------------------|-------------|
| 96k/10m | | | | | | | | |
| 512k/16m | | | | | | | | |

### 6.3 内存明细表

| case | jsHeap@1st | jsHeapPeak | jsHeap@clearP90 | jsHeap@idle10s | vram@1st | vramPeak | vram@clearP90 | vram@idle10s |
|------|------------|------------|-----------------|----------------|----------|----------|---------------|--------------|
| 96k/10m | | | | | | | | |
| 512k/16m | | | | | | | | |

---

## 7. 瓶颈判定规则

### 7.1 Scheduler / scan 瓶颈

满足任意两条即可判定：

- `timingsMs.scan` P95 明显高于另一组（同 renderer/budget）。
- `leavesEvaluated` P50 接近 **2048** 且 `scanMode=full` 占比高。
- `candidateFileRefs` P95 明显高（分块 fan-out），但 **scan ms 仍 ~1** → fan-out 主要体现在 **queue/下载**，不是 scan 墙钟。
- `rendererGsplatsM` 接近，但 FPS 或 blur->clear 明显更差。

**注意**：`maxLeafEvaluationsCap=2048` 会钳制 scan CPU；分块变密时优先看 `candidateFileRefs`、`queueLen`、`timingsMs.queue`。

优化方向：

- 降低 `scan.maxLeafEvaluationsCap` / `maxLeafEvaluationsRatio`。
- 缩短 `burst.moveFrames`（默认 18 → 更少 full scan 帧）。
- 更强 dirty gate（减少 `traversalForceDirty`）。
- asset 侧减少过细 leaf fan-out。

### 7.2 Loader queue 瓶颈

满足任意两条即可判定：

- `timingsMs.queue` P95 高。
- `priorityQueued` 高但 `priorityInFlight` 低。
- `staleInFlight` 高。
- `queueLen` / `suspended` 长期高。
- `safeAbortedInflight` 经常发生。

优化方向：

- 降低 foreground/critical limit。
- 降低 burst concurrent 或 extreme concurrent，避免内存峰值。
- 减少小文件数量，优先 bundled。
- 更激进丢弃旧视角 suspended queue。

### 7.3 Instance sync / GPU update 瓶颈

满足任意两条即可判定：

- `timingsMs.sync` P95 高。
- `staleLoadedNodes` 高。
- `syncedInstances` 频繁非 0。
- WebGPU 比 WebGL 更明显。
- VRAM 峰值同步升高。

优化方向：

- 合并 sync，限制每 N 帧一次。
- 仅对 foreground/critical node sync。
- 减少 fileJustLanded 后的重复 sync。
- 检查 WebGPU deferred update 是否重建过多资源。

### 7.4 Renderer / GPU splat 瓶颈

满足任意两条即可判定：

- `rendererGsplatsM` 明显高。
- 降低 `splatBudget` 后 FPS 明显恢复。
- `vramTexPeakMb` 与 `rendererGsplatsM` 同步增长。
- `timingsMs.scan/queue/sync` 不高但 FPS 低。

优化方向：

- 降低 splat budget。
- 降低 `lodUnderfillLimit`。
- 更保守 target LOD。
- 优化 renderer / sort 路径。

### 7.5 内存 residency 瓶颈

满足任意两条即可判定：

- `jsHeapPeakMb` 或 `vramTexPeakMb` 在 96k 明显高。
- clear / idle 后不回落。
- `pinnedFiles`, `suspended`, `queueLen`, `staleInFlight` 长期高。
- warm start 内存峰值仍高。

优化方向：

- 限制 pin 数与 pin 生命周期。
- clear 后释放非 foreground stale resources。
- 限制 concurrent load。
- 分离 benchmark 截图/base64 对 JS Heap 的干扰。

---

## 8. 执行步骤（可复现命令）

### 8.1 逐帧交互 profiling（Finland / Poland）

```bash
# 终端 1
npm run develop

# 终端 2 — 约 3 min/场景，输出 docs/logs/refinement_*_v3.txt 或 native_*_finelod.txt
node scripts/frame-profile-interaction.mjs

# 移动量分桶 + 报告
node scripts/analyze-frame-profile-movement.mjs
```

手动 URL 示例：

```text
http://localhost:3000/?content=<lod-meta.json>&settings=/assets/settings/settings-finland-p0-benchmark.json&webgpu&benchmarkHud&budget=2.5&frameProfile=1&noanim
```

### 8.2 animTrack 路径 benchmark（blur→clear + FPS）

```bash
node scripts/benchmark-playwright.mjs public/benchmark-suites/scene-downtown-like.json
# 热启动对比
BENCHMARK_WARM_START=1 node scripts/benchmark-playwright.mjs public/benchmark-suites/<suite>.json
```

animTrack 模式 URL flags：`benchmark&benchmarkAnimTrack`；**不要**加 `noanim`。

### 8.3 调度 fan-out 排查（短 session）

```text
?debugOctreeRefinement=1&benchmarkHud&webgpu
```

交互 1–2 分钟后：

```js
copy(JSON.stringify(window.__octreeRefinementSamples, null, 2))
```

汇总脚本（本地）：对 JSON 数组求 `timingsMs.scan/queue/sync` 的 P50/P95/max，以及 `candidateFileRefs` P95。

### 8.4 推荐实验顺序

1. **frame-profiler v2** 录两场景交互 → 确认 frameMs/GPU/scan 占比（见 `docs/LOD调度性能瓶颈分析.md` §6）。
2. **debug=0** 下跑 animTrack suite → blurToClearMs、fpsP50、jsHeapPeak。
3. 只改一个变量（分块粒度 / budget / renderer）重复 1–2。
4. warm start 复跑 → 剥离 HTTP 下载。

### 8.5 汇总时必算指标

| 类别 | 指标 | 来源 |
|------|------|------|
| 整帧 | `frameMs` P50/P90 | frame-profiler |
| GPU | `gpu.totalMs` P50 | frame-profiler |
| 调度 | `refinement.tick.timingsMs.scan` P50/P95 | frame-profiler 或 debug |
| fan-out | `candidateFileRefs` P95, `leavesEvaluated` P50 | 同上 |
| 移动 | 按 `camera.moveSinceLastM` 分桶 | analyze 脚本 |
| 内存 | `jsHeapMb` / `vramTexMb` peak @ clear | benchmark-refinement tracker |
| 清晰 | `blurToClearMs`, `refineTimedOut` | animTrack results.json |

---

## 9. 最小结论模板

```md
## 结论

- 两组 `rendererGsplatsM` 接近 / 不接近：...
- 96k/10m 的 `scanP95` 是 512k/16m 的 ... 倍，主要来自 `leavesEvaluated` / `candidateFileRefs`。
- `queueP95` 是否升高：...；`staleInFlight` / `suspended` 是否异常：...
- `syncP95` 是否升高：...；WebGPU 与 WebGL 差异：...
- JS Heap 峰值差异：...；clear/idle 后是否回落：...
- VRAM 峰值差异：...；是否与 `visibleSplats.currentM` 或 stale loaded nodes 相关：...

瓶颈归因：scheduler scan / loader queue / instance sync / renderer GPU / memory residency / mixed。
下一步优化：...
```
