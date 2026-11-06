# NativeOctreeLod Billions 中心优先预取规划

> 目标：针对 **同 asset 多 entity / 多 region 的 billions 场景**，以 PlayCanvas 原生 `nativeOctreeLod` 为主执行路径，在不破坏帧率的前提下增加视锥中心优先下载调度。  
> 日期：2026-06-26  
> **进度快照**：2026-06-26（P0–P6 已落地；P4 待跑批；FPS 瓶颈待 benchmark 验证）

---

## 0. 实施进度与 TODO

### 0.1 阶段总览

| 阶段 | 内容 | 状态 | 关键文件 |
|------|------|------|----------|
| **A / P0** | 协议 `lodRuntime`、HUD 诊断 | ✅ | `native-octree-lod.ts` |
| **B** | 共享评分 + 首屏模块 | ✅ | `octree-priority-scoring.ts` 等 |
| **C / P1** | NativeOctreePrefetchController | ✅ | **仅 quality native 启用** |
| **P2–P3** | queue reorder + warm/cold clamp | ✅ | quality native + region-budget |
| **P4** | Benchmark | ⚠️ 5 case 已配置，待跑批 | `scene-finland-native.json` |
| **P5** | region warm/cold（quality native） | ✅ | `region-scheduler.ts` |
| **P6** | native performance/quality 分流；移除 balanced | ✅ | `resolveNativeQualityPath()` |
| **F** | native resident governor | ⏳ | — |

### 0.2 native 多 entity 路径（P6）

| lodMode | lodRuntime | 行为 |
|---------|------------|------|
| **performance**（默认） | native | **纯引擎**：无 prefetch、无 warm/cold clamp；unlock 全档 LOD |
| **quality** | native | **轻量 refinement**：prefetch burst + 可选 region-budget clamp |
| performance / quality | refinement | JS OctreeRefinementController |

`balanced` 已移除 → warn 并按 `performance` 解析。

### 0.3 首屏与 prefetch

| 路径 | firstFrame | prefetch |
|------|------------|----------|
| refinement | 82% → centerClear → 100% | 全生命周期 |
| native performance | 粗层 ready → 100% | **无** |
| native quality | 粗层 ready → 100% | idle/active burst |

### 0.4 待办

- [ ] **E**：跑批 5 case（perf/quality × native/refinement + billions）
- [ ] **F**：native resident governor
- [ ] nanguangchang benchmark suite

### 0.5 重要结论

1. prefetch 不应绑所有 native — **P6 分流**。
2. warm/cold ≠ billions 机制；Finland 4-tile 全 active 时 region-budget 几乎无效。
3. **P5** `regionPolicy=billions` 已移除（benchmark 无收益）；native performance unlock 全档 LOD 为内建语义。

---

## 1. 结论

后续大场景 LOD 路线应拆成两条：

```Plain Text
单 asset / 单 entity / 传统场景
  继续保留现有 custom refinement 管线

同 asset 多 entity / 多 region / billions 场景
  nativeOctreeLod 作为主路径
  叠加轻量 center-priority prefetch
```

原因：

- Finland 多 piece 测试中，`nativeOctreeLod` 的 steady FPS 明显优于 custom refinement。
- PlayCanvas 官方 `billions.example.mjs` 也是依赖 engine 原生 octree LOD，而不是外部 refinement controller 接管 LOD。
- custom refinement 的优势是强控下载和上屏节奏，但它会引入 JS 侧 node 遍历、priority 排序、loader gate、placement sync、instance dirty/update 等额外成本。
- billions 场景中更关键的是「保住 native FPS，再优化下载优先级」，而不是「重写一套 LOD 执行层」。

---

## 2. 路线边界

### 2.1 保留 custom refinement 的场景

适用：

- 单 asset / 单 entity。
- 传统 streaming octree 场景。
- 需要强控首屏进度、变清进度、下载队列和 debug 指标。
- WebGL 或特殊设备上 native 表现不稳定时。
- 小到中等规模场景，JS refinement 成本可接受。

特点：

```Plain Text
custom refinement controller
  计算 visible nodes
  评分 priority files
  patch loader queue / gate
  sync placements
  mark dirty / update instance
```

这条路径继续作为精细调度和 fallback 方案。

### 2.2 采用 native + prefetch 的场景

适用：

- 同 asset 多 entity。
- 多 region 大场景。
- billions 示例类场景。
- Finland 四 piece / 多 piece 验证场景。
- 目标优先级是稳定 FPS，其次是中心区域快速变清。

特点：

```Plain Text
nativeOctreeLod
  负责 LOD 决策、上屏、排序、渲染

center-priority prefetch
  只负责下载优先级
  不持续接管 updateLod
  不频繁 sync placements
```

---

## 3. 原理

### 3.1 nativeOctreeLod 负责「显示什么」

PlayCanvas 原生 octree LOD 会基于：

- 相机位置和方向。
- Entity transform。
- `lodBaseDistance`。
- `lodMultiplier`。
- `lodUpdateDistance`。
- `lodUpdateAngle`。
- `lodRangeMin / lodRangeMax`。

决定每个 octree instance 的 `currentLod / optimalLod`。

billions 场景中，多个 Entity 可以共享同一份 asset/resource：

```Plain Text
Asset / GSplatResource
  octree metadata
  physical files

Entity A
  transform A
  instance LOD state A

Entity B
  transform B
  instance LOD state B
```

也就是说，resource 共享，但 LOD instance 状态不共享。

### 3.2 center-priority prefetch 负责「先下载谁」

native LOD 的问题不是帧率，而是下载顺序可能不够符合业务期望：

```Plain Text
视锥中心需要 L0/L1
边缘区域也在请求 LOD
旧视角 residual queue 仍占下载槽
lazy/warm region 可能提前占队列
```

center-priority prefetch 的职责是：

```Plain Text
找出 native 很快会需要的中心细档 file
把它们提前 ensure / 排到 loader queue 前部
```

它不负责：

- 强行修改 `currentLod`。
- 高频调用 `updateLod`。
- 重建 placement。
- 强制中心 L0 立即上屏。

### 3.3 为什么这能提升中心变清速度

中心变清慢通常有三类原因：

| 原因 | prefetch 是否有效 | 说明 |
|------|------------------|------|
| 中心细档 file 还没下载 | 有效 | priority prefetch 可以让中心 file 提前进入队列 |
| 中心细档 file 已下载但 native 未切换 | 部分有效 | 可低频 `dirty/renderNextFrame`，主要应调 LOD 参数 |
| 中心细档 file 太大 / 网络慢 | 有限 | prefetch 只能提前排队，不能缩短单文件下载时间 |

因此它提升的是：

```Plain Text
下载队列导致的中心变清延迟
```

不是：

```Plain Text
绕过 native LOD 或强行上屏更细档
```

---

## 4. 目标架构

### 4.1 模块分层

```Plain Text
RegionScheduler
  - active / warm / cold region 划分
  - per-entity lodRange clamp
  - bootstrap 策略

NativeOctreePrefetchController
  - active region 中心优先评分
  - priority file 计算
  - loader queue 轻量重排
  - stale queued request 后移

PlayCanvas native octree LOD
  - instance LOD update
  - placement
  - sort / render
```

### 4.2 文件建议

建议新增：

```Plain Text
src/loaders/gsplat/lod/native/native-octree-prefetch-controller.ts
src/loaders/gsplat/lod/native/native-prefetch-scoring.ts
src/loaders/gsplat/lod/native/native-prefetch-loader-queue.ts
```

也可以先合并为一个文件，稳定后再拆。

---

## 5. NativeOctreePrefetchController 设计

### 5.1 输入

```ts
type NativeOctreePrefetchOptions = {
    app: AppBase;
    cameraEntity: Entity;
    regionScheduler: RegionScheduler;
    resourceGroups: GsplatResourceGroup[];
    tickIntervalMs?: number;
    maxPriorityFiles?: number;
    maxEnsurePerTick?: number;
};
```

其中 `resourceGroups` 可以复用 multi-piece bootstrap 里按 shared asset/resource 聚合出来的结果。

### 5.2 输出

```ts
type NativePrefetchSnapshot = {
    activeRegions: number;
    candidateNodes: number;
    priorityFiles: number;
    queuedPriority: number;
    residentPriority: number;
    staleQueued: number;
};
```

用于 benchmark HUD 和诊断。

### 5.3 调度频率

不建议每帧跑。

推荐：

| 场景 | 频率 |
|------|------|
| 相机移动中 | 不跑或 300-500ms 低频 |
| 相机停驻 100-200ms 后 | 跑一次 burst |
| active region 切换 | 立即跑一次 |
| priority file 落地 | 只 `dirty/renderNextFrame` |

### 5.4 评分逻辑

候选 node 来自 active regions 的 octree。

评分建议：

```Plain Text
score =
  screenSize
  * centerBias
  * lodUrgency
  * regionPriority
  / distancePenalty
```

含义：

- `screenSize`：node 在屏幕上的近似尺寸。
- `centerBias`：越靠视锥中心越高。
- `lodUrgency`：越接近 L0 / L1 越高。
- `regionPriority`：来自 RegionScheduler。
- `distancePenalty`：避免远处大 AABB 抢占中心近景。

### 5.5 目标 LOD

不要凭空追 L0。应以 native 当前判断为参考：

```Plain Text
优先 native optimalLod
其次 optimalLod 附近更细 1 档
最多追到配置允许的 minLod
```

初始版本可以简化为：

```Plain Text
读取 instance.nodeInfos[nodeIndex].optimalLod
若对应 file 未 resident，则加入候选
```

这最接近 native 的真实需求。

---

## 6. Loader Queue 处理

### 6.1 轻量原则

native prefetch 不应复刻 custom refinement 的强 gate。

建议只做：

- priority URL 放到 queue 前部。
- 非 priority queued URL 后移。
- 已 resident 不重复 ensure。
- in-flight 不强杀，除非明确是旧视角且未 resident。

不建议：

- 每帧改 `maxConcurrentLoads`。
- 每帧 patch loader。
- 大量 soft cancel in-flight。
- 复杂 suspended queue。

### 6.2 初始策略

```Plain Text
for priorityFile in topK:
  if !octree.getFileResource(fileIndex):
    octree.ensureFileResource(fileIndex)

if loader._loadQueue exists:
  stable reorder:
    priority urls before non-priority urls
```

`topK` 建议从 8-16 开始。

---

## 7. Region 状态策略

### 7.1 active

```Plain Text
lodRange = 0..worstLod
参与 native prefetch
允许 native 完整选档
```

### 7.2 warm

```Plain Text
lodRange = coarse..worstLod（viewer region 预算；billions 示例无此层）
可选少量 coarse prefetch
不参与中心细档 prefetch
```

### 7.3 cold

```Plain Text
lodRange = worstLod..worstLod（viewer region 预算；billions 示例无此层）
不参与 prefetch
entity 不 disable，避免切换时闪烁
```

**与 billions 示例差异**：官方 [billions.example.mjs](https://github.com/playcanvas/engine/blob/main/examples/src/examples/gaussian-splatting/billions.example.mjs) 首帧后 **全部 instance `0..worstLod`**，无 active/warm/cold；靠 **圆柱布局 + lodMultiplier ramp** 限 active splats。viewer 的 warm/cold 是 **region rank 预算扩展**，非 billions 原生机制；Finland 4-tile 全 active 时可忽略。可选 **`regionPolicy: 'billions'`**（P5）完全对齐示例。

如果发现 cold 在 native 模式下被 engine 重新打开，应恢复低频 clamp：

```Plain Text
每 250-500ms 检查 cold/warm instance range
只在 range 被污染时重新 apply clamp
```

不要每帧 clamp。

---

## 8. 与现有 refinement 的关系

### 8.1 可复用逻辑

可从现有 `refinement-controller.ts` 中提取或参考：

- frustum / AABB 判断。
- centerBias。
- screenSize 估算。
- URL 去重。
- loader queue reorder。
- stale queue 统计。

### 8.2 不应复用的行为

native prefetch 不应复用：

- `syncStreamingOctreePlacements` 高频调用。
- boost splatBudget。
- `enterRefinementMode / restoreRefinementMode`。
- fpsGuard tier 调整。
- 每帧 `markOctreeInstancesDirty`。
- aggressive in-flight cancel。

这些属于 custom refinement 的强控制路径，会拖低 native FPS。

---

## 9. 实施计划

### P0：诊断对齐 ✅

目标：确认 Finland/billions native 路径真实运行状态。

**已落地（2026-06-26）**

- HUD：`Renderer`、`SplatBudget`、`Regions`、`Prefetch pri/resident/queued/stale`
- `?lodRuntime=` / `settings.sceneProfile.lodRuntime` 协议
- 移除 legacy `nativeOctreeLod` URL / schema 字段
- 文档：[SCENE_PROFILE.md](SCENE_PROFILE.md) lodMode × lodRuntime 矩阵

验收：Finland native 页面可看到 renderer / splatBudget / gsplats / regions / lodRange ✅

### P1：NativePrefetch 最小版 ✅

目标：只做 center priority ensure。

**已落地**

- `src/loaders/gsplat/lod/native/native-octree-prefetch-controller.ts`
- 复用 `buildPriorityFiles` + `nodeInfos[].optimalLod`
- `ensureFileResource` Top-K；**burst 触发**（bootstrap / active 切换 / 相机 idle ≥150ms）
- 接入：`bootstrap.ts`、`viewer.ts`、`multi-piece-bootstrap.ts`

**偏离与修正**

- 初版每 150ms 常驻 tick + 移动中 `onCameraMoved` burst → 已改为 idle burst only
- native 首屏曾强对齐 centerClear（卡 82%）→ 已回退为粗层 ready 即 `firstFrame`

验收：HUD 可见 priority/resident/queued ✅；FPS 影响需 P5 A/B 再量化

### P2：Queue Reorder ✅

目标：避免旧视角和边缘请求挡住中心 file。

**已落地**

- `src/loaders/gsplat/lod/native/native-prefetch-loader-queue.ts`
- `reorderLoaderQueueForPriority`：priority 前移、stale 后移，无 gate / suspended
- snapshot 含 `staleQueued`；HUD 展示

验收：快速转向后 queue 重排 ⏳ 待 benchmark 量化；无 in-flight cancel ✅

### P3：Warm / Cold 低频 Clamp 保护 ✅（有效性待 P5 验证）

目标：保证非 active region 不偷跑细档。

**已落地**

- native：`active` → `0..worstLod`；`warm` → `coarse..worstLod`；`cold` → `worstLod`
- `RegionScheduler.auditNativeLodClamps()` 每 ~400ms（仅 cold/warm）
- entity 不 disable（对齐 billions）

**注意**：billions 示例 **无 warm/cold**；Finland 4-tile 全 active 时本阶段 **对 FPS 几乎无影响**。保留作为 multi-region rank 靠后 piece 的预算手段；是否默认开启待 P5 `regionPolicy: 'billions'` A/B。

验收：cold 保持 worstLod ✅；active 切换无闪烁 ⏳ 主观待验

### P4：Benchmark 与对比 ⚠️ 部分

目标：建立 native vs native+prefetch vs custom refinement 的数据。

**已有**

- `public/benchmark-suites/scene-finland-native.json`（balanced × refinement/native）
- 报告：`benchmark-reports/2026-06-25/scene-finland-native/` — native/refinement **fpsP50 均 ~4**，gsplats ~2.7–2.9M

**未完成**

- 独立 prefetch on/off case
- `scene-nanguangchang-native.json` 四象限 suite
- 中心 blur-to-clear、priority 命中率专项指标

建议 case（仍有效）：

```Plain Text
finland-balanced-native
finland-balanced-refinement
finland-native-billions-policy   # P5 新增
```

指标：FPS P50/P95、gsplatsAvgM、blurToClearMs、firstFrameMs、VRAM peak、staleQueued

### P5：Billions 对齐与 FPS 根因 ⏳ 待做

目标：解释并缩小与 [billions.example.mjs](https://github.com/playcanvas/engine/blob/main/examples/src/examples/gaussian-splatting/billions.example.mjs) 的 FPS 差距。

方向：

1. **`regionPolicy: 'billions'`**：unlock 后全部 `applyLodRange(0, worstLod)`，关闭 warm/cold clamp / audit
2. **减 viewer 热路径**：native 下 RegionScheduler 是否可降频；prefetch 是否可默认 off 做 baseline
3. **LOD ramp 调参**：`lodMultiplier` 1.6 vs 1.8；Finland 十字布局 vs 单 active tile 对比 active splats
4. **renderer 确认**：WebGPU 路径 `gpu-sort` + `splatBudget=0` 与示例一致

---

## 10. 风险

### 10.1 Prefetch 过度导致 FPS 下降

如果 Top K 太大，会拉太多细档，active splats 上升，native FPS 下降。

控制：

- `maxPriorityFiles` 从 8 开始。
- `maxEnsurePerTick` 从 4-8 开始。
- 停驻触发，不持续触发。

### 10.2 与 native loader 内部策略冲突

PlayCanvas loader 可能已有队列顺序。过强 reorder 可能破坏其内部假设。

控制：

- 初期只调用 `ensureFileResource`。
- 第二阶段再轻量 reorder。
- 不修改 loader 原型，不长期 patch。

### 10.3 中心变清收益不明显

如果瓶颈是单个 L0 file 太大，prefetch 只能提前排队，收益有限。

控制：

- 资产侧继续评估 chunk 粒度。
- benchmark 里分开记录 pending file 数和单 file 下载耗时。

### 10.4 active splats 无上限

官方 billions 使用 `splatBudget = 0`，依赖 LOD ramp 控制 active splats。若 Finland 资产 LOD 分布更密，active splats 可能过高。

控制：

- 调整 `lodBaseDistance / lodMultiplier`。
- 必要时给 native billions profile 增加可选 `nativeMaxActiveSplats`，但默认保持对齐官方。

---

## 11. 推荐默认参数

初始参数（**当前实现**）：

```ts
{
    tickIntervalMs: 150,
    idleBurstWindowMs: 200,
    idleDelayMs: 150,           // bootstrap 相机停驻阈值
    maxPriorityFiles: 12,
    maxEnsurePerTick: 6,
    centerBiasStrength: 2.0,
    staleQueueReorder: true     // P2 已默认开启
}
```

Finland / desktop native profile：

```Plain Text
renderer = gpu-sort
splatBudget = 0
lodBaseDistance = 40
lodMultiplier = 1.8
lodUpdateDistance = 32
lodUpdateAngle = 90
lodUnderfillLimit = 5
minPixelSize = 2
alphaClipForward = 1 / 255
```

---

## 12. 最终目标

最终状态应是：

```Plain Text
单 asset 单 entity:
  custom refinement 继续作为质量优先和强控调度路径

同 asset 多 entity / billions:
  nativeOctreeLod 保持官方级 FPS（P5：先对齐 billions 再谈 prefetch 收益）
  center-priority prefetch 改善中心变清速度（burst-only，可开关）
  RegionScheduler：默认 billions 对齐 OR 可选 warm/cold 预算（regionPolicy）
  loader queue 只做轻量下载优先级治理
```

这条路线的核心原则是：

```Plain Text
native 负责上屏和帧率
viewer 负责下载优先级；region 参与度仅在 rank 预算场景启用，不应默认偏离 billions
```

**当前差距**：Finland native benchmark fpsP50 ~4 vs billions 示例流畅 60fps（同 gsplats 量级下），下一步以 **P5 billions 对齐 A/B** 为主，而非继续叠 warm/cold 或 prefetch 频率。

