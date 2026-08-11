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
import {
    STREAMING_BOOTSTRAP,
    computeBootstrapDoneRatio,
    createBootstrapWorkloadState,
    hasSeenRefinePressure,
    isAtEffectiveClearTarget,
    mapCoarsePlacementProgress,
    mapRefinementUiProgress,
    resetBootstrapWorkloadState,
    stepBootstrapCompletion,
    type BootstrapRefinementSnapshot,
    type BootstrapWorkloadState
} from './streaming-bootstrap-policy';
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
     * Streaming 首屏：参数与收条判定见 streaming-bootstrap-policy.ts（单一策略）。
     * A gate% → B coarseCap% → C refineCap% → D 100% finalize。
     */
    const { progress: BOOT_PROGRESS } = STREAMING_BOOTSTRAP;
    const refinementWorkload: BootstrapWorkloadState = createBootstrapWorkloadState();

    let streamingLodUnlocked = false;
    let streamingPerfHandlerRegistered = false;
    let streamingBootstrapGateReached = false;
    let streamingSceneWarmupDone = false;
    let streamingPendingCoarseDisplay = false;
    let streamingCoarseDisplayed = false;
    let streamingBootstrapDisplayFinalized = false;
    let streamingViewportSyncCooldown = 0;
    let streamingRefinementPhaseStarted = false;
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
                centerTargetNodes: 0,
                centerClearNodes: 0,
                settlingFrames: 0,
                tickSeq: 0,
                ready: false
            };
        }
        return getStreamingViewportRefinementStatus(scene, streamingViewportOptions());
    };

    const hasValidRefinementTick = (): boolean =>
        refinementController?.getLastTickMetrics() != null;

    const toBootstrapSnap = (
        refinement: ReturnType<typeof resolveStreamingRefinementStatus>
    ): BootstrapRefinementSnapshot => {
        const tick = refinementController?.getLastTickMetrics();
        return {
            pendingNodes: refinement.pendingNodes,
            staleLodNodes: refinement.staleLodNodes,
            centerEngineBehindNodes: refinement.centerEngineBehindNodes ?? 0,
            centerTargetNodes:
                refinement.centerTargetNodes ?? tick?.centerTargetNodes ?? 0,
            centerClearNodes:
                refinement.centerClearNodes ?? tick?.centerClearNodes ?? 0,
            centerBehindNoEngine: tick?.centerBehindNoEngine ?? 0,
            settlingFrames: refinement.settlingFrames ?? 0,
            staleLoadedNodes: refinement.staleLoadedNodes ?? 0,
            tickSeq: refinement.tickSeq ?? 0
        };
    };

    const noteBaselinePending = (pendingNodes: number) => {
        if (pendingNodes > refinementWorkload.baselinePending) {
            refinementWorkload.baselinePending = pendingNodes;
        }
    };

    const finalizeStreamingBootstrapDisplay = () => {
        if (streamingBootstrapDisplayFinalized) {
            return;
        }
        streamingBootstrapDisplayFinalized = true;
        // 收条后退出 BootstrapFast，后台追满 engineOptimal（不挡交互）
        refinementController?.setBootstrapCoarsenActive(false);
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
            Math.min(fileProgress, BOOT_PROGRESS.gate)
        );

        if (fileProgress >= BOOT_PROGRESS.gate || mergedPreGate >= BOOT_PROGRESS.gate) {
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
            state.progress = Math.max(state.progress, Math.min(fileProgress, BOOT_PROGRESS.gate));
            return;
        }

        const scene = streamingScene();
        if (!scene) {
            state.progress = Math.min(Math.max(state.progress, fileProgress), BOOT_PROGRESS.gate);
            return;
        }

        const viewport = getStreamingViewportBootstrapStatus(scene, streamingViewportOptions());

        if (!viewport.ready) {
            state.progress = Math.max(
                state.progress,
                mapCoarsePlacementProgress(viewport.placementRatio)
            );
            return;
        }

        if (!streamingLodUnlocked) {
            state.progress = BOOT_PROGRESS.coarseCap;
            return;
        }

        if (!streamingRefinementPhaseStarted) {
            streamingRefinementPhaseStarted = true;
            state.progress = BOOT_PROGRESS.coarseCap;
        }

        const refinement = resolveStreamingRefinementStatus();
        noteBaselinePending(refinement.pendingNodes);
        const snap = toBootstrapSnap(refinement);
        const hasTick = hasValidRefinementTick();
        const doneRatio = computeBootstrapDoneRatio(snap, refinementWorkload);

        // 粗档对齐期 clear/target 会虚高：未见真实细化压力前进度停在 coarseCap
        // （勿在此处跳 refineCap=99，否则会「瞬间 99 干等 settle/quiet」）
        if (!hasSeenRefinePressure(refinementWorkload)) {
            state.progress = Math.max(state.progress, BOOT_PROGRESS.coarseCap);
            return;
        }

        if (snap.centerTargetNodes <= 0 && refinementWorkload.peakCenterTarget <= 0) {
            state.progress = Math.max(state.progress, BOOT_PROGRESS.coarseCap);
            return;
        }

        const refinementProgress = mapRefinementUiProgress(doneRatio, {
            completedSettleCycles: refinementWorkload.completedSettleCycles,
            postSettleQuietTicks: refinementWorkload.postSettleQuietTicks,
            atEffectiveClearTarget: isAtEffectiveClearTarget(snap)
        });
        state.progress = Math.min(
            BOOT_PROGRESS.refineCap,
            Math.max(state.progress, refinementProgress)
        );
    };

    const unlockStreamingLod = () => {
        if (!isStreamingOctree || streamingLodUnlocked) {
            return;
        }
        streamingLodUnlocked = true;
        resetBootstrapWorkloadState(refinementWorkload);
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
            refinementWorkload.postSettleQuietTicks = 0;
            refinementWorkload.completedSettleCycles = 0;
            refinementWorkload.wasPendingZero = false;
            return;
        }

        tryShowStreamingCoarseViewport();
        unlockStreamingLod();

        if (streamingViewportSyncCooldown <= 0) {
            syncStreamingOctreePlacements(scene);
            streamingViewportSyncCooldown = 2;
        }

        const refinement = resolveStreamingRefinementStatus();
        noteBaselinePending(refinement.pendingNodes);

        // 先推进 settle/quiet，再刷 UI：clear 齐后进度靠 quiet 从 ~91 爬到 99，避免先钉 99 再干等
        const step = stepBootstrapCompletion(
            refinementWorkload,
            toBootstrapSnap(refinement),
            { hasValidTick: hasValidRefinementTick() }
        );
        updateStreamingLoadProgress(
            watermark > 0 ? Math.trunc((current / watermark) * 100) : state.progress
        );

        if (!step.shouldFinalize) {
            return;
        }

        if (!progressUIHidden) {
            if (!streamingLodUnlocked) {
                refinementWorkload.postSettleQuietTicks = 0;
                return;
            }
            progressUIHidden = true;
            state.progress = 100;
            // Phase D：收条 + 解锁输入（progressThresholdReached）
            finalizeStreamingBootstrapDisplay();
            events.fire('progressThresholdReached', 100);
            if (step.finalizeReason === 'escape') {
                console.warn(
                    'Streaming octree: bootstrap finalize via no-progress escape',
                    `pending ${refinement.pendingNodes}, staleLod ${refinement.staleLodNodes}`,
                    `peakStale ${refinementWorkload.peakStale}, noProgressFrames ${refinementWorkload.noProgressFrames}`,
                    `fine ${refinement.centerClearNodes}/${refinement.centerTargetNodes}`,
                    `peakBehindRatio ${refinementWorkload.peakBehindRatio.toFixed(2)}`
                );
            } else {
                console.log(
                    'Streaming octree: bootstrap finalize',
                    `fine ${refinement.centerClearNodes}/${refinement.centerTargetNodes}`,
                    `pending ${refinement.pendingNodes}, ctr↓ ${refinement.centerEngineBehindNodes}`,
                    `settleCycles ${refinementWorkload.completedSettleCycles}`,
                    `quietTicks ${refinementWorkload.postSettleQuietTicks}`,
                    `peakBehindRatio ${refinementWorkload.peakBehindRatio.toFixed(2)}`,
                    `baselinePending ${refinementWorkload.baselinePending}`
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

            if (!progressUIHidden && progress >= BOOT_PROGRESS.gate) {
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
                        console.log(`Progress reached ${BOOT_PROGRESS.gate}%, starting animation`);
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
        state.progress = Math.min(state.progress, BOOT_PROGRESS.gate);
        if (state.progress >= BOOT_PROGRESS.gate) {
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
