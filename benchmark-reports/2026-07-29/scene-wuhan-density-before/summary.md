# Scene Profile Benchmark — 2026-07-29

## 本轮维度: profile

Suite: `/Users/leqiwan/Desktop/shuyuan_wlq/大场景渲染/supersplat-viewer/public/benchmark-suites/scene-wuhan-density-before.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| wuhan-density-before | undefined | - | - | refinement | 37584.200000047684 | 278 | 291 | 348 | 340 | 41.0 | 52.0 | 3.65 |

## 交互巡检（糊→清晰）

### wuhan-density-before

播放段 FPS: P50=41.0, P95=52.0, min=40.0, 总播放=2915ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 4 | 1402 | 42.0 | 42.0 | 41.0 | 3.62 | 252 | 296 | 278 | 296 | N |
| kf-1 | 1.00 | 982 | 5 | 4201 | 40.0 | 41.0 | 39.0 | 3.62 | 297 | 316 | 308 | 316 | N |
| kf-2 | 2.00 | 967 | 23 | 15000 | 55.0 | 60.0 | 40.0 | 3.71 | 283 | 316 | 348 | 324 | N |
| kf-3 | 3.00 | 966 | 26 | 15602 | 60.0 | 60.0 | 50.0 | 3.68 | 316 | 340 | 346 | 340 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/wuhan-density-before/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/wuhan-density-before/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/wuhan-density-before/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/wuhan-density-before/kf-3.jpg)



## 优化前 vs 优化后

### default（基线 `wuhan-density-before`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| wuhan-density-before | - | refinement | 37584 (—) | 4201 (—) | 15000 | 15602 | 340 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）