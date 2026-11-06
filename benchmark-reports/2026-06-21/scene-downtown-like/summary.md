# Scene Profile Benchmark — 2026-06-21

## 本轮维度: profile

Suite: `public/benchmark-suites/scene-downtown-like.json`

Renderer: `webgpu`

## 运行条件

- Browser session: fresh-launch-per-script
- Browser HTTP cache: warm-after-discarded-warmup
- Warmup: discarded run of `downtown-like-current-profile` (71248ms)
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | firstFrameMs | progressCompleteMs | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|--------------|---------------------|--------|--------|-------------|
| downtown-like-current-profile | desktop-mega-medium | 8 | 35284.299999952316 | 25724.100000023842 | 76.0 | 120.0 | 3.58 |

## 交互巡检（糊→清晰）

### downtown-like-current-profile

播放段 FPS: P50=76.0, P95=120.0, min=72.0, 总播放=2882ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|---------|
| kf-0 | 0.00 | 0 | 31 | 9443 | 77.0 | 79.0 | 76.0 | 3.27 | N |
| kf-1 | 1.00 | 953 | 1 | 3270 | 117.0 | 120.0 | 76.0 | 3.29 | N |
| kf-2 | 2.00 | 970 | 8 | 13527 | 79.0 | 84.0 | 77.0 | 3.88 | N |
| kf-3 | 3.00 | 960 | 1 | 6681 | 74.0 | 75.0 | 67.0 | 3.89 | N |


## 结论

- （填写本轮发现与推荐 preset）