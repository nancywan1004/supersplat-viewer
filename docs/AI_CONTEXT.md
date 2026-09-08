# SuperSplat Viewer - AI Context

> 供 AI 助手快速理解项目结构与编辑模式核心能力的上下文文档。

**当前 Session 上下文**：本文档已纳入「父级托管编辑模式重构」「局部亮灯区域改造」「**阴影 B 管线放置资产接影（2026-06-01）**」「**scene mesh 出站协议 + Universe `voxel-collision`（2026-06-01）**」「放置资产 AABB 相机碰撞（2026-05-29）」「**场景拾取 Picker 双路径收敛（2026-05-29）**」「**天空盒 settings 结构 + 编辑左栏 skybox 模块（2026-06-04）**」「**Octree refinement 闪烁与 pending 不降（2026-06-09）**」「**View→Edit 天空盒保留 + 缩略图 cover 裁切 + 无天空盒 envAtlas 副作用修复（2026-06-11）**」「**点彩 NPR（pointillism-stipple）modify/post/skybox 管线（2026-06-12 / 2026-06-16）**」「**点彩 + NightMode 场景光解耦（2026-06-16）**」「**SETTINGS_SAVE destination + 统一 saveExperienceProject（2026-08-26）**」。

**2026-08-26 补充（SETTINGS_SAVE destination）**：
- **入站**：**`SETTINGS_SAVE { destination?: 'host' | 'universe', requestId?: string }`**，缺省 **`universe`**。postMessage **本地保存发 `host`**：不下载不上传，成功/失败都 **`SETTINGS_SAVE_RESULT`**（含 settings、File、`references`、`contentChanged`）。**`universe`** 成功 **`SETTINGS_UPDATED`**，失败 **`SETTINGS_SAVE_FAILED { message, requestId? }`**。
- **去向**：postMessage `host` = 产物交回父级；`universe` = OSS 上传。Viewer 内部 UI 直连仍可用 **`local`** 下载 zip（不是给父级的协议值）。
- **加载成败（两对）**：
  - **主场景**：成功 **`VIEWER_READY { requestId? }`**（首帧）；失败 **`VIEWER_LOAD_FAILED { requestId?, stage: 'settings'|'content', message, status?, url? }`**（不再发 READY）。
  - **场景内资产**：成功 **`VIEWER_ASSETS_READY { requestId? }`**（可开始编辑）；失败 **`VIEWER_ASSETS_LOAD_FAILED { requestId?, message, status?, url?, failedCount }`**（不再发 ASSETS_READY）。
  - URL `?requestId=`。
- **缩略图**：暂存 JPEG **仅 universe** 时 OSS + 登记；local **不下载**。
- **超时**：internal UI 等待保存结果 **60s**（原 3s）。详 **[项目保存管线说明](项目保存管线说明.md)**、**`docs/工作记录.md`（2026-08-26）**、**`docs/SaaS第三期 编辑模式交互职责划分.md`**。
- **ASSET_PLACE File**：入站 **`value.src?: string | File`**；File 写入会话表并改成 **`assets/<basename>`**（重名 **`assets/<assetId>-<basename>`**），用会话表 object URL 加载。运行态 **`ScenePlacedItem.file`** 仍可保留原始字节（内部）。仅 CDN **http(s)** 仍写绝对 URL。**`blob:` 不入库**。不认独立 **`value.url` / `value.file`**。复制拷贝同一 **`file`** 引用。
- **天空盒 / 标注 File**：**`SKYBOX_SET`/`SKYBOX_ADD { value?: string | File }`**；**`ANNOTATION_CONFIRM`/`UPDATE` 的 `image?: string | File` / `video?: string | File`**。入站写入会话表并改成相对路径，随 zip / OSS sidecar 附带。
- **碰撞 mesh GLB**：`POST /conversion/voxel-collision/jobs` 提交后轮询 `GET .../jobs/:jobId`，成功写 **`data.url`** 到 **`settings.collision.url`**（默认 upload true）。已有绝对 CDN URL 仍不打包。生成中出站 **`SCENE_MESH_LOAD_PROGRESS`**；转换超时从 **`running`** 起算，不含排队。
- **相对路径物化**：`serializeExperienceSettings` 之后 **`materializeUserUploadRelativeFiles`** 扫描 sceneAssets / skybox / annotations / soundUrl / **collision.url**：`File`/`data:`/`blob:` → `assets/<unique>` 并写入 **`global.userUploadFiles`**（`相对路径→Blob`）；已是相对路径则保留并从会话表或 **`config.settingsUrl`** 取回字节（失败则整次保存失败）。绝对 URL 不改写。加载：相对路径优先会话表 object URL，否则 `new URL(rel, settingsUrl)`；**不把 `blob:` 写回 settings**。
- **local zip**：无相对路径文件仍下载 **`settings.json`**；有则 **fflate** 打 **`settings.zip`**（根目录 `settings.json` + `assets/`）。缺字节或打包失败则 **`SETTINGS_SAVE_FAILED`**，不下载残包。缩略图仍不进 zip。
- **universe sidecar**：**不打 zip**。无相对路径文件仍只登记 **`settings.json`**。有则共用一次 **`uploadTimestamp`**，先 OSS put 到 **`<baseDir>/<projectId>/<timestamp>/assets/...`**（不走版本接口「最多 2 文件 / type=model」），再上传并登记 **`settings.json`**（内容保持相对路径，与旁边 `assets/` 可互相解析）。缺字节或任一 put 失败则整次失败。缩略图仍单独登记，不进该版本目录。
- **读取**：`?settings=` **只读 settings.json**（不读 zip）。相对路径相对该文件 URL；本地先解压 `settings.zip`，再指向解压后的 `settings.json`。
- **目录**：解析/导出收口 **`src/settings-io/`** — `load.ts` 读 json，`save.ts` 写 json / settings.zip，`user-files.ts` 相对路径与会话表，`pack.ts` 本地下载 zip 与路径/MIME。`settings-serialize/` 仍只负责 ExperienceSettings 序列化。

**2026-06-16 补充（点彩 · 对比度 / 天空 / NightMode·mesh / 协议）**：
- **对比度 `levelRange`（单管线）**：**高斯**仅 **post** `applyContrast(uLevelRange)`；**天空**仅 **skyboxPS** `skyPointApplyContrast`；**modify 无 per-splat 对比度**（禁止 post+modify 双开）。post 对比度须在 **flatten / luma 量化之前**施加，否则高斯平坦区滑条无感；**`syncPostSettingsOnly()`** 每帧同步 post uniform（不重挂 CameraFrame）。
- **天空点彩**：**`skybox-pointillism-shaders.ts`**（oct 网格 + 球面角 soft mask）；post **`skyProtect` 回混未调对比的 `rawScene`**，避免与 skybox 路径叠色。
- **开点彩 mesh 变暗**：**`nightFade`** 两路——(1) **gsplatModifyVS** 仅高斯；(2) **`applySceneLightingFromNightFade`** 调 **主光 + skyboxIntensity**，**mesh 走标准光照会受影响**。点彩挂载 **`nightMode:exit`** 仅挂起 (1)；**须保留 `settings.nightMode.fade` 驱动 (2)**（**`night-mode.ts`**：`exit` 不再对点彩/忆韵清零 fade；挂起时 **`nightFade:set` 仍更新场景光**）。加载仍走 **`viewer.applyNightModeFromSettingsAfterLoad` → `applyLightingFromSettings`**。
- **协议**：**`EFFECT_PARAMS_PATCH`** + **`effectId: scene.gsplat-persistent-stylization`** + **`{ pointillism-stipple: { … } }`**；白名单 **`persistent-effect-params.ts` / `POINTILLISM_STIPPLE`**；**enabled** 才热更新脚本。
- **详**：[3DGS点彩NPR渲染内核方案.md](3DGS点彩NPR渲染内核方案.md)、**`docs/工作记录.md`（2026-06-16 · 点彩）**。

**2026-06-12 补充（点彩 NPR · `pointillism-stipple`）**：
- **挂载**：`settings.effects.persistent` 轨 **`scene.gsplat-persistent-stylization` → `pointillism-stipple`**；脚本 **`GsplatPersistentPointillismStipple`**（`pointillism-stipple-persistent.ts`）直连材质 **`gsplatModifyVS` + patch `gsplatPS`**，**不经** `GsplatEffectComposer`；与 **NightMode gsplat shader 互斥**（`effect-types.ts` → `PERSISTENT_GSPLAT_MATERIAL_SHADER_EFFECT_TYPES`；开点彩 **`nightMode:exit` 挂起 modify**，**场景主光/天空盒仍随 fade**，见 **2026-06-16**）。
- **三阶段管线**：**modify**（点径/减密/颜料色）→ **gsplatPS**（椭圆笔触 + `paintGrain`）→ **post**（`PointillismPostController` / CameraFrame bridge，可选 `postEffectEnabled`）。
- **modify 要点**：`gapSpacing` 控 overlap；`gapFill` **主路径在 modify**（`coverBoost` + bucket `interiorKeep`）；`denoiseStrength` 飞点剔除；`contrastDotMix`（UI：**色彩振动**）三层随机——原色系微扰 / 对比邻域（H≈+180°±20° + 20–50% 混回原色）/ 强对比（±10° + 更少混色）；`sourceStructureBlend` ↓ 触发 modify 平坦区增覆盖 + post edge-aware 平整。
- **post 要点**：`structureEdgeMask` + 限幅 `flatOpticalMix` + luma 量化 + `suppressSpeckles`；结构边保留原色、锐化仅 `structEdge`；**对比度在平整化前**。**已知**：post 仍含 **`fillSparseHoles(uGapFill)`** 宽域 blur 补洞（易整屏发糊）；**目标** gapFill **仅 modify**，post 待解耦该路径。
- **参数/UI**：`persistent-effect-params.ts` 白名单 + `effect-params-ui-schema.ts`；**协议**见 **2026-06-16**；测试 preset **`public/assets/settings/settings-huangye-point.json`**。
- **详**：[3DGS点彩NPR渲染内核方案.md](3DGS点彩NPR渲染内核方案.md)、**`docs/工作记录.md`（2026-06-12 / 2026-06-16）**。

**2026-06-11 补充（缩略图 / View→Edit 天空盒 / mesh IBL）**：
- **缩略图**：**`render/capture-viewport-screenshot.ts`** 默认 **1024×576**；由 letterbox 改为 **cover 居中裁切**（**`centerCoverCrop`**），避免 iframe 非 16:9 视口截图左右黑边。
- **View→Edit 天空盒**：进入编辑在 **`applySettingsSnapshot(__originalSettings)`** 前快照 Viewer 当前 **`skybox.currentUrl`**；**`mergeSkyboxOnEditEnter`**（lighting 恢复前写 settings）+ **`applySkyboxOnEditEnter`**（GPU/UI）。真源有 URL → **`restoreSkyboxFromSettings`**；真源无、Viewer 有 → 保留；均无 → **no-op**（不 clear）。
- **mesh IBL**：**`skybox-loader.clearSkyboxDisplay`** 仅在实际卸载过 **`app.scene.skybox`** 时重置 **`envAtlas`**；避免无天空盒场景进入编辑误把引擎默认 IBL 换成纯白 envAtlas。**`skybox`（背景）与 `envAtlas`（mesh 反射）仍解耦**，换天空盒不改变 mesh 反射贴图内容。
- 详 **`docs/工作记录.md`（2026-06-11）**。

**2026-06-09 补充（Octree refinement：闪烁 + pending 不降）**：
- **范围**：**普通 octree streaming**（separate SOG）；**`src/loaders/octree-refinement-controller.ts`** + **`viewer.ts`** `notifyCameraMoved`；**勿**混用 universe_pack / aholo 路径（见 **`docs/LOD_UNIVERSE_PACK_*.md` 废弃说明**）。
- **闪烁**：pending→0 时 **勿立刻 clear gate**；前景 stable 下载完成后 **settle 窗口（~30 帧）hold `lastPriorityUrls`**，防 peripheral 涌入 + budget 重平衡 + underfill 跳档。
- **挪机卡死**：hold **不能**因 `staleLodNodes/staleLoadedNodes` 长期生效；**`notifyCameraMoved`** 清空 gate / `lastPriorityUrls` / settle 标记；挪机后对 **`staleLoadedNodes`** 立即 sync。
- **pending ~17 平衡态**：**`trackedMissingFiles`** 稳定下载集；**in-flight aware `reconcileLoaderQueue`**；gate = 优先 URL ∪ **`_currentlyLoading`**；**`retainCriticalDownloadFiles`** 下载前 pin ref；移除 **`activeUrls=queuedUrls` 子集** reconcile。
- **完成判定**：**`stableForegroundPending` / `stableCriticalPending`**（非 `pendingUniqueFiles`，后者含外围 budget 振荡）；debug **`?debugOctreeRefinement=2&noanim=1`**。
- 详 **`docs/Octree-Refinement闪烁与pending问题说明.md`**、**`docs/工作记录.md`（2026-06-09）**、调度计划 **`docs/Octree-Refinement调度加速计划.md`**。

**2026-06-04 补充（天空盒 settings + 编辑模块）**：
- **存盘**：**`settings.background.skybox`** — **`currentUrl`**（当前显示）+ **`uploadUrls`**（外部/内部登记的上传资源列表）。**`settings-serialize-helper.ts`** 统一读写；**`serializeExperienceSettings` / `applySettingsSnapshot`** 调用 **`normalizeSkyboxForPersistence`**；导入时 **`ensureBackground`** 将历史 **`background.skyboxUrl` / `skyboxUrls`** 等收敛到新结构。
- **协议（父级）**：**`SKYBOX_SET { value?: string | File }`** → **`skyboxSet`** → **`setSkyboxCurrentUrlInSettings` + `applySkyboxTexture`**（空串清除）；**`SKYBOX_ADD { value?: string | File }`** → **`skyboxAdd`** → **`addSkyboxUploadUrlToSettings` + 设为 current + `skyboxListChanged`**。`value` 为 File 时写入相对路径。已移除 **`SKYBOX_SWITCH`**。
- **Internal UI**：**`editLeftModule: 'skybox'`**（**`edit-left-toolbar.ts`**「天空盒」）；右侧 **`skybox-settings-ui.ts`**（manifest 下拉 + URL 输入 +「添加并应用」）；**`EDIT_MODULE_SET`** 白名单含 **`skybox`**。原 Settings 调试面板 **`skyboxRow`** 已删。
- 详 **`docs/工作记录.md`（2026-06-04）**「天空盒」条目。

**2026-05-21 补充（场景 settings 重置 + SKYBOX_SET）**：
- **重置**：**`src/settings-reset.ts`** 对外 **`resetSceneSettings(global)`**；入站 **`SETTINGS_RESET`**；出站 **`SETTINGS_RESET_APPLIED { pathFrom }`** / **`SETTINGS_RESET_FAILED`**。**`pathFrom`**：**`'original'`** = 云端初始 **`transform.json`** 经 **`importSettings`**；**`'current'`** = 列表无 transform 时 **`settingsKeepCamera`**（保留当前 **anim/initial**，清空资产/标注/光照/后效等）。**重置不改 `background`/`skybox`**（应用快照前写回当前 **`settings.background`**，含 **`skybox.currentUrl` / `uploadUrls`**）。**internal**：顶栏 **「重置场景」**，**`confirmSceneReset`** + **`showEditToast`**（**`edit-toast-ui.ts`**）。云端：**`universe/service.fetchOriginalTransform`** → **`GET .../project/version/{id}/original`**。详 **`docs/工作记录.md`（2026-05-21）**。

**2026-06-02 补充（移动端触摸 + 双摇杆交互）**：
- **输入主链路收敛**：`src/input/devices/mobile-fly-input.ts` 仅保留单指 look + 双指 rotate/roll 手势，不再承载内置摇杆与 DOM pointer 交互；`src/input/devices/touch.ts` 修复双指平移向量被原地缩放清空的问题，恢复 fly 场景下双指平移/缩放/横滚。
- **双摇杆落地**：新增右下 look 摇杆（`joystickLookBase`/`joystickLook`），与左下 move 摇杆并存；UI/样式在 `src/ui/ui.ts`、`src/index.scss`、`src/index.html`、`public/index.html`。摇杆采用底部锚定 + 元素中心计算偏移，修复横屏首触时整体下移。
- **模式切换语义**：横屏摇杆输入在 `orbit` 下会 `requestFirstPerson` 自动切 `fly`；`anim` 下同样会在摇杆输入时退出动画并切 `fly`。
- **触摸双击统一链路**：`src/input/app/nav-interaction.ts` 改为 touch `pointerup` 双击判定后统一派发 `inputEvent: dblclick`，复用 desktop 的 pick + 模式切换处理，避免依赖浏览器原生 touch dblclick 不稳定行为。
- **方向与显示门控**：横屏 `orbit` 路径下修正双指 pinch 前后方向；摇杆显示增加 reveal 时机门控（有 reveal 时需 `revealComplete` 后才显示，无 reveal 则按横屏 touch 直接显示）。

与 **2026-04-08/09** 起补充的 **NightMode gsplat 点聚光数值与色彩管线**、**`reveal-policy`（persistent VFX）**、**光源删除销毁语义（`destroy`）**、**首个 draft 区域在 `LIGHT_ERASER_START` 下的防误清空判定顺序**，以及 **`message-bridge` 的模块化 dispatch 封装（asset/annotation/environment/effects）**、**`settings-serialize` 三层分工（serialize/configs/helper）**、**`state-selectors` 查询层命名收敛** 等决策；**2026-05-13 补充（effects 双轨 GSplat + 协议 + 本地 UI）**：**`EFFECT_PARAMS_PATCH`** 按 **`effectId`** 区分 **`scene.gsplat-reveal`** 与 **`scene.gsplat-persistent`**（入站若带 **`module`** 则须为 **`'effects'`**，与 **`MESSAGE_BRIDGE_MODULE.effects`** 一致；**`module` 可选**）；**`EFFECT_TOGGLE`** 仅 persistent（`value: boolean`）；**`EFFECT_REPLAY`** 仅一次性 reveal。**`prepareExternalPersistentScriptMount`** 不得把 **`effectsRuntimeState.reveal.status`** 写成 **`playing`**（避免与 **`syncEffectsRuntimeStateFromSettings`** 的 playing 粘性叠加导致关 persistent 时误判、跳过 **`vfxExit`**）。**切换 reveal 类型 / `restart`** 会 **`destroyAllRevealScripts`** 拆掉 persistent，若 **`readPersistentRevealParams`** 仍有效则在 **`revealComplete`** 后 **`persistentGsplatEffectRemountRequested`**（**`schedulePersistentGsplatRemountAfterRevealCompleteIfWanted`**）；**`updateConfig` 切 reveal 为 `none`** 且仍配置 persistent 时 **立即** remount。**脚本 `onRevealComplete`** 须在 **`fire('revealComplete')` 之前** **`patchRevealRuntimeMirror(completed)` + `syncEffectsRuntimeStateFromSettings`**，避免 UI 仍读 **`playing`**。**`effects-ui.ts`**：persistent toggle 禁用**仅看出轨 reveal**；**`revealRestart`/`revealComplete`** 用 **`queueMicrotask`** 刷新；有可持续类型时 **`settings.effects.persistent.enabled ?? true`**。实施摘要见 **`docs/工作记录.md`（2026-05-13）** 与 **`.cursor/plans/effects-architecture-refactor_c7c5d9eb.plan.md`**「实施跟进（2026-05-13）」。**2026-04-13** 起补充：**资产 `frame` 聚焦改为 bbox framing（完整入画+构图一致）**、**`editLeftModule===null` 时 orchestrator 仍触发上一模块 `onExit`**、**View→Edit 用 `global.__originalSettings` 恢复丢弃 View 内 settings 改动**、**入站编辑模式仅 `EDIT_MODE_SET`（已移除 `EDIT_MODE_ENTER`/`EDIT_MODE_EXIT`）**、**父级托管下编辑基线与 `initEditHistory` 仅在 `message-bridge` 内完成且 `ui.ts` 不重复 restore/snapshot**、**`getComparableSettingsStringFromSnapshot`**、**`requestSceneAssetsRestore` 统一调度 sceneAssets 恢复（**`edit-enter`** → **`syncScenePlacedEntitiesFromSettings`** 就地同步；**discard/history/startup** → clear+restore）并用 restore version 使旧的 reveal defer 失效**、**场景/协议同资产重复选中不再二次 focus**、**编辑态临时关闭 camera bounds（回到 View 自动恢复）**；**同日起**另补充：**`LIGHT_SELECT` 不触发相机 frame 聚焦（与资产区分）**、**点光源 `range` + `LIGHT_RANGE_SET`（0–20，`directional` 忽略）与线框/UI/Bloom 绑定灯联动**、**`ASSET(S)_SHOW_HIDE_SET` 幂等**、**切换非 `none` 的 VFX 类型时 `revealRestart` + `viewer` 对 `DEFAULT_DEFERRED_EDITING_LAYERS` 门控（与导出/首访一致）**、**天空盒仍走原 `applySkyboxTexture`；mesh 弱光可读性主要靠 `scene.ambientLight` 与放置时 StandardMaterial 基线**、**gaussian 为对齐 mesh 主观构图在 `camera-manager.ts` 中使用 `GAUSSIAN_ASSET_FOCUS_DISTANCE_SCALE` 语义补偿**；**2026-05-10 补充（asset-loader + 导出时间轴统一）**：**`loaders/asset-loader.ts`** 提供 `getAssetLoader(global)`（挂 `global.__assetLoader`）、`trackPromise('mainScene'|'sceneAssets'|'placement', …)`、`waitAllReady()`，并发出 **`assets:readyStateChanged` / `assets:allReady` / `assets:waitTimeout`**；主场景在 **`index.ts`** 对 `loadGsplat` 包一层 `trackPromise`；场景资产恢复与放置侧 hydrate 经 **`hydrateAssetLibraryItem` / `loadSceneAssetLibraryItem`** 纳入同一计数器。**`render/export-timeline-resolver.ts`** 的 **`resolveExportTimelinePlan`** 统一输出 **`totalDuration`、`animSeekAt(exportTime)`** 等（秒）；有 anim 且同步时除「VFX 用 anim loop 铺满」外，还要求在 **`max(vfxDuration, allAssetsReadyAt)`** 之后再播至少 **`extraAnimLoopsAfterAssetsReady`（默认 1）** 整圈 anim，修复 **anim 时长等于 VFX（如 12s）时总时长不再延长** 的缺口；无 anim 时在锚点后加 **`noAnimTrackExtraDuration`（默认 2s）**。**`video-export.ts`** 导出前 **`waitAllReady()`**，将 **`allAssetsReadyAt = waitMs/1000`** 传入 resolver；**`message-bridge`** 的 **`VIDEO_EXPORT_START`** 预计算时长时同样等待并传参。**`video-export-ui.ts`** 极速导出时 **`showSaveFilePicker` 已与 `format:'mp4'` 对齐**（MP4 类型，不再误用 WebM 对话框）。
**2026-05-12 补充（输入排空 + reveal 收尾时序）**：**`cameraControlsEnabled===false` 时**（如 Gizmo 占用相机），`input-controller.ts` 在提前返回前仍须每帧调用各 device 的 **`drainBufferedInput()`**，否则会跳过 `KeyboardMouseSource` / `MultiTouchSource` / `GamepadSource` 的 **`read()`**，底层 `InputDelta` 持续累积，**松手后首帧一次性吐出 → 表现为 pointer up 后相机跟着动**；实现上为 **`keyboard-mouse.ts`**（`source.read()`）、**`touch.ts`**（`read()` + `_touchCount`）、**`trackpad.ts`**（清零 wheel 累积与 orbit→fly 跟踪）、**`gamepad.ts`**（`read()`）。**Reveal + compute 黑闪**：**`reveal.ts`** 在 **`onRevealComplete`** 将 **NightMode 恢复** 与 **`effectScriptDisabled`** 路径统一为 **`frameend` 延后一帧**（`pendingDeferredNightRestore`），避免与 **`removeShaders`** 同帧覆盖导致的一帧黑屏。
**2026-05-14 补充（effects 编排与模块命名）**：**`reveal-persistent-coherence.ts` → `effects-orchestrator.ts`**（`shouldRequestPersistentGsplatRemount`）；**`reveal-policy.ts` 保持独立**（不与 orchestrator 合并）；**`extract-gsplat-modify-layers.ts` → `gsplat-effect-layers-extractor.ts`**（`extractGlslWgslModifyBlocks`、`PERLIN_WAVE_COMPOSER_ID`）。**一次性 reveal** teardown 用 **`teardownOneShotRevealGsplatScripts`** 字面量模式；**persistent** 挂载单路径 **`remountPersistentGsplatOnEntity`**；关 persistent 须 **`persistentGsplatEffectRemountRequested`** 与 **`vfxExit`** 协同。详见 **`.cursor/plans/effects-architecture-refactor_c7c5d9eb.plan.md`**「实施跟进（2026-05-14）」与 **`docs/工作记录.md`（2026-05-14）**。
**2026-05-14 补充（架构文档与第四期接口）**：特效重构 **plan 与 `docs/场景GSplat特效扩展指南.md` §0.1 共用同一幅总览 mermaid**；指南 **§0.0** 说明非两套架构、**`RPC`/`LIF→RC`** 分工；**§0.2** 为 **文件/类分链流程图**（入站、`revealConfigChanged`、`persistentGsplatEffectRemountRequested`→**`runPersistentGsplatEntityLifecycle`**、`EFFECT_REPLAY`、policy）。**`docs/SaaS第四期编辑模式接口文档.md`** §2.2/§7/§8 与 **M18/M20** 对齐（**宿主 `EFFECT_*` 语义不变**）。详 **`docs/工作记录.md`（2026-05-14）**「文档 / 本 session」。
**2026-05-15 补充（Reveal 参与半径 + effectParams 专参）**：
- **空间上界**：**radial / sketch / growth-wave** 对外仅 **`effectParams.maxEndRadius`**（默认 50）；有效半径 = **`max(请求半径, bbox×padding)` 再 `min(maxEndRadius)`**；**`totalDuration` 不变**时由各类型的 **`syncSpeedToTotalDuration`** 反算波速/时长。
- **编排**：**`GsplatShaderEffect.syncRevealParticipation`** 统一读 `effectParams`、写半径、再调速度；**`RevealController`** 只拼 `RevealParticipationSyncContext` 并调用脚本方法，**不再**维护 `types.has('radial'|…)` 白名单。
- **rain-v2**：**`riseTint` / `riseTintIntensity` / `rainSize` / `hitTint`**（**非** `fallTint`）；**`hitDuration`** 已参与 shader 淡出；**rain / pieces-recover** 仍用 **`endRadius`**。
- **integrate**：**`waveAmplitude`**、**`aabbMin`/`aabbMax`**、**`aabbXZMin`/`aabbXZMax`**；白名单见 **`reveal-effect-params.ts`**。
- **存盘/协议**：**`settings.effects.reveal.paramsById['scene.gsplat-reveal'].effectParams`** 与 **`EFFECT_PARAMS_PATCH.params.effectParams`** 增量合并；改专参后需 **重建 reveal 脚本** 或走协议 patch（改类默认值 alone 不更新已挂载实例）。
- 详 **`docs/工作记录.md`（2026-05-15）**。

