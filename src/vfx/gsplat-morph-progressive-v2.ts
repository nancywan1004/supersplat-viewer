import {
    Asset,
    Entity,
    GSplatData,
    GSplatResource,
    Mat4,
    WORKBUFFER_UPDATE_ONCE,
    type AppBase
} from 'playcanvas';
import * as pc from 'playcanvas';

import type { AssetSource } from '../loaders/asset-source';

type MorphSource = string | AssetSource;

interface SplatArrays {
    count: number;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    opacity: Float32Array;
    rot0: Float32Array;
    rot1: Float32Array;
    rot2: Float32Array;
    rot3: Float32Array;
    fdc0: Float32Array;
    fdc1: Float32Array;
    fdc2: Float32Array;
    scale0: Float32Array;
    scale1: Float32Array;
    scale2: Float32Array;
    rest: Float32Array[];
}

interface LoadedMorphModel {
    name: string;
    splats: SplatArrays;
    /** 仅当 `retainSourceAssets: true` 时保留，便于调试；默认已卸载以省显存/内存。 */
    asset?: Asset;
    resource?: GSplatResource;
    data?: GSplatData;
}

interface PairCorrespondence {
    /** 长度恒为 `max(|A|,|B|)`，两侧下标均合法，无 leftover。 */
    matchedA: Uint32Array;
    matchedB: Uint32Array;
}

interface PairAxisParams {
    originX: number;
    originY: number;
    originZ: number;
    dirX: number;
    dirY: number;
    dirZ: number;
    projMin: number;
    projSpan: number;
}

type CorrespondenceStrategy = 'resample' | 'greedy';

type CorrespondenceRuntimePhase = 'preview' | 'building' | 'ready' | 'failed';

interface CorrespondenceRuntimeStatus {
    strategy: CorrespondenceStrategy;
    phase: CorrespondenceRuntimePhase;
    done?: number;
    total?: number;
    error?: unknown;
}

interface MorphPlaybackState {
    pairIndex: number;
    t: number;
    reverse: boolean;
}

export interface GsplatMorphOptions {
    segmentDuration?: number;
    /** 每段变形到下一个关键帧后停顿时长（秒）。默认 1 秒。 */
    segmentHoldDuration?: number;
    loop?: boolean;
    autoPlay?: boolean;
    /**
     * 为 true 时，在 `playing` 且存在 morph 段期间临时将 `app.autoRender = true`（每帧完整 render，最稳但最费）。
     * 为 false（默认）时只靠 `renderNextFrame` + `gsplat:sorted` 补帧；若偶发停画可改 true。
     */
    continuousAppRender?: boolean;
    unified?: boolean;
    layers?: number[];
    entityName?: string;
    fadeLogMin?: number; /** 用于隐藏小点数端多余输出槽和尾部占位（极小高斯），不参与配对求解。 */
    /**
     * 为 true 时保留各 keyframe 加载后的 `Asset` / `GSplatResource`（与 `splats` 并存，占显存与内存）。
     * 默认 false：在 `readSplatArrays` 完成后立即 `unload` + `assets.remove`，仅保留 CPU 侧 `splats` 供 morph（显著减轻 keyframe 多时 GPU/重复数据压力）。
     */
    retainSourceAssets?: boolean;
    /** Center-align every keyframe before correspondence/interpolation. Defaults to true. */
    recenterModels?: boolean;
    normalizeScales?: boolean;
    targetScale?: number;
    /**
     * 播放时限制「插值 + 写回 GSplatResource」的频率（墙钟）。0 表示不限制。
     * `_time` 仍每帧累加，仅减轻 CPU/GPU 上传；seek/stop/段末等会强制刷新。
     */
    morphPresentMaxHz?: number;
    /**
     * 为 false 时：高阶 SH（`f_rest_*`）只在每段切换或 `seek` 后的首次呈现时重算并重传 GPU，
     * 其余帧只 morph 位置/尺度/不透明度/旋转与 DC 颜色，可明显减压（大 ply 常为 45 维 rest）。
     */
    morphAnimateSphericalHarmonics?: boolean;
    /**
     * Prefer the PlayCanvas unified GPU splat path when the runtime exposes
     * GSplatContainer / GSplatProcessor. This removes the per-frame CPU
     * interpolation and full texture upload that makes multi-million point
     * morphs stall the main thread. Older PlayCanvas builds fall back to the
     * compatible CPU path automatically.
     */
    preferGpuMorph?: boolean;
    /**
     * CPU fallback only: update CPU sort centers at this maximum frequency.
     * Keeping this below the visual morph rate avoids a second multi-million
     * point pass every frame. 0 means every presented morph frame.
     */
    sortCentersMaxHz?: number;
    /**
     * CPU fallback only: use normalized quaternion lerp instead of exact slerp.
     * This is visually close for frame-to-frame morphing and much cheaper at
     * 2M+ splats.
     */
    fastQuaternionNlerp?: boolean;
    /**
     * 配对表仅在加载时构建一次，变形播放中不会重算。
     * `resample`（默认）：按索引比例映射，O(n) 极快，配合 progressivePairFlight 足够。
     * `greedy`：位置/颜色近似最近邻，大点云很慢，仅质量要求高时启用。
     */
    correspondenceStrategy?: CorrespondenceStrategy;
    greedySpatialWeight?: number;
    greedyColorWeight?: number;
    greedyGridCellSize?: number;
    greedySearchRadiusCells?: number;
    greedyMaxCandidatesPerPoint?: number;
    /** 按配对顺序逐步从 A 飞向 B。默认 true；关闭后恢复整段统一 t 插值。 */
    progressivePairFlight?: boolean;
    /**
     * 飞行重叠窗口（0–1）。单粒子从起飞到落地的 globalT 时长；越小则相邻粒子起飞间隔越大。默认 0.5。
     */
    progressivePairFlightWindow?: number;
    /**
     * 配对索引错峰权重（0–1）。与 sA/sB 空间相位混合，拉大「先飞 / 后飞」时间差并保持通道连续。默认 0.48。
     */
    progressivePairFlightStagger?: number;
    /**
     * A/B 分离消散与生成：A 按 sA 从靠 B 侧先散，B 按 sB 从靠 A 侧先生；
     * 中间段才成通道粒子。默认 true。false 时退回单一 localT 对称插值。
     */
    progressivePairAsymmetricDissolve?: boolean;
    /**
     * A→B 非圆形沙漏：粒子仍从 A 形体各点飞向 B 目标，仅在中间段向轴线径向收束成细腰。
     * 与点云 morphPointCloud* 无关。
     */
    morphHourglassChannel?: boolean;
    morphHourglassStrength?: number;
    /** @deprecated 圆形管道遗留，径向收束模式下忽略。 */
    morphHourglassEndRadiusFrac?: number;
    /** 腰部径向保留比例 0–1（相对当前点到轴距离），越小腰越细。默认 0.14。 */
    morphHourglassWaistRatio?: number;
    /** 收腰沿程锐度，越大越集中在中间。默认 2.6。 */
    morphHourglassWaistPinch?: number;
    /** @deprecated 圆形管道遗留，径向收束模式下忽略。 */
    morphHourglassShellBias?: number;
    /** 收束段的扰动幅度 × A→B 间距。默认 0.012（主扰动由 Spark hash 承担）。 */
    morphHourglassPerturbAmp?: number;
    /**
     * Spark Disintegrate 式 hash 位移强度（× A→B 间距），见 spark splat-shader-effects。
     * 默认 0.048。
     */
    morphHourglassSparkIntensity?: number;
    /** Spark Disintegrate 切向扭转强度。默认 1.0。 */
    morphHourglassSparkTwist?: number;
    /** 通道粒子飞行中的时间随机漂移（× A→B 间距）。默认 0.026。 */
    morphHourglassSparkDrift?: number;
    /** 通道粒子直径 = A→B 间距 × 该比例（再与绝对上限、单 splat 尺度取 min）。默认 0.004。 */
    morphHourglassParticleScaleFrac?: number;
    /** 固定世界单位粒子直径；仅在不使用 scaleFrac 时生效。 */
    morphHourglassParticleLogScale?: number;
    morphHourglassTintA?: [number, number, number];
    morphHourglassTintB?: [number, number, number];
    morphHourglassTintMix?: number;
    /** 飞行点贴到沙漏管道表面的强度 0–1。默认 0.92。 */
    morphHourglassConform?: number;
    /** A-B 变形途中临时转为点云感（v2 未实现，保留兼容）。 */
    morphPointCloudEffect?: boolean;
    /** 点云阶段固定点大小（世界单位）。默认 0.00015。 */
    morphPointCloudPointSize?: number;
    /** 点云阶段屏幕最小可见尺寸（像素）；设为 0 可关闭距离/FOV 保底。默认 1.25。 */
    morphPointCloudMinScreenPx?: number;
    /** 屏幕尺寸保底相对 `morphPointCloudPointSize` 的最大放大倍数。默认 32。 */
    morphPointCloudScreenFloorMaxScale?: number;
    /** 点云强度倍率；变形段从 0->1，到达端点后直接切回 GS。默认 1.5。 */
    morphPointCloudStrength?: number;
    /** 点云辉光色调 RGB 0–1。默认 (0, 145/255, 1)。 */
    morphPointCloudTint?: [number, number, number];
    /** 点云阶段颜色辉光强度。默认 1.2。 */
    morphPointCloudGlowStrength?: number;
    /** 点云阶段目标不透明度（0-1）。默认 0.88。 */
    morphPointCloudOpacity?: number;
    /** 点云阶段可见点比例（0-1）。默认 0.32，避免全部高斯堆成实体。 */
    morphPointCloudDensity?: number;
    /** 点云阶段随机散开距离（世界单位）。默认 0.25。 */
    morphPointCloudScatterDistance?: number;
    /** GS 与点云之间的短切换时长（秒）。默认 0.08 秒。 */
    morphPointCloudEdgeDuration?: number;
    /** 点云到达目标形态后保持完整点云的时长（秒），随后切回 GS。默认 0.35 秒。 */
    morphPointCloudHoldDuration?: number;
    /** 完整点云从顶部光圈扫描恢复成 GS 的时长（秒）。默认 0.85 秒。 */
    morphPointCloudRevealDuration?: number;
    /** Runtime-only: reports whether morph is using the fast preview route or upgraded greedy route. */
    onCorrespondenceStatus?: (status: CorrespondenceRuntimeStatus) => void;
    /**
     * 启动后用 resample 先播 morph，再在后台构建 greedy 并热替换插值器。
     * 默认 false：greedy 与变形播放无关，且大点云下会长时间占满主线程。
     * Disabled by default because the greedy matcher still runs on the browser
     * main thread and can starve morph presentation on large splats.
     */
    buildGreedyInBackground?: boolean;
    /**
     * Scene entities used as visual keyframes. They are never transformed by
     * the morph runtime; when provided, the generated morph entity copies the
     * first entity's world transform and temporarily hides these sources.
     */
    sourceEntities?: Entity[];
    /** Hide sourceEntities while the morph controller is alive. Defaults to true. */
    hideSourceEntities?: boolean;
    /** Internal: precomputed by loadGsplatMorphSequence to keep setup responsive. */
    prebuiltInterpolator?: GaussianInterpolatorRuntime;
}

const MAX_MORPH_MODELS = 4;
const MAX_SH_REST_PROPS = 45;
const DEFAULT_SEGMENT_DURATION = 1.5;
const DEFAULT_SEGMENT_HOLD_DURATION = 1.0;
const DEFAULT_FADE_LOG_MIN = -6.0;
const DEFAULT_TARGET_SCALE = 10.0;
const DEFAULT_SORT_CENTERS_MAX_HZ = 6;
const DEFAULT_GREEDY_SPATIAL_WEIGHT = 0.7;
const DEFAULT_GREEDY_COLOR_WEIGHT = 0.0;
const DEFAULT_GREEDY_SEARCH_RADIUS_CELLS = 2;
const DEFAULT_GREEDY_MAX_CANDIDATES = 96;
const DEFAULT_GREEDY_GLOBAL_FALLBACK_SAMPLES = 2048;
const DEFAULT_MORPH_BUILD_YIELD_MS = 2;
const DEFAULT_PROGRESSIVE_PAIR_FLIGHT_WINDOW = 0.5;
const DEFAULT_PROGRESSIVE_PAIR_FLIGHT_STAGGER = 0.48;
const DEFAULT_MORPH_HOURGLASS_STRENGTH = 1.0;
const DEFAULT_MORPH_HOURGLASS_WAIST_RADIAL_MIN = 0.14;
const DEFAULT_MORPH_HOURGLASS_WAIST_PINCH = 2.6;
const DEFAULT_MORPH_HOURGLASS_PERTURB_AMP = 0.012;
const DEFAULT_MORPH_HOURGLASS_SPARK_INTENSITY = 0.048;
const DEFAULT_MORPH_HOURGLASS_SPARK_TWIST = 1.0;
const DEFAULT_MORPH_HOURGLASS_SPARK_DRIFT = 0.026;
/** Spark disintegrate 约 0.01 量级；大场景再按 A→B 间距上限裁剪。 */
const DEFAULT_MORPH_HOURGLASS_PARTICLE_SCALE_FRAC = 0.004;
const MORPH_HOURGLASS_PARTICLE_MAX_DIAMETER = 0.012;
const DEFAULT_MORPH_HOURGLASS_TINT_A: [number, number, number] = [0.95, 0.22, 0.28];
const DEFAULT_MORPH_HOURGLASS_TINT_B: [number, number, number] = [0.25, 0.42, 0.98];
/** 0 = 不改颜色，完全用 A→B 插值后的 GS 原色。 */
const DEFAULT_MORPH_HOURGLASS_TINT_MIX = 0;
const DEFAULT_MORPH_HOURGLASS_CONFORM = 0.78;
const DEFAULT_MORPH_HOURGLASS_MIN_OPACITY_LOG = -0.2;
const VALID_REST_PROP_COUNTS = [0, 9, 24, 45] as const;
const SH_C0 = 0.28209479177387814;

interface MorphHourglassSettings {
    enabled: boolean;
    strength: number;
    waistRadialMin: number;
    waistPinch: number;
    perturbAmp: number;
    sparkIntensity: number;
    sparkTwist: number;
    sparkDrift: number;
    particleScaleFrac: number;
    particleLogScale?: number;
    tintA: [number, number, number];
    tintB: [number, number, number];
    tintMix: number;
    conform: number;
    minOpacityLog: number;
}

const resolveMorphHourglassSettings = (options: GsplatMorphOptions = {}): MorphHourglassSettings => ({
    enabled: options.morphHourglassChannel ?? true,
    strength: options.morphHourglassStrength ?? DEFAULT_MORPH_HOURGLASS_STRENGTH,
    waistRadialMin: options.morphHourglassWaistRatio ?? DEFAULT_MORPH_HOURGLASS_WAIST_RADIAL_MIN,
    waistPinch: options.morphHourglassWaistPinch ?? DEFAULT_MORPH_HOURGLASS_WAIST_PINCH,
    perturbAmp: options.morphHourglassPerturbAmp ?? DEFAULT_MORPH_HOURGLASS_PERTURB_AMP,
    sparkIntensity: options.morphHourglassSparkIntensity ?? DEFAULT_MORPH_HOURGLASS_SPARK_INTENSITY,
    sparkTwist: options.morphHourglassSparkTwist ?? DEFAULT_MORPH_HOURGLASS_SPARK_TWIST,
    sparkDrift: options.morphHourglassSparkDrift ?? DEFAULT_MORPH_HOURGLASS_SPARK_DRIFT,
    particleScaleFrac: options.morphHourglassParticleScaleFrac ?? DEFAULT_MORPH_HOURGLASS_PARTICLE_SCALE_FRAC,
    particleLogScale: options.morphHourglassParticleLogScale,
    tintA: options.morphHourglassTintA ?? DEFAULT_MORPH_HOURGLASS_TINT_A,
    tintB: options.morphHourglassTintB ?? DEFAULT_MORPH_HOURGLASS_TINT_B,
    tintMix: options.morphHourglassTintMix ?? DEFAULT_MORPH_HOURGLASS_TINT_MIX,
    conform: options.morphHourglassConform ?? DEFAULT_MORPH_HOURGLASS_CONFORM,
    minOpacityLog: DEFAULT_MORPH_HOURGLASS_MIN_OPACITY_LOG
});

/** 通道粒子目标直径（世界单位）：min(间距×比例, 绝对上限)。 */
const resolveHourglassParticleDiameter = (axis: PairAxisParams, settings: MorphHourglassSettings) => {
    if (typeof settings.particleLogScale === 'number' && Number.isFinite(settings.particleLogScale)) {
        return Math.exp(settings.particleLogScale);
    }
    const spanDiameter = axis.projSpan * settings.particleScaleFrac;
    return Math.min(Math.max(spanDiameter, 1e-5), MORPH_HOURGLASS_PARTICLE_MAX_DIAMETER);
};

const resolveHourglassParticleLogScale = (axis: PairAxisParams, settings: MorphHourglassSettings) => {
    return Math.log(resolveHourglassParticleDiameter(axis, settings));
};

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const smoothstep = (edge0: number, edge1: number, value: number) => {
    const t = clamp((value - edge0) / Math.max(edge1 - edge0, 1e-6), 0, 1);
    return t * t * (3 - 2 * t);
};
const resolveProgressivePairT = (
    globalT: number,
    slotIndex: number,
    slotCount: number,
    enabled: boolean,
    window: number
) => {
    if (!enabled || slotCount <= 1) {
        return clamp(globalT, 0, 1);
    }

    const travelWindow = clamp(window, 1e-4, 1);
    const delay = (slotIndex / Math.max(1, slotCount - 1)) * (1 - travelWindow);
    return smoothstep(0, 1, clamp((globalT - delay) / travelWindow, 0, 1));
};
const resolveDirectionalFlightT = (
    globalT: number,
    phase: number,
    enabled: boolean,
    window: number,
    reverse = false
) => {
    if (!enabled) {
        return clamp(globalT, 0, 1);
    }
    const travelWindow = clamp(window, 1e-4, 1);
    const delay = clamp(phase, 0, 1) * (1 - travelWindow);
    if (!reverse) {
        return smoothstep(0, 1, clamp((globalT - delay) / travelWindow, 0, 1));
    }
    const reverseProgress = 1 - clamp(globalT, 0, 1);
    return 1 - smoothstep(0, 1, clamp((reverseProgress - delay) / travelWindow, 0, 1));
};

interface AsymmetricMorphWeights {
    goneA: number;
    presentB: number;
    posT: number;
    weightA: number;
    weightB: number;
    inChannel: boolean;
    channelBand: number;
    blendA: number;
    blendB: number;
}

/** 配对索引 0–1 + 轻微哈希，避免同 sA 带内同时起飞。 */
const resolvePairFlightPhase = (pairIndex: number, pairCount: number) => {
    if (pairCount <= 1) {
        return 0.5;
    }
    const base = pairIndex / Math.max(1, pairCount - 1);
    const jitter = (hourglassSplatHash(pairIndex, 4.7) - 0.5) * 0.07;
    return clamp(base + jitter, 0, 1);
};

