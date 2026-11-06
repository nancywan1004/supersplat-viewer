# Poland v2 · Longtask / CPU 栈归因

> 日期：2026-07-15  
> Profile：`chrome-cpu-profile-refinement-poland-finelod_gapAttr_v2.json`  
> 对应 gap 结论：Mode B（高 gap ≠ bake）→ 本文件查「主线程到底在干嘛」

## 方法说明

CDP `Profiler.start` 是**采样 CPU profile**，不是 PerformanceObserver longtask 事件。  
节点常缺 `parent` 字段，已用 `children` 反向重建调用链。

## Top self-time（订正后调用链）

| Self ms | % | 函数 | 真正的调用方 |
|--------:|--:|------|--------------|
| **46491** | **41.4%** | `isOctreeBootstrapPlaceableNode` | `ensureStreamingBootstrapCoarseFiles`（25.7s）+ `countStreamingViewportBootstrapNodes`（20.8s） |
| 9675 | 8.6% | `countStreamingViewportBootstrapNodes` | `getStreamingViewportBootstrapStatus` ← **`pollStreamingBootstrapComplete` ← `onUpdate` / `frame:ready`**（每帧） |
| 7250 | 6.5% | `ensureStreamingBootstrapCoarseFiles` | 同上，`pollStreamingBootstrapComplete` 每帧 |
| 5565 | 5.0% | `sumAllocationSlots` | `readGsplatBufferUploadMetrics` ← **HUD `frameend`** + frameProfiler |
| 5450 | 4.9% | `assignSplatOffsets` | gsplat `_updateWorldState`（真 bake，合理） |
| 4718 | 4.2% | `readBakeGovernorPressure` | `runPriorityPrefetch`（扫整表 allocationMap） |
| 1735 | 1.5% | `(garbage collector)` | GC 不高 |

## 根因

`bootstrap.ts` 里：`streamingBootstrapGateReached` 后，`app.on('update')` **每帧**调用 `pollStreamingBootstrapComplete()`。

该函数在 **`progressUIHidden === true`（首屏已完成）之后没有短路**，仍每帧：

1. `ensureStreamingBootstrapCoarseFiles` → 扫 `octree.nodes`（Poland ~96k）
2. `getStreamingViewportBootstrapStatus` → 再扫一遍（边缘过滤失败时甚至两遍）

小函数 `isOctreeBootstrapPlaceableNode` 变成 41% self，是因为被 **每帧 × 全树节点** 狂调。

这正好解释 Mode B：高 gap 时 `bakeCpu` 不高，主线程被 **bootstrap 轮询** 和次级观测（HUD slots / governor pressure）占用。

## 已做修复

`pollStreamingBootstrapComplete`：一旦 `progressUIHidden`，跳过全树扫描，只保留 animTrack 开机。

## 仍建议的后续（未改）

| 项 | 说明 |
|----|------|
| HUD `frameend` → `sumAllocationSlots` | Poland allocationMap 大时每帧 O(blocks)；可降频或缓存 |
| `readBakeGovernorPressure` 扫 slots | 可用上帧 `bufferCopy*` / 缓存 slots，避免每 tick 全表 |
| 真 longtask Tracing | 可选：CDP `Tracing` + `DisabledByDefault-v8.gc` 核对 GC |

## 复验

硬刷新后再跑：

```bash
node scripts/chrome-performance-profile.mjs --scene=poland --lodRuntime=refinement --fineLod=1 --profileSuffix=_gapAttr_v3
```

期待：`isOctreeBootstrapPlaceableNode` / `ensureStreamingBootstrapCoarseFiles` 占比大幅下降；fps / gap 体感改善。
