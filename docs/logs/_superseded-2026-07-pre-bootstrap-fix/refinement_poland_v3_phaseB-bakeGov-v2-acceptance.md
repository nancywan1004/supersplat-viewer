# Phase B 验收（修订版 Bake Governor）— Poland 96k

> 日期：2026-07-15  
> 实现：slot-token `bake-governor.ts` + admit 闸门 + 高压 `lodUpdateDistance` 钳制  
> 录制：`node scripts/chrome-performance-profile.mjs --scene=poland --lodRuntime=refinement --fineLod=1 --profileSuffix=_bakeGov_v2b`

## 产物

| 文件 | 说明 |
|------|------|
| `refinement_poland_v3_finelod_bakeGov_v2b.txt` | 677 帧 |
| `refinement_poland_v3_bakeGov_v2b-buf-buffer-table.md` | bufferUpload 分档 |

## 止损判据（plan）

| 判据 | 结果 |
|------|------|
| 上传帧 `uploaded/total` P50 **> 50%** → 止损开 B-engine | **否**：P50 ≈ **6.0%**，P90 ≈ **19.7%** |
| 慢档是否相对旧 B 可见下降 | 140–200ms **11.2%**（旧 B 14.6% / A2 13.6%） |

→ **不进入 B-engine 止损**；本轮 Viewer Governor 继续保留。

## 对比摘要

| 指标 | 07-13 旧 Phase B | 本版 v2b | 备注 |
|------|------------------|----------|------|
| 上传帧 blocks↑/tot（有效上传帧 P50） | ~98% | **~6%** | 主信号 |
| 慢档 140–200ms | 14.6% | **11.2%** | 改善有限 |
| fullRebuild 推断 | 28% | **0%** | |
| `syncSuppressedPeripheral` max | ≈0 有效 | **446** | 抑制生效 |
| `governorMode` | criticalOnly 主导但未关门 | criticalOnly **241** / full **436** | HUD 可观测 |
| animTrack fpsP50 | — | **11** | |
| blurToClear | 无显著回退目标 | kf 最大约 3.4s | 未做严格 A/B |

## 结论

相对 07-13 失败版：闸门与 token 形态对 **upload 比尖刺** 有实质压低（上传帧 P50 6% / P90 ~20%，低于止损线）。慢档与 gapMs 仍偏高，**未达到**门禁「慢档 <5% / gapMs P90 <40ms」。下一步可调 `slotBudgetFrac` / critical，**不必**立刻做引擎分帧；若后续尖刺回潮再开 B-engine。
