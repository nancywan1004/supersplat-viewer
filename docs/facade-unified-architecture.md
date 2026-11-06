# 统一 Facade 架构评审（资产 / 标注 / 环境 / 特效）

> 目标是在不破坏现有 `postMessage` 协议事件名与宿主联动语义的前提下，让 `asset / annotation / environment / effects` 四个编辑模块拥有一致的“模块生命周期 + selection/gizmo 清理一致性 + 协议入口对齐”。

## 1. 现状概览：四个模块的差异

### 1.1 标注（annotation）
- 已存在独立的 facade 入口：`src/annotation-toolbar/init-annotation-system.ts`。
- `AnnotationManager` 维护标注实体集合与选择态（`state.selectedAnnotationId`）。
- `gizmo` 的解绑依赖多处监听：`annotation-ui.ts`、以及 `gizmo-handler.ts`（对 gizmo 只负责资产/环境；标注 gizmo 通过 `annotation-gizmo-handler.ts` 接管）。
- 真实问题表现为：模块切换时可能出现“selectedAnnotationId / gizmo 残留”，以及 selection 回传在某些路径下不触发父级。

### 1.2 资产（asset）
- 核心落在 `src/asset-placement-handler.ts` + `src/gizmo-handler.ts`。
- 选择态由 `state.selectedSceneEntityId` 表示，放置/拾取/复制/删除都散落在 `asset-placement-handler.ts` 内。
- 模块切换清理逻辑分布式：
  - `asset-placement-handler.ts` 在 `editLeftModule:changed` 内清空 `selectedSceneEntityId`、重置 `assetTransformMode`。
  - `gizmo-handler.ts` 在 `editMode:changed` / `editLeftModule:changed` / `assetTransformMode:changed` / `sceneAsset:selected` 等路径上同步/清理 gizmo。
- selection 回传（父级 `SCENE_ASSET_SELECTED`）在 `src/message-bridge.ts` 中依赖 `sceneAsset:selected` 的 `source`（目前仅当 `source === 'scene'` 才会 post）。

### 1.3 环境（environment）
- 主要由 `src/ui/components/lighting-ui.ts` 与 `src/ui/components/post-effect-ui.ts` 修改 settings，并通过 events 驱动运行时更新（`lighting:changed` / `postEffect:changed`）。
- 运行时光源 gizmo/可视化显隐由 `src/gizmo-handler.ts` 与 `src/light.ts` 按 `state.editMode` + `state.editLeftModule === 'environment'` 决定。
- selection（光源拾取）在 `src/light.ts` 内通过 `sceneLight:selected { source: 'scene' }` 发出；协议/列表操作会以 `host` 作为 source（并在 `message-bridge.ts` 中被过滤掉只向父级回传场景选择）。

### 1.4 特效（effects）
- 运行时控制中心是 `src/reveal.ts`（`RevealController`）。
- UI 组件（如 `src/ui/components/reveal-ui.ts`）触发 `revealConfigChanged / effectPlayPause:* / effectTimeline:*` 等事件。
- 协议入口经 `editor-modules/protocol-adapters/effects-protocol-adapter.ts` 写入 `settings.revealEffect` / `state.vfxType`，并 fire 同一组事件，使 `RevealController` 接管。
- “是否属于 effects 模块”的切换本身不直接影响 VFX 播放；更多由 `VFX_EXIT / VFX_RESTART` 语义控制。

## 2. 统一设计目标

为四个模块建立一致的“ facade 体系”，核心是解决以下长期问题：

1. **模块生命周期一致性**
   - `enter` / `exit` / `editModeExit` 三个阶段都有明确的强制清理语义（selection、gizmo、以及必要的 transient state）。
2. **selection 回传路径一致性**
   - selection 事件 payload 的 `source` 语义要可控、可预测，从而保证 `message-bridge.ts` 的过滤策略不再因 UI 时序而失效。
3. **UI 挂载时序不应成为正确性的前提**
   - 类似 annotation 的独立 `initAnnotationSystem` 这种“系统级兜底”，应成为 asset/environment/effects 的可复用范式。
