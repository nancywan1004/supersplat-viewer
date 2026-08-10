/**
 * 视锥外降档 + 预算回填可见区 + 同视角防抖：
 *
 * 预算（evaluateOptimalLods 后）：
 *   - OOF placeable 叶 optimal → bootstrap（并从额度里抠掉看不见的细档）
 *   - 返回值仍用钳制前 Σopt，避免系统性 underfill 把 `_budgetScale` 拉到 100
 *   - balancer 欠预算时从近桶加细 → 额度回填 Center/Edge（opt/adj 可上升）
 *
 * 显示（apply 前）：
 *   - current 仍细的 OOF → optimal/bootstrap 换档吐 WB
 *   - 同一视角 hold：视锥内（含 sticky）只许变清、不许变糊；
 *     恢复细档时若会让 Σopt 超过 splatBudget 则放弃（避免 opt>bud）
 *
 * 其它：
 *   - 世界系 AABB 缓存 / placeable 掩码
 *   - 无「细档 OOF current」时跳过换档扫描
 *   - idle drip 限频
 */
import { Frustum, Mat4, Vec3, math, type AppBase, type Entity } from 'playcanvas';

import {
    findAllOctreeInstances,
    requestOctreePlacementUpdate,
    type OctreeInstanceLike
} from './octree-instance-access';
import { getOctreeBootstrapLod, isOctreeBootstrapPlaceableNode } from './lod-meta';

export type OofDowngradeStats = {
    clamped: number;
    pendingCoarse: number;
    budgetExcluded: number;
    /** 同视角 hold 挡住的「变糊」叶数 */
    held?: number;
};

type OctreeNodeLike = {
    lods: Array<{ fileIndex: number; count?: number }>;
};

type OctreeHost = {
    nodes: OctreeNodeLike[];
    nodeBoundsMinMax: Float32Array;
    lodLevels: number;
    ensureFileResource: (fileIndex: number) => void;
    getFileResource: (fileIndex: number) => unknown;
};

type OofCameraMats = {
    viewProj: Mat4;
    frustum: Frustum;
    worldTransform: Mat4;
    cameraPos: Vec3;
    cameraFwd: Vec3;
    fov: number;
};

type NodeInfoBudget = {
    currentLod: number;
    optimalLod: number;
    budgetBucket?: number;
};

type LodViewHoldState = {
    posX: number;
    posY: number;
    posZ: number;
    fwdX: number;
    fwdY: number;
    fwdZ: number;
    fov: number;
    /** 同锚点下连续 apply 次数；≥1 才启用 hold（首拍允许全量重算） */
    framesStable: number;
};

type OctreeInstanceOofPatched = OctreeInstanceLike & {
    octree: OctreeHost;
    nodeInfos: NodeInfoBudget[];
    applyLodChanges?: (maxLod: number, params: unknown) => void;
    evaluateOptimalLods?: (...args: unknown[]) => number;
    __oofApplyPatched?: boolean;
    __oofEvalOptimalPatched?: boolean;
    __originalApplyLodChanges?: (maxLod: number, params: unknown) => void;
    __originalEvaluateOptimalLods?: (...args: unknown[]) => number;
    __oofDripLimit?: number | null;
    __oofLastStats?: OofDowngradeStats;
    __oofInView?: Uint8Array;
    __oofInViewFp?: string;
    /** 世界系 AABB：xmin,ymin,zmin,xmax,ymax,zmax * n */
    __oofWorldBounds?: Float32Array;
    __oofWorldBoundsFp?: string;
    __oofBootstrapLod?: number;
    __oofPlaceable?: Uint8Array;
    /** 同视角下 sticky 视锥内：离开边界后仍防糊，直到相机移动 */
    __lodHoldStickyInView?: Uint8Array;
    __lodViewHold?: LodViewHoldState;
};

const OOF_BUDGET_BUCKET_FAR = 63;
const DEFAULT_IDLE_DRIP_LIMIT = 16;
const IDLE_DRIP_TICK_INTERVAL = 30;

/** 同视角判定：位移 / 朝向 / FOV（略严于引擎 lodUpdate，避免微抖反复解锁） */
const VIEW_HOLD_POS_EPS_M = 0.08;
const VIEW_HOLD_ANGLE_DEG = 0.6;
const VIEW_HOLD_FOV_REL = 0.02;

const _viewProj = new Mat4();
const _frustum = new Frustum();
const _worldMin = new Vec3();
const _worldMax = new Vec3();
const _camPos = new Vec3();
const _camFwd = new Vec3();

let _idleDripTickCounter = 0;
/** 模块级开关：由 refinement / URL 配置 */
let _oofDowngradeEnabled = true;
let _lodViewHoldEnabled = true;

export function configureLodStabilizers(options: {
    oofDowngrade?: boolean;
    lodViewHold?: boolean;
}): void {
    if (options.oofDowngrade !== undefined) {
        _oofDowngradeEnabled = options.oofDowngrade;
    }
    if (options.lodViewHold !== undefined) {
        _lodViewHoldEnabled = options.lodViewHold;
    }
}

export function isLodViewHoldEnabled(): boolean {
    return _lodViewHoldEnabled;
}

export function isOofDowngradeEnabled(): boolean {
    return _oofDowngradeEnabled;
}

function aabbIntersectsFrustum(
    frustum: Frustum,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number
): boolean {
    for (let p = 0; p < 6; p++) {
        const plane = frustum.planes[p];
        const nx = plane.normal.x;
        const ny = plane.normal.y;
        const nz = plane.normal.z;
        const d = plane.distance;
        const px = nx >= 0 ? maxX : minX;
        const py = ny >= 0 ? maxY : minY;
        const pz = nz >= 0 ? maxZ : minZ;
        if (nx * px + ny * py + nz * pz + d <= 0) {
            return false;
        }
    }
    return true;
}

function mat4Fingerprint(m: Mat4): string {
    const d = m.data as Float32Array | number[];
    return [
        d[0]?.toFixed?.(3),
        d[5]?.toFixed?.(3),
        d[10]?.toFixed?.(3),
        d[12]?.toFixed?.(2),
        d[13]?.toFixed?.(2),
        d[14]?.toFixed?.(2)
    ].join('|');
}

function worldTransformFingerprint(m: Mat4): string {
    const d = m.data as Float32Array | number[];
    // 平移 + 对角尺度（gsplat 实体通常刚体/均匀缩）
    return `${d[12]?.toFixed?.(3)}|${d[13]?.toFixed?.(3)}|${d[14]?.toFixed?.(3)}|${d[0]?.toFixed?.(3)}|${d[5]?.toFixed?.(3)}|${d[10]?.toFixed?.(3)}`;
}

function ensureWorldBoundsCache(inst: OctreeInstanceOofPatched, worldTransform: Mat4): Float32Array | null {
    const octree = inst.octree;
    const local = octree?.nodeBoundsMinMax;
    const n = octree?.nodes?.length ?? 0;
    if (!local || n <= 0) {
        return null;
    }
    const fp = worldTransformFingerprint(worldTransform);
    if (inst.__oofWorldBounds && inst.__oofWorldBounds.length >= n * 6 && inst.__oofWorldBoundsFp === fp) {
        return inst.__oofWorldBounds;
    }
    const out = inst.__oofWorldBounds && inst.__oofWorldBounds.length >= n * 6
        ? inst.__oofWorldBounds
        : new Float32Array(n * 6);
    const count = Math.min(n, Math.floor(local.length / 6));
    for (let i = 0; i < count; i++) {
        const b = i * 6;
        _worldMin.set(local[b], local[b + 1], local[b + 2]);
        _worldMax.set(local[b + 3], local[b + 4], local[b + 5]);
        worldTransform.transformPoint(_worldMin, _worldMin);
        worldTransform.transformPoint(_worldMax, _worldMax);
        out[b] = Math.min(_worldMin.x, _worldMax.x);
        out[b + 1] = Math.min(_worldMin.y, _worldMax.y);
        out[b + 2] = Math.min(_worldMin.z, _worldMax.z);
        out[b + 3] = Math.max(_worldMin.x, _worldMax.x);
        out[b + 4] = Math.max(_worldMin.y, _worldMax.y);
        out[b + 5] = Math.max(_worldMin.z, _worldMax.z);
    }
    inst.__oofWorldBounds = out;
    inst.__oofWorldBoundsFp = fp;
    return out;
}

function ensurePlaceableMask(inst: OctreeInstanceOofPatched): { bootstrapLod: number; placeable: Uint8Array } | null {
    const octree = inst.octree;
    const n = octree?.nodes?.length ?? 0;
    if (!n) {
        return null;
    }
    const bootstrapLod = getOctreeBootstrapLod(octree);
    if (bootstrapLod <= 0) {
        return null;
    }
    if (inst.__oofPlaceable && inst.__oofPlaceable.length === n && inst.__oofBootstrapLod === bootstrapLod) {
        return { bootstrapLod, placeable: inst.__oofPlaceable };
    }
    const placeable = inst.__oofPlaceable && inst.__oofPlaceable.length === n
        ? inst.__oofPlaceable
        : new Uint8Array(n);
    for (let i = 0; i < n; i++) {
        placeable[i] = isOctreeBootstrapPlaceableNode(octree.nodes[i], bootstrapLod) ? 1 : 0;
    }
    inst.__oofPlaceable = placeable;
    inst.__oofBootstrapLod = bootstrapLod;
    return { bootstrapLod, placeable };
}

function ensureInViewCache(inst: OctreeInstanceOofPatched, mats: OofCameraMats): Uint8Array | null {
    const octree = inst.octree;
    const n = octree?.nodes?.length ?? 0;
    if (!n) {
        return null;
    }
    const worldBounds = ensureWorldBoundsCache(inst, mats.worldTransform);
    if (!worldBounds) {
        return null;
    }
    const fp = mat4Fingerprint(mats.viewProj);
    if (inst.__oofInView && inst.__oofInView.length === n && inst.__oofInViewFp === fp) {
        return inst.__oofInView;
    }
    const flags = inst.__oofInView && inst.__oofInView.length === n
        ? inst.__oofInView
        : new Uint8Array(n);
    const count = Math.min(n, Math.floor(worldBounds.length / 6));
    for (let i = 0; i < count; i++) {
        const b = i * 6;
        flags[i] = aabbIntersectsFrustum(
            mats.frustum,
            worldBounds[b],
            worldBounds[b + 1],
            worldBounds[b + 2],
            worldBounds[b + 3],
            worldBounds[b + 4],
            worldBounds[b + 5]
        )
            ? 1
            : 0;
    }
    for (let i = count; i < n; i++) {
        flags[i] = 0;
    }
    inst.__oofInView = flags;
    inst.__oofInViewFp = fp;
    return flags;
}

/** 快速：还有多少 OOF 叶 current 细于 bootstrap（决定是否要跑换档） */
function countFineOutOfFrustumCurrents(
    inst: OctreeInstanceOofPatched,
    inView: Uint8Array,
    bootstrapLod: number
): number {
    const nodeInfos = inst.nodeInfos;
    const n = Math.min(nodeInfos.length, inView.length);
    let count = 0;
    for (let i = 0; i < n; i++) {
        if (inView[i]) {
            continue;
        }
        const cur = nodeInfos[i]?.currentLod ?? -1;
        if (cur >= 0 && cur < bootstrapLod) {
            count++;
        }
    }
    return count;
}

function viewPoseMoved(
    hold: LodViewHoldState,
    pos: Vec3,
    fwd: Vec3,
    fov: number
): boolean {
    const dx = pos.x - hold.posX;
    const dy = pos.y - hold.posY;
    const dz = pos.z - hold.posZ;
    if (dx * dx + dy * dy + dz * dz > VIEW_HOLD_POS_EPS_M * VIEW_HOLD_POS_EPS_M) {
        return true;
    }
    const dot = Math.min(1, Math.max(-1, fwd.x * hold.fwdX + fwd.y * hold.fwdY + fwd.z * hold.fwdZ));
    const angle = Math.acos(dot);
    if (angle > VIEW_HOLD_ANGLE_DEG * math.DEG_TO_RAD) {
        return true;
    }
    const fovBase = Math.max(1e-3, hold.fov);
    if (Math.abs(fov - hold.fov) > fovBase * VIEW_HOLD_FOV_REL) {
        return true;
    }
    return false;
}

function syncLodViewHoldState(inst: OctreeInstanceOofPatched, mats: OofCameraMats): boolean {
    let hold = inst.__lodViewHold;
    if (!hold || viewPoseMoved(hold, mats.cameraPos, mats.cameraFwd, mats.fov)) {
        hold = {
            posX: mats.cameraPos.x,
            posY: mats.cameraPos.y,
            posZ: mats.cameraPos.z,
            fwdX: mats.cameraFwd.x,
            fwdY: mats.cameraFwd.y,
            fwdZ: mats.cameraFwd.z,
            fov: mats.fov,
            framesStable: 0
        };
        inst.__lodViewHold = hold;
        inst.__lodHoldStickyInView = undefined;
        return false;
    }
    hold.framesStable++;
    return hold.framesStable >= 1;
}

function sumOptimalLodSplats(inst: OctreeInstanceOofPatched): number {
    const octree = inst.octree;
    const nodeInfos = inst.nodeInfos;
    if (!octree?.nodes?.length || !nodeInfos?.length) {
        return 0;
    }
    let total = 0;
    const n = Math.min(octree.nodes.length, nodeInfos.length);
    for (let i = 0; i < n; i++) {
        const lod = nodeInfos[i]?.optimalLod;
        if (typeof lod !== 'number' || lod < 0) {
            continue;
        }
        const c = octree.nodes[i]?.lods?.[lod]?.count;
        if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
            total += c;
        }
    }
    return total;
}

function lodCountAt(inst: OctreeInstanceOofPatched, nodeIndex: number, lod: number): number {
    const c = inst.octree?.nodes?.[nodeIndex]?.lods?.[lod]?.count;
    return typeof c === 'number' && Number.isFinite(c) && c > 0 ? c : 0;
}

/**
 * 同视角防抖：视锥内（sticky）叶若 optimal 比 current 更粗，钳回 current。
 * 只挡「变糊」；变清（optimal 更细）照常。
 * 若提供 maxOptimalSplats：仅在不突破预算时恢复细档（优先保近桶/中央）。
 */
export function holdStableViewInFrustumLods(
    inst: OctreeInstanceLike,
    mats: OofCameraMats,
    options?: { maxOptimalSplats?: number | null }
): number {
    if (!_lodViewHoldEnabled) {
        return 0;
    }
    const patched = inst as OctreeInstanceOofPatched;
    const nodeInfos = patched.nodeInfos;
    if (!nodeInfos?.length) {
        return 0;
    }
    const holdActive = syncLodViewHoldState(patched, mats);
    if (!holdActive) {
        return 0;
    }
    const inView = ensureInViewCache(patched, mats);
    if (!inView) {
        return 0;
    }
    const n = Math.min(nodeInfos.length, inView.length);
    let sticky = patched.__lodHoldStickyInView;
    if (!sticky || sticky.length !== n) {
        sticky = new Uint8Array(n);
        patched.__lodHoldStickyInView = sticky;
    }

    type Candidate = { nodeIndex: number; cur: number; bucket: number; delta: number };
    const candidates: Candidate[] = [];

    for (let i = 0; i < n; i++) {
        if (inView[i]) {
            sticky[i] = 1;
        }
        if (!sticky[i]) {
            continue;
        }
        const info = nodeInfos[i];
        if (!info) {
            continue;
        }
        const cur = info.currentLod;
        if (cur < 0 || info.optimalLod < 0) {
            continue;
        }
        // optimalLod 更大 = 更粗 → 钳回 current 会增加 Σopt
        if (info.optimalLod > cur) {
            const delta = lodCountAt(patched, i, cur) - lodCountAt(patched, i, info.optimalLod);
            candidates.push({
                nodeIndex: i,
                cur,
                bucket: info.budgetBucket ?? 0,
                delta: Number.isFinite(delta) ? delta : 0
            });
        }
    }

    if (candidates.length === 0) {
        return 0;
    }

    // 近桶优先 hold（中央清晰优先；超预算时边缘可被削）
    candidates.sort((a, b) => a.bucket - b.bucket || b.delta - a.delta);

    const maxOpt = options?.maxOptimalSplats;
    const enforceCap = typeof maxOpt === 'number' && Number.isFinite(maxOpt) && maxOpt > 0;
    let sumOpt = enforceCap ? sumOptimalLodSplats(patched) : 0;
    let held = 0;

    for (let i = 0; i < candidates.length; i++) {
        const { nodeIndex, cur, delta } = candidates[i];
        const info = nodeInfos[nodeIndex];
        if (!info || info.optimalLod <= cur) {
            continue;
        }
        if (enforceCap && sumOpt + delta > maxOpt) {
            continue;
        }
        info.optimalLod = cur;
        if (enforceCap) {
            sumOpt += delta;
        }
        held++;
    }
    return held;
}

/**
 * 预算侧：视锥外叶 optimal → bootstrap（不要求粗档已加载）。
 * Σoptimal 不含「看不见的细档」，balancer 才能把额度回填给视锥内。
 * sticky 视锥内叶跳过（与同视角 hold 一致）。
 * evaluate 返回值仍用钳制前总量（见 patch），避免 budgetScale→100。
 */
export function excludeOutOfFrustumFromBudget(
    inst: OctreeInstanceLike,
    mats: OofCameraMats
): OofDowngradeStats {
    const stats: OofDowngradeStats = { clamped: 0, pendingCoarse: 0, budgetExcluded: 0 };
    if (!_oofDowngradeEnabled) {
        return stats;
    }
    const patched = inst as OctreeInstanceOofPatched;
    const nodeInfos = patched.nodeInfos;
    if (!nodeInfos?.length) {
        return stats;
    }
    const mask = ensurePlaceableMask(patched);
    const inView = ensureInViewCache(patched, mats);
    if (!mask || !inView) {
        return stats;
    }
    const { bootstrapLod, placeable } = mask;
    const sticky = _lodViewHoldEnabled ? patched.__lodHoldStickyInView : undefined;
    const n = Math.min(nodeInfos.length, inView.length, placeable.length);
    for (let i = 0; i < n; i++) {
        if (inView[i] || !placeable[i]) {
            continue;
        }
        if (sticky?.[i]) {
            continue;
        }
        const info = nodeInfos[i];
        if (!info || info.optimalLod < 0) {
            continue;
        }
        if (info.optimalLod !== bootstrapLod) {
            info.optimalLod = bootstrapLod;
            stats.budgetExcluded++;
            stats.clamped++;
        }
        info.budgetBucket = OOF_BUDGET_BUCKET_FAR;
    }
    return stats;
}

/**
 * 换档侧：current 仍细的 OOF → bootstrap（吐 WB）。
 */
export function clampOutOfFrustumOptimalLods(
    inst: OctreeInstanceLike,
    mats: OofCameraMats,
    options?: { maxNodes?: number | null; ensureCoarse?: boolean }
): OofDowngradeStats {
    const stats: OofDowngradeStats = { clamped: 0, pendingCoarse: 0, budgetExcluded: 0 };
    if (!_oofDowngradeEnabled) {
        return stats;
    }
    const patched = inst as OctreeInstanceOofPatched;
    const octree = patched.octree;
    const nodeInfos = patched.nodeInfos;
    if (!octree?.nodes?.length || !nodeInfos?.length) {
        return stats;
    }

    const mask = ensurePlaceableMask(patched);
    const inView = ensureInViewCache(patched, mats);
    if (!mask || !inView) {
        return stats;
    }
    const { bootstrapLod, placeable } = mask;

    // 快路径：没有细档 OOF current → 整段跳过
    if (countFineOutOfFrustumCurrents(patched, inView, bootstrapLod) === 0) {
        return stats;
    }

    const maxNodes = options?.maxNodes ?? null;
    const ensureCoarse = options?.ensureCoarse !== false;
    const n = Math.min(octree.nodes.length, nodeInfos.length, inView.length);

    type Candidate = { nodeIndex: number; count: number };
    const candidates: Candidate[] = [];

    for (let nodeIndex = 0; nodeIndex < n; nodeIndex++) {
        if (inView[nodeIndex] || !placeable[nodeIndex]) {
            continue;
        }
        // sticky 视锥内：同视角下刚出界的叶仍当可见，不强制 OOF 降档（防边缘闪糊）
        if (_lodViewHoldEnabled && patched.__lodHoldStickyInView?.[nodeIndex]) {
            continue;
        }
        const info = nodeInfos[nodeIndex];
        const currentLod = info?.currentLod ?? -1;
        if (currentLod < 0 || currentLod >= bootstrapLod) {
            continue;
        }
        const count = octree.nodes[nodeIndex].lods[currentLod]?.count ?? 0;
        candidates.push({ nodeIndex, count: Number.isFinite(count) ? count : 0 });
    }

    if (candidates.length === 0) {
        return stats;
    }

    if (maxNodes != null && maxNodes > 0 && candidates.length > maxNodes) {
        candidates.sort((a, b) => b.count - a.count);
        candidates.length = maxNodes;
    }

    for (let i = 0; i < candidates.length; i++) {
        const nodeIndex = candidates[i].nodeIndex;
        const info = nodeInfos[nodeIndex];
        const fi = octree.nodes[nodeIndex].lods[bootstrapLod]?.fileIndex ?? -1;
        if (fi < 0) {
            continue;
        }
        if (octree.getFileResource(fi)) {
            info.optimalLod = bootstrapLod;
            info.budgetBucket = OOF_BUDGET_BUCKET_FAR;
            stats.clamped++;
        } else if (ensureCoarse) {
            octree.ensureFileResource(fi);
            stats.pendingCoarse++;
        }
    }

    return stats;
}

export const forceOutOfFrustumOptimalToBootstrap = clampOutOfFrustumOptimalLods;

export function buildOofCameraMats(cameraEntity: Entity, gsplatEntity: Entity): OofCameraMats | null {
    const camera = cameraEntity.camera;
    if (!camera?.projectionMatrix || !camera?.viewMatrix) {
        return null;
    }
    _viewProj.mul2(camera.projectionMatrix, camera.viewMatrix);
    _frustum.setFromMat4(_viewProj);
    const pos = cameraEntity.getPosition();
    const fwd = cameraEntity.forward;
    _camPos.copy(pos);
    _camFwd.copy(fwd);
    return {
        viewProj: _viewProj,
        frustum: _frustum,
        worldTransform: gsplatEntity.getWorldTransform(),
        cameraPos: _camPos,
        cameraFwd: _camFwd,
        fov: camera.fov ?? 0
    };
}

export function ensureOutOfFrustumEvaluateOptimalPatch(
    inst: OctreeInstanceLike | null,
    getCamera: () => OofCameraMats | null
): void {
    const patched = inst as OctreeInstanceOofPatched | null;
    if (!patched?.evaluateOptimalLods || patched.__oofEvalOptimalPatched) {
        return;
    }
    patched.__originalEvaluateOptimalLods = patched.evaluateOptimalLods.bind(patched);
    patched.evaluateOptimalLods = (...args: unknown[]) => {
        const totalBefore = patched.__originalEvaluateOptimalLods?.(...args) ?? 0;
        if (!_oofDowngradeEnabled) {
            return totalBefore;
        }
        const mats = getCamera();
        if (mats && patched.nodeInfos?.length) {
            const ex = excludeOutOfFrustumFromBudget(patched, mats);
            patched.__oofLastStats = {
                clamped: ex.clamped,
                pendingCoarse: 0,
                budgetExcluded: ex.budgetExcluded
            };
        }
        // 钳制前总量：避免 OOF→bootstrap 后系统性 underfill 把 budgetScale 拉爆
        return totalBefore;
    };
    patched.__oofEvalOptimalPatched = true;
}

export function ensureOutOfFrustumApplyPatch(
    inst: OctreeInstanceLike | null,
    getCamera: () => OofCameraMats | null
): void {
    const patched = inst as OctreeInstanceOofPatched | null;
    if (!patched?.applyLodChanges || patched.__oofApplyPatched) {
        return;
    }
    patched.__originalApplyLodChanges = patched.applyLodChanges.bind(patched);
    patched.__oofDripLimit = null;
    patched.applyLodChanges = (maxLod: number, params: unknown) => {
        const mats = getCamera();
        let budgetExcluded = 0;
        let clamped = 0;
        let pendingCoarse = 0;
        let held = 0;
        if (mats && patched.nodeInfos?.length) {
            const splatBudget = (params as { splatBudget?: number } | null)?.splatBudget;
            // 同视角：先挡住视锥内变糊（不突破 budget），再处理 OOF
            held = holdStableViewInFrustumLods(patched, mats, {
                maxOptimalSplats: splatBudget
            });
            if (_oofDowngradeEnabled) {
                budgetExcluded = excludeOutOfFrustumFromBudget(patched, mats).budgetExcluded;
                const limit = patched.__oofDripLimit;
                const cur = clampOutOfFrustumOptimalLods(patched, mats, {
                    maxNodes: limit == null ? null : limit,
                    ensureCoarse: true
                });
                clamped = cur.clamped;
                pendingCoarse = cur.pendingCoarse;
            }
        }
        patched.__oofLastStats = { clamped, pendingCoarse, budgetExcluded, held };
        return patched.__originalApplyLodChanges?.(maxLod, params);
    };
    patched.__oofApplyPatched = true;
}

export function ensureOutOfFrustumEvaluatePatch(
    inst: OctreeInstanceLike | null,
    getCamera: () => OofCameraMats | null
): void {
    ensureOutOfFrustumEvaluateOptimalPatch(inst, getCamera);
}

export function ensureOutOfFrustumDowngradePatches(
    inst: OctreeInstanceLike | null,
    getCamera: () => OofCameraMats | null
): void {
    ensureOutOfFrustumEvaluateOptimalPatch(inst, getCamera);
    ensureOutOfFrustumApplyPatch(inst, getCamera);
}

/** 别名：apply 稳定器（OOF + 同视角 hold） */
export const ensureLodStabilizerPatches = ensureOutOfFrustumDowngradePatches;

export function dripOutOfFrustumDowngrade(
    app: AppBase,
    octree: unknown,
    gsplatEntity: Entity,
    cameraEntity: Entity,
    gsplatParams: unknown,
    options?: { maxNodes?: number; force?: boolean }
): OofDowngradeStats {
    const empty: OofDowngradeStats = { clamped: 0, pendingCoarse: 0, budgetExcluded: 0, held: 0 };
    if (!_oofDowngradeEnabled) {
        return empty;
    }
    _idleDripTickCounter++;
    if (!options?.force && _idleDripTickCounter % IDLE_DRIP_TICK_INTERVAL !== 0) {
        return empty;
    }

    const mats = buildOofCameraMats(cameraEntity, gsplatEntity);
    if (!mats) {
        return empty;
    }

    const getMats = () => mats;
    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
    const maxNodes = options?.maxNodes ?? DEFAULT_IDLE_DRIP_LIMIT;
    let clamped = 0;
    let pendingCoarse = 0;
    let budgetExcluded = 0;
    let held = 0;
    let anyApply = false;

    for (let i = 0; i < instances.length; i++) {
        const inst = instances[i] as OctreeInstanceOofPatched;
        ensureOutOfFrustumDowngradePatches(inst, getMats);
        if (typeof inst.applyLodChanges !== 'function' || !inst.__originalApplyLodChanges) {
            continue;
        }
        const inView = ensureInViewCache(inst, mats);
        const mask = ensurePlaceableMask(inst);
        if (inView && mask && countFineOutOfFrustumCurrents(inst, inView, mask.bootstrapLod) === 0) {
            continue;
        }
        held += holdStableViewInFrustumLods(inst, mats, {
            maxOptimalSplats: (gsplatParams as { splatBudget?: number } | null)?.splatBudget
        });
        budgetExcluded += excludeOutOfFrustumFromBudget(inst, mats).budgetExcluded;
        const pre = clampOutOfFrustumOptimalLods(inst, mats, { maxNodes, ensureCoarse: true });
        pendingCoarse += pre.pendingCoarse;
        if (pre.clamped <= 0) {
            continue;
        }
        const host = inst.octree as OctreeHost;
        const maxLod = Math.max(0, (host?.lodLevels ?? 1) - 1);
        inst.__originalApplyLodChanges(maxLod, gsplatParams);
        clamped += pre.clamped;
        anyApply = true;
        inst.__oofLastStats = {
            clamped: pre.clamped,
            pendingCoarse: pre.pendingCoarse,
            budgetExcluded,
            held
        };
    }

    if (anyApply) {
        requestOctreePlacementUpdate(app, octree);
    }

    return { clamped, pendingCoarse, budgetExcluded, held };
}