/** A 按 sA 消散、B 按 sB 生成；pairPhase 拉开相邻粒子起飞间隔。 */
const resolveAsymmetricMorphWeights = (
    globalT: number,
    sA: number,
    sB: number,
    pairPhase: number,
    progressivePairFlight: boolean,
    window: number,
    stagger: number,
    reversePlayback: boolean
): AsymmetricMorphWeights => {
    if (!progressivePairFlight) {
        const u = clamp(globalT, 0, 1);
        return {
            goneA: u,
            presentB: u,
            posT: u,
            weightA: 1 - u,
            weightB: u,
            inChannel: u > 0.04 && u < 0.96,
            channelBand: clamp(4 * u * (1 - u), 0, 1),
            blendA: 1 - u,
            blendB: u
        };
    }

    const staggerMix = clamp(stagger, 0, 1);
    const spatialLeave = Math.pow(clamp(1 - sA, 0, 1), 1.45);
    const spatialArrive = Math.pow(clamp(sB, 0, 1), 1.45);
    const phaseLeaveA = clamp(spatialLeave * (1 - staggerMix) + pairPhase * staggerMix, 0, 1);
    const phaseArriveB = clamp(spatialArrive * (1 - staggerMix) + pairPhase * staggerMix, 0, 1);
    const travelWindow = clamp(window, 0.12, 1);

    const goneA = resolveDirectionalFlightT(globalT, phaseLeaveA, true, travelWindow, reversePlayback);
    const presentB = resolveDirectionalFlightT(globalT, phaseArriveB, true, travelWindow, reversePlayback);
    const weightA = 1 - goneA;
    const weightB = presentB;

    const flightPhase = clamp(phaseLeaveA * 0.52 + phaseArriveB * 0.48, 0, 1);
    const posT = resolveDirectionalFlightT(globalT, flightPhase, true, travelWindow, reversePlayback);

    const channelBand = clamp(goneA * (1 - presentB), 0, 1);
    const inChannel = goneA > 0.04 && presentB < 0.96 && posT > 0.02 && posT < 0.98;
    const blendA = weightA;
    const blendB = weightB;

    return { goneA, presentB, posT, weightA, weightB, inChannel, channelBand, blendA, blendB };
};

/** 沿 A→B 轴：两端 0、中间 1，用于只在腰段径向收束。 */
const hourglassWaistProfile = (axisS: number, waistPinch: number) => {
    const u = 1 - Math.abs(2 * clamp(axisS, 0, 1) - 1);
    return Math.pow(u, Math.max(0.5, waistPinch));
};

const hourglassSplatHash = (seed: number, salt: number) => {
    const x = Math.sin((seed + 1) * 12.9898 + salt * 78.233) * 43758.5453;
    return x - Math.floor(x);
};

/** Spark disintegrate: fract(sin(p * 123.456) * 123.456) per component */
const sparkHash3 = (x: number, y: number, z: number) => {
    const fract = (v: number) => v - Math.floor(v);
    return {
        x: fract(Math.sin(x * 123.456) * 123.456),
        y: fract(Math.sin(y * 123.456) * 123.456),
        z: fract(Math.sin(z * 123.456) * 123.456)
    };
};

const rgbToFdc = (r: number, g: number, b: number) => ({
    f0: (r - 0.5) / SH_C0,
    f1: (g - 0.5) / SH_C0,
    f2: (b - 0.5) / SH_C0
});

/**
 * 非圆形沙漏：保留 A→B 插值/渐进飞行的位置，仅在腰段把径向分量向轴线收紧。
 * 两端自然保持 A/B 形体散开的 GS 分布。
 */
const applyHourglassChannelToSplat = (
    writeIndex: number,
    globalT: number,
    morphWeights: AsymmetricMorphWeights,
    axis: PairAxisParams,
    settings: MorphHourglassSettings,
    output: SplatArrays
) => {
    if (!settings.enabled) {
        return;
    }

    const morphActive = smoothstep(0.01, 0.05, globalT) * (1 - smoothstep(0.95, 0.99, globalT));
    const channelWeight = morphActive * morphWeights.channelBand;
    if (channelWeight <= 0.008) {
        return;
    }

    let px = output.x[writeIndex];
    let py = output.y[writeIndex];
    let pz = output.z[writeIndex];

    const proj = (px - axis.originX) * axis.dirX
        + (py - axis.originY) * axis.dirY
        + (pz - axis.originZ) * axis.dirZ;
    const axisS = clamp((proj - axis.projMin) / axis.projSpan, 0, 1);
    const pinchProfile = hourglassWaistProfile(axisS, settings.waistPinch);
    if (pinchProfile <= 0.001) {
        return;
    }

    const ax = axis.originX + axis.dirX * proj;
    const ay = axis.originY + axis.dirY * proj;
    const az = axis.originZ + axis.dirZ * proj;

    let rx = px - ax;
    let ry = py - ay;
    let rz = pz - az;
    const axial = rx * axis.dirX + ry * axis.dirY + rz * axis.dirZ;
    rx -= axis.dirX * axial;
    ry -= axis.dirY * axial;
    rz -= axis.dirZ * axial;

    const pinchAmt = clamp(channelWeight * pinchProfile * settings.strength * settings.conform, 0, 1);
    const radialScale = 1 - (1 - settings.waistRadialMin) * pinchAmt;
    rx *= radialScale;
    ry *= radialScale;
    rz *= radialScale;

    const wobble = settings.perturbAmp * axis.projSpan * pinchProfile * channelWeight;
    const seed = writeIndex;
    const flowPhase = globalT * Math.PI * 2 + morphWeights.posT * Math.PI * 1.35 + seed * 0.17;
    let perpX = axis.dirY;
    let perpY = -axis.dirX;
    let perpZ = 0;
    if (Math.hypot(perpX, perpY, perpZ) < 0.1) {
        perpX = 0;
        perpY = axis.dirZ;
        perpZ = -axis.dirY;
    }
    const pl = Math.max(1e-6, Math.hypot(perpX, perpY, perpZ));
    perpX /= pl;
    perpY /= pl;
    perpZ /= pl;
    const perp2X = axis.dirY * perpZ - axis.dirZ * perpY;
    const perp2Y = axis.dirZ * perpX - axis.dirX * perpZ;
    const perp2Z = axis.dirX * perpY - axis.dirY * perpX;
    px = ax + axis.dirX * axial + rx
        + perpX * Math.sin(flowPhase * 1.1 + seed) * wobble
        + perp2X * Math.cos(flowPhase * 0.85 + seed * 2.3) * wobble;
    py = ay + axis.dirY * axial + ry
        + perpY * Math.sin(flowPhase * 1.1 + seed) * wobble
        + perp2Y * Math.cos(flowPhase * 0.85 + seed * 2.3) * wobble;
    pz = az + axis.dirZ * axial + rz
        + perpZ * Math.sin(flowPhase * 1.1 + seed) * wobble
        + perp2Z * Math.cos(flowPhase * 0.85 + seed * 2.3) * wobble;

    const particleBand = clamp(channelWeight * pinchProfile * settings.strength, 0, 1);
    if (particleBand > 0.02) {
        const sparkPhase = Math.sin(
            globalT * Math.PI * 2
            + morphWeights.posT * Math.PI
            + axisS * 4
            - proj * 0.5
            + seed * 0.11
        );
        const sparkTt = smoothstep(-1, 0.5, -sparkPhase) * channelWeight * pinchProfile;

        const hashPos = sparkHash3(px * 0.65, py * 0.65, pz * 0.65);
        const jitter = settings.sparkIntensity * axis.projSpan * particleBand;
        px += (hashPos.x * 2 - 1) * jitter;
        py += (hashPos.y * 2 - 1) * jitter;
        pz += (hashPos.z * 2 - 1) * jitter;

        let srx = px - ax;
        let sry = py - ay;
        let srz = pz - az;
        const saxial = srx * axis.dirX + sry * axis.dirY + srz * axis.dirZ;
        srx -= axis.dirX * saxial;
        sry -= axis.dirY * saxial;
        srz -= axis.dirZ * saxial;
        let ru = srx * perpX + sry * perpY + srz * perpZ;
        let rv = srx * perp2X + sry * perp2Y + srz * perp2Z;
        const twistAng = sparkTt * 2 + saxial * 2 * sparkTt * settings.sparkTwist;
        const cosA = Math.cos(twistAng);
        const sinA = Math.sin(twistAng);
        const ru2 = ru * cosA - rv * sinA;
        const rv2 = ru * sinA + rv * cosA;
        ru = ru2;
        rv = rv2;
        px = ax + axis.dirX * saxial + perpX * ru + perp2X * rv;
        py = ay + axis.dirY * saxial + perpY * ru + perp2Y * rv;
        pz = az + axis.dirZ * saxial + perpZ * ru + perp2Z * rv;

        const rh = sparkHash3(seed * 0.071, axisS * 5.31, proj * 0.019);
        const t1 = globalT * Math.PI * 2 + morphWeights.posT * 4.5 + rh.x * Math.PI * 2;
        const t2 = globalT * 5.1 + morphWeights.posT * 3.7 + rh.y * Math.PI * 2 + seed * 0.31;
        const t3 = globalT * 7.2 + morphWeights.posT * 5.3 + rh.z * Math.PI * 2 + seed * 0.19;
        const driftAmp = settings.sparkDrift * axis.projSpan * particleBand;
        const rh2 = sparkHash3(seed, t1 * 0.13, t2 * 0.11);
        px += (perpX * Math.sin(t1 * (1.15 + rh.x * 0.4) + seed)
            + perp2X * Math.cos(t2 * (0.95 + rh.y * 0.5) + seed * 2.1)) * driftAmp;
        py += (perpY * Math.sin(t1 * (1.15 + rh.x * 0.4) + seed)
            + perp2Y * Math.cos(t2 * (0.95 + rh.y * 0.5) + seed * 2.1)) * driftAmp;
        pz += (perpZ * Math.sin(t1 * (1.15 + rh.x * 0.4) + seed)
            + perp2Z * Math.cos(t2 * (0.95 + rh.y * 0.5) + seed * 2.1)) * driftAmp;
        const drift2 = driftAmp * 0.55;
        px += (perpX * Math.sin(t2 * 2.3 + rh2.y * 12) + perp2X * Math.sin(t1 * 1.9 + rh2.z * 12)) * drift2;
        py += (perpY * Math.sin(t2 * 2.3 + rh2.y * 12) + perp2Y * Math.sin(t1 * 1.9 + rh2.z * 12)) * drift2;
        pz += (perpZ * Math.sin(t2 * 2.3 + rh2.y * 12) + perp2Z * Math.sin(t1 * 1.9 + rh2.z * 12)) * drift2;
        const driftAx = driftAmp * 0.22 * Math.sin(t3 * 0.6 + seed * 0.07);
        px += axis.dirX * driftAx;
        py += axis.dirY * driftAx;
        pz += axis.dirZ * driftAx;

        const particleLin = resolveHourglassParticleDiameter(axis, settings);
        const scaleBlend = clamp(particleBand, 0, 1);
        const splatLin0 = Math.exp(output.scale0[writeIndex]);
        const splatLin1 = Math.exp(output.scale1[writeIndex]);
        const splatLin2 = Math.exp(output.scale2[writeIndex]);
        const currentRms = Math.sqrt((splatLin0 * splatLin0 + splatLin1 * splatLin1 + splatLin2 * splatLin2) / 3);
        const targetLin = currentRms * (1 - scaleBlend) + particleLin * scaleBlend;
        const targetLog = Math.log(Math.max(targetLin, 1e-6));
        output.scale0[writeIndex] = targetLog;
        output.scale1[writeIndex] = targetLog;
        output.scale2[writeIndex] = targetLog;
        const invBlend = 1 - scaleBlend;
        output.rot0[writeIndex] = output.rot0[writeIndex] * invBlend + 1 * scaleBlend;
        output.rot1[writeIndex] *= invBlend;
        output.rot2[writeIndex] *= invBlend;
        output.rot3[writeIndex] *= invBlend;
        const rl = Math.hypot(output.rot0[writeIndex], output.rot1[writeIndex], output.rot2[writeIndex], output.rot3[writeIndex]);
        if (rl > 1e-8) {
            output.rot0[writeIndex] /= rl;
            output.rot1[writeIndex] /= rl;
            output.rot2[writeIndex] /= rl;
            output.rot3[writeIndex] /= rl;
        }
    }

    output.x[writeIndex] = px;
    output.y[writeIndex] = py;
    output.z[writeIndex] = pz;

    if (settings.tintMix <= 0) {
        return;
    }

    const effect = clamp(channelWeight * settings.strength, 0, 1);
    const tintR = settings.tintA[0] * (1 - axisS) + settings.tintB[0] * axisS;
    const tintG = settings.tintA[1] * (1 - axisS) + settings.tintB[1] * axisS;
    const tintB = settings.tintA[2] * (1 - axisS) + settings.tintB[2] * axisS;
    const tint = rgbToFdc(tintR, tintG, tintB);
    const tintMix = effect * settings.tintMix;
    output.fdc0[writeIndex] = output.fdc0[writeIndex] * (1 - tintMix) + tint.f0 * tintMix;
    output.fdc1[writeIndex] = output.fdc1[writeIndex] * (1 - tintMix) + tint.f1 * tintMix;
    output.fdc2[writeIndex] = output.fdc2[writeIndex] * (1 - tintMix) + tint.f2 * tintMix;
};

const yieldToBrowser = () => new Promise<void>((resolve) => {
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => setTimeout(resolve, 0));
        return;
    }
    setTimeout(resolve, 0);
});

const safeFilenameFromUrl = (url: string) => {
    try {
        const pathname = new URL(url, location.href).pathname;
        return pathname.split('/').pop() || `morph-${Date.now()}.ply`;
    } catch {
        return url.split('/').pop() || `morph-${Date.now()}.ply`;
    }
};

const resolveMorphSource = (source: MorphSource, index: number) => {
    if (typeof source === 'string') {
        return {
            url: new URL(source, location.href).href,
            filename: safeFilenameFromUrl(source),
            cleanupUrl: null as string | null
        };
    }

    if (source.contents) {
        const objectUrl = URL.createObjectURL(source.contents);
        return {
            url: objectUrl,
            filename: source.filename || source.contents.name || `morph-${index + 1}.ply`,
            cleanupUrl: objectUrl
        };
    }

    const url = source.url ?? source.filename;
    if (!url) {
        throw new Error(`Morph source #${index + 1} 缺少 url/filename/contents`);
    }

    return {
        url: new URL(url, location.href).href,
        filename: source.filename || safeFilenameFromUrl(url),
        cleanupUrl: null as string | null
    };
};

const getEntityGsplatSource = (entity: Entity | undefined) => {
    const gsplat = entity?.gsplat as any;
    const asset = gsplat?.asset as Asset | undefined;
    const resource = (asset?.resource ?? gsplat?.resource) as GSplatResource | undefined;
    if (!resource) {
        return null;
    }

    return {
        asset,
        resource
    };
};

const isReadableGsplatData = (data: unknown): data is GSplatData => {
    const record = data as { getProp?: unknown; numSplats?: unknown } | null | undefined;
    return !!record && typeof record.getProp === 'function' && typeof record.numSplats === 'number';
};

const resolveReadableGsplatData = async (
    resource: GSplatResource | undefined,
    label: string
): Promise<GSplatData> => {
    const data = resource?.gsplatData as unknown;
    if (isReadableGsplatData(data)) {
        return data;
    }

    const decompress = (data as { decompress?: unknown } | null | undefined)?.decompress;
    if (typeof decompress === 'function') {
        const decompressed = await decompress.call(data);
        if (isReadableGsplatData(decompressed)) {
            return decompressed;
        }
    }

    throw new Error(`加载 ${label} 失败: gsplatData 不可读（PLY/SOG morph 需要可解压为 GSplatData）`);
};

const createGsplatFileContents = (contents: ArrayBuffer | undefined) => {
    if (!contents) {
        return undefined;
    }
    // PlayCanvas' PLY parser expects a Response-like object with `.body`;
    // SOG accepts either Response or ArrayBuffer. Use Response so both paths work.
    return typeof Response !== 'undefined' ? new Response(contents) : contents;
};

const getRequiredProp = (data: GSplatData, name: string) => {
    const prop = data.getProp(name) as ArrayLike<number> | null;
    if (!prop) {
        throw new Error(`GSplat 缺少必要属性: ${name}`);
    }
    return Float32Array.from(prop);
};

const getRestPropCount = (data: GSplatData) => {
    let count = 0;
    for (let i = 0; i < MAX_SH_REST_PROPS; i++) {
        if (!data.getProp(`f_rest_${i}`)) {
            break;
        }
        count++;
    }
    return count;
};

const normalizeRestPropCount = (count: number) => {
    if (VALID_REST_PROP_COUNTS.includes(count as typeof VALID_REST_PROP_COUNTS[number])) {
        return count;
    }

    throw new Error(`Unsupported SH rest property count: ${count}`);
};

const readSplatArrays = (data: GSplatData): SplatArrays => {
    const restCount = normalizeRestPropCount(getRestPropCount(data));
    const rest = Array.from({ length: restCount }, (_, index) => getRequiredProp(data, `f_rest_${index}`));

    return {
        count: data.numSplats,
        x: getRequiredProp(data, 'x'),
        y: getRequiredProp(data, 'y'),
        z: getRequiredProp(data, 'z'),
        opacity: getRequiredProp(data, 'opacity'),
        rot0: getRequiredProp(data, 'rot_0'),
        rot1: getRequiredProp(data, 'rot_1'),
        rot2: getRequiredProp(data, 'rot_2'),
        rot3: getRequiredProp(data, 'rot_3'),
        fdc0: getRequiredProp(data, 'f_dc_0'),
        fdc1: getRequiredProp(data, 'f_dc_1'),
        fdc2: getRequiredProp(data, 'f_dc_2'),
        scale0: getRequiredProp(data, 'scale_0'),
        scale1: getRequiredProp(data, 'scale_1'),
        scale2: getRequiredProp(data, 'scale_2'),
        rest
    };
};

const recenterPointCloud = (model: SplatArrays) => {
    if (model.count === 0) {
        return;
    }

    let cx = 0;
    let cy = 0;
    let cz = 0;

    for (let i = 0; i < model.count; i++) {
        cx += model.x[i];
        cy += model.y[i];
        cz += model.z[i];
    }

    cx /= model.count;
    cy /= model.count;
    cz /= model.count;

    for (let i = 0; i < model.count; i++) {
        model.x[i] -= cx;
        model.y[i] -= cy;
        model.z[i] -= cz;
    }
};

const normalizeScale = (model: SplatArrays, targetScale: number) => {
    if (model.count === 0) {
        return;
    }

    let minX = model.x[0];
    let minY = model.y[0];
    let minZ = model.z[0];
    let maxX = model.x[0];
    let maxY = model.y[0];
    let maxZ = model.z[0];

    for (let i = 1; i < model.count; i++) {
        minX = Math.min(minX, model.x[i]);
        minY = Math.min(minY, model.y[i]);
        minZ = Math.min(minZ, model.z[i]);
        maxX = Math.max(maxX, model.x[i]);
        maxY = Math.max(maxY, model.y[i]);
        maxZ = Math.max(maxZ, model.z[i]);
    }

    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    const maxExtent = Math.max(extentX, extentY, extentZ);

    if (!(Number.isFinite(maxExtent) && maxExtent > 0)) {
        return;
    }

    const scaleFactor = targetScale / maxExtent;
    const logScaleFactor = Math.log(scaleFactor);

    for (let i = 0; i < model.count; i++) {
        model.x[i] *= scaleFactor;
        model.y[i] *= scaleFactor;
        model.z[i] *= scaleFactor;
        model.scale0[i] += logScaleFactor;
        model.scale1[i] += logScaleFactor;
        model.scale2[i] += logScaleFactor;
    }
};

