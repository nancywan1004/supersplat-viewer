# Scene Profile

Scene Profile 对外只选 **lodMode 档位**（`performance` / `quality`），内部自动推导 **preset + budget**。可选 **lodRuntime** 选择 refinement（默认）或 native 引擎 LOD。refinement 调度为**单一调参表**（原 aggressive）。

## lodMode（两档，默认 `performance`）

| lodMode | 自动 preset（单 piece / mega） | 体感 |
|---------|-------------------------------|------|
| `performance`（**默认**） | standard / mega-low | 稳 FPS，边缘更糊 |
| `quality` | large / mega-medium | 中心先清，VRAM 更高 |

`balanced` 已移除；若仍传入会 warn 并按 `performance` 解析。

简写 settings：

```json
{ "sceneProfile": "performance" }
```

完整写法：

```json
{
  "sceneProfile": {
    "lodMode": "quality",
    "lodRuntime": "refinement",
    "lodMultiplier": 3,
    "lodBehindPenalty": 5,
    "lodBaseDistance": 5
  }
}
```

**选档（refinement / native 统一米制）**：`localDistance` 相对 `lodBaseDistance`，再按 `lodMultiplier` 几何级数升档。默认 **`lodBaseDistance=5`**、**`lodMultiplier=3`**、**`lodBehindPenalty=5`**（档距 5 / 15 / 45…）。

**调度尺度对齐（R95 + 金字塔）**：octree 就绪后用叶中心距离 **P95（R95）** 作稳健占用半径，并结合 LOD 金字塔远景目标档反推 `lodBaseDistance`：

- **何时跑 align**：默认**关**；仅 `"lodScaleAlign": true` 时开（可与显式 `lodBaseDistance` 组合：配置值作上限仍自适应）
- `targetFarLod`：各档总点数相对 L0 **约 ≤1/64**（容差 ×1.05）优先；否则 `round(maxLod×2/3)`
- `rawD0 = R95 / lodMultiplier^(targetFarLod-1)`
- `effectiveD0 = clamp(rawD0 × qualityFactor, 0.15, configuredD0)`；默认 **qualityFactor=1.4**
- 叶中位 / 密度仅日志诊断，**不**参与最终 d0
- 资产 meta `lodDistanceScale`（若 >1）仅作 soft 乘子（最多相对 raw×qf ±25%）
- 相机 `moveThr` 仍按叶中位对角 ×5%（与选档 d0 正交，见 `leaf-extent.ts`）

未写 `lodBaseDistance`、align 开启时预期（qf=1.4）：Wuhan-v6 / Florenz ≈ **0.37–0.38m**；南广场 ≈ **0.68m** 等。调试：`globalThis.__lodScaleAlignDebug`。

**解析优先级（`lodBaseDistance` / `lodMultiplier` / `lodBehindPenalty` 相同）**：

1. `settings.sceneProfile` 同名字段显式正数
2. 否则引擎默认 **5 / 3 / 5**（未写 settings 时行为与改前一致）

不提供 URL query 覆盖；改档请写 settings 或调用 `setLodPlacementParams`。

**绑定（主路径已接通）**：

