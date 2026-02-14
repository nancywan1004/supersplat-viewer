import type { Entity, EventHandler, AppBase } from 'playcanvas';

import type { ExperienceSettings } from './settings';

type CameraMode = 'orbit' | 'anim' | 'fly';

type InputMode = 'desktop' | 'touch';

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
};

// observable state that can change at runtime
type State = {
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
};

type Global = {
    app: AppBase;
    settings: ExperienceSettings;
    config: Config;
    state: State;
    events: EventHandler;
    camera: Entity;
};

export { CameraMode, InputMode, Config, State, Global };
