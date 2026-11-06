# 3DGS 大场景重光照系统 · 项目梳理（STAR）

> 本文用于个人网站的项目介绍，按 STAR（Situation / Task / Action / Result）组织：
> **先讲清楚问题为什么存在，再讲目标边界，然后按演进顺序讲每个阶段的选择与代价，最后给结果与复盘。**
> 文中的数值、上限、常量均取自当前代码实现，可直接对账。

---

## 0. 一句话概述

在一套基于 PlayCanvas 的高斯泼溅（3DGS）大场景查看器里，从零搭出一套**适用于高斯泼溅的实时重光照系统**：白天/黑夜全局亮度 → 点光源与聚光灯 → 世界空间笔刷「亮灯区域」→ 局部辉光 → 手电筒，全部在 **WebGL / WebGPU 双后端、编辑态与运行态同链路**下工作，并且可持久化、可被外部编辑器协议驱动。

**核心难点一句话**：高斯泼溅没有面片、没有法线、没有真实光照模型，引擎原生光源对 splat 完全无效——所以这套系统必须自己重建一条"能光照 splat"的渲染支线。

---

## 1. Situation：问题背景

### 1.1 产品形态

- 场景是**城市级/公里级**的 3DGS 重建结果，走 Octree LOD + 流式 refinement，单场景可达亿级 splat。
- 查看器同时支持**编辑态**（可视化调参、放置资产、导出配置）与**观看态**（对外交付的沉浸浏览），两态必须同一条渲染链路，否则"编辑器里看到的"和"交付给客户看到的"不一致。
- 场景配置（`settings.json`）是可序列化交付物，光照必须能被保存、恢复、被外部编辑器通过协议修改。

### 1.2 技术前提：为什么 3DGS 天生"不能被光照"

| 事实 | 后果 |
|---|---|
| splat 是带协方差的半透明椭球，**不是三角面** | 没有面法线，`N·L` 无从算起 |
| 引擎的 LightComponent + clustered forward 只作用于 mesh | 点光/聚光/阴影对 splat **零效果** |
| splat 的颜色来自训练时的烘焙球谐（SH） | 颜色代表"拍摄那一刻的光"，改不了光照方向 |
| 渲染是深度排序 + alpha blending，不是 opaque | 加光照不能靠额外几何 pass，只能改**每个 splat 出屏前的颜色** |

结论：**对 3DGS 做重光照，本质上是在 splat 的顶点/片元阶段插一段自己的着色代码**。这段代码在哪里插、插进去之后和引擎的后处理、LOD、特效系统怎么共存，就是整个项目的技术主线。

### 1.3 起点：从 PlayCanvas 官方 Demo 拆 night-mode

项目第一阶段不是设计一套系统，而是**逆向拆解**：PlayCanvas 官方 demo 里有一个 night-mode 示例，用 GS 材质的自定义 shader 实现"夜晚变暗"。

拆解得到的三个关键认知，成了后续所有工作的地基：

1. **注入点是 `gsplatModifyVS` chunk**——引擎为 GS 顶点阶段留了三个可覆盖的入口：
   `modifySplatCenter` / `modifySplatRotationScale` / `modifySplatColor`。
   其中 `modifySplatColor(vec3 center, inout vec4 color)` 就是"每个 splat 出屏前改颜色"的钩子，**这就是重光照的唯一落点**。
2. **改动必须是"整段覆盖 chunk"而不是打补丁**——`material.getShaderChunks(lang).set('gsplatModifyVS', src)` + `material.update()`，一行换掉整块。代价是必须自己维护完整可编译的 shader，好处是完全可控。
3. **WGSL 不能靠翻译得到**——WebGPU 后端下必须手写一份平行实现（`ptr<function, ...>` 代替 `inout`、纹理与采样器必须成对声明、数组用 `array<vec3f,10>`）。这一点直接决定了后续"每加一个功能就要写两遍"的研发成本模型。

> **这一阶段的产出**：一个能通过滑杆把整场从白天拉到黑夜的 `NightMode` 脚本。
> **这一阶段暴露的问题**：它只是一段"乘一个系数"的 shader，一旦要加灯、加局部效果，整段字符串式的维护方式立刻不够用了——这为后面第 5 阶段的架构收敛埋了伏笔。

---

## 2. Task：目标与约束

### 2.1 能力目标（5 层递进，也是实际开发顺序）

```
L1 全局亮度    白天 ←→ 黑夜连续过渡（含主光、天空球、splat 三方同步）
L2 局部光源    点光源 / 聚光灯，逐 splat 真实衰减，可增删、可 Gizmo 编辑
L3 局部亮灯区  用笔刷在世界空间"画"出亮灯范围，不依赖打灯
L4 辉光        让"亮"的地方真的发光，且支持只让笔刷区域发光
L5 手电筒      跟随鼠标的锥形光，带深度遮挡，可开关
```

这五层的顺序不是拍脑袋：**L1 解决"整体明暗"，L2 解决"光的形状"，L3 解决"不想打灯也能亮"，L4 解决"亮得像灯"，L5 解决"玩家手里的光"**。每一层都依赖前一层已经把"逐 splat 着色"这条路打通。

### 2.2 工程约束（真正决定架构的部分）

| 约束 | 来源 | 对设计的影响 |
|---|---|---|
| **双后端** | WebGL2 + WebGPU 都要跑 | 所有 shader 手写两份；纹理格式取交集（R8 + clamp + 无 mip） |
| **uniform 数量硬上限** | WebGL uniform 数组 + ANGLE 编译稳定性 | 灯数定长写死（点光 10 / 聚光 10），不能"动态加灯" |
| **材质会被引擎重建** | camera move / 光照 hash 变化时 gsplat 重建材质 | uniform 不能"设一次"，必须每帧对材质集合重刷 |
| **一个 chunk 槽多方争用** | Reveal 开场动画、点彩等 VFX 也改 `gsplatModifyVS` | 需要互斥仲裁机制，不能各自 set/delete |
| **编辑态/观看态同链路** | 交付一致性 | 后处理管线是否挂载不能看"参数存不存在"，要看"有没有真实贡献" |
| **每帧预算** | 亿级 splat，CPU 侧还有 LOD 调度 | 所有逐 splat 逻辑必须 O(1)；CPU 侧烘焙必须可缓存 |

---

## 3. Action：演进路径与每一步的取舍

> 下面每一阶段都按「问题 → 思路 → 关键实现 → 代价/取舍」写。这是项目里真正发生的事，也是最能体现工程判断的部分。

### 阶段 1 · 全局亮度：把 demo 的 shader 变成可用的调光

**问题**：demo 只是把颜色乘一个暗色。真实需求是"从白天连续过渡到黑夜"，而黑夜不只是 splat 变暗——主方向光和天空球也得跟着降，否则会出现"地面黑了但天空还亮着"的割裂。

**思路**：定义单一控制量 `nightFade ∈ [-1, 1]`（0 = 中性，-1 = 全黑，+1 = 过曝提亮），让 splat、主光、天空球**同源驱动**。

**关键实现**（`src/vfx/lighting/night-mode.ts`）：

在线性空间做乘算，再回 gamma 写出：

```glsl
vec3 linearColor = g2l(color.rgb);
float f = uNightFade;

if (f > 0.0) {                                    // 调亮
    vec3 baseBright = mix(vec3(1.0), vec3(uBrightFactor), f);
    mult = baseBright * (vec3(1.0) + sum + dirContrib);
} else {                                          // 调暗
    mult = mix(vec3(1.0), nightColor + dirContrib, -f);
}
color.rgb = l2g(clamp(linearColor * mult + torchAdd, 0.0, 24.0));
```

场景侧同步（`applySceneLightingFromNightFade`）：

```ts
// 主方向光：配置基准 × (1 + fade)，硬限 0.1~4
this.light.light.intensity = clamp(baseIntensity * (1 + this.nightFade), 0.1, 4);
// 天空球：1.1 + fade，限 0.23~2.0；无 skybox 时强制 0（否则纯色背景发白）
this.app.scene.skyboxIntensity = hasSkybox ? clamp(1.1 + this.nightFade, 0.23, 2.0) : 0;
```

**踩到的坑与解法**：

- **ANGLE 上 `pow(0)` 出 NaN，表现为整块黑片** → `g2l/l2g` 对底数 `max(c, 1e-6)` 兜底。
- **事件风暴**：UI 每帧推值会触发 `nightFade:changed`，进而重跑 `configureCamera` → 改为"仅在数值真正变化时 fire"，并用 `|fade| > 1e-6` 判定是否启用。
- **双重调光**：一开始 NightMode 也改 `bloom.intensity`，导致调亮/调暗下辉光表现不一致 → **收敛为单一写入点**：Bloom 强度只由 settings 写，NightMode 不碰（见 `docs/Bloom与NightMode适配说明.md`）。这条"单一写入点"原则后面反复用到。

---

### 阶段 2 · 点光源 / 聚光灯：在没有法线的物体上做光照

**问题**：需求是"在街区里摆灯"。但 splat 没有法线，`N·L` 算不出来。

**思路**：分两个子问题解决。

1. **"光照方向"用什么代替法线？**
   用**视线方向当伪法线**：`NdotL = max(0, dot(normalize(cameraPos - wpos), lightDir))`。
   含义上它等价于"billboard 朝向相机的伪漫反射"——不物理，但对半透明椭球是最稳定的近似：不会因为 splat 内部法线乱跳而闪烁。
   > 明确没做：不用球谐重建法线、不用协方差最短轴。原因是大场景下逐 splat 求协方差主轴的开销与稳定性都不划算，而雾化/发光式的观感已经够用。

2. **灯怎么传进 shader？**
   定长 uniform 数组，空槽用哨兵值（`length(pos) < 0.001`）跳过：

```glsl
uniform vec3  uSpherePositions[10];
uniform vec3  uSphereColors[10];
uniform float uSphereRanges[10];
uniform vec3  uSpotPositions[10];
uniform vec3  uSpotDirections[10];
uniform vec4  uSpotParams[10];   // x=innerRad y=outerRad z=range w=enabled
```

   - 点光衰减用 `att = pow(1 - d/range, 2.5)`——指数取 2.5 而不是物理的 2.0，是为了让中段过渡更柔和、边缘不早早截断成硬边。
   - 聚光在距离衰减之上再乘锥形衰减：`spotAtt = smoothstep(cosOuter, cosInner, cosTheta)`，并在 shader 里强制 `cosInner > cosOuter` 防内外锥写反导致过渡带塌缩。

**关键设计：局部灯不依赖全局亮度**

```glsl
// fade = 0（白天）时也允许点光生效——只加光，不做夜晚调色
if (abs(f) < 5e-5) {
    color.rgb = l2g(clamp(linearColor * (vec3(1.0) + sum) + torchAdd, 0.0, 24.0));
    return;
}
```

这条让"灯光"和"昼夜"解耦，用户可以只开灯、不改昼夜。

**代价与取舍（诚实记录）**：

- **灯数写死 10 + 10**。不是不想动态，是 WebGL uniform 数组 + ANGLE 编译稳定性下的保守选择；改容量要同时改两处 shader 字符串和 `light.ts` 常量。
- **不排序、不剔除**：按遍历顺序取前 N 盏。这意味着**超过 10 盏时，顺序变化会造成"换灯"跳变**。这是已知简化，后续被阶段 3 的"体积烘焙"路径绕开（见下）。
- **CPU 侧颜色预处理**：sRGB→线性、白光软压缩（0.2）、感知等亮补偿（0.35）、单灯峰值封顶 64。动机很实际——不封顶会"一开灯整片死白"，不补偿会"白色刺眼、彩色偏暗"。
- **灯色必须双写**：`lightComp.color.set()` 不会触发 `light.setColor()`，只写前者会出现"splat 有色、mesh 无色"。这类"两套光照体系语义不一致"的坑后面还会遇到。

---

### 阶段 3 · 局部亮灯区域：把"笔刷"从屏幕空间升级为世界空间

**问题**：设计师的真实动作不是"摆一盏灯"，而是"把这片建筑点亮"。打灯做不到（光会漏到别的物体上），而早期方案是**在 shader 里循环遍历笔刷点**——

```glsl
for (int i = 0; i < 256; ++i) { /* 每个 splat 遍历所有笔刷点算距离 */ }
```

两个致命问题：**点数上限 64/256**、**每 splat O(N)**。亿级 splat × 上百点 = 直接崩。

**思路（这是整个项目最漂亮的一次转换）**：
把"逐 splat 遍历点"反过来做——**把点烘焙成一张世界空间的亮度场，让 splat 去查表**。

```
CPU：已提交点集(位置+半径) ──烘焙──> 64³ 体素亮度场 ──打包──> 64 × 4096 的 R8 纹理图集
GPU：每个 splat 用自己的世界坐标 ──> 归一化 ──> 体素索引 ──> UV ──> 一次 texture2D 采样
```

于是复杂度从 **O(splat × points)** 变成 **O(splat) + O(voxels × points) 的一次性烘焙**。

**关键实现**：

- **体积布局**：逻辑体积 64×64×64；2D 纹理宽 64、高 4096（= 64×64 块拼成一张长图）。
  体素 `(ix,iy,iz)` → 像素列 `ix`、行 `iy + iz*64`，索引 `ix + (iy + iz*64) * 64`。
- **Falloff**：`t = 1 - smoothstep(0.5r, 1.3r, d)`，多个球累加后 clamp 到 [0,1]。
  外扩到 `1.3r` 是有原因的——只到 `1.0r` 时，"笔刷里看到的亮区"比"松手后的亮区"小一圈，用户会以为效果丢了。
- **Shader 侧**：

```glsl
vec3 size = max(uCommittedAabbMax - uCommittedAabbMin, vec3(1e-6));
vec3 n = clamp((wpos - uCommittedAabbMin) / size, 0.0, 1.0);
float ix = min(floor(n.x * 64.0), 63.0);
float iy = min(floor(n.y * 64.0), 63.0);
float iz = min(floor(n.z * 64.0), 63.0);
vec2 uv = vec2((ix + 0.5) / 64.0, (iy + iz * 64.0 + 0.5) / 4096.0);
float committedMask = texture2D(uCommittedBrightnessVolume, uv).r;
color.rgb *= 1.0 + uCommittedBrightness * committedMask;
```

**结果**：**无点数上限**、每 splat **一次采样 + 一次乘算**、多区域合并仍然是"单纹理单采样"。

**配套的两个工程问题**：

- **烘焙不能每帧跑**（64³ × N 点）。解法是**内容签名缓存**：把区域 id、点数、亮度、可见性、是否绘制中串成 hash，只有 hash 变化才重建；并且把重建时机钉在 `pointerup` / FINISH，而不是 `pointermove`。
- **纹理重建会让材质 sampler 悬空**（旧纹理已 destroy，下一帧 draw 直接崩）→ 所有体积/掩码采样器都配一张 **1×1 占位纹理**兜底，重建期间也安全。

---

### 阶段 4 · 辉光：让"亮"真的发光，且只在该亮的地方发

**问题**：调亮只是把颜色乘大，观感是"过曝"而不是"发光"。需要 bloom，但需求是**局部 bloom**（只有笔刷区域、灯区域发光）。

**思路**：不自写 fullscreen pass，而是**接入引擎 CameraFrame 内建的 bloom 通道，但替换它的 compose shader 片段**，在最后合成时乘一个 mask。

**关键实现**（`src/vfx/bloom/bloom.ts`）：

```ts
// 覆盖引擎的 compose 阶段 chunk（GLSL / WGSL 各一份）
ShaderChunks.get(device, 'glsl').set('composeBloomPS', composeBloomPSGlsl);
```

```glsl
float brightPass = smoothstep(bloomThreshold - knee, bloomThreshold + knee, lum);
return color + dBloom * bloomIntensity * mask * brightPass;
```

- 强度/档位走 CameraFrame 原生 API：`cameraFrame.bloom.intensity`、`bloom.blurLevel`（1~5 档，没有"半径"参数）。
- threshold / knee / mask 走 **device scope 的全局 uniform**（`bloomMaskTexture`、`bloomThreshold`、`bloomThresholdKnee`），因为 CameraFrame 没有暴露这些入口。
- knee 自适应：`clamp(threshold * 0.12 + 0.04, 0.05, 0.35)`，避免阈值硬切出现"环状硬边"。

**这一步踩了三个硬坑**：

1. **`renderFormats` 必须先设再 enable**。
   `cameraFrame.enabled = true` 之后再设 `RGBA16F` 是无效的——引擎会回退到 `RGBA8` 并**静默关闭 bloom**（`_bloomEnabled = false`），表现为"参数都对但没效果"。这是纯靠读引擎源码才定位到的问题。
2. **mask 必须在 `framerender` 生成，不能在 `frameupdate`**。
   小写 `frameupdate` 时相机矩阵还没 update，投影会滞后一帧，表现为"笔刷跟着屏幕滑"。
3. **mask 重绘要卡在正确的缓存粒度**。
   签名太细（相机每帧微抖）→ mask 每帧重建、闪动；太粗 → 跟屏滑。最终用 `toFixed(3)` 的相机签名 + 点数/末点坐标组合做 key。

**另一个设计选择**：为什么"局部调亮"要放在 bloom 之前？
因为调亮抬高了 splat 的亮部，才会进入 compose 的 `brightPass`——**"局部亮灯" = 变亮 + 发光，是一条链**。如果先 bloom 再调亮，就只剩过曝，没有光晕。这条顺序约束直接决定了：调亮必须在 `modifySplatColor`（逐 splat）里做，bloom 必须在后处理 stage 里做，两者共用同一套点数据但作用于不同管线阶段。

---

### 阶段 5 · 手电筒：跟随鼠标的锥光 + 深度遮挡

**问题**：夜游场景里"玩家手里有一支手电筒"。它不同于普通点光：方向跟随**鼠标在屏幕上的位置**，且必须被墙挡住。

**思路**：不做单独 pass、不做 cookie 投影贴图，而是**用解析式锥体在 shader 里算**（Fill + Hotspot 两层），遮挡靠采样场景深度图。

**关键实现**（`src/vfx/lighting/torch-light.ts` + night-mode 的 `addDepthTorchContribution`）：

- **方向**：`origin = camera.position`，方向 = 相机 → 鼠标屏幕点的射线。拿不到射线时回退到 `camera.forward`。
- **Fill（铺底光）**：沿射线 `t ∈ (0, beamEnd]`，`beamEnd = farClip × ratio`；锥半径随距离张开
  `radius = mix(nearRadius, farRadius, kFill)`，其中 `nearRadius = max(0.18, r*0.5)`、`farRadius = max(0.75, r*2.0)`。
- **Hotspot（热点）**：命中点附近用高斯 `exp(-dk² * 2.0)`，形成中心亮斑。
- **深度遮挡**：把 splat 用 `uTorchViewProj` 投到 NDC→UV，与 `uSceneDepthMap` 比较，`bias = 0.0025`；UV 越界视为遮挡，深度 0/1 视为无效。
  > **关键防御**：没有深度图时必须**强制关闭遮挡**。否则采样值恒为 0，"全部判定被挡"，手电筒直接失效。这个判断是靠 `camera.requestSceneDepthMap(true)` 的绑定状态做的。

**手电筒带来的三个竞态问题与解法**：

| 竞态 | 表现 | 解法 |
|---|---|---|
| 异步 pick 与 mesh 同步拾取抢答 | 手电筒光斑在 mesh 前后跳 | mesh AABB 同步拾取优先 + 0.2m 滞回；mesh 命中时主动取消在途 gsplat pick |
| 相机移动后旧深度滞留 | 光斑"粘"在旧视角的位置 | 相机变化即清空热点深度 |
| torch 更新与 shader 重挂同帧竞争 | 首帧闪一下/不生效 | NightMode 把手电筒的 shader 刷新**延后到同帧 onUpdate 之后** |

另外，开关是**会话态瞬时量**（不入库、不插值），只有热点深度和强度做 50ms 平滑——因为"按下手电筒"要的是即时反馈，插值反而迟钝。

---

### 阶段 6 · 架构收敛：从"抢 chunk"到"分层合成"

**问题**（这一阶段是纯架构债的偿还）：
到 L5 时，`gsplatModifyVS` 这一个槽被多方争用——NightMode、Reveal 开场动画、点彩风格化，各自 `set` / `delete`。

- 顺序反了 → 特效被覆盖。
- `reveal` 构造时立即 fire `nightMode:exit`，如果 NightMode 监听还没注册，**这个 exit 就丢了**，导致 NightMode 一直占着槽位、与 VFX 互斥失败（`viewer.ts` 里为此写死了创建顺序）。
- 只 `clear` 材质集合而不真正 delete chunk → 旧 shader / uniform 残留，表现为"关了还在生效"。
- 重复 exit 会 `applyComposedToMaterials` 覆盖直连 chunk → 大面积黑片。

**思路**：把"谁改 shader"变成**贡献者协议 + 仲裁器**。

```
GsplatEffectComposer
  ├─ 各特效注册 GsplatContribution：{ id, priority, scope, version, shaderBlocks, capabilities }
  ├─ 按优先级仲裁（exclusiveWithLighting 只保留最高优先级）
  ├─ 把各贡献者的 header + 三个函数体拼回完整 chunk
  └─ 统一写材质；无贡献者时 delete chunk
```

- NightMode 从"直接覆盖整段 shader"降级为一个 **priority = 100 的贡献者**，并声明 `exclusiveWithLighting`（有它在，其它改光照的贡献被让位）。
- 按**函数签名切块**（`modifySplatCenter` / `modifySplatRotationScale` / `modifySplatColor` 的函数体），而不是整段字符串覆盖——这样不同特效可以只贡献自己关心的那个函数。
- 旧的直连路径保留为可回退开关（`?nightComposer=0`），用于出问题时快速降级。

**这一阶段解决的三个隐蔽问题**：

1. **材质重建必须重挂**：引擎在相机移动/光照变化时会重建 gsplat 材质，新材质会**克隆模板上的残留 chunk**。解法是监听 `gsplat.on('material:created')`，在创建当帧把材质加回集合并重新应用。
2. **`version` 字段不能塞每帧变化的 uniform**：否则每帧重编译，疯狂掉帧。`version` 只用于"变体切换"（如 BloomBrush 开关）。
3. **`getGSplatMaterial(camera, layer)` 必须传 `Camera` 实例，不能传 `CameraComponent`**——传错类型会静默查不到，表现为"某个 layer 没被照亮"。

---

### 阶段 7 · 阴影（延伸能力）

**问题**：有了灯，就要有影子；但 splat 不投影，且放置的 mesh 资产需要和 splat 互相遮挡。

**思路**：不自己算投影，**复用引擎 shadow map**，再补一条屏幕空间叠影管线。

| | A 管线：引擎 shadow map | B 管线：屏幕空间叠影 |
|---|---|---|
| 谁参与 | 放置的 **mesh**（`receiveShadows`/shadowCatcher） | **主场景高斯** + 地面/接影区 |
| 机制 | 引擎在 LIT_SHADOW_CATCHER 材质里采样 shadow map，写出 R=0/1 | 独立相机渲出 R 通道 → 全屏 quad `blend = (1-R) * intensity` 叠黑 |
| splat 角色 | 主高斯 `castShadows` 恒 false，splat **只接影不投影** | 同左 |

两条额外处理：

- **放置 mesh 的遮挡**：靠 depth-only 预写（`redWrite..alphaWrite=false`），在 `prerender:layer` 临时换隐形材质、`postrender:layer` 换回。
- **放置高斯的透影/横切**：单独一个 exclude 相机输出 mask（G 通道）+ 深度比较，`if (exDepth > occluderDepth + bias) gsplatMask = 0`，再 `blend *= (1 - gsplatMask)` 抠洞。
- **为什么会分裂成两条管线**：同一个 Layer 内"有投影的 splat 集合"和"有接影的 splat 集合"不一致时，引擎的 gsplat-director 会拆成 forward + shadow 两个 manager，直接**花屏/闪烁**。所以策略上让主高斯永不投影，只让放置高斯随开关投影。

---

## 4. 管线级难点总表（最能体现深度的部分）

| # | 难点 | 根因 | 解法 | 代价 |
|---|---|---|---|---|
| 1 | 无面法线 | splat 是椭球 | 视线方向作伪法线 | 非物理、视角相关 |
| 2 | uniform 数组上限 | WebGL/ANGLE | 定长 10+10，空槽哨兵 | 超 10 盏会跳变 |
| 3 | 逐 splat 遍历点 O(N) | 早期笔刷方案 | 64³ 体积烘焙 + 1 次采样 | 一次性 CPU 烘焙 |
| 4 | 烘焙卡顿 | 262144 体素 × N 点 | 内容 hash 缓存 + 只在 pointerup/FINISH 重建 | 重建有延迟感 |
| 5 | 材质被引擎重建 | camera move / 光照 hash | `material:created` 监听 + 每帧重刷 uniform | CPU 每帧逐材质写参 |
| 6 | chunk 槽多方争用 | 单一注入点 | Composer 贡献者协议 + 优先级仲裁 | 增加一层抽象 |
| 7 | chunk 残留 | 只 clear 不 delete | 真删 chunk（含模板材质） | 需谨慎处理时序 |
| 8 | 采样器悬空 | 纹理重建后旧引用 | 1×1 fallback 纹理 | 多一次绑定 |
| 9 | mask 滞后一帧 | `frameupdate` 时相机未更新 | 移到 `framerender` | 时序约束变强 |
| 10 | bloom 静默失效 | `renderFormats` 设置晚于 enable | 先设 RGBA16F 再 enable | 无 |
| 11 | 笔刷进出亮度跳变 | 预览与提交两路叠加乘算 | `committedMask < 0.2` 才算预览；分支不 return | 阈值需调参 |
| 12 | 灯色双写 | `color.set` 不触发 `light.setColor` | 双写两处 | 易漏 |
| 13 | 手电筒光斑抖动 | 异步 pick 与 mesh 拾取抢答 | mesh 优先 + 滞回 + 取消在途 | 逻辑复杂 |
| 14 | 手电筒全黑 | 无深度图时采样恒 0 | 未绑定则强制关闭遮挡 | 需探测绑定状态 |
| 15 | 坐标空间错位 | `unified` 模式下 center 已是世界坐标 | 传单位矩阵 vs 传世界变换 | 条件分支易错 |
| 16 | ANGLE NaN 黑块 | `pow(0)` | `g2l/l2g` 底数 clamp 1e-6 | 无 |
| 17 | 数值死白 | 多灯叠加溢出 | 单灯峰值封顶 64 + `sum` clamp 8 + 输出 clamp 24 | 高光略压 |
| 18 | 特效互斥时序 | reveal 构造即 fire exit | 写死创建顺序 | 初始化耦合 |

---

## 5. Result：结果

### 5.1 能力矩阵

| 能力 | 状态 | 关键指标 |
|---|---|---|
| 全局亮度（昼夜） | ✅ | fade ∈ [-1,1]，splat / 主光 / 天空球三方同步 |
| 点光源 | ✅ | 上限 10，`pow(1-d/r, 2.5)` 衰减 |
| 聚光灯 | ✅ | 上限 10，内外锥 + 距离双衰减 |
| 局部亮灯区域 | ✅ | **无点数上限**，每 splat 1 次采样 |
| 局部辉光 | ✅ | CameraFrame bloom + 自定义 compose mask，blurLevel 1~5 |
| 手电筒 | ✅ | 锥光 Fill + 高斯 Hotspot + 深度遮挡，33ms 节流 |
| 阴影 | ✅ | 双管线（引擎 shadow map + 屏幕空间叠影） |
| 双后端 | ✅ | WebGL2 / WebGPU 手写双份 shader |
| 可持久化 | ✅ | 灯列表 / 区域点集 / 亮度 / 染色全部入 settings |
| 外部协议驱动 | ✅ | `LIGHT_*` / `TORCH_*` 系列协议，可被外部编辑器控制 |

### 5.2 复杂度结果

- **逐 splat 光照成本**：点光循环 10 + 聚光循环 10 + 手电筒解析计算 1 + 体积采样 1 + 笔刷掩码 1 ≈ **常数级**，与场景中亮灯区域的数量无关。
- **CPU 烘焙成本**：64³ 体积 × 已提交点数，**仅在内容变化时触发一次**，不进入帧循环。
- **从 O(splat × points) 到 O(splat)**：这是让"局部亮灯"在亿级场景里变成可用的关键一步。

### 5.3 工程质量

- 编辑态与观看态走同一条 CameraFrame 链路，**所见即所得**。
- 所有新增 shader 都有 GLSL + WGSL 两份，纹理格式取双后端交集（R8 / RGBA8，clamp，无 mip），显式 `textureSampleLevel(..., 0.0)` 规避 mip 差异。
- 每个失败模式都有兜底：纹理 fallback、深度图未绑定降级、legacy 直连路径可回退、体积读回 try/catch。

---

## 6. 复盘：三条可复用的设计原则

1. **数据形态决定复杂度上限。**
   笔刷方案的天花板不是"循环写得好不好"，而是"点是数据、还是纹理"。把点烘焙成体积纹理，等于把 N 从热路径里彻底移除。**当发现 O(N) 在热路径上时，先想"能不能换个数据形态"，而不是优化循环。**

2. **单一写入点。**
   Bloom 强度只由 settings 写、NightMode 不碰；mask 只在 `framerender` 生成；shader 只由 Composer 写。每次出现"两处都能改同一状态"，后面一定会有表现不一致的 bug。

3. **先让它能跑，再让它能和别人一起跑。**
   前 5 个阶段是"抢一个 chunk 槽"的快速迭代，第 6 阶段才收敛成贡献者协议。这个顺序是对的——过早抽象会阻碍功能探索；但**必须预留收敛的时机**，否则技术债会变成"加一个特效就要改三个文件"。

---

## 7. 网站可直接摘用的短版文案

### 版本 A（一段话，约 90 字）

> 为亿级高斯泼溅大场景从零构建实时重光照系统。由于 3DGS 没有面法线、引擎原生光源对其完全无效，我通过覆盖 GS 材质的 `gsplatModifyVS` 注入自研着色，实现了昼夜全局亮度、点光/聚光逐 splat 光照、世界空间笔刷亮灯区、局部辉光与手电筒，并在 WebGL/WebGPU 双后端下保持一致。

### 版本 B（问题-方案-结果，约 180 字）

> **问题**：高斯泼溅没有面片和法线，PlayCanvas 的灯光组件对它零效果，而客户需要"能在夜里点亮一条街"。
> **方案**：以官方 demo 的夜模式 shader 拆解为起点，接管 GS 材质的颜色注入点，逐层构建：全局昼夜亮度 → 点光/聚光（伪法线 + 定长 uniform 数组）→ 世界空间笔刷亮灯区（把逐点循环换成 64³ 亮度场烘焙成 64×4096 图集，每 splat 一次采样、无点数上限）→ 局部辉光（替换引擎 bloom 的 compose 片段注入 mask）→ 手电筒（解析锥光 + 场景深度遮挡）。
> **结果**：逐 splat 光照成本与亮灯区域数量解耦，编辑态与观看态同链路，全部能力可持久化并被外部协议驱动。

### 版本 C（要点式，适合卡片）

- 从官方 Demo 逆向拆解 shader 注入点，独立设计并落地 5 层重光照能力
- 用「3D 亮度场 → 2D 图集」替换「逐 splat 遍历笔刷点」，把 O(splat × points) 降为 O(splat)，解除点数上限
- 手写 GLSL + WGSL 双份着色器，覆盖 WebGL2 / WebGPU 双后端
- 定位并修复 18 类渲染管线级问题（bloom 静默关闭、mask 滞后一帧、采样器悬空、材质重建丢失 uniform、特效争用同一 shader 槽等）

---

## 附：代码索引

| 模块 | 文件 |
|---|---|
| 全局亮度 + 逐 splat 光照 + 手电筒着色 | `src/vfx/lighting/night-mode.ts` |
| 手电筒跟随与拾取 | `src/vfx/lighting/torch-light.ts` |
| 灯光实体与设灯上限 | `src/light.ts` |
| 辉光与笔刷总控 | `src/vfx/bloom/bloom.ts` |
| 笔刷会话状态机 | `src/vfx/bloom/bloom-brush-flow.ts` |
| 体积烘焙（64³ → 64×4096） | `src/vfx/bloom/committed-brightness-volume.ts` |
| 笔刷点数据与持久化 | `src/vfx/bloom/world-space-bloom-data.ts` |
| shader 分层合成 / 仲裁 | `src/vfx/effects-runtime/gsplat-effect-composer.ts` |
| shader 注入底座 | `src/vfx/effects-runtime/gsplat-shader-effect.ts` |
| 阴影双管线 | `src/vfx/shadow/shadow-apply.ts` |
| 配置 Schema | `src/schemas/v2.ts`、`src/schemas/v2-custom.ts` |
| 外部协议 | `src/editor-modules/protocol-adapters/environment-protocol-adapter.ts` |
| 相关设计文档 | `docs/Bloom与NightMode适配说明.md`、`docs/局部亮度调节实现说明.md`、`docs/阴影双管线与放置资产说明.md` |
