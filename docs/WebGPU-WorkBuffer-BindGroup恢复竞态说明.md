# WebGPU WorkBuffer BindGroup 恢复竞态说明

日期：2026-07-19

## 结论（定性）

控制台里这几条：

1. `createBindGroup` → `not of type GPUBufferBinding`
2. `No bind group set at group index 1`
3. `Command buffer recording ended before RenderPassEncoder was ended` / `Invalid CommandBuffer`

**是同一根因的级联，不是三个独立 bug。**

若复现稳定落在「离开页面再回来」，可定性为 **WebGPU suspend/resume（或 device lost/restore）下，WorkBuffer bake 早于 GPU buffer 重新有效**；`scene.dirty` / full rebuild 只是让竞态更容易撞上。

## 调用链（对照 PlayCanvas 2.20 源码）

```
GSplatManager.update()
  → GSplatWorld.bake()
    → rebuildWorkBuffer()
      → GSplatWorkBuffer.render()
        → GSplatWorkBufferRenderPass.render() / execute()
          → renderSplat()
            → QuadRender.render()
              → bindGroup.update()          // BINDGROUP_MESH = group 1
                → WebgpuBindGroup.update()
                  → device.wgpu.createBindGroup(desc)
```

`webgpu-bind-group.js` 里 buffer 取值：

- uniform（persistent）：`ub.impl.buffer`
- uniform（dynamic）：`ub.allocation.gpuBuffer.buffer`
- storage：`buffer.impl.buffer`

任一为 `null`/`undefined` 时，`resource: { buffer: … }` 不满足 `GPUBufferBinding`，抛出第一条错误。

## 级联机制

| 步骤 | 原因 |
|------|------|
| group 1 未 set | `createBindGroup` 抛错后 `setBindGroup(BINDGROUP_MESH, …)` 未执行 |
| RenderPass 未 end | `RenderPass.render()` 无 try/finally：`start → execute → end`，中间抛错跳过 `endRenderPass` |
| Queue.Submit 失败 | 未结束的 encoder → Invalid CommandBuffer |

额外引擎细节：`BindGroup.update` 在调用 `impl.update` **之前**就把 `dirty = false`。若 create 抛错，下一帧可能不再重试，直到其它路径重新置 dirty。

## 与「页面隐藏」的关系

- `AppBase.onVisibilityChange` **只暂停音频**，不暂停 `update/render`。
- `graphicsDevice.contextLost` 仅在真正 `wgpu.lost` 时置位；tab 切后台不一定走 `devicelost`。
- `WebgpuBuffer.loseContext()` 会把 `this.buffer = null`——一旦经历 lost/restore 竞态，正好命中 `GPUBufferBinding` 类型错误。
- bake 发生在 **`update()`**，不是 `render()`；只跳过 `autoRender` 不够，必须挡住 `QuadRender`/`createBindGroup` 或推迟 bake。

## 排查时应看的字段

在失败帧打印（已由 `webgpu-bind-group-guard` 在 skip/throw 时输出）：

- `document.visibilityState`、`framesSinceVisible`、`lastHiddenDurationMs`
- `graphicsDevice.renderVersion`、`contextLost`、是否刚 `devicerestored`
- uniform：`persistent` / `impl.buffer` / `allocation.gpuBuffer.buffer`
- storage：`impl.buffer`

判读：

- `allocation.gpuBuffer.buffer == null` → 动态 UB 未分配或已 detach
- `impl.buffer == null`（persistent UB 或 storage）→ 更像 WorkBuffer/material 仍引用恢复前资源

## Viewer 侧防护

> **2026-08-06**：去掉 bind-group-guard。改为 `src/render/webgpu-visibility-session.ts`：  
> - `document.hidden` 期间不跑 update/render（复用 tick 的 contextLost 早退）  
> - 长 hidden 归来 / `devicerestored` 后 settle 空心跳，再 `scene.gsplat.dirty` + `world.invalidate({ worldState, workBuffer })`  
> 关闭：`?webgpuVisPause=0`。

> **2026-07-22（历史）**：曾整段移除 guard（旧版 skip draw 叠加 pinRelease 会放大缺块）。  
> **2026-07-19（历史）**：曾用 createBindGroup guard；只能吞异常，不能避免半截 bake。


## 非本次重点

`totalBlocks` / `uploadedBlocks` / LOD 数量与此级联无关；它们最多放大「恢复后立刻 full rebuild」的概率。
