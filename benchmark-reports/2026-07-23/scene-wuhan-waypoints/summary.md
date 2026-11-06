# Scene Profile Benchmark — 2026-07-23

## 本轮维度: profile

Suite: `public/benchmark-suites/scene-wuhan-waypoints.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| wuhan-user-waypoints | undefined | 2.5 | - | refinement | 6991.600000023842 | 280 | 256 | 356 | 308 | 49.0 | 59.0 | 2.44 |

## 交互巡检（糊→清晰）

### wuhan-user-waypoints

播放段 FPS: P50=49.0, P95=59.0, min=45.0, 总播放=2900ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 12 | 8000 | 47.0 | 49.0 | 44.0 | 2.44 | 299 | 262 | 342 | 271 | N |
| kf-1 | 1.00 | 983 | 15 | 11400 | 47.0 | 49.0 | 46.0 | 2.44 | 293 | 262 | 343 | 270 | N |
| kf-2 | 2.00 | 967 | 20 | 8801 | 60.0 | 60.0 | 50.0 | 2.44 | 290 | 271 | 354 | 289 | N |
| kf-3 | 3.00 | 950 | 23 | 6202 | 52.0 | 60.0 | 51.0 | 2.44 | 317 | 269 | 354 | 308 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/wuhan-user-waypoints/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/wuhan-user-waypoints/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/wuhan-user-waypoints/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/wuhan-user-waypoints/kf-3.jpg)



## 优化前 vs 优化后

### default（基线 `wuhan-user-waypoints`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| wuhan-user-waypoints | - | refinement | 6992 (—) | 11400 (—) | 8801 | 11400 | 308 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）