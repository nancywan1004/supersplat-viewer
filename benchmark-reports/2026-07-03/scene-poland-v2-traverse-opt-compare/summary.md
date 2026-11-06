# Poland-v2 全量遍历优化 A/B — 2026-07-03

场景：`poland-v2/lod-meta.json` · `lodRuntime=refinement` · `lodMode=performance`
路径：`settings-poland-mainline-benchmark.json`（6 关键帧）

对比项：优化前 = `1669da55`（BVH+PQ，无 dirty 门控）；优化后 = dirty 门控 + maxLeafEvaluations。

| 指标 | 优化前 | 优化后 | Δ |
|------|--------|--------|---|
| firstFrameMs | 7218 | 7072 | -2.0% |
| fpsP50 (播放) | 60 | 60 | 0.0% |
| fpsP95 (播放) | 60 | 60 | 0.0% |
| gsplatsAvgM | 2.70 | 2.70 | - |
| blur P90 (ms) | 3600.39999999851 | 3400.2000000029802 | -5.6% |
| jsHeapPeak Mb | 534.0501956939697 | 510.369421005249 | - |
| vramPeak Mb | 485.3207006454468 | 485.32132625579834 | - |

## 逐关键帧 blurToClearMs

| kf | 优化前 | 优化后 | Δ% |
|----|--------|--------|-----|
| kf-0 | 0 | 0 | -% |
| kf-1 | 3000.7000000029802 | 2201 | -26.7% |
| kf-2 | 1600.8000000044703 | 2201 | 37.5% |
| kf-3 | 3600.39999999851 | 3400.2000000029802 | -5.6% |
| kf-4 | 1200.1999999955297 | 1200.8000000044703 | 0.0% |
| kf-5 | 0 | 0 | -% |

## 原始报告

- 优化前：`benchmark-reports/2026-07-03/scene-poland-v2-traverse-before/`
- 优化后：`benchmark-reports/2026-07-03/scene-poland-v2-traverse-after/`