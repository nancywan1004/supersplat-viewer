import type { LodSettings, LodPreset, LodPlatform, RevealEffect, TransformFrame } from "./v2-custom";

type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness: number,
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
            fov: number[],
        }
    }
};

type CameraPose = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

type Camera = {
    initial: CameraPose,
    /**
     * 可选：相机俯仰角限制（单位：度）
     * - 默认值：[-90, 90]
     * - 第一个值为最小俯仰角（向下看的角度限制）
     * - 第二个值为最大俯仰角（向上看的角度限制）
     */
    pitchRange?: [number, number];
};

type Annotation = {
    position: [number, number, number],
    title: string,
    text: string,
    extras: any,
    camera: Camera;
};

type PostEffectSettings = {
    sharpness: {
        enabled: boolean,
        amount: number,
    },
    bloom: {
        enabled: boolean,
        intensity: number,
        blurLevel: number,
    },
    grading: {
        enabled: boolean,
        brightness: number,
        contrast: number,
        saturation: number,
        tint: [number, number, number],
    },
    vignette: {
        enabled: boolean,
        intensity: number,
        inner: number,
        outer: number,
        curvature: number,
    },
    fringing: {
        enabled: boolean,
        intensity: number
    }
};

type ExperienceSettings = {
    version: 2,
    tonemapping: 'none' | 'linear' | 'filmic' | 'hejl' | 'aces' | 'aces2' | 'neutral',
    highPrecisionRendering: boolean,
    soundUrl?: string,
    background: {
        color: [number, number, number],
        skyboxUrl?: string
    },
    postEffectSettings: PostEffectSettings,

    animTracks: AnimTrack[],
    cameras: Camera[],
    annotations: Annotation[],

    startMode: 'default' | 'animTrack' | 'annotation',

    hasStartPose?: boolean,

    revealEffect?: RevealEffect,
    lodSettings?: LodSettings,

    /**
     * 可选：相机边界策略（不影响旧 settings.json）
     * - animScale: 动画核心区域整体放大系数（>1 更宽松）
     * - enabled: 是否启用相机移动限制（默认 true）
     */
    cameraBounds?: {
        animScale?: number;
        enabled?: boolean;
    }
};

export type { AnimTrack, Camera, Annotation, PostEffectSettings, RevealEffect, LodSettings, LodPreset, LodPlatform, TransformFrame, ExperienceSettings };
