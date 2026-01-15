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
    hasAR: boolean;
    hasVR: boolean;
    isFullscreen: boolean;
    controlsHidden: boolean;
    hasRevealEffect: boolean;
    showCameraPath: boolean;                    // show camera path visualization
    showCameraBoundingBox: boolean;            // show camera bounding box (animCoreBbox preferred, fallback to scene bbox)
    vfxActive: boolean;                        // VFX effect active state
    vfxType: 'none' | 'grow' | 'pieces-recover' | 'perlin-wave' | 'disintegrate' | 'integrate';  // current VFX effect type
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
