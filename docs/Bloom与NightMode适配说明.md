# Bloom 与 Night Mode 适配说明

---

## 一、当前设计（统一逻辑）

- **Bloom**：无论调亮还是调暗，都使用 **settings 里的 bloom 强度**（由 `configureCamera` → `applyToCameraFrame` 写入），不在 Night Mode 里改写。
- **Night Mode**：只负责主光强度、天空球强度、以及 GS 球 shader 的调亮/调暗；不碰 `bloom.intensity`。
- **事件**：仅在 **fade 数值发生变化**时 fire `nightFade:changed`，viewer 收到后再 `configureCamera`，避免每帧无意义重跑。

这样调亮和调暗的表现一致（都能看到 settings 的 bloom），逻辑单一、易维护。

---

## 二、执行顺序（改后）

1. **Bloom 强度**  
   - 唯一写入点：`BloomController.applyToCameraFrame()`（在 `configureCamera` 里被调用）。  
   - 触发时机：初始化、`postEffect:changed`、**以及 `nightFade:changed`**（且仅在 fade 变化时 fire，不再每帧）。

2. **nightFade:changed**  
   - 在 `setNightFade`、`applyFromSettings`、`nightFade:set` 里会 fire 一次。  
   - 在 `updateEffect()` 里：仅当 `this.nightFade !== this._lastFiredNightFade` 时 fire，并更新 `_lastFiredNightFade`，避免同一数值每帧重复触发。

---

## 三、与 Bloom 相关的其他部分（不变）

- **Shader**：调暗时 `mult = mix(1, nightColor, -f)`，调亮时 `mult = baseBright * (1 + dirContrib)`；亮部参与 bloom 的 brightPass。
- **主光 / 天空球**：与 fade 同向。
- **Bloom Brush**：笔刷内亮部不压暗、参与 bloom；数据流仍为 BloomController → setBloomBrushParams / setCommittedBrightnessVolume → NightMode。

---

## 四、小结

| 场景     | Bloom 强度来源     | nightFade:changed |
|----------|--------------------|--------------------|
| 调亮     | settings（统一）   | 仅 fade 变化时 fire |
| 调暗     | settings（统一）   | 仅 fade 变化时 fire |
| 无 Night Mode | settings       | 不涉及             |

**结论**：调亮/调暗逻辑已统一，Bloom 由 settings 一处控制；`nightFade:changed` 仅在 fade 变化时触发，逻辑清晰、表现符合预期。
