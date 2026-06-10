import {
    Entity,
    Frustum,
    Mat4,
    Vec3,
    Vec4,
    math,
    platform,
    type AppBase,
    type GSplatComponent
} from 'playcanvas';

import type { Global } from '../types';

const REF_TAN_HALF_FOV = Math.tan(22.5 * math.DEG_TO_RAD);

const DEFAULT_MAX_CONCURRENT = 2;

const BOOST_MAX_CONCURRENT = platform.mobile ? 4 : 8;
// 非 0 可抑制视锥边缘 node 因微动触发的 LOD 来回切换（0 时每帧重算）
const BOOST_LOD_UPDATE_DISTANCE = platform.mobile ? 0.2 : 0.35;
// refinement 阶段放宽 budget 但不设 0（0=无上限，细层全上会撑爆 CPU sort 内存）
const REFINEMENT_SPLAT_BUDGET = platform.mobile ? 3_000_000 : 8_000_000;
// 下载完成后继续推动渲染/work-buffer 重建的帧数
const POST_DOWNLOAD_SETTLE_FRAMES = 30;
// 每个 chunk 落地后短促推动上屏
const PER_FILE_SETTLE_FRAMES = 12;
// refinement 阶段按 score 排序的下载 gate 上限（始终单队列，不再等 critical 下完）
const FOREGROUND_DOWNLOAD_LIMIT = platform.mobile ? 32 : 64;
// score Top N，用于 criticalPendingUnique 统计与 debug；pin 保活仅 Top PIN_FILE_LIMIT
const CRITICAL_DOWNLOAD_LIMIT = platform.mobile ? 4 : 8;
const PIN_FILE_LIMIT = platform.mobile ? 6 : 12;
// refinement 期间启用 underfill（方案 A）：在 [optimal, optimal+limit] 内显示已加载的最细档
const REFINEMENT_LOD_UNDERFILL_LIMIT = platform.mobile ? 2 : 3;
// 屏幕 NDC 边缘：内侧全权重，外侧跳过 refinement 下载，中间带放宽一档 optimal
const VIEWPORT_EDGE_NDC_INNER = 0.62;
const VIEWPORT_EDGE_NDC_OUTER = 0.9;
const VIEWPORT_EDGE_RELAX_OPTIMAL = 0.35;

type OctreeLod = {
    fileIndex: number;
    count: number;
};

type OctreeNode = {
    lods: OctreeLod[];
};

type OctreeAssetLoaderLike = {
    maxConcurrentLoads: number;
    _loadQueue?: string[];
    _currentlyLoading?: Set<string>;
    load: (url: string) => void;
    unload?: (url: string) => void;
    _processQueue?: () => void;
    __refinementLoadPatched?: boolean;
    __refinementSuspendedQueue?: string[];
    __refinementGateActive?: boolean;
    __refinementPriorityUrls?: Set<string>;
};

type OctreeLike = {
    nodes: OctreeNode[];
    nodeBoundsMinMax: Float32Array;
    lodLevels: number;
    files: Array<{ url: string }>;
    ensureFileResource: (fileIndex: number) => void;
    getFileResource: (fileIndex: number) => unknown;
    incRefCount?: (fileIndex: number) => void;
    assetLoader?: OctreeAssetLoaderLike | null;
    __refinementEnsurePatched?: boolean;
    __originalEnsureFileResource?: (fileIndex: number) => void;
    __refinementPriorityUrls?: Set<string>;
};

export type { OctreeLike };

type OctreeInstanceLike = {
    octree: OctreeLike;
    nodeInfos: Array<{ currentLod: number; optimalLod: number }>;
    needsLodUpdate?: boolean;
    update?: () => boolean;
};

type GsplatSceneLike = {
    lodRangeMin: number;
    lodRangeMax: number;
    lodBehindPenalty: number;
    lodUpdateDistance: number;
    lodUpdateAngle: number;
    lodUnderfillLimit: number;
    splatBudget: number;
    dirty: boolean;
};

type OctreeResourceLike = {
    octree?: OctreeLike | null;
};

type PrioritizedFile = {
    fileIndex: number;
    score: number;
};

type PrioritizedBatch = {
    files: PrioritizedFile[];
    /** 去重后的缺失 optimal 文件数（真实下载量） */
    pendingUniqueFiles: number;
    /** 高优先级（视野中心）仍缺的 unique 文件数 */
    foregroundPendingUnique: number;
    /** 核心区域（Top N）仍缺的 unique 文件数 */
    criticalPendingUnique: number;
    /** 文件已下完但仍在显示粗层的 node 数 */
    staleLoadedNodes: number;
    /** 引擎 currentLod 与 budget 后 optimalLod 不一致的 node 数（抖动诊断） */
    lodDisplayMismatch: number;
    needsLodSwitch: boolean;
    staleLodNodes: number;
};

type LodPlacementParams = {
    lodBaseDistance: number;
    lodMultiplier: number;
};

const _invWorldMat = new Mat4();
const _localCameraPos = new Vec3();
const _localCameraFwd = new Vec3();
const _worldMin = new Vec3();
const _worldMax = new Vec3();
const _worldCenter = new Vec3();
const _viewProj = new Mat4();
const _frustum = new Frustum();
const _clipPos = new Vec4();

function getRefinementDebugLevel(): number {
    try {
        const value = new URLSearchParams(window.location.search).get('debugOctreeRefinement');
        if (value === '2') {
            return 2;
        }
        if (value === '1') {
            return 1;
        }
    } catch {
        // ignore
    }
    return 0;
}

function isRefinementDebugEnabled(): boolean {
    return getRefinementDebugLevel() >= 1;
}

function patchEnsureFileResourceGate(octree: OctreeLike) {
    if (octree.__refinementEnsurePatched) {
        return;
    }
    const original = octree.ensureFileResource.bind(octree);
    octree.__originalEnsureFileResource = original;
    octree.ensureFileResource = (fileIndex: number) => {
        const allowed = octree.__refinementPriorityUrls;
        if (allowed && allowed.size > 0) {
            const url = octree.files[fileIndex]?.url;
            if (!url || !allowed.has(url)) {
                return;
            }
        }
        original(fileIndex);
    };
    octree.__refinementEnsurePatched = true;
}

