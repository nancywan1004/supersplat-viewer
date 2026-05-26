import {
    getPersistentEffectParamKeys,
    getPersistentParamFieldKind
} from '../../vfx/effects-runtime/persistent/persistent-effect-params';
import { SPARKLE_DEFAULT_LIGHT_TINTS } from '../../vfx/effects-runtime/persistent/gsplat-sparkle-twinkle';
import {
    getRevealEffectParamKeys,
    getRevealParamFieldKind,
    type RevealParamFieldKind
} from '../../vfx/effects-runtime/reveal/reveal-effect-params';

export type EffectParamKind = RevealParamFieldKind | 'vec3';

export interface EffectParamUiSpec {
    key: string;
    label: string;
    kind: EffectParamKind;
    min?: number;
    max?: number;
    step?: number;
    default?: number | boolean | [number, number, number] | [number, number];
}

type NumberRange = Pick<EffectParamUiSpec, 'min' | 'max' | 'step' | 'default'>;

const REVEAL_PARAM_LABELS: Record<string, string> = {
    speed: '速度',
    acceleration: '加速度',
    delay: '延迟 (s)',
    maxEndRadius: '参与半径上界',
    oscillationIntensity: '振荡强度',
    dotTint: '点阵色调',
    waveTint: '波前色调',
    distance: '雨区距离',
    endRadius: '影响半径',
    flightTime: '飞行时间 (s)',
    rainSize: '雨点大小',
    rotation: '旋转量',
    fallTintIntensity: '下落 tint 强度',
    hitDuration: '触地时长 (s)',
    fallTint: '下落色调',
    hitTint: '触地色调',
    intensity: '强度',
    riseTintIntensity: '上升 tint 强度',
    riseTint: '上升色调',
    bottomY: '起始 Y',
    rainHeight: '雨层厚度',
    maxDist2D: '最大 xz 距离',
    timeScale: '时间缩放',
    maxRadius: '球形半径',
    fadeWidthRatio: '过渡带比例',
    transitionEffect: '过渡形态',
    growthSpeed: '增长速度',
    scatterDistance: '飞散距离',
    scatterDuration: '飞散时长 (s)',
    holdDuration: '悬停时长 (s)',
    recoverDuration: '收回时长 (s)',
    noiseIntensity: '噪声强度',
    scatterDirection: '飞散方向',
    maxScatterRadius: '飞散上限',
    waveSpeed: '波速',
    springStiffness: '回弹刚度',
    waveSpeedDistScale: '波速距离修正',
    pointSize: '点尺寸',
    pointSizeScaleByScene: '按场景缩放点',
    scatterIntensity: '飞散强度',
    tangentTwist: '切向扭转',
    radialExpand: '径向膨胀',
    smokeDrift: '烟状漂移',
    waveFrequency: '波前频率',
    waveAmplitude: '径向振幅',
    verticalSpread: '竖向 spread',
    aabbMin: 'AABB 最小',
    aabbMax: 'AABB 最大',
    aabbXZMin: 'XZ 最小',
    aabbXZMax: 'XZ 最大',
    growthDuration: '生长时长 (s)',
    minSize: '最小尺寸',
    pointSizeAdaptiveScale: '远点放大',
    minScreenPointPx: '屏幕像素地板',
    screenFloorMaxScale: '视距最大放大',
    densityAnchorMin: '密度锚点低',
    densityAnchorMax: '密度锚点高',
    densityInfluence: '密度补偿',
    topY: '生长顶 Y',
    edgeAreaMin: '边缘区 min',
    edgeAreaMax: '边缘区 max',
    edgeAnisoMin: '边缘各向异性 min',
    phase1CloudTint: 'Phase1 点云色',
    phase2HaloTint: 'Phase2 金环色',
    sketchDuration: '素描时长 (s)',
    colorizeDuration: '上色时长 (s)',
    sketchIntensity: '素描浓度',
    sketchContrast: '素描对比',
    draftFeel: '草图感',
    shadeLevels: '明暗层数',
    hatchDensity: '排线密度',
    hatchStrength: '排线强度',
    paperTintAmount: '纸色混合',
    paperTint: '画纸色',
    grainFreq: '颗粒频率',
    grainAmp: '颗粒振幅',
    colorizeSharpness: '上色锐度',
    colorizeSpread: '上色扩散',
    colorizeDensity: '上色密度',
    colorizeAlphaGrain: 'Alpha 颗粒',
    useCameraDistance: '相机距离模式',
    wavelength: '波长',
    scaleBlend: '尺度混合',
    center: '效果原点'
};

