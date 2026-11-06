# Work Buffer / 上传量统计表

> 源文件 `refinement_poland_v3_finelod_gapAttr_v1.txt` · 样本 **793** 帧
> 场景：`http://localhost:3000/?content=https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/poland/lod-meta.json&settings=/assets/settings/settings-finland-p0-benchmark.json&webgpu&benchmarkHud&frameProfile=1&benchmark&benchmarkAnimTrack&lodRuntime=refinement&budget=2.5`
> 导出：2026-07-15T07:34:01.312Z

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
| allocator used | 0.05 – 2.51 M | 已分配 slot |
| hardCap | 268.44 M | maxTextureSize² |
| textureSize | 1696 | |

## 3. 分档统计（P50 / P90 / max）

| 分档 | 帧数 | 占比 | frameMs | gapMs | uploadMB | drawCalls | gsplatsM | activeM | blocks↑/tot P50 | copy% P50 | bake× P50 | frag P50 | engFULL | infFULL |
|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 全部 | 793 | 100.0% | 66.7 / 165.8 / 916.7 | 19.4 / 101.2 / 905.6 | 0.0 / 0.0 / 88.9 | 2 / 16 / 174 | 1.79 / 2.43 / 2.51 | 1.79 / 2.43 / 2.51 | 0/299408 | 0.0 | 0 | 0.997 | 0 | 1 |
| 慢档 140–200ms | 56 | 7.1% | 183.1 / 200.0 / 200.0 | 119.5 / 142.1 / 157.3 | 0.0 / 5.0 / 14.1 | 20 / 51 / 72 | 2.10 / 2.47 / 2.51 | 2.10 / 2.47 / 2.51 | 61/328246 | 0.0 | 1 | 0.995 | 0 | 0 |
| 快档 40–70ms | 572 | 72.1% | 66.6 / 67.5 / 67.7 | 14.3 / 26.3 / 56.5 | 0.0 / 0.0 / 0.0 | 2 / 3 / 6 | 1.79 / 2.42 / 2.51 | 1.79 / 2.42 / 2.51 | 0/299408 | 0.0 | 0 | 0.998 | 0 | 0 |
| 上传帧 | 124 | 15.6% | 183.1 / 249.3 / 350.5 | 119.5 / 176.4 / 270.6 | 0.1 / 7.4 / 88.9 | 21 / 70 / 174 | 2.01 / 2.47 / 2.51 | 2.01 / 2.47 / 2.51 | 322/314851 | 1.5 | 1 | 0.994 | 0 | 1 |
| fullRebuild（任意） | 1 | 0.1% | 249.9 / 249.9 / 249.9 | 168.4 / 168.4 / 168.4 | 88.9 / 88.9 / 88.9 | 97 / 97 / 97 | 2.05 / 2.05 / 2.05 | 2.05 / 2.05 / 2.05 | 314851/314851 | 113.7 | 1 | 0.000 | 0 | 1 |
| fullRebuild engine | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |
| fullRebuild inferred | 1 | 0.1% | 249.9 / 249.9 / 249.9 | 168.4 / 168.4 / 168.4 | 88.9 / 88.9 / 88.9 | 97 / 97 / 97 | 2.05 / 2.05 / 2.05 | 2.05 / 2.05 / 2.05 | 314851/314851 | 113.7 | 1 | 0.000 | 0 | 1 |

列说明：数值列除帧数/占比外均为 **P50 / P90 / max**；`blocks↑/tot P50` = uniqueUploadBlocks / totalBlocks；`uploadMB` = slot写入次数×40B。
## 4. 上传量分布（uploadMbEst）

| 桶 | 帧数 | 占比 | frameMs P50 | gapMs P50 |
|---|---:|---:|---:|---:|
| 0（无上传） | 680 | 85.8% | 66.6 | 16.3 |
| 0–5 MB | 98 | 12.4% | 182.5 | 116.6 |
| 5–20 MB | 14 | 1.8% | 184.3 | 119.9 |
| ≥60 MB | 1 | 0.1% | 249.9 | 168.4 |