function setRefinementPriorityUrls(octree: OctreeLike, loader: OctreeAssetLoaderLike | null | undefined, urls: string[]) {
    const set = new Set(urls);
    octree.__refinementPriorityUrls = set;
    if (loader) {
        loader.__refinementPriorityUrls = set;
        loader.__refinementGateActive = true;
    }
}

function clearRefinementPriorityUrls(octree: OctreeLike, loader: OctreeAssetLoaderLike | null | undefined) {
    octree.__refinementPriorityUrls = undefined;
    if (loader) {
        loader.__refinementPriorityUrls = undefined;
        loader.__refinementGateActive = false;
    }
}

function patchAssetLoaderPriority(loader: OctreeAssetLoaderLike) {
    if (loader.__refinementLoadPatched) {
        return;
    }
    if (!loader.__refinementSuspendedQueue) {
        loader.__refinementSuspendedQueue = [];
    }
    const originalLoad = loader.load.bind(loader);
    loader.load = (url: string) => {
        const gateActive = loader.__refinementGateActive;
        const prioritySet = loader.__refinementPriorityUrls;
        if (gateActive && prioritySet && prioritySet.size > 0 && !prioritySet.has(url)) {
            const suspended = loader.__refinementSuspendedQueue ?? [];
            if (!suspended.includes(url)) {
                suspended.push(url);
            }
            loader.__refinementSuspendedQueue = suspended;
            return;
        }

        const queue = loader._loadQueue;
        if (queue?.includes(url)) {
            const idx = queue.indexOf(url);
            if (idx > 0) {
                queue.splice(idx, 1);
                queue.unshift(url);
            }
            return;
        }
        originalLoad(url);
        if (queue && queue[queue.length - 1] === url) {
            queue.pop();
            queue.unshift(url);
        }
    };
    loader.__refinementLoadPatched = true;
}

function expandDownloadGateUrls(
    loader: OctreeAssetLoaderLike | null | undefined,
    priorityUrls: string[]
): string[] {
    if (!loader) {
        return priorityUrls;
    }
    const expanded = new Set(priorityUrls);
    loader._currentlyLoading?.forEach((url) => expanded.add(url));
    return [...expanded];
}

function reconcileLoaderQueue(loader: OctreeAssetLoaderLike, priorityUrls: string[]) {
    const queue = loader._loadQueue ?? [];
    loader._loadQueue = queue;
    const suspended = loader.__refinementSuspendedQueue ?? [];
    const inFlight = loader._currentlyLoading ?? new Set<string>();
    const prioritySet = new Set(priorityUrls);
    const order = new Map(priorityUrls.map((url, index) => [url, index]));

    const isActive = (url: string) => prioritySet.has(url) || inFlight.has(url);

    const nextSuspended: string[] = [];
    const addSuspended = (url: string) => {
        if (!isActive(url) && !nextSuspended.includes(url)) {
            nextSuspended.push(url);
        }
    };

    const priorityInQueue: string[] = [];
    const addQueue = (url: string) => {
        if (isActive(url) && !inFlight.has(url) && !priorityInQueue.includes(url)) {
            priorityInQueue.push(url);
        }
    };

    for (let i = 0; i < suspended.length; i++) {
        const url = suspended[i];
        if (isActive(url)) {
            addQueue(url);
        } else {
            addSuspended(url);
        }
    }

    for (let i = 0; i < queue.length; i++) {
        const url = queue[i];
        if (isActive(url)) {
            addQueue(url);
        } else {
            addSuspended(url);
        }
    }

    for (let i = 0; i < priorityUrls.length; i++) {
        addQueue(priorityUrls[i]);
    }

    priorityInQueue.sort((a, b) => (order.get(a) ?? 9999) - (order.get(b) ?? 9999));
    queue.length = 0;
    queue.push(...priorityInQueue);
    loader.__refinementSuspendedQueue = nextSuspended;
    loader._processQueue?.();
}

function updateTrackedMissingFiles(
    tracked: Map<number, number>,
    files: PrioritizedFile[],
    octree: OctreeLike
): void {
    for (let i = 0; i < files.length; i++) {
        const entry = files[i];
        if (octree.getFileResource(entry.fileIndex)) {
            continue;
        }
        const prev = tracked.get(entry.fileIndex);
        if (prev === undefined || entry.score > prev) {
            tracked.set(entry.fileIndex, entry.score);
        }
    }
    for (const fi of tracked.keys()) {
        if (octree.getFileResource(fi)) {
            tracked.delete(fi);
        }
    }
}

function buildBatchFromTracked(tracked: Map<number, number>, limit: number): PrioritizedFile[] {
    const batch: PrioritizedFile[] = [];
    for (const [fileIndex, score] of tracked) {
        batch.push({ fileIndex, score });
    }
    batch.sort((a, b) => b.score - a.score);
    return batch.slice(0, limit);
}

function restoreSuspendedQueuedLoads(loader: OctreeAssetLoaderLike) {
    const suspended = loader.__refinementSuspendedQueue;
    if (!suspended?.length) {
        return;
    }
    const queue = loader._loadQueue ?? [];
    for (const url of suspended) {
        if (!queue.includes(url)) {
            queue.push(url);
        }
    }
    loader._loadQueue = queue;
    loader.__refinementSuspendedQueue = [];
    loader._processQueue?.();
}

