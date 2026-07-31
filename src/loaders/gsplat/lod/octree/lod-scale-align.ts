/**
 * Viewer 侧调度米制尺对齐（稳健半径 + LOD 金字塔）。
 *
 * 在典型远距（叶中心距离第 95 百分位）处，希望进入「约剩最细档 1/64 点数」的档
 *（decimate 0.5 时即约第 6 档）；若点数信号不足则回退层数约 2/3。
 * 反推 lodBaseDistance，写回 entity 供引擎与 refinement 共用。
 */

import { computeMedianLeafExtent } from './leaf-extent';

/** Poland-new 叶中位对角；仅诊断 leafScale 参考 */
export const LOD_SCALE_REF_MEDIAN_LEAF_M = 35;
/** 与 splat-transform DEFAULT_LOD_CHUNK_EXTENT 对齐（密度仅日志） */
export const LOD_SCALE_CHUNK_EXTENT_M = 10;
export const LOD_SCALE_TARGET_L0_POINTS = 4096;
export const LOD_SCALE_TARGET_DENSITY_RATIO = 0.5;
/** effectiveD0 地板（米） */
export const LOD_SCALE_MIN_D0_M = 0.15;
export const LOD_SCALE_HYSTERESIS_RATIO = 0.08;
/** 默认档距倍率（与 scene-profile DEFAULT_LOD_MULTIPLIER 一致） */
export const LOD_SCALE_DEFAULT_MULTIPLIER = 3;
/** 默认质量系数（balanced） */
export const LOD_SCALE_DEFAULT_QUALITY_FACTOR = 1.4;
/** 「约 1/64」点数比容差 */
export const LOD_SCALE_POINT_RATIO_FAR = 1 / 64;
export const LOD_SCALE_POINT_RATIO_SLACK = 1.05;
/** meta lodDistanceScale soft 修正幅度（相对 raw×qf） */
export const LOD_SCALE_SOFT_CORR_MIN = 0.75;
export const LOD_SCALE_SOFT_CORR_MAX = 1.25;

/** @deprecated 旧半边公式残留；主路径已改 R95+金字塔 */
export const LOD_SCALE_TARGET_L2_HALF_FRACTION = 0.05;
/** @deprecated 主路径不再用 MAX scale 钳制 */
export const LOD_SCALE_MAX = 12;
/** @deprecated 保留导出供旧日志/脚本 */
export const LOD_SCALE_REF_SCENE_DIAGONAL_M = 4000;
/** @deprecated */
export const LOD_SCALE_DENSITY_TRIGGER_RATIO = 1;

export type LodScaleAlignMetrics = {
    sceneDiagonal: number | null;
    halfExtent: number | null;
    longestExtent: number | null;
    medianLeafExtent: number | null;
    pointCountL0: number;
    footprintArea: number;
    /** 诊断：密度比，不进最终 d0 */
    densityRatio: number;
    robustRadiusR95: number | null;
    maxLod: number;
    targetFarLod: number;
    targetByLayers: number;
    targetByPoints: number | null;
    qualityFactor: number;
    rawD0: number | null;
    metaLodDistanceScale: number | null;
    /**
     * @deprecated 诊断占位；最终 scale 见 result.scale = configuredD0/effectiveD0
     */
    halfScale: number;
    /** @deprecated 同 halfScale */
    extentScale: number;
    /** 诊断：旧叶 scale，不接管结果 */
    leafScale: number;
    /** 诊断：旧密度 scale，不接管结果 */
    densityScale: number;
    /** 诊断：configuredD0 / effectiveD0（measure 阶段填 1，resolve 后以 result.scale 为准） */
    combinedScale: number;
    configuredL2: number;
    /** 进入 targetFarLod 的阈值（effective 前 raw×qf 路径上的目标距离 ≈ R95） */
    targetL2: number | null;
};

export type LodScaleAlignResult = {
    applied: boolean;
    configuredD0: number;
    effectiveD0: number;
    scale: number;
    metrics: LodScaleAlignMetrics;
    reason: string;
};

export type LodScaleAlignOctree = {
    nodes: Array<{ lods: Array<{ count: number }> }>;
    nodeBoundsMinMax: Float32Array;
    lodLevels?: number;
};

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

