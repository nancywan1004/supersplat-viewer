/**
 * 资产侧 lod-meta.`lodDistanceScale`（AUTO_SCALE 密度尺）辅助工具。
 *
 * 主路径：viewer `lod-scale-align`（R95 + 金字塔）决定 lodBaseDistance；
 * meta S>1 时仅作 **soft 质量修正**（最多相对 raw×qf ±25%），由
 * `applyLodScaleAlignToComponent({ metaLodDistanceScale })` 读入，**不再**
 * 独立整表改写 d0 / 跳过 align，也**不与** viewer density 叠加。
 *
 * 本文件保留 `applyLodDistanceScaleFromMeta` 供诊断/旧脚本；bootstrap 主路径不调用。
 */

import { computeSceneExtentMetrics } from './lod-scale-align';

/** @deprecated 旧独立 meta 路径地板；主路径用 lod-scale-align 的 0.15 */
export const LOD_DISTANCE_SCALE_MIN_D0_M = 0.75;
/** lodUpdateDistance 缩放地板（米） */
export const LOD_DISTANCE_SCALE_MIN_UPDATE_M = 1;
/** 流式相机位移门槛缩放地板（米） */
export const LOD_DISTANCE_SCALE_MIN_MOVE_M = 0.01;
/**
 * 半边低于此值时，旧独立路径忽略 meta 密度尺（Florenz 半边~73m；Wuhan~124m 保留）。
 * 主路径 soft 修正不再使用该钳制。
 */
export const LOD_DISTANCE_SCALE_SMALL_HALF_EXTENT_M = 100;

export type LodDistanceScaleOctree = {
    nodes: unknown[];
    nodeBoundsMinMax: Float32Array;
};

export type LodDistanceScaleResource = {
    data?: { lodDistanceScale?: unknown } | null;
    octree?: LodDistanceScaleOctree | null;
};

export type LodDistanceScaleApplyResult = {
    /** 是否改写了运行时米制阈值 */
    applied: boolean;
    /** meta 原始值；缺省 / 非法为 null */
    metaScale: number | null;
    /** 钳制后实际使用的 S（≥1） */
    effectiveScale: number;
    halfExtent: number | null;
    configuredD0: number;
    effectiveD0: number;
    configuredUpdateDistance: number;
    effectiveUpdateDistance: number;
    configuredMoveThr: number;
    effectiveMoveThr: number;
    reason: 'meta' | 'clamped-small-extent' | 'missing' | 'near-1' | 'disabled';
};

type LodDistanceScaleDebugGlobal = typeof globalThis & {
    __lodDistanceScaleDebug?: LodDistanceScaleApplyResult & { at: number };
};

export function readMetaLodDistanceScale(
    resource: LodDistanceScaleResource | null | undefined
): number | null {
    const raw = resource?.data?.lodDistanceScale;
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw <= 0) {
        return null;
    }
    return raw;
}

/**
 * 解析有效 S：meta 缺失→1；小半边钳 1；否则 max(1, meta)。
 * @deprecated 主路径改用 soft 修正；仅旧独立 apply 使用。
 */
export function resolveEffectiveLodDistanceScale(
    metaScale: number | null,
    halfExtent: number | null | undefined
): { scale: number; reason: LodDistanceScaleApplyResult['reason'] } {
    if (metaScale === null) {
        return { scale: 1, reason: 'missing' };
    }
    if (metaScale <= 1 + 1e-6) {
        return { scale: 1, reason: 'near-1' };
    }
    if (
        halfExtent !== null &&
        halfExtent !== undefined &&
        Number.isFinite(halfExtent) &&
        halfExtent > 0 &&
        halfExtent < LOD_DISTANCE_SCALE_SMALL_HALF_EXTENT_M
    ) {
        return { scale: 1, reason: 'clamped-small-extent' };
    }
    return { scale: metaScale, reason: 'meta' };
}

export function scaleLodThresholdMeters(value: number, scale: number, floor: number): number {
    const base = Number.isFinite(value) && value > 0 ? value : floor;
    const s = Number.isFinite(scale) && scale > 1 ? scale : 1;
    return Math.max(floor, base / s);
}

/**
 * @deprecated 旧独立 meta 整表改写路径。bootstrap 已改为 R95 align + meta soft；
 * 返回 applied=false 时调用方应回退到 viewer lod-scale-align（历史语义）。
 */
export function applyLodDistanceScaleFromMeta(
    gsplatComponent: { lodBaseDistance?: number } | null | undefined,
    gsplatScene: { lodUpdateDistance?: number } | null | undefined,
    resource: LodDistanceScaleResource | null | undefined,
    options: {
        configuredD0: number;
        configuredUpdateDistance: number;
        configuredMoveThr?: number;
        enabled?: boolean;
    }
): LodDistanceScaleApplyResult {
    const configuredD0 = options.configuredD0 > 0 ? options.configuredD0 : 5;
    const configuredUpdateDistance =
        options.configuredUpdateDistance > 0 ? options.configuredUpdateDistance : 32;
    const configuredMoveThr =
        options.configuredMoveThr !== undefined && options.configuredMoveThr > 0
            ? options.configuredMoveThr
            : 0.03;

    const empty = (
        reason: LodDistanceScaleApplyResult['reason'],
        metaScale: number | null,
        halfExtent: number | null,
        scale: number
    ): LodDistanceScaleApplyResult => ({
        applied: false,
        metaScale,
        effectiveScale: scale,
        halfExtent,
        configuredD0,
        effectiveD0: configuredD0,
        configuredUpdateDistance,
        effectiveUpdateDistance: configuredUpdateDistance,
        configuredMoveThr,
        effectiveMoveThr: configuredMoveThr,
        reason
    });

    if (options.enabled === false) {
        const result = empty('disabled', null, null, 1);
        publishLodDistanceScaleDebug(result);
        return result;
    }

    const metaScale = readMetaLodDistanceScale(resource);
    const octree = resource?.octree ?? null;
    const halfExtent = octree?.nodes?.length && octree.nodeBoundsMinMax
        ? computeSceneExtentMetrics(octree.nodeBoundsMinMax, octree.nodes.length)?.halfExtent ?? null
        : null;

    const { scale, reason } = resolveEffectiveLodDistanceScale(metaScale, halfExtent);
    if (scale <= 1 + 1e-6) {
        const result = empty(reason, metaScale, halfExtent, 1);
        publishLodDistanceScaleDebug(result);
        return result;
    }

    const effectiveD0 = scaleLodThresholdMeters(configuredD0, scale, LOD_DISTANCE_SCALE_MIN_D0_M);
    const effectiveUpdateDistance = scaleLodThresholdMeters(
        configuredUpdateDistance,
        scale,
        LOD_DISTANCE_SCALE_MIN_UPDATE_M
    );
    const effectiveMoveThr = scaleLodThresholdMeters(
        configuredMoveThr,
        scale,
        LOD_DISTANCE_SCALE_MIN_MOVE_M
    );

    if (gsplatComponent) {
        gsplatComponent.lodBaseDistance = effectiveD0;
    }
    if (gsplatScene) {
        gsplatScene.lodUpdateDistance = effectiveUpdateDistance;
    }

    const result: LodDistanceScaleApplyResult = {
        applied: true,
        metaScale,
        effectiveScale: scale,
        halfExtent,
        configuredD0,
        effectiveD0,
        configuredUpdateDistance,
        effectiveUpdateDistance,
        configuredMoveThr,
        effectiveMoveThr,
        reason: 'meta'
    };
    publishLodDistanceScaleDebug(result);
    return result;
}

function publishLodDistanceScaleDebug(result: LodDistanceScaleApplyResult): void {
    (globalThis as LodDistanceScaleDebugGlobal).__lodDistanceScaleDebug = {
        ...result,
        at: performance.now()
    };
}

export function readLodDistanceScaleDebug(): (LodDistanceScaleApplyResult & { at: number }) | null {
    return (globalThis as LodDistanceScaleDebugGlobal).__lodDistanceScaleDebug ?? null;
}
