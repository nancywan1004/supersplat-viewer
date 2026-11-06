# LOD Stream Container 加载规格（Viewer / PCSLD）

> **状态：导出已实现（splat-transform v2.7+）· viewer 待实现**  
> **日期**：2026-07-01（2026-07-01 增补：schema 对齐、native LOD 语义、demo 踩坑）  
> **受众**：supersplat-viewer 维护者  
> **导出侧配套**：[splat-transform](../../splat-transform/docs/LOD_STREAM_CONTAINER_SPEC.md) `docs/LOD_STREAM_CONTAINER_SPEC.md`  
> **格式 PoC（非生产验收基准）**：[splat-transform](../../splat-transform/demo/pcsld-viewer/) `demo/pcsld-viewer/`

### 实现状态（2026-07）


| 组件                                       | 状态    | 说明                                                           |
| ---------------------------------------- | ----- | ------------------------------------------------------------ |
| splat-transform `--lod-pack-mode stream` | ✅     | 产出 `.pcsld`；SPZ-v4 per-chunk；`CHUNK_CRC32`；导出日志含 `modeA/B/C` |
| `demo/pcsld-viewer`                      | ✅ PoC | 验证 Range / header / SPZ / 简易 leaf 调度；**不含** native 父节点兜底     |
| supersplat-viewer stream loader          | ❌     | 本文档范围                                                        |


**Schema v1 要点（与导出对齐）**

- mHeader：`FileHeader` 32B + JSON（长度由 `headerByteLength` 决定，**非固定 4096**）
- 叶节点 `tree.lods[n]`：`{ chunk, offset, count }`（`file` → `chunk`）
- `bootChunkIds`：首屏 Range 预拉（通常为 `[0]`）
- **不含** `permanentChunkIds`（coarse-merge 已废弃；常驻策略由 viewer 运行时决定）
- Chunk 载荷：`encoding: "spz-v4"`；`flags & CHUNK_CRC32` 时尾部 4B CRC

导出日志示例：

```text
[stream] chunks=956 bootBytes=1.1MB bootChunks=[0] modeA=100% modeB=0% modeC=0%
```



### demo 与 viewer 边界（勿混用）

`demo/pcsld-viewer` 与 supersplat-viewer **交互和能力不一致**。迁移时只复用 **格式/传输层验证结论**，**不要**把 demo 的实现细节同步进 viewer。


| 从 demo **可复用**                                  | **不必**同步到 viewer                                            |
| ----------------------------------------------- | ----------------------------------------------------------- |
| Header Range 读取（32B + `headerByteLength`）       | WASD / tour / fly camera 交互                                 |
| `fetch` + HTTP Range + 206 探测                   | 独立 `StreamManager` + 多 `Entity` 渲染路径                        |
| `@adobe/spz` per-chunk 解码                       | leaf 列表 + `maxActiveLeaves` / horizon ring 自研调度             |
| chunk 内 `offset/count` slice                    | demo 对大场景 **禁用 boot**（`count >= 5M`）的策略                     |
| CRC32 校验思路                                      | `leaveGrace` / `mountBatch` / `updateSensitivity` 等 demo 调参 |
| 坐标 root（`sceneEuler`）与 production settings 对齐方式 | demo HUD / Vite 工程结构                                        |


**Viewer 应走的路线**（与 demo 不同）：

- 入口：`src/index.ts` + 现有 octree bootstrap / `OctreeRefinementController`
- 调度：`ensureFileResource` → `ensureChunkResource` patch；复用 `lodUnderfillLimit`、center-priority
- 缺页语义：按 **§4.5**（父节点兜底、swap hold、boot 底图），**不是** demo 的 leaf underfill 实现
- 交互：现网 viewer 相机、tour、benchmark；**不**引入 demo 专有控件

demo 的价值是证明「`.pcsld` 能 Range 拉、能解码、能画出来」；**native LOD 观感**以本文 §4.5 + 现网 refinement 为准，不以 demo 行为为验收标准。

---



## 1. 背景与目标



### 1.1 为何需要 viewer 侧改造

splat-transform `--lod-pack-mode stream` 产出单个 `.pcsld` 容器后，**现有 PlayCanvas 加载路径无法直接消费**：


