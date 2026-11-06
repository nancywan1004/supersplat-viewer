# Scene Profile Benchmark — 2026-07-24

## 本轮维度: profile

Suite: `public/benchmark-suites/scene-wuhan-legacy-matched-waypoints.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| wuhan-legacy-matched-waypoints | undefined | 2.5 | - | refinement | 2999.399999976158 | 76 | 109 | 408 | 320 | 53.0 | 60.0 | 2.40 |

## 交互巡检（糊→清晰）

### wuhan-legacy-matched-waypoints

播放段 FPS: P50=53.0, P95=60.0, min=49.0, 总播放=2881ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 30 | - | 59.0 | 60.0 | 49.0 | - | - | - | 339 | 259 | Y |
| kf-1 | 1.00 | 950 | 27 | - | 57.0 | 60.0 | 51.0 | - | - | - | 408 | 276 | Y |
| kf-2 | 2.00 | 965 | 24 | 11400 | 60.0 | 60.0 | 53.0 | 2.40 | 305 | 298 | 402 | 298 | N |
| kf-3 | 3.00 | 966 | 17 | 9600 | 60.0 | 60.0 | 59.0 | 2.40 | 366 | 320 | 378 | 320 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/wuhan-legacy-matched-waypoints/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/wuhan-legacy-matched-waypoints/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/wuhan-legacy-matched-waypoints/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/wuhan-legacy-matched-waypoints/kf-3.jpg)



## 优化前 vs 优化后

### default（基线 `wuhan-legacy-matched-waypoints`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| wuhan-legacy-matched-waypoints | - | refinement | 2999 (—) | - (—) | 11400 | 11400 | 320 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）