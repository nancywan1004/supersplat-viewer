# SaaS 第四期 编辑模式接口文档

> **定位**：在第三期《编辑模式交互职责划分》基础上的**接口与数据模型升级说明**，侧重 **特效（Effects）三轨**、**持久化 `settings.effects`**、**运行态 `state.effectsRuntimeState`** 以及 `**EFFECT_*` 入站协议**（`module: 'effects'` **可选**；与左侧 `**editLeftModule`** 的 `effects` 门面键同字面值；`effectId` 联合路由）。  
> **非目标**：本文不重复第三期已约定的资产 / 标注 / 光照 / 后处理全量事件表；未改动的命令仍以第三期文档为准。  
> **特效协议**：宿主侧 `**EFFECT_*`** 以本文为准（`**module` 可不传**；若传则须为 `**effects`**）；第三期文档中的 `VFX_*` 表格视为历史约定，不要求再修订第三期文件。

---

## 1. 与第三期的关系


| 维度                 | 第三期                                         | 第四期（本文）                                                                                                                                                                                                                                              |
| ------------------ | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 特效入站事件名            | `VFX_TYPE_SET` / `VFX_EXIT` / `VFX_RESTART` | `EFFECT_PARAMS_PATCH` / `EFFECT_TOGGLE` / `EFFECT_REPLAY`                                                                                                                                                                                            |
| 入站通用字段             | 无统一 `module`                                | `**module: 'effects'` 可选**；与 `effectId` 联合路由（与 `CommandRegistry` 的 `effects` 门面键同字面值）                                                                                                                                                                |
| 场景 GSplat effectId | 无                                           | reveal 固定 `**scene.gsplat-reveal`**；persistent 固定 `**scene.gsplat-persistent**`（与 Viewer 常量一致）                                                                                                                                                       |
| 持久化                | 主要依赖 `settings.revealEffect`                | `**settings.json` 以 `settings.effects` 为 scene reveal 真源**（`effects.reveal`）；导出快照**不写出** `revealEffect` 键。内存中 `revealEffect` 仅作读兼容影子，由 `syncLegacyRevealEffectShadow` 与 `effects.reveal` 对齐；存盘前经 `flushRevealIntoEffectsForExport` 将遗留内存刷入 `effects` |
| 运行态                | `state.vfxType` / `state.vfxActive`         | 保留；新增 `**state.effectsRuntimeState`**（不入库）                                                                                                                                                                                                           |


---

## 2. 持久化：`settings.effects`（v2）

与 `ExperienceSettings.version === 2` 并存，字段为**三轨**结构：

- `**effects.reveal`**：一次性开场类（含 timed reveal 等）。
  - `activeEffectId?: string`
  - `paramsById: Record<string, Record<string, unknown>>`
- `**effects.persistent**`：可持续场景风格化（如 `perlin-wave`）。
  - `activeEffectId?: string`
  - `**enabled: boolean**`（**仅此轨**允许持久化 `enabled`）
  - `paramsById: Record<string, Record<string, unknown>>`
- `**effects.asset`**：资产级特效默认参数占位。
  - `defaultParamsById: Record<string, Record<string, unknown>>`

### 2.1 当前场景 reveal 参数存放约定

对 `**effectId === 'scene.gsplat-reveal'**` 的参数字典，与既有 `revealEffect` 对齐的键包括：

- `type`：特效类型（与 `RevealEffect.type` 一致）
- `autoStart`、`totalDuration` 等（与 `RevealEffect` 其余字段一致）；`**effectParams**` 为按 `type` 白名单的脚本专参（见 `reveal-effect-params.ts`）

`**scene.gsplat-persistent` 的 `paramsById**`：`**type` / `autoStart` / `effectParams`（可选）**；**不含** `totalDuration`。专参白名单见 `**persistent-effect-params.ts`**；写入由 `**patchPersistentSettingsFromParams**` 完成。

**持久化（当前实现）**：`settings.json` 中 **scene reveal 以 `settings.effects.reveal` 为真源**；导出前经 `flushRevealIntoEffectsForExport` 将内存中的 `revealEffect` 刷入 `effects` 后 **不再写出 `revealEffect` 键**（旧文件仍可带 `revealEffect` 导入，由 `normalizeEffectsOnImport` 与 `effects.reveal` 对齐）。若导入时 `**effects.reveal.paramsById['scene.gsplat-reveal'].type` 与 `revealEffect.type` 不一致**，以 `**effects.reveal`** 为准写回内存中的 `revealEffect`（`syncLegacyRevealEffectShadow`）。

