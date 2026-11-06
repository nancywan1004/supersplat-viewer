# Poland leaf ladder — 2026-08-11

settings=https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/settings-poland.json · budget=2.5 · webgpu · 4 static poses · blur timeout 45s

| case | leaves | firstUsefulMs | frameMs P50/P90 | update P50/P90 | gpu P50 | blocks P50 | gsplats P50 | blur P50/P90 | pendingPeak P50/max | timeouts |
|------|-------:|--------------:|-----------------|----------------|--------:|-----------:|------------:|--------------|---------------------|---------:|
| poland-96k-hard | 4096 | 5413 | 16.7/17.2 | 6.2/8.2 | 17.3 | 4096 | 2.19 | 11900/21158 | 26/56 | 0/4 |
| poland-96k-C-ext10-min8k | 32752 | 15472 | 66.7/99.9 | 49.8/63.9 | 28.8 | 32752 | 2.06 | 6503/26061 | 25/61 | 0/4 |
| poland-96k-B-ext10-min16k | 16384 | 10370 | 25.7/41.7 | 21.5/29.9 | 26.6 | 16384 | 2.19 | 10333/27630 | 20/64 | 0/4 |

## per-step blurToClearMs

| case | kf0 | kf1 | kf2 | kf3 |
|------|----:|----:|----:|----:|
| poland-96k-hard | 33833 | 21158 | 10071 | 11900 |
| poland-96k-C-ext10-min8k | 33730 | 26061 | 5713 | 6503 |
| poland-96k-B-ext10-min16k | 33528 | 27630 | 6513 | 10333 |

## Conclusion hints

- Prefer lower **frameMs / updateMs** for steady FPS.
- Prefer lower **blurToClear / pendingPeak** for load & move clarity.
- Leaf count is the main packing axis among these three (all ~96k SOG bins).
