import type { LodSettings, LodPreset, LodPlatform, RevealEffect, TransformFrame, PointLightConfig, LightingSettings } from "./v2-custom";

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
        /** 亮度阈值，仅高于此值的像素参与 bloom 柔光，0-1 */
        threshold: number,
        /** 仅显示参与 bloom 的高斯点（调试用） */
        bloomDebug: boolean,
        /** 2D 笔刷局部 bloom：仅在笔刷区域叠加光晕，与 bloomDebug 互斥 */
        bloomBrush: boolean,
        bloomBrushSize: number,
        /** Bloom 模式：'screen' = 屏幕空间（默认），'world' = 世界空间 */
        bloomMode?: 'screen' | 'world',
        /** 世界空间 bloom 数据（序列化后的 WorldSpaceBloomData），仅当 bloomMode='world' 时有效 */
        worldSpacePoints?: {
            points: Array<{ position: [number, number, number], radius: number, intensity: number }>,
            committed: Array<{ position: [number, number, number], radius: number, intensity: number }>
        },
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
    },
    /** 地面阴影（与 SHADOW_SYSTEM_复用说明 一致：ShadowCatcher + ShadowApply postrender 叠阴影） */
    shadow: {
        enabled: boolean,
        /** 阴影强度 0~1，越小阴影越淡 */
        darken: number,
        /** 调试：true 时全屏显示 RT 内容（R 通道灰度） */
        debugRt?: boolean,
        /** 调试：true 时显示接影平面几何（半透明绿色），用于确认平面位置与范围 */
        debugVisual?: boolean,
        /** 是否投射阴影，默认false */
        castShadows?: boolean
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
     * 可选：光照配置（点光源列表，上限 10 个）
     * 用于夜间模式等效果，每项包含 position / color / intensity
     */
    lighting?: LightingSettings,

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

export type { AnimTrack, Camera, Annotation, PostEffectSettings, RevealEffect, LodSettings, LodPreset, LodPlatform, TransformFrame, ExperienceSettings, PointLightConfig, LightingSettings };
