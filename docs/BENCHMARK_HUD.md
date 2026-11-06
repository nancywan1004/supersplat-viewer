# Benchmark HUD 参数说明

> URL：`?benchmarkHud=1`（可与 `?benchmark=1`、`?frameProfile=1` 叠加）。  
> 实现：`src/benchmark/benchmark-hud.ts` · Work Buffer 指标采样：`src/benchmark/benchmark-refinement.ts` → `readGsplatBufferUploadMetrics`。

HUD 右上角浮层，**250ms 刷新 DOM**；Work Buffer 相关数值在 **`frameend`** 采样（避免漏计本帧 bake）。Scheduler 区块来自 refinement controller **最近一次 tick**（≠ 每一渲染帧）。

---

## 1. 启用与布局

| 项 | 说明 |
|----|------|
| 启用 | `?benchmarkHud=1` |
| 标题 | `benchmark=1` 时为 `Benchmark · {label}`，否则 `Perf HUD` |
| 折叠 | 标题栏右侧 `▾`/`▸`；收起只留标题条；状态记在 `sessionStorage`（`benchmark-hud-collapsed`） |
| 进度条 | 场景加载进度 `state.progress` |
| 复制相机位姿 | 按钮输出 JSON：`position` / `target` / `fov` / 可选 `animTimeSec` |

---

## 2. 主面板行（按显示顺序）

### Progress

加载进度百分比（0–100）。

### Phase / Keyframe（仅 `benchmark=1`）

| 字段 | 说明 |
|------|------|
| Phase | `loading` / `anim` / `complete` 等 benchmark 阶段 |
| Keyframe | animTrack 当前关键帧名（phase=`anim` 时） |

### FPS / FPS P95

| 字段 | 说明 |
|------|------|
| FPS | 当前帧率；括号内 **P50** 为最近 **120 帧**滑动窗口中位数 |
| FPS P95 | 同窗口 **95 分位**帧率 |

### JS Heap

Chromium `performance.memory.usedJSHeapSize / totalJSHeapSize`（MB）。非 Chromium 显示 `N/A`。

**解读**：含 SOG 解码、下载队列、保活 file 等 JS 对象；Poland 96k 漫游后偏高常与 **file 常驻 + 保活泄漏** 相关，与 gapMs 慢帧机制不同。

### GPU VRAM

`app.stats.vram.tex`（MB），纹理显存合计。

### frame.gsplats

同屏 **active** 高斯数量（百万）。HUD 行名与 `app.stats.frame.gsplats` 对齐。

本 viewer 在 `frameend` 把 `renderer._gsplatCount` 写回该字段（修复 `autoRender=false` 时引擎在 tick 开头拷贝导致常为 0）。

非 LOD 单文件 SOG：整包进 WB，**frame.gsplats ≈ 文件总点数**（这是引擎口径，不是 bug）。要控点数请用 LOD。

### GPU frustum

仅 **GPU-sort**（`intervalCompaction.numSplatsBuffer`）有值：interval AABB 视锥 cull + projector 可见性之后、间接绘制用的 splat 数（百万）。约 200ms 节流；**须 immediate readback**（引擎非 immediate 路径不 submit，会恒读 0）。

非 LOD 对照：`frame.gsplats` = WB 全量 active；`GPU frustum` = 本帧真正送去画的数量。整包只有一个大 AABB 且几乎总在锥内时，两者可能接近；贴脸/裁切强时 `GPU frustum` 会明显更低。

CPU-sort 路径无此 buffer → 不显示该行。

### Asset（仅当与 Gsplats 不同时显示）

已加载资源的 `numSplats` 合计（文件/chunk 体积口径）。LOD 下常与上屏 interval active 不同。

### SplatBudget / Budget fill

仅 **LOD**（或场景已设 `splatBudget>0`）时显示。非 LOD 默认不写 budget、HUD 也不展示这两行。

### DrawCalls

`app.stats.drawCalls.total`：本帧 gsplat **interval / compaction 参与块数**。