### 2.2 双轨：reveal（一次性）+ persistent（可持续）

- **reveal**：`revealEffect`（内存影子）与 `**effects.reveal.paramsById['scene.gsplat-reveal']`**（文件真源）表示一次性开场 / Timed；与 `RevealController` 的 `createEffect` 一致。
- **persistent**：`**effects.persistent`**（`enabled: true` + 同 `effectId` 下 `paramsById`，`type` 为可持续类如 `perlin-wave`）可与 reveal **并存于 JSON**；运行时由 Viewer 在 `**revealComplete` 之后**再挂载 persistent GSplat 脚本（避免与 reveal 抢同一 shader 时序），门控见 `shouldDeferPersistentMount`（`effects-sync.ts`）。协议/adapter 在需重挂或拆除实体脚本时会派发 `**persistentGsplatEffectRemountRequested`**，Viewer 在下一帧 `**frameend**` 侧经 `**runPersistentGsplatEntityLifecycle**`（`persistent-gsplat-lifecycle.ts`）完成 registry 同步与 remount（实现细节，**不改变**宿主仍只发 `EFFECT_*` 的约定）。
- **旧单轨兼容**：仅 `revealEffect.type === 'perlin-wave'` 等、无独立 `effects.persistent` 时，仍按 legacy 解析为可持续参数（`readPersistentRevealParams`）。

---

## 3. 运行态：`state.effectsRuntimeState`（不入库）

与 `global.settings` 并列，**不写回 `settings.json`**。用于 UI / 调试 / 宿主状态对齐；`**reveal.activeType` 由 `syncEffectsRuntimeStateFromSettings` 从 `readRevealParams(settings)` 推导**；`reveal.status` 在播放中由 `patchRevealRuntimeMirror` 与 sync 的「`playing` 粘性」协同（见实现代码）。

结构概要：

- `reveal: { activeEffectId?, activeType?, status }`
- `persistent: { activeEffectId?, activeType?, status }`
- `asset: { instances: Record<string, { effectId, status }> }`
- `lastError?`：预留（协议拒绝、校验失败等）

`status` 取值与内部 `EffectRuntimeStatus` 一致（如 `idle` / `playing` / `stopped` 等）。

---

## 4. 父级 → Viewer：特效相关 postMessage（第四期）

以下 payload 字段与 `**src/message-bridge/` 实现**一致；`**EFFECT_*` 入站若带 `module` 且不为 `effects` 则丢弃**并 `console.warn`（**不**再处理历史 `VFX_*` 入站）。

### 4.1 通用约束

- `**module`**：**可选**；若父级传入则须为 `**'effects'`**（与 `src/editor-modules/modules-types.ts` 中 `**MESSAGE_BRIDGE_MODULE.effects**` 一致）。缺省时 Viewer 仍按 `**effectId**` / `**params**` 处理入站 `EFFECT_*`。
- `**effectId**`：按轨道固定：
  - reveal 轨命令：`**scene.gsplat-reveal**`
  - persistent 轨命令：`**scene.gsplat-persistent**`

### 4.2 事件表


| 功能                               | 事件名 `type`            | payload                                                                                                                      |
| -------------------------------- | --------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| 特效参数补丁（reveal / persistent 统一入口） | `EFFECT_PARAMS_PATCH` | `{ effectId, params: { … }, module?: 'effects' }`                                                                            |
| persistent 开关（仅支持 persistent 轨）  | `EFFECT_TOGGLE`       | `{ effectId: 'scene.gsplat-persistent', value: boolean, module?: 'effects' }`                                                |
| 重新播放                             | `EFFECT_REPLAY`       | `{ effectId: 'scene.gsplat-reveal', restartAnim?: boolean, module?: 'effects' }`（默认 `restartAnim !== false` 等价于第三期「默认 true」） |


**语义说明**：

