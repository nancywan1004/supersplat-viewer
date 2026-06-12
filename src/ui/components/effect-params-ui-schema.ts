import {
    getPersistentEffectParamKeys,
    getPersistentParamFieldKind
} from '../../vfx/effects-runtime/persistent/persistent-effect-params';
import {
    OVERALL_WAVE_DEFAULTS,
    clampOverallWaveNoiseType
} from '../../vfx/effects-runtime/persistent/scene/gsplat-overall-wave';
import { BUTTERFLY_PARTICLE_DEFAULTS } from '../../vfx/effects-runtime/persistent/scene/gsplat-butterfly-particle';
import { SPARKLE_TWINKLE_DEFAULTS } from '../../vfx/effects-runtime/persistent/scene/gsplat-sparkle-twinkle';
import {
    GSPLAT_FALLING_PETALS_DEFAULT_ATLAS_URL,
    GSPLAT_FALLING_PETALS_PRESET
} from '../../vfx/effects-runtime/persistent/camera/gsplat-falling-petals';
import { GSPLAT_FALLING_WEATHER_PRESETS } from '../../vfx/effects-runtime/persistent/camera/gsplat-falling-weather';
import { DEFAULT_NOSTALGIC_COMIC_SETTINGS } from '../../vfx/effects-runtime/persistent/stylisation/nostalgic-comic';
import { DEFAULT_YIYUN_DIANRAN_SETTINGS } from '../../vfx/effects-runtime/persistent/stylisation/yiyun-dianran-stylisation';
import {
    DEFAULT_PALETTE_PIXEL_SETTINGS,
    PALETTE_PIXEL_PALETTE_NAMES,
    PALETTE_PIXEL_SIZE_STEPS
} from '../../vfx/effects-runtime/persistent/stylisation/palette-pixel';
import { POINTILLISM_DEFAULTS } from '../../vfx/effects-runtime/persistent/stylisation/pointillism-stipple-shaders';
import {
    getRevealEffectParamKeys,
    getRevealParamFieldKind,
    type RevealParamFieldKind
} from '../../vfx/effects-runtime/reveal/reveal-effect-params';

export type EffectParamKind = RevealParamFieldKind | 'vec3' | 'enum' | 'text';

export interface EffectParamEnumOption {
    value: number;
    label: string;
}

export interface EffectParamUiSpec {
    key: string;
    label: string;
    kind: EffectParamKind;
    min?: number;
    max?: number;
    step?: number;
    default?: number | boolean | string | [number, number, number] | [number, number];
    options?: readonly EffectParamEnumOption[];
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
    wavelength: '波纹间距',
    waveSpeed: '波动速度',
    scaleBlend: '尺度混合',
    center: '效果中心',
    opacity: '透明度',
    color: '颜色',
    glowColor: '辉光颜色',
    glowStrength: '辉光强度',
    glowWidth: '辉光宽度',
    extents: '覆盖范围',
    density: '密度',
    petalParticleCount: '花瓣数量',
    petalTextureUrl: '花瓣贴图',
    continuousRender: '持续渲染',
    speed: '速度',
    drift: '飘移',
    globalOpacity: '整体透明度',
    farOpacity: '远处透明度',
    particleMinSize: '最小粒径',
    particleMaxSize: '最大粒径',
    elongate: '拉伸长度',
    flutter: '摆动',
    tumble: '翻滚',
    angle: '角度',
    fogDensity: '雾密度',
    exposure: '曝光',
    useFog: '使用雾效',
    cameraClearColor: '相机底色',
    useCameraClearColor: '使用相机底色',
    restoreSceneAtmosphere: '恢复场景氛围',
    levelCount: '色阶数量',
    edgeThreshold: '描边阈值',
    paperColor: '纸张颜色',
    lightColor: '亮部颜色',
    strokeColor: '线稿颜色',
    postEffectEnabled: '轻量后处理',
    saturation: '饱和度',
    glowIntensity: '发光强度',
    pixelSize: '像素尺寸',
    paletteIndex: '色盘（调试）',
    levels: '色阶',
    levelRange: '明暗对比',
    ditherSpread: '抖动扩散',
    dotScale: '整体颗粒尺度',
    brushSize: '单点笔触大小',
    brushDensity: '点涂密度',
    brushAspect: '短块比例',
    brushHardness: '块状硬边',
    colorVibration: '综合色彩变化',
    darkPaintBoost: '暗部厚度',
    highlightSkip: '亮部留白',
    strokeAspect: '笔触长宽比',
    roundness: '圆润收敛',
    strokeSoftness: '笔触软边',
    paintThickness: '颜料厚度',
    lumaLevels: '明度色阶',
    contrastDotMix: '对比色点数量',
    complementaryMix: '对比色强度',
    warmCoolSplit: '冷暖分离',
    paletteStrength: '色板强度',
    sourceStructureBlend: '结构文字保留',
    seed: '随机分布',
    minVisibleAlpha: '最小可见透明度',
    dotSizeFactor: '点尺寸系数',
    strokeLength: '笔触长度',
    strokeWidth: '笔触宽度',
    shapeJitter: '形态抖动',
    highlightSparsity: '亮部稀疏',
    darkDensityBoost: '暗部加密',
    stippleSize: '整体颗粒尺度',
    paperStrength: '纸张强度',
    paperTint: '纸张色调',
    edgeStrength: '描边强度'
};

