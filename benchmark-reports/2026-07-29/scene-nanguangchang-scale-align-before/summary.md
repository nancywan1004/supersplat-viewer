# Scene Profile Benchmark — 2026-07-29

## 本轮维度: profile

Suite: `/Users/leqiwan/Desktop/shuyuan_wlq/大场景渲染/supersplat-viewer/public/benchmark-suites/scene-nanguangchang-scale-align-before.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| nanguangchang-scale-align-before | undefined | - | - | refinement | 23635.10000014305 | 227 | 241 | 357 | 355 | 45.0 | 60.0 | 2.97 |

## 交互巡检（糊→清晰）

### nanguangchang-scale-align-before

播放段 FPS: P50=45.0, P95=60.0, min=33.0, 总播放=2900ms

| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |
|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|
| kf-0 | 0.00 | 0 | 8 | 3801 | 35.0 | 36.0 | 33.0 | 2.55 | 237 | 263 | 249 | 264 | N |
| kf-1 | 1.00 | 971 | 10 | 10405 | 51.0 | 53.0 | 37.0 | 2.98 | 243 | 271 | 310 | 272 | N |
| kf-2 | 2.00 | 964 | 16 | 8201 | 45.0 | 60.0 | 41.0 | 3.12 | 287 | 310 | 298 | 310 | N |
| kf-3 | 3.00 | 966 | 10 | 10601 | 60.0 | 60.0 | 58.0 | 3.22 | 346 | 355 | 357 | 355 | N |

变清晰截图（480×270 JPEG）：

**kf-0**

![kf-0](./screenshots/nanguangchang-scale-align-before/kf-0.jpg)

**kf-1**

![kf-1](./screenshots/nanguangchang-scale-align-before/kf-1.jpg)

**kf-2**

![kf-2](./screenshots/nanguangchang-scale-align-before/kf-2.jpg)

**kf-3**

![kf-3](./screenshots/nanguangchang-scale-align-before/kf-3.jpg)



## 优化前 vs 优化后

### default（基线 `nanguangchang-scale-align-before`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| nanguangchang-scale-align-before | - | refinement | 23635 (—) | 10405 (—) | 8201 | 10601 | 355 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）