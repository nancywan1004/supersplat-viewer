# 标注放置 Picker 无法拾取位置 — 根因说明

## 结论（先答你的两个问题）

1. **是改了哪里导致的？**  
   **直接原因**是 **`picker.ts` 里对全局 `pickPS` 的改动**（给 mesh 加 ID 分支、保留 gsplat 深度分支）。  
   **不是** asset-placement-handler 里「改成用 pc.Picker 点选实体」那一段逻辑直接导致的；但 asset 改动**依赖**了 picker 的这套双分支，所以两者在 staged 里是一起出现的。

2. **和 staged 里的 picker.ts / asset-placement-handler.ts 有关系吗？**  
   **有。** 标注放不下去，就是这次 **picker.ts 的 staged 改动** 触发的；asset-placement-handler 的改动只是「需要 ID 拾取」的那一侧，没有改标注放置的调用链，但和 picker 改动配套。

---

## 1. 改动前后对比（只看 pickPS）

### HEAD（改动前）— 标注能放置时的 picker.ts

```glsl
// override global pick to pack depth instead of meshInstance id
uniform vec4 camera_params;
vec4 getPickOutput() {
    float linearDepth = 1.0 / gl_FragCoord.w;
    float normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
    return vec4(gaussianColor.a * normalizedDepth, 0.0, 0.0, gaussianColor.a);
}
```

- 全局 `pickPS` **只有**「深度 + alpha」这一种输出（没有 `encodePickOutput`，没有 `#ifndef PICK_CUSTOM_ID`）。
- 标注放置用的 `Picker` 用 `RenderPassPicker` 渲染一帧，读 RGBA 当「深度×alpha / 透射率」用，能正确得到世界坐标。

### Staged（改动后）— 标注放不下去的 picker.ts

```glsl
// override global pick: encodePickOutput（gsplat/mesh 共用）+ getPickOutput 分支（mesh 用 meshInstanceId，gsplat 用深度）
vec4 encodePickOutput(uint id) { ... }
#ifndef PICK_CUSTOM_ID
uniform uint meshInstanceId;
vec4 getPickOutput() { return encodePickOutput(meshInstanceId); }  // mesh → 出 ID
#else
uniform vec4 camera_params;
vec4 getPickOutput() { return vec4(gaussianColor.a * normalizedDepth, 0.0, 0.0, gaussianColor.a); }  // gsplat → 出深度
#endif
```

- 目的：**mesh 在 PICK 时出 ID**（给 asset 用 `pc.Picker` + `getSelectionAsync`），**gsplat 在 PICK 时出深度**（给标注/放置用）。
- 但 engine 里 gsplat 的 PICK 逻辑是：**只要开了 `GSPLAT_UNIFIED_ID`，就永远走「ID 分支」**，不会走你写的 `getPickOutput()`。

---

## 2. Engine 里 gsplat 在 PICK 时实际走哪条路

在 engine 的 gsplat fragment 里（例如 `engine/src/scene/shader-lib/glsl/chunks/gsplat/frag/gsplat.js`）：

```glsl
#ifdef PICK_PASS
    #ifdef GSPLAT_UNIFIED_ID
        pcFragColor0 = encodePickOutput(vPickId);   // ← 实际走的：出 ID
    #else
        pcFragColor0 = getPickOutput();            // ← 你期望的：出深度+alpha
    #endif
#endif
```

- 当前 viewer 用的 gsplat 是 **unified**，engine 会设 `GSPLAT_UNIFIED_ID`（和 `PICK_CUSTOM_ID`）。
- 所以 **无论** 你在 `pickPS` 里怎么写 `#else` 的 `getPickOutput()`，gsplat 在 PICK pass 里**始终**写的是 `encodePickOutput(vPickId)`，也就是 **ID 打包成 RGBA**，**不是**「深度×alpha / 透射率」。

结果：

- 标注放置仍然用同一套：**全局 pickPS + 同一个 RenderPassPicker + 读 1 像素 RGBA 当 half-float 深度/透射率**。
- 但这一帧里 gsplat 写进 buffer 的是 **ID**，不是深度。
- 把 ID 的 RGBA 当「深度、透射率」去解，就会得到 **alpha≈0**，你的代码里 `if (alpha < 1e-6) return null`，所以**永远拾取不到**，标注无法放置。

所以：**导致「标注放不下去」的，就是 picker.ts 里这次对全局 pickPS 的改动**（引入了双分支，但 gsplat 仍只走 ID 分支）。

---

## 3. asset-placement-handler 的改动在这里的角色

Staged 里 asset-placement-handler 做了两件事：

1. **实体选中**：从「射线 + 球交 (pickPlacedEntity)」改成用 **pc.Picker + getSelectionAsync**，需要 PICK 时输出 **ID**（mesh 用 meshInstanceId，gsplat 用 vPickId）。
2. **放置**：删掉了「拖到画布再放」的 `onDropOnCanvas` / `placementPicker.pick()`，改成协议里「在相机前方放置」等，不再用 Picker 算落点。

因此：

- **标注放置**：只依赖「标注用的 Picker」→ 用同一套全局 pickPS + RenderPassPicker，期望读到**深度+alpha**。
- **资产选中**：依赖「pc.Picker + 同一套全局 pickPS」，期望读到 **ID**。

也就是说：

- **直接导致标注坏掉的**：是 **picker.ts** 把 pickPS 改成「mesh 出 ID、gsplat 出深度」后，gsplat 实际仍只出 ID，导致标注侧读到的不是深度。
- **asset-placement-handler** 的改动没有改标注的调用链，但**依赖** picker 出 ID，所以和 picker 的改动是配套的；若只撤 picker、不撤 asset，资产选中会拿不到 ID。

---

## 4. 当前落地（2026-05-29 更新）

在「方案 1」基础上进一步拆成 **三条 pass**，详见 [场景拾取与Picker双路径说明.md](场景拾取与Picker双路径说明.md)：

| 能力 | 实现 |
|------|------|
| `pick()` / 标注放置 | `EnginePicker(depth=true)` + `getWorldPointAsync`，**不改**全局 `pickPS` |
| `pickSurface()` / 手电筒 | Raster：**RGBA16F 累加** + 临时 `pickPS` 补丁；Compute：引擎深度 + 邻域最近点 |
| 高斯资产选中 | `SceneAssetPick` 层 + `scene-asset-selection-pick.ts`，避免主场景合成 pick 遮挡 |

**不要**再让深度补丁在 `Picker` 实例存活期间常驻注册（会导致 `getSelectionAsync` 读到深度而非 ID）。

## 4.1 历史可选方案（归档）

- **方案 1（DEPTH_PICK 双 pass，标注侧）** — 已用于 `pick()`。  
- **方案 A / B / C** — 见下文归档，供排查旧分支时对照。

- **方案 A（恢复标注、牺牲资产 ID 选中）**  
  - 把 **picker.ts 的 pickPS 改回 HEAD**（只保留深度版 `getPickOutput()`，不要 `encodePickOutput` 和 `#ifndef PICK_CUSTOM_ID`）。  
  - 标注放置会恢复。  
  - 同时把 **asset-placement-handler** 里「点选实体」改回用 **射线 + pickPlacedEntity**，不再用 pc.Picker 读 ID。

- **方案 B（保留资产 ID 选中 + 标注深度拾取）**  
  - **保留** 当前 picker.ts 的双分支 pickPS，以及 asset-placement-handler 的 pc.Picker 选中。  
  - 在**仅做「标注用」的深度拾取**时（即本仓库的 `Picker` 在 `pick()` 里调用 `RenderPassPicker` 的那次渲染前）：  
    - 临时关掉主场景 gsplat material 的 **GSPLAT_UNIFIED_ID**（例如 `setDefine('GSPLAT_UNIFIED_ID', false)` + `material.update()`），  
    - 渲染、读像素、算完世界坐标后，在 `finally` 里立刻把 **GSPLAT_UNIFIED_ID** 设回 `true` 并 `update()`。  
  - 这样这一帧里 gsplat 会走 `getPickOutput()`，写出深度+alpha，标注能放置；其它时候（资产选中、正常渲染）仍用 ID，行为不变。

- **方案 C（两套 Picker 完全分离）**  
  - 标注/放置专用一套「深度 Picker」：**不**改全局 pickPS，只在这次渲染前临时换上深度用 pickPS，并临时关 GSPLAT_UNIFIED_ID，渲染完立刻恢复。  
  - 资产选中继续用 pc.Picker + 当前全局 pickPS（ID 分支）。  
  - 实现量比 B 大，但全局 pickPS 只服务资产，语义更清晰。

---

## 5. 总结表

| 问题 | 答案 |
|------|------|
| 是改了哪里导致标注放不下去？ | **picker.ts 里对全局 pickPS 的改动**（加 mesh ID 分支、期望 gsplat 出深度，但 gsplat 仍只出 ID）。 |
| 和 staged 的 picker.ts 有关吗？ | **有**，就是这次 picker 的 pickPS 改动导致的。 |
| 和 staged 的 asset-placement-handler 有关吗？ | **间接有关**：asset 需要 ID 拾取，所以才要 picker 出 ID；asset 本身没改标注的调用，但和 picker 改动配套。 |
| 若只撤 picker、不撤 asset？ | 标注会恢复，但资产用 pc.Picker 会读到深度而不是 ID，选中会错。 |
| 若只撤 asset、不撤 picker？ | 标注仍然放不下去（因为 gsplat 还是只出 ID）。 |

当前实现采用 **方案 1**（DEPTH_PICK 双 pass）：

- `picker.ts`：`Picker(depth=true)` + `getWorldPointAsync` / 深度 buffer 块读，**不覆盖**全局 `pickPS`。
- `asset-placement-handler.ts`：`pc.Picker(depth=false)` + `getSelectionAsync`，仅 ID pass。
