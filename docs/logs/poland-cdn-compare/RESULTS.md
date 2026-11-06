# Poland CDN 三方对比（dolly zoom + 变清晰）

exportedAt: 2026-07-29T02:17:43.701Z

路径：同一 target 沿视线 far→mid→near→close→mid→far（zoom in 再 zoom out）。

## 结构（打包侧）

| scene | leaves | L0/叶 mean | LODs |
|-------|-------:|-----------:|-----:|
| CDN poland | 362,875 | ~293 | 12 |
| CDN poland-new | 32,756 | ~3,250 | 10 |
| CDN poland-new-98304 | 4,096 | ~26,000 | 10 |

## A 轴全段

| scene | frames | camUniq | frameMs p50/p90/max | update max | gpu p50/p90/max | blocks p50 | gs p50 | pendingPeak |
|-------|-------:|--------:|---------------------|-----------:|-----------------|-----------:|-------:|------------:|
| poland | 297 | 6 | 82.5/182.7/316.7 | 237.6 | 23.5/33.0/46.2 | 217777 | 1.6 | 13 |
| poland-new | 1365 | 6 | 8.3/9.2/41.6 | 47.1 | 7.2/9.1/11.7 | 29308 | 0.8 | 5 |
| poland-new-98304 | 2352 | 6 | 8.3/8.9/50.2 | 5.3 | 9.5/11.8/14.9 | 4096 | 1.7 | 9 |

## 变清晰（blurToClearMs，每步从 pending peak → 稳定 clear）

| scene | blur p50/p90/max (ms) | timeouts | pendingPeakMax | stalePeakMax | gs@clear p50 |
|-------|----------------------:|---------:|---------------:|-------------:|-------------:|
| poland | 3090/3323/8003 | 0/6 | 13 | 78868 | 1.59 |
| poland-new | 0/1267/1847 | 0/6 | 5 | 3128 | 0.77 |
| poland-new-98304 | 1205/3415/5847 | 0/6 | 10 | 374 | 1.66 |

### per-step blurToClearMs

| scene | far | zoom_in_mid | zoom_in_near | zoom_in_close | zoom_out_mid | zoom_out_far |
|-------|----:|----:|----:|----:|----:|----:|
| poland | 8003 | 3090 | 3323 | 3217 | 0 | 0 |
| poland-new | 0 | 1267 | 1234 | 1847 | 0 | 0 |
| poland-new-98304 | 5847 | 1205 | 3415 | 2213 | 0 | 0 |

## EARLY / LATE

| scene | early fm max | early upd max | late fm p50/p90 | late gpu p50 | late blocks | late upd>100 |
|-------|-------------:|--------------:|-----------------|-------------:|------------:|-------------:|
| poland | 316.7 | 237.6 | 66.7/117.2/233.1 | 24.4 | 217777 | 13 |
| poland-new | 17.4 | 8.3 | 8.3/8.8/9.4 | 7.7 | 30173 | 0 |
| poland-new-98304 | 9.4 | 4.5 | 8.3/9.3/9.4 | 10.5 | 4096 | 0 |
