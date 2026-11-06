# Poland vs jinanqiao 流畅差异 — 定位实验（iso v1）

> 日期：2026-07-15  
> 目的：**先定位、不下最终根因结论**。分离 settings 与 content，并对 Poland ≥100ms 尖峰做 `gapAttribution` / `bufferUpload` 拆解。

## 实验设计

| 轴 | 取值 |
|---|---|
| lodRuntime | `refinement` |
| fineLod | `0`（标定轨迹相同） |
| budget | `2.5` |
| settings | **A** `settings-finland-p0-benchmark.json` / **B** `settings-jinanqiao.json` |
| content | poland / jinanqiao-v3-x10 |
| 矩阵 | 2×2（同 settings 只换 content） |

runner 增加 `--settings=` 覆盖（`scripts/chrome-performance-profile.mjs`）。

产物后缀：`_isoFin_v1` / `_isoJin_v1`。

## 步骤 1：settings 是否导致体感差？

| content | settings | fps P50 | frame p50 / p99 / max | ≥100ms 帧数 | update max | gap max | heap p50 |
|---|---|---:|---:|---:|---:|---:|---:|
| poland | finland | 60 | 16.7 / 116.6 / **184** | **19** | 159 | 142 | 925 |
| jinan | finland | 60 | 16.7 / 50 / 67 | **0** | 38 | 35 | 283 |
| poland | jinanqiao | 59 | 16.7 / 100 / **183** | **15** | 161 | 160 | 819 |
| jinan | jinanqiao | 60 | 16.7 / 50.9 / 67 | **0** | 39 | 17 | 356 |

**可下结论（步骤 1）**

- **可排除**：流畅差异**不是**由 finland vs jinanqiao settings 引起。换 settings 后，Poland 尖峰仍在，jinan 仍无 ≥100ms。
- **可收窄**：差异随 **content（Poland 资产/其运行态）** 走，不随 settings 走。

仍**不能**说「已知根因」——只证明是 content 侧问题域。

## 步骤 2：Poland 尖峰帧在计什么？

对 isoFin Poland 的 ≥100ms 帧粗分（基于已有 `gapAttribution` + `bufferUpload`，非单帧 Chrome 对齐）：

| 类 | 定义（操作化） | 约计数 (isoFin) | 含义 |
|---|---|---:|---|
| **A** | `fullRebuild` 或 `copyPct≥99` | 3 | 整缓冲/大比例上传可见 |
| **B** | `gap` 高且 `bake+write` 低（&lt;20ms） | **11** | **计时器解释不了的主线程残留** |
| **C** | 主要为高 `updateMs` | 5 | update 路径重，但不一定是已计入的 bake |

代表帧（isoFin）：

- **A**：`fullRebuild=true`，`uploadedBlocks≈122933≈totalBlocks`，`copy=100`，`gap≈130–140`，但 `bakeCpuMs` 常只有数 ms～十余 ms → 墙钟在 copy/其它，不完全等于 bakeCpu。
- **B/C**：`needsUploadBlocks` 可到数万，`uploadedBlocks=0`，`bake≈8`，`update` 40–60+，`gap` 仍可几十 ms → **不能把尖峰简单归因成「bake 太慢」**。

isoJin Poland 同类现象复现（尖峰仍在，分类结构类似）。

## 强相关运行态差异（仍属相关，待证因果）

同为 finland settings时：

| 指标 | Poland | jinan |
|---|---:|---:|
| `bufferUpload.totalBlocks` P50 | **~122908** | **~27158**（约 **4.5×**） |
| `totalBlocks` max | ~247530 | ~30134 |
| `activeSplatSlots` P50 | ~0.57M | **~1.10M**（jinan 反而更高） |
| `fullRebuild` 帧数（整段） | 8 | 2 |

解读边界：

- 运行时 **MemBlock 数量** Poland 显著更多；同时 jinan **每帧活跃 slot 更多**。  
  → 体感差**不像**「jinan 画得少」，更像 **Poland 的 block 组织/更新面更碎或更大**。
- 这与用户所说「制作侧块粒度相同」**不冲突也不等价**：制作粒度 ≠ 运行时 `totalBlocks`。此处只报告运行时事实。
- **相关 ≠ 根因**：尚未做「人为限制 Poland totalBlocks / 禁止 fullRebuild」等反证实验。

## 步骤 2b：fullRebuild / copy≈100% 是主要卡顿原因吗？

**结论：不是（相对热身后的可感尖峰）。**

对 `isoFin` Poland，把「`frameMs≥100` 尖峰帧」与「真正背负 update 成本的帧」拆开：

| 口径 | 发现 |
|---|---|
| 热身后尖峰里，严格 `fullRebuild` 或大比例 `uploaded≈totalBlocks` | **极少** |
| 这些尖峰的 **前一帧** | **15/15** 都有 `updateMs≥80` 且 `frameMs≈16` 的「隐藏重帧」 |
| 隐藏重帧里 `fullRebuild` | **约 1/22**；绝大多数 `bakeCpuMs<20`，当帧 uploaded 常为 0 |
| jinan 同协议隐藏重帧 | **0** |

