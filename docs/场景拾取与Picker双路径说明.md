# 场景拾取与 Picker 双路径说明

> 2026-05-29 收敛：**深度拾取**（标注/放置/通用 `pick`）与 **ID 拾取**（场景资产 mesh）及 **alpha 累加表面拾取**（手电筒 `pickSurface`）分离，避免全局 `pickPS` 互抢。

---

## 1. 三种需求

| 能力 | 需要 buffer 内容 | 主要调用方 |
|------|------------------|------------|
| 世界坐标（单击/放置） | 线性深度 / `getWorldPointAsync` | `pickWorldFromClientXY` → 标注、Bloom 画笔、`input-controller` 世界点击 |
| 表面+邻域最近点 | alpha 加权期望深度（RGBA16F 累加） | `Picker.pickSurface` → 手电筒、nav 法线 |
| 实体 ID | `vPickId` / meshInstanceId | `pc.Picker(false)` + `getSelectionAsync` → mesh 资产；高斯见 §3 |

---

## 2. 当前实现（`src/picker.ts`）

### 2.1 `pick()` — 引擎深度 pass

- `EnginePicker(app, w, h, **true**)` + `prepare` + `getWorldPointAsync`。
- 走 PlayCanvas **`SHADER_DEPTH_PICK`**，**不修改**全局 `pickPS` / `gsplatPS`。
- Compute 与 Raster 均走此路径（Raster 不再用累加写 `pick()`）。

### 2.2 `pickSurface()` — 分渲染器

- **Compute**：`getPointDepthAsync` + 邻域 `getWorldPointAsync`（`PICK_NEAREST_RADIUS_PX`）求 `nearestPosition`。
- **Raster**：恢复 **RGBA16F 累加** + `pickPS` 深度补丁；补丁仅在 `accumPass.render()` 前后 **register / unregister**，不常驻，避免影响资产 ID 拾取。
- 邻域搜索 + `PICK_SURFACE_MIN_ALPHA`（透射率阈值）用于暗部高斯；手电筒应读 **`nearestPosition ?? position`**。

### 2.3 单例

- Viewer 注入 **`global.picker`**（`types.Global.picker`）。
- `getSharedPicker(global)` 懒创建；手电筒、`pickWorldFromClientXY`、nav 等共用同一实例。

---

## 3. 高斯资产选中（`scene-asset-selection-pick.ts`）

主场景 unified gsplat 在 World 层上的 **合成 pick** 会盖住已放置高斯的 `vPickId`。

- 已放置 unified 高斯：`World` + **`SceneAssetPick`** 层（`configurePlacedGaussianPickLayer`）。
- 场景点选：**先**在仅 `SceneAssetPick` 层上 `pc.Picker(false)`（临时把该层加入相机.layers）；**再** World 层拾取 mesh。
- 仍失败时：深度 + 放置列表 AABB 兜底（`findPlacedGaussianFromWorldPoint`）。

详见工作记录 **2026-05-29「场景拾取与 Picker 双路径收敛」**。

---

## 4. 与旧文档关系

- [标注放置Picker问题根因说明.md](标注放置Picker问题根因说明.md)：记录「全局 pickPS 改坏标注」的历史根因；当前 **标注已走 §2.1**，不再依赖全局深度补丁。
- [场景选中与输入分层说明.md](场景选中与输入分层说明.md)：输入分层；资产 mesh / 高斯命中策略见本文 §3。

---

## 5. 维护注意

1. **不要**让 `registerPickerShaderPatches` 在 Picker 生命周期内常驻（会破坏 `getSelectionAsync` 读 ID）。
2. 新增「需要表面法线/邻域最近深度」的能力 → 走 **`pickSurface`**，不要复用引擎 depth 替代 raster 累加，除非已验证暗部高斯效果可接受。
3. 新增「只需世界坐标」的能力 → 走 **`pick()` / `pickWorldFromClientXY`**。
