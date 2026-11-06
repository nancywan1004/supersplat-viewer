# Scene Profile Benchmark — 2026-07-29

## 本轮维度: profile

Suite: `/Users/leqiwan/Desktop/shuyuan_wlq/大场景渲染/supersplat-viewer/public/benchmark-suites/scene-bda-density-after.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| bda-density-after | undefined | - | - | refinement | 19387.10000014305 | 148 | 193 | 318 | 316 | 60.0 | 60.0 | 2.35 |

## 交互巡检（糊→清晰）

### bda-density-after

播放段 FPS: P50=60.0, P95=60.0, min=59.0, 总播放=2895ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 8 | 4400 | 60.0 | 60.0 | 60.0 | 2.40 | 198 | 223 | 198 | 223 | N |
| kf-1 | 1.00 | 967 | 8 | 7600 | 60.0 | 60.0 | 59.0 | 1.85 | 226 | 249 | 226 | 249 | N |
| kf-2 | 2.00 | 964 | 8 | 7000 | 60.0 | 60.0 | 59.0 | 2.37 | 258 | 274 | 267 | 276 | N |
| kf-3 | 3.00 | 964 | 24 | 15200 | 60.0 | 60.0 | 59.0 | 2.76 | 318 | 316 | 318 | 316 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/bda-density-after/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/bda-density-after/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/bda-density-after/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/bda-density-after/kf-3.jpg)



## 优化前 vs 优化后

### default（基线 `bda-density-after`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| bda-density-after | - | refinement | 19387 (—) | 7600 (—) | 7000 | 15200 | 316 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）