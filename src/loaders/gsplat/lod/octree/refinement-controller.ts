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

import type { Global } from '../../../../types';
import { getOctreeBootstrapLod, isOctreeBootstrapPlaceableNode } from './lod-meta';
import { resolveEntityLodRange } from './entity-lod-range';
import { findAllOctreeInstances, type OctreeInstanceLike } from './octree-instance-access';
import { ensureOctreeLeafSpatialIndex } from './octree-spatial-index';
import { computeStreamingRefinementProgressRatio } from './streaming-refinement-progress';

export { computeStreamingRefinementProgressRatio };

const REF_TAN_HALF_FOV = Math.tan(22.5 * math.DEG_TO_RAD);

/** refinement 调度可调参数（按 mobile/desktop 分支集中管理） */
const T = {
    loader: {
        defaultConcurrent: 2,
        boostConcurrent: platform.mobile ? 4 : 8,
        burstConcurrent: platform.mobile ? 8 : 12,
        emergencyConcurrent: platform.mobile ? 16 : 32,
        /** stale in-flight 占满时允许额外开槽的绝对上限，保证 criticalLimit 个新槽 */
        extremeConcurrent: platform.mobile ? 32 : 64,
        foregroundLimit: platform.mobile ? 32 : 64,
        criticalLimit: platform.mobile ? 4 : 8,
        pinLimit: platform.mobile ? 6 : 12,
        trackedMissFrames: platform.mobile ? 8 : 12,
        trackedLimit: platform.mobile ? 96 : 192
    },
    settle: {
        postDownloadFrames: 30,
        perFileFrames: 12
    },
    lod: {
        splatBudget: platform.mobile ? 2_000_000 : 4_000_000,
        underfillLimit: platform.mobile ? 2 : 3,
        boostUpdateDistance: platform.mobile ? 0.12 : 0.18,
        burstUpdateDistance: 0
    },
    viewport: {
        edgeNdcInner: 0.44,
        edgeNdcOuter: 0.72,
        edgeRelaxOptimal: 0.45,
        centerScorePower: 5.0
    },
    burst: {
        moveFrames: 18,
        zoomFrames: 36,
        unlockFrames: 48,
        syncCooldown: 3,
        staleSyncCooldown: 6,
        staleSyncIdleFrames: 12
    },
    ladder: {
        coarsestStepBoost: 2.75,
        stepBoost: 1.6
    }
} as const;

export const STREAMING_VIEWPORT_READY_RATIO = 1;

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
    _urlToAsset?: Map<string, { loaded?: boolean; loading?: boolean; off: (event: string) => void }>;
    _retryCount?: Map<string, number>;
    load: (url: string) => void;
    unload?: (url: string) => void;
    getResource?: (url: string) => unknown;
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
    __refinementUrlToFileIndex?: Map<string, number>;
    /** Phase1：由 nodeBoundsMinMax 构建的 leaf BVH（引擎会丢弃 meta.tree） */
    __leafSpatialIndex?: import('./octree-spatial-index').OctreeLeafSpatialIndex | null;
};

export type { OctreeLike };

export type GSplatOctreeResourceLike = {
    octree?: OctreeLike | null;
};

/** 多文件 octree 渐进加载；单文件 .sog 等无 octree 或仅 1 个物理文件时返回 false */
export function isStreamableOctreeResource(
    resource: GSplatOctreeResourceLike | null | undefined
): boolean {
    const octree = resource?.octree;
    if (!octree?.nodes?.length) {
        return false;
    }
    const fileCount = octree.files?.length ?? 0;
    const lodLevels = octree.lodLevels ?? 0;
    return fileCount > 1 && lodLevels > 1;
}

type GsplatSceneLike = {
    lodBehindPenalty: number;
    lodUpdateDistance: number;
    lodUpdateAngle: number;
    lodUnderfillLimit: number;
    splatBudget: number;
    dirty: boolean;
};

type PrioritizedFile = {
    fileIndex: number;
    score: number;
};

type TrackedMissingFile = {
    score: number;
    missedFrames: number;
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

export type OctreeStreamingScene = {
    app: AppBase;
    octree: OctreeLike;
    gsplatEntity: Entity;
    cameraEntity: Entity;
};

export type StreamingViewportOptions = {
    /** 粗层/bootstrap 就绪比例，默认 1 */
    readyRatio?: number;
    /** 统计时排除仅擦到视锥边缘的 node，默认 true */
    excludeViewportEdgeNodes?: boolean;
};

/** @deprecated 使用 {@link StreamingViewportOptions} */
export type StreamingViewportBootstrapOptions = StreamingViewportOptions;

type RefinementEvaluateContext = {
    scene: OctreeStreamingScene;
    gsplat: GsplatSceneLike;
    lod: LodPlacementParams;
};

function lodParamsFromComponent(component: GSplatComponent | null): LodPlacementParams {
    return {
        lodBaseDistance: component?.lodBaseDistance ?? 5,
        lodMultiplier: component?.lodMultiplier ?? 3
    };
}

function resolveViewportOptions(options?: StreamingViewportOptions) {
    return {
        readyRatio: options?.readyRatio ?? STREAMING_VIEWPORT_READY_RATIO,
        excludeViewportEdgeNodes: options?.excludeViewportEdgeNodes !== false
    };
}

const _invWorldMat = new Mat4();
const _localCameraPos = new Vec3();
const _localCameraFwd = new Vec3();
const _worldMin = new Vec3();
const _worldMax = new Vec3();
const _worldCenter = new Vec3();
const _viewProj = new Mat4();
const _frustum = new Frustum();
const _clipPos = new Vec4();
let _lastScoreMinX = 0;
let _lastScoreMinY = 0;
let _lastScoreMinZ = 0;
let _lastScoreMaxX = 0;
let _lastScoreMaxY = 0;
let _lastScoreMaxZ = 0;

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
    const prioritySet = new Set(priorityUrls);
    const expanded = new Set(priorityUrls);
    // 仅保留 priority 自身的 in-flight，不把 stale 旧视角下载扩进 gate
    loader._currentlyLoading?.forEach(url => {
        if (prioritySet.has(url)) {
            expanded.add(url);
        }
    });
    return [...expanded];
}