- `EFFECT_PARAMS_PATCH` 映射到内部更新 `**settings.effects.reveal`**（scene reveal **唯一写源**），并由 `syncLegacyRevealEffectShadow` 对齐内存中的 `revealEffect`；随后 `syncEffectsRuntimeStateFromSettings` 与 `revealConfigChanged` 驱动 `RevealController`。从单轨 persistent 切到非 persistent reveal 类型时，会 `**clearPersistentRevealTrack`** 避免误留双轨脏数据。
- `EFFECT_PARAMS_PATCH` 在 `effectId='scene.gsplat-persistent'` 时经 `**patchPersistentSettingsFromParams**` 写入 `**settings.effects.persistent**`（`paramsById` 包为 `**type` / `autoStart` / `effectParams**`，**无** `totalDuration`）；随后按 reveal 是否独占播放决定 **立即** 或 `**revealComplete` 后** 派发 `**persistentGsplatEffectRemountRequested`** 以重挂脚本并应用专参。
- `EFFECT_TOGGLE` 仅接受 `effectId='scene.gsplat-persistent'`；`value=true/false` 对应开启/关闭 persistent 轨（不会作为 reveal 轨停播命令使用）。
- `EFFECT_REPLAY` 派发 `revealRestart`。

### 4.3 物理碰撞（`settings.collision`，`module: 'camera'`）

持久化真源为 `**settings.collision**`（`url` / `enabled` / `scale`）；`debugVisual` 仅会话态，不入库。


| 功能   | 事件名 `type`        | payload                                                                                                     |
| ---- | ----------------- | ----------------------------------------------------------------------------------------------------------- |
| 总开关  | `COLLISION_SET`   | `{ value: boolean }` — 场景 mesh 碰撞 + 放置资产 AABB                                                               |
| 部分更新 | `COLLISION_PATCH` | `{ value: SceneCollisionSettingsPatch }` — 可含 `enabled`、`url`、`scale`（`gaussian` / `mesh` 轴缩放或标量、`autoFit`） |


AABB 调试线框（`debugVisual`）仅 Viewer 内「物理碰撞」面板与会话态，**无**父级入站事件。

实现：`collision-protocol-adapter.ts` + `message-bridge.ts`；与 Viewer 内「物理碰撞」面板行为一致。

### 4.4 视频导出

与第三期一致：`VIDEO_EXPORT_START` / `VIDEO_EXPORT_CANCEL`（未改名）。

---

## 5. Viewer → 父级

第三期已有 `VIDEO_EXPORT_*` 等上报。第四期规划中的特效出站事件（如 `EFFECT_STATUS_CHANGED`、`EFFECT_PLAYBACK_FINISHED`、`EFFECT_COMMAND_REJECTED`）**尚未在 Viewer 全量实现**；落地后以代码与后续文档修订为准。

### 5.1 出站 `module` 字段（仅 `editLeftModule` 相关）

与左侧 `**editLeftModule`** / 相机域相关的 Viewer→父级事件在 payload 中带 `**module**`。`VIEWER_READY`、`VIEWER_LOAD_FAILED`、`VIEWER_ASSETS_READY`、`VIEWER_ASSETS_LOAD_FAILED`、`EDIT_MODE_READY`、`PROJECT_IMPORT_SUCCEEDED`、`PROJECT_IMPORT_FAILED`、`EDIT_HISTORY_STATE`、`SETTINGS_*`、`CAMERA_MODE_CHANGED` 等**不带** `module`（碰撞加载出站见下表）。`EDIT_MODE_READY` 在 `EDIT_MODE_SET(true)` 恢复完成且编辑基线设好之后出站（无 payload），此后编辑命令与 `PROJECT_SAVE` 才写入可持久化 settings。


| `module` 取值       | 适用事件                                                                                          |
| ----------------- | --------------------------------------------------------------------------------------------- |
| `**asset`**       | `SCENE_ASSET_SELECTED`、`SCENE_ASSET_PLACED`                                                   |
| `**annotation**`  | `SCENE_ANNOTATION_SELECTED`、`SCENE_ANNOTATION_EDIT_START`                                     |
| `**environment**` | `SCENE_LIGHT_SELECTED`、`SCENE_LIGHT_PLACED`、`SHADOW_SYSTEM_READY`；`**SCENE_MESH_LOAD_*`**（仅 shadow intent） |
| `**camera**`      | `**SCENE_MESH_LOAD_*`**（collision intent）、`COLLISION_SYSTEM_READY`、`CAMERA_DEFAULT_VIEW_CAPTURE_*` |
| `**effects**`     | `VIDEO_EXPORT_STARTED`、`VIDEO_EXPORT_CANCELLED`、`VIDEO_EXPORT_END`                            |


**Scene mesh 资源加载**（`module: 'camera'`）— 接影 GLB / voxel 等由 `CameraCollisionManager` 加载：

