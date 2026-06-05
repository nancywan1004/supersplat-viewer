import {
    Entity,
    Frustum,
    Mat4,
    Vec3,
    math,
    platform,
    type AppBase,
    type GSplatComponent
} from 'playcanvas';

import type { Global } from '../types';

const REF_TAN_HALF_FOV = Math.tan(22.5 * math.DEG_TO_RAD);

const DEFAULT_MAX_CONCURRENT = 2;
const DEFAULT_LOD_UPDATE_DISTANCE = 1;

const BOOST_MAX_CONCURRENT = platform.mobile ? 4 : 6;
const BOOST_LOD_UPDATE_DISTANCE = 0;
// refinement 阶段放宽 budget 但不设 0（0=无上限，细层全上会撑爆 CPU sort 内存）
const REFINEMENT_SPLAT_BUDGET = platform.mobile ? 3_000_000 : 6_000_000;
// 下载完成后继续推动渲染/work-buffer 重建的帧数
const POST_DOWNLOAD_SETTLE_FRAMES = 30;
// 每个 chunk 落地后短促推动上屏
const PER_FILE_SETTLE_FRAMES = 12;
// refinement 阶段优先保证视野中心变清晰，边缘 chunk 可延后
const FOREGROUND_DOWNLOAD_LIMIT = platform.mobile ? 32 : 64;
// 最先下载的核心文件数（严格两阶段：核心下完再下其余前景）
const CRITICAL_DOWNLOAD_LIMIT = platform.mobile ? 6 : 12;

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
    assetLoader?: OctreeAssetLoaderLike | null;
    __refinementEnsurePatched?: boolean;
    __originalEnsureFileResource?: (fileIndex: number) => void;
    __refinementPriorityUrls?: Set<string>;
};

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

