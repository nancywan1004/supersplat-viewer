# Octree Refinement 调度加速计划

> 在 **separate + bundled** 资产布局不变的前提下，通过前端调度优化「拉近后糊→清」的体感速度。  
> 实施日期：2026-06-05

---

## 1. 背景与约束

### 1.1 问题

普通 octree streaming（如 `yunji` / `yunji-v2`）在相机拉近后，画面从粗档过渡到 L0 细档偏慢。对比 aholo / universe 类资产，瓶颈不在 PlayCanvas engine，而在：

- **separate 模式**：每升一档常需新 HTTP 下载独立 SOG；要到 L0 必须拉 L0 文件，前端无法「跳过下载」。
- **现网 yunji**：约 1403 leaf、101 文件；`yunji/` 未 bundled，`yunji-v2/` 已 bundled（`0_0.sog` 等）。

### 1.2 已排除方向

- **Universe Pack / permanentFiles 预载**：用户已撤回 aholo/universe 专用方案，不在本计划范围。
- **加 LOD 档数**：separate 下档越多、切换越慢；更有效的是 **减小 `lod-chunk-count` / `lod-chunk-extent` + bundled**（资产侧，见 `LOD资产切片优化规格-splat-transform.md`）。

### 1.3 本计划范围

仅改 **viewer 前端调度**（`octree-refinement-controller` + `viewer` 联动），不动 splat-transform 产出逻辑。

---

## 2. 目标

| 目标 | 说明 |
|------|------|
| 停驻后中心优先变清晰 | 相机 idle ≥0.15s 解锁 streaming LOD 后，refinement 进入 boost，视野中心 L0 chunk 优先下载与上屏 |
| boost 可重复触发 | 挪机后再停住，仍能重新 boost，而非 finish 后永久退出 |
| critical 文件保活 | 已落地的中心 critical SOG 不因 LRU 被卸，避免「清了又糊」 |
| 落地即 sync | 文件落地或 `frame:ready` loading 下降时立即 `syncOctreePendingPlacements`，缩短上屏延迟 |
| 拉近 burst | orbit 距离/FOV 突变时 burst 窗口内 `lodUpdateDistance=0` + 立即 prefetch；详见 [Octree-拉近LOD感知优化](Octree-拉近LOD感知优化.md) |

---

## 3. 改动清单

### P0 — 调度核心

#### P0-1 `lodUrgency` 评分（`scoreVisibleNode`）

```ts
let lodUrgency = 1 + (maxLod - optimalLod) * 0.5;
if (optimalLod === 0) {
    lodUrgency *= 1.25;
}
return screenSize * lodUrgency * centerBias / (1 + localDistance * 0.02);
```

- `optimalLod` 越小（越需要细档）→ 下载优先级越高。
- L0 额外 ×1.25，保证中心 L0 chunk 排在队列前部。

#### P0-2 boost / idle 两档生命周期

| 状态 | 行为 |
|------|------|
| `boostActive = true` | 提高并发、budget、lod 更新频率 |
| `boostActive = false` | 恢复 `savedLoaderConcurrency` / `splatBudget` / `lodUpdateDistance` |
| `active` 常驻 | `update` 监听不随「任务完成」移除；仅 `destroy()` 时 `stopRefinementController` |

**进入 boost 条件**（`needsBoost`）：

- `cameraMovedSinceSettle`（挪机后由 viewer 通知）
- `criticalPendingUnique > 0`
- `staleLoadedNodes > 0`
- `needsLodSwitch && pendingUniqueFiles > 0`
- `settleFramesRemaining > 0`（下载/落地后的 settle 窗口）

**退出 boost**：上述条件全不满足时 `restoreRefinementMode()`。

#### P0-3 停驻 boost 常量（desktop）

| 常量 | 原值 | 新值 |
|------|------|------|
| `BOOST_MAX_CONCURRENT` | 6 | **8** |
| `CRITICAL_DOWNLOAD_LIMIT` | 12 | **16** |
| `REFINEMENT_SPLAT_BUDGET` | 6M | **8M** |

mobile 保持 4 / 6 / 3M。

### P1 — 保活与上屏

#### P1-1 critical 文件 pin（`pinLoadedCriticalFiles`）

- `fileJustLanded` 时对已加载的 critical batch 调用 `octree.incRefCount(fi)`。
- `pinnedCritical` Set 去重，debug 输出 `pinnedCritical` 数量。

#### P1-2 落地 / frame 即时 sync

- `fileJustLanded`：除原有 settle 外，立即 pin + 必要时二次 `syncOctreePendingPlacements`。
- `frame:ready`：`loading` 从 >0 下降时触发 sync + `markOctreeInstancesDirty`。

### P1-3 viewer 联动（`viewer.ts`）

- `tryUnlockStreamingOnCameraIdle` 在 `streamingLodUnlocked` 后，检测相机移动/旋转 → `octreeRefinementController.notifyCameraMoved()`。
- `notifyCameraMoved`：置 `cameraMovedSinceSettle = true`，清零 `settleFramesRemaining`，下一帧 `runPriorityPrefetch` 重新 `enterRefinementMode`。

### P2 — 可选（未实施）

- bootstrap 50% 后对视野中心 L0 做轻量预取。留作后续若 P0+P1 仍不足时再开。

---

## 4. 涉及文件

| 文件 | 改动 |
|------|------|
| `src/loaders/octree-refinement-controller.ts` | P0/P1 全部逻辑 |
| `src/viewer.ts` | `notifyCameraMoved` 接线 |
| `docs/Octree-Refinement调度加速计划.md` | 本文档 |

---

## 5. 调试与验收

### 5.1 调试 URL

```text
/index.html?content=/assets/gsplat/lods/yunji-v2/lod-meta.json&settings=/assets/settings/settings-yunji.json&debugOctreeRefinement=1
```

### 5.2 期望现象

1. 首屏 bootstrap 完成后，相机停住约 0.15s → streaming LOD 解锁，refinement `start()`。
2. 再停住 3s 左右，视野中心应由糊变清。
3. 控制台 `[octree-refinement]` 每 2s：
   - `boostActive: true`（有 pending 或 settling 时）
   - `criticalPendingUnique` 逐步 → 0
   - `pinnedCritical` > 0（critical 落地后）
4. **挪机后再停**：`notifyCameraMoved` 触发，`boostActive` 可再次为 true，中心继续 refinement。

### 5.3 回归注意

- 性能模式切换：boost 期间 `performanceMode:changed` 会 `applyBoostSettings()` 重应用 boost 参数。
- `destroy()` 仍完整清理 handler、pinned 状态、loader 队列优先级。

---

## 6. 与资产侧优化的关系

本计划解决 **「同一资产布局下，前端如何把已有 SOG 更快排到中心并上屏」**。

若需进一步缩短「必须等的 HTTP 次数」，应配合 splat-transform：

- 减小 `--lod-chunk-count` / `--lod-chunk-extent`
- 使用 `--lod-pack-mode bundled`（如 `yunji-v2`）

两者正交、可叠加。
