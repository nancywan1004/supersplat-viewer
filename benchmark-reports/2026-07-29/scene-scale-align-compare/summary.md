# lodScaleAlign 调度尺度对齐 A/B 总览 — 2026-07-29

优化后 = 按场景 AABB/叶/密度缩小 `lodBaseDistance`；优化前 = `lodScaleAlign:false`。南广场抽样 4 关键帧；武汉 4 waypoints。

| 场景 | blur mean 前 | blur mean 后 | Δ% | blur P90 前 | blur P90 后 | Δ% |
|------|--------------|--------------|----|-------------|-------------|----|
| 南广场 | 8252 | 4451 | -46.1% | 10601.200000047684 | 8200.5 | -22.6% |
| Wuhan | 7601 | 6801 | -10.5% | 16400.599999904633 | 17600.700000047684 | 7.3% |

- [南广场明细](nanguangchang/summary.md)
- [Wuhan 明细](wuhan/summary.md)