function prioritizeFileLoad(octree: OctreeLike, fileIndex: number): string | null {
    if (fileIndex < 0 || octree.getFileResource(fileIndex)) {
        return null;
    }
    const url = octree.files[fileIndex]?.url;
    if (!url) {
        return null;
    }
    const loader = octree.assetLoader;
    if (loader) {
        patchAssetLoaderPriority(loader);
    }
    const ensure = octree.__originalEnsureFileResource ?? octree.ensureFileResource.bind(octree);
    ensure(fileIndex);
    if (loader) {
        const queue = loader._loadQueue;
        if (queue?.includes(url)) {
            const idx = queue.indexOf(url);
            if (idx > 0) {
                queue.splice(idx, 1);
                queue.unshift(url);
            }
        }
        loader._processQueue?.();
    }
    return url;
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

function computeOptimalLodIndex(
    localDistance: number,
    maxLod: number,
    lodBaseDistance: number,
    lodMultiplier: number,
    rangeMin: number,
    rangeMax: number,
    minDistBuf: Float32Array | null
): number {
    let optimalLodIndex: number;
    if (maxLod === 0 || localDistance < lodBaseDistance) {
        optimalLodIndex = 0;
    } else if (!minDistBuf) {
        optimalLodIndex = maxLod;
    } else {
        optimalLodIndex = maxLod;
        while (optimalLodIndex > 1 && localDistance < minDistBuf[optimalLodIndex]) {
            optimalLodIndex--;
        }
    }
    if (optimalLodIndex < rangeMin) optimalLodIndex = rangeMin;
    if (optimalLodIndex > rangeMax) optimalLodIndex = rangeMax;
    return optimalLodIndex;
}

function ensureLodMinDistThresholds(maxLod: number, d0: number, m: number): Float32Array {
    const buf = new Float32Array(maxLod + 1);
    let t = d0;
    buf[1] = t;
    for (let k = 2; k <= maxLod; k++) {
        t *= m;
        buf[k] = t;
    }
    return buf;
}

function findAllOctreeInstances(
    app: AppBase,
    octree: OctreeLike,
    gsplatEntity?: Entity
): OctreeInstanceLike[] {
    const found: OctreeInstanceLike[] = [];
    const seen = new Set<OctreeInstanceLike>();

    const director = (app.renderer as unknown as { gsplatDirector?: {
        camerasMap: Map<unknown, {
            layersMap: Map<unknown, { gsplatManager?: { octreeInstances?: Map<unknown, OctreeInstanceLike> } | null }>;
        }>;
    } }).gsplatDirector;

    const addInstance = (inst: OctreeInstanceLike | undefined | null) => {
        if (!inst || inst.octree !== octree || seen.has(inst)) {
            return;
        }
        seen.add(inst);
        found.push(inst);
    };

    if (director) {
        for (const cameraData of director.camerasMap.values()) {
            for (const layerData of cameraData.layersMap.values()) {
                const instances = layerData.gsplatManager?.octreeInstances;
                if (!instances) {
                    continue;
                }
                for (const inst of instances.values()) {
                    addInstance(inst);
                }
            }
        }
    }

    // 兜底：通过 entity placement 反查 instance（director 遍历未命中时）
    if (!found.length && gsplatEntity && director) {
        const placement = (gsplatEntity.gsplat as unknown as { _placement?: unknown } | null)?._placement;
        if (placement) {
            for (const cameraData of director.camerasMap.values()) {
                for (const layerData of cameraData.layersMap.values()) {
                    addInstance(layerData.gsplatManager?.octreeInstances?.get(placement));
                }
            }
        }
    }

    return found;
}

function syncOctreePendingPlacements(
    app: AppBase,
    octree: OctreeLike,
    gsplatEntity: Entity,
    gsplatScene: GsplatSceneLike,
    markSceneDirty = false
) {
    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
    for (let i = 0; i < instances.length; i++) {
        const inst = instances[i];
        try {
            inst.update?.();
        } catch (err) {
            console.warn('[octree-refinement] sync update failed', err);
        }
        inst.needsLodUpdate = true;
    }

    if (markSceneDirty) {
        gsplatScene.dirty = true;
    }
    app.renderNextFrame = true;
    return instances.length;
}

function markOctreeInstancesDirty(app: AppBase, octree: OctreeLike, gsplatEntity?: Entity) {
    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
    for (let i = 0; i < instances.length; i++) {
        instances[i].needsLodUpdate = true;
    }
}

function scoreVisibleNode(
    frustum: Frustum,
    worldTransform: Mat4,
    boundsFlat: Float32Array,
    nodeIndex: number,
    localDistance: number,
    optimalLod: number,
    maxLod: number,
    cameraPos: Vec3,
    cameraFwd: Vec3
): number {
    const b = nodeIndex * 6;
    _worldMin.set(boundsFlat[b], boundsFlat[b + 1], boundsFlat[b + 2]);
    _worldMax.set(boundsFlat[b + 3], boundsFlat[b + 4], boundsFlat[b + 5]);
    worldTransform.transformPoint(_worldMin, _worldMin);
    worldTransform.transformPoint(_worldMax, _worldMax);

    const minX = Math.min(_worldMin.x, _worldMax.x);
    const minY = Math.min(_worldMin.y, _worldMax.y);
    const minZ = Math.min(_worldMin.z, _worldMax.z);
    const maxX = Math.max(_worldMin.x, _worldMax.x);
    const maxY = Math.max(_worldMin.y, _worldMax.y);
    const maxZ = Math.max(_worldMin.z, _worldMax.z);

    if (!aabbIntersectsFrustum(frustum, minX, minY, minZ, maxX, maxY, maxZ)) {
        return 0;
    }

    _worldCenter.set(
        (minX + maxX) * 0.5,
        (minY + maxY) * 0.5,
        (minZ + maxZ) * 0.5
    );
    const dx = _worldCenter.x - cameraPos.x;
    const dy = _worldCenter.y - cameraPos.y;
    const dz = _worldCenter.z - cameraPos.z;
    const worldDistance = Math.sqrt(dx * dx + dy * dy + dz * dz) || 0.001;
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);

    const toCenter = _worldCenter.x * cameraFwd.x + _worldCenter.y * cameraFwd.y + _worldCenter.z * cameraFwd.z;
    const centerBias = toCenter > 0 ? 1.2 : 0.6;

    const screenSize = extent / worldDistance;
    // 越需要细档（optimalLod 越小）优先级越高
    let lodUrgency = 1 + (maxLod - optimalLod) * 0.5;
    if (optimalLod === 0) {
        lodUrgency *= 1.25;
    }
    return screenSize * lodUrgency * centerBias / (1 + localDistance * 0.02);
}

/** 1=屏幕中心，0=视口边缘外缘；用于抑制边缘 chunk 的 refinement 激进度 */
function computeViewportEdgeFactor(viewProj: Mat4, worldCenter: Vec3): number {
    _clipPos.set(worldCenter.x, worldCenter.y, worldCenter.z, 1);
    viewProj.transformVec4(_clipPos, _clipPos);
    if (_clipPos.w <= 0.001) {
        return 0;
    }
    const invW = 1 / _clipPos.w;
    const ndcExtent = Math.max(Math.abs(_clipPos.x * invW), Math.abs(_clipPos.y * invW));
    if (ndcExtent <= VIEWPORT_EDGE_NDC_INNER) {
        return 1;
    }
    if (ndcExtent >= VIEWPORT_EDGE_NDC_OUTER) {
        return 0;
    }
    return 1 - (ndcExtent - VIEWPORT_EDGE_NDC_INNER) / (VIEWPORT_EDGE_NDC_OUTER - VIEWPORT_EDGE_NDC_INNER);
}

function dedupeByFileIndex(files: PrioritizedFile[]): PrioritizedFile[] {
    const best = new Map<number, PrioritizedFile>();
    for (let i = 0; i < files.length; i++) {
        const entry = files[i];
        const prev = best.get(entry.fileIndex);
        if (!prev || entry.score > prev.score) {
            best.set(entry.fileIndex, entry);
        }
    }
    const out = [...best.values()];
    out.sort((a, b) => b.score - a.score);
    return out;
}

function countMissingUniqueFiles(octree: OctreeLike, files: PrioritizedFile[]): number {
    let count = 0;
    for (let i = 0; i < files.length; i++) {
        if (!octree.getFileResource(files[i].fileIndex)) {
            count++;
        }
    }
    return count;
}

export const STREAMING_VIEWPORT_READY_RATIO = 1;

export type StreamingViewportBootstrapOptions = {
    /** 视口边缘仅擦到 AABB 的 node 不参与统计，避免 80% 来自边缘、中心仍有洞 */
    excludeViewportEdgeNodes?: boolean;
};

export type StreamingViewportBootstrapStatus = {
    visibleNodes: number;
    unplacedVisibleNodes: number;
    placedVisibleNodes: number;
    /** 视锥内已上屏 node 占比 [0,1] */
    placementRatio: number;
    ready: boolean;
};

/** streaming 首屏：视锥内足够比例 node 已至少显示一档（粗层即可） */
export function getStreamingViewportBootstrapStatus(
    app: AppBase,
    octree: OctreeLike,
    gsplatEntity: Entity,
    cameraEntity: Entity,
    readyRatio = STREAMING_VIEWPORT_READY_RATIO,
    options?: StreamingViewportBootstrapOptions
): StreamingViewportBootstrapStatus {
    const camera = cameraEntity.camera;
    if (!camera || !octree.nodes.length) {
        return {
            visibleNodes: 0,
            unplacedVisibleNodes: 0,
            placedVisibleNodes: 0,
            placementRatio: 1,
            ready: true
        };
    }

    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
    const nodeInfos = instances[0]?.nodeInfos;
    if (!nodeInfos) {
        return {
            visibleNodes: 0,
            unplacedVisibleNodes: 0,
            placedVisibleNodes: 0,
            placementRatio: 0,
            ready: false
        };
    }

    _viewProj.mul2(camera.projectionMatrix, camera.viewMatrix);
    _frustum.setFromMat4(_viewProj);
    const worldTransform = gsplatEntity.getWorldTransform();
    const boundsFlat = octree.nodeBoundsMinMax;

    let visibleNodes = 0;
    let unplacedVisibleNodes = 0;
    const excludeEdge = options?.excludeViewportEdgeNodes !== false;

    for (let nodeIndex = 0; nodeIndex < octree.nodes.length; nodeIndex++) {
        const b = nodeIndex * 6;
        _worldMin.set(boundsFlat[b], boundsFlat[b + 1], boundsFlat[b + 2]);
        _worldMax.set(boundsFlat[b + 3], boundsFlat[b + 4], boundsFlat[b + 5]);
        worldTransform.transformPoint(_worldMin, _worldMin);
        worldTransform.transformPoint(_worldMax, _worldMax);

        const minX = Math.min(_worldMin.x, _worldMax.x);
        const minY = Math.min(_worldMin.y, _worldMax.y);
        const minZ = Math.min(_worldMin.z, _worldMax.z);
        const maxX = Math.max(_worldMin.x, _worldMax.x);
        const maxY = Math.max(_worldMin.y, _worldMax.y);
        const maxZ = Math.max(_worldMin.z, _worldMax.z);

        if (!aabbIntersectsFrustum(_frustum, minX, minY, minZ, maxX, maxY, maxZ)) {
            continue;
        }

        if (excludeEdge) {
            _worldCenter.set(
                (minX + maxX) * 0.5,
                (minY + maxY) * 0.5,
                (minZ + maxZ) * 0.5
            );
            if (computeViewportEdgeFactor(_viewProj, _worldCenter) <= 0) {
                continue;
            }
        }

        visibleNodes++;
        const currentLod = nodeInfos[nodeIndex]?.currentLod ?? -1;
        if (currentLod < 0) {
            unplacedVisibleNodes++;
        }
    }

    const placedVisibleNodes = visibleNodes - unplacedVisibleNodes;
    const placementRatio = visibleNodes > 0 ? placedVisibleNodes / visibleNodes : 0;

    return {
        visibleNodes,
        unplacedVisibleNodes,
        placedVisibleNodes,
        placementRatio,
        ready:
            visibleNodes > 0 &&
            unplacedVisibleNodes === 0 &&
            placementRatio >= readyRatio
    };
}

export function syncStreamingOctreePlacements(
    app: AppBase,
    octree: OctreeLike,
    gsplatEntity: Entity
): number {
    const gsplatScene = app.scene.gsplat as GsplatSceneLike;
    return syncOctreePendingPlacements(app, octree, gsplatEntity, gsplatScene, true);
}

function buildPriorityFiles(
    app: AppBase,
    octree: OctreeLike,
    gsplatEntity: Entity,
    cameraEntity: Entity,
    gsplat: GsplatSceneLike,
    lodParams: LodPlacementParams
): PrioritizedBatch {
    const maxLod = octree.lodLevels - 1;
    const camera = cameraEntity.camera;
    if (!camera || maxLod < 0) {
        return {
            files: [],
            pendingUniqueFiles: 0,
            foregroundPendingUnique: 0,
            criticalPendingUnique: 0,
            staleLoadedNodes: 0,
            lodDisplayMismatch: 0,
            needsLodSwitch: false,
            staleLodNodes: 0
        };
    }

    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
    const inst = instances[0] ?? null;
    const nodeInfos = inst?.nodeInfos;

    let tanHalfVFov = Math.tan(camera.fov * 0.5 * math.DEG_TO_RAD);
    if (camera.horizontalFov) {
        tanHalfVFov /= camera.aspectRatio;
    }
    const tanHalfHFov = tanHalfVFov * camera.aspectRatio;
    const fovScale = Math.min(tanHalfVFov, tanHalfHFov) / REF_TAN_HALF_FOV;

    const worldTransform = gsplatEntity.getWorldTransform();
    _invWorldMat.copy(worldTransform).invert();
    const worldCameraPos = cameraEntity.getPosition();
    const worldCameraFwd = cameraEntity.forward;
    const localCameraPos = _invWorldMat.transformPoint(worldCameraPos, _localCameraPos);
    const localCameraFwd = _invWorldMat.transformVector(worldCameraFwd, _localCameraFwd).normalize();

    _viewProj.mul2(camera.projectionMatrix, camera.viewMatrix);
    _frustum.setFromMat4(_viewProj);

    const rangeMin = Math.max(0, Math.min(gsplat.lodRangeMin ?? 0, maxLod));
    const rangeMax = Math.max(rangeMin, Math.min(gsplat.lodRangeMax ?? maxLod, maxLod));
    const { lodBaseDistance, lodMultiplier } = lodParams;
    const minDistBuf = maxLod >= 1
        ? ensureLodMinDistThresholds(maxLod, lodBaseDistance, lodMultiplier)
        : null;

    const px = localCameraPos.x;
    const py = localCameraPos.y;
    const pz = localCameraPos.z;
    const fwx = localCameraFwd.x;
    const fwy = localCameraFwd.y;
    const fwz = localCameraFwd.z;
    const lodBehindPenalty = gsplat.lodBehindPenalty ?? 1;

    const prioritized: PrioritizedFile[] = [];
    let needsLodSwitch = false;
    let staleLodNodes = 0;
    let staleLoadedNodes = 0;
    let lodDisplayMismatch = 0;
    const boundsFlat = octree.nodeBoundsMinMax;

    for (let nodeIndex = 0; nodeIndex < octree.nodes.length; nodeIndex++) {
        const b = nodeIndex * 6;
        let qx = px;
        const minX = boundsFlat[b];
        const maxX = boundsFlat[b + 3];
        if (qx < minX) qx = minX;
        else if (qx > maxX) qx = maxX;

        let qy = py;
        const minY = boundsFlat[b + 1];
        const maxY = boundsFlat[b + 4];
        if (qy < minY) qy = minY;
        else if (qy > maxY) qy = maxY;

        let qz = pz;
        const minZ = boundsFlat[b + 2];
        const maxZ = boundsFlat[b + 5];
        if (qz < minZ) qz = minZ;
        else if (qz > maxZ) qz = maxZ;

        const dx = qx - px;
        const dy = qy - py;
        const dz = qz - pz;
        const actualDistance = Math.sqrt(dx * dx + dy * dy + dz * dz);
        let penalizedDistance = actualDistance;
        if (lodBehindPenalty > 1 && actualDistance > 0.01) {
            const dotOverDistance = (fwx * dx + fwy * dy + fwz * dz) / actualDistance;
            if (dotOverDistance < 0) {
                const t = -dotOverDistance;
                penalizedDistance = actualDistance * (1 + t * (lodBehindPenalty - 1));
            }
        }

        const fovAdjustedDistance = penalizedDistance * fovScale;
        const optimalLod = computeOptimalLodIndex(
            fovAdjustedDistance,
            maxLod,
            lodBaseDistance,
            lodMultiplier,
            rangeMin,
            rangeMax,
            minDistBuf
        );

        const nodeInfo = nodeInfos?.[nodeIndex];
        const currentLod = nodeInfo?.currentLod ?? -1;
        const engineOptimalLod = nodeInfo?.optimalLod ?? -1;
        if (currentLod >= 0 && engineOptimalLod >= 0 && currentLod !== engineOptimalLod) {
            lodDisplayMismatch++;
        }
        const node = octree.nodes[nodeIndex];

        const score = scoreVisibleNode(
            _frustum,
            worldTransform,
            boundsFlat,
            nodeIndex,
            fovAdjustedDistance,
            optimalLod,
            maxLod,
            worldCameraPos,
            worldCameraFwd
        );
        if (score <= 0) {
            continue;
        }

        const edgeFactor = computeViewportEdgeFactor(_viewProj, _worldCenter);
        if (edgeFactor <= 0) {
            continue;
        }

        const targetLod = edgeFactor < VIEWPORT_EDGE_RELAX_OPTIMAL
            ? Math.min(maxLod, optimalLod + 1)
            : optimalLod;

        // 文件已加载但仍在显示粗层时，继续触发引擎切换
        if (currentLod >= 0 && currentLod <= targetLod) {
            continue;
        }

        needsLodSwitch = true;
        if (currentLod < 0 || currentLod > targetLod) {
            staleLodNodes++;
        }

        const fi = node.lods[targetLod]?.fileIndex ?? -1;
        if (fi !== -1 && octree.getFileResource(fi)) {
            staleLoadedNodes++;
        } else if (fi !== -1) {
            prioritized.push({ fileIndex: fi, score: score * edgeFactor });
        }
    }

    prioritized.sort((a, b) => b.score - a.score);
    const uniqueFiles = dedupeByFileIndex(prioritized);
    const criticalFiles = uniqueFiles.slice(0, CRITICAL_DOWNLOAD_LIMIT);
    const foregroundFiles = uniqueFiles.slice(0, FOREGROUND_DOWNLOAD_LIMIT);
    return {
        files: uniqueFiles,
        pendingUniqueFiles: countMissingUniqueFiles(octree, uniqueFiles),
        foregroundPendingUnique: countMissingUniqueFiles(octree, foregroundFiles),
        criticalPendingUnique: countMissingUniqueFiles(octree, criticalFiles),
        staleLoadedNodes,
        lodDisplayMismatch,
        needsLodSwitch,
        staleLodNodes
    };
}