| 事件 | 时机 | payload |
| ---- | ---- | ------- |
| `SCENE_MESH_LOAD_PROGRESS` | Universe 转换任务 `queued` / `running`（约每 2s） | `{ module, jobId, status: 'queued' \| 'running', queuePosition, queuedMs, runningElapsedMs, elapsedMs, timeoutMs, etaMs, progress }` |
| `SCENE_MESH_LOAD_FINISHED` | `cameraCollision:load` 且 `state === 'ready'` | `{ module: 'camera' \| 'environment', collisionUrl? }`；`module` 由本次加载合并的 intent 决定（见下） |
| `SCENE_MESH_LOAD_FAILED` | `cameraCollision:load` 且 `state === 'failed'` | 同上，可含 `message?` |

**`SCENE_MESH_LOAD_*` 的 `module`**：`wantCollision` → `camera`；`wantShadow` → `environment`；二者同时为真时**各发一条**（payload 相同、仅 `module` 不同）。无显式 intent 时按当前 `collision.enabled` / 阴影开关推断。

**`SCENE_MESH_LOAD_PROGRESS`**：只在需要 Universe 生成 GLB 时发出（已有 collision URL 则不会）。`timeoutMs` 为服务端转换超时（默认 5min），**从任务进入 `running` 起算，不含排队**。`progress` 为 0–100 **估算**（排队约 1–15，转换约 20–90），不是 GPU 真实百分比。宿主下发 `COLLISION_SET` / `SHADOW_SET` 期间 **仍会** 出站进度（方便进度条）；`SCENE_MESH_LOAD_FINISHED` / `*_SYSTEM_READY` 仍受 `suppressCollisionOutbound` 抑制，成功结束后补发。

**子系统就绪**（在 scene mesh 就绪且对应开关已写入后）：

| 事件 | 时机 | payload |
| ---- | ---- | ------- |
| `COLLISION_SYSTEM_READY` | 碰撞已 `setEnabled` 且资源满足（未开启则不回传） | `{ module: 'camera', collisionUrl? }` |
| `SHADOW_SYSTEM_READY` | 阴影已开启且接影实际参与渲染（`isShadowOutputEnabled`；未出影前**不回传**） | `{ module: 'environment' }` |

入站 `COLLISION_SET` / `COLLISION_PATCH` / `SHADOW_SET` 开启时：若无 `settings.collision.url` / URL 参数碰撞地址，则用 `contentUrl` 调 Universe `POST /conversion/voxel-collision/jobs`（`{ modelUrl, projectId }`，需 `token`）并轮询 `GET .../jobs/:jobId`，成功后把 `data.url` 写入 `settings.collision.url`，再 `ensureSceneMeshLoaded`，**然后**才写入 enabled。不先拉项目文件列表。`loading` / `idle` 不出站；轮询期间出站 `SCENE_MESH_LOAD_PROGRESS`。宿主下发触发的 apply **过程中**不回传 `SCENE_MESH_LOAD_FINISHED` / `*_SYSTEM_READY`（`suppressCollisionOutbound` 防回环），**成功结束后补发一次**。客户端等待转换的超时与服务端一致，从 `running` 起算，不含排队。

**说明**：入站 `**EFFECT_*`** 的 `**module**` 为 **可选**；若出现则须为 `**effects`**（与上表 `**effects**` 及 `CommandRegistry` 的 `effects` 键一致）。字面量唯一定义见 `**src/editor-modules/modules-types.ts**` 的 `**MESSAGE_BRIDGE_MODULE**`；`**EFFECTS_PROTOCOL_MODULE**` 为其别名（等于 `**effects**`）。

