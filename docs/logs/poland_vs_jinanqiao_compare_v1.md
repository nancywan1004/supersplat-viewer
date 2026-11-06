# Poland vs jinanqiao-v3-x10 — post-fix 对照（v1）

> 采集日期：2026-07-15  
> 基准代码：bootstrap `progressUIHidden` 全树轮询短路已合入；**Bake Governor 已移除**。  
> **旧报告一律作废**：见 [`_superseded-2026-07-pre-bootstrap-fix/README.md`](_superseded-2026-07-pre-bootstrap-fix/README.md)。

> **后续定位**（settings 隔离 + 尖峰拆解，根因未定）：见 [`poland_vs_jinanqiao_localize_iso_v1.md`](poland_vs_jinanqiao_localize_iso_v1.md)。

## 协议

| 项 | 值 |
|---|---|
| runner | `scripts/chrome-performance-profile.mjs` |
| lodRuntime | `refinement` |
| fineLod | `0`（标定移动路径，无 animTrack） |
| budget | `2.5` |
| 交互 | `idle_baseline` → `move_5cm` / `1m` / `5m` / `yaw_30deg` / `combo_2m_20deg` |
| Poland settings | `settings-finland-p0-benchmark.json` |
| jinanqiao settings | `settings-jinanqiao.json` |
| profileSuffix | `_postFix_compare_v1` |

原始产物：

- Poland：`refinement_poland_v3_postFix_compare_v1.txt` + `chrome-cpu-profile-refinement-poland_postFix_compare_v1.json`
- jinanqiao：`refinement_jinanqiao-v3-x10_v3_postFix_compare_v1.txt` + `chrome-cpu-profile-refinement-jinanqiao-v3-x10_postFix_compare_v1.json`

## 帧率 / 帧时（跳过前 60 帧热身后）

| 指标 | Poland | jinanqiao-v3-x10 |
|---|---:|---:|
| 有效样本 | 1429 | 1335 |
| fps P50 / mean | **59 / 51.5** | **59 / 52.1** |
| frameMs P50 / P90 / P99 | 16.7 / 17.6 / **83.4** | 16.7 / 33.4 / **50.3** |
| frameMs max | **182.3** | 67.6 |
| 慢档 140–200ms | **2**（全量含热身共 5） | **0** |
| gapMs P50 / P99 / max | 6.0 / 66.3 / **125.7** | 2.6 / 13.9 / 21.0 |
| updateMs P50 / P99 / max | 0.2 / 79.3 / **160.9** | 0.6 / 30.5 / 36.9 |
| jsHeapMb P50 / max | **941 / 1821** | 342 / 429 |
| gsplatsM P50 / max | 0.61 / 1.34 | **1.14 / 1.63** |
| 扫描高峰 leavesEvaluated / visibleLeaves | **2048 / 1834** | 1459 / 1256 |
| drawCalls max | 32 | **48** |

## lod-meta 结构（资产侧）

| 项 | Poland | jinanqiao-v3-x10 |
|---|---:|---:|
| lodLevels | **12** | **9** |
| 总 splats (`count`) | 2.13e8 | **2.94e8** |
| filenames | 2166 | **2791** |
| asset.cellSize 等 | **无**（仅 `generator`） | **无** |

> meta 本身不暴露 cell/grid 尺寸；两侧 LOD 层数不同（12 vs 9），不能从 lod-meta 直接断言「块粒度相同」，运行时应以 scan 峰值 / gsplatsM / drawCalls 为准（见上表）。

## 结论（以本轮为准）

1. **稳态中位帧率已接近**：两侧 fps P50 均为 ~59，frameMs P50 均为 16.7ms。先前「Poland 远慢于 jinanqiao」的对比多半来自 **bootstrap 全树轮询 + Governor 实验路径** 的旧数据，不可再引用。
2. **差距主要在尾部尖峰，不在中位 FPS**：Poland 仍有偶发 140–180ms 慢帧与更高的 update/gap 尾部；jinanqiao 本轮无 140ms+ 慢档，P99 frameMs ~50ms。
3. **不要用「颗粒更细」解释本轮差距**：同协议下 jinanqiao 的 `gsplatsM` 中位/峰值反而更高，drawCalls max 也更高；Poland 更突出的是 **jsHeap 更高**、扫描峰值 `leavesEvaluated` 更大，以及偶发 **大 update/gap 尖峰**（与换档上传相关），不是稳态每帧扫描卡死。
4. **Chrome CPU（本轮）**：Poland 热函数以 HUD `sumAllocationSlots`、引擎 `assignSplatOffsets` / `_diffAlloc` 为主；bootstrap 相关符号仍出现但不再是修复前那种整段录制 41% 主因形态。jinanqiao 录制窗口内 bootstrap 扫描占比仍可见（首屏/闸门阶段更长），但未形成慢档尖峰。

## 后续优化优先级（基于本轮）

1. 压 Poland **偶发换档 upload / update 尖峰**（burst 内多块同时上屏），而非再压稳态 scan。
2. 削减 HUD `sumAllocationSlots` 每帧开销（Poland CPU 采样第二高）。
3. Heap 常驻偏高可作体验加压项，但不是本轮中位 FPS 主因。