// 去中心+尺度归一化
const preprocessModel = (model: SplatArrays, options: GsplatMorphOptions) => {
    const hasSceneSourceTransforms = !!options.sourceEntities?.length;
    if (options.recenterModels ?? !hasSceneSourceTransforms) {
        recenterPointCloud(model);
    }

    if (options.normalizeScales ?? !hasSceneSourceTransforms) {
        normalizeScale(model, options.targetScale ?? DEFAULT_TARGET_SCALE);
    }
};

const quatMulValues = (
    ax: number,
    ay: number,
    az: number,
    aw: number,
    bx: number,
    by: number,
    bz: number,
    bw: number
) => ({
    x: aw * bx + ax * bw + ay * bz - az * by,
    y: aw * by - ax * bz + ay * bw + az * bx,
    z: aw * bz + ax * by - ay * bx + az * bw,
    w: aw * bw - ax * bx - ay * by - az * bz
});

const bakeEntityTransformIntoSplats = (
    splats: SplatArrays,
    sourceEntity: Entity | undefined,
    anchorEntity: Entity | undefined
) => {
    if (!sourceEntity || !anchorEntity || splats.count === 0) {
        return;
    }

    const invAnchor = new Mat4();
    const rel = new Mat4();
    invAnchor.copy(anchorEntity.getWorldTransform()).invert();
    rel.mul2(invAnchor, sourceEntity.getWorldTransform());

    const p = new pc.Vec3();
    const out = new pc.Vec3();
    for (let i = 0; i < splats.count; i++) {
        p.set(splats.x[i], splats.y[i], splats.z[i]);
        rel.transformPoint(p, out);
        splats.x[i] = out.x;
        splats.y[i] = out.y;
        splats.z[i] = out.z;
    }

    const axis = new pc.Vec3();
    const relScaleX = Math.max(rel.transformVector(pc.Vec3.RIGHT, axis).length(), 1e-6);
    const relScaleY = Math.max(rel.transformVector(pc.Vec3.UP, axis).length(), 1e-6);
    const relScaleZ = Math.max(rel.transformVector(pc.Vec3.FORWARD, axis).length(), 1e-6);
    const logScaleX = Math.log(relScaleX);
    const logScaleY = Math.log(relScaleY);
    const logScaleZ = Math.log(relScaleZ);

    const anchorRotInv = anchorEntity.getRotation().clone().invert();
    const sourceRot = sourceEntity.getRotation();
    const relRot = anchorRotInv.mul(sourceRot);
    for (let i = 0; i < splats.count; i++) {
        const q = quatMulValues(
            relRot.x,
            relRot.y,
            relRot.z,
            relRot.w,
            splats.rot1[i],
            splats.rot2[i],
            splats.rot3[i],
            splats.rot0[i]
        );
        const invLen = 1 / Math.max(Math.hypot(q.x, q.y, q.z, q.w), 1e-6);
        splats.rot1[i] = q.x * invLen;
        splats.rot2[i] = q.y * invLen;
        splats.rot3[i] = q.z * invLen;
        splats.rot0[i] = q.w * invLen;
        splats.scale0[i] += logScaleX;
        splats.scale1[i] += logScaleY;
        splats.scale2[i] += logScaleZ;
    }
};

const createMutableGSplatData = (numSplats: number, restPropCount: number) => {
    const makeFloatProp = (name: string) => ({
        type: 'float' as const,
        name,
        storage: new Float32Array(numSplats),
        byteSize: 4
    });

    const properties = [
        makeFloatProp('x'),
        makeFloatProp('y'),
        makeFloatProp('z'),
        makeFloatProp('opacity'),
        makeFloatProp('rot_0'),
        makeFloatProp('rot_1'),
        makeFloatProp('rot_2'),
        makeFloatProp('rot_3'),
        makeFloatProp('f_dc_0'),
        makeFloatProp('f_dc_1'),
        makeFloatProp('f_dc_2'),
        makeFloatProp('scale_0'),
        makeFloatProp('scale_1'),
        makeFloatProp('scale_2')
    ];

    for (let i = 0; i < restPropCount; i++) {
        properties.push(makeFloatProp(`f_rest_${i}`));
    }

    const data = new GSplatData([{
        name: 'vertex',
        count: numSplats,
        properties
    }]);

    return {
        data,
        arrays: {
            count: numSplats,
            x: data.getProp('x') as Float32Array,
            y: data.getProp('y') as Float32Array,
            z: data.getProp('z') as Float32Array,
            opacity: data.getProp('opacity') as Float32Array,
            rot0: data.getProp('rot_0') as Float32Array,
            rot1: data.getProp('rot_1') as Float32Array,
            rot2: data.getProp('rot_2') as Float32Array,
            rot3: data.getProp('rot_3') as Float32Array,
            fdc0: data.getProp('f_dc_0') as Float32Array,
            fdc1: data.getProp('f_dc_1') as Float32Array,
            fdc2: data.getProp('f_dc_2') as Float32Array,
            scale0: data.getProp('scale_0') as Float32Array,
            scale1: data.getProp('scale_1') as Float32Array,
            scale2: data.getProp('scale_2') as Float32Array,
            rest: Array.from({ length: restPropCount }, (_, i) => data.getProp(`f_rest_${i}`) as Float32Array)
        } satisfies SplatArrays
    };
};

const normalizeQuat = (x: number, y: number, z: number, w: number) => {
    const length = Math.hypot(x, y, z, w);
    if (length <= 1e-8) {
        return { x: 0, y: 0, z: 0, w: 1 };
    }

    return {
        x: x / length,
        y: y / length,
        z: z / length,
        w: w / length
    };
};

const slerpQuat = (
    ax: number, ay: number, az: number, aw: number,
    bx: number, by: number, bz: number, bw: number,
    t: number
) => {
    let qa = normalizeQuat(ax, ay, az, aw);
    let qb = normalizeQuat(bx, by, bz, bw);

    let dot = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w;
    if (dot < 0) {
        qb = { x: -qb.x, y: -qb.y, z: -qb.z, w: -qb.w };
        dot = -dot;
    }

    if (dot > 0.9995) {
        return normalizeQuat(
            qa.x + (qb.x - qa.x) * t,
            qa.y + (qb.y - qa.y) * t,
            qa.z + (qb.z - qa.z) * t,
            qa.w + (qb.w - qa.w) * t
        );
    }

    const theta0 = Math.acos(clamp(dot, -1, 1));
    const sinTheta0 = Math.sin(theta0);
    if (Math.abs(sinTheta0) < 1e-6) {
        return qa;
    }

    const theta = theta0 * t;
    const s1 = Math.sin(theta0 - theta) / sinTheta0;
    const s2 = Math.sin(theta) / sinTheta0;

    return {
        x: qa.x * s1 + qb.x * s2,
        y: qa.y * s1 + qb.y * s2,
        z: qa.z * s1 + qb.z * s2,
        w: qa.w * s1 + qb.w * s2
    };
};
// 构建帧索引对应表
const nlerpQuat = (
    ax: number, ay: number, az: number, aw: number,
    bx: number, by: number, bz: number, bw: number,
    t: number
) => {
    let dot = ax * bx + ay * by + az * bz + aw * bw;
    if (dot < 0) {
        bx = -bx;
        by = -by;
        bz = -bz;
        bw = -bw;
    }

    return normalizeQuat(
        ax + (bx - ax) * t,
        ay + (by - ay) * t,
        az + (bz - az) * t,
        aw + (bw - aw) * t
    );
};

type GpuSplatContainer = {
    centers: Float32Array;
    aabb: any;
    getTexture: (name: string) => { lock: () => Float32Array | Uint16Array; unlock: () => void };
    update: (numSplats: number, centersUpdated?: boolean) => void;
    destroy?: () => void;
};

type GpuMorphModel = {
    container: GpuSplatContainer;
    count: number;
};

const floatToHalf = (value: number) => {
    const packing = (pc as any).FloatPacking;
    if (packing?.float2Half) {
        return packing.float2Half(value);
    }

    const floatView = new Float32Array(1);
    const int32View = new Int32Array(floatView.buffer);
    floatView[0] = value;
    const x = int32View[0];
    let bits = (x >> 16) & 0x8000;
    let m = (x >> 12) & 0x07ff;
    const e = (x >> 23) & 0xff;

    if (e < 103) {
        return bits;
    }
    if (e > 142) {
        bits |= 0x7c00;
        return bits | ((e === 255 ? 0 : 1) && (x & 0x007fffff));
    }
    if (e < 113) {
        m |= 0x0800;
        return bits | ((m >> (114 - e)) + ((m >> (113 - e)) & 1));
    }

    return bits | ((e - 112) << 10) | ((m >> 1) + (m & 1));
};

const writeHalfOrFloat = (array: Float32Array | Uint16Array, index: number, value: number) => {
    array[index] = array instanceof Float32Array ? value : floatToHalf(value);
};

const sigmoid = (value: number) => 1 / (1 + Math.exp(-value));

const createAabbFromModels = (models: LoadedMorphModel[]) => {
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;

    for (const { splats } of models) {
        for (let i = 0; i < splats.count; i++) {
            minX = Math.min(minX, splats.x[i]);
            minY = Math.min(minY, splats.y[i]);
            minZ = Math.min(minZ, splats.z[i]);
            maxX = Math.max(maxX, splats.x[i]);
            maxY = Math.max(maxY, splats.y[i]);
            maxZ = Math.max(maxZ, splats.z[i]);
        }
    }

    if (!Number.isFinite(minX)) {
        return new pc.BoundingBox(new pc.Vec3(), new pc.Vec3(1, 1, 1));
    }

    return new pc.BoundingBox(
        new pc.Vec3((minX + maxX) * 0.5, (minY + maxY) * 0.5, (minZ + maxZ) * 0.5),
        new pc.Vec3(
            Math.max(0.001, (maxX - minX) * 0.5),
            Math.max(0.001, (maxY - minY) * 0.5),
            Math.max(0.001, (maxZ - minZ) * 0.5)
        )
    );
};

const fillGpuContainerFromSplats = (container: GpuSplatContainer, splats: SplatArrays) => {
    const centerData = container.getTexture('dataCenter').lock();
    const colorData = container.getTexture('dataColor').lock();
    const scaleData = container.getTexture('dataScale').lock();
    const rotationData = container.getTexture('dataRotation').lock();

    for (let i = 0; i < splats.count; i++) {
        const c4 = i * 4;
        const c3 = i * 3;

        centerData[c4] = splats.x[i];
        centerData[c4 + 1] = splats.y[i];
        centerData[c4 + 2] = splats.z[i];
        centerData[c4 + 3] = 1;

        writeHalfOrFloat(colorData, c4, clamp(splats.fdc0[i] * SH_C0 + 0.5, 0, 1));
        writeHalfOrFloat(colorData, c4 + 1, clamp(splats.fdc1[i] * SH_C0 + 0.5, 0, 1));
        writeHalfOrFloat(colorData, c4 + 2, clamp(splats.fdc2[i] * SH_C0 + 0.5, 0, 1));
        writeHalfOrFloat(colorData, c4 + 3, sigmoid(splats.opacity[i]));

        writeHalfOrFloat(scaleData, c4, Math.exp(splats.scale0[i]));
        writeHalfOrFloat(scaleData, c4 + 1, Math.exp(splats.scale1[i]));
        writeHalfOrFloat(scaleData, c4 + 2, Math.exp(splats.scale2[i]));
        writeHalfOrFloat(scaleData, c4 + 3, 0);

        const q = normalizeQuat(splats.rot1[i], splats.rot2[i], splats.rot3[i], splats.rot0[i]);
        writeHalfOrFloat(rotationData, c4, q.x);
        writeHalfOrFloat(rotationData, c4 + 1, q.y);
        writeHalfOrFloat(rotationData, c4 + 2, q.z);
        writeHalfOrFloat(rotationData, c4 + 3, q.w);

        container.centers[c3] = splats.x[i];
        container.centers[c3 + 1] = splats.y[i];
        container.centers[c3 + 2] = splats.z[i];
    }

    container.getTexture('dataCenter').unlock();
    container.getTexture('dataColor').unlock();
    container.getTexture('dataScale').unlock();
    container.getTexture('dataRotation').unlock();
};

const writeGpuSplat = (
    centerData: Float32Array | Uint16Array,
    colorData: Float32Array | Uint16Array,
    scaleData: Float32Array | Uint16Array,
    rotationData: Float32Array | Uint16Array,
    centers: Float32Array,
    write: number,
    splats: SplatArrays,
    src: number,
    invisible = false,
    fadeLogMin = DEFAULT_FADE_LOG_MIN
) => {
    const c4 = write * 4;
    const c3 = write * 3;
    centerData[c4] = splats.x[src] ?? 0;
    centerData[c4 + 1] = splats.y[src] ?? 0;
    centerData[c4 + 2] = splats.z[src] ?? 0;
    centerData[c4 + 3] = 1;

    writeHalfOrFloat(colorData, c4, clamp((splats.fdc0[src] ?? 0) * SH_C0 + 0.5, 0, 1));
    writeHalfOrFloat(colorData, c4 + 1, clamp((splats.fdc1[src] ?? 0) * SH_C0 + 0.5, 0, 1));
    writeHalfOrFloat(colorData, c4 + 2, clamp((splats.fdc2[src] ?? 0) * SH_C0 + 0.5, 0, 1));
    writeHalfOrFloat(colorData, c4 + 3, invisible ? sigmoid(fadeLogMin) : sigmoid(splats.opacity[src] ?? fadeLogMin));

    const scale0 = invisible ? fadeLogMin : (splats.scale0[src] ?? fadeLogMin);
    const scale1 = invisible ? fadeLogMin : (splats.scale1[src] ?? fadeLogMin);
    const scale2 = invisible ? fadeLogMin : (splats.scale2[src] ?? fadeLogMin);
    writeHalfOrFloat(scaleData, c4, Math.exp(scale0));
    writeHalfOrFloat(scaleData, c4 + 1, Math.exp(scale1));
    writeHalfOrFloat(scaleData, c4 + 2, Math.exp(scale2));
    writeHalfOrFloat(scaleData, c4 + 3, 0);

    const q = normalizeQuat(splats.rot1[src] ?? 0, splats.rot2[src] ?? 0, splats.rot3[src] ?? 0, splats.rot0[src] ?? 1);
    writeHalfOrFloat(rotationData, c4, q.x);
    writeHalfOrFloat(rotationData, c4 + 1, q.y);
    writeHalfOrFloat(rotationData, c4 + 2, q.z);
    writeHalfOrFloat(rotationData, c4 + 3, q.w);

    centers[c3] = splats.x[src] ?? 0;
    centers[c3 + 1] = splats.y[src] ?? 0;
    centers[c3 + 2] = splats.z[src] ?? 0;
};

const fillGpuContainerFromMapping = (
    container: GpuSplatContainer,
    splats: SplatArrays,
    indices: Uint32Array,
    outputCount: number,
    fadeLogMin = DEFAULT_FADE_LOG_MIN
) => {
    const centerData = container.getTexture('dataCenter').lock();
    const colorData = container.getTexture('dataColor').lock();
    const scaleData = container.getTexture('dataScale').lock();
    const rotationData = container.getTexture('dataRotation').lock();
    const fallback = splats.count > 0 ? 0 : -1;

    for (let i = 0; i < outputCount; i++) {
        if (i < indices.length && indices[i] < splats.count) {
            writeGpuSplat(
                centerData,
                colorData,
                scaleData,
                rotationData,
                container.centers,
                i,
                splats,
                indices[i],
                false,
                fadeLogMin
            );
        } else if (fallback >= 0) {
            writeGpuSplat(centerData, colorData, scaleData, rotationData, container.centers, i, splats, fallback, true, fadeLogMin);
        }
    }

    container.getTexture('dataCenter').unlock();
    container.getTexture('dataColor').unlock();
    container.getTexture('dataScale').unlock();
    container.getTexture('dataRotation').unlock();
    container.update(outputCount, true);
};

class GpuMorphRuntime {
    readonly resource: GpuSplatContainer;

    private readonly _accumulator: GpuSplatContainer;

    private readonly _models: GpuMorphModel[];

    private readonly _sourceModels: LoadedMorphModel[];

    private readonly _device: any;

    private readonly _outputCount: number;

    private readonly _fadeLogMin: number;

    private readonly _progressivePairFlight: boolean;

    private readonly _progressivePairFlightWindow: number;

    private readonly _hourglass: MorphHourglassSettings;

    private readonly _pairAxisParams: PairAxisParams[];

    private _correspondences?: Map<string, PairCorrespondence>;

    private readonly _pairSourceA?: GpuSplatContainer;

    private readonly _pairSourceB?: GpuSplatContainer;

    private readonly _copyAndWeightGLSL = `
        uniform float uGlobalT;
        uniform float uIsTarget;
        uniform float uProgressivePairFlight;
        uniform float uProgressivePairFlightWindow;
        uniform vec3 uPairAxisOrigin;
        uniform vec3 uPairAxisDir;
        uniform float uPairProjMin;
        uniform float uPairProjSpan;
        uniform float uReversePlayback;

        float localPairT() {
            float globalT = clamp(uGlobalT, 0.0, 1.0);
            if (uProgressivePairFlight < 0.5 || dstNumSplats <= 1u) {
                return globalT;
            }
            float window = clamp(uProgressivePairFlightWindow, 0.0001, 1.0);
            vec3 localCenter = getCenter();
            float projected = dot(localCenter - uPairAxisOrigin, uPairAxisDir);
            float axisS = clamp((projected - uPairProjMin) / max(uPairProjSpan, 0.0001), 0.0, 1.0);
            float phase = mix(1.0 - axisS, axisS, uIsTarget);
            phase = pow(clamp(phase, 0.0, 1.0), 1.8);
            float delay = phase * (1.0 - window);
            float t;
            if (uReversePlayback > 0.5) {
                float reverseProgress = 1.0 - globalT;
                t = 1.0 - clamp((reverseProgress - delay) / window, 0.0, 1.0);
            } else {
                t = clamp((globalT - delay) / window, 0.0, 1.0);
            }
            return t * t * (3.0 - 2.0 * t);
        }

        uint resampledSourceIndex() {
            if (srcNumSplats == 0u) {
                return 0u;
            }
            if (srcNumSplats >= dstNumSplats) {
                return min(splat.index, srcNumSplats - 1u);
            }
            return min(uint(floor(float(splat.index) * float(srcNumSplats) / float(dstNumSplats))), srcNumSplats - 1u);
        }

        void process() {
            setSplat(resampledSourceIndex());
            float t = localPairT();
            float weight = mix(1.0 - t, t, uIsTarget);
            writeDataCenter(vec4(getCenter() * weight, 0.0));
            vec4 color = getColor();
            color.a = log(max(color.a, 0.000001) / max(1.0 - color.a, 0.000001));
            writeDataColor(color * weight);
            writeDataScale(vec4(log(max(getScale(), vec3(0.000001))) * weight, 0.0));
            writeDataRotation(getRotation() * weight);
        }
    `;

