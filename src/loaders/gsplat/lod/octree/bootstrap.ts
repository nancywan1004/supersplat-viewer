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
    bindGsplatPerfSettings,
    bindGsplatRenderer,
    getSplatBudgetMillions,
    warnOnComputeRendererFallback,
    type GsplatSceneRuntime
} from '../scene-bindings';
import {
    computeStreamingRefinementProgressRatio,
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

    gsplat.lodUpdateAngle = 90;
    gsplat.lodBehindPenalty = 5;
    gsplat.radialSorting = true;

    const eventHandler = app.systems.gsplat;
    let idleTime = 0;
    forceRender.set(true);

    let refinementController: OctreeRefinementController | null = null;
    let current = 0;
    let watermark = 1;
    let maxProgress = 0;
    let progressUIHidden = false;

    const PROGRESS_THRESHOLD = 50;
    const PROGRESS_COARSE_CAP = 82;
    const PROGRESS_REFINEMENT_CAP = 99;
    const STREAMING_REFINEMENT_STABLE_FRAMES = 10;
    const STREAMING_REFINEMENT_PENDING_SPIKE_FRAMES = 3;
    const STREAMING_REFINEMENT_STALL_MS = 5000;

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
    let streamingRefinementCapReachedAt = 0;
    let streamingRefinementBaselinePending = 0;
    let streamingRefinementPhaseStarted = false;

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
                ready: false
            };
        }
        return getStreamingViewportRefinementStatus(scene, streamingViewportOptions());
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
        revealController?.ensureInitialEffectCreatedBeforeFirstDisplay?.();
        forceRender.set(true);
        app.renderNextFrame = true;
        app.once('frameend', () => {
            bindGsplatRenderer(gsplat, global);
            warnOnComputeRendererFallback(global);
            gsplat.debug = config.colorize ? GSPLAT_DEBUG_LOD : GSPLAT_DEBUG_NONE;
            forceRender.set(false);
            if (streamingPendingCoarseDisplay && !state.readyToRender) {
                streamingPendingCoarseDisplay = false;
                state.readyToRender = true;
                ensureShadowPipelineReady();
            }
        });
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
            state.progress = Math.min(fileProgress, PROGRESS_THRESHOLD);
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
            state.progress = refinement.ready ? PROGRESS_REFINEMENT_CAP : PROGRESS_COARSE_CAP;
            return;
        }

        const doneRatio = computeStreamingRefinementProgressRatio(
            refinement.pendingNodes,
            streamingRefinementBaselinePending
        );
        const refinementProgress =
            PROGRESS_COARSE_CAP +
            Math.round(doneRatio * (PROGRESS_REFINEMENT_CAP - PROGRESS_COARSE_CAP));
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
        bindGsplatPerfSettings(gsplat, global);
        const maxLod = octreeResource?.octree?.lodLevels;
        if (maxLod) {
            gsplat.lodRangeMin = 0;
            gsplat.lodRangeMax = maxLod - 1;
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
    };

    const pollStreamingBootstrapComplete = () => {
        if (!isStreamingOctree || !streamingBootstrapGateReached) {
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
        updateStreamingLoadProgress(
            watermark > 0 ? Math.trunc((current / watermark) * 100) : state.progress
        );

        if (!refinement.ready) {
            streamingRefinementPendingSpikeFrames++;
            if (streamingRefinementPendingSpikeFrames >= STREAMING_REFINEMENT_PENDING_SPIKE_FRAMES) {
                streamingRefinementStableFrames = 0;
                streamingRefinementCapReachedAt = 0;
            }
            return;
        }
        streamingRefinementPendingSpikeFrames = 0;

        if (state.progress >= PROGRESS_REFINEMENT_CAP && !streamingRefinementCapReachedAt) {
            streamingRefinementCapReachedAt = performance.now();
        }

        streamingRefinementStableFrames++;
        const refinementStalledAtCap =
            streamingRefinementCapReachedAt > 0 &&
            performance.now() - streamingRefinementCapReachedAt >= STREAMING_REFINEMENT_STALL_MS;
        if (
            streamingRefinementStableFrames < STREAMING_REFINEMENT_STABLE_FRAMES &&
            !refinementStalledAtCap
        ) {
            return;
        }

        if (!progressUIHidden) {
            if (!streamingLodUnlocked || state.progress < PROGRESS_COARSE_CAP) {
                streamingRefinementStableFrames = 0;
                streamingRefinementCapReachedAt = 0;
                return;
            }
            progressUIHidden = true;
            state.progress = 100;
            finalizeStreamingBootstrapDisplay();
            events.fire('progressThresholdReached', 100);
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
            'Streaming octree: viewport refinement downloads ready',
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
        if (ready && loading === 0) {
            if (isStreamingOctree) {
                runStreamingSceneWarmupOnce();
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
                        const gsplatScene = app.scene.gsplat as {
                            lodRangeMin?: number;
                            lodRangeMax?: number;
                            splatBudget?: number;
                        };
                        if (gsplatScene.lodRangeMin !== undefined) {
                            gsplat.lodRangeMin = gsplatScene.lodRangeMin;
                            gsplat.lodRangeMax = gsplatScene.lodRangeMax ?? gsplat.lodRangeMax;
                            if (gsplatScene.splatBudget !== undefined) {
                                gsplatEntity.gsplat!.splatBudget = gsplatScene.splatBudget * 1_000_000;
                            }
                        }
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
                    streamingBootstrapGateReached = true;
                    pollStreamingBootstrapComplete();
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
        forceRender.set(idleTime < 4);
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
        const gsplatScene = global.app.scene.gsplat as {
            lodRangeMax?: number;
            splatBudget?: number;
        };
        if (gsplatScene.lodRangeMax !== undefined) {
            if (gsplatScene.splatBudget !== undefined) {
                gsplatEntity.gsplat!.splatBudget = gsplatScene.splatBudget * 1_000_000;
            }
            gsplat.lodRangeMin = 0;
            gsplat.lodRangeMax = gsplatScene.lodRangeMax;
        } else {
            gsplat.lodRangeMin = 0;
            gsplat.lodRangeMax = 5;
        }
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
            gsplat.lodRangeMax = gsplat.lodRangeMin = lodLevels - 1;
        }
        gsplat.splatBudget = getSplatBudgetMillions(global) * 1_000_000;
        bindGsplatRenderer(gsplat, global);
        gsplat.dirty = true;
    }
}