**2026-05-21 补充（场景音视频播控 + 标注式音频 UI）**：
- **视频播控（纹理合成）**：**`scene-assets/media/video-controls-texture.ts`** — 白字时间码 + 细进度条 + 右侧播放钮，合成在 **video 纹理底部**；**H5 式 hover 显隐**（离开约 3s 隐藏，再 hover 显示）；**编辑/预览/Viewer 一致**，不再仅编辑选中才显示；canvas 点击进度条 seek、点击播放钮切换播放/暂停；**曲屏命中**：射线与 **`intersectRayLocalVideoMesh`** 求交后映射纹理像素，**`playPad` / `screenPad` / jitter** 随 **`horizontalCurvature`** 放大（大曲度弧端不漏点）。详 **`docs/工作记录.md`（2026-05-25）**。
- **音频 callout（Annotation 式深度）**：**`scene-assets/media/audio-callout.ts`** — Canvas 绘制 callout 贴到 **HotspotBase**（`depthTest`）+ **HotspotOverlay**（被挡时 25% 半透明仍可见）；每帧 **prerender** 朝向相机；播放钮射线平面命中（**`PLAY_HIT_PAD=24`** 纹理扩边）+ **InputArbiter**（priority 205）；**`initSceneAudioCallout`** 为 Viewer 入口。
- **播控策略分层**：**`scene-media-playback.ts`** — **画面非互斥 + 出声唯一**；**`ensureSceneVideoFramePlaying(entry, { muted })`** 让在热区的视频「推帧 + 静音控制」，**`playSceneMediaEntry`**（**`source: 'hotspot' | 'user'`**）让本条出声并把其它视频静音（保留画面）、其它 audio 暂停；**`setActiveSceneMediaSoundId`** 由控制器收尾设定出声槽；**`userPlaySceneMedia` / `userPauseSceneMedia`** 走 `playSceneMediaEntry` 并把当前 entry 写入出声槽（控制器下一帧用 `getActiveSceneMediaEntryId` 优先沿用）。**`media-hotspot-controller.ts`** 仅热区评估（距离 / 视锥 / 视频赢家 / 视频赢家时 audio 全部 pause / 冷却 / 编辑门）。
- **热区全局自动播（音视频对称）**：**`sceneMediaHotspot.video.hotspotAutoplayEnabled` / `audio.hotspotAutoplayEnabled`**（缺省 true，显式 **`false`** 入库）；**`audio.showCalloutInViewer`**（缺省 true，显式 **`false`** 入库；true 时浏览模式也显示音频 callout 并可手动 toggle 播放）；**`MEDIA_HOTSPOT_SET`** 嵌套 patch **`{ video?: { hotspotAutoplayEnabled?, coneHalfDeg? }, audio?: { hotspotAutoplayEnabled?, showCalloutInViewer? } }`**；仅视频有 **`coneHalfDeg`**（音频用纯欧氏距离）。
- **热区基准距离（按资产）**：**`SceneAsset.triggerDistanceM`**（video 视轴深度 + 视锥，audio 欧氏）；**`ASSET_MEDIA_HOTSPOT_SET_BASELINE`** **`{ id, target: 'video' | 'audio' }`**（用选中资产相机距离写入该资产）；baseline 出站 **`SCENE_ASSET_MEDIA_TRIGGER_DISTANCE_CHANGED`** **`{ id, value: { triggerDistanceM } }`**。**`userPaused`** 阻止热区自动 play。
- **消费态交互**：**`isMediaConsumptionMode`**（Viewer 或编辑预览）下视频播控须 **`inHotspotZone`**；音频 callout 隐藏且不抢指针。

**2026-05-19 补充（场景 video/audio + 热区）**：**`SceneAsset.type`** 含 **`video` / `audio`**；**`settings.sceneMediaHotspot`** 仅持久化 **视频/音频触发距离（欧氏，米）**（冷却为 **`media-hotspot-controller.ts` 常量**）。放置：**`scene-assets/media/video-texture.ts`**、**`audio-callout.ts`**、**`media-runtime.ts`**、**`media-hotspot-controller.ts`**（**`media-view-depth.ts`** 欧氏判定；多视频按距离最近一路有声）。内置 **video/audio 仅 URL**（推荐 **MP4 H.264**）。详 **`docs/工作记录.md`（2026-05-19）**。

**2026-05-19 补充（音视频热区协议 + 配置收敛）**：
- **类型真源**：**`schemas/v2-custom` → `SceneMediaHotspotSettings`**；协议与 **`patchSceneMediaHotspot`** 使用 **`Partial<SceneMediaHotspotSettings>`**，勿内联重复字段。
- **入站（父 → Viewer）**：**`MEDIA_HOTSPOT_SET`** `{ value?: SceneMediaHotspotPatch }`（嵌套 video/audio 子节点）；**`ASSET_MEDIA_HOTSPOT_SET_BASELINE`** `{ id, target: 'video' | 'audio' }`；**`ASSET_MEDIA_HOTSPOT_RANGE_SET`** `{ id, value }` — **`id`** = 场景 video/audio 实例 id。
- **默认视角 + 项目缩略图（1024×576 JPEG）**：入站 **`CAMERA_DEFAULT_VIEW_CAPTURE`**（**已取代** **`PROJECT_THUMBNAIL_CAPTURE_UPLOAD`**）— 当前机位 → **`settings.cameras[0].initial`** + 模块变量 **`pendingProjectThumbnailJpeg`**（**不入 settings、不落盘**）；**`camera:syncPrimaryInitial`** 刷新 **`resetCamera`**；**不立即上传**。出站 **`CAMERA_DEFAULT_VIEW_CAPTURED`** / **`CAMERA_DEFAULT_VIEW_CAPTURE_FAILED`**（**`module: 'camera'`**）。**`SETTINGS_SAVE`** → **`saveExperienceProject`**：`destination: 'universe'`（缺省）先缩略图 OSS + **`POST /app/api/v1/saas/project/image`** `{ fileType:'SNAPSHOT', projectId, storageLocation:2, url }`，再 **settings.json**；`destination: 'local'` 仅下载 settings.json。**internal**：**`render/project-thumbnail.ts`** + Render 面板「设为默认视角并截图」；保存发 **`SETTINGS_SAVE { destination: 'local' }`**。详 **`docs/工作记录.md`（2026-05-20 / 2026-08-26）**。
- **出站（Viewer → 父）**：**仅** baseline 成功 → **`SCENE_ASSET_MEDIA_TRIGGER_DISTANCE_CHANGED`** `{ module:'asset', id, value: { triggerDistanceM } }`；**`MEDIA_HOTSPOT_SET` / RANGE_SET 不回传**。
- **实现**：**`settings-serialize-helper.ts`**（`ensure` / `patch` / `applySceneMediaHotspotBaselineFromView`）；**`message-bridge.ts`** 处理入站与 baseline 出站；**`asset-placement-settings-ui.ts`** 在 **`message-bridge`** 下 **`sendEditProtocolMessage`** 与 Bloom/资产列表同轨。详 **`docs/工作记录.md`（2026-05-19）**「音视频热区：协议 baseline…」。

**2026-05-20 补充（View 全局静音 + `view-settings.ts`）**：**`global.viewSettings`**（**`types.ViewSettings`**：`bloom.localLightsEnabled`、`annotationsVisible`、`mediaMuted`，均不入库）；读写与协议应用在 **`src/view-settings.ts`**（**`ensureViewSettings` / `applyViewMediaMuteSet` / `readViewMediaMuted` / `applyViewBloomLocalLightsEnabled` / `applyViewAnnotationsVisible`**）；入站 **`VIEW_MEDIA_MUTE_SET`** `{ value: boolean }`（**不回传**）；**`media-hotspot-controller`** 在热区门开启时强制 video `muted` / audio `pause`。已删除 **`view-media-settings.ts`**。

**2026-05-29 补充（放置资产 AABB 相机碰撞）**：
- **能力**：对所有可见 **mesh / gaussian** 放置项生成世界 AABB 碰撞；**Fly / Orbit** 推开（球半径 **0.3m**）；开关 **`enabled`** 且 **Viewer 或编辑预览** 下生效（纯编辑仅配置）。
- **缩放**：**`autoFit` 与手动 XYZ 互斥** — `autoFit:true` 各向自动贴合；`false` 用高斯/Mesh **50%–150%** 滑条。默认 **`autoFit:false`**，**mesh X=57%**，y/z 与高斯 **85%**。
- **状态**：入库 **`settings.sceneAssetCollision`**（`schemas/v2-custom` **`SceneAssetCollisionSettings`**）；会话 **`SceneAssetCollisionRuntimeState`**（**`types.ts`**，含 **`debugVisual` 不入库**）；**`settings-serialize`** + **`applySceneAssetCollisionFromSettings`**。
- **实现**：**`scene-assets/collision/scene-asset-collision.ts`**、**`scene-asset-collision-debug.ts`**；UI **`camera-settings-ui.ts`**；**`viewer.ts`** **`initSceneAssetCollision`**。详 **`docs/放置资产相机碰撞实现说明.md`**、**`docs/工作记录.md`（2026-05-29）**。

**2026-05-29 补充（场景拾取 Picker 双路径）**：
- **`src/picker.ts`（混合）**：
  - **`pick()` / `pickWorldFromClientXY`**：`EnginePicker(depth=true)` + `getWorldPointAsync`；**不**常驻覆盖全局 `pickPS`（与资产 `pc.Picker(false)` ID pass 分离）。
  - **`pickSurface()`**：**Raster** 恢复 **RGBA16F alpha 加权深度累加** + `PICK_SURFACE_MIN_ALPHA` + `nearestPosition` 邻域（手电筒须用 `nearestPosition ?? position`）；深度 `pickPS` 仅在 `accumPass.render()` 前后 **register/unregister**。**Compute** 用引擎深度 + 邻域 `getWorldPointAsync`。
  - **单例**：**`global.picker`**（`types.Global.picker`）；`getSharedPicker`；Viewer **`global.picker = this.picker`**。
- **`src/scene-assets/scene-asset-selection-pick.ts`**：已放置 **unified 高斯** 挂 **`World + SceneAssetPick`**（`configurePlacedGaussianPickLayer`）；点选先 **SceneAssetPick** 层 `getSelectionAsync`，再 World 拾取 mesh；高斯可深度/AABB 兜底。主场景 World 合成 pick 不再单独依赖来选中放置高斯。
- **文档**：[场景拾取与Picker双路径说明.md](场景拾取与Picker双路径说明.md)；[标注放置Picker问题根因说明.md](标注放置Picker问题根因说明.md) §4 已更新为当前落地。详 **`docs/工作记录.md`（2026-05-29）**「场景拾取与 Picker 双路径收敛」。

**2026-06-02 补充（Viewer / 预览：场景资产拾取上报）**：
- **范围**：**`!state.editMode || state.previewMode`**（**`isViewerOrPreviewMode` / `isAssetScenePickEventOnlyMode`**，真源 **`state-selectors.ts`**；**`isMediaConsumptionMode`** 复用同一 Viewer/预览判定，定义在 **`media-hotspot-params.ts`**）。
- **行为**：**`asset-placement-handler`** 经 **`input-arbiter`**（`asset.placement-and-selection`）处理画布单击；**仅**更新 **`selectedSceneEntityId`** 并 **`events.fire('sceneAsset:selected', { source:'scene' })`** → **`SCENE_ASSET_SELECTED`**；**不**触发 Gizmo、**`inputEvent('frame')`**、放置、历史。
- **可拾取类型**：**`isSceneAssetPickableInViewerMode`** — 仅 **`mesh` / `gaussian`**；**image / video / audio** 暂不参与（音视频仍走热区 / callout 既有逻辑）。
- **与编辑态差异**：编辑 + 资产模块仍走完整 **`editAsset`** 路径（聚焦、Gizmo 等）；pick-only 未命中 **不 claim** 点击。详 **`docs/工作记录.md`（2026-06-02）**、**`docs/场景选中与输入分层说明.md`**。

