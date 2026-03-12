type RevealEffect = {
    type?: 'radial' | 'rain' | 'rain_v2' | 'smooth' | 'pieces-recover' | 'perlin-wave' | 'integrate' | 'growth-wave' | 'sketch' | 'none',
    radius?: number, // 10
    autoStart?: boolean,
    totalDuration?: number // 总时长（秒），用于 rain_v2, pieces-recover, integrate, growth-wave 四个特效，默认 15 秒
}

type LodPlatform = 'desktop-max' | 'desktop' | 'mobile-max' | 'mobile'

type LodPreset = {
    range: [number, number],
    lodDistances: number[],
    splatBudget?: number
}

type LodSettings = {
    presets?: Record<LodPlatform, LodPreset>,
    lodUpdateDistance?: number, // 0.5
    lodUnderfillLimit?: number, // 5
    cameraPosition?: number[], // [[10.3, 2, -10]
    eulerAngles?: number[], //[-90, 0, 0]
    moveSpeed?: number, // 4
    moveFastSpeed?: number, // 15
    enableOrbit?: boolean, // false
    enablePan?: boolean, // false
    focusPoint?: number[], // [12, 3, 0]
    [key: string]: any;
}

type TransformFrame = {
    id: number,
    img_name: string,
    width: number,
    height: number,
    position: [number, number, number],
    rotation: [[number, number, number], [number, number, number], [number, number, number]],
    fy: number,
    fx: number
}

/**
 * Lighting 配置（自定义扩展字段）
 * - 用于 settings.json 中配置点光源、平行光等
 */
type PointLightConfig = {
    position: [number, number, number],
    color: [number, number, number],
    intensity: number,
    /** 是否启用该光源，默认 true */
    enabled?: boolean
};

/** 平行光配置（主方向光/太阳，无位置概念，仅方向；用于阴影等）。阴影开关由 postEffectSettings.shadow.enabled 统一控制。 */
type DirectionalLightConfig = {
    type: 'directional',
    /** 仅用于锥体可视化与阴影相机参考，默认 [0, 8, 8] */
    position?: [number, number, number],
    color: [number, number, number],
    intensity: number,
    pitch?: number,
    yaw?: number,
    shadowBias?: number,
    enabled?: boolean
};

/** 聚光灯配置：有位置 + 方向，局部锥形照明 */
type SpotLightConfig = {
    type: 'spot',
    position: [number, number, number],
    color: [number, number, number],
    intensity: number,
    /** 俯仰角（度），默认 -45 */
    pitch?: number,
    /** 偏航角（度），默认 0 */
    yaw?: number,
    /** 内锥角（度），默认 25 */
    innerConeAngle?: number,
    /** 外锥角（度），默认 45 */
    outerConeAngle?: number,
    /** 照射范围（世界单位），默认 10 */
    range?: number,
    enabled?: boolean
};

type LightingSettings = {
    /** 点光源 + 平行光（最多一个） + 聚光灯 */
    lights: (PointLightConfig | DirectionalLightConfig | SpotLightConfig)[]
};

/**
 * 世界空间 Bloom 区域的序列化结构，
 * 需与 WorldSpaceBloomData.toJSON() 保持兼容。
 */
type WorldSpaceBloomRegionJSON = {
    points: Array<{
        position: [number, number, number],
        radius: number,
        intensity: number,
    }>,
    committed: Array<{
        position: [number, number, number],
        radius: number,
        intensity: number,
    }>,
    committedBrightness?: number,
};

/**
 * 单个局部亮灯区域配置。
 */
type LocalLightRegion = {
    /** 稳定 ID，用于内部引用与父级托管 */
    id: string;
    /** 列表显示名称，例如「亮灯区域01」 */
    name: string;
    /** 世界空间 Bloom 区域数据（与 WorldSpaceBloomData.toJSON 兼容） */
    worldSpace: WorldSpaceBloomRegionJSON;
    /**
     * 区域局部亮度 -1～1：
     * - 0 不变
     * - <0 调暗
     * - >0 调亮
     */
    localBrightness: number;
};

type SceneAsset = {
    id: string,
    type: 'image' | 'mesh' | 'gaussian',
    name: string,
    visible: boolean,
    source: {
        assetId?: string,
        filename?: string,
        url?: string
    },
    transform: {
        position: [number, number, number],
        rotation: [number, number, number],
        scale: [number, number, number]
    }
}

export type { RevealEffect, LodSettings, LodPreset, LodPlatform, TransformFrame, PointLightConfig, DirectionalLightConfig, SpotLightConfig, LightingSettings, SceneAsset, LocalLightRegion, WorldSpaceBloomRegionJSON };