function isRefinementDebugEnabled(): boolean {
    try {
        return new URLSearchParams(window.location.search).get('debugOctreeRefinement') === '1';
    } catch {
        return false;
    }
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

function reconcileLoaderQueue(loader: OctreeAssetLoaderLike, priorityUrls: string[]) {
    const queue = loader._loadQueue ?? [];
    loader._loadQueue = queue;
    const suspended = loader.__refinementSuspendedQueue ?? [];
    const prioritySet = new Set(priorityUrls);
    const order = new Map(priorityUrls.map((url, index) => [url, index]));

    const nextSuspended: string[] = [];
    const addSuspended = (url: string) => {
        if (!nextSuspended.includes(url)) {
            nextSuspended.push(url);
        }
    };

    for (const url of suspended) {
        if (!prioritySet.has(url)) {
            addSuspended(url);
        }
    }

    const priorityInQueue: string[] = [];
    for (const url of queue) {
        if (prioritySet.has(url)) {
            priorityInQueue.push(url);
        } else {
            addSuspended(url);
        }
    }

    for (const url of priorityUrls) {
        if (!priorityInQueue.includes(url)) {
            priorityInQueue.push(url);
        }
    }

    priorityInQueue.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    queue.length = 0;
    queue.push(...priorityInQueue);
    loader.__refinementSuspendedQueue = nextSuspended;
    loader._processQueue?.();
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
    clearDownloadGate = false
) {
    if (clearDownloadGate) {
        clearRefinementPriorityUrls(octree, octree.assetLoader);
    }

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

    gsplatScene.dirty = true;
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
    const lodUrgency = 1 + optimalLod * 0.5;
    return screenSize * lodUrgency * centerBias / (1 + localDistance * 0.02);
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
        const node = octree.nodes[nodeIndex];

        const score = scoreVisibleNode(
            _frustum,
            worldTransform,
            boundsFlat,
            nodeIndex,
            fovAdjustedDistance,
            optimalLod,
            worldCameraPos,
            worldCameraFwd
        );
        if (score <= 0) {
            continue;
        }

        // 文件已加载但仍在显示粗层时，继续触发引擎切换
        if (currentLod >= 0 && currentLod <= optimalLod) {
            continue;
        }

        needsLodSwitch = true;
        if (currentLod < 0 || currentLod > optimalLod) {
            staleLodNodes++;
        }
        const fi = node.lods[optimalLod]?.fileIndex ?? -1;
        if (fi !== -1 && octree.getFileResource(fi)) {
            staleLoadedNodes++;
        } else if (fi !== -1) {
            prioritized.push({ fileIndex: fi, score });
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
        needsLodSwitch,
        staleLodNodes
    };
}

export type OctreeRefinementController = {
    start: () => void;
    destroy: () => void;
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
    let hadPendingOptimal = false;
    let hadPendingForeground = false;
    let hadPendingCritical = false;
    let settleFramesRemaining = 0;
    let prevCriticalPending = -1;
    let prevPendingUnique = -1;

    const enterRefinementMode = () => {
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
        gsplatScene.dirty = true;
    };

    const restoreRefinementMode = () => {
        if (savedLodUpdateDistance !== null) {
            gsplatScene.lodUpdateDistance = savedLodUpdateDistance;
            savedLodUpdateDistance = null;
        }
        if (savedSplatBudget !== null) {
            gsplatScene.splatBudget = savedSplatBudget;
            savedSplatBudget = null;
        }
        const loader = octree.assetLoader;
        if (loader && savedLoaderConcurrency !== null) {
            loader.maxConcurrentLoads = savedLoaderConcurrency;
            restoreSuspendedQueuedLoads(loader);
            clearRefinementPriorityUrls(octree, loader);
            savedLoaderConcurrency = null;
        }
        gsplatScene.dirty = true;
    };

    const runPriorityPrefetch = () => {
        const {
            files: batch,
            pendingUniqueFiles,
            foregroundPendingUnique,
            criticalPendingUnique,
            staleLoadedNodes,
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

        const criticalBatch = batch.slice(0, CRITICAL_DOWNLOAD_LIMIT);
        const foregroundBatch = batch.slice(0, FOREGROUND_DOWNLOAD_LIMIT);
        const inCriticalPhase = criticalPendingUnique > 0;
        const activeBatch = inCriticalPhase ? criticalBatch : foregroundBatch;

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

        const loader = octree.assetLoader;
        if (priorityUrls.length > 0) {
            setRefinementPriorityUrls(octree, loader, priorityUrls);
            const queuedUrls: string[] = [];
            for (let i = 0; i < pendingFileIndices.length; i++) {
                const url = prioritizeFileLoad(octree, pendingFileIndices[i]);
                if (url) {
                    queuedUrls.push(url);
                }
            }
            if (loader) {
                const activeUrls = queuedUrls.length > 0 ? queuedUrls : priorityUrls;
                reconcileLoaderQueue(loader, activeUrls);
                loader._processQueue?.();
            }
        } else if (loader) {
            clearRefinementPriorityUrls(octree, loader);
        }

        if (pendingUniqueFiles > 0) {
            hadPendingOptimal = true;
            settleFramesRemaining = 0;
        } else if (hadPendingOptimal) {
            hadPendingOptimal = false;
            settleFramesRemaining = POST_DOWNLOAD_SETTLE_FRAMES;
        }

        if (foregroundPendingUnique > 0) {
            hadPendingForeground = true;
        } else if (hadPendingForeground) {
            hadPendingForeground = false;
            settleFramesRemaining = Math.max(settleFramesRemaining, POST_DOWNLOAD_SETTLE_FRAMES);
        }

        if (criticalPendingUnique > 0) {
            hadPendingCritical = true;
        } else if (hadPendingCritical) {
            hadPendingCritical = false;
            settleFramesRemaining = Math.max(settleFramesRemaining, POST_DOWNLOAD_SETTLE_FRAMES);
        }

        const fileJustLanded =
            (prevPendingUnique > 0 && pendingUniqueFiles < prevPendingUnique) ||
            (prevCriticalPending > 0 && criticalPendingUnique < prevCriticalPending);
        if (fileJustLanded) {
            settleFramesRemaining = Math.max(settleFramesRemaining, PER_FILE_SETTLE_FRAMES);
        }
        prevCriticalPending = criticalPendingUnique;
        prevPendingUnique = pendingUniqueFiles;

        let syncedInstances = 0;
        const downloadsComplete = pendingUniqueFiles === 0 || criticalPendingUnique === 0;
        if (needsLodSwitch && (fileJustLanded || staleLoadedNodes > 0 || settleFramesRemaining > 0)) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                downloadsComplete
            );
        } else if (downloadsComplete && (staleLodNodes > 0 || settleFramesRemaining > 0)) {
            syncedInstances = syncOctreePendingPlacements(app, octree, gsplatEntity, gsplatScene, true);
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
                console.log('[octree-refinement]', {
                    downloadPhase: inCriticalPhase ? 'critical' : 'foreground',
                    pendingUniqueFiles,
                    criticalPendingUnique,
                    foregroundPendingUnique,
                    activeDownloads: priorityUrls.length,
                    staleLoadedNodes,
                    needsLodSwitch,
                    staleLodNodes,
                    syncedInstances,
                    settlingFrames: settleFramesRemaining,
                    queueLen,
                    inFlight,
                    suspended,
                    maxConcurrent: loader?.maxConcurrentLoads,
                    splatBudget: gsplatScene.splatBudget,
                    lodRange: [gsplatScene.lodRangeMin, gsplatScene.lodRangeMax]
                });
            }
        }

        if (priorityUrls.length > 0 || isSettling || fileJustLanded || staleLoadedNodes > 0) {
            gsplatScene.dirty = true;
            markOctreeInstancesDirty(app, octree, gsplatEntity);
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

    return {
        start() {
            if (active) {
                return;
            }
            active = true;
            enterRefinementMode();

            updateHandler = onUpdate;
            app.on('update', updateHandler);

            const eventHandler = app.systems.gsplat;
            frameReadyHandler = () => {
                if (settleFramesRemaining > 0) {
                    markOctreeInstancesDirty(app, octree, gsplatEntity);
                    gsplatScene.dirty = true;
                    app.renderNextFrame = true;
                }
            };
            eventHandler.on('frame:ready', frameReadyHandler);

            perfModeHandler = () => enterRefinementMode();
            events.on('performanceMode:changed', perfModeHandler);

            runPriorityPrefetch();
        },

        destroy() {
            active = false;
            restoreRefinementMode();
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
        }
    };
}
