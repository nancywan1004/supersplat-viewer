# Work Buffer / 上传量统计表

> 源文件 `refinement_poland_v3_finelod_phaseB.txt` · 样本 **1330** 帧
> 场景：`http://localhost:3000/?content=https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/poland/lod-meta.json&settings=/assets/settings/settings-finland-p0-benchmark.json&webgpu&benchmarkHud&frameProfile=1&benchmark&benchmarkAnimTrack&lodRuntime=refinement&budget=2.5`
> 导出：2026-07-13T09:30:41.267Z

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
| allocator used | 0.05 – 2.17 M | 已分配 slot |
| hardCap | 268.44 M | maxTextureSize² |
| textureSize | 1696 | |

## 3. 分档统计（P50 / P90 / max）

| 分档 | 帧数 | 占比 | frameMs | gapMs | uploadMB | drawCalls | gsplatsM | activeM | blocks↑/tot P50 | copy% P50 | bake× P50 | frag P50 | engFULL | infFULL |
|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 全部 | 1330 | 100.0% | 58.5 / 208.3 / 1058.4 | 20.5 / 127.5 / 969.4 | 0.0 / 76.8 / 85.0 | 2 / 120 / 197 | 1.82 / 2.04 / 2.17 | 1.82 / 2.04 / 2.17 | 0/254052 | 0.0 | 0 | 0.998 | 0 | 373 |
| 慢档 140–200ms | 207 | 15.6% | 183.3 / 199.8 / 200.0 | 111.5 / 128.4 / 160.8 | 35.1 / 80.5 / 83.9 | 36 / 124 / 185 | 0.94 / 2.11 / 2.16 | 0.94 / 2.11 / 2.17 | 173857/176862 | 100.0 | 1 | 0.998 | 0 | 193 |
| 快档 40–70ms | 843 | 63.4% | 57.6 / 59.0 / 67.6 | 13.4 / 23.3 / 31.3 | 0.0 / 0.0 / 0.0 | 2 / 2 / 6 | 1.82 / 1.93 / 2.16 | 1.82 / 1.93 / 2.17 | 0/259655 | 0.0 | 0 | 0.997 | 0 | 0 |
| 上传帧 | 409 | 30.8% | 200.0 / 224.8 / 1058.4 | 119.7 / 154.3 / 969.4 | 55.6 / 81.0 / 85.0 | 86 / 169 / 197 | 1.78 / 2.11 / 2.17 | 1.77 / 2.11 / 2.17 | 240217/244590 | 100.0 | 1 | 0.999 | 0 | 373 |
| fullRebuild（任意） | 373 | 28.0% | 200.0 / 224.9 / 1058.4 | 119.5 / 146.5 / 969.4 | 68.8 / 81.2 / 85.0 | 100 / 170 / 197 | 1.80 / 2.11 / 2.17 | 1.80 / 2.11 / 2.17 | 241839/241839 | 100.1 | 1 | 0.999 | 0 | 373 |
| fullRebuild engine | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |
| fullRebuild inferred | 373 | 28.0% | 200.0 / 224.9 / 1058.4 | 119.5 / 146.5 / 969.4 | 68.8 / 81.2 / 85.0 | 100 / 170 / 197 | 1.80 / 2.11 / 2.17 | 1.80 / 2.11 / 2.17 | 241839/241839 | 100.1 | 1 | 0.999 | 0 | 373 |

列说明：数值列除帧数/占比外均为 **P50 / P90 / max**；`blocks↑/tot P50` = uniqueUploadBlocks / totalBlocks；`uploadMB` = slot写入次数×40B。
## 4. 上传量分布（uploadMbEst）

| 桶 | 帧数 | 占比 | frameMs P50 | gapMs P50 |
|---|---:|---:|---:|---:|
| 0（无上传） | 921 | 69.2% | 57.8 | 14.2 |
| 0–5 MB | 33 | 2.5% | 191.2 | 131.3 |
| 5–20 MB | 23 | 1.7% | 225.1 | 138.6 |
| 20–40 MB | 134 | 10.1% | 175.8 | 111.7 |
| 40–60 MB | 23 | 1.7% | 208.3 | 128.8 |
| ≥60 MB | 196 | 14.7% | 207.9 | 122.5 |
