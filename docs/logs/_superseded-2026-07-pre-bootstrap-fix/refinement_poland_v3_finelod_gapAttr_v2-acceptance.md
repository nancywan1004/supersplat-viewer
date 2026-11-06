# Poland Gap 归因实测 v2

> 日期：2026-07-15  
> 命令：`node scripts/chrome-performance-profile.mjs --scene=poland --lodRuntime=refinement --fineLod=1 --profileSuffix=_gapAttr_v2`  
> 相对 v1：已修 `updateTime===0` → 回退墙钟；本轮 `updateMs=0` 帧为 **0/711**

## 产物

| 文件 | 说明 |
|------|------|
| `refinement_poland_v3_finelod_gapAttr_v2.txt` | 711 帧 |
| `refinement_poland_v3_finelod_gapAttr_v2-summary.md` | 判读表 |
| `chrome-cpu-profile-refinement-poland-finelod_gapAttr_v2.json` | CPU profile |

## vs v1

| | v1（夸大 gap） | v2（本轮） |
|--|----------------|------------|
| updateMs=0 | 全员 | **0** |
| gap P50（全帧） | 19.4 | **0** |
| gap≥40 帧 | 172 | **103** |
| Mode A（gap≥40 ∩ bake+write≥30） | 0 | **0** |
| Mode B（gap≥40 ∩ bake&lt;10） | 69.8% | **88.3%** |

## 结论

**仍是 Mode B，暂不升第二阶段 bake 分片。**

- 最重 bake（`bake+write` ~30–40ms、slots 可达 2M+）落在 **updateMs 高、gap≈0** 的帧上，已被 update 计入口径吸收。
- 真正高 gap 帧：`bakeCpu/write` 近 0，常伴 **longtask**（高 gap 103 帧里 61 帧 longtask≥50ms）。
- `worldUpdateMs` / `placementIntegrateMs` 仍全 0（引擎侧计时/采样时序问题，不影响本轮 A/B 判别：bakeCpu/write 有效）。

## 建议

1. ~~用 v2 CPU profile 看 longtask 栈~~ → 已查清：首屏后 bootstrap 全树轮询。见 [refinement_poland_v3_finelod_gapAttr_v2-cpu-stacks.md](refinement_poland_v3_finelod_gapAttr_v2-cpu-stacks.md)。  
2. 硬刷新后跑 `_gapAttr_v3` 复验短路修复。  
3. 不要为「降 gapMs」优先做 pending bake 队列。
