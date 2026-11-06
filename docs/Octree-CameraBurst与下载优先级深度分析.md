# Octree Camera Burst 与下载优先级 — 深度分析

> 回答：burst 能否「瞬间上屏」？为何仍慢？为何后方先清晰？  
> 日期：2026-06-09

---

## 1. Camera Burst 到底做了什么（与没做什么）

**Burst 不是「跳过下载瞬间上屏」**，它只是一段 **调度加速窗口**（36～48 帧），做这些事：

| 能力 | Burst 是否提供 |
|------|----------------|
| 提高 HTTP 并发（8） | ✅ |
| 放宽 splatBudget（8M） | ✅ |
| `lodUpdateDistance = 0` 每帧重算 LOD | ✅ |
| 更频繁 `syncOctreePendingPlacements` | ✅ |
| 连续 `renderNextFrame` | ✅ |
| **跳过 SOG 下载** | ❌ |
| **跳过 SOG 解析 / GPU 上传** | ❌ |
| **跳过 separate 资产「每档一文件」** | ❌ |

### 1.1 一帧升一档的真实链路

以 separate 资产、当前显示 L4（最糊）为例：

```
调度选中 targetLod=L3
    → ensureFileResource / HTTP 下载 `(lodLevels-2)_*.sog`
    → 解析 SOG、写入 ResourceManager
    → syncOctreePendingPlacements → 引擎 needsLodUpdate
    → octree instance 换 interval / work-buffer 重建
    → splatBudget 内 sort + 上屏
```

Burst 只能压缩 **调度/sync/渲染** 的等待，**不能压缩 HTTP + 解析**。  
若 L3 文件 2MB、RTT 50ms，物理上仍有 **百毫秒～秒级** 下限。

**唯一「近 instant」的情况**：该档 physical file **已在内存**（bootstrap 下过、或别 node 共用已 pin）→ 只剩 sync，Burst 才有明显体感。

---

## 2. 为何仍感觉「上屏慢」— 本质仍是下载 + 逐档 ladder

### 2.1 Separate 资产结构

- L4、L3、L2… 多为 **不同 URL**；升一档 ≈ **新发 HTTP**（见 `LOD资产切片优化规格-splat-transform.md`）。
- **Ladder 策略**（`computeRefinementTargetLod`）刻意 **每次只升一档**，避免一步追 L0；代价是清晰化是 **阶梯状**，每阶都要等一次下载。

### 2.2 与 aholo / universe 的差距

| | separate（当前 yunji 类） | universe / 切片共用 |
|--|---------------------------|---------------------|
| L4→L3 | 新 HTTP | 常在同 file 换 offset |
| 首屏后第一阶变清 | 受网络支配 | 常近 instant |

**结论**：在 separate 资产下，Burst 优化的是 **「多快开始下」和「下完后多快 sync」**，不是 **「不下就清」**。要 2～3 秒内到 L0，最终仍要 **资产侧 bundled / 切片**。

### 2.3 其它延迟来源

- **Gate 队列**：仅 foreground Top 64 URL 进 gate，其余 suspend。
- **CRITICAL 仅 8 个 pin**：中心文件可能被 peripheral 挤占并发槽（tracked 队列过长时）。
- **Settle 窗口**：`POST_DOWNLOAD_SETTLE_FRAMES=30` 内 hold gate，可能略 delay 下一批（设计为防闪烁）。
- **引擎 budget**：细档 splat 多，budget 满时中心 node 可能 **晚于** 外围少 splat 的 node 完成 placement。

---

## 3. 为何「后面先清晰、前面后清晰」

这是 **评分 + 队列 + 引擎** 叠加，不全是下载慢。

### 3.1 已修复：`centerBias` 用错向量（严重）

原逻辑：

```ts
const toCenter = worldCenter · cameraForward;  // 未减去相机位置
const centerBias = toCenter > 0 ? 1.2 : 0.6;
```

场景原点与相机位置相差较大时，**屏幕前方 node 可能被当成「后方」降权**，远处背景反而高分 → **后方 chunk 先入队、先 sync**。

**修复**：改用 `(worldCenter - cameraPos) · forward`，并加 **depthBias ∝ 1/(1+depth)**，近处更高优先级。

### 3.2 `screenSize = extent / distance` 偏大面积

视锥 **远处大平面**（外墙、地面远端）extent 大 → score 高；  
**近处小 chunk** score 相对低 → 同档 SOG 可能 **后下载**。

这与「屏幕中心」不是同一概念：**占屏大 ≠ 离相机近**。

### 3.3 `trackedMissingFiles` 只增不减（已修复）

原逻辑：file 一旦进 tracked，**只有下载完才删除**；离开当前视锥仍占 foreground 64 槽位 → **旧视角/外围高 score 文件挡住中心**。

**修复**：当前帧 `buildPriorityFiles` 未再出现的 fileIndex 从 tracked 移除。

### 3.4 `lodBehindPenalty = 5` 只作用于 optimal，不作用于 score 的 screenSize

`buildPriorityFiles` 里 behind node 的 **optimal 变粗**，但 `scoreVisibleNode` 的 screenSize 仍用 **未惩罚的 worldDistance** → 大背景块仍可能高分（已通过 depthBias 缓解）。

### 3.5 屏幕中心 vs 视线深度

`computeViewportEdgeFactor` 只看 **NDC 离屏幕中心距离**，不看深度：  
**屏幕中心的远景** 与 **屏幕中心近景** edgeFactor 同为 1 → 需 depthBias 区分。

### 3.6 引擎侧

- **Radial sorting / budget**：细档 splat 多的近处 node placement 更慢。
- **Underfill**：某区域已加载较细档会先显示，与下载顺序一致时表现为「后方先清」。

---

## 4. 调试建议

`?debugOctreeRefinement=1`，拉近时观察：

| 字段 | 期望 |
|------|------|
| `cameraBurstFrames` | zoom 后 >0 递减 |
| `stableForegroundPending` | 拉近后很快 >0 |
| `activeDownloads` | 中心对应 URL 靠前 |
| `staleLoadedNodes` | 文件落地后 >0 再归零 |
| Network 面板 | 先出现 **视锥中心** 的 `(maxLod-1)_*` / 当前 ladder 档 URL |

若 Network 已是中心 URL 先完成但画面仍后方先清 → 偏 **引擎 placement / budget**；  
若 Network 本身后方 URL 先完成 → 偏 **评分/队列**（查 3.1～3.3）。

---

## 5. 改进方向（按 ROI）

| 优先级 | 方向 | 说明 |
|--------|------|------|
| P0 | 资产 bundled + 切片 | 根治 separate 每档 HTTP |
| P1 | 评分 depth + center 修复 | 中心先下、先 sync（本次已做） |
| P1 | tracked 随视锥刷新 | 避免旧队列挡路（本次已做） |
| P2 | bootstrap 预拉 **中心** Lmax-1 | 首阶变清少一次 RTT |
| P2 | 临时 UI `octreeRefinement:activity` | 让用户感知「在加载细节」 |
| P3 | 略增 CRITICAL / 缩短 settle | 换更少闪烁风险 |

---

## 6. 相关代码

- `src/loaders/octree-refinement-controller.ts` — burst、ladder、score、tracked
- `src/viewer.ts` — zoom 检测、`lodBehindPenalty`
- `docs/Octree-拉近LOD感知优化.md` — burst / ladder 产品说明