| 现网路径                    | 行为                                      | 与 PCSLD 的冲突                      |
| ----------------------- | --------------------------------------- | -------------------------------- |
| `GSplatOctreeParser`    | 加载 `lod-meta.json`                      | meta 内嵌于 `.pcsld` header         |
| `ensureFileResource(i)` | `assetLoader.load(filenames[i])` 整包 SOG | 需改为 **HTTP Range 拉 chunk**       |
| SOG 解码                  | ZIP 整包解压                                | chunk 为 **独立 SPZ / column-gzip** |
| refinement              | 按 `fileIndex` 调度                        | 需改为 `chunkId` **调度**             |


Spark 亿级「几秒变清」的收益 **~60% 在传输层（Range + boot chunk）**，~40% 在调度语义（父节点兜底、pixel_scale）。本规格先打通传输层，再逐步吸收调度语义。

### 1.2 目标指标


| 场景                   | 现状（separate）     | stream 目标                  |
| -------------------- | ---------------- | -------------------------- |
| Poland 1.04 亿点 冷启动首屏 | ~29s             | **≤ 3s**（boot chunk Range） |
| Poland 停住 blur→清晰    | 20–30s           | **2–5s**                   |
| 南广场 ~4000 万          | ~3s              | ≤ 3s（不退化）                  |
| 帧率                   | 60fps（poland-v2） | 保持 ≥ 60fps（budget 不变）      |


---



## 2. 架构总览

```text
content URL (*.pcsld)
    │
    ▼
PcsldContainerLoader          ← 新建：HEAD/Range 读 header + chunk 索引
    │
    ├─ bootstrap：Range bootChunkIds → decode → 粗画面 firstFrame
    │
    ▼
StreamChunkCache              ← 新建：chunkId → decoded GSplatData / GPU resource
    │
    ▼
StreamOctreeAdapter           ← 新建：实现 ensureChunkResource，映射到 octree interval
    │
    ├─ 复用 OctreeRefinementController 评分 / center-priority
    │
    ▼
PlayCanvas GSplatOctreeInstance（interval 切换上屏）
```

**原则**：尽量 **patch 调度层**，避免 fork PlayCanvas engine；仅在必要时向 engine 提 PR（虚拟 file provider）。

---



## 3. 加载流程



### 3.1 容器识别

```ts
// content manifest / settings URL 以 .pcsld 结尾，或 HEAD 响应 Content-Type
function isPcsldContainer(url: string): boolean;
```

入口分支（`src/index.ts` / `bootstrap/octree-lod.ts`）：

```text
.pcsld  → stream 路径
lod-meta.json → 现有 octree 路径（不变）
```



### 3.2 Phase 0 — Header 读取

```http
GET /scene.pcsld
Range: bytes=0-4095
```

解析 `FileHeader` → 若 `headerByteLength` 更大，再 Range 拉完整 JSON。

产出内存结构：

```ts
type PcsldHeader = {
    chunks: PcsldChunkIndex[];
    tree: MetaNode;
    lodLevels: number;
    bootChunkIds: number[];
    defaultChunkSplatCount: number;
    count: number;
    counts: number[];
};
```



### 3.3 Phase 1 — Bootstrap（首屏）

```text
for id in bootChunkIds (parallel, concurrency=2):
  Range fetch chunks[id]
  decode(encoding) → GSplatData
  upload GPU → register in StreamChunkCache

构建「仅 boot chunk 可见」的 octree instance 初始 interval
→ firstFrame（目标：header 完成后 < 3s）
```

**不等**全文件下载；**不等** unlockStreamingLod 才显示（boot 即粗画面）。

### 3.4 Phase 2 — Unlock refinement

与现网类似：`loadingCount → 0` 或 boot ready 后 `unlockStreamingLod()`，但调度单位从 `fileIndex` 变为 `chunkId`。

### 3.5 Phase 3 — 细化调度

每帧（复用 `octree-refinement-controller` 评分）：

```text
for visible leaf node:
  targetLod = f(distance, fov, splatBudget, pixelScale?)
  entry = node.lods[targetLod]   // { chunk, offset, count }

  if StreamChunkCache.has(entry.chunk):
    sync interval(entry.chunk, entry.offset, entry.count)   // 近 instant
  else:
    enqueueChunkDownload(entry.chunk, priority=score)
    keep current coarser interval as parent fallback         // Spark 语义
```



### 3.6 HTTP Range 请求规范

```http
GET /scene.pcsld
Range: bytes={byteOffset}-{byteOffset+byteLength-1}
```

要求 CDN / 对象存储支持 **Range**（阿里云 OSS、AWS S3、Cloudflare 均支持）。