含义：

1. 长 `frameMs` 常是 **前一帧天价 `updateTime` 的跨帧表现**（`frame.ms` 与 `updateTime` 量纲经常不对齐）。  
2. **不能**把尖峰帧上的 fullRebuild/copy100 当主因。  
3. 隐藏重帧上 refinement tick 仅 **1–3ms**，但常 `needsLodSwitch`；Chrome 窗口成本在 `evaluateNodeLods` / `applyLodChanges` / `assignSplatOffsets` / `_diffAlloc` 等，`writeBuffer` 很小。

## 步骤 2c：弱反证 — `refinementPolicy=conservative`

同 finland settings + 标定轨迹（`_isoFin_conservative_v1`）：

| 指标 | aggressive (isoFin) | conservative |
|---|---:|---:|
| `frameMs≥100` | 19 | 24 |
| 隐藏重帧 | 26 | 25 |
| `update` max | 159 | 167 |

**尖峰未消失** → 「只是 aggressive burst」权重下降。jinan 的 needsLod **更频繁**，但 `update` max 仅 ~38。

## 步骤 2d：反证 — 关 sync / 冻结 lodUpdateDistance

定位开关（**非产品默认**）：

- `?lodSync=0`：refinement `trackSyncOctreePendingPlacements` 直接 return 0  
- `?freezeLodDist=1`：burst/boost **不把** `gsplatScene.lodUpdateDistance` 压成 `burstUpdateDistance`（通常为 0）

同 finland settings + 标定轨迹：

| 条件 | `frameMs≥100` | 隐藏重帧 | synced 帧 | fullRebuild 帧 | updMax |
|---|---:|---:|---:|---:|---:|
| baseline (isoFin) | 19 | 26 | 164 | 8 | 159 |
| **lodSync=0** | **45** | **45** | **0** | 24 | 164 |
| **freezeLodDist=1** | **6** | **12** | 257 | **1** | 158 |
| freeze + lodSync=0 | 24 | 24 | 0 | 2 | 170 |
| jinan baseline | 0 | 0 | 363 | 2 | 38 |

中后段（再跳过约 10s）同趋势：baseline 隐藏 22 → freeze 12；lodSync0 仍升高。

**解读（定位，非定论优化）**

1. **关我们的 placement sync 不能消尖峰，反而更糟** → 「主因 = refinement `requestOctreePlacementUpdate`」**已证伪**。引擎侧仍可 `fullRebuild` / 高 update。  
2. **冻结 `lodUpdateDistance`（避免 burst 压到 0）明显减轻但仍不归零** → burst 期间 `lodUpdateDistance=0` 是 **重要放大器**，不是唯一根因。  
3. freeze 后仍有隐藏重帧，且常伴随 `needsLodSwitch` / 偶发我们的 sync → 剩余成本仍在 **原生/换档 apply 路径**（与 Poland 更高 `totalBlocks` 的假说仍相容，未单独证伪）。  
4. 尚不能说「改成 freezeLodDist 即可上线」：这是归因探针，质量/清晰度延迟未在本轮验收。

## 步骤 2e：反证 — 关 burst 窗口（`noBurst=1`）+ 对照 jinan+freeze

新增 `?noBurst=1`：`notifyCameraMoved` **不再延长** `cameraBurstFrames`（unlock 初始 burst 仍可能存在，标定段实测 burstMax=0）。

| 条件 | spike≥100 | 隐藏重帧 | updMax | totalBlocks P50 | burstMax |
|---|---:|---:|---:|---:|---:|
| pol baseline | 15 | 22 | 159 | 194k | 35 |
| pol **freezeLodDist** | **6** | **12** | 158 | 199k | 35 |
| pol freeze + **noBurst** | **102** | **39** | 170 | 208k | **0** |
| jinan baseline | 0 | 0 | 31 | 29k | 35 |
| jinan **freezeLodDist** | **0** | **0** | **32** | **31k** | 35 |

**解读**

1. **关 burst 比 baseline 更糟** → burst 窗口本身在帮「节奏化」换档/下载；**不是**应整体关掉 burst。  
2. 与 2d 合读：**真正放大器是 burst 内把 `lodUpdateDistance→0`**，不是 burst 存在本身。产品向探针应是「保留 burst、别压距为 0」，而非 `noBurst`。  
3. jinan 在同样 `freezeLodDist=1` 下仍 **0 尖峰** → 差距仍绑定 **Poland 运行态**（`totalBlocks` 地板 ~122k→200k+ vs jinan ~29k），不是 freeze 开关能否泛化到 jinan 的问题。  
4. freeze 后剩余重帧（Chrome 窗口）：仍见 `assignSplatOffsets` / `_diffAlloc` / `writeBuffer`，且常伴随 `needsUploadBlocks` 上万；首帧 `fullRebuild` 在 move_5m 后仍可出现一次。