function reconcileLoaderQueue(loader: OctreeAssetLoaderLike, priorityUrls: string[]) {
    const queue = loader._loadQueue ?? [];
    loader._loadQueue = queue;
    const suspended = loader.__refinementSuspendedQueue ?? [];
    const inFlight = loader._currentlyLoading ?? new Set<string>();
    const prioritySet = new Set(priorityUrls);
    const order = new Map(priorityUrls.map((url, index) => [url, index]));

    // 仅以当前 priority 为准；stale in-flight 不再视为 active，避免队列继续服务旧视角
    const isActive = (url: string) => prioritySet.has(url);

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

function getOctreeUrlToFileIndex(octree: OctreeLike): Map<string, number> {
    if (octree.__refinementUrlToFileIndex) {
        return octree.__refinementUrlToFileIndex;
    }
    const map = new Map<string, number>();
    for (let i = 0; i < octree.files.length; i++) {
        const url = octree.files[i]?.url;
        if (url) {
            map.set(url, i);
        }
    }
    octree.__refinementUrlToFileIndex = map;
    return map;
}

function isFileBoundToOctreeInstance(
    instances: OctreeInstanceLike[],
    fileIndex: number
): boolean {
    for (let i = 0; i < instances.length; i++) {
        const placement = instances[i].filePlacements?.[fileIndex];
        if (placement?.resource) {
            return true;
        }
    }
    return false;
}

/** 从 loader 并发槽释放 URL（不 unload asset，避免 WebGPU 竞态） */
function releaseInflightSlot(loader: OctreeAssetLoaderLike, url: string): boolean {
    if (!loader._currentlyLoading?.has(url)) {
        return false;
    }
    loader._currentlyLoading.delete(url);
    const queue = loader._loadQueue;
    if (queue) {
        const queueIndex = queue.indexOf(url);
        if (queueIndex !== -1) {
            queue.splice(queueIndex, 1);
        }
    }
    loader._retryCount?.delete(url);
    loader._processQueue?.();
    return true;
}

/**
 * 软取消 in-flight：释放 loader 槽位，不调用 asset.unload()。
 * 已 loaded 但回调被摘掉时也必须释放槽位，否则会形成僵尸 in-flight 永久堵死队列。
 */
function softCancelInflightLoad(
    loader: OctreeAssetLoaderLike,
    url: string,
    octree: OctreeLike,
    fileIndex: number
): boolean {
    if (!loader._currentlyLoading?.has(url)) {
        return false;
    }

    // 已进 octree 但仍在 in-flight 集合里 — 孤儿槽位，直接释放
    if (fileIndex >= 0 && octree.getFileResource(fileIndex)) {
        return releaseInflightSlot(loader, url);
    }

    const asset = loader._urlToAsset?.get(url);
    // load 已完成但 _onAssetLoadSuccess 未跑（此前 off('load')）— 必须释放槽位
    if (asset?.loaded) {
        return releaseInflightSlot(loader, url);
    }

    if (asset) {
        asset.off('load');
        asset.off('error');
        if (!asset.loaded) {
            asset.loading = false;
        }
    }

    return releaseInflightSlot(loader, url);
}

/** 将 _loadQueue 中非 priority 的 URL 移入 suspended，避免排队区与当前 priority 不同步 */
function purgeNonPriorityQueuedLoads(
    loader: OctreeAssetLoaderLike,
    priorityUrls: string[]
): number {
    const prioritySet = new Set(priorityUrls);
    const queue = loader._loadQueue ?? [];
    const suspended = loader.__refinementSuspendedQueue ?? [];
    let purged = 0;

    for (let i = queue.length - 1; i >= 0; i--) {
        const url = queue[i];
        if (prioritySet.has(url)) {
            continue;
        }
        queue.splice(i, 1);
        if (!suspended.includes(url)) {
            suspended.push(url);
        }
        purged++;
    }

    loader._loadQueue = queue;
    loader.__refinementSuspendedQueue = suspended;
    if (purged > 0) {
        loader._processQueue?.();
    }
    return purged;
}

/**
 * 软取消非 priority 的 stale in-flight，腾出 loader 并发槽给当前 critical 下载。
 * 不调用 unload（避免 WebGPU 竞态）；仅跳过正在上屏 / pinned 的文件。
 */
function abortSafeStaleInflightLoads(
    octree: OctreeLike,
    loader: OctreeAssetLoaderLike,
    priorityUrls: string[],
    instances: OctreeInstanceLike[],
    pinnedFiles?: Set<number>
): number {
    if (!loader._currentlyLoading?.size) {
        return 0;
    }

    const prioritySet = new Set(priorityUrls);
    const urlToFileIndex = getOctreeUrlToFileIndex(octree);
    let aborted = 0;

    // priority 僵尸槽：已 loaded / 已进 octree 但仍占 in-flight
    for (const url of [...loader._currentlyLoading]) {
        if (!prioritySet.has(url)) {
            continue;
        }
        const fileIndex = urlToFileIndex.get(url);
        const asset = loader._urlToAsset?.get(url);
        const integrated = fileIndex !== undefined && octree.getFileResource(fileIndex);
        if (integrated || asset?.loaded) {
            if (releaseInflightSlot(loader, url)) {
                aborted++;
            }
        }
    }

    const staleUrls = [...loader._currentlyLoading].filter(url => !prioritySet.has(url));

    for (let i = 0; i < staleUrls.length; i++) {
        const url = staleUrls[i];
        const fileIndex = urlToFileIndex.get(url);

        // 无法映射到 file 的孤儿 in-flight（旧视角 / 环境资源等）直接释放槽位
        if (fileIndex === undefined) {
            if (releaseInflightSlot(loader, url)) {
                aborted++;
            }
            continue;
        }
        if (pinnedFiles?.has(fileIndex)) {
            continue;
        }
        if (!loader._currentlyLoading.has(url)) {
            continue;
        }
        if (isFileBoundToOctreeInstance(instances, fileIndex)) {
            continue;
        }
        if (softCancelInflightLoad(loader, url, octree, fileIndex)) {
            aborted++;
        }
    }

    return aborted;
}

/** loader 已有 resource 但 octree.fileResources 未登记时，绕过 gate 接入 */
function integratePendingLoaderResources(octree: OctreeLike, fileIndices: number[]): number {
    const loader = octree.assetLoader;
    if (!loader?.getResource) {
        return 0;
    }
    const ensure = octree.__originalEnsureFileResource ?? octree.ensureFileResource.bind(octree);
    let integrated = 0;
    for (let i = 0; i < fileIndices.length; i++) {
        const fi = fileIndices[i];
        if (octree.getFileResource(fi)) {
            continue;
        }
        const url = octree.files[fi]?.url;
        if (!url || !loader.getResource(url)) {
            continue;
        }
        ensure(fi);
        if (octree.getFileResource(fi)) {
            integrated++;
        }
    }
    return integrated;
}

function countPriorityLoadState(loader: OctreeAssetLoaderLike | null | undefined, priorityUrls: string[]) {
    const prioritySet = new Set(priorityUrls);
    const priorityQueued = loader?._loadQueue?.filter(url => prioritySet.has(url)).length ?? 0;
    let priorityInFlight = 0;
    let staleInFlight = 0;
    loader?._currentlyLoading?.forEach((url) => {
        if (prioritySet.has(url)) {
            priorityInFlight++;
        } else {
            staleInFlight++;
        }
    });
    return { priorityQueued, priorityInFlight, staleInFlight };
}

function updateBoostConcurrencyForPriority(
    loader: OctreeAssetLoaderLike | null | undefined,
    priorityUrls: string[]
): ReturnType<typeof countPriorityLoadState> & { maxConcurrent: number | undefined } {
    const state = countPriorityLoadState(loader, priorityUrls);
    if (!loader) {
        return { ...state, maxConcurrent: undefined };
    }

    // 只要有 stale in-flight 占槽且 priority 排队未启动，就需要开槽
    const blockedByStaleInflight = state.priorityQueued > 0 && state.staleInFlight > 0;
    const target = blockedByStaleInflight ?
        // 目标 = stale 数 + criticalLimit，确保始终有 criticalLimit 个空槽给新优先下载
        // 用 extremeConcurrent 而非 emergencyConcurrent，避免 stale 太多时仍无空槽
        Math.min(
            T.loader.extremeConcurrent,
            Math.max(T.loader.burstConcurrent, state.staleInFlight + T.loader.criticalLimit)
        ) :
        T.loader.boostConcurrent;

    if (loader.maxConcurrentLoads !== target) {
        loader.maxConcurrentLoads = target;
        loader._processQueue?.();
    } else if (blockedByStaleInflight) {
        // 上限未变但仍被堵：旧请求可能已完成腾槽，强制踢一次队列
        loader._processQueue?.();
    }

    return { ...countPriorityLoadState(loader, priorityUrls), maxConcurrent: loader.maxConcurrentLoads };
}

function updateTrackedMissingFiles(
    tracked: Map<number, TrackedMissingFile>,
    files: PrioritizedFile[],
    octree: OctreeLike
): void {
    const seenThisFrame = new Set<number>();
    for (let i = 0; i < files.length; i++) {
        const entry = files[i];
        seenThisFrame.add(entry.fileIndex);
        if (octree.getFileResource(entry.fileIndex)) {
            continue;
        }
        tracked.set(entry.fileIndex, { score: entry.score, missedFrames: 0 });
    }
    for (const [fi, entry] of tracked) {
        if (octree.getFileResource(fi)) {
            tracked.delete(fi);
            continue;
        }
        if (!seenThisFrame.has(fi)) {
            entry.missedFrames++;
            if (entry.missedFrames > T.loader.trackedMissFrames) {
                tracked.delete(fi);
            }
        }
    }

    if (tracked.size > T.loader.trackedLimit) {
        const entries = [...tracked.entries()].sort((a, b) => b[1].score - a[1].score);
        for (let i = T.loader.trackedLimit; i < entries.length; i++) {
            tracked.delete(entries[i][0]);
        }
    }
}

function buildBatchFromTracked(tracked: Map<number, TrackedMissingFile>, limit: number): PrioritizedFile[] {
    const batch: PrioritizedFile[] = [];
    for (const [fileIndex, entry] of tracked) {
        batch.push({ fileIndex, score: entry.score });
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

type OctreeGpuSyncJob = {
    octree: OctreeLike;
    gsplatEntity: Entity;
};

/** WebGPU：inst.update 会重建 work buffer / bind group，须在当帧 render 结束后执行 */
const deferredOctreeGpuSyncJobs = new WeakMap<AppBase, OctreeGpuSyncJob[]>();
const deferredOctreeGpuSyncApps = new WeakSet<AppBase>();

function flushDeferredOctreeInstanceUpdates(app: AppBase): void {
    const jobs = deferredOctreeGpuSyncJobs.get(app);
    if (!jobs?.length) {
        return;
    }
    const snapshot = jobs.splice(0, jobs.length);

    const updated = new Set<OctreeInstanceLike>();
    for (let i = 0; i < snapshot.length; i++) {
        const { octree, gsplatEntity } = snapshot[i];
        const instances = findAllOctreeInstances(app, octree, gsplatEntity);
        for (let j = 0; j < instances.length; j++) {
            const inst = instances[j];
            if (updated.has(inst)) {
                continue;
            }
            updated.add(inst);
            try {
                inst.update?.();
            } catch (err) {
                console.warn('[octree-refinement] deferred sync update failed', err);
            }
        }
    }
    app.renderNextFrame = true;
}

function scheduleDeferredOctreeInstanceUpdates(
    app: AppBase,
    octree: OctreeLike,
    gsplatEntity: Entity
): void {
    let jobs = deferredOctreeGpuSyncJobs.get(app);
    if (!jobs) {
        jobs = [];
        deferredOctreeGpuSyncJobs.set(app, jobs);
    }
    jobs.push({ octree, gsplatEntity });

    if (!deferredOctreeGpuSyncApps.has(app)) {
        deferredOctreeGpuSyncApps.add(app);
        app.on('frameend', () => flushDeferredOctreeInstanceUpdates(app));
    }
}

function cancelDeferredOctreeInstanceUpdates(app: AppBase, octree: OctreeLike): void {
    const jobs = deferredOctreeGpuSyncJobs.get(app);
    if (!jobs?.length) {
        return;
    }
    deferredOctreeGpuSyncJobs.set(
        app,
        jobs.filter((job) => job.octree !== octree)
    );
}

function runOctreeInstanceUpdates(
    app: AppBase,
    octree: OctreeLike,
    gsplatEntity: Entity,
    instances: OctreeInstanceLike[]
): void {
    if (app.graphicsDevice?.isWebGPU) {
        scheduleDeferredOctreeInstanceUpdates(app, octree, gsplatEntity);
        return;
    }
    for (let i = 0; i < instances.length; i++) {
        try {
            instances[i].update?.();
        } catch (err) {
            console.warn('[octree-refinement] sync update failed', err);
        }
    }
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
        instances[i].needsLodUpdate = true;
    }
    runOctreeInstanceUpdates(app, octree, gsplatEntity, instances);

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

function scoreWorldAabbVisibleNode(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    localDistance: number,
    optimalLod: number,
    maxLod: number,
    cameraPos: Vec3,
    cameraFwd: Vec3
): number {
    _worldCenter.set(
        (minX + maxX) * 0.5,
        (minY + maxY) * 0.5,
        (minZ + maxZ) * 0.5
    );
    const extent = Math.max(maxX - minX, maxY - minY, maxZ - minZ);

    const centerDx = _worldCenter.x - cameraPos.x;
    const centerDy = _worldCenter.y - cameraPos.y;
    const centerDz = _worldCenter.z - cameraPos.z;
    const centerDepth =
        centerDx * cameraFwd.x +
        centerDy * cameraFwd.y +
        centerDz * cameraFwd.z;
    const depthRadius =
        (maxX - minX) * Math.abs(cameraFwd.x) * 0.5 +
        (maxY - minY) * Math.abs(cameraFwd.y) * 0.5 +
        (maxZ - minZ) * Math.abs(cameraFwd.z) * 0.5;
    const farDepth = centerDepth + depthRadius;
    if (farDepth <= 0) {
        return 0;
    }
    const nearestDepth = Math.max(0.001, centerDepth - depthRadius);
    const depthBias = 1 / (1 + nearestDepth * 0.055);

    const screenSize = Math.sqrt(Math.max(extent / nearestDepth, 0));
    // 越需要细档（optimalLod 越小）优先级越高
    let lodUrgency = 1 + (maxLod - optimalLod) * 0.5;
    if (optimalLod === 0) {
        lodUrgency *= 1.25;
    }
    return screenSize * lodUrgency * depthBias / (1 + localDistance * 0.02);
}

function edgeFactorFromNdcExtent(ndcExtent: number): number {
    if (ndcExtent <= T.viewport.edgeNdcInner) {
        return 1;
    }
    if (ndcExtent >= T.viewport.edgeNdcOuter) {
        return 0;
    }
    return 1 - (ndcExtent - T.viewport.edgeNdcInner) / (T.viewport.edgeNdcOuter - T.viewport.edgeNdcInner);
}

/** 1=屏幕中心，0=视口边缘外缘；用于抑制边缘 chunk 的 refinement 激进度 */
function computeViewportEdgeFactor(viewProj: Mat4, worldCenter: Vec3): number {
    _clipPos.set(worldCenter.x, worldCenter.y, worldCenter.z, 1);
    viewProj.transformVec4(_clipPos, _clipPos);
    if (_clipPos.w <= 0.001) {
        return 0;
    }
    const invW = 1 / _clipPos.w;
    return edgeFactorFromNdcExtent(Math.max(Math.abs(_clipPos.x * invW), Math.abs(_clipPos.y * invW)));
}

/**
 * 以 AABB 投影矩形到屏幕中心的最近距离打分，而不是只看 AABB 中心点。
 * 近处前景块经常只有一部分覆盖屏幕中心；只用中心点会把它误判成边缘块。
 */
function computeViewportAabbEdgeFactor(
    viewProj: Mat4,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number
): number {
    let projected = false;
    let minNdcX = Infinity;
    let minNdcY = Infinity;
    let maxNdcX = -Infinity;
    let maxNdcY = -Infinity;

    for (let ix = 0; ix < 2; ix++) {
        const x = ix === 0 ? minX : maxX;
        for (let iy = 0; iy < 2; iy++) {
            const y = iy === 0 ? minY : maxY;
            for (let iz = 0; iz < 2; iz++) {
                const z = iz === 0 ? minZ : maxZ;
                _clipPos.set(x, y, z, 1);
                viewProj.transformVec4(_clipPos, _clipPos);
                if (_clipPos.w <= 0.001) {
                    continue;
                }
                const invW = 1 / _clipPos.w;
                const ndcX = _clipPos.x * invW;
                const ndcY = _clipPos.y * invW;
                minNdcX = Math.min(minNdcX, ndcX);
                minNdcY = Math.min(minNdcY, ndcY);
                maxNdcX = Math.max(maxNdcX, ndcX);
                maxNdcY = Math.max(maxNdcY, ndcY);
                projected = true;
            }
        }
    }

    if (!projected) {
        return 0;
    }

    const nearestNdcX = minNdcX > 0 ? minNdcX : (maxNdcX < 0 ? -maxNdcX : 0);
    const nearestNdcY = minNdcY > 0 ? minNdcY : (maxNdcY < 0 ? -maxNdcY : 0);
    return edgeFactorFromNdcExtent(Math.max(nearestNdcX, nearestNdcY));
}

/**
 * separate 资产逐档升 LOD：当前比 optimal 粗时，先拉 currentLod-1，避免一次追 L0 导致「最糊→次糊」长时间不动。
 */
function computeRefinementTargetLod(
    optimalLod: number,
    maxLod: number,
    currentLod: number,
    edgeFactor: number
): number {
    const relaxedTarget = edgeFactor < T.viewport.edgeRelaxOptimal
        ? Math.min(maxLod, optimalLod + 1)
        : optimalLod;

    if (currentLod >= 0 && currentLod > relaxedTarget) {
        return currentLod - 1;
    }
    return relaxedTarget;
}

function computeLadderScoreBoost(
    maxLod: number,
    currentLod: number,
    targetLod: number
): number {
    if (currentLod < 0 || currentLod <= targetLod) {
        return 1;
    }
    if (currentLod === maxLod && targetLod === maxLod - 1) {
        return T.ladder.coarsestStepBoost;
    }
    if (targetLod === currentLod - 1) {
        return T.ladder.stepBoost;
    }
    return 1;
}

function dedupePrioritizedFiles(files: PrioritizedFile[]): PrioritizedFile[] {
    const best = new Map<number, PrioritizedFile>();
    for (let i = 0; i < files.length; i++) {
        const entry = files[i];
        const prev = best.get(entry.fileIndex);
        if (!prev || entry.score > prev.score) {
            best.set(entry.fileIndex, entry);
        }
    }
    return [...best.values()];
}

/** 取 score 最高的 topK；候选数大于 k 时用 size-k 最小堆，避免全量 sort */
function selectTopKByScore(files: PrioritizedFile[], k: number): PrioritizedFile[] {
    if (k <= 0 || files.length === 0) {
        return [];
    }
    if (files.length <= k) {
        const out = files.slice();
        out.sort((a, b) => b.score - a.score);
        return out;
    }

    const heap: PrioritizedFile[] = [];
    const parent = (i: number) => (i - 1) >> 1;
    const left = (i: number) => (i << 1) + 1;
    const swap = (i: number, j: number) => {
        const t = heap[i];
        heap[i] = heap[j];
        heap[j] = t;
    };
    const siftUp = (i: number) => {
        while (i > 0) {
            const p = parent(i);
            if (heap[p].score <= heap[i].score) {
                break;
            }
            swap(p, i);
            i = p;
        }
    };
    const siftDown = (i: number) => {
        const n = heap.length;
        while (true) {
            let smallest = i;
            const l = left(i);
            const r = l + 1;
            if (l < n && heap[l].score < heap[smallest].score) {
                smallest = l;
            }
            if (r < n && heap[r].score < heap[smallest].score) {
                smallest = r;
            }
            if (smallest === i) {
                break;
            }
            swap(i, smallest);
            i = smallest;
        }
    };

    for (let i = 0; i < files.length; i++) {
        const entry = files[i];
        if (heap.length < k) {
            heap.push(entry);
            siftUp(heap.length - 1);
        } else if (entry.score > heap[0].score) {
            heap[0] = entry;
            siftDown(0);
        }
    }
    heap.sort((a, b) => b.score - a.score);
    return heap;
}

/** 相机 idle 时仅刷新 tracked 缺文件，跳过全树扫描 */
function buildPriorityFilesIncremental(
    octree: OctreeLike,
    tracked: Map<number, TrackedMissingFile>
): PrioritizedBatch {
    const ranked = buildBatchFromTracked(tracked, T.loader.trackedLimit);
    const criticalFiles = ranked.slice(0, T.loader.criticalLimit);
    const foregroundFiles = ranked.slice(0, T.loader.foregroundLimit);
    const pendingUnique = countMissingUniqueFiles(octree, ranked);
    const foregroundPending = countMissingUniqueFiles(octree, foregroundFiles);
    const criticalPending = countMissingUniqueFiles(octree, criticalFiles);
    return {
        files: ranked,
        pendingUniqueFiles: pendingUnique,
        foregroundPendingUnique: foregroundPending,
        criticalPendingUnique: criticalPending,
        staleLoadedNodes: 0,
        lodDisplayMismatch: 0,
        needsLodSwitch: pendingUnique > 0,
        staleLodNodes: 0
    };
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

export type StreamingViewportBootstrapStatus = {
    visibleNodes: number;
    unplacedVisibleNodes: number;
    placedVisibleNodes: number;
    /** 视锥内已上屏 node 占比 [0,1] */
    placementRatio: number;
    ready: boolean;
};

function countStreamingViewportBootstrapNodes(
    octree: OctreeLike,
    nodeInfos: Array<{ currentLod: number; optimalLod: number }>,
    worldTransform: Mat4,
    boundsFlat: Float32Array,
    excludeEdge: boolean
): Pick<StreamingViewportBootstrapStatus, 'visibleNodes' | 'unplacedVisibleNodes' | 'placedVisibleNodes' | 'placementRatio'> {
    const bootstrapLod = getOctreeBootstrapLod(octree);
    let visibleNodes = 0;
    let unplacedVisibleNodes = 0;

    for (let nodeIndex = 0; nodeIndex < octree.nodes.length; nodeIndex++) {
        const node = octree.nodes[nodeIndex];
        if (!isOctreeBootstrapPlaceableNode(node, bootstrapLod)) {
            continue;
        }

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
    return { visibleNodes, unplacedVisibleNodes, placedVisibleNodes, placementRatio };
}

/** bootstrap 期间主动拉取视锥核心 node 的粗档 SOG，避免 loading=0 后引擎改追细档 */
export function ensureStreamingBootstrapCoarseFiles(
    scene: OctreeStreamingScene,
    _options?: StreamingViewportOptions
): number {
    const { app, octree, gsplatEntity, cameraEntity } = scene;
    const camera = cameraEntity.camera;
    if (!camera || !octree.nodes.length) {
        return 0;
    }

    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
    const nodeInfos = instances[0]?.nodeInfos;

    _viewProj.mul2(camera.projectionMatrix, camera.viewMatrix);
    _frustum.setFromMat4(_viewProj);
    const worldTransform = gsplatEntity.getWorldTransform();
    const boundsFlat = octree.nodeBoundsMinMax;
    const bootstrapLod = getOctreeBootstrapLod(octree);
    const excludeEdge = _options?.excludeViewportEdgeNodes !== false;
    let enqueued = 0;

    for (let nodeIndex = 0; nodeIndex < octree.nodes.length; nodeIndex++) {
        const node = octree.nodes[nodeIndex];
        if (!isOctreeBootstrapPlaceableNode(node, bootstrapLod)) {
            continue;
        }
        if (nodeInfos && (nodeInfos[nodeIndex]?.currentLod ?? -1) >= 0) {
            continue;
        }

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

        const fi = node.lods[bootstrapLod]?.fileIndex ?? -1;
        if (fi >= 0 && !octree.getFileResource(fi)) {
            octree.ensureFileResource(fi);
            enqueued++;
        }
    }

    return enqueued;
}

/** streaming 首屏：视锥内足够比例 node 已至少显示一档（粗层即可） */
export function getStreamingViewportBootstrapStatus(
    scene: OctreeStreamingScene,
    options?: StreamingViewportOptions
): StreamingViewportBootstrapStatus {
    const { app, octree, gsplatEntity, cameraEntity } = scene;
    const { readyRatio, excludeViewportEdgeNodes: excludeEdge } = resolveViewportOptions(options);
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

    let counts = countStreamingViewportBootstrapNodes(
        octree,
        nodeInfos,
        worldTransform,
        boundsFlat,
        excludeEdge
    );

    // 边缘过滤后若无核心 node，回退为全视锥统计，避免 visibleNodes=0 永久卡住
    if (counts.visibleNodes === 0 && excludeEdge) {
        counts = countStreamingViewportBootstrapNodes(
            octree,
            nodeInfos,
            worldTransform,
            boundsFlat,
            false
        );
    }

    const { visibleNodes, unplacedVisibleNodes, placedVisibleNodes, placementRatio } = counts;

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

export type StreamingViewportRefinementStatus = {
    visibleNodes: number;
    refinedNodes: number;
    /** 前景仍缺下载的 unique 文件数 */
    pendingNodes: number;
    staleLoadedNodes: number;
    /** 前景下载完成度 [0,1]；需配合 unlock 时记录的 baselinePending 计算进度 */
    refinementRatio: number;
    pendingUniqueFiles: number;
    staleLodNodes: number;
    ready: boolean;
};

/**
 * streaming 首屏 refinement 快照（瞬时 foreground 评分，可能随帧振荡）。
 * 进度条完成判定应优先用 OctreeRefinementController.getStreamingRefinementStatus（stable tracked pending）。
 */
export function getStreamingViewportRefinementStatus(
    scene: OctreeStreamingScene,
    _options?: StreamingViewportOptions
): StreamingViewportRefinementStatus {
    const { app, octree, gsplatEntity, cameraEntity } = scene;
    const camera = cameraEntity.camera;
    if (!camera || !octree.nodes.length) {
        return {
            visibleNodes: 0,
            refinedNodes: 0,
            pendingNodes: 0,
            staleLoadedNodes: 0,
            refinementRatio: 1,
            pendingUniqueFiles: 0,
            staleLodNodes: 0,
            ready: true
        };
    }

    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
    if (!instances[0]?.nodeInfos) {
        return {
            visibleNodes: 0,
            refinedNodes: 0,
            pendingNodes: 0,
            staleLoadedNodes: 0,
            refinementRatio: 0,
            pendingUniqueFiles: 0,
            staleLodNodes: 0,
            ready: false
        };
    }

    const batch = buildPriorityFiles({
        scene,
        gsplat: app.scene.gsplat as GsplatSceneLike,
        lod: lodParamsFromComponent(gsplatEntity.gsplat as GSplatComponent | null)
    });

    const pendingForeground = batch.foregroundPendingUnique;
    const pendingUnique = batch.pendingUniqueFiles;
    const staleLoaded = batch.staleLoadedNodes;
    const staleLod = batch.staleLodNodes;
    const needsWork = pendingForeground + staleLod;

    return {
        visibleNodes: needsWork,
        refinedNodes: needsWork === 0 ? 1 : 0,
        pendingNodes: pendingForeground,
        staleLoadedNodes: staleLoaded,
        refinementRatio: pendingForeground <= 0 ? 1 : 0,
        pendingUniqueFiles: pendingUnique,
        staleLodNodes: staleLod,
        ready:
            pendingForeground === 0
    };
}

export function syncStreamingOctreePlacements(scene: OctreeStreamingScene): number {
    const { app, octree, gsplatEntity } = scene;
    const gsplatScene = app.scene.gsplat as GsplatSceneLike;
    return syncOctreePendingPlacements(app, octree, gsplatEntity, gsplatScene, true);
}

type BuildPriorityFilesOptions = {
    /**
     * prefetch 路径：PQ 已收集足够前景 file 后提前停止（进度条判定勿开启）。
     */
    prefetchBudget?: boolean;
};

function buildPriorityFiles(
    ctx: RefinementEvaluateContext,
    options?: BuildPriorityFilesOptions
): PrioritizedBatch {
    const { scene, gsplat, lod: lodParams } = ctx;
    const { app, octree, gsplatEntity, cameraEntity } = scene;
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

    const { rangeMin, rangeMax } = resolveEntityLodRange(gsplatEntity, maxLod);
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
    const prefetchCandidateFiles = new Set<number>();
    const spatialIndex = ensureOctreeLeafSpatialIndex(octree);

    const processRefinementLeaf = (nodeIndex: number): boolean => {
        const b = nodeIndex * 6;
        _worldMin.set(boundsFlat[b], boundsFlat[b + 1], boundsFlat[b + 2]);
        _worldMax.set(boundsFlat[b + 3], boundsFlat[b + 4], boundsFlat[b + 5]);
        worldTransform.transformPoint(_worldMin, _worldMin);
        worldTransform.transformPoint(_worldMax, _worldMax);

        const worldMinX = Math.min(_worldMin.x, _worldMax.x);
        const worldMinY = Math.min(_worldMin.y, _worldMax.y);
        const worldMinZ = Math.min(_worldMin.z, _worldMax.z);
        const worldMaxX = Math.max(_worldMin.x, _worldMax.x);
        const worldMaxY = Math.max(_worldMin.y, _worldMax.y);
        const worldMaxZ = Math.max(_worldMin.z, _worldMax.z);

        if (!aabbIntersectsFrustum(_frustum, worldMinX, worldMinY, worldMinZ, worldMaxX, worldMaxY, worldMaxZ)) {
            return true;
        }

        _lastScoreMinX = worldMinX;
        _lastScoreMinY = worldMinY;
        _lastScoreMinZ = worldMinZ;
        _lastScoreMaxX = worldMaxX;
        _lastScoreMaxY = worldMaxY;
        _lastScoreMaxZ = worldMaxZ;

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

        const nodeInfo = nodeInfos?.[nodeIndex];
        const currentLod = nodeInfo?.currentLod ?? -1;
        const engineOptimalLod = nodeInfo?.optimalLod ?? -1;
        if (currentLod >= 0 && engineOptimalLod >= 0 && currentLod !== engineOptimalLod) {
            lodDisplayMismatch++;
        }
        const node = octree.nodes[nodeIndex];

        const optimalLod = computeOptimalLodIndex(
            fovAdjustedDistance,
            maxLod,
            lodBaseDistance,
            lodMultiplier,
            rangeMin,
            rangeMax,
            minDistBuf
        );

        const score = scoreWorldAabbVisibleNode(
            worldMinX,
            worldMinY,
            worldMinZ,
            worldMaxX,
            worldMaxY,
            worldMaxZ,
            fovAdjustedDistance,
            optimalLod,
            maxLod,
            worldCameraPos,
            worldCameraFwd
        );
        if (score <= 0) {
            return true;
        }

        const edgeFactor = computeViewportAabbEdgeFactor(
            _viewProj,
            worldMinX,
            worldMinY,
            worldMinZ,
            worldMaxX,
            worldMaxY,
            worldMaxZ
        );
        if (edgeFactor <= 0) {
            return true;
        }

        const targetLod = computeRefinementTargetLod(
            optimalLod,
            maxLod,
            currentLod,
            edgeFactor
        );

        if (currentLod >= 0 && currentLod <= targetLod) {
            return true;
        }

        needsLodSwitch = true;
        if (currentLod < 0 || currentLod > targetLod) {
            staleLodNodes++;
        }

        const fi = node.lods[targetLod]?.fileIndex ?? -1;
        const ladderBoost = computeLadderScoreBoost(maxLod, currentLod, targetLod);
        if (fi !== -1 && octree.getFileResource(fi)) {
            staleLoadedNodes++;
        } else if (fi !== -1) {
            const edgeWeight = Math.pow(edgeFactor, T.viewport.centerScorePower);
            prioritized.push({ fileIndex: fi, score: score * edgeWeight * ladderBoost });
            prefetchCandidateFiles.add(fi);
            if (options?.prefetchBudget && prefetchCandidateFiles.size >= T.loader.foregroundLimit) {
                return false;
            }
        }
        return true;
    };

    if (spatialIndex) {
        spatialIndex.visitFrustumLeaves(_frustum, worldTransform, worldCameraPos, processRefinementLeaf);
    } else {
        for (let nodeIndex = 0; nodeIndex < octree.nodes.length; nodeIndex++) {
            if (processRefinementLeaf(nodeIndex) === false) {
                break;
            }
        }
    }

    const uniqueCandidates = dedupePrioritizedFiles(prioritized);
    const ranked = selectTopKByScore(uniqueCandidates, T.loader.trackedLimit);
    const criticalFiles = ranked.slice(0, T.loader.criticalLimit);
    const foregroundFiles = ranked.slice(0, T.loader.foregroundLimit);
    return {
        files: uniqueCandidates,
        pendingUniqueFiles: countMissingUniqueFiles(octree, uniqueCandidates),
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
    loader: OctreeAssetLoaderLike | null | undefined,
    criticalBatch: PrioritizedFile[],
    pinnedFiles: Set<number>,
    pinLimit = T.loader.pinLimit
): void {
    if (!octree.incRefCount) {
        return;
    }
    const queue = loader?._loadQueue;
    const inFlight = loader?._currentlyLoading;
    for (let i = 0; i < criticalBatch.length; i++) {
        if (pinnedFiles.size >= pinLimit) {
            break;
        }
        const fi = criticalBatch[i].fileIndex;
        if (pinnedFiles.has(fi)) {
            continue;
        }
        const url = octree.files[fi]?.url;
        const isLoaded = !!octree.getFileResource(fi);
        const isQueuedOrLoading = !!url && (!!queue?.includes(url) || !!inFlight?.has(url));
        if (!isLoaded && !isQueuedOrLoading) {
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
    pinLimit = T.loader.pinLimit
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

export type OctreeRefinementNotifyOptions = {
    /** 主要为 orbit 距离/FOV 变化（瞬间拉近） */
    zoom?: boolean;
};

export type OctreeRefinementActivity = {
    active: boolean;
    pendingForeground: number;
    staleLoadedNodes: number;
    burstFrames: number;
};

export type OctreeRefinementController = {
    start: () => void;
    destroy: () => void;
    notifyCameraMoved: (options?: OctreeRefinementNotifyOptions) => void;
    getActivity: () => OctreeRefinementActivity;
    /** 与下载控制器一致的 stable foreground pending，供进度条完成判定 */
    getStreamingRefinementStatus: () => StreamingViewportRefinementStatus;
};

export function createOctreeRefinementController(
    global: Global,
    gsplatEntity: Entity,
    resource: unknown
): OctreeRefinementController | null {
    const octree = (resource as { octree?: OctreeLike | null } | null)?.octree;
    if (!octree?.nodes?.length) {
        return null;
    }

    const { app, camera: cameraEntity, events } = global;
    const gsplatScene = app.scene.gsplat as GsplatSceneLike;
    const scene: OctreeStreamingScene = { app, octree, gsplatEntity, cameraEntity };
    const evalCtx: RefinementEvaluateContext = {
        scene,
        gsplat: gsplatScene,
        lod: lodParamsFromComponent(gsplatEntity.gsplat as GSplatComponent | null)
    };

    if (octree.assetLoader) {
        patchAssetLoaderPriority(octree.assetLoader);
    }
    patchEnsureFileResourceGate(octree);
    ensureOctreeLeafSpatialIndex(octree);

    let active = false;
    let updateHandler: ((dt: number) => void) | null = null;
    let frameReadyHandler: ((...args: unknown[]) => void) | null = null;
    let perfModeHandler: (() => void) | null = null;
    let debugLastLog = 0;

    let savedLoaderConcurrency: number | null = null;
    let savedSplatBudget: number | null = null;
    let savedLodUpdateDistance: number | null = null;
    let savedLodUnderfillLimit: number | null = null;
    const prefetch = {
        tracked: new Map<number, TrackedMissingFile>(),
        pinned: new Set<number>(),
        lastUrls: [] as string[]
    };
    const settle = {
        framesRemaining: 0,
        hadOptimal: false,
        hadForeground: false,
        hadCritical: false
    };
    const prevPending = {
        critical: -1,
        unique: -1,
        stableForeground: -1,
        staleLodNodes: -1
    };
    let staleSyncCooldown = 0;
    let boostActive = false;
    let cameraMovedSinceSettle = false;
    let cameraBurstFrames = 0;
    let incrementalScanCooldown = 0;
    const INCREMENTAL_SCAN_INTERVAL = 45;
    let prevActivityActive = false;
    let lastActivity: OctreeRefinementActivity = {
        active: false,
        pendingForeground: 0,
        staleLoadedNodes: 0,
        burstFrames: 0
    };
    let lastStreamingRefinementStatus: StreamingViewportRefinementStatus = {
        visibleNodes: 0,
        refinedNodes: 0,
        pendingNodes: 0,
        staleLoadedNodes: 0,
        refinementRatio: 0,
        pendingUniqueFiles: 0,
        staleLodNodes: 0,
        ready: false
    };

    const syncBurstLodUpdateDistance = () => {
        if (!boostActive || savedLodUpdateDistance === null) {
            return;
        }
        gsplatScene.lodUpdateDistance = cameraBurstFrames > 0
            ? T.lod.burstUpdateDistance
            : T.lod.boostUpdateDistance;
    };

    const applyBoostSettings = () => {
        const loader = octree.assetLoader;
        if (loader) {
            if (savedLoaderConcurrency === null) {
                savedLoaderConcurrency = loader.maxConcurrentLoads ?? T.loader.defaultConcurrent;
            }
            loader.maxConcurrentLoads = T.loader.boostConcurrent;
        }

        if (savedLodUpdateDistance === null) {
            savedLodUpdateDistance = gsplatScene.lodUpdateDistance;
        }
        syncBurstLodUpdateDistance();

        if (savedSplatBudget === null) {
            savedSplatBudget = gsplatScene.splatBudget;
        }
        const refinementBudget = savedSplatBudget > 0
            ? Math.min(savedSplatBudget, T.lod.splatBudget)
            : T.lod.splatBudget;
        gsplatScene.splatBudget = refinementBudget;

        if (savedLodUnderfillLimit === null) {
            savedLodUnderfillLimit = gsplatScene.lodUnderfillLimit ?? 0;
        }
        // 5 档资产 optimal=0 时 limit 至少为 4 才能包含 bootstrap L4；取 max 保证生效
        const maxLod = octree.lodLevels - 1;
        gsplatScene.lodUnderfillLimit = Math.max(T.lod.underfillLimit, maxLod);
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
        prefetch.lastUrls = [];
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
        cancelDeferredOctreeInstanceUpdates(app, octree);
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

    const emitRefinementActivity = (activity: OctreeRefinementActivity) => {
        lastActivity = activity;
        if (activity.active !== prevActivityActive) {
            prevActivityActive = activity.active;
            events.fire('octreeRefinement:activity', activity);
        }
    };

    const runPriorityPrefetch = () => {
        const cameraJustMoved = cameraMovedSinceSettle;
        const cameraBurstActive = cameraBurstFrames > 0;
        const useIncrementalScan =
            !cameraJustMoved &&
            !cameraBurstActive &&
            prefetch.tracked.size > 0 &&
            incrementalScanCooldown < INCREMENTAL_SCAN_INTERVAL;

        let batch: PrioritizedBatch;
        if (useIncrementalScan) {
            batch = buildPriorityFilesIncremental(octree, prefetch.tracked);
            incrementalScanCooldown++;
        } else {
            batch = buildPriorityFiles(evalCtx, { prefetchBudget: true });
            incrementalScanCooldown = 0;
        }

        const {
            files: batchFiles,
            pendingUniqueFiles,
            foregroundPendingUnique,
            criticalPendingUnique,
            staleLoadedNodes,
            lodDisplayMismatch,
            needsLodSwitch,
            staleLodNodes
        } = batch;

        updateTrackedMissingFiles(prefetch.tracked, batchFiles, octree);
        const stableForeground = buildBatchFromTracked(prefetch.tracked, T.loader.foregroundLimit);
        const stableCritical = buildBatchFromTracked(prefetch.tracked, T.loader.criticalLimit);
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
            (prevPending.unique > 0 && pendingUniqueFiles < prevPending.unique) ||
            (prevPending.stableForeground > 0 && stableForegroundPending < prevPending.stableForeground) ||
            (prevPending.critical > 0 && criticalPendingUnique < prevPending.critical);

        // 完成/settle 以 stableForegroundPending 为准，避免外围 budget 振荡拉高 pendingUniqueFiles
        if (stableForegroundPending > 0) {
            settle.hadOptimal = true;
            settle.hadForeground = true;
            settle.framesRemaining = 0;
        } else if (settle.hadOptimal || settle.hadForeground) {
            settle.hadOptimal = false;
            settle.hadForeground = false;
            settle.framesRemaining = Math.max(settle.framesRemaining, T.settle.postDownloadFrames);
        }

        if (stableCriticalPending > 0) {
            settle.hadCritical = true;
        } else if (settle.hadCritical) {
            settle.hadCritical = false;
            settle.framesRemaining = Math.max(settle.framesRemaining, T.settle.postDownloadFrames);
        }

        if (fileJustLanded) {
            settle.framesRemaining = Math.max(settle.framesRemaining, T.settle.perFileFrames);
        }

        const loader = octree.assetLoader;
        let safeAbortedInflight = 0;
        let integratedLoaderResources = 0;
        if (priorityUrls.length > 0) {
            if (loader) {
                const preAbortState = countPriorityLoadState(loader, priorityUrls);
                const priorityBlocked =
                    preAbortState.priorityQueued > 0 &&
                    preAbortState.priorityInFlight === 0 &&
                    preAbortState.staleInFlight > 0;

                // 与 priority 同步：每帧释放非 priority 占槽（不依赖 burst 窗口）
                if (preAbortState.staleInFlight > 0) {
                    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
                    safeAbortedInflight = abortSafeStaleInflightLoads(
                        octree,
                        loader,
                        priorityUrls,
                        instances,
                        prefetch.pinned
                    );
                }
                if (priorityBlocked) {
                    safeAbortedInflight += purgeNonPriorityQueuedLoads(loader, priorityUrls);
                }
                integratedLoaderResources = integratePendingLoaderResources(
                    octree,
                    pendingFileIndices
                );
            }

            const gateUrls = expandDownloadGateUrls(loader, priorityUrls);
            prefetch.lastUrls = gateUrls.slice();
            setRefinementPriorityUrls(octree, loader, gateUrls);
            for (let i = 0; i < pendingFileIndices.length; i++) {
                prioritizeFileLoad(octree, pendingFileIndices[i]);
            }
            if (loader) {
                reconcileLoaderQueue(loader, gateUrls);
            }
            if (loader && savedLoaderConcurrency === null) {
                savedLoaderConcurrency = loader.maxConcurrentLoads ?? T.loader.defaultConcurrent;
            }
            updateBoostConcurrencyForPriority(
                loader,
                priorityUrls
            );
            retainCriticalDownloadFiles(octree, loader, criticalBatch, prefetch.pinned);
        } else if (loader) {
            if (boostActive && loader.maxConcurrentLoads !== T.loader.boostConcurrent) {
                loader.maxConcurrentLoads = T.loader.boostConcurrent;
            }
            // 仅在刚完成一轮下载的 settle 窗口内 hold 旧 gate，防 peripheral 涌入抖动。
            // 勿用 staleLodNodes 条件：挪机后 stale 长期存在会沿用旧视角 URL，卡死新中心 sync/下载。
            const holdGate =
                boostActive &&
                settle.framesRemaining > 0 &&
                stableForegroundPending === 0 &&
                prefetch.lastUrls.length > 0;
            if (holdGate) {
                setRefinementPriorityUrls(octree, loader, prefetch.lastUrls);
            } else if (boostActive) {
                clearRefinementPriorityUrls(octree, loader);
                prefetch.lastUrls = [];
            } else {
                clearRefinementPriorityUrls(octree, loader);
                prefetch.lastUrls = [];
            }
        }

        if (boostActive) {
            pinLoadedForegroundFiles(octree, foregroundBatch, prefetch.pinned);
        }
        prevPending.critical = criticalPendingUnique;
        prevPending.unique = pendingUniqueFiles;
        prevPending.stableForeground = stableForegroundPending;

        const needsBoost =
            cameraJustMoved ||
            cameraBurstActive ||
            stableCriticalPending > 0 ||
            staleLoadedNodes > 0 ||
            (needsLodSwitch && stableForegroundPending > 0) ||
            (needsLodSwitch && staleLodNodes > 0) ||
            settle.framesRemaining > 0;

        if (needsBoost) {
            enterRefinementMode();
            syncBurstLodUpdateDistance();
            if (priorityUrls.length > 0) {
                updateBoostConcurrencyForPriority(loader, priorityUrls);
            }
            cameraMovedSinceSettle = false;
        } else if (boostActive) {
            restoreRefinementMode();
            const loader = octree.assetLoader;
            if (loader) {
                clearRefinementPriorityUrls(octree, loader);
            }
        }

        let syncedInstances = 0;
        if ((cameraJustMoved || cameraBurstActive) && needsLodSwitch) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                true
            );
            staleSyncCooldown = cameraBurstActive ? T.burst.syncCooldown : T.burst.staleSyncIdleFrames;
        } else if (needsLodSwitch && fileJustLanded) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                true
            );
        } else if (needsLodSwitch && staleLoadedNodes >= T.loader.foregroundLimit) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                true
            );
            staleSyncCooldown = T.burst.syncCooldown;
        } else if (needsLodSwitch && staleLoadedNodes > 0 && staleSyncCooldown <= 0) {
            syncedInstances = syncOctreePendingPlacements(
                app,
                octree,
                gsplatEntity,
                gsplatScene,
                false
            );
            staleSyncCooldown = T.burst.staleSyncCooldown;
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

        if (syncedInstances > 0) {
            markOctreeInstancesDirty(app, octree, gsplatEntity);
            gsplatScene.dirty = true;
            app.renderNextFrame = true;
        }

        if (staleSyncCooldown > 0) {
            staleSyncCooldown--;
        }

        const isSettling = settle.framesRemaining > 0;
        if (isSettling) {
            settle.framesRemaining--;
        }

        if (isRefinementDebugEnabled()) {
            const now = performance.now();
            if (now - debugLastLog > 2000) {
                debugLastLog = now;
                const suspended = loader?.__refinementSuspendedQueue?.length ?? 0;
                const queueLen = loader?._loadQueue?.length ?? 0;
                const inFlight = loader?._currentlyLoading?.size ?? 0;
                const priorityLoad = countPriorityLoadState(loader, priorityUrls);
                const log: Record<string, unknown> = {
                    boostActive,
                    pinLimit: T.loader.pinLimit,
                    pinnedFiles: prefetch.pinned.size,
                    pendingUniqueFiles,
                    criticalPendingUnique,
                    foregroundPendingUnique,
                    stableForegroundPending,
                    stableCriticalPending,
                    trackedMissing: prefetch.tracked.size,
                    activeDownloads: priorityUrls.length,
                    priorityQueued: priorityLoad.priorityQueued,
                    priorityInFlight: priorityLoad.priorityInFlight,
                    staleInFlight: priorityLoad.staleInFlight,
                    priorityBlocked:
                        priorityLoad.priorityQueued > 0 &&
                        priorityLoad.priorityInFlight === 0 &&
                        priorityLoad.staleInFlight >= (loader?.maxConcurrentLoads ?? 0),
                    safeAbortedInflight,
                    integratedLoaderResources,
                    extremeConcurrent: T.loader.extremeConcurrent,
                    staleLoadedNodes,
                    lodDisplayMismatch,
                    needsLodSwitch,
                    staleLodNodes,
                    syncedInstances,
                    cameraBurstFrames,
                    settlingFrames: settle.framesRemaining,
                    staleSyncCooldown,
                    gateHeld:
                        boostActive &&
                        settle.framesRemaining > 0 &&
                        stableForegroundPending === 0 &&
                        prefetch.lastUrls.length > 0,
                    lastGateUrls: prefetch.lastUrls.length,
                    queueLen,
                    inFlight,
                    suspended,
                    maxConcurrent: loader?.maxConcurrentLoads,
                    splatBudget: gsplatScene.splatBudget,
                    lodUnderfillLimit: gsplatScene.lodUnderfillLimit,
                    lodRange: (() => {
                        const comp = gsplatEntity.gsplat as GSplatComponent | null;
                        return [comp?.lodRangeMin ?? 0, comp?.lodRangeMax ?? 0];
                    })()
                };
                if (getRefinementDebugLevel() >= 2) {
                    log.jitterHint = {
                        deltaStaleLod: staleLodNodes - prevPending.staleLodNodes,
                        deltaLodMismatch: lodDisplayMismatch,
                        likelyBudgetOscillation:
                            lodDisplayMismatch > 20 && Math.abs(staleLodNodes - prevPending.staleLodNodes) > 5,
                        likelyDirtyLoop:
                            staleLoadedNodes > 0 && staleSyncCooldown > 0
                    };
                }
                console.log('[octree-refinement]', log);
                prevPending.staleLodNodes = staleLodNodes;
            }
        }

        const activityActive =
            stableForegroundPending > 0 ||
            staleLoadedNodes > 0 ||
            (cameraBurstActive && needsLodSwitch);
        emitRefinementActivity({
            active: activityActive,
            pendingForeground: stableForegroundPending,
            staleLoadedNodes,
            burstFrames: cameraBurstFrames
        });

        const needsWork = stableForegroundPending + staleLodNodes;
        lastStreamingRefinementStatus = {
            visibleNodes: needsWork,
            refinedNodes: needsWork === 0 ? 1 : 0,
            pendingNodes: stableForegroundPending,
            staleLoadedNodes,
            refinementRatio: stableForegroundPending <= 0 ? 1 : 0,
            pendingUniqueFiles: pendingUniqueFiles,
            staleLodNodes,
            ready: stableForegroundPending === 0
        };

        if (cameraBurstFrames > 0) {
            cameraBurstFrames--;
            syncBurstLodUpdateDistance();
        }

        if (fileJustLanded || activityActive) {
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
            cameraMovedSinceSettle = true;
            incrementalScanCooldown = INCREMENTAL_SCAN_INTERVAL;
            cameraBurstFrames = T.burst.unlockFrames;
            prevActivityActive = false;
            prefetch.pinned.clear();
            prefetch.tracked.clear();
            prefetch.lastUrls = [];
            prevPending.staleLodNodes = -1;
            prevPending.stableForeground = -1;
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

        notifyCameraMoved(options?: OctreeRefinementNotifyOptions) {
            if (!active) {
                return;
            }
            cameraMovedSinceSettle = true;
            incrementalScanCooldown = 0;
            const burstFrames = options?.zoom ? T.burst.zoomFrames : T.burst.moveFrames;
            cameraBurstFrames = Math.max(cameraBurstFrames, burstFrames);
            settle.framesRemaining = 0;
            settle.hadOptimal = false;
            settle.hadForeground = false;
            settle.hadCritical = false;
            prefetch.lastUrls = [];
            prefetch.tracked.clear();
            prefetch.pinned.clear();
            staleSyncCooldown = 0;
            const loader = octree.assetLoader;
            if (loader) {
                clearRefinementPriorityUrls(octree, loader);
                if (options?.zoom) {
                    // zoom/双击时丢弃旧位置的 suspended 队列，避免旧视角 URL
                    // 在新位置 burst 期间重新进队与当前 priority 争抢槽位
                    loader.__refinementSuspendedQueue = [];
                }
            }
            runPriorityPrefetch();
        },

        getActivity() {
            return lastActivity;
        },

        getStreamingRefinementStatus() {
            return lastStreamingRefinementStatus;
        },

        destroy() {
            stopRefinementController();
        }
    };
}