**解读**：稳态 refinement ~2；burst 换档慢帧常 **20–30+**，与 `gapMs` 强相关，是 bake 并行度的探针。

### Renderer

`scene.gsplat.currentRenderer` 枚举值（compute / raster 等）。

### SplatBudget

`scene.gsplat.splatBudget`（个 splat）：

- `0` → 显示 `0 / uncapped`（native billions 路径常见）
- `>0` → 如 `2.50M`

**作用**：

1. LOD 选档软上限（同屏点数预算）
2. Work Buffer **初始容量** ≈ `ceil(splatBudget × 1.15)`（引擎 `ALLOCATOR_GROW_MULTIPLIER`）

**注意**：budget 定**起步** pool 大小，**不是** capacity 硬顶；占用超了引擎仍可 **grow**（见 WB Cap）。

### Budget fill

`readGsplatBudgetFill` / `formatGsplatBudgetFill`（**统一全树口径**，与 PlayCanvas `evaluateNodeLods` 一致）：

| 模式 | 显示 |
|------|------|
| **LOD** | `cur · opt · adj (bud) · opt/adj% · cur/opt%` |
| **非 LOD** | `cur (bud) · cur/bud%` |

- **cur / opt**：全树 Σ `currentLod` / `optimalLod` 点数（**含视锥外**）
- **adj / bud**：引擎有效预算 / 名义 `splatBudget`
- 原生 budget balancer 也是全树 Σoptimal，故与 HUD 对齐

`cur/opt<100%` 且 Refine 已完成：通常是视锥外目标细、上屏仍粗（下载未追齐），不是口径拆成两套。

### Center fill / Edge fill / Out fill（LOD）

在 Budget fill（全树）旁拆区，区分「中央追齐 / 视锥内外围滞后 / 视锥外不入队」：

| 行 | 含义 |
|----|------|
| **Center fill** | 视锥内且 `edgeFactor ≥ 0.45`；≈100% 时 **`OK`** → 中央已追上各自 `optimalLod` |
| **Edge fill** | **仅视锥内**非中央；应对齐同一 `engineOptimal`，**可滞后、不挡完成**；≈100% 亦标 **`OK`**。长期偏低才是真「外围不追满」 |
| **Out fill** | **视锥外**；不入队升档。v1：`evaluateNodeLods` 后钳 `optimal→bootstrap`（**budget 回填视锥内**）+ `applyLodChanges`/idle drip 降 `current`（不 unload）。移动后 **Out cur↓**，且 **opt/adj 应回升**（额度给 Center/Edge）。后缀 **`不入队`** = 不追细 |

判读顺序建议：

1. **Budget fill `opt/adj`** → 视锥外钳粗后，若 **Asset 总点数 < Budget**，全树 opt **不可能**贴满 adj（例如 Asset 3.6M / bud 6M）。`×100` 为异常（budgetScale 失控）；正常多为 `×0.7～×1.2`
2. **Center / Edge fill `OK`** → 可见区已追上各自目标
3. **Out fill `cur` 很小** → 视锥外加速降档生效
4. Scheduler **OOF ↓** → 本拍仍在吐视锥外细档

与 Refine 行「细档 centerClear/centerTarget」互补：后者看节点数是否细档上屏，前者看点数是否追齐 `optimal`。

---

## 3. Work Buffer（WB）相关

**WB = Work Buffer**：换档 bake 后高斯数据写入的 GPU 纹理（C 层 slot 池）。SOG → bake → WB → draw。

```
SOG Resource  ──bake──►  Work Buffer (slot 池)  ──►  GPU draw
                              ▲
                         BlockAllocator 管 capacity / used / 碎片
```

### WB Cap

格式：`{used}/{capacity}M · hard {hardCap}M`

| 片段 | 引擎字段 | 含义 |
|------|----------|------|
| **used** | `BlockAllocator.usedSize` | 当前已分配给 MemBlock 的 **slot 总数**（常驻占用） |
| **capacity** | `BlockAllocator.capacity` | WB **slot 池总容量**（座位总数） |
| **hard** | `maxTextureSize²` | GPU 纹理布局的**绝对上限** slot 数 |

**示例**：`2.16/2.88M · hard 268M` = 已用 216 万 slot / 池子 288 万 slot。

- 看 **状态快照**（池子装了多少），不是本帧写了多少
- `capacity` 初始 ≈ `splatBudget × 1.15`；Poland `budget=2.5` → **2.875M**
- `used` 接近 `capacity` 时可能触发 **grow + defrag**（engine literal fullRebuild）

### WB Frag

格式：`{fragmentation}% · tex {textureSize}`

| 片段 | 含义 |
|------|------|
| **fragmentation** | BlockAllocator 碎片率 0–100%；空闲 slot 被拆散程度 |
| **tex** | WB 纹理边长 ≈ `ceil(sqrt(capacity))` |

碎片高 + burst 大量换档 → 更容易 grow / 全量 defrag。

### WB Blocks

格式：`{uploadedBlocks}/{totalBlocks} · {copyPct}%` 或 `—`

| 字段 | 引擎来源 | 含义 |
|------|----------|------|
| **uploadedBlocks** | `bufferCopyUploaded`（本帧） | 本帧各次 bake 累加的「上传块次数」；**无 bake 时 HUD 读 0**（见下） |
| **totalBlocks** | `bufferCopyTotal` ≈ `allocationMap.size` | 当时账本中的 MemBlock 行数（≠ slot 数）；idle 时仍显示账本规模 |
| **copyPct** | `uploaded/total×100` | 与 profiler `cpu.gsplatBufferCopyPct` 同口径；以 `stats.frame.gsplatBufferCopy` 为准：**为 0 则本帧视为无 upload**（避免 world 计数粘住） |

**解读**：与 `DrawCalls` / `gapMs` 强相关；Poland 慢帧常见高 copyPct（78–100%）。`frameend` 采样，与 WB Upload 同源。

### WB Upload

格式：`{uploadMbEst}MB` 或 `—`；多趟 bake 时 `· ×N pass`

| 字段 | 计算 | 含义 |
|------|------|------|
| **uploadMbEst** | `uploadSplatSlotsEst × 40B` | 本帧估计从 SOG **拷入 WB 的数据量** |
| **×N pass** | `bakePassesEst ≈ round(uploadedBlocks/totalBlocks)` | 同帧多次 `rebuildWorkBuffer` |

**解读**：慢帧常突然变大（Poland P50 ~28MB）；对应 profiler 里 `gapMs` 主因（CPU bake，非 GPU draw）。

### WB Bake %

格式：`{pct}% · {uploadSlots}/{capacity}M slots · peak {peakPct}% · bud {budget}M`

| 片段 | 计算 | 含义 |
|------|------|------|
| **pct** | `uploadSplatSlotsEst / allocatorCapacity × 100` | 本帧写入 slot 数占 **capacity** 的比例 |
| **uploadSlots/capacity** | 同上，绝对值（百万 slot） | |
| **peak** | 本会话 `bakeCapacityPct` 最大值 | 找最卡帧 |
| **bud** | 当前 splatBudget（百万） | 对照 capacity 来源 |

**与 WB Cap 区别**：

| 行 | 问什么 |
|----|--------|
| WB Cap | 池子**现在**装了多少（状态） |
| WB Bake % | 本帧**又改写了**容量的百分之几（事件） |

burst 慢帧：`DrawCalls`↑ 常伴随 `WB Bake %` / `peak`↑。

### Gap bake / NeedsUp（引擎计时）

有 bake 活动时出现：

| 行 | 含义 |
|----|------|
| **Gap bake** | `bakeCpu · write · world · place`（ms）：引擎 `_lastFrame*`，**≠** `gapMs` 残差 |
| **NeedsUp** | 本帧 `needsUpload` 块数 / slots；`FULL` = `_lastFrameFullRebuild` |

判读：`gapMs` 高且 **bakeCpu/write 高** → 数据面 bake；**bake 不高** → 查 longtask / resource / 其它。详见 [Gap归因第一阶段说明.md](Gap归因第一阶段说明.md)。

---

## 4. Refinement 摘要行

### Refine

格式：`{ratio}% · pending {n}` · 可选 `· 细档{clear}/{target}` · 可选 `· ctr↓{n}` · `· phase=bootFast|polish` · 可选 `· dl`

| 字段 | 含义 |
|------|------|
| **ratio** | 中央细档上屏比例 `clear/target`（相对当前有效目标：BootstrapFast=`visualTarget`，polish=`engineOptimal`） |
| **pending** | 前景仍缺 unique 文件数 |
| **细档** | `centerClearNodes` / `centerTargetNodes`（首屏收条门槛：中央 100%） |
| **ctr↓** | 中央区仍粗于 / 等待当前有效目标的 node 数（**不是**「正在换挡」计数） |
| **phase** | `bootFast`=初始加载粗档收条；`polish`=追满 engineOptimal |
| **dl** | `activityActive`：boost / 下载活跃 |

### Pending peak（benchmark anim 期间）

当前 keyframe 等待变清过程中的 **pending 峰值**（与 Blur→Clear 区块联动）。

---

## 5. Scheduler tick 区块（≠ 渲染帧）

标题：`Scheduler tick (≠ frame)`。数据来自 `OctreeRefinementController.getLastTickMetrics()`，**一次 runPriorityPrefetch  tick 一条**，刷新频率低于 FPS。

### Scan mode

`full` / `incremental` / `skip`：本轮 scan 策略。

### Tick ms

`total (scan · q · sync)`：该 tick CPU 耗时拆分。Poland 典型 **scan ~1ms**，慢帧不在此。

### Leaves

`leavesEvaluated · vis {visibleLeaves} · scored {scoredLeaves}`：视锥遍历叶数。

### Cand refs

`candidateFileRefs · uniq {candidateUniqueFiles}`：本轮排队下载 **file 引用次数** / 去重 file 数。Poland burst 峰值可达 **1000+**。

### Stale LOD

| 片段 | 含义 |
|------|------|
| **待升** (`staleLodNodes`) | `currentLod > targetLod`，需要升档 |
| **已下未上** (`staleLoadedNodes`) | target 对应 **file 已落地** 但未 sync 上屏 |
| **引擎差** (`lodDisplayMismatch`) | 视锥内 `current ≠ engine optimal`；括号拆：`放宽`（历史字段，边缘已不再放宽目标，通常为 0）/ `更细` / `外缘` edgeFactor≤0 / `其它` |
| **ctr↓** (`centerEngineBehindNodes`) | 中央区仍粗于 / 等待当前有效目标；旁注 `细档 clear/target` 为收条比例；`phase=` 见 Refine |

### Burst

`{cameraBurstFrames} fr` · 可选 `· boost`：burst 剩余帧数 / 是否 boost 模式。

### Downloads

`{inFlight} fly · q{queueLen} · susp {suspended} · max {maxConcurrent}` · 可选 `· stale {staleInFlight}` · 可选 `· fail N(backoff a/perm b)`：下载队列状态。

| 字段 | 含义 |
|------|------|
| **max** | `loader.maxConcurrentLoads` 当前上限；可用 URL `?maxConcurrent=N` 锁定（对照 1/2/4/8） |
| **fail** | 引擎 `maxRetries` 耗尽后的外层失败文件数 |
| **backoff** | 等待卸载假 `loaded` 后再试 |
| **perm** | 外层也耗尽：已从 pending/收条剔除，不再堵进度条 |

### RenderScale（仅 `lodSelectMode: "renderScale"`）

`rs {lodRenderScale} · clamp N · urg X · {meta|aabb-fallback|mixed}`：

| 片段 | 含义 |
|------|------|
| **rs** | 中央目标屏上直径（px），即 settings `lodRenderScale` |
| **clamp** | 本拍被视觉目标抬粗的叶数 |
| **urg** | 入队文件 `visualUrgency` 均值 |
| **表来源** | `meta` / `aabb-fallback` / `mixed` |

### LOD est

`cur {visibleSplatsCurrentM}M · tgt {visibleSplatsTargetM}M`：视锥内当前/目标 splat 估计（百万）。

---

## 6. Blur→Clear 区块（benchmark anim）

每个 keyframe 一行：`{label}` → `{blurToClearMs}` · 可选 `peak {pendingPeakNodes}`

| 字段 | 含义 |
|------|------|
| **blurToClearMs** | pending **从峰值降到 0** 且 ratio≥0.95 的耗时 |
| **peak** | 该 keyframe 等待期间 pending 峰值 |
| **timeout** | 等待超时未变清 |
| **live …** | 当前 keyframe 进行中（黄色） |

---

## 7. 其他行

| 行 | 条件 | 含义 |
|----|------|------|
| **FrameProfile** | `?frameProfile=1` | `REC N` 录制中 / `idle N` 已采样帧数 |
| **Anim** | 有 animTrack | 当前时间 / 总时长 |
| **Loaded** | `state.loaded` | `yes` = readyToRender；`warming` = 加载中 |

---

## 8. frameProfile 离线字段（HUD 不展示）

`?frameProfile=1` 导出 JSON 另含：

| 字段 | 说明 |
|------|------|
| `bufferUpload.fullRebuild` / `fullRebuildSource` | engine：`worldState.fullRebuild`；inferred：upload 覆盖 ≥95% totalBlocks。**勿与旧 HUD「FULL rebuild 计数」混读** |
| `bufferUpload.copyPct` | `uploadedBlocks/totalBlocks×100`，可 >100（同帧多趟 bake） |
| `bufferUpload.memBlockBakePct` | dirty MemBlock 占 allocationMap 块数比例（易误解，HUD 已移除） |
| `bufferUpload.worldUpdateMs` / `placementIntegrateMs` / `bakeCpuMs` / `writeBufferMs` | 引擎本帧计时 |
| `bufferUpload.needsUploadBlocks` / `needsUploadSlots` / `engineFrameFullRebuild` | 本帧 upload 规模与 full 标记 |
| `gapAttribution.*` | 同上汇总 + `engineAccountedMs`；与 `refinement.gapMs` 对照 |
| `longTask` | Chromium longtask 合计（可含 GC） |
| `resourceTiming` | 本帧窗口 Resource Timing（下载为主） |
| `cpu.cullMs` / `sortMs` | PlayCanvas cull / sort |

用法与判别：见 [Gap归因第一阶段说明.md](Gap归因第一阶段说明.md)。

---

## 9. 慢帧对照（Poland 96k · budget=2.5 · refinement）

| 指标 | 快档 P50 | 慢档 P50 | 说明 |
|------|---------:|---------:|------|
| FPS | ~50 | ~8 | |
| DrawCalls | 2 | **26** | 换档块数 |
| gapMs（frameProfile） | ~13ms | **~119ms** | bake 残差 |
| WB Bake % | ~0 | **10–20%+** | 本帧改写 capacity 比例 |
| WB Upload | 低 | **~28MB** | |
| engine fullRebuild | 0 | 0 | capacity 未 grow |
| staleLoadedNodes（tick） | 低 | burst 后高 | 已下未上 |

---

## 10. 相关文档

- [SCENE_PROFILE_BENCHMARK.md](SCENE_PROFILE_BENCHMARK.md) — benchmark 流程与 `results.json` 字段
- [logs/refinement_poland_v3-bottleneck.md](logs/refinement_poland_v3-bottleneck.md) — gapMs / bake / WB 瓶颈归因
- Canvas：`gsplat-world-data-flow.canvas.tsx` — WB / allocId / bake 数据流
