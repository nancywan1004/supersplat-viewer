/**
 * Viewer 侧调度米制尺对齐（AUTO_SCALE 同构）。
 *
 * 预处理 AUTO_SCALE：几何 ×S → 固定 d0=5 相对场景更「短」→ 更早粗档。
 * Viewer 不改坐标：effectiveD0 = configuredD0 / S（只缩小、不放大），
 * 并写回 entity.gsplat.lodBaseDistance，与引擎/refinement 共用。
 *
 * 信号：场景对角、叶中位对角、密度 ratio（与 splat-transform densityScale 同构）。
 */

import { computeMedianLeafExtent } from './leaf-extent';

/** Poland-new 量级：固定 d0=5 相对合理的参考对角 */
export const LOD_SCALE_REF_SCENE_DIAGONAL_M = 4000;
/** Poland-new 叶中位对角量级 */
export const LOD_SCALE_REF_MEDIAN_LEAF_M = 35;
/** 与 splat-transform DEFAULT_LOD_CHUNK_EXTENT 对齐 */
export const LOD_SCALE_CHUNK_EXTENT_M = 10;
/** 与 splat-transform DEFAULT_TARGET_L0_POINTS 对齐 */
export const LOD_SCALE_TARGET_L0_POINTS = 4096;
/** 与 splat-transform DEFAULT_TARGET_DENSITY_RATIO 对齐 */
export const LOD_SCALE_TARGET_DENSITY_RATIO = 0.5;
/** 密度触发：ratio > target × trigger 才上调 scale */
export const LOD_SCALE_DENSITY_TRIGGER_RATIO = 1;
/** viewer 侧比 preprocess maxScale=32 更保守，避免与投影密度双重过粗 */
export const LOD_SCALE_MAX = 6;
/** effectiveD0 地板，避免贴脸也永远追不到细档 */
export const LOD_SCALE_MIN_D0_M = 0.75;
/** 二次应用时相对变化低于此比例则跳过（滞回） */
export const LOD_SCALE_HYSTERESIS_RATIO = 0.08;

export type LodScaleAlignMetrics = {
    sceneDiagonal: number | null;
    medianLeafExtent: number | null;
    pointCountL0: number;
    footprintArea: number;
    densityRatio: number;
    extentScale: number;
    leafScale: number;
    densityScale: number;
    combinedScale: number;
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
};

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}

/** 全体节点 AABB 空间对角线；无有效 bounds 时 null */
export function computeSceneDiagonal(
    nodeBoundsMinMax: Float32Array | null | undefined,
    nodeCount: number
): number | null {
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
    const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
    return Number.isFinite(diag) && diag > 0 ? diag : null;
}

/** 两最大轴乘积作 footprint（与 splat-transform estimateFootprintArea 同构） */
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

function densitySuggestedScale(
    pointCount: number,
    footprintArea: number,
    options?: { maxScale?: number }
): { densityRatio: number; densityScale: number } {
    const maxScale = options?.maxScale ?? LOD_SCALE_MAX;
    if (pointCount <= 0 || footprintArea <= 0) {
        return { densityRatio: 0, densityScale: 1 };
    }
    const cell = LOD_SCALE_CHUNK_EXTENT_M * LOD_SCALE_CHUNK_EXTENT_M;
    const pointsPerChunkCell = (pointCount / footprintArea) * cell;
    const densityRatio = pointsPerChunkCell / LOD_SCALE_TARGET_L0_POINTS;
    const denseThreshold = LOD_SCALE_TARGET_DENSITY_RATIO * LOD_SCALE_DENSITY_TRIGGER_RATIO;
    if (densityRatio <= denseThreshold * (1 + 1e-9)) {
        return { densityRatio, densityScale: 1 };
    }
    const raw = Math.sqrt(densityRatio / LOD_SCALE_TARGET_DENSITY_RATIO);
    return { densityRatio, densityScale: clamp(raw, 1, maxScale) };
}

/**
 * 由 octree 量纲估 AUTO_SCALE 同构 scale。
 * extent 用 sqrt 软化，避免小对角场景单独打满 maxScale。
 */
export function measureLodScaleAlign(octree: LodScaleAlignOctree): LodScaleAlignMetrics {
    const nodeCount = octree.nodes.length;
    const sceneDiagonal = computeSceneDiagonal(octree.nodeBoundsMinMax, nodeCount);
    const medianLeafExtent = computeMedianLeafExtent(octree.nodeBoundsMinMax, nodeCount);
    const footprint = computeSceneFootprintArea(octree.nodeBoundsMinMax, nodeCount);
    const pointCountL0 = sumLod0PointCount(octree);
    const footprintArea = footprint?.footprintArea ?? 0;

    const extentScale = sceneDiagonal && sceneDiagonal > 0
        ? clamp(Math.sqrt(LOD_SCALE_REF_SCENE_DIAGONAL_M / sceneDiagonal), 1, LOD_SCALE_MAX)
        : 1;
    const leafScale = medianLeafExtent && medianLeafExtent > 0
        ? clamp(LOD_SCALE_REF_MEDIAN_LEAF_M / medianLeafExtent, 1, LOD_SCALE_MAX)
        : 1;
    const { densityRatio, densityScale } = densitySuggestedScale(pointCountL0, footprintArea);

    const combinedScale = clamp(Math.max(extentScale, leafScale, densityScale), 1, LOD_SCALE_MAX);

    return {
        sceneDiagonal,
        medianLeafExtent,
        pointCountL0,
        footprintArea,
        densityRatio,
        extentScale,
        leafScale,
        densityScale,
        combinedScale
    };
}

export function resolveAlignedLodBaseDistance(
    configuredD0: number,
    metrics: LodScaleAlignMetrics,
    previousEffectiveD0?: number | null
): LodScaleAlignResult {
    const base = Number.isFinite(configuredD0) && configuredD0 > 0 ? configuredD0 : 5;
    const scale = metrics.combinedScale;
    const rawEffective = base / scale;
    const effectiveD0 = clamp(rawEffective, LOD_SCALE_MIN_D0_M, base);

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
    gsplatComponent: { lodBaseDistance?: number } | null | undefined,
    octree: LodScaleAlignOctree | null | undefined,
    configuredD0: number,
    options?: { enabled?: boolean }
): LodScaleAlignResult | null {
    if (options?.enabled === false) {
        return null;
    }
    if (!gsplatComponent || !octree?.nodes?.length || !octree.nodeBoundsMinMax) {
        return null;
    }

    const metrics = measureLodScaleAlign(octree);
    const previous = Number.isFinite(gsplatComponent.lodBaseDistance as number)
        ? (gsplatComponent.lodBaseDistance as number)
        : null;
    // 滞回相对「已生效 d0」；若当前仍是配置值则 previous 可作参考
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