/** 亮光细闪中文文案与控件范围（默认数值取自 {@link SPARKLE_TWINKLE_DEFAULTS}） */
const SPARKLE_TWINKLE_PARAM_UI: Partial<
    Record<
        keyof typeof SPARKLE_TWINKLE_DEFAULTS,
        { min?: number; max?: number; step?: number; label?: string }
    >
> = {
    pointSize: { min: 0.002, max: 0.1, step: 0.001, label: '光点大小' },
    sparkleDensity: { min: 0, max: 1, step: 0.05, label: '光点密度' },
    twinkleSpeed: { min: 0, max: 10, step: 0.1, label: '闪烁速度' },
    twinkleMin: { min: 0, max: 0.5, step: 0.05, label: '最暗亮度' },
    twinkleSharpness: { min: 0.5, max: 8, step: 0.1, label: '闪烁锐利度' },
    brightness: { min: 0.2, max: 5, step: 0.1, label: '亮度' },
    lightTint1: { min: 0, max: 2, step: 0.01, label: '光点颜色 1' },
    lightTint2: { min: 0, max: 2, step: 0.01, label: '光点颜色 2' },
    lightTint3: { min: 0, max: 2, step: 0.01, label: '光点颜色 3' },
    colorBlendMode: { label: '颜色混合' },
    center: { label: '效果中心' }
};

/** 蝴蝶粒子：中文文案与控件范围（默认取自 {@link BUTTERFLY_PARTICLE_DEFAULTS}） */
const BUTTERFLY_PARTICLE_PARAM_UI: Partial<
    Record<
        keyof typeof BUTTERFLY_PARTICLE_DEFAULTS,
        { min?: number; max?: number; step?: number; label?: string }
    >
> = {
    pointSize: { min: 0.001, max: 0.01, step: 0.0005, label: '光点大小' },
    twinkleSpeed: { min: 0, max: 10, step: 0.1, label: '闪烁速度' },
    twinkleMin: { min: 0, max: 0.85, step: 0.05, label: '最暗亮度' },
    twinkleSharpness: { min: 0.5, max: 8, step: 0.1, label: '闪烁锐利度' },
    brightness: { min: 0.2, max: 5, step: 0.1, label: '亮度' },
    baseColor: { label: '基础颜色' },
    cycleColor1: { label: '循环颜色 1' },
    cycleColor2: { label: '循环颜色 2' },
    colorCycleEnabled: { label: '颜色循环' },
    colorCycleSpeed: { min: 0.05, max: 2, step: 0.05, label: '循环速度' },
    sparkleTrailStrength: { min: 0, max: 2, step: 0.05, label: '拖尾强度' },
    gsLightEnabled: { label: '照亮高斯点光源' },
    gsLightIntensity: { min: 0, max: 5, step: 0.1, label: '光源强度' },
    gsLightRange: { min: 0, max: 15, step: 0.5, label: '光源范围' },
    gsLightColor: { label: '光源颜色' },
    center: { label: '效果中心' }
};

