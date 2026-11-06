# Phase A 验收报告 — Poland 96k refinement

> 日期：2026-07-13  
> 实现：aggressive tunables 对齐（syncCooldown 4/8、foregroundLimit 32、boostConcurrent 6、burstConcurrent 10）+ burst `burst_lod_switch` cooldown + `fileJustLanded` critical bypass  
> 录制：`node scripts/chrome-performance-profile.mjs --scene=poland --lodRuntime=refinement --fineLod=1 --profileSuffix=_phaseA2`

## 产物

| 文件 | 说明 |
|------|------|
| `refinement_poland_v3_finelod_phaseA2.txt` | frame-profiler 原始样本（1258 帧） |
| `refinement_poland_v3_finelod_phaseA2-bottleneck.md` | 自动归因报告 |
| `refinement_poland_v3_phaseA2-buf-buffer-table.md` | bufferUpload 分档表 |
| `chrome-cpu-profile-refinement-poland-finelod_phaseA2.json` | CDP trace |

## 与 T0 基线对比

**T0**：`refinement_poland_v3.txt` / `refinement_poland_v3-bottleneck.md`（noanim，535 有效帧，2026-07-05）  
**Phase A2**：finelod（animTrack 10 关键帧 + 标定移动 + 键鼠），1257 有效帧

> **读数注意**：Phase A2 含 animTrack 预加载，清晰时 `gsplatsM` 达 **~2.0M**（T0 noanim P50 **~0.97M**），同屏块数与 work buffer 规模更大；`drawCalls` / `uploadedBlocks` 与 T0 **非完全同工况**，慢档占比与 `burst_lod_switch` 仍具参考价值。

| 指标 | T0 | Phase A2 | Δ | 门禁 |
|------|-----|----------|---|------|
| **慢档 140–200ms 占比** | 192/535 = **35.8%** | 171/1257 = **13.6%** | **−22.2 pp** | ✅ 目标 <30% |
| **慢档 gapMs P90** | 143 ms | 132.3 ms | −7.5% | ✅ 下降 |
| **慢档 drawCalls P90** | 65 | 121 | +86% | ❌ 未达标（工况更重） |
| **全帧 drawCalls P90** | 44 | 132 | +200% | ❌ |
| **上传帧 blocks↑/tot P50** | 165251/211295 ≈ **78%** | 250048/252833 ≈ **99%** | 升高 | ❌（finelod 后 totalBlocks≈25 万） |
| **fullRebuild 推断占比** | 190/927 ≈ **20.5%** | 387/1258 ≈ **30.8%** | +10.3 pp | ⚠️ 上升 |
| **burst_lod_switch 命中（全样本）** | **359** | **221** | **−38%** | ✅ 明显下降 |
| **burst_lod_switch（慢档内）** | — | **90** | — | cooldown 生效 |

### animTrack blurToClear（产品 KPI）

T0 无同路径 finelod 对照。本次 animTrack 10 关键帧均无超时：

| KF | blurToClearMs | gsplatsAtClearM |
|----|---------------|-----------------|
| kf-3 | 6073 | 1.00M |
| kf-4 | 3283 | 1.05M |
| kf-6 | 2683 | 1.69M |
| kf-9 | 6075 | 2.03M |

播放段 `fpsP50=12`（animTrack 段含大量等待变清晰，非稳态漫游 fps）。

## 结论

| 维度 | 判定 |
|------|------|
| **sync 节奏 / burst 限流** | ✅ `burst_lod_switch` 全样本 −38%；慢档占比 35.8%→13.6% |
| **gapMs** | ✅ 慢档 P90 略降 |
| **同帧 bake 强度（drawCalls / upload 比）** | ❌ 未改善；finelod 重载后 drawCalls P90 更高 |
| **中心变清** | ⚠️ 无 T0 同路径 blurToClear 基线；本次无 refine 超时 |

**总评：Phase A 部分达标。**

- **通过项**：慢档占比、gapMs、`burst_lod_switch` 次数 — 符合计划「A 单独可能不够，但须可见改善」。
- **未通过项**：`drawCalls` P90、`uploadedBlocks/totalBlocks` — 主因仍是 burst 后同帧多块 bake；限流减少了 sync **次数**，但未限制引擎侧单次 sync 拖入的 interval 数（计划 Phase B Bake Governor 主杠杆）。
- **建议**：按计划进入 **Phase B**；可选补跑 **noanim 同脚本**（`--fineLod=0`）与 T0 严格对齐 drawCalls/upload 比，验证 tunables 在同等 gsplats 规模下的边际效果。

## 复现命令

```bash
npm run develop
node scripts/chrome-performance-profile.mjs --scene=poland --lodRuntime=refinement --fineLod=1 --profileSuffix=_phaseA2
node scripts/analyze-refinement-bottleneck.mjs docs/logs/refinement_poland_v3_finelod_phaseA2.txt
node scripts/analyze-buffer-upload.mjs docs/logs/refinement_poland_v3_finelod_phaseA2.txt -o docs/logs/refinement_poland_v3_phaseA2-buf-buffer-table.md
```
