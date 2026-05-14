import type { Entity, EventHandler, AppBase, Asset } from 'playcanvas';

import type { ExperienceSettings } from './settings';
import {
    type AssetEffectRuntimeStatus,
    type RevealEffectRuntimeStatus,
    type PersistentEffectRuntimeStatus,
    PERSISTENT_EFFECT_TYPE_VALUES,
    REVEAL_EFFECT_TYPE_VALUES
} from './vfx/effects-runtime/effect-types';

export { PERSISTENT_EFFECT_TYPE_VALUES, REVEAL_EFFECT_TYPE_VALUES };

/** 一次性 reveal 类型（含 none） */
export type RevealEffectType = 'none' | (typeof REVEAL_EFFECT_TYPE_VALUES)[number];

/** 可持续 persistent 类型 */
export type PersistentEffectType = 'none' |(typeof PERSISTENT_EFFECT_TYPE_VALUES)[number];

/**
 * 与 `settings.effects` 对应的运行态快照（不入库）；由导入/快照与 reveal 管线同步更新。
 * **reveal 轨**：`activeType` / `status` 为真源（reveal 无 pause）。
 * **persistent 轨**：**仅**用 `status: PersistentEffectRuntimeStatus` 表达运行态（`inactive/playing/paused`）；不再额外维护 `enabled` / `effectPaused`。
 */
export type EffectsRuntimeState = {
    reveal: {
        /** scene reveal 固定 effectId（当前写死为 `scene.gsplat-reveal`） */
        activeEffectId: string;
        /** 当前 scene reveal 类型，由 `syncEffectsRuntimeStateFromSettings` 与 `readRevealParams` 对齐 `settings.effects.reveal` */
        activeType?: RevealEffectType;
        status: RevealEffectRuntimeStatus;
    };
    persistent: {
        /** scene persistent 固定 effectId（当前写死为 `scene.gsplat-reveal`） */
        activeEffectId: string;
        /** 当前运行中的 persistent 类型（无则为 `undefined`） */
        activeType?: PersistentEffectType;
        /** 可持续轨状态真源；`inactive` 表示未激活 */
        status: PersistentEffectRuntimeStatus;
    };
    asset: { instances: Record<string, { effectId: string; status: AssetEffectRuntimeStatus }> };
    lastError?: { code: string; message: string; effectId?: string; command?: string };
};

/** 资产库项类型 */
export type AssetLibraryType = 'image' | 'mesh' | 'gaussian';

/** 资产库单项（上传后的资产） */
export interface AssetLibraryItem {
    id: string;
    type: AssetLibraryType;
    name: string;
    filename?: string;
    url?: string;
    file?: File;
    asset?: Asset;
    thumbnailUrl?: string;
}

/** 场景中已放置的可编辑实体项 */
export interface ScenePlacedItem {
    id: string;
    name: string;
    entity: Entity;
    visible: boolean;
    /** 对应资产库类型（用于 serialize） */
    assetType?: AssetLibraryType;
    /** 对应上传资产库中的条目 id（用于 serialize） */
    assetId?: string;
    /** 资产源文件名（可选，便于调试 / 保存） */
    filename?: string;
    /** 资产源 url（用于 serialize 到 settings.sceneAssets.source.url） */
    url?: string;
    /** 对应源资产库条目的缩略图 URL（serialize 到 settings.sceneAssets.thumbnailUrl） */
    thumbnailUrl?: string;
}

type CameraMode = 'orbit' | 'anim' | 'fly' | 'walk';

type InputMode = 'desktop' | 'touch';

/** 编辑模式左侧工具箱当前选中的模块 */
type EditLeftModule = 'gs' | 'asset' | 'annotation' | 'environment' | 'camera' | 'effects';

/** 资产变换模式（移动/旋转/缩放） */
type AssetTransformMode = 'move' | 'rotate' | 'scale';

/** 光源变换模式（移动/旋转） */
type LightTransformMode = 'move' | 'rotate' | null;
type AnnotationTransformMode = 'move' | null;
/** 统一选中来源（用于防循环与回传语义） */
type SelectionSource = 'host' | 'scene' | 'unknown';

/** Facade 生命周期触发原因 */
type ModuleLifecycleReason = 'editModuleChange' | 'editModeExit' | 'dispose';

/** 编辑模块生命周期上下文（契约层，供 facade/orchestrator 使用） */
interface ModuleContext {
    global: Global;
    state: State;
    events: EventHandler;
    activeModule: EditLeftModule | null;
    editMode: boolean;
}

/** 统一模块命令（协议映射/UI事件收敛后的标准命令） */
interface ModuleCommand<TPayload = unknown> {
    type: string;
    payload?: TPayload;
    source?: SelectionSource;
}

/** 编辑模块 facade 统一契约（仅类型约束） */
interface ModuleFacade {
    readonly module: EditLeftModule;
    onEnter(ctx: ModuleContext): void;
    onExit(ctx: ModuleContext, reason?: ModuleLifecycleReason): void;
    onEditModeExit(ctx: ModuleContext): void;
    onPreviewModeChanged?(ctx: ModuleContext, previewMode: boolean): void;
    handleCommand<TPayload = unknown>(ctx: ModuleContext, command: ModuleCommand<TPayload>): void;
    selectById(ctx: ModuleContext, id: string | null, source: SelectionSource, options?: Record<string, unknown>): void;
    dispose?(ctx: ModuleContext): void;
}

// configuration options are immutable at runtime
type Config = {
    poster?: HTMLImageElement;
    skyboxUrl?: string;
    contentUrl?: string;
    contents?: Promise<Response>;
    collisionUrl?: string;

    noui: boolean;
    noBottomUI: boolean;                        // hide bottom UI controls, but keep poster and loading bar
    noanim: boolean;
    noautorotate: boolean;
    nofx: boolean;                              // disable post effects
    hpr?: boolean;                              // override highPrecisionRendering (undefined = use settings)
    ministats: boolean;
    colorize: boolean;                          // render with LOD colorization
    fullload: boolean;                          // load all streaming LOD data before first frame
    aa: boolean;                                // render with antialiasing
    noreveal: boolean;                          // disable reveal effect transition animation
    showCameraPathVisualizer?: boolean;         // show camera path visualization
    /** 接影几何 GLB 的 URL（如 /assets/mesh/gabriel.glb），由 urlParam splatMesh 传入；无则用平面 */
    splatMeshUrl?: string;
    /** 是否允许进入编辑模式（默认 true）；设为 false 时不显示编辑按钮且不响应进入编辑的 postMessage */
    allowEditMode?: boolean;
    /** 是否启用编辑历史与撤销/重做（默认 false）；为 true 时才会记录历史并显示撤销/重做按钮及快捷键 */
    trackEditHistory?: boolean;
    /** 是否显示内部编辑 UI（默认 true）；为 false 时不挂载顶部菜单、左侧工具栏、右侧面板、底部编辑工具栏，由父级通过 postMessage 驱动 */
    showEditUI?: boolean;
    /**
     * 内部编辑 UI 的驱动方式（默认 internal）。
     * - internal：多数模块仍直连 state/events；**effects 轨**经 `CommandRegistry` → `EffectsFacade`（与 bridge 解码后同路径，M18）。
     * - message-bridge：UI 通过 window.postMessage 发送协议命令，由 src/message-bridge.ts 统一映射到内部逻辑
     *   主要用于 E2E 抓包对齐 docs 中的 postMessage 事件表（即使 showEditUI === true 也能强制走协议）
     */
    editUiTransport?: 'internal' | 'message-bridge';
    /**
     * 是否禁用相机边界约束（默认 false）。
     * - false 或未设置：遵循 settings.cameraBounds.enabled（默认启用）
     * - true：强制关闭 CameraManager 的 box 约束（orbit/fly 都不再被场景 bbox 限制）
     */
    disableCameraBounds?: boolean;
    webgpu: boolean;                            // use WebGPU device
    /** 父级透传的项目 ID（用于保存上传） */
    projectId?: string | number;
    /** 父级透传的 token（用于保存上传鉴权） */
    token?: string;
    budget?: number;                            // override splat budget in millions (overrides platform + performanceMode table)
    renderer: 'webgl' | 'cpu-sort' | 'gpu-sort' | 'compute';
    heatmap: boolean;                           // render heatmap debug overlay (WebGPU only)
};

// observable state that can change at runtime
type State = {
    loaded: boolean;                            // true once first frame is rendered
    readyToRender: boolean;                     // don't render till this is set
    performanceMode: boolean;
    progress: number;                           // content loading progress 0-100
    inputMode: InputMode;
    cameraMode: CameraMode;
    hasAnimation: boolean;
    animationDuration: number;
    animationTime: number;
    animationPaused: boolean;
    animationStarted: boolean;                  // true once animation has been started (e.g. after reveal or at progress threshold)
    hasAR: boolean;
    hasVR: boolean;
    hasCollision: boolean;
    hasCollisionOverlay: boolean;
    collisionOverlayEnabled: boolean;
    isFullscreen: boolean;
    controlsHidden: boolean;
    hasRevealEffect: boolean;
    showCameraPath: boolean;                    // show camera path visualization
    showCameraBoundingBox: boolean;            // show camera bounding box (animCoreBbox preferred, fallback to scene bbox)
    syncAnimTrackOnExport?: boolean;           // 导出 VFX 视频时是否同步重播动画轨道（由 reveal-ui 设置，video-export-ui 读取）
    editMode: boolean;                         // true = 编辑模式（显示 rightToolBar），false = 观看模式
    /** 编辑预览模式：true 时隐藏编辑调试组件（操作轴、光源线框） */
    previewMode?: boolean;
    /** 左侧工具箱当前模块；null 表示不选中任何模块 */
    editLeftModule?: EditLeftModule | null;
    assetTransformMode?: AssetTransformMode;   // 资产变换模式，默认 'move'
    /** 已上传的资产库列表 */
    uploadedAssets?: AssetLibraryItem[];
    /** 场景中已放置的可编辑实体列表 */
    scenePlacedEntities?: ScenePlacedItem[];
    /** 当前选中的场景实体 id（用于列表高亮、Gizmo、复制删除；实体通过 getSelectedSceneEntity(state) 获取） */
    selectedSceneEntityId?: string | null;
    /** 相机输入是否启用（用于与 Gizmo 交互互斥） */
    cameraControlsEnabled?: boolean;
    /** 当前选中的标注 ID */
    selectedAnnotationId?: string | null;
    /** 标注变换模式（与标注模块底部「移动」按钮联动） */
    annotationTransformMode?: AnnotationTransformMode | null;
    /** 当前选中的光源 ID（用于环境模块光照编辑、Gizmo 挂载与列表/场景联动） */
    selectedLightId?: string | null;
    /** 光源变换模式（与环境模块底部工具栏联动） */
    lightTransformMode?: LightTransformMode | null;
    gamingControls: boolean;
    /**
     * 特效运行态（与 `settings.effects` 三轨对齐）；不入 `settings.json`。
     * reveal 写入 `patchRevealRuntimeMirror`；persistent 暂停写入 `patchPersistentRuntimeMirror`。
     */
    effectsRuntimeState?: EffectsRuntimeState;
};

/**
 * 观看态/会话级「视图设置」：与 `global.settings`（`ExperienceSettings`）**并列**、**不入库**。
 * 只放「Viewer 里需要单独持有一份、又不能写回 JSON」的字段；由 `Viewer` 注入，编辑态通常不存在。
 */
export type ViewSettings = {
    bloom: {
        /**
         * 整场景用户灯总闸在观看态的**仅内存**镜像（`LIGHT_TOGGLE_ALL` → `applyLightToggleAll` 写入）；
         * **不从 settingsJson 读、不存盘**；旧键 `postEffectSettings.bloom.localLightsEnabled` 在导入时剥离。
         * Viewer 构造默认 `true`，关灯后为 `false`。
         */
        localLightsEnabled: boolean;
    };
    /**
     * 标注显隐状态（View 模式专属，不入库）
     * - `ASSETS_SHOW_HIDE_SET` 切换资产显隐时同步更新
     * - `revealComplete` 等恢复 deferred layers 时参考此状态决定是否恢复标注可见性
     * - 编辑态通常不存在此字段，由模块自身控制
     */
    annotationsVisible?: boolean;
};

type Global = {
    app: AppBase;
    settings: ExperienceSettings;
    config: Config;
    state: State;
    events: EventHandler;
    camera: Entity;
    /** 见 {@link ViewSettings} */
    viewSettings?: ViewSettings;
};

export {
    CameraMode,
    InputMode,
    EditLeftModule,
    AssetTransformMode,
    LightTransformMode,
    AnnotationTransformMode,
    SelectionSource,
    ModuleLifecycleReason,
    ModuleContext,
    ModuleCommand,
    ModuleFacade,
    Config,
    State,
    Global
};
