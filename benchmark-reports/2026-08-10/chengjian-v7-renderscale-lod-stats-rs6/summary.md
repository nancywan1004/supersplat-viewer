# chengjian-v7 renderScale LOD 统计 — 2026-08-10

- content: `https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/chengjian-school-v7/lod-meta.json`
- budget: **6** · `lodSelectMode=renderScale` · URL `lodRenderScale`
- `targetLod = max(renderScaleLod, engineOptimalLod)`
- 每关键帧变清后强制 scan：**仅视锥内叶**；`engineOptimalLod` = applyLodChanges **merge 前快照**
- 同步记录：`gsplatsAtClearM` / `blurToClearMs` / `pendingPeak`

## 主表（选档 + 性能）

优先看：**mean eng / mean target / visual>eng % / gsplatsAvgM / blurAvgMs / pendingPeak**

| rs | mean eng | mean target | mean rsLod | visual>eng % | eng>rs % | Δ(tgt−eng) | gsplatsAvgM | blurAvgMs* | pendingPeak |
|----|----------|-------------|------------|--------------|----------|------------|-------------|------------|-------------|
| 6 | 1.66 | 3.90 | 3.50 | 72.1% | 16.8% | 2.246 | 0.89 | 21766 | 32 |

*blurAvgMs = blur>0 关键帧均值（通常不含 kf-0）

## LOD 采样明细

| rs | leaf samples | mean rsLod | mean engLod | mean target | visual>eng % | eng>rs % | equal % | mean Δ(tgt−eng) |
|----|--------------|------------|-------------|-------------|--------------|----------|---------|-----------------|
| 6 | 656 | 3.50 | 1.66 | 3.90 | 72.1% | 16.8% | 11.1% | 2.246 |

## 直方图（四关键帧合计）

### rs=6

- **renderScaleLod**: `L0:114 L1:38 L2:53 L3:74 L4:66 L5:126 L6:90 L7:64 L8:31`
- **engineOptimalLod**: `L0:37 L1:264 L2:223 L3:132`
- **targetLod**: `L0:36 L1:47 L2:58 L3:138 L4:66 L5:126 L6:90 L7:64 L8:31`

## 分关键帧（LOD + 性能）

### rs=6

| kf | n | mean rs | mean eng | mean tgt | visual>eng | eng>rs | equal | gsplatsM | blurMs | pendPeak |
|----|---|----------|----------|----------|------------|--------|-------|----------|--------|----------|
| kf-0 | 101 | 3.49 | 1.11 | 3.69 | 74.3% | 20.8% | 5% | 0.07 | 3542 | 0 |
| kf-1 | 205 | 4.25 | 1.73 | 4.34 | 82.4% | 6.3% | 11.2% | 1.10 | 46905 | 32 |
| kf-2 | 237 | 4.57 | 1.71 | 4.75 | 78.5% | 8.9% | 12.7% | 1.20 | 0 | 0 |
| kf-3 | 113 | 1.68 | 2.08 | 2.83 | 38.1% | 48.7% | 13.3% | 1.21 | 14852 | 22 |