**2026-06-04 补充（变形关键帧拾取 `MORPH_ASSET_ADD_*`）**：
- **协议**：**`MORPH_ASSET_ADD_START` / `MORPH_ASSET_ADD_FINISH`** 经 **`dispatchAsset` → `AssetFacade`**（与 **`ASSET_*`** 同属 **asset 域**）；**`morphAssetAddActive`** 写入 **`state`**（须在 **`observe` 初始 keys**）。
- **生效条件**：**`isMorphAssetAddPickMode`** = 编辑态 + **`editLeftModule==='asset'`** + **`morphAssetAddActive`**（宿主配置 morph 时须 **`EDIT_MODULE_SET` → `asset`**，或用户在资产 Tab 下操作）。
- **画布行为**：**`asset-placement-handler`** — morph 子模式 **仅拾取 `gaussian`**，**不** 触发 **`ASSET_PLACE`**；选中后走常规 asset 路径（**`focusTarget:'asset'`**、Gizmo、底部栏）。光标与 **`ASSET_PLACE`** 相同 **placement** 图标。
- **出站**：**`SCENE_ASSET_SELECTED`** **`{ module:'asset', id, assetType? }`**（**`source==='scene'`**）。
- **Internal**：测试按钮在 **`asset-placement-settings-ui`**；**`assetEffects`** 面板仅保留 morph 配置 UI（**`asset-effects-ui`**），**不** 承载 START/FINISH。详 **`docs/工作记录.md`（2026-06-04）`**。

**2026-06-02 补充（手电筒拾取稳定性，`torch-light.ts`）**：
- **位置模型**（不变）：方向 = 每帧当前光标视线；深度 = 缓存 **`lastDistance`**；gsplat 经 **`night-mode`** **`uTorchWorldPos`**（**`getTorchLightWorldPosition` 仅 `hasWorldPos`**）。
- **本轮修复**：**`pickInFlight` 400ms 超时恢复**；**mesh + `pickSurface` 同轮异步回调合并提交**（避免刷新后 mesh/gsplat 时序竞态）；**开灯 `resetPickRuntime`**；**`readyToRender` 门控**；无指针时 **屏幕中心** 拾取（**`resolvePickClientXY`**）。**未**保留 collision GLB 排除、强制最近深度等已撤回方案。
- **已知限制**：大场景 **LOD** 加载进度不同，同像素 **`pickSurface`** 深度仍可能略有差异。详 **`docs/工作记录.md`（2026-06-02）**。

**2026-06-01 补充（阴影 B：放置资产接影 — 当前实现）**：
- **开关**：GLB 型 **`?collision=`** + **`postEffectSettings.shadow.enabled`**；reveal 后 **`activateOutput`**（`shadow-system.ts`）。
- **A / B**：放置 **mesh** → 引擎 shadow map + **`receiveShadows`**；**主场景高斯** → B 全屏叠影；**主高斯 `castShadows` 恒 false**；放置高斯 `castShadows` 随 enabled。
- **放置 mesh/image/video（B）**：**`ShadowReceiverOccluder`** — `shadowMaskCamera` 先 depth-only 预写，再渲接影层；**不**挂 **`PlacedMeshExclude`**。
- **放置高斯（B 自像素）**：**`PlacedMeshExclude`** + exclude 相机（priority 1，仅有放置高斯时启用）；**`gsplat-exclude-mask-shader`** → **G=1** mask-only splat；postrender `blend *= (1 - gsplatMask)`，且仅当 **`excludeDepth <= shadowMaskDepth + bias`**（`createShadowPassDepthTexture`）— 避免轮廓投到前景放置 mesh 上误抠洞。
- **勿再实现**：mesh **R 白模 / prerender 换材质**、postrender **手比接影深度**、**`PlacedGsplat` 分层**（破坏 unified 遮挡）。
- **unified**：主/放置 **同 World 层**；加载期 **`suspendShadowPipelineForGsplatLoad`**。详 **`docs/工作记录.md`（2026-06-01）**、**`docs/阴影双管线与放置资产说明.md`**。

**2026-06-01 补充（scene mesh 出站 + Universe 体素碰撞）**：
- **场景碰撞 URL**：**`?collision=` / `?voxel=`**（优先）或 **`settings.collision.url`**；**`scene-collision-source.ts`** 的 **`resolveCollisionUrl` / `ensureCollisionUrl` / `setCollisionUrl`**；加载与门控在 **`CameraCollisionManager`**（**`camera-collision-manager.ts`**）+ **`scene-mesh-load-orchestrator.ts`**。
- **生成（无现成 URL，或已有 URL 加载失败）**：**`POST {apiHost}/conversion/voxel-collision/jobs`** 立即拿 **`jobId`**，再 **`GET .../jobs/:jobId`** 轮询（**`universe/collision-mesh-service.ts`**）。body 默认 **`{ modelUrl, projectId }`**（upload true）。成功 **`data.data.url`** 写回 **`settings.collision.url`**。队列满 **429**；任务过期 **404** 可 **`forceRegenerate`**。需 **projectId + token + contentUrl**。轮询超时从 **`running`** 起算（对齐服务端 5min，不含排队）。
- **入站**：**`COLLISION_SET` / `COLLISION_PATCH`**（**`collision-protocol-adapter.ts`**）、**`SHADOW_SET`**（**`environment-protocol-adapter.applyShadowSetFromHost`**）— 开启前先 **`ensureSceneMeshForIntent`**。
- **出站（`message-bridge`）**：**`SCENE_MESH_LOAD_PROGRESS`** — 生成排队/转换中（**不受** `suppressCollisionOutbound` 抑制）；**`SCENE_MESH_LOAD_*`** — `module` 按 intent（collision→**`camera`**，shadow→**`environment`**）；**`COLLISION_SYSTEM_READY`** — **`{ module:'camera', collisionUrl? }`**；**`SHADOW_SYSTEM_READY`** — 仅 **`isShadowOutputEnabled`** 时 **`{ module:'environment' }`**（无 `enabled`/`outputActive`）。宿主下发加载/就绪在 **`suppressCollisionOutbound`** 下不回环。详 **`docs/SaaS第四期编辑模式接口文档.md`** §5.1、**`docs/工作记录.md`（2026-06-01）**「碰撞/阴影：出站协议…」。

**2026-05-20 补充（视频横向曲度 / 电视墙 + image/video 不收引擎阴影）**：已放置 **video** 可用 **`transform.horizontalCurvature`**（**[0,1]**，0 平面；1 对应最大张角约 **180°**，即半圆）做绕竖直轴的水平弯曲（**`curved-billboard-mesh.ts`**：**`VIDEO_HORIZONTAL_MAX_ARC_DEG=180`**；细分 **`PlaneGeometry` 保持 XZ/+Y**，局部 X 弯弧、凹向与内置 plane 一致）；**`rebuildVideoRenderMesh`**；入站 **`ASSET_VIDEO_CURVATURE_SET`** `{ id, value }`（**不回传**）。播控命中与曲度联动见 **`video-controls-texture.ts`**（**2026-05-25**）。**`image` / `video`**：**`receiveShadows: false`**（unlit 卡片）；**B** 由 **`ShadowReceiverOccluder`** 处理遮挡（非 exclude mask）。

**2026-05-25 补充（曲度半圆上限 + 大曲度播控命中 + 音频热区）**：
- **曲度上限**：**`VIDEO_HORIZONTAL_MAX_ARC_DEG`** 由 **270°** 改为 **180°**；协议 **`horizontalCurvature ∈ [0,1]`** 不变，**1 = 半圆**。
- **视频播控命中**：控件绘制在纹理像素空间固定，几何随 **`createCurvedBillboardMesh`** 弯曲；命中 **射线 ↔ 弯曲 mesh 三角形** → 纹理 **`(px,py)`** → **`hitTestTextureControls`**。大曲度时弧端按钮屏幕投影极小、**`px≈texW`** 易漏点，故 **`screenPad` / `playPad` / jitter** 按曲度线性放宽。详 **`docs/工作记录.md`（2026-05-25）**。
- **音频 callout**：**`PLAY_HIT_PAD=24`**（平面 callout，无曲度联动）。

**2026-05-20 补充（View→Edit 场景资产就地同步）**：进入编辑在 **`applySettingsSnapshot(__originalSettings)`** 之后，**`requestSceneAssetsRestore(global, { reason: 'edit-enter' })`** 默认 **`clearBeforeRestore: false`** → **`syncScenePlacedEntitiesFromSettings`**（**不** `clearScenePlacedEntities`）：按 **`id` + `type` + `source` 指纹**复用已有 entity，仅写回 position/transform/**`visible`**/视频曲度等；**显隐以 `settings.sceneAssets[].visible` 为准**（View 下 **`ASSET(S)_SHOW_HIDE_SET`** 只改运行态、不写 settings）。**`edit-discard` / `history-restore` / startup** 仍为 clear+全量 **`restoreSceneAssetsFromSettings`**。详 **`docs/工作记录.md`（2026-05-20）**「View → Edit：场景资产就地同步」。

**2026-05-20 补充（默认视角 / 缩略图 / 热区深度）**：**`CAMERA_DEFAULT_VIEW_CAPTURE`** + **`saveExperienceProject`**（`destination: 'universe'` 上传缩略图+settings；`'local'` 仅下载 settings.json，见 **2026-08-26**）。截图 **`captureViewportJpegBlob`**（**`capture-viewport-screenshot.ts`**）为 **cover 居中裁切至 1024×576**（非 letterbox）。**`CAMERA_RESET`** → **`inputEvent 'reset'`** → **`settings.cameras[0].initial` 的 `resetCamera`**（orbit/walk/fly 分支）；**`ANIMATION_RESET`** → **`resetAnim`** 重播 **animTrack**，二者勿混。**热区（2026-05-22 起）**：仅 **欧氏距离** ≤ 触发半径；已移除 **`coneHalfDeg`**。详 **`docs/工作记录.md`（2026-05-22）**。

**2026-05-19 补充（sceneAssets 保存合并 + 视频放置预热）**：
- **序列化**：**`settings-serialize/settings-serialize.ts`** 的 **`buildSceneAssetsForPersistence`** = **`serializeScenePlacedItem(scenePlacedEntities)`** + **settings 中 id 不在运行态的 preserved**（video 恢复失败仍保留 JSON）；**`removeSceneAssetFromSettings`** 在 **`sceneAssets:removed`** 时剔除，防删除后 merge 复活。
- **视频放置**：**`scene-assets/video-placement-preload.ts`** — **`assetPlacement:start`** 对 video 调用 **`startVideoPlacementPreload`**；**`placement-cursor`** **`loading: true`** 为系统 **`wait`**；点击 **`acquirePlacedVideoForPlacement`**；**`awaitPlacedVideoFirstFrame`**（**`progress` / `loadeddata`**，放置 **20s**、恢复 **45s**）。**`asset-facade`** 对 video 不在「下载完成」时抢回十字光标（由 handler 接管）。慢的主因：**远程首帧 + CORS/Range**，非 mesh 式预下载。
- **可选后续**：metadata 占位平面、失败 toast、dev 仅媒体代理。详 **`docs/工作记录.md`（2026-05-19）**「保存合并、视频放置预热与光标」。

**2026-05-19 补充（标注嵌入视频）**：标注除 **`imageUrl`** 外支持可选 **`videoUrl`**（**互斥**，**`normalizeAnnotationMediaFields`**，双字段同存时保留 **`videoUrl`**）；视频**仅 URL**（**`ANNOTATION_CONFIRM` / `ANNOTATION_UPDATE` / settings JSON**），Viewer **不上传**。场景：**`annotation.ts`** 的 **`videoThumbDom` + `videoPreviewOverlay`**，tooltip **不 autoplay**，点击缩略全屏 **`<video controls playsinline>`** 再 **`play()`**；**`Annotation.closeMediaPreviews`** / **`_hideElements`** 关闭并 **`pause()`**。出站 **`SCENE_ANNOTATION_EDIT_START.value`** 含 **`videoUrl`**。Internal 表单（**`annotation-toolbar-ui` / `annotation-settings-ui`**）为 **无/图片/视频** 三选一 + 视频 URL 输入。详 **`docs/工作记录.md`（2026-05-19）**。

**2026-05-14 补充（message-bridge `module` 真源与出站）**：**`MESSAGE_BRIDGE_MODULE` / `EFFECTS_PROTOCOL_MODULE` / `EffectsProtocolModule`** 定义在 **`src/editor-modules/modules-types.ts`**（**`message-bridge`** 与 **`effects-protocol-adapter`** 共用，避免 **`message-bridge` ↔ `effects-protocol-adapter`** 为常量互引）。**`postToParent`** 调试日志打印 **`postMessage` 的最终 `message`（含 `type`）**。出站 **仅编辑域**事件带 **`module`**（**`asset` / `annotation` / `environment` / `camera` / `effects`**）；**`SCENE_ASSET_SELECTED`** 在 **`source==='scene'`** 时为 **`{ type, module:'asset', id, assetType? }`**（**`assetType`**：**`getSelectedSceneAssetType`**）。**`VIEWER_READY`、`EDIT_HISTORY_*`、`SETTINGS_*`** 等仍不带 **`module`**；**`CAMERA_DEFAULT_VIEW_CAPTURED`** 等相机域事件带 **`module:'camera'`**。**2026-06-01**：**`SCENE_MESH_LOAD_*`** 的 **`module`** 按 collision/shadow **intent** 分流；**`SHADOW_SYSTEM_READY`** → **`environment`**；**`COLLISION_SYSTEM_READY`** → **`camera`**。第四期文档 **`MESSAGE_BRIDGE_MODULE`** 锚点见 **`modules-types.ts`**。详 **`docs/工作记录.md`（2026-05-14、2026-06-01）**。
**2026-05-11 补充（merge conflict 收口与交互回归修复）**：冲突文件已统一按 secondary-first 收敛到单语义：**`picker.ts`** 保留 `pickWorldFromClientXY` 与 compute `clientWidth/clientHeight` 采样语义，同时吸收 `pickSurface`、相机快照缓存与串行 pick；**`input-controller.ts`** 采用 `NavInteraction + Picker` 主路径并保留本地速度/标注焦点接口；**`viewer.ts` / `ui/ui.ts`** 统一碰撞覆盖层状态为 `hasCollisionOverlay/collisionOverlayEnabled`，并将 `showVoxels` DOM 绑定改为 `showCollision`（修复 `null.addEventListener`）；**`camera-manager.ts`** 在动画 `interrupt/cancel` 回退时对 `walk` 做 `orbit` 兜底，修复“动画播放时点击场景默认进 walk”；loadingBar UI 恢复原橙色渐变进度样式。
**2026-05-08 补充（资产镜像+旋转持久化）**：`sceneAssets.transform` 在资产链路新增 `rotationQuat?: [x,y,z,w]` 并保留 `rotation` 兼容字段；保存时写 `rotationQuat + rotation + scale + mirror`，读取时优先 `rotationQuat`（缺失回退 Euler），并固定恢复顺序为“rotation → scale → mirror”，用于降低镜像与欧拉角组合产生的等价解抖动，作为当前会话约束。
**2026-04-29 补充（天空盒 / PBR 亮度链路）**：`src/loaders/skybox-loader.ts` 的 `applySkyboxTexture` 已切换为 `EnvLighting.generateSkyboxCubemap` 驱动 `app.scene.skybox`（背景显示），并将 `app.scene.envAtlas` 固定为独立反射源（当前为纯色白 envAtlas：`SOLID_ENV_ATLAS_COLOR = Color(1,1,1)`），实现背景与 IBL 反射解耦；`src/vfx/lighting/night-mode.ts` 的 `targetSkyboxIntensity` 经多轮“提亮→回调”后收敛为 `Math.max(0.23, Math.min(2.0, 1.1 + 1.0 * this.nightFade))`，用于平衡高反光 PBR 的提亮与过曝风险。
**2026-04-28 补充**：**`growth-wave` Phase 1 自适应点大小**：新增 `pointSizeAdaptiveScale` 属性（默认 3.0），远处点自动放大（近处保持小尺寸防过曝），公式 `adaptiveSize = pointSize * (1.0 + normalizedDistance * adaptiveScale)`，GLSL/WGSL shader 同步实现。**首帧 VFX 闪现修复（forceRenderNextFrame 语义修复）**：`framerender` 事件处理中 `forceRenderNextFrame` 优先级高于 `readyToRender` 抑制（用于预热帧），`frameend` 回调清除标志恢复按需渲染；修复此前修复引入的“卡在 100%”死锁问题。
**2026-04-14 补充**：**Bloom 面板在 `message-bridge` 下的 `BLOOM_IS_LOCAL_SET` 统一走 `sendEditProtocolMessage`**（不再使用 `global.postMessage`）、**Threshold(HDR) 含 UI tooltip 与代码注释语义说明**、**离开 `environment` 模块若存在 `draft-*` 区域则内部自动触发 `LIGHT_BRUSH_CLEAR` 回收笔刷会话**、**开场 reveal 初始效果创建延后到 `firstFrame` 且阻塞 reveal 分支提前冻结 `animationPaused`**。
**2026-04-15 补充**：**`growth-wave` 点云阶段新增 `maxScatterDistance` 上限（GLSL/WGSL 同步）以避免大场景位移过大导致的远裁剪观感**、**聚光灯可视化新增 `spotLight_debugDisc`（锥底平面调试圆盘）用于核验“锥底截面 vs 场景受光交线”**、**聚光灯实验性收敛参数 `EFFECTIVE_SPOT_CONE_ANGLE_SCALE=0.9`（仅收紧真实 light/gsplat 生效锥角，`settings` 与 gizmo 展示不变）**，并确认**侧视偏差主因属于光锥与受光表面交线/法线/遮挡叠加及视差放大，而非锥底几何计算错误**；**同日起 `previewMode` 架构改为由 `ModuleOrchestrator` 统一分发到各 `Facade` 的模块策略（asset/annotation/environment/effects），`message-bridge` 的 `PREVIEW_MODE_SET` 仅负责写状态；随后继续收敛为“单一 `previewMode` + `state-selectors` 实时推导（asset/annotation/environment）”，移除 `asset/annotation/environmentPreviewVisualEnabled` 三个派生全局 state，底层 gizmo/light 执行层不再维护可见性派生状态。**
**2026-04-17 补充**：**资产 Transform Gizmo 与相机、场景拾取互斥统一用 `state.cameraControlsEnabled`（不再在 `Global` 上挂 `gizmoPointerCapture`）**；**`gizmo-handler.ts` 在 `canvas` capture 阶段用当前 Gizmo `_getSelection` 预判命中，命中则先于资产 ID-Picker 关相机并 `flushInputs`**；**`asset-placement-handler.ts` 在 `cameraControlsEnabled===false` 时跳过资产 `pointerdown` 拾取**；**`input-controller.ts` 在同等条件下跳过 `pointerup` 触发的 `scenePointerWorldClick`**。**`gizmo-handler` 切换 Gizmo 类型时显式设置 `coordSpace`：`scale`→`local`，`translate`/`rotate`→`world`，避免从 scale 切回后轴向被继承污染**。**资产 `scale` 模式 + 按住 Shift 时 `ScaleGizmo` 拖拽为整体等比缩放**（`transform:start/move/end` 内按轴因子同步三轴，保持各节点起始比例）。
**2026-04-18 补充（局部亮灯 / Bloom 观看闸 + 协议）**：**整灯总闸在观看态的读数**为 **`global.viewSettings?.bloom?.localLightsEnabled`（不入库，Viewer 默认 `true`）**；**`LIGHT_TOGGLE_ALL` 写入该字段**；`bloom.ts` 的 `applyViewerLocalLightPolicy` 仅在**观看态且为 false** 时整段清空局部亮灯合成，**编辑态不读此闸**。存盘 **`postEffectSettings.bloom.localLightsEnabled`** 已废弃，导入时从 `bloom` 删除。**`LIGHT_BRUSH_FINISH`**：`skipAutoLinkedLight` **缺省或 `true` → FINISH 不落自动灯**；**仅 `false` → 单步内 `applyLightAdd`**；FINISH 写入 **`draftLightRegionCenter`**（质心→中心→原 draft）供后续 **`LIGHT_ADD(id)`** 进入单击放置流程，并由 **`applyLightAdd`** 对 **`activeLocalLightRegionId`** 下**未绑**区域写 **`linkedLightId`**。**本机**：`internal` 完成 = FINISH + 本地第二步 `allocateNextUserLightId`+`applyLightAdd`；**`message-bridge`** 完成仅 FINISH，灯由父级 **`LIGHT_ADD` + 场景单击一次** 完成落位。**Lighting 加灯**：仅当激活区域尚无 `linkedLightId` 时才自动绑定，避免覆盖已有绑灯。**2026-04-20 补充（growth-wave 裁剪与架构收口）**：`viewer.ts` 不再按 `vfxType==='growth-wave'` 做硬编码裁剪分支；改为 `reveal.ts` 暴露统一 `getCameraClipHint()`，由当前脚本（如 `vfx/gsplat-growth-wave.ts`）按需提供 `clipPadding/nearMax`。`viewer` 仅消费通用 hint，`clipPadding` 仅扩 `farClip`、`nearClip` 采用默认值再受 `nearMax` 上限约束，避免补丁式 if-else 扩散与 near 侧联动副作用。
**2026-04-21 补充（输入仲裁/放置态收口）**：新增 **`input-arbiter.ts`** 并在 `viewer.ts` 初始化，点击链路改为“`input-controller.ts` 统一拾取后按优先级 `claim` 分发”；`environment-facade`、`asset-placement-handler`、`annotation-toolbar/placement-mode`、`camera-manager` 全量接入仲裁器并移除直接 DOM 点击竞争。放置语义统一为**未命中 worldPosition 仍保持放置态**。全局 `state` 移除 `lightPlacementActive` / `annotationPlacementActive` / `annotationEditMode`，改为模块内状态。`annotation-ui.ts` 修复 `AnnotationManager` 双实例导致的占位残留（复用全局实例 + ownership 销毁）。新增 `placement-cursor.ts` 由 Facade 层统一放置光标（`/assets/icons/placement.svg`，失败回退 `crosshair`）。`input-arbiter.ts` 已补充注释说明优先级、claim 短路和解绑设计。
**2026-04-22 补充（聚光角语义/线框对齐/闪烁优化）**：聚光配置语义固定为 **settings 存整锥顶角（度）→ 引擎使用半角**，转换函数统一为 **`spotApexToHalfDeg`**（原冗长命名已替换）；默认顶角收口为 **`inner=50` / `outer=90`**（等效半角约 `25/45`）。同时移除 `spotConeApexStorage` 与 `migrateSpotConeAnglesToApexStorage`，`ensureLighting` 不再自动迁移旧角度数据。为减少“线框与实际受光不贴合”，`updateSpotGizmoShape` 改为优先读取 `LightComponent` 当前生效角度计算内外圈。针对环境模块高频调灯的整屏闪烁，在 `updatePointLightsFromSettings` 增加 directional 配置签名缓存，仅方向光相关参数变化时才重写 directional/阴影状态。
|**2026-04-27 补充（资产放置下载状态机）**：**`ASSET_PLACE` 协议处理改为异步预下载模式**：`asset-facade.ts` 新增 `hydrateAssetForPlacement` 与 `handleAssetPlace`，对 gaussian/mesh 类型资产先下载再允许放置，image 类型保持原异步加载；放置光标分两种状态 - `downloading`（`wait` 光标，禁用点击）与 `awaitingPlacement`（正常放置光标，允许点击）。`placement-cursor.ts` 扩展 `setPlacementCursorActive(global, active, { loading })` 接口支持状态区分。模块退出时自动取消正在进行的下载，防止误触发放置。
|**2026-04-28 补充（资产/标注显隐统一控制）**：`types.ts` 新增 `ViewSettings.annotationsVisible` 作为 View 模式标注显隐状态源；`ASSETS_SHOW_HIDE_SET` 通过事件 `assets:allVisibilityChanged` 驱动标注显隐同步；`deferred-editing-visual-sync.ts` 统一控制：reveal 期间强制隐藏，解锁时按 `viewSettings.annotationsVisible ?? true` 恢复；解决 reveal 重播时标注异常显现问题。
|**2026-04-28 补充（高反光 PBR 材质亮度提升）**：`asset-placement-handler.ts` 新增 `configurePlacedMeshMaterials`，智能检测高反光 PBR 特征（metalness/shininess/clearCoat/贴图），通过**突破 1.0 限制的 ambient/diffuse 绝对值**（1.2/1.1）+ **降低 metalness 保留漫反射**（0.6-0.7）+ **微弱自发光补偿**提升弱光场景可读性；`viewer.ts` **强制开启 HPR**（`highPrecisionRendering=true`）确保 HDR 值正确渲染；代码规范化提取 `PBR_DETECT_THRESHOLDS`、`PBR_BOOST_FACTORS` 常量与纯函数。
|**2026-04-27 补充（光源协议完善）**：**`LIGHT_ADD` 通过 draftRegion 建灯触发 `SCENE_LIGHT_PLACED`**（`source='scene'`）保持与点击放置协议一致；**`PointLightConfig` 补充 `type: 'point'`** 字段与 Spot/Directional 统一；**`LIGHT_COPY` 扩展 `copyName`** 支持指定复制光源名称；**`LIGHT_BRUSH_RANGE_SET` 支持点光源**（不再仅限聚光灯）；**`SHADOW_DIRECTION_SET` 修复**：支持父级字符串 `value` 传参、清除方向光签名缓存强制刷新。

**2026-04-24 补充（Spot Light 旋转 Gizmo 万向锁修复）**：`gizmo-handler.ts` 中 **spot light rotate 模式 `coordSpace='local'`**，禁用局部 Y 轴（roll 轴），仅启用 X/Z 轴作为 pitch 控制候选。投影逻辑统一使用照射方向（local -Y 世界方向）计算 yaw，不再依赖旋转轴自身方向。新增 **yaw 连续性保持**：`getSpotYawFromDirection` 选择最接近 `fallbackYaw` 的等价值（考虑 ±360 偏移），避免 atan2 在 0°/360° 边界跳变。新增 **水平区域优化**：当 |pitch|<15° 时直接使用 `asin(垂直分量)` 计算 pitch，不依赖 yaw，避免 yaw 误差导致的 pitch 突变到 ±180°。目标文件 lint 通过。**同日补充（相机稳定性 + Bloom 总闸语义）**：相机链路收口为：`orbit-controller.ts` `onEnter` 仅收敛 `distance` 不改 `position`、`camera-manager.ts` 将 orbit `maxZoom` 系数从 `0.5` 放宽至 `4.0`、`cameras/camera.ts` 的 `Camera.lerp` 增加零向量/非有限值保护以避免双击后角度 NaN 黑屏；并在 `environment-protocol-adapter.ts` 中将 `LIGHT_TOGGLE_ALL` 扩展为 **`bloomScope='global'` 时同步 `settings.postEffectSettings.bloom.enabled`**，使该协议可直接开关整场辉光（`local` 模式保持 `viewSettings.bloom.localLightsEnabled` 语义）。
**2026-04-27 补充（growth-wave 远裁剪修复 - 双层修复）**：修复 `growth-wave` 特效在较远视角下 Phase 1 蓝色点云被裁剪的问题。根因是双层问题：1）`getCameraClipHint` 计算的 `clipPadding` 未能覆盖 shader 实际外推距离（`scatter * 15.0 * (1.0 + distFromCenter * 0.2) * ~2.5`）；2）`viewer.ts` 中 `far` 计算使用 `dot(camera.forward, centerOffset)` 投影距离，当相机侧视/背向场景中心时无法覆盖被外推到侧方/后方的粒子。修复：1）`gsplat-growth-wave.ts` 重新计算 `clipPadding` 并移除 120 上限（大场景需 1000+）；2）`viewer.ts` 改用 `cameraToCenterDist`（实际欧氏距离）计算 `far = cameraToCenterDist + boundRadius + clipPadding`，确保任何朝向下都能覆盖外推粒子。

**2026-04-27 补充（首帧 VFX 闪现修复 - 双层修复）**：修复首帧上屏时偶发“闪现偏色/蓝光后消失”问题。根因是**双层时序问题**：1）**NightMode/VFX 互斥空窗期**：`createEffect` 中 `nightMode:exit` 和 VFX shader 应用在同一帧，导致 NightMode shader 移除后、VFX shader 应用前的“空窗帧”；2）**材质异步创建时序**：unified 模式下第一帧创建材质、第二帧 shader 编译完成。修复采用**双层方案**：1）`reveal.ts` 中 `createEffect` **延迟一帧**调用 `doCreateEffectScript`，确保 `nightMode:exit` 和 VFX 应用跨帧，消除空窗期；2）`viewer.ts` 中非 LOD 模式与 LOD 模式两处使用**多帧预热**（最多 3 帧）确保材质创建+shader 编译完成后再设置 `readyToRender`。

**2026-04-27 补充（光源协议元数据 + Spot 回写收口）**：新增 **`LIGHT_UPDATE { id, value: { name } }`** 外部协议（`message-bridge`/`environment-facade`/`environment-protocol-adapter` 全链路接入），用于更新光源名称等元数据；**`LIGHT_ADD`** 支持 **`name`** 入参并在落位后写入灯配置（未传回退 `id`），`Point/Spot/Directional` 配置类型统一补齐 `name?: string`。同时收口 Spot 旋转回写语义：`gizmo-handler.ts` 在 `pointer:up` 阶段仅在 **rotate 模式且有有效旋转变更** 时写回 `pitch/yaw`，不再在 `rotate -> move` 或纯平移场景用 `Euler` 兜底覆盖，降低模式切换触发上下翻转的副作用。另补充：`SHADOW_DIRECTION_SET` 执行前清空 `__directionalLightSignature`，确保方向光签名缓存失效后强制刷新生效。

---

## 1. 项目目的

**SuperSplat Viewer** 是基于 PlayCanvas 的 3D Gaussian Splatting 场景查看器，支持：

- 加载 `.ply` / `.splat` 等高斯点云格式
- 编辑模式：资产放置、场景标注、光照、阴影、后处理、VFX 特效、视频导出
- 观看模式：相机控制、动画轨道、Reveal 过渡、XR 支持

---

## 2. 架构概览

```
index.ts (main)
    ├── createApp() → App + Camera
    ├── initLight / initXr / initUI
    ├── Viewer(global, gsplatLoad, skyboxLoad)
    └── initVideoExport(global, { getRevealExportTimingSource: () => viewer.revealController })
        （须在 new Viewer 之后；不向 Global 挂 reveal 阈值回调）

Viewer (viewer.ts)
    ├── CameraManager (orbit / anim / fly)
    ├── ModuleOrchestrator (facade 生命周期：onEnter/onExit/onEditModeExit)
    ├── CommandRegistry (模块命令分发：asset/annotation/environment/effects)
    ├── reveal-policy.ts（`PERSISTENT_VFX` / `revealBlocksAnim` / `nightDeferredByReveal`，供 viewer 统一门控）
    ├── reveal/effects-orchestrator.ts（`shouldRequestPersistentGsplatRemount`：双轨 remount 编排，读 `settings`）
    ├── persistent/persistent-gsplat-lifecycle.ts（`runPersistentGsplatEntityLifecycle`：Viewer 侧 persistent 单入口，M20）
    ├── RevealController（`reveal/reveal-controller.ts`；组合 `RevealPersistentGsplatController` → `reveal-persistent-controller.ts`）
    ├── BloomController (Bloom 后处理)
    ├── NightMode (夜间模式 + Bloom Brush 合成)
    ├── shadow-system / ShadowApplyRt + shadow-apply-exclude-mask + gsplat-exclude-mask-shader + initShadowCatcher
    ├── Annotations (场景标注)
    └── GizmoHandler / AssetPlacementHandler
```

**核心数据流**：`Global = { app, settings, config, state, events, camera }`，各模块通过 `events` 通信，`settings` 持久化配置。

---

## 3. 主要模块

| 模块 | 路径 | 职责 |
|------|------|------|
| App | `app.ts` | PlayCanvas 应用扩展、postMessage 桥接 |
| Viewer | `viewer.ts` | 场景管线、相机、后处理、VFX、阴影、Bloom 集成 |
| RevealController | `vfx/effects-runtime/reveal/reveal-controller.ts` | 一次性 reveal：`createEffect` / 时间轴；**M20** 组合 **`RevealPersistentGsplatController`**（`reveal-persistent-controller.ts`）处理 persistent 挂载前后 Night/inVfx；Viewer 侧实体重挂入口 **`persistent/persistent-gsplat-lifecycle.ts`**（`runPersistentGsplatEntityLifecycle`） |
| CameraManager | `camera-manager.ts` | 相机模式切换、动画轨道；Fly/Orbit **sceneAsset 碰撞 resolver** |
| EditHistory | `edit-history.ts` | 编辑历史快照、撤销/重做 |
| Settings | `settings.ts` / `settings-serialize/settings-serialize.ts` / `settings-serialize/settings-serialize-helper.ts` / `settings-serialize/settings-serialize-configs.ts` | 配置结构、ensure/normalize 与序列化 |
| effects-orchestrator | `vfx/effects-runtime/reveal/effects-orchestrator.ts` | 双轨 GSplat：`shouldRequestPersistentGsplatRemount`（读 `settings`，与 `reveal-policy` 解耦） |
| gsplat-effect-layers-extractor | `vfx/effects-runtime/gsplat-effect-layers-extractor.ts` | 从整段 `gsplatModifyVS` 拆 layered 块供 `GsplatEffectComposer`（Night / perlin 等） |
| Pointillism NPR | `vfx/effects-runtime/persistent/stylisation/pointillism-stipple-{shaders,persistent,post}.ts` | persistent stylisation **`pointillism-stipple`**：modify 点径/减密/色彩振动 + gsplatPS 笔触 + 可选 post 平整；与 NightMode 互斥；见 **§5.9** |

---

## 4. 编辑模式工具栏结构

**左侧工具箱** (`edit-left-toolbar.ts`)：8 个模块入口（支持 `null`：不选中任何模块）

- `gs` - GS 模型编辑（敬请期待）
- `asset` - 资产放置
- `annotation` - 场景标注
- `environment` - 环境设置（Lighting + PostEffect）
- `skybox` - 天空盒（内置列表 + **`uploadUrls`** + URL 添加 → **`skybox-settings-ui.ts`**）
- `camera` - 相机设置（碰撞开关、autoFit/XYZ 缩放、调试线框 → **`camera-settings-ui.ts`**）
- `effects` - 场景特效（VFX + Render）
- `assetEffects` - 物体特效

**右侧面板** (`edit-right-toolbar.ts`)：按 `state.editLeftModule` 切换对应面板；当 `editLeftModule === null` 时隐藏右侧面板。

**底部栏** (`edit-bottom-toolbar.ts`)：按模块显隐与内容区分

- **显隐**：
  - `asset` / `annotation` / `environment` 模块时显示底部栏
  - 其他模块 (gs, skybox, camera, effects, assetEffects) 隐藏
  - `null`（未选模块）时隐藏
- **asset 模块**：移动、旋转、缩放；复制、删除
- **annotation 模块**：移动、编辑、删除
- **environment 模块**：光源编辑底栏（移动 / 旋转 / 编辑 / 删除），通过 `state.lightTransformMode` 与 `selectedLightId` 驱动 Transform Gizmo 与 Lighting 面板联动

---

## 5. 编辑模式核心模块能力

### 5.1 资产放置 (Asset Placement)

**入口**：`asset` 模块 → `rightPanelAsset`  
**核心**：`asset-facade.ts`、`asset-placement-handler.ts`、`placement-cursor.ts`

- **放置流程（含下载状态机）**：`ASSET_PLACE` 命令由 `asset-facade.ts` 异步处理，分两个阶段：
  - **`downloading`**：对 gaussian/mesh 类型（**image / video / audio 除外**），先预下载 PlayCanvas Asset；此阶段显示 `wait` 光标，**禁用场景点击放置**；下载失败则终止流程。
  - **`awaitingPlacement`**：下载完成后切换为正常放置光标，此时用户点击场景才触发放置；完成后回传 `SCENE_ASSET_PLACED`。
  - **video 放置（无 mesh 式预下载，有首帧预热）**：`assetPlacement:start` 后 **`video-placement-preload.ts`** 即对 URL **`startVideoPlacementPreload`**；预热中 **`placement-cursor` `loading: true`（`wait`）**；首帧就绪后恢复十字。点击时 **`placeAsset(..., { videoLoadMode: 'placement' })`** → **`acquirePlacedVideoForPlacement`**；实现见 **`scene-assets/video-texture.ts`**（**`awaitPlacedVideoFirstFrame`**，放置超时 **20s**、settings 恢复 **45s**）。慢通常来自 **远程 MP4 首段缓冲 + `crossOrigin=anonymous` 的 CORS/Range**，非本地解码本身。
  - **取消机制**：切换模块（`onExit`）或 **`assetFacade:exit`** 时中断 mesh 下载并 **`cancelVideoPlacementPreload`**。
  - `placement-cursor.ts` 的 `setPlacementCursorActive(global, active, { loading })` 控制光标样式；**`isPlacementCursorActive()`** 供 **`nav-interaction`** 避免覆盖放置/等待光标。
- **资产类型**：`image`（贴图平面）、`mesh`（GLB 容器）、`gaussian`（.splat/.sog）、**`video`（`HTMLVideoElement` + `Texture.setSource` 平面，可选 `transform.horizontalCurvature` 横向曲度）**、**`audio`（`HTMLAudioElement` + 场景 speaker icon）**；**`image` / `video`** 为 **unlit 贴图/emissive**，**`receiveShadows: false`**（阴影见 §5.4：**mesh** A 管线；**image/video** B 由 **`ShadowReceiverOccluder`**；**gaussian** B exclude + 深度门控）。**内置右侧面板**中 **video / audio 仅通过 URL 加入资产库**（无本地上传），与 **image / mesh / gaussian** 的本地上传分流。
- **音视频热区（仅 Viewer 或 编辑+预览模式）**：全局 **`settings.sceneMediaHotspot`**（嵌套 **`video.{hotspotAutoplayEnabled, coneHalfDeg}` / `audio.{hotspotAutoplayEnabled}`**）；每路 **`settings.sceneAssets[].triggerDistanceM`**。播控：**`evaluateMediaHotspotAnchor`** / **`evaluateAudioHotspotAnchor`**；多视频按距离最近一路有声。消费态视频须在热区内才可点播控；音频无 callout UI、仅热区自动播。
  - **协议（父级托管）**：**`MEDIA_HOTSPOT_SET`** 嵌套 patch（video/audio）；**`ASSET_MEDIA_HOTSPOT_SET_BASELINE`** `{ id, target }`；baseline 出站 **`SCENE_ASSET_MEDIA_TRIGGER_DISTANCE_CHANGED`**。
  - **内置面板**：**`editUiTransport=message-bridge`** 时热区滑条/设基准走 **`sendEditProtocolMessage`**（与 **`environment-ui`** 等一致）；**`internal`** 直写 settings 并 **`sceneMediaHotspot:changed`**。
- **Mesh（GLB）弱主光可读性**：`asset-placement-handler.ts` 新增 `configurePlacedMeshMaterials`，智能检测高反光 PBR 特征（metalness>0.3、shininess>60、clearCoat、各类贴图），对这类材质：
  - 强制开启 `highPrecisionRendering`（viewer.ts）确保 HDR 值正确渲染
  - 突破 1.0 限制设置 `ambient=[1.2,1.2,1.2]`、`diffuse=[1.1,1.1,1.1]`（利用浮点格式）
  - 极高 metalness（>0.8）时降至 0.6-0.7 保留漫反射
  - 添加微弱自发光补偿（`emissive=0.05, intensity=0.6`）
  - 关闭 `useSkybox` 避免不同场景 skybox 差异影响
  - 与「保留原 `applySkyboxTexture`、不以改天空盒链路为代价提亮 mesh」的产品取向一致；具体数值见 `PBR_DETECT_THRESHOLDS`、`PBR_BOOST_FACTORS` 常量。
- **操作**：选中、复制、删除、Gizmo 变换（move/rotate/scale）；**Gizmo 仅在「有选中 entity 且用户点击了底部移动/旋转/缩放」时显示**，默认不显示。**Gizmo 与相机/拾取**：命中 Gizmo 时 `cameraControlsEnabled=false`；capture 阶段预判命中以早于资产拾取；资产 `pointerdown` 与通用 `scenePointerWorldClick`（`pointerup` 路径）在相机被 Gizmo 占用时短路。**坐标空间**：切换 Gizmo 类型时 `scale` 用 `local`，`move`/`rotate` 用 `world`。**等比缩放**：资产 `scale` 模式 + **Shift** 拖拽为整体等比缩放。
- **资产与标注显隐统一控制（View 模式）**：`ASSETS_SHOW_HIDE_SET` 同时控制场景资产与标注显隐（通过事件 `assets:allVisibilityChanged` 驱动）；`ViewSettings.annotationsVisible` 存储 View 模式下标注显隐状态（不入库）；`deferred-editing-visual-sync.ts` 统一控制 reveal 期间资产与标注的显隐——reveal 期间强制隐藏，解锁时按 `viewSettings.annotationsVisible ?? true` 恢复（默认可见）。
- **聚焦**：场景点击/协议 `ASSET_SELECT` 对资产聚焦统一走 `inputEvent('frame', { focusTarget:'asset' })`，由 `camera-manager.ts` 按 **world-space bbox framing** 计算距离；同一资产重复选中不触发二次 focus（scene 命中与 host 回环两侧均短路）。
- **持久化**：`settings.sceneAssets`，支持从配置还原。**View→Edit**：**`requestSceneAssetsRestore({ reason: 'edit-enter' })`** 默认 **`syncScenePlacedEntitiesFromSettings`**（复用 entity，按 settings 写回 transform/visible/曲度；**不**全量 destroy+reload）；**discard / history-restore / startup** 仍为 clear+**`restoreSceneAssetsFromSettings`**。**保存**：**`serializeExperienceSettings`** → **`buildSceneAssetsForPersistence`**（运行态 + **settings 中未恢复进场景的 preserved**）；**删除**资产须同步 **`removeSceneAssetFromSettings`**，避免 preserved merge 复活已删条目。
- **放置资产相机碰撞（AABB）**：**`settings.sceneAssetCollision`**（`enabled` + `scale`）；会话 **`state.sceneAssetCollisionRuntimeState`**（含 **`debugVisual` 不入库**）。对所有可见 **mesh/gaussian** 构建世界 AABB，**Fly/Orbit** 经 **`sceneAssetCollisionResolver`** 推开；**Viewer 或编辑预览** 下生效。**`autoFit` 与手动 XYZ 互斥**（默认 **autoFit=false**，mesh **X=57%**）。调试绿线框见 **`scene-asset-collision-debug.ts`**。详 **`docs/放置资产相机碰撞实现说明.md`**。
- **编辑历史**：放置/复制/删除/变换均记录快照，可撤销
- **上报**：仅当来源为场景拾取（`source='scene'`）时上报 **`SCENE_ASSET_SELECTED`**，载荷 **`{ module:'asset', id, assetType? }`**（**`assetType`**：`image` / `mesh` / `gaussian` / **`video`** / **`audio`**，来自 **`getSelectedSceneAssetType`**）；父级/UI 触发选中（`source='host'`）不回传，避免 circular。Gizmo 结束时上报 `SCENE_ASSET_TRANSFORMED { id, transform }`
- **变形关键帧拾取（2026-06-04）**：**`MORPH_ASSET_ADD_START/FINISH`**（**`AssetFacade`**）开启 **`morphAssetAddActive`**；须在 **`editLeftModule==='asset'`** 下拾取，**仅 `gaussian`** → **`SCENE_ASSET_SELECTED`**（**`module:'asset'`**）；与 **`ASSET_PLACE`** 共享 placement 光标；**不** 与 **`assetEffects`** 模块绑定。详文首 **2026-06-04 补充**。
- **Viewer / 编辑预览拾取**（2026-06-02）：**`isAssetScenePickEventOnlyMode`** 下场景单击同样上报 **`SCENE_ASSET_SELECTED`**，但**仅** **`mesh` / `gaussian`**，且**不**发 **`inputEvent('frame')`**、不显示 Gizmo（见文首 **2026-06-02 补充**）。
- **模块进入/离开**：**进入 asset 模块**默认不选中任何 entity（保持 `selectedSceneEntityId=null`）；**离开 asset** 时清空选中并 detach 资产 Gizmo

---

### 5.2 场景标注 (Scene Annotation)

**入口**：`annotation` 模块 → `rightPanelAnnotation`  
**核心**：`annotation-manager.ts`、`placement-mode.ts`、`annotation-entity.ts`、`annotation-ui.ts`、`annotation-gizmo-handler.ts`

- **创建（先填表单再放置）**：父级/内部先填表单 → 点击「去放置」下发 `ANNOTATION_PLACEMENT_START { id }` → Viewer 进入放置模式、**光标改为十字拾取** → 场景点击生成/更新占位标注 → 父级/内部「确认放置」发 `ANNOTATION_CONFIRM` 固化。占位阶段可多次点击换位置；Picker 多次返回 null 时退化为「相机前方一段距离放置」
- **热点布局**：收起时**标题在热点上方**（非右侧）；点击热点 = 收起↔展开切换；悬停展开、离开收起
- **编辑**：**先点击某标注热点、再点击底部「移动」** 才显示该标注的 Transform Gizmo；底部「编辑」显示表单，提交走 `ANNOTATION_CONFIRM`
- **删除**：底部栏「删除」→ `ANNOTATION_DELETE { id }`，支持历史
- **底部栏**：`annotation` 模块显示「移动」「编辑」「删除」；`ANNOTATION_TRANSFORM_MODE { value: 'move' | null }` 控制标注 Gizmo 显隐；内部用 `state.annotationTransformMode` 记录当前模式，**在切换选中标注时保持移动模式并把 Gizmo 迁移到新标注上**（避免“点新标注后移动被取消”）。
- **进入模块**：**不**默认选中、**不**默认展开已有标注；离开模块时清除标注 Gizmo 与选中
- **协议约定**：`ANNOTATION_PLACEMENT_UPDATE` 文档保留但当前实现**不再主动触发**（放置与 Gizmo 移动仅内部更新，不推送给父级）
- **持久化**：`settings.annotations`，与 EditHistory 快照同步
- **切换模块自动取消**：切换到非 `annotation` 时取消放置/编辑并恢复
- **选中来源约束**：`SCENE_ANNOTATION_SELECTED` 仅由场景热点选中（`source='scene'`）触发；父级/UI 选中（`source='host'`）不回传
- **导出与门控**：`Annotation` 在 `app.prerender` 上 `_update`；若仅关 `entity.enabled` 而不在 `_update` 里同步隐藏 DOM，则 `AnnotationManager.setAllAnnotationsVisible(false)` 无法收起热点。实现上在 `_update` 开头 **`!entity.enabled` 时 `_hideElements()` 并 return**（`_hideElements` 对 `hotspotDom` 判空）。
- **媒体（图片 / 视频）**：
  - **字段**：`imageUrl?` 与 `videoUrl?` **互斥**（**`src/annotation-toolbar/media-fields.ts`** 的 **`normalizeAnnotationMediaFields`**；导入 / facade / 表单写库前统一归一；双字段同存时 **保留 `videoUrl`**）。
  - **来源**：视频**仅 URL**（父级 **`ANNOTATION_CONFIRM` / `ANNOTATION_UPDATE`** 或 **`settings.annotations[]`**）；Viewer **不做** 视频文件上传 / OSS（父级托管表单为真源；internal 右栏仅 **URL 输入** 便于本地调试）。
  - **展示**：**`Annotation.syncTooltipMedia(imageUrl?, videoUrl?)`** 驱动 tooltip 内 **`imageDom` 或 `videoThumbDom`**（二选一）；缩略用 **`videoThumbPosterEl`**（**`preload=metadata` + `muted`**，tooltip 内不播声）；点击缩略打开 **`videoPreviewOverlay`** 内 **`<video controls playsinline>`**，**`muted=false`**（用户点击后 **`play()`**，保留音轨）；点击遮罩空白 **`Annotation.closeMediaPreviews()`**（**`pause()` + 清 `src`**）。**`_hideElements`** / 标注不可见时亦关闭遮罩，避免后台续播。
  - **协议出站**：**`SCENE_ANNOTATION_EDIT_START`** 的 **`value`** 含 **`title` / `text` / `imageUrl?` / `videoUrl?` / `showTitleWhenCollapsed`**（见 **`docs/SaaS第三期 编辑模式交互职责划分.md`**）。

---

### 5.3 光照系统 (Lighting)

**入口**：`environment` → Lighting 子面板  
**核心**：`light.ts`、`lighting-ui.ts`、`night-mode.ts`、`gizmo-handler.ts`

- **主方向光**：`settings.lighting.lights` 中 `type: 'directional'`，控制 pitch/yaw/intensity，阴影由 `postEffectSettings.shadow.enabled` 统一开关
- **点光源 / 聚光灯**：
  - 最多 10 个，位置/颜色/强度可调；**点光源 `range`**（settings + `LIGHT_RANGE_SET`，**0–20**；**`directional` 上忽略**）与引擎 `Light.range` 及线框球 `localScale` 一致，默认 **10**。Lighting 面板与 Bloom 区域绑定灯 UI 均可调 Range（点光/聚光均通过 `LIGHT_BRUSH_RANGE_SET` 协议，由 `applyBloomLocalLightRegionRangeSet` 统一处理）
  - 支持场景内可视化（Show lights in scene）
  - `state.selectedLightId` 作为光源选中真源；`state.lightTransformMode: 'move' | 'rotate' | null` 控制环境模块下的光源 Transform Gizmo
  - `gizmo-handler.ts` 同时支持资产与光源两种模式：根据 `editLeftModule` 选择 `selectedSceneEntityId + assetTransformMode` 或 `selectedLightId + lightTransformMode`
  - Gizmo `pointer:up` 时，将光源 `position/pitch/yaw` 回写 `settings.lighting.lights[*]` 并 `updatePointLightsFromSettings` + `pushEditHistory('transform light')`
- **夜间模式**：`nightMode.fade` 滑块（-1～1），与 Bloom Brush 局部亮度合成
- **NightMode → gsplat 点光/聚光（`night-mode.ts`）**：写入 `gsplatModifyVS` 的局部光颜色在 **TS** 侧已转为 **线性 RGB**（`localLightLinearRgb`：sRGB `pow(x,2.2)` 后乘 `intensity × lightingIntensity`），**shader 内不对 `uSphereColors` / `uSpotColors` 再做 `g2l`**，与方向光 `uLightColor` 一致。距离衰减为 **`1.15/(1+d²)`**（非物理 `1/r²`），减轻近距过曝。着色器内对局部光累加 **`sum` clamp**、对 **`linearColor * mult` 在 `l2g` 前 clamp**，**`g2l`/`l2g` 底数 `max(c,1e-6)`**，**`viewDir` 零长回退**避免 `normalize(0)`，**`uNightFade≈0` 用小 epsilon** 判断。TS 侧 **`LOCAL_LIGHT_LINEAR_PEAK_CAP`**（默认 16）对单灯线性色按**峰值等比封顶、保色相**，防止极大 intensity 单灯把 GPU 侧累加顶死。实现需在 **GLSL 主 / GLSL BloomBrush / WGSL 主 / WGSL BloomBrush** 四套 chunk 中保持语义一致。
- **光源删除语义（`light.ts`）**：在清理多余点光/聚光及其容器时，必须使用 **`destroy()`** 而非 `removeChild()`；前者会销毁 `LightComponent` 与底层 `pc.Light`，后者仅脱离层级，可能留下对 mesh 的照明影响残留。
- **不保存退出与撤销时的亮度恢复**：`applySettingsSnapshot` 回写 `settings` 后，`edit-history.restoreLightingFromSettings` 根据 **`settings.nightMode.fade`** 触发 `app.fire('nightMode:forceReapply', fade)`。`nightMode:forceReapply` 必须**先 `removeShaders()`**（从已跟踪材质上删除 `gsplatModifyVS`），不能只清空 `materialsApplied` Set；否则 discard 后材质仍带旧 night shader，画面亮度看似未复位。`|fade|≈0` 时可不再 `applyShaders()`，但须 **`updateEffect`** 以收回主光强度与天空盒强度。
- **数据收集**：`collectPointLights` / `collectSpotLights` 供 gsplat shader 使用
- **协议联动**：`LIGHT_SELECT` / `SCENE_LIGHT_SELECTED` 通过 `message-bridge.ts`（`dispatchEnvironment`）与 `editor-modules/protocol-adapters/environment-protocol-adapter.ts` 映射到 `state.selectedLightId` 与 `sceneLight:selected`，为父级托管模式下的光源编辑提供同步；**`LIGHT_SELECT` 不触发** `inputEvent` **相机 frame 聚焦**（与资产选中推相机区分）
- **选中来源约束**：`SCENE_LIGHT_SELECTED` 仅由场景 picker 选中（`source='scene'`）触发；父级/UI 选中（`source='host'`）不回传
- **场景 ambient 与 mesh**：入口 `index.ts` 对 **`app.scene.ambientLight`** 设全局基线，用于在关/弱平行光时抬高 mesh 底色；**不**以此替换原有 `skybox-loader.ts` **`applySkyboxTexture`**（纹理缓存 → `scene.envAtlas`）行为。

---

### 5.4 阴影系统 (Shadow)

**入口**：`environment` → PostEffect → Shadow 子面板  
**核心**：`vfx/shadow/shadow-system.ts`、`shadow-catcher.ts`、`shadow-apply.ts`、`shadow-apply-exclude-mask.ts`、`gsplat-exclude-mask-shader.ts`  
**说明文档**：`docs/阴影双管线与放置资产说明.md`、`src/vfx/shadow/SHADOW_DEMO_对比与配置.md`

**门控**：`hasShadowSceneMesh`（**`settings.collision.url`** / `?collision=` 或可 **`voxel-collision` 生成**）+ `postEffectSettings.shadow.enabled` + `isShadowOutputEnabled`（`readyToRender` 且 reveal 后 `activateOutput`）。父级 **`SHADOW_SYSTEM_READY`** 仅在 **`isShadowOutputEnabled`** 时出站（**`message-bridge.ts`**）。

**双管线**：

| 资产 | cast | 接收阴影 |
|------|------|----------|
| 主场景高斯 | **恒 false** | **B**（全屏 `shadowTex` 叠影） |
| 放置高斯 | 随 `enabled` | **B**；**G mask** + **exclude/shadow 深度门控** 跳过自身可见像素叠影 |
| 放置 mesh | 随 `enabled` | **A**（`receiveShadows`）；**ShadowReceiverOccluder** 裁切 B |
| image / video | false | 无 A；**ShadowReceiverOccluder** 裁切 B |

- **接影面**：`shadow-catcher`；GLB 型 `?collision=` 作接影几何（ShadowMask 层，仅 shadow 相机渲染）。
- **ShadowApplyRt**：`shadowMaskCamera`（priority -1，`ShadowReceiverOccluder` → `ShadowMask`）写 `shadowTex` + 可采样深度；`postrender` 叠到主画面：`blend = (1-R)*darken*(1-gsplatMask_eff)`，`gsplatMask_eff` 来自 exclude RT **G** 且 **`excludeDepth <= shadowMaskDepth + bias`**（**勿用 alpha** 作 mask）。
- **PlacedMeshExclude**：仅 **gaussian**；`syncPlacedMeshExcludeLayers` 为 gaussian 加层并从 render 资产剥离；exclude 相机 priority 1；**`gsplat-exclude-mask-shader`** patch 仅 exclude 相机材质。
- **配置**：`postEffectSettings.shadow`（`enabled`、`darken`、`debugExcludeMask`、`debugVisual`、`lightYaw` 等）。
- **unified / 加载**：同 World 层；**不用 `PlacedGsplat` 分层**；**`suspendShadowPipelineForGsplatLoad`**。深度门控不含未进 occluder 的**场景原生 mesh**（已知边界）。详 **`docs/工作记录.md`（2026-06-01）**。
- **调试 / UI**：Enable、Darken、`debugExcludeMask`、Light Yaw、Spawn Test Sphere/Splat；协议 `SHADOW_SET` / `SHADOW_INTENSITY_UPDATE` / `SHADOW_DIRECTION_SET`（`environment-protocol-adapter`）；出站 **`SHADOW_SYSTEM_READY`** 见上 **2026-06-01 补充**。

---

### 5.5 后处理 Bloom 与局部亮灯区域

**入口**：`environment` → PostEffect → Bloom 子面板  
**核心**：`vfx/bloom.ts`、`bloom-brush-filter.ts`、`world-space-bloom-data.ts`、`committed-brightness-volume.ts`、`post-effect-ui.ts`（LocalLightRegion 列表与绘制流程）

- **配置分层**：`postEffectSettings.bloom` 为**可持久化** Bloom 参数（强度、模糊、threshold、`localLightRegions` 等）。**编辑器/会话态**集中在 `postEffectSettings.bloomEditorSession`（`bloomBrush`、`activeLocalLightRegionId`、`draftLightRegionCenter`）；`settings-serialize/settings-serialize.ts` 存盘时删除整段 `bloomEditorSession`，并对 `bloom` 上可能残留的扁平会话字段做防御性剥离。运行时统一通过 `settings-serialize/settings-serialize-helper.ts` 的 `ensureBloomEditorSession` 访问；导入时 `settings.ts` 可将旧 JSON 中的扁平字段 hoist 到 `bloomEditorSession`。
- **Reveal 期间 Bloom 门控（无额外 `state` 字段）**：`BloomController` 内部私有 `_bloomStackUnlocked` 与开场 reveal 共用节奏：`hasRevealEffect` 为 true 或 `revealRestart` 时关闭；每次 `revealComplete` 打开。关闭期间 compose **bloom intensity 强制为 0**、NightMode **局部亮灯体积/tint 清空**、2D world-space mask **涂黑**；无 reveal 时保持全程开启。
- **模式**：仅 World Space（Screen Space 已移除）
- **全局 Bloom**：intensity、**blurLevel 范围 0–10，0 表示关闭 Bloom**（协议 `BLOOM_BLUR_SET`）、threshold、bloomDebug。  
  现行为中，`BLOOM_INTENSITY_UPDATE` 直接写入真实 `bloom.intensity`（不做旧版 0–16→0–0.2 映射；仅对 `NaN/Infinity` 做有限值兜底）。
- **产品默认（与 `ensureBloom` / migrate 模板一致）**：**默认 intensity `0`（即默认关闭 Bloom）**、**默认 blurLevel `10`**、**默认 threshold `0`**、**默认 `bloomScope='global'`**、默认 `bloomBrushBrightness=1`。`bloom.ts` 应用 CameraFrame 时 `blurLevel` 回退为 `10`。**注意**：存盘 **`bloom.localLightsEnabled` 已废弃**（导入时从 `bloom` 删除）；**观看态整灯闸**读 **`global.viewSettings?.bloom?.localLightsEnabled`**（**不入库**，`viewer.ts` 默认 **`true`**，`LIGHT_TOGGLE_ALL` 写入）。
- **导入与 UI 同步**：`importSettings` 在规范化 `localLightRegions` 之后调用 **`ensureBloom(result)`**，使加载场景后 settings 与面板读数一致；`post-effect-ui.ts` 内嵌 HTML 的 Bloom 默认值与模板保持一致（Intensity `0.00`、Blur `10`、Threshold `0.00`）。
- **旧存盘运行时迁移**（`ensureBloom`，不改磁盘 JSON）：保留历史 `intensity===1` 的兼容归一逻辑（会写回当前默认 `DEFAULT_BLOOM.intensity`），并按条件处理历史配套占位字段；显式配置值优先，不对磁盘 JSON 回写。
- **局部亮度 (localBrightness) 导入规则**：`ensureBloomLocalLightRegions` 仅在 **`localBrightness` 非 number** 时补齐（优先 `worldSpace.committedBrightness`，否则 **`1`**）。**JSON 中显式 `0` 保留为 `0`**，不因默认策略被改写。列表渲染使用 `region.localBrightness ?? 1`，故 **`undefined`/`null` 显示为 1，`0` 仍显示 0**。
- **Reveal 相关约束**：勿将 **`WorldSpaceBloomData` 默认 `committedBrightness`** 改为非零以追求「区域默认更亮」——冷启动在 committed 为空时仍会走 `syncCommittedToNightMode()`，若乘数非零易与 **radial reveal** 阶段 NightMode/shader 状态冲突；区域默认亮度应通过 **settings / `loadRegion` / 新建区域** 路径表达，而非提高工作区空状态的 committed 亮度默认值。
- **局部亮灯区域 (LocalLightRegion)**：
  - **数据结构**：`BloomSettings.localLightRegions[]`，每区域含 `id`、`name`、`worldSpace`、`localBrightness`、可选 tint、`linkedLightId` 等；**当前选中区域 ID、笔刷开关、`draftLightRegionCenter`** 在 **`bloomEditorSession`**（不入库）
  - **UI**：新建亮灯区域 + 区域列表；每区域可展开/折叠，独立 **局部亮度 + 可选 Bloom 强度** 双通道 slider；绘制流程：新建 → 笔刷/擦除/放弃 → 完成/放弃
  - **LIGHT_BRUSH_*** 仅作用于当前 **active** LocalLightRegion；`LIGHT_BRUSH_START`/`LIGHT_BRUSH_FINISH` 为起止，无 toggle；支持局部擦除（`LIGHT_ERASER_START`）。**`LIGHT_BRUSH_FINISH`**：payload **`skipAutoLinkedLight`** **缺省或 `true` → 仅落正式区域、不在 FINISH 内自动建灯**；**仅 `skipAutoLinkedLight: false` → 单步自动建灯并绑定**。FINISH 会写 **`draftLightRegionCenter`**（质心→中心→原 draft）；后续由 **`LIGHT_ADD { id, isThreeSixty }`** 进入放置态，场景单击一次后通过 **`applyLightAdd(..., positionOverride)`** 完成建灯并对 **`activeLocalLightRegionId`** 下**尚无 `linkedLightId`** 的区域绑定（父级无需额外关联字段）。
  - **首个草稿防误清空（`bloom.ts`）**：当 `regions.length===0` 时，渲染链路需**先判断 draft-only**（`activeLocalLightRegionId` 为 `draft-*` 或 `worldSpaceData` 仍有 working points），命中后优先按草稿点构建 3D volume；仅在非 draft-only 时才允许走 `_lastMultiRegionHash` 的清空分支。用于规避 `LIGHT_ERASER_START` 切换瞬间的一帧状态抖动导致的偶发清空。
  - **多区域叠加渲染**：所有 `localLightRegions` 同时参与 NightMode 体积/亮度合成；体积在烘焙阶段合并为单纹理（各区域 committed 点合并，按 localBrightness 加权），无多张纹理开销
  - **与灯光开关联动**：**`LIGHT_TOGGLE_ALL`** 写 **`global.viewSettings.bloom.localLightsEnabled`**（及用户灯 `enabled` 等）；**观看态** `bloom.ts` 的 **`applyViewerLocalLightPolicy`** 在该闸为 **false** 时整段清空局部亮灯合成；**编辑态不读此闸**。**`LIGHT_TOGGLE`** 单灯关时仅该灯绑定区域从体积与 mask 中过滤；BloomController 用 **`isLocalLightRegionVisible(region)`**（按 `linkedLightId` 查 `lighting.lights[*].enabled`），体积 hash 含 `|vis=...` 以在单灯切换时触发重建。**Lighting 面板新建点光/聚光**与 **`applyLightAdd`**：仅当激活区域 **`linkedLightId` 仍为空** 时才写入新灯 id，避免「已有绑灯后再加灯」被改绑。
  - **持久化**：`worldSpace` 只保存 committed，不强制持久化 points 草稿；`worldSpacePoints` 旧字段已下线，不再自动迁移
- **与 Night Mode 合成**：多区域时 `buildCommittedBrightnessVolumeFromRegions` 合并各区域后写入同一体积纹理；points 为空时销毁旧纹理避免残留

---

### 5.6 VFX 特效系统

**入口**：`effects` → VFX 子面板  
**核心**：`reveal.ts`、`vfx/reveal/*`、`vfx/gsplat-*.ts`、`reveal-ui.ts`

- **初始化顺序**：`viewer.ts` 须在创建 **`RevealController` 之前** 完成 **`NightMode`** 的 `create` 与 `splat/camera` 赋值。`RevealController` 构造函数内会立即 `createEffect` 并 `app.fire('nightMode:exit')`；若 NightMode 尚未注册监听，首次 `exit` 丢失会导致 NightMode 与 VFX 对 `gsplatModifyVS` 互斥失败（表现为首帧特效不播、切换类型后反而正常）。
- **Reveal 中心与首帧相机**：创建 `RevealController` **之前**调用 **`applyCamera`**，使 reveal 中心与当前相机一致（与导出门控独立，同属 reveal 体验链路）。
- **大场景半径**：**radial / sketch / growth-wave** 经 **`syncRevealParticipation`**（内部 **`applyAdaptiveEndRadius`** + **`maxEndRadius` cap** + 可选 **`syncSpeedToTotalDuration`**）；**rain / pieces-recover** 仍仅 **`applyAdaptiveEndRadius`** + 协议 **`effectParams.endRadius`**。**smooth** 用 **`GsplatRevealSmooth.maxRadius`**（白名单键 **`maxRadius`**）。
- **导出用「内容可显」时刻**：`RevealController.getPostRevealContentThresholdSec()` **优先**各脚本的 **`getCompletionTime()`**（与 `isEffectComplete` 对齐），再回退 Timed / perlin 的 `totalDuration` 等。
- **Timed VFX 完成事件**：继承 `GsplatShaderEffect` 的 sketch / rain-v2 / pieces-recover / integrate / growth-wave 在判定播放结束时须调用 **`notifyRevealComplete()`**，以触发 `RevealController` 注入的 `onRevealComplete` → `events.fire('revealComplete')`；否则 animTrack、标注/资产延后初始化、Bloom 门控等依赖 `revealComplete` 的逻辑不会在首播结束时执行。
- **Persistent VFX（不触发 complete）**：**`perlin-wave`** 等为持续动画，**不**应伪造 `revealComplete`。门控集中在 **`src/reveal-policy.ts`**：**`PERSISTENT_VFX`**、`isPersistentVfx`、`revealBlocksAnim`（非 persistent 且 `hasRevealEffect` 时暂停路径动画直至 `revealComplete`）、`nightDeferredByReveal`（有 reveal 时与 night 首帧节奏配合）。**`viewer.ts`** 使用上述函数，避免在多处硬编码 `perlin-wave` 字符串组合判断。
- **Unified 下材质查找**：`gsplat-shader-effect.ts` 的 `updateUnifiedMaterials` 在指定相机 Entity 时，须向 `getGSplatMaterial` 传入 **`Camera` 渲染实例**（`entity.camera.camera`），不可传入 `CameraComponent`（与 `night-mode.ts` 注释一致）。
- **Reveal 类**：radial、rain、smooth（无时间轴）
- **Timed VFX**：rain-v2、pieces-recover、integrate、growth-wave、sketch（有 totalDuration + 时间轴）
- **effectParams 白名单**：**`src/vfx/effects-runtime/reveal/reveal-effect-params.ts`** 的 **`BY_TYPE`**；仅列出的键会写入脚本。宿主/存盘示例：
  - **radial / sketch / growth-wave**：`maxEndRadius`（及各类 tint、时长相关键，见文件内注释）
  - **rain-v2**：`riseTint`（`[r,g,b]`）、`riseTintIntensity`、`rainSize`、`hitTint`、`hitDuration`、`intensity`、`bottomY`、`rainHeight`、`maxDist2D`、`timeScale` 等
  - **integrate**：`waveAmplitude`、`waveSpeed`、`waveFrequency`、`aabbMin`/`aabbMax`、`aabbXZMin`/`aabbXZMax`、`verticalSpread` 等
  - **rain / pieces-recover**：`endRadius`（非 maxEndRadius）
- **growth-wave 点云尺度**：`growth-wave` 点云阶段的 `uPointSize` 固定为脚本 `pointSize`，不再基于 bbox/高度动态缩放；确保不同场景初始点云观感尽量一致。
- **sketch 传播对齐**：`sketch` 在 `useCameraDistance` 模式下，传播距离使用 **xz 平面到 Reveal 焦点 `uCenter`** 的度量（不再使用相机 eye 欧氏距离），以对齐 `rain-v2` 的“由视线中心向外推进”语义。
- **integrate 波前柔化**：`integrate` 的竖向 `wavePhase -> tt` 过渡通过调整 `INTEGRATE_WAVE_PHASE_END` + 尾端收尾（`waveFactor`/xz settle），减弱“模糊波前”和“清晰高斯”之间的硬分界观感。
- **integrate xz 裁剪**：shader 内 `insideAABB`；区域外 splat 不参与 integrate（不改色、不缩放）。外部用 **`aabbMin`/`aabbMax`** 或仅水平 **`aabbXZMin`/`aabbXZMax`** 覆盖 create 时来自 bbox 的默认盒。
- **Continuous**：perlin-wave（持续动画）
- **时间轴**：effectTimeline 滑块、Play/Pause、Restart Effect、Restart AnimTrack
- **导出联动**：`includeVfx` 控制导出时是否驱动 VFX；`syncAnimTrack` 控制相机 animTrack 与 VFX 同步
- **协议事件（SaaS）**：`VFX_TYPE_SET { value }`、`VFX_RESTART { restartAnim? }`、`VFX_EXIT`。其中 `VFX_EXIT` 当前语义为「强制停播但保留配置」（不改 `settings.revealEffect.type`），通过 `events.fire('vfxExit')` 进入 RevealController 的停播/恢复逻辑。
- **NightMode 互斥**：VFX 与 NightMode/局部亮灯区域同占用 `gsplatModifyVS`，VFX 开始时会 `app.fire('nightMode:exit')` 触发 NightMode 挂起（见 9. Recent Changes）。**点彩 NPR**（`pointillism-stipple`）为 persistent 材质直连路径，与 NightMode **硬互斥**，见 **§5.9**。

---

### 5.7 视频导出系统

**入口**：`effects` → Render 子面板  
**核心**：`render/video-export.ts`、`render/export-timeline-resolver.ts`、`render/deferred-editing-visual-sync.ts`、`loaders/asset-loader.ts`、`video-export-ui.ts`

- **Timed VFX 导出时的编辑叠加层门控**：`VfxExportPostRevealSync`（`deferred-editing-visual-sync.ts`）在导出循环内按 **`frameTime`** 与 **`getPostRevealContentThresholdSec()`** 控制默认层显隐：放置资产根节点、`setAllAnnotationsVisible`、点光/聚光容器等。**仅当** `includeVfx` 且 `state.hasRevealEffect` 且 **`RevealController.isTimedEffect()`** 时启用；非 Timed（radial / rain / smooth 等）导出**不**做时间门控。越过阈值时 **`events.fire('revealComplete')` 一次**，与 **`BloomController._bloomStackUnlocked`** 对齐；`finalizeAfterExport` 在 abort / 短导出时补发。默认层表可通过 **`extendDeferredEditingLayers`** 扩展。Reveal 时间源通过 **`initVideoExport(global, { getRevealExportTimingSource })`** 注入，**不得**依赖 Global 上的旧 reveal 回调字段。
- **`exportVideo` 启动顺序**：先置 **`isExportingVfxVideo = true`**，再 **`revealRestart`**，再 **`syncExportFrame(..., 0, { includeVfx: includeVfxTimeline })`**（与快速导出 **`fixVfxAtEnd`** 的 include 语义一致），避免门锁建立前闪一帧已 reveal 完成的叠加层。
- **导出总时长与资产就绪**：**`resolveExportTimelinePlan`**（`export-timeline-resolver.ts`）单点决策 **`totalDuration`** 与 **`animSeekAt`**；导出前 **`getAssetLoader(global).waitAllReady()`**，将 **`allAssetsReadyAt = waitMs/1000`** 传入 resolver。有 anim 且 **`syncAnimTrack`** 时：除「VFX 用 anim loop 铺满」外，还要求在 **`max(vfxDuration, allAssetsReadyAt)`** 之后再播至少 **1** 整圈 anim（可配 **`extraAnimLoopsAfterAssetsReady`**）；无 anim 时在锚点后加默认可配尾长（**`noAnimTrackExtraDuration`，默认 2s**）。调试可搜控制台 **`[ExportTimeline]`**。
- **离线导出**：离屏 RenderTarget + 双 RT 交替 + 异步 readback + VideoEncoder，支持 MP4/WebM/MOV/MKV，H264/H265/VP9/AV1
- **快速导出**：
  - `format=webm`：`canvas.captureStream` + MediaRecorder，约实时，输出 WebM（mimeType 优先 vp9，其次 avc1，再次 webm）
  - `format=mp4`：主线程逐帧渲染 + `createImageBitmap` 投递 Worker（WebCodecs 编码）+ MP4 封装；通过背压控制 `framesSent - encodedChunkCount`，将编码结算前移到渲染阶段，降低尾部 flush 波动
- **内部 UI 保存对话框**：极速导出若走 **`showSaveFilePicker`**，类型须与 **`format`** 一致（当前 **`format:'mp4'`** 时使用 MP4 的 accept / 建议扩展名）；此前误配 WebM 会导致扩展名与实际编码不匹配。
- **VFX 驱动**：每帧 `effectTimeline:setForExport` + 手动 `script.update`（`isExportingVfxVideo` 时引擎不跑脚本）
- **VFX 驱动补充**：`includeVfx=false` 时走 `skipVfx` 路径，跳过 timeline/script update，仅保留 animTrack 驱动与渲染
- **相机同步**：`syncAnimTrack` 时每帧 seek anim 并应用相机
- **配置**：导出时长、分辨率预设、includeVfx、单帧测试
- **特效时间策略**：`perlin-wave` 在导出路径不再受 `revealEffect.totalDuration` 限制，按整段视频时长推进；其他特效保持 clamp 到 totalDuration
- **父级托管协议**：
  - `VIDEO_EXPORT_START { includeVfx? }`：默认 **快速导出 MP4**（`useFastExport: true`、`format: 'mp4'`）；导出前 **`waitAllReady`**，**`totalDuration` 由 `resolveExportTimelinePlan` 与内部导出一致**；**先弹 filePicker 选择保存地址**（无 API 时回退内存编码 + 下载），再 **`render.video`**
  - `VIDEO_EXPORT_CANCEL`：取消当前导出
  - 出站：`VIDEO_EXPORT_STARTED`（开始）、`VIDEO_EXPORT_CANCELLED`（中断/取消）、`VIDEO_EXPORT_END`（正常结束）

---

### 5.8 相机设置 (Camera Settings)

**入口**：`camera` 模块 → 右侧面板  
**核心**：`ui/components/camera-settings-ui.ts`、`collision/camera-collision-manager.ts`、`collision/scene-collision-source.ts`、`scene-assets/collision/scene-asset-collision.ts`

- **场景碰撞 mesh（URL / Universe）**：**`settings.collision.url`** + **`settings.collision.enabled`**（物理 Walk/Fly + 接影 GLB 同源）；URL 参数 **`?collision=` / `?voxel=`** 优先于 settings。无 URL 时 **`ensureCollisionUrl`** → **`POST /conversion/voxel-collision/jobs`** + 轮询（**`modelUrl` = `contentUrl`**，成功写 **`data.url`**）。生成中出站 **`SCENE_MESH_LOAD_PROGRESS`**；加载 **`SCENE_MESH_LOAD_*`**、就绪 **`COLLISION_SYSTEM_READY`**（§5.1 / **2026-06-01 补充**）。UI 开关走 **`applyCollisionSetFromHost`**。
- **放置资产碰撞**：开关 **`settings.collision.enabled`**（runtime **`sceneAssetCollisionRuntimeState.enabled`**）；**Fly/Orbit** AABB 推开（半径 **0.3m**）；**Viewer 或编辑预览** 下实际阻挡，纯编辑仅调参。
- **缩放**：**`autoFit` 与手动 XYZ 互斥**；默认 **autoFit=false**，**mesh X=57%**，高斯与 mesh y/z **85%**；滑条 **50%–150%**。
- **调试线框**：**`debugVisual`** 仅 **`state.sceneAssetCollisionRuntimeState`**，不入 settings。
- **持久化**：**`settings-serialize`** 写入 **`sceneAssetCollision`**；类型见 **`types.ts`** / **`v2-custom.ts`**。详 **`docs/放置资产相机碰撞实现说明.md`**。

---

### 5.9 点彩 NPR（`pointillism-stipple`）

**入口**：`effects` → persistent 轨 **`scene.gsplat-persistent-stylization`** → **`pointillism-stipple`**  
**核心**：`pointillism-stipple-{shaders,persistent,post}.ts`、`persistent-effect-params.ts`、`effect-params-ui-schema.ts`  
**详**：[3DGS点彩NPR渲染内核方案.md](3DGS点彩NPR渲染内核方案.md)

```
modify (点径 + gapFill 覆盖 + bucket 减密 + 色彩振动 + 飞点剔除)
  → gsplatPS (椭圆笔触 + paintGrain)
  → post (飞点抑制 + edge-aware 平整 [+ 当前仍含 fillSparseHoles，待解耦])
```

- **挂载方式**：**`GsplatPersistentPointillismStipple`** 直连 splat 材质 **`gsplatModifyVS`** 与 patch **`gsplatPS`**，**不经** `GsplatEffectComposer`；一次性 reveal 播放中不写 modify（reveal 独占），可保留 gsplatPS patch。
- **NightMode 互斥**：登记于 **`PERSISTENT_GSPLAT_MATERIAL_SHADER_EFFECT_TYPES`**；启用点彩时 **`nightMode:exit`**；关闭或切到纯后处理 stylization 时 **`nightMode:forceReapply`**。reveal 播完且 settings 仍启用点彩时 **不得** `restoreNightModeIfNeeded` 写回 night gsplat。
- **modify 要点**：
  - **`gapSpacing`**：点间缝隙 / overlap（间距驱动 `dotSize ∝ originalSize`，`screenCap` 防 bokeh）。
  - **`gapFill`**：**主路径在 modify**——`coverBoost`、`interiorKeep`、稀疏 splat 更大 overlap 与 bucket 保留率。
  - **`sourceStructureBlend`**：↑ 保留点涂颗粒；↓ 触发 modify 平坦区增覆盖 + post edge-aware 平整。
  - **`contrastDotMix`（色彩振动）**：三层 per-splat——原色微扰 / 对比邻域（H≈+180°±δ + lerp 回原色）/ 强对比（±10°）；**非**旧版 H+180° 硬互补。
  - **`denoiseStrength`**：modify 多规则飞点剔除（弱 alpha 高亮/暗漂浮点等）。
- **gsplatPS**：单 splat 单 daub；椭圆外接域 + 平顶硬边 alpha + **`paintGrain`** 笔触内肌理；禁止 UV 内切网格 hard discard。
- **post 要点**（`postEffectEnabled`，`PointillismPostController`）：
  - **`structureEdgeMask`** + 限幅 **`flatOpticalMix`**（≤0.35）+ **`quantizeInteriorLuma`**；结构边保留原 `sceneColor`。
  - **`suppressSpeckles`**：小邻域 spike 抑制（非补洞）。
  - **边缘锐化**：`edgeFactor` 仅乘 **`structEdge`**。
  - **已知债务**：**`fillSparseHoles(uGapFill)`** 仍用宽域 blur 补洞，调节 gapFill 可能 post 发糊；**目标** gapFill 仅 modify，post 移除该路径。
- **关键参数**（白名单见 **`persistent-effect-params.ts`**）：

| 参数 | 层级 | 作用 |
|------|------|------|
| `gapSpacing` | modify | 点间缝隙 / overlap |
| `gapFill` | modify（主）+ post（当前仍绑 blur，待解耦） | 3D 增覆盖 / bucket 保留 |
| `sourceStructureBlend` | modify + post | ↑ 点涂；↓ edge-aware 平整 |
| `contrastDotMix` | modify | 色彩振动三层 |
| `denoiseStrength` | modify + post | 飞点剔除 / spike 抑制 |
| `dotRadiusPx` / `paintGrain` / `edgeStrength` 等 | modify / gsplatPS / post | 点径、笔触、锐化 |

- **测试 preset**：**`public/assets/settings/settings-huangye-point.json`**（`?settings=.../settings-huangye-point.json`）。

---

## 6. 重要约束

- **标注**：`annotation.activate` 时 camera-manager 需兼容 `annotation.data.camera`；占位标注 camera [0,0,0] 时跳过相机过渡；`PlacementMode.cancelPlacement` 不销毁实体，由 `AnnotationManager.cancelAnnotation` 负责
- **Bloom 与 Reveal**：Bloom 不挂到 gsplat 实体，避免覆盖 reveal 的 `gsplatCustomizeVS`；有开场 reveal 时 **compose bloom + 局部亮灯**由 `BloomController._bloomStackUnlocked` 与 `revealComplete` / `revealRestart` / `hasRevealEffect:changed` 对齐，**不**使用额外 `state` 字段。**Timed VFX 视频导出**在越过内容阈值时也会 `fire('revealComplete')`，与上述门控一致（见 §5.7）。
- **NightFade 事件**：统一使用 `nightFade:changedDetailed { value, source }`（由 NightMode 发出），用于确定性区分 `nightMode:exit` 的内部写入与用户 `nightFade:set` 调节，避免 VFX 结束时亮度恢复被 0 覆盖。
- **局部亮灯区域**：`worldSpaceData` 仅作为当前 active LocalLightRegion 的工作区，不允许多区域共享；擦除只写当前区域的 worldSpace.committed
- **Bloom 默认与迁移**：以 `settings-serialize/settings-serialize-helper.ts` 的 `ensureBloom` 与 `settings.importSettings` 为准；旧存盘 `intensity:1` 等在运行归一，**显式 `localBrightness:0` 不迁移为 1**；调整 Bloom 默认时避免抬高 `WorldSpaceBloomData` 冷启动 `committedBrightness`，以免破坏 Reveal
- **父级托管**：`hostEditUI=true` 时仅通过 message-bridge 与事件驱动，不挂载内部顶栏/左侧/右侧/底部编辑 UI；协议事件名与 payload 以 `docs/SaaS第三期 编辑模式交互职责划分.md` 为准
- **编辑模式开关（父级）**：入站 **`EDIT_MODE_SET { value: boolean }`** 为编辑态唯一开关；**`EDIT_MODE_ENTER` / `EDIT_MODE_EXIT` 已移除**，避免与 `EDIT_MODE_SET` 双轨。进入 `true` 时 bridge 内先按 **`global.__originalSettings`** 恢复配置与运行时（资产/标注/光照/后处理/天空盒），其中资产统一走 **`requestSceneAssetsRestore(global, { reason: 'edit-enter' })`**（**就地 `syncScenePlacedEntitiesFromSettings`**，避免大资产 clear+reload 闪灭；显隐以恢复后的 **`settings.sceneAssets`** 为准）；天空盒经 **`mergeSkyboxOnEditEnter` + `applySkyboxOnEditEnter`**（真源有 URL reset，Viewer 临时 **`SKYBOX_SET`** 保留，均无 no-op）；待恢复完成后再 **`serializeExperienceSettings` → `setBaseline(initialSnapshot)`** 与 **`initEditHistory(global, initialSnapshot)`**，供 **`EDIT_EXIT_NEEDS_SAVE`** 与撤销栈对齐；**`getEditUiTransport(global)==='message-bridge'` 时 `ui.ts` 的 `updateEditModeUI` 跳过上述恢复与 `initEditHistory`**，防止双轨基线与假脏。
- **进入编辑与特效停播**：进入编辑（父级 `EDIT_MODE_SET(true)` 与 internal `ui.ts`）仅当 `revealBlocksAnim(state)===true`（timed/阻塞 revealComplete）时才 `events.fire('vfxExit')`，persistent（如 `perlin-wave`）不额外停播；`RevealController.forceStopVfx` 停播后统一 `fire('revealComplete')`，用于 timed 停播时立即解锁 deferred editing layers 与 Bloom 栈。
- **View→Edit 与配置真源**：应用启动后在 `index.ts` 将 `importSettings` 后的配置深拷贝为 **`(global as any).__originalSettings`**；进入编辑时用其覆盖 `global.settings` 并重建场景实体，使编辑始终从「初始 JSON」出发；View 内对 settings 的临时调节不视为持久真源。
- **`editLeftModule===null`**：`ModuleOrchestrator` 维护 `activeModule`，从任意模块切到 **`null`** 时仍对**上一模块**调用 `onExit`，与切到其他模块行为一致（清选中/Gizmo 等由各 facade 收口）。
- **`previewMode` 与调试可视化**：仅保留单一源状态 `state.previewMode`；asset/annotation/environment 的调试可视化显隐统一通过 `state-selectors` 按 `editMode + editLeftModule + previewMode` 实时推导，避免维护派生全局状态。`PREVIEW_MODE_SET` 仅写 `previewMode`，不直接编排各 visual。
- **环境线框开关真源**：`app.__lightsVisualToggle` 仅代表 Lighting 面板「Show lights in scene」用户开关，不得在 `setLightsVisualVisible` 中被“最终可见值”覆盖；模块切换（environment ↔ 其他/null）只影响即时显示，不污染开关意图。
- **选中事件防循环**：资产/光源/标注选中链路统一携带 `source: 'host' | 'scene' | 'unknown'`；message-bridge 只转发 `source==='scene'` 的 `SCENE_*_SELECTED`
- **资产显隐幂等**：`ASSET_SHOW_HIDE_SET` / `ASSETS_SHOW_HIDE_SET` 在目标显隐与当前一致时不得产生副作用（`asset-facade.ts` 短路）
- **相机模式防循环**：`CAMERA_MODE_SWITCH`（入站）触发的相机切换标记为 `source='host'`，对应 `cameraMode:changed` 不再回传 `CAMERA_MODE_CHANGED`；仅非 host 变更对父级上报，避免双向回环
- **重置视角 vs 重播动画**：**`CAMERA_RESET`** → `inputEvent('reset')` → 回到 **`settings.cameras[0].initial`**（`CameraManager` 内 **`resetCamera`**，经 **`camera:syncPrimaryInitial`** 与默认视角截图同步）；walk/fly/orbit 各自分支；若在 **anim** 模式会先切 **orbit** 再 goto。**`ANIMATION_RESET`** → **`resetAnim`**：anim 轨道时间回 **0** 并重播，**不是** initial 机位。**场景 settings 重置**（**`SETTINGS_RESET`**）与上述不同：全量恢复编辑内容并重建运行时，**`pathFrom`** 仅表示相机路径来自云端 transform 或保留当前；**不修改天空盒**。
- **相机俯仰角范围**：入站 **`CAMERA_PITCH_RANGE_SET { value: [min, max] }`**（度，**`[-90, 90]`**，**`min ≤ max`**）→ 写 **`settings.cameras[0].pitchRange`** + 派发 **`camera:pitchRangeChanged`** → **`CameraManager.applyPitchRange`** 同时更新 **`orbit.controller.pitchRange`** 与 **`fly.pitchRange`**（**`Vec2`**），构造时与运行时复用同一路径。
- **相机移动步长系数**：入站 **`CAMERA_MOVE_SPEED_SCALE_SET { value: number }`** → 写 **`settings.cameras[0].moveSpeedScale`** + **`camera:moveSpeedScaleChanged`**。运行时为 **`max(1, sceneSize×0.05) × scale`**（WASD / 触控 / 手柄）及 orbit 近距平移下限 **`max(1, sceneSize×0.1) × scale`**；缺省 **1**；范围 **(0, 10]**。大场景小步取小于 1 的系数。本地 UI：编辑右侧 **相机设置 → 移动步长**。快照回退经 **`settingsSnapshotApplied`** 重读。详 **`docs/工作记录.md`（2026-09-07）**。
- **天空盒（父级）**：**`SKYBOX_SET { value: string }`** → **`settings.background.skybox.currentUrl`** + **`applySkyboxTexture`**；**`SKYBOX_ADD { value: string }`** → **`skybox.uploadUrls`** 追加并设为 **`currentUrl`**。空字符串清空显示（**`clearSkyboxDisplay`** 仅在实际卸载过 **`scene.skybox`** 时重置 **`envAtlas`**）。**View→Edit**：见 **2026-06-11 补充**。Internal：**`editLeftModule:'skybox'`** + **`skybox-settings-ui.ts`**。已移除 **`SKYBOX_SWITCH`** 与 Settings 面板 **`skyboxRow`**。详 **2026-06-04 / 2026-06-11 补充（天空盒）**。
- **编辑态相机边界**：`camera-manager.ts` 中 `editMode=true` 时临时关闭 orbit/fly target constraint 与 fly sphere constraint；`editMode=false` 时按 `config.disableCameraBounds` 与 `settings.cameraBounds.enabled` 恢复基础约束。
- **放置资产相机碰撞**：**Walk** 尚未接入；碰撞开关 **`enabled`**（非 `userEnabled`）；**`debugVisual`** 不入库；存盘字段 **`settings.sceneAssetCollision`**（见 §5.8）。
- **编辑历史**：使用快照方式，非命令模式；`pushEditHistory(global, label)` 保存 `settings` 快照
- **编辑 discard 与 NightMode**：本地 `ui.ts` 与 `message-bridge` 的 `EDIT_MODE_EXIT_DISCARD` 在 `applySettingsSnapshot` 后调用 `restoreLightingFromSettings` + `restorePostEffectsFromSettings`；其中全局亮度依赖 **`nightMode:forceReapply`**，实现上须 **`removeShaders()` 后再按需 `applyShaders()`**（见 §5.3）
- **WebGPU**：`config.webgpu` 时禁用 XR
- **H264 编码**：宽高需为偶数
- **LOD**：多文件 octree（`lod-meta.json`）走 streaming refinement；`?fullload` 走全量加载

---

## 7. 推断的设计决策

| 决策 | 原因 |
|------|------|
| 全局 `Global` 对象 | 避免深层传参，便于事件驱动与跨模块访问 |
| 右侧面板按模块切换 | 减少 DOM 数量，保持 UI 简洁 |
| 底部栏按模块显隐与内容区分 | asset/annotation 操作不同，仅相关模块时显示，避免干扰 |
| 模块切换时各模块自行清理 | asset 离开时清空选中（asset-placement-handler），annotation 离开时取消放置/编辑（annotation-ui），职责分离 |
| 资产放置用 Picker 优先 | 提高放置精度，贴合 gsplat 表面；`pick()` 走引擎 `getWorldPointAsync` |
| 资产选中分类型 | Mesh 等：`pc.Picker(false)` + World；已放置高斯：`SceneAssetPick` 层 ID 拾取（`scene-asset-selection-pick.ts`），避免主场景合成 pick 遮挡 |
| 光源选中使用世界坐标 + 最近灯逻辑 | 统一由 `input-controller` 产出 `scenePointerWorldClick`（世界点击事件），`light.ts` 在业务层基于点击位置选择最近灯光，避免输入层与具体 Lighting 逻辑耦合 |
| 屏幕坐标 → 世界坐标统一封装 | `pickWorldFromClientXY` → `global.picker.pick()`（引擎深度）；手电筒表面用 `pickSurface()`（Raster 累加 / Compute 引擎深度） |
| Picker 全局单例 | 仅 `global.picker`；勿再使用 `app.__picker` 第二实例 |
| 标注用快照式历史 | 实现简单，与 settings 序列化一致 |
| Bloom 仅 World Space | 产品决策，避免屏幕空间笔刷与相机移动不一致 |
| 阴影由 postEffectSettings 统一控制 | 与 Bloom 等后处理配置风格一致 |
| 视频导出双 RT 流水线 | 渲染与 readback 并行，降低 GPU 等待 |

---

## 8. 关键文件索引

```
src/
├── settings-reset.ts     # resetSceneSettings；SETTINGS_RESET 编排
├── index.ts              # 入口、loadGsplat、createApp；skyboxSet 监听
├── viewer.ts             # Viewer 主类、管线集成
├── app.ts                # App 扩展
├── types.ts              # Config / State / Global 类型
├── settings.ts           # ExperienceSettings 结构
├── edit-history.ts       # 编辑历史
├── asset-placement-handler.ts   # 资产放置、editLeftModule:changed 时清空选中
├── scene-assets/scene-asset-selection-pick.ts  # 高斯/mesh 分路径场景点选（SceneAssetPick 层）
├── scene-assets/scene-asset-pick-layer.ts      # SceneAssetPick 图层（拾取专用，不入相机 渲染）
├── scene-assets/collision/      # 放置资产 AABB 相机碰撞 + 调试线框
│   ├── scene-asset-collision.ts
│   └── scene-asset-collision-debug.ts
├── gizmo-handler.ts             # 资产 Transform Gizmo
├── light.ts
├── reveal-policy.ts        # persistent VFX 集合 + reveal 与 anim / night 门控
├── reveal.ts
├── annotation-toolbar/          # 标注相关（annotation-manager, annotation-gizmo-handler 等）
├── vfx/
│   ├── bloom.ts
│   ├── lighting/night-mode.ts
│   └── shadow/           # shadow-system, shadow-catcher, shadow-apply, shadow-apply-exclude-mask, gsplat-exclude-mask-shader
├── render/video-export.ts
├── render/deferred-editing-visual-sync.ts  # Timed VFX 导出：叠加层门控 + revealComplete 对齐 Bloom
└── ui/
    ├── ui.ts             # 主 UI 初始化
    ├── edit-left-toolbar.ts
    ├── edit-right-toolbar.ts
    ├── edit-bottom-toolbar.ts   # 按模块显隐，asset/annotation 不同内容
    └── components/       # 各面板 UI 组件（含 skybox-settings-ui、camera-settings-ui 等）
        └── styles/       # _skybox-settings-ui.scss, _annotation-ui.scss, …
```

---

## 9. Recent Changes

- **放置资产 AABB 相机碰撞（2026-05-29）**：
  - **`scene-assets/collision/`**：全可见 mesh/gaussian 多 AABB 复合碰撞；**Fly/Orbit** 推开；**Viewer/编辑预览** 生效。
  - **`settings.sceneAssetCollision`** 持久化；**`SceneAssetCollisionRuntimeState`** 在 **`types.ts`**（**`debugVisual`** 不入库）。
  - 默认 **autoFit=false**，**mesh X=57%**；**autoFit 与手动 XYZ 互斥**。
  - UI：**`camera-settings-ui.ts`**；详 **`docs/放置资产相机碰撞实现说明.md`**。

- **阴影 B：放置资产接影（2026-06-01）**：
  - **`ShadowReceiverOccluder`**（mesh/image/video B 遮挡）+ **`PlacedMeshExclude`** / **G mask**（放置高斯）+ postrender **exclude vs shadowMask 深度门控**（前景遮挡不再误抠洞）。
  - 已移除 mesh 白模 exclude；**`PlacedGsplat` 分层已放弃**；加载见 **`suspendShadowPipelineForGsplatLoad`**。

- **天空盒 settings + 编辑模块（2026-06-04）**：
  - **`background.skybox.{ currentUrl, uploadUrls }`**；**`SKYBOX_ADD`** / **`skybox-settings-ui`**；左栏 **`skybox`** 模块。
  - 详 **`docs/工作记录.md`（2026-06-04）**「天空盒」条目。

- **场景 settings 重置 + SKYBOX_SET（2026-05-21）**：
  - **`settings-reset.ts`**：**`resetSceneSettings`**、**`pathFrom: 'original' | 'current'`**；**`SETTINGS_RESET`** 协议；保留 **`background.skybox`**；**`fetchOriginalTransform`**。
  - internal 顶栏 **重置场景** + **`confirmSceneReset` / `showEditToast`**。
  - **`SKYBOX_SWITCH` → `SKYBOX_SET`**，内部 **`skyboxSet`**（现写 **`currentUrl`**）。
  - 详 **`docs/工作记录.md`（2026-05-21）**。

- **View→Edit 场景资产就地同步（2026-05-20）**：
  - **`syncScenePlacedEntitiesFromSettings`** + **`applySceneAssetTransformToEntry`**；**`requestSceneAssetsRestore`** 在 **`reason:'edit-enter'`** 时默认不 clear。
  - View 临时显隐不写 settings；进入编辑后 **`settings.sceneAssets[].visible`** 为真源。
  - 详 **`docs/工作记录.md`（2026-05-20）**。

- **View 静音 + 视频曲度 + 贴图不收阴影（2026-05-20，曲度上限 2026-05-25）**：
  - **`view-settings.ts`**、**`VIEW_MEDIA_MUTE_SET`**、**`horizontalCurvature`** / **`ASSET_VIDEO_CURVATURE_SET`**、**`curved-billboard-mesh.ts`**（**`VIDEO_HORIZONTAL_MAX_ARC_DEG=180`**）。
  - **大曲度播控命中**：**`video-controls-texture.ts`** 曲度联动 **`screenPad` / `playPad` / jitter**。
  - **音频 callout 热区**：**`audio-callout.ts`** **`PLAY_HIT_PAD=24`**。
  - **image/video**：**`receiveShadows: false`**。
  - 详 **`docs/工作记录.md`（2026-05-25）**。

- **标注嵌入视频（大屏点击播放，2026-05-19）**：
  - **`videoUrl?`** 与 **`imageUrl?`** 互斥；归一 **`normalizeAnnotationMediaFields`**（**`media-fields.ts`**）。
  - **`annotation.ts`**：**`videoThumbDom`** + **`videoPreviewOverlay`**；**`syncTooltipMedia` / `closeMediaPreviews`**；与图片全屏遮罩共用 **`.pc-annotation-image-preview-overlay`** 样式类。
  - **`annotation-entity.ts`**、**`annotation-facade.ts`**、**`message-bridge.ts`**（**`SCENE_ANNOTATION_EDIT_START`**）、**`normalizeImportedAnnotation`** 全链路贯通。
  - Internal：**`annotation-toolbar-ui.ts`** / **`annotation-settings-ui.ts`** 媒体类型 **无 / 图片 / 视频**（视频为 URL 输入）。不做上传 / 转码 / 同条双媒体展示。

- **Reveal 参与半径与 effectParams 专参（2026-05-15）**：
  - **`GsplatShaderEffect.syncRevealParticipation`**：radial/sketch/growth-wave 用 **`maxEndRadius`** + bbox 下限 + **`syncSpeedToTotalDuration`**；rain/pieces 仍 **`endRadius`**。
  - **`reveal-effect-params.ts`**：按类型白名单；rain-v2 **`riseTint*`** / **`rainSize`**；integrate **`waveAmplitude`** / AABB 键。
  - **修复**：`'endRadius' in this` 使 PlayCanvas 脚本上的 cap 生效；rain-v2 **`hitDuration`** 接入 shader。
  - 详 **`docs/工作记录.md`（2026-05-15）**。

- **资产镜像与旋转持久化收口（2026-05-08）**：
  - `sceneAssets.transform` 新增 `rotationQuat?: [x,y,z,w]`（`schemas/v2-custom.ts`），并保留 `rotation` 作为旧数据兼容字段。
  - `settings-serialize.ts` 保存资产时同步写入 `rotationQuat`（来自 `entity.getLocalRotation()`），同时保留 `rotation + scale + mirror`。
  - `asset-placement-handler.ts` 读取资产时优先 `rotationQuat`（无效/缺失回退 `rotation`），再应用缩放与镜像；避免仅依赖 Euler 在镜像场景下出现多解抖动。
  - 资产变换恢复顺序固定为 **rotation（优先 quat）→ scale → mirror**，减少“保存后刷新姿态不一致”。

- **天空盒与 PBR 亮度收口（2026-04-29，2026-06-11 补充 clear 语义）**：
  - **skybox / envAtlas 解耦**（`src/loaders/skybox-loader.ts`）：`applySkyboxTexture` 使用 `EnvLighting.generateSkyboxCubemap(sourceTexture)` 写 `app.scene.skybox` 负责背景显示；`app.scene.envAtlas` 固定走独立反射源，不再与背景纹理强绑定。**mesh 反射不随天空盒贴图变化**。
  - **`clearSkyboxDisplay`**：仅当 **`app.scene.skybox != null`** 时才将 **`envAtlas`** 重置为纯色白；避免无天空盒场景进入编辑时误覆盖引擎默认 IBL（**2026-06-11**）。
  - **环境反射基线**：`SOLID_ENV_ATLAS_COLOR` 调整为 `Color(1, 1, 1)`，通过纯色 envAtlas 提升高反光 PBR 材质的整体反射亮度基线。
  - **夜景反射强度微调**（`src/vfx/lighting/night-mode.ts`）：`targetSkyboxIntensity` 当前为 `Math.max(0.23, Math.min(2.0, 1.1 + 1.0 * this.nightFade))`，基于多轮实机观感反馈在“足够亮”与“不过曝”之间取折中。
  - **材质侧增强仍保留**（`src/asset-placement-handler.ts`）：高反光材质继续使用 PBR boost 策略（`useSkybox=true` + ambient/diffuse/emissive 调整），与 envAtlas/skybox 调整共同构成当前亮度方案。

- **相机链路稳定性收口 + `LIGHT_TOGGLE_ALL` 全局 Bloom 总闸（2026-04-24）**：
  - **包围盒外控制异常修复**：`orbit-controller.ts` 中 orbit `onEnter` 改为仅 clamp `camera.distance`，不再回算并覆盖 `camera.position`，避免点击/模式切换时“吸附式瞬移”。
  - **orbit 上限放宽**：`camera-manager.ts` 将 `maxZoomMultiplier` 从 `0.5` 调整为 `4.0`，防止初始视角在包围盒外时被过小上限强制拉近。
  - **双击黑屏防护**：`cameras/camera.ts` 的 `Camera.lerp` 增加与 `look` 同级的数值保护（`distance` 非有限或过小时保留姿态并钳制正值），避免 `vecToAngles(dir / distance)` 触发 NaN。
  - **协议语义扩展**：`editor-modules/protocol-adapters/environment-protocol-adapter.ts` 中 `applyLightToggleAll` 新增 `bloomScope` 分支：`global` 模式下同步 `settings.postEffectSettings.bloom.enabled`，实现 `LIGHT_TOGGLE_ALL` 直接控制整场 Bloom；`local` 模式保留 `viewSettings.bloom.localLightsEnabled` 观看态语义。

- **输入仲裁器接入 + 放置态收口 + 标注双实例修复（2026-04-21）**：
  - **输入统一入口**：新增 `input-arbiter.ts`，在 `viewer.ts` 初始化挂载；`input-controller.ts` 在 `pointerup` 产出一次拾取结果后，先走 `dispatchPointerClick`（可 `claim`）再决定是否继续通用广播，避免多模块并行监听同一点击。
  - **模块按优先级消费**：`environment-facade`（光源放置）、`annotation-toolbar/placement-mode`（标注放置）、`asset-placement-handler`（资产放置/选中）、`camera-manager`（光源选中）按优先级接入，同一点击由首个 claim 成功者消费。
  - **放置语义一致化**：asset/light/annotation 在“点击未命中 worldPosition”时统一 claim 并保持放置态，避免误退出放置流程。
  - **状态收口**：移除全局 `state` 中 `lightPlacementActive`、`annotationPlacementActive`、`annotationEditMode`，模块内部自行维护放置/编辑状态，减少跨模块状态耦合。
  - **回归修复**：`annotation-ui.ts` 改为复用 `global.annotationManager`，并用 `ownsAnnotationManager` 控制销毁责任，修复“确认放置后占位热点与 tooltip 残留”问题。
  - **光标统一**：新增 `placement-cursor.ts`，在 asset/environment/annotation Facade 层统一设置放置光标，默认 `placement.svg`，降级 `crosshair`。

- **growth-wave 裁剪问题架构收口（2026-04-20）**：
  - **目标**：修复 growth-wave 开场“视觉 cutoff / 相机前移才出现”时，避免在 `viewer.ts` 继续堆叠按特效名分支。
  - **能力下沉到脚本**（`vfx/gsplat-growth-wave.ts`）：新增 `getCameraClipHint()`，按当前特效参数返回 `clipPadding`（扩展 far）与 `nearMax`（near 上限）提示。
  - **控制器统一透传**（`reveal.ts`）：新增 `RevealController.getCameraClipHint()`，统一校验并输出通用 `RevealCameraClipHint`，Viewer 不再直接读取具体脚本字段。
  - **viewer 保持中立**（`viewer.ts`）：移除 `vfxType==='growth-wave'` 直判断；改为消费通用 hint。裁剪语义同步收敛为：`clipPadding` 仅作用于 `farClip`，`nearBase` 使用 `dist - boundRadius`，`nearClip` 在默认计算基础上再受 `nearMax` 上限约束，降低前景裁切风险。
  - **可维护性**：后续新特效若有裁剪需求，只需实现同名能力接口，不改 viewer 主流程，保持模块边界清晰。

- **聚光灯受光范围收敛实验 + 锥底调试圆盘 + growth-wave 位移上限（2026-04-15）**：
  - **`growth-wave` 点云阶段位移上限**（`vfx/gsplat-growth-wave.ts`）：在 Phase 1 中对 `maxScatterDistance` 增加上限（以 `uEndRadius` 为上界，GLSL/WGSL 同步），用于抑制大场景下粒子位移过大导致的远裁剪“大片截断感”。
  - **聚光灯锥底调试圆盘**（`light.ts`）：新增 `spotLight_debugDisc`（位于锥体底面局部 `y=-1`，与锥体共用 `range + outerConeAngle` 缩放和 Show lights 显隐），用于快速验证可视锥底与实际受光交线是否为同一几何语义。
  - **聚光灯真实受光收敛实验**（`light.ts`）：新增 `EFFECTIVE_SPOT_CONE_ANGLE_SCALE=0.9`，创建/更新 `spot` light 时对 `inner/outerConeAngle` 做轻微收紧，仅影响真实光照与 gsplat 打光，不改变 `settings` 值与 gizmo 展示，作为“主亮区尽量收敛到锥体内”的实验参数。
  - **排查结论**：在“锥尖→锥底”视角重合、侧视出现偏差的情况下，偏差主要由光锥与墙面/展板交线、法线、遮挡与视差共同放大，不属于锥底线框几何计算错误。

- **Bloom 面板协议收口 + 环境模块退出清草稿 + reveal 首帧时序调整（2026-04-14）**：
  - **Bloom scope toggle（`post-effect-ui.ts`）**：`editUiTransport='message-bridge'` 时，“仅局部亮灯区域”统一通过 `sendEditProtocolMessage({ type: 'BLOOM_IS_LOCAL_SET', value })` 下发，并本地即时更新勾选样式，避免 UI 点击反馈滞后。
  - **Threshold 语义可读性**：`Threshold (HDR)` 增加 tooltip 与处理代码注释，明确为 Bloom 亮度提取阈值（值越低越容易发光，值越高越偏向高光）。
  - **环境模块退出清理 draft**（`environment-facade.ts`）：`onExit` 检测 `bloomEditorSession.activeLocalLightRegionId` 为 `draft-*` 时自动 `fire('messageBridge:lightBrush', { type: 'LIGHT_BRUSH_CLEAR' })`，防止切到 `null`/其他模块后笔刷态残留。
  - **首访 reveal 启动时序**：`reveal.ts` 初始 `createEffect` 延后到 `firstFrame`；`viewer.ts` 在 `revealBlocksAnim(state)` 分支提前 `state.animationPaused = true`，减少首帧前 animTrack 偷跑造成的开场视角偏移。

- **光源协议与 UI、资产显隐幂等、VFX 切换 reveal 门控、mesh 环境光可读性（2026-04-13）**：
  - **`LIGHT_SELECT`**：不再派发相机 `frame` + `focusTarget:'light'`（`message-bridge.ts`），避免与资产「选中即推相机」混同。
  - **点光 Range**：`PointLightConfig.range`、`light.ts` 默认 **10**、`LIGHT_RANGE_SET` 写 settings 并刷新场景（**忽略 directional**）；Lighting UI Range 滑条；Bloom 区域绑定灯对点光发 `LIGHT_RANGE_SET`、聚光仍走 `LIGHT_BRUSH_RANGE_SET` 等（`post-effect-ui.ts`）。
  - **`LIGHT_TOGGLE_*`**：曾试验 View 不写 settings 已撤回，仍写 `global.settings`（与既有 Viewer 联动文档一致）。
  - **资产显隐**：`ASSET_SHOW_HIDE_SET` / `ASSETS_SHOW_HIDE_SET` **幂等**（`asset-facade.ts`）。
  - **VFX 类型切换**：非 `none` 时 `revealRestart` + 更新 `hasRevealEffect`；`viewer.ts` 对 **`DEFAULT_DEFERRED_EDITING_LAYERS`** 在 reveal 期间隐藏、`revealComplete` 恢复，与导出 Timed 门控语义对齐（`reveal.ts`）。
  - **天空盒与 mesh**：**保留** `applySkyboxTexture` 原逻辑；mesh 提亮以 **`index.ts` `ambientLight` 基线** + **`asset-placement-handler` mesh 材质基线**为主（具体 RGB 以代码为准）。

- **资产聚焦、模块 null 退出、View→Edit 与 bridge 单轨（2026-04-13）**：
  - **资产**：`camera-manager` 在 `focusTarget==='asset'` 时走 **bbox framing**（按 FOV/宽高比计算 fit distance，目标完整入画且构图一致）；`asset-placement-handler` 场景点击资产统一触发 `frame+focusTarget:'asset'`，`message-bridge.ts` 的 `ASSET_SELECT` 与 scene 命中链路都做了“同 id 不重复 focus”短路。
  - **gaussian 构图补偿**：由于 gsplat 与 mesh 的可视主体语义差异，`camera-manager.ts` 对 gaussian 在最终 `fitDistance` 上应用 `GAUSSIAN_ASSET_FOCUS_DISTANCE_SCALE`（当前 0.6）以对齐 mesh 的主观聚焦距离。
  - **模块**：`module-orchestrator` 用 `activeModule` 记录上一左侧模块，**`editLeftModule===null`** 时仍 `onExit` 上一模块，与各 facade 清理语义一致。
  - **编辑态边界**：进入编辑模式时临时关闭 camera bounds，退出回到 View 时自动恢复基础约束。
  - **View→Edit**：`index.ts` 保存 **`__originalSettings`**；进入编辑时 snapshot 恢复 + 重建 placed assets / 标注 / 光照 / 后处理。
  - **message-bridge**：移除 **`EDIT_MODE_ENTER`/`EDIT_MODE_EXIT`**，仅 **`EDIT_MODE_SET`**；进入 true 时 **`setBaseline(initialSnapshot)` + `initEditHistory`**；**`ui.ts` 在 message-bridge 模式下不重复 restore/snapshot**。
  - **序列化**：`settings-serialize` 增加 **`getComparableSettingsStringFromSnapshot`** 供基线字符串与快照一致对齐。
  - **sceneAssets 恢复单轨**：`viewer.ts` 启动期、`message-bridge.ts` 进入编辑/discard、`ui.ts` internal 进入编辑/discard、`edit-history.ts` snapshot restore 统一走 **`requestSceneAssetsRestore`**；**`edit-enter`** 默认 **`syncScenePlacedEntitiesFromSettings`**（见文首 **2026-05-20** 补充）；**discard / history-restore / startup** 为 clear+全量 restore；startup 可 defer 到 `revealComplete`，后续 restore 会提升 version 使旧 defer 失效。
  - **persistent VFX（perlin-wave）一致性**：`viewer.ts` 在 `revealRestart` 且 `revealBlocksAnim(state)===false` 时主动解锁 deferred layers，避免从 timed 切到 persistent 时资产/标注持续隐藏；进入编辑仅 timed 会 `vfxExit`，persistent 不额外停播且资产/标注按常规恢复，不依赖 perlin 的 `revealComplete`。

- **局部亮灯首个草稿偶发清空 + 光源删除残留修复（2026-04-08）**：
  - **首个草稿偶发清空**（`bloom.ts`）：将 `regions.length===0` 分支的优先级调整为 **`isDraftOnly`（含 `hasWorkingPoints` 兜底）优先**，再处理 `_lastMultiRegionHash` 清空；避免 `LIGHT_ERASER_START` 时序下误清空 draft 体积、切回 BRUSH 才恢复的问题。
  - **光源删除残留**（`light.ts`）：点光/聚光及容器清理从 `removeChild` 改为 `destroy`，确保组件级销毁，避免父级删除后仍影响 mesh 受光。

- **NightMode 点聚光 gsplat 管线加固 + persistent VFX 策略集中（2026-04-08）**：
  - **色彩与强度**：点/聚光线性色在 TS **`localLightLinearRgb`** 计算（与方向光一致），shader **不再对灯色 `g2l`**；衰减 **`1.15/(1+d²)`**；**`sum` / `linearColor*mult` / `pow` 底数 / `viewDir` / `uNightFade`** 等数值防护见 §5.3。
  - **极大 intensity**：**`LOCAL_LIGHT_LINEAR_PEAK_CAP`**（默认 16）按峰值等比缩小单灯线性 RGB、保色相，与 shader clamp 分层，避免单灯无界放大。
  - **Reveal 节奏**：新增 **`reveal-policy.ts`**（**`PERSISTENT_VFX`** 含 **`perlin-wave`**，**`revealBlocksAnim`**、**`nightDeferredByReveal`**）；**`viewer.ts`** 统一使用，**`reveal.ts`** 不为 perlin 伪造 `revealComplete`。详见 `docs/工作记录.md` 2026-04-08。

- **编辑 discard 后全局亮度复位（NightMode `forceReapply`）**（2026-04-07）：
  - **问题**：不保存退出编辑后，全局亮度滑块对应的画面仍像未恢复。
  - **根因**：`nightMode:forceReapply` 仅清空 `materialsApplied` 记录，未调用 `GsplatShaderEffect.removeShaders()`，gsplat 材质上 **`gsplatModifyVS` 残留**，旧 uniform 继续生效。
  - **修复**（`night-mode.ts`）：`forceReapply` 内 **`removeShaders()` →（|fade|>0 时）`applyShaders()` → 始终 `updateEffect`**；与 VFX 结束、Reveal 恢复亮度等同一事件语义对齐。

- **VFX 传播/点云尺度一致性修复**（2026-04-02）：
  - `sketch`：`useCameraDistance` 模式下以 **xz 平面到 Reveal 焦点 `uCenter`** 的距离推进（并移除不再需要的 `uCameraPos`/相机 eye 捕获），对齐 `rain-v2` 的传播语义。
  - `integrate`：通过调整 `INTEGRATE_WAVE_PHASE_END`、拉长 `wavePhase -> tt` 过渡并在尾端收尾（`waveFactor`/xz 收尾），降低「模糊阶段/清晰阶段」硬分界观感；`getCompletionTime` 与 shader 阈值对齐。
  - `growth-wave`：点云阶段 `uPointSize` 统一固定为脚本 `pointSize`，不再随 bbox/高度动态 scale；同时移除 reveal 侧注入相关特征尺度，以避免不同场景初始点云偏大。

- **Bloom 会话态拆分 + Reveal/VFX 首帧与 Bloom 节奏**（2026-03-31）：
  - `postEffectSettings.bloomEditorSession` 承载笔刷/选中/草稿中心等非持久化编辑态；`bloom` 仅持久化字段；序列化剔除 `bloomEditorSession`；`ensureBloomEditorSession` + 导入 hoist 对齐旧 JSON。
  - Timed `GsplatShaderEffect` 子类在结束路径调用 `notifyRevealComplete()`，保证 `revealComplete` 与 animTrack 等联动。
  - `updateUnifiedMaterials` 对 `getGSplatMaterial` 传入 **Camera 实例**（非 CameraComponent）；`viewer` 中 **NightMode 先于 RevealController** 创建，避免首次 `nightMode:exit` 丢失。
  - `BloomController` 内 **`_bloomStackUnlocked`** 统一门控 reveal 期间的 **compose bloom + 局部亮灯**（无新 `state` 字段）；监听 `hasRevealEffect:changed`、`revealComplete`、`revealRestart`。
  - **Timed VFX 视频导出门控**：`render/deferred-editing-visual-sync.ts` 的 `VfxExportPostRevealSync`；**`initVideoExport` 在 `new Viewer` 之后** 并传入 **`getRevealExportTimingSource: () => viewer.revealController`**；`exportVideo` 先设导出旗标再 `revealRestart` 再首帧 `syncExportFrame`；标注 **`prerender` + `entity.enabled`** 早退隐藏 DOM。
  - **Reveal 阈值与半径**：`getPostRevealContentThresholdSec` 优先脚本 **`getCompletionTime()`**；radial / rain 等 **`endRadius`** 由 **`applyAdaptiveEndRadius`** 与脚本默认及 bbox 下限协同；`viewer` 创建 Reveal 前 **`applyCamera`**。

- **Bloom / 局部亮灯默认值与导入归一 + Reveal 安全边界**（2026-03-30）：
  - 该条为历史基线；后续已更新为：**intensity 0（默认关闭 Bloom）**、**blurLevel 10**、**threshold 0**、`bloomScope='global'`、`bloomBrushBrightness 1`。`importSettings` 末尾仍调用 **`ensureBloom(result)`**；`ensureBloom` 仍保留历史 `intensity===1` 的运行时归一以兼容旧存盘。**整灯闸与观看态局部亮灯合成**：不再使用存盘 **`bloom.localLightsEnabled`**（导入时删除该键），以 **`2026-04-18`** 起 **`global.viewSettings.bloom.localLightsEnabled`** + `bloom.ts` **`applyViewerLocalLightPolicy`** 为准（见 §5.5 与文首补充）。
  - **localBrightness**：仅缺字段时补齐（默认 1）；**显式 `0` 保留**；UI 用 `?? 1` 只对 `undefined`/`null`。
  - **勿改** `WorldSpaceBloomData` 默认 committedBrightness 为非零：空 committed 时 `syncCommittedToNightMode` 会与 radial reveal 冲突。详见 `docs/工作记录.md` 2026-03-30。

- **Bloom 笔刷链路重构收口（协议单轨 + 语义收敛）**（2026-03-27）：
  - `bloom.ts` 中笔刷/擦除分发与 pointer 会话已下沉到 `vfx/bloom-brush-flow.ts`，`BloomController` 仅保留宿主编排与渲染主链路。
  - legacy 完成入口 `bloomBrush:set` 已移除，完成操作统一为 `LIGHT_BRUSH_FINISH` 单轨，不再维护双入口并行。
  - 亮度语义收敛：运行时不再读写 `bloomBrushCommittedBrightness`；会话亮度使用 `bloomBrushBrightness`，区域持久化亮度以 `LocalLightRegion.localBrightness` 为唯一真源。
  - **`editor-modules/protocol-adapters/environment-protocol-adapter.ts`**、`schemas/v2.ts` 与 UI 相关类型注释已同步到新语义，避免继续引入旧字段职责。

- **视频导出（fast-mp4）阶段性优化收口**（2026-03-26）：
  - 建立导出分段观测：新增 `render/encodeDrain/workerFlush` 分段 timing 与 `chunks/debt/eqs/paceHits` 指标，用于区分“渲染慢”与“编码尾部慢”。
  - 在 `fast-mp4` 渲染循环中引入基于 `framesSent - encodedChunkCount` 的主动背压（8ms），将编码清账前移到渲染阶段，显著降低 `workerFlush` 长尾波动。
  - `includeVfx=false` 时走 `skipVfx`（跳过 timeline/script update），避免无效 VFX 驱动路径。
  - 试验后移除 `WEBGL_lose_context` 方案（存在恢复风险/黑屏与 framebuffer 报错），保留低风险尾段策略（暂停渲染循环 + `visibility:hidden`）。
  - `RevealController.setEffectTimeForExport` 对 `perlin-wave` 取消 `totalDuration` 限制，导出时可覆盖整段视频时长；其余特效保持 clamp。
  - `video-export.ts` 去除本地 `localize` 占位函数，导出进度/开始文案统一为中文固定 label。

- **局部亮灯区域编辑链路收口为单入口（本地/父级共用）**（2026-03-25）：
  - `post-effect-ui.ts` 中新建区域、切笔刷/擦除、完成、放弃统一改为发送 `LIGHT_BRUSH_*` 协议事件；internal 模式也通过 `events.fire('messageBridge:lightBrush', ...)` 进入同一处理链，不再保留 UI 层独立“创建草稿/导出/落盘”的第二套状态机。
  - `bloom.ts` 的 `LIGHT_BRUSH_FINISH` 统一承担草稿落正式区域逻辑（不再仅限 `showEditUI=false`），并支持 `payload.id` 作为优先区域 id；同 id 时覆盖更新，避免重复区域条目。
  - `post-effect-ui.ts` 合并 `onSelectRegion2/refreshRegionList2` 与原有实现，收敛为单一 `onSelectRegion/refreshRegionList`，降低列表状态分叉与重复刷新风险。

- **父级托管协议对齐与保存上传链路收口**（2026-03-24）：
  - `SETTINGS_SAVE` 改为“先上传后回传”：`message-bridge.ts` 中接入 `uploadProjectData`，仅在上传 `settings.json` 成功后回传 `SETTINGS_UPDATED`；失败回传 `SETTINGS_SAVE_FAILED`。
  - `SETTINGS_UPDATED/SETTINGS_SAVE_FAILED` 按协议改为无 payload 语义；Viewer→父级上报统一改为顶层字段格式 `{ type, ...data }`，不再包 `payload`，修复父级取值不一致导致的 `undefined`。
  - `EDIT_EXIT_NEEDS_SAVE` 统一回传顶层 `value`，并在内部等待逻辑兼容读取，避免内外调试环境字段差异。
  - 保存上传参数统一走顶层 `config.projectId/config.token`；`ui.ts` 中当存在 `projectId/token` 时优先走协议保存路径，避免误回落本地下载分支。

- **settings 上传对象 key 规则更新**（2026-03-24，**2026-05-29** 增补时间戳目录，**2026-08-26** sidecar）：
  - `src/universe/service.ts` 中版本目录走 **`buildProjectVersionObjectKey`**：有 `projectId` 时为 `<baseDir>/<projectId>/<timestamp>/<relativePath>`（settings.json 或 `assets/...`）；无 `projectId` 时为 `<baseDir>/<relativePath>`。单次保存共用一个 `timestamp`（`Date.now()` 毫秒）。
  - 用户上传 sidecar **只 OSS put、不登记版本接口**；版本接口仍只登记 settings.json。缩略图仍沿用 STS `objectKey`，不进该目录。
  - 以上规则同时覆盖单文件上传（`ststoken`）与分片上传（`multipart/init`）路径。

- **标注协议与展示体验修复**（2026-03-24）：
  - 新增入站 `ANNOTATION_UPDATE { id, value }`，用于父级表单输入时实时更新场景标注预览；`annotation-ui.ts` 在 `editUiTransport=message-bridge` 下输入变化时持续发送该事件。
  - `LIGHT_ADD` 接入 `isThreeSixty`：`true` 创建 point light，`false` 创建 spot light（含默认 inner/outer 角）。
  - 标注热点 SVG 资源纳入 dist 构建拷贝（`public/assets/icons/**/* -> dist/assets/icons`），修复打包产物中热点图标缺失。
  - 标注 Tooltip/收起标题样式按联调需求更新：背景透明度下调、标题正文居中、padding 与圆角规格更新。

- **局部亮灯区域“第二个完成后覆盖第一个”修复**（2026-03-23）：
  - **（历史）**曾存在 **`bloomBrush:set` 内部入口**与 **`LIGHT_BRUSH_FINISH`** 并行，且 `message-bridge` 路径中 **`LIGHT_BRUSH_FINISH` 曾误调 `syncCommittedToNightMode()`**，用单区域 `worldSpaceData` 覆盖已合成的多区域体积。
  - **现状**：**`bloomBrush:set` 已移除**；仅 **`LIGHT_BRUSH_FINISH`**（经 `messageBridge:lightBrush` → **`BloomBrushFlowController`**）落盘；若已有其它已提交区域则**不**再走单区域 `syncCommittedToNightMode()` 覆盖，改为清 **`_lastMultiRegionHash` / `_lastMaskSignature`** 后由下一帧 **`applyToCameraFrame`** 按全量 **`localLightRegions`** 重建。

- **视频导出协议补齐（Started/Cancelled/End）+ filePicker 前置**（2026-03-20）：
  - `VIDEO_EXPORT_START`（message-bridge）改为先 `showSaveFilePicker` 获取保存地址，再启动 `render.video`；取消选址直接上报 `VIDEO_EXPORT_CANCELLED`。
  - Viewer→父级新增/落地 `VIDEO_EXPORT_STARTED`、`VIDEO_EXPORT_CANCELLED`、`VIDEO_EXPORT_END`：开始由 `progressStart` 上报，结束由 `progressEnd` 按取消状态区分上报。
  - `VIDEO_EXPORT_CANCEL` 触发 `render.video.stop` 后，快速导出与离线导出均按 B 方案丢弃部分结果（不写入、不下载）；取消状态用闭包变量+事件传递，避免向 `global.state` 动态加属性导致 Proxy set trap 报错。

- **标注编辑新增出站协议 `SCENE_ANNOTATION_EDIT_START`**（2026-03-20）：
  - 在 `annotationEdit:show` 时统一上报 `SCENE_ANNOTATION_EDIT_START { id, value }`，`value` 包含 `title/text/imageUrl?/videoUrl?/showTitleWhenCollapsed`（`imageUrl` 与 `videoUrl` 互斥），用于父级编辑面板初始化数据。

- **资产显隐协议拆分 + 去除旧协议兼容**（2026-03-19）：
  - `ASSET_SHOW_HIDE_SET` 语义固定为**单资产显隐**，payload 为 `{ id, value }`，不再兼容旧格式 `{ value }`。
  - `ASSETS_SHOW_HIDE_SET { value }` 作为**全部资产显隐**事件使用（包括 View 模式“显隐所有资产”）。

- **相机模式协议防循环升级（source 方案）**（2026-03-19）：
  - `CAMERA_MODE_SWITCH / CAMERA_MODE_CHANGED` 从临时时间窗 guard 升级为来源显式化策略：入站切换标记 `host`，出站 `cameraMode:changed` 遇到 `host` 来源即跳过回传。
  - 保留同值短路（父级下发值与当前值一致直接忽略），减少无效触发；整体与 `SCENE_*_SELECTED` 的 source 治理模型保持一致，长期可维护性更高。

- **场景选中事件防循环重构（source 显式来源）**（2026-03-19）：
  - 将 `SCENE_ASSET_SELECTED / SCENE_LIGHT_SELECTED / SCENE_ANNOTATION_SELECTED` 的上报策略从“一次性 suppress”改为“来源显式化”：选中事件统一透传 `source`，仅 `source==='scene'` 允许向父级回传。
  - 父级协议触发（`ASSET_SELECT`/`LIGHT_SELECT`/`ANNOTATION_EDIT`）及本地右侧 UI 列表触发统一标记 `source:'host'`；场景命中路径（资产 picker、光源 picker、标注 hotspot）标记 `source:'scene'`。
  - `AnnotationManager.selectAnnotation` 与 `applyLightSelect` 补齐 `source` 参数透传，确保中间层不丢来源语义，彻底避免监听环路。

- **光源线框可视化（点光 range 球 + 聚光 inner/outer 锥体）**（2026-03-17）：
  - 点光范围线框：`light.ts` 中新增 `createSphereWireframeMesh(device)` 与 `createWireframeMaterial()`，使用 `Mesh + PRIMITIVE_LINES` 生成三个正交圆环（XY/XZ/YZ）组成的单位球线框；`addLightVisual` 不再依赖 `render: { type: 'sphere' }` 的实心小球，而是挂载自定义 `meshInstances`。`createPointLightsFromSettings` 会从 `cfg.range` 读取点光范围（默认 **10**）并写入 light 组件，同时调用 `updatePointLightRangeVisual(entity, range)` 通过 `localScale` 对线框球做均匀缩放，使 gizmo 半径与点光 range 一致。
  - 聚光锥体与内圈：新增 `createConeWireframeMesh(device)`（单位锥体：锥尖 (0,0,0)，底面 y=-1，半径 1）和 `createCircleWireframeMesh(device)`（底面圆环，用于 innerAngle），`addSpotLightVisual` 为每个聚光灯挂一个外锥体实体 `spotLight_visual` 与一个内圈实体 `spotLight_innerRing`。`createSpotLightsFromSettings` 在创建/更新 PlayCanvas spot light 时写入 `innerConeAngle` / `outerConeAngle` / `range`，并统一通过 `updateSpotGizmoShape(entity, range, outerCone)` 计算外锥体底面半径与高度，同时根据 `light.innerConeAngle` 计算内圈半径，两者都按照「单位锥体几何 × (outerRadius/range)」的约定进行缩放，从而在编辑视图中直观展示聚光灯的 inner/outer 角与照明距离。
  - 独立 LightVisual 渲染层：为避免 gsplat（高斯点云）与透明物体对 gizmo 的深度与排序干扰，`light.ts` 中新增 `ensureLightVisualLayer(app)`，创建名为 `LightVisual` 的 Layer 并放入 layer 列表末尾，同时确保主相机 `camera.layers` 包含该 layer。点光球、聚光锥体与内圈全部使用白色 emissive 材质（`diffuse=(0,0,0)`、`emissive=(1,1,1)`、`emissiveIntensity=1`、`depthWrite=false`、`depthTest=false`、`useLighting=false`），并指定 `layers: [lightVisualLayerId]`，从而实现「始终可见但不污染场景光照」的叠加效果。
  - 显隐与编辑模式联动：`setPointLightsVisualVisible(global, visible)` 仍然是低层级显隐控制入口，现在在 `spotLights` 容器中会同时更新 `__spotVisualEntity` 与 `__spotInnerRingEntity` 的 `render.enabled`，保证 Show lights in scene 开关能统一控制外锥体与内圈。`setLightsVisualVisible` 继续按照「仅在 `state.editMode && editLeftModule === 'environment'` 且环境面板开关为 true 时显示」的规则调用 `setPointLightsVisualVisible`，避免在非环境编辑上下文中出现 gizmo 干扰。
  - 旧实现清理：移除了基于彩色实心小球/锥体的可视化逻辑（`LIGHT_VISUAL_RADIUS`、`SPOT_VISUAL_SCALE`、`updateLightVisual`、`updateSpotLightVisual` 等），统一改为白色线框 gizmo，以减少视觉噪音，并避免在夜间模式 / Bloom 叠加时出现「小光源自发光把整块区域点亮」的问题。

- **编辑模式阴影 / 光照 / 标注与局部亮灯交互打磨**（2026-03-17）：
  - 阴影系统：在 PostEffect → Shadow 子面板中新增「Light Yaw (°)」slider，并通过双通道适配 `SHADOW_DIRECTION_SET { value }`——internal 模式直接调用 `applyShadowDirectionSet` 同步更新 `settings.lighting.lights` 中主方向光 yaw 与 `postEffectSettings.shadow.lightYaw` 并刷新场景；hostEditUI/message-bridge 模式下仅发送协议，由 `message-bridge.ts` → **`CommandRegistry` → `EnvironmentFacade`** → **`environment-protocol-adapter.ts`** 统一更新配置与场景主方向光；同时确认 `ShadowApplyRt` 中使用 `intensity = darken`，配合文档将 `shadow.darken` 语义固定为「0 不压暗、1 阴影最深」。
  - 光照生成与选中：**`environment-protocol-adapter.applyLightAdd`** 与 Lighting 面板中新建点光/聚光灯均通过 `getPositionInFrontOfCamera` 在相机前方生成光源，使父级协议与内部 UI 的新建行为一致；新建后写入 `state.selectedLightId` 并派发 `sceneLight:selected`，实现「创建即选中」。环境模块底部栏监听 `lighting:deleteLight` 事件，删除非 directional 光源时从 `settings.lighting.lights` 中移除并清空选中，随后 `updatePointLightsFromSettings` + `lighting:changed` 重建场景实体，修复原先底部删除按钮无效的问题。
  - 标注图片体验：`annotation.ts` 中为标注 Tooltip 图片增加点击预览能力——创建全屏遮罩 `pc-annotation-image-preview-overlay` 与大图 `<img>`，点击缩略图时显示遮罩、再次点击遮罩关闭；同时在图片加载错误或无 `imageUrl` 时清空 `src` 并隐藏图片，避免出现破损占位。`annotation-entity.ts` 在无图场景下同样清空 `Annotation.imageDom.src` 并隐藏，实现「没有图片就完全不占位」的交互。
  - 局部亮灯区域 Range 协议与聚光灯可视化：在 `docs/SaaS第三期 编辑模式交互职责划分.md` 中补充 `LIGHT_BRUSH_RANGE_SET { id, value }` 协议，并在 `message-bridge.ts` 与 **`environment-protocol-adapter.applyBloomLocalLightRegionRangeSet`** 中实现——通过亮灯区域 `id` 找到其 `linkedLightId` 所绑定的非 360° 聚光灯，限定 Range 到 \[0,20\] 后写回并调用 `updatePointLightsFromSettings` + `lighting:changed`，使 Bloom 面板中每个 LocalLightRegion 的 Range slider 能以区域维度安全控制对应聚光灯的照明范围。在 `light.ts` 中复用 PlayCanvas 风格的聚光灯锥体可视化，仅保留外锥体，并将几何缩放逻辑统一到 `updateSpotGizmoShape(entity, range, outerConeAngle)`，根据当前 Range 与 OuterAngle 计算锥体高度与底面半径、动态设置 `localPosition` / `localScale`，保证调整 Range 或 OuterAngle 时编辑视图中锥体形状即时反映。

- **阴影系统协议与 UI 调试增强**（2026-03-17）：
  - 在 `message-bridge.ts` 与 **`environment-protocol-adapter.ts`** 中对接 `SHADOW_SET`、`SHADOW_INTENSITY_UPDATE`，并新增 `SHADOW_DIRECTION_SET { value }`：internal 模式通过 `applyShadowDirectionSet` 同步更新 `settings.lighting.lights` 中的 directional yaw 与 `postEffectSettings.shadow.lightYaw`，再调用 `updatePointLightsFromSettings` 立即刷新场景主方向光；父级托管模式下仅通过协议驱动，行为以 `docs/SaaS第三期 编辑模式交互职责划分.md` 为准。
  - 统一阴影深度语义：`shadow.darken` 改为「0 不压暗、1 阴影最深」，`ShadowApplyRt` 中直接使用 `intensity = darken` 叠阴影，并同步更新 SaaS 协议文档及 Shadow 面板文案，使 UI slider、协议数值与最终视觉一致。
  - 在 PostEffect → Shadow 子面板中新增「Light Yaw (°)」调试 slider，internal 模式调用 `applyShadowDirectionSet` 直接写 settings 并更新光照，message-bridge 模式下通过 `SHADOW_DIRECTION_SET` 事件由父级控制；配合原有 Spawn Test Sphere/Splat 按钮，便于在编辑模式内快速观察不同方向光下的阴影效果。

- **Viewer 模式光照与局部亮灯联动**（2026-03-16）：
  - 协议 `LIGHT_TOGGLE_ALL { value }`、`LIGHT_TOGGLE { id, value }` 在 view/edit 模式均可触发，仅作用于用户点光/聚光灯（排除 directional）；实现于 **`message-bridge.ts` → `EnvironmentFacade` → `environment-protocol-adapter.ts`**（`applyLightToggleAll` / `applyLightToggle`）。
  - **（表述更新 2026-04-18）**关灯时局部亮灯合成在**观看态**随整灯闸隐藏：**`LIGHT_TOGGLE_ALL`** 写 **`global.viewSettings.bloom.localLightsEnabled`**（及用户灯 `enabled` 等），**非**存盘 `bloom.localLightsEnabled`；`bloom.ts` 在 **`applyViewerLocalLightPolicy`** 为真时建空体积并 return；`getPointsForMask()` 在观看闸关或「所有绑定灯均关」等条件下返回 `[]`；单灯关仍按 **`isLocalLightRegionVisible`** 过滤；灯光变更后需 **`postEffect:changed`** 驱动 `applyToCameraFrame`。
  - BloomController 抽取 `isLocalLightRegionVisible(region)` 私有方法，供体积合成与 `getPointsForMask` 复用。
  - View 模式顶栏调试：Toggle Assets、Lights On/Off、区域下拉 +「Toggle 区域灯」；internal 模式用顶层 `import` 引入 `applyLightToggleAll`/`applyLightToggle`，避免浏览器 `require is not defined`。

- **VFX / NightMode / 局部亮灯区域互斥修复**（2026-03-18）：
  - **问题**：LocalLightRegions（亮灯区域）通过 NightMode 的体积纹理/笔刷参与 `gsplatModifyVS`，与 Reveal/VFX 同占用同一 shader chunk，导致存在亮灯区域时 VFX 无法正常加载渲染。
  - **方案**：在 `night-mode.ts` 增加 `suspendedByVfx`，收到 `nightMode:exit` 后挂起 NightMode 对 shader 的写入并清理局部亮灯/笔刷需求；互斥期 `updateEffect` 直接 return；VFX 结束恢复时由 `nightMode:forceReapply` 解除挂起并重新应用。

- **VFX 协议与 UI 对齐（message-bridge）**（2026-03-18）：
  - `VFX_EXIT` 调整为「强制停播但保留配置」：**`effects-protocol-adapter.applyVfxExit`**（`protocol-adapters/effects-protocol-adapter.ts`）仅置 `state.vfxActive=false` 并 `events.fire('vfxExit')`，由 RevealController 销毁脚本并恢复 NightMode，但不改 `settings.revealEffect.type`。
  - `reveal-ui.ts` 新增 Stop 按钮，并在 `editUiTransport=message-bridge` 时统一走 `sendEditProtocolMessage` 下发 `VFX_TYPE_SET/VFX_RESTART/VFX_EXIT`。
  - `message-bridge.ts` 增加入站 `[MessageBridge] inbound ...` 日志，便于排查父级协议下发链路。

- **VFX 默认时长统一**（2026-03-18）：
  - 新增 `DEFAULT_VFX_TOTAL_DURATION=12` 并替换各处散落 fallback，修复 UI 默认仍显示 20s 的问题。

- **标注创建后默认选中**（2026-03-18）：
  - `AnnotationManager.confirmAnnotation()` 在“确认并放置”后默认选中新创建标注（不自动打开 Gizmo），便于连续编辑与列表高亮同步。

- **编辑模式左侧模块支持 `null`**（2026-03-19）：
  - `state.editLeftModule` 支持 `null` 表示不选中任何模块；左侧工具栏再次点击已激活项会取消选中。
  - `editLeftModule===null` 时右侧面板与底部栏隐藏；进入编辑模式默认不选模块。

- **视频导出协议：默认快速导出 + animTrack 时长 + CANCEL**（2026-03-19，**后经 2026-05-10 调整**）：
  - 历史：`VIDEO_EXPORT_START` 曾默认 WebM（captureStream + MediaRecorder），时长常与 animTrack 对齐。
  - **现行**：默认 **MP4 极速导出**（`format:'mp4'` + WebCodecs Worker），导出前 **`waitAllReady`**，**`totalDuration` 由 `resolveExportTimelinePlan`** 统一（含 VFX 默认 12s 锚、`anim` 铺满与「锚点后再一整圈 anim」等规则）；仍支持 **`VIDEO_EXPORT_CANCEL`** 与 Viewer→父级 **`VIDEO_EXPORT_*`** 出站事件。

- **showEditUI=false 首屏闪现规避**（2026-03-19）：
  - `index.html` 初始化阶段为 `<html>` 加 `hide-edit-ui`，并在 `index.scss` 中对编辑顶栏/侧栏/底栏做强制隐藏，避免首屏 UI 闪现。
- **底部栏按模块显隐与内容区分**：`edit-bottom-toolbar.ts` 根据 `editLeftModule` 动态渲染；`asset` 显示移动/旋转/缩放+复制/删除，`annotation` 显示移动/编辑/删除，`environment` 显示光源编辑按钮；仅 asset/annotation/environment 模块时显示底部栏
- **标注**：进入模块**不**默认选中；先点热点再点「移动」才显示 Gizmo；先填表单再「去放置」、十字光标放置；热点收起时标题在上方；`ANNOTATION_PLACEMENT_UPDATE` 不再主动触发
- **资产**：点击资产先进入放置态，场景点击一次完成放置（无拖拽）；Gizmo 仅选中且点击移动/旋转/缩放时显示；进入 asset 默认空选中，离开清空选中并 detach Gizmo
- **父级托管**：`hostEditUI` 隐藏内部编辑 UI，仅保留逻辑与 message-bridge；协议以 `docs/SaaS第三期 编辑模式交互职责划分.md` 为准
- **局部亮灯区域**：Bloom 面板改为 LocalLightRegion 列表 + 新建/绘制流程；多区域叠加渲染；blurLevel 0–5、BLOOM_BLUR_SET；LIGHT_BRUSH_* 仅作用当前 active 区域
- **标注编辑由底部栏触发**：`annotationEdit:show` 事件，底部栏「编辑」按钮显示右侧编辑表单
- **标注切换模块自动取消**：`editLeftModule:changed` 时，若新模块非 `annotation`，自动取消放置或编辑（恢复原数据、隐藏表单）
- **标注样式迁移**：`#annotations`、`#annotationNav` → `_annotation-ui.scss`；`.annotation-toolbar` 及表单/列表样式 → `_annotation-toolbar-ui.scss`
- **光源编辑与 Gizmo**：
  - 环境模块下引入光源 Transform Gizmo：`state.selectedLightId` / `state.lightTransformMode` 驱动 Gizmo 挂载与模式；Gizmo 结束写回 `settings.lighting.lights[*]` 并记录编辑历史
  - 环境模块底部栏新增光源操作按钮（移动 / 旋转 / 编辑 / 删除），与 Lighting 列表、Gizmo、协议 `LIGHT_SELECT` / `SCENE_LIGHT_SELECTED` 联动
- **场景点击输入抽象**：
  - `input-controller` 统一产出世界点击事件（如 `scenePointerWorldClick`），光源选中、标注放置、Bloom 画笔等均基于该事件进行 Ray Picking 和最近元素选择，解耦输入层与具体业务
- **局部亮灯区域 ↔ 光源联动**：
  - 在 `BloomSettings.localLightRegions[*]` 中引入 `linkedLightId`，完成亮灯区域与 `settings.lighting.lights[*]` 的一对一绑定：通过 **`bloomEditorSession.draftLightRegionCenter` + `activeLocalLightRegionId`** 在 Lighting 面板新建点光/聚光灯时自动写入绑定 id
  - 删除亮灯区域时在 UI（internal 模式）与 **`environment-protocol-adapter.applyBloomLocalLightRegionDelete`**（经 facade / message-bridge）中同步删除绑定光源，并在必要时清空 `state.selectedLightId` 与场景 Gizmo / Lighting 列表选中
  - 在 Bloom 面板每个亮灯区域下新增绑定光源参数面板：点光/聚光支持光照强度；聚光灯额外支持 Inner/Outer 角度与 Range；internal 模式直接写 `settings.lighting.lights` + `updatePointLightsFromSettings`，showEditUI/message-bridge 模式通过 `LIGHT_BRUSH_INTENSITY_UPDATE`、`LIGHT_BRUSH_INNER_ANGLE_SET`、`LIGHT_BRUSH_OUTER_ANGLE_SET`（以及 `LIGHT_RANGE_SET`）由 `message-bridge.ts` 分发到 `applyBloomLocalLightRegion*` 更新绑定光源
  - 右侧 Lighting / PostEffect 面板及其列表支持内部滚动，并在鼠标位于右栏区域滚动时通过 `wheel.stopPropagation()` 防止事件冒泡到画布触发相机缩放
  - `input-controller.ts` 使用 `picker.ts` 中的 `pickWorldFromClientXY` 统一实现「双击 → worldPos → pick（用于相机 frame）」与「单击 → worldPos → scenePointerWorldClick」
  - `scenePointerWorldClick` 为通用「场景世界点击」事件，当前由 `camera-manager.ts` 监听并交给 `light.ts` 的 `selectNearestLightAtPosition` 完成灯光单击选中；资产经 `asset-placement-handler` + **`scene-asset-selection-pick.ts`**（mesh：World ID 拾取；已放置高斯：**SceneAssetPick** 层）。**当 `cameraControlsEnabled===false`（例如 Gizmo 拖拽中）时，`input-controller` 不派发 `scenePointerWorldClick`**，避免松手误触发灯光/场景拾取。**同状态下须每帧 `drainBufferedInput()`**（各 `input/devices/*`）以调用 PlayCanvas 源的 `read()` 并清空累积增量，否则合并「device 分离」后会出现 **松手（pointer up）后首帧相机吃进整段拖拽缓冲** 的回归。
- **场景选中与输入分层**：`docs/场景选中与输入分层说明.md`；拾取实现细节见 **`docs/场景拾取与Picker双路径说明.md`**

---

## 10. 当前 Session 相关规划与决策

> 以下摘录自 **父级托管编辑模式重构**（`.cursor/plans/父级托管编辑模式重构_14d2b249.plan.md`）与 **局部亮灯区域改造**（`.cursor/plans/局部亮灯区域改造_61a5f86e.plan.md`）中的关键约定与已采纳决策，作为当前会话的约束与上下文。

### 10.3 Effects 双轨 GSplat 实施跟进（2026-05-13）

- **计划文档**：`.cursor/plans/effects-architecture-refactor_c7c5d9eb.plan.md` 已增「**实施跟进（双轨 GSplat + 协议 + 本地 UI，2026-05-13）**」小节，与代码对齐。
- **要点**：`EFFECT_PARAMS_PATCH` / `EFFECT_TOGGLE` / `EFFECT_REPLAY` 与 `module:'effect'`；**勿**在 `prepareExternalPersistentScriptMount` 污染 `reveal.status`；切换 reveal / `restart` 后按 `revealComplete` 或 `none` 分支补 **`persistentGsplatEffectRemountRequested`**；`onRevealComplete` 先于 `revealComplete` 写入 **`completed`**；本地 **`effects-ui.ts`** toggle 与 **`queueMicrotask`** 刷新策略。

### 10.1 父级托管编辑模式重构

- **协议唯一依据**：事件名（type）与 payload 以 `docs/SaaS第三期 编辑模式交互职责划分.md` 为准。
- **协议升级实现原则**：当文档协议已升级时，默认直接切换到新语义并清理旧分支，**不为旧协议保留兼容代码**；仅在用户明确要求时才允许临时兼容。
- **编辑模式开关**：统一使用 **`EDIT_MODE_SET { value: boolean }`** 进入/退出编辑态；**不再使用** `EDIT_MODE_ENTER` / `EDIT_MODE_EXIT`（Viewer 侧已移除对应入站处理）。
- **顶栏**：退出为两段式——父级发 `EDIT_MODE_EXIT_REQUEST`，Viewer 回传 `EDIT_EXIT_NEEDS_SAVE { value }`（基线与当前 `serializeExperienceSettings` 可比较字符串对比）；历史状态回传 `EDIT_HISTORY_STATE { canUndo, canRedo }`。进入编辑时由 **`message-bridge`** 在恢复原始配置后 **`initEditHistory`**；**`editUiTransport==='message-bridge'` 时 `ui.ts` 不重复建进入快照/历史**，避免假脏与双轨恢复。
- **左侧模块**：`EDIT_MODULE_SET { value: 'gs'|'asset'|'annotation'|'environment'|'camera'|'effects' }`；资产模块进入默认空选中（不自动选首 entity）、离开清选中与 Gizmo；标注模块进入不默认选中，仅「先点热点再点移动」显示 Gizmo，离开清 Gizmo 与选中。
- **资产**：`ASSET_PLACE { value: AssetLibraryItem }` 进入放置态并在场景单击一次完成（回传 `SCENE_ASSET_PLACED`）；`ASSET_TRANSFORM_MODE { value: 'move'|'rotate'|'scale' }` 含默认 none/undefined 以关闭 Gizmo；`ASSET_SHOW_HIDE_SET { id: string, value: boolean }` 控制单个场景资产显隐；`ASSETS_SHOW_HIDE_SET { value: boolean }` 控制场景资产整体显隐。
- **标注**：`ANNOTATION_TRANSFORM_MODE { value: 'move'|null }` 由底部「移动」触发以显式打开/关闭标注 Gizmo；Viewer 内部维护 `state.annotationTransformMode`，在用户点击其他标注热点切换选中时若仍为 move 则继续显示 Gizmo。
- **标注实时编辑**：新增 `ANNOTATION_UPDATE { id, value }`，父级表单输入过程可实时下发，Viewer 仅做场景内容预览更新；最终提交仍使用 `ANNOTATION_CONFIRM`。
- **笔刷**：仅局部颜色调制；局部区域可选 Bloom（父级 bloom slider 为 0 则不加）；`LIGHT_BRUSH_START`/`LIGHT_BRUSH_FINISH` 为起止、无 toggle；支持局部擦除；原 reset→clear、原 set→LIGHT_BRUSH_FINISH。
- **VFX**：`VFX_EXIT` 当前语义为「强制停播但保留配置」（不改 `settings.revealEffect.type`），经 `events.fire('vfxExit')` 进入 RevealController 的停播/恢复逻辑；与 `VFX_TYPE_SET { value: 'none' }` 语义区分。
- **hostEditUI**：为 true 时隐藏内部顶栏、左侧工具栏、右侧面板、底部编辑栏，仅保留逻辑与 message-bridge。
- **待办**：`VIDEO_EXPORT_START`/`VIDEO_EXPORT_END` 与现有 render.video 打通；最小父级宿主 demo 验证完整链路。

