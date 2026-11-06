# Wuhan-v8 lodScaleAlign 半边归一 A/B — 2026-07-30

优化前 = `lodScaleAlign:false`；优化后 = 半边归一（目标 L2≈14%·half，Wuhan 预期 effective d0≈1.92）。content=`wuhan-v8`，waypoints 4 点。

| 指标 | 优化前 | 优化后 | Δ |
|------|--------|--------|---|
| firstFrameMs | 5701 | 5756 | 1.0% |
| fpsP50 | 34 | 42 | - |
| gsplatsAvgM | 3.2807637499999998 | 2.9305535 | - |
| blur mean (ms) | 13850 | 13051 | -5.8% |
| blur P50 (ms) | 17799.800000190735 | 17000.900000095367 | -4.5% |
| blur P90 (ms) | 24001.400000095367 | 21199.799999952316 | -11.7% |

## 逐关键帧 blurToClearMs

| kf | 优化前 | 优化后 | Δ% | timedOut前 | timedOut后 |
|----|--------|--------|-----|-----------|-----------|
| kf-0 | 24001.400000095367 | 21199.799999952316 | -11.7% |  |  |
| kf-1 | 0 | 0 | - |  |  |
| kf-2 | 17799.800000190735 | 17000.900000095367 | -4.5% |  |  |
| kf-3 | 13600.199999809265 | 14001.599999904633 | 3.0% |  |  |

## 原始报告

- 优化前：`benchmark-reports/2026-07-30/scene-wuhan-v8-scale-align-before/`
- 优化后：`benchmark-reports/2026-07-30/scene-wuhan-v8-scale-align-after/`
