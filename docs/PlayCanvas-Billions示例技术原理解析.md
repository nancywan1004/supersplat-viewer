# PlayCanvas Billions 示例技术原理解析

> 解析对象：PlayCanvas 官方 `examples/src/examples/gaussian-splatting/billions.example.mjs`。  
> 参考源码：<https://github.com/playcanvas/engine/blob/main/examples/src/examples/gaussian-splatting/billions.example.mjs>  
> 日期：2026-06-24

---

## 1. 示例实际做了什么

`billions.example.mjs` 的目标是展示 PlayCanvas 可以渲染「总 splat 数达到 billions 量级」的超大世界。它并不是加载一个真实的十亿点唯一场景，而是：

```Plain Text
加载一份 Poland village multi-LOD streamed gsplat asset
创建 N 个 gsplat Entity
每个 Entity 指向同一个 asset
把这些 Entity 按网格 / 圆柱布局摆开
依靠每个实例的 LOD streaming 只显示当前需要的点
```

核心代码模式可以概括为：

```ts
const assets = {
    scene: new pc.Asset('gsplat', 'gsplat', { url: config.url })
};

const entity = new pc.Entity(`${config.name}-${idx}`);
entity.addComponent('gsplat', { asset: assets.scene });
entity.setLocalEulerAngles(eulerX, 0, 0);
entity.setLocalPosition(pos[0], pos[1], pos[2]);
```

关键点：

- `assets.scene` 只有一份。
- `Entity` 可以有很多个。
- 每个 Entity 共享同一个 `GSplatResource`。
- 每个 Entity 有自己的 world transform。

因此，示例中的 billions 是：

```Plain Text
numSplatsPerInstance * instanceCount
```

而不是：

```Plain Text
一次性加载 numSplatsPerInstance * instanceCount 个唯一 splat 数据
```

---

## 2. 核心机制

### 2.1 Asset / Resource 共享

PlayCanvas 的 `Asset` 是资源加载入口。多个 component 引用同一个 `Asset` 时，底层资源不会为每个 Entity 重复下载和解析。

在 billions 示例中：

```Plain Text
Asset(scene)
  resource: GSplatResource
    octree
    files
    aabb
    numSplats

Entity 0 -> gsplat.asset = Asset(scene)
Entity 1 -> gsplat.asset = Asset(scene)
Entity 2 -> gsplat.asset = Asset(scene)
...
```

这种结构减少的是：

- 重复网络请求。
- 重复 meta 解析。
- 重复底层 resource 创建。
- 相同数据的重复驻留。

但它不会减少每个 Entity 的：

- transform 计算。
- 可见性判断。
- LOD instance 状态。
- 渲染提交与排序相关成本。

### 2.2 Entity 作为实例调度单元

每个 Entity 都是一个独立空间实例：

```Plain Text
同一份 local-space octree
  Entity A: transform A
  Entity B: transform B
  Entity C: transform C
```

LOD 判断时需要把相机和 bounds 放到每个实例自己的空间关系下计算。相同 local node 在不同 Entity 下，可能有不同可见性和不同屏幕尺寸。

所以共享 asset 不等于共享 LOD 结果：

```Plain Text
共享：
  - asset/resource
  - octree metadata
  - physical file data

不共享：
  - world transform
  - per-instance visibility
  - per-instance nodeInfos / currentLod / optimalLod
```

### 2.3 LOD ramp 抑制活跃点数

示例没有靠 `splatBudget` 强行限制全部点数，而是主要靠每个实例的 LOD 距离曲线：

```ts
gs.lodBaseDistance = base;
gs.lodMultiplier = mult;
```

含义可以简化为：

```Plain Text
离相机近的实例:
  允许更细 LOD

离相机远的实例:
  快速掉到粗 LOD
```

当实例数量增加时，远处实例虽然理论 splat 总数巨大，但实际 active splat 数不会线性增长到总量，因为大部分远处实例只停留在粗档。

### 2.4 首帧 worst LOD

示例在启动时先锁定最低清晰度档：

```Plain Text
lodRangeMin = worstLod
lodRangeMax = worstLod
```

等第一帧需要的最低档数据 ready 后，再打开完整范围：

```Plain Text
lodRangeMin = 0
lodRangeMax = worstLod
```

这个策略的意义是：

- 首屏先出现完整但很粗的世界。
- 避免启动阶段直接追细档，把下载队列打爆。
- 让用户先获得空间感，再逐步 refinement。

### 2.5 LOD 更新频率放宽

示例把 `lodUpdateDistance` 设得较大。原因是实例世界很大，默认很小的移动阈值会导致 LOD 过于频繁地重评估。

这说明 billions 量级下的优化重点之一是：

```Plain Text
不要每个小相机移动都让全部实例重算 LOD
```

对大场景来说，应按场景尺度调节：

- LOD 重评估距离。
- LOD 重评估角度。
- active region 切换阈值。
- 下载 priority 更新频率。

---

## 3. 为什么它能显示 billions 量级

这个示例的成立依赖四个条件。

### 3.1 总点数巨大，但 active 点数受控

理论总点数：

```Plain Text
totalSplats = splatsPerInstance * instanceCount
```

但实际每帧渲染：

```Plain Text
activeSplats = 当前可见实例在当前 LOD 下的 splat 数之和
```

由于 LOD ramp，远处和边缘实例使用粗档，`activeSplats` 远小于 `totalSplats`。

### 3.2 资源数据复用

复制 50 个 Entity 不等于下载 50 份 asset。共享 asset 让资源本体只加载一次。

因此示例的内存模型更接近：

```Plain Text
1 份资源数据
+ N 份实例状态
+ 当前 LOD 所需的 file/resource 驻留
```

而不是：

```Plain Text
N 份完整资源数据
```

### 3.3 Streaming 只追当前需要的文件

multi-LOD streamed gsplat resource 通常由 meta + 多个 LOD 文件组成。运行时根据视角追文件，不把所有细档一次性拉完。

实例越多，越需要依靠：

- 视锥裁剪。
- 距离 LOD。
- 屏幕贡献度。
- 下载队列优先级。
- 已驻留资源复用。

### 3.4 WebGPU / GPU sort 提供更高上限

示例偏向 WebGPU，并使用 GPU-sort raster 路径。高 active splat 数下，GPU sort 能降低 CPU 排序瓶颈。

这不是 billions 机制本身，但决定了示例能在更高 active splat 下保持交互。

---

## 4. 它不是我们最终场景，但有工程启发

### 4.1 示例的局限

官方示例是重复同一个 capture：

```Plain Text
same village asset
  copied to many positions
```

真实大场景通常是：

```Plain Text
city region A: unique asset A
city region B: unique asset B
city region C: unique asset C
shared building / tree / prop: reusable asset D
```

因此不能期待「一个 asset 共享给整个城市」。

### 4.2 可迁移的部分

真正值得迁移的是：

| 示例机制 | 大场景中的对应改造 |
|----------|--------------------|
| 多 Entity 指向同一 asset | 共享资产、重复结构、公共粗层复用 |
| Entity 有独立 transform | 区域块 / 实例块成为调度单元 |
| worst LOD 首帧 | 当前视口 active region 先显示粗层 |
| per-instance LOD ramp | 不同区域根据距离和屏幕贡献独立降档 |
| 大尺度 lodUpdateDistance | 按场景尺度控制调度频率 |

### 4.3 不应照搬的部分

不建议照搬：

- 圆柱布局。
- 同一场景复制 N 次作为真实大场景方案。
- 对每个 Entity 都开独立 refinement controller。
- 用总 splat 数作为真实唯一数据规模指标。

---

## 5. 对 Supersplat Viewer 的含义

现有 viewer 已经有 multi-piece，但它是：

```Plain Text
多个 piece
  每个 piece 独立 asset
  每个 piece 独立 bootstrap/refinement
```

billions 机制要求进一步拆开：

```Plain Text
Entity instance layer
Asset / Resource sharing layer
Resource group refinement layer
Region scheduler layer
```

也就是说，要从：

```Plain Text
piece == asset == entity == controller
```

演进为：

```Plain Text
region entity: 多个
asset/resource: 可共享
controller: 按 unique resource group
scene scheduler: 按 region priority
```

---

## 6. 为什么对十亿级明显，对千万级不明显

### 6.1 千万级瓶颈

千万级场景通常还是少量资源：

```Plain Text
1 个或少数 gsplat asset
有限 octree nodes
有限 files
```

这时主要瓶颈是：

- active splat 数。
- 排序成本。
- shader / overdraw。
- GPU buffer 和显存。

多 Entity + shared asset 对这些瓶颈帮助有限，甚至会增加少量 component / instance 状态成本。

### 6.2 十亿级瓶颈

十亿级场景的问题变成：

```Plain Text
区域很多
文件很多
调度队列很长
旧视角请求容易占槽
单个全局资源太大
```

这时最有效的优化是：

```Plain Text
先按 region 剔除绝大多数区域
再对少数 active region 进行 refinement
```

这正是 Entity 实例层的价值：它提供一个比 octree node 更粗、更便宜的场景级调度边界。

---

## 7. 推荐抽象

### 7.1 三层模型

```Plain Text
Scene Region Layer
  大场景区域 / 重复实例 / 可见性 / 优先级

Resource Group Layer
  shared asset / octree / loader / resident pool

Octree Node Layer
  node LOD / file priority / placement / sync
```

### 7.2 调度流程

```Plain Text
每帧或低频 tick:
  1. Region Scheduler 根据相机选 active regions
  2. 按 resourceKey 聚合 active regions
  3. 每个 Resource Group 合并多个 Entity 的 node/file priority
  4. loader 只按合并后的 priority URL 集合下载
  5. 文件 ready 后 sync group 内相关 instances
  6. 非 active regions 降级、冻结或释放
```

---

## 8. 结论

PlayCanvas `billions.example.mjs` 的技术价值不在于它复制了一个村庄，而在于它证明了：

```Plain Text
GSplat resource 可以被多个 Entity 实例共享
LOD streaming 可以基于实例 transform 分别调度
总数据规模可以远大于当前 active splat 数
```

对真实大场景，应该把这个机制改造成：

```Plain Text
多区域 Entity
+ 共享 Asset cache
+ Resource Group Controller
+ Region Scheduler
+ 全局预算 / 驻留治理
```

这样才能把 billions 量级的问题从「一个巨大资源内部无限 refinement」变成「大量区域中只让少数相关区域参与 refinement」。

