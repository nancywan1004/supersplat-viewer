# Work Buffer / 上传量统计表

> 源文件 `refinement_poland_v3_finelod_bakeGov_v2b.txt` · 样本 **677** 帧
> 场景：`http://localhost:3000/?content=https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/poland/lod-meta.json&settings=/assets/settings/settings-finland-p0-benchmark.json&webgpu&benchmarkHud&frameProfile=1&benchmark&benchmarkAnimTrack&lodRuntime=refinement&budget=2.5`
> 导出：2026-07-15T06:54:05.104Z

## 1. 存储分层（CPU / GPU 是不是一套？）

| 层 | 物理位置 | 作用 | Benchmark 里看哪项 |
|---|---|---|---|
| SOG / RAD Resource | CPU 堆 | 解码源数据 | jsHeapMb |
| Work Buffer | GPU VRAM | unified splat 纹理 | vramTexMb / activeSplatSlots |
| Bake Staging | CPU 临时 | writeBuffer 前 staging | gapMs |
| Compaction/Sort | GPU VRAM | 可见索引/排序 | gpu.totalMs |

**结论**：Work Buffer **只有 GPU 侧一份持久纹理**；CPU bake 读 Resource → staging → `writeBuffer`。**不是 CPU/GPU 各存一套 work buffer**。jsHeap 主要是 **SOG Resource + pin 文件**，与 work buffer **不是同一块内存**。

## 2. Work Buffer 容量

| 项 | 值 | 说明 |
|---|---:|---|
| splatBudget | 2.50 M | 软预算 |
| allocator capacity | 2.88 – 2.88 M | 未 grow |
| allocator used | 0.05 – 2.50 M | 已分配 slot |
| hardCap | 268.44 M | maxTextureSize² |
| textureSize | 1696 | |

## 3. 分档统计（P50 / P90 / max）

| 分档 | 帧数 | 占比 | frameMs | gapMs | uploadMB | drawCalls | gsplatsM | activeM | blocks↑/tot P50 | copy% P50 | bake× P50 | frag P50 | engFULL | infFULL |
|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 全部 | 677 | 100.0% | 66.9 / 182.9 / 866.6 | 21.0 / 112.6 / 855.5 | 0.0 / 0.0 / 16.2 | 2 / 18 / 155 | 1.73 / 2.30 / 2.50 | 1.73 / 2.30 / 2.50 | 0/295623 | 0.0 | 0 | 0.998 | 0 | 0 |
| 慢档 140–200ms | 76 | 11.2% | 182.5 / 199.2 / 200.0 | 111.7 / 137.1 / 153.8 | 0.0 / 4.5 / 15.1 | 15 / 51 / 66 | 1.86 / 2.43 / 2.50 | 1.86 / 2.43 / 2.50 | 61/312023 | 0.0 | 1 | 0.998 | 0 | 0 |
| 快档 40–70ms | 436 | 64.4% | 66.6 / 67.4 / 67.7 | 15.6 / 23.9 / 57.4 | 0.0 / 0.0 / 0.0 | 2 / 3 / 6 | 1.44 / 2.29 / 2.48 | 1.44 / 2.27 / 2.50 | 0/251696 | 0.0 | 0 | 0.998 | 0 | 0 |
| 上传帧 | 130 | 19.2% | 182.9 / 250.1 / 300.0 | 112.6 / 186.7 / 230.5 | 0.0 / 4.5 / 16.2 | 19 / 62 / 155 | 1.83 / 2.43 / 2.50 | 1.83 / 2.43 / 2.50 | 61/308347 | 1.4 | 1 | 0.998 | 0 | 0 |
| fullRebuild（任意） | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |
| fullRebuild engine | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |
| fullRebuild inferred | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |

列说明：数值列除帧数/占比外均为 **P50 / P90 / max**；`blocks↑/tot P50` = uniqueUploadBlocks / totalBlocks；`uploadMB` = slot写入次数×40B。
## 4. 上传量分布（uploadMbEst）

| 桶 | 帧数 | 占比 | frameMs P50 | gapMs P50 |
|---|---:|---:|---:|---:|
| 0（无上传） | 553 | 81.7% | 66.7 | 18.7 |
| 0–5 MB | 112 | 16.5% | 183.1 | 113.1 |
| 5–20 MB | 12 | 1.8% | 167.7 | 108.3 |
