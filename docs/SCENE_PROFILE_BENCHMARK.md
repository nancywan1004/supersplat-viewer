# Scene Profile Benchmark

Phase 1 仅 **profile 轴**：在同一场景上对比不同 preset / tunable 的加载耗时与帧率。

默认场景：**PlayCanvas downtown 4-piece**（[`settings-downtown-like.json`](../public/assets/settings/settings-downtown-like.json)）。

## 前置

1. 启动开发服务（含 CORS 代理，拉取 `code.playcanvas.com` 资产）：

```bash
npm run develop
```

浏览器访问基址：**http://localhost:3000/**（`serve` 默认端口 3000；代理 **3001**）。

2. （可选）Playwright 批量跑 suite：

```bash
npm i -D playwright
npx playwright install chromium
npm run benchmark:profile
```

## 方式一：浏览器手动（单 case）

打开 DevTools Console，等待 `[SceneProfileBenchmark]` 日志或读取 `window.__sceneProfileBenchmark`。

**downtown 4-piece + preset 覆盖：**

```
http://localhost:3000/?benchmark=1&benchmarkLabel=standard&preset=standard&settings=/assets/settings/settings-downtown-like.json
```

**使用 settings 内联 profile（mega-medium + tunable）：**

```
http://localhost:3000/?benchmark=1&benchmarkLabel=downtown-like&settings=/assets/settings/settings-downtown-like.json
```

说明：

- `benchmark=1` 自动叠加 `noui` / `nofx` / `noreveal` / `noanim`
- 有 `contentManifest` 时**不必**传 `content`
- `?preset=` 覆盖 settings 里的档位（URL 优先于 settings）

## 方式二：Playwright suite（多 case）

Suite 示例：

- 单场景 preset 扫档：[`scene-profiles.json`](../public/benchmark-suites/scene-profiles.json)
- **lodMode 三档 vs lodRuntime**：[`scene-nanguangchang-native.json`](../public/benchmark-suites/scene-nanguangchang-native.json)（balanced refinement vs native + performance/quality native）
- **三 mode 对比（refinement）**：[`scene-nanguangchang-modes.json`](../public/benchmark-suites/scene-nanguangchang-modes.json)
- Finland 双 tile：[`scene-finland-native.json`](../public/benchmark-suites/scene-finland-native.json)

```bash
node scripts/benchmark-playwright.mjs public/benchmark-suites/scene-nanguangchang-native.json
```

`summary.md` 自动生成对比表（基线 `lodRuntime=native`，含 Δ%）。`results.json` 含 `lodMode`、`lodRuntime`、`poolEvictions`、`bottleneckHint`。

```bash
node scripts/benchmark-playwright.mjs public/benchmark-suites/scene-profiles.json
# 或
npm run benchmark:profile
```

输出目录：`benchmark-reports/{YYYY-MM-DD}/results.json` + `summary.md`。

**Warmup（可选，热启动）**：suite `"warmup": true` 或 `BENCHMARK_WARM_START=1` — 首个 case 预热一遍（丢弃），正式 case 在同一浏览器 context 内测量（HTTP 缓存已热）。

**Cold start（Playwright 默认）**：每个 case 独立启动 Chromium；CDP 禁用 HTTP 缓存 + `clearBrowserCache` + `--disk-cache-size=0`。更接近首访加载。`results.json` 的 `runConditions` 记录会话与缓存策略。

`BENCHMARK_SKIP_WARMUP=1` 为旧变量，冷启动已是默认，可不再设置。

自定义基址：

```bash
BENCHMARK_BASE_URL=http://127.0.0.1:3000/ node scripts/benchmark-playwright.mjs
```

## 指标

| 字段 | 说明 |
|------|------|
| `firstFrameMs` | 场景首帧可渲染（`firstFrame` 事件，相对页面启动）；加载完成唯一指标 |
| `settleStartMs` | 首帧后 settle 再采样 / 进入 animTrack 巡检 |
| `fpsP50` / `fpsP95` | 采样 5s 内帧率分位 |
| `gsplatsAvgM` | 采样期平均 splat 数（百万） |
| `jsHeapAtFirstFrameMb` | 首帧时 Chromium JS 堆已用（MB）；非 Chromium 为 null |
| `vramTexAtFirstFrameMb` | 首帧时 PlayCanvas 纹理显存 `app.stats.vram.tex`（MB） |
| `jsHeapPeakMb` / `vramTexPeakMb` | 整 case 期间（含 settle、animTrack、idle 采样）峰值 |
| `presetId` | 实际命中档位（含 platform 前缀） |
| `rendererUsed` | 请求 renderer |

结果挂载：`window.__sceneProfileBenchmark`；事件 `sceneProfileBenchmark:complete`。

### 交互巡检（Phase 1+）

`firstFrame` 后自动执行相机路径（默认 4 个 downtown 点位），每个点位：

1. `camera:gotoPose` 平滑移动（约 1.2s）
2. 等待 refinement `pendingNodes === 0` 且 `refinementRatio ≥ 0.95` 稳定 8 帧
3. 记录 `blurToClearMs`（**pending 峰值 → 0** 耗时）、`pendingPeakNodes`、过程 `fpsP50/P95/Min`、`gsplatsAtClearM`
4. 记录内存：`jsHeapAtClearMb`、`vramTexAtClearMb`（变清晰瞬间），以及等待期间 `jsHeapPeakDuringRefineMb`、`vramTexPeakDuringRefineMb`

结果字段：`interactionWaypoints[]`（见 `results.json`）。

默认点位定义：`src/benchmark/benchmark-interaction.ts` → `DEFAULT_DOWNTOWN_BENCHMARK_WAYPOINTS`。

## 单轮单轴约定

- 每轮 suite 只评 **一个** `benchmarkAxis`（Phase 1 固定 `profile`）
- **不**自动跑 splat-transform；exportParams / sceneScale 维需用户另供 URL 与 suite（后续 Phase 2）

## 相关文档

- [SCENE_PROFILE.md](SCENE_PROFILE.md) — 档位与 tunable
- [BENCHMARK_HUD.md](BENCHMARK_HUD.md) — **benchmarkHud 各行参数说明（WB Cap / Bake % / Scheduler tick 等）**
- [CONTENT_MANIFEST.md](CONTENT_MANIFEST.md) — downtown 多 piece
- [LOD_DOWNTOWN_ASSET_PIPELINE.md](LOD_DOWNTOWN_ASSET_PIPELINE.md) — 资产导出与 CDN 对齐
