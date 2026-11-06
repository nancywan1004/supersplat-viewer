# Work Buffer / 上传量统计表

> 源文件 `refinement_poland_v3_buf.txt` · 样本 **927** 帧
> 场景：`http://localhost:3000/?content=https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/poland/lod-meta.json&settings=/assets/settings/settings-finland-p0-benchmark.json&webgpu&benchmarkHud&budget=2.5&frameProfile=1&noanim`
> 导出：2026-07-08T07:24:46.132Z

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
| allocator used | 0.05 – 2.16 M | 已分配 slot |
| hardCap | 268.44 M | maxTextureSize² |
| textureSize | 1696 | |

## 3. 分档统计（P50 / P90 / max）

| 分档 | 帧数 | 占比 | frameMs | gapMs | uploadMB | drawCalls | gsplatsM | activeM | blocks↑/tot P50 | copy% P50 | bake× P50 | frag P50 | engFULL | infFULL |
|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 全部 | 927 | 100.0% | 65.8 / 225.0 / 391.7 | 19.7 / 148.1 / 308.4 | 0.0 / 38.8 / 81.3 | 2 / 59 / 183 | 0.49 / 2.01 / 2.13 | 0.49 / 2.01 / 2.16 | 0/112584 | 0.0 | — | 0.966 | 0 | 190 |
| 慢档 140–200ms | 77 | 8.3% | 159.2 / 199.4 / 200.0 | 107.6 / 135.6 / 161.2 | 0.0 / 18.8 / 42.5 | 2 / 15 / 48 | 0.49 / 0.49 / 2.09 | 0.49 / 0.49 / 2.09 | 0/112584 | 0.0 | — | 0.966 | 0 | 32 |
| 快档 40–70ms | 639 | 68.9% | 58.4 / 66.7 / 69.9 | 15.7 / 23.1 / 32.1 | 0.0 / 0.0 / 81.3 | 2 / 2 / 4 | 0.49 / 2.02 / 2.13 | 0.49 / 2.02 / 2.16 | 0/112584 | 0.0 | — | 0.966 | 0 | 13 |
| 上传帧 | 231 | 24.9% | 216.6 / 250.1 / 391.7 | 138.7 / 166.6 / 308.4 | 26.2 / 67.1 / 81.3 | 24 / 136 / 183 | 1.11 / 1.97 / 2.13 | 1.11 / 1.99 / 2.16 | 165251/211295 | 100.0 | — | 0.967 | 0 | 190 |
| fullRebuild（任意） | 190 | 20.5% | 221.7 / 258.3 / 391.7 | 139.7 / 164.4 / 308.4 | 38.4 / 67.3 / 81.3 | 39 / 136 / 183 | 0.99 / 1.76 / 2.13 | 1.01 / 1.77 / 2.13 | 190205/189716 | 100.0 | — | 0.967 | 0 | 190 |
| fullRebuild engine | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |
| fullRebuild inferred | 190 | 20.5% | 221.7 / 258.3 / 391.7 | 139.7 / 164.4 / 308.4 | 38.4 / 67.3 / 81.3 | 39 / 136 / 183 | 0.99 / 1.76 / 2.13 | 1.01 / 1.77 / 2.13 | 190205/189716 | 100.0 | — | 0.967 | 0 | 190 |

列说明：数值列除帧数/占比外均为 **P50 / P90 / max**；`blocks↑/tot P50` = uniqueUploadBlocks / totalBlocks；`uploadMB` = slot写入次数×40B。
## 4. 上传量分布（uploadMbEst）

| 桶 | 帧数 | 占比 | frameMs P50 | gapMs P50 |
|---|---:|---:|---:|---:|
| 0（无上传） | 713 | 76.9% | 58.5 | 17.8 |
| 0–5 MB | 28 | 3.0% | 66.7 | 5.1 |
| 5–20 MB | 67 | 7.2% | 191.7 | 124.6 |
| 20–40 MB | 31 | 3.3% | 216.5 | 141.3 |
| 40–60 MB | 27 | 2.9% | 216.6 | 137.5 |
| ≥60 MB | 61 | 6.6% | 225.1 | 142.2 |
