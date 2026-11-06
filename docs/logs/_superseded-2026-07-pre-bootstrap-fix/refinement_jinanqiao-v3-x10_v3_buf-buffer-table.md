# Work Buffer / 上传量统计表

> 源文件 `refinement_jinanqiao-v3-x10_v3_buf.txt` · 样本 **863** 帧
> 场景：`http://localhost:3000/?content=https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/jinanqiao-v3-x10/lod-meta.json&settings=/assets/settings/settings-jinanqiao.json&webgpu&benchmarkHud&frameProfile=1&noanim&lodRuntime=refinement&budget=2.5`
> 导出：2026-07-08T10:02:00.318Z

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
| allocator used | 0.12 – 1.84 M | 已分配 slot |
| hardCap | 268.44 M | maxTextureSize² |
| textureSize | 1696 | |

## 3. 分档统计（P50 / P90 / max）

| 分档 | 帧数 | 占比 | frameMs | gapMs | uploadMB | drawCalls | gsplatsM | activeM | blocks↑/tot P50 | copy% P50 | bake× P50 | frag P50 | engFULL | infFULL |
|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 全部 | 863 | 100.0% | 49.1 / 66.1 / 300.0 | 14.1 / 30.8 / 271.9 | 44.5 / 61.6 / 101.4 | 48 / 69 / 100 | 1.43 / 1.61 / 1.84 | 1.43 / 1.61 / 1.84 | 25093/27174 | 100.1 | 1 | 0.989 | 0 | 729 |
| 慢档 140–200ms | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |
| 快档 40–70ms | 456 | 52.8% | 50.1 / 66.7 / 67.7 | 24.8 / 34.9 / 53.7 | 41.1 / 61.6 / 95.6 | 48 / 76 / 100 | 1.24 / 1.61 / 1.84 | 1.24 / 1.61 / 1.84 | 24839/25093 | 100.1 | 1 | 0.978 | 0 | 415 |
| 上传帧 | 773 | 89.6% | 49.5 / 66.2 / 300.0 | 14.1 / 31.4 / 271.9 | 50.9 / 61.6 / 101.4 | 49 / 71 / 100 | 1.38 / 1.61 / 1.84 | 1.38 / 1.61 / 1.84 | 25093/25093 | 100.1 | 1 | 0.987 | 0 | 729 |
| fullRebuild（任意） | 729 | 84.5% | 49.4 / 66.3 / 300.0 | 13.6 / 29.6 / 271.9 | 52.7 / 61.6 / 101.4 | 49 / 67 / 100 | 1.38 / 1.61 / 1.84 | 1.38 / 1.61 / 1.84 | 25093/25093 | 100.1 | 1 | 0.986 | 0 | 729 |
| fullRebuild engine | 0 | 0.0% | — | — | — | — | — | — | — | — | — | — | 0 | 0 |
| fullRebuild inferred | 729 | 84.5% | 49.4 / 66.3 / 300.0 | 13.6 / 29.6 / 271.9 | 52.7 / 61.6 / 101.4 | 49 / 67 / 100 | 1.38 / 1.61 / 1.84 | 1.38 / 1.61 / 1.84 | 25093/25093 | 100.1 | 1 | 0.986 | 0 | 729 |

列说明：数值列除帧数/占比外均为 **P50 / P90 / max**；`blocks↑/tot P50` = uniqueUploadBlocks / totalBlocks；`uploadMB` = slot写入次数×40B。
## 4. 上传量分布（uploadMbEst）

| 桶 | 帧数 | 占比 | frameMs P50 | gapMs P50 |
|---|---:|---:|---:|---:|
| 0（无上传） | 124 | 14.4% | 33.3 | 17.5 |
| 0–5 MB | 19 | 2.2% | 50.0 | 24.1 |
| 5–20 MB | 34 | 3.9% | 50.4 | 22.1 |
| 20–40 MB | 209 | 24.2% | 49.9 | 14.6 |
| 40–60 MB | 235 | 27.2% | 49.5 | 14.5 |
| ≥60 MB | 242 | 28.0% | 33.9 | 8.1 |