const BUTTERFLY_COLOR_CYCLE_PARAM_KEYS = new Set(['cycleColor1', 'cycleColor2', 'colorCycleSpeed']);

function butterflyShowsColorCycleParams(colorCycleEnabled: unknown): boolean {
    if (typeof colorCycleEnabled === 'boolean') {
        return colorCycleEnabled;
    }
    return BUTTERFLY_PARTICLE_DEFAULTS.colorCycleEnabled;
}

function applyButterflyParticleParamUiSpec(spec: EffectParamUiSpec): void {
    const key = spec.key as keyof typeof BUTTERFLY_PARTICLE_DEFAULTS;
    const ui = BUTTERFLY_PARTICLE_PARAM_UI[key];
    if (ui?.label) spec.label = ui.label;
    if (key in BUTTERFLY_PARTICLE_DEFAULTS) {
        const d = BUTTERFLY_PARTICLE_DEFAULTS[key];
        spec.default = Array.isArray(d) ? ([...d] as [number, number, number]) : d;
    }
    if (!ui) return;
    if (ui.min !== undefined) spec.min = ui.min;
    if (ui.max !== undefined) spec.max = ui.max;
    if (ui.step !== undefined) spec.step = ui.step;
}

const buildButterflyParticleParamSpec = (key: string): EffectParamUiSpec => {
    const kind = getPersistentParamFieldKind(key);
    const spec: EffectParamUiSpec = { key, label: key, kind };
    if (kind === 'vec3') {
        spec.step = 0.1;
    }
    if (kind === 'color') {
        spec.step = 0.01;
        spec.min = 0;
        spec.max = 2;
    }
    applyButterflyParticleParamUiSpec(spec);
    return spec;
};

function applySparkleTwinkleParamUiSpec(spec: EffectParamUiSpec): void {
    const key = spec.key as keyof typeof SPARKLE_TWINKLE_DEFAULTS;
    const ui = SPARKLE_TWINKLE_PARAM_UI[key];
    if (ui?.label) spec.label = ui.label;
    if (key in SPARKLE_TWINKLE_DEFAULTS) {
        const d = SPARKLE_TWINKLE_DEFAULTS[key];
        spec.default = Array.isArray(d) ? ([...d] as [number, number, number]) : d;
    }
    if (!ui) return;
    if (ui.min !== undefined) spec.min = ui.min;
    if (ui.max !== undefined) spec.max = ui.max;
    if (ui.step !== undefined) spec.step = ui.step;
}

/** 临时调试 UI：整体波动中文文案与控件范围（默认数值取自 {@link OVERALL_WAVE_DEFAULTS}） */
const OVERALL_WAVE_NOISE_TYPE_OPTIONS: readonly EffectParamEnumOption[] = [
    { value: 0, label: '雾涌起伏' },
    { value: 1, label: '逐浪传行' }
];

const OVERALL_WAVE_PARAM_UI: Partial<
    Record<keyof typeof OVERALL_WAVE_DEFAULTS, { min?: number; max?: number; step?: number; label?: string }>
> = {
    noiseType: { label: '波动类型' },
    intensity: { min: 0, max: 3, step: 0.05, label: '起伏明暗（波峰亮、波谷暗）' },
    waveAmplitude: { min: 0, max: 1.5, step: 0.02, label: '位移振幅' },
    waveSpeed: { min: 0.05, max: 5, step: 0.05, label: '波动速度' },
    wavelength: { min: 1, max: 15, step: 0.5, label: '波纹间距' },
    crestTint: { min: 0, max: 2, step: 0.01, label: '亮区颜色' },
    troughTint: { min: 0, max: 2, step: 0.01, label: '暗区颜色' },
    waveDirection: { label: '波列传播方向' },
    center: { label: '效果中心' }
};

function overallWaveShowsWaveDirection(noiseType: unknown): boolean {
    let n: number | null = null;
    if (typeof noiseType === 'number' && Number.isFinite(noiseType)) {
        n = noiseType;
    } else if (typeof noiseType === 'string' && noiseType !== '') {
        const parsed = parseInt(noiseType, 10);
        if (Number.isFinite(parsed)) n = parsed;
    }
    return n !== null && clampOverallWaveNoiseType(n) === 1;
}

