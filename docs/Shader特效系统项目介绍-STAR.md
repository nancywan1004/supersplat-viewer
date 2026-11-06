# 3DGS Shader 特效系统 · 项目梳理（STAR）

> 用于个人网站的项目介绍。按 STAR 组织：**先讲清四类特效为什么不是同一件事，再讲共用底座与仲裁机制，然后按四类分别讲实现，最后给难点、结果与取舍。**
>
> 代码里的四条轨道与产品分类一一对应：
> `stylization`（风格化 7 个）/ `scene`（可持续 4 个）/ `camera`（镜头 3 个）/ `reveal`（开场 8 个，本文详述 5 个）。

---

## 0. 一句话概述

在 PlayCanvas + 3DGS 上做一套 **14 个可持续特效 + 8 个开场特效** 的着色器系统，覆盖从"整场变成水彩画"到"下雪"到"场景从地面长出来"。

核心难点不在单个特效的算法，而在于：**所有这些效果都要挤进同一个 `gsplatModifyVS` 槽位、都要和夜景/辉光/流式 LOD 共存、都要在 WebGL/WebGPU 双后端一致、都要可序列化可导出**。所以这个项目的真正产出是**一套分层注入 + 贡献者仲裁 + 生命周期契约**，18 个特效只是它的使用方。

---

## 1. Situation：四类特效为什么不能一起做

### 1.1 产品视角的四类

| 类别 | 数量 | 用户心智 | 生命周期 | 代码轨道 |
|---|---:|---|---|---|
| **风格化滤镜** | 7 | "把整个画面变成某种画风" | 常驻，直到关掉 | `stylization` |
| **可持续特效** | 4 | "场景里有微光/在起伏/有蝴蝶" | 常驻，可暂停 | `scene` |
| **镜头特效** | 3 | "在下雪/下雨/落花瓣" | 常驻，跟随相机 | `camera` |
| **开场特效** | 5（+3） | "打开时的一段揭示动画" | 一次性，播完即走 | `reveal` |

### 1.2 技术视角：这四类的"作用层"完全不同

这是整个系统设计的分水岭——**它们不是同一个管线上的四个开关**：

| 类别 | 主要作用层 | 是否改 splat 数据 | 是否碰全屏后处理 |
|---|---|---|---|
| 风格化（多数） | **全屏 post**（`composePass.sceneTexture` 或 `camera.postEffects`） | 否 | 是 |
| 风格化（2 个） | splat hook + 全屏 + 天空盒 | 是 | 是 |
| 可持续（2 个） | **`gsplatModifyVS` 分层贡献** | 是（几何 + 颜色） | 否 |
| 可持续（2 个） | **独立 additive Layer + billboard Mesh** | 否 | 否 |
| 镜头（雪/雨） | **程序化 splat 场 + 专属 Layer** | 否（自己造 splat） | 否 |
| 镜头（花瓣） | **单 Mesh（World 层）** | 否 | 否 |
| 开场 | **整段独占 `gsplatModifyVS`** | 是 | 否 |

同一个"特效"标签下，有的改顶点、有的改像素、有的造几何、有的抢 chunk。**如果按"特效"来做架构，一定会互相踩**。

### 1.3 五个结构性难点

| # | 难点 | 具体表现 |
|---|---|---|
| 1 | **单一注入槽** | `gsplatModifyVS` 是材质上的**一个** chunk，只能整段写一份。夜景、波纹、点彩、开场全想写它 |
| 2 | **splat 没有法线、没有面** | 钢笔素描的排线方向、水彩的边缘暗化，都没有几何可以依附，只能用**图像空间结构**代替 |
| 3 | **半透明 + 深度排序** | 改 splat 中心点会破坏排序键；改 alpha 制造半透明堆叠会出现"雾状层" |
| 4 | **双后端** | WebGL 用 GLSL、WebGPU 用 WGSL，且 WGSL 有 `inout→ptr`、纹理采样器成对、无隐式类型转换等硬差异 |
| 5 | **时序** | 开场特效必须"播完才能放行标注/资产/辉光/摇杆"；夜景必须在开场时让位再回来；导出要能 scrub 任意时间点 |

---

## 2. Task：目标与约束

### 2.1 目标矩阵

| 目标 | 验收方式 |
|---|---|
| 四类特效都能独立开关、参数可调 | UI schema 与 settings 一一对应 |
| 同类互斥、异类共存有确定规则 | 同一时刻不出现"两个特效抢同一 chunk"导致的黑片 |
| 任意场景尺度、任意时长都能"刚好播完" | 开场特效统一由 bbox → 半径 → 反算速度/时长 |
| 编辑态 = 观看态 = 导出态 | 导出按时间 scrub，暂停时也不掉帧 |
| 关闭后完全无残留 | chunk / Layer / clearColor / exposure / autoRender 全部可还原 |

### 2.2 四类轨道的关系（代码里的真实约束）

| 轨道 | 多选？ | 说明 |
|---|---|---|
| `scene`（可持续 4 个） | **可多选** | 微光 + 波浪 + 蝴蝶可同时开 |
| `camera`（镜头 3 个） | **互斥** | 雨/雪/花瓣只留一个（大气参数会互相覆盖） |
| `stylization`（风格化 7 个） | **互斥** | 切换时只关 `enabled`、**保留各自 `effectParams`**，来回切即恢复 |
| `reveal`（开场） | **独占** | 播放期间其它改 splat 的特效必须让位 |

---

## 3. Action

### 3.1 共用底座：四个注入点

所有特效最终落在四个位置之一，这是整个系统的"（硬件）总线"：

```
① 材质 chunk        gsplatModifyVS   ← 改 splat 顶点/颜色（夜景、波纹、点彩、开场）
② work buffer       unified 模式      ← per-entity 着色，不污染同层其它实例
③ 独立 Layer        additive billboard ← 微光、蝴蝶、雪、雨（叠在 splat 之上）
④ 全屏 post         compose 纹理      ← 风格化滤镜（不改 splat）
```

第 ③ 层的关键设计是 **Layer 顺序**：新建层并插到 `World` 透明项之后（`layers.insert(layer, layers.getTransparentIndex(world) + 1)`），这样 billboard 一定叠在 splat 之上，不需要深度补偿。

### 3.2 仲裁：从"抢 chunk"到"贡献者协议"

这是整套系统的地基。规则按优先级从强到弱：

| 规则 | 行为 |
|---|---|
| **`full` 覆盖一切** | 只要存在整段写入（开场 reveal），**丢弃全部 layered 贡献** |
| **独占组互斥** | 声明 `exclusiveWithLighting` 的多个贡献者，只保留 `priority` 最高的 |
| **容量截断** | scene 槽位按 priority 降序取前 N，超出的降级并记诊断 |
| **拼接顺序** | 按 `priority` **升序**拼进三个函数体（数值小的先执行） |

当前优先级分配：

| 贡献者 | priority | 类型 |
|---|---:|---|
| NightMode | **100** | full / exclusive |
| pointillism-stipple | 30 | layered（`allowConcurrentWithPersistent`） |
| overall-wave | 21 | layered |
| perlin-wave | 20 | layered |

scene 槽位容量按"夜景 1 + 全部 persistent"给足：`1 + 14 = 15`（composer 默认只有 2，这里必须显式调大）。

> **一个反直觉的结论**：夜景和波纹**可以共存于同一个 chunk**——因为波纹是 layered 且非 exclusive。仲裁只在"多个 exclusive"之间发生。这也解释了为什么点彩能和夜景同开，而开场 sketch 一播就必须让夜景退出。

### 3.3 风格化滤镜（7 个）：三条技术路线

#### 路线划分

| 滤镜 | 路线 | 关键手段 |
|---|---|---|
| palette-pixel | **纯全屏** | 调色板量化 + 场景明度域自适应 |
| nostalgic-comic | **纯全屏** | 阶梯色调 + Sobel 描边 + 双色映射 |
| pen-sketch | **纯全屏（4 pass）** | 结构张量方向场 + 分层排线 |
| watercolor | **纯全屏（1+5 pass）** | 湿扩散 + 边缘暗化 + 纸纹 |
| charcoal-sketch | **纯全屏（单 pass）** | 涂抹 + 三向排线 + 炭粒噪声 |
| yiyun-dianran | **splat + 全屏** | 三点概率换色 + 笔触拉长 + 版画全屏 |
| pointillism-stipple | **splat + 全屏 + 天空盒** | 屏幕恒定点径 + 密度哈希抽稀 + 三处一致性 |

#### 三个值得单独讲的算法

**① palette-pixel：先测画面，再决定量化到哪一段**

固定调色板最大的问题是"场景本身很暗/很亮时，量化后全糊在一片"。做法是 CPU 侧**异步读回 48×48 采样**估画面 luma 域（每 24 帧一次，`levelRange==1` 时直接跳过），把 luma 域映射到"该调色板行实际占用的索引段"。

量化不重建 alpha——它作用在**已完成 alpha 混合的 scene texture** 上，所以柔边表现为"混合结果被吸附到最近色阶 + ±0.04 白噪声抖动"。

> 注意口径：它是**白噪声抖动，不是 Bayer/ordered dithering**；输出 `alpha = 1.0`。

**② pen-sketch：没有法线，就用图像结构张量代替**

这是全项目最能体现"3DGS 约束下的算法设计"的一处：

```
9 邻域梯度 → 外积累加成结构张量 J = [gx², gxgy; gxgy, gy²]
→ doubled = (Jxx−Jyy, 2Jxy)，anisotropy = |doubled|
→ axis = doubled / anisotropy        ← 主梯度方向
→ coherence = anisotropy / energy    ← 该方向可不可信
→ 笔触方向 = axis 的垂直方向（等照度线方向）
```

再配合三件事让"线"看起来像手绘：
- **角度量化到 30°** 再镜像到同一半平面（避免线条在阈值边界抖动）；
- **置信度低时回退**到 10° 兜底方向（`mix(vec2(0.9848,0.1736), tangent, conf)`）；
- **方向场先做一次 confidence 加权模糊**，把方向"抹顺"。

排线是三层（主线 + ±10° 交叉 + 深部 5° 加密），由色调阶梯阈值 0.02/0.43/0.72 控制；每笔有**两端 taper（收笔）**、`pressure` 变线宽、`feather` 羽化——这是"像真钢笔"而非"像自动描边"的关键。

整条分析链跑在 **0.25 分辨率**，主 pass 才全分辨率。

**③ pointillism-stipple：三处一致性是核心难点**

点彩要同时覆盖 splat、全屏、天空——三者投影语义不同，但视觉上必须像"同一支笔点的"：

| 层 | 做法 |
|---|---|
| splat | `modifySplatRotationScale` 把球改成**屏幕恒定 px 的圆盘**：`screenTypical = viewDist × slope`，`slope` 由 CPU 用 `pxToSlope = px·2tan(fov/2)/canvasH` 反算 → 点径与距离无关 |
| 密度 | 世界空间 bucket hash 抽稀：`bucketHash > keepChance → color.a = 0`，`keepChance` 随距离衰减（近密远稀），避免 overdraw 爆炸 |
| 形状 | 在 `gsplatModifyPS` 里做圆盘遮罩：`A = dot(shapeUV,shapeUV); if (A>1) a=0`，再拉成笔触椭圆 + 三层 value noise 做颜料颗粒 |
| 天空 | 天空不是 splat，走不到 `gsplatModify*` → 只能把点彩代码插进引擎 `skyboxPS` chunk，按**球面方向网格**点 |
| 补偿 | 球面 UV 与 splat 投影语义不同 → 用 `skyDotVisualMatch = 3.3` 补偿；全屏 post 的平整化会抹掉天空笔触 → 专门做天空保护与回混 |

**为了让 splat 点彩不被全屏 post 抹掉**，post 侧做了：去斑点 → 补空洞（7×7 邻域加权）→ 内部平整化（5×5 双边式）→ 结构边缘保留 → 锐化。

#### 纸纹系统：三处复用，零贴图

pen / watercolor / charcoal 三个共用一套 `stylisation-paper-*`：

| 关注点 | 做法 |
|---|---|
| 纸纹来源 | **纯程序生成**（fbm + value noise），零贴图 |
| 与画面混合 | 不是全局 overlay：`mix(paper, ink, coverage)`，纸纤维**只在无颜料区可见** |
| 背景 | `camera.clearColor = 纸色`（关掉时快照还原） |
| 坐标系 | **固定屏幕空间**（`vUv0`）——这是"画在一张纸上"的正确观感，也省掉重投影 |
| 共用理由 | 三者"挂载 / clearColor / reveal 挂起 / 夜模式重挂"逻辑完全同构，抽出后每个滤镜只剩 `PostEffect` + fragment |

### 3.4 可持续特效（4 个）：两种范式

| 特效 | 范式 | 注入点 | 改几何 |
|---|---|---|---|
| sparkle-twinkle | **独立 additive billboard 层** | 不走 `gsplatModifyVS` | 否 |
| butterfly-particle | **相机子节点 billboard Mesh** | 同上 | 否 |
| overall-wave | layered 贡献 | `Center` + `Color` | 是 |
| perlin-wave | layered 贡献 | `Center` + `Color` | 是 |

#### sparkle-twinkle：如何让"局部"随机闪而不是整体呼吸

三步，每一步都针对一个具体故障：

| 步骤 | 做法 | 防的问题 |
|---|---|---|
| 选点 | 世界空间网格量化 + 三重整数哈希抽稀，每个 cell 只留离抖动中心最近的 splat | 直接在 splat 上闪会导致密度不均、成团 |
| 相位 | **CPU 用世界坐标 hash 生成相位**，写进顶点属性 `TEXCOORD1` | 用 index 或时间会导致整体同步闪 |
| 亮度 | 双频 sin 叠加（`sin(t·s+φ)·0.65 + sin(t·1.37·s+φ₂)·0.35`）再 `pow` 锐化 | 单频 sin 是"呼吸"，不是"闪" |

`twinkleMin` 保住底光（不会全灭），`soft` 做圆盘径向衰减，`colorBlendMode` 在"每点独立随机色 + 独立周期"和"全场同周期同色"之间切换——这是给设计师的观感 A/B。

规模自适应：上限 6000 光点；源点 > 12 万时按 stride 抽样；密度/点径随 bbox 半径 `1→3` 缩放。

#### overall-wave：两套样式，一套衰减

| 样式 | 算法 |
|---|---|
| `雾涌起伏` | 3D value noise 双频混合，只做垂直起伏 |
| `逐浪传行` | 沿 `waveDirection` 的行波：3 个 octave（1 / 2.4 / 5.1）做 `crestBend` 相位扰动 + `surgeNoise` 破规则，最终 `g_offset = travel · h`（只沿传播方向推） |

这是四个可持续特效里**唯一带距离衰减**的：`atten = 1/(1 + 0.006·dist)`。

#### perlin-wave：最简单的那个，也留下了明确技术债

单层 3D value noise + `sin3D` 颜色调制，世界坐标驱动，是"云状漂移"。

> **已知限制（诚实记录）**：`scaleBlend` / `uEndRadius` / `g_dist` 三个量在 shader 里**声明但从未消费**，JS 仍每帧上传 → 无效 uniform；因此 perlin **无半径裁切、无距离衰减、无多 octave**。

#### butterfly-particle：不是粒子系统，是"程序化生物"

5200 个点，5 类 part（体 / 前翅 / 后翅 / 须 / 腿），全部**用参数化曲线生成后缓存**（`TEMPLATE_VERSION = 27` 说明模板迭代了 27 版）：

- 体块用椭球 + `radial = hash^0.62`（近中心更密）；
- 翅面用 `spanFactor` + `rootBias = pow(depth, 0.82)` 控制翅根到翅缘的疏密；
- 翅缘做**双频 sin 波浪**（`WING_EDGE_SCALLOP`），这是"蝴蝶翅边"的辨识度来源；
- 动画全在 CPU：绕铰链 2D 旋转 + `spanWeight = 0.32 + 0.68·wingCoord`（翅根也动，避免"只翅尖在扇"）+ 高频 ripple + 体节多频 bob；
- 移动时扇翅加速（amp `0.25 → 1.05`），拖尾光屑有完整生命周期（0.88 s 寿命 / 重力 0.52 / 上限 1400）。

> 代价：每帧 O(5200) 动画 + 顶点重写 + 拖尾 mesh 每帧 `new Float32Array`——这是主要 GC 压力点。

### 3.5 镜头特效（3 个）：世界锚定的跟随

三个都挂在**相机跟随实体**上，但跟随方式决定成败——**跟不好就会露馅成"粒子贴在镜头上"**。

#### 雪/雨：不是 mesh，是"程序化 splat 场"

| 关注点 | 做法 |
|---|---|
| 几何 | 建一个 `GSplatContainer`（默认 **93,312** 个 splat），每个 splat 只存"自己在格子里的整数索引"（RGBA8 纹理） |
| 运动 | 全在 `GSplatFormat.readGLSL` 的 GPU 端：`getCenter/getColor/getScale/getRotation` |
| CPU 成本 | 每帧只写 **15 个 uniform**，无逐帧 CPU 写 |
| 形态 | 雨 = `elongate 20` 各向异性拉长 + 高速直线；雪 = `elongate 1` 圆点 + 慢飘 + 可选翻滚。**无纹理** |

#### 花瓣：烘焙式 instancing

6000 个 quad 烘焙进**一个 Mesh**（24k 顶点 / 36k 索引 / **1 个 draw call**），每花瓣的种子走 `TEXCOORD1..3`；形态靠 4×4 spritesheet + 视空间 billboard + 三轴 `roll/tiltX/tiltY`（伪 3D 翻面）。

与雨雪的三个关键差异：

| 维度 | 雨雪 | 花瓣 |
|---|---|---|
| Layer | 专属 `GsplatCameraWeather`（插在透明之后） | **World 层**（不透明阶段） |
| 深度 | 不参与 mesh 深度 | `BLEND_NONE` + `depthWrite` + `alphaTest 0.34` → **与 splat 真实互相遮挡** |
| 贴图 | 无 | 4×4 花瓣 atlas |

#### 跟随而不露馅的三层手法（这是本节的重点）

```
① 相机位置吸附到"整数世界格"（只平移，不旋转盒）
② 粒子的相位/风速/漂移全部由「世界格子坐标」哈希出来
③ 竖向 fract 循环 + 双端 alpha fade，遮住"传送"瞬间
```

因为 hash 的输入是 `worldCell` 而不是相机坐标，**相机挪一格后同一世界位置仍是同一组随机值**——图案不会贴在镜头上。花瓣更进一步用 `wrappedCell` 把每个粒子的世界格 `mod` 回相机周围盒内，**盒子平移时粒子从另一侧再生**，而不是整体平移。

#### 与夜景 / 辉光的交互（容易写错的地方）

| 交互 | 事实 |
|---|---|
| 夜景调暗 | **不作用于天气**——夜景只遍历主 splat 实体的 layers，天气在另一个 entity/Layer |
| 但天气会改全局大气 | `scene.exposure`（预设 0.5 → 整场压暗）、`scene.fog`、`camera.clearColor`，且**快照/还原** |
| 辉光 | 天气参与 bloom（bloom 是相机合成级），但**不参与"局部亮灯体积"**（那是 gsplat 材质级） |
| 代价 | 打开天气会把 `autoRender` 强制设为 `true` → 失去按需渲染省电 |

### 3.6 开场特效（5 个）：单槽位独占 + 时间反算 + 挡板

#### 编排：一个 controller + 一个策略文件

`reveal-policy.ts` 不是"选哪个特效/时长多久"的策略表，而是**三个门控谓词**：

| 谓词 | 作用 |
|---|---|
| `isRevealTimedVfxType` | "一次性" = "非 persistent" |
| `revealBlocksAnim` | 挡不挡动画轨的唯一判定（`autoStart:false` 或 `completed` 则不挡） |
| `nightDeferredByReveal` | 有 reveal 就把夜景首帧应用延后 |

#### 五个特效的算法内核

| 特效 | 一句话 | 关键公式/机制 |
|---|---|---|
| **radial** | 双波扩散，用**改 scale 当可见性开关** | `dotWave` 先到（变成小点）→ `liftWave` 后到（长回原尺寸）；`dist > endRadius` 直接 `makeSpherical(scale, 0)` 隐藏 |
| **rain-v2** | **从地面向上"长"出来**，不是从天上落 | `progress = pow(smoothstep(0,5, t²·0.1 − dist2D·2 + 1), 0.5 + h.x)`；`y = min(bottomY + p·rainHeight, 原y)`；xz 从 30% 外扩回原位 |
| **integrate** | 竖向波前把点云"整合"成 splat，同层 xz 径向弹动 | `tt = smoothstep(0,1, t·speed − yOffset·spread)`；`tt≤0` 隐藏；层波动只在 `0<tt<1` 存在 |
| **growth-wave** | **两阶段**：自下而上聚拢（蓝辉点云）→ 中心向外金色光圈复原 | Phase1 路径叠加 fBM 噪声且强度 `(1-eased)²·10`；Phase2 `recoverProgress = 1 − smoothstep(r−band, r+band, dist)` |
| **sketch** | **先线稿，再上色**，两段波前 | 阶段机 0 隐藏 / 1 素描 / 2 上色 / 3 完成；素描 = `pow(luma, contrast)` → 三向 sin 排线 → 量化 → 纸纤维颗粒 |

> `sketch`（开场）与 `pen-sketch`（风格化）的区别必须说清：前者是**一次性 reveal**，走整段 chunk 写入 + 波前推进 + "素描→上色"时间阶段；后者是**常驻风格化**，走 fullscreen post + 分层贡献，没有揭示语义。

#### 时间反算：任意场景尺度都"刚好播完"

所有特效统一实现 `syncRevealParticipation()`：

```
bbox → 有效半径（padding 0.65）→ 按半径补偿传播速度（0.7）→ 反算 totalDuration
```

以及各自闭式的 `getCompletionTime()`。这一步让"同一个特效放在 300 m 的小场景和 4 km 的大场景里都是 10 秒播完"，而不是"小场景一闪而过、大场景播到一半就结束"。

#### 挡板：怎么防止用户看到半成品

| 层 | 闸门 |
|---|---|
| 首帧 | `readyToRender = true` **之前**就把 shader 装上（不出现"没有特效的一帧"） |
| 内容 | 标注 / 放置资产 / 辉光 / 局部亮灯 / 动画轨 / 触屏摇杆，全部 `revealComplete` 后放行 |
| 收尾 | `revealComplete` 当帧只置状态，**拆脚本 + 恢复夜景延后到 `frameend`** |

最后一条是踩坑改出来的：

> 若立即 `forceReapply` 夜景，可能被同帧 `removeShaders` 覆盖，出现**一帧黑闪**（compute 路径更明显）。

---

## 4. 难点与解法总表

| # | 难点 | 根因 | 解法 | 代价/边界 |
|---|---|---|---|---|
| 1 | 多特效抢一个 chunk | `gsplatModifyVS` 单槽 | 贡献者协议 + priority + layered/full 仲裁 | 需要容量上限与诊断 |
| 2 | 开场与夜景互相覆盖 | 两个系统都整段写 chunk | `nightMode:exit` / `forceReapply` 事件对 + 创建顺序硬约束 | 初始化耦合 |
| 3 | 收尾一帧黑闪 | 同帧 remove 覆盖 reapply | 收尾延后到 `frameend` | 多一帧延迟 |
| 4 | 无面法线的排线方向 | 3DGS 没有几何 | 图像空间**结构张量** + 角度量化 + 置信度回退 | 依赖图像结构，平坦区退化 |
| 5 | 改中心点破坏排序 | 排序基于原始 centers | 风格化**不改 center**（空实现/振幅设 0），只改 scale | 波形类仍会位移（见 #12） |
| 6 | 改 alpha 出现"雾状层" | 半透明堆叠不稳定 | 抽稀用**整点删除**（`a=0`）而非降 alpha；alpha 语义收敛到 1 | 需要 PS 遮罩承担形状 |
| 7 | 点彩三处不一致 | splat / 全屏 / 球面 UV 语义不同 | 统一 `px→slope` 物理量 + `skyDotVisualMatch` 补偿 + 天空保护回混 | 参数耦合度高 |
| 8 | 全屏 post 抹掉 splat 点彩 | 平整化/量化会吃掉细节 | 结构边缘保留 + 天空保护 mask | 多 5 个 pass |
| 9 | 固定调色板在暗/亮场景失效 | 画面 luma 域与调色板不匹配 | 48×48 异步读回估域（24 帧节流） | 异步滞后 |
| 10 | 天气"贴在镜头上" | 相机空间生成粒子 | 世界格吸附 + 世界坐标哈希 + fract 循环 + 双端 fade | 需要 AABB 与 fade 配合 |
| 11 | 雪雨 9 万粒子的 CPU 成本 | 逐帧写顶点 | 走 `GSplatFormat.readGLSL`，CPU 只写 15 个 uniform | 逻辑只能写在 GPU read script |
| 12 | 几何位移与排序冲突 | 排序键未随位移更新 | 控制振幅 + 距离衰减；标注为已知边界 | **未做深度补偿** |
| 13 | WGSL 与 GLSL 语义差异 | 语言限制 | 手写两份 + `inout→ptr` + 显式类型转换 + `getImageEffectUV` 防上下颠倒 | 每加功能写两遍 |
| 14 | 全景 post 成本 | 多 tap 采样 | 分析链降分辨率（0.25×/0.5×）+ RT 复用 + early-out | 需要精度与观感的调参 |
| 15 | 关闭后残留 | chunk / Layer / clearColor / exposure 多处副作用 | 全部快照-还原；`enabled=false` 时按"参数归一化 + 卸载" | 逻辑分散但必须齐全 |

---

## 5. Result

### 5.1 能力矩阵

| 类别 | 特效 | 实现层 | 状态 |
|---|---|---|---|
| 风格化 | palette-pixel | 全屏 | ✅ 调色板 7 组 + 明度域自适应 |
| 风格化 | nostalgic-comic | 全屏 | ✅ 3–7 阶 + Sobel 描边 + 双色 |
| 风格化 | pen-sketch | 全屏 4 pass | ✅ 结构张量方向场 + 三层排线 |
| 风格化 | watercolor | 全屏 1+5 pass | ✅ 湿扩散 + 边缘暗化 + 纸纤维 |
| 风格化 | charcoal-sketch | 全屏单 pass | ✅ 涂抹 + 三向排线 + 炭粒 |
| 风格化 | yiyun-dianran | splat + 全屏 | ✅ 笔触拉长 + 三点概率换色 |
| 风格化 | pointillism-stipple | splat + 全屏 + 天空盒 | ✅ ~30 参数，三处一致 |
| 可持续 | sparkle-twinkle | additive 层 | ✅ 6000 上限 + 双频闪 |
| 可持续 | overall-wave | layered | ✅ 2 样式 + 3 octave + 距离衰减 |
| 可持续 | perlin-wave | layered | ✅ 单层噪声（有未消费参数） |
| 可持续 | butterfly-particle | 相机子节点 Mesh | ✅ 5200 点 + 拖尾 1400 |
| 镜头 | falling-snow | 程序化 splat 场 | ✅ 93,312 splat / 15 uniform 每帧 |
| 镜头 | falling-rain | 程序化 splat 场 | ✅ 各向异性拉长 |
| 镜头 | falling-petals | 单 Mesh | ✅ 6000 quad / 1 draw call |
| 开场 | radial / rain-v2 / integrate / growth-wave / sketch | 独占 chunk | ✅ 统一时长反算 + 挡板 |

（另有 `rain` / `smooth` / `pieces-recover` 三个开场实现在同一框架内。）

### 5.2 性能预算（关键设计）

| 特效 | 主要成本 | 控制手段 |
|---|---|---|
| palette-pixel | 1 tap 场景 + 1 tap 调色板（最便宜） | 48×48 读回 / 24 帧；`levelRange==1` 跳过 |
| watercolor | ~36 taps（3 张纹理 × ~12 次） | 湿扩散压到 0.5 分辨率、3 张 RT 跑 5 遍 |
| pen-sketch | 主 pass 全分辨率 | 分析链 0.25 分辨率、方向场先模糊 |
| charcoal | 单 pass，4 次笔触 + 12 tap 涂抹 | RT 复用 |
| pointillism | 逐 splat PS 遮罩 + 全屏 5 段处理 | 3 处 early-out + uniform 缓存 + 90 帧巡检 |
| 波形 | 每 splat 噪声 | overall `≈48 hash/splat`（最重）；perlin 1 次 noise |
| 雪雨 | GPU per-splat | CPU 每帧 15 uniform，索引一次性烘焙 |
| 花瓣 | 1 draw call | 顶点烘焙 + VS 内 billboard（无逐帧 CPU） |
| 开场 | per-splat ALU | sketch / growth-wave 的 fBM 是高峰成本点 |

### 5.3 工程质量

- **双后端**：7 个风格化里只有 pointillism 需要手写 GLSL+WGSL 两份（splat hook、PS hook、skybox 三处）；其余全屏滤镜共用一套 GLSL 经引擎转译，但避开了"裸 `new Shader` 在 WebGPU 编译失败"的坑。
- **可序列化**：`settings.effects.persistent.{scene|camera|stylization}.paramsById[packId]`，同类切换保留参数。
- **可暂停/可 scrub**：统一 `isPaused` + `setEffectTime`，导出时对所有已挂载脚本强制暂停并设定时间。
- **可还原**：chunk、Layer、clearColor、exposure、fog、autoRender 全部快照-还原。

---

## 6. 复盘：三条判断

1. **先定"作用层"，再谈"特效"。**
   18 个特效能收敛成四类，是因为先按"改顶点 / 改像素 / 造几何 / 抢 chunk"分层。如果按"每个特效一个类"去堆，第 5 个特效就会开始互相踩。
   
2. **仲裁规则要能量化，不能靠约定。**
   `priority` + `layered/full` + `exclusiveWithLighting` 三条规则把"谁让谁"变成了可计算的结果；而"创建顺序"这种靠注释维持的约束，是最脆弱的一环（夜景必须早于 reveal 创建，否则首次 exit 丢失）。

3. **"没有几何"是这套系统的第一性约束。**
   没有法线 → 用图像结构张量画排线；没有面 → 用水彩的边缘暗化伪造纸张吸色；没有实例 → 用烘焙顶点做"手工 instancing"。**每一个看起来像美术效果的实现，背后都是在补一个 3DGS 缺失的几何前提。**

---

## 7. 网站可直接摘用的短版文案

### 版本 A（一段话，约 100 字）

> 为 3DGS 大场景从零搭建 Shader 特效系统，落地 14 个可持续特效与 8 个开场特效：7 种画风滤镜、微光/波浪/蝴蝶、雨雪花瓣、以及径向/生长/整合/素描等揭示动画。核心是分层注入 + 贡献者仲裁机制——让夜景、点彩、波纹、开场动画共存于同一个 splat 着色槽位而不互相覆盖。

### 版本 B（问题-方案-结果，约 200 字）

> **问题**：3DGS 没有面片和法线，且所有特效只能写同一个 `gsplatModifyVS` 槽位；夜景、风格化、天气、开场动画互相抢，且要覆盖 WebGL/WebGPU 双后端。
> **方案**：按"作用层"把特效拆成四类（改顶点 / 改像素 / 造几何 / 抢 chunk），建立四个注入点与贡献者仲裁协议（priority + layered/full + exclusive）；用图像空间结构张量解决"没有法线怎么画排线"；用世界格吸附 + 世界坐标哈希解决"天气跟随相机却不贴脸"；用 bbox→半径→反算速度让开场动画在任意尺度下都刚好播完。
> **结果**：18 个特效共用一套仲裁底座；9 万粒子的雨雪做到 CPU 每帧只写 15 个 uniform；6000 花瓣单 draw call；开场与夜景互斥/恢复无黑闪。

### 版本 C（要点式，适合卡片）

- 建立四层注入点（材质 chunk / work buffer / 独立 Layer / 全屏 post）+ 贡献者仲裁，解决多特效抢同一着色槽
- 用**结构张量方向场**替代不存在的法线，实现钢笔/炭笔的分层排线与收笔羽化
- 点彩在 splat / 全屏 / 天空盒三处统一 `px→slope`，解决跨投影语义的视觉一致性
- 天气特效采用世界格吸附 + 世界坐标哈希 + fract 循环，做到跟随相机而不"贴在镜头上"
- 9.3 万粒子雨雪零逐帧 CPU 写；6000 花瓣单 draw call
- 开场特效统一 bbox→半径→时长反算与"挡板"机制，覆盖 8 种揭示动画

---

## 附：代码索引

### 底座与仲裁

| 模块 | 文件 |
|---|---|
| 特效分类与槽位常量 | `src/vfx/effects-runtime/effect-types.ts` |
| 贡献者协议与仲裁 | `src/vfx/effects-runtime/gsplat-effect-composer.ts`、`gsplat-contribution.ts` |
| chunk 注入底座 | `src/vfx/effects-runtime/gsplat-shader-effect.ts` |
| unified work buffer 注入 | `src/vfx/effects-runtime/gsplat-unified-work-buffer.ts` |
| 管线策略（一次性 vs 持续） | `src/vfx/effects-runtime/effects-pipeline-policy.ts` |
| 参数白名单/序列化 | `src/vfx/effects-runtime/persistent/persistent-effect-params.ts` |
| UI 参数 schema | `src/ui/components/effect-params-ui-schema.ts` |

### 风格化（`persistent/stylisation/`）

`palette-pixel.ts` / `nostalgic-comic.ts` / `pen-sketch.ts` + `-shaders.ts` / `watercolor.ts` + `-shaders.ts` / `charcoal-sketch.ts` + `-shaders.ts` / `yiyun-dianran-stylisation.ts` / `pointillism-stipple-{shaders,post,persistent}.ts` / `skybox-pointillism-*.ts` / `stylisation-paper-*.ts`

### 可持续（`persistent/scene/`）

`gsplat-sparkle-twinkle.ts`、`gsplat-overall-wave.ts`、`gsplat-perlin-wave.ts`、`gsplat-butterfly-particle.ts`（各带 `-shaders.ts`）

### 镜头（`persistent/camera/`）

`falling-weather-persistent.ts`、`gsplat-falling-weather.ts`、`gsplat-falling-petals.ts`

### 开场（`reveal/`）

`reveal-controller.ts`、`reveal-policy.ts`、`effects-orchestrator.ts`、`gsplat-reveal-radial.ts`、`gsplat-rain.ts`（rain-v2）、`gsplat-integrate.ts`、`gsplat-growth-wave.ts`、`gsplat-sketch.ts`、`gsplat-reveal-rain.ts`（v1）、`gsplat-reveal-smooth.ts`、`gsplat-pieces-recover.ts`

### 相关设计文档

- `docs/3DGS点彩NPR渲染内核方案.md` —— 点彩 NPR 的算法与参数体系
- `docs/EFFECT_EXTERNAL_PARAMS_REFERENCE.md` —— 外部可调参数参考
- `docs/Bloom与NightMode适配说明.md` —— 特效与夜景/辉光的顺序约束