const REVEAL_NUMBER_RANGES: Record<string, NumberRange> = {
    speed: { min: 0, max: 20, step: 0.1, default: 5 },
    acceleration: { min: 0, max: 10, step: 0.1, default: 0 },
    delay: { min: 0, max: 5, step: 0.05, default: 0.5 },
    maxEndRadius: { min: 1, max: 200, step: 1, default: 50 },
    oscillationIntensity: { min: 0, max: 1, step: 0.01, default: 0 },
    intensity: { min: 0, max: 1, step: 0.01, default: 0.8 },
    fallTintIntensity: { min: 0, max: 1, step: 0.01, default: 0.5 },
    riseTintIntensity: { min: 0, max: 1, step: 0.01, default: 0.6 },
    fadeWidthRatio: { min: 0.01, max: 1, step: 0.01, default: 0.2 },
    shadeLevels: { min: 1, max: 16, step: 1, default: 4 },
    waveAmplitude: { min: 0, max: 2, step: 0.01, default: 0.5 },
    wavelength: { min: 0, max: 100, step: 0.1, default: 2.5 },
    waveSpeed: { min: 0, max: 5, step: 0.01, default: 0.5 },
    waveFrequency: { min: 0, max: 10, step: 0.01, default: 1 },
    scaleBlend: { min: 0, max: 1, step: 0.01, default: 0.75 }
};

const COLOR_DEFAULTS: Record<string, [number, number, number]> = {
    dotTint: [0, 1, 1],
    waveTint: [1, 0.5, 0],
    fallTint: [0.5, 0.7, 1],
    hitTint: [1, 0.8, 0.2],
    riseTint: [0.4, 0.6, 1],
    phase1CloudTint: [0.18, 0.45, 1],
    phase2HaloTint: [1, 0.82, 0.52],
    paperTint: [0.95, 0.92, 0.85]
};

const labelForKey = (key: string): string => REVEAL_PARAM_LABELS[key] ?? key;

const buildRevealSpec = (key: string): EffectParamUiSpec => {
    const kind = getRevealParamFieldKind(key);
    const base: EffectParamUiSpec = { key, label: labelForKey(key), kind };
    if (kind === 'color') {
        base.default = COLOR_DEFAULTS[key] ?? [1, 1, 1];
        return base;
    }
    if (kind === 'boolean') {
        base.default = false;
        return base;
    }
    if (kind === 'vec3') {
        base.step = 0.1;
        base.default = key === 'scatterDirection' ? [0, 1, 0] : [0, 0, 0];
        return base;
    }
    if (kind === 'vec2xz') {
        base.step = 0.1;
        return base;
    }
    const range = REVEAL_NUMBER_RANGES[key];
    if (range) {
        return { ...base, ...range };
    }
    return { ...base, min: 0, max: 100, step: 0.01 };
};

const PERSISTENT_PARAM_LABELS: Record<string, string> = {
    intensity: '颜色强度',
    waveAmplitude: '位移振幅',
    waveFrequency: '空间频率',
    wavelength: '波长 (世界单位)',
    waveSpeed: '动画速度',
    scaleBlend: '尺度混合',
    center: '效果原点',
    pointSize: '光点大小',
    sparkleDensity: '光点密度',
    twinkleSpeed: '闪烁速度',
    twinkleMin: '最暗亮度',
    twinkleSharpness: '闪烁锐利度',
    brightness: '亮度',
    lightTint1: '光点颜色 1',
    lightTint2: '光点颜色 2',
    lightTint3: '光点颜色 3',
    colorBlendMode: '颜色混合'
};

const PERSISTENT_NUMBER_RANGES: Record<string, NumberRange> = {
    pointSize: { min: 0.002, max: 0.1, step: 0.001, default: 0.02 },
    sparkleDensity: { min: 0, max: 1, step: 0.05, default: 0.5 },
    twinkleSpeed: { min: 0, max: 10, step: 0.1, default: 5 },
    twinkleMin: { min: 0, max: 0.5, step: 0.05, default: 0 },
    twinkleSharpness: { min: 0.5, max: 8, step: 0.1, default: 3 },
    brightness: { min: 0.2, max: 5, step: 0.1, default: 2 }
};

const buildPersistentSpec = (key: string): EffectParamUiSpec => {
    const kind = getPersistentParamFieldKind(key);
    const base: EffectParamUiSpec = { key, label: PERSISTENT_PARAM_LABELS[key] ?? labelForKey(key), kind };
    if (kind === 'color') {
        base.step = 0.01;
        const sparkleTint = SPARKLE_DEFAULT_LIGHT_TINTS[key as keyof typeof SPARKLE_DEFAULT_LIGHT_TINTS];
        base.default = sparkleTint ? [...sparkleTint] : [1, 1, 1];
        base.min = 0;
        base.max = 2;
        return base;
    }
    if (kind === 'boolean') {
        base.default = false;
        return base;
    }
    if (kind === 'vec3') {
        base.step = 0.1;
        base.default = [0, 0, 0];
        return base;
    }
    const range = PERSISTENT_NUMBER_RANGES[key] ?? REVEAL_NUMBER_RANGES[key];
    if (range) {
        return { ...base, ...range };
    }
    return { ...base, min: 0, max: 10, step: 0.01 };
};

export function getRevealParamSpecs(effectType: string): EffectParamUiSpec[] {
    return getRevealEffectParamKeys(effectType).map(buildRevealSpec);
}

export function getPersistentParamSpecs(effectType: string): EffectParamUiSpec[] {
    return getPersistentEffectParamKeys(effectType).map(buildPersistentSpec);
}
