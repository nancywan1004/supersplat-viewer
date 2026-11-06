# Scene Profile Benchmark — 2026-07-22

## 本轮维度: profile

Suite: `public/benchmark-suites/scene-wuhan.json`

Renderer: `webgpu`

## 运行条件

- Cold start: yes
- Browser session: fresh-chromium-per-case
- Chromium HTTP cache: disabled-cdp-clearBrowserCache-zero-disk-cache
- Cold start (default): fresh Chromium per case, HTTP cache disabled
- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异

| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |
|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|
| wuhan-current-profile | undefined | - | - | refinement | 3441.100000023842 | 80 | 150 | 80 | 150 | - | - | - |

## 交互巡检（糊→清晰）

### wuhan-current-profile

- （无交互数据）


## 优化前 vs 优化后

### default（基线 `wuhan-current-profile`）

| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |
|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|
| wuhan-current-profile | - | refinement | 3441 (—) | - (—) | - | - | 150 | - |


## 结论

- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）