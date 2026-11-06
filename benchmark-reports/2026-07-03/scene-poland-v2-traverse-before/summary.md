# Scene Profile Benchmark — 2026-07-03

## 本轮维度: profile

Suite: `/Users/leqiwan/Desktop/shuyuan_wlq/大场景渲染/supersplat-viewer/public/benchmark-suites/scene-poland-v2-traverse-before.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| poland-v2-traverse-before | undefined | - | - | refinement | 7218.39999999851 | 264 | 269 | 534 | 485 | 60.0 | 60.0 | 2.70 |

## 交互巡检（糊→清晰）

### poland-v2-traverse-before

播放段 FPS: P50=60.0, P95=60.0, min=59.0, 总播放=10275ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 0 | 0 | 60.0 | 60.0 | 60.0 | 1.68 | 230 | 269 | 264 | 269 | N |
| kf-1 | 2.10 | 2049 | 2 | 3001 | 60.0 | 60.0 | 60.0 | 2.56 | 316 | 326 | 329 | 326 | N |
| kf-2 | 4.20 | 2064 | 1 | 1601 | 60.0 | 60.0 | 60.0 | 3.18 | 383 | 375 | 390 | 385 | N |
| kf-3 | 6.30 | 2050 | 5 | 3600 | 60.0 | 60.0 | 59.0 | 3.01 | 487 | 473 | 534 | 473 | N |
| kf-4 | 8.40 | 2048 | 1 | 1200 | 60.0 | 60.0 | 60.0 | 3.02 | 498 | 465 | 528 | 485 | N |
| kf-5 | 10.50 | 2065 | 0 | 0 | 60.0 | 60.0 | 60.0 | 2.75 | 476 | 465 | 515 | 465 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/poland-v2-traverse-before/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/poland-v2-traverse-before/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/poland-v2-traverse-before/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/poland-v2-traverse-before/kf-3.jpg)

**kf-4**

![kf-4](./screenshots/poland-v2-traverse-before/kf-4.jpg)

**kf-5**

![kf-5](./screenshots/poland-v2-traverse-before/kf-5.jpg)



## 优化前 vs 优化后

### default（基线 `poland-v2-traverse-before`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| poland-v2-traverse-before | - | refinement | 7218 (—) | 3001 (—) | 1601 | 3600 | 485 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）