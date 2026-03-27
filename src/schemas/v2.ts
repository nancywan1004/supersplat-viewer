import type { LodSettings, LodPreset, LodPlatform, RevealEffect, TransformFrame, PointLightConfig, DirectionalLightConfig, SpotLightConfig, LightingSettings, SceneAsset, LocalLightRegion, WorldSpaceBloomRegionJSON } from "./v2-custom";

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
    id: string,
    position: [number, number, number],
    title: string,
    text: string,
    imageUrl?: string,
    showTitleWhenCollapsed: boolean,
    collapsed: boolean,
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
        /** Bloom 管线范围：'global' 全屏辉光，'local' 仅局部亮灯区域参与 compose mask */
        bloomScope?: 'global' | 'local';
        /** 2D 笔刷局部 bloom：仅在笔刷区域叠加光晕，与 bloomDebug 互斥 */
        bloomBrush: boolean,
        bloomBrushSize: number,
        /** 当前绘制会话局部亮度 -1～1（草稿/编辑态滑块） */
        bloomBrushBrightness?: number,
        /**
         * 可选：局部亮灯区域列表。
         * - 首版策略：一次只激活一个 LocalLightRegion；
         * - 未来可扩展为多区域叠加。
         */
        localLightRegions?: LocalLightRegion[];
        /**
         * 当前激活的 LocalLightRegion ID。
         * - null 或 undefined 表示没有激活区域。
         */
        activeLocalLightRegionId?: string | null;
        /**
         * 最近一次完成绘制的 LocalLightRegion 的世界空间中心位置：
         * - 由 Bloom 绘制完成（点击「完成」）时，根据该区域的 worldSpace 点集计算得到；
         * - 用于后续在 Lighting 面板中新建点光源/聚光灯时，优先将光源放置在该中心位置；
         * - 使用一次后应被重置为 null，避免长期干扰后续创建。
         */
        draftLightRegionCenter?: [number, number, number] | null;
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
        castShadows?: boolean,
        /** 光源方向俯仰角（度），用于序列化还原 */
        lightPitch?: number,
        /** 光源方向偏航角（度），用于序列化还原 */
        lightYaw?: number,
        /** 阴影 bias，用于序列化还原 */
        shadowBias?: number,
        /** 调试球体半径，用于序列化还原 */
        sphereRadius?: number
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
     * 可选：场景亮度配置（保存/加载时序列化）
     * - fade: 全局亮度 -1~1，负值变暗、正值变亮、0 不变（仅用滑块控制，无开关）
     * - enabled: 已废弃，仅用于兼容旧配置；新配置只保存 fade
     */
    nightMode?: {
        fade?: number;
        enabled?: boolean;
    };

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

    /**
     * 可选：场景中放置的资产列表（编辑模式添加的 mesh / gaussian / image）
     * - 每一项记录类型、来源 url 以及在世界空间中的变换
     */
    sceneAssets?: SceneAsset[];
};

export type {
    AnimTrack,
    Camera,
    Annotation,
    PostEffectSettings,
    RevealEffect,
    LodSettings,
    LodPreset,
    LodPlatform,
    TransformFrame,
    ExperienceSettings,
    PointLightConfig,
    DirectionalLightConfig,
    SpotLightConfig,
    LightingSettings,
    WorldSpaceBloomRegionJSON,
    LocalLightRegion,
};