并发：默认 **6**（与现网 refinement burst 对齐）；**boot 队列独立**（默认 2），避免 refinement 饿死首屏。

**Range 自检**：启动时对 header 与 boot chunk 发 probe；非 `206 Partial Content` 时 dev 警告、生产 CDN 配置应拒绝上线。

**CRC32**：`FileHeader.flags & CHUNK_CRC32` 时，解码前校验 chunk 载荷 + 尾部 4B，并与 `chunks[i].crc32` 对照。

---



## 4. 模块设计



### 4.1 新建文件


| 模块        | 路径                                                       | 职责                                      |
| --------- | -------------------------------------------------------- | --------------------------------------- |
| 容器解析      | `src/loaders/gsplat/lod/stream/pcsld-header.ts`          | 魔数、JSON header、chunk 表                  |
| Range 获取  | `src/loaders/gsplat/lod/stream/pcsld-fetch.ts`           | fetch + Abort + 重试 + 进度                 |
| Chunk 解码  | `src/loaders/gsplat/lod/stream/chunk-decode.ts`          | `spz-v4` / 未来 column-gzip               |
| 缓存        | `src/loaders/gsplat/lod/stream/chunk-cache.ts`           | LRU、ref count、boot pin（运行时策略，非 meta 字段） |
| Octree 适配 | `src/loaders/gsplat/lod/stream/stream-octree-adapter.ts` | 替代 `ensureFileResource`                 |
| Bootstrap | `src/loaders/gsplat/lod/stream/stream-bootstrap.ts`      | 首屏 boot chunk 流程                        |
| 入口        | `src/loaders/gsplat/lod/stream/index.ts`                 | 对外 API                                  |




### 4.2 需改造的现有文件


| 文件                                                       | 改动                                  |
| -------------------------------------------------------- | ----------------------------------- |
| `src/index.ts`                                           | content URL 分流 `.pcsld`             |
| `src/loaders/gsplat/lod/octree/bootstrap.ts`             | 挂载 `stream-bootstrap` 分支            |
| `src/loaders/gsplat/lod/octree/refinement-controller.ts` | `ensureChunkResource` 钩子；pending 保粗 |
| `src/viewer.ts`                                          | `unlockStreamingLod` 与 stream 路径联动  |
| `src/benchmark/*`                                        | 支持 `.pcsld` content URL             |




### 4.3 StreamOctreeAdapter 核心接口

```ts
type StreamOctreeAdapter = {
    header: PcsldHeader;
    cache: StreamChunkCache;

    ensureChunkResource(chunkId: number, priority: number): void;
    getChunkResource(chunkId: number): GSplatResource | null;
    syncPlacement(nodeIndex: number, lodEntry: { chunk: number; offset: number; count: number }): void;

    /** 诊断 */
    getDebugState(): {
        chunksLoaded: number;
        chunksPending: number;
        bootReady: boolean;
        bytesFetched: number;
    };
};
```



### 4.4 与 PlayCanvas engine 的集成策略

**方案 A（优先）— Viewer 侧虚拟 file 映射**

- 不修改 engine；在 `GSplatOctree` 实例上 patch `ensureFileResource`：
  - `filenames[i]` 保留为逻辑名 `pcsld://chunk/{id}`
  - patch 函数拦截 → 转 `ensureChunkResource(id)`

**方案 B — Engine PR**

- 为 `GSplatOctree` 增加 `chunkSource` 回调注册点  
- 工作量大，仅在方案 A 无法覆盖 interval 同步时采用



### 4.5 缺页与升档策略（对齐 PlayCanvas native LOD）

> **关键**：传输层（Range/boot）只解决「怎么拉」；native 观感取决于本节。  
> `demo/pcsld-viewer` 的 leaf 级 underfill **不足以**作为生产目标（pan 时会闪块）。



#### 4.5.1 父节点兜底（octree 向上）

当叶节点 `targetLod` 的 `(chunk, offset, count)` **未 resident**：

1. **不得**卸载当前可见 interval，避免空洞
2. 沿 **octree 祖先**查找更粗、且 chunk 已 resident 或可请求的 `lods` 条目（不仅限于同一 leaf 的更粗档）
3. 将 `targetLod` 所需 chunk 插入 center-priority 队列
4. chunk ready 后 `syncOctreePendingPlacements` / interval 切换

