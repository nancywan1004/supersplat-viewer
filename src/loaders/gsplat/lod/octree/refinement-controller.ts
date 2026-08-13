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
import {
    DEFAULT_LOD_BASE_DISTANCE,
    DEFAULT_LOD_MULTIPLIER,
    resolveLodRenderScale,
    resolveLodRenderScaleFoveation,
    resolveLodSelectMode
} from '../scene-profile';
import { getOctreeBootstrapLod, isOctreeBootstrapPlaceableNode } from './lod-meta';
import {
    buildLeafRepDiameterTable,
    computeEffectiveRenderScale,
    computeFilePriority,
    computeFoveateFactor,
    computePixelFactor,
    computeScreenDiameter,
    computeViewAngleDeg,
    computeVisualUrgency,
    mergeVisualBudgetLod,
    resolveVerticalFovRad,
    selectRenderScaleLodFromDiameters,
    type LeafRepDiameterTable,
    type LodRenderScaleFoveationParams
} from './lod-render-scale';
import {
    findAllOctreeInstances,
    requestOctreeLodUpdate,
    requestOctreePlacementUpdate,
    type OctreeInstanceLike
} from './octree-instance-access';
import {
    buildOofCameraMats,
    configureLodStabilizers,
    dripOutOfFrustumDowngrade,
    ensureOutOfFrustumDowngradePatches
} from './out-of-frustum-downgrade';
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
        /**
         * 中央 / 边缘分界（edgeFactor）。
         * ≥ 此值：中央（收条统计 + 一次跳到目标档）；< 此值：边缘（仍追 optimal，ladder 降优先）。
         * 不再用于「边缘放宽一档目标」。
         */
        edgeRelaxOptimal: 0.45,
        /** 下载分对 edgeFactor 的幂次：边缘权重大幅低于中央（降优先，不是不追） */
        centerScorePower: 5.0,
        /**
         * 视锥外缘（AABB edgeFactor≤0）仍允许入队的最低权重。
         * 过去直接 skip 会导致引擎已为这些叶留了细档预算却永不下载 → cur 顶不满 budget。
         */
        edgeOuterDownloadFloor: 0.08
    },
    ladder: {
        coarsestStepBoost: 2.75,
        stepBoost: 1.6,
        /** stableForeground pending ≥ 此值：边缘升档用 edgeBacklogJumpSteps */
        backlogPending: 12,
        /** 视野中央：每轮最多跳档数（edgeFactor ≥ edgeRelaxOptimal） */
        centerJumpSteps: 2,
        /** 视野边缘：仍追 engineOptimal，但每轮跳档更慢（降优先） */
        edgeJumpSteps: 1,
        /** 视野边缘且前景积压时跳档；极大值≈直达目标档 */
        edgeBacklogJumpSteps: 3
    },
    burst: {
        moveFrames: 18,
        zoomFrames: 36,
        unlockFrames: 48,
        /**
         * 已下未上时的 drip 间隔（帧）。
         * 节流 bake，但有 stale 就持续 sync，避免长时间画面无变化。
         * 同帧赋值后会 -1，故 1 ≈ 每帧 sync，2 ≈ 隔一帧再 sync。
         */
        progressiveSyncInterval: 1
    },
    /**
     * 引擎 GSplatAssetLoader 耗尽 maxRetries 后，asset.loaded 仍为 true → load() 永久早退，pending 卡死。
     * 此处做外层 backoff 再试；超过 maxOuterAttempts 标永久失败，从 pending/收条剔除。
     */
    downloadFail: {
        /** 覆盖引擎默认 maxRetries（含首次共 N+1 次） */
        engineMaxRetries: 3,
        /** 引擎耗尽后的外层再试轮数 */
        maxOuterAttempts: 3,
        /** 各外层轮次的等待 ms */
        backoffMs: [2000, 5000, 12000] as const
    },
    /**
     * 初始加载 BootstrapFast：视锥内（中央+边缘）先追 visualTarget=engineOptimal+steps，
     * finalize 后再追满 engineOptimal。URL `?bootstrapCoarsenSteps=N`（0 关）。
     */
    bootstrapCoarsen: {
        defaultSteps: 2
    }
};

/** config/URL → 有效 coarsen 步数；未设用默认 2；0=关闭 */
function resolveBootstrapCoarsenSteps(configSteps: number | undefined): number {
    if (configSteps !== undefined && Number.isFinite(configSteps)) {
        return Math.max(0, Math.min(8, Math.floor(configSteps)));
    }
    return T.bootstrapCoarsen.defaultSteps;
}

export type OctreeRefinePhase = 'bootFast' | 'polish';

type LoaderConcurrencyTunables = {
    defaultConcurrent: number;
    boostConcurrent: number;
    burstConcurrent: number;
    emergencyConcurrent: number;
    extremeConcurrent: number;
    foregroundLimit: number;
    criticalLimit: number;
    pinLimit: number;
    trackedMissFrames: number;
    trackedLimit: number;
};

const LOADER_CONCURRENCY_DEFAULTS: LoaderConcurrencyTunables = { ...T.loader };

/**
 * URL/config `maxConcurrent`：把 boost 与动态开槽上限都锁到 N，便于网速对照。
 * 未设置时恢复平台默认（desktop boost=8，堵槽时可升到 extreme）。
 */
function applyMaxConcurrentOverride(raw: number | undefined): number | null {
    const loader = T.loader as LoaderConcurrencyTunables;
    Object.assign(loader, LOADER_CONCURRENCY_DEFAULTS);
    if (raw === undefined || !Number.isFinite(raw) || raw < 1) {
        return null;
    }
    const n = Math.min(64, Math.max(1, Math.floor(raw)));
    loader.boostConcurrent = n;
    loader.burstConcurrent = n;
    loader.emergencyConcurrent = n;
    loader.extremeConcurrent = n;
    // criticalLimit 用于 stale 开槽公式；锁并发时勿超过 N
    loader.criticalLimit = Math.min(LOADER_CONCURRENCY_DEFAULTS.criticalLimit, n);
    return n;
}

/** URL `?ladder=center,edge,backlog` 覆盖；backlog=`target` 表示积压边缘直达目标档 */
type LadderJumpOverride = {
    centerJumpSteps: number;
    edgeJumpSteps: number;
    /** null = 直达目标（jumpSteps 用极大值） */
    edgeBacklogJumpSteps: number | null;
};

let ladderJumpOverride: LadderJumpOverride | null = null;
/** 上次解析的 `?ladder=` 原文；同页换 URL 时需重解析（warm start） */
let ladderJumpOverrideRaw: string | null | undefined;

function parseLadderJumpOverride(): LadderJumpOverride | null {
    let raw: string | null = null;
    try {
        raw = new URLSearchParams(window.location.search).get('ladder');
    } catch {
        raw = null;
    }
    if (raw === ladderJumpOverrideRaw) {
        return ladderJumpOverride;
    }
    ladderJumpOverrideRaw = raw;
    if (!raw) {
        ladderJumpOverride = null;
        return null;
    }
    try {
        const parts = raw.split(',').map((s) => s.trim());
        if (parts.length < 3) {
            console.warn('[octree-refinement] ladder URL 需 3 段：center,edge,backlog 例如 2,3,target');
            ladderJumpOverride = null;
            return null;
        }
        const center = Number(parts[0]);
        const edge = Number(parts[1]);
        const backlogRaw = parts[2].toLowerCase();
        const backlogTarget = backlogRaw === 'target' || backlogRaw === 'max';
        const backlog = backlogTarget ? null : Number(backlogRaw);
        if (!Number.isFinite(center) || center < 1 || !Number.isFinite(edge) || edge < 1) {
            console.warn('[octree-refinement] ladder center/edge 须为正整数', raw);
            ladderJumpOverride = null;
            return null;
        }
        if (!backlogTarget && (!Number.isFinite(backlog) || (backlog as number) < 1)) {
            console.warn('[octree-refinement] ladder backlog 须为正整数或 target', raw);
            ladderJumpOverride = null;
            return null;
        }
        ladderJumpOverride = {
            centerJumpSteps: Math.floor(center),
            edgeJumpSteps: Math.floor(edge),
            edgeBacklogJumpSteps: backlogTarget ? null : Math.floor(backlog as number)
        };
        console.info('[octree-refinement] ladder override', {
            ...ladderJumpOverride,
            edgeBacklogJumpSteps: backlogTarget ? 'target' : ladderJumpOverride.edgeBacklogJumpSteps
        });
        return ladderJumpOverride;
    } catch {
        ladderJumpOverride = null;
        return null;
    }
}

function resolveLadderCenterJumpSteps(): number {
    return parseLadderJumpOverride()?.centerJumpSteps ?? T.ladder.centerJumpSteps;
}

function resolveLadderEdgeJumpSteps(pendingBacklog: boolean): number {
    const ov = parseLadderJumpOverride();
    if (!ov) {
        return pendingBacklog ? T.ladder.edgeBacklogJumpSteps : T.ladder.edgeJumpSteps;
    }
    if (!pendingBacklog) {
        return ov.edgeJumpSteps;
    }
    // null = 直达目标：用足够大的步数，由 computeRefinementTargetLod 的 max(relaxed, current-steps) 落到目标
    return ov.edgeBacklogJumpSteps ?? 64;
}

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
    maxRetries?: number;
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

/** 单文件：引擎重试耗尽后的外层失败状态 */
type DownloadFailEntry = {
    outerAttempts: number;
    nextRetryAtMs: number;
    permanent: boolean;
    phase: 'backoff' | 'retrying' | 'permanent';
};

type DownloadFailMap = Map<number, DownloadFailEntry>;

function isExhaustedFailedAsset(loader: OctreeAssetLoaderLike, url: string): boolean {
    const asset = loader._urlToAsset?.get(url);
    if (!asset?.loaded) {
        return false;
    }
    if (loader.getResource?.(url)) {
        return false;
    }
    if (loader._currentlyLoading?.has(url)) {
        return false;
    }
    return true;
}

function downloadFailBlocksPending(entry: DownloadFailEntry | undefined): boolean {
    return !!entry && (entry.permanent || entry.phase === 'backoff');
}

function countDownloadFailStats(failures: DownloadFailMap): {
    downloadFailed: number;
    downloadBackoff: number;
    downloadPermanent: number;
} {
    let downloadBackoff = 0;
    let downloadPermanent = 0;
    for (const entry of failures.values()) {
        if (entry.permanent || entry.phase === 'permanent') {
            downloadPermanent++;
        } else if (entry.phase === 'backoff') {
            downloadBackoff++;
        }
    }
    return {
        downloadFailed: downloadBackoff + downloadPermanent,
        downloadBackoff,
        downloadPermanent
    };
}

/**
 * 检测引擎重试耗尽；在 backoff 到期后 unload 清掉假 loaded，再允许外层重下。
 * 返回本拍是否触发了至少一次外层重试。
 */
function reconcileDownloadFailures(
    octree: OctreeLike,
    loader: OctreeAssetLoaderLike | null | undefined,
    fileIndices: number[],
    failures: DownloadFailMap,
    nowMs: number
): boolean {
    let retried = false;
    const seen = new Set<number>();

    for (let i = 0; i < fileIndices.length; i++) {
        const fi = fileIndices[i];
        if (seen.has(fi)) {
            continue;
        }
        seen.add(fi);

        if (octree.getFileResource(fi)) {
            failures.delete(fi);
            continue;
        }

        const url = octree.files[fi]?.url;
        if (!url || !loader) {
            continue;
        }

        const prev = failures.get(fi);

        if (prev?.permanent || prev?.phase === 'permanent') {
            continue;
        }

        if (prev?.phase === 'backoff') {
            if (nowMs < prev.nextRetryAtMs) {
                continue;
            }
            // 清假 loaded，否则 load() 永久早退
            if (typeof loader.unload === 'function') {
                loader.unload(url);
            } else {
                const asset = loader._urlToAsset?.get(url);
                if (asset) {
                    asset.loaded = false;
                    asset.loading = false;
                }
                loader._currentlyLoading?.delete(url);
                loader._retryCount?.delete(url);
            }
            prev.phase = 'retrying';
            retried = true;
            continue;
        }

        if (!isExhaustedFailedAsset(loader, url)) {
            continue;
        }

        // 引擎耗尽：首次或 retrying 后又挂
        const outerAttempts = (prev?.outerAttempts ?? 0) + 1;
        const permanent = outerAttempts >= T.downloadFail.maxOuterAttempts;
        const backoffIdx = Math.min(outerAttempts - 1, T.downloadFail.backoffMs.length - 1);
        failures.set(fi, {
            outerAttempts,
            nextRetryAtMs: permanent
                ? Number.POSITIVE_INFINITY
                : nowMs + T.downloadFail.backoffMs[backoffIdx],
            permanent,
            phase: permanent ? 'permanent' : 'backoff'
        });
    }

    return retried;
}

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
};

export type { OctreeLike };

export type GSplatOctreeResourceLike = {
    octree?: OctreeLike | null;
    /** lod-meta 原始 data（tree 已被引擎置 null；可含 leafRepScale） */
    data?: unknown;
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
    /** 视锥内 currentLod ≠ engine optimalLod 的 node 数（抖动诊断；不含视锥外） */
    lodDisplayMismatch: number;
    /** 引擎差归因：边缘区仍粗一档（诊断；目标已不再放宽，此项通常归入「其它」路径） */
    lodMismatchEdgeRelax: number;
    /** 引擎差归因：比引擎目标更细 */
    lodMismatchFiner: number;
    /** 引擎差归因：有 score 但 edgeFactor≤0（不进下载队） */
    lodMismatchViewportEdge: number;
    /** 引擎差归因：其余（含中央仍粗等） */
    lodMismatchOther: number;
    /**
     * 中央区仍粗于 / 等待引擎目标的 node 数（诊断 / HUD ctr↓）。
     * 含 engineOptimal<0；不含「引擎要了某档但该叶无文件」。
     * 首屏收条改看 clear/target 比例，不再要求本值归零。
     */
    centerEngineBehindNodes: number;
    /** 其中：中央已上屏但引擎尚未写出 optimalLod */
    centerBehindNoEngine: number;
    /** 中央可统计叶（已上屏且引擎目标档有文件） */
    centerTargetNodes: number;
    /** 其中 currentLod ≤ 当前有效目标（BootstrapFast=visualTarget；否则 engineOptimal） */
    centerClearNodes: number;
    /** ctr↓ 样本（最多 3）：便于定位是哪一叶 */
    centerBehindSamples: CenterBehindSample[];
    needsLodSwitch: boolean;
    staleLodNodes: number;
    /** renderScale 本拍写回钳制叶数 */
    renderScaleClampedNodes: number;
    /** 本拍入队文件的 visualUrgency 均值（仅 renderScale） */
    avgVisualUrgency: number;
};

export type CenterBehindSample = {
    nodeIndex: number;
    currentLod: number;
    engineOptimalLod: number;
    edgeFactor: number;
    targetLod: number;
    fileIndex: number;
    fileLoaded: boolean;
    reason: 'no_engine' | 'coarser';
};

export type LodPlacementParams = {
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

type RenderScaleLodSample = {
    renderScaleLod: number;
    engineOptimalLod: number;
    targetLod: number;
    effective: number;
    distance: number;
};

type RenderScaleTickStats = {
    n: number;
    /** targetLod !== engineOptimalLod（合并后写回改变了引擎档） */
    mergedChanged: number;
    /** renderScaleLod > engineOptimalLod：视觉目标更粗，clamp 抬粗 */
    visualCoarser: number;
    /** engineOptimalLod > renderScaleLod：引擎/budget 更粗，视觉想更细但被挡住 */
    engineCoarser: number;
    /** 两者相等 */
    equal: number;
    /** 各档计数：index = lod */
    histRenderScaleLod: number[];
    histEngineOptimalLod: number[];
    histTargetLod: number[];
    meanRenderScaleLod: number;
    meanEngineOptimalLod: number;
    meanTargetLod: number;
    meanDeltaTargetMinusEngine: number;
};

type RenderScaleEvalState = {
    enabled: boolean;
    baseRenderScale: number;
    foveation: LodRenderScaleFoveationParams;
    table: LeafRepDiameterTable;
    scratchDiameters: Float32Array;
    lastClampedNodes: number;
    /**
     * applyLodChanges 补丁在 merge 前写入的引擎档（-1=尚未采到）。
     * scan 读 nodeInfo.optimalLod 可能已是上帧 target，采样/合并应优先用此缓冲。
     */
    lastEngineOptimalByLeaf: Int16Array;
    /** 仅 buildPriorityFiles scan 期间为 true，避免 applyLodChanges 补丁污染样本 */
    samplingEnabled: boolean;
    /** 本拍 clamp 样本（视锥内叶）；scan 开头清空 */
    lastTickSamples: RenderScaleLodSample[];
    lastTickStats: RenderScaleTickStats | null;
    /** 最近一次 full scan 的局部相机；供 applyLodChanges 补丁使用 */
    cameraLocal: {
        px: number;
        py: number;
        pz: number;
        fwx: number;
        fwy: number;
        fwz: number;
    } | null;
    pixelFactor: number;
};

function emptyRenderScaleTickStats(lodLevels: number): RenderScaleTickStats {
    const hist = () => new Array(Math.max(1, lodLevels)).fill(0);
    return {
        n: 0,
        mergedChanged: 0,
        visualCoarser: 0,
        engineCoarser: 0,
        equal: 0,
        histRenderScaleLod: hist(),
        histEngineOptimalLod: hist(),
        histTargetLod: hist(),
        meanRenderScaleLod: 0,
        meanEngineOptimalLod: 0,
        meanTargetLod: 0,
        meanDeltaTargetMinusEngine: 0
    };
}

function summarizeRenderScaleSamples(
    samples: RenderScaleLodSample[],
    lodLevels: number
): RenderScaleTickStats {
    const stats = emptyRenderScaleTickStats(lodLevels);
    if (samples.length === 0) {
        return stats;
    }
    let sumRs = 0;
    let sumEng = 0;
    let sumTgt = 0;
    let sumDelta = 0;
    for (const s of samples) {
        stats.n++;
        sumRs += s.renderScaleLod;
        sumEng += s.engineOptimalLod;
        sumTgt += s.targetLod;
        sumDelta += s.targetLod - s.engineOptimalLod;
        if (s.targetLod !== s.engineOptimalLod) {
            stats.mergedChanged++;
        }
        if (s.renderScaleLod > s.engineOptimalLod) {
            stats.visualCoarser++;
        } else if (s.engineOptimalLod > s.renderScaleLod) {
            stats.engineCoarser++;
        } else {
            stats.equal++;
        }
        const bump = (hist: number[], lod: number) => {
            const i = Math.max(0, Math.min(hist.length - 1, lod | 0));
            hist[i]++;
        };
        bump(stats.histRenderScaleLod, s.renderScaleLod);
        bump(stats.histEngineOptimalLod, s.engineOptimalLod);
        bump(stats.histTargetLod, s.targetLod);
    }
    const n = stats.n;
    stats.meanRenderScaleLod = sumRs / n;
    stats.meanEngineOptimalLod = sumEng / n;
    stats.meanTargetLod = sumTgt / n;
    stats.meanDeltaTargetMinusEngine = sumDelta / n;
    return stats;
}

type RefinementEvaluateContext = {
    scene: OctreeStreamingScene;
    gsplat: GsplatSceneLike;
    lod: LodPlacementParams;
    /** false 时不安装/不执行视锥外降档（URL ?oofDowngrade=0） */
    oofDowngradeEnabled: boolean;
    /** 同视角防抖：视锥内只许变清不许变糊；默认 true。?lodViewHold=0 关 */
    lodViewHoldEnabled: boolean;
    /** 初始加载 BootstrapFast：视锥内相对 engineOptimal 放粗 */
    bootstrapCoarsenActive: boolean;
    /** 放粗档数；0 表示关闭 */
    bootstrapCoarsenSteps: number;
    /** lodSelectMode=renderScale 时非 null；默认 distance 为 null */
    renderScale: RenderScaleEvalState | null;
};

/**
 * BootstrapFast：相对 engineOptimal 放粗（LOD 越大越粗）。
 * polish / 关闭时原样返回 engineOptimal。
 */
function resolveEffectiveOptimalLod(
    engineOptimalLod: number,
    maxLod: number,
    ctx: Pick<RefinementEvaluateContext, 'bootstrapCoarsenActive' | 'bootstrapCoarsenSteps'>
): number {
    if (
        engineOptimalLod < 0 ||
        !ctx.bootstrapCoarsenActive ||
        !(ctx.bootstrapCoarsenSteps > 0)
    ) {
        return engineOptimalLod;
    }
    return Math.min(maxLod, engineOptimalLod + ctx.bootstrapCoarsenSteps);
}

function lodParamsFromComponent(component: GSplatComponent | null): LodPlacementParams {
    return {
        lodBaseDistance: component?.lodBaseDistance ?? DEFAULT_LOD_BASE_DISTANCE,
        lodMultiplier: component?.lodMultiplier ?? DEFAULT_LOD_MULTIPLIER
    };
}

/** 每次 full scan 重读组件，避免创建时冻结导致改 gsplat.lod* 无效 */
function refreshEvalLodParams(ctx: RefinementEvaluateContext): LodPlacementParams {
    const lod = lodParamsFromComponent(ctx.scene.gsplatEntity.gsplat as GSplatComponent | null);
    ctx.lod = lod;
    return lod;
}

function fillScratchRepDiameters(
    table: LeafRepDiameterTable,
    nodeIndex: number,
    scratch: Float32Array
): void {
    const { lodLevels, diameters } = table;
    const base = nodeIndex * lodLevels;
    for (let lod = 0; lod < lodLevels; lod++) {
        scratch[lod] = diameters[base + lod];
    }
}

/**
 * 用屏幕尺寸目标钳制引擎 optimalLod（只允许变粗）。
 * 返回 merge 前后分项；写回 nodeInfo.optimalLod = targetLod。
 * `engineOptimalOverride`：scan 时传入 applyLodChanges 保存的纯引擎档，避免读到已 merge 的写回值。
 */
function applyRenderScaleClampToNode(
    nodeInfo: { optimalLod: number },
    args: {
        nodeIndex: number;
        maxLod: number;
        actualDistance: number;
        leafCenterX: number;
        leafCenterY: number;
        leafCenterZ: number;
        cameraPosX: number;
        cameraPosY: number;
        cameraPosZ: number;
        cameraFwdX: number;
        cameraFwdY: number;
        cameraFwdZ: number;
        pixelFactor: number;
        state: RenderScaleEvalState;
        engineOptimalOverride?: number;
    }
): {
    targetLod: number;
    renderScaleLod: number;
    engineOptimalLod: number;
    effective: number;
} {
    const rawEngine =
        args.engineOptimalOverride !== undefined && args.engineOptimalOverride >= 0
            ? args.engineOptimalOverride
            : nodeInfo.optimalLod;
    const budgetOptimalLod = Math.max(0, Math.min(args.maxLod, rawEngine));
    const { state } = args;
    fillScratchRepDiameters(state.table, args.nodeIndex, state.scratchDiameters);
    const viewAngleDeg = computeViewAngleDeg(
        args.leafCenterX,
        args.leafCenterY,
        args.leafCenterZ,
        args.cameraPosX,
        args.cameraPosY,
        args.cameraPosZ,
        args.cameraFwdX,
        args.cameraFwdY,
        args.cameraFwdZ
    );
    const foveate = computeFoveateFactor(viewAngleDeg, state.foveation);
    const effective = computeEffectiveRenderScale(state.baseRenderScale, foveate);
    const renderScaleLod = selectRenderScaleLodFromDiameters(
        state.scratchDiameters.subarray(0, state.table.lodLevels),
        args.pixelFactor,
        args.actualDistance,
        effective
    );
    const visualBudgetLod = mergeVisualBudgetLod(renderScaleLod, budgetOptimalLod);
    if (visualBudgetLod !== nodeInfo.optimalLod) {
        state.lastClampedNodes++;
    }
    nodeInfo.optimalLod = visualBudgetLod;
    return {
        targetLod: visualBudgetLod,
        renderScaleLod,
        engineOptimalLod: budgetOptimalLod,
        effective
    };
}

type OctreeInstanceApplyPatched = OctreeInstanceLike & {
    applyLodChanges?: (maxLod: number, params: unknown) => void;
    __renderScaleApplyPatched?: boolean;
    __originalApplyLodChanges?: (maxLod: number, params: unknown) => void;
};

/** 在引擎 applyLodChanges 前钳制 optimalLod，使上屏与下载一致 */
function ensureRenderScaleApplyPatch(
    inst: OctreeInstanceLike | null,
    getState: () => RenderScaleEvalState | null,
    boundsFlat: Float32Array
): void {
    const patched = inst as OctreeInstanceApplyPatched | null;
    if (!patched?.applyLodChanges || patched.__renderScaleApplyPatched) {
        return;
    }
    patched.__originalApplyLodChanges = patched.applyLodChanges.bind(patched);
    patched.applyLodChanges = (maxLod: number, params: unknown) => {
        const state = getState();
        const cam = state?.cameraLocal;
        const pf = state?.pixelFactor ?? 0;
        if (state?.enabled && cam && pf > 0 && patched.nodeInfos?.length) {
            state.lastClampedNodes = 0;
            for (let i = 0; i < patched.nodeInfos.length; i++) {
                const info = patched.nodeInfos[i];
                if (!info || info.optimalLod < 0) {
                    continue;
                }
                // merge 前快照：此时 nodeInfo 仍是引擎刚写出的 budget/distance 档
                if (i < state.lastEngineOptimalByLeaf.length) {
                    state.lastEngineOptimalByLeaf[i] = info.optimalLod;
                }
                const b = i * 6;
                const minX = boundsFlat[b];
                const maxX = boundsFlat[b + 3];
                const minY = boundsFlat[b + 1];
                const maxY = boundsFlat[b + 4];
                const minZ = boundsFlat[b + 2];
                const maxZ = boundsFlat[b + 5];
                let qx = cam.px;
                if (qx < minX) qx = minX;
                else if (qx > maxX) qx = maxX;
                let qy = cam.py;
                if (qy < minY) qy = minY;
                else if (qy > maxY) qy = maxY;
                let qz = cam.pz;
                if (qz < minZ) qz = minZ;
                else if (qz > maxZ) qz = maxZ;
                const dx = qx - cam.px;
                const dy = qy - cam.py;
                const dz = qz - cam.pz;
                applyRenderScaleClampToNode(info, {
                    nodeIndex: i,
                    maxLod,
                    actualDistance: Math.sqrt(dx * dx + dy * dy + dz * dz),
                    leafCenterX: (minX + maxX) * 0.5,
                    leafCenterY: (minY + maxY) * 0.5,
                    leafCenterZ: (minZ + maxZ) * 0.5,
                    cameraPosX: cam.px,
                    cameraPosY: cam.py,
                    cameraPosZ: cam.pz,
                    cameraFwdX: cam.fwx,
                    cameraFwdY: cam.fwy,
                    cameraFwdZ: cam.fwz,
                    pixelFactor: pf,
                    state
                });
            }
        }
        return patched.__originalApplyLodChanges?.(maxLod, params);
    };
    patched.__renderScaleApplyPatched = true;
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

type OctreeGpuSyncJob = {
    octree: OctreeLike;
    gsplatEntity: Entity;
};

/**
 * 历史：WebGPU 曾在 frameend 推迟 inst.update。
 * 现改走 world.requestOctreePlacementUpdate()，由 world.update 同拍轮询；保留队列清理供 destroy。
 */
const deferredOctreeGpuSyncJobs = new WeakMap<AppBase, OctreeGpuSyncJob[]>();

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

/**
 * 同一渲染帧内每个 octree 只允许真正执行一次 sync。
 * 必须在 bootstrap（controller start 前）也能按帧清空，不能依赖 refinement controller 的 frameupdate。
 */
const syncedOctreesThisFrameByApp = new WeakMap<AppBase, WeakSet<object>>();
/** 已为该 app 绑定「按真实帧」清空 sync 去重集合 */
const syncDedupFrameBoundApps = new WeakSet<AppBase>();

function clearSyncedOctreesThisFrame(app: AppBase): void {
    syncedOctreesThisFrameByApp.set(app, new WeakSet<object>());
}

/**
 * 首次 sync 即绑定 frameupdate：bootstrap 阶段也能跨帧重新放行 sync。
 */
function ensureSyncDedupFrameBound(app: AppBase): void {
    if (syncDedupFrameBoundApps.has(app)) {
        return;
    }
    syncDedupFrameBoundApps.add(app);
    app.on('frameupdate', () => {
        clearSyncedOctreesThisFrame(app);
    });
}

function hasSyncedOctreeThisFrame(app: AppBase, octree: OctreeLike): boolean {
    ensureSyncDedupFrameBound(app);
    return syncedOctreesThisFrameByApp.get(app)?.has(octree as object) === true;
}

function markSyncedOctreeThisFrame(app: AppBase, octree: OctreeLike): void {
    ensureSyncDedupFrameBound(app);
    let set = syncedOctreesThisFrameByApp.get(app);
    if (!set) {
        set = new WeakSet<object>();
        syncedOctreesThisFrameByApp.set(app, set);
    }
    set.add(octree as object);
}

export type RefinementSyncTrigger =
    | 'burst_lod_switch'
    | 'file_landed_lod'
    | 'stale_limit'
    | 'stale_cooldown'
    | 'post_download'
    | 'file_landed_fallback'
    | 'frame_ready_loading_drop';

export type RefinementFrameProfile = {
    syncedInstances: number;
    syncTriggers: RefinementSyncTrigger[];
    frameReadySync: boolean;
};

const frameProfileByApp = new WeakMap<AppBase, RefinementFrameProfile>();
const lastDeferredInstUpdateMsByApp = new WeakMap<AppBase, number>();

function ensureFrameProfile(app: AppBase): RefinementFrameProfile {
    let profile = frameProfileByApp.get(app);
    if (!profile) {
        profile = { syncedInstances: 0, syncTriggers: [], frameReadySync: false };
        frameProfileByApp.set(app, profile);
    }
    return profile;
}

function recordFrameSync(app: AppBase, trigger: RefinementSyncTrigger, count: number): void {
    if (count <= 0) {
        return;
    }
    const profile = ensureFrameProfile(app);
    profile.syncedInstances += count;
    profile.syncTriggers.push(trigger);
}

/** 每帧 frameupdate 重置；frameend 前累积 tick / frame:ready sync */
export function resetRefinementFrameProfile(app: AppBase): void {
    ensureSyncDedupFrameBound(app);
    frameProfileByApp.set(app, { syncedInstances: 0, syncTriggers: [], frameReadySync: false });
    clearSyncedOctreesThisFrame(app);
}

export function readRefinementFrameProfile(app: AppBase): RefinementFrameProfile {
    return frameProfileByApp.get(app) ?? { syncedInstances: 0, syncTriggers: [], frameReadySync: false };
}

/** 新路径恒为 0（不再 frameend deferred inst.update） */
export function readLastDeferredInstUpdateMs(app: AppBase): number {
    return lastDeferredInstUpdateMsByApp.get(app) ?? 0;
}

function trackSyncOctreePendingPlacements(
    app: AppBase,
    trigger: RefinementSyncTrigger,
    octree: OctreeLike,
    gsplatEntity: Entity,
    gsplatScene: GsplatSceneLike,
    markSceneDirty = false
): number {
    const count = syncOctreePendingPlacements(app, octree, gsplatEntity, gsplatScene, markSceneDirty);
    recordFrameSync(app, trigger, count);
    return count;
}

function syncOctreePendingPlacements(
    app: AppBase,
    octree: OctreeLike,
    gsplatEntity: Entity,
    gsplatScene: GsplatSceneLike,
    markSceneDirty = false
) {
    if (hasSyncedOctreeThisFrame(app, octree)) {
        // 同帧已 sync：保留 render 请求即可，勿重复 placement update
        app.renderNextFrame = true;
        return 0;
    }
    markSyncedOctreeThisFrame(app, octree);

    // 1) 强制下一拍 fullUpdate + applyLodChanges（否则预下载已落地也切不上屏）
    // 2) placement 轮询：处理 pendingDecrements / 增量 bake
    const lodCount = requestOctreeLodUpdate(app, octree);
    const worldCount = requestOctreePlacementUpdate(app, octree);
    const instanceCount = findAllOctreeInstances(app, octree, gsplatEntity).length;
    const count = Math.max(lodCount, worldCount, instanceCount);

    // 仅真实结构变化才允许 markSceneDirty（默认 false；LOD sync 不得 scene-wide rebuild）
    if (markSceneDirty) {
        gsplatScene.dirty = true;
    }
    app.renderNextFrame = true;
    return count;
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
    _lastScoreMinX = minX;
    _lastScoreMinY = minY;
    _lastScoreMinZ = minZ;
    _lastScoreMaxX = maxX;
    _lastScoreMaxY = maxY;
    _lastScoreMaxZ = maxZ;

    if (!aabbIntersectsFrustum(frustum, minX, minY, minZ, maxX, maxY, maxZ)) {
        return 0;
    }

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
 * separate 资产逐档升 LOD：当前比 optimal 粗时按 jumpSteps 逼近目标。
 * BootstrapFast 时 optimal 为 visualTarget；否则为 engineOptimal（renderScale 下已钳制）。
 * distance：中央/边缘差异只在 jumpSteps 与下载 score；renderScale 中央可一次到位。
 */
function computeRefinementTargetLod(
    optimalLod: number,
    maxLod: number,
    currentLod: number,
    _edgeFactor: number,
    jumpSteps = 1
): number {
    const target = Math.max(0, Math.min(maxLod, optimalLod));

    if (currentLod >= 0 && currentLod > target) {
        const steps = Math.max(1, jumpSteps | 0);
        return Math.max(target, currentLod - steps);
    }
    return target;
}

/** 中央 jump；边缘更慢 / 积压时加速（或 URL ladder 覆盖） */
function resolveLadderJumpSteps(edgeFactor: number, pendingBacklog: boolean): number {
    if (edgeFactor >= T.viewport.edgeRelaxOptimal) {
        return resolveLadderCenterJumpSteps();
    }
    return resolveLadderEdgeJumpSteps(pendingBacklog);
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

function countMissingUniqueFiles(
    octree: OctreeLike,
    files: PrioritizedFile[],
    options?: { ignoreFile?: (fileIndex: number) => boolean }
): number {
    let count = 0;
    for (let i = 0; i < files.length; i++) {
        const fi = files[i].fileIndex;
        if (options?.ignoreFile?.(fi)) {
            continue;
        }
        if (!octree.getFileResource(fi)) {
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
    /** 中央细档上屏比例 clear/target；无 target 时为 0 */
    refinementRatio: number;
    pendingUniqueFiles: number;
    staleLodNodes: number;
    /** 中央区仍粗于 / 等待引擎目标的 node 数 */
    centerEngineBehindNodes: number;
    /** 中央可统计叶（已上屏且引擎目标档有文件） */
    centerTargetNodes: number;
    /** 其中 currentLod ≤ 当前有效目标（BootstrapFast=visualTarget） */
    centerClearNodes: number;
    /** post-download settle 剩余帧；>0 时勿收条（否则 settle 结束会再涌一轮 pending） */
    settlingFrames: number;
    /** refinement 拍号（每 runPriorityPrefetch +1） */
    tickSeq: number;
    /** 全清：pending=0 且 ctr↓=0（benchmark clear） */
    ready: boolean;
    /** bootFast=初始加载粗档收条；polish=追满 engineOptimal */
    refinePhase: OctreeRefinePhase;
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
            centerEngineBehindNodes: 0,
            centerTargetNodes: 0,
            centerClearNodes: 0,
            settlingFrames: 0,
            tickSeq: 0,
            ready: true,
            refinePhase: 'polish'
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
            centerEngineBehindNodes: 0,
            centerTargetNodes: 0,
            centerClearNodes: 0,
            settlingFrames: 0,
            tickSeq: 0,
            ready: false,
            refinePhase: 'polish'
        };
    }

    const batch = buildPriorityFiles({
        scene,
        gsplat: app.scene.gsplat as GsplatSceneLike,
        lod: lodParamsFromComponent(gsplatEntity.gsplat as GSplatComponent | null),
        oofDowngradeEnabled: true,
        lodViewHoldEnabled: true,
        bootstrapCoarsenActive: false,
        bootstrapCoarsenSteps: 0,
        renderScale: null
    });

    const pendingForeground = batch.foregroundPendingUnique;
    const pendingUnique = batch.pendingUniqueFiles;
    const staleLoaded = batch.staleLoadedNodes;
    const staleLod = batch.staleLodNodes;
    const centerBehind = batch.centerEngineBehindNodes;
    const centerTarget = batch.centerTargetNodes;
    const centerClear = batch.centerClearNodes;
    const ready = pendingForeground === 0 && centerBehind === 0;
    const needsWork = pendingForeground + staleLod + centerBehind;
    const refinementRatio =
        centerTarget > 0 ? Math.max(0, Math.min(1, centerClear / centerTarget)) : ready ? 1 : 0;

    return {
        visibleNodes: needsWork,
        refinedNodes: needsWork === 0 ? 1 : 0,
        pendingNodes: pendingForeground,
        staleLoadedNodes: staleLoaded,
        refinementRatio,
        pendingUniqueFiles: pendingUnique,
        staleLodNodes: staleLod,
        centerEngineBehindNodes: centerBehind,
        centerTargetNodes: centerTarget,
        centerClearNodes: centerClear,
        settlingFrames: 0,
        tickSeq: 0,
        ready,
        refinePhase: 'polish'
    };
}

export function syncStreamingOctreePlacements(scene: OctreeStreamingScene): number {
    const { app, octree, gsplatEntity } = scene;
    const gsplatScene = app.scene.gsplat as GsplatSceneLike;
    // bootstrap / viewport sync：只推 LOD，不 scene-wide dirty
    return syncOctreePendingPlacements(app, octree, gsplatEntity, gsplatScene, false);
}

function buildPriorityFiles(
    ctx: RefinementEvaluateContext,
    options?: {
        pendingBacklog?: boolean;
        /** 下载失败/backoff：不计入 pending；永久失败时中央追档也不堵完成 */
        downloadFailures?: DownloadFailMap;
    }
): PrioritizedBatch {
    const pendingBacklog = options?.pendingBacklog === true;
    const downloadFailures = options?.downloadFailures;
    const isFailBlocked = (fi: number) =>
        downloadFailBlocksPending(downloadFailures?.get(fi));
    const isPermanentFail = (fi: number) => {
        const e = downloadFailures?.get(fi);
        return !!(e?.permanent || e?.phase === 'permanent');
    };
    // jumpSteps 按叶 edgeFactor 在循环内 resolveLadderJumpSteps
    const { scene, gsplat } = ctx;
    // 热更新 lod 参数（align 写回 entity）；下载目标本身只跟 engineOptimal
    refreshEvalLodParams(ctx);
    const { app, octree, gsplatEntity, cameraEntity } = scene;
    const maxLod = octree.lodLevels - 1;
    const camera = cameraEntity.camera;
    const emptyBatch = (): PrioritizedBatch => ({
        files: [],
        pendingUniqueFiles: 0,
        foregroundPendingUnique: 0,
        criticalPendingUnique: 0,
        staleLoadedNodes: 0,
        lodDisplayMismatch: 0,
        lodMismatchEdgeRelax: 0,
        lodMismatchFiner: 0,
        lodMismatchViewportEdge: 0,
        lodMismatchOther: 0,
        centerEngineBehindNodes: 0,
        centerBehindNoEngine: 0,
        centerTargetNodes: 0,
        centerClearNodes: 0,
        centerBehindSamples: [],
        needsLodSwitch: false,
        staleLodNodes: 0,
        renderScaleClampedNodes: 0,
        avgVisualUrgency: 0
    });
    if (!camera || maxLod < 0) {
        return emptyBatch();
    }

    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
    const inst = instances[0] ?? null;
    const nodeInfos = inst?.nodeInfos;
    if (ctx.oofDowngradeEnabled || ctx.lodViewHoldEnabled) {
        // apply 前：同视角 hold +（可选）视锥外降档
        for (let i = 0; i < instances.length; i++) {
            ensureOutOfFrustumDowngradePatches(instances[i], () => buildOofCameraMats(cameraEntity, gsplatEntity));
        }
    }

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

    const px = localCameraPos.x;
    const py = localCameraPos.y;
    const pz = localCameraPos.z;
    const fwx = localCameraFwd.x;
    const fwy = localCameraFwd.y;
    const fwz = localCameraFwd.z;
    const lodBehindPenalty = gsplat.lodBehindPenalty ?? 1;
    const boundsFlat = octree.nodeBoundsMinMax;

    const rsState = ctx.renderScale;
    let pixelFactor = 0;
    if (rsState?.enabled) {
        rsState.lastClampedNodes = 0;
        rsState.lastTickSamples.length = 0;
        rsState.lastTickStats = null;
        rsState.samplingEnabled = true;
        const verticalFovRad = resolveVerticalFovRad(
            camera.fov,
            camera.aspectRatio,
            !!camera.horizontalFov
        );
        const viewportHeight =
            (app.graphicsDevice as { height?: number } | undefined)?.height ??
            (app.graphicsDevice as { canvas?: HTMLCanvasElement } | undefined)?.canvas?.height ??
            1080;
        pixelFactor = computePixelFactor(viewportHeight, verticalFovRad);
        rsState.pixelFactor = pixelFactor;
        rsState.cameraLocal = { px, py, pz, fwx, fwy, fwz };
        ensureRenderScaleApplyPatch(inst, () => ctx.renderScale, boundsFlat);
    }

    const prioritized: PrioritizedFile[] = [];
    let needsLodSwitch = false;
    let staleLodNodes = 0;
    let staleLoadedNodes = 0;
    let lodDisplayMismatch = 0;
    let lodMismatchEdgeRelax = 0;
    let lodMismatchFiner = 0;
    let lodMismatchViewportEdge = 0;
    let lodMismatchOther = 0;
    let centerEngineBehindNodes = 0;
    let centerBehindNoEngine = 0;
    let centerTargetNodes = 0;
    let centerClearNodes = 0;
    const centerBehindSamples: CenterBehindSample[] = [];
    let visualUrgencySum = 0;
    let visualUrgencyCount = 0;

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
        const nodeInfo = nodeInfos?.[nodeIndex];
        const currentLod = nodeInfo?.currentLod ?? -1;
        let engineOptimalLod = nodeInfo?.optimalLod ?? -1;
        const node = octree.nodes[nodeIndex];

        // renderScale：视觉目标与预算取 max（更粗），写回 optimalLod
        let rsClamp: {
            targetLod: number;
            renderScaleLod: number;
            engineOptimalLod: number;
            effective: number;
        } | null = null;
        if (
            rsState?.enabled &&
            nodeInfo &&
            engineOptimalLod >= 0 &&
            pixelFactor > 0
        ) {
            const engOverride =
                nodeIndex < rsState.lastEngineOptimalByLeaf.length
                    ? rsState.lastEngineOptimalByLeaf[nodeIndex]
                    : -1;
            rsClamp = applyRenderScaleClampToNode(nodeInfo, {
                nodeIndex,
                maxLod,
                actualDistance,
                leafCenterX: (minX + maxX) * 0.5,
                leafCenterY: (minY + maxY) * 0.5,
                leafCenterZ: (minZ + maxZ) * 0.5,
                cameraPosX: px,
                cameraPosY: py,
                cameraPosZ: pz,
                cameraFwdX: fwx,
                cameraFwdY: fwy,
                cameraFwdZ: fwz,
                pixelFactor,
                state: rsState,
                engineOptimalOverride: engOverride
            });
            engineOptimalLod = rsClamp.targetLod;
        }

        // 评分 urgency：有引擎目标则用之，否则按最粗档降低抢队（不再本地算 rawOptimal）
        const scoreLodHint = engineOptimalLod >= 0 ? engineOptimalLod : maxLod;
        const score = scoreVisibleNode(
            _frustum,
            worldTransform,
            boundsFlat,
            nodeIndex,
            fovAdjustedDistance,
            scoreLodHint,
            maxLod,
            worldCameraPos,
            worldCameraFwd
        );
        if (score <= 0) {
            continue;
        }

        // 仅视锥内叶计入 LOD 统计（engineOptimal = merge 前读到的档）
        if (rsState?.samplingEnabled && rsClamp) {
            rsState.lastTickSamples.push({
                renderScaleLod: rsClamp.renderScaleLod,
                engineOptimalLod: rsClamp.engineOptimalLod,
                targetLod: rsClamp.targetLod,
                effective: rsClamp.effective,
                distance: actualDistance
            });
        }

        const edgeFactor = computeViewportAabbEdgeFactor(
            _viewProj,
            _lastScoreMinX,
            _lastScoreMinY,
            _lastScoreMinZ,
            _lastScoreMaxX,
            _lastScoreMaxY,
            _lastScoreMaxZ
        );

        // 视锥内引擎差 + 归因（须先有 edgeFactor）
        if (currentLod >= 0 && engineOptimalLod >= 0 && currentLod !== engineOptimalLod) {
            lodDisplayMismatch++;
            if (edgeFactor <= 0) {
                lodMismatchViewportEdge++;
            } else if (currentLod < engineOptimalLod) {
                lodMismatchFiner++;
            } else {
                lodMismatchOther++;
            }
        }

        // 外缘 edgeFactor≤0：仍用地板权重入队（避免引擎细档预算空挂、cur 顶不满）
        const edgeForQueue =
            edgeFactor > 0 ? edgeFactor : T.viewport.edgeOuterDownloadFloor;
        const isCenter = edgeFactor >= T.viewport.edgeRelaxOptimal;
        // 中央细档上屏统计 + ctr↓ 诊断（相对当前有效目标：BootstrapFast=visualTarget）
        if (isCenter && currentLod >= 0) {
            if (engineOptimalLod < 0) {
                centerBehindNoEngine++;
                centerEngineBehindNodes++;
                if (centerBehindSamples.length < 3) {
                    centerBehindSamples.push({
                        nodeIndex,
                        currentLod,
                        engineOptimalLod,
                        edgeFactor,
                        targetLod: -1,
                        fileIndex: -1,
                        fileLoaded: false,
                        reason: 'no_engine'
                    });
                }
            } else {
                const effectiveOptimalLod = resolveEffectiveOptimalLod(
                    engineOptimalLod,
                    maxLod,
                    ctx
                );
                const clearFi = node.lods[effectiveOptimalLod]?.fileIndex ?? -1;
                if (clearFi < 0) {
                    // 无档文件：不计入 target（无法追）
                } else if (currentLod <= effectiveOptimalLod) {
                    centerTargetNodes++;
                    centerClearNodes++;
                } else if (!isPermanentFail(clearFi)) {
                    centerTargetNodes++;
                    centerEngineBehindNodes++;
                    if (centerBehindSamples.length < 3) {
                        const jumpSteps =
                            currentLod > engineOptimalLod
                                ? Math.max(1, currentLod - engineOptimalLod)
                                : resolveLadderJumpSteps(edgeForQueue, pendingBacklog);
                        const targetLod = computeRefinementTargetLod(
                            effectiveOptimalLod,
                            maxLod,
                            currentLod,
                            edgeForQueue,
                            jumpSteps
                        );
                        const fi = node.lods[targetLod]?.fileIndex ?? -1;
                        centerBehindSamples.push({
                            nodeIndex,
                            currentLod,
                            engineOptimalLod,
                            edgeFactor,
                            targetLod,
                            fileIndex: fi,
                            fileLoaded: fi >= 0 && !!octree.getFileResource(fi),
                            reason: 'coarser'
                        });
                    }
                }
            }
        }

        // 下载目标：BootstrapFast 用 visualTarget，否则 engineOptimal（renderScale 下已钳制）
        if (engineOptimalLod < 0) {
            continue;
        }

        const effectiveOptimalLod = resolveEffectiveOptimalLod(
            engineOptimalLod,
            maxLod,
            ctx
        );
        // distance：沿用 ladder；renderScale 中央一次到位，边缘仍 ladder / backlog
        let jumpSteps: number;
        if (
            ctx.renderScale?.enabled &&
            isCenter &&
            currentLod >= 0 &&
            currentLod > effectiveOptimalLod
        ) {
            jumpSteps = Math.max(1, currentLod - effectiveOptimalLod);
        } else {
            jumpSteps = resolveLadderJumpSteps(edgeForQueue, pendingBacklog);
        }
        const targetLod = computeRefinementTargetLod(
            effectiveOptimalLod,
            maxLod,
            currentLod,
            edgeForQueue,
            jumpSteps
        );

        // 文件已加载且 current 已不粗于 target
        if (currentLod >= 0 && currentLod <= targetLod) {
            continue;
        }

        const fi = node.lods[targetLod]?.fileIndex ?? -1;
        // 无对应档文件 / 永久失败：无法升档，不计 stale、不建队
        if (fi < 0 || isPermanentFail(fi)) {
            continue;
        }

        needsLodSwitch = true;
        if (currentLod < 0 || currentLod > targetLod) {
            staleLodNodes++;
        }

        const ladderBoost = computeLadderScoreBoost(maxLod, currentLod, targetLod);
        if (octree.getFileResource(fi)) {
            staleLoadedNodes++;
        } else if (rsState?.enabled && pixelFactor > 0) {
            fillScratchRepDiameters(rsState.table, nodeIndex, rsState.scratchDiameters);
            const curLodForSize = currentLod >= 0 ? currentLod : maxLod;
            const curDiamWorld = rsState.scratchDiameters[Math.min(curLodForSize, maxLod)] ?? 0;
            const currentScreenDiameter = computeScreenDiameter(
                curDiamWorld,
                pixelFactor,
                actualDistance
            );
            const viewAngleDeg = computeViewAngleDeg(
                (minX + maxX) * 0.5,
                (minY + maxY) * 0.5,
                (minZ + maxZ) * 0.5,
                px,
                py,
                pz,
                fwx,
                fwy,
                fwz
            );
            const foveate = computeFoveateFactor(viewAngleDeg, rsState.foveation);
            const effective = computeEffectiveRenderScale(rsState.baseRenderScale, foveate);
            const extent = Math.max(
                _lastScoreMaxX - _lastScoreMinX,
                _lastScoreMaxY - _lastScoreMinY,
                _lastScoreMaxZ - _lastScoreMinZ
            );
            const projectedArea =
                (extent / Math.max(actualDistance, 0.001)) * (extent / Math.max(actualDistance, 0.001));
            const urgency = computeVisualUrgency(
                currentScreenDiameter,
                effective,
                projectedArea,
                foveate
            );
            const costProxy = Math.max(1, node.lods[targetLod]?.count ?? 1);
            const fileScore = computeFilePriority(urgency, costProxy) * ladderBoost;
            visualUrgencySum += urgency;
            visualUrgencyCount++;
            prioritized.push({
                fileIndex: fi,
                score: fileScore > 0 ? fileScore : score * 1e-6 * ladderBoost
            });
        } else {
            // backoff 仍进候选，便于到期后外层重试；pending 计数侧 ignore
            const edgeWeight = Math.pow(edgeForQueue, T.viewport.centerScorePower);
            prioritized.push({ fileIndex: fi, score: score * edgeWeight * ladderBoost });
        }
    }

    if (rsState?.enabled) {
        rsState.samplingEnabled = false;
        rsState.lastTickStats = summarizeRenderScaleSamples(
            rsState.lastTickSamples,
            rsState.table.lodLevels
        );
    }

    prioritized.sort((a, b) => b.score - a.score);
    const uniqueFiles = dedupeByFileIndex(prioritized);
    const criticalFiles = uniqueFiles.slice(0, T.loader.criticalLimit);
    const foregroundFiles = uniqueFiles.slice(0, T.loader.foregroundLimit);
    const ignoreFailPending = (fileIndex: number) => isFailBlocked(fileIndex);
    return {
        files: uniqueFiles,
        pendingUniqueFiles: countMissingUniqueFiles(octree, uniqueFiles, {
            ignoreFile: ignoreFailPending
        }),
        foregroundPendingUnique: countMissingUniqueFiles(octree, foregroundFiles, {
            ignoreFile: ignoreFailPending
        }),
        criticalPendingUnique: countMissingUniqueFiles(octree, criticalFiles, {
            ignoreFile: ignoreFailPending
        }),
        staleLoadedNodes,
        lodDisplayMismatch,
        lodMismatchEdgeRelax,
        lodMismatchFiner,
        lodMismatchViewportEdge,
        lodMismatchOther,
        centerEngineBehindNodes,
        centerBehindNoEngine,
        centerTargetNodes,
        centerClearNodes,
        centerBehindSamples,
        needsLodSwitch,
        staleLodNodes,
        renderScaleClampedNodes: rsState?.lastClampedNodes ?? 0,
        avgVisualUrgency: visualUrgencyCount > 0 ? visualUrgencySum / visualUrgencyCount : 0
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

export type OctreeRefinementTraverseStats = {
    leavesEvaluatedLast: number;
    lastScanMode: 'full' | 'incremental' | 'skip';
    fullScans: number;
    incrementalScans: number;
    dirtySkips: number;
};

/** 最近一次 runPriorityPrefetch tick 的调度指标（供 benchmarkHud 等只读展示） */
export type OctreeRefinementTickMetrics = {
    timingsMs: {
        total: number;
        scan: number;
        tracked: number;
        queue: number;
        sync: number;
    };
    scanMode: 'full' | 'incremental' | 'skip';
    leavesEvaluated: number;
    visibleLeaves: number;
    scoredLeaves: number;
    candidateFileRefs: number;
    candidateUniqueFiles: number;
    staleLodNodes: number;
    staleLoadedNodes: number;
    lodDisplayMismatch: number;
    /** 见 PrioritizedBatch 同源归因字段 */
    lodMismatchEdgeRelax: number;
    lodMismatchFiner: number;
    lodMismatchViewportEdge: number;
    lodMismatchOther: number;
    /** 中央区仍粗于 / 等待 engineOptimal 的 node 数（堵收条；含无引擎目标） */
    centerEngineBehindNodes: number;
    /** 其中 engineOptimal 尚未写出的中央叶数（诊断） */
    centerBehindNoEngine: number;
    /** 中央可统计叶 / 已追上 engineOptimal */
    centerTargetNodes: number;
    centerClearNodes: number;
    /** ctr↓ 样本 */
    centerBehindSamples: CenterBehindSample[];
    /** 引擎重试耗尽后的失败文件：backoff 中 + 永久 */
    downloadFailed: number;
    downloadBackoff: number;
    downloadPermanent: number;
    /** 本拍 ladder 是否因前景积压启用边缘跳档加成 */
    ladderBacklog: boolean;
    /** 视野中央跳档数（连贯） */
    ladderCenterJumpSteps: number;
    /** 本拍边缘跳档数（积压时为 edgeBacklogJumpSteps） */
    ladderEdgeJumpSteps: number;
    /** 判定积压的 stableForeground 阈值 */
    ladderBacklogThreshold: number;
    /** 本拍结束时的 stable foreground pending（下一拍 backlog 判定依据） */
    stableForegroundPending: number;
    cameraBurstFrames: number;
    inFlight: number;
    queueLen: number;
    /** loader.maxConcurrentLoads 当前上限（含 ?maxConcurrent= 锁定） */
    maxConcurrent: number;
    staleInFlight: number;
    suspended: number;
    idleQueueDrained: number;
    priorityDownloadsActive: boolean;
    visibleSplatsCurrentM: number;
    visibleSplatsTargetM: number;
    boostActive: boolean;
    syncedInstances: number;
    pinnedFiles: number;
    pinnedReleased: number;
    integratedLoaderResources: number;
    fileJustLanded: boolean;
    needsLodSwitch: boolean;
    syncTrigger: RefinementSyncTrigger | null;
    /** 本拍视锥外加速降档：成功钳到 bootstrap 的叶数 */
    oofDowngraded: number;
    /** 本拍视锥外粗档未就绪、已 ensure 的叶数 */
    oofPendingCoarse: number;
    /** bootFast=初始加载粗档收条；polish=追满 engineOptimal */
    refinePhase: OctreeRefinePhase;
    /** renderScale 模式：本拍钳制叶数 / 入队 urgency 均值 / 表来源 */
    renderScaleEnabled: boolean;
    /** 中央目标屏上直径（px），即 settings `lodRenderScale` */
    lodRenderScale: number;
    renderScaleClampedNodes: number;
    avgVisualUrgency: number;
    renderScaleTableSource: 'meta' | 'aabb-fallback' | 'mixed' | 'off';
};

export type OctreeRefinementController = {
    start: () => void;
    destroy: () => void;
    notifyCameraMoved: (options?: OctreeRefinementNotifyOptions) => void;
    getActivity: () => OctreeRefinementActivity;
    /** 与下载控制器一致的 stable foreground pending，供进度条完成判定 */
    getStreamingRefinementStatus: () => StreamingViewportRefinementStatus;
    getTraverseStats: () => OctreeRefinementTraverseStats;
    /** 最近一次调度 tick 指标；无 tick 时为 null */
    getLastTickMetrics: () => OctreeRefinementTickMetrics | null;
    /**
     * 运行时覆写切档参数（写入 entity 组件；下次 full scan 生效）。
     * 通常由 bindGsplatEntityLodSettings 在 bootstrap 写入；此处供调试 / 热更新。
     */
    setLodPlacementParams: (params: Partial<LodPlacementParams>) => void;
    /**
     * 初始加载 BootstrapFast 开关。finalize 收条后应设 false，开始追满 engineOptimal。
     * steps=0 时无操作。
     */
    setBootstrapCoarsenActive: (active: boolean) => void;
    /** 当前是否处于 BootstrapFast */
    getRefinePhase: () => OctreeRefinePhase;
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
    const maxConcurrentOverride = applyMaxConcurrentOverride(global.config?.maxConcurrent);
    if (maxConcurrentOverride != null) {
        console.info(`[octree-refinement] maxConcurrent override=${maxConcurrentOverride}`);
    }
    const bootstrapCoarsenSteps = resolveBootstrapCoarsenSteps(
        global.config?.bootstrapCoarsenSteps
    );
    let bootstrapCoarsenActive = bootstrapCoarsenSteps > 0;
    if (bootstrapCoarsenSteps > 0) {
        console.info(
            `[octree-refinement] bootstrapCoarsen steps=${bootstrapCoarsenSteps} (off after finalize)`
        );
    }

    const lodLevels = octree.lodLevels;
    const leafCount = octree.nodes.length;
    const resourceData = (resource as GSplatOctreeResourceLike | null)?.data;
    const repTable = buildLeafRepDiameterTable({
        leafCount,
        lodLevels,
        nodeBoundsMinMax: octree.nodeBoundsMinMax,
        getSplatCount: (leaf, lod) => octree.nodes[leaf]?.lods[lod]?.count ?? 1,
        metaData: resourceData
    });
    const selectMode = resolveLodSelectMode(global);
    const renderScaleState: RenderScaleEvalState | null =
        selectMode === 'renderScale'
            ? {
                enabled: true,
                baseRenderScale: resolveLodRenderScale(global),
                foveation: resolveLodRenderScaleFoveation(global),
                table: repTable,
                scratchDiameters: new Float32Array(Math.max(1, lodLevels)),
                lastClampedNodes: 0,
                lastEngineOptimalByLeaf: new Int16Array(leafCount).fill(-1),
                samplingEnabled: false,
                lastTickSamples: [],
                lastTickStats: null,
                cameraLocal: null,
                pixelFactor: 0
            }
            : null;
    if (renderScaleState) {
        console.info(
            `[octree-refinement] lodSelectMode=renderScale base=${renderScaleState.baseRenderScale} table=${repTable.source}`
        );
    }

    const evalCtx: RefinementEvaluateContext = {
        scene,
        gsplat: gsplatScene,
        lod: lodParamsFromComponent(gsplatEntity.gsplat as GSplatComponent | null),
        oofDowngradeEnabled: global.config?.oofDowngrade !== false,
        lodViewHoldEnabled: global.config?.lodViewHold !== false,
        bootstrapCoarsenActive,
        bootstrapCoarsenSteps,
        renderScale: renderScaleState
    };
    configureLodStabilizers({
        oofDowngrade: evalCtx.oofDowngradeEnabled,
        lodViewHold: evalCtx.lodViewHoldEnabled
    });

    const currentRefinePhase = (): OctreeRefinePhase =>
        bootstrapCoarsenActive && bootstrapCoarsenSteps > 0 ? 'bootFast' : 'polish';

    if (renderScaleState) {
        (globalThis as { __lodRenderScaleDebug?: unknown }).__lodRenderScaleDebug = {
            enabled: true,
            selectMode,
            baseRenderScale: renderScaleState.baseRenderScale,
            foveation: renderScaleState.foveation,
            tableSource: repTable.source,
            metaLeafCount: repTable.metaLeafCount,
            leafCount,
            lodLevels,
            get lastClampedNodes() {
                return renderScaleState.lastClampedNodes;
            },
            get pixelFactor() {
                return renderScaleState.pixelFactor;
            },
            get lastTickStats() {
                return renderScaleState.lastTickStats;
            },
            get lastTickSampleCount() {
                return renderScaleState.lastTickSamples.length;
            }
        };
    }

    if (octree.assetLoader) {
        patchAssetLoaderPriority(octree.assetLoader);
        if (maxConcurrentOverride != null) {
            octree.assetLoader.maxConcurrentLoads = maxConcurrentOverride;
        }
        if (typeof octree.assetLoader.maxRetries === 'number') {
            octree.assetLoader.maxRetries = T.downloadFail.engineMaxRetries;
        } else {
            octree.assetLoader.maxRetries = T.downloadFail.engineMaxRetries;
        }
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
    const prefetch = {
        tracked: new Map<number, TrackedMissingFile>(),
        pinned: new Set<number>(),
        lastUrls: [] as string[]
    };
    const downloadFailures: DownloadFailMap = new Map();
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
        centerEngineBehindNodes: 0,
        centerTargetNodes: 0,
        centerClearNodes: 0,
        settlingFrames: 0,
        tickSeq: 0,
        ready: false,
        refinePhase: currentRefinePhase()
    };
    let lastTickMetrics: OctreeRefinementTickMetrics | null = null;
    let tickSeq = 0;
    let frameProfileResetHandler: (() => void) | null = null;
    const traverseStats: OctreeRefinementTraverseStats = {
        leavesEvaluatedLast: 0,
        lastScanMode: 'skip',
        fullScans: 0,
        incrementalScans: 0,
        dirtySkips: 0
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
        // 尊重 URL/config budget（含 >4M）；仅当场景未设 budget 时用 refinement 默认
        gsplatScene.splatBudget =
            savedSplatBudget > 0 ? savedSplatBudget : T.lod.splatBudget;

        if (savedLodUnderfillLimit === null) {
            savedLodUnderfillLimit = gsplatScene.lodUnderfillLimit ?? 0;
        }
        // 5 档资产 optimal=0 时 limit 至少为 4 才能包含 bootstrap L4；取 max 保证生效
        const maxLod = octree.lodLevels - 1;
        gsplatScene.lodUnderfillLimit = Math.max(T.lod.underfillLimit, maxLod);
        // 结构参数（budget / underfill）变化 → 允许 scene-wide dirty
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
        // budget/underfill 未在此恢复；勿 scene-wide dirty（仅并发 / lodUpdateDistance）
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
        // 恢复全局 LOD 结构参数 → scene-wide dirty
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
        if (frameProfileResetHandler) {
            app.off('frameupdate', frameProfileResetHandler);
            frameProfileResetHandler = null;
        }
        if (perfModeHandler) {
            events.off('performanceMode:changed', perfModeHandler);
            perfModeHandler = null;
        }
        downloadFailures.clear();
    };

    const emitRefinementActivity = (activity: OctreeRefinementActivity) => {
        lastActivity = activity;
        if (activity.active !== prevActivityActive) {
            prevActivityActive = activity.active;
            events.fire('octreeRefinement:activity', activity);
        }
    };

    const runPriorityPrefetch = () => {
        const tickStartMs = performance.now();
        let scanMs = 0;
        let trackedMs = 0;
        let queueMs = 0;
        const cameraJustMoved = cameraMovedSinceSettle;
        const cameraBurstActive = cameraBurstFrames > 0;
        const scanStartMs = performance.now();
        tickSeq++;
        const pendingBacklog =
            prevPending.stableForeground >= T.ladder.backlogPending;
        const {
            files: batch,
            pendingUniqueFiles: pendingUniqueFilesRaw,
            foregroundPendingUnique: foregroundPendingUniqueRaw,
            criticalPendingUnique: criticalPendingUniqueRaw,
            staleLoadedNodes,
            lodDisplayMismatch,
            lodMismatchEdgeRelax,
            lodMismatchFiner,
            lodMismatchViewportEdge,
            lodMismatchOther,
            centerEngineBehindNodes,
            centerBehindNoEngine,
            centerTargetNodes,
            centerClearNodes,
            centerBehindSamples,
            needsLodSwitch,
            staleLodNodes,
            renderScaleClampedNodes,
            avgVisualUrgency
        } = buildPriorityFiles(evalCtx, { pendingBacklog, downloadFailures });
        let pendingUniqueFiles = pendingUniqueFilesRaw;
        let foregroundPendingUnique = foregroundPendingUniqueRaw;
        let criticalPendingUnique = criticalPendingUniqueRaw;
        scanMs = performance.now() - scanStartMs;
        traverseStats.leavesEvaluatedLast = batch.length;
        traverseStats.lastScanMode = 'full';
        traverseStats.fullScans++;

        const trackedStartMs = performance.now();
        updateTrackedMissingFiles(prefetch.tracked, batch, octree);
        trackedMs = performance.now() - trackedStartMs;
        const ignoreFailPending = (fileIndex: number) =>
            downloadFailBlocksPending(downloadFailures.get(fileIndex));
        const stableForeground = buildBatchFromTracked(prefetch.tracked, T.loader.foregroundLimit);
        const stableCritical = buildBatchFromTracked(prefetch.tracked, T.loader.criticalLimit);
        const criticalBatch = stableCritical;
        const foregroundBatch = stableForeground;
        const activeBatch = foregroundBatch;

        const nowMs = performance.now();
        const reconcileIndices: number[] = [];
        for (let i = 0; i < activeBatch.length; i++) {
            reconcileIndices.push(activeBatch[i].fileIndex);
        }
        for (let i = 0; i < batch.length; i++) {
            reconcileIndices.push(batch[i].fileIndex);
        }
        for (const fi of downloadFailures.keys()) {
            reconcileIndices.push(fi);
        }
        reconcileDownloadFailures(octree, octree.assetLoader, reconcileIndices, downloadFailures, nowMs);

        const stableForegroundPending = countMissingUniqueFiles(octree, stableForeground, {
            ignoreFile: ignoreFailPending
        });
        const stableCriticalPending = countMissingUniqueFiles(octree, stableCritical, {
            ignoreFile: ignoreFailPending
        });
        // buildPriorityFiles 时尚未 reconcile 本拍新耗尽；用最新 failures 重算
        pendingUniqueFiles = countMissingUniqueFiles(octree, batch, {
            ignoreFile: ignoreFailPending
        });
        criticalPendingUnique = countMissingUniqueFiles(octree, criticalBatch, {
            ignoreFile: ignoreFailPending
        });
        foregroundPendingUnique = countMissingUniqueFiles(octree, foregroundBatch, {
            ignoreFile: ignoreFailPending
        });

        const pendingFileIndices: number[] = [];
        const priorityUrls: string[] = [];

        for (let i = 0; i < activeBatch.length; i++) {
            const { fileIndex } = activeBatch[i];
            if (octree.getFileResource(fileIndex)) {
                downloadFailures.delete(fileIndex);
                continue;
            }
            const fail = downloadFailures.get(fileIndex);
            if (fail?.permanent || fail?.phase === 'permanent') {
                continue;
            }
            // backoff 未到期：不占下载槽；到期后 reconcile 已切到 retrying
            if (fail?.phase === 'backoff' && nowMs < fail.nextRetryAtMs) {
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
        const queueStartMs = performance.now();
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
        queueMs = performance.now() - queueStartMs;

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
        let syncTrigger: RefinementSyncTrigger | null = null;
        const syncStartMs = performance.now();
        let syncMs = 0;
        const markProgressiveSyncCooldown = () => {
            // 有剩余 stale 时短间隔继续 drip；无 stale 也无妨（下帧条件不满足）
            staleSyncCooldown = T.burst.progressiveSyncInterval;
        };
        if ((cameraJustMoved || cameraBurstActive) && needsLodSwitch) {
            syncTrigger = 'burst_lod_switch';
            syncedInstances = trackSyncOctreePendingPlacements(
                app,
                syncTrigger,
                octree,
                gsplatEntity,
                gsplatScene,
                false
            );
            markProgressiveSyncCooldown();
        } else if (needsLodSwitch && fileJustLanded) {
            // 新文件落地：立刻上屏（不受 cooldown 挡），再进入短 drip
            syncTrigger = 'file_landed_lod';
            syncedInstances = trackSyncOctreePendingPlacements(
                app,
                syncTrigger,
                octree,
                gsplatEntity,
                gsplatScene,
                false
            );
            markProgressiveSyncCooldown();
        } else if (needsLodSwitch && staleLoadedNodes >= T.loader.foregroundLimit) {
            syncTrigger = 'stale_limit';
            syncedInstances = trackSyncOctreePendingPlacements(
                app,
                syncTrigger,
                octree,
                gsplatEntity,
                gsplatScene,
                false
            );
            markProgressiveSyncCooldown();
        } else if (needsLodSwitch && staleLoadedNodes > 0 && staleSyncCooldown <= 0) {
            syncTrigger = 'stale_cooldown';
            syncedInstances = trackSyncOctreePendingPlacements(
                app,
                syncTrigger,
                octree,
                gsplatEntity,
                gsplatScene,
                false
            );
            markProgressiveSyncCooldown();
        } else if (stableForegroundPending === 0 && staleLodNodes > 0 && fileJustLanded) {
            syncTrigger = 'post_download';
            syncedInstances = trackSyncOctreePendingPlacements(
                app,
                syncTrigger,
                octree,
                gsplatEntity,
                gsplatScene,
                false
            );
            markProgressiveSyncCooldown();
        }

        if (fileJustLanded && syncedInstances === 0 && (staleLoadedNodes > 0 || needsLodSwitch)) {
            syncTrigger = 'file_landed_fallback';
            syncedInstances = trackSyncOctreePendingPlacements(
                app,
                syncTrigger,
                octree,
                gsplatEntity,
                gsplatScene,
                false
            );
            markProgressiveSyncCooldown();
        }
        if (syncedInstances > 0) {
            syncMs = performance.now() - syncStartMs;
        }

        // sync 经 World.requestOctreePlacementUpdate + renderNextFrame；勿再绑 gsplatScene.dirty

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
                    pendingBacklog,
                    ladderBacklog: pendingBacklog,
                    ladderCenterJumpSteps: T.ladder.centerJumpSteps,
                    ladderEdgeJumpSteps: pendingBacklog
                        ? T.ladder.edgeBacklogJumpSteps
                        : T.ladder.edgeJumpSteps,
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
                    lodMismatch: {
                        edgeRelax: lodMismatchEdgeRelax,
                        finer: lodMismatchFiner,
                        viewportEdge: lodMismatchViewportEdge,
                        other: lodMismatchOther
                    },
                    centerEngineBehindNodes,
                    centerBehindNoEngine,
                    centerTargetNodes,
                    centerClearNodes,
                    centerBehindSamples,
                    downloadFail: countDownloadFailStats(downloadFailures),
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

        const tickLoader = octree.assetLoader;
        const tickPriorityLoad = countPriorityLoadState(tickLoader, priorityUrls);
        const priorityDownloadsActive = priorityUrls.length > 0;
        const failStats = countDownloadFailStats(downloadFailures);

        // 静止 idle：限流把视锥外细档钳到 bootstrap（相机移动时由 applyLodChanges patch 覆盖）
        let oofDowngraded = 0;
        let oofPendingCoarse = 0;
        if (
            evalCtx.oofDowngradeEnabled &&
            !cameraBurstActive &&
            !cameraJustMoved &&
            stableForegroundPending === 0
        ) {
            const oof = dripOutOfFrustumDowngrade(
                app,
                octree,
                gsplatEntity,
                cameraEntity,
                gsplatScene,
                { maxNodes: 32 }
            );
            oofDowngraded = oof.clamped;
            oofPendingCoarse = oof.pendingCoarse;
            if (oofDowngraded > 0) {
                app.renderNextFrame = true;
            }
        }

        lastTickMetrics = {
            timingsMs: {
                total: performance.now() - tickStartMs,
                scan: scanMs,
                tracked: trackedMs,
                queue: queueMs,
                sync: syncMs
            },
            scanMode: traverseStats.lastScanMode,
            leavesEvaluated: traverseStats.leavesEvaluatedLast,
            visibleLeaves: batch.length,
            scoredLeaves: batch.length,
            candidateFileRefs: batch.length,
            candidateUniqueFiles: pendingUniqueFiles,
            staleLodNodes,
            staleLoadedNodes,
            lodDisplayMismatch,
            lodMismatchEdgeRelax,
            lodMismatchFiner,
            lodMismatchViewportEdge,
            lodMismatchOther,
            centerEngineBehindNodes,
            centerBehindNoEngine,
            centerTargetNodes,
            centerClearNodes,
            centerBehindSamples,
            downloadFailed: failStats.downloadFailed,
            downloadBackoff: failStats.downloadBackoff,
            downloadPermanent: failStats.downloadPermanent,
            ladderBacklog: pendingBacklog,
            ladderCenterJumpSteps: T.ladder.centerJumpSteps,
            ladderEdgeJumpSteps: pendingBacklog
                ? T.ladder.edgeBacklogJumpSteps
                : T.ladder.edgeJumpSteps,
            ladderBacklogThreshold: T.ladder.backlogPending,
            stableForegroundPending,
            cameraBurstFrames,
            inFlight: tickLoader?._currentlyLoading?.size ?? 0,
            queueLen: tickLoader?._loadQueue?.length ?? 0,
            maxConcurrent:
                tickLoader?.maxConcurrentLoads ?? T.loader.boostConcurrent,
            staleInFlight: priorityDownloadsActive ? tickPriorityLoad.staleInFlight : 0,
            suspended: tickLoader?.__refinementSuspendedQueue?.length ?? 0,
            idleQueueDrained: 0,
            priorityDownloadsActive,
            // v5 收敛：未迁 traverse 内 splat 统计，HUD 显示 0；budget 作参考目标
            visibleSplatsCurrentM: 0,
            visibleSplatsTargetM: (gsplatScene.splatBudget ?? 0) / 1_000_000,
            boostActive,
            syncedInstances,
            pinnedFiles: prefetch.pinned.size,
            pinnedReleased: 0,
            integratedLoaderResources,
            fileJustLanded,
            needsLodSwitch,
            syncTrigger,
            oofDowngraded,
            oofPendingCoarse,
            refinePhase: currentRefinePhase(),
            renderScaleEnabled: !!renderScaleState?.enabled,
            lodRenderScale: renderScaleState?.baseRenderScale ?? 0,
            renderScaleClampedNodes,
            avgVisualUrgency,
            renderScaleTableSource: renderScaleState?.enabled
                ? renderScaleState.table.source
                : 'off'
        };

        const activityActive =
            stableForegroundPending > 0 ||
            staleLoadedNodes > 0 ||
            centerEngineBehindNodes > 0 ||
            (cameraBurstActive && needsLodSwitch);
        emitRefinementActivity({
            active: activityActive,
            pendingForeground: stableForegroundPending,
            staleLoadedNodes,
            burstFrames: cameraBurstFrames
        });

        const ready =
            stableForegroundPending === 0 && centerEngineBehindNodes === 0;
        const needsWork =
            stableForegroundPending + staleLodNodes + centerEngineBehindNodes;
        const refinementRatio =
            centerTargetNodes > 0
                ? Math.max(0, Math.min(1, centerClearNodes / centerTargetNodes))
                : ready
                    ? 1
                    : 0;
        lastStreamingRefinementStatus = {
            visibleNodes: needsWork,
            refinedNodes: needsWork === 0 ? 1 : 0,
            pendingNodes: stableForegroundPending,
            staleLoadedNodes,
            refinementRatio,
            pendingUniqueFiles: pendingUniqueFiles,
            staleLodNodes,
            centerEngineBehindNodes,
            centerTargetNodes,
            centerClearNodes,
            settlingFrames: settle.framesRemaining,
            tickSeq,
            ready,
            refinePhase: currentRefinePhase()
        };

        if (cameraBurstFrames > 0) {
            cameraBurstFrames--;
            syncBurstLodUpdateDistance();
        }

        // activity / 下载中：只保活渲染节拍，不触发 scene-wide dirty / 重复 needsLodUpdate
        if (fileJustLanded || activityActive || priorityUrls.length > 0) {
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
            cameraBurstFrames = T.burst.unlockFrames;
            prevActivityActive = false;
            prefetch.pinned.clear();
            prefetch.tracked.clear();
            prefetch.lastUrls = [];
            downloadFailures.clear();
            prevPending.staleLodNodes = -1;
            prevPending.stableForeground = -1;
            staleSyncCooldown = 0;
            enterRefinementMode();

            updateHandler = onUpdate;
            app.on('update', updateHandler);

            frameProfileResetHandler = () => resetRefinementFrameProfile(app);
            app.on('frameupdate', frameProfileResetHandler);

            const eventHandler = app.systems.gsplat;
            frameReadyHandler = (_camera: unknown, _layer: unknown, _ready: unknown, loading: unknown) => {
                const loadingCount = typeof loading === 'number' ? loading : -1;
                const loadingDropped = prevFrameLoading > 0 && loadingCount >= 0 && loadingCount < prevFrameLoading;
                if (loadingCount >= 0) {
                    prevFrameLoading = loadingCount;
                }
                if (loadingDropped) {
                    const count = trackSyncOctreePendingPlacements(
                        app,
                        'frame_ready_loading_drop',
                        octree,
                        gsplatEntity,
                        gsplatScene,
                        false
                    );
                    if (count > 0) {
                        ensureFrameProfile(app).frameReadySync = true;
                    }
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

        getTraverseStats(): OctreeRefinementTraverseStats {
            return {
                leavesEvaluatedLast: traverseStats.leavesEvaluatedLast,
                lastScanMode: traverseStats.lastScanMode,
                fullScans: traverseStats.fullScans,
                incrementalScans: traverseStats.incrementalScans,
                dirtySkips: traverseStats.dirtySkips
            };
        },

        getLastTickMetrics() {
            return lastTickMetrics;
        },

        setLodPlacementParams(params: Partial<LodPlacementParams>) {
            const comp = gsplatEntity.gsplat as GSplatComponent | null;
            if (!comp) {
                return;
            }
            if (params.lodBaseDistance !== undefined && Number.isFinite(params.lodBaseDistance) && params.lodBaseDistance > 0) {
                comp.lodBaseDistance = params.lodBaseDistance;
            }
            if (params.lodMultiplier !== undefined && Number.isFinite(params.lodMultiplier) && params.lodMultiplier > 0) {
                comp.lodMultiplier = params.lodMultiplier;
            }
            refreshEvalLodParams(evalCtx);
        },

        setBootstrapCoarsenActive(active: boolean) {
            if (bootstrapCoarsenSteps <= 0) {
                return;
            }
            const next = !!active;
            if (bootstrapCoarsenActive === next) {
                return;
            }
            bootstrapCoarsenActive = next;
            evalCtx.bootstrapCoarsenActive = next;
            console.info(
                `[octree-refinement] bootstrapCoarsen ${next ? 'bootFast' : 'polish'} (steps=${bootstrapCoarsenSteps})`
            );
            cameraMovedSinceSettle = true;
            runPriorityPrefetch();
        },

        getRefinePhase() {
            return currentRefinePhase();
        },

        destroy() {
            stopRefinementController();
        }
    };
}
