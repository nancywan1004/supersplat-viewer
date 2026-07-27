/**
 * 叶节点 AABB 尺度（中位空间对角线）与相机触发门槛。
 * Phase 1：位移门槛按叶尺度自适应；选档距离仍由 lodBaseDistance 控制。
 */

/** 位移 = medianDiag × 该比例，再 clamp */
export const MOVE_THR_LEAF_FRACTION = 0.05;
/** 下限 0.15：相对旧 0.03 更钝，压 Wuhan 手微抖 / 插值 churn */
export const MOVE_THR_MIN_M = 0.15;
export const MOVE_THR_MAX_M = 2.0;

/** zoom 距离触发绝对下限（对齐旧 0.04） */
export const ZOOM_DIST_EPS = 0.04;
/** zoom 按相机 distance 比例（对齐旧 0.08） */
export const ZOOM_DIST_FRACTION = 0.08;

/** 相对上次触发 forward：累计转角达此值 → 进入 inMotion 并 notify */
export const ROTATE_START_DEG = 3;
/** 已在 motion 中：再累计达此值才再次 notify */
export const ROTATE_CONTINUE_DEG = 2;

/**
 * 叶 AABB 空间对角线中位数 `sqrt(dx²+dy²+dz²)`（局部空间）。
 * 无有效叶 bounds 时返回 null。
 */
export function computeMedianLeafExtent(
    nodeBoundsMinMax: Float32Array | null | undefined,
    nodeCount: number
): number | null {
    if (!nodeBoundsMinMax || nodeCount <= 0 || nodeBoundsMinMax.length < nodeCount * 6) {
        return null;
    }

    const extents = new Float64Array(nodeCount);
    let valid = 0;
    for (let i = 0; i < nodeCount; i++) {
        const b = i * 6;
        const dx = nodeBoundsMinMax[b + 3] - nodeBoundsMinMax[b];
        const dy = nodeBoundsMinMax[b + 4] - nodeBoundsMinMax[b + 1];
        const dz = nodeBoundsMinMax[b + 5] - nodeBoundsMinMax[b + 2];
        if (!Number.isFinite(dx) || !Number.isFinite(dy) || !Number.isFinite(dz)) {
            continue;
        }
        if (dx <= 0 || dy <= 0 || dz <= 0) {
            continue;
        }
        const diag = Math.sqrt(dx * dx + dy * dy + dz * dz);
        if (!Number.isFinite(diag) || diag <= 0) {
            continue;
        }
        extents[valid++] = diag;
    }

    if (valid === 0) {
        const dx = nodeBoundsMinMax[3] - nodeBoundsMinMax[0];
        const dy = nodeBoundsMinMax[4] - nodeBoundsMinMax[1];
        const dz = nodeBoundsMinMax[5] - nodeBoundsMinMax[2];
        if (Number.isFinite(dx) && Number.isFinite(dy) && Number.isFinite(dz) && dx > 0 && dy > 0 && dz > 0) {
            const rootDiag = Math.sqrt(dx * dx + dy * dy + dz * dz);
            if (Number.isFinite(rootDiag) && rootDiag > 0) {
                return Math.max(rootDiag, 1e-3);
            }
        }
        return null;
    }

    const sorted = Array.from(extents.subarray(0, valid));
    sorted.sort((a, b) => a - b);
    const mid = Math.floor(valid / 2);
    const median = valid % 2 === 1 ? sorted[mid] : 0.5 * (sorted[mid - 1] + sorted[mid]);
    return Math.max(median, 1e-3);
}

/**
 * 自适应位移门槛：`clamp(medianLeafDiag * 0.05, 0.15, 2.0)`。
 * median 未知时回退下限 0.15（仍比旧 0.03 钝）。
 */
export function resolveMoveTriggerThreshold(medianLeafDiag?: number | null): number {
    if (medianLeafDiag === null || medianLeafDiag === undefined || !Number.isFinite(medianLeafDiag) || medianLeafDiag <= 0) {
        return MOVE_THR_MIN_M;
    }
    const raw = medianLeafDiag * MOVE_THR_LEAF_FRACTION;
    return Math.min(MOVE_THR_MAX_M, Math.max(MOVE_THR_MIN_M, raw));
}

/** zoom 距离门槛：`max(0.04, distance × 0.08)`（本阶段不跟叶尺度） */
export function resolveZoomDistanceThreshold(cameraDistance: number): number {
    return Math.max(ZOOM_DIST_EPS, Math.max(0, cameraDistance) * ZOOM_DIST_FRACTION);
}