4. **bridge 边界保持不变**
   - 你偏向 `message-bridge.ts` 保留“协议 ↔ 内部事件映射层”职责边界，因此统一 facade 应以“内部系统入口”形式被 bridge 调用或被模块管理器触发，而不重写 bridge 结构。

## 3. 建议的统一 Facade 架构

### 3.1 组件划分

建议引入两层 facade：

1. **`EditModuleManager`（全局模块调度器）**
   - 监听 `editMode:changed` 与 `editLeftModule:changed`
   - 负责在 enter/exit/editModeExit 三个阶段调用各模块 system facade 的生命周期方法。
2. **每个模块一个 `*SystemFacade`**
   - `AssetSystemFacade`
   - `AnnotationSystemFacade`
   - `EnvironmentSystemFacade`
   - `EffectsSystemFacade`

### 3.2 `*SystemFacade` 接口（contract-spec）

每个模块系统 facade 推荐实现如下方法（已在 `src/types.ts` 预留类型契约，当前阶段仅约束接口，不改变运行时行为）：

- `onEnter(ctx: ModuleContext): void`
  - 进入模块：同步模块可交互状态；**默认不强制选择第一项**，避免隐式选中。
- `onExit(ctx: ModuleContext): void`
  - 离开模块：**强制清理 selection 与 gizmo/state**（核心在“正确性保证”，而非“视觉刷新”）。
- `onEditModeExit(ctx: ModuleContext): void`
  - 退出编辑模式：统一做“全模块强制清理”（gizmo解绑、selected 置空、必要的 transient 复位）。
- `handleCommand(ctx: ModuleContext, command: ModuleCommand): void`
  - 统一命令入口：收敛“协议映射/UI 事件”的最终执行业务入口。
- `selectById(id: string | null, source: 'host' | 'scene' | 'unknown', options?: any): void`
  - selection 的单一出口（将内部 state 写入与事件派发收敛到系统一处）。
- `dispose(ctx: ModuleContext): void`（可选）
  - 模块系统销毁时释放监听与临时资源。

### 3.3 统一 source 语义（contract-spec）

- `SelectionSource = 'scene' | 'host' | 'unknown'`
- **约束**：
  - 所有 `scene*selected` 事件必须携带 `source`
  - `message-bridge.ts` 只转发 `source === 'scene'` 的 `SCENE_*_SELECTED`
  - 禁止新增“无 source 的选中派发”路径

### 3.4 `ModuleContext`（用于让接口具备同构参数）

建议 `ModuleContext` 至少包含：

- `global: Global`
- `state` 与 `events` 快捷引用
- `current editMode / editLeftModule`（用于防止竞态）

### 3.5 四模块清理清单（contract-spec）

- `asset`：
  - 清 `selectedSceneEntityId`
  - 清 `assetTransformMode`
  - detach 资产 gizmo
- `annotation`：
  - 清 `selectedAnnotationId`
  - 清 `annotationTransformMode`
  - 取消 placement/editing 中间态，detach 标注 gizmo
- `environment`：
  - 清 `selectedLightId`
  - 清 `lightTransformMode`
  - detach 光源 gizmo，并按模块规则收敛 light visual 显隐
- `effects`：
  - 不在模块切换时隐式改写 `settings.revealEffect.type`
  - 按既定 `VFX_EXIT` / policy 语义处理临时播放状态，清理模块级 transient 监听

## 4. 关键迁移点（分阶段，保持协议兼容）

### Phase 0：仅建立“接口规范 + 生命周期清理对齐清单”（无功能变更）
- 先在文档层对齐每个模块目前：
  - selection state 键名（`selectedSceneEntityId / selectedAnnotationId / selectedLightId / vfxType/vfxActive`）
  - gizmo 解绑路径
  - 模块切换时的清理动作集合

