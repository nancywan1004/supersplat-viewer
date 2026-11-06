# Poland Gap 归因 v1 — 订正判读

PlayCanvas stats.frame.updateTime 本轮全为 0，导致 refinement.gapMs 把整段 update 算进残差，不能把 raw gapMs 当成“未知黑洞”。下方 frameResid = frameMs − render − gpu − tick − deferred − engineBake。

| 集合 | n | rawGap P50/P90 | frameResid P50/P90 | bake+write P50/P90 | longtask P90 | A(raw) | B(raw) |
|---|---:|---|---|---|---|---:|---:|
| all | 793 | 19.4/100.5 | 19.1/97.4 | 0/10.2 | 198 | 0 | 120 |
| gapRaw≥40 | 172 | 92/171.3 | 91.1/161.7 | 0/12.8 | 330 | 0 | 120 |
| frame≥140 | 93 | 137.5/190.6 | 136.5/180.7 | 0/10.9 | 400 | 0 | 71 |
| bake≥20 | 8 | 0/5 | 0/0 | 26.7/34.1 | 121 | 0 | 0 |

## 相关性
- rawGap vs bake+write：0.2
- rawGap vs longtask：0.3
- frameResid vs bake+write：0.1

## 结论（订正后）

- 本轮 **没有出现 Mode A**（raw gap≥40 且 bake+write≥30：**0 帧**）。
- 慢帧 bake+write P50 约 **4–5ms**，P90 ~11ms；最大 bakeCpu 仅 **34ms**，且往往落在 **frameMs≈50–70、raw gap≈0** 的帧上。
- **longtask** 与 rawGap 强相关（高 gap 帧 100/172 有 longtask≥50ms），更像主线程其它工作 / GC，不是单独 bake 风暴。
- `worldUpdateMs`/`placementIntegrateMs`/`updateMs` 本轮几乎全 0（stats.updateTime 失效 + world 计时未采到），下一轮应修 profiler 对 updateTime=0 的回退。
- **不宜据此直接开第二阶段 bake 分片**；应先修 update 归因，并用 Chrome CPU profile 看 longtask 栈。
