# 南广场 lodScaleAlign A/B — 2026-07-29

对比项：优化前 = `lodScaleAlign:false`；优化后 = `lodScaleAlign:true`（场景 AABB/叶/密度缩小 effective d0）。投影密度与引擎钳制两边相同。

| 指标 | 优化前 | 优化后 | Δ |
|------|--------|--------|---|
| firstFrameMs | 23635 | 15422 | -34.8% |
| fpsP50 (播放) | 45 | 60 | 33.3% |
| gsplatsAvgM | 2.97 | 1.89 | - |
| blur mean (ms) | 8252 | 4451 | -46.1% |
| blur P50 (ms) | 10405.200000047684 | 7400.5 | -28.9% |
| blur P90 (ms) | 10601.200000047684 | 8200.5 | -22.6% |
| jsHeapPeak Mb | 356.5566682815552 | 296.7228145599365 | - |
| vramPeak Mb | 354.64680004119873 | 280.63430309295654 | - |

## 逐关键帧 blurToClearMs

| kf | 优化前 | 优化后 | Δ% | timedOut前 | timedOut后 |
|----|--------|--------|-----|-----------|-----------|
| kf-0 | 3800.7000000476837 | 2201.2000000476837 | -42.1% |  |  |
| kf-1 | 10405.200000047684 | 8200.5 | -21.2% |  |  |
| kf-2 | 8201.199999809265 | 0 | -100.0% |  |  |
| kf-3 | 10601.200000047684 | 7400.5 | -30.2% |  |  |

## 原始报告

- 优化前：`benchmark-reports/2026-07-29/scene-nanguangchang-scale-align-before/`
- 优化后：`benchmark-reports/2026-07-29/scene-nanguangchang-scale-align-after/`