function applyOverallWaveParamUiSpec(spec: EffectParamUiSpec): void {
    const key = spec.key as keyof typeof OVERALL_WAVE_DEFAULTS;
    const ui = OVERALL_WAVE_PARAM_UI[key];
    if (ui?.label) spec.label = ui.label;
    if (key in OVERALL_WAVE_DEFAULTS) {
        const d = OVERALL_WAVE_DEFAULTS[key];
        spec.default = Array.isArray(d) ? ([...d] as [number, number, number]) : d;
    }
    if (!ui) return;
    if (ui.min !== undefined) spec.min = ui.min;
    if (ui.max !== undefined) spec.max = ui.max;
    if (ui.step !== undefined) spec.step = ui.step;
}

type PersistentParamUiOverride = Partial<
    Pick<EffectParamUiSpec, 'label' | 'kind' | 'min' | 'max' | 'step' | 'default' | 'options'>
>;

const PALETTE_PIXEL_SIZE_OPTIONS: readonly EffectParamEnumOption[] = PALETTE_PIXEL_SIZE_STEPS.map((value) => ({
    value,
    label: `${value}`
}));

const PALETTE_PIXEL_PALETTE_OPTIONS: readonly EffectParamEnumOption[] = Object.entries(PALETTE_PIXEL_PALETTE_NAMES)
    .map(([value, label]) => ({ value: Number(value), label }));

const FALLING_PETALS_PARAM_KEYS = ['density', 'extents'] as const;
const FALLING_RAIN_PARAM_KEYS = [
    'density',
    'speed',
    'opacity',
    'drift',
    'extents',
    'particleMinSize',
    'particleMaxSize',
    'elongate',
    'fogDensity',
    'exposure',
    'useFog',
    'cameraClearColor',
    'angle'
] as const;
const FALLING_SNOW_PARAM_KEYS = [
    'density',
    'speed',
    'opacity',
    'farOpacity',
    'drift',
    'extents',
    'particleMinSize',
    'particleMaxSize',
    'elongate',
    'fogDensity',
    'exposure',
    'useFog',
    'angle'
] as const;

const FALLING_PETALS_DEFAULTS: Record<string, EffectParamUiSpec['default']> = {
    ...GSPLAT_FALLING_PETALS_PRESET,
    petalTextureUrl: GSPLAT_FALLING_PETALS_DEFAULT_ATLAS_URL,
    continuousRender: true
};

const FALLING_PETALS_PARAM_UI: Record<string, PersistentParamUiOverride> = {
    density: { min: 0.05, max: 2, step: 0.05 },
    extents: { min: 1, max: 120, step: 1 }
};

const WEATHER_PARAM_UI: Record<string, PersistentParamUiOverride> = {
    speed: { min: 0, max: 30, step: 0.1 },
    drift: { min: 0, max: 2, step: 0.01 },
    opacity: { min: 0, max: 1, step: 0.01 },
    globalOpacity: { min: 0, max: 1, step: 0.01 },
    farOpacity: { min: 0, max: 1, step: 0.01 },
    color: { min: 0, max: 2, step: 0.01 },
    particleMinSize: { min: 0.001, max: 0.1, step: 0.001 },
    particleMaxSize: { min: 0.001, max: 0.1, step: 0.001 },
    elongate: { min: 1, max: 30, step: 0.1 },
    flutter: { min: 0, max: 2, step: 0.01 },
    tumble: { min: 0, max: 2, step: 0.01 },
    density: { min: 0.1, max: 4, step: 0.1 },
    extents: { min: 1, max: 80, step: 1 },
    angle: { min: -75, max: 75, step: 1 },
    fogDensity: { min: 0, max: 0.05, step: 0.0005 },
    exposure: { min: 0, max: 1.5, step: 0.01 },
    cameraClearColor: { min: 0, max: 1, step: 0.01 },
    continuousRender: { default: true },
    restoreSceneAtmosphere: { default: true }
};

const NOSTALGIC_COMIC_PARAM_UI: Record<string, PersistentParamUiOverride> = {
    levelCount: { min: 3, max: 7, step: 1, default: DEFAULT_NOSTALGIC_COMIC_SETTINGS.levelCount },
    edgeThreshold: { min: 0.3, max: 3, step: 0.01, default: DEFAULT_NOSTALGIC_COMIC_SETTINGS.edgeThreshold },
    paperColor: { min: 0, max: 1, step: 0.01, default: [...DEFAULT_NOSTALGIC_COMIC_SETTINGS.paperColor] },
    lightColor: { min: 0, max: 1, step: 0.01, default: [...DEFAULT_NOSTALGIC_COMIC_SETTINGS.lightColor] },
    strokeColor: { min: 0, max: 1, step: 0.01, default: [...DEFAULT_NOSTALGIC_COMIC_SETTINGS.strokeColor] }
};

const YIYUN_DIANRAN_PARAM_UI: Record<string, PersistentParamUiOverride> = {
    postEffectEnabled: { default: DEFAULT_YIYUN_DIANRAN_SETTINGS.postEffectEnabled },
    saturation: { min: 1, max: 1.6, step: 0.01, default: DEFAULT_YIYUN_DIANRAN_SETTINGS.saturation },
    glowIntensity: { min: 0, max: 0.1, step: 0.001, default: DEFAULT_YIYUN_DIANRAN_SETTINGS.glowIntensity },
    glowColor: { min: 0, max: 1, step: 0.01, default: [...DEFAULT_YIYUN_DIANRAN_SETTINGS.glowColor] }
};

const PALETTE_PIXEL_PARAM_UI: Record<string, PersistentParamUiOverride> = {
    pixelSize: {
        kind: 'enum',
        options: PALETTE_PIXEL_SIZE_OPTIONS,
        default: DEFAULT_PALETTE_PIXEL_SETTINGS.pixelSize
    },
    paletteIndex: {
        kind: 'enum',
        options: PALETTE_PIXEL_PALETTE_OPTIONS,
        default: DEFAULT_PALETTE_PIXEL_SETTINGS.paletteIndex
    },
    levels: { min: 2, max: 20, step: 1, default: DEFAULT_PALETTE_PIXEL_SETTINGS.levels },
    levelRange: { min: 0, max: 2, step: 0.01, default: DEFAULT_PALETTE_PIXEL_SETTINGS.levelRange },
    ditherSpread: { min: 0, max: 0.08, step: 0.001, default: DEFAULT_PALETTE_PIXEL_SETTINGS.ditherSpread }
};

const POINTILLISM_PALETTE_OPTIONS: readonly EffectParamEnumOption[] = [
    { value: 0, label: '暖橙厚涂' },
    { value: 1, label: '紫蓝橙光' },
    { value: 2, label: '翠绿金黄' },
    { value: 3, label: '大地中性' }
];

const POINTILLISM_PARAM_UI: Record<string, PersistentParamUiOverride> = {
    brushSize: { min: 0.02, max: 0.32, step: 0.01, default: POINTILLISM_DEFAULTS.brushSize },
    brushDensity: { min: 0.15, max: 4.4, step: 0.01, default: POINTILLISM_DEFAULTS.brushDensity },
    brushAspect: { min: 0.85, max: 2.2, step: 0.01, default: POINTILLISM_DEFAULTS.brushAspect },
    brushHardness: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.brushHardness },
    colorVibration: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.colorVibration },
    darkPaintBoost: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.darkPaintBoost },
    highlightSkip: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.highlightSkip },
    dotScale: { min: 0.05, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.dotScale },
    dotSizeFactor: { min: 0.01, max: 0.32, step: 0.005, default: POINTILLISM_DEFAULTS.dotSizeFactor },
    strokeAspect: { min: 0.85, max: 2.2, step: 0.01, default: POINTILLISM_DEFAULTS.strokeAspect },
    roundness: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.roundness },
    density: { min: 0, max: 4.4, step: 0.01, default: POINTILLISM_DEFAULTS.density },
    strokeSoftness: { min: 0.08, max: 0.55, step: 0.005, default: POINTILLISM_DEFAULTS.strokeSoftness },
    strokeLength: { min: 0.58, max: 1.2, step: 0.01, default: POINTILLISM_DEFAULTS.strokeLength },
    strokeWidth: { min: 0.42, max: 1.0, step: 0.01, default: POINTILLISM_DEFAULTS.strokeWidth },
    shapeJitter: { min: 0, max: 0.22, step: 0.005, default: POINTILLISM_DEFAULTS.shapeJitter },
    paintThickness: { min: 0.5, max: 1.5, step: 0.01, default: POINTILLISM_DEFAULTS.paintThickness },
    saturation: { min: 0, max: 3, step: 0.01, default: POINTILLISM_DEFAULTS.saturation },
    lumaLevels: { min: 2, max: 24, step: 1, default: POINTILLISM_DEFAULTS.lumaLevels },
    contrastDotMix: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.contrastDotMix },
    complementaryMix: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.complementaryMix },
    warmCoolSplit: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.warmCoolSplit },
    paletteStrength: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.paletteStrength },
    paletteIndex: {
        kind: 'enum',
        options: POINTILLISM_PALETTE_OPTIONS,
        default: POINTILLISM_DEFAULTS.paletteIndex
    },
    sourceStructureBlend: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.sourceStructureBlend },
    highlightSparsity: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.highlightSparsity },
    darkDensityBoost: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.darkDensityBoost },
    seed: { min: 0, max: 997, step: 1, default: POINTILLISM_DEFAULTS.seed },
    minVisibleAlpha: { min: 0, max: 0.05, step: 0.001, default: POINTILLISM_DEFAULTS.minVisibleAlpha },
    postEffectEnabled: { default: POINTILLISM_DEFAULTS.postEffectEnabled },
    stippleSize: { min: 32, max: 160, step: 8, default: POINTILLISM_DEFAULTS.stippleSize },
    levels: { min: 2, max: 20, step: 1, default: POINTILLISM_DEFAULTS.levels },
    levelRange: { min: 0.5, max: 2, step: 0.01, default: POINTILLISM_DEFAULTS.levelRange },
    ditherSpread: { min: 0, max: 0.2, step: 0.005, default: POINTILLISM_DEFAULTS.ditherSpread },
    paperStrength: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.paperStrength },
    paperTint: { default: [...POINTILLISM_DEFAULTS.paperTint] },
    edgeThreshold: { min: 0.02, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.edgeThreshold },
    edgeStrength: { min: 0, max: 1, step: 0.01, default: POINTILLISM_DEFAULTS.edgeStrength }
};

const POINTILLISM_VISIBLE_PARAM_KEYS = [
    'postEffectEnabled',
    'stippleSize',
    'levelRange',
    'sourceStructureBlend',
    'brushSize',
    'brushDensity',
    'brushHardness',
    'shapeJitter',
    'saturation',
    'lumaLevels',
    'contrastDotMix',
    'complementaryMix',
    'colorVibration',
    'paperStrength',
    'edgeStrength'
] as const;

const buildPersistentSpec = (key: string): EffectParamUiSpec => {
    const kind = getPersistentParamFieldKind(key);
    const base: EffectParamUiSpec = { key, label: PERSISTENT_PARAM_LABELS[key] ?? labelForKey(key), kind };
    if (kind === 'color') {
        base.step = 0.01;
        base.default = [1, 1, 1];
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
    if (kind === 'text') {
        base.default = '';
        return base;
    }
    const range = REVEAL_NUMBER_RANGES[key];
    if (range) {
        return { ...base, ...range };
    }
    return { ...base, min: 0, max: 10, step: 0.01 };
};

function applyPersistentParamUiOverride(spec: EffectParamUiSpec, override: PersistentParamUiOverride | undefined): void {
    if (!override) return;
    if (override.label !== undefined) spec.label = override.label;
    if (override.kind !== undefined) spec.kind = override.kind;
    if (override.min !== undefined) spec.min = override.min;
    if (override.max !== undefined) spec.max = override.max;
    if (override.step !== undefined) spec.step = override.step;
    if (override.default !== undefined) spec.default = Array.isArray(override.default)
        ? ([...override.default] as [number, number, number] | [number, number])
        : override.default;
    if (override.options !== undefined) spec.options = override.options;
}

function persistentParamOverrideFor(effectType: string, key: string): PersistentParamUiOverride | undefined {
    if (effectType === 'falling-petals') {
        return { ...FALLING_PETALS_PARAM_UI[key], default: FALLING_PETALS_DEFAULTS[key] };
    }
    if (effectType === 'falling-rain' || effectType === 'falling-snow') {
        const mode = effectType === 'falling-rain' ? 'rain' : 'snow';
        const defaults: Record<string, EffectParamUiSpec['default']> = {
            ...GSPLAT_FALLING_WEATHER_PRESETS[mode],
            continuousRender: true,
            restoreSceneAtmosphere: true
        };
        return { ...WEATHER_PARAM_UI[key], default: defaults[key] };
    }
    if (effectType === 'nostalgic-comic') return NOSTALGIC_COMIC_PARAM_UI[key];
    if (effectType === 'yiyun-dianran') return YIYUN_DIANRAN_PARAM_UI[key];
    if (effectType === 'palette-pixel') return PALETTE_PIXEL_PARAM_UI[key];
    if (effectType === 'pointillism-stipple') return POINTILLISM_PARAM_UI[key];
    return undefined;
}

const buildPersistentSpecForType = (effectType: string, key: string): EffectParamUiSpec => {
    const spec = buildPersistentSpec(key);
    applyPersistentParamUiOverride(spec, persistentParamOverrideFor(effectType, key));
    return spec;
};

const buildSparkleTwinkleParamSpec = (key: string): EffectParamUiSpec => {
    const kind = getPersistentParamFieldKind(key);
    const spec: EffectParamUiSpec = { key, label: key, kind };
    if (kind === 'vec3') {
        spec.step = 0.1;
    }
    if (kind === 'color') {
        spec.step = 0.01;
    }
    applySparkleTwinkleParamUiSpec(spec);
    return spec;
};

const buildOverallWaveParamSpec = (key: string): EffectParamUiSpec => {
    const kind = getPersistentParamFieldKind(key);
    const spec: EffectParamUiSpec = { key, label: key, kind };
    if (kind === 'enum') {
        spec.options = OVERALL_WAVE_NOISE_TYPE_OPTIONS;
    }
    if (kind === 'vec3') {
        spec.step = 0.1;
    }
    applyOverallWaveParamUiSpec(spec);
    return spec;
};

export function getRevealParamSpecs(effectType: string): EffectParamUiSpec[] {
    return getRevealEffectParamKeys(effectType).map(buildRevealSpec);
}

export function getPersistentParamSpecs(
    effectType: string,
    effectValues?: Record<string, unknown>
): EffectParamUiSpec[] {
    if (effectType === 'sparkle-twinkle') {
        return getPersistentEffectParamKeys(effectType).map(buildSparkleTwinkleParamSpec);
    }
    if (effectType === 'butterfly-particle') {
        return getPersistentEffectParamKeys(effectType)
            .filter(
                (key) =>
                    !BUTTERFLY_COLOR_CYCLE_PARAM_KEYS.has(key) ||
                    butterflyShowsColorCycleParams(effectValues?.colorCycleEnabled)
            )
            .map(buildButterflyParticleParamSpec);
    }
    if (effectType === 'overall-wave') {
        return getPersistentEffectParamKeys(effectType)
            .filter((key) => key !== 'waveDirection' || overallWaveShowsWaveDirection(effectValues?.noiseType))
            .map(buildOverallWaveParamSpec);
    }
    if (effectType === 'falling-petals') {
        return FALLING_PETALS_PARAM_KEYS.map((key) => buildPersistentSpecForType(effectType, key));
    }
    if (effectType === 'falling-rain') {
        return FALLING_RAIN_PARAM_KEYS.map((key) => buildPersistentSpecForType(effectType, key));
    }
    if (effectType === 'falling-snow') {
        return FALLING_SNOW_PARAM_KEYS.map((key) => buildPersistentSpecForType(effectType, key));
    }
    if (effectType === 'pointillism-stipple') {
        return POINTILLISM_VISIBLE_PARAM_KEYS.map((key) => buildPersistentSpecForType(effectType, key));
    }
    return getPersistentEffectParamKeys(effectType).map((key) => buildPersistentSpecForType(effectType, key));
}