这与现网 `OctreeRefinementController`「pending 保粗」一致，只是把 `fileIndex` 换成 `chunkId`。

#### 4.5.2 lodUnderfill（与 engine 复用）

- 继续尊重 `gsplatScene.lodUnderfillLimit`（现网默认 5，见 `custom-loader.ts` / `refinement-controller.ts`）  
- **语义**：目标 LOD chunk 未就绪时，保留 **同一节点** 上已显示的更粗 interval  
- **与父节点兜底叠加**：underfill 管「同节点 finer→coarser」；父节点管「子未就绪→祖先 coarse」



#### 4.5.3 Swap hold（先装后卸）

- 新 `(chunk, offset, count)` interval **上屏成功**后，再卸载被替换的 coarse interval  
- **禁止** budget 轮换或 grace 到期时「先卸后装」——这是 demo 闪块主因之一



#### 4.5.4 Boot 底图（大场景也启用）

- **始终** Range 拉取 `bootChunkIds` 并上屏粗代理（sangaolu 实测 boot ~1.1MB / 65K splats）  
- Boot 与 stream 细 chunk **可空间重叠**；策略：boot 作全局底图，细 interval 就绪后局部覆盖；全部 stream 稳定后可 **fade / 降权** boot，而非首帧禁用  
- Boot 不参与 octree leaf 计划，但参与 splat budget 的「底图份额」（可配置 `bootBudgetRatio`）



#### 4.5.5 Budget 挤掉时的优先级

当 `splatBudget` / `maxActiveLeaves` 触顶：

1. 保留 **已 resident 的 coarse** 与 boot 底图
2. 优先卸载 **最远的 fine** placement
3. 禁止把某 leaf 的 **全部** interval 同时卸空（至少留一档 coarse 或祖先兜底）



#### 4.5.6 导出 mode A/B/C 对 viewer 的影响


| 模式    | 叶节点 LOD 引用                   | Viewer 行为                               |
| ----- | ---------------------------- | --------------------------------------- |
| **B** | 多档同 `(chunk, offset, count)` | 升档 **零下载**，仅改 interval 指针               |
| **A** | 粗档独立 chunk，细档共享 base         | 升档需拉 chunk；**必须** swap hold + underfill |
| **C** | 仅最粗档独立                       | 介于 A/B 之间                               |


导出日志 `modeA/B/C` 占比用于 benchmark 归因（例：sangaolu `modeA=100%` → 升档必拉新 chunk，调度层压力最大）。

#### 4.5.7 反模式（demo 已验证）


| 反模式                       | 后果                        |
| ------------------------- | ------------------------- |
| 仅 leaf 内 underfill，无父节点兜底 | 走进未加载区域 → 整块消失            |
| 大场景禁用 boot                | 冷启动与 pan 时无全局 coarse 垫层   |
| leaf 出计划即卸载（短 grace）      | 相机移动时区域闪灭/闪现              |
| 先卸 interval 再等 chunk      | 画面空洞；极端情况 `hasCenters` 崩溃 |




### 4.6 GSplat 生命周期与帧序

PlayCanvas 帧序：`update` → `framerender`（读 placement）→ `prerender` → `render`（reconcile）。

**约束**：

- interval/placement **销毁**须在 `prerender` **之前**完成 reconcile（或在 engine 认可的 sync 点），避免 `framerender` 读到 `resource=null`  
- `syncPlacement` 必须支持 **chunk 内 slice**：`GSplatData` 仅含 `[offset, offset+count)` 子集，非整 chunk 全量（参考 splat-transform `cloud-slice`）  
- 与 `OctreeRefinementController` 的 pending 队列配合，避免与 engine 内部 LOD 切换竞态



### 4.7 坐标空间

PCSLD 数据与 classic `lod-meta.json` 使用 **相同数据空间**。Viewer 侧：

- splat root 变换与现网 production settings 一致（例：sangaolu `sceneEuler Z=180°`）  
- Boot chunk 与 stream interval **共用同一 root entity**  
- 不得在 stream 分支单独改坐标约定



### 4.8 SPZ 解码

splat-transform 使用 `spz-v4` per-chunk 编码。Viewer 侧：

- **P0**：`@adobe/spz` WASM（与 splat-transform / demo 一致）  
- **P1**：Worker 并行解码，避免主线程卡顿  
- 解码结果 → `GSplatData` → `GSplatResource`（与现网 SOG 路径汇合）

---



## 5. 配置与协议



### 5.1 settings / manifest 扩展

```jsonc
{
  "content": {
    "url": "https://cdn.example.com/poland.pcsld"
  },
  "lodSettings": {
    "stream": {
      "rangeConcurrency": 6,
      "bootConcurrency": 2,
      "chunkDecodeWorkers": 2,
      "bootBudgetRatio": 0.15,
      "bootFadeAfterStreamReady": true
    }
  }
}
```

`lodSettings` 命名空间仅用于 stream 容器；现有 `lod-meta.json` 路径不读取此字段。

### 5.2 HUD / benchmark 指标


| 指标                                      | 含义                          |
| --------------------------------------- | --------------------------- |
| `stream.bootMs`                         | header + boot chunk 上屏耗时    |
| `stream.bytesFetched`                   | 累计 Range 字节                 |
| `stream.chunksLoaded` / `chunksPending` | 调度状态                        |
| `stream.blurToClearMs`                  | 与现网 waypoint 一致             |
| `stream.panHoleCount`                   | pan 10s 内可见空洞次数（目标 0）       |
| `stream.modeBLeafRatio`                 | 从 header 树统计，与导出 `modeB` 对照 |


---



## 6. 验收用例


| #   | 用例                   | 通过标准                                           |
| --- | -------------------- | ---------------------------------------------- |
| 1   | 小场景 `.pcsld` 冷启动     | bootMs < 2s，有粗画面                               |
| 2   | Poland 子集停住          | blurToClearMs < 5s                             |
| 3   | Poland 全量 60fps      | fpsP50 ≥ 60，blurToClearMs < 8s                 |
| 4   | 挪机后再停住               | boost 可重复，blurToClear 不退化                      |
| 5   | separate 回归          | `lod-meta.json` 路径零行为变化                        |
| 6   | CDN Range            | 断点续传、206 响应正确                                  |
| 7   | 相机 pan / orbit 10s   | **无可见空洞**（允许变糊，禁止整块消失）                         |
| 8   | 走近未加载区域              | 先 coarse 占位，再变清（行为对齐 separate）                 |
| 9   | sangaolu 全量 `.pcsld` | boot 上屏 + tour 无 crash；`chunksLoaded` 单调增      |
| 10  | 高 modeA 资产           | blurToClear 可慢，但 **panHoleCount = 0**（验证 §4.5） |


> **注意**：`demo/pcsld-viewer` 仅验证格式与 Range，**不作为**用例 7–10 的通过基准。

---



## 7. 工作量评估（viewer）

假设 **1 名熟悉本仓库的开发者**，含 benchmark 与 Poland 子集联调。


| 阶段                     | 内容                                                     | 人天                     |
| ---------------------- | ------------------------------------------------------ | ---------------------- |
| **V0 规格对齐**            | 与 splat-transform 冻结 schema                            | 2                      |
| **V1 PoC**             | header 解析 + Range boot chunk + 粗画面上屏                   | 7–10                   |
| **V2 解码链**             | SPZ per-chunk WASM decode + Worker                     | 8–12                   |
| **V3 Adapter**         | patch ensureFileResource → chunk；interval sync + slice | 10–15                  |
| **V3.5 Refinement 语义** | 父节点兜底 + swap hold + boot 底图（§4.5）                      | 5–8                    |
| **V4 Refinement 队列**   | center-priority 改 chunk 队列；与 underfill 整合              | 3–5                    |
| **V5 Bootstrap 整合**    | firstFrame / unlock / progress 与现网一致                   | 3–5                    |
| **V6 Benchmark**       | scene-poland-stream.json + blurToClear 报告              | 3–5                    |
| **V7 全量调优**            | Poland 亿级、内存/VRAM 峰值、回归                                | 5–8                    |
| **合计**                 |                                                        | **43–65 人天（约 9–13 周）** |


**PoC 可交付最小集（V0+V1+V2+V3.5 子集）**：**15–22 人天** — boot 出画 + 1 个细 chunk 变清 + **pan 10s 无空洞**。

### 与 splat-transform 并行时的总工期


| 模式                         | 日历时间        | 说明                           |
| -------------------------- | ----------- | ---------------------------- |
| **串行**（1 人）                | **15–20 周** | 先导出 PoC → 再 viewer PoC → 再全量 |
| **并行**（2 人，schema 第 1 周冻结） | **8–11 周**  | 导出/加载各一线，第 3 周联调             |
| **仅 PoC 验证假设**             | **4–6 周**   | 子集 Poland + blurToClear 对比   |




### 风险与依赖


| 风险                                     | 影响                  | 缓解                                   |
| -------------------------------------- | ------------------- | ------------------------------------ |
| PlayCanvas interval sync 与 chunk 资源不兼容 | V3 阻塞               | 提前用最小 `.pcsld` 验证方案 A                |
| SPZ 浏览器解码性能                            | 变清仍慢                | Worker + 更小 chunk；或改 sog-column-gzip |
| CDN 未开 Range                           | 全文件下载，收益归零          | 部署规范强制 Range；启动时 HEAD 自检             |
| boot chunk 体积超预期                       | 首屏 > 3s             | 与导出侧联动调 `defaultChunkSplatCount`     |
| engine 升级破坏 patch                      | 维护成本                | 尽量收敛到 adapter 单层                     |
| 仅实现 leaf underfill                     | pan 闪块，与 native 不一致 | 必须实现 §4.5 全套后再 benchmark             |
| modeA 占比 100% 资产                       | 升档必拉 chunk          | swap hold + 父节点；导出侧逐步提高 modeB        |


---



## 8. 实施顺序（推荐）

```text
Week 1    双端 schema 评审冻结（导出 v1 已落地）
Week 2-3  viewer header/boot PoC（splat-transform 已有 .pcsld 样本）
Week 4-5  SPZ decode + chunk cache + adapter slice
Week 5-6  §4.5 调度语义（与 V3 并行，不可延后）
Week 7-8  Poland / sangaolu benchmark（含 panHoleCount）
Week 9+   全量调优 + CDN + 文档收尾
```

**不建议**在 stream 落地前继续加大 separate refinement 参数投入作为亿级主方案；universe / packed 可作为 stream 未就绪时的过渡。

---



## 9. 与 classic / universe / packed 的关系


| 能力                   | classic separate       | packed + permanentFiles | stream (PCSLD)                   |
| -------------------- | ---------------------- | ----------------------- | -------------------------------- |
| 减少 HTTP 文件数          | ❌                      | 部分                      | ✅ 单 URL                          |
| 细档零下载升档              | ❌                      | 同 file 切片（mode B）       | 同 chunk 切片（mode B）               |
| Range 渐进加载           | ❌                      | ❌                       | ✅                                |
| boot 立刻出画            | ❌                      | ❌                       | ✅                                |
| 粗档常驻                 | `permanentFiles`（meta） | meta 字段                 | **viewer 运行时**（boot pin + cache） |
| `lodUnderfillLimit`  | ✅ engine               | ✅ engine                | ✅ **必须保留**                       |
| 需改 PlayCanvas loader | 否                      | 否                       | 是（viewer 层）                      |


**配置映射（stream 分支）**


| classic `lodSettings`               | stream 行为               |
| ----------------------------------- | ----------------------- |
| `lodUnderfillLimit`                 | 继续传入 `gsplatScene`      |
| `lodBaseDistance` / `lodMultiplier` | 复用 refinement 距离选档      |
| universe / `permanentFiles`         | **忽略**；由 boot + §4.5 替代 |


stream **包含** packed 的 tree 语义，并替代传输层；**不**再读取 `permanentFiles` / `permanentChunkIds`。

---



## 10. 参考资料

- 现网 refinement：`src/loaders/gsplat/lod/octree/refinement-controller.ts`
- Octree bootstrap：`src/loaders/gsplat/lod/octree/bootstrap.ts`
- Universe（过渡方案）：[LOD_UNIVERSE_PACK_LOADING.md](LOD_UNIVERSE_PACK_LOADING.md)
- 多文件加载适配：[supersplat-viewer-loading-adaptation.md](../../splat-transform/docs/supersplat-viewer-loading-adaptation.md)（splat-transform 侧副本）
- 导出规格：[splat-transform](../../splat-transform/docs/LOD_STREAM_CONTAINER_SPEC.md) `docs/LOD_STREAM_CONTAINER_SPEC.md`
- 格式 PoC（**非生产 LOD 基准**）：[splat-transform](../../splat-transform/demo/pcsld-viewer/) `demo/pcsld-viewer/`
- Poland benchmark：`public/benchmark-suites/scene-poland-mainline.json`
- sangaolu 样本：`splat-transform/assets/sangaolu/output/sangaolu.pcsld`（956 chunks，modeA=100%）

