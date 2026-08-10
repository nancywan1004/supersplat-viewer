/**
 * Spark-like lodRenderScale：屏幕尺寸选档纯函数（Chunk LOD 离散近似）。
 *
 * LOD0 = 最细，索引越大越粗。
 * 设计见 docs/lodRenderScale机制说明.md
 */

/** 叶档代表 Gaussian 世界直径分位数（与场景单位一致） */
export type RepScaleStats = {
    p50: number;
    p75: number;
    p90: number;
};

export type LodSelectMode = 'distance' | 'renderScale';

/** 视线夹角 foveation（度 / 无量纲因子） */
export type LodRenderScaleFoveationParams = {
    /** 全细节锥半角（度），夹角 ≤ 此值时 factor=1 */
    coneFov0Deg: number;
    /** 外锥半角（度），此角处 factor=`coneFoveate` */
    coneFovDeg: number;
    /** 外锥边缘 foveate 因子（<1 → 更粗） */
    coneFoveate: number;
    /** 身后（≈180°）foveate 因子 */
    behindFoveate: number;
};

export const DEFAULT_LOD_RENDER_SCALE = 1.0;

export const DEFAULT_LOD_RENDER_SCALE_FOVEATION: Readonly<LodRenderScaleFoveationParams> = {
    coneFov0Deg: 20,
    coneFovDeg: 80,
    coneFoveate: 0.5,
    behindFoveate: 0.2
};

const DIST_EPS = 1e-4;
const FOV_EPS = 1e-6;

function lerp(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function clamp01(t: number): number {
    return Math.max(0, Math.min(1, t));
}

/**
 * 投影像素因子：世界单位长度在焦点处对应的像素数。
 * `pixelFactor = viewportHeight / (2 * tan(verticalFov/2))`
 */
export function computePixelFactor(viewportHeightPx: number, verticalFovRad: number): number {
    const h = Math.max(1, viewportHeightPx);
    const halfFov = Math.max(FOV_EPS, verticalFovRad * 0.5);
    return h / (2 * Math.tan(halfFov));
}

/**
 * 代表直径投影到屏幕上的像素直径。
 * `screenDiameter = repDiameter * pixelFactor / distance`
 */
export function computeScreenDiameter(
    representativeDiameter: number,
    pixelFactor: number,
    distanceToLeaf: number
): number {
    const d = Math.max(DIST_EPS, distanceToLeaf);
    const rep = Math.max(0, representativeDiameter);
    const pf = Math.max(0, pixelFactor);
    return (rep * pf) / d;
}

/** 由每档代表直径批量算 screenDiameter[lod] */
export function buildScreenDiameters(
    representativeDiameters: ArrayLike<number>,
    pixelFactor: number,
    distanceToLeaf: number
): number[] {
    const out = new Array<number>(representativeDiameters.length);
    for (let i = 0; i < representativeDiameters.length; i++) {
        out[i] = computeScreenDiameter(representativeDiameters[i], pixelFactor, distanceToLeaf);
    }
    return out;
}

/**
 * 按视线夹角（叶方向相对相机 forward，0=正视，180=身后）连续求 foveateFactor。
 * 中央=1，边缘→coneFoveate，身后→behindFoveate。
 */
export function computeFoveateFactor(
    viewAngleDeg: number,
    params: LodRenderScaleFoveationParams = DEFAULT_LOD_RENDER_SCALE_FOVEATION
): number {
    const cone0 = Math.max(0, params.coneFov0Deg);
    const cone = Math.max(cone0, params.coneFovDeg);
    const edge = Math.max(FOV_EPS, params.coneFoveate);
    const behind = Math.max(FOV_EPS, params.behindFoveate);
    const a = Math.max(0, Math.min(180, viewAngleDeg));

    if (a <= cone0) {
        return 1;
    }
    if (a <= cone) {
        const t = clamp01((a - cone0) / Math.max(FOV_EPS, cone - cone0));
        return lerp(1, edge, t);
    }
    const t = clamp01((a - cone) / Math.max(FOV_EPS, 180 - cone));
    return lerp(edge, behind, t);
}

/**
 * `effectiveRenderScale = baseRenderScale / foveateFactor`
 * 边缘 factor↓ → 有效阈值↑ → 选更粗档。
 */
export function computeEffectiveRenderScale(
    baseRenderScale: number,
    foveateFactor: number
): number {
    const base = Math.max(FOV_EPS, baseRenderScale);
    const f = Math.max(FOV_EPS, foveateFactor);
    return base / f;
}

/**
 * 选档：LOD0 最细。找满足
 *   screenDiameter[lod] >= threshold
 *   且 (lod===0 || screenDiameter[lod-1] < threshold)
 * 的 lod；若全部亚阈值则退到最粗档。
 */
export function selectRenderScaleLod(
    screenDiameters: ArrayLike<number>,
    effectiveRenderScale: number
): number {
    const n = screenDiameters.length;
    if (n <= 0) {
        return 0;
    }
    const maxLod = n - 1;
    const threshold = Math.max(FOV_EPS, effectiveRenderScale);

    for (let lod = 0; lod <= maxLod; lod++) {
        const d = screenDiameters[lod];
        if (!(d >= threshold)) {
            continue;
        }
        if (lod === 0 || screenDiameters[lod - 1] < threshold) {
            return lod;
        }
    }
    return maxLod;
}

/**
 * 视觉目标与预算目标合并：index 越大越粗。
 * budget 充足停在视觉档；不足允许更粗；富余不突破视觉目标。
 */
export function mergeVisualBudgetLod(renderScaleLod: number, budgetOptimalLod: number): number {
    const a = Math.max(0, renderScaleLod | 0);
    const b = Math.max(0, budgetOptimalLod | 0);
    return Math.max(a, b);
}

/**
 * 选档主用 p75；无效时用 fallbackDiameter。
 */
export function resolveRepresentativeDiameter(
    stats: RepScaleStats | null | undefined,
    fallbackDiameter: number
): number {
    if (stats && Number.isFinite(stats.p75) && stats.p75 > 0) {
        return stats.p75;
    }
    return Math.max(0, fallbackDiameter);
}

/**
 * 无离线 repScale 时的粗估：`k * aabbDiagonal / cbrt(count)`。
 */
export function estimateRepDiameterFromAabb(
    leafAabbDiagonal: number,
    splatCount: number,
    k = 1
): number {
    const diag = Math.max(0, leafAabbDiagonal);
    const n = Math.max(1, splatCount);
    return (Math.max(0, k) * diag) / Math.cbrt(n);
}

/**
 * 从 meta lod 条目解析 `repScale`；缺字段或非法返回 null。
 */
export function parseRepScaleStats(raw: unknown): RepScaleStats | null {
    if (!raw || typeof raw !== 'object') {
        return null;
    }
    const o = raw as Record<string, unknown>;
    const p50 = typeof o.p50 === 'number' ? o.p50 : NaN;
    const p75 = typeof o.p75 === 'number' ? o.p75 : NaN;
    const p90 = typeof o.p90 === 'number' ? o.p90 : NaN;
    if (!(p50 > 0) || !(p75 > 0) || !(p90 > 0)) {
        return null;
    }
    return { p50, p75, p90 };
}

/**
 * 便捷：给定每档代表直径 + 相机投影参数 → renderScaleLod。
 */
export function selectRenderScaleLodFromDiameters(
    representativeDiameters: ArrayLike<number>,
    pixelFactor: number,
    distanceToLeaf: number,
    effectiveRenderScale: number
): number {
    const screens = buildScreenDiameters(representativeDiameters, pixelFactor, distanceToLeaf);
    return selectRenderScaleLod(screens, effectiveRenderScale);
}

/** 叶 × LOD 代表直径表（世界单位）；`diameters[leaf * lodLevels + lod]` */
export type LeafRepDiameterTable = {
    leafCount: number;
    lodLevels: number;
    diameters: Float32Array;
    /** meta 命中叶数；其余为 AABB fallback */
    metaLeafCount: number;
    source: 'meta' | 'aabb-fallback' | 'mixed';
};

function aabbDiagonalFromBounds(bounds: Float32Array, leafIndex: number): number {
    const b = leafIndex * 6;
    const dx = bounds[b + 3] - bounds[b];
    const dy = bounds[b + 4] - bounds[b + 1];
    const dz = bounds[b + 5] - bounds[b + 2];
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * 从 lod-meta 顶栏 `leafRepScale`（leaf → per-lod 选档直径[]）读取；
 * tree 在引擎解析后会被置 null，故用顶栏旁路表（P2 写出；值为密度帽后的 P50）。
 */
export function parseLeafRepScaleTable(
    data: unknown,
    leafCount: number,
    lodLevels: number
): Float32Array | null {
    if (!data || typeof data !== 'object' || leafCount <= 0 || lodLevels <= 0) {
        return null;
    }
    const raw = (data as { leafRepScale?: unknown }).leafRepScale;
    if (!Array.isArray(raw) || raw.length < leafCount) {
        return null;
    }
    const out = new Float32Array(leafCount * lodLevels);
    let ok = 0;
    for (let leaf = 0; leaf < leafCount; leaf++) {
        const row = raw[leaf];
        if (!Array.isArray(row)) {
            continue;
        }
        let rowOk = true;
        for (let lod = 0; lod < lodLevels; lod++) {
            const v = row[lod];
            if (typeof v !== 'number' || !(v > 0)) {
                rowOk = false;
                break;
            }
            out[leaf * lodLevels + lod] = v;
        }
        if (rowOk) {
            ok++;
        }
    }
    return ok > 0 ? out : null;
}

/**
 * 构建每叶每档代表直径：优先 meta `leafRepScale`，缺档用 AABB/`count` fallback。
 */
export function buildLeafRepDiameterTable(args: {
    leafCount: number;
    lodLevels: number;
    nodeBoundsMinMax: Float32Array;
    getSplatCount: (leafIndex: number, lod: number) => number;
    metaData?: unknown;
}): LeafRepDiameterTable {
    const { leafCount, lodLevels, nodeBoundsMinMax, getSplatCount, metaData } = args;
    const diameters = new Float32Array(Math.max(0, leafCount * lodLevels));
    const meta = parseLeafRepScaleTable(metaData, leafCount, lodLevels);
    let metaLeafCount = 0;

    for (let leaf = 0; leaf < leafCount; leaf++) {
        const diag = aabbDiagonalFromBounds(nodeBoundsMinMax, leaf);
        let leafHasMeta = true;
        for (let lod = 0; lod < lodLevels; lod++) {
            const idx = leaf * lodLevels + lod;
            const fromMeta = meta?.[idx] ?? 0;
            if (fromMeta > 0) {
                diameters[idx] = fromMeta;
            } else {
                leafHasMeta = false;
                diameters[idx] = estimateRepDiameterFromAabb(diag, getSplatCount(leaf, lod), 1);
            }
        }
        if (leafHasMeta && meta) {
            metaLeafCount++;
        }
    }

    let source: LeafRepDiameterTable['source'] = 'aabb-fallback';
    if (metaLeafCount >= leafCount && leafCount > 0) {
        source = 'meta';
    } else if (metaLeafCount > 0) {
        source = 'mixed';
    }

    return { leafCount, lodLevels, diameters, metaLeafCount, source };
}

/** 叶心相对相机 forward 的夹角（度，0=正视，180=身后） */
export function computeViewAngleDeg(
    leafCenterX: number,
    leafCenterY: number,
    leafCenterZ: number,
    cameraPosX: number,
    cameraPosY: number,
    cameraPosZ: number,
    cameraFwdX: number,
    cameraFwdY: number,
    cameraFwdZ: number
): number {
    const dx = leafCenterX - cameraPosX;
    const dy = leafCenterY - cameraPosY;
    const dz = leafCenterZ - cameraPosZ;
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    if (len < DIST_EPS) {
        return 0;
    }
    const cos = (dx * cameraFwdX + dy * cameraFwdY + dz * cameraFwdZ) / len;
    const c = Math.max(-1, Math.min(1, cos));
    return Math.acos(c) * (180 / Math.PI);
}

/**
 * PlayCanvas CameraComponent.fov（度）→ 垂直 FOV（弧度）。
 * `horizontalFov===true` 时 fov 为水平角。
 */
export function resolveVerticalFovRad(fovDeg: number, aspectRatio: number, horizontalFov: boolean): number {
    const fov = Math.max(FOV_EPS, fovDeg) * (Math.PI / 180);
    if (!horizontalFov) {
        return fov;
    }
    const aspect = Math.max(FOV_EPS, aspectRatio);
    return 2 * Math.atan(Math.tan(fov * 0.5) / aspect);
}

/**
 * 下载视觉紧迫度：当前屏上直径相对目标越大越急。
 * `log2(current/target) × projectedArea × foveationWeight`；亚目标时钳到 0。
 */
export function computeVisualUrgency(
    currentScreenDiameter: number,
    targetScreenDiameter: number,
    projectedArea: number,
    foveationWeight: number
): number {
    const cur = Math.max(FOV_EPS, currentScreenDiameter);
    const tgt = Math.max(FOV_EPS, targetScreenDiameter);
    const ratio = cur / tgt;
    if (!(ratio > 1)) {
        return 0;
    }
    const area = Math.max(0, projectedArea);
    const fovW = Math.max(0, foveationWeight);
    return Math.log2(ratio) * area * fovW;
}

/**
 * 单文件优先级：urgency / costProxy（无 compressedBytes 时用 splat count）。
 */
export function computeFilePriority(visualUrgency: number, costProxy: number): number {
    const cost = Math.max(1, costProxy);
    return Math.max(0, visualUrgency) / cost;
}
