# Billions 量级场景调度迁移与重构规划

> 目标：在现有 Supersplat Viewer / PlayCanvas octree streaming 架构上，引入类似 PlayCanvas `billions.example.mjs` 的 **多 Entity 实例层 + 共享 Asset / Resource + 分层调度** 能力。  
> 日期：2026-06-24

---

## 1. 背景

PlayCanvas 官方 `billions.example.mjs` 的核心机制是：

- 只加载一份 multi-LOD streamed `gsplat` asset。
- 创建多个 `Entity`，每个 `Entity` 的 `gsplat` component 都指向同一个 asset。
- 每个 Entity 有独立 transform、AABB、LOD 参数和可见性判断。
- PlayCanvas streaming LOD 系统根据当前相机，只让可见且高收益的实例进入更细 LOD。

这个示例本身是「同一个波兰村庄场景复制多次」，不是我们最终要的「同一个大场景拆成不同区域」。但它证明了一个关键工程能力：

```Plain Text
Entity 是调度实例
Asset / Resource 是数据本体
多个 Entity 可以共享同一份 streamed gsplat resource
```

对真实大场景来说，应迁移的不是「复制场景」，而是 **实例层调度模型**：

```Plain Text
scene
  region entity A -> asset/resource A
  region entity B -> asset/resource B
  region entity C -> asset/resource C
  repeated entity D1 -> shared asset/resource D
  repeated entity D2 -> shared asset/resource D
```

---

## 2. 现有架构切入点

### 2.1 已有能力

现有代码已经具备一部分多区域基础：

| 能力 | 现状 | 文件 |
|------|------|------|
| 多 piece manifest | `contentManifest.pieces[]` 可声明多个 gsplat piece | `src/loaders/gsplat/lod/content-manifest.ts` |
| 多 piece 加载 | 每个 piece 创建一个 gsplat Entity | `src/loaders/gsplat/lod/gsplat-scene-load.ts` |
| 多 piece bootstrap | 对每个 Entity 调用 `bootstrapOctreeLod`，再合并进度 | `src/loaders/gsplat/lod/multi-piece-bootstrap.ts` |
| Octree streaming refinement | 对单 Entity / 单 octree 做下载优先级、gate、sync、LRU | `src/loaders/gsplat/lod/octree/refinement-controller.ts` |
| 多 octree instance 查找 | `findAllOctreeInstances` 能扫描同一 octree 下的多个 runtime instance | `src/loaders/gsplat/lod/octree/refinement-controller.ts` |

### 2.2 当前限制

当前 multi-piece 更像「多个独立 asset 并行加载」：

```Plain Text
piece A -> new Asset A -> Entity A -> controller A
piece B -> new Asset B -> Entity B -> controller B
piece C -> new Asset C -> Entity C -> controller C
```

这和 billions 示例的共享 resource 模型不同：

```Plain Text
shared Asset X
  -> Entity X1
  -> Entity X2
  -> Entity X3
```

当前如果直接把很多 Entity 都接到 `bootstrapOctreeLod`，会有几个问题：

- 多个 controller 可能同时 patch 同一个 `octree.assetLoader`。
- 多个 controller 会分别写 `__refinementPriorityUrls` / gate / queue，互相覆盖。
- priority 计算以单个 `gsplatEntity` 的 transform 为主，不能正确合并共享 resource 下多个实例的可见需求。
- 首屏进度按 piece 平均合并，不能表达「先显示当前视口相关 region」。
- `primary` Entity 仍被 reveal、night mode、shadow、camera bound 等模块当作单一主场景引用。

---

## 3. 目标架构

### 3.1 分层调度

billions 量级需要两层调度：

```Plain Text
Region Scheduler
  负责场景级区域选择：
    - 视锥 / 距离 / 屏幕占比
    - 用户运动方向
    - active / warm / cold region 切换
    - 全局下载和驻留预算

Octree Group Refinement
  负责资源级细化：
    - 同一 octree/resource 下多个 Entity instance 的 node/file priority 合并
    - 一个 resource 只拥有一个 loader gate / queue controller
    - 统一 sync placements 和 dirty 标记
```

### 3.2 核心数据结构

建议新增：

```ts
type GsplatRegion = {
    id: string;
    entity: Entity;
    assetKey: string;
    resourceKey: string;
    worldAabb: BoundingBox;
    priority: number;
    state: 'active' | 'warm' | 'cold';
};

type GsplatResourceGroup = {
    resourceKey: string;
    asset: Asset;
    octree: OctreeLike;
    entities: Entity[];
    activeEntities: Entity[];
};
```

其中：

- `GsplatRegion` 是场景级调度单元。
- `GsplatResourceGroup` 是 asset/resource 级调度单元。
- 同一个 `assetKey` 可以对应多个 Entity。
- 不同区域可以是不同 asset，也可以是同 asset 的多个实例。

### 3.3 Manifest 扩展

当前 `ContentManifestPiece` 只有：

```ts
type ContentManifestPiece = {
    url: string;
    label?: string;
    rotation?: [number, number, number];
};
```

建议扩展为：

```ts
type ContentManifestPiece = {
    url: string;
    assetKey?: string;
    label?: string;
    position?: [number, number, number];
    rotation?: [number, number, number];
    scale?: [number, number, number];
    lodBaseDistance?: number;
    lodMultiplier?: number;
    bootstrap?: 'viewport' | 'warm' | 'lazy';
};
```

示例：

```json
{
  "pieces": [
    {
      "assetKey": "block-a",
      "url": "/assets/gsplat/city/block-a/lod-meta.json",
      "label": "block-a",
      "position": [0, 0, 0],
      "rotation": [0, 0, 180],
      "bootstrap": "viewport"
    },
    {
      "assetKey": "repeated-building",
      "url": "/assets/gsplat/shared/building/lod-meta.json",
      "label": "building-001",
      "position": [200, 0, 80],
      "rotation": [0, 30, 180],
      "bootstrap": "lazy"
    },
    {
      "assetKey": "repeated-building",
      "url": "/assets/gsplat/shared/building/lod-meta.json",
      "label": "building-002",
      "position": [260, 0, 160],
      "rotation": [0, -15, 180],
      "bootstrap": "lazy"
    }
  ]
}
```

---

## 4. 迁移路线

### P0：验证共享 Asset 实例化

目标：不重构 refinement，只验证同 URL / 同 asset 多 Entity 可运行。

改动：

- 在 `gsplat-scene-load.ts` 增加 URL 级 `Asset` cache。
- manifest 支持 `position` / `scale`。
- 同 URL 的 piece 复用同一个 `Asset`，创建多个 `Entity`。
- 每个 Entity 独立设置 transform 和 `lodBaseDistance` / `lodMultiplier`。
- 保留当前 `bootstrapMultiPieceOctreeLod`，只用于小规模验证。

验收：

- 两个以上 Entity 指向同一个 `Asset`。
- 网络面板中同 URL 只加载一次 meta 和首批资源。
- 实例 transform 不互相影响。
- WebGPU / WebGL2 均能显示。

风险：

- 多 controller 共享同一 resource 时可能出现 loader gate 互相覆盖。
- 因此 P0 只作为功能验证，不作为十亿级方案上线。

### P1：新增 Region Scheduler

目标：把「是否参与 refinement」从 octree 内部提升到场景区域层。

改动：

- 新增 `src/loaders/gsplat/lod/region/region-scheduler.ts`。
- 建立 `GsplatRegion` 列表，维护 `active / warm / cold` 状态。
- 根据相机视锥、距离、屏幕占比、运动方向排序。
- 控制 Entity 的 enabled / LOD 参与状态。
- 首屏只等待当前视口相关 region，而不是等待所有 pieces。

建议策略：

| 状态 | 行为 |
|------|------|
| `active` | 进入 group refinement，允许追细档 |
| `warm` | 保留粗档或最低档，可预取少量 coarse file |
| `cold` | 不参与 refinement，可禁用 Entity 或保持最低资源驻留 |

验收：

- 大量 region 存在时，只有视口附近 region 进入下载优先队列。
- 相机移动后 active region 能切换。
- 旧视角 region 不继续占用 foreground 下载槽。

**P1 已落地（2026-06-24）**

| 模块 | 路径 |
|------|------|
| Region 调度 | `src/loaders/gsplat/lod/region/region-scheduler.ts` |
| Region 描述构建 | `src/loaders/gsplat/lod/region/region-scene-load.ts` |
| cold/warm lodRange 压档 | `src/loaders/gsplat/lod/region/region-lod-participation.ts` |
| 首屏进度 / firstFrame 门控 | `src/loaders/gsplat/lod/multi-piece-bootstrap.ts` |
| participation 门控 | `src/loaders/gsplat/lod/octree/bootstrap.ts` |
| viewer 每帧 `update()` | `src/viewer.ts` |
| Benchmark HUD Regions | `src/benchmark/benchmark-hud.ts` |

**验证场景（Finland 双 tile，共享 asset）**

```
/index.html?settings=/assets/settings/settings-finland-p0-test.json&noui
```

- 资产：`https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/finland/lod-meta.json`
- piece0 `viewport` 锚点相机初始位；piece1 `lazy` 偏移 `[1140.309, 0, 0]`
- 预期：初始 `#0 active` / `#1 cold`；飞到 tile-1 后切换 active；离屏 viewport 降为 cold（lodRange 最粗档，entity 不 disable）

### P2：重构 Octree Refinement 为 Resource Group Controller

目标：同一个 octree/resource 只由一个 controller 管下载队列和 priority gate。

改动：

- 新增 `OctreeResourceGroupController`。
- 把当前 `OctreeStreamingScene` 从单 Entity：

```ts
{ app, octree, gsplatEntity, cameraEntity }
```

升级为 group：

```ts
{ app, octree, entities, activeEntities, cameraEntity }
```

- `buildPriorityFiles` 对所有 active entities 做合并：
  - 每个 Entity 使用自己的 world transform。
  - 每个 Entity 使用自己的 runtime octree instance / `nodeInfos`。
  - 相同 fileIndex 去重，score 取 max 或加权 max。
- loader patch / priority gate / queue reconcile 只在 resource group 级运行一次。
- `syncStreamingOctreePlacements` 对 group 内所有相关 instances 标脏并同步。

验收：

- 同一 shared asset 的多个 Entity 同时可见时，只产生一个合并后的 priority URL 集合。
- controller 数量按 unique octree/resource 计数，而不是按 Entity 数计数。
- 不再出现多个 controller 竞争同一 loader 的 gate 状态。

### P3：全局预算与驻留策略

目标：让 billions 量级在可控下载、内存和显存内运行。

改动：

- 新增全局 `GsplatStreamingBudget`：

```ts
type GsplatStreamingBudget = {
    maxActiveRegions: number;
    maxWarmRegions: number;
    maxForegroundFiles: number;
    maxConcurrentLoads: number;
    maxResidentBytes: number;
    maxActiveSplats: number;
};
```

- Region Scheduler 先分配 region 预算。
- Resource Group Controller 再分配 file / LOD 预算。
- LodResourcePool 从单 octree 视角扩展为全局或 group-aware resident pool。

验收：

- region 数量增长时，活跃下载数不线性增长。
- 相机快速飞行时，旧 region 的 in-flight / queued URL 能被降级或软取消。
- 显存和 resident file 数有上限。

### P4：功能集成与兼容

需要逐步接入的模块：

| 模块 | 改造点 |
|------|--------|
| scene bound / camera farClip | 从单 `primary` AABB 改为 region AABB 合并 |
| reveal | 初期只支持 primary 或 active region；后续支持多 Entity reveal |
| night mode / persistent effects | 从单 splat 引用扩展为 region 列表 |
| shadow / collision | scene mesh 与 gsplat region 解耦，避免重复绑定 |
| picker | 多 region 下选中返回 region/entity id |
| benchmark | 增加 region 激活数、resource group 数、共享 asset 命中率 |

---

## 5. 推荐实施顺序

| 阶段 | 内容 | 预估风险 |
|------|------|----------|
| P0 | Asset cache + manifest transform + 小规模 shared asset 验证 | 低 |
| P1 | Region Scheduler，只做 Entity 级 active/warm/cold | 中 |
| P2 | Resource Group Controller，重构 priority 合并和 loader gate | 高 |
| P3 | 全局预算 / resident pool / stale 下载治理 | 中高 |
| P4 | VFX、picker、benchmark、文档和工具链补齐 | 中 |

建议不要先做 P2。先用 P0/P1 验证 PlayCanvas shared asset 与现有 viewer 的兼容性，再进入资源组 controller 重构。

---

## 6. 为什么千万级不急，十亿级必须做

千万级场景通常仍能用单 asset / 少量 asset 承载：

- 文件数量少。
- octree node 数量有限。
- refinement 队列长度可控。
- 主要瓶颈是渲染预算、排序、GPU buffer。

billions 量级的主要瓶颈变成：

- 区域数量巨大。
- 文件数量巨大。
- 冷启动和快速移动时下载队列被旧视角污染。
- 单个全局 controller 难以表达场景级区域取舍。
- 所有区域都进入 octree refinement 会导致 CPU 调度成本和 loader 队列膨胀。

因此，billions 支持的核心不是「一个更激进的 LOD 参数」，而是：

```Plain Text
先减少参与调度的区域
再对少数 active resource 做精细 refinement
```

---

## 7. 关键风险

### 7.1 多 controller 共享 loader

当前 refinement 会 patch loader queue / gate。多个 controller 管同一 octree 会互相覆盖状态。必须通过 resource group controller 收敛为一个 owner。

### 7.2 共享 resource 下的 transform 差异

同一个 octree resource 的 nodeBounds 是 local space。多个 Entity transform 不同，priority 必须逐实例计算，再按 fileIndex 合并。

### 7.3 首屏完成语义

现有 multi-piece 需要全部 piece finalize 才 firstFrame。billions 场景不能等全部 region，应该只等当前视口 active region 的 worst/coarse LOD。

### 7.4 VFX 单 Entity 假设

reveal / night mode / persistent effect 当前主要围绕 `primary` gsplatEntity。billions 支持初期应明确：

- 只对 primary / active main region 生效；或
- 暂不支持全局多 region VFX；或
- 增加 multi-target effect registry。

---

## 8. 验收指标

建议新增以下调试指标：

| 指标 | 含义 |
|------|------|
| `regions.total` | manifest 中 region 总数 |
| `regions.active` | 当前参与 refinement 的 region 数 |
| `regions.warm` | 当前保留粗级或预热的 region 数 |
| `resourceGroups.total` | unique asset/resource 数 |
| `resourceGroups.sharedInstances` | 共享 asset 下 Entity 数 |
| `streaming.priorityFiles` | 当前前景 priority unique file 数 |
| `streaming.staleQueued` | 旧视角排队 URL 数 |
| `streaming.staleInflight` | 旧视角 in-flight URL 数 |
| `resident.bytes` | resource pool 驻留估算 |
| `frame.gsplats` | 当前上屏 splat 数 |

基础验收：

- 100+ region manifest 不导致首屏等待所有 region。
- 同 asset 多 Entity 不重复下载 asset meta。
- 同 resource group 下只有一个 refinement owner。
- 快速移动时 foreground priority 能切换到新视角。
- active region 数受预算约束。

---

## 9. 结论

引入 PlayCanvas billions 示例机制是可行的，但应作为架构演进，而不是脚本移植。

推荐方向：

```Plain Text
P0: 共享 Asset cache
P1: Region Scheduler
P2: Resource Group Refinement
P3: 全局预算与驻留治理
```

最小可验证版本只需要改加载层和 manifest；真正支撑十亿级的版本必须把 refinement 从 per-entity 改成 per-resource-group，并在其上增加 region 级调度。

---

## 10. 实施进度（2026-06-25）

| 阶段 | 状态 | 说明 |
|------|------|------|
| P0 | ✅ | Asset cache + manifest transform |
| P1 | ✅ | `RegionScheduler` active/warm/cold |
| P2 | ✅ | Resource group primary controller + 合并 priority |
| P3 | ✅ 初版 | `GsplatStreamingBudget` + `resolveGsplatStreamingBudget()`；settings / URL 可配 `maxActiveRegions` 等；budget 覆盖 refinement tunables；`OctreeStreamingSnapshot` 聚合 stale/priority 队列 |
| P4 | ⚠️ 部分 | benchmark `streamingMetrics` 落盘；HUD Streaming 行；picker `regionIndex`/`regionId`；AABB 合并已有；reveal/nightMode 仍 primary |

P3 配置示例（`settings.sceneProfile.streamingBudget` 或 URL）：

```json
{
  "streamingBudget": {
    "maxActiveRegions": 12,
    "maxWarmRegions": 28,
    "maxForegroundFiles": 48,
    "maxConcurrentLoads": 8,
    "maxResidentBytes": 536870912
  }
}
```

URL：`?maxActiveRegions=8&maxWarmRegions=24`

P4 benchmark 导出字段：`streamingMetrics.regions` / `resourceGroups` / `streaming`（含 `staleQueued`、`staleInFlight`、`poolResidentCount`）。

