# Poland Gap 归因实测 v1

> 日期：2026-07-15  
> 命令：`node scripts/chrome-performance-profile.mjs --scene=poland --lodRuntime=refinement --fineLod=1 --profileSuffix=_gapAttr_v1`  
> 样本：793 帧 · animTrack kf-0…9 + calibrated moves

## 产物

| 文件 | 说明 |
|------|------|
| `refinement_poland_v3_finelod_gapAttr_v1.txt` | frameProfile JSON |
| `refinement_poland_v3_finelod_gapAttr_v1-summary.md` | 订正判读 |
| `refinement_poland_v3_finelod_gapAttr_v1-bottleneck.md` | 旧瓶颈脚本 |
| `chrome-cpu-profile-refinement-poland-finelod_gapAttr_v1.json` | CPU profile |

## 关键结论

| 问题 | 结果 |
|------|------|
| Mode A：`gap` 高 && `bakeCpu+write` 高（≥30ms） | **0 帧** |
| Mode B：高 residual 且 bake 不高 | 主导；慢帧 bake+write P50~**4–5ms** / P90~**11ms** |
| bakeCpu 最大 | **34ms**（落在 frame≈67ms、raw gap≈0 的帧，且 needsUploadSlots 可达 2M+） |
| longtask≥50ms ∩ gap≥40ms | **100 / 172** |
| 是否立刻做第二阶段 bake 分片 | **否** |

## 测量caveat（重要）

本轮 `stats.frame.updateTime` **全为 0**，旧 `gapMs` 会把整段 update 算进残差（已修 profiler：`updateTime>0` 才采纳，否则回退墙钟）。`worldUpdateMs` / `placementIntegrateMs` 本轮也始终为 0，需下一轮复核引擎计时是否在 reset 之后被清掉。

## 下一步

1. 硬刷新后 **重跑一轮**（带 update 回退修复）再定 A/B。  
2. 同时用 `chrome-cpu-profile-…json` 看 longtask 栈（更像 GC / 未计时 JS，而非单纯 bake）。  
3. 仅当重跑确认 Mode A 后再上 pending bake 队列。
