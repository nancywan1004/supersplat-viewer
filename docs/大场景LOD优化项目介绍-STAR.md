# 大场景 3DGS LOD 优化 · 项目梳理（STAR）

> 用于个人网站的项目介绍。按 STAR 组织：**先讲原架构的结构性难点，再讲为什么必须先建一套评测体系，然后讲优化的核心目标与方案，最后给量化结果与被数据否决的方向。**
>
> **数据可信度约定**（全文遵守）：
> - 标 `实测` 的数字来自 `benchmark-reports/` 与 `docs/logs/*-bottleneck.md` 的权威轮；
> - 标 `目标` 的是规格文档里的验收线，**不是已达成值**；
> - 标 `已作废` 的来自 `docs/logs/_superseded-2026-07-pre-bootstrap-fix/`，该目录 README 明确"不以其中数字为结论依据"（采集于首屏全树轮询修复前）。

---

## 0. 一句话概述

在浏览器里把 **1 亿 ~ 3 亿点**的 3DGS 场景做成"打开就能看、漫游不卡、停下就清晰"的产品，需要解决的不是"渲染更多点"，而是**在有限的网络、显存和单帧预算下，决定"现在该有哪些点、以什么顺序到达、什么时候可以上屏"**。

我在这套 viewer 上做的工作可以概括为四件事：

1. **建立一套可复现、多尺度同判据的评测体系**——因为在亿级场景里"手感变好了"是不可证伪的，没有尺子就没有优化；
2. **重构调度语义**——把"引擎算目标、viewer 编排下载与上屏"的职责切开，用评分 + 预取 + 门控让"该清的块先清"变成确定性行为；
3. **让预算真正驱动起来**——引擎的两个关键默认值（`splatBudget=0`、`lodUnderfillLimit=0`）实际是"关闭"语义，需要对齐兜底半径、覆盖顺序与反馈环，否则画面完全不受控；
4. **把优化的杠杆推到离线侧**——运行时优化到 `scan 1.7 ms` 之后，真正决定上限的是**离线分块粒度**（叶子数 = 运行时 block 数 = 慢帧），并用五档扫描证明"不是越细越好"。

---

## 1. Situation：原架构的难点

### 1.1 问题的物理来源

3DGS 大场景的数据量和普通模型不是一个量级：

| 场景 | 最高精度点数 | 文件数 | 叶子数 | 场景对角线 |
|---|---:|---:|---:|---:|
| 南广场 v6 | 4,089 万 | 630 | 11,612 | 593 m |
| Finland | 5,518 万 | 1,113 | 98,450 | 1.3×1.4 km |
| Poland（重建版） | 1.0645 亿 | 1,789 | 32,756 | 4,372 m |
| 济南桥 jinanqiao-v3-x10 | 2.94 亿 | 2,791 | 80,596 | 3,515 m |

一次性下载不可能（几个 GB）。所以必须走 **分块 + 分级 + 流式**：

- 离线把场景切成空间块（chunk），每块预生成 L0（细）到 L9～L11（粗）多档；
- 运行时按视角决定"这个块显示哪一档"，只下载缺的那一档。

这套结构带来一个硬约束：**变清速度受 HTTP 支配**。一档一文件，用户往前走进一个新区块，就要等新的 HTTP 请求回来。所有调度优化，本质是在"有限的带宽和并发槽位"里做取舍。

### 1.2 原架构的五层结构性难点

在动手之前，我先梳理了这套 chunk-based 管线的固有难点（对照了 Aholo Chunk-LOD、Spark / Tiny-LOD / Bhatt-LOD 三种管线）：

| # | 难点 | 具体表现 | 为什么难 |
|---|---|---|---|
| 1 | **职责边界模糊** | 引擎有 `optimalLod`，viewer 又有自己的距离判断，两边都能改档位 | 谁说了算不清晰，改一处影响另一处，参数互相打架 |
| 2 | **"糊"与"消失"是两种错误** | 缺档时如果直接不画就是空洞；用父档兜底才是"糊" | 前者是 bug 级观感（panHole），后者是可接受降级，但需要 budget 允许 underfill |
| 3 | **换档 = 大批量显存上传** | 一次 sync 把多块新高斯数据写进 work buffer | 单帧 CPU 尖峰，且与 GPU 无关，profile 里表现为"gap" |
| 4 | **抖动** | budget 每帧重算 → 缺档集合每帧变 → 队列反复挂起/恢复 → pending 长期不归零 → 画面闪 | 三个原因叠加，单看每个都"没错" |
| 5 | **首屏"假完成"** | 粗档先到位就能画了，但进度条说 100% 时中央其实还是糊的 | 需要区分"能看"和"清晰"两个语义 |

### 1.3 优化前的实测基线（这是后面一切对比的锚点）

| 指标 | 值 | 说明 |
|---|---|---|
| 慢档帧（140–200 ms）占比 | **35.8%**（192/535） | Poland 96k，`实测` |
| 慢档 `gapMs` P90 | **143 ms** | 帧时间减去所有已计时项 |
| `totalBlocks` P50 | ≈ **21 万** | work buffer 分块数 |
| 上传帧 `uploadedBlocks/totalBlocks` P50 | **78%** | 即上传帧几乎全量重写 |
| 慢档 `drawCalls` P90 | 65 | |
| Poland 1.04 亿冷启动 | **~30 s** | `实测` |
| Poland 停住后 blur→clear | **~30 s** | `实测`（native 粗分块口径） |

> 注意这里的对比陷阱：同一份"Poland"存在三种资产版本（CDN 原版 36 万叶 / 重建版 3.2 万叶 / 98k 分块版），数字差异巨大。**跨版本对比是无意义的**，这本身也是必须先建评测体系的原因之一。

### 1.4 关键一步：先做归因，而不是先做优化

原架构"慢"的表象是一致的（掉帧、模糊时间长），但可能的原因有五六种。我先用逐帧 profiler 把慢帧与快帧做对照，得到三个反直觉结论：

| 假设 | 实测 | 结论 |
|---|---|---|
| 扫描全树节点太慢 | `scan` P50 **1.7 ms** / P90 2.2 ms | **不是瓶颈** |
| sync 调度入口太重 | `sync` **0.00 ms** | **不是瓶颈** |
| GPU 画不动 | 慢帧 `gpu.totalMs` **8.3 ms**（P90 13.8） | **不是瓶颈** |
| —— | 慢帧 `copyPct` P90 **100%**、`gapMs` max **125.7 ms** | 真正的成本是 **CPU 把新高斯数据写进显存** |
| —— | 慢帧 **100%** 落在 camera burst 窗口内（5/5 帧） | 触发条件明确 |

进一步做"碎片化"归因，找到了更底层的原因：

| 场景 | splats / block | totalBlocks P50 | 首帧 totalBlocks |
|---|---:|---:|---|
| Poland | **~4.9** | 122,908 | 45,480（恰好等于最粗档 leaf 数） |
| 济南桥 | **~41.8** | 27,158 | 22,476 |