**资产扩展（与第三期并存）**：`ASSET_PLACE` 的 `AssetLibraryType` 已含 `**video`  `audio`**；`**MEDIA_HOTSPOT_SET**` 嵌套 patch 全局热区，payload `**{ value: { video?: { hotspotAutoplayEnabled?, coneHalfDeg? }, audio?: { hotspotAutoplayEnabled?, showCalloutInViewer? } } }**`（音频无视锥；`audio.showCalloutInViewer` 控制浏览模式音频 callout 与手动播放按钮可见性，缺省 true，显式 false 入库）；`**ASSET_MEDIA_HOTSPOT_RANGE_SET**` `{ id, value }` 写该条 `**triggerDistanceM**`；`**ASSET_MEDIA_HOTSPOT_SET_BASELINE**` `{ id, target: 'video' | 'audio' }` 由 Viewer 按选中资产相机距离写入该资产 `triggerDistanceM`；baseline 出站 `**SCENE_ASSET_MEDIA_TRIGGER_DISTANCE_CHANGED**` `{ module, id, value: { triggerDistanceM } }`。**视频横向曲度**：`**ASSET_VIDEO_CURVATURE_SET`** `{ id, value }`。**View 全局静音**：`**VIEW_MEDIA_MUTE_SET`**。消费态（Viewer/预览）：热区外视频不可点播控；音频默认在浏览模式也可见 callout 并支持手动 toggle（`audio.showCalloutInViewer=true` 默认开），如需隐藏置 false；热区自动播由 `audio.hotspotAutoplayEnabled` 控制。详见第三期资产表。出站 `**SCENE_ASSET_SELECTED.assetType**` 同步扩展。

---

## 6. 迁移与兼容

1. **旧 JSON**：仅有 `revealEffect`、无 `effects` → 导入后自动补全 `settings.effects`。
2. **新 JSON**：含 `effects` → 若与 `revealEffect` 的 `type` 冲突，以 `**effects.reveal.paramsById['scene.gsplat-reveal']`** 为准。
3. `**noreveal` URL 行为**：清除 `revealEffect` 时同步删除 `effects`，避免残留三轨数据。
4. **存盘 / 出站 `PROJECT_SAVE_SUCCEEDED`**：`serializeExperienceSettings` 先 `**flushRevealIntoEffectsForExport**`（把内存 `revealEffect` 刷进 `effects`），再 **删除快照中的 `revealEffect` 键**；出站 payload **仅含 `settings.effects`** 作为 scene reveal 持久化形态。宿主 diff / 展示应以 `**effects**` 为准。

---

## 7. UI / Viewer 职责（仅补充差异）

与第三期相同部分（顶部菜单、资产、标注、环境等）略。

**特效（第四期）**

- **宿主 / 本地面板**：`message-bridge` 模式下发 `**EFFECT_*`** 须带 `**effectId**`（`**module` 可选**；若传须为 `**effects`**）；`**editUiTransport=internal**` 时 `**effects-ui.ts**`（`initRevealUI`）经 `**CommandRegistry` → `EffectsFacade.handleCommand**`，与宿主 `postMessage` 解码后路径一致（见 `effects-facade.ts`）。
- **Viewer**：`EffectsFacade` 将协议落为 `**settings.effects`** 与运行态同步；GSplat 实体侧挂载时序见 §2.2（宿主仍只关心 `EFFECT_*` 与 `settings` 形态即可）。

---

## 8. 参考代码路径（便于联调）


| 主题                                 | 路径                                                                                                                                                                                  |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 入站桥接                               | `src/message-bridge/`                                                                                                                                                             |
| 模块门面                               | `src/editor-modules/effects-facade.ts`                                                                                                                                              |
| 协议 → settings                      | `src/editor-modules/protocol-adapters/effects-protocol-adapter.ts`                                                                                                                  |
| 物理碰撞协议                             | `src/editor-modules/protocol-adapters/collision-protocol-adapter.ts`                                                                                                                |
| effects 镜像与导入归一                    | `src/settings-serialize/effects-sync.ts`                                                                                                                                            |
| 默认骨架                               | `src/settings-serialize/settings-serialize-configs.ts`（`DEFAULT_EFFECTS`）                                                                                                           |
| v2 校验                              | `src/schemas/v2.ts`（`effects` 可选校验）                                                                                                                                                 |
| 场景 reveal/persistent `effectId` 常量 | `**src/vfx/effects-runtime/effect-types.ts**` 定义字符串；`**effects-runtime.ts**` 再导出并与 `EffectsRuntime` 内置轨共用（联调时以协议字面量 `**scene.gsplat-reveal**` / `**scene.gsplat-persistent**` 为准即可） |


---

## 9. 与第三期文档的并存阅读建议

- **交互职责、未改命令**（资产 / 标注 / 光照 / 后处理 / 视频导出事件名等）：仍以 `**docs/SaaS第三期 编辑模式交互职责划分.md`** 为主。
- **第四期新增 / 替换语义**（`**EFFECT_`*、`settings.effects`、出站无 `revealEffect`、双轨 reveal+persistent**）：以 **本文** 为唯一权威；第三期中的 `**VFX_`* 特效入站表不再维护**，宿主按本文升级即可。