    private readonly _copyAndWeightWGSL = `
        uniform uGlobalT: f32;
        uniform uIsTarget: f32;
        uniform uProgressivePairFlight: f32;
        uniform uProgressivePairFlightWindow: f32;
        uniform uPairAxisOrigin: vec3f;
        uniform uPairAxisDir: vec3f;
        uniform uPairProjMin: f32;
        uniform uPairProjSpan: f32;
        uniform uReversePlayback: f32;

        fn localPairT() -> f32 {
            let globalT = clamp(uniform.uGlobalT, 0.0, 1.0);
            if (uniform.uProgressivePairFlight < 0.5 || uniform.dstNumSplats <= 1u) {
                return globalT;
            }
            let window = clamp(uniform.uProgressivePairFlightWindow, 0.0001, 1.0);
            let localCenter = getCenter();
            let projected = dot(localCenter - uniform.uPairAxisOrigin, uniform.uPairAxisDir);
            let axisS = clamp((projected - uniform.uPairProjMin) / max(uniform.uPairProjSpan, 0.0001), 0.0, 1.0);
            let phase = mix(1.0 - axisS, axisS, uniform.uIsTarget);
            phase = pow(clamp(phase, 0.0, 1.0), 1.8);
            let delay = phase * (1.0 - window);
            var t = clamp((globalT - delay) / window, 0.0, 1.0);
            if (uniform.uReversePlayback > 0.5) {
                let reverseProgress = 1.0 - globalT;
                t = 1.0 - clamp((reverseProgress - delay) / window, 0.0, 1.0);
            }
            return t * t * (3.0 - 2.0 * t);
        }

        fn resampledSourceIndex() -> u32 {
            if (uniform.srcNumSplats == 0u) {
                return 0u;
            }
            if (uniform.srcNumSplats >= uniform.dstNumSplats) {
                return min(splat.index, uniform.srcNumSplats - 1u);
            }
            return min(u32(floor(f32(splat.index) * f32(uniform.srcNumSplats) / f32(uniform.dstNumSplats))), uniform.srcNumSplats - 1u);
        }

        fn process() {
            setSplat(resampledSourceIndex());
            let t = localPairT();
            let weight = mix(1.0 - t, t, uniform.uIsTarget);
            writeDataCenter(vec4f(getCenter() * weight, 0.0));
            var color = getColor();
            color.a = log(max(color.a, 0.000001) / max(1.0 - color.a, 0.000001));
            writeDataColor(color * weight);
            writeDataScale(vec4f(log(max(getScale(), vec3f(0.000001))) * weight, 0.0));
            writeDataRotation(getRotation() * weight);
        }
    `;

    private readonly _normalizeGLSL = `
        uniform float uGlobalT;
        uniform float uHourglassEnabled;
        uniform float uHourglassStrength;
        uniform float uHourglassWaistRatio;
        uniform float uHourglassWaistPinch;
        uniform float uHourglassPerturbAmp;
        uniform float uHourglassSparkIntensity;
        uniform float uHourglassSparkTwist;
        uniform float uHourglassSparkDrift;
        uniform float uHourglassParticleLogScale;
        uniform float uHourglassParticleScaleFrac;
        uniform float uHourglassParticleMaxDiameter;
        uniform float uHourglassTintMix;
        uniform float uHourglassConform;
        uniform float uMorphLocalT;
        uniform vec3 uHourglassTintA;
        uniform vec3 uHourglassTintB;
        uniform vec3 uPairAxisOrigin;
        uniform vec3 uPairAxisDir;
        uniform float uPairProjMin;
        uniform float uPairProjSpan;

        mat2 rot2(float a) {
            float s = sin(a);
            float c = cos(a);
            return mat2(c, -s, s, c);
        }

        vec3 sparkHash3(vec3 p) {
            return fract(sin(p * 123.456) * 123.456);
        }

        void hourglassRadialPinch(
            inout vec3 center,
            out float axisS,
            out float pinchProfile,
            out float particleBand,
            out float morphActive
        ) {
            axisS = 0.0;
            pinchProfile = 0.0;
            particleBand = 0.0;
            morphActive = 0.0;
            if (uHourglassEnabled < 0.5) {
                return;
            }
            morphActive = smoothstep(0.02, 0.08, uGlobalT) * (1.0 - smoothstep(0.9, 0.98, uGlobalT));
            if (morphActive <= 0.03) {
                return;
            }
            float projected = dot(center - uPairAxisOrigin, uPairAxisDir);
            axisS = clamp((projected - uPairProjMin) / max(uPairProjSpan, 0.0001), 0.0, 1.0);
            float u = 1.0 - abs(2.0 * axisS - 1.0);
            pinchProfile = pow(max(u, 0.0), max(uHourglassWaistPinch, 0.5));
            if (pinchProfile <= 0.001) {
                return;
            }
            vec3 axisPoint = uPairAxisOrigin + uPairAxisDir * projected;
            vec3 radial = center - axisPoint;
            float axial = dot(radial, uPairAxisDir);
            radial -= uPairAxisDir * axial;
            float pinchAmt = clamp(morphActive * pinchProfile * uHourglassStrength * uHourglassConform, 0.0, 1.0);
            float radialScale = 1.0 - (1.0 - uHourglassWaistRatio) * pinchAmt;
            radial *= radialScale;
            vec3 perp = normalize(cross(uPairAxisDir, vec3(0.0, 1.0, 0.0)));
            if (length(perp) < 0.1) {
                perp = normalize(cross(uPairAxisDir, vec3(1.0, 0.0, 0.0)));
            }
            vec3 perp2 = normalize(cross(uPairAxisDir, perp));
            float wobble = uHourglassPerturbAmp * uPairProjSpan * pinchProfile * morphActive;
            float flowPhase = uGlobalT * 6.2831853 + uMorphLocalT * 3.14159265 + float(splat.index) * 0.17;
            center = axisPoint + uPairAxisDir * axial + radial;
            center += perp * sin(flowPhase * 1.1 + float(splat.index)) * wobble;
            center += perp2 * cos(flowPhase * 0.85 + float(splat.index) * 2.3) * wobble;
            particleBand = clamp(morphActive * pinchProfile * uHourglassStrength, 0.0, 1.0);
        }

        void applySparkDisintegrate(
            inout vec3 center,
            float axisS,
            float pinchProfile,
            float particleBand,
            float morphActive,
            out float sparkTt
        ) {
            sparkTt = 0.0;
            if (particleBand <= 0.02) {
                return;
            }
            float projected = dot(center - uPairAxisOrigin, uPairAxisDir);
            vec3 axisPoint = uPairAxisOrigin + uPairAxisDir * projected;
            vec3 h = sparkHash3(center * 0.65 + vec3(float(splat.index) * 0.013));
            center += (h * 2.0 - 1.0) * uHourglassSparkIntensity * uPairProjSpan * particleBand;

            float sparkPhase = sin(
                uGlobalT * 6.2831853 + uMorphLocalT * 3.14159265 + axisS * 4.0 - projected * 0.5 + float(splat.index) * 0.11
            );
            sparkTt = smoothstep(-1.0, 0.5, -sparkPhase) * pinchProfile * morphActive;

            vec3 radial = center - axisPoint;
            float axial = dot(radial, uPairAxisDir);
            radial -= uPairAxisDir * axial;
            vec3 perp = normalize(cross(uPairAxisDir, vec3(0.0, 1.0, 0.0)));
            if (length(perp) < 0.1) {
                perp = normalize(cross(uPairAxisDir, vec3(1.0, 0.0, 0.0)));
            }
            vec3 perp2 = normalize(cross(uPairAxisDir, perp));
            vec2 rp = vec2(dot(radial, perp), dot(radial, perp2));
            float ang = sparkTt * 2.0 + axial * 2.0 * sparkTt * uHourglassSparkTwist;
            rp = rot2(ang) * rp;
            center = axisPoint + uPairAxisDir * axial + perp * rp.x + perp2 * rp.y;

            float seed = float(splat.index);
            vec3 rh = sparkHash3(vec3(seed * 0.071, axisS * 5.31, projected * 0.019));
            float t1 = uGlobalT * 6.2831853 + uMorphLocalT * 4.5 + rh.x * 6.2831853;
            float t2 = uGlobalT * 5.1 + uMorphLocalT * 3.7 + rh.y * 6.2831853 + seed * 0.31;
            float t3 = uGlobalT * 7.2 + uMorphLocalT * 5.3 + rh.z * 6.2831853 + seed * 0.19;
            float driftAmp = uHourglassSparkDrift * uPairProjSpan * particleBand;
            vec3 rh2 = sparkHash3(vec3(seed, t1 * 0.13, t2 * 0.11));
            vec3 drift = (perp * sin(t1 * (1.15 + rh.x * 0.4) + seed)
                + perp2 * cos(t2 * (0.95 + rh.y * 0.5) + seed * 2.1)) * driftAmp;
            drift += (perp * sin(t2 * 2.3 + rh2.y * 12.0) + perp2 * sin(t1 * 1.9 + rh2.z * 12.0)) * driftAmp * 0.55;
            drift += uPairAxisDir * sin(t3 * 0.6 + seed * 0.07) * driftAmp * 0.22;
            center += drift;
        }

        void process() {
            vec3 center = getCenter();
            float axisS = 0.0;
            float pinchProfile = 0.0;
            float particleBand = 0.0;
            float morphActive = 0.0;
            hourglassRadialPinch(center, axisS, pinchProfile, particleBand, morphActive);
            float sparkTt = 0.0;
            applySparkDisintegrate(center, axisS, pinchProfile, particleBand, morphActive, sparkTt);
            vec4 color = getColor();
            float hgEffect = particleBand;
            if (hgEffect > 0.03 && uHourglassTintMix > 0.001) {
                vec3 tint = mix(uHourglassTintA, uHourglassTintB, axisS);
                color.rgb = mix(color.rgb, tint, hgEffect * uHourglassTintMix);
            }
            color.a = 1.0 / (1.0 + exp(-color.a));
            vec3 scale = exp(getScale());
            vec4 rot = normalize(getRotation());
            if (particleBand > 0.02) {
                float particleSize = min(
                    uPairProjSpan * uHourglassParticleScaleFrac,
                    uHourglassParticleMaxDiameter
                );
                float currentRms = sqrt(dot(scale, scale) / 3.0);
                float scaleBlend = clamp(particleBand, 0.0, 1.0);
                float targetSize = mix(currentRms, particleSize, scaleBlend);
                scale = vec3(targetSize);
                vec4 idRot = vec4(0.0, 0.0, 0.0, 1.0);
                rot = normalize(mix(rot, idRot, scaleBlend));
            }
            writeDataCenter(vec4(center, 1.0));
            writeDataColor(color);
            writeDataScale(vec4(scale, 0.0));
            writeDataRotation(rot);
        }
    `;

    private readonly _normalizeWGSL = `
        uniform uGlobalT: f32;
        uniform uHourglassEnabled: f32;
        uniform uHourglassStrength: f32;
        uniform uHourglassWaistRatio: f32;
        uniform uHourglassWaistPinch: f32;
        uniform uHourglassPerturbAmp: f32;
        uniform uHourglassSparkIntensity: f32;
        uniform uHourglassSparkTwist: f32;
        uniform uHourglassSparkDrift: f32;
        uniform uHourglassParticleLogScale: f32;
        uniform uHourglassParticleScaleFrac: f32;
        uniform uHourglassParticleMaxDiameter: f32;
        uniform uHourglassTintMix: f32;
        uniform uHourglassConform: f32;
        uniform uMorphLocalT: f32;
        uniform uHourglassTintA: vec3f;
        uniform uHourglassTintB: vec3f;
        uniform uPairAxisOrigin: vec3f;
        uniform uPairAxisDir: vec3f;
        uniform uPairProjMin: f32;
        uniform uPairProjSpan: f32;

        fn rot2(a: f32) -> mat2x2f {
            let s = sin(a);
            let c = cos(a);
            return mat2x2f(c, -s, s, c);
        }

        fn sparkHash3(p: vec3f) -> vec3f {
            return fract(sin(p * 123.456) * 123.456);
        }

        fn hourglassRadialPinch(
            center: ptr<function, vec3f>,
            axisS: ptr<function, f32>,
            pinchProfile: ptr<function, f32>,
            particleBand: ptr<function, f32>,
            morphActive: ptr<function, f32>
        ) {
            if (uniform.uHourglassEnabled < 0.5) {
                return;
            }
            *morphActive = smoothstep(0.02, 0.08, uniform.uGlobalT) * (1.0 - smoothstep(0.9, 0.98, uniform.uGlobalT));
            if (*morphActive <= 0.03) {
                return;
            }
            let projected = dot(*center - uniform.uPairAxisOrigin, uniform.uPairAxisDir);
            *axisS = clamp((projected - uniform.uPairProjMin) / max(uniform.uPairProjSpan, 0.0001), 0.0, 1.0);
            let u = 1.0 - abs(2.0 * *axisS - 1.0);
            *pinchProfile = pow(max(u, 0.0), max(uniform.uHourglassWaistPinch, 0.5));
            if (*pinchProfile <= 0.001) {
                return;
            }
            let axisPoint = uniform.uPairAxisOrigin + uniform.uPairAxisDir * projected;
            var radial = *center - axisPoint;
            let axial = dot(radial, uniform.uPairAxisDir);
            radial -= uniform.uPairAxisDir * axial;
            let pinchAmt = clamp(*morphActive * *pinchProfile * uniform.uHourglassStrength * uniform.uHourglassConform, 0.0, 1.0);
            let radialScale = 1.0 - (1.0 - uniform.uHourglassWaistRatio) * pinchAmt;
            radial *= radialScale;
            var perp = normalize(cross(uniform.uPairAxisDir, vec3f(0.0, 1.0, 0.0)));
            if (length(perp) < 0.1) {
                perp = normalize(cross(uniform.uPairAxisDir, vec3f(1.0, 0.0, 0.0)));
            }
            let perp2 = normalize(cross(uniform.uPairAxisDir, perp));
            let wobble = uniform.uHourglassPerturbAmp * uniform.uPairProjSpan * *pinchProfile * *morphActive;
            let flowPhase = uniform.uGlobalT * 6.2831853 + uniform.uMorphLocalT * 3.14159265 + f32(splat.index) * 0.17;
            *center = axisPoint + uniform.uPairAxisDir * axial + radial;
            *center += perp * sin(flowPhase * 1.1 + f32(splat.index)) * wobble;
            *center += perp2 * cos(flowPhase * 0.85 + f32(splat.index) * 2.3) * wobble;
            *particleBand = clamp(*morphActive * *pinchProfile * uniform.uHourglassStrength, 0.0, 1.0);
        }

        fn applySparkDisintegrate(
            center: ptr<function, vec3f>,
            axisS: f32,
            pinchProfile: f32,
            particleBand: f32,
            morphActive: f32,
            sparkTt: ptr<function, f32>
        ) {
            *sparkTt = 0.0;
            if (particleBand <= 0.02) {
                return;
            }
            let projected = dot(*center - uniform.uPairAxisOrigin, uniform.uPairAxisDir);
            let axisPoint = uniform.uPairAxisOrigin + uniform.uPairAxisDir * projected;
            let h = sparkHash3(*center * 0.65 + vec3f(f32(splat.index) * 0.013));
            *center += (h * 2.0 - 1.0) * uniform.uHourglassSparkIntensity * uniform.uPairProjSpan * particleBand;

            let sparkPhase = sin(
                uniform.uGlobalT * 6.2831853 + uniform.uMorphLocalT * 3.14159265 + axisS * 4.0 - projected * 0.5 + f32(splat.index) * 0.11
            );
            *sparkTt = smoothstep(-1.0, 0.5, -sparkPhase) * pinchProfile * morphActive;

            var radial = *center - axisPoint;
            let axial = dot(radial, uniform.uPairAxisDir);
            radial -= uniform.uPairAxisDir * axial;
            var perp = normalize(cross(uniform.uPairAxisDir, vec3f(0.0, 1.0, 0.0)));
            if (length(perp) < 0.1) {
                perp = normalize(cross(uniform.uPairAxisDir, vec3f(1.0, 0.0, 0.0)));
            }
            let perp2 = normalize(cross(uniform.uPairAxisDir, perp));
            var rp = vec2f(dot(radial, perp), dot(radial, perp2));
            let ang = *sparkTt * 2.0 + axial * 2.0 * *sparkTt * uniform.uHourglassSparkTwist;
            rp = rot2(ang) * rp;
            *center = axisPoint + uniform.uPairAxisDir * axial + perp * rp.x + perp2 * rp.y;

            let seed = f32(splat.index);
            let rh = sparkHash3(vec3f(seed * 0.071, axisS * 5.31, projected * 0.019));
            let t1 = uniform.uGlobalT * 6.2831853 + uniform.uMorphLocalT * 4.5 + rh.x * 6.2831853;
            let t2 = uniform.uGlobalT * 5.1 + uniform.uMorphLocalT * 3.7 + rh.y * 6.2831853 + seed * 0.31;
            let t3 = uniform.uGlobalT * 7.2 + uniform.uMorphLocalT * 5.3 + rh.z * 6.2831853 + seed * 0.19;
            let driftAmp = uniform.uHourglassSparkDrift * uniform.uPairProjSpan * particleBand;
            let rh2 = sparkHash3(vec3f(seed, t1 * 0.13, t2 * 0.11));
            var drift = (perp * sin(t1 * (1.15 + rh.x * 0.4) + seed)
                + perp2 * cos(t2 * (0.95 + rh.y * 0.5) + seed * 2.1)) * driftAmp;
            drift += (perp * sin(t2 * 2.3 + rh2.y * 12.0) + perp2 * sin(t1 * 1.9 + rh2.z * 12.0)) * driftAmp * 0.55;
            drift += uniform.uPairAxisDir * sin(t3 * 0.6 + seed * 0.07) * driftAmp * 0.22;
            *center += drift;
        }

        fn process() {
            var center = getCenter();
            var axisS = 0.0;
            var pinchProfile = 0.0;
            var particleBand = 0.0;
            var morphActive = 0.0;
            hourglassRadialPinch(&center, &axisS, &pinchProfile, &particleBand, &morphActive);
            var sparkTt = 0.0;
            applySparkDisintegrate(&center, axisS, pinchProfile, particleBand, morphActive, &sparkTt);
            var color = getColor();
            let hgEffect = particleBand;
            if (hgEffect > 0.03 && uniform.uHourglassTintMix > 0.001) {
                let tint = mix(uniform.uHourglassTintA, uniform.uHourglassTintB, axisS);
                color = vec4f(mix(color.rgb, tint, hgEffect * uniform.uHourglassTintMix), color.a);
            }
            color.a = 1.0 / (1.0 + exp(-color.a));
            var scale = exp(getScale());
            var rot = normalize(getRotation());
            if (particleBand > 0.02) {
                let particleSize = min(
                    uniform.uPairProjSpan * uniform.uHourglassParticleScaleFrac,
                    uniform.uHourglassParticleMaxDiameter
                );
                let currentRms = sqrt(dot(scale, scale) / 3.0);
                let scaleBlend = clamp(particleBand, 0.0, 1.0);
                let targetSize = mix(currentRms, particleSize, scaleBlend);
                scale = vec3f(targetSize);
                let idRot = vec4f(0.0, 0.0, 0.0, 1.0);
                rot = normalize(mix(rot, idRot, scaleBlend));
            }
            writeDataCenter(vec4f(center, 1.0));
            writeDataColor(color);
            writeDataScale(vec4f(scale, 0.0));
            writeDataRotation(rot);
        }
    `;

    private _pairIndex = -1;

    private _processorA: any;

    private _processorB: any;

    private _normalizeProcessor: any;

    constructor(
        app: AppBase,
        models: LoadedMorphModel[],
        outputCount: number,
        correspondences?: Map<string, PairCorrespondence>,
        fadeLogMin = DEFAULT_FADE_LOG_MIN,
        options: GsplatMorphOptions = {}
    ) {
        const GSplatFormat = (pc as any).GSplatFormat;
        const GSplatContainer = (pc as any).GSplatContainer;
        const GSplatProcessor = (pc as any).GSplatProcessor;
        if (!GSplatFormat?.createDefaultFormat || !GSplatContainer || !GSplatProcessor) {
            throw new Error('Current PlayCanvas build does not expose GSplatContainer / GSplatProcessor');
        }

        this._device = app.graphicsDevice;
        this._sourceModels = models;
        this._outputCount = outputCount;
        this._correspondences = correspondences;
        this._fadeLogMin = fadeLogMin;
        this._progressivePairFlight = options.progressivePairFlight ?? true;
        this._progressivePairFlightWindow = options.progressivePairFlightWindow ?? DEFAULT_PROGRESSIVE_PAIR_FLIGHT_WINDOW;
        this._hourglass = resolveMorphHourglassSettings(options);
        this._pairAxisParams = this.buildPairAxisParams(models);
        const aabb = createAabbFromModels(models);
        const format = GSplatFormat.createDefaultFormat(this._device);
        this._models = correspondences ? [] : models.map((model) => {
            const container = new GSplatContainer(this._device, model.splats.count, format) as GpuSplatContainer;
            fillGpuContainerFromSplats(container, model.splats);
            container.aabb = aabb;
            container.update(model.splats.count, true);
            return { container, count: model.splats.count };
        });

        this._accumulator = new GSplatContainer(this._device, outputCount, format) as GpuSplatContainer;
        this.resource = new GSplatContainer(this._device, outputCount, format) as GpuSplatContainer;
        if (correspondences) {
            this._pairSourceA = new GSplatContainer(this._device, outputCount, format) as GpuSplatContainer;
            this._pairSourceB = new GSplatContainer(this._device, outputCount, format) as GpuSplatContainer;
            this._pairSourceA.aabb = aabb;
            this._pairSourceB.aabb = aabb;
            this._pairSourceA.update(outputCount, true);
            this._pairSourceB.update(outputCount, true);
        }
        this._accumulator.aabb = aabb;
        this.resource.aabb = aabb;
        this._accumulator.update(outputCount, true);
        this.resource.update(outputCount, true);
    }

    apply(pairIndex: number, t: number, reversePlayback = false) {
        if (this._pairIndex !== pairIndex) {
            this.destroyProcessors();
            this._pairIndex = pairIndex;
            const GSplatProcessor = (pc as any).GSplatProcessor;
            let sourceA = this._models[pairIndex]?.container;
            let sourceB = this._models[pairIndex + 1]?.container;
            const correspondence = this._correspondences?.get(`${pairIndex}:${pairIndex + 1}`);
            if (correspondence && this._pairSourceA && this._pairSourceB) {
                fillGpuContainerFromMapping(
                    this._pairSourceA,
                    this._sourceModels[pairIndex].splats,
                    correspondence.matchedA,
                    this._outputCount,
                    this._fadeLogMin
                );
                fillGpuContainerFromMapping(
                    this._pairSourceB,
                    this._sourceModels[pairIndex + 1].splats,
                    correspondence.matchedB,
                    this._outputCount,
                    this._fadeLogMin
                );
                sourceA = this._pairSourceA;
                sourceB = this._pairSourceB;
            }
            if (!sourceA || !sourceB) {
                throw new Error(`Missing GPU morph source containers for pair ${pairIndex}:${pairIndex + 1}`);
            }
            this._processorA = new GSplatProcessor(
                this._device,
                { resource: sourceA },
                { resource: this._accumulator, streams: ['dataCenter', 'dataColor', 'dataScale', 'dataRotation'] },
                { processGLSL: this._copyAndWeightGLSL, processWGSL: this._copyAndWeightWGSL }
            );
            this._processorB = new GSplatProcessor(
                this._device,
                { resource: sourceB },
                { resource: this._accumulator, streams: ['dataCenter', 'dataColor', 'dataScale', 'dataRotation'] },
                { processGLSL: this._copyAndWeightGLSL, processWGSL: this._copyAndWeightWGSL }
            );
            this._processorB.blendState = (pc as any).BlendState.ADDBLEND;
            this._normalizeProcessor = new GSplatProcessor(
                this._device,
                { resource: this._accumulator },
                { resource: this.resource, streams: ['dataCenter', 'dataColor', 'dataScale', 'dataRotation'] },
                { processGLSL: this._normalizeGLSL, processWGSL: this._normalizeWGSL }
            );
        }

        this._processorA.setParameter('uGlobalT', t);
        this._processorA.setParameter('uIsTarget', 0);
        this._processorA.setParameter('uProgressivePairFlight', this._progressivePairFlight ? 1 : 0);
        this._processorA.setParameter('uProgressivePairFlightWindow', this._progressivePairFlightWindow);
        const axis = this._pairAxisParams[Math.max(0, Math.min(pairIndex, this._pairAxisParams.length - 1))];
        this._processorA.setParameter('uPairAxisOrigin', [axis.originX, axis.originY, axis.originZ]);
        this._processorA.setParameter('uPairAxisDir', [axis.dirX, axis.dirY, axis.dirZ]);
        this._processorA.setParameter('uPairProjMin', axis.projMin);
        this._processorA.setParameter('uPairProjSpan', axis.projSpan);
        this._processorA.setParameter('uReversePlayback', reversePlayback ? 1 : 0);
        this._processorA.process();
        this._processorB.setParameter('uGlobalT', t);
        this._processorB.setParameter('uIsTarget', 1);
        this._processorB.setParameter('uProgressivePairFlight', this._progressivePairFlight ? 1 : 0);
        this._processorB.setParameter('uProgressivePairFlightWindow', this._progressivePairFlightWindow);
        this._processorB.setParameter('uPairAxisOrigin', [axis.originX, axis.originY, axis.originZ]);
        this._processorB.setParameter('uPairAxisDir', [axis.dirX, axis.dirY, axis.dirZ]);
        this._processorB.setParameter('uPairProjMin', axis.projMin);
        this._processorB.setParameter('uPairProjSpan', axis.projSpan);
        this._processorB.setParameter('uReversePlayback', reversePlayback ? 1 : 0);
        this._processorB.process();
        this._setHourglassNormalizeParams(t, pairIndex);
        this._normalizeProcessor.process();
    }

    private _setHourglassNormalizeParams(t: number, pairIndex: number) {
        const hg = this._hourglass;
        const axis = this._pairAxisParams[Math.max(0, Math.min(pairIndex, this._pairAxisParams.length - 1))];
        this._normalizeProcessor.setParameter('uGlobalT', t);
        this._normalizeProcessor.setParameter('uHourglassEnabled', hg.enabled ? 1 : 0);
        this._normalizeProcessor.setParameter('uHourglassStrength', hg.strength);
        this._normalizeProcessor.setParameter('uHourglassWaistRatio', hg.waistRadialMin);
        this._normalizeProcessor.setParameter('uHourglassWaistPinch', hg.waistPinch);
        this._normalizeProcessor.setParameter('uHourglassPerturbAmp', hg.perturbAmp);
        this._normalizeProcessor.setParameter('uHourglassSparkIntensity', hg.sparkIntensity);
        this._normalizeProcessor.setParameter('uHourglassSparkTwist', hg.sparkTwist);
        this._normalizeProcessor.setParameter('uHourglassSparkDrift', hg.sparkDrift);
        this._normalizeProcessor.setParameter('uMorphLocalT', t);
        this._normalizeProcessor.setParameter(
            'uHourglassParticleLogScale',
            resolveHourglassParticleLogScale(axis, hg)
        );
        this._normalizeProcessor.setParameter('uHourglassParticleScaleFrac', hg.particleScaleFrac);
        this._normalizeProcessor.setParameter('uHourglassParticleMaxDiameter', MORPH_HOURGLASS_PARTICLE_MAX_DIAMETER);
        this._normalizeProcessor.setParameter('uHourglassTintMix', hg.tintMix);
        this._normalizeProcessor.setParameter('uHourglassConform', hg.conform);
        this._normalizeProcessor.setParameter('uHourglassTintA', hg.tintA);
        this._normalizeProcessor.setParameter('uHourglassTintB', hg.tintB);
        this._normalizeProcessor.setParameter('uPairAxisOrigin', [axis.originX, axis.originY, axis.originZ]);
        this._normalizeProcessor.setParameter('uPairAxisDir', [axis.dirX, axis.dirY, axis.dirZ]);
        this._normalizeProcessor.setParameter('uPairProjMin', axis.projMin);
        this._normalizeProcessor.setParameter('uPairProjSpan', axis.projSpan);
    }

    updateSortCenters(models: LoadedMorphModel[], pairIndex: number, t: number, reversePlayback = false) {
        const a = models[pairIndex].splats;
        const b = models[pairIndex + 1].splats;
        const centers = this.resource.centers;
        const outN = centers.length / 3;
        const correspondence = this._correspondences?.get(`${pairIndex}:${pairIndex + 1}`);
        const axis = this._pairAxisParams[Math.max(0, Math.min(pairIndex, this._pairAxisParams.length - 1))];

        for (let i = 0; i < outN; i++) {
            const ia = correspondence && i < correspondence.matchedA.length
                ? correspondence.matchedA[i]
                : (a.count >= outN ? i : Math.min(Math.floor((i * a.count) / outN), a.count - 1));
            const ib = correspondence && i < correspondence.matchedB.length
                ? correspondence.matchedB[i]
                : (b.count >= outN ? i : Math.min(Math.floor((i * b.count) / outN), b.count - 1));
            const projA = (a.x[ia] - axis.originX) * axis.dirX + (a.y[ia] - axis.originY) * axis.dirY + (a.z[ia] - axis.originZ) * axis.dirZ;
            const projB = (b.x[ib] - axis.originX) * axis.dirX + (b.y[ib] - axis.originY) * axis.dirY + (b.z[ib] - axis.originZ) * axis.dirZ;
            const sA = clamp((projA - axis.projMin) / axis.projSpan, 0, 1);
            const sB = clamp((projB - axis.projMin) / axis.projSpan, 0, 1);
            let phase = this._progressivePairFlight
                ? clamp((1 - sA + sB) * 0.5, 0, 1)
                : (outN <= 1 ? 0 : i / Math.max(1, outN - 1));
            phase = Math.pow(phase, 1.8);
            const localT = resolveDirectionalFlightT(
                t,
                phase,
                this._progressivePairFlight,
                this._progressivePairFlightWindow,
                reversePlayback
            );
            const inv = 1 - localT;
            const base = i * 3;
            centers[base] = a.x[ia] * inv + b.x[ib] * localT;
            centers[base + 1] = a.y[ia] * inv + b.y[ib] * localT;
            centers[base + 2] = a.z[ia] * inv + b.z[ib] * localT;
        }

        this.resource.update(outN, true);
    }

    replaceCorrespondences(correspondences: Map<string, PairCorrespondence>) {
        this._correspondences = correspondences;
        this._pairIndex = -1;
        this.destroyProcessors();
    }

    destroy() {
        this.destroyProcessors();
        this._models.forEach(model => model.container.destroy?.());
        this._pairSourceA?.destroy?.();
        this._pairSourceB?.destroy?.();
        this._accumulator.destroy?.();
        this.resource.destroy?.();
    }

    private destroyProcessors() {
        this._processorA?.destroy?.();
        this._processorB?.destroy?.();
        this._normalizeProcessor?.destroy?.();
        this._processorA = undefined;
        this._processorB = undefined;
        this._normalizeProcessor = undefined;
    }

    private buildPairAxisParams(models: LoadedMorphModel[]) {
        const result: PairAxisParams[] = [];
        for (let i = 0; i < models.length - 1; i++) {
            const a = models[i].splats;
            const b = models[i + 1].splats;
            const aAabb = createAabbFromModels([models[i]]);
            const bAabb = createAabbFromModels([models[i + 1]]);
            const ox = aAabb.center.x;
            const oy = aAabb.center.y;
            const oz = aAabb.center.z;
            const dx = bAabb.center.x - ox;
            const dy = bAabb.center.y - oy;
            const dz = bAabb.center.z - oz;
            const len = Math.max(1e-4, Math.hypot(dx, dy, dz));
            const dirX = dx / len;
            const dirY = dy / len;
            const dirZ = dz / len;
            let projMin = Number.POSITIVE_INFINITY;
            let projMax = Number.NEGATIVE_INFINITY;
            for (let j = 0; j < a.count; j++) {
                const p = (a.x[j] - ox) * dirX + (a.y[j] - oy) * dirY + (a.z[j] - oz) * dirZ;
                projMin = Math.min(projMin, p);
                projMax = Math.max(projMax, p);
            }
            for (let j = 0; j < b.count; j++) {
                const p = (b.x[j] - ox) * dirX + (b.y[j] - oy) * dirY + (b.z[j] - oz) * dirZ;
                projMin = Math.min(projMin, p);
                projMax = Math.max(projMax, p);
            }
            result.push({
                originX: ox,
                originY: oy,
                originZ: oz,
                dirX,
                dirY,
                dirZ,
                projMin: Number.isFinite(projMin) ? projMin : 0,
                projSpan: Math.max(1e-4, Number.isFinite(projMax - projMin) ? projMax - projMin : len)
            });
        }
        if (result.length === 0) {
            result.push({
                originX: 0,
                originY: 0,
                originZ: 0,
                dirX: 1,
                dirY: 0,
                dirZ: 0,
                projMin: 0,
                projSpan: 1
            });
        }
        return result;
    }
}

class GaussianInterpolatorRuntime {
    readonly models: LoadedMorphModel[];

    readonly correspondences = new Map<string, PairCorrespondence>();

    readonly fadeLogMin: number;

    private readonly _options: GsplatMorphOptions;

    private readonly _pairAxisParams = new Map<string, PairAxisParams>();

    constructor(models: LoadedMorphModel[], fadeLogMin: number, options: GsplatMorphOptions = {}, buildNow = true) {
        this.models = models;
        this.fadeLogMin = fadeLogMin;
        this._options = options;
        if (buildNow) {
            this.buildCorrespondences();
        }
    }

    mergeOptions(options: Partial<GsplatMorphOptions>) {
        Object.assign(this._options, options);
    }

    private pairKey(idxA: number, idxB: number) {
        return `${idxA}:${idxB}`;
    }

    private getPairAxisParams(idxA: number, idxB: number) {
        const key = this.pairKey(idxA, idxB);
        const cached = this._pairAxisParams.get(key);
        if (cached) {
            return cached;
        }
        const aModel = this.models[idxA].splats;
        const bModel = this.models[idxB].splats;
        const aAabb = createAabbFromModels([this.models[idxA]]);
        const bAabb = createAabbFromModels([this.models[idxB]]);
        const ox = aAabb.center.x;
        const oy = aAabb.center.y;
        const oz = aAabb.center.z;
        const dx = bAabb.center.x - ox;
        const dy = bAabb.center.y - oy;
        const dz = bAabb.center.z - oz;
        const len = Math.max(1e-4, Math.hypot(dx, dy, dz));
        const dirX = dx / len;
        const dirY = dy / len;
        const dirZ = dz / len;
        let projMin = Number.POSITIVE_INFINITY;
        let projMax = Number.NEGATIVE_INFINITY;
        for (let j = 0; j < aModel.count; j++) {
            const p = (aModel.x[j] - ox) * dirX + (aModel.y[j] - oy) * dirY + (aModel.z[j] - oz) * dirZ;
            projMin = Math.min(projMin, p);
            projMax = Math.max(projMax, p);
        }
        for (let j = 0; j < bModel.count; j++) {
            const p = (bModel.x[j] - ox) * dirX + (bModel.y[j] - oy) * dirY + (bModel.z[j] - oz) * dirZ;
            projMin = Math.min(projMin, p);
            projMax = Math.max(projMax, p);
        }
        const params: PairAxisParams = {
            originX: ox,
            originY: oy,
            originZ: oz,
            dirX,
            dirY,
            dirZ,
            projMin: Number.isFinite(projMin) ? projMin : 0,
            projSpan: Math.max(1e-4, Number.isFinite(projMax - projMin) ? projMax - projMin : len)
        };
        this._pairAxisParams.set(key, params);
        return params;
    }

    private buildCorrespondences() {
        for (let i = 0; i < this.models.length - 1; i++) {
            const j = i + 1;
            this.correspondences.set(
                this.pairKey(i, j),
                (this._options.correspondenceStrategy ?? 'resample') === 'greedy'
                    ? this.correspondGreedyApprox(this.models[i].splats, this.models[j].splats)
                    : this.correspondMaxResample(this.models[i].splats, this.models[j].splats)
            );
        }
    }

    async buildCorrespondencesAsync(onProgress?: (done: number, total: number) => void) {
        const total = Math.max(0, this.models.length - 1);
        for (let i = 0; i < total; i++) {
            const j = i + 1;
            this.correspondences.set(
                this.pairKey(i, j),
                (this._options.correspondenceStrategy ?? 'resample') === 'greedy'
                    ? await this.correspondGreedyApproxAsync(this.models[i].splats, this.models[j].splats)
                    : this.correspondMaxResample(this.models[i].splats, this.models[j].splats)
            );
            onProgress?.(i + 1, total);
            await yieldToBrowser();
        }
    }

    private estimateGreedyCellSize(a: SplatArrays, b: SplatArrays) {
        const explicit = this._options.greedyGridCellSize;
        if (explicit && Number.isFinite(explicit) && explicit > 0) {
            return explicit;
        }

        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let minZ = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let maxZ = Number.NEGATIVE_INFINITY;
        for (const splats of [a, b]) {
            for (let i = 0; i < splats.count; i += Math.max(1, Math.floor(splats.count / 200000))) {
                minX = Math.min(minX, splats.x[i]);
                minY = Math.min(minY, splats.y[i]);
                minZ = Math.min(minZ, splats.z[i]);
                maxX = Math.max(maxX, splats.x[i]);
                maxY = Math.max(maxY, splats.y[i]);
                maxZ = Math.max(maxZ, splats.z[i]);
            }
        }

        const volume = Math.max(1e-9, (maxX - minX) * (maxY - minY) * (maxZ - minZ));
        const densityCell = Math.cbrt(volume / Math.max(1, Math.min(a.count, b.count)));
        return Math.max(1e-5, densityCell * 2.5);
    }

    private correspondGreedyApprox(a: SplatArrays, b: SplatArrays): PairCorrespondence {
        const na = a.count;
        const nb = b.count;
        const outN = Math.max(na, nb);
        if (outN === 0 || na === 0 || nb === 0) {
            return { matchedA: new Uint32Array(0), matchedB: new Uint32Array(0) };
        }

        const cellSize = this.estimateGreedyCellSize(a, b);
        const radius = Math.max(0, Math.floor(this._options.greedySearchRadiusCells ?? DEFAULT_GREEDY_SEARCH_RADIUS_CELLS));
        const maxCandidates = Math.max(1, this._options.greedyMaxCandidatesPerPoint ?? DEFAULT_GREEDY_MAX_CANDIDATES);
        const spatialWeight = this._options.greedySpatialWeight ?? DEFAULT_GREEDY_SPATIAL_WEIGHT;
        const colorWeight = this._options.greedyColorWeight ?? DEFAULT_GREEDY_COLOR_WEIGHT;
        const useColorCost = colorWeight > 0;
        const smallIsA = na <= nb;
        const small = smallIsA ? a : b;
        const large = smallIsA ? b : a;
        const nSmall = small.count;
        const nLarge = large.count;
        const grid = new Map<string, number[]>();
        const keyOf = (x: number, y: number, z: number) =>
            `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;

        const addToGrid = (targetGrid: Map<string, number[]>, splats: SplatArrays, index: number) => {
            const key = keyOf(splats.x[index], splats.y[index], splats.z[index]);
            const bucket = targetGrid.get(key);
            if (bucket) {
                bucket.push(index);
            } else {
                targetGrid.set(key, [index]);
            }
        };

        for (let i = 0; i < nLarge; i++) {
            addToGrid(grid, large, i);
        }

        const smallGrid = nLarge > nSmall ? new Map<string, number[]>() : null;
        if (smallGrid) {
            for (let i = 0; i < nSmall; i++) {
                addToGrid(smallGrid, small, i);
            }
        }

        const usedLarge = new Uint8Array(nLarge);
        const matchedA = new Uint32Array(outN);
        const matchedB = new Uint32Array(outN);
        let write = 0;
        let nextUnusedLarge = 0;
        const candidateCost = (
            source: SplatArrays,
            sourceIndex: number,
            target: SplatArrays,
            targetIndex: number
        ) => {
            const px = (source.x[sourceIndex] - target.x[targetIndex]) / cellSize;
            const py = (source.y[sourceIndex] - target.y[targetIndex]) / cellSize;
            const pz = (source.z[sourceIndex] - target.z[targetIndex]) / cellSize;
            const spatialCost = spatialWeight * (px * px + py * py + pz * pz);
            if (!useColorCost) {
                return spatialCost;
            }
            const cr = source.fdc0[sourceIndex] - target.fdc0[targetIndex];
            const cg = source.fdc1[sourceIndex] - target.fdc1[targetIndex];
            const cb = source.fdc2[sourceIndex] - target.fdc2[targetIndex];
            return spatialCost + colorWeight * (cr * cr + cg * cg + cb * cb);
        };

        const findGlobalApproxLargeForSmall = (smallIndex: number, requireUnused: boolean) => {
            let best = -1;
            let bestCost = Number.POSITIVE_INFINITY;
            const samples = Math.min(nLarge, DEFAULT_GREEDY_GLOBAL_FALLBACK_SAMPLES);
            const stride = Math.max(1, Math.floor(nLarge / samples));
            const offset = nLarge > 0 ? smallIndex % stride : 0;

            for (let i = offset; i < nLarge; i += stride) {
                if (requireUnused && usedLarge[i]) {
                    continue;
                }
                const cost = candidateCost(small, smallIndex, large, i);
                if (cost < bestCost) {
                    bestCost = cost;
                    best = i;
                }
            }

            if (requireUnused && best < 0) {
                while (nextUnusedLarge < nLarge && usedLarge[nextUnusedLarge]) {
                    nextUnusedLarge++;
                }
                return nextUnusedLarge < nLarge ? nextUnusedLarge : -1;
            }

            return best;
        };

        const findBestLargeForSmall = (
            smallIndex: number,
            requireUnused: boolean,
            searchRadius = radius,
            candidateLimit = maxCandidates
        ) => {
            const cx = Math.floor(small.x[smallIndex] / cellSize);
            const cy = Math.floor(small.y[smallIndex] / cellSize);
            const cz = Math.floor(small.z[smallIndex] / cellSize);
            let best = -1;
            let bestCost = Number.POSITIVE_INFINITY;
            let tested = 0;

            for (let dz = -searchRadius; dz <= searchRadius && tested < candidateLimit; dz++) {
                for (let dy = -searchRadius; dy <= searchRadius && tested < candidateLimit; dy++) {
                    for (let dx = -searchRadius; dx <= searchRadius && tested < candidateLimit; dx++) {
                        const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                        if (!bucket) {
                            continue;
                        }
                        for (let n = 0; n < bucket.length && tested < candidateLimit; n++) {
                            const largeIndex = bucket[n];
                            if (requireUnused && usedLarge[largeIndex]) {
                                continue;
                            }
                            tested++;
                            const cost = candidateCost(small, smallIndex, large, largeIndex);
                            if (cost < bestCost) {
                                bestCost = cost;
                                best = largeIndex;
                            }
                        }
                    }
                }
            }

            return best;
        };

        for (let smallIndex = 0; smallIndex < nSmall && write < outN; smallIndex++, write++) {
            let best = findBestLargeForSmall(smallIndex, true);
            if (best < 0 && radius < 6) {
                best = findBestLargeForSmall(smallIndex, true, Math.min(6, radius + 2), maxCandidates * 2);
            }
            if (best < 0) {
                best = findGlobalApproxLargeForSmall(smallIndex, true);
            }
            if (best < 0) {
                best = 0;
            }

            usedLarge[best] = 1;
            if (smallIsA) {
                matchedA[write] = smallIndex;
                matchedB[write] = best;
            } else {
                matchedA[write] = best;
                matchedB[write] = smallIndex;
            }
        }

        if (nLarge > nSmall && smallGrid) {
            for (let largeIndex = 0; largeIndex < nLarge && write < outN; largeIndex++) {
                if (usedLarge[largeIndex]) {
                    continue;
                }
                let nearestSmall = this.findNearestApproxIndex(
                    large,
                    largeIndex,
                    small,
                    smallGrid,
                    cellSize,
                    radius,
                    maxCandidates,
                    spatialWeight,
                    colorWeight
                );
                if (nearestSmall < 0 && radius < 6) {
                    nearestSmall = this.findNearestApproxIndex(
                        large,
                        largeIndex,
                        small,
                        smallGrid,
                        cellSize,
                        Math.min(6, radius + 2),
                        maxCandidates * 2,
                        spatialWeight,
                        colorWeight
                    );
                }
                const smallIndex = nearestSmall >= 0
                    ? nearestSmall
                    : this.findGlobalApproxIndex(large, largeIndex, small, cellSize, spatialWeight, colorWeight);
                if (smallIsA) {
                    matchedA[write] = smallIndex;
                    matchedB[write] = largeIndex;
                } else {
                    matchedA[write] = largeIndex;
                    matchedB[write] = smallIndex;
                }
                write++;
            }
        }

        for (; write < outN; write++) {
            matchedA[write] = na - 1;
            matchedB[write] = nb - 1;
        }

        console.info('[GsplatMorph] greedy correspondence built', {
            a: na,
            b: nb,
            out: outN,
            small: nSmall,
            large: nLarge,
            cellSize,
            radius,
            maxCandidates,
            globalFallbackSamples: DEFAULT_GREEDY_GLOBAL_FALLBACK_SAMPLES,
            spatialWeight,
            colorWeight
        });

        return { matchedA, matchedB };
    }

    private async correspondGreedyApproxAsync(a: SplatArrays, b: SplatArrays): Promise<PairCorrespondence> {
        const na = a.count;
        const nb = b.count;
        const outN = Math.max(na, nb);
        if (outN === 0 || na === 0 || nb === 0) {
            return { matchedA: new Uint32Array(0), matchedB: new Uint32Array(0) };
        }

        let lastYield = performance.now();
        const maybeYield = async () => {
            const now = performance.now();
            if (now - lastYield < DEFAULT_MORPH_BUILD_YIELD_MS) {
                return;
            }
            await yieldToBrowser();
            lastYield = performance.now();
        };

        const cellSize = this.estimateGreedyCellSize(a, b);
        const radius = Math.max(0, Math.floor(this._options.greedySearchRadiusCells ?? DEFAULT_GREEDY_SEARCH_RADIUS_CELLS));
        const maxCandidates = Math.max(1, this._options.greedyMaxCandidatesPerPoint ?? DEFAULT_GREEDY_MAX_CANDIDATES);
        const spatialWeight = this._options.greedySpatialWeight ?? DEFAULT_GREEDY_SPATIAL_WEIGHT;
        const colorWeight = this._options.greedyColorWeight ?? DEFAULT_GREEDY_COLOR_WEIGHT;
        const useColorCost = colorWeight > 0;
        const smallIsA = na <= nb;
        const small = smallIsA ? a : b;
        const large = smallIsA ? b : a;
        const nSmall = small.count;
        const nLarge = large.count;
        const grid = new Map<string, number[]>();
        const smallGrid = nLarge > nSmall ? new Map<string, number[]>() : null;
        const keyOf = (x: number, y: number, z: number) =>
            `${Math.floor(x / cellSize)},${Math.floor(y / cellSize)},${Math.floor(z / cellSize)}`;
        const addToGrid = (targetGrid: Map<string, number[]>, splats: SplatArrays, index: number) => {
            const key = keyOf(splats.x[index], splats.y[index], splats.z[index]);
            const bucket = targetGrid.get(key);
            if (bucket) {
                bucket.push(index);
            } else {
                targetGrid.set(key, [index]);
            }
        };

        for (let i = 0; i < nLarge; i++) {
            addToGrid(grid, large, i);
            if ((i & 0x7ff) === 0) await maybeYield();
        }
        if (smallGrid) {
            for (let i = 0; i < nSmall; i++) {
                addToGrid(smallGrid, small, i);
                if ((i & 0x7ff) === 0) await maybeYield();
            }
        }

        const usedLarge = new Uint8Array(nLarge);
        const matchedA = new Uint32Array(outN);
        const matchedB = new Uint32Array(outN);
        let write = 0;
        let nextUnusedLarge = 0;
        const cost = (si: number, li: number) => {
            const px = (small.x[si] - large.x[li]) / cellSize;
            const py = (small.y[si] - large.y[li]) / cellSize;
            const pz = (small.z[si] - large.z[li]) / cellSize;
            const spatialCost = spatialWeight * (px * px + py * py + pz * pz);
            if (!useColorCost) {
                return spatialCost;
            }
            const cr = small.fdc0[si] - large.fdc0[li];
            const cg = small.fdc1[si] - large.fdc1[li];
            const cb = small.fdc2[si] - large.fdc2[li];
            return spatialCost + colorWeight * (cr * cr + cg * cg + cb * cb);
        };
        const globalUnusedLarge = (si: number) => {
            let best = -1;
            let bestCost = Number.POSITIVE_INFINITY;
            const samples = Math.min(nLarge, DEFAULT_GREEDY_GLOBAL_FALLBACK_SAMPLES);
            const stride = Math.max(1, Math.floor(nLarge / samples));
            for (let li = si % stride; li < nLarge; li += stride) {
                if (usedLarge[li]) continue;
                const c = cost(si, li);
                if (c < bestCost) {
                    bestCost = c;
                    best = li;
                }
            }
            if (best >= 0) return best;
            while (nextUnusedLarge < nLarge && usedLarge[nextUnusedLarge]) nextUnusedLarge++;
            return nextUnusedLarge < nLarge ? nextUnusedLarge : 0;
        };
        const bestLarge = (si: number, searchRadius: number, candidateLimit: number) => {
            const cx = Math.floor(small.x[si] / cellSize);
            const cy = Math.floor(small.y[si] / cellSize);
            const cz = Math.floor(small.z[si] / cellSize);
            let best = -1;
            let bestCost = Number.POSITIVE_INFINITY;
            let tested = 0;
            for (let dz = -searchRadius; dz <= searchRadius && tested < candidateLimit; dz++) {
                for (let dy = -searchRadius; dy <= searchRadius && tested < candidateLimit; dy++) {
                    for (let dx = -searchRadius; dx <= searchRadius && tested < candidateLimit; dx++) {
                        const bucket = grid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                        if (!bucket) continue;
                        for (let k = 0; k < bucket.length && tested < candidateLimit; k++) {
                            const li = bucket[k];
                            if (usedLarge[li]) continue;
                            tested++;
                            const c = cost(si, li);
                            if (c < bestCost) {
                                bestCost = c;
                                best = li;
                            }
                        }
                    }
                }
            }
            return best;
        };

        for (let si = 0; si < nSmall && write < outN; si++, write++) {
            let li = bestLarge(si, radius, maxCandidates);
            if (li < 0 && radius < 6) {
                li = bestLarge(si, Math.min(6, radius + 2), maxCandidates * 2);
            }
            if (li < 0) {
                li = globalUnusedLarge(si);
            }
            usedLarge[li] = 1;
            if (smallIsA) {
                matchedA[write] = si;
                matchedB[write] = li;
            } else {
                matchedA[write] = li;
                matchedB[write] = si;
            }
            if ((si & 0x1ff) === 0) await maybeYield();
        }

        if (nLarge > nSmall && smallGrid) {
            for (let li = 0; li < nLarge && write < outN; li++) {
                if (usedLarge[li]) {
                    continue;
                }
                let si = this.findNearestApproxIndex(large, li, small, smallGrid, cellSize, radius, maxCandidates, spatialWeight, colorWeight);
                if (si < 0 && radius < 6) {
                    si = this.findNearestApproxIndex(large, li, small, smallGrid, cellSize, Math.min(6, radius + 2), maxCandidates * 2, spatialWeight, colorWeight);
                }
                if (si < 0) {
                    si = this.findGlobalApproxIndex(large, li, small, cellSize, spatialWeight, colorWeight);
                }
                if (smallIsA) {
                    matchedA[write] = si;
                    matchedB[write] = li;
                } else {
                    matchedA[write] = li;
                    matchedB[write] = si;
                }
                write++;
                if ((li & 0x1ff) === 0) await maybeYield();
            }
        }

        for (; write < outN; write++) {
            matchedA[write] = na - 1;
            matchedB[write] = nb - 1;
        }

        console.info('[GsplatMorph] greedy correspondence built async', {
            a: na,
            b: nb,
            out: outN,
            cellSize,
            radius,
            maxCandidates,
            globalFallbackSamples: DEFAULT_GREEDY_GLOBAL_FALLBACK_SAMPLES,
            spatialWeight,
            colorWeight
        });

        return { matchedA, matchedB };
    }

    private findNearestApproxIndex(
        source: SplatArrays,
        sourceIndex: number,
        target: SplatArrays,
        targetGrid: Map<string, number[]>,
        cellSize: number,
        radius: number,
        maxCandidates: number,
        spatialWeight: number,
        colorWeight: number
    ) {
        const cx = Math.floor(source.x[sourceIndex] / cellSize);
        const cy = Math.floor(source.y[sourceIndex] / cellSize);
        const cz = Math.floor(source.z[sourceIndex] / cellSize);
        const useColorCost = colorWeight > 0;
        let best = -1;
        let bestCost = Number.POSITIVE_INFINITY;
        let tested = 0;

        for (let dz = -radius; dz <= radius && tested < maxCandidates; dz++) {
            for (let dy = -radius; dy <= radius && tested < maxCandidates; dy++) {
                for (let dx = -radius; dx <= radius && tested < maxCandidates; dx++) {
                    const bucket = targetGrid.get(`${cx + dx},${cy + dy},${cz + dz}`);
                    if (!bucket) {
                        continue;
                    }
                    for (let n = 0; n < bucket.length && tested < maxCandidates; n++) {
                        const targetIndex = bucket[n];
                        tested++;
                        const px = (source.x[sourceIndex] - target.x[targetIndex]) / cellSize;
                        const py = (source.y[sourceIndex] - target.y[targetIndex]) / cellSize;
                        const pz = (source.z[sourceIndex] - target.z[targetIndex]) / cellSize;
                        let cost = spatialWeight * (px * px + py * py + pz * pz);
                        if (useColorCost) {
                            const cr = source.fdc0[sourceIndex] - target.fdc0[targetIndex];
                            const cg = source.fdc1[sourceIndex] - target.fdc1[targetIndex];
                            const cb = source.fdc2[sourceIndex] - target.fdc2[targetIndex];
                            cost += colorWeight * (cr * cr + cg * cg + cb * cb);
                        }
                        if (cost < bestCost) {
                            bestCost = cost;
                            best = targetIndex;
                        }
                    }
                }
            }
        }

        return best;
    }

    private findGlobalApproxIndex(
        source: SplatArrays,
        sourceIndex: number,
        target: SplatArrays,
        cellSize: number,
        spatialWeight: number,
        colorWeight: number
    ) {
        const n = target.count;
        if (n <= 0) {
            return 0;
        }

        let best = 0;
        let bestCost = Number.POSITIVE_INFINITY;
        const useColorCost = colorWeight > 0;
        const samples = Math.min(n, DEFAULT_GREEDY_GLOBAL_FALLBACK_SAMPLES);
        const stride = Math.max(1, Math.floor(n / samples));
        const offset = sourceIndex % stride;

        for (let i = offset; i < n; i += stride) {
            const px = (source.x[sourceIndex] - target.x[i]) / cellSize;
            const py = (source.y[sourceIndex] - target.y[i]) / cellSize;
            const pz = (source.z[sourceIndex] - target.z[i]) / cellSize;
            let cost = spatialWeight * (px * px + py * py + pz * pz);
            if (useColorCost) {
                const cr = source.fdc0[sourceIndex] - target.fdc0[i];
                const cg = source.fdc1[sourceIndex] - target.fdc1[i];
                const cb = source.fdc2[sourceIndex] - target.fdc2[i];
                cost += colorWeight * (cr * cr + cg * cg + cb * cb);
            }
            if (cost < bestCost) {
                bestCost = cost;
                best = i;
            }
        }

        return best;
    }

    /**
     * `max(|A|,|B|)` 条输出对应关系，**无 leftover、无 fade**：
     * - 点数多的一侧：输出槽 `i` 直接用该侧下标 `i`；
     * - 少的一侧：`floor(i * smallCount / largeCount)`（多对一，例如 A=200w、B=100w 时约两个输出槽共用同一个 `B[j]`，但各自与不同的 `A[i]` 做完整属性 lerp）。
     */
    private correspondMaxResample(a: SplatArrays, b: SplatArrays): PairCorrespondence {
        const na = a.count;
        const nb = b.count;
        const outN = Math.max(na, nb);
        if (outN === 0 || na === 0 || nb === 0) {
            return {
                matchedA: new Uint32Array(0),
                matchedB: new Uint32Array(0)
            };
        }

        const matchedA = new Uint32Array(outN);
        const matchedB = new Uint32Array(outN);

        if (na >= nb) {
            for (let i = 0; i < outN; i++) {
                matchedA[i] = i;
                matchedB[i] = nb <= 1 ? 0 : Math.min(Math.floor((i * nb) / na), nb - 1);
            }
        } else {
            for (let i = 0; i < outN; i++) {
                matchedB[i] = i;
                matchedA[i] = na <= 1 ? 0 : Math.min(Math.floor((i * na) / nb), na - 1);
            }
        }

        return { matchedA, matchedB };
    }

    /**
     * 按当前 `correspondMaxResample` 配对表，抽样统计两端中心距（`pair.matchedA[i]` 与 `pair.matchedB[i]`）。
     * mean 很大说明按该映射几何仍差得远；若需与「语义最近邻」对齐，应在外部先做重排序/重采样再喂 morph。
     */
    getIndexPairingDiagnostics(idxA: number, idxB: number, sampleStride: number) {
        const pair = this.correspondences.get(this.pairKey(idxA, idxB));
        if (!pair) {
            return null;
        }

        const a = this.models[idxA].splats;
        const b = this.models[idxB].splats;
        const n = pair.matchedA.length;
        let sum = 0;
        let sumSq = 0;
        let cnt = 0;

        for (let i = 0; i < n; i += sampleStride) {
            const ia = pair.matchedA[i];
            const ib = pair.matchedB[i];
            const dx = a.x[ia] - b.x[ib];
            const dy = a.y[ia] - b.y[ib];
            const dz = a.z[ia] - b.z[ib];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            sum += d;
            sumSq += d * d;
            cnt++;
        }

        const mean = sum / Math.max(1, cnt);
        const rms = Math.sqrt(sumSq / Math.max(1, cnt));

        return {
            pairCount: n,
            sampleStride,
            samplesUsed: cnt,
            meanCenterDist: mean,
            rmsCenterDist: rms
        };
    }

    interpolateBetween(
        idxA: number,
        idxB: number,
        t: number,
        output: SplatArrays,
        writeRestSh = true,
        fastQuaternionNlerp = true,
        reversePlayback = false
    ) {
        if (!(t >= 0 && t <= 1)) {
            throw new Error(`Interpolation t must be in [0, 1], got ${t}`);
        }

        const a = this.models[idxA].splats;
        const b = this.models[idxB].splats;
        const correspondence = this.correspondences.get(this.pairKey(idxA, idxB));

        if (!correspondence) {
            throw new Error(`Failed to build correspondence for pair (${idxA}, ${idxB})`);
        }

        let write = 0;
        const progressivePairFlight = this._options.progressivePairFlight ?? true;
        const progressivePairFlightWindow = this._options.progressivePairFlightWindow ?? DEFAULT_PROGRESSIVE_PAIR_FLIGHT_WINDOW;
        const asymmetricDissolve = this._options.progressivePairAsymmetricDissolve ?? true;
        const hourglass = resolveMorphHourglassSettings(this._options);
        const slotCount = correspondence.matchedA.length;
        const axis = this.getPairAxisParams(idxA, idxB);

        for (let i = 0; i < correspondence.matchedA.length; i++, write++) {
            const src = correspondence.matchedA[i];
            const dst = correspondence.matchedB[i];
            const projA = (a.x[src] - axis.originX) * axis.dirX + (a.y[src] - axis.originY) * axis.dirY + (a.z[src] - axis.originZ) * axis.dirZ;
            const projB = (b.x[dst] - axis.originX) * axis.dirX + (b.y[dst] - axis.originY) * axis.dirY + (b.z[dst] - axis.originZ) * axis.dirZ;
            const sA = clamp((projA - axis.projMin) / axis.projSpan, 0, 1);
            const sB = clamp((projB - axis.projMin) / axis.projSpan, 0, 1);

            const aVisible = src < a.count;
            const bVisible = dst < b.count;
            const aScale0 = aVisible ? a.scale0[src] : this.fadeLogMin;
            const aScale1 = aVisible ? a.scale1[src] : this.fadeLogMin;
            const aScale2 = aVisible ? a.scale2[src] : this.fadeLogMin;
            const bScale0 = bVisible ? b.scale0[dst] : this.fadeLogMin;
            const bScale1 = bVisible ? b.scale1[dst] : this.fadeLogMin;
            const bScale2 = bVisible ? b.scale2[dst] : this.fadeLogMin;
            const aOpacity = aVisible ? a.opacity[src] : this.fadeLogMin;
            const bOpacity = bVisible ? b.opacity[dst] : this.fadeLogMin;

            let posT: number;
            let blendA: number;
            let blendB: number;
            let morphWeights: AsymmetricMorphWeights;

            const pairPhase = resolvePairFlightPhase(i, slotCount);
            const flightStagger = this._options.progressivePairFlightStagger ?? DEFAULT_PROGRESSIVE_PAIR_FLIGHT_STAGGER;

            if (asymmetricDissolve && progressivePairFlight) {
                morphWeights = resolveAsymmetricMorphWeights(
                    t, sA, sB, pairPhase, true, progressivePairFlightWindow, flightStagger, reversePlayback
                );
                posT = morphWeights.posT;
                blendA = morphWeights.blendA;
                blendB = morphWeights.blendB;
            } else {
                let phase = progressivePairFlight
                    ? clamp((1 - sA + sB) * 0.5 * (1 - flightStagger) + pairPhase * flightStagger, 0, 1)
                    : pairPhase;
                phase = Math.pow(phase, 1.8);
                const localT = resolveDirectionalFlightT(
                    t,
                    phase,
                    progressivePairFlight,
                    progressivePairFlightWindow,
                    reversePlayback
                );
                posT = localT;
                blendA = 1 - localT;
                blendB = localT;
                const legacyChannel = clamp(4 * localT * (1 - localT), 0, 1);
                morphWeights = {
                    goneA: localT,
                    presentB: localT,
                    posT: localT,
                    weightA: 1 - localT,
                    weightB: localT,
                    inChannel: localT > 0.04 && localT < 0.96,
                    channelBand: legacyChannel,
                    blendA,
                    blendB
                };
            }

            const invPosT = 1 - posT;
            const bodySum = morphWeights.weightA + morphWeights.weightB;

            if (bodySum < 0.02 && morphWeights.channelBand < 0.04) {
                output.x[write] = a.x[src];
                output.y[write] = a.y[src];
                output.z[write] = a.z[src];
                output.fdc0[write] = a.fdc0[src];
                output.fdc1[write] = a.fdc1[src];
                output.fdc2[write] = a.fdc2[src];
                output.scale0[write] = this.fadeLogMin;
                output.scale1[write] = this.fadeLogMin;
                output.scale2[write] = this.fadeLogMin;
                output.opacity[write] = this.fadeLogMin;
                output.rot0[write] = aVisible ? a.rot0[src] : 1;
                output.rot1[write] = aVisible ? a.rot1[src] : 0;
                output.rot2[write] = aVisible ? a.rot2[src] : 0;
                output.rot3[write] = aVisible ? a.rot3[src] : 0;
                if (writeRestSh) {
                    for (let restIndex = 0; restIndex < output.rest.length; restIndex++) {
                        output.rest[restIndex][write] = 0;
                    }
                }
                continue;
            }

            output.x[write] = a.x[src] * invPosT + b.x[dst] * posT;
            output.y[write] = a.y[src] * invPosT + b.y[dst] * posT;
            output.z[write] = a.z[src] * invPosT + b.z[dst] * posT;

            output.fdc0[write] = a.fdc0[src] * blendA + b.fdc0[dst] * blendB;
            output.fdc1[write] = a.fdc1[src] * blendA + b.fdc1[dst] * blendB;
            output.fdc2[write] = a.fdc2[src] * blendA + b.fdc2[dst] * blendB;

            output.scale0[write] = aScale0 * blendA + bScale0 * blendB;
            output.scale1[write] = aScale1 * blendA + bScale1 * blendB;
            output.scale2[write] = aScale2 * blendA + bScale2 * blendB;
            output.opacity[write] = aOpacity * blendA + bOpacity * blendB;

            const q = fastQuaternionNlerp
                ? nlerpQuat(
                    a.rot1[src], a.rot2[src], a.rot3[src], a.rot0[src],
                    b.rot1[dst], b.rot2[dst], b.rot3[dst], b.rot0[dst],
                    posT
                )
                : slerpQuat(
                    a.rot1[src], a.rot2[src], a.rot3[src], a.rot0[src],
                    b.rot1[dst], b.rot2[dst], b.rot3[dst], b.rot0[dst],
                    posT
                );

            output.rot0[write] = q.w;
            output.rot1[write] = q.x;
            output.rot2[write] = q.y;
            output.rot3[write] = q.z;

            if (writeRestSh) {
                for (let restIndex = 0; restIndex < output.rest.length; restIndex++) {
                    const av = restIndex < a.rest.length ? a.rest[restIndex][src] : 0;
                    const bv = restIndex < b.rest.length ? b.rest[restIndex][dst] : 0;
                    output.rest[restIndex][write] = av * blendA + bv * blendB;
                }
            }

            applyHourglassChannelToSplat(write, t, morphWeights, axis, hourglass, output);
        }

        const fallback = a.count > 0 ? a : b;
        for (; write < output.count; write++) {
            output.x[write] = fallback.count > 0 ? fallback.x[0] : 0;
            output.y[write] = fallback.count > 0 ? fallback.y[0] : 0;
            output.z[write] = fallback.count > 0 ? fallback.z[0] : 0;
            output.fdc0[write] = fallback.count > 0 ? fallback.fdc0[0] : 0;
            output.fdc1[write] = fallback.count > 0 ? fallback.fdc1[0] : 0;
            output.fdc2[write] = fallback.count > 0 ? fallback.fdc2[0] : 0;
            output.rot0[write] = fallback.count > 0 ? fallback.rot0[0] : 1;
            output.rot1[write] = fallback.count > 0 ? fallback.rot1[0] : 0;
            output.rot2[write] = fallback.count > 0 ? fallback.rot2[0] : 0;
            output.rot3[write] = fallback.count > 0 ? fallback.rot3[0] : 0;
            output.scale0[write] = this.fadeLogMin;
            output.scale1[write] = this.fadeLogMin;
            output.scale2[write] = this.fadeLogMin;
            output.opacity[write] = this.fadeLogMin;

            if (writeRestSh) {
                for (let restIndex = 0; restIndex < output.rest.length; restIndex++) {
                    output.rest[restIndex][write] = 0;
                }
            }
        }
    }
}

const loadMorphModel = async (
    app: AppBase,
    source: MorphSource,
    index: number,
    options: GsplatMorphOptions
) => {
    const resolved = resolveMorphSource(source, index);
    const sourceEntity = options.sourceEntities?.[index];
    const entitySource = getEntityGsplatSource(sourceEntity);
    if (entitySource) {
        const data = await resolveReadableGsplatData(
            entitySource.resource,
            sourceEntity?.name || resolved.filename
        );
        const splats = readSplatArrays(data);
        bakeEntityTransformIntoSplats(
            splats,
            sourceEntity,
            options.sourceEntities?.[0]
        );
        preprocessModel(splats, options);
        console.info('[GsplatMorph] using scene entity gsplat resource for keyframe', {
            index,
            entity: sourceEntity?.name,
            url: resolved.url,
            splats: splats.count
        });
        return {
            name: sourceEntity?.name || resolved.filename,
            splats
        } satisfies LoadedMorphModel;
    }

    const fileContents = typeof source !== 'string' && source.contents
        ? await source.contents.arrayBuffer()
        : undefined;

    const assetFile = {
        url: resolved.url,
        filename: resolved.filename,
        ...(fileContents ? { contents: createGsplatFileContents(fileContents) } : {})
    } as {
        url: string;
        filename: string;
        contents?: ArrayBuffer | Response;
    };

    const asset = new Asset(resolved.filename, 'gsplat', assetFile as any, {
        reorder: false,
        decompress: true
    });

    app.assets.add(asset);

    try {
        const loaded = await new Promise<Asset>((resolve, reject) => {
            asset.once('load', () => resolve(asset));
            asset.once('error', (err: unknown) => reject(err));
            app.assets.load(asset);
        });

        const resource = loaded.resource as GSplatResource | null;
        if (!resource) {
            throw new Error(`加载 ${resolved.filename} 失败: resource 为空`);
        }

        const data = await resolveReadableGsplatData(resource, resolved.filename);

        const splats = readSplatArrays(data);
        bakeEntityTransformIntoSplats(
            splats,
            options.sourceEntities?.[index],
            options.sourceEntities?.[0]
        );
        preprocessModel(splats, options);

        if (options.retainSourceAssets) {
            return {
                name: resolved.filename,
                asset: loaded,
                resource,
                data,
                splats
            } satisfies LoadedMorphModel;
        }

        loaded.unload();
        app.assets.remove(loaded);

        return {
            name: resolved.filename,
            splats
        } satisfies LoadedMorphModel;
    } finally {
        if (resolved.cleanupUrl) {
            URL.revokeObjectURL(resolved.cleanupUrl);
        }
    }
};

export class GsplatMorphController {
    readonly app: AppBase;

    readonly entity: Entity;

    readonly asset: Asset;

    readonly resource: GSplatResource | GpuSplatContainer;

    readonly outputData?: GSplatData;

    readonly output?: SplatArrays;

    readonly models: LoadedMorphModel[];

    interpolator?: GaussianInterpolatorRuntime;

    private readonly _centers: Float32Array;

    private readonly _gpuRuntime?: GpuMorphRuntime;

    private readonly _morphOptions: GsplatMorphOptions;

    /** 在 `application.update` 之前执行，保证本帧 GSplat unified 读到的已是当帧 morph 数据。 */
    private readonly _onFrameUpdate: (ms: number) => void;

    /**
     * Viewer 在 `framerender` 里若 `!readyToRender` 会把 `renderNextFrame` 清掉；
     * morph 在更早的 `frameupdate` 里设的真值会被覆盖。本回调挂在 Viewer 之后执行，在判定需要时再拉高。
     */
    private readonly _onAfterFrameRender: () => void;

    /**
     * Unified GSplat 排序在 Worker 里异步完成，新顺序可能在当前帧 `render()` 之后才落到 mesh；
     * `autoRender=false` 时须再请求一帧才能把排序结果画到画布（否则往往要靠拖相机「碰」出 `renderNextFrame`）。
     */
    private readonly _onGsplatSorted: () => void;

    /** `continuousAppRender` 生效时暂存的 Viewer 关闭前的 `app.autoRender`。 */
    private _savedAppAutoRender: boolean | undefined;

    private _autoRenderOverridden = false;

    private _segmentDuration: number;

    private _segmentHoldDuration: number;

    private _loop: boolean;

    private _playing: boolean;

    private _time = 0;

    /** 墙钟节流用；`morphPresentMaxHz` 为 0 时不使用。 */
    private _lastMorphPresentMs = Number.NEGATIVE_INFINITY;

    private readonly _morphPresentMaxHz: number;

    private readonly _morphAnimateSh: boolean;

    private readonly _fastQuaternionNlerp: boolean;

    private readonly _sortCentersMaxHz: number;

    private _lastSortCentersMs = Number.NEGATIVE_INFINITY;

    /** 与 `morphAnimateSphericalHarmonics === false` 配合：段切换时重算并重传 `f_rest_*`。 */
    private _lastPairIndexForSh = -1;

    /** `pushOutputToResource` 已执行，本帧 `framerender` 需再拉高 `renderNextFrame`（防 Viewer 清掉）。 */
    private _morphPushedThisFrame = false;

    private readonly _hiddenSourceStates: { entity: Entity; enabled: boolean }[] = [];

    private _destroyed = false;

    constructor(app: AppBase, models: LoadedMorphModel[], options: GsplatMorphOptions = {}) {
        this._morphOptions = options;
        this.app = app;
        this.models = models;

        // 构建输出缓冲区
        const maxSplats = Math.max(...models.map(model => model.splats.count));
        const restPropCount = normalizeRestPropCount(Math.max(...models.map(model => model.splats.rest.length)));
        const fadeLogMin = options.fadeLogMin ?? DEFAULT_FADE_LOG_MIN;
        const useGreedyCorrespondence = (options.correspondenceStrategy ?? 'resample') === 'greedy';
        const correspondenceInterpolator = options.prebuiltInterpolator ?? (
            useGreedyCorrespondence
                ? new GaussianInterpolatorRuntime(models, fadeLogMin, options)
                : undefined
        );

        let gpuRuntime: GpuMorphRuntime | undefined;
        if (options.preferGpuMorph ?? true) {
            try {
                gpuRuntime = new GpuMorphRuntime(
                    app,
                    models,
                    maxSplats,
                    correspondenceInterpolator?.correspondences,
                    fadeLogMin,
                    options
                );
                console.info('[GsplatMorph] GPU morph path enabled: interpolation runs through GSplatProcessor.');
                if (restPropCount > 0) {
                    console.info('[GsplatMorph] GPU morph path uses SH0/DC color for animation; high-order SH stays disabled to avoid multi-million coefficient uploads.');
                }
            } catch (err) {
                console.warn('[GsplatMorph] GPU morph path unavailable; falling back to CPU uploads.', err);
            }
        }

        this._gpuRuntime = gpuRuntime;
        if (this._gpuRuntime) {
            this.interpolator = correspondenceInterpolator;
            this.resource = this._gpuRuntime.resource;
            this._centers = this.resource.centers;
        } else {
            this.interpolator = correspondenceInterpolator ?? new GaussianInterpolatorRuntime(models, fadeLogMin, options);
            const { data, arrays } = createMutableGSplatData(maxSplats, restPropCount);
            this.outputData = data;
            this.output = arrays;
            // Create the mutable resource used by the gsplat component.
            this.resource = new GSplatResource(app.graphicsDevice, this.outputData);
            this._centers = this.resource.centers ?? new Float32Array(maxSplats * 3);
            this.resource.centers = this._centers;
        }

        this.asset = new Asset(options.entityName || 'gsplatMorphAsset', 'gsplat', {
            url: `gsplat-morph://${Date.now()}`,
            filename: `${options.entityName || 'gsplatMorph'}.ply`
        });
        this.asset.resource = this.resource as any;
        this.asset.loaded = true;
        app.assets.add(this.asset);
        this.asset.fire('load', this.asset);

        this.entity = new Entity(options.entityName || 'gsplatMorph');
        const anchorEntity = options.sourceEntities?.find((entity) => !!entity);
        if (anchorEntity) {
            this.entity.setPosition(anchorEntity.getPosition());
            this.entity.setRotation(anchorEntity.getRotation());
            this.entity.setLocalScale(anchorEntity.getLocalScale());
        } else {
            this.entity.setLocalEulerAngles(0, 0, 180);
        }
        const gsplatComponentData: {
            unified: boolean;
            asset: Asset;
            layers?: number[];
        } = {
            unified: options.unified ?? true,
            asset: this.asset
        };
        // 勿传 layers: undefined — PlayCanvas gsplat setter 会读 layers.length 并报错
        if (Array.isArray(options.layers) && options.layers.length > 0) {
            gsplatComponentData.layers = options.layers;
        } else {
            const worldLayer = app.scene.layers.getLayerByName('World');
            if (worldLayer) {
                gsplatComponentData.layers = [worldLayer.id];
            }
        }
        this.entity.addComponent('gsplat', gsplatComponentData as any);
        app.root.addChild(this.entity);

        this._segmentDuration = Math.max(0.001, options.segmentDuration ?? DEFAULT_SEGMENT_DURATION);
        this._segmentHoldDuration = Math.max(0, options.segmentHoldDuration ?? DEFAULT_SEGMENT_HOLD_DURATION);
        this._loop = options.loop ?? true;
        this._playing = options.autoPlay ?? true;
        this._morphPresentMaxHz = Math.max(0, options.morphPresentMaxHz ?? 0);
        this._morphAnimateSh = options.morphAnimateSphericalHarmonics ?? true;
        this._fastQuaternionNlerp = options.fastQuaternionNlerp ?? true;
        this._sortCentersMaxHz = Math.max(0, options.sortCentersMaxHz ?? DEFAULT_SORT_CENTERS_MAX_HZ);
        this._onFrameUpdate = (ms: number) => {
            let dt = ms / 1000;
            dt = clamp(dt, 0, this.app.maxDeltaTime);
            dt *= this.app.timeScale;
            this.update(dt);
        };
        this._onAfterFrameRender = () => {
            if (this.segmentCount === 0) {
                return;
            }
            if (this._morphPushedThisFrame) {
                this.app.renderNextFrame = true;
                this._morphPushedThisFrame = false;
            }
        };

        this._onGsplatSorted = () => {
            this.app.renderNextFrame = true;
        };

        app.on('frameupdate', this._onFrameUpdate);
        app.on('framerender', this._onAfterFrameRender);
        app.scene.on('gsplat:sorted', this._onGsplatSorted);
        this.applyCurrentFrame(true);
        this.syncPlaybackVisibility();
        this.syncMorphDrivenAppRender();
    }

    get segmentDuration() {
        return this._segmentDuration;
    }

    set segmentDuration(value: number) {
        this._segmentDuration = Math.max(0.001, value);
        this._lastPairIndexForSh = -1;
        this.applyCurrentFrame(true);
    }

    get segmentHoldDuration() {
        return this._segmentHoldDuration;
    }

    set segmentHoldDuration(value: number) {
        this._segmentHoldDuration = Math.max(0, value);
        this._lastPairIndexForSh = -1;
        this.applyCurrentFrame(true);
    }

    get loop() {
        return this._loop;
    }

    set loop(value: boolean) {
        this._loop = value;
    }

    get playing() {
        return this._playing;
    }

    get modelCount() {
        return this.models.length;
    }

    get segmentCount() {
        return Math.max(0, this.modelCount - 1);
    }

    get totalDuration() {
        return this.segmentCount * (this._segmentDuration + this._segmentHoldDuration);
    }

    private get loopCycleDuration() {
        return this.segmentCount * 2 * (this._segmentDuration + this._segmentHoldDuration);
    }

    get interpolationValue() {
        if (this.modelCount === 0) {
            return 1;
        }

        if (this.segmentCount === 0) {
            return 1;
        }

        if (!this._loop && this._time >= this.totalDuration) {
            return this.modelCount;
        }

        const state = this.resolvePlaybackState();
        return state.pairIndex + state.t + 1;
    }

    set interpolationValue(value: number) {
        if (this.segmentCount === 0) {
            this._time = 0;
            this._lastPairIndexForSh = -1;
            this.applyCurrentFrame(true);
            return;
        }

        const clampedValue = clamp(value, 1, this.modelCount);
        this._time = clampedValue >= this.modelCount
            ? this.totalDuration
            : (clampedValue - 1) * (this._segmentDuration + this._segmentHoldDuration);
        this._lastPairIndexForSh = -1;
        this.applyCurrentFrame(true);
    }

    play() {
        this._playing = true;
        this.syncPlaybackVisibility();
        this.syncMorphDrivenAppRender();
        this.applyCurrentFrame(true);
        return this;
    }

    pause() {
        this._playing = false;
        this.syncMorphDrivenAppRender();
        this.applyCurrentFrame(true);
        return this;
    }

    stop() {
        this._playing = false;
        this._time = 0;
        this._lastPairIndexForSh = -1;
        this.syncPlaybackVisibility();
        this.syncMorphDrivenAppRender();
        return this;
    }

    seek(timeSeconds: number) {
        this._time = Math.max(0, timeSeconds);
        this._lastPairIndexForSh = -1;
        this.applyCurrentFrame(true);
        return this;
    }

    /**
     * 打印某一段在当前 `correspondMaxResample` 映射下的中心距抽样统计。
     * 若 Web 观感与离线工具不一致，可对比预处理（recenter/normalize）、配对策略以及 PlayCanvas 渲染（SH 打包、half 精度等）。
     */
    logMorphDiagnostics(segmentIndex = 0, sampleStride = 32) {
        const idxB = segmentIndex + 1;
        if (idxB >= this.modelCount) {
            console.warn('[GsplatMorph] logMorphDiagnostics: segmentIndex 越界');
            return;
        }

        const interpolator = this.interpolator ?? new GaussianInterpolatorRuntime(
            this.models,
            this._morphOptions.fadeLogMin ?? DEFAULT_FADE_LOG_MIN,
            this._morphOptions
        );
        const stats = interpolator.getIndexPairingDiagnostics(segmentIndex, idxB, sampleStride);
        if (!stats) {
            console.warn('[GsplatMorph] logMorphDiagnostics: 无配对数据');
            return;
        }

        console.log('[GsplatMorph] index-pairing stats', stats);
        console.log(
            '[GsplatMorph] 插值规则：默认 resample 按索引比例配对（快）；greedy 为可选的质量模式（加载时一次性构建，播放中不重算）；' +
            '`resample` 策略则仅按索引比例映射。多出来的点会参与变形，但在小点数目标端缩小并透明隐藏。'
        );
    }

    replaceInterpolator(interpolator: GaussianInterpolatorRuntime) {
        if (this._destroyed) {
            return;
        }
        this.interpolator = interpolator;
        this._gpuRuntime?.replaceCorrespondences(interpolator.correspondences);
        this._lastPairIndexForSh = -1;
        this.applyCurrentFrame(true);
    }

    setOptions(options: Partial<GsplatMorphOptions>) {
        if (this._destroyed) {
            return;
        }

        Object.assign(this._morphOptions, options);
        this.interpolator?.mergeOptions(options);
        if (typeof options.segmentDuration === 'number') {
            this.segmentDuration = options.segmentDuration;
        }
        if (typeof options.segmentHoldDuration === 'number') {
            this.segmentHoldDuration = options.segmentHoldDuration;
        }
        if (typeof options.loop === 'boolean') {
            this.loop = options.loop;
        }
        this.applyCurrentFrame(true);
    }

    destroy() {
        this._destroyed = true;
        this.disarmAppAutoRenderOverride();
        this.app.off('frameupdate', this._onFrameUpdate);
        this.app.off('framerender', this._onAfterFrameRender);
        this.app.scene.off('gsplat:sorted', this._onGsplatSorted);
        this.restoreSourceEntities(true);
        this.entity.destroy();

        this.asset.unload();
        this.app.assets.remove(this.asset);
        this._gpuRuntime?.destroy();

        this.models.forEach((model) => {
            if (model.asset) {
                model.asset.unload();
                this.app.assets.remove(model.asset);
            }
        });
    }

    private hideSourceEntities() {
        if (this._morphOptions.hideSourceEntities === false) {
            return;
        }
        if (this._hiddenSourceStates.length > 0) {
            return;
        }
        const seen = new Set<Entity>();
        for (const entity of this._morphOptions.sourceEntities ?? []) {
            if (!entity || seen.has(entity)) {
                continue;
            }
            seen.add(entity);
            this._hiddenSourceStates.push({ entity, enabled: entity.enabled });
            entity.enabled = false;
        }
    }

    private restoreSourceEntities(forceEnabled = false) {
        for (const { entity, enabled } of this._hiddenSourceStates) {
            entity.enabled = forceEnabled ? true : enabled;
        }
        this._hiddenSourceStates.length = 0;
    }

    private syncPlaybackVisibility() {
        if (this._playing) {
            this.entity.enabled = true;
            this.hideSourceEntities();
        } else {
            this.restoreSourceEntities(true);
            this.entity.enabled = false;
        }
        this.app.renderNextFrame = true;
    }

    update(dt: number) {
        if (!this._playing || this.segmentCount === 0 || !Number.isFinite(dt) || dt <= 0) {
            return;
        }

        const totalDuration = this.totalDuration;
        if (this._loop) {
            const cycleDuration = this.loopCycleDuration;
            this._time = cycleDuration > 0 ? (this._time + dt) % cycleDuration : 0;
            this.applyCurrentFrame();
            return;
        }

        this._time = Math.min(this._time + dt, totalDuration);
        this.applyCurrentFrame(this._time >= totalDuration);

        if (this._time >= totalDuration) {
            this._playing = false;
            this.syncPlaybackVisibility();
            this.syncMorphDrivenAppRender();
        }
    }
    // 立刻根据当前 _time 算一帧并推到 GPU。
    /** `forceMorphPresent`：绕过 `morphPresentMaxHz` 节流（seek/stop/段末等）。 */
    private applyCurrentFrame(forceMorphPresent = false) {
        if (this.segmentCount === 0) {
            return;
        }

        if (this._playing && !forceMorphPresent && this._morphPresentMaxHz > 0) {
            const minMs = 1000 / this._morphPresentMaxHz;
            const now = performance.now();
            if (now - this._lastMorphPresentMs < minMs) {
                return;
            }
        }

        const totalDuration = this.totalDuration;
        if (!this._loop && this._time >= totalDuration) {
            this.applyPair(this.segmentCount - 1, 1, false);
            return;
        }

        const state = this.resolvePlaybackState();
        this.applyPair(state.pairIndex, state.t, state.reverse);
    }

    private resolvePlaybackState(): MorphPlaybackState {
        const totalDuration = this.totalDuration;
        if (!this._loop || totalDuration <= 0) {
            return this.playbackStateFromForwardTime(clamp(this._time, 0, totalDuration));
        }

        const cycleDuration = this.loopCycleDuration;
        const wrappedTime = ((this._time % cycleDuration) + cycleDuration) % cycleDuration;
        return this.playbackStateFromLoopTime(wrappedTime);
    }

    private playbackStateFromForwardTime(time: number): MorphPlaybackState {
        if (this.segmentCount <= 0) {
            return { pairIndex: 0, t: 0, reverse: false };
        }

        const segmentSpan = this._segmentDuration + this._segmentHoldDuration;
        const index = Math.min(this.segmentCount - 1, Math.floor(time / Math.max(segmentSpan, 0.001)));
        const local = time - index * segmentSpan;
        if (local >= this._segmentDuration) {
            return { pairIndex: index, t: 1, reverse: false };
        }

        return { pairIndex: index, t: clamp(local / Math.max(this._segmentDuration, 1e-6), 0, 1), reverse: false };
    }

    private playbackStateFromLoopTime(time: number): MorphPlaybackState {
        if (this.segmentCount <= 0) {
            return { pairIndex: 0, t: 0, reverse: false };
        }

        const segmentSpan = this._segmentDuration + this._segmentHoldDuration;
        const legCount = this.segmentCount * 2;
        const legIndex = Math.min(legCount - 1, Math.floor(time / Math.max(segmentSpan, 0.001)));
        const local = time - legIndex * segmentSpan;
        const inHold = local >= this._segmentDuration;
        const t = inHold ? 1 : clamp(local / Math.max(this._segmentDuration, 1e-6), 0, 1);

        if (legIndex < this.segmentCount) {
            return {
                pairIndex: legIndex,
                t,
                reverse: false
            };
        }

        const reverseLegIndex = legIndex - this.segmentCount;
        return {
            pairIndex: this.segmentCount - 1 - reverseLegIndex,
            t: 1 - t,
            reverse: true
        };
    }
    private applyPair(pairIndex: number, t: number, reversePlayback = false) {
        if (this._gpuRuntime) {
            const segmentChanged = this._lastPairIndexForSh !== pairIndex;
            this._lastPairIndexForSh = pairIndex;
            this._gpuRuntime.apply(pairIndex, t, reversePlayback);
            this.pushGpuOutputToResource(segmentChanged);
            return;
        }

        const segmentChanged = this._lastPairIndexForSh !== pairIndex;
        this._lastPairIndexForSh = pairIndex;
        const writeRestSh = this._morphAnimateSh || segmentChanged;
        this.interpolator!.interpolateBetween(
            pairIndex,
            pairIndex + 1,
            t,
            this.output!,
            writeRestSh,
            this._fastQuaternionNlerp,
            reversePlayback
        );
        this.pushOutputToResource(writeRestSh, segmentChanged);
    }

    private pushOutputToResource(uploadShData: boolean, forceSortCenters = false) {
        const resource = this.resource as GSplatResource;
        const outputData = this.outputData!;
        const output = this.output!;
        resource.updateColorData(outputData);
        resource.updateTransformData(outputData);

        if (output.rest.length > 0 && uploadShData) {
            resource.updateSHData(outputData);
        }

        const now = performance.now();
        const shouldUpdateCenters =
            forceSortCenters ||
            this._sortCentersMaxHz === 0 ||
            now - this._lastSortCentersMs >= 1000 / this._sortCentersMaxHz;

        if (shouldUpdateCenters) {
            for (let i = 0; i < output.count; i++) {
                const base = i * 3;
                this._centers[base] = output.x[i];
                this._centers[base + 1] = output.y[i];
                this._centers[base + 2] = output.z[i];
            }

            resource.centersVersion++;
            outputData.calcAabb(resource.aabb);
            resource.mesh?.aabb.copy(resource.aabb);
            this._lastSortCentersMs = now;
        }

        const gsplat = this.entity.gsplat;
        if (gsplat) {
            gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
        }

        this.app.renderNextFrame = true;
        this._morphPushedThisFrame = true;
        this._lastMorphPresentMs = now;
    }

    private pushGpuOutputToResource(forceSortCenters = false) {
        const now = performance.now();
        const shouldUpdateCenters =
            forceSortCenters ||
            this._sortCentersMaxHz === 0 ||
            now - this._lastSortCentersMs >= 1000 / this._sortCentersMaxHz;

        if (shouldUpdateCenters) {
            const state = !this._loop && this._time >= this.totalDuration
                ? { pairIndex: this.segmentCount - 1, t: 1, reverse: false }
                : this.resolvePlaybackState();
            this._gpuRuntime!.updateSortCenters(this.models, state.pairIndex, state.t, state.reverse);
            this._lastSortCentersMs = now;
        }

        const gsplat = this.entity.gsplat;
        if (gsplat) {
            gsplat.workBufferUpdate = WORKBUFFER_UPDATE_ONCE;
        }

        this.app.renderNextFrame = true;
        this._morphPushedThisFrame = true;
        this._lastMorphPresentMs = now;
    }

    /**
     * `continuousAppRender` 打开且正在播放时，临时把 `app.autoRender` 拉高，避免仅依赖 `renderNextFrame`
     * 时被 Viewer 的 `framerender` 链或异步排序「夹掉」一整段连续刷新。
     */
    private syncMorphDrivenAppRender() {
        const wantOverride =
            (this._morphOptions.continuousAppRender ?? false) &&
            this._playing &&
            this.segmentCount > 0;

        if (wantOverride && !this._autoRenderOverridden) {
            this._savedAppAutoRender = this.app.autoRender;
            this.app.autoRender = true;
            this._autoRenderOverridden = true;
            return;
        }

        if (!wantOverride && this._autoRenderOverridden) {
            this.disarmAppAutoRenderOverride();
        }
    }

    private disarmAppAutoRenderOverride() {
        if (!this._autoRenderOverridden) {
            return;
        }
        if (this._savedAppAutoRender !== undefined) {
            this.app.autoRender = this._savedAppAutoRender;
        }
        this._savedAppAutoRender = undefined;
        this._autoRenderOverridden = false;
    }
}

export const loadGsplatMorphSequence = async (
    app: AppBase,
    sources: MorphSource[],
    options: GsplatMorphOptions = {}
) => {
    const clippedSources = sources.slice(0, MAX_MORPH_MODELS);
    if (sources.length > MAX_MORPH_MODELS) {
        console.warn(`[GsplatMorph] 只支持最多 ${MAX_MORPH_MODELS} 个模型，已截断为前 ${MAX_MORPH_MODELS} 个。`);
    }

    if (clippedSources.length < 2) {
        throw new Error('Gsplat morph 至少需要 2 个关键帧文件（.ply / .sog 等）。');
    }

    if (options.sourceEntities?.length && options.sourceEntities.length !== clippedSources.length) {
        console.warn('[GsplatMorph] sourceEntities/source URL count mismatch; keyframes without a matching entity will fall back to URL loading.', {
            sources: clippedSources.length,
            sourceEntities: options.sourceEntities.length
        });
    }

    const models = await Promise.all(
        clippedSources.map((source, index) => loadMorphModel(app, source, index, options))
    );

    const fadeLogMin = options.fadeLogMin ?? DEFAULT_FADE_LOG_MIN;
    const previewOptions: GsplatMorphOptions = {
        ...options,
        correspondenceStrategy: 'resample'
    };
    const previewInterpolator = new GaussianInterpolatorRuntime(models, fadeLogMin, previewOptions);
    const controller = new GsplatMorphController(app, models, {
        ...options,
        prebuiltInterpolator: previewInterpolator
    });
    options.onCorrespondenceStatus?.({
        strategy: 'resample',
        phase: 'preview'
    });

    if (options.buildGreedyInBackground === true) {
        const { prebuiltInterpolator: _discard, ...greedyOptions } = options;
        void (async () => {
            try {
                console.info('[GsplatMorph] preview uses resample; building greedy correspondence in background...');
                options.onCorrespondenceStatus?.({
                    strategy: 'greedy',
                    phase: 'building',
                    done: 0,
                    total: Math.max(0, models.length - 1)
                });
                await yieldToBrowser();
                const greedyInterpolator = new GaussianInterpolatorRuntime(models, fadeLogMin, {
                    ...greedyOptions,
                    correspondenceStrategy: 'greedy'
                }, false);
                await greedyInterpolator.buildCorrespondencesAsync((done, total) => {
                    console.info('[GsplatMorph] greedy correspondence progress', { done, total });
                    options.onCorrespondenceStatus?.({
                        strategy: 'greedy',
                        phase: 'building',
                        done,
                        total
                    });
                });
                controller.replaceInterpolator(greedyInterpolator);
                options.onCorrespondenceStatus?.({
                    strategy: 'greedy',
                    phase: 'ready'
                });
                console.info('[GsplatMorph] greedy correspondence ready; morph route upgraded.');
            } catch (err) {
                options.onCorrespondenceStatus?.({
                    strategy: 'greedy',
                    phase: 'failed',
                    error: err
                });
                console.warn('[GsplatMorph] greedy correspondence build failed; keeping resample preview route.', err);
            }
        })();
    }

    return controller;
};
