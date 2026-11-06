# 南广场缺块 + createBindGroup 级联 — 排查说明

日期：2026-07-22  
分支：`mega-scene-load-v2` vs `wlq_dev_v4`

## 现象

南广场（nanguangchang-v6）漫游时：

1. 画面**缺块**
2. `[webgpu-bind-group-guard] createBindGroup-threw: … not of type GPUBufferBinding`
3. 随后 `RenderPassEncoder … already finished` / `SetBindGroup(1, [null])` / Invalid CommandBuffer
4. 偶发 `Attribute shader location (0) is used more than once`

用户判断：`wlq_dev_v4` 无此问题，怀疑与本分支 unload 相关。

## 结论（高置信）

**与本分支相对 v4 的调度/防护改动相关，不是南广场资产本身。** 两条链路叠加：

### A. 资源侧（本分支有、v4 无）

| 能力 | v4 | 当前分支 |
|------|----|----------|
| `releasePinnedFiles` → `decRefCount` | **无** | idle 排空首帧、**每次 `notifyCameraMoved`** 都会调 |
| `idleQueueDrain` | **无** | 默认开 |
| `reclaimIdleLoadedFiles` | 无 | 曾合入又 **Revert**（`b777c081`），不是现网主因 |

引擎 `decRefCount`：ref→0 后进入 cooldown，到期 `unloadResource` → `assetLoader.unload` → **GPU buffer 销毁**。  
若此时 WorkBuffer bake 仍拿该 resource 建 bind group → 正好报 `GPUBufferBinding` 非法。

相机一动就 `releasePinnedFiles`，南广场这种频繁换视角场景更容易撞上。

### B. 防护侧（本分支有、v4 无）

`webgpu-bind-group-guard`（`ca721abb`）本意为 tab 恢复竞态：

1. `WebgpuBindGroup.update` **先 destroy 旧 bind group，再 createBindGroup**
2. create 抛错 → bind group 已是 **null**
3. 旧版 guard 仍 `setBindGroup(1, …)` → 日志里的 **`SetBindGroup(1, [null])`**
4. 同时 **skip draw** → WorkBuffer MRT 少画若干 interval → **画面缺块**
5. encoder/pass 状态被打乱 → 后面一串 `Parent encoder already finished`

因此：**缺块不全是「没下载到」；相当一部分是 bake 中途 bind group 失败后被 skip 掉的 draw。**

## 与「unload 改动」的关系

- **直接相关**：`53aba9ad` idle 清空 + 后续 pin release 路径（相对 v4 新增）。
- **间接放大**：bind-group-guard 把偶发 create 失败变成系统性 skip-draw + 控制台风暴。
- **不是**：已 revert 的 `reclaimIdleLoadedFiles`（那条已不在树里）。

## 已做修复（本轮 / 后续）

1. **`pinRelease` 默认不再走 runtime decRef**（对齐 v4）；当前树亦无默认 pinRelease 开关路径。
2. **2026-07-22**：曾移除 `webgpu-bind-group-guard`（旧版 skip draw + `SetBindGroup(null)` 干扰缺块判断）。
3. **2026-08-06**：在 pinRelease 已收敛前提下，**不用 bind-group-guard**，改为 `webgpu-visibility-session`（后台停 bake + 归来强制 WorkBuffer 重建）。见 [WebGPU-WorkBuffer-BindGroup恢复竞态说明](WebGPU-WorkBuffer-BindGroup恢复竞态说明.md)。

## 建议复验

1. 南广场默认 WebGPU：切后台较久再回来，控制台不应再出现未捕获的 `GPUBufferBinding`；可见 `[webgpu-visibility-session] arm settle` / `force gsplat gpu rebuild`。  
2. 漫游缺块不应因防护回归（不再 skip 单次 WorkBuffer draw）。
