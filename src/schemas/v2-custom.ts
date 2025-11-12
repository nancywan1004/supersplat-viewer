type RevealEffect = {
    type?: 'radial' | 'rain' | 'smooth',
    duration?: number, // 3.0
    radius?: number, // 10
    autoStart?: boolean
}

type LodPlatform = 'desktop-max' | 'desktop' | 'mobile-max' | 'mobile'

type LodPreset = {
    range: [number, number],
    lodDistances: number[]
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

export type { RevealEffect, LodSettings, LodPreset, LodPlatform };