## 步骤 2f：产品向探针 — `burstUpdateDistance=0.15`（保留 burst，不压到 0）

URL `?burstUpdateDistance=0.15` 覆盖 tunables 的 burst 距离（默 aggressive 为 **0**）。

中后段对比：

| 条件 | spike≥100 | 隐藏重帧 | updMax |
|---|---:|---:|---:|
| baseline | 15 | 22 | 159 |
| freezeLodDist（≈全程 32） | **6** | **12** | 158 |
| burstUpdateDistance=0.15 | 15 | 17 | **146** |

**解读**：0.15 仅略降 `updMax` / 隐藏重帧，**尖峰数不变**。`burstUpdateDistance=32` 单独跑 **未复现 freeze 收益**（spike 20）——freeze 在 **整个 boost 段** 都保持 ~32，而不只是 burst 子窗口。

## 步骤 2g：Poland `totalBlocks` 地板为何 ~12 万？

`totalBlocks` = 引擎 work-buffer 的 **MemBlock 槽位数**（`world.bufferCopyTotal`）。

同 finland settings 稳态：

| | Poland | jinan |
|---|---:|---:|
| `totalBlocks` P50 | **122,908** | **27,158** |
| `activeSplatSlots` P50 | 566,978 | **1,103,420** |
| **splats / block** P50 | **~4.9** | **~41.8** |

jinan 活跃 splat 更多，但 **每块装更多 splat**；Poland MemBlock **碎 ~8×**。首屏后 idx≈38 即稳在 ~122,908，属 **运行时切块**，与更多 LOD instance/placement 相容。尚未有直接「合并块」反证。

## 当前定位状态（更新）

| 命题 | 状态 |
|---|---|
| Poland 高 `totalBlocks` = 更碎 MemBlock（~4.9 vs ~41.8 splats/block） | **高置信** |
| 尖峰主因 = placement sync | **已证伪** |
| 放大器 = burst 内 lodUpdateDistance→0 | **部分证实** |
| burst 窗口本身有害 | **已证伪** |
| 产品向：burst 保留、boost 段避免压零 | **方向成立** |

## 步骤 2h：为什么 Poland ≈5 splats/block，jinan ≈42？

**结论（机制）**：运行时每个 MemBlock ≈ **一个 octree leaf 当前上屏的那一档 LOD interval**（`allocationMap` 一行）。  
~~5~~ / ~~42~~ **不是引擎随便切块**，而是两边 **资产 leaf 切片大小** 直接映到 MemBlock.size。

### 资产 lod-meta 实测（2026-07-15）

| | Poland | jinanqiao-v3-x10 |
|---|---:|---:|
| 八叉树节点 | 725,749 | 161,191 |
| **leaf 数** | **362,875** | **80,596**（约 1/4.5） |
| LOD 层数 | 12 | 9 |
| 最粗档有 lods 的 leaf 数 | **45,480**（=lod11） | **22,476**（=lod8） |
| 运行时首帧 `totalBlocks` | **45,480** | **22,476** |

首帧 `totalBlocks` **精确等于**最粗档 leaf 数 → 印证「一块 = 一个上屏 interval」。

各档 leaf.`count`（每 leaf 该档 splat 数）分布：

| 档 | Poland mean / p50 | jinan mean / p50 |
|---|---:|---:|
| lod0（最细） | 293 / 114 | **3666 / 560** |
| lod5 | 9.3 / 5 | **44 / 8** |
| lod6 | **5.0 / 3** | 20 / 5 |
| 最粗 | ~1.1 / 1 | ~5.1 / 2 |

运行时稳态：

| | Poland | jinan |
|---|---:|---:|
| `totalBlocks` P50 | ~122,908 | ~27,158 |
| `activeSplatSlots` P50 | ~567k | ~1.10M |
| **slots/block ≈** | **~4.9** | **~41.8** |

与上表对照：Poland 稳态对应 **偏中粗档**（lod5–6 一带 mean≈5–9）；jinan 稳态对应 **lod5 一带 mean≈44**。  
jinan 活跃点更多，但 **leaf 更少、每 leaf 切片更大** → MemBlock 更「肥」。

### 用人话

Poland 包资产时 **空间 leaf 切得很碎**（36 万叶子、12 层 LOD），很多 leaf 在常用档上只有几个 splat。引擎按 interval 建 MemBlock，所以平均就剩 ~5。  
jinan leaf 粗得多（8 万叶子、每 leaf 几百～几千点），同样「一块一 interval」平均就到 ~40+。

**要改 5→更接近 42**：改的是 **splat-transform / lod-chunk 资产粒度**（更大 `--lod-chunk-count` 一类），不是 viewer 里再人为「合并 MemBlock」这么简单（viewer 只是消费 interval）。