function percentileNearestRank(sortedAscending: number[], p: number): number {
    const n = sortedAscending.length;
    if (n === 0) {
        return NaN;
    }
    const idx = Math.min(n - 1, Math.max(0, Math.round((p / 100) * (n - 1))));
    return sortedAscending[idx];
}

function medianOf(sortedAscending: number[]): number {
    const n = sortedAscending.length;
    const mid = Math.floor(n / 2);
    return n % 2 === 1
        ? sortedAscending[mid]
        : 0.5 * (sortedAscending[mid - 1] + sortedAscending[mid]);
}

/** 全体节点 AABB：对角、最长轴、半边（对比日志） */
export function computeSceneExtentMetrics(
    nodeBoundsMinMax: Float32Array | null | undefined,
    nodeCount: number
): { diagonal: number; longestExtent: number; halfExtent: number } | null {
    if (!nodeBoundsMinMax || nodeCount <= 0 || nodeBoundsMinMax.length < nodeCount * 6) {
        return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let valid = 0;

    for (let i = 0; i < nodeCount; i++) {
        const b = i * 6;
        const x0 = nodeBoundsMinMax[b];
        const y0 = nodeBoundsMinMax[b + 1];
        const z0 = nodeBoundsMinMax[b + 2];
        const x1 = nodeBoundsMinMax[b + 3];
        const y1 = nodeBoundsMinMax[b + 4];
        const z1 = nodeBoundsMinMax[b + 5];
        if (
            !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(z0) ||
            !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(z1)
        ) {
            continue;
        }
        if (x1 <= x0 || y1 <= y0 || z1 <= z0) {
            continue;
        }
        if (x0 < minX) minX = x0;
        if (y0 < minY) minY = y0;
        if (z0 < minZ) minZ = z0;
        if (x1 > maxX) maxX = x1;
        if (y1 > maxY) maxY = y1;
        if (z1 > maxZ) maxZ = z1;
        valid++;
    }

    if (valid === 0) {
        return null;
    }

    const dx = maxX - minX;
    const dy = maxY - minY;
    const dz = maxZ - minZ;
    const diagonal = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const longestExtent = Math.max(dx, dy, dz);
    if (!Number.isFinite(diagonal) || diagonal <= 0 || !Number.isFinite(longestExtent) || longestExtent <= 0) {
        return null;
    }
    return {
        diagonal,
        longestExtent,
        halfExtent: longestExtent * 0.5
    };
}

/** @deprecated 用 computeSceneExtentMetrics */
export function computeSceneDiagonal(
    nodeBoundsMinMax: Float32Array | null | undefined,
    nodeCount: number
): number | null {
    return computeSceneExtentMetrics(nodeBoundsMinMax, nodeCount)?.diagonal ?? null;
}

/** 两最大轴乘积作 footprint（密度诊断） */
export function computeSceneFootprintArea(
    nodeBoundsMinMax: Float32Array | null | undefined,
    nodeCount: number
): { extent: number; footprintArea: number } | null {
    if (!nodeBoundsMinMax || nodeCount <= 0 || nodeBoundsMinMax.length < nodeCount * 6) {
        return null;
    }

    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    let valid = 0;

    for (let i = 0; i < nodeCount; i++) {
        const b = i * 6;
        const x0 = nodeBoundsMinMax[b];
        const y0 = nodeBoundsMinMax[b + 1];
        const z0 = nodeBoundsMinMax[b + 2];
        const x1 = nodeBoundsMinMax[b + 3];
        const y1 = nodeBoundsMinMax[b + 4];
        const z1 = nodeBoundsMinMax[b + 5];
        if (
            !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(z0) ||
            !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(z1)
        ) {
            continue;
        }
        if (x1 <= x0 || y1 <= y0 || z1 <= z0) {
            continue;
        }
        if (x0 < minX) minX = x0;
        if (y0 < minY) minY = y0;
        if (z0 < minZ) minZ = z0;
        if (x1 > maxX) maxX = x1;
        if (y1 > maxY) maxY = y1;
        if (z1 > maxZ) maxZ = z1;
        valid++;
    }

    if (valid === 0) {
        return null;
    }

    const axes = [maxX - minX, maxY - minY, maxZ - minZ].sort((a, b) => b - a);
    const extent = axes[0];
    const footprintArea = axes[0] * axes[1] > 0 ? axes[0] * axes[1] : extent * extent;
    if (!Number.isFinite(extent) || extent <= 0 || !Number.isFinite(footprintArea) || footprintArea <= 0) {
        return null;
    }
    return { extent, footprintArea };
}

/**
 * 叶中心相对各轴中位数中心的距离 P95（稳健占用半径）。
 * 运行时 `nodes` 已是叶集，直接遍历有效 bounds。
 */
export function computeLeafCenterDistanceP95(
    nodeBoundsMinMax: Float32Array | null | undefined,
    nodeCount: number
): number | null {
    if (!nodeBoundsMinMax || nodeCount <= 0 || nodeBoundsMinMax.length < nodeCount * 6) {
        return null;
    }

    const cx: number[] = [];
    const cy: number[] = [];
    const cz: number[] = [];
    for (let i = 0; i < nodeCount; i++) {
        const b = i * 6;
        const x0 = nodeBoundsMinMax[b];
        const y0 = nodeBoundsMinMax[b + 1];
        const z0 = nodeBoundsMinMax[b + 2];
        const x1 = nodeBoundsMinMax[b + 3];
        const y1 = nodeBoundsMinMax[b + 4];
        const z1 = nodeBoundsMinMax[b + 5];
        if (
            !Number.isFinite(x0) || !Number.isFinite(y0) || !Number.isFinite(z0) ||
            !Number.isFinite(x1) || !Number.isFinite(y1) || !Number.isFinite(z1)
        ) {
            continue;
        }
        if (x1 <= x0 || y1 <= y0 || z1 <= z0) {
            continue;
        }
        cx.push(0.5 * (x0 + x1));
        cy.push(0.5 * (y0 + y1));
        cz.push(0.5 * (z0 + z1));
    }

    if (cx.length === 0) {
        return null;
    }

    const mx = medianOf(cx.slice().sort((a, b) => a - b));
    const my = medianOf(cy.slice().sort((a, b) => a - b));
    const mz = medianOf(cz.slice().sort((a, b) => a - b));
    const dists: number[] = [];
    for (let i = 0; i < cx.length; i++) {
        const dx = cx[i] - mx;
        const dy = cy[i] - my;
        const dz = cz[i] - mz;
        const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (Number.isFinite(d) && d >= 0) {
            dists.push(d);
        }
    }
    if (dists.length === 0) {
        return null;
    }
    dists.sort((a, b) => a - b);
    const r95 = percentileNearestRank(dists, 95);
    return Number.isFinite(r95) && r95 > 0 ? r95 : null;
}

export function sumLod0PointCount(octree: LodScaleAlignOctree): number {
    let total = 0;
    for (let i = 0; i < octree.nodes.length; i++) {
        const count = octree.nodes[i]?.lods?.[0]?.count ?? 0;
        if (Number.isFinite(count) && count > 0) {
            total += count;
        }
    }
    return total;
}

/** 各 LOD 全场景点数合计 */
export function sumPointCountsByLod(octree: LodScaleAlignOctree, lodLevels: number): number[] {
    const counts = new Array<number>(Math.max(0, lodLevels)).fill(0);
    for (let i = 0; i < octree.nodes.length; i++) {
        const lods = octree.nodes[i]?.lods;
        if (!lods) {
            continue;
        }
        const n = Math.min(lods.length, lodLevels);
        for (let lod = 0; lod < n; lod++) {
            const count = lods[lod]?.count ?? 0;
            if (Number.isFinite(count) && count > 0) {
                counts[lod] += count;
            }
        }
    }
    return counts;
}

export function resolveOctreeMaxLod(octree: LodScaleAlignOctree): number {
    if (Number.isFinite(octree.lodLevels) && (octree.lodLevels as number) > 0) {
        return Math.max(0, Math.floor(octree.lodLevels as number) - 1);
    }
    let maxLen = 0;
    for (let i = 0; i < octree.nodes.length; i++) {
        const len = octree.nodes[i]?.lods?.length ?? 0;
        if (len > maxLen) {
            maxLen = len;
        }
    }
    return Math.max(0, maxLen - 1);
}

/**
 * 远景目标档：点数「约 1/64」优先（decimate 0.5 时≈第 6 档，跨层数结果稳定）；
 * 点数信号不足时回退层数约 2/3。
 */
export function resolveTargetFarLod(
    maxLod: number,
    pointCountsByLod: number[] | null | undefined
): { targetFarLod: number; targetByLayers: number; targetByPoints: number | null } {
    const capped = Math.max(0, Math.floor(maxLod));
    const targetByLayers = clamp(Math.round(capped * 2 / 3), Math.min(2, capped), capped);

    let targetByPoints: number | null = null;
    const l0 = pointCountsByLod?.[0] ?? 0;
    if (l0 > 0 && pointCountsByLod && pointCountsByLod.length > 0) {
        const thr = LOD_SCALE_POINT_RATIO_FAR * LOD_SCALE_POINT_RATIO_SLACK;
        const hi = Math.min(capped, pointCountsByLod.length - 1);
        for (let k = 2; k <= hi; k++) {
            const c = pointCountsByLod[k] ?? 0;
            if (c / l0 <= thr) {
                targetByPoints = k;
                break;
            }
        }
    }

    const targetFarLod = targetByPoints ?? targetByLayers;
    return { targetFarLod, targetByLayers, targetByPoints };
}

function densityDiagnosticRatio(pointCount: number, footprintArea: number): number {
    if (pointCount <= 0 || footprintArea <= 0) {
        return 0;
    }
    const cell = LOD_SCALE_CHUNK_EXTENT_M * LOD_SCALE_CHUNK_EXTENT_M;
    const pointsPerChunkCell = (pointCount / footprintArea) * cell;
    return pointsPerChunkCell / LOD_SCALE_TARGET_L0_POINTS;
}

/**
 * meta lodDistanceScale>1 → 有限乘子（最多相对 raw×qf ±25%），不与 density 叠加。
 */
export function applyMetaSoftFactor(rawWithQuality: number, metaScale: number | null | undefined): number {
    if (metaScale === null || metaScale === undefined || !Number.isFinite(metaScale) || metaScale <= 1 + 1e-6) {
        return rawWithQuality;
    }
    const soft = clamp(1 / metaScale, LOD_SCALE_SOFT_CORR_MIN, LOD_SCALE_SOFT_CORR_MAX);
    return rawWithQuality * soft;
}

export type AdaptiveLodBaseInput = {
    robustRadiusR95: number;
    maxLod: number;
    pointCountsByLod?: number[] | null;
    configuredD0?: number;
    lodMultiplier?: number;
    qualityFactor?: number;
    metaLodDistanceScale?: number | null;
};

export type AdaptiveLodBaseResult = {
    rawD0: number;
    effectiveD0: number;
    scale: number;
    targetFarLod: number;
    targetByLayers: number;
    targetByPoints: number | null;
    qualityFactor: number;
};

/**
 * R95 / m^(targetFarLod-1) × qualityFactor，可选 meta soft，钳到 [0.15, configuredD0]。
 */
export function computeAdaptiveLodBaseDistance(input: AdaptiveLodBaseInput): AdaptiveLodBaseResult | null {
    const r95 = input.robustRadiusR95;
    if (!Number.isFinite(r95) || r95 <= 0) {
        return null;
    }
    const configuredD0 = input.configuredD0 && input.configuredD0 > 0 ? input.configuredD0 : 5;
    const m = input.lodMultiplier && input.lodMultiplier > 1 ? input.lodMultiplier : LOD_SCALE_DEFAULT_MULTIPLIER;
    const qualityFactor =
        input.qualityFactor && input.qualityFactor > 0
            ? input.qualityFactor
            : LOD_SCALE_DEFAULT_QUALITY_FACTOR;

    const { targetFarLod, targetByLayers, targetByPoints } = resolveTargetFarLod(
        input.maxLod,
        input.pointCountsByLod
    );
    const exp = Math.max(0, targetFarLod - 1);
    const rawD0 = r95 / (m ** exp);
    if (!Number.isFinite(rawD0) || rawD0 <= 0) {
        return null;
    }

    const adaptive = applyMetaSoftFactor(rawD0 * qualityFactor, input.metaLodDistanceScale);
    const effectiveD0 = clamp(adaptive, LOD_SCALE_MIN_D0_M, configuredD0);
    const scale = effectiveD0 > 0 ? configuredD0 / effectiveD0 : 1;

    return {
        rawD0,
        effectiveD0,
        scale,
        targetFarLod,
        targetByLayers,
        targetByPoints,
        qualityFactor
    };
}

/** @deprecated 旧半边主信号；主路径已改用 computeAdaptiveLodBaseDistance */
export function computeHalfExtentScale(
    halfExtent: number,
    configuredD0: number,
    lodMultiplier: number = LOD_SCALE_DEFAULT_MULTIPLIER
): { halfScale: number; configuredL2: number; targetL2: number } {
    const m = Number.isFinite(lodMultiplier) && lodMultiplier > 1 ? lodMultiplier : LOD_SCALE_DEFAULT_MULTIPLIER;
    const configuredL2 = configuredD0 * m * m;
    const targetL2 = Math.max(LOD_SCALE_MIN_D0_M * m * m, LOD_SCALE_TARGET_L2_HALF_FRACTION * halfExtent);
    const halfScale = configuredL2 > targetL2
        ? clamp(configuredL2 / targetL2, 1, LOD_SCALE_MAX)
        : 1;
    return { halfScale, configuredL2, targetL2 };
}

/**
 * 由 octree 量纲估 R95+金字塔对齐指标与建议 effectiveD0。
 */
export function measureLodScaleAlign(
    octree: LodScaleAlignOctree,
    options?: {
        configuredD0?: number;
        lodMultiplier?: number;
        qualityFactor?: number;
        metaLodDistanceScale?: number | null;
    }
): LodScaleAlignMetrics & { suggestedEffectiveD0: number; suggestedScale: number } {
    const configuredD0 = options?.configuredD0 && options.configuredD0 > 0 ? options.configuredD0 : 5;
    const lodMultiplier = options?.lodMultiplier ?? LOD_SCALE_DEFAULT_MULTIPLIER;
    const qualityFactor = options?.qualityFactor ?? LOD_SCALE_DEFAULT_QUALITY_FACTOR;
    const metaLodDistanceScale = options?.metaLodDistanceScale ?? null;
    const nodeCount = octree.nodes.length;
    const extents = computeSceneExtentMetrics(octree.nodeBoundsMinMax, nodeCount);
    const medianLeafExtent = computeMedianLeafExtent(octree.nodeBoundsMinMax, nodeCount);
    const footprint = computeSceneFootprintArea(octree.nodeBoundsMinMax, nodeCount);
    const pointCountL0 = sumLod0PointCount(octree);
    const footprintArea = footprint?.footprintArea ?? 0;
    const densityRatio = densityDiagnosticRatio(pointCountL0, footprintArea);
    const maxLod = resolveOctreeMaxLod(octree);
    const pointCountsByLod = sumPointCountsByLod(octree, maxLod + 1);
    const r95 = computeLeafCenterDistanceP95(octree.nodeBoundsMinMax, nodeCount);

    const adaptive = r95
        ? computeAdaptiveLodBaseDistance({
            robustRadiusR95: r95,
            maxLod,
            pointCountsByLod,
            configuredD0,
            lodMultiplier,
            qualityFactor,
            metaLodDistanceScale
        })
        : null;

    const configuredL2 = configuredD0 * lodMultiplier * lodMultiplier;
    const targetFarLod = adaptive?.targetFarLod ?? clamp(Math.round(maxLod * 2 / 3), Math.min(2, maxLod), maxLod);
    const targetL2 = adaptive ? adaptive.rawD0 * adaptive.qualityFactor * (lodMultiplier ** Math.max(0, targetFarLod - 1)) : null;

    // 诊断用旧 leaf/density scale（不进最终 d0）
    const leafScale = medianLeafExtent && medianLeafExtent > 0
        ? clamp(Math.sqrt(LOD_SCALE_REF_MEDIAN_LEAF_M / medianLeafExtent), 1, LOD_SCALE_MAX)
        : 1;
    const densityScale = densityRatio > LOD_SCALE_TARGET_DENSITY_RATIO
        ? clamp(Math.sqrt(densityRatio / LOD_SCALE_TARGET_DENSITY_RATIO), 1, Math.min(LOD_SCALE_MAX, 4))
        : 1;

    const suggestedEffectiveD0 = adaptive?.effectiveD0 ?? configuredD0;
    const suggestedScale = adaptive?.scale ?? 1;

    return {
        sceneDiagonal: extents?.diagonal ?? null,
        halfExtent: extents?.halfExtent ?? null,
        longestExtent: extents?.longestExtent ?? null,
        medianLeafExtent,
        pointCountL0,
        footprintArea,
        densityRatio,
        robustRadiusR95: r95,
        maxLod,
        targetFarLod,
        targetByLayers: adaptive?.targetByLayers ?? targetFarLod,
        targetByPoints: adaptive?.targetByPoints ?? null,
        qualityFactor: adaptive?.qualityFactor ?? qualityFactor,
        rawD0: adaptive?.rawD0 ?? null,
        metaLodDistanceScale,
        halfScale: suggestedScale,
        extentScale: suggestedScale,
        leafScale,
        densityScale,
        combinedScale: suggestedScale,
        configuredL2,
        targetL2,
        suggestedEffectiveD0,
        suggestedScale
    };
}

export function resolveAlignedLodBaseDistance(
    configuredD0: number,
    metrics: LodScaleAlignMetrics & { suggestedEffectiveD0?: number; suggestedScale?: number },
    previousEffectiveD0?: number | null
): LodScaleAlignResult {
    const base = Number.isFinite(configuredD0) && configuredD0 > 0 ? configuredD0 : 5;
    const effectiveD0 = clamp(
        metrics.suggestedEffectiveD0 ?? (metrics.rawD0 != null
            ? clamp(metrics.rawD0 * metrics.qualityFactor, LOD_SCALE_MIN_D0_M, base)
            : base),
        LOD_SCALE_MIN_D0_M,
        base
    );
    const scale = effectiveD0 > 0 ? base / effectiveD0 : 1;
    metrics.combinedScale = scale;
    metrics.halfScale = scale;
    metrics.extentScale = scale;

    if (previousEffectiveD0 !== null && previousEffectiveD0 !== undefined && previousEffectiveD0 > 0) {
        const rel = Math.abs(effectiveD0 - previousEffectiveD0) / previousEffectiveD0;
        if (rel < LOD_SCALE_HYSTERESIS_RATIO) {
            return {
                applied: false,
                configuredD0: base,
                effectiveD0: previousEffectiveD0,
                scale,
                metrics,
                reason: 'hysteresis'
            };
        }
    }

    if (Math.abs(effectiveD0 - base) < 1e-6) {
        return {
            applied: false,
            configuredD0: base,
            effectiveD0: base,
            scale,
            metrics,
            reason: 'scale-near-1'
        };
    }

    return {
        applied: true,
        configuredD0: base,
        effectiveD0,
        scale,
        metrics,
        reason: 'aligned'
    };
}

type LodScaleDebugGlobal = typeof globalThis & {
    __lodScaleAlignDebug?: LodScaleAlignResult & { at: number };
};

/** 将对齐结果写入 entity 组件；返回是否改写了 d0 */
export function applyLodScaleAlignToComponent(
    gsplatComponent: { lodBaseDistance?: number; lodMultiplier?: number } | null | undefined,
    octree: LodScaleAlignOctree | null | undefined,
    configuredD0: number,
    options?: {
        enabled?: boolean;
        lodMultiplier?: number;
        qualityFactor?: number;
        metaLodDistanceScale?: number | null;
    }
): LodScaleAlignResult | null {
    if (options?.enabled === false) {
        return null;
    }
    if (!gsplatComponent || !octree?.nodes?.length || !octree.nodeBoundsMinMax) {
        return null;
    }

    const lodMultiplier =
        options?.lodMultiplier ??
        (Number.isFinite(gsplatComponent.lodMultiplier as number) && (gsplatComponent.lodMultiplier as number) > 0
            ? (gsplatComponent.lodMultiplier as number)
            : LOD_SCALE_DEFAULT_MULTIPLIER);

    const metrics = measureLodScaleAlign(octree, {
        configuredD0,
        lodMultiplier,
        qualityFactor: options?.qualityFactor,
        metaLodDistanceScale: options?.metaLodDistanceScale
    });
    const previous = Number.isFinite(gsplatComponent.lodBaseDistance as number)
        ? (gsplatComponent.lodBaseDistance as number)
        : null;
    const result = resolveAlignedLodBaseDistance(configuredD0, metrics, previous === configuredD0 ? null : previous);

    if (result.applied) {
        gsplatComponent.lodBaseDistance = result.effectiveD0;
    }

    (globalThis as LodScaleDebugGlobal).__lodScaleAlignDebug = {
        ...result,
        at: performance.now()
    };

    return result;
}

export function readLodScaleAlignDebug(): (LodScaleAlignResult & { at: number }) | null {
    return (globalThis as LodScaleDebugGlobal).__lodScaleAlignDebug ?? null;
}
