# Wuhan CDN 原版 vs wuhan-98304 对比

exportedAt: 2026-07-29T03:25:18.822Z

原版: https://unicity-model-cdn.bdnrc.org.cn/.../wuhan/lod-meta.json（min≈0）
98304: https://unicity-dev2.bdnrc.org.cn/.../wuhan-98304/lod-meta.json
路径: dolly zoom in/out · budget=2.5 · 同 settings（未缩放）

## A 轴全段

| scene | frames | camUniq | frameMs p50/p90/max | update max | gpu p50/p90/max | blocks p50 | gs p50 | pendingPeak |
|-------|-------:|--------:|---------------------|-----------:|-----------------|-----------:|-------:|------------:|
| cdn-wuhan | 1781 | 4 | 16.7/17.5/183.5 | 5.4 | 15.8/22.1/86.3 | 1431 | 1.7 | 20 |
| cdn-wuhan-98304 | 1783 | 4 | 16.7/17.3/2466.4 | 41.3 | 13.9/20.4/4850.2 | 512 | 1.9 | 17 |

## 变清晰 blurToClearMs

| scene | blur p50/p90/max | timeouts | pendingPeakMax | stalePeakMax | gs@clear p50 |
|-------|-----------------:|---------:|---------------:|-------------:|-------------:|
| cdn-wuhan | 1811/5233/16291 | 0/6 | 20 | 251 | 2.04 |
| cdn-wuhan-98304 | 1607/5829/14681 | 0/6 | 17 | 108 | 2.05 |

### per-step

| scene | far | zoom_in_mid | zoom_in_near | zoom_in_close | zoom_out_mid | zoom_out_far |
|-------|----:|----:|----:|----:|----:|----:|
| cdn-wuhan | 16291 | 5233 | 1206 | 1812 | 1006 | 1811 |
| cdn-wuhan-98304 | 14681 | 5829 | 1607 | 0 | 1004 | 1612 |

## EARLY / LATE

| scene | early fm max | early upd max | late fm p50/p90 | late gpu p50 | late blocks | late upd>100 |
|-------|-------------:|--------------:|-----------------|-------------:|------------:|-------------:|
| cdn-wuhan | 17.7 | 2.9 | 17.2/67.6/133.6 | 12.4 | 1430 | 0 |
| cdn-wuhan-98304 | 2433.3 | 2.0 | 16.7/17.1/17.6 | 17.5 | 512 | 0 |