> **首帧 totalBlocks 精确等于最粗档叶子数** —— 这说明 **一个叶子 = 一个上屏 interval = 一个 mem block**。
> 推论：**叶片切得越碎，运行时 block 数越多，换档时的一次性开销越大。**
> 这条推论后来被独立实验证实（见 §5.2），并直接推翻了"优化调度算法"这个初始方向。

---

## 2. Task：目标与约束

### 2.1 体验目标（先量化"好"是什么）

| 维度 | 指标 | 目标线 |
|---|---|---|
| 打开 | `bootMs`（首帧） | < 2 s |
| 变清 | `blurToClearMs` | < 5 s |
| 流畅 | `fpsP50` | ≥ 60 |
| 无空洞 | `panHoleCount` | **0**（允许变糊，禁止整块消失） |
| 不退化 | separate 资产回归 | 零行为变化 |

### 2.2 工程约束

| 约束 | 影响 |
|---|---|
| **不改资产生成管线的前提** | 一档一文件的物理下限在，burst 无法跳过 HTTP + 解析 |
| **不能增加显存峰值** | 优化不能靠"多缓存几档"换速度 |
| **引擎是外部依赖**（PlayCanvas 2.20） | 只能在引擎暴露的原语上编排，不能改引擎内部 bake |
| **运行时分支收敛** | `native`（引擎完全接管）曾并行存在，后收敛为主路径 `refinement`；`isNativeLodRuntime()` 目前仅保留定义、无调用点，属预留分支 |
| **多设备档位** | mobile / desktop 的并发、budget、窗口参数不同 |

### 2.3 一个前置判断：不可测 = 不可优化

这是我做这个项目时最先确认的事。

大场景 LOD 的问题是**跨尺度的**：可能是 1 帧的尖峰，可能是 30 秒的收敛，可能是 200 MB 的内存漂移。而"用户觉得卡"这句话无法定位到任何一层。

所以我把"建评测体系"当成 Task 的一部分，而不是附属工作。**没有它，后面的每一个优化都无法证明有效，也无法证明没有副作用。**

---

## 3. Action

### 3.1 第一步：建一套五层评测体系

不是写一个 benchmark 脚本，而是做出一条**从体感到函数栈的连续可下钻链路**：

```
L1  在线 HUD           ?benchmarkHud=1       ← 回答"现在发生了什么"
L2  逐帧采样器         ?frameProfile=1       ← 回答"这一帧花在哪"
L3  批量实验台         Playwright suite      ← 回答"A 和 B 哪个好"
L4  一致性门禁         bake-acceptance       ← 回答"有没有偷偷把工作丢了"
L5  函数级下钻         CDP CPU Profile       ← 回答"具体哪个函数"
```

#### (1) 定义核心 KPI：blur→clear

这是整个项目最重要的一个定义。不能用"到点后等 5 秒看看"：

```
清晰判据：  pendingNodes === 0  &&  refinementRatio >= 0.95  &&  ready
稳定判据：  连续 4 次采样（200 ms 间隔，共 800 ms）都满足
超时判据：  45 s 未满足 → 记 refineTimedOut，而不是记 45 s
计时起点：  pending 峰值时刻（不是用户到达时刻）
```

其中：
- `pendingNodes` 用的是 **`stableForegroundPending`**（前景 unique 文件缺失数），不是会振荡的 `pendingUniqueFiles`；
- `refinementRatio` 是 **屏幕中央**区域的细档上屏率，不是全屏——因为用户看的是中央。

> **为什么"从 pending 峰值起算"很重要**：如果从到点起算，一个"到点就立即补齐"的实现会得到接近 0 的结果；而从峰值起算才能反映"真正需要多久变清"。

#### (2) 解决"口径混乱"：四套点数口径

这是踩过的真实坑——只看 HUD 上那个 `Gsplats` 会得出完全错误的结论：

| 口径 | 含义 | 用途 |
|---|---|---|
| `rendererGsplatsM` | 引擎 `stats.frame.gsplats` | 快速参考，**易误导** |
| `visibleSplats.currentM` | 全树 Σ`currentLod` | 判断"调度追到哪了" |
| `optimalM` | 全树 Σ`optimalLod` | 判断"目标在哪" |
| `targetM` | 预算允许的目标 | 判断"是否被 budget 卡住" |

并进一步把 `optimalM` 拆成 **中央 / 视锥内边缘 / 视锥外** 三段（按 `edgeFactor ≥ 0.45` 分界），因为"中央没追齐"和"视锥外不算"是两种完全不同的落后。

> **副产品**：还发现 `app.stats.frame.gsplats` 在 `autoRender=false` 下恒为 0——如果不先修这个量具（`sync-frame-gsplats.ts`），所有"同屏点数"指标在 benchmark 模式下都是假的。**先修量具，再量东西。**

#### (3) 让逐帧采样可信

`frame-profiler` 采样 20+ 个字段（CPU 分项 / GPU pass / gap / bake 归因 / longtask / 网络 / 相机增量），其中两个设计值得说明：

- **`gapMs` 的定义是显式的**：`frameMs − (update + render + gpu + tick + deferredInstUpdate)`，文件里写明"含 GC 与未计时引擎路径，**≠ 纯 bake**"。不做这种声明，后面所有归因都会吵起来。
- **不可信值回退墙钟**：生产版 PlayCanvas 没设 `renderStart/updateStart`，`stats.frame.renderTime` 是不可信的。做法是 `isPlausibleDurationMs(value, frameMs)` 校验，不合法就回退到 `postrenderAt − framerenderAt`。
- **观测阈值 = 执行阈值**：profiler 里 `moveTriggersLod := move > 0.03 m`、`rotateTriggersLod := dot < cos(3°)`，与调度器真实阈值一字不差。否则会出现"profiler 说触发了、调度器说没触发"的口径分裂。

#### (4) 让批量实验可比

`benchmark-playwright.mjs` 解决三件事：

| 问题 | 做法 |
|---|---|
| 冷/热启动混杂 | 默认冷启动：**每个 case 独立 Chromium** + 禁 disk cache + 禁 SW；热启动需显式 opt-in，且**丢弃第一个 case 作 warmup** |
| 相机路径不可复现 | 统一走 animTrack：第 i 帧先 scrub 回 i−1（暂停态）再 play 到 i，**每次从同一姿势起步** |
| 报告不可读 | 自动生成 `summary.md`：运行条件 → 主表 → 逐 keyframe 表 → **优化前后 Δ% 对比段**（组内第 1 个 case 自动作 baseline） |

**诚实的边界声明**（写在每份报告里）：OS page cache、DNS、GPU pipeline cache 不重置，跨次运行仍可能漂移。

#### (5) 建立验收门禁

不放在 CI 里做断言，而是**每阶段一份 acceptance 文档，固定三列：指标 | 基线 | 本次 | Δ | 门禁，逐行 ✅/❌**。并且写了硬约束：

> **禁止在未达标时进入下一阶段。**

这条规则后来真的用上了——Phase B 四项指标全 ❌，Phase C 被阻断（见 §4）。

其中 `bake-acceptance` 提供了一类特别的指标：**正确性门禁**，不只测性能。

| 判据 | 含义 |
|---|---|
| `syncAdvance.advanceRatio` | sync 后 5 帧内 `worldStateVersion` / `currentLodSum` 是否推进——**sync 了但状态没变 = 假 sync** |
| `dirtyForcedWorkBufferRebuild` | LOD sync 是否偷偷走了"dirty 强制全量重建"（回归探针） |
| `staleLoadedNodes.maxConsecutiveFrames` | "已下载未上屏"最长连续帧——通道是否堵死 |

> 这类指标的价值：性能优化最容易"把工作偷偷丢掉"来变快。没有正确性门禁，快了 30% 也可能是假的。

---

### 3.2 核心目标与方案：把"该清的块先清"变成确定性行为

优化方案围绕四个问题组织。这是整个 Action 的主干：

```
① 目标档位谁算？   → 引擎算 optimalLod，viewer 只做"编排"，不重复实现选档
② 先下载谁？       → 五维评分 + 视口边缘因子 + 档位紧迫度
③ 同时下多少？     → 四级预取 + 四档并发 + tracked/pin/gate 三件套
④ 什么时候上屏？   → 六路 sync 触发 + 同帧去重 + burst 窗口
```

#### ① 职责切分：引擎算目标，viewer 做编排

原架构两边都在算档位，参数互相打架。改成：

```ts
// viewer 不自己算 SSE，直接读引擎写入的 optimalLod
const currentLod = nodeInfo?.currentLod ?? -1;
let engineOptimalLod = nodeInfo?.optimalLod ?? -1;
```

viewer 只保留三件引擎做不到的事：

- **距离修正**：身后块惩罚（`lodBehindPenalty`）、FOV 归一化（窄 FOV 更激进要细档）；
- **ladder 限速**：一次只升有限档（下面讲）；
- **下载编排**：评分、并发、门控、上屏时机。

这个切分是后面所有优化的前提——**只有职责清晰，参数才有意义**。

#### ② 下载评分：把"看得见的、中心的、差得多的"排在前面

```ts
score = screenSize × lodUrgency × centerBias / (1 + localDistance × 0.02)
```

三处关键修正，都是踩坑后加的：

| 修正 | 原实现的问题 | 现在的做法 |
|---|---|---|
| **centerBias 向量** | 用了未减相机位置的向量，导致"后方先清晰、前方后清晰" | `(worldCenter − cameraPos) · forward` |
| **视口边缘因子** | 只看 AABB 中心点，近处前景块常只覆盖屏幕边缘却被判成中心块 | 用 AABB **8 角投影矩形的最近距离**计算 `edgeFactor` |
| **档位紧迫度** | 所有缺档一视同仁 | `lodUrgency = 1 + (maxLod − optimalLod) × 0.5`，L0 再 ×1.25 |

边缘权重用 **5 次幂**塌陷（`centerScorePower = 5.0`），但保留 **0.08 的地板**——这是为了防一个具体故障：视锥外缘的块被彻底跳过，导致"引擎留了预算却永远不下载"，budget 顶不满。

#### ③ 并发与预取：四档并发 + 三件套

并发不是单一数值，而是按状态分档（desktop / mobile）：

| 档 | 触发条件 | 并发 |
|---|---|---|
| default | 常态 | 2 / 2 |
| boost | 明确需要细化 | 8 / 4 |
| burst | 相机移动后 18–48 帧 | 12 / 8 |
| emergency | stale 积压 | 32 / 16 |
| extreme | stale 占满 | 64 / 32 |

配套三件套解决"pending 卡在某个值不动"：

| 机制 | 作用 |
|---|---|
| `trackedMissingFiles` | 进候选就跟踪到 loaded，不因每帧分数抖动被踢出队列 |
| `pinLoadedForegroundFiles` | 入队前 `incRefCount`，防"下完即卸"（`pinLimit 12/6`） |
| `expandDownloadGateUrls` | gate = 优先 URL ∪ **正在下载** URL，避免 reconcile 把 in-flight 误判为非优先而 suspend |

这三条对应的正是"pending 长期卡在 ~17"的**三个叠加成因**：budget 振荡、队列 reconcile 打断、下完即卸。

#### ④ 上屏时机：六路 sync 触发 + 同帧去重

上屏（把已下载的档位真正切上去）比下载更容易出错，因为它依赖引擎内部两个不同语义的调用：

| 引擎原语 | 语义 |
|---|---|
| `requestOctreePlacementUpdate` | WorldState 增量 bake，**不重建 WorkBuffer** |
| `requestOctreeLodUpdate` | 下一拍走 `updateLod / _enforceBudget / applyLodChanges` |

**必须配对**。只做前者会出现一个很典型的卡死：`pending = 0` 但画面还是粗的——因为相机静止且无 dirty 时，引擎只在 `fullUpdate` 里消费 `needsLodUpdate`。

六路触发条件（任一满足即 sync，同帧去重）：

`burst_lod_switch` / `file_landed_lod` / `stale_limit` / `stale_cooldown` / `post_download` / `file_landed_fallback` / `frame_ready_loading_drop`

#### ⑤ 治抖动：ladder + OOF + settle hold

三个机制，各自针对一种抖动：

| 机制 | 防的现象 | 关键参数 |
|---|---|---|
| **ladder 逐档** | 一步追 L0 导致"要么最糊、要么突然全清"，中间过程不可见 | 中央一次 2 档、边缘 1 档、积压 3 档；最粗档 ×2.75 分加成 |
| **OOF 视锥外降档** | 看不见的块白占 budget 与 work buffer（详见 §3.5） | 只在"相机静止 + burst 结束 + 前景 pending=0"时执行，`maxNodes 32/拍` |
| **settle hold gate** | pending 归零瞬间放开队列 → 外围涌入 → underfill 跳档 → 闪 | hold 30 帧，且 hold 条件**刻意不含** `staleLodNodes` |

> 最后这点是个细节但很关键：如果用 `staleLodNodes` 作为 hold 条件，挪机后 stale 会长期存在，一直沿用旧视角的 URL，**新中心的 sync/下载被卡死**。

#### ⑥ 首屏：用状态机替代固定等待

原来的首屏是"等一段时间，或者等 pending 归零"，结果是两难：等 pending 归零，大场景永远不收条；等固定时间，小场景白等。

改成四阶段状态机：

```
gate 50%  →  coarseCap 82%  →  refineCap 99%  →  100% 收条
收条条件：中央细档 ≥ 1.0 + pending/stale/settle 全清 + settle 周期 ≥ 2 + quietTicks ≥ 24
```

并加了两个防呆：

- **假完成防护**：粗档对齐导致的"虚高 clear"不算数；
- **escape 逃生**：360 帧 / 720 帧（约 6 s / 12 s）强制降级收条，避免永久卡在 82%。

#### ⑦ 让"清晰"可定义：renderScale 选档模式

米制距离选档（`lodBaseDistance 5 m`、`lodMultiplier 3`）对高密度场景不准：同样是 5 m，一个小物件和一面墙需要的档位完全不同。

引入第二条判据——**屏幕投影尺寸**（Spark 风格）：

```
renderScaleLod     ← 屏幕投影"清晰需要多少"
budgetOptimalLod   ← 设备"最多承受多少"
targetLod = max(renderScaleLod, budgetOptimalLod)
```

取 max 的含义很精确：

| 情况 | 行为 |
|---|---|
| budget 充足 | 停在 `renderScaleLod`，**不追亚像素** |
| budget 不足 | 允许比视觉目标更粗 |
| budget 富余 | **不能**突破视觉目标继续填满 |

配套离线侧给每个 leaf × 每档写入 `repScale` 分位数（P50 密度帽），因为引擎解析后会 `tree = null`，viewer 只能用顶栏旁路表 `leafRepScale`。

> 这个模式最终**没有切成默认**（P4 暂缓），原因见 §4 第 7 条。写在这里是为了说明"设计完整但未强制推广"这一点。

---

### 3.3 离线分块粒度：块数是怎么被限制的，以及"越细越好"为什么错

前面所有优化都在运行时。但运行时优化到 `scan 1.7 ms`、`sync 0 ms`、慢档 0.14% 之后，还剩一个更大的杠杆在**离线侧**：这个场景被切成多少块。

#### (1) 没有一个"总块数"参数

`splat-transform` 的 LOD 输出只有三个真正影响块数的参数，且**都是"每块"口径，不是"总块数"口径**：

| 参数 | 准确语义 | 默认值 | 备注 |
|---|---|---|---|
| `--lod-chunk-count` / `-C` | 每个 chunk 的**目标高斯数**，单位 K | **96**（= 98,304） | 单叶点数**硬上限**，不让步 |
| `--lod-chunk-extent` / `-X` | 空间叶**允许的最大边长**（米） | **10** | 场景最长轴 ≥ 1000 m 时自动置 **0**（关掉空间分裂） |
| `--lod-min-chunk-points` | 触发空间分裂的**最小点数门槛** | **8192** | 设 0 = 只要超 extent 就分裂（extent-only） |

> **口径更正**：`docs/大场景 LOD 现有管线分析.md` 里写"CLI 默认 512 → 524,288"，与当前代码不符（`cli/index.ts` 与 `lod-plan.ts` 均为 **96**）。本文按代码口径写。

**块数是被"双重停止条件"间接决定的**，不是被某个 maxChunks 卡住的：

```ts
const splitByHardCount = node.count > binSize;                    // 数量约束（96K）
const splitByExtent = binDim > 0 && node.aabb.largestDim() > binDim
                      && node.count > minChunkPoints;            // 空间约束（10m + 门槛）
if (!node.indices && (splitByHardCount || splitByExtent)) { 继续递归分裂 }
```

配套有三道**间接护栏**，但都不改变"点数上限不让步"这条硬规则：

| 护栏 | 行为 |
|---|---|
| `LOD_MAX_LEAVES_WARNING = 32,768` | 叶数超线**只 warn**，并建议调大 `minChunkPoints`/`extent` |
| 大场景自动关 extent | 最长轴 ≥ 1000 m → `chunkExtent = 0`（注释："AABB 大 + extent 门小 → 叶子数爆炸"） |
| 流水线经验目标 | 叶数 3k–6k（红线 ~8k），并用 `computeMinChunkPoints()` 反推门槛 |

**必须分清两层切分**，否则会误判优化对象：

| 层 | 单位 | 谁决定 |
|---|---|---|
| **空间叶（leaf）** | 上屏调度 / 换档单位 | 上面双停止条件 |
| **物理 SOG 文件** | 实际下载单位 | `assignLodFiles()` 按 `binSize` 把多个 leaf 的 LOD 段 Morton 合包 |

我关心的是**叶数**——因为它等价于运行时的工作量，而不是文件数。

#### (2) 怎么对比分析的：一维扫描

实验设计的关键是**只动一个变量**：

```
固定：--lod-chunk-extent 10、同一 settings、同一 6 机位相机路径、budget 2.5
变量：--lod-min-chunk-points ∈ {98304, 16384, 8192, 2048, 0}
```

> `min-98304` = 门槛等于硬上限 → **extent 门退化，只剩 96K 硬约束**；
> `min-0` = extent-only → 只要 AABB 超 10 m 就分裂 → 叶子数爆炸。
> 这两个 pack 恰好构成"粗 / 细"两端，中间三档用来验证是否单调。

实测结果（`docs/logs/poland-min-chunk/RESULTS.md`）：

| pack | frameMs P50/P90/max | totalBlocks P50/max | bake max | longTask max | fullRebuild |
|---|---|---|---:|---:|---:|
| min-98304 | 17.1 / 50.5 / 683.6 | **1,054** / 1,342 | 0.5 | 0 | 25% |
| min-16384 | 16.9 / 50 / 550 | 3,816 / 5,280 | 1.1 | — | — |
| min-8192 | 16.8 / 50 / 384.2 | 7,792 / 10,544 | 1.3 | — | — |
| min-2048 | 16.8 / **100** / 399.9 | 27,025 / 35,979 | 2.6 | — | — |
| min-0 | 16.7 / **83.9** / **950.1** | **49,475** / 68,918 | **7.3** | **959** | **49%** |

#### (3) 结论：不是"越细越好"，也不是"有一个最优点"

三条互相牵制的效应，决定了它是一条**区间**：

| 效应 | 方向 | 数据 |
|---|---|---|
| 块越细 → 单次上传字节越小 | 好处 | `uploadMb max`：min-0 **855 MB** vs min-98304 **2,482 MB** |
| 块越细 → block 数暴涨 | 坏处 | `totalBlocks` P50 **49,475 vs 1,054**（47×） |
| block 数暴涨 → 单帧 bake/update 尖峰 | 坏处 | `updateMs max` **948.5 vs 13.0 ms**；`longTask max` **959 vs 0** |
| block 数暴涨 → 全量重建比例升高 | 坏处 | `fullRebuild` EARLY **49% vs 25%** |

而且中间档（16K / 8K）的 P50/P90 与 96K 同量级、max 甚至更低——说明**收益/代价的拐点在"块数"上，不在"块大小"上**。

**机制链（这是整件事的底层解释）**：

```
空间叶 → 一个 placement interval → 一个 MemBlock → work buffer 上的一段
```

两个独立样本证明了"首帧 totalBlocks **精确等于**最粗档叶子数"：

| 场景 | 最粗档有数据的 leaf 数 | 运行时首帧 totalBlocks |
|---|---:|---:|
| Poland / 济南桥 | 45,480 / 22,476 | **45,480 / 22,476** |
| poland-new-98304 | 4,096 | **4,096** |

> 所以"叶片切碎"不是制作习惯问题，它**直接等于每帧要维护的 block 数**，也就直接等于换档时的 CPU 开销。
> 碎片化程度还有一个更直观的指标：`Poland ~4.9 splats/block` vs `济南桥 ~41.8 splats/block` —— 前者一个 block 只装 5 个点，等于"每块都在做搬运但几乎没装东西"。

#### (4) 反例：小场景用 96K 反而更差

统一用 96K 是错的。Wuhan（场景对角线 321 m、叶节点中位数 8.5 m）换 98304 后：

| 指标 | 原版 | 98304 | 判定 |
|---|---:|---:|---|
| blocks P50 | 1,431 | **512** | 叶数确实降了 |
| blur P50 | 1,811 ms | 1,607 ms | 略好 |
| **frameMs max** | 183.5 ms | **2,466 ms** | 恶化 |
| **GPU max** | 86.3 ms | **4,850 ms** | 恶化 |

原因还是同一条链：块变粗 → 单块承载的点变多 → 换档时**一次性带进 work buffer 的 interval 变大**，单帧尖峰反而更炸。

> **结论**：分块粒度必须**按场景尺度单独标定**，96K/10 m 是亿级大尺度场景的结论，不能外推。
> 同一逻辑也解释了两端：Poland CDN 原版 36 万叶 → `frameMs P50 82.5 ms`；重建版 3.2 万叶 → `8.3 ms`。**10 倍差距全在离线切分，运行时优化一点都补不回来。**

---

### 3.4 budget 驱动：为什么一开始是"距离驱动"而不是"预算驱动"

这是 runtime 侧最容易漏掉的一层——**调度跑得再快，如果预算根本没生效，画面依然不受控**。

#### (1) 引擎的默认值是"关闭"的

| 引擎默认 | 实际含义 |
|---|---|
| `splatBudget = 0` | **关闭预算执行，只用 LOD 距离**（这是引擎默认行为） |
| `lodUnderfillLimit = 0` | **禁用兜底**：optimal 档没驻留时不退到更粗档，而是一直等最优档 |

也就是说：**如果 viewer 不显式写这两个值，引擎根本不会按"预算"驱动，纯按距离自由升档。** 上屏点数、显存占用都不受控。

#### (2) 四个真实故障，以及各自怎么被查出来

**故障 A：underfill 半径不够，中心到不了最细档**

5 档资产 `lodLevels = 5 → maxLod = 4`，bootstrap 档是 L4。
若 `underfillLimit` 只取默认的 2（mobile）/ 3（desktop）：

```
allowedMaxCoarseLod = min(maxLod, optimal + limit) = min(4, 0 + 2) = L2
```

L4 **不在允许范围内** → 引擎只能"要么等 L2 文件、要么不画"，表现为：

- 可见区停在比 bootstrap 更细的目标上，被迫新下载；
- `Σ optimal` 被 balancer 压着，**顶不满 `adj`（有效预算）**；
- 用户看到的是"预算明明还有富余，中心却一直不清晰"。

修法（一行，但语义要想清楚）：

```ts
// 取 max：保证 bootstrap 档永远落在 underfill 兜底范围内
gsplatScene.lodUnderfillLimit = Math.max(T.lod.underfillLimit, maxLod);
```

**故障 B：boost 期把用户 budget 覆盖了**

细化阶段进 boost 时曾无条件写 `gsplatScene.splatBudget = 默认值`，导致 URL `?budget=` 失效——用户明明指定了 6M，跑起来还是 4M。

修法：**尊重 URL/config，只在场景未设时兜底**。

```ts
gsplatScene.splatBudget = savedSplatBudget > 0 ? savedSplatBudget : T.lod.splatBudget;
```

**故障 C：budget 每帧重算 → 缺档集合振荡 → pending 不降 → 闪烁**

三重叠加，单看每个都"没错"：

1. 引擎每帧重算 `optimalLod` → 缺档集合每帧变 → `pendingUniqueFiles` 在 2→18→17 之间振荡；
2. 队列 reconcile 用当帧子集 → 不在子集里的 file 被 suspend → "下完又被挂起"；
3. 文件 ref 归零 → cooldown 后 unload → 重新计 pending。

对付方式不是"让 budget 别变"，而是**换口径**：

| 手段 | 作用 |
|---|---|
| 完成判据改用 `stableForegroundPending` | 把外围振荡从"是否完成"里剔除 |
| settle hold gate（30 帧） | pending 归零瞬间不放开队列，防外围涌入 → underfill 跳档 → 闪 |
| `jitterHint.likelyBudgetOscillation` 诊断字段 | `lodDisplayMismatch > 20 && |ΔstaleLodNodes| > 5` 时告警 |

**故障 D：OOF 钳粗把 `budgetScale` 拉爆 → opt 虚高**

这是我自己引入 OOF 之后**制造出来的新 bug**，很隐蔽：

```
OOF 把视锥外 Σopt 系统性压低 → ratio = Σopt/adj 长期 < 0.6
→ 引擎认为"预算有富余" → budgetScale 每拍单调上抬 → optimalLod 整体调细
→ 又有更多叶被判 OOF 被钳 → 正反馈
```

修法很反直觉——**喂给 `budgetScale` 用"钳制前的 Σopt"，而 `nodeInfos.optimalLod` 用钳后值**：

```ts
const totalBefore = previous(...args) ?? 0;     // 钳制前总量
excludeOutOfFrustumFromBudget(patched, mats);   // 真改 optimalLod → bootstrap
return totalBefore;                             // 但 ratio 仍用原值
```

两个口径分开，`opt/adj` 与 `budgetScale` 才不会互相带偏。

类似的还有 `lodScaleAlign` 默认关的原因——它会把 `d0` 拧到 0.2 m 量级，同样导致 **budgetScale 爆炸、opt 虚高**。

#### (3) 排查靠哪几个指标

| 指标 | 读法 |
|---|---|
| **Budget fill** `cur · opt · adj` + `opt/adj%` + `cur/opt%` | `opt/adj` 远低于 100% 且 Asset < Budget → 正常；`×100` 且 `budgetScale` 异常 → 失控 |
| **Center fill** | 视锥内且 `edgeFactor ≥ 0.45`；≈100% 才算中央追齐（首屏收条口径） |
| **Edge / Out fill** | 视锥外 `cur` 应该很小；移动后 `Out cur↓` 且 `opt/adj` 回升 = 额度回填成功 |
| `centerEngineBehindNodes` | 中央仍粗于目标的**节点数**，它堵首屏收条 |
| `lodDisplayMismatch`、`staleLodNodes` | 前者=视锥内 current≠optimal；后者=需升档节点数（会振荡，不能用作 gate 条件） |
| `probe-budget-fill-ab.mjs` | OOF 开 / `?oofDowngrade=0` 的对照探针 |

> 这一层的教训：**"预算驱动"不是一个开关，而是四个默认值、一条兜底半径、一个覆盖顺序、一个反馈环的组合**。任何一个没对齐，表现都是同一句话——"预算没生效"。

---

### 3.5 视锥外 chunk 降档：从"上过就常驻"到"看不见就吐回来"

#### (1) 原状：视野外的细档不会自己退出

这是原架构一个很容易被忽略的漏洞，历史分析里的原话是：

> **Gsplats / 内存不会在 skip 时自动回落**——不是「没卸载」，而是**既不降档显示，也不在本 tick 回收文件**。真正推动变粗的路径主要是：引擎 `splatBudget` 分桶 / native 距离曲线 / 视锥外叶子不再参与 compaction。

翻译成现象：**你回头看过一次的地方，它的细档会一直占着 work buffer。** 转一圈之后，`used` 持续上涨、block 数只增不减、预算被看不见的东西吃掉，而"引擎的 budget 分桶"只能被动地整体压粗——**该清的更不清，不该占的一直占**。

> 证据强度说明：这段描述来自 `_superseded` 目录（采集于首屏轮询修复前），按约定只作**现象描述**、不作量化结论；OOF 本身没有留下独立的变更记录。

#### (2) 拆成两件事：改"意图" vs 改"显示"

关键认知是：`optimalLod` 同时是三样东西的输入——预算分配的输入、`budgetScale` 的分子、下载目标的来源。所以不能一把改，要分两侧做：

| 侧 | 函数 | 做什么 | 为什么必须分开 |
|---|---|---|---|
| **预算侧** | `excludeOutOfFrustumFromBudget` | 视锥外 leaf 的 `optimalLod → bootstrap`，把额度从"看不见的"里抠出来回填可见区 | 不要求粗档已驻留，只改意图；且 `Σopt` 的返回值另算（见 §3.4 故障 D） |
| **显示侧** | `clampOutOfFrustumOptimalLods` | `current` 仍细的视锥外叶 → 降到 bootstrap，真正"吐"出 work buffer | 必须先确认粗档已驻留（否则先 `ensureFileResource` 拉粗档，不直接降） |
| **空闲滴灌** | `dripOutOfFrustumDowngrade` | 静止时每 30 tick、每次最多 16/32 个节点慢慢降 | 一次性降完会产生一次集中换档上传 |

#### (3) 三重触发限制，以及提前跑会怎样

```
只在「相机静止 && burst 结束 && stableForegroundPending === 0」时执行
```

| 提前跑的后果 | 机制 |
|---|---|
| 与 burst 抢下载 | burst 期内 `lodUpdateDistance → 0`，此刻把视锥外压粗会立刻改变缺档集合，与"先把前景细档拉下来"直接冲突 |
| 制造额外上传尖峰 | 每次换档 = 一次 bake 写 WB，而慢帧主因正是这个 |
| 把"正在追的细档"误判成"看不见的" | 只有 `stableForegroundPending === 0` 才是"前景已收敛"的可信信号 |
| sticky 视锥掩码不可靠 | hold 的 sticky 依赖"上次视角"，只有静止时才成立 |

#### (4) 一个必须写清楚的边界：降档 ≠ 省显存

这是我查证后**修正自己表述**的一点。准确结论：

| 层面 | OOF 降档后 | 原因 |
|---|---|---|
| `allocatorUsed`（已分配 slot） | **会下降** | interval/placement 减少，block 被 `free` 回池 |
| `allocatorCapacity` | **不会下降** | allocator `grow()` 明写 "Only increases capacity, never decreases." |
| WB 纹理 VRAM | **不会下降** | 纹理边长 ≈ `ceil(sqrt(capacity))`，capacity 不减则纹理不减 |
| SOG 侧 VRAM | **不会因 OOF 下降** | OOF 明确"不 unload"，文件真正卸载走引擎 cooldown（默认 100 tick） |

> 所以 OOF 的收益是 **上屏点数 / draw call / 预算回填 / 后续分配效率**，**不是**"把显存还回来"。
> 反过来说，如果目标是压显存峰值，这条路走不通——需要的是资产侧分块（§3.3）与引用计数回收。

#### (5) 四个 patch 写同一个字段，顺序不能错

`hold` / `OOF` / `renderScale 钳制` / `scale-align` 都在改 `nodeInfo.optimalLod`，顺序契约是：

```
hold 前快照（仅统计） → hold + OOF → renderScale 钳制 → 引擎 apply
```

两条硬约束：

- **renderScale 必须在 hold 之后钳制**，否则 hold 会把"变粗"撤掉；
- **merge 基准必须用 OOF 之后的 `optimalLod`**，否则会把视锥外 bootstrap 覆盖回细档 → `Σopt` 虚高 → `budgetScale` 反向修正 → "opt 看着很高、中心却变粗"。

而且 patch 必须用**闭包保存上一层**，不能用共享字段（`__originalApplyLodChanges`）——否则多个 patch 互相覆盖直接爆栈。

---

## 4. 被数据否决的方向（这部分最能体现工程判断）

优化工作的价值不只在"做对了什么"，也在"**知道自己错了，并且用数据证明了错**"。以下都是真实发生过的否决：

| # | 我原本的判断 | 数据 | 最终结论 |
|---|---|---|---|
| 1 | 优化的关键是调度算法（scan/sync） | `scan` P50 1.7 ms、`sync` 0.00 ms、`gpu` 8.3 ms | **推翻**：瓶颈在显存上传，不在调度 |
| 2 | 应该做"引擎 pending bake 分片" | `gap≥40` 的 103 帧里 **88.3%** 的 `bake+write` P50 ≈ 0；最重 bake 落在 `gap≈0` 的帧 | **不做**：分片解决不了 gap，反而增加复杂度 |
| 3 | 用"Bake Governor"压上传比 | 上传比能压到 P50 98%→6%，但慢档只从 14.6%→11.2%，fps 无感 | **整块从主路径移除**，只留归档 |
| 4 | placement sync 是尖峰主因 | 关掉（`lodSync=0`）：尖峰 **19 → 45**、fullRebuild **8 → 24** | **已证伪**：关掉更糟 |
| 5 | burst 窗口本身有害 | `noBurst=1`：尖峰 **15 → 102** | **已证伪**：真正放大器是 burst 内的 `lodUpdateDistance→0` |
| 6 | 把 `burstUpdateDistance` 从 0 调到 0.15 就能解决 | 尖峰 15→15 不变，仅 updMax 159→146 | **未采用** |
| 7 | 全量切 `renderScale` 作为默认更好 | rs=1~4 与 distance 接近，**rs≥16 才明显 clamp**；根因是叶子 `repScale` 量级偏大 | **P4 暂缓**，默认仍是 distance |
| 8 | 分块越细越好 | 五档扫描：`totalBlocks` **49,475（min-0）→ 1,054（min-98304）**、bake max **7.3 → 0.5 ms**、frameMs P90 **83.9 → 50.5**、全重建 **49% → 25%**；但单次上传反而 **855 MB → 2,482 MB** | **推翻**：不是越细越好，也不是单调关系（中间档 16K/8K 的 P90 与 max 更好）→ 取 96K 区间 |
| 9 | 叶片切碎只是制作习惯问题 | CDN 版 36 万叶：frameMs P50 **82.5 ms**、blocks **217,777**；重建版 3.2 万叶：**8.3 ms / 29,308**；98304 版 4,096 叶：**8.3 ms / 4,096 blocks** | **推翻**：叶子数 = 运行时 block 数 = 慢帧（首帧 totalBlocks 精确等于最粗档叶数） |
| 10 | Wuhan 改 98304 分块会更好 | blur P50 1811→1607 ms（略好），但 max frameMs **183 → 2466 ms**（更炸） | **收益有限**，不推广 |
| 11 | native 首屏应强对齐 centerClear + 常驻预取 | 卡在 82%；每 150 ms tick 拖累移动 FPS | **回退**为粗层 ready 即 firstFrame，改为 idle burst only |
| 12 | region 分层（warm/cold clamp）值得做 | Finland 4 tile 全 active 时 region-budget 几乎无效；官方实现也无此层 | **P5 移除** |
| 13 | 旧的全部 Poland/jinanqiao 对照数据可作为基线 | 采集早于首屏轮询修复、含 governor 实验路径 | **整目录归档作废**，重跑权威轮 |

> 第 13 条是方法论层面的：**推翻自己的旧基线，比保留一个好看的数字更难，但必须有。**

---

## 5. Result

### 5.1 量化结果

**A. 首屏之后的无效轮询（最大单点收益）**

首屏完成后仍在每帧全树轮询 bootstrap 状态。用 `progressUIHidden` 短路后（`实测`）：

| 指标 | 优化前 | 优化后 | Δ |
|---|---:|---:|---:|
| 京东 viewer-bundle CPU | 7,569 ms | **1,713 ms** | **−77%** |
| 京东 octree-lod CPU | 561.8 ms | **27.6 ms** | **−95%** |
| 南广场慢档帧数 | 1 | **0** | −100% |
| 南广场上传帧数 | 9 | **4** | −56% |

> 这项优化曾占整段 CPU profile 的 **41% 主因**。它说明一个道理：**最高收益的优化往往是"少做无用功"，而不是"把有用的事做得更快"。**

**B. 冷热身语义拆分**

`Dirty / Sync` 三语义拆分（`renderNextFrame` / `needsLodUpdate` / `gsplatScene.dirty`）+ 同帧 sync 去重（`实测`）：

> **fullRebuild 占比 28% → 0%**

**C. 限流阶段（Phase A2）**

| 指标 | T0 基线 | Phase A2 | 判定 |
|---|---:|---:|---|
| 慢档（140–200 ms）占比 | 35.8% | **13.6%**（−22.2 pp） | ✅ 目标 <30% |
| 慢档 `gapMs` P90 | 143 ms | 132.3 ms | ✅ 下降 |
| `burst_lod_switch` 次数 | 359 | **221**（−38%） | ✅ |
| 慢档 `drawCalls` P90 | 65 | 121（+86%） | ❌ |
| 上传帧 `uploaded/total` P50 | 78% | ~99% | ❌ |

**总评：部分达标。** 限流减少了 sync 的**次数**，但没限制**单次 sync 拖入的 interval 数**——这个诊断直接指向了后续正确的方向。

**D. Phase B（Bake Governor）→ 未通过门禁 → 阻断 Phase C → 整块移除**

| 指标 | 门禁 | Phase B 实测 | 判定 |
|---|---:|---:|---|
| 慢档占比 | <5% | 14.6% | ❌ |
| 慢档 `gapMs` P90 | <40 ms | 129 ms | ❌ |
| 慢档 `drawCalls` P90 | ≤12 | 120 | ❌ |
| 上传帧 `blocks↑/tot` P50 | ≤15–20% | ~98% | ❌ |

按事先约定"禁止在未达标时进入 Phase C"，Phase C 被阻断。修订版（slot-token + admit 闸门）能把上传比压到 **P50 6.0% / P90 19.7%**、`fullRebuild` 0%、慢档 11.2%，但 fps 仍无感 → **最终决策：Bake Governor 从主路径整块移除**。

> 这是一个"及时止损"的决定：能压低一个指标，但压不出体感，就不该留在主路径里误导后续排障。

**E. 最终稳态（post-fix 权威轮，`实测`）**

| 场景 / 指标 | 值 | 判定 |
|---|---|---|
| Poland 慢档帧数 | **2 / 1,429** | ✅ 目标 <5% |
| Poland `frameMs` P50 / P90 / P99 | 16.7 / 17.6 / **83.4** ms（max 182.3） | 尾部仍偶发超标 |
| Poland `fpsP50` | **59**（mean 51.5） | ✅ |
| Poland `gapMs` P50 / P99 / max | 6.0 / 66.3 / 125.7 ms | ❌ 未闭环 |
| 济南桥 jinanqiao-v3-x10 | fps 59、慢档 **0**、`frameMs` P99 50.3 | ✅ |
| 南广场 | 初始 5–15 s、blur **<3 s**、FPS 中位 69 / 最低 44 | ✅ |
| Finland | blur <5 s ✅，但 FPS 中位 **10** / 最低 6 | ❌ 未解 |

**与同协议对照场景持平**：Poland 与济南桥 `frameMs` P50 均为 16.7 ms、`fpsP50` 均为 59。差异只剩下极少数换档上传尾部尖峰（P99 83.4 vs 50.3）。

### 5.2 剩余差距的根因（已经定位，未完成）

| 问题 | 根因 | 证据 |
|---|---|---|
| Poland 尾部尖峰仍高于对照组 | **叶片切碎 → MemBlock 碎片化**（~4.9 vs ~41.8 splats/block） | `totalBlocks` P50 122,908 vs 27,158；两个独立样本证明首帧 `totalBlocks` = 最粗档 leaf 数（45,480/22,476；4,096/4,096） |
| Poland native 粗分块仍然慢 | 粗分块下 blur ≈ 30 s，细粒度口径可到 5 s 左右 | 资产切分方式决定上限，调度改不动 |
| 显存峰值不随降档回落 | allocator `grow()` 只增不减；OOF 只降 `used`、不降 `capacity`，且不 unload 文件（走 cooldown 100 tick） | 要压峰值只能从资产分块与引用计数回收入手 |
| Finland native FPS ~4（官方 billions 示例 60） | 未定位，属引擎侧 bake 路径差异 | 已隔离为独立课题 |

> **结论写清楚**：调度侧的优化空间已经基本用尽（scan 1.7 ms、sync 0 ms、慢档占比 0.14%）；**剩下的差距在资产分块粒度与引擎 bake 路径上，不在 viewer 调度**。

### 5.3 方法论沉淀

| 原则 | 具体实践 |
|---|---|
| **先修量具，再量东西** | 修 `gsplats` 恒 0；给不可信的 `stats` 值做合理性校验并回退墙钟；给 `gapMs` 写明口径边界 |
| **同一件事，多尺度同判据** | blur→clear 在 HUD（实时）、profiler（离线）、Playwright（批量）三处用同一套常量，所以自动报告与人工观察说的是同一句话 |
| **观测阈值 = 执行阈值** | profiler 的移动/旋转判定与调度器一字不差，避免口径分裂 |
| **性能门禁 + 正确性门禁并行** | `syncAdvance` / `dirtyForcedWorkBufferRebuild` 专抓"把工作偷偷丢掉"式的假优化 |
| **让反例可存档** | 被推翻的结论标 `superseded` 而非删除；acceptance 保留 ❌ 与"根因待迭代"，形成可追溯的决策日志 |
| **单个指标变好不算好** | Phase B 上传比 98%→6%，但慢档只降 3 pp → 判不合格 |

---

## 6. 复盘：三条可复用的判断

1. **先归因，再优化——而且归因要能证伪。**
   我最初认定的方向（调度太慢）被三个数字否掉了（scan 1.7 ms / sync 0 ms / gpu 8.3 ms）。如果先动手优化 scan，会投入大量时间在一个 1.7 ms 的地方。**能快速证伪一个假设的评测体系，比一个能证明"我改进了"的评测体系更有价值。**

2. **优化的层级决定收益的量级。**
   按收益排序，这个项目里的实际结果是：
   `少做无用功（−77% CPU）` > `减少工作次数（慢档 35.8%→13.6%）` > `限制单次工作量（未完成）` > `微观调参（无效）`。
   先问"这件事能不能不做"，再问"能不能做得更快"。

3. **资产决定上限，代码决定能否接近上限。**
   同一份场景内容，36 万叶与 3.2 万叶的 `frameMs` 是 82.5 ms 与 8.3 ms——**差 10 倍，全部来自离线切分方式**。当调度侧优化到 scan 1.7 ms、慢档 0.14% 之后，继续投入调度的边际收益已经接近零。承认"这一层已经到顶"并写清根因，比继续刷指标更有价值。

---

## 7. 网站可直接摘用的短版文案

### 版本 A（一段话，约 100 字）

> 负责亿级 3DGS 大场景（1 亿~3 亿点）的浏览器端 LOD 流式调度优化。先建立五层可复现评测体系（在线 HUD → 逐帧 profiler → Playwright 批量实验 → 正确性门禁 → CDP 火焰图），把"卡"从体感变成可归因的数字；再通过职责切分、下载评分、四级预取与上屏同步重构，把慢帧占比从 35.8% 降到 0.14%。

### 版本 B（问题-方案-结果，约 200 字）

> **问题**：亿级高斯泼溅场景在浏览器里做流式 LOD，冷启动约 30 s、停住后要 20–30 s 才清晰，慢帧（140–200 ms）占比 35.8%，且"卡"无法定位——可能来自扫描、调度、GPU 或显存上传。
> **方案**：① 先建评测体系，定义 blur→clear 的统一定义（pending=0 且中央细档 ≥95% 连续 4 次采样），并用逐帧 profiler 把慢帧与快帧逐项对照；② 据数据把瓶颈定位到"CPU 写显存"而非调度（scan 1.7 ms / sync 0 ms / GPU 8.3 ms）；③ 重构调度语义：引擎算目标档、viewer 只做评分与编排，配合四级预取、四档并发、六路上屏触发与 ladder 限速。
> **结果**：慢帧占比 35.8% → 0.14%（2/1429），稳态 fps P50 59 与同协议对照组持平；并识别出剩余差距来自资产分块粒度（叶片数 = 运行时 block 数），而非调度。

### 版本 C（要点式，适合卡片）

- 建立五层递进评测体系，把"卡"从主观体感变成可下钻到函数栈的量化链路
- 定义核心 KPI（blur→clear）并统一 HUD / profiler / 批量实验三处判据，消除口径分裂
- 用数据证伪 5 个错误优化方向（含我自己最初判断），及时止损并归档决策日志
- 慢帧占比 35.8% → 0.14%，慢帧 CPU 归因（首屏无效轮询）降低 77%
- 修正引擎预算的两个"默认关闭"语义（`splatBudget` / `lodUnderfillLimit`），解决"预算有富余但中心不清晰"
- 用五档扫描证明"分块不是越细越好"：block 数 47× 差异、单帧 update 尖峰 948 ms → 13 ms
- 定位并证明"叶片数 = 运行时 MemBlock 数 = 慢帧"这一资产级根因
- 视锥外降档：从"上过就常驻"到"看不见就吐回"，并厘清其收益边界（降 `used`、不降 `capacity`）

---

## 附：核心代码与文档索引

### 调度实现

| 模块 | 文件 |
|---|---|
| 调度器主体（扫描 / 评分 / 并发 / sync） | `src/loaders/gsplat/lod/octree/refinement-controller.ts` |
| 首屏状态机 | `src/loaders/gsplat/lod/octree/streaming-bootstrap-policy.ts`、`bootstrap.ts` |
| 选档纯函数（renderScale 模式） | `src/loaders/gsplat/lod/octree/lod-render-scale.ts` |
| 视锥外降档（预算侧 / 显示侧 / idle drip） | `src/loaders/gsplat/lod/octree/out-of-frustum-downgrade.ts` |
| 米制尺对齐（默认关） | `src/loaders/gsplat/lod/octree/lod-scale-align.ts` |
| 引擎原语封装 | `src/loaders/gsplat/lod/octree/octree-instance-access.ts` |
| 配置解析（budget / selectMode / runtime） | `src/loaders/gsplat/lod/scene-profile.ts`、`scene-bindings.ts` |

### 离线分块（splat-transform，同工作区的独立包）

| 模块 | 文件 |
|---|---|
| 参数定义与 help（`-C/-X/min-chunk-points`） | `../splat-transform/src/cli/index.ts` |
| 默认值（96K / 10 m / 8192）与计划推导 | `../splat-transform/src/lib/lod/lod-plan.ts` |
| 双停止条件、合包、叶数告警 | `../splat-transform/src/lib/writers/write-lod.ts` |
| B-Tree 分块（256 叶 / 最长轴中位分裂） | `../splat-transform/src/lib/spatial/b-tree.ts` |
| 流水线（计划 → CLI 注入） | `../splat-transform/lod-pipeline/scripts/compute-lod-plan.mjs`、`run-lod-chain.mjs` |

### 分块粒度与预算实验

| 实验 | 文件 |
|---|---|
| Poland 一维扫 `minChunkPoints`（五档） | `scripts/frame-profile-poland-min-chunk.mjs` |
| Poland 三方资产对比（dolly zoom） | `scripts/frame-profile-poland-cdn-compare.mjs` |
| Wuhan CDN vs 98304 | `scripts/frame-profile-wuhan-cdn-vs-min98304.mjs` |
| OOF 开/关的预算填充探针 | `scripts/probe-budget-fill-ab.mjs` |

### 评测体系

| 层 | 文件 |
|---|---|
| HUD | `src/benchmark/benchmark-hud.ts` |
| 指标采集 / blur→clear | `src/benchmark/benchmark-refinement.ts` |
| 逐帧采样 | `src/benchmark/frame-profiler.ts` |
| 上传分档统计 | `src/benchmark/buffer-upload-profile-table.ts` |
| 正确性门禁 | `src/benchmark/bake-acceptance.ts` |
| 批量驱动 | `scripts/benchmark-playwright.mjs` |
| 函数级下钻 | `scripts/chrome-performance-profile.mjs`、`analyze-refinement-bottleneck.mjs` |

### 指标口径与实验设计

- `docs/BENCHMARK_HUD.md` —— 逐字段口径字典（含陷阱说明）
- `docs/LOD调度性能与内存细粒度Benchmark方案.md` —— 指标定义、判定规则、实验设计
- `docs/SCENE_PROFILE.md` —— 全部可调参数与默认值
- `docs/大场景 LOD 现有管线分析.md` —— 三种管线（chunk-based / splat-based）原理对比
- `docs/logs/*-acceptance.md` —— 各阶段验收表（含 ❌ 与根因）
- `docs/logs/_superseded-2026-07-pre-bootstrap-fix/README.md` —— 被作废结论的原因说明
