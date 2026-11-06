# Wuhan lodScaleAlign A/B — 2026-07-29

对比项：优化前 = `lodScaleAlign:false`；优化后 = `lodScaleAlign:true`（场景 AABB/叶/密度缩小 effective d0）。投影密度与引擎钳制两边相同。

| 指标 | 优化前 | 优化后 | Δ |
|------|--------|--------|---|
| firstFrameMs | 26331 | 18184 | -30.9% |
| fpsP50 (播放) | 44 | 27 | -38.6% |
| gsplatsAvgM | 3.22 | 2.45 | - |
| blur mean (ms) | 7601 | 6801 | -10.5% |
| blur P50 (ms) | 11801 | 8400.5 | -28.8% |
| blur P90 (ms) | 16400.599999904633 | 17600.700000047684 | 7.3% |
| jsHeapPeak Mb | 310.04175090789795 | 276.08851051330566 | - |
| vramPeak Mb | 314.81760692596436 | 291.1357069015503 | - |

## 逐关键帧 blurToClearMs

| kf | 优化前 | 优化后 | Δ% | timedOut前 | timedOut后 |
|----|--------|--------|-----|-----------|-----------|
| kf-0 | 2201.0999999046326 | 1202.9000000953674 | -45.4% |  |  |
| kf-1 | 0 | 0 | -% |  |  |
| kf-2 | 16400.599999904633 | 17600.700000047684 | 7.3% |  |  |
| kf-3 | 11801 | 8400.5 | -28.8% |  |  |

## 原始报告

- 优化前：`benchmark-reports/2026-07-29/scene-wuhan-scale-align-before/`
- 优化后：`benchmark-reports/2026-07-29/scene-wuhan-scale-align-after/`