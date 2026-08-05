import type { AppBase } from 'playcanvas';

import type { OctreeRefinementController, OctreeRefinementTickMetrics } from '../loaders/gsplat/lod/octree/refinement-controller';
import type { Global } from '../types';

export const REFINEMENT_CLEAR_RATIO = 0.95;
/** 观测轮询间隔：只读采样，不驱动 refinement / LOD */
export const BENCHMARK_OBSERVE_MS = 200;
/** 连续清晰观测次数（× BENCHMARK_OBSERVE_MS）判定 blur→clear */
export const REFINEMENT_STABLE_OBSERVATIONS = 4;
export const REFINEMENT_TIMEOUT_MS = 45_000;

export type RefinementWaitResult = {
    blurToClearMs: number | null;
    refineTimedOut: boolean;
    pendingNodesAtArrival: number;
    pendingPeakNodes: number;
    refinementRatioAtClear: number | null;
    fpsP50DuringRefine: number | null;
    fpsP95DuringRefine: number | null;
    fpsMinDuringRefine: number | null;
    gsplatsAtClearM: number | null;
    jsHeapAtClearMb: number | null;
    vramTexAtClearMb: number | null;
    jsHeapPeakDuringRefineMb: number | null;
    vramTexPeakDuringRefineMb: number | null;
};

export type RefinementTickPayload = {
    pendingNodes: number;
    pendingPeakNodes: number;
    refinementRatio: number;
    ready: boolean;
    elapsedSincePeakMs: number | null;
    blurToClearMs: number | null;
};

export type RefinementSnapshot = {
    pendingNodes: number;
    refinementRatio: number;
    ready: boolean;
};

type ViewerLike = {
    octreeRefinementController?: OctreeRefinementController | null;
};

export function readGsplatsM(app: AppBase): number | null {
    const frame = (app.stats as { frame?: { gsplats?: number } })?.frame;
    const n = frame?.gsplats;
    return Number.isFinite(n) ? (n as number) / 1_000_000 : null;
}

/** PlayCanvas stats.drawCalls.total：本帧参与 gsplat compaction/绘制的 interval 数（≈ bake 并行度观测） */
export function readDrawCalls(app: AppBase): number | null {
    const n = (app.stats as { drawCalls?: { total?: number } })?.drawCalls?.total;
    return Number.isFinite(n) ? (n as number) : null;
}

/**
 * Work buffer 默认格式（GSplatFormat.createDefaultFormat）：
 * dataColor RGBA16F(8) + dataCenter RGBA32F(16) + dataScale RGBA16F(8) + dataRotation RGBA16F(8) = 40 B/splat。
 * 用于把「上传 slot 数」换成估算 MB（非引擎原生字节计数）。
 */
export const WORK_BUFFER_BYTES_PER_SPLAT_DEFAULT = 40;

export type GsplatBufferUploadMetrics = {
    /**
     * 引擎 `bufferCopyUploaded`：本帧各次 bake 累加的「上传块次数」。
     * 同帧 rebuild 多次时可能 **> totalBlocks**（copyPct>100 的来源）。
     */
    uploadedBlocks: number;
    /** 引擎 `bufferCopyTotal`：当时 allocationMap.size（唯一 alloc 块数） */
    totalBlocks: number;
    /** uploaded/total×100；可 >100（同帧多次 bake） */
    copyPct: number;
    /** min(uploaded,total)：去重后的块覆盖规模 */
    uniqueUploadBlocksEst: number;
    /** 同帧 bake 次数粗估 ≈ max(1, round(uploaded/total)) */
    bakePassesEst: number;
    /** 当前 allocationMap 全部 slot 数（active work buffer splat 容量） */
    activeSplatSlots: number;
    /**
     * 本帧估计写入的 splat-slot 次数：
     * slots ≈ activeSplatSlots × (uploaded/total)
     * （uploaded>total 时表示多趟全量/近似全量，可 > activeSplatSlots）
     */
    uploadSplatSlotsEst: number;
    /** uploadSplatSlotsEst × 40B，单位 MB */
    uploadMbEst: number;
    /**
     * 本帧估计写入 slot 数占 BlockAllocator.capacity 的比例（%）。
     * HUD 主指标：比 fullRebuild 计数更直观（「烤了多少 / 池子多大」）。
     */
    bakeCapacityPct: number;
    /**
     * 本帧 dirty MemBlock 数占 allocationMap 块数的比例（%）。
     * 仅 frameProfile 离线用；HUD 不展示（分母是活跃块数而非 buffer 容量，易误解）。
     */
    memBlockBakePct: number;
    /** 估算口径 */
    uploadEstMode: 'full_rebuild' | 'proportional' | 'none';
    /**
     * 本帧是否视作 fullRebuild / 近全表上传：
     * - engine：worldState.fullRebuild 或 workBufferRebuildRequired
     * - inferred：unique 覆盖 ≥95% total，或 uploaded>total
     */
    fullRebuild: boolean;
    fullRebuildSource: 'engine' | 'inferred' | 'none';
    /** 引擎最新 GSplatWorldState.fullRebuild（不含 inferred） */
    worldStateFullRebuild: boolean;
    /**
     * 本帧曾见 scene.gsplat.dirty 且 workBufferRebuildRequired 被置位
     * （B.1 回归：LOD sync 不应再走这条强制全量路径）
     */
    dirtyForcedWorkBufferRebuild: boolean;
    /** GSplatWorld._lastWorldStateVersion */
    worldStateVersion: number | null;
    /** GSplatWorld._currentVersion（render-ready） */
    currentVersion: number | null;
    /** 所有 octree instance 的 Σ currentLod（sync 推进指纹） */
    currentLodSum: number | null;
    /** BlockAllocator.capacity（splat slots）；可随 grow 上涨 */
    allocatorCapacity: number;
    /** BlockAllocator.usedSize */
    allocatorUsed: number;
    /** BlockAllocator.freeSize */
    allocatorFree: number;
    /** BlockAllocator.fragmentation∈[0,1] */
    fragmentation: number;
    /** work buffer 纹理边长 ≈ ceil(sqrt(capacity)) */
    textureSize: number;
    /** 设备 maxTextureSize；硬上限 capacity ≈ maxTextureSize² */
    maxTextureSize: number;
    /** 硬上限 slots = maxTextureSize²（纹理方形布局） */
    hardCapSlots: number;
    /** scene.gsplat.splatBudget；>0 时为软上限，亦决定初始 capacity≈budget×1.15 */
    splatBudget: number;
    /**
     * 引擎本帧计时（vendor `GSplatWorld._lastFrame*`）。
     * 用于拆开 `gapMs` 残差：高 gap && 高 bakeCpu → 数据面 bake；高 gap && 低 bakeCpu → 另处。
     */
    worldUpdateMs: number;
    placementIntegrateMs: number;
    /** rebuild/apply 中剔除 writeBuffer 后的 CPU（含排序 staging、splat.update 等） */
    bakeCpuMs: number;
    /** `_workBuffer.render` / `renderColor` 墙钟（可能含 GPU 同步） */
    writeBufferMs: number;
    /** 引擎累加的本帧 needsUpload / fullRebuild 块次数 */
    needsUploadBlocks: number;
    /** 对应 allocationMap 的 slot 合计（fullRebuild 时为全表 slots） */
    needsUploadSlots: number;
    /** 本帧 rebuild 路径曾见 engine fullRebuild（`_lastFrameFullRebuild`） */
    engineFrameFullRebuild: boolean;
};

type MemBlockLike = { size?: number };
type AllocatorLike = {
    capacity?: number;
    usedSize?: number;
    freeSize?: number;
    fragmentation?: number;
};
type WorldStateLike = { fullRebuild?: boolean };
type GsplatWorldLike = {
    bufferCopyUploaded?: number;
    bufferCopyTotal?: number;
    _allocationMap?: Map<number, MemBlockLike>;
    _allocator?: AllocatorLike;
    _worldStates?: Map<number, WorldStateLike>;
    _lastWorldStateVersion?: number;
    _currentVersion?: number;
    _workBufferRebuildRequired?: boolean;
    _octreeInstances?: Map<unknown, unknown>;
    _layerPlacements?: Array<{ resource?: { numSplats?: number } | null }>;
    _workBuffer?: { textureSize?: number };
    _budgetScale?: number;
    _lastFrameWorldUpdateMs?: number;
    _lastFramePlacementIntegrateMs?: number;
    _lastFrameBakeCpuMs?: number;
    _lastFrameWriteBufferMs?: number;
    _lastFrameNeedsUploadBlocks?: number;
    _lastFrameNeedsUploadSlots?: number;
    _lastFrameFullRebuild?: boolean;
};
type GsplatManagerLike = {
    bufferCopyUploaded?: number;
    bufferCopyTotal?: number;
    world?: GsplatWorldLike;
};
type GsplatDirectorLike = {
    camerasMap: Map<unknown, {
        layersMap: Map<unknown, {
            gsplatManager?: GsplatManagerLike | null;
            gsplatManagerShadow?: GsplatManagerLike | null;
        }>;
    }>;
};

function getGsplatDirector(app: AppBase): GsplatDirectorLike | null {
    return (app.renderer as unknown as { gsplatDirector?: GsplatDirectorLike }).gsplatDirector ?? null;
}

function sumAllocationSlots(map: Map<number, MemBlockLike> | undefined): number {
    if (!map?.size) {
        return 0;
    }
    let sum = 0;
    for (const block of map.values()) {
        const size = block?.size;
        if (Number.isFinite(size) && (size as number) > 0) {
            sum += size as number;
        }
    }
    return sum;
}

/** PlayCanvas 每帧 stats：`bufferCopyUploaded/total×100`，无 bake 时为 0（会清零）。 */
function readFrameGsplatBufferCopyPct(app: AppBase): number | null {
    const n = (app.stats as { frame?: { gsplatBufferCopy?: number } })?.frame?.gsplatBufferCopy;
    return Number.isFinite(n) && (n as number) >= 0 ? (n as number) : null;
}

function readWorldFullRebuild(world: GsplatWorldLike): boolean | null {
    const states = world._worldStates;
    if (!states?.size) {
        return null;
    }
    const version = world._lastWorldStateVersion ?? world._currentVersion;
    if (version !== undefined) {
        const state = states.get(version);
        if (state && typeof state.fullRebuild === 'boolean') {
            return state.fullRebuild;
        }
    }
    let any = false;
    let saw = false;
    for (const state of states.values()) {
        if (typeof state.fullRebuild === 'boolean') {
            saw = true;
            any = any || state.fullRebuild;
        }
    }
    return saw ? any : null;
}

function emptyBufferUploadMetrics(app?: AppBase): GsplatBufferUploadMetrics {
    const maxTex =
        (app?.graphicsDevice as { maxTextureSize?: number } | undefined)?.maxTextureSize ?? 0;
    const splatBudget =
        (app?.scene?.gsplat as { splatBudget?: number } | undefined)?.splatBudget ?? 0;
    return {
        uploadedBlocks: 0,
        totalBlocks: 0,
        copyPct: 0,
        uniqueUploadBlocksEst: 0,
        bakePassesEst: 0,
        activeSplatSlots: 0,
        uploadSplatSlotsEst: 0,
        uploadMbEst: 0,
        bakeCapacityPct: 0,
        memBlockBakePct: 0,
        uploadEstMode: 'none',
        fullRebuild: false,
        fullRebuildSource: 'none',
        worldStateFullRebuild: false,
        dirtyForcedWorkBufferRebuild: false,
        worldStateVersion: null,
        currentVersion: null,
        currentLodSum: null,
        allocatorCapacity: 0,
        allocatorUsed: 0,
        allocatorFree: 0,
        fragmentation: 0,
        textureSize: 0,
        maxTextureSize: maxTex,
        hardCapSlots: maxTex > 0 ? maxTex * maxTex : 0,
        splatBudget: Number.isFinite(splatBudget) ? splatBudget : 0,
        worldUpdateMs: 0,
        placementIntegrateMs: 0,
        bakeCpuMs: 0,
        writeBufferMs: 0,
        needsUploadBlocks: 0,
        needsUploadSlots: 0,
        engineFrameFullRebuild: false
    };
}

function roundMs1(value: number): number {
    return Math.round(value * 10) / 10;
}

export type ReadBufferUploadOptions = {
    /** 本帧曾观测到 scene.gsplat.dirty === true */
    dirtySeen?: boolean;
    /** 本帧曾观测到 world._workBufferRebuildRequired === true */
    workBufferRebuildSeen?: boolean;
    /** 仅 sync 窗口内才扫 currentLod（Poland 96k 全帧扫会压帧） */
    includeCurrentLodSum?: boolean;
};

function readCurrentLodSum(director: GsplatDirectorLike): number | null {
    let sum = 0;
    let saw = false;
    for (const cameraData of director.camerasMap.values()) {
        for (const layerData of cameraData.layersMap.values()) {
            for (const manager of [layerData.gsplatManager, layerData.gsplatManagerShadow]) {
                const instances = manager?.world?._octreeInstances;
                if (!instances) {
                    continue;
                }
                for (const inst of instances.values()) {
                    const infos = (inst as { nodeInfos?: Array<{ currentLod?: number }> }).nodeInfos;
                    if (!infos?.length) {
                        continue;
                    }
                    saw = true;
                    for (let i = 0; i < infos.length; i++) {
                        const lod = infos[i]?.currentLod;
                        if (typeof lod === 'number' && lod >= 0) {
                            sum += lod;
                        }
                    }
                }
            }
        }
    }
    return saw ? sum : null;
}

export type GsplatBudgetFillSnapshot = {
    /** scene.gsplat.splatBudget 名义上限 */
    splatBudget: number;
    /** 引擎 _enforceBudget 同构估算：budget − fixed − texture padding */
    adjustedBudget: number | null;
    /** Σ lods[optimalLod].count（balancer 后目标档点数） */
    optimalSplats: number | null;
    /** Σ lods[currentLod].count（实例当前选档点数；缺细档时会粗于 optimal） */
    currentSplats: number | null;
    /** 有 optimalLod≥0 的叶数 */
    optimalNodes: number;
    /** 有 currentLod≥0 的叶数 */
    currentNodes: number;
    /** 引擎 _budgetScale */
    budgetScale: number | null;
};

function padSlots(numSplats: number, textureWidth: number): number {
    if (!(textureWidth > 0) || !(numSplats > 0)) {
        return 0;
    }
    return (textureWidth - (numSplats % textureWidth)) % textureWidth;
}

function sumLodCountAt(
    nodes: Array<{ lods?: Array<{ count?: number }> }>,
    nodeInfos: Array<{ optimalLod?: number; currentLod?: number }>,
    which: 'optimal' | 'current'
): { splats: number; nodes: number } {
    let splats = 0;
    let count = 0;
    const n = Math.min(nodes.length, nodeInfos.length);
    for (let i = 0; i < n; i++) {
        const lodIndex = which === 'optimal' ? nodeInfos[i]?.optimalLod : nodeInfos[i]?.currentLod;
        if (typeof lodIndex !== 'number' || lodIndex < 0) {
            continue;
        }
        const c = nodes[i]?.lods?.[lodIndex]?.count;
        if (typeof c === 'number' && Number.isFinite(c) && c > 0) {
            splats += c;
            count++;
        }
    }
    return { splats, nodes: count };
}

/**
 * 读取引擎预算填充诊断（名义 bud / adjusted / Σoptimal / Σcurrent）。
 * adjusted 按 gsplat-world._enforceBudget 同构估算；须在 LOD/budget 更新后的帧采样。
 */
export function readGsplatBudgetFill(app: AppBase): GsplatBudgetFillSnapshot {
    const splatBudget =
        (app?.scene?.gsplat as { splatBudget?: number } | undefined)?.splatBudget ?? 0;
    const empty: GsplatBudgetFillSnapshot = {
        splatBudget: Number.isFinite(splatBudget) ? splatBudget : 0,
        adjustedBudget: null,
        optimalSplats: null,
        currentSplats: null,
        optimalNodes: 0,
        currentNodes: 0,
        budgetScale: null
    };
    const director = getGsplatDirector(app);
    if (!director) {
        return empty;
    }

    let optimalSplats = 0;
    let currentSplats = 0;
    let optimalNodes = 0;
    let currentNodes = 0;
    let sawLod = false;
    let adjustedBudget: number | null = null;
    let budgetScale: number | null = null;
    const seenWorlds = new Set<GsplatWorldLike>();

    for (const cameraData of director.camerasMap.values()) {
        for (const layerData of cameraData.layersMap.values()) {
            for (const manager of [layerData.gsplatManager, layerData.gsplatManagerShadow]) {
                const world = manager?.world;
                if (!world || seenWorlds.has(world)) {
                    continue;
                }
                seenWorlds.add(world);

                if (typeof world._budgetScale === 'number' && Number.isFinite(world._budgetScale)) {
                    budgetScale = world._budgetScale;
                }

                const textureWidth =
                    world._workBuffer?.textureSize ??
                    (typeof world._allocator?.capacity === 'number' && world._allocator.capacity > 0
                        ? Math.ceil(Math.sqrt(world._allocator.capacity))
                        : 0);

                if (empty.splatBudget > 0 && textureWidth > 0 && adjustedBudget === null) {
                    let fixedSplats = 0;
                    let paddingEstimate = 0;
                    const layerPlacements = world._layerPlacements;
                    if (layerPlacements?.length) {
                        for (let i = 0; i < layerPlacements.length; i++) {
                            const num = layerPlacements[i]?.resource?.numSplats ?? 0;
                            if (num > 0) {
                                fixedSplats += num;
                                paddingEstimate += padSlots(num, textureWidth);
                            }
                        }
                    }
                    const instances = world._octreeInstances;
                    if (instances) {
                        for (const inst of instances.values()) {
                            const active = (inst as {
                                activePlacements?: Set<{ resource?: { numSplats?: number } | null }>;
                            }).activePlacements;
                            if (!active) {
                                continue;
                            }
                            for (const placement of active) {
                                const num = placement?.resource?.numSplats ?? 0;
                                if (num > 0) {
                                    paddingEstimate += padSlots(num, textureWidth);
                                }
                            }
                        }
                    }
                    adjustedBudget = Math.max(1, empty.splatBudget - fixedSplats - paddingEstimate);
                }

                const instances = world._octreeInstances;
                if (!instances) {
                    continue;
                }
                for (const inst of instances.values()) {
                    const typed = inst as {
                        octree?: { nodes?: Array<{ lods?: Array<{ count?: number }> }> };
                        nodeInfos?: Array<{ optimalLod?: number; currentLod?: number }>;
                    };
                    const nodes = typed.octree?.nodes;
                    const infos = typed.nodeInfos;
                    if (!nodes?.length || !infos?.length) {
                        continue;
                    }
                    sawLod = true;
                    const opt = sumLodCountAt(nodes, infos, 'optimal');
                    const cur = sumLodCountAt(nodes, infos, 'current');
                    optimalSplats += opt.splats;
                    optimalNodes += opt.nodes;
                    currentSplats += cur.splats;
                    currentNodes += cur.nodes;
                }
            }
        }
    }

    return {
        splatBudget: empty.splatBudget,
        adjustedBudget,
        optimalSplats: sawLod ? optimalSplats : null,
        currentSplats: sawLod ? currentSplats : null,
        optimalNodes,
        currentNodes,
        budgetScale
    };
}

export function formatGsplatBudgetFill(snapshot: GsplatBudgetFillSnapshot): string {
    const fmtM = (v: number | null) =>
        v === null || !Number.isFinite(v) ? '—' : `${(v / 1e6).toFixed(2)}M`;
    const bud = snapshot.splatBudget > 0 ? fmtM(snapshot.splatBudget) : '0';
    const parts = [
        `cur ${fmtM(snapshot.currentSplats)}`,
        `opt ${fmtM(snapshot.optimalSplats)}`,
        `adj ${fmtM(snapshot.adjustedBudget)}`,
        `(bud ${bud})`
    ];
    if (
        snapshot.optimalSplats != null &&
        snapshot.adjustedBudget != null &&
        snapshot.adjustedBudget > 0
    ) {
        const pct = (100 * snapshot.optimalSplats) / snapshot.adjustedBudget;
        parts.push(`opt/adj ${pct.toFixed(0)}%`);
    }
    if (
        snapshot.currentSplats != null &&
        snapshot.optimalSplats != null &&
        snapshot.optimalSplats > 0
    ) {
        const pct = (100 * snapshot.currentSplats) / snapshot.optimalSplats;
        parts.push(`cur/opt ${pct.toFixed(0)}%`);
    }
    if (snapshot.budgetScale != null && Math.abs(snapshot.budgetScale - 1) > 0.02) {
        parts.push(`×${snapshot.budgetScale.toFixed(2)}`);
    }
    return parts.join(' · ');
}

/**
 * 读取引擎真实的 work-buffer block 上传计数、allocator 容量与 fullRebuild 信号。
 * 须在 manager.update / frameend 之后采样（与 frame-profiler 一致）。
 */
export function readGsplatBufferUploadMetrics(
    app: AppBase,
    options?: ReadBufferUploadOptions
): GsplatBufferUploadMetrics {
    const empty = emptyBufferUploadMetrics(app);
    const director = getGsplatDirector(app);
    if (!director) {
        const pct = (app.stats as { frame?: { gsplatBufferCopy?: number } })?.frame?.gsplatBufferCopy;
        if (Number.isFinite(pct)) {
            return { ...empty, copyPct: Math.round((pct as number) * 10) / 10 };
        }
        return empty;
    }

    let uploadedBlocks = 0;
    let totalBlocks = 0;
    let activeSplatSlots = 0;
    let allocatorCapacity = 0;
    let allocatorUsed = 0;
    let allocatorFree = 0;
    let fragmentation = 0;
    let engineFullRebuild: boolean | null = null;
    let worldStateFullRebuild = false;
    let workBufferRebuildRequired = false;
    let worldStateVersion: number | null = null;
    let currentVersion: number | null = null;
    let worldUpdateMs = 0;
    let placementIntegrateMs = 0;
    let bakeCpuMs = 0;
    let writeBufferMs = 0;
    let needsUploadBlocks = 0;
    let needsUploadSlots = 0;
    let engineFrameFullRebuild = false;
    const seenWorlds = new Set<GsplatWorldLike>();

    for (const cameraData of director.camerasMap.values()) {
        for (const layerData of cameraData.layersMap.values()) {
            for (const manager of [layerData.gsplatManager, layerData.gsplatManagerShadow]) {
                if (!manager) {
                    continue;
                }
                const world = manager.world;
                // 多 camera/layer 会挂同一 world：block 计数只累加一次，避免放大上百倍
                if (world) {
                    if (seenWorlds.has(world)) {
                        continue;
                    }
                    seenWorlds.add(world);
                    uploadedBlocks += world.bufferCopyUploaded ?? manager.bufferCopyUploaded ?? 0;
                    totalBlocks += world.bufferCopyTotal ?? manager.bufferCopyTotal ?? 0;
                    worldUpdateMs += world._lastFrameWorldUpdateMs ?? 0;
                    placementIntegrateMs += world._lastFramePlacementIntegrateMs ?? 0;
                    bakeCpuMs += world._lastFrameBakeCpuMs ?? 0;
                    writeBufferMs += world._lastFrameWriteBufferMs ?? 0;
                    needsUploadBlocks += world._lastFrameNeedsUploadBlocks ?? 0;
                    needsUploadSlots += world._lastFrameNeedsUploadSlots ?? 0;
                    engineFrameFullRebuild =
                        engineFrameFullRebuild || world._lastFrameFullRebuild === true;
                    activeSplatSlots += sumAllocationSlots(world._allocationMap);
                    const alloc = world._allocator;
                    if (alloc) {
                        allocatorCapacity += alloc.capacity ?? 0;
                        allocatorUsed += alloc.usedSize ?? 0;
                        allocatorFree += alloc.freeSize ?? 0;
                        fragmentation = Math.max(fragmentation, alloc.fragmentation ?? 0);
                    }
                    const fr = readWorldFullRebuild(world);
                    if (fr !== null) {
                        engineFullRebuild = engineFullRebuild === null ? fr : engineFullRebuild || fr;
                        worldStateFullRebuild = worldStateFullRebuild || fr;
                    }
                    if (world._workBufferRebuildRequired) {
                        engineFullRebuild = true;
                        workBufferRebuildRequired = true;
                    }
                    if (typeof world._lastWorldStateVersion === 'number') {
                        worldStateVersion =
                            worldStateVersion === null
                                ? world._lastWorldStateVersion
                                : Math.max(worldStateVersion, world._lastWorldStateVersion);
                    }
                    if (typeof world._currentVersion === 'number') {
                        currentVersion =
                            currentVersion === null
                                ? world._currentVersion
                                : Math.max(currentVersion, world._currentVersion);
                    }
                } else {
                    uploadedBlocks += manager.bufferCopyUploaded ?? 0;
                    totalBlocks += manager.bufferCopyTotal ?? 0;
                }
            }
        }
    }

    // world.bufferCopy* 在部分引擎版本无 bake 帧不清零；以 stats.frame.gsplatBufferCopy 为本帧是否 upload
    const frameCopyPct = readFrameGsplatBufferCopyPct(app);
    const frameHadBufferUpload =
        frameCopyPct !== null ? frameCopyPct > 0 : uploadedBlocks > 0;
    if (!frameHadBufferUpload) {
        uploadedBlocks = 0;
    } else if (uploadedBlocks <= 0 && totalBlocks > 0 && frameCopyPct !== null && frameCopyPct > 0) {
        uploadedBlocks = Math.max(1, Math.round((totalBlocks * frameCopyPct) / 100));
    }

    const copyPct = !frameHadBufferUpload
        ? 0
        : totalBlocks > 0 && uploadedBlocks > 0
            ? (uploadedBlocks / totalBlocks) * 100
            : frameCopyPct ?? 0;
    const uniqueUploadBlocksEst =
        totalBlocks > 0 ? Math.min(uploadedBlocks, totalBlocks) : uploadedBlocks;
    const bakePassesEst =
        totalBlocks > 0 && uploadedBlocks > 0
            ? Math.max(1, Math.round(uploadedBlocks / totalBlocks))
            : uploadedBlocks > 0
                ? 1
                : 0;
    const coverage =
        totalBlocks > 0 && uploadedBlocks > 0 ? uniqueUploadBlocksEst / totalBlocks : 0;
    const nearlyAllBlocks = coverage >= 0.95 || uploadedBlocks > totalBlocks;

    let uploadSplatSlotsEst = 0;
    let uploadEstMode: GsplatBufferUploadMetrics['uploadEstMode'] = 'none';
    if (uploadedBlocks > 0 && activeSplatSlots > 0 && totalBlocks > 0) {
        // uploaded/total 可 >1：同帧多趟 bake，按「写出次数」估 slot 流量
        uploadSplatSlotsEst = Math.round(activeSplatSlots * (uploadedBlocks / totalBlocks));
        uploadEstMode = nearlyAllBlocks ? 'full_rebuild' : 'proportional';
    } else if (uploadedBlocks > 0 && activeSplatSlots > 0) {
        uploadSplatSlotsEst = activeSplatSlots;
        uploadEstMode = 'full_rebuild';
    }

    let fullRebuild = false;
    let fullRebuildSource: GsplatBufferUploadMetrics['fullRebuildSource'] = 'none';
    if (engineFullRebuild === true) {
        fullRebuild = true;
        fullRebuildSource = 'engine';
        if (uploadEstMode === 'none' && activeSplatSlots > 0) {
            uploadEstMode = 'full_rebuild';
            uploadSplatSlotsEst = activeSplatSlots;
        }
    } else if (nearlyAllBlocks && uploadedBlocks >= 1) {
        fullRebuild = true;
        fullRebuildSource = 'inferred';
    } else if (engineFullRebuild === false) {
        fullRebuild = false;
        fullRebuildSource = 'engine';
    }

    const uploadMbEst =
        Math.round(((uploadSplatSlotsEst * WORK_BUFFER_BYTES_PER_SPLAT_DEFAULT) / (1024 * 1024)) * 100) / 100;
    const bakeCapacityPct =
        allocatorCapacity > 0 && uploadSplatSlotsEst > 0
            ? Math.round((uploadSplatSlotsEst / allocatorCapacity) * 1000) / 10
            : 0;
    const memBlockBakePct =
        totalBlocks > 0 && uniqueUploadBlocksEst > 0
            ? Math.round((uniqueUploadBlocksEst / totalBlocks) * 1000) / 10
            : 0;
    const textureSize = allocatorCapacity > 0 ? Math.ceil(Math.sqrt(allocatorCapacity)) : 0;

    const dirtySeen = options?.dirtySeen === true;
    const workBufferRebuildSeen =
        options?.workBufferRebuildSeen === true || workBufferRebuildRequired;
    const dirtyForcedWorkBufferRebuild = dirtySeen && workBufferRebuildSeen;

    return {
        uploadedBlocks,
        totalBlocks,
        copyPct: Math.round(copyPct * 10) / 10,
        uniqueUploadBlocksEst,
        bakePassesEst,
        activeSplatSlots,
        uploadSplatSlotsEst,
        uploadMbEst,
        bakeCapacityPct,
        memBlockBakePct,
        uploadEstMode,
        fullRebuild,
        fullRebuildSource,
        worldStateFullRebuild,
        dirtyForcedWorkBufferRebuild,
        worldStateVersion,
        currentVersion,
        currentLodSum: options?.includeCurrentLodSum ? readCurrentLodSum(director) : null,
        allocatorCapacity,
        allocatorUsed,
        allocatorFree,
        fragmentation: Math.round(fragmentation * 1000) / 1000,
        textureSize,
        maxTextureSize: empty.maxTextureSize,
        hardCapSlots: empty.hardCapSlots,
        splatBudget: empty.splatBudget,
        worldUpdateMs: roundMs1(worldUpdateMs),
        placementIntegrateMs: roundMs1(placementIntegrateMs),
        bakeCpuMs: roundMs1(bakeCpuMs),
        writeBufferMs: roundMs1(writeBufferMs),
        needsUploadBlocks,
        needsUploadSlots,
        engineFrameFullRebuild
    };
}

/** HUD / 会话累计：在刷新循环里喂每帧 metrics */
export type BufferUploadSessionStats = {
    frames: number;
    uploadFrames: number;
    peakUploadMbEst: number;
    peakBakeCapacityPct: number;
    lastUploadMbEst: number;
    lastBakeCapacityPct: number;
    lastCopyPct: number;
};

export function createBufferUploadSessionStats(): BufferUploadSessionStats {
    return {
        frames: 0,
        uploadFrames: 0,
        peakUploadMbEst: 0,
        peakBakeCapacityPct: 0,
        lastUploadMbEst: 0,
        lastBakeCapacityPct: 0,
        lastCopyPct: 0
    };
}

export function accumulateBufferUploadSession(
    stats: BufferUploadSessionStats,
    m: GsplatBufferUploadMetrics
): void {
    stats.frames += 1;
    stats.lastCopyPct = m.copyPct;
    stats.lastUploadMbEst = m.uploadMbEst;
    stats.lastBakeCapacityPct = m.bakeCapacityPct;
    if (m.uploadedBlocks > 0 || m.uploadMbEst > 0) {
        stats.uploadFrames += 1;
        stats.peakUploadMbEst = Math.max(stats.peakUploadMbEst, m.uploadMbEst);
        stats.peakBakeCapacityPct = Math.max(stats.peakBakeCapacityPct, m.bakeCapacityPct);
    }
}

export function readJsHeapUsedMB(): number | null {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const n = mem?.usedJSHeapSize;
    return Number.isFinite(n) ? (n as number) / (1024 * 1024) : null;
}

export function readVramTexMB(app: AppBase): number | null {
    const vram = (app.stats as { vram?: { tex?: number } })?.vram;
    const n = vram?.tex;
    return Number.isFinite(n) ? (n as number) / (1024 * 1024) : null;
}

export class BenchmarkMemoryTracker {
    private jsHeapPeak: number | null = null;
    private vramTexPeak: number | null = null;

    constructor(private readonly app: AppBase) {}

    sample(): void {
        const js = readJsHeapUsedMB();
        const vram = readVramTexMB(this.app);
        if (js !== null) {
            this.jsHeapPeak = this.jsHeapPeak === null ? js : Math.max(this.jsHeapPeak, js);
        }
        if (vram !== null) {
            this.vramTexPeak = this.vramTexPeak === null ? vram : Math.max(this.vramTexPeak, vram);
        }
    }

    current(): { jsHeapUsedMb: number | null; vramTexMb: number | null } {
        return {
            jsHeapUsedMb: readJsHeapUsedMB(),
            vramTexMb: readVramTexMB(this.app)
        };
    }

    peaks(): { jsHeapPeakMb: number | null; vramTexPeakMb: number | null } {
        return {
            jsHeapPeakMb: this.jsHeapPeak,
            vramTexPeakMb: this.vramTexPeak
        };
    }
}

export function percentile(values: number[], p: number): number | null {
    if (!values.length) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
}

export function getRefinementController(global: Global): OctreeRefinementController | null {
    const viewer = (global.app as { viewer?: ViewerLike }).viewer;
    return viewer?.octreeRefinementController ?? null;
}

export function readRefinementTickMetrics(global: Global): OctreeRefinementTickMetrics | null {
    return getRefinementController(global)?.getLastTickMetrics() ?? null;
}

export type RuntimeLodPlacementSnapshot = {
    /** entity 上生效的 d0（含 scale-align / meta 缩放后） */
    lodBaseDistance: number | null;
    lodMultiplier: number | null;
    lodBehindPenalty: number | null;
    /** settings 配置 d0；scale-align 调试有值时带上 */
    configuredD0: number | null;
    /** scale-align 合成 scale；无对齐时 null */
    alignScale: number | null;
};

type LodScaleAlignDebugLike = {
    configuredD0?: number;
    effectiveD0?: number;
    scale?: number;
};

/**
 * 读运行时选档米制：entity.gsplat.lodBaseDistance/Multiplier + scene.gsplat.lodBehindPenalty。
 * 优先名为 `gsplat` 的 entity，否则取首个带 lodBaseDistance 的 gsplat 组件。
 */
export function readRuntimeLodPlacement(global: Global): RuntimeLodPlacementSnapshot {
    const sceneGsplat = global.app.scene.gsplat as { lodBehindPenalty?: unknown } | undefined;
    const behindRaw = sceneGsplat?.lodBehindPenalty;
    const lodBehindPenalty =
        typeof behindRaw === 'number' && Number.isFinite(behindRaw) ? behindRaw : null;

    type GsplatLodComp = {
        lodBaseDistance?: unknown;
        lodMultiplier?: unknown;
    };

    const root = global.app.root as {
        findByName?: (name: string) => { gsplat?: GsplatLodComp | null } | null;
        findComponents?: (name: string) => GsplatLodComp[];
    };

    let comp: GsplatLodComp | null =
        root.findByName?.('gsplat')?.gsplat ?? null;

    if (!comp && typeof root.findComponents === 'function') {
        const comps = root.findComponents('gsplat') ?? [];
        for (let i = 0; i < comps.length; i++) {
            const c = comps[i];
            if (typeof c?.lodBaseDistance === 'number' && Number.isFinite(c.lodBaseDistance)) {
                comp = c;
                break;
            }
        }
    }

    const d0Raw = comp?.lodBaseDistance;
    const multRaw = comp?.lodMultiplier;
    const lodBaseDistance =
        typeof d0Raw === 'number' && Number.isFinite(d0Raw) ? d0Raw : null;
    const lodMultiplier =
        typeof multRaw === 'number' && Number.isFinite(multRaw) ? multRaw : null;

    const align = (globalThis as { __lodScaleAlignDebug?: LodScaleAlignDebugLike }).__lodScaleAlignDebug;
    const configuredD0 =
        typeof align?.configuredD0 === 'number' && Number.isFinite(align.configuredD0)
            ? align.configuredD0
            : null;
    const alignScale =
        typeof align?.scale === 'number' && Number.isFinite(align.scale) && align.scale > 1
            ? align.scale
            : null;

    return {
        lodBaseDistance,
        lodMultiplier,
        lodBehindPenalty,
        configuredD0,
        alignScale
    };
}

/** HUD 短串：d0 / ×m / behind；若有对齐则附 cfg 与 scale */
export function formatRuntimeLodPlacement(snapshot: RuntimeLodPlacementSnapshot): string {
    const fmt = (v: number | null, digits = 2) =>
        v === null ? '—' : (Number.isInteger(v) ? String(v) : v.toFixed(digits));
    const d0 = snapshot.lodBaseDistance;
    const d0Str =
        d0 !== null && d0 < 10 ? d0.toFixed(2) : fmt(d0, 1);
    let text = `${d0Str} / ${fmt(snapshot.lodMultiplier, 1)} / ${fmt(snapshot.lodBehindPenalty, 1)}`;
    if (
        snapshot.configuredD0 !== null &&
        snapshot.lodBaseDistance !== null &&
        Math.abs(snapshot.configuredD0 - snapshot.lodBaseDistance) > 1e-3
    ) {
        const scaleHint =
            snapshot.alignScale !== null ? ` · ×${snapshot.alignScale.toFixed(2)}` : '';
        text += ` (cfg ${fmt(snapshot.configuredD0, 1)}${scaleHint})`;
    }
    return text;
}

function formatHudMs(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
        return '0';
    }
    return value < 10 ? value.toFixed(1) : value.toFixed(0);
}

/** benchmarkHud 调度指标区块 HTML */
export function renderRefinementTickMetricsHtml(metrics: OctreeRefinementTickMetrics): string {
    const row = (label: string, value: string) =>
        `<div class="benchmark-hud-row"><span class="benchmark-hud-label">${label}</span><span class="benchmark-hud-value">${value}</span></div>`;
    const { timingsMs } = metrics;
    const lines: string[] = [
        '<div class="benchmark-hud-section-title">Scheduler tick (≠ frame)</div>',
        row('Scan mode', metrics.scanMode),
        row(
            'Tick ms',
            `${formatHudMs(timingsMs.total)} (scan ${formatHudMs(timingsMs.scan)} · q ${formatHudMs(timingsMs.queue)} · sync ${formatHudMs(timingsMs.sync)})`
        ),
        row('Cand refs', `${metrics.candidateFileRefs} · uniq ${metrics.candidateUniqueFiles}`),
        row(
            'Stale LOD',
            `${metrics.staleLodNodes}待升 · ${metrics.staleLoadedNodes}已下未上 · ${metrics.lodDisplayMismatch}引擎差` +
                ` (放宽${metrics.lodMismatchEdgeRelax}/更细${metrics.lodMismatchFiner}` +
                `/外缘${metrics.lodMismatchViewportEdge}/其它${metrics.lodMismatchOther})` +
                ` · ctr↓${metrics.centerEngineBehindNodes}` +
                (metrics.centerBehindNoEngine > 0 ? `(无引擎${metrics.centerBehindNoEngine})` : '') +
                (metrics.centerTargetNodes > 0
                    ? ` · 细档${metrics.centerClearNodes}/${metrics.centerTargetNodes}`
                    : '') +
                (metrics.centerBehindSamples?.length
                    ? ` [${metrics.centerBehindSamples
                        .map((s) =>
                            s.reason === 'no_engine'
                                ? `n${s.nodeIndex}:cur${s.currentLod}/eng-`
                                : `n${s.nodeIndex}:cur${s.currentLod}→eng${s.engineOptimalLod}` +
                                  (s.fileIndex >= 0
                                      ? ` f${s.fileIndex}${s.fileLoaded ? '✓' : '✗'}`
                                      : '')
                        )
                        .join(' · ')}]`
                    : '')
        ),
        row(
            'Ladder',
            `ctr×${metrics.ladderCenterJumpSteps} · edge×${metrics.ladderEdgeJumpSteps}` +
                (metrics.ladderBacklog
                    ? ` · backlog (fg ${metrics.stableForegroundPending}≥${metrics.ladderBacklogThreshold})`
                    : ` · fg ${metrics.stableForegroundPending}`)
        ),
        row('Burst', `${metrics.cameraBurstFrames} fr${metrics.boostActive ? ' · boost' : ''}`),
        row(
            'Downloads',
            `${metrics.inFlight} fly · q${metrics.queueLen} · susp ${metrics.suspended}` +
                (metrics.priorityDownloadsActive && metrics.staleInFlight > 0
                    ? ` · stale ${metrics.staleInFlight}`
                    : '') +
                (metrics.downloadFailed > 0
                    ? ` · fail ${metrics.downloadFailed}(backoff ${metrics.downloadBackoff}/perm ${metrics.downloadPermanent})`
                    : '')
        )
    ];
    return lines.join('');
}

/** 只读观测：不触发 refinement 调度 */
export function readRefinementSnapshot(global: Global): RefinementSnapshot {
    const controller = getRefinementController(global);
    if (!controller) {
        return { pendingNodes: 0, refinementRatio: 1, ready: true };
    }
    const status = controller.getStreamingRefinementStatus();
    return {
        pendingNodes: status.pendingNodes,
        refinementRatio: status.refinementRatio,
        ready: status.ready
    };
}

export async function waitForRefinementClear(
    global: Global,
    caseMemoryTracker?: BenchmarkMemoryTracker
): Promise<RefinementWaitResult> {
    const arrivalSnapshot = readRefinementSnapshot(global);
    const fpsSamples: number[] = [];
    let stableObservations = 0;
    let blurToClearMs: number | null = null;
    let ratioAtClear: number | null = null;
    let gsplatsAtClearM: number | null = null;
    let jsHeapAtClearMb: number | null = null;
    let vramTexAtClearMb: number | null = null;
    const loopStartMs = performance.now();
    const refineMemory = new BenchmarkMemoryTracker(global.app);

    let peakPending = arrivalSnapshot.pendingNodes;
    let peakPendingAtMs = loopStartMs;

    const emitTick = (snapshot: RefinementSnapshot, blurMs: number | null) => {
        const elapsedSincePeak =
            blurMs !== null
                ? blurMs
                : peakPending > 0
                    ? performance.now() - peakPendingAtMs
                    : null;
        global.events.fire('sceneProfileBenchmark:refineTick', {
            pendingNodes: snapshot.pendingNodes,
            pendingPeakNodes: peakPending,
            refinementRatio: snapshot.refinementRatio,
            ready: snapshot.ready,
            elapsedSincePeakMs: elapsedSincePeak,
            blurToClearMs: blurMs
        } satisfies RefinementTickPayload);
    };

    return new Promise((resolve) => {
        const onObserve = () => {
            const now = performance.now();
            const fps = global.app.stats.frame.fps;
            if (Number.isFinite(fps) && fps > 0) {
                fpsSamples.push(fps);
            }

            refineMemory.sample();
            caseMemoryTracker?.sample();

            const snapshot = readRefinementSnapshot(global);

            if (snapshot.pendingNodes > peakPending) {
                peakPending = snapshot.pendingNodes;
                peakPendingAtMs = now;
            }

            const isClear =
                snapshot.pendingNodes === 0 &&
                snapshot.refinementRatio >= REFINEMENT_CLEAR_RATIO &&
                snapshot.ready;

            if (isClear) {
                stableObservations++;
            } else {
                stableObservations = 0;
            }

            if (stableObservations >= REFINEMENT_STABLE_OBSERVATIONS && blurToClearMs === null) {
                blurToClearMs = peakPending > 0 ? now - peakPendingAtMs : 0;
                ratioAtClear = snapshot.refinementRatio;
                gsplatsAtClearM = readGsplatsM(global.app);
                jsHeapAtClearMb = readJsHeapUsedMB();
                vramTexAtClearMb = readVramTexMB(global.app);
                emitTick(snapshot, blurToClearMs);
            } else if (blurToClearMs === null) {
                emitTick(snapshot, null);
            }

            if (blurToClearMs !== null || now - loopStartMs >= REFINEMENT_TIMEOUT_MS) {
                window.clearInterval(observeTimer);
                const refinePeaks = refineMemory.peaks();
                resolve({
                    blurToClearMs,
                    refineTimedOut: blurToClearMs === null,
                    pendingNodesAtArrival: arrivalSnapshot.pendingNodes,
                    pendingPeakNodes: peakPending,
                    refinementRatioAtClear: ratioAtClear,
                    fpsP50DuringRefine: percentile(fpsSamples, 0.5),
                    fpsP95DuringRefine: percentile(fpsSamples, 0.95),
                    fpsMinDuringRefine: fpsSamples.length ? Math.min(...fpsSamples) : null,
                    gsplatsAtClearM,
                    jsHeapAtClearMb,
                    vramTexAtClearMb,
                    jsHeapPeakDuringRefineMb: refinePeaks.jsHeapPeakMb,
                    vramTexPeakDuringRefineMb: refinePeaks.vramTexPeakMb
                });
            }
        };

        const observeTimer = window.setInterval(onObserve, BENCHMARK_OBSERVE_MS);
        onObserve();
    });
}
