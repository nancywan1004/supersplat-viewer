# Phase B 验收报告 — Poland 96k Bake Governor

> 日期：2026-07-13  
> 实现：`bake-governor.ts` + sync/下载门控 + HUD 指标  
> 录制：`node scripts/chrome-performance-profile.mjs --scene=poland --lodRuntime=refinement --fineLod=1 --profileSuffix=_phaseB`

## 产物

| 文件 | 说明 |
|------|------|
| `refinement_poland_v3_finelod_phaseB.txt` | 1330 帧 |
| `refinement_poland_v3_finelod_phaseB-bottleneck.md` | 自动归因 |
| `refinement_poland_v3_phaseB-buf-buffer-table.md` | bufferUpload 分档 |

## 三方对比（T0 / Phase A2 / Phase B）

| 指标 | T0 (noanim) | Phase A2 | Phase B | B 门禁 |
|------|-------------|----------|---------|--------|
| **慢档 140–200ms 占比** | **35.8%** | **13.6%** | **14.6%** (194/1329) | ❌ 目标 **<5%** |
| **慢档 gapMs P90** | 143 ms | 132 ms | **129 ms** | ❌ 目标 **<40ms** |
| **慢档 drawCalls P90** | 65 | 121 | **120** | ❌ 目标 **≤12** |
| **全帧 drawCalls P90** | 44 | 132 | **120** | ❌ |
| **上传帧 blocks↑/tot P50** | ~78% | ~99% | **~98%** (240k/245k) | ❌ 目标 **≤15–20%** |
| **fullRebuild 推断占比** | 20.5% | 30.8% | **28.0%** | ❌ 应下降 |
| **burst_lod_switch（全样本）** | 359 | 221 | **368** | ❌ 相对 A2 **回升** |
| **burst_lod_switch（慢档内）** | — | 90 | **163** | ❌ |

### Governor HUD（Phase B 新增）

| 指标 | 观测 |
|------|------|
| `governorMode` | 多数 tick 为 `allowCriticalOnly`（压力传感器生效） |
| `bakeDebtNodes` | burst 期间可达 **696**（债务队列有数据） |
| `syncSuppressedPeripheral` | 全样本仅 **~18 tick >0**（抑制过少） |
| `criticalBypassCount` | **~19 tick** |

### animTrack blurToClear（相对 Phase A2）

| KF | A2 (ms) | B (ms) | Δ |
|----|---------|--------|---|
| kf-3 | 6073 | 6163 | +1.5% |
| kf-4 | 3283 | 3284 | ≈0 |
| kf-6 | 2683 | 1912 | **−29%** ✅ |
| kf-9 | 6075 | 2491 | **−59%** ✅ |

中心变清无显著回退（部分关键帧更快），满足 blurToClear 门禁。

## 结论：**Phase B 未通过主门禁**

### 有效部分

- 压力传感器闭环运行：`allowCriticalOnly` 在高压帧占主导
- `bakeDebtNodes` 在 burst 期间有合理非零值
- blurToClear 未相对 A2 回退

### 未达标 / 回退

- **慢档占比、gapMs、drawCalls、upload 比**：均未达 B 主验收目标
- **`burst_lod_switch` 相对 A2 回升**（221→368），governor 未减少 sync 次数反而增多
- **`syncSuppressedPeripheral` 几乎为 0**：外围抑制逻辑未真正挡住 sync

### 根因分析（待迭代）

1. **`allowCriticalOnly` 下 `criticalDebtCount > 0` 即放行 sync** — 视口中心叶多，`critical` 阈值（`nearJumpEdgeMin=0.65`）过宽，几乎每帧都满足放行
2. **引擎全 instance sync** — 即使债务预算 `releaseCount≤24`，一次 `syncOctreePendingPlacements` 仍 reconcile 全部 interval；`drawCalls` P90 仍在 120 量级
3. **`file_landed` / `frame_ready_loading_drop` bypass** — 与 governor 叠加后 sync 路径仍偏多（`frame_ready_loading_drop` 85 次 vs A2 116 次，burst 368 vs 221）
4. **首帧无压力样本** — 冷启动阶段 `allowFull`，animTrack 预加载期可能已积累大量债务

### 建议下一步（留在 Phase B 迭代）

1. **收紧 critical 判定**：`critical` 需同时满足 `edgeFactor ≥ nearJumpEdgeMin` **且** 在 `criticalBatch` 文件集内，或提高 edge 阈值
2. **`allowCriticalOnly` 下仍应用 release 预算**：`criticalDebtCount > 0` 不等于每帧 sync；仅 `releaseCount > 0` 或 `fileJustLanded` 时 sync
3. **计划 v1.1**：仅当本帧 `releases.length > 0` 时调用 sync（否则父档继续显示）
4. **调参**：`gapMsHold`/`uploadRatioHold` 可略降，使 budgeted 模式更早介入

**禁止在未达标时进入 Phase C。**

## 复现命令

```bash
npm run develop
node scripts/chrome-performance-profile.mjs --scene=poland --lodRuntime=refinement --fineLod=1 --profileSuffix=_phaseB
node scripts/analyze-refinement-bottleneck.mjs docs/logs/refinement_poland_v3_finelod_phaseB.txt
node scripts/analyze-buffer-upload.mjs docs/logs/refinement_poland_v3_finelod_phaseB.txt -o docs/logs/refinement_poland_v3_phaseB-buf-buffer-table.md
```