### Phase 1：引入 `EditModuleManager` + 强制清理
- 由 manager 统一调用各模块的 `onExit` / `onEditModeExit`。
- 目标是一次性保证你遇到的问题不会再依赖 UI 时序或挂载顺序：
  - `annotation -> asset` 切换时 selected/gizmo 残留
  - 重复点击选择回传缺失（由 selection 单一出口处理）

### Phase 2：收敛 selection 的事件派发与 source 语义
- 强制约定每次 `scene*selected` 事件都携带明确 `source`：
  - “场景拾取 / 热点点击” => `source: 'scene'`
  - “列表点击 / UI 驱动” => `source: 'host'`
  - “协议驱动的语义事件” => 视语义决定（如“确认放置”可视为场景行为）
- `message-bridge.ts` 的过滤策略保持原样或只做迁移适配。

### Phase 3：bridge 最后调用系统 facade（bridge 结构保留）
- 仍保留 `message-bridge.ts` switch-case 结构
- 但将 switch 中散落的处理改为统一入口调用 `*.systemFacade.applyProtocolXXX()`

## 5. 关键痛点与新设计的覆盖关系（你当前遇到的）

1. **父级在 annotation -> asset / 其他模式切换时存在 selected/gizmo 残留**
   - 新设计通过 `EditModuleManager.onExit()` 强制清理：
     - annotation：取消选中 + gizmo:detach
     - asset：selectedSceneEntityId=null + assetTransformMode=undefined + gizmo 清理
2. **重复点击已选中的 annotation 不能再触发 `SCENE_ANNOTATION_SELECTED`**
   - 新设计的核心是 selection 单一出口策略：
     - `selectById()` 可以显式支持“重复点击也要 fire”（由系统策略控制）
     - 避免在 manager 内部多个入口短路造成回传缺失
3. **新建标注放置成功后点击不触发（但旧标注能触发）**
   - 归因通常是 source/事件触发时机不一致：
     - 放置确认时应在系统选择出口里以语义正确的 `source` 触发上报
4. **asset/environment/effects 的模块清理分散，导致偶发状态一致性问题**
   - manager 统一 lifecycle + 系统 facade 提供强制清理语义，降低“UI 挂载是否发生”的正确性依赖。

## 6. mermaid 数据流图（架构示意）

```mermaid
editState[editMode/editLeftModule 变化] -->|"EditModuleManager 监听"| moduleManager[EditModuleManager]

moduleManager -->|"onExit / onEditModeExit"| annotationSystem[AnnotationSystemFacade]
moduleManager -->|"onExit / onEditModeExit"| assetSystem[AssetSystemFacade]
moduleManager -->|"onExit / onEditModeExit"| environmentSystem[EnvironmentSystemFacade]
moduleManager -->|"onExit / onEditModeExit"| effectsSystem[EffectsSystemFacade]

messageBridge[message-bridge.ts（keep 结构）] -->|"协议事件映射最后调用"| moduleFacadeEntry[对应 SystemFacade.applyProtocolXXX]
moduleFacadeEntry -->|"写 state/settings + fire 内部事件"| internalEvents[统一内部事件（scene*selected / lighting:changed / revealConfigChanged...）]

internalEvents -->|"被 gizmo-handler / light.ts / RevealController / UI 监听"| runtime[运行时更新]
```

## 7. 参考：当前关键文件（后续重构的落点）

- `src/annotation-toolbar/init-annotation-system.ts`
- `src/annotation-toolbar/annotation-manager.ts`
- `src/asset-placement-handler.ts`
- `src/gizmo-handler.ts`
- `src/light.ts`
- `src/reveal.ts`
- `src/message-bridge.ts`
- `src/settings-serialize-configs.ts`（`ExperienceSettings` 相关默认片段）
- `src/settings-serialize-helper.ts`（对存盘 settings 树的 ensure* 补齐；与 `settings-serialize.ts` 的 JSON 序列化分工）
- `src/editor-modules/protocol-adapters/environment-protocol-adapter.ts`
- `src/editor-modules/protocol-adapters/effects-protocol-adapter.ts`

