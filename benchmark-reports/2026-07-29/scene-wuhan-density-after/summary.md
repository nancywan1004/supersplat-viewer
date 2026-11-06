# Scene Profile Benchmark — 2026-07-29

## 本轮维度: profile

Suite: `/Users/leqiwan/Desktop/shuyuan_wlq/大场景渲染/supersplat-viewer/public/benchmark-suites/scene-wuhan-density-after.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| wuhan-density-after | undefined | - | - | refinement | 25097.200000047684 | 179 | 236 | 299 | 311 | 42.0 | 55.0 | 3.24 |

## 交互巡检（糊→清晰）

### wuhan-density-after

播放段 FPS: P50=42.0, P95=55.0, min=40.0, 总播放=2866ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 7 | 3000 | 54.0 | 57.0 | 51.0 | 3.12 | 195 | 254 | 220 | 256 | N |
| kf-1 | 1.00 | 970 | 0 | 0 | 44.0 | 44.0 | 40.0 | 3.12 | 205 | 254 | 216 | 254 | N |
| kf-2 | 2.00 | 950 | 25 | 13999 | 59.0 | 60.0 | 42.0 | 3.35 | 261 | 292 | 274 | 292 | N |
| kf-3 | 3.00 | 947 | 25 | 12401 | 60.0 | 60.0 | 50.0 | 3.37 | 278 | 311 | 299 | 311 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/wuhan-density-after/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/wuhan-density-after/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/wuhan-density-after/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/wuhan-density-after/kf-3.jpg)



## 优化前 vs 优化后

### default（基线 `wuhan-density-after`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| wuhan-density-after | - | refinement | 25097 (—) | 0 (—) | 13999 | 13999 | 311 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）