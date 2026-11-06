# Scene Profile Benchmark — 2026-07-24

## 本轮维度: profile

Suite: `public/benchmark-suites/scene-wuhan-v5-matched-waypoints.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| wuhan-v5-matched-waypoints | undefined | 2.5 | - | refinement | 6265.800000071526 | 149 | 125 | 290 | 260 | 59.0 | 60.0 | 1.92 |

## 交互巡检（糊→清晰）

### wuhan-v5-matched-waypoints

播放段 FPS: P50=59.0, P95=60.0, min=59.0, 总播放=2878ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 12 | 7400 | 60.0 | 60.0 | 59.0 | 1.75 | 177 | 174 | 182 | 174 | N |
| kf-1 | 1.00 | 950 | 11 | 10001 | 60.0 | 60.0 | 59.0 | 1.98 | 200 | 210 | 222 | 210 | N |
| kf-2 | 2.00 | 965 | 12 | 8001 | 60.0 | 60.0 | 59.0 | 2.01 | 234 | 233 | 258 | 233 | N |
| kf-3 | 3.00 | 964 | 7 | 5600 | 60.0 | 60.0 | 59.0 | 1.94 | 278 | 260 | 290 | 260 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/wuhan-v5-matched-waypoints/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/wuhan-v5-matched-waypoints/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/wuhan-v5-matched-waypoints/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/wuhan-v5-matched-waypoints/kf-3.jpg)



## 优化前 vs 优化后

### default（基线 `wuhan-v5-matched-waypoints`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| wuhan-v5-matched-waypoints | - | refinement | 6266 (—) | 10001 (—) | 8001 | 10001 | 260 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）