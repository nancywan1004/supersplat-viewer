# Work Buffer / 上传量统计表

> 源文件 `refinement_poland_v3_finelod_bakeGov_v2.txt` · 样本 **740** 帧
> 场景：`http://localhost:3000/?content=https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/poland/lod-meta.json&settings=/assets/settings/settings-finland-p0-benchmark.json&webgpu&benchmarkHud&frameProfile=1&benchmark&benchmarkAnimTrack&lodRuntime=refinement&budget=2.5`
> 导出：2026-07-15T06:49:27.572Z

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
| 全部 | 740 | 100.0% | 66.7 / 182.4 / 883.3 | 18.2 / 117.9 / 874.4 | 0.0 / 0.0 / 70.4 | 2 / 16 / 172 | 2.18 / 2.49 / 2.50 | 2.18 / 2.49 / 2.50 | 0/319940 | 0.0 | 0 | 0.997 | 0 | 2 |
| 慢档 140–200ms | 62 | 8.4% | 167.7 / 184.2 / 200.0 | 111.7 / 139.5 / 145.8 | 0.0 / 5.4 / 15.7 | 16 / 47 / 82 | 2.35 / 2.49 / 2.50 | 2.35 / 2.49 / 2.50 | 26/327891 | 0.0 | 1 | 0.997 | 0 | 0 |
| 快档 40–70ms | 562 | 75.9% | 66.0 / 67.3 / 67.8 | 12.8 / 27.6 / 56.7 | 0.0 / 0.0 / 0.0 | 2 / 3 / 5 | 1.91 / 2.49 / 2.50 | 1.91 / 2.49 / 2.50 | 0/319488 | 0.0 | 0 | 0.997 | 0 | 0 |
| 上传帧 | 123 | 16.6% | 183.3 / 250.1 / 316.7 | 126.5 / 185.4 / 266.3 | 0.0 / 5.4 / 70.4 | 20 / 80 / 172 | 2.34 / 2.50 / 2.50 | 2.34 / 2.50 / 2.50 | 25/323709 | 1.0 | 1 | 0.997 | 0 | 2 |
| fullRebuild（任意） | 2 | 0.3% | 250.7 / 250.7 / 250.7 | 200.7 / 200.7 / 200.7 | 70.4 / 70.4 / 70.4 | 82 / 82 / 82 | 1.66 / 1.66 / 1.66 | 1.66 / 1.66 / 1.66 | 291562/291562 | 121.4 | 1 | 0.000 | 0 | 2 |
| fullRebuild engine | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |
| fullRebuild inferred | 2 | 0.3% | 250.7 / 250.7 / 250.7 | 200.7 / 200.7 / 200.7 | 70.4 / 70.4 / 70.4 | 82 / 82 / 82 | 1.66 / 1.66 / 1.66 | 1.66 / 1.66 / 1.66 | 291562/291562 | 121.4 | 1 | 0.000 | 0 | 2 |

列说明：数值列除帧数/占比外均为 **P50 / P90 / max**；`blocks↑/tot P50` = uniqueUploadBlocks / totalBlocks；`uploadMB` = slot写入次数×40B。
## 4. 上传量分布（uploadMbEst）

| 桶 | 帧数 | 占比 | frameMs P50 | gapMs P50 |
|---|---:|---:|---:|---:|
| 0（无上传） | 631 | 85.3% | 66.6 | 15.2 |
| 0–5 MB | 95 | 12.8% | 183.3 | 125.4 |
| 5–20 MB | 12 | 1.6% | 183.2 | 139.5 |
| ≥60 MB | 2 | 0.3% | 250.7 | 200.7 |
