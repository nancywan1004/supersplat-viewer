# Octree 拉近 LOD 感知优化

> 解决 streaming octree 在**瞬间拉近**时「画面不变、用户不知道在加载细档」的体感问题。  
> 日期：2026-06-09

---

## 1. 现象与原因

用户滚轮/双指快速 zoom-in 到某区域后，常感觉：

- 画面仍停留在粗档，**没有立刻开始变清晰**；
- 首屏 loading 条早已消失，**缺少「还在加载细节」的反馈**；
- 过几秒才突然变清，难以建立「LOD 正在工作」的信任感。

这不是单一 bug，而是 **调度 + 引擎节流 + 感知** 叠加：

| 环节 | 原因 |
|------|------|
| 相机变化检测 | 原先只比较 **位置 / 朝向**，orbit **距离** 变化大但 pivot 几乎不动时，可能不触发 `notifyCameraMoved` |
| `lodUpdateDistance` | refinement boost 下仍为 0.2~0.35，引擎 **不会每帧重算 optimal LOD**，拉近后仍显示旧档 |
| placement sync | 仅在 `staleLoadedNodes > 0`（文件已下完）时挪机 sync；拉近后多数 chunk **尚未下载**，不会立刻 sync |
| 按需渲染 | 相机停住后若无可渲染 diff，帧循环可能 **少渲染**，渐进变清不易被看见 |
| separate 资产 | 每升一档常需 **新 HTTP**，物理上不可能「瞬间全 L0」，只能 **更快开始 + 更可感知** |

结论：**无法违背网络与 separate 切片做到「瞬间全清」**，但可以显著改善 **「拉近后立即开始 refinement + 持续出帧」** 的体感。

---

## 2. 方案：Camera Burst（拉近突发窗口）

在 `octree-refinement-controller` 与 `viewer` 联动，引入 **burst 窗口**：

### 2.1 更完整的相机变化检测（viewer）

除平移 / 旋转外，增加：

- **orbit `distance` 相对变化**（> max(0.04, 8% 当前距离)）
- **FOV 变化**（> 0.5°）

检测到 zoom 时调用：

```ts
octreeRefinementController?.notifyCameraMoved({ zoom: true });
```

### 2.2 Burst 常量（refinement controller）

| 常量 | 值 | 含义 |
|------|-----|------|
| `CAMERA_MOVE_BURST_FRAMES` | 18 | 平移/旋转 burst |
| `CAMERA_ZOOM_BURST_FRAMES` | 36 | **拉近** burst（更长） |
| `CAMERA_BURST_LOD_UPDATE_DISTANCE` | 0 | burst 内每帧重算 LOD |
| `CAMERA_BURST_SYNC_COOLDOWN` | 3 | burst 内 sync 冷却更短 |

### 2.3 Burst 期间行为

1. **进入 / 维持 boost**（并发、budget、underfill 与既有 refinement 一致）
2. **`lodUpdateDistance = 0`**：引擎立即按新距离选档，粗→细需求立刻反映到调度
3. **`needsLodSwitch` 即 sync**：不要求 `staleLoadedNodes > 0`，先推动引擎更新 placement 意图
4. **`needsBoost` 增加 `needsLodSwitch && staleLodNodes`**：仍有未上屏/未升档 node 时保持 boost
5. **`notifyCameraMoved` 末尾立即 `runPriorityPrefetch()`**：不等到下一帧 update
6. **持续出帧**：burst / pending / stale 期间 `renderNextFrame = true`；viewer 监听 `octreeRefinement:activity` 强制连续渲染

### 2.4 事件（可选 UI 扩展）

```ts
events.fire('octreeRefinement:activity', {
  active: boolean,           // 正在 refinement
  pendingForeground: number, // 前景仍缺文件数
  staleLoadedNodes: number,  // 已下完待升档
  burstFrames: number
});
```

`active` 从 false→true 或 true→false 时触发，可用于：

- 右下角轻量「细节加载中…」
- 短暂 vignette / 锐度动画
- 调试 overlay

当前 **未默认加 UI**，仅保证画面连续刷新；产品若要提示可订阅该事件。

---

## 3. 用户可预期的体验

| 阶段 | 用户看到什么 |
|------|----------------|
| 瞬间拉近 | 1~2 帧内 optimal 重算，中心 chunk **开始排队下载**（网络允许时） |
| burst 内 (~0.5–1s) | 已缓存的细档 **更快切换上屏**；未下载区域仍可能暂时粗/空 |
| burst 后 | 恢复 `lodUpdateDistance` 节流，避免边缘微抖；继续 foreground 下载直至稳定 |

**仍做不到**：从未访问过的区域、首次 L0 HTTP 未完成时「立刻全清」——这是 separate + 网络下限。

---

## 4. 调试

URL 加 `?debugOctreeRefinement=1`，观察：

- `cameraBurstFrames`：拉近后应跳到 36 并递减
- `stableForegroundPending` / `activeDownloads`：中心文件是否立刻入队
- `needsLodSwitch` / `staleLodNodes`：是否识别到需升档

---

## 5. 与 fine-merge 的关系

fine-merge（L0/L1 同 file）已 **从 viewer 移除**；本方案仅依赖 standard separate 资产 + 现有 foreground gate，不引入 merge 复杂度。

---

## 6. 相关文件

- `src/loaders/octree-refinement-controller.ts` — burst、sync、activity 事件
- `src/viewer.ts` — zoom 检测、连续渲染
- `docs/Octree-Refinement调度加速计划.md` — 既有 foreground / boost 设计

---

## 7. 粗→次粗「逐档 ladder」

**现象**：bootstrap 最粗档上屏后，到次粗档仍慢、阶梯感不强。

**原因**：调度直接追 `optimalLod`（拉近时常是 L0），Lmax→Lmax-1 的 SOG 在下载队列里被细档挤后。

**改动**：

1. **`computeRefinementTargetLod`**：`currentLod > optimal` 时本帧只拉 **`currentLod - 1`**，逐档变细。
2. **得分**：Lmax→Lmax-1 ×2.75，其它单档步进 ×1.6。
3. **unlock 后 48 帧 burst**；`lodUpdateDistance` 0.18 / 0.12；stale sync 冷却 6 帧。

separate 资产每档仍要 HTTP；ladder 让「糊→稍清→更清」按台阶出现，而不是长时间停在最糊。
