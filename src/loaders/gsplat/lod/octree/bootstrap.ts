import {
    GSPLAT_DEBUG_LOD,
    GSPLAT_DEBUG_NONE,
    Vec3,
    type AppBase,
    type CameraComponent,
    type Entity,
    type Layer
} from 'playcanvas';

import type { ExperienceSettings } from '../../../../settings';
import type { Global } from '../../../../types';
import { revealBlocksAnim } from '../../../../vfx/effects-runtime/reveal/reveal-policy';
import type { RevealController } from '../../../../vfx/effects-runtime/reveal/reveal-controller';
import type { CameraManager } from '../../../../camera-manager';
import { isCustomLodEnabled } from '../custom-loader';
import {
    bindGsplatEntityLodSettings,
    bindGsplatPerfSettings,
    bindGsplatRenderer,
    bindGsplatStreamingLodSettings,
    getSplatBudgetMillions,
    warnOnComputeRendererFallback,
    type GsplatSceneRuntime
} from '../scene-bindings';
import {
    resolveLodBaseDistance,
    resolveLodScaleAlignEnabled,
    resolveLodScaleQualityFactor
} from '../scene-profile';
import { applyLodRangeToGsplatEntity } from './entity-lod-range';
import { readMetaLodDistanceScale } from './lod-distance-scale';
import { applyLodScaleAlignToComponent } from './lod-scale-align';
import { computeStreamingRefinementProgressRatio } from './streaming-refinement-progress';
import {
    createOctreeRefinementController,
    ensureStreamingBootstrapCoarseFiles,
    getStreamingViewportBootstrapStatus,
    getStreamingViewportRefinementStatus,
    isStreamableOctreeResource,
    syncStreamingOctreePlacements,
    type GSplatOctreeResourceLike,
    type OctreeLike,
    type OctreeRefinementController,
    type OctreeStreamingScene,
    type StreamingViewportOptions
} from './refinement-controller';
import type { ForceRenderBinding } from '../../shared-types';

export type OctreeLoadMode = {
    isCustomLod: boolean;
    isStreamingOctree: boolean;
    isFullload: boolean;
};

export function resolveOctreeLoadMode(
    global: Global,
    octreeResource: GSplatOctreeResourceLike | null
): OctreeLoadMode {
    const { config, settings } = global;
    const isCustomLod = isCustomLodEnabled(settings, config.contentUrl);
    return {
        isCustomLod,
        isFullload: !!config.fullload,
        isStreamingOctree:
            !isCustomLod &&
            !config.fullload &&
            isStreamableOctreeResource(octreeResource)
    };
}

export type OctreeLodBootstrapOptions = {
    global: Global;
    settings: ExperienceSettings;
    gsplatEntity: Entity;
    camera: Entity;
    cameraManager: CameraManager;
    forceRender: ForceRenderBinding;
    ensureShadowPipelineReady: () => void;
    revealController?: RevealController | null;
    onRefinementController: (controller: OctreeRefinementController | null) => void;
};

export type OctreeLodBootstrapHandle = {
    destroy: () => void;
};

/**
 * PlayCanvas octree 引擎路径（无 unified instance）：custom LOD / fullload / streaming octree。
 * 与 {@link bootstrapSogUnified} 互不重叠。
 */
export function bootstrapOctreeLod(options: OctreeLodBootstrapOptions): OctreeLodBootstrapHandle {
    const {
        global,
        settings,
        gsplatEntity,
        camera,
        cameraManager,
        forceRender,
        ensureShadowPipelineReady,
        revealController,
        onRefinementController
    } = options;

    const { app, config, events, state } = global;
    const gsplat = app.scene.gsplat as unknown as GsplatSceneRuntime;
    const octreeResource = gsplatEntity.gsplat?.resource as GSplatOctreeResourceLike | null;
    const loadMode = resolveOctreeLoadMode(global, octreeResource);
    const { isCustomLod, isStreamingOctree, isFullload } = loadMode;

    configureInitialGsplatScene(gsplat, global, gsplatEntity, loadMode, octreeResource);

    bindGsplatStreamingLodSettings(gsplat, global);
    bindGsplatEntityLodSettings(gsplatEntity.gsplat, global);
    // R95 + 金字塔：反推 effective lodBaseDistance，写回 entity 供引擎与 refinement 共用
    const octreeForAlign = octreeResource?.octree ?? null;
    const scaleAlign = applyLodScaleAlignToComponent(
        gsplatEntity.gsplat,
        octreeForAlign,
        resolveLodBaseDistance(global),
        {
            enabled: resolveLodScaleAlignEnabled(global),
            qualityFactor: resolveLodScaleQualityFactor(global),
            metaLodDistanceScale: readMetaLodDistanceScale(
                octreeResource as { data?: { lodDistanceScale?: unknown } } | null
            )
        }
    );
    if (scaleAlign?.applied) {
        console.log('[LOD] scale-align lodBaseDistance', {
            configured: scaleAlign.configuredD0,
            effective: Number(scaleAlign.effectiveD0.toFixed(3)),
            scale: Number(scaleAlign.scale.toFixed(3)),
            R95: scaleAlign.metrics.robustRadiusR95 != null
                ? Number(scaleAlign.metrics.robustRadiusR95.toFixed(2))
                : null,
            maxLod: scaleAlign.metrics.maxLod,
            targetFarLod: scaleAlign.metrics.targetFarLod,
            rawD0: scaleAlign.metrics.rawD0 != null
                ? Number(scaleAlign.metrics.rawD0.toFixed(4))
                : null,
            qualityFactor: Number(scaleAlign.metrics.qualityFactor.toFixed(3)),
            halfExtent: scaleAlign.metrics.halfExtent != null
                ? Number(scaleAlign.metrics.halfExtent.toFixed(1))
                : null,
            leafScale: Number(scaleAlign.metrics.leafScale.toFixed(3)),
            densityScale: Number(scaleAlign.metrics.densityScale.toFixed(3)),
            densityRatio: Number(scaleAlign.metrics.densityRatio.toFixed(3))
        });
    }

    const eventHandler = app.systems.gsplat;
    let idleTime = 0;
    forceRender.set(true);

    let refinementController: OctreeRefinementController | null = null;
    let current = 0;
    let watermark = 1;
    let maxProgress = 0;
    let progressUIHidden = false;

    /*
     * Streaming 首屏阶段契约（状态优先，不以固定 ms 当清晰度门槛）：
     * A 0–50%   文件 watermark / 开门禁
     * B 50–82%   粗档 lodRange，拉视锥粗 SOG；可 readyToRender，输入仍锁
     * C 82–99%   unlockStreamingLod：放开 lodRange + 距离档 refinement；收条前不可交互
     * D 收条后   progressThresholdReached 解锁输入
     *
     * 收条主路径：有效 tick + 下载收敛 + 中央追上 engineOptimal + staleLod===0 + N 帧稳定。
     * 真空完成：tick 后 pending=0 且 centerBehind=0 且 stale=0。
     * 逃生阀：下载已收敛但 stale 卡住时，按「无进展帧数」escape（非清晰度门槛）。
     */
    const PROGRESS_THRESHOLD = 50;
    const PROGRESS_COARSE_CAP = 82;
    /** 未 finalize 前 UI 最高到 99，避免 progress===100 提前藏条却未发 progressThresholdReached */
    const PROGRESS_REFINEMENT_CAP = 99;
    /** 视口细档下载完成比例达到该值才进入收条候选（仍须 staleLod===0） */
    const STREAMING_REFINEMENT_UI_COMPLETE_RATIO = 0.8;
    /** 主路径条件连续成立的抗抖帧数（不是「等时间」） */
    const STREAMING_REFINEMENT_STABLE_FRAMES = 10;
    const STREAMING_REFINEMENT_PENDING_SPIKE_FRAMES = 3;
    /**
     * 逃生阀：下载已收敛但 stale 长期无进展时的连续无进展帧数。
     * 仅防 Poland 类卡死，不是清晰度门槛。约 60fps×6s。
     */
    const STREAMING_REFINEMENT_NO_PROGRESS_ESCAPE_FRAMES = 360;
    /** 逃生阀加强：stale 从未下降时的更长无进展帧数（约 12s@60fps） */
    const STREAMING_REFINEMENT_NO_PROGRESS_HARD_ESCAPE_FRAMES = 720;

    let streamingLodUnlocked = false;
    let streamingPerfHandlerRegistered = false;
    let streamingBootstrapGateReached = false;
    let streamingSceneWarmupDone = false;
    let streamingPendingCoarseDisplay = false;
    let streamingCoarseDisplayed = false;
    let streamingBootstrapDisplayFinalized = false;
    let streamingViewportSyncCooldown = 0;
    let streamingRefinementStableFrames = 0;
    let streamingRefinementPendingSpikeFrames = 0;
    let streamingRefinementBaselinePending = 0;
    let streamingRefinementPhaseStarted = false;
    let streamingRefinementPeakStale = 0;
    let streamingRefinementNoProgressFrames = 0;
    let streamingRefinementLastPending = -1;
    let streamingRefinementLastStale = -1;
    let streamingPreGateKickCooldown = 0;

    const streamLastCamPos = new Vec3();
    const streamLastCamFwd = new Vec3();
    let streamLastCamDist = cameraManager.camera.distance;
    let streamLastCamFov = cameraManager.camera.fov;

    let perfModeHandler: (() => void) | null = null;

    const streamingViewportOptions = (): StreamingViewportOptions => ({
        excludeViewportEdgeNodes: true
    });

    const streamingScene = (): OctreeStreamingScene | null => {
        const octree = octreeResource?.octree as OctreeLike | null | undefined;
        if (!octree) {
            return null;
        }
        return { app, octree, gsplatEntity, cameraEntity: camera };
    };

    const resolveStreamingRefinementStatus = () => {
        const fromController = refinementController?.getStreamingRefinementStatus();
        if (fromController) {
            return fromController;
        }
        const scene = streamingScene();
        if (!scene) {
            return {
                visibleNodes: 0,
                refinedNodes: 0,
                pendingNodes: 0,
                staleLoadedNodes: 0,
                refinementRatio: 0,
                pendingUniqueFiles: 0,
                staleLodNodes: 0,
                centerEngineBehindNodes: 0,
                ready: false
            };
        }
        return getStreamingViewportRefinementStatus(scene, streamingViewportOptions());
    };

    const hasValidRefinementTick = (): boolean =>
        refinementController?.getLastTickMetrics() != null;

    /** 仅度量下载收敛；不含 750ms grace，不含 stale；中央未追上 engine 不算完成 */
    const getStreamingRefinementDoneRatio = (
        refinement: ReturnType<typeof resolveStreamingRefinementStatus>
    ): number => {
        if ((refinement.centerEngineBehindNodes ?? 0) > 0) {
            // pending 已空但中央仍粗于引擎目标：禁止进度条假完成
            const dl =
                streamingRefinementBaselinePending <= 0
                    ? 0
                    : refinement.pendingNodes <= 0
                        ? 1
                        : computeStreamingRefinementProgressRatio(
                            refinement.pendingNodes,
                            streamingRefinementBaselinePending
                        );
            return Math.min(dl, STREAMING_REFINEMENT_UI_COMPLETE_RATIO - 0.01);
        }
        if (streamingRefinementBaselinePending <= 0) {
            return 0;
        }
        if (refinement.pendingNodes <= 0) {
            return 1;
        }
        return computeStreamingRefinementProgressRatio(
            refinement.pendingNodes,
            streamingRefinementBaselinePending
        );
    };

    const isVacuumBootstrapComplete = (
        refinement: ReturnType<typeof resolveStreamingRefinementStatus>
    ): boolean => {
        if (!hasValidRefinementTick()) {
            return false;
        }
        if (
            refinement.pendingNodes > 0 ||
            refinement.staleLodNodes > 0 ||
            (refinement.centerEngineBehindNodes ?? 0) > 0
        ) {
            return false;
        }
        const tick = refinementController?.getLastTickMetrics();
        // pending/stale/中央追档皆 0 时即真空完成；needsLodSwitch 抖动不阻收条
        return tick != null;
    };

    const isDownloadConverged = (
        refinement: ReturnType<typeof resolveStreamingRefinementStatus>
    ): boolean => {
        if ((refinement.centerEngineBehindNodes ?? 0) > 0) {
            return false;
        }
        if (streamingRefinementBaselinePending > 0) {
            return (
                getStreamingRefinementDoneRatio(refinement) >= STREAMING_REFINEMENT_UI_COMPLETE_RATIO
            );
        }
        // 无 baseline：有效 tick 且 pending===0 → 下载侧无活（含热缓存已齐，只等 stale 消掉）
        return hasValidRefinementTick() && refinement.pendingNodes <= 0;
    };

    const isDisplayConverged = (
        refinement: ReturnType<typeof resolveStreamingRefinementStatus>
    ): boolean => refinement.staleLodNodes <= 0;

    /** 主路径：有效 tick + 下载收敛 + staleLod===0 */
    const isBootstrapMainPathReady = (
        refinement: ReturnType<typeof resolveStreamingRefinementStatus>
    ): boolean => {
        if (!hasValidRefinementTick()) {
            return false;
        }
        if (!isDownloadConverged(refinement)) {
            return false;
        }
        return isDisplayConverged(refinement);
    };

    /**
     * 逃生阀：下载已收敛但 stale 卡住。
     * 优先要求 stale 相对峰值已下降；若从未下降则用更长无进展帧数。
     */
    const isBootstrapNoProgressEscapeReady = (
        refinement: ReturnType<typeof resolveStreamingRefinementStatus>
    ): boolean => {
        if (!hasValidRefinementTick()) {
            return false;
        }
        if (!isDownloadConverged(refinement)) {
            return false;
        }
        if (refinement.staleLodNodes <= 0) {
            return false;
        }
        if (streamingRefinementPeakStale <= 0) {
            return false;
        }
        const staleImproved = refinement.staleLodNodes < streamingRefinementPeakStale;
        if (staleImproved) {
            return (
                streamingRefinementNoProgressFrames >= STREAMING_REFINEMENT_NO_PROGRESS_ESCAPE_FRAMES
            );
        }
        return (
            streamingRefinementNoProgressFrames >= STREAMING_REFINEMENT_NO_PROGRESS_HARD_ESCAPE_FRAMES
        );
    };

    const trackRefinementProgressForEscape = (
        refinement: ReturnType<typeof resolveStreamingRefinementStatus>
    ) => {
        if (refinement.staleLodNodes > streamingRefinementPeakStale) {
            streamingRefinementPeakStale = refinement.staleLodNodes;
        }
        const pending = refinement.pendingNodes;
        const stale = refinement.staleLodNodes;
        const improved =
            (streamingRefinementLastPending >= 0 && pending < streamingRefinementLastPending) ||
            (streamingRefinementLastStale >= 0 && stale < streamingRefinementLastStale);
        if (improved) {
            streamingRefinementNoProgressFrames = 0;
        } else if (isDownloadConverged(refinement)) {
            streamingRefinementNoProgressFrames++;
        } else {
            streamingRefinementNoProgressFrames = 0;
        }
        streamingRefinementLastPending = pending;
        streamingRefinementLastStale = stale;
    };

    const finalizeStreamingBootstrapDisplay = () => {
        if (streamingBootstrapDisplayFinalized) {
            return;
        }
        streamingBootstrapDisplayFinalized = true;
        if (!state.readyToRender) {
            state.readyToRender = true;
            ensureShadowPipelineReady();
        }
        events.fire('firstFrame');
        window.firstFrame?.();
    };

    const runStreamingSceneWarmupOnce = () => {
        if (streamingSceneWarmupDone) {
            return;
        }
        streamingSceneWarmupDone = true;
        kickStreamingBootstrapDownloads();
        revealController?.ensureInitialEffectCreatedBeforeFirstDisplay?.();
        forceRender.set(true);
        app.renderNextFrame = true;
        app.once('frameend', () => {
            bindGsplatRenderer(gsplat, global);
            warnOnComputeRendererFallback(global);
            gsplat.debug = config.colorize ? GSPLAT_DEBUG_LOD : GSPLAT_DEBUG_NONE;
            forceRender.set(!streamingBootstrapDisplayFinalized);
            if (streamingPendingCoarseDisplay && !state.readyToRender) {
                streamingPendingCoarseDisplay = false;
                state.readyToRender = true;
                ensureShadowPipelineReady();
            }
        });
    };

    const kickStreamingBootstrapDownloads = (): number => {
        const scene = streamingScene();
        if (!scene) {
            return 0;
        }
        const enqueued = ensureStreamingBootstrapCoarseFiles(scene, streamingViewportOptions());
        syncStreamingOctreePlacements(scene);
        app.renderNextFrame = true;
        return enqueued;
    };

    const syncLoadingWatermark = (loading: number) => {
        if (loading <= 0) {
            return;
        }
        watermark = Math.max(watermark, loading);
        current = watermark - loading;
    };

    const computeFileLoadProgress = (): number =>
        watermark > 0 ? Math.trunc((current / watermark) * 100) : 0;

    const tryOpenStreamingBootstrapGate = () => {
        if (!isStreamingOctree || streamingBootstrapGateReached || progressUIHidden) {
            return;
        }

        const fileProgress = computeFileLoadProgress();
        const mergedPreGate = Math.max(
            state.progress,
            Math.min(fileProgress, PROGRESS_THRESHOLD)
        );

        if (fileProgress >= PROGRESS_THRESHOLD || mergedPreGate >= PROGRESS_THRESHOLD) {
            streamingBootstrapGateReached = true;
            pollStreamingBootstrapComplete();
            return;
        }

        // 会话缓存 / loading 计数为 0：粗层已可放置时直接开门禁
        const scene = streamingScene();
        if (!scene) {
            return;
        }
        const viewport = getStreamingViewportBootstrapStatus(scene, streamingViewportOptions());
        if (viewport.visibleNodes > 0 && viewport.ready) {
            streamingBootstrapGateReached = true;
            pollStreamingBootstrapComplete();
        }
    };

    const tryShowStreamingCoarseViewport = () => {
        if (streamingCoarseDisplayed) {
            return;
        }
        streamingCoarseDisplayed = true;
        if (streamingSceneWarmupDone) {
            if (!state.readyToRender) {
                state.readyToRender = true;
                ensureShadowPipelineReady();
            }
            return;
        }
        streamingPendingCoarseDisplay = true;
        runStreamingSceneWarmupOnce();
    };

    const updateStreamingLoadProgress = (fileProgress: number) => {
        if (!isStreamingOctree) {
            state.progress = fileProgress;
            return;
        }

        if (progressUIHidden || state.animationStarted) {
            state.progress = 100;
            return;
        }

        if (!streamingBootstrapGateReached) {
            state.progress = Math.max(state.progress, Math.min(fileProgress, PROGRESS_THRESHOLD));
            return;
        }

        const scene = streamingScene();
        if (!scene) {
            state.progress = Math.min(Math.max(state.progress, fileProgress), PROGRESS_THRESHOLD);
            return;
        }

        const viewport = getStreamingViewportBootstrapStatus(scene, streamingViewportOptions());

        if (!viewport.ready) {
            const coarseProgress =
                PROGRESS_THRESHOLD +
                Math.round(viewport.placementRatio * (PROGRESS_COARSE_CAP - PROGRESS_THRESHOLD));
            state.progress = Math.min(PROGRESS_COARSE_CAP, Math.max(state.progress, coarseProgress));
            return;
        }

        if (!streamingLodUnlocked) {
            state.progress = PROGRESS_COARSE_CAP;
            return;
        }

        if (!streamingRefinementPhaseStarted) {
            streamingRefinementPhaseStarted = true;
            state.progress = PROGRESS_COARSE_CAP;
        }

        const refinement = resolveStreamingRefinementStatus();

        if (refinement.pendingNodes > streamingRefinementBaselinePending) {
            streamingRefinementBaselinePending = refinement.pendingNodes;
        }

        if (streamingRefinementBaselinePending <= 0) {
            // 未见 baseline：真空完成可贴顶，否则停在粗档顶（禁止 750ms 空队列秒收条）
            state.progress = isVacuumBootstrapComplete(refinement)
                ? PROGRESS_REFINEMENT_CAP
                : Math.max(state.progress, PROGRESS_COARSE_CAP);
            return;
        }

        const doneRatio = getStreamingRefinementDoneRatio(refinement);
        const refinementDisplayRatio = Math.min(
            1,
            doneRatio / STREAMING_REFINEMENT_UI_COMPLETE_RATIO
        );
        let refinementProgress =
            PROGRESS_COARSE_CAP +
            Math.round(refinementDisplayRatio * (PROGRESS_REFINEMENT_CAP - PROGRESS_COARSE_CAP));
        // pending 已收敛但 stale 未消：进度可到 99，但不收条（等显示换档）
        if (
            doneRatio >= STREAMING_REFINEMENT_UI_COMPLETE_RATIO &&
            refinement.staleLodNodes > 0
        ) {
            refinementProgress = PROGRESS_REFINEMENT_CAP;
        }
        state.progress = Math.min(
            PROGRESS_REFINEMENT_CAP,
            Math.max(state.progress, refinementProgress)
        );
    };

    const unlockStreamingLod = () => {
        if (!isStreamingOctree || streamingLodUnlocked) {
            return;
        }
        streamingLodUnlocked = true;
        streamingRefinementBaselinePending = 0;
        streamingRefinementStableFrames = 0;
        streamingRefinementPendingSpikeFrames = 0;
        streamingRefinementPeakStale = 0;
        streamingRefinementNoProgressFrames = 0;
        streamingRefinementLastPending = -1;
        streamingRefinementLastStale = -1;
        // Phase C：放开 lodRange，开始 refinement（不等于可交互）
        bindGsplatPerfSettings(gsplat, global);
        const maxLod = octreeResource?.octree?.lodLevels;
        if (maxLod) {
            applyLodRangeToGsplatEntity(gsplatEntity, 0, maxLod - 1);
        }
        gsplat.dirty = true;
        app.renderNextFrame = true;

        if (!streamingPerfHandlerRegistered) {
            streamingPerfHandlerRegistered = true;
            perfModeHandler = () => {
                bindGsplatPerfSettings(gsplat, global);
            };
            events.on('performanceMode:changed', perfModeHandler);
        }

        refinementController?.destroy();
        refinementController = createOctreeRefinementController(global, gsplatEntity, octreeResource);
        refinementController?.start();
        onRefinementController(refinementController);

        // Phase C 开始：粗层齐、放开 lodRange。不等于可交互（锁仍等 progressThresholdReached）。
        events.fire('streamingLodUnlocked');
    };

    const pollStreamingBootstrapComplete = () => {
        if (!isStreamingOctree || !streamingBootstrapGateReached) {
            return;
        }

        // 首屏已完成：禁止再每帧全树扫描（Poland 等大场景上 isOctreeBootstrapPlaceableNode
        // + ensureStreamingBootstrapCoarseFiles 可占 CPU profile >50%）。
        // 仅保留 animTrack 开机逻辑。见 mega 1e0bc0e9。
        if (progressUIHidden) {
            if (
                state.animationStarted ||
                revealBlocksAnim(state) ||
                settings.startMode !== 'animTrack' ||
                !state.hasAnimation ||
                config.noanim
            ) {
                return;
            }
            state.animationStarted = true;
            state.animationPaused = false;
            state.progress = 100;
            events.fire('animationStarted');
            console.log('Streaming octree: starting animation after bootstrap UI complete');
            return;
        }

        const scene = streamingScene();
        if (!scene) {
            return;
        }

        ensureStreamingBootstrapCoarseFiles(scene, streamingViewportOptions());

        if (streamingViewportSyncCooldown <= 0) {
            syncStreamingOctreePlacements(scene);
            streamingViewportSyncCooldown = 2;
        } else {
            streamingViewportSyncCooldown--;
        }

        const viewport = getStreamingViewportBootstrapStatus(scene, streamingViewportOptions());
        updateStreamingLoadProgress(
            watermark > 0 ? Math.trunc((current / watermark) * 100) : state.progress
        );

        if (!viewport.ready) {
            streamingRefinementStableFrames = 0;
            return;
        }

        tryShowStreamingCoarseViewport();
        unlockStreamingLod();

        if (streamingViewportSyncCooldown <= 0) {
            syncStreamingOctreePlacements(scene);
            streamingViewportSyncCooldown = 2;
        }

        const refinement = resolveStreamingRefinementStatus();
        if (refinement.pendingNodes > streamingRefinementBaselinePending) {
            streamingRefinementBaselinePending = refinement.pendingNodes;
        }
        trackRefinementProgressForEscape(refinement);
        updateStreamingLoadProgress(
            watermark > 0 ? Math.trunc((current / watermark) * 100) : state.progress
        );

        const mainReady = isBootstrapMainPathReady(refinement);
        const escapeReady = isBootstrapNoProgressEscapeReady(refinement);

        if (!mainReady && !escapeReady) {
            streamingRefinementPendingSpikeFrames++;
            if (streamingRefinementPendingSpikeFrames >= STREAMING_REFINEMENT_PENDING_SPIKE_FRAMES) {
                streamingRefinementStableFrames = 0;
            }
            return;
        }

        streamingRefinementPendingSpikeFrames = 0;
        streamingRefinementStableFrames++;
        if (
            !escapeReady &&
            streamingRefinementStableFrames < STREAMING_REFINEMENT_STABLE_FRAMES
        ) {
            return;
        }

        if (!progressUIHidden) {
            if (!streamingLodUnlocked) {
                streamingRefinementStableFrames = 0;
                return;
            }
            progressUIHidden = true;
            state.progress = 100;
            // Phase D：收条 + 解锁输入（progressThresholdReached）
            finalizeStreamingBootstrapDisplay();
            events.fire('progressThresholdReached', 100);
            if (escapeReady && !mainReady) {
                console.warn(
                    'Streaming octree: bootstrap finalize via no-progress escape',
                    `pending ${refinement.pendingNodes}, staleLod ${refinement.staleLodNodes}`,
                    `peakStale ${streamingRefinementPeakStale}, noProgressFrames ${streamingRefinementNoProgressFrames}`
                );
            }
        }

        if (
            state.animationStarted ||
            revealBlocksAnim(state) ||
            settings.startMode !== 'animTrack' ||
            !state.hasAnimation ||
            config.noanim
        ) {
            return;
        }

        state.animationStarted = true;
        state.animationPaused = false;
        state.progress = 100;
        events.fire('animationStarted');
        console.log(
            'Streaming octree: viewport refinement ready',
            `foreground pending ${refinement.pendingNodes}`,
            `staleLod ${refinement.staleLodNodes}, starting animation`
        );
    };

    const tryUnlockStreamingOnCameraIdle = () => {
        if (!isStreamingOctree || !streamingBootstrapGateReached) {
            return;
        }
        const camState = cameraManager.camera;
        const camPos = camera.getPosition();
        const camFwd = camera.forward;
        const moved = streamLastCamPos.distance(camPos) > 0.03;
        const rotated = streamLastCamFwd.dot(camFwd) < (1 - 0.015);
        const distDelta = Math.abs(camState.distance - streamLastCamDist);
        const fovDelta = Math.abs(camState.fov - streamLastCamFov);
        const zoomed = distDelta > Math.max(0.04, streamLastCamDist * 0.08) || fovDelta > 0.5;
        if (streamingLodUnlocked && (moved || rotated || zoomed)) {
            refinementController?.notifyCameraMoved({ zoom: zoomed });
            idleTime = 0;
            forceRender.set(true);
            app.renderNextFrame = true;
        }
        streamLastCamPos.copy(camPos);
        streamLastCamFwd.copy(camFwd);
        streamLastCamDist = camState.distance;
        streamLastCamFov = camState.fov;
    };

    const readyHandler = (_camera: CameraComponent, _layer: Layer, ready: boolean, loading: number) => {
        if (isStreamingOctree) {
            syncLoadingWatermark(loading);
        }

        if (ready && loading === 0) {
            if (isStreamingOctree) {
                runStreamingSceneWarmupOnce();
                tryOpenStreamingBootstrapGate();
            } else {
                eventHandler.off('frame:ready', readyHandler);

                revealController?.ensureInitialEffectCreatedBeforeFirstDisplay?.();
                forceRender.set(true);
                app.renderNextFrame = true;

                app.once('frameend', () => {
                    if (state.readyToRender) {
                        return;
                    }

                    state.readyToRender = true;
                    ensureShadowPipelineReady();
                    forceRender.set(false);

                    if (
                        isCustomLod &&
                        settings.startMode === 'animTrack' &&
                        state.hasAnimation &&
                        !config.noanim &&
                        !revealBlocksAnim(state)
                    ) {
                        console.log('LOD mode: all chunks loaded, ensuring animation is playing');
                        state.animationStarted = true;
                        state.animationPaused = false;
                    }

                    const updateLod = () => {
                        gsplat.dirty = true;
                        app.renderNextFrame = true;
                    };
                    const onPerformanceModeChanged = isCustomLod ? updateLod : () => {
                        bindGsplatPerfSettings(gsplat, global);
                    };

                    bindGsplatRenderer(gsplat, global);
                    warnOnComputeRendererFallback(global);

                    if (isCustomLod || isFullload) {
                        events.on('performanceMode:changed', onPerformanceModeChanged);
                        onPerformanceModeChanged();
                    }

                    gsplat.debug = config.colorize ? GSPLAT_DEBUG_LOD : GSPLAT_DEBUG_NONE;
                    events.fire('firstFrame');
                    window.firstFrame?.();

                    if (!progressUIHidden) {
                        progressUIHidden = true;
                        events.fire('progressThresholdReached', state.progress);
                    }
                });
            }
        }

        if (loading !== current) {
            watermark = Math.max(watermark, loading);
            current = watermark - loading;

            let progress: number;
            if (isCustomLod && state.animationStarted) {
                progress = 100;
            } else {
                progress = Math.trunc(current / watermark * 100);
                if (isCustomLod) {
                    maxProgress = Math.max(maxProgress, progress);
                    progress = maxProgress;
                }
            }

            if (isStreamingOctree) {
                updateStreamingLoadProgress(progress);
            } else {
                state.progress = progress;
            }

            if (!progressUIHidden && progress >= PROGRESS_THRESHOLD) {
                if (isStreamingOctree) {
                    tryOpenStreamingBootstrapGate();
                } else if (isCustomLod) {
                    progressUIHidden = true;
                    events.fire('progressThresholdReached', progress);

                    if (
                        settings.startMode === 'animTrack' &&
                        state.hasAnimation &&
                        !config.noanim &&
                        !state.animationStarted &&
                        !revealBlocksAnim(state)
                    ) {
                        state.animationStarted = true;
                        console.log(`Progress reached ${PROGRESS_THRESHOLD}%, starting animation`);
                        state.animationPaused = false;
                        events.fire('animationStarted');
                    }
                }
            } else if (isStreamingOctree && streamingBootstrapGateReached) {
                pollStreamingBootstrapComplete();
            }
        }
    };

    const onUpdate = (_dt: number) => {
        idleTime += _dt;
        if (isStreamingOctree && !streamingBootstrapGateReached) {
            if (streamingPreGateKickCooldown <= 0) {
                kickStreamingBootstrapDownloads();
                streamingPreGateKickCooldown = 2;
            } else {
                streamingPreGateKickCooldown--;
            }
            updateStreamingLoadProgress(computeFileLoadProgress());
            tryOpenStreamingBootstrapGate();
        }
        const streamingBootstrapActive =
            isStreamingOctree && !streamingBootstrapDisplayFinalized;
        forceRender.set(streamingBootstrapActive || idleTime < 4);
        tryUnlockStreamingOnCameraIdle();
        if (isStreamingOctree && streamingBootstrapGateReached) {
            pollStreamingBootstrapComplete();
        }
    };

    const onInputEvent = (type: string) => {
        if (type !== 'interact') {
            idleTime = 0;
        }
    };

    const onFrameReady = (_camera: unknown, _layer: unknown, ready: unknown, loading: unknown) => {
        if (loading as number > 0 || !ready) {
            idleTime = 0;
        }
    };

    const onRefinementActivity = (activity: { active?: boolean }) => {
        if (!isStreamingOctree || !activity?.active) {
            return;
        }
        idleTime = 0;
        forceRender.set(true);
        app.renderNextFrame = true;
    };

    const notifyStreamingCameraInteraction = (zoom = false) => {
        if (!isStreamingOctree || !streamingLodUnlocked) {
            return;
        }
        refinementController?.notifyCameraMoved({ zoom });
        idleTime = 0;
        forceRender.set(true);
        app.renderNextFrame = true;
    };

    const onRefinementInputEvent = (type: string) => {
        if (type === 'dblclick' || type === 'interrupt') {
            notifyStreamingCameraInteraction(true);
        }
    };

    const onRefinementPick = () => {
        notifyStreamingCameraInteraction(true);
    };

    const onRefinementNavigateTo = () => {
        notifyStreamingCameraInteraction(true);
    };

    app.on('update', onUpdate);
    events.on('inputEvent', onInputEvent);
    events.on('inputEvent', onRefinementInputEvent);
    events.on('pick', onRefinementPick);
    events.on('navigateTo', onRefinementNavigateTo);
    eventHandler.on('frame:ready', onFrameReady);
    eventHandler.on('frame:ready', readyHandler);
    events.on('octreeRefinement:activity', onRefinementActivity);

    if (isStreamingOctree) {
        // lod-meta 下载阶段可能已把 progress 推高；保留并尝试直接开门禁
        state.progress = Math.min(state.progress, PROGRESS_THRESHOLD);
        if (state.progress >= PROGRESS_THRESHOLD) {
            streamingBootstrapGateReached = true;
        }
        kickStreamingBootstrapDownloads();
        app.once('frameend', () => {
            kickStreamingBootstrapDownloads();
            tryOpenStreamingBootstrapGate();
            if (streamingBootstrapGateReached) {
                pollStreamingBootstrapComplete();
            }
        });
    }

    return {
        destroy() {
            app.off('update', onUpdate);
            events.off('inputEvent', onInputEvent);
            events.off('inputEvent', onRefinementInputEvent);
            events.off('pick', onRefinementPick);
            events.off('navigateTo', onRefinementNavigateTo);
            eventHandler.off('frame:ready', onFrameReady);
            eventHandler.off('frame:ready', readyHandler);
            events.off('octreeRefinement:activity', onRefinementActivity);
            if (perfModeHandler) {
                events.off('performanceMode:changed', perfModeHandler);
            }
            refinementController?.destroy();
            onRefinementController(null);
        }
    };
}

function configureInitialGsplatScene(
    gsplat: GsplatSceneRuntime,
    global: Global,
    gsplatEntity: Entity,
    loadMode: OctreeLoadMode,
    octreeResource: GSplatOctreeResourceLike | null
): void {
    const { config } = global;
    const { isCustomLod, isStreamingOctree, isFullload } = loadMode;

    if (isCustomLod) {
        gsplat.minContribution = 1;
        gsplat.alphaClip = 1 / 255;
        gsplat.antiAlias = config.aa;
        return;
    }

    if (isFullload) {
        bindGsplatPerfSettings(gsplat, global);
        return;
    }

    if (isStreamingOctree) {
        const lodLevels = octreeResource?.octree?.lodLevels;
        if (lodLevels) {
            const coarseLod = lodLevels - 1;
            applyLodRangeToGsplatEntity(gsplatEntity, coarseLod, coarseLod);
        }
        gsplat.splatBudget = getSplatBudgetMillions(global) * 1_000_000;
        bindGsplatRenderer(gsplat, global);
        gsplat.dirty = true;
    }
}