### 10.2 局部亮灯区域改造

- **数据**：`BloomSettings.localLightRegions`；**选中/笔刷/草稿中心**在 `bloomEditorSession`；每区域独立 `worldSpace`（仅 committed 持久化）、`localBrightness`、可选颜色调制。
- **交互原则**：每区域独立数据；`worldSpaceData` 仅作为当前区域工作区；体积在渲染阶段按区域叠加；擦除只影响当前区域；删除最后一区时体积清空。进入区域（含草稿）时 loadRegion 到 worldSpaceData，完成时只覆盖当前区域，放弃不回写。
- **草稿与预览**：`isDrawing` 时跳过 volume-based 路径，走 point-based 投影并令 mask 签名含 `:draw:${allPoints.length}`，实现拖动中实时预览。
- **Reset 与已有区域**：reset 时始终清空 `_lastMaskSignature`；若存在已提交区域，则不涂黑 mask、不调用 `syncCommittedToNightMode()`，由下一帧从 `localLightRegions` 重建 volume/mask。
- **blurLevel 与协议**：UI 与 `post-effect-ui` 中 slider 多为 **0–10**，`bloom.ts` 应用到 CameraFrame 时再收敛到引擎侧档位；协议 **`BLOOM_BLUR_SET`**；**`environment-protocol-adapter`** 与 **message-bridge** 均支持。
- **清空区域后纹理**：`buildCommittedBrightnessVolume` / `buildCommittedBrightnessVolumeFromRegions` 在 points 为空时若存在旧纹理，**destroy 旧纹理**并创建干净 1×1 占位（或写 0），避免残留导致「整体变暗+局部亮」。
- **message-bridge 下 UI→协议**：放弃→`LIGHT_BRUSH_CLEAR`；擦除→`LIGHT_ERASER_START`；完成→`LIGHT_BRUSH_FINISH`；删除区域→`LIGHT_BRUSH_DELETE { id }`。LIGHT_BRUSH_* 与 BLOOM 相关事件在 `editUiTransport=message-bridge` 与 `internal` 下均走对应 protocol。
- **笔刷区域世界坐标**：确保 screenToWorld、WorldSpaceBloomData 存储与 NightMode 体积/mask 渲染坐标系一致，避免切换视角后区域错位。
- **待办**：清理仓库内遗留示例配置中的旧字段痕迹（如有）。
