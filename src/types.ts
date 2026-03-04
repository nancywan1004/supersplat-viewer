import type { Entity, EventHandler, AppBase, Asset } from 'playcanvas';

import type { ExperienceSettings } from './settings';

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
}

type CameraMode = 'orbit' | 'anim' | 'fly';

type InputMode = 'desktop' | 'touch';

/** 编辑模式左侧工具箱当前选中的模块 */
type EditLeftModule = 'gs' | 'asset' | 'annotation' | 'environment' | 'camera' | 'effects';

/** 资产变换模式（移动/旋转/缩放） */
type AssetTransformMode = 'move' | 'rotate' | 'scale';

// configuration options are immutable at runtime
type Config = {
    poster?: HTMLImageElement;
    skyboxUrl?: string;
    contentUrl?: string;
    contents?: Promise<Response>;

    noui: boolean;
    noBottomUI: boolean;                        // hide bottom UI controls, but keep poster and loading bar
    noanim: boolean;
    noautorotate: boolean;
    nofx: boolean;                              // disable post effects
    hpr?: boolean;                              // override highPrecisionRendering (undefined = use settings)
    ministats: boolean;
    colorize: boolean;                          // render with LOD colorization
    unified: boolean;                           // force unified rendering mode
    aa: boolean;                                // render with antialiasing
    noreveal: boolean;                          // disable reveal effect transition animation
    showCameraPathVisualizer?: boolean;         // show camera path visualization
    /** 接影几何 GLB 的 URL（如 /assets/mesh/gabriel.glb），由 urlParam splatMesh 传入；无则用平面 */
    splatMeshUrl?: string;
    /** 是否允许进入编辑模式（默认 true）；设为 false 时不显示编辑按钮且不响应进入编辑的 postMessage */
    allowEditMode?: boolean;
    webgpu: boolean;                            // use WebGPU device
    gpusort: boolean;                           // use GPU sorting for splats
};

// observable state that can change at runtime
type State = {
    loaded: boolean;                            // true once first frame is rendered
    readyToRender: boolean;                     // don't render till this is set
    hqMode: boolean;
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
    isFullscreen: boolean;
    controlsHidden: boolean;
    hasRevealEffect: boolean;
    showCameraPath: boolean;                    // show camera path visualization
    showCameraBoundingBox: boolean;            // show camera bounding box (animCoreBbox preferred, fallback to scene bbox)
    vfxActive: boolean;                        // VFX effect active state
    vfxType: 'none' | 'radial' | 'rain' | 'rain_v2' | 'smooth' | 'pieces-recover' | 'perlin-wave' | 'integrate' | 'growth-wave' | 'sketch';  // current effect type (includes reveal and VFX)
    syncAnimTrackOnExport?: boolean;           // 导出 VFX 视频时是否同步重播动画轨道（由 reveal-ui 设置，video-export-ui 读取）
    editMode: boolean;                         // true = 编辑模式（显示 rightToolBar），false = 观看模式
    editLeftModule?: EditLeftModule;           // 左侧工具箱当前模块，默认 'environment'
    assetTransformMode?: AssetTransformMode;   // 资产变换模式，默认 'move'
    /** 已上传的资产库列表 */
    uploadedAssets?: AssetLibraryItem[];
    /** 场景中已放置的可编辑实体列表 */
    scenePlacedEntities?: ScenePlacedItem[];
    /** 当前选中的场景实体 id（用于列表高亮、Gizmo、复制删除；实体通过 getSelectedSceneEntity(state) 获取） */
    selectedSceneEntityId?: string | null;
    /** 相机输入是否启用（用于与 Gizmo 交互互斥） */
    cameraControlsEnabled?: boolean;
};

type Global = {
    app: AppBase;
    settings: ExperienceSettings;
    config: Config;
    state: State;
    events: EventHandler;
    camera: Entity;
};

export { CameraMode, InputMode, EditLeftModule, AssetTransformMode, Config, State, Global };