function retainCriticalDownloadFiles(
    octree: OctreeLike,
    criticalBatch: PrioritizedFile[],
    pinnedFiles: Set<number>,
    pinLimit = PIN_FILE_LIMIT
): void {
    if (!octree.incRefCount) {
        return;
    }
    for (let i = 0; i < criticalBatch.length; i++) {
        if (pinnedFiles.size >= pinLimit) {
            break;
        }
        const fi = criticalBatch[i].fileIndex;
        if (pinnedFiles.has(fi)) {
            continue;
        }
        octree.incRefCount(fi);
        pinnedFiles.add(fi);
    }
}

function pinLoadedForegroundFiles(
    octree: OctreeLike,
    foregroundBatch: PrioritizedFile[],
    pinnedFiles: Set<number>,
    pinLimit = PIN_FILE_LIMIT
): void {
    if (!octree.incRefCount) {
        return;
    }
    for (let i = 0; i < foregroundBatch.length; i++) {
        if (pinnedFiles.size >= pinLimit) {
            break;
        }
        const fi = foregroundBatch[i].fileIndex;
        if (pinnedFiles.has(fi) || !octree.getFileResource(fi)) {
            continue;
        }
        octree.incRefCount(fi);
        pinnedFiles.add(fi);
    }
}

export type OctreeRefinementController = {
    start: () => void;
    destroy: () => void;
    notifyCameraMoved: () => void;
};

