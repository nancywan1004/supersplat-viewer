# Work Buffer / 上传量统计表

> 源文件 `refinement_poland_v3_finelod_phaseA2.txt` · 样本 **1258** 帧
> 场景：`http://localhost:3000/?content=https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/poland/lod-meta.json&settings=/assets/settings/settings-finland-p0-benchmark.json&webgpu&benchmarkHud&frameProfile=1&benchmark&benchmarkAnimTrack&lodRuntime=refinement&budget=2.5`
> 导出：2026-07-13T07:15:19.125Z

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
| allocator used | 0.05 – 2.22 M | 已分配 slot |
| hardCap | 268.44 M | maxTextureSize² |
| textureSize | 1696 | |

## 3. 分档统计（P50 / P90 / max）

| 分档 | 帧数 | 占比 | frameMs | gapMs | uploadMB | drawCalls | gsplatsM | activeM | blocks↑/tot P50 | copy% P50 | bake× P50 | frag P50 | engFULL | infFULL |
|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 全部 | 1258 | 100.0% | 58.7 / 208.5 / 1050.1 | 22.8 / 135.8 / 961.2 | 0.0 / 80.4 / 89.2 | 2 / 132 / 223 | 2.03 / 2.09 / 2.22 | 2.03 / 2.09 / 2.22 | 0/262300 | 0.0 | 0 | 0.999 | 0 | 387 |
| 慢档 140–200ms | 185 | 14.7% | 183.3 / 199.9 / 200.0 | 119.0 / 132.3 / 165.2 | 34.2 / 81.0 / 84.9 | 34 / 129 / 188 | 0.93 / 2.12 / 2.22 | 0.94 / 2.12 / 2.22 | 171884/175858 | 100.0 | 1 | 0.996 | 0 | 151 |
| 快档 40–70ms | 764 | 60.7% | 57.8 / 59.0 / 67.5 | 17.9 / 24.0 / 33.6 | 0.0 / 0.0 / 86.5 | 2 / 2 / 5 | 2.03 / 2.03 / 2.07 | 2.03 / 2.03 / 2.09 | 0/268198 | 0.0 | 0 | 0.999 | 0 | 25 |
| 上传帧 | 452 | 35.9% | 200.0 / 217.3 / 1050.1 | 124.8 / 146.1 / 961.2 | 58.5 / 83.6 / 89.2 | 91 / 188 / 223 | 1.96 / 2.17 / 2.22 | 1.96 / 2.17 / 2.22 | 250048/252833 | 100.0 | 1 | 0.999 | 0 | 387 |
| fullRebuild（任意） | 387 | 30.8% | 200.8 / 224.0 / 1050.1 | 125.6 / 142.9 / 961.2 | 75.9 / 83.7 / 89.2 | 104 / 191 / 223 | 1.96 / 2.17 / 2.22 | 1.96 / 2.17 / 2.22 | 252816/252816 | 100.0 | 1 | 0.999 | 0 | 387 |
| fullRebuild engine | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |
| fullRebuild inferred | 387 | 30.8% | 200.8 / 224.0 / 1050.1 | 125.6 / 142.9 / 961.2 | 75.9 / 83.7 / 89.2 | 104 / 191 / 223 | 1.96 / 2.17 / 2.22 | 1.96 / 2.17 / 2.22 | 252816/252816 | 100.0 | 1 | 0.999 | 0 | 387 |

列说明：数值列除帧数/占比外均为 **P50 / P90 / max**；`blocks↑/tot P50` = uniqueUploadBlocks / totalBlocks；`uploadMB` = slot写入次数×40B。
## 4. 上传量分布（uploadMbEst）

| 桶 | 帧数 | 占比 | frameMs P50 | gapMs P50 |
|---|---:|---:|---:|---:|
| 0（无上传） | 830 | 66.0% | 58.1 | 20.0 |
| 0–5 MB | 35 | 2.8% | 58.4 | 6.3 |
| 5–20 MB | 26 | 2.1% | 225.4 | 130.2 |
| 20–40 MB | 123 | 9.8% | 182.4 | 115.9 |
| 40–60 MB | 23 | 1.8% | 207.8 | 129.2 |
| ≥60 MB | 221 | 17.6% | 208.2 | 130.5 |
