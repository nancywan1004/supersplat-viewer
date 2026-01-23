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
     * - enabled: 是否启用相机移动限制（默认 true）
     * - animScaleX: X 轴方向的缩放系数（可选，仅在有动画路径时生效）
     *   可以是单个数值（左右相同）或数组 [left, right]（分别设置左右缩放，默认 1.5）
     * - animScaleY: Y 轴方向的缩放系数（可选，仅在有动画路径时生效）
     *   可以是单个数值（上下相同）或数组 [top, bottom]（分别设置上下缩放，默认 1.5）
     */
    cameraBounds?: {
        enabled?: boolean;
        animScaleX?: number | [number, number];
        animScaleY?: number | [number, number];
    };

    /**
     * 可选：初始相机模式
     * - 'orbit': 轨道模式（默认）
     * - 'fly': 飞行模式
     * - 如果不设置或没有动画，默认为 'orbit'
     * - 如果有动画，默认为 'anim'
     */
    initialCameraMode?: 'orbit' | 'fly';
};

export type { AnimTrack, Camera, Annotation, PostEffectSettings, RevealEffect, LodSettings, LodPreset, LodPlatform, TransformFrame, ExperienceSettings };