export function createOctreeRefinementController(
    global: Global,
    gsplatEntity: Entity,
    resource: unknown
): OctreeRefinementController | null {
    const octree = (resource as OctreeResourceLike | null)?.octree;
    if (!octree?.nodes?.length) {
        return null;
    }

    const { app, camera: cameraEntity, events } = global;
    const gsplatScene = app.scene.gsplat as GsplatSceneLike;
    const gsplatComponent = gsplatEntity.gsplat as GSplatComponent | null;

    const lodParams: LodPlacementParams = {
        lodBaseDistance: gsplatComponent?.lodBaseDistance ?? 5,
        lodMultiplier: gsplatComponent?.lodMultiplier ?? 3
    };

    if (octree.assetLoader) {
        patchAssetLoaderPriority(octree.assetLoader);
    }
    patchEnsureFileResourceGate(octree);

    let active = false;
    let updateHandler: ((dt: number) => void) | null = null;
    let frameReadyHandler: ((...args: unknown[]) => void) | null = null;
    let perfModeHandler: (() => void) | null = null;
    let debugLastLog = 0;

    let savedLoaderConcurrency: number | null = null;
    let savedSplatBudget: number | null = null;
    let savedLodUpdateDistance: number | null = null;
    let savedLodUnderfillLimit: number | null = null;
    let hadPendingOptimal = false;
    let hadPendingForeground = false;
    let hadPendingCritical = false;
    let settleFramesRemaining = 0;
    let prevCriticalPending = -1;
    let prevPendingUnique = -1;
    let prevStableForegroundPending = -1;
    let prevStaleLodNodes = -1;
    let staleSyncCooldown = 0;
    let boostActive = false;
    let cameraMovedSinceSettle = false;
    const pinnedFiles = new Set<number>();
    const trackedMissingFiles = new Map<number, number>();
    let lastPriorityUrls: string[] = [];

    const applyBoostSettings = () => {
        const loader = octree.assetLoader;
        if (loader) {
            if (savedLoaderConcurrency === null) {
                savedLoaderConcurrency = loader.maxConcurrentLoads ?? DEFAULT_MAX_CONCURRENT;
            }
            loader.maxConcurrentLoads = BOOST_MAX_CONCURRENT;
        }

        if (savedLodUpdateDistance === null) {
            savedLodUpdateDistance = gsplatScene.lodUpdateDistance;
        }
        gsplatScene.lodUpdateDistance = BOOST_LOD_UPDATE_DISTANCE;

        if (savedSplatBudget === null) {
            savedSplatBudget = gsplatScene.splatBudget;
        }
        gsplatScene.splatBudget = REFINEMENT_SPLAT_BUDGET;

        if (savedLodUnderfillLimit === null) {
            savedLodUnderfillLimit = gsplatScene.lodUnderfillLimit ?? 0;
        }
        // 5 档资产 optimal=0 时 limit 至少为 4 才能包含 bootstrap L4；取 max 保证生效
        const maxLod = octree.lodLevels - 1;
        gsplatScene.lodUnderfillLimit = Math.max(REFINEMENT_LOD_UNDERFILL_LIMIT, maxLod);
        gsplatScene.dirty = true;
    };

    const enterRefinementMode = () => {
        if (boostActive) {
            return;
        }
        boostActive = true;
        applyBoostSettings();
    };

    const restoreRefinementMode = () => {
        if (!boostActive) {
            return;
        }
        boostActive = false;
        if (savedLodUpdateDistance !== null) {
            gsplatScene.lodUpdateDistance = savedLodUpdateDistance;
            savedLodUpdateDistance = null;
        }
        // budget/underfill 保持 boost 值至 controller destroy，避免 pending 清零后 peripheral 因 budget 骤降抖动
        const loader = octree.assetLoader;
        if (loader && savedLoaderConcurrency !== null) {
            loader.maxConcurrentLoads = savedLoaderConcurrency;
            // 丢弃 gate 期间拦截的后台 URL，避免 settle 结束时洪峰下载冲击 peripheral
            loader.__refinementSuspendedQueue = [];
            clearRefinementPriorityUrls(octree, loader);
            savedLoaderConcurrency = null;
        }
        lastPriorityUrls = [];
        gsplatScene.dirty = true;
    };

    const restoreSavedGsplatSceneSettings = () => {
        if (savedSplatBudget !== null) {
            gsplatScene.splatBudget = savedSplatBudget;
            savedSplatBudget = null;
        }
        if (savedLodUnderfillLimit !== null) {
            gsplatScene.lodUnderfillLimit = savedLodUnderfillLimit;
            savedLodUnderfillLimit = null;
        }
        gsplatScene.dirty = true;
    };

    const stopRefinementController = () => {
        if (!active) {
            return;
        }

        active = false;
        restoreRefinementMode();
        restoreSavedGsplatSceneSettings();
        const loader = octree.assetLoader;
        if (loader) {
            restoreSuspendedQueuedLoads(loader);
            clearRefinementPriorityUrls(octree, loader);
        }
        if (updateHandler) {
            app.off('update', updateHandler);
            updateHandler = null;
        }
        if (frameReadyHandler) {
            app.systems.gsplat.off('frame:ready', frameReadyHandler);
            frameReadyHandler = null;
        }
        if (perfModeHandler) {
            events.off('performanceMode:changed', perfModeHandler);
            perfModeHandler = null;
        }
    };

    const runPriorityPrefetch = () => {
        const cameraJustMoved = cameraMovedSinceSettle;
        const {
            files: batch,
            pendingUniqueFiles,
            foregroundPendingUnique,
            criticalPendingUnique,
            staleLoadedNodes,
            lodDisplayMismatch,
            needsLodSwitch,
            staleLodNodes
        } = buildPriorityFiles(
            app,
            octree,
            gsplatEntity,
            cameraEntity,
            gsplatScene,
            lodParams
        );

        updateTrackedMissingFiles(trackedMissingFiles, batch, octree);
        const stableForeground = buildBatchFromTracked(trackedMissingFiles, FOREGROUND_DOWNLOAD_LIMIT);
        const stableCritical = buildBatchFromTracked(trackedMissingFiles, CRITICAL_DOWNLOAD_LIMIT);
        const criticalBatch = stableCritical;
        const foregroundBatch = stableForeground;
        const activeBatch = foregroundBatch;
        const stableForegroundPending = countMissingUniqueFiles(octree, stableForeground);
        const stableCriticalPending = countMissingUniqueFiles(octree, stableCritical);

        const pendingFileIndices: number[] = [];
        const priorityUrls: string[] = [];
        for (let i = 0; i < activeBatch.length; i++) {
            const { fileIndex } = activeBatch[i];
            if (octree.getFileResource(fileIndex)) {
                continue;
            }
            pendingFileIndices.push(fileIndex);
            const url = octree.files[fileIndex]?.url;
            if (url) {
                priorityUrls.push(url);
            }
        }

        const fileJustLanded =
            (prevPendingUnique > 0 && pendingUniqueFiles < prevPendingUnique) ||
            (prevStableForegroundPending > 0 && stableForegroundPending < prevStableForegroundPending) ||
            (prevCriticalPending > 0 && criticalPendingUnique < prevCriticalPending);

        // 完成/settle 以 stableForegroundPending 为准，避免外围 budget 振荡拉高 pendingUniqueFiles
        if (stableForegroundPending > 0) {
            hadPendingOptimal = true;
            hadPendingForeground = true;
            settleFramesRemaining = 0;
        } else if (hadPendingOptimal || hadPendingForeground) {
            hadPendingOptimal = false;
            hadPendingForeground = false;
            settleFramesRemaining = Math.max(settleFramesRemaining, POST_DOWNLOAD_SETTLE_FRAMES);
        }

        if (stableCriticalPending > 0) {
            hadPendingCritical = true;
        } else if (hadPendingCritical) {
            hadPendingCritical = false;
            settleFramesRemaining = Math.max(settleFramesRemaining, POST_DOWNLOAD_SETTLE_FRAMES);
        }

        if (fileJustLanded) {
            settleFramesRemaining = Math.max(settleFramesRemaining, PER_FILE_SETTLE_FRAMES);
        }

        const loader = octree.assetLoader;
        if (priorityUrls.length > 0) {
            retainCriticalDownloadFiles(octree, criticalBatch, pinnedFiles);
            const gateUrls = expandDownloadGateUrls(loader, priorityUrls);
            lastPriorityUrls = gateUrls.slice();
            setRefinementPriorityUrls(octree, loader, gateUrls);
            for (let i = 0; i < pendingFileIndices.length; i++) {
                prioritizeFileLoad(octree, pendingFileIndices[i]);
            }
            if (loader) {
                reconcileLoaderQueue(loader, gateUrls);
            }
        } else if (loader) {
            // 仅在刚完成一轮下载的 settle 窗口内 hold 旧 gate，防 peripheral 涌入抖动。
            // 勿用 staleLodNodes 条件：挪机后 stale 长期存在会沿用旧视角 URL，卡死新中心 sync/下载。
            const holdGate =
                boostActive &&
                settleFramesRemaining > 0 &&
                stableForegroundPending === 0 &&
                lastPriorityUrls.length > 0;
            if (holdGate) {
                setRefinementPriorityUrls(octree, loader, lastPriorityUrls);
            } else if (boostActive) {
                clearRefinementPriorityUrls(octree, loader);
                lastPriorityUrls = [];
            } else {
                clearRefinementPriorityUrls(octree, loader);
                lastPriorityUrls = [];
            }
        }

        if (boostActive) {
            pinLoadedForegroundFiles(octree, foregroundBatch, pinnedFiles);
        }
        prevCriticalPending = criticalPendingUnique;
        prevPendingUnique = pendingUniqueFiles;
        prevStableForegroundPending = stableForegroundPending;

        const needsBoost =
            cameraMovedSinceSettle ||
            stableCriticalPending > 0 ||
            staleLoadedNodes > 0 ||
            (needsLodSwitch && stableForegroundPending > 0) ||
            settleFramesRemaining > 0;

        if (needsBoost) {
            enterRefinementMode();
            cameraMovedSinceSettle = false;
        } else if (boostActive) {
            restoreRefinementMode();
            const loader = octree.assetLoader;
            if (loader) {
                clearRefinementPriorityUrls(octree, loader);
            }
        }

        let syncedInstances = 0;
        if (cameraJustMoved && needsLodSwitch && staleLoadedNodes > 0) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                true
            );
        } else if (needsLodSwitch && fileJustLanded) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                true
            );
        } else if (needsLodSwitch && staleLoadedNodes > 0 && staleSyncCooldown <= 0) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                false
            );
            staleSyncCooldown = 12;
        } else if (stableForegroundPending === 0 && staleLodNodes > 0 && fileJustLanded) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                true
            );
        }

        if (fileJustLanded && syncedInstances === 0 && (staleLoadedNodes > 0 || needsLodSwitch)) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                true
            );
        }

        if (staleSyncCooldown > 0) {
            staleSyncCooldown--;
        }

        const isSettling = settleFramesRemaining > 0;
        if (isSettling) {
            settleFramesRemaining--;
        }

        if (isRefinementDebugEnabled()) {
            const now = performance.now();
            if (now - debugLastLog > 2000) {
                debugLastLog = now;
                const suspended = loader?.__refinementSuspendedQueue?.length ?? 0;
                const queueLen = loader?._loadQueue?.length ?? 0;
                const inFlight = loader?._currentlyLoading?.size ?? 0;
                const log: Record<string, unknown> = {
                    boostActive,
                    pinLimit: PIN_FILE_LIMIT,
                    pinnedFiles: pinnedFiles.size,
                    pendingUniqueFiles,
                    criticalPendingUnique,
                    foregroundPendingUnique,
                    stableForegroundPending,
                    stableCriticalPending,
                    trackedMissing: trackedMissingFiles.size,
                    activeDownloads: priorityUrls.length,
                    staleLoadedNodes,
                    lodDisplayMismatch,
                    needsLodSwitch,
                    staleLodNodes,
                    syncedInstances,
                    settlingFrames: settleFramesRemaining,
                    staleSyncCooldown,
                    gateHeld:
                        boostActive &&
                        settleFramesRemaining > 0 &&
                        stableForegroundPending === 0 &&
                        lastPriorityUrls.length > 0,
                    lastGateUrls: lastPriorityUrls.length,
                    queueLen,
                    inFlight,
                    suspended,
                    maxConcurrent: loader?.maxConcurrentLoads,
                    splatBudget: gsplatScene.splatBudget,
                    lodUnderfillLimit: gsplatScene.lodUnderfillLimit,
                    lodRange: [gsplatScene.lodRangeMin, gsplatScene.lodRangeMax]
                };
                if (getRefinementDebugLevel() >= 2) {
                    log.jitterHint = {
                        deltaStaleLod: staleLodNodes - prevStaleLodNodes,
                        deltaLodMismatch: lodDisplayMismatch,
                        likelyBudgetOscillation:
                            lodDisplayMismatch > 20 && Math.abs(staleLodNodes - prevStaleLodNodes) > 5,
                        likelyDirtyLoop:
                            staleLoadedNodes > 0 && staleSyncCooldown > 0
                    };
                }
                console.log('[octree-refinement]', log);
                prevStaleLodNodes = staleLodNodes;
            }
        }

        if (fileJustLanded) {
            gsplatScene.dirty = true;
            markOctreeInstancesDirty(app, octree, gsplatEntity);
            app.renderNextFrame = true;
        } else if (priorityUrls.length > 0) {
            app.renderNextFrame = true;
        }

        return priorityUrls.length;
    };

    const onUpdate = () => {
        if (!active) {
            return;
        }
        runPriorityPrefetch();
    };

    let prevFrameLoading = -1;

    return {
        start() {
            if (active) {
                return;
            }
            active = true;
            boostActive = false;
            cameraMovedSinceSettle = false;
            pinnedFiles.clear();
            trackedMissingFiles.clear();
            lastPriorityUrls = [];
            prevStaleLodNodes = -1;
            prevStableForegroundPending = -1;
            staleSyncCooldown = 0;
            enterRefinementMode();

            updateHandler = onUpdate;
            app.on('update', updateHandler);

            const eventHandler = app.systems.gsplat;
            frameReadyHandler = (_camera: unknown, _layer: unknown, _ready: unknown, loading: unknown) => {
                const loadingCount = typeof loading === 'number' ? loading : -1;
                const loadingDropped = prevFrameLoading > 0 && loadingCount >= 0 && loadingCount < prevFrameLoading;
                if (loadingCount >= 0) {
                    prevFrameLoading = loadingCount;
                }
                if (loadingDropped) {
                    syncOctreePendingPlacements(app, octree, gsplatEntity, gsplatScene, true);
                    markOctreeInstancesDirty(app, octree, gsplatEntity);
                    app.renderNextFrame = true;
                }
            };
            eventHandler.on('frame:ready', frameReadyHandler);

            perfModeHandler = () => {
                if (boostActive) {
                    applyBoostSettings();
                }
            };
            events.on('performanceMode:changed', perfModeHandler);

            runPriorityPrefetch();
        },

        notifyCameraMoved() {
            if (!active) {
                return;
            }
            cameraMovedSinceSettle = true;
            settleFramesRemaining = 0;
            hadPendingOptimal = false;
            hadPendingForeground = false;
            hadPendingCritical = false;
            lastPriorityUrls = [];
            trackedMissingFiles.clear();
            staleSyncCooldown = 0;
            const loader = octree.assetLoader;
            if (loader) {
                clearRefinementPriorityUrls(octree, loader);
            }
        },

        destroy() {
            stopRefinementController();
        }
    };
}
