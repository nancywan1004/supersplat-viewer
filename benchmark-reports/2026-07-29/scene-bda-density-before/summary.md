# Scene Profile Benchmark — 2026-07-29

## 本轮维度: profile

Suite: `/Users/leqiwan/Desktop/shuyuan_wlq/大场景渲染/supersplat-viewer/public/benchmark-suites/scene-bda-density-before.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| bda-density-before | undefined | - | - | refinement | 8159.699999809265 | 96 | 157 | 356 | 338 | 60.0 | 60.0 | 2.67 |

## 交互巡检（糊→清晰）

### bda-density-before

播放段 FPS: P50=60.0, P95=60.0, min=60.0, 总播放=2863ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 8 | 4199 | 60.0 | 60.0 | 59.0 | 2.40 | 179 | 226 | 203 | 226 | N |
| kf-1 | 1.00 | 967 | 14 | 9400 | 60.0 | 60.0 | 59.0 | 2.41 | 234 | 262 | 248 | 262 | N |
| kf-2 | 2.00 | 948 | 13 | 9401 | 60.0 | 60.0 | 59.0 | 3.02 | 282 | 290 | 289 | 292 | N |
| kf-3 | 3.00 | 949 | 14 | 20599 | 60.0 | 60.0 | 58.0 | 2.87 | 354 | 338 | 356 | 338 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/bda-density-before/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/bda-density-before/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/bda-density-before/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/bda-density-before/kf-3.jpg)



## 优化前 vs 优化后

### default（基线 `bda-density-before`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| bda-density-before | - | refinement | 8160 (—) | 9400 (—) | 9401 | 20599 | 338 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）