# Scene Profile Benchmark — 2026-07-30

## 本轮维度: profile

Suite: `/Users/leqiwan/Desktop/shuyuan_wlq/大场景渲染/supersplat-viewer/public/benchmark-suites/scene-wuhan-v8-midstop-before.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| wuhan-v8-midstop-before | undefined | - | - | refinement | 5567.700000047684 | 102 | 153 | 309 | 308 | 45.0 | 56.0 | 2.71 |

## 交互巡检（糊→清晰）

### wuhan-v8-midstop-before

播放段 FPS: P50=45.0, P95=56.0, min=42.0, 总播放=2906ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 30 | 15399 | 82.0 | 120.0 | 45.0 | 2.48 | 180 | 238 | 201 | 238 | N |
| kf-1 | 1.00 | 980 | 0 | 0 | 44.0 | 44.0 | 42.0 | 2.53 | 193 | 238 | 193 | 238 | N |
| kf-2 | 2.00 | 971 | 19 | 13201 | 63.0 | 76.0 | 49.0 | 2.85 | 255 | 284 | 255 | 286 | N |
| kf-3 | 3.00 | 955 | 11 | 9599 | 69.0 | 84.0 | 54.0 | 2.99 | 293 | 308 | 309 | 308 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/wuhan-v8-midstop-before/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/wuhan-v8-midstop-before/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/wuhan-v8-midstop-before/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/wuhan-v8-midstop-before/kf-3.jpg)



## 优化前 vs 优化后

### default（基线 `wuhan-v8-midstop-before`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| wuhan-v8-midstop-before | - | refinement | 5568 (—) | 0 (—) | 13201 | 15399 | 308 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）