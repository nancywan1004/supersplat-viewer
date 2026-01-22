type RevealEffect = {
    type?: 'radial' | 'rain' | 'rain_v2' | 'smooth' | 'pieces-recover' | 'perlin-wave' | 'integrate' | 'growth-wave' | 'none',
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

export type { RevealEffect, LodSettings, LodPreset, LodPlatform, TransformFrame };
