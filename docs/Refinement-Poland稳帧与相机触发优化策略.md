# Refinement Poland 稳帧与相机触发优化策略

> 目标：Poland 96k 这类细粒度场景中，保持视野中心 refine 速度，同时避免 burst 期间把大量 LOD 切换集中到同一帧，导致 `uploadedBlocks/totalBlocks`、`drawCalls`、`gapMs` 尖刺。

## 1. 结论

需要限制 sync 频率，也需要限制下载并发，但核心不是简单把数值调低，而是建立 **bake 压力闭环**：

- burst 内不要 18 帧每帧都常规 sync；
- 下载并发不要让大量外围文件同时 ready；
- 中心 critical 可绕过限流，外围按多帧摊平；
- 以 `uploadedBlocks/totalBlocks`、`drawCalls`、`gapMs` 作为下一帧是否放行外围 sync 的依据；
- 移动中不要 unload 已上屏资源，保持 `totalBlocks` 相对稳定；
- **先拆 dirty / sync 语义**（`renderNextFrame` ≠ `needsLodUpdate` ≠ `gsplat.dirty`），避免 activity 心跳误触发 scene-wide rebuild，并对同帧重复 sync 去重。

相机触发阈值目前偏敏感：平移 3cm 或旋转约 10 度就会触发一次 18 帧 burst。这个阈值对中心变清有利，但对 Poland 96k 会放大 bake 风暴。建议不要完全照搬 native 的大阈值，而是把 refinement 改成分级触发：小移动只轻量扫描/下载，较大移动或 zoom 才进入强 burst。

## 2. 当前问题

Poland 96k 慢帧不是 scan，也不是 GPU draw，而是 work buffer bake 在单帧内被集中触发。

已知现象：

| 指标 | Poland 96k refinement 慢帧 |
|------|----------------------------|
| `scan` | 约 1ms，不是瓶颈 |
| `gpu.totalMs` | 约 16ms，不是主因 |
| `drawCalls` | 慢帧约 26 |
| `gapMs` | 慢档约 119ms |
| `uploadedBlocks/totalBlocks` | 慢帧常到 78-100% |
| `engFULL` | 0，说明多数不是 literal full rebuild |

关键点：`syncedInstances=1` 仍可能让引擎在同一帧 reconcile 很多 interval。因此只限制 `syncedInstances` 不够，必须限制实际进入 bake 的 LOD 切换债务。

## 3. Sync 策略

### 3.1 不建议的做法

不要只做这些：

- 直接把 `burst.moveFrames` 从 18 改短；
- 只设置 `maxSyncsPerFrame=1`；
- 只提高相机移动阈值；
- 只降低 `splatBudget`。

这些能缓解部分触发频率，但无法保证一次 sync 内部不会打包大量 interval。

### 3.2 Bake Governor（已验证 · **已从主路径移除**）

曾实现 viewer 侧 slot-token debt / admit 闸门（历史上 `bake-governor.ts`），期望压低 `uploadedBlocks/totalBlocks` 尖刺。

**结论（2026-07）**：

- 上传比可压低，但 **fps / 体感增益有限**；主路径已 **整块移除**，避免默认开闸门误导排障。
- Gap 归因实测为 **Mode B**（高 gap 时 bakeCpu 不高）；真正热点是首屏后 `pollStreamingBootstrapComplete` 每帧全树扫描——已用 `progressUIHidden` 短路修复。
- **不做**引擎 pending bake 分片（B-engine），除非日后复现 Mode A（高 gap && 高 bakeCpu）。测量口径见 [Gap归因第一阶段说明.md](Gap归因第一阶段说明.md)。

历史验收归档：`docs/logs/refinement_poland_v3_phaseB-bakeGov-v2-acceptance.md` 等（只读存档，非现行方案）。

### 3.3 Burst 内 sync 频率

固定频率可作为第一版保护：

```ts
burst.syncCooldown = 4;
burst.staleSyncCooldown = 8;
```

含义：

- burst 内常规外围 sync 每 3-4 帧最多一次；
- `fileJustLanded` 且属于 center critical，可占用本帧配额立即 sync；
- 上一帧压力高时，进一步延后外围；
- sync 被抑制时继续显示父档，不卸载、不降档、不空洞。

## 4. 下载并发策略

下载也要限流，因为 Poland 96k 的文件粒度细，过高并发会快速制造大量 ready-but-not-applied 节点，随后一起进入 bake。

建议第一版参数：

```ts
loader.foregroundLimit = 32;
loader.criticalLimit = 6;
loader.boostConcurrent = 6; // 或 8
loader.burstConcurrent = 8; // 或 10
```

策略：

- critical 下载保留稳定槽位；
- foreground/peripheral 在 burst 中限流；
- 高压帧谨慎 enqueue 外围（勿一次塞满队列）；
- priority URLs 优先服务中心 critical；
- idle 后再 drain queue；
- 移动中只软取消非 priority in-flight，不做 asset unload。

## 5. 相机交互阈值

### 5.1 当前 refinement 阈值

当前 bootstrap 检测：

```ts
moved = distance > 0.03;
rotated = forwardDot < 1 - 0.015; // 约 10 度
zoomed = distanceDelta > max(0.04, lastDistance * 0.08) || fovDelta > 0.5;
```

触发后：

- `notifyCameraMoved()`；
- `cameraBurstFrames = max(current, 18)`；
- zoom 时 burst 更长；
- burst 内 `lodUpdateDistance = 0`，引擎更频繁重算 optimal LOD；
- 立即 `runPriorityPrefetch()`。

这个设计对“相机一动中心快速变清”有效，但对 Poland 96k 偏激进。3cm 平移在大场景里很小，可能导致频繁进入 18 帧 burst，而 burst 又会持续触发 sync / prefetch。

### 5.2 Native 是什么样

native handoff 后没有 JS refinement controller 的 burst / sync：

- 没有 `burst_lod_switch`；
- 没有 viewer 侧每帧 scan/sync；
- 文件按引擎 loader 节奏落地；
- 换档由引擎按帧消化，天然更接近多帧摊平。

文档中的 Finland / desktop native profile 使用过：

```text
lodUpdateDistance = 32
lodUpdateAngle = 90
```

这不是说 refinement 应该直接改成 32m / 90 度。native 稳帧的主因不是阈值大，而是没有 JS burst 把多块切档集中引爆。native 的代价是首个视点追到细档可能很慢，Poland native fineLod 的 kf-0 blurToClear 约 18s。

### 5.3 是否需要向 native 靠拢

需要靠拢的是 **节奏**，不是完全照搬阈值：

| 项 | 是否靠拢 native | 说明 |
|----|----------------|------|
| 多帧摊平 bake | 是 | refinement 当前最缺这个 |
| 父档兜底 | 是 | sync 被抑制时继续画旧档 |
| 文件落地节奏 | 部分 | 下载不要过度 fan-out |
| 相机阈值 32m / 90度 | 不建议直接照搬 | 会明显拖慢中心变清 |
| 无 JS 强控 | 不完全照搬 | refinement 仍需要中心优先能力 |

推荐做分级触发：

| 触发类型 | 建议行为 |
|----------|----------|
| 微小移动：3-10cm 或小角度 | 不开启 full burst；只允许低频 scan / 更新 priority |
| 中等移动：10-30cm 或 10-20度 | 开启短 burst，但外围 sync 限流 |
| 大移动：>30cm、>20度、路径跳点 | 开启完整 burst（cooldown + Phase A 限流） |
| zoom / FOV 变化 | 保留快速响应，中心 critical bypass |

初始试验值：

```ts
softMoveDistance = 0.03;
hardMoveDistance = 0.12;
softTurnDegrees = 6;
hardTurnDegrees = 15;
zoomDistanceRatio = 0.08;
fovDeltaDegrees = 0.5;
```

soft 触发只更新下载优先级，不重置全部 tracked/pinned，不开启 18 帧强 burst。hard / zoom 才进入 burst。

## 6. `uploadedBlocks` 与 `totalBlocks` 稳定性

Poland 需要保证：

- `totalBlocks` 不因移动中 unload / reload 大幅波动；
- `uploadedBlocks` 不在 burst 中接近 `totalBlocks`；
- 多帧摊平后，每帧 dirty blocks 有上限。

### 6.1 `totalBlocks` 为什么会涨到 20 多万

`totalBlocks` 约等于引擎 `allocationMap.size`，是当前 work buffer 账本里的 MemBlock / allocId 数量，不是文件数，也不是 splat 数。它涨到 20 多万通常说明：

1. 细粒度 96k 资产的可见/曾可见 leaf 数量很大，每个 leaf / LOD interval 都会占一行 MemBlock。
2. refinement 主要做升档，视野外或外围 leaf 没有被及时下屏/降到 coarse。
3. 文件保活只 `incRefCount`，移动时只 `prefetch.pinned.clear()`，没有 `decRefCount`，导致 file 和对应 placement 长期留在引擎侧。
4. 移动中不断把新区块切进来，但旧区块不释放，`allocationMap` 只涨不回落。

`totalBlocks` 高的直接风险是：即使本帧 `copyPct` 只有 20%，实际 dirty block 数也可能很大；一旦接近 80-100%，就是近似整表 bake。

实施原则：

1. 移动中不卸载正在上屏或近期使用的 file。
2. `prefetch.pinned.clear()` 必须配对 `decRefCount`，避免保活泄漏。
3. idle 连续 30 帧后才回收非 keep 文件。
4. 上传/压力偏高时，谨慎 enqueue 外围文件（勿一次塞满队列）。

第一阶段先修引用计数：

```text
retainCriticalDownloadFiles / pinLoadedForegroundFiles: incRefCount
notifyCameraMoved / destroy / idle eviction: releasePinnedFiles → decRefCount
```

controller pin 与 placement 自身 `incRefCount` 分离：只释放 pin 集合内的引用，上屏资源仍由 `filePlacements` / `activePlacements` 持有。

否则 Heap 会只增不减，长跑后更容易抖动。

### 6.2 治理方案

建议分三层做，避免直接在移动中粗暴 unload：

| 层 | 做法 | 目的 | 风险 |
|----|------|------|------|
| 引用计数修复 | 所有 `incRefCount` 都记录 owner，移动/销毁/idle 时配对 `decRefCount` | 让引擎 cooldown 有机会释放 file | 需要确认 permanent / bootstrap file 不被误释放 |
| 视野 active window | 只允许中心+前景一定数量 leaf 保持细档；外围超过上限时停止升档，必要时回 coarse | 限制新增 MemBlock | 可能让边缘变清变慢 |
| idle 回收 | 相机静止 N 帧后，对非 keep、非 visible、非 in-flight、非 pinned 的已加载 file 释放引用 | 让 `totalBlocks` 回落 | 不能在 WebGPU render 中途 unload |

第一阶段优先做引用计数和观测，不急着强制 unload。因为 `totalBlocks` 的下降通常要等引擎发现 placement 不再引用、cooldown 到期、再回收。直接 unload 正在绑定的 file 容易触发闪烁或 WebGPU bind 竞态。

### 6.3 Active Window 上限

Poland 96k 应加一个“可上屏细档 leaf 数”上限，而不只是 `splatBudget`：

```ts
maxFineVisibleLeaves = 80;      // 中心/高分 leaf 可升细档
maxResidentLodLeaves = 160;     // 当前视角附近允许保持 LOD placement 的 leaf
maxBakeDebtLeaves = 24;         // ready 但未 apply 的队列上限
```

策略：

- 中心 leaf 保留细档；
- 边缘 leaf 只允许到中档或 coarse；
- 超出 active window 的旧 leaf 不再继续升档；
- idle 后再把长期不可见 leaf 释放到 coarse / 下屏；
- `totalBlocks` 高于阈值时，先停止外围升档，再做 idle 回收。

初始阈值建议：

| 指标 | 动作 |
|------|------|
| `totalBlocks > 120k` | 停止外围细档升档 |
| `totalBlocks > 160k` | 只允许 center critical 升档 |
| `totalBlocks > 200k` | 进入保护模式：下载外围暂停，等待 idle 回收 |

这些阈值需要按 Poland 96k 实测调，但方向是把 20 多万视为保护线，而不是正常稳态。

### 6.4 观测补充

HUD / frameProfile 建议补：

- `totalBlocksP50/P90/max`；
- `totalBlocksDelta`：最近 120 帧增量；
- `residentLoadedFiles`；
- `pinnedFiles`；
- `visiblePlacedLeaves`；
- `finePlacedLeaves`；
- `offscreenPlacedLeaves`。

如果 `offscreenPlacedLeaves` 和 `pinnedFiles` 持续上涨，就优先修释放；如果 `visiblePlacedLeaves` 本身很高，就优先做 active window / asset 粒度治理。

## 7. 落地顺序

### Phase A：低风险限流

- burst 常规 sync cooldown 调到 4；
- stale sync cooldown 调到 8；
- Poland profile 下 `foregroundLimit=32`；
- `boostConcurrent=6-8`，`burstConcurrent=8-10`；
- center critical fileJustLanded 保留 bypass。

验收：

- 慢档比例下降；
- 中心 blurToClear 不明显变差；
- `uploadedBlocks/totalBlocks` P90 下降。

### Phase B：Dirty / Sync 语义 + 真瓶颈修复（现行）

主路径优先：

1. **B.1 Dirty / Sync 语义拆分**（见下）；
2. **bootstrap 首屏完成后勿再全树轮询**（`progressUIHidden` 短路）；
3. 用 Gap 归因区分 Mode A/B，**不要**默认假设高 gap = bake。

~~Bake Governor 压力闭环~~：**已移除**（仅历史归档）。

#### B.1 Dirty / Sync 语义拆分（优先级高）

`renderNextFrame`、`needsLodUpdate`、`gsplatScene.dirty` 是三种不同语义，禁止绑在一起：

| 标志 | 含义 | 允许用途 |
|------|------|----------|
| `app.renderNextFrame` | 本帧还要再画 / 拉流心跳 | 下载中、相机动、streaming 未静默 |
| `instance.needsLodUpdate` | 该 instance 待 `update` 做 LOD reconcile | **仅** sync / 真实 LOD 推进 |
| `gsplatScene.dirty` | 场景级强制重建 work buffer | **仅**格式/renderer/全局 splatBudget·underfill 等结构参数变化 |

必须落地：

1. **去掉 activity heartbeat 上的 `gsplatScene.dirty = true`**  
   `activityActive`（pending/stale/burst）不得触发 scene-wide dirty；需要继续渲染时只置 `renderNextFrame`。
2. **只有真实结构变化才 dirty**  
   例如 `applyBoostSettings` / restore 改 `splatBudget`、`lodUnderfillLimit`；LOD sync **不得**再带 `markSceneDirty`。
3. **对 sync 做帧内去重**  
   同一帧内 `update` tick、`file_landed_fallback`、`frame:ready_loading_drop` 对同一 octree 的 `syncOctreePendingPlacements` 只执行一次（后续调用 no-op）。

验收：

- Poland 96k `drawCalls P90 <= 12`；
- `gapMs P90 < 40ms`；
- `uploadedBlocks/totalBlocks P90 <= 15-20%`；
- 140-200ms 慢档 < 5%。
- **B.1**：activity-only 帧不再置 `gsplat.dirty`；同帧 `syncTriggers` 对同一 octree 实际执行 ≤1。

### Phase C：相机触发分级

- soft move 不开启 full burst；
- hard move / zoom 才开启 full burst；
- soft 触发不清空全部 tracked/pinned；
- 对连续交互做 100-150ms debounce 或合并。

验收：

- 小幅 orbit / pan 不再反复进入 18 帧强 burst；
- 中心 zoom 仍能快速变清；
- Poland 漫游时 `syncTrigger=burst_lod_switch` 次数下降。

### Phase D：内存与驻留

- `incRefCount` / `decRefCount` 配对（`releasePinnedFiles`；已落地 D0）；
- idle 安全回收；
- 后续再做 resident file LRU。
- `totalBlocks` 超阈值时触发保护模式，暂停外围升档。

### P0 增量 WorldState invalidation（与 B.1 配套）

目标链路：placement/interval 改变 → `worldStateDirty` → 新 `GSplatWorldState` → `needsUploadIds` → **增量** Work Buffer bake。

禁止退回：`scene.dirty` → `workBufferRebuildRequired` → `renderAll`。

引擎 API：`GSplatWorld.requestOctreePlacementUpdate()` —— 下一拍立即轮询 instance、捕获 placement dirty、只服务 WorldState invalidation，不强制 Work Buffer 全量 rebuild。viewer sync 改走该 API，不再直接 `inst.update()`。

验收：

- 移动一圈后 JS Heap 能回落；
- `totalBlocks` 运动中波动降低；
- `totalBlocks max` 不再超过 Poland 保护线；
- 不出现回访闪烁或空洞。

## 8. 验收指标

必须同时看这些指标：

| 指标 | 目标 |
|------|------|
| FPS P50 | Poland 96k 明显高于当前 refinement 慢档 |
| 140-200ms 慢档 | < 5% |
| `gapMs P90` | < 40ms |
| `drawCalls P90` | <= 12 |
| `uploadedBlocks/totalBlocks P90` | <= 15-20% |
| `totalBlocks` | 移动中相对稳定 |
| center `blurToClear` | 不显著回退 |
| Heap | 长跑后可回落 |

不要只看 `Gsplats` 或 `syncedInstances`。Poland 的关键是换档 fan-out 和 work buffer dirty blocks。