- `bindGsplatEntityLodSettings` → entity `gsplat.lodBaseDistance` / `lodMultiplier`（bootstrap 写入；refinement / native 共用）
- 随后 `applyLodScaleAlignToComponent`（R95+金字塔；可选读 meta `lodDistanceScale` 作 soft）
- 数据链：`scale align → entity d0/x → 引擎 budgetScale/balancer → engineOptimalLod → refinement 下载`（**不再**本地算 rawOptimal）
- **可选** `lodSelectMode: "renderScale"`：在引擎 optimal 之后用屏幕尺寸视觉目标钳制（只允许变粗），见 [lodRenderScale机制说明.md](lodRenderScale机制说明.md)
- ladder 默认 **中央一次到位 / edge×1 / backlog×3**（可用 `?ladder=` 覆盖边缘；中央恒直达 target）
- 边缘/视锥外缘仍追有效 `optimalLod`（外缘用地板权重入队，避免预算空挂）；`renderScale` 模式下下载分改用 `visualUrgency`
- 首屏完成：中央细档 100% **且** 前景 `pending===0` **且** post-download settle 结束，再稳定若干帧
- **初始加载 BootstrapFast**（默认开）：视锥内（中央+边缘）下载/收条目标为 `visualTarget=min(maxLod, engineOptimal+steps)`（默认 steps=2）；`progressThresholdReached` 后退出进 polish 追满 `engineOptimal`。关：`?bootstrapCoarsenSteps=0` / `?bootstrapCoarsen=0`
- URL `?budget=`（百万）须生效：refinement boost **不再**把 budget 钳到 4M
- 下载失败：引擎 `maxRetries` 耗尽后 asset 会卡在假 `loaded`；refinement 外层 backoff（2s/5s/12s×最多 3 轮）`unload` 后再试；永久失败从 pending/中央追档剔除（HUD `fail`）
- 上屏：文件落地立刻 sync；已下未上用 `progressiveSyncInterval=2` drip（节流但持续变清晰，不再 6/12 帧干等）
- `bindGsplatStreamingLodSettings` → `scene.gsplat.lodBehindPenalty`（及 `lodUpdateDistance`）
- refinement：`buildPriorityFiles` 每次 full scan **重读** entity 组件；可用 `setLodPlacementParams` 热更新

### lodSelectMode / lodRenderScale（P1，默认关闭）

```json
{
  "sceneProfile": {
    "lodSelectMode": "renderScale",
    "lodRenderScale": 1.0,
    "coneFov0": 20,
    "coneFov": 80,
    "coneFoveate": 0.5,
    "behindFoveate": 0.2
  }
}
```

- 默认 `lodSelectMode: "distance"`（行为与改前一致）；**P4 暂缓**切默认，见 [lodRenderScale机制说明.md](lodRenderScale机制说明.md)
- `renderScale`：`targetLod = max(renderScaleLod, engineOptimalLod)`；foveation 连续调节有效像素阈值；无 meta `leafRepScale` 时用 AABB/`count` fallback
- **URL 覆盖 settings**（优先）：`?lodRenderScale=4` 或 `?renderScale=4`；`?lodSelectMode=renderScale|distance`。仅写 `lodRenderScale`/`renderScale` 且未写 mode 时，视为开启 `renderScale`
- HUD：`RenderScale` 行显示 `rs {lodRenderScale} · clamp · urg · 表来源`
- 调试：`globalThis.__lodRenderScaleDebug`

### Streaming 首屏阶段（状态优先）

参数与收条判定收敛在 [`streaming-bootstrap-policy.ts`](../src/loaders/gsplat/lod/octree/streaming-bootstrap-policy.ts)（`STREAMING_BOOTSTRAP` + `stepBootstrapCompletion`）。

| 阶段 | 进度 | 含义 |
|------|------|------|
| A | 0–`gate`(50)% | 文件 watermark / 开门禁 |
| B | →`coarseCap`(82)% | 仅粗档 `lodRange`，视锥粗 SOG；可 `readyToRender`，**输入仍锁** |
| C | →`refineCap`(99)% | `streamingLodUnlocked`：放开全档 + refinement；**仍不可交互** |
| D | 100% / 收条 | `progressThresholdReached`：**解锁输入** |

收条主路径（状态机）：中央细档≥1.0 + pending/staleLoaded/settle 全清 + **完整 settle 周期≥2** + settle 后连续 quietTicks(24，按 refinement tickSeq) ；pending 回流则作废周期重来。  
逃生仅在下载侧已稳且细档条件长期达不到时触发（禁止 pending 抖动期 escape）。

锁契约：`loadingCameraControlsLocked` **仅**在 `progressThresholdReached` 解开（勿绑 `streamingLodUnlocked` / `firstFrame`）。

未显式配置时不要假设 settings 里写了无效历史值会静默变档——只有正数显式字段才会覆盖默认。

URL / settings 可用 `performance` / `quality`；内部映射为 `performanceFirst` / `qualityFirst`。

## lodRuntime（与 lodMode 正交）

| 值 | 说明 |
|----|------|
| `refinement`（**默认**） | JS OctreeRefinementController 持续调度下载与 LOD 升档 |
| `native` | 首帧与 refinement 共用 bootstrap 闸门；`firstFrame` 后 handoff 到引擎原生 octree LOD |

refinement 调度参数见 `refinement-tunables.ts`（单一档位，原 aggressive：boost 并发 4/8、增量扫描 45 帧等）。`nearJumpLadder` 仍可由 `lodMode=quality` / URL / settings 打开。

## native 多 entity 路径（lodRuntime=native）

| lodMode | 行为 |
|---------|------|
| **performance** | **纯 native**：引擎 `updateLod` + `splatBudget=0`；unlock 后全 entity `0..worstLod`；**无** prefetch / warm-cold clamp |
| **quality** | **轻量 refinement 策略**：`NativeOctreePrefetchController`（burst ensure + queue reorder）；multi-region **warm/cold lodRange clamp** |

## preset 档位（内部推导，debug 可 override）

| preset | desktop budget | mobile budget |
|--------|----------------|---------------|
| `compact` | 2M | 1M |
| `standard` | 4M | 2M |
| `large` | 6M | 3M |
| `mega-low` | 4M | 2M |
| `mega-medium` | 8M | 4M |
| `mega-high` | 16M | 8M |
| `mega-extreme` | 25M | 12M |

platform 运行时自动前缀：`mega-medium` → `desktop-mega-medium` / `mobile-mega-medium`。

显式 `?preset=` / `?budget=` **仅作 debug override**，覆盖 lodMode 自动选档。

## URL 参数

- `?lodMode=performance|quality`
- `?lodRuntime=refinement|native`
- `?preset=mega-medium`（debug override）
- `?budget=10`
- `?maxConcurrent=1|2|4|8`（锁定 LOD 下载并发；亦接受 `?concurrent=`；对照用）
- `?bootstrapCoarsenSteps=2`（初始加载视锥内相对 engineOptimal 放粗档数后收条；默认 2；`0` 或 `?bootstrapCoarsen=0` 关）
- `?nearJumpLadder=1|0`（quality 默认开启）
- `?ladder=c,e,b`（跳档覆盖，如 `2,1,3`；b 可为 `target`）
- `?halfDpi`

`lodProfileScheduler=legacy` 已移除；若仍传入会 warn 并忽略。
`refinementPolicy` 已移除；URL / settings 中的该字段忽略。

## Bootstrap / 首帧

Phase 0–2（meta 下载 → 粗层 viewport → unlock 闸门）**refinement 与 native 共用**。

相机触发（unlock 后 `notifyCameraMoved`）相对**上次触发位姿**累计，并带停稳终算：

| 信号 | 规则 |
|------|------|
| 位移 | 累计位移 > `clamp(medianLeafDiag × 0.05, 0.15, 2.0)` |
| 旋转开始 | 累计转角 ≥ **3°** → 进入 `inMotion` 并 notify |
| 旋转继续 | 已在 motion，再累计 ≥ **2°** 才再次 notify |
| zoom | `max(0.04, cameraDistance × 0.08)` 或 FOV Δ > 0.5°（不跟叶尺度） |
| 停稳终算 | `inMotion` 且本帧无 move/rotate/zoom → **强制一次** notify，再清 motion |

`medianLeafExtent`：叶 AABB **空间对角线**中位数；meta 就绪后算一次。`?benchmarkHud` 显示 Leaf med / Move thr。

下限 0.15（相对旧 0.03 更钝）专打 Wuhan 手微抖 / 路径插值 churn。选档距离仍由 `lodBaseDistance` 控制，本阶段不改。

下载 gate：`motionCriticalDownloadsOnly`（默认开）在 `notifyCameraMoved` / camera burst 内仅入队 **criticalLimit**（桌面 8）；burst 结束后再放到 **foregroundLimit**。HUD `pendingNodes` / ready 仍按前景缺文件统计。

实现：`leaf-extent.ts` + `camera-lod-scale-debug.ts` + `bootstrap.ts` + `refinement-controller.ts`。

Phase 4（82%→100% / `firstFrame`）：

- **refinement**：OctreeRefinementController；中央细档上屏 100%（见上文 Streaming 首屏阶段）后收条 / `progressThresholdReached`；边缘后台继续追细档（降优先）
- **native + performance**：粗层 ready 即 `firstFrame`；纯引擎 LOD，unlock 全档 `0..worstLod`
- **native + quality**：同上首屏；prefetch burst；RegionScheduler warm/cold clamp

`firstFrame` 后：refinement 走 JS controller；native quality 侧 prefetch 继续 `ensureFileResource`。

逻辑：`src/loaders/gsplat/lod/octree/bootstrap.ts`。

## lodMode × lodRuntime 矩阵（摘要）

| 换参 | refinement | native |
|------|------------|--------|
| `performance` | 稳 FPS、resident cap 更紧 | **纯引擎**，无 prefetch |
| `quality` | 中心先清、VRAM 更高 | 引擎 LOD + **轻量 prefetch** + 可选 region clamp |

换 `lodRuntime` 不改变 lodMode 档位语义，只切换**执行层**（JS 强控 vs 引擎 LOD；native 下 quality 才启用 viewer prefetch）。

解析优先级：`?lodRuntime=` > `settings.sceneProfile.lodRuntime` > 默认 `refinement`。

## Tunable

| 字段 | 说明 |
|------|------|
| `budget` | splat budget（百万，override）；**refinement** 路径生效；native 路径忽略（`splatBudget=0` 对齐 billions） |
| `lodBaseDistance` | 米制切档基准；settings 显式正数则**覆盖**默认 5，且**默认跳过** scale-align；未写时默认 5 并可被 align 改写 |
| `lodMultiplier` | LOD 档距倍率（默认 **3**）；同上绑定 |
| `lodBehindPenalty` | 相机后方距离惩罚（默认 **5**）；经 `bindGsplatStreamingLodSettings` 写入 `scene.gsplat` |
| `lodScaleAlign` | 默认关；仅 `true` 强制开；`false`/未写均关 |
| `lodScaleQualityFactor` | R95 自适应质量系数（正数）；缺省 **1.4** |
| `lodScaleQuality` | `performance`/`balanced`/`quality` → 1.0/1.4/1.8；可被 `lodScaleQualityFactor` 覆盖 |
| `halfDpi` | 半分辨率渲染 |

## 示例

- downtown：[`settings-downtown-like.json`](../public/assets/settings/settings-downtown-like.json)
- Finland 双 tile benchmark：[`settings-finland-p0-benchmark.json`](../public/assets/settings/settings-finland-p0-benchmark.json)

多 piece 见 [CONTENT_MANIFEST.md](CONTENT_MANIFEST.md)。

## 相关文档

- [LOD策略分析.md](LOD策略分析.md)
- [SCENE_PROFILE_BENCHMARK.md](SCENE_PROFILE_BENCHMARK.md)

## 与旧协议

- `lodProfileScheduler=legacy|profile` 已移除（恒为 profile 调参）
- `nativeOctreeLod` 已移除，统一使用 `lodRuntime`
- `lodSettings` / Custom LOD 已移除
- `refinementPolicy`（aggressive / conservative）已移除；refinement 恒用原 aggressive 调参表
- 曾试验的投影尺寸选档（`lodBaseAngular`）已撤销
- 调度尺度对齐：`lod-scale-align.ts`（R95 + 金字塔反推 d0，`qualityFactor` 默认 1.4；可用 `lodScaleAlign:false` 关闭）
