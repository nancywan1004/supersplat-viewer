import {
    BoundingBox,
    CameraFrame,
    Color,
    Entity,
    RenderTarget,
    Mat4,
    MiniStats,
    ShaderChunks,
    StandardMaterial,
    Texture,
    type TextureHandler,
    PIXELFORMAT_RGBA16F,
    PIXELFORMAT_RGBA32F,
    TONEMAP_NONE,
    TONEMAP_LINEAR,
    TONEMAP_FILMIC,
    TONEMAP_HEJL,
    TONEMAP_ACES,
    TONEMAP_ACES2,
    TONEMAP_NEUTRAL,
    Vec3,
    GSplatComponent,
    GSplatComponentSystem
} from 'playcanvas';

import { Annotations } from './annotations';
import { CameraManager } from './camera-manager';
import { Camera } from './cameras/camera';
import type { Collision } from './collision';
import { MeshCollision, VoxelCollision } from './collision';
import {
    getCameraCollisionManager,
    type CollisionLoadPayload,
    type SceneMeshReadyPayload
} from './collision/camera-collision-manager';
import { installCollisionOverlayConsole } from './collision/collision-overlay-console';
import type { ShadowPipelineMount } from './vfx/shadow/shadow-system';
import { nearlyEquals } from './core/math';
import { InputController } from './input-controller';
import { MeshDebugOverlay } from './mesh-debug-overlay';
import { NavCursor } from './nav-cursor';
import { Picker } from './picker/index';
import type { ExperienceSettings, PostEffectSettings } from './settings';
import { readPersistentTrackEffects, shouldDeferPersistentMount } from './settings-serialize/effects-sync';
import type { Global } from './types';
import { nightDeferredByReveal, revealBlocksAnim } from './vfx/effects-runtime/reveal/reveal-policy';
import { RevealController } from './vfx/effects-runtime/reveal/reveal-controller';
import {
    applyPersistentSceneEffectEnableChange,
    destroyPersistentSceneEffectByType,
    mountPersistentSceneEffectByType,
    runPersistentGsplatEntityLifecycle
} from './vfx/effects-runtime/persistent/persistent-gsplat-lifecycle';
import { POINTILLISM_DEFAULTS } from './vfx/effects-runtime/persistent/stylisation/pointillism-stipple-shaders';
import { charcoalPaperClearColor } from './vfx/effects-runtime/persistent/stylisation/charcoal-sketch';
import { penPaperClearColor } from './vfx/effects-runtime/persistent/stylisation/pen-sketch';
import {
    isCharcoalSketchRuntimeActive,
    isPenSketchRuntimeActive,
    isWatercolorRuntimeActive,
    readCharcoalSketchEffectParams,
    readPenSketchEffectParams,
    readWatercolorEffectParams
} from './vfx/effects-runtime/persistent/stylisation/stylisation-paper-runtime';
import { watercolorPaperClearColor } from './vfx/effects-runtime/persistent/stylisation/watercolor';
import { buildSkyboxPsChunk } from './vfx/effects-runtime/persistent/stylisation/skybox-pointillism-shaders';
import { refreshSkyboxMaterialShader } from './vfx/effects-runtime/persistent/stylisation/skybox-pointillism-runtime';
import { CameraPathVisualizer, type VisualizerOptions } from './camera-path-visualizer';
import { getSkyboxRadius } from './loaders/skybox/skybox-loader';
import { readSkyboxCurrentUrlFromSettings } from './settings-serialize/settings-serialize-helper';
import { bootstrapOctreeLod, type OctreeLodBootstrapHandle } from './loaders/gsplat/lod/octree/bootstrap';
import { bootstrapSogUnified } from './loaders/gsplat/sog/bootstrap';
import type { OctreeRefinementController } from './loaders/gsplat/lod/octree/refinement-controller';
import { BloomController } from './vfx/bloom';
import { NightMode } from './vfx/lighting/night-mode';
import {
    hasShadowSceneMesh,
    isShadowSystemEnabled,
    notifyViewportReadyForShadow,
    scheduleShadowPipeline,
} from './vfx/shadow';
import { initTorchLight } from './vfx/lighting/torch-light';
import { initAssetPlacementHandler, requestSceneAssetsRestore } from './scene-assets/asset-placement-handler';
import { initSceneAssetCollision } from './scene-assets/collision/scene-asset-collision';
import { initSceneAssetCollisionDebug } from './scene-assets/collision/scene-asset-collision-debug';
import { initMediaHotspotController } from './scene-assets/media/media-hotspot-controller';
import { initSceneAudioCallout } from './scene-assets/media/audio-callout';
import {
    initVideoControlsInteraction,
    initVideoControlsTexture
} from './scene-assets/media/video-controls-texture';
import { pushEditHistory } from './edit-history';
import { initGizmoHandler } from './gizmo-handler';
import { initAnnotationGizmoHandler } from './annotation-toolbar/annotation-gizmo-handler';
import { initAnnotationSystem } from './annotation-toolbar/init-annotation-system';
import { initModuleOrchestrator, type ModuleOrchestrator } from './editor-modules/module-orchestrator';
import { initAssetFacade } from './editor-modules/asset-facade';
import { initAnnotationFacade } from './editor-modules/annotation-facade';
import { applyAllAnnotationsVisibilityFromSettings } from './annotation-toolbar/annotation-visibility';
import { initEnvironmentFacade } from './editor-modules/environment-facade';
import { initEffectsFacade } from './editor-modules/effects-facade';
import { createAssetEffectsController, type AssetEffectsController } from './vfx/effects-runtime/asset/asset-effects-controller';
import {
    createAssetEffectViewToggleController,
    type AssetEffectViewToggleController
} from './vfx/effects-runtime/asset/asset-effect-view-toggle-controller';
import { createEffectsRuntime, type EffectsRuntime } from './vfx/effects-runtime';
import { hasEnabledPersistentGsplatMaterialShaderEffect } from './vfx/effects-runtime/effects-pipeline-policy';
import { initCommandRegistry } from './editor-modules/command-registry';
import { initSceneContentVisibility, getSceneContentVisibilityRegistry } from './scene-visibility';
import { DEFAULT_DEFERRED_EDITING_LAYERS } from './render/deferred-editing-visual-sync';
import { initInputArbiter } from './input-arbiter';
import { VoxelDebugOverlay } from './voxel-debug-overlay';

// String.replace wrapper that warns when the source substring is missing, so
// shader chunk patches against the engine fail loudly instead of silently
// producing the original chunk.
const patchChunk = (source: string | undefined, search: string, replacement: string, name: string): string => {
    if (source == null) {
        console.warn(`patchChunk: source missing for '${name}', patch skipped.`);
        return '';
    }
    if (!source.includes(search)) {
        console.warn(`patchChunk: substring not found in '${name}', shader chunk patch may be out of sync with the engine.`);
    }
    return source.replace(search, replacement);
};

// compute 渲染器在 ?nofx 时也需要 CameraFrame 做 tile composite，因此提供一份全关闭后处理配置。
const noPostEffects: PostEffectSettings = {
    sharpness: { enabled: false, amount: 0 },
    bloom: {
        enabled: false,
        intensity: 0,
        blurLevel: 0,
        threshold: 0,
        bloomDebug: false,
        bloomScope: 'global',
        bloomBrushSize: 30,
        bloomBrushBrightness: 1
    },
    grading: { enabled: false, brightness: 0, contrast: 1, saturation: 1, tint: [1, 1, 1] },
    vignette: { enabled: false, intensity: 0, inner: 0, outer: 0, curvature: 0 },
    fringing: { enabled: false, intensity: 0 },
    shadow: { darken: 0, debugVisual: false, castShadows: false }
};

const gammaChunkGlsl = `
#include "decodePS"
#include "fogPS"

#if FOG != NONE && !defined(GSPLAT_NO_FOG)
    #define GSPLAT_FOG
#endif

vec3 prepareOutputFromGamma(vec3 gammaColor, float depth) {
    #ifdef GSPLAT_FOG
        vec3 linear = decodeGamma(gammaColor);
        linear = addFog(linear, depth);
        return pow(linear + 0.0000001, vec3(1.0 / 2.2));
    #endif

    return gammaColor;
}
`;

const gammaChunkWgsl = `
#include "decodePS"
#include "fogPS"

#if FOG != NONE && !defined(GSPLAT_NO_FOG)
    #define GSPLAT_FOG
#endif

fn prepareOutputFromGamma(gammaColor: vec3f, depth: f32) -> vec3f {
    #ifdef GSPLAT_FOG
        var linear = decodeGamma3(gammaColor);
        linear = addFog(linear, depth);
        return pow(linear + vec3f(0.0000001), vec3f(1.0 / 2.2));
    #endif

    return gammaColor;
}
`;

const tonemapTable: Record<string, number> = {
    none: TONEMAP_NONE,
    linear: TONEMAP_LINEAR,
    filmic: TONEMAP_FILMIC,
    hejl: TONEMAP_HEJL,
    aces: TONEMAP_ACES,
    aces2: TONEMAP_ACES2,
    neutral: TONEMAP_NEUTRAL
};

/** 仅处理非 Bloom 的后处理（Bloom 由 BloomController 统一配置） */
const applyPostEffectSettings = (cameraFrame: CameraFrame, settings: PostEffectSettings) => {
    if (settings.sharpness.enabled) {
        cameraFrame.rendering.sharpness = settings.sharpness.amount;
    } else {
        cameraFrame.rendering.sharpness = 0;
    }

    const { grading } = cameraFrame;
    if (settings.grading.enabled) {
        grading.enabled = true;
        grading.brightness = settings.grading.brightness;
        grading.contrast = settings.grading.contrast;
        grading.saturation = settings.grading.saturation;
        grading.tint = new Color().fromArray(settings.grading.tint);
    } else {
        grading.enabled = false;
    }

    const { vignette } = cameraFrame;
    if (settings.vignette.enabled) {
        vignette.intensity = settings.vignette.intensity;
        vignette.inner = settings.vignette.inner;
        vignette.outer = settings.vignette.outer;
        vignette.curvature = settings.vignette.curvature;
    } else {
        vignette.intensity = 0;
    }

    const { fringing } = cameraFrame;
    if (settings.fringing.enabled) {
        fringing.intensity = settings.fringing.intensity;
    } else {
        fringing.intensity = 0;
    }
};

const needsBloomPipeline = (settings: PostEffectSettings): boolean => {
    const bloom = settings?.bloom as any;
    if (!bloom) return false;
    // 对齐 global/local：只要 Bloom blur 配置有效，就保持 CameraFrame/Bloom 路径一致。
    // 这样 intensity=0 时切 scope 不会因为管线启停差异导致 mesh 观感分叉。
    const blurLevel = Number(bloom.blurLevel ?? 0);
    if (!(Number.isFinite(blurLevel) && blurLevel > 0)) return false;
    return true;
};

const anyPostEffectEnabled = (
    settings: PostEffectSettings,
    config: Global['config'],
    allSettings: ExperienceSettings
): boolean => {
    const bloomOn = settings.bloom.enabled && (
        Number(settings.bloom.intensity) > 0 ||
        needsBloomPipeline(settings)
    );
    const shadowOn = isShadowSystemEnabled({ config, settings: allSettings });
    return (settings.sharpness.enabled && settings.sharpness.amount > 0) ||
        bloomOn ||
        (settings.grading.enabled) ||
        (settings.vignette.enabled && settings.vignette.intensity > 0) ||
        (settings.fringing.enabled && settings.fringing.intensity > 0) ||
        shadowOn;
};

const isNostalgicComicPersistentActive = (settings: ExperienceSettings): boolean => {
    return readPersistentTrackEffects(settings, 'stylization').some(e => e.type === 'nostalgic-comic');
};

const isYiyunDianranPersistentActive = (settings: ExperienceSettings): boolean => {
    return readPersistentTrackEffects(settings, 'stylization').some(e => e.type === 'yiyun-dianran');
};

const isYiyunDianranPostEffectActive = (settings: ExperienceSettings): boolean => {
    if (!isYiyunDianranPersistentActive(settings)) {
        return false;
    }
    const params = readPersistentTrackEffects(settings, 'stylization', { includeDisabled: true })
        .find(e => e.type === 'yiyun-dianran')?.effectParams;
    if (params && typeof params === 'object' && typeof params.postEffectEnabled === 'boolean') {
        return params.postEffectEnabled;
    }
    return true;
};

const isPalettePixelPersistentActive = (settings: ExperienceSettings): boolean => {
    return readPersistentTrackEffects(settings, 'stylization').some(e => e.type === 'palette-pixel');
};

const isPointillismStippleEnabled = (settings: ExperienceSettings): boolean => {
    const entry = readPersistentTrackEffects(settings, 'stylization', { includeDisabled: true })
        .find(e => e.type === 'pointillism-stipple');
    return !!entry?.enabled;
};

const isPointillismStipplePostEffectActive = (settings: ExperienceSettings): boolean => {
    if (!isPointillismStippleEnabled(settings)) {
        return false;
    }
    const entry = readPersistentTrackEffects(settings, 'stylization', { includeDisabled: true })
        .find(e => e.type === 'pointillism-stipple');
    const raw = entry?.effectParams?.postEffectEnabled;
    if (typeof raw === 'boolean') {
        return raw;
    }
    if (raw === 1 || raw === '1' || raw === 'true') {
        return true;
    }
    return POINTILLISM_DEFAULTS.postEffectEnabled;
};

const YIYUN_DIANRAN_PAPER_CLEAR = new Color(0.98, 0.94, 0.85, 1);

const vec = new Vec3();

// store the original isColorBufferSrgb so the override in updatePostEffects is idempotent
const origIsColorBufferSrgb = RenderTarget.prototype.isColorBufferSrgb;

class Viewer {
    global: Global;

    cameraFrame: CameraFrame;

    inputController: InputController;

    revealController: RevealController;

    cameraManager: CameraManager;

    picker: Picker;

    annotations: Annotations | null = null;

    forceRenderNextFrame = false;
    pathVisualizer: CameraPathVisualizer | null = null;

    /** Bloom 统一由 BloomController 管理，不往 gsplat 挂脚本，避免覆盖 reveal */
    bloomController: BloomController | null = null;

    /** Night Mode 脚本（用于 Night Mode + Bloom Brush 合成） */
    nightModeScript: InstanceType<typeof NightMode> | null = null;

    /** 普通 octree streaming 首帧后的视锥/屏幕误差优先 refinement */
    octreeRefinementController: OctreeRefinementController | null = null;

    private octreeLodBootstrap: OctreeLodBootstrapHandle | null = null;

    /** 将 cameraManager 的相机姿态应用到实体（导出时 seek anim 后调用） */
    applyCameraFromManager: () => void = () => {};

    /** 资产放置 handler 清理函数 */
    cleanupAssetPlacementHandler: (() => void) | null = null;

    /** sceneAsset AABB 碰撞运行时清理 */
    cleanupSceneAssetCollision: (() => void) | null = null;

    /** 相机物理碰撞 Manager 清理 */
    cleanupCameraCollision: (() => void) | null = null;

    /** urlParam 加载的原始场景碰撞（与开关/编辑态门控无关，供 debug overlay 使用） */
    baseSceneCollision: Collision | null = null;

    /** 阴影管线挂载参数（GLB 懒加载完成后热更新 meshEntity） */
    private shadowPipelineMount: ShadowPipelineMount | null = null;

    /** 避免同帧多次 schedule；接影 mesh 挂载延后到 frameend，规避与 configureCamera 等同帧 draw 竞态 */
    private shadowPipelineFrameScheduled = false;

    /** 音视频热区播控卸载 */
    cleanupMediaHotspotController: (() => void) | null = null;
    cleanupSceneAudioCallout: (() => void) | null = null;
    cleanupVideoControlsTexture: (() => void) | null = null;
    cleanupVideoControlsInteraction: (() => void) | null = null;

    /** Gizmo handler 清理函数 */
    cleanupGizmoHandler: (() => void) | null = null;

    /** Annotation Gizmo handler 清理函数 */
    cleanupAnnotationGizmoHandler: (() => void) | null = null;

    /** 编辑模块生命周期编排器（orchestrator-core） */
    moduleOrchestrator: ModuleOrchestrator | null = null;

    /** 特效运行时（reveal / persistent / asset）；M1 仅占位，不改变现有 VFX 行为 */
    effectsRuntime: EffectsRuntime | null = null;

    assetEffectsController: AssetEffectsController | null = null;

    assetEffectViewToggleController: AssetEffectViewToggleController | null = null;

    voxelOverlay: VoxelDebugOverlay | null = null;

    meshOverlay: MeshDebugOverlay | null = null;

    navCursor: NavCursor | null = null;

    /** 开场 reveal 播放期间，风格化 persistent 的相机后处理与 clearColor 跟随实体脚本一起延后生效。 */
    private deferPersistentStylizationCameraEffects = false;

    origChunks: {
        glsl: {
            gsplatOutputVS: string,
            skyboxPS: string
        },
        wgsl: {
            gsplatOutputVS: string,
            skyboxPS: string
        }
    };

    constructor(global: Global, gsplatLoad: Promise<Entity>) {
        this.global = global;

        const { app, settings, config, events, state, camera } = global;
        const { graphicsDevice } = app;

        const collisionMgr = getCameraCollisionManager(global);
        collisionMgr.configure();
        installCollisionOverlayConsole(global);
        events.on('cameraCollision:load', (payload: CollisionLoadPayload) => {
            if (payload.state === 'ready') {
                const sceneCollision = collisionMgr.getCollision();
                if (sceneCollision) {
                    this.bindSceneCollisionDebugOverlay(sceneCollision);
                }
            }
        });
        events.on('sceneMesh:ready', (_payload: SceneMeshReadyPayload) => {
            this.applyShadowMeshEntity(collisionMgr.getSceneMeshEntity());
        });
        events.on('sceneMesh:cleared', () => {
            if (this.shadowPipelineMount) {
                this.shadowPipelineMount.meshEntity = null;
            }
            this.destroySceneCollisionDebugOverlay();
        });
        events.on('collisionOverlayEnabled:changed', (value: boolean) => {
            if (this.voxelOverlay) {
                this.voxelOverlay.enabled = value;
            }
            if (this.meshOverlay) {
                this.meshOverlay.enabled = value;
            }
            app.renderNextFrame = true;
        });

        initInputArbiter(global);

        // 仅初始化 orchestrator 核心骨架：后续 phase 再逐步注册各模块 facade
        this.moduleOrchestrator = initModuleOrchestrator(global);
        initCommandRegistry(global);
        (global as any).__moduleOrchestrator = this.moduleOrchestrator;
        initAssetFacade(global);
        initAnnotationFacade(global);
        initEnvironmentFacade(global);
        initEffectsFacade(global);
        initSceneContentVisibility(global);
        this.effectsRuntime = createEffectsRuntime(global);
        (global as any).__effectsRuntime = this.effectsRuntime;
        (app as any).effectsRuntime = this.effectsRuntime;

        // enable anonymous CORS for image loading in safari
        (app.loader.getHandler('texture') as TextureHandler).imgParser.crossOrigin = 'anonymous';

        // render skybox as plain equirect
        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        glsl.set('skyboxPS', patchChunk(glsl.get('skyboxPS'), 'mapRoughnessUv(uv, mipLevel)', 'uv', 'glsl skyboxPS'));

        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', patchChunk(wgsl.get('skyboxPS'), 'mapRoughnessUv(uv, uniform.mipLevel)', 'uv', 'wgsl skyboxPS'));

        this.origChunks = {
            glsl: {
                gsplatOutputVS: glsl.get('gsplatOutputVS'),
                skyboxPS: glsl.get('skyboxPS')
            },
            wgsl: {
                gsplatOutputVS: wgsl.get('gsplatOutputVS'),
                skyboxPS: wgsl.get('skyboxPS')
            }
        };

        const getCameraFrame = () => this.cameraFrame;
        (app as { getCameraFrame?: () => CameraFrame | null }).getCameraFrame = getCameraFrame;

        this.bloomController = new BloomController(global, {
            getCameraFrame,
            getAppCanvas: () => (app.graphicsDevice?.canvas as HTMLCanvasElement) ?? document.querySelector('canvas'),
            getNightModeScript: () => this.nightModeScript
        });

        // disable auto render, we'll render only when camera changes
        app.autoRender = false;

        app.systems.gsplat.on(GSplatComponentSystem.EVENT_FRAMEREQUEST, () => {
            app.renderNextFrame = true;
        });

        this.deferPersistentStylizationCameraEffects = shouldDeferPersistentMount(settings);

        // configure the camera
        this.configureCamera(settings);

        events.on('revealRestart', () => {
            this.setPersistentStylizationCameraEffectsDeferred(shouldDeferPersistentMount(global.settings));
        });
        events.on('revealComplete', () => {
            this.setPersistentStylizationCameraEffectsDeferred(false);
        });

        // reconfigure camera when entering/exiting XR
        app.xr.on('start', () => this.configureCamera(settings));
        app.xr.on('end', () => this.configureCamera(settings));

        events.on('postEffect:changed', () => {
            this.configureCamera(global.settings);
            app.renderNextFrame = true;
        });
        app.on('nightFade:changedDetailed', () => {
            this.configureCamera(global.settings);
            app.renderNextFrame = true;
        });
        // handle canvas resize - update aspect ratio and trigger render
        const handleResize = () => {
            camera.camera.aspectRatio = graphicsDevice.width / graphicsDevice.height;
            app.renderNextFrame = true;
        };
        graphicsDevice.on('resizecanvas', handleResize);
        // construct debug ministats
        if (config.ministats) {
            const options = MiniStats.getDefaultOptions() as any;
            options.cpu.enabled = false;
            options.stats = options.stats.filter((s: any) => s.name !== 'DrawCalls');
            options.stats.push({
                name: 'VRAM',
                stats: ['vram.tex'],
                decimalPlaces: 1,
                multiplier: 1 / (1024 * 1024),
                unitsName: 'MB',
                watermark: 1024
            }, {
                name: 'Splats',
                stats: ['frame.gsplats'],
                decimalPlaces: 3,
                multiplier: 1 / 1000000,
                unitsName: 'M',
                watermark: 5
            });

            // eslint-disable-next-line no-new
            new MiniStats(app, options);
        }

        const prevProj = new Mat4();
        const prevWorld = new Mat4();
        const sceneBound = new BoundingBox();

        // track the camera state and trigger a render when it changes
        app.on('framerender', () => {
            // 导出 VFX 视频时：不推进相机/UI 逻辑，但允许 renderNextFrame 保持为 true（由导出循环设置），
            // 以便主相机管线照常跑一帧并输出到导出 RT，实现 SuperSplat 式「关掉最终 blit 到 canvas」的离屏导出
            const stateAny = state as any;
            if (stateAny.isExportingVfxVideo) {
                return;
            }

            const world = camera.getWorldTransform();
            const proj = camera.camera.projectionMatrix;

            if (!app.renderNextFrame) {
                if (config.ministats ||
                    !nearlyEquals(world.data, prevWorld.data) ||
                    !nearlyEquals(proj.data, prevProj.data)) {
                    app.renderNextFrame = true;
                }
            }

            // 强制渲染优先级最高（用于预热帧），否则在就绪前抑制渲染
            if (this.forceRenderNextFrame) {
                app.renderNextFrame = true;
            } else if (!state.readyToRender) {
                app.renderNextFrame = false;
            }

            if (app.renderNextFrame) {
                prevWorld.copy(world);
                prevProj.copy(proj);
            }
        });

        // Create roll container entity if it doesn't exist
        // This allows roll to be applied independently of pitch/yaw
        let rollContainer = camera.parent;
        if (!rollContainer || rollContainer === app.root) {
            rollContainer = new Entity('rollContainer');
            app.root.addChild(rollContainer);
            rollContainer.addChild(camera);
        }

        const applyCamera = (camera: Camera) => {
            const cameraEntity = global.camera;
            const hasFinitePose =
                Number.isFinite(camera.position.x) &&
                Number.isFinite(camera.position.y) &&
                Number.isFinite(camera.position.z) &&
                Number.isFinite(camera.angles.x) &&
                Number.isFinite(camera.angles.y) &&
                Number.isFinite(camera.angles.z) &&
                Number.isFinite(camera.distance) &&
                Number.isFinite(camera.fov);
            if (!hasFinitePose) {
                return;
            }

            // Apply position and pitch/yaw to the roll container
            // This keeps pitch/yaw separate from roll
            rollContainer.setPosition(camera.position);
            rollContainer.setEulerAngles(camera.angles.x, camera.angles.y, 0);
            
            // Apply roll to the camera entity (child of rollContainer)
            // Roll rotates around the local Z-axis (forward direction)
            cameraEntity.setLocalEulerAngles(0, 0, camera.angles.z);
            
            cameraEntity.camera.fov = camera.fov;

            //cameraEntity.camera.horizontalFov = graphicsDevice.width > graphicsDevice.height;

            // fit clipping planes to bounding box
            const boundRadius = sceneBound.halfExtents.length();
            let clipPadding = 0;
            let nearMaxHint: number | null = null;
            // 通过 RevealController 的通用能力获取裁剪提示，viewer 不直接判断具体特效类型。
            const clipHint = this.revealController?.getCameraClipHint?.();
            if (clipHint) {
                if (typeof clipHint.clipPadding === 'number' && Number.isFinite(clipHint.clipPadding)) {
                    clipPadding = Math.max(0, clipHint.clipPadding);
                }
                if (typeof clipHint.nearMax === 'number' && Number.isFinite(clipHint.nearMax)) {
                    nearMaxHint = Math.max(0.001, clipHint.nearMax);
                }
            }

            // calculate the forward distance between the camera to the bound center
            vec.sub2(sceneBound.center, camera.position);
            const dist = vec.dot(cameraEntity.forward);

            // far 基于包围体并叠加可选 padding（用于覆盖特效阶段的临时外推范围）。
            let far = Math.max(dist + boundRadius + clipPadding, 1e-2);
            
            // 获取天空盒的实际半径，如果存在天空盒，确保 farClip 足够大以包含它
            const skyboxRadius = getSkyboxRadius(app, readSkyboxCurrentUrlFromSettings(settings));
            if (skyboxRadius > 0) {
                // 使用固定的天空盒半径，计算相机到天空盒边缘的最大距离
                // 假设天空盒中心在原点 (0, 0, 0)，计算相机到原点的距离 + 半径
                const distToOrigin = camera.position.length();
                const requiredFar = distToOrigin + skyboxRadius;
                far = Math.max(far, requiredFar);
            }
            
            const nearBase = dist - boundRadius;
            const nearDefault = Math.max(nearBase, far / (1024 * 16));
            // nearMaxHint 仅作为“上限”约束 near，避免 near 随 far 抬升导致前景被裁。
            const near = nearMaxHint == null
                ? nearDefault
                : Math.max(0.01, Math.min(nearDefault, nearMaxHint));

            cameraEntity.camera.farClip = far;
            cameraEntity.camera.nearClip = near;
        };

        /** 将 cameraManager 的相机姿态应用到实体（导出时 seek anim 后调用） */
        this.applyCameraFromManager = () => {
            if (this.cameraManager) applyCamera(this.cameraManager.camera);
        };

        // handle application update
        app.on('update', (deltaTime) => {
            // 导出 VFX 视频时锁住实时更新（相机 / VFX 不再推进）
            const stateAny = this.global.state as any;
            if (stateAny.isExportingVfxVideo) {
                return;
            }

            // in xr mode we leave the camera alone
            if (app.xr.active) {
                return;
            }

            if (this.inputController && this.cameraManager) {
                // update inputs
                this.inputController.update(deltaTime, this.cameraManager.camera.distance);

                // update cameras
                this.cameraManager.update(deltaTime, this.inputController.frame);

                // apply to the camera entity
                applyCamera(this.cameraManager.camera);
            }
            // update reveal effect timing
            if (this.revealController) {
                this.revealController.updateTiming(deltaTime);
            }
        });

        // Render voxel debug overlay
        app.on('prerender', () => {
            this.voxelOverlay?.update();
        });

        // unpause the animation on first frame（仅「会结束的 reveal」暂停路径动画，等 revealComplete）
        events.on('firstFrame', () => {
            state.loaded = true;
            if (revealBlocksAnim(state)) {
                state.animationPaused = true;
            } else {
                state.animationPaused = !!config.noanim;
            }

            window.scrubTo = (time: number) => {
                if (!state.hasAnimation) {
                    return Promise.reject(new Error('No animation track'));
                }

                state.animationPaused = true;
                return new Promise<void>((resolve) => {
                    events.fire('scrubAnim', time);
                    app.renderNextFrame = true;
                    app.once('frameend', () => resolve());
                });
            };

            window.animationDuration = state.animationDuration;
        });

        // wait for the model to load（接影 GLB 与 collision 共用 mesh，由 CameraCollisionManager 懒加载）
        // 天空盒在 index 中独立加载，失败不阻塞场景初始化。
        gsplatLoad.then((gsplatEntity) => {
            try {
            const gsplat = gsplatEntity.gsplat as GSplatComponent;

            // get scene bounding box
            const gsplatBbox = gsplat?.customAabb;
            if (gsplatBbox) {
                sceneBound.setFromTransformedAabb(gsplatBbox, gsplatEntity.getWorldTransform());
            }

            this.shadowPipelineMount = {
                sceneBound,
                gsplatEntity,
                meshEntity: null
            };
            const preloadedShadowMesh = getCameraCollisionManager(global).getSceneMeshEntity();
            if (preloadedShadowMesh) {
                this.applyShadowMeshEntity(preloadedShadowMesh);
            }

            // 标注系统初始化时机：
            // - 若有 reveal / VFX（开场播放），则等 revealComplete 后再初始化，避免动画期间热点/tooltip 干扰观感
            // - 否则加载完成后立即初始化
            const initAnnotations = () => {
                if (config.noui) return;
                // showEditUI=false 时也使用可交互标注系统（AnnotationManager + AnnotationEntity），避免走只读 Annotations
                // showEditUI=true 时 annotation-ui 会先创建 annotationManager，这里 initAnnotationSystem 会自动跳过
                initAnnotationSystem(global);
                applyAllAnnotationsVisibilityFromSettings(global);
                // 兜底：若没有 annotationManager，才创建只读 Annotations
                if (!(global as any).annotationManager) {
                    this.annotations = new Annotations(global, this.cameraFrame != null);
                }
            };

            const initSceneAssets = (deferUntilRevealComplete: boolean = false) => {
                requestSceneAssetsRestore(global, {
                    reason: 'startup',
                    deferUntilRevealComplete
                }).catch((err) => {
                    console.warn('[SceneAssets] restore from settings failed:', err);
                });
            };

            this.picker = new Picker(app, camera);
            global.picker = this.picker;
            this.inputController = new InputController(global, this.picker);

            // 场景 ?collision= 网格（与接影 GLB 同源）；总开关 + Viewer/预览 + 懒加载就绪后非 null。
            // 放置资产 AABB 不在此注入，由 CameraManager 的 sceneAssetCollisionResolver 处理。
            const collisionMgr = getCameraCollisionManager(global);
            const sceneCollision = collisionMgr.activeCollision();
            this.inputController.collision = sceneCollision;

            const sceneSize = sceneBound.halfExtents.length();
            this.inputController.setMoveSpeedFromSceneSize(sceneSize);

            // 先创建 cameraManager，因为 revealController 需要它来获取 targetConstraint
            this.cameraManager = new (CameraManager as any)(global, sceneBound, sceneCollision);
            if (!config.noui) {
                this.navCursor = new NavCursor(
                    app,
                    camera,
                    sceneCollision,
                    events,
                    state,
                    this.picker,
                    sceneBound.halfExtents.length()
                );
            }

            // 懒加载完成或总开关/模式变化时，同步 walk、fly、input、nav 上的场景碰撞引用
            collisionMgr.attachConsumers({
                applyUrlCollision: (collision) => {
                    if (this.inputController) {
                        this.inputController.collision = collision;
                    }
                    if (this.cameraManager) {
                        this.cameraManager.setUrlParamCollision(collision);
                    }
                    if (this.navCursor) {
                        this.navCursor.setCollision(collision);
                    }
                }
            });
            this.cleanupCameraCollision = collisionMgr.start();

            // NightMode 必须在 RevealController 之前创建：Reveal 构造函数里会立即 createEffect 并 fire('nightMode:exit')。
            // 若 NightMode 尚未注册监听，首次开场的 exit 会丢失，NightMode 仍占用 gsplatModifyVS，与 sketch 等 VFX 互斥失败；
            // 用户在 UI 里切换特效时会再次 fire exit，因此只有「第一次」不播。
            if (!app.root.script) {
                app.root.addComponent('script');
            }
            const nightModeScriptEarly = app.root.script.create(NightMode) as unknown as InstanceType<typeof NightMode>;
            this.nightModeScript = nightModeScriptEarly;
            {
                const lightEntity = app.root.findByName('light') as Entity | null || (app.root.findByTag('light') as Entity[])?.[0] || null;
                const cameraEntity = global.camera;
                nightModeScriptEarly.light = lightEntity;
                nightModeScriptEarly.camera = cameraEntity || null;
                nightModeScriptEarly.splat = gsplatEntity;
                nightModeScriptEarly.enabled = true;
                const nightCfg = (settings as { nightMode?: { enabled?: boolean; fade?: number } }).nightMode;
                const nightFade = typeof nightCfg?.fade === 'number' && Number.isFinite(nightCfg.fade)
                    ? Math.max(-1, Math.min(1, nightCfg.fade))
                    : (nightCfg?.enabled ? -0.95 : 0);
                if (!nightDeferredByReveal(state)) {
                    events.once('firstFrame', () => {
                        if (this.nightModeScript) {
                            this.applyNightModeFromSettingsAfterLoad(
                                settings as ExperienceSettings,
                                nightCfg,
                                nightFade
                            );
                        }
                    });
                }
                console.log('NightMode script initialized:', {
                    light: lightEntity ? 'found' : 'not found',
                    camera: cameraEntity ? 'found' : 'not found',
                    splat: gsplatEntity ? 'found' : 'not found'
                });
            }

            // 全局手电筒（单例 spot）：放在 NightMode 之后、RevealController 之前，
            // 以便首次 active 切换时 NightMode 的 `collectSpotLights` 能立刻看到它。
            initTorchLight(global);
            
            // ── 关键：根据 unified 模式选择正确的坐标空间 ──
            // PlayCanvas gsplat 的 modifySplatCenter 在两种模式下接收不同坐标空间：
            //   unified=true  → CopyToWorkbuffer 中先做 matrix_model * modelCenter → world space
            //   unified=false → 顶点着色器直接传入 getCenter() → model space
            // 传给 RevealController 的 AABB 必须与 shader 坐标空间一致。
            const isUnified = gsplatEntity.gsplat?.unified ?? false;
            const revealBbox = new BoundingBox();
            if (isUnified) {
                revealBbox.copy(sceneBound);           // world space
            } else if (gsplatBbox) {
                revealBbox.copy(gsplatBbox);            // model space
            } else {
                revealBbox.copy(sceneBound);            // fallback
            }
            this.revealController = new RevealController(global, revealBbox, gsplatEntity, this.cameraManager);
            this.assetEffectsController = createAssetEffectsController(global);
            (global as any).__assetEffectsController = this.assetEffectsController;
            this.assetEffectViewToggleController = createAssetEffectViewToggleController(global);
            (global as any).__assetEffectViewToggleController = this.assetEffectViewToggleController;

            const ensureShadowPipelineReady = () => {
                if (!isShadowSystemEnabled(global) || !this.shadowPipelineMount) {
                    return;
                }
                const collisionMgr = getCameraCollisionManager(global);
                // 配置了 GLB collision 时先懒加载接影 mesh，避免用默认平面占位且后续不更新
                if (hasShadowSceneMesh(global) && !this.shadowPipelineMount.meshEntity) {
                    void collisionMgr.ensureSceneMeshLoaded();
                    return;
                }
                this.scheduleShadowPipelineNextFrame();
            };
            ensureShadowPipelineReady();
            events.on('postEffect:changed', () => {
                ensureShadowPipelineReady();
            });
            global.events.on('persistentGsplatEffectRemountRequested', (restartAnim?: boolean) => {
                this.configureCamera(global.settings);
                // revealComplete 当帧内 reveal 脚本可能仍在执行 removeShaders；
                // remount persistent 若同帧进行，可能被旧脚本收尾覆盖。统一延后一帧。
                global.app.once('frameend', () => {
                    this.syncPersistentRevealGsplat(gsplatEntity, restartAnim === true);
                });
            });
            global.events.on(
                'persistentGsplatEffectEnableChanged',
                (payload: { effectType?: string; enabled?: boolean }) => {
                    const effectType = payload?.effectType;
                    if (typeof effectType !== 'string') {
                        return;
                    }
                    global.app.once('frameend', () => {
                        this.applyPersistentSceneEffectEnable(gsplatEntity, effectType, payload.enabled === true);
                    });
                }
            );
            const onPersistentTrackEffect = (effectType: string, add: boolean) => {
                global.app.once('frameend', () => {
                    const input = {
                        global,
                        gsplatEntity,
                        revealController: this.revealController,
                        effectType
                    };
                    if (add) {
                        mountPersistentSceneEffectByType(input);
                    } else {
                        destroyPersistentSceneEffectByType(input);
                    }
                });
            };
            global.events.on('persistentTrackEffect:delete', (payload: { effectType?: string }) => {
                if (typeof payload?.effectType === 'string') {
                    onPersistentTrackEffect(payload.effectType, false);
                }
            });
            global.events.on('persistentTrackEffect:add', (payload: { effectType?: string }) => {
                if (typeof payload?.effectType === 'string') {
                    onPersistentTrackEffect(payload.effectType, true);
                }
            });
            const es = global.settings as ExperienceSettings;
            if (shouldDeferPersistentMount(es)) {
                events.once('revealComplete', (payload?: { skipPersistentRemount?: boolean }) => {
                    if (payload?.skipPersistentRemount) return;
                    this.syncPersistentRevealGsplat(gsplatEntity, false);
                });
            } else {
                this.syncPersistentRevealGsplat(gsplatEntity, false);
            }
            let deferredEditingLayersLocked = false;
            const applyDeferredEditingLayersVisibility = (visible: boolean) => {
                const registry = getSceneContentVisibilityRegistry(global);
                if (registry) {
                    registry.applyRuntimeGate(visible);
                    return;
                }
                for (const layer of DEFAULT_DEFERRED_EDITING_LAYERS) {
                    try {
                        layer.applyVisibility(global, visible);
                    } catch (err) {
                        console.warn(`[Viewer] deferred layer "${layer.id}" visibility failed`, err);
                    }
                }
            };
            const lockDeferredEditingLayersForReveal = () => {
                if (deferredEditingLayersLocked) return;
                deferredEditingLayersLocked = true;
                applyDeferredEditingLayersVisibility(false);
            };
            const unlockDeferredEditingLayersAfterReveal = () => {
                if (!deferredEditingLayersLocked) return;
                deferredEditingLayersLocked = false;
                applyDeferredEditingLayersVisibility(true);
            };
            events.on('revealRestart', () => {
                if (revealBlocksAnim(state)) {
                    lockDeferredEditingLayersForReveal();
                } else {
                    // persistent VFX（如 perlin-wave）与非阻塞类型切换时不应继续沿用上一轮 reveal 的隐藏态
                    unlockDeferredEditingLayersAfterReveal();
                }
            });
            events.on('revealComplete', unlockDeferredEditingLayersAfterReveal);
            events.on('hasRevealEffect:changed', (hasReveal: boolean) => {
                if (!hasReveal) {
                    unlockDeferredEditingLayersAfterReveal();
                }
            });
            // 供 VFX 导出与 deferred-editing-visual-sync 使用，避免从 app.viewer 反射取 RevealController
            if (state.hasRevealEffect) {
                const afterReveal = () => {
                    if (settings.startMode === 'animTrack' && state.hasAnimation && !config.noanim) {
                        state.animationStarted = true;
                        state.animationPaused = false;
                        events.fire('animationStarted');
                    }
                    const nightCfgAfterReveal = (settings as { nightMode?: { enabled?: boolean; fade?: number } }).nightMode;
                    if (nightCfgAfterReveal && this.nightModeScript) {
                        const fade = typeof nightCfgAfterReveal.fade === 'number' && Number.isFinite(nightCfgAfterReveal.fade)
                            ? Math.max(-1, Math.min(1, nightCfgAfterReveal.fade))
                            : (nightCfgAfterReveal.enabled ? -0.95 : 0);
                        this.applyNightModeFromSettingsAfterLoad(
                            settings as ExperienceSettings,
                            nightCfgAfterReveal,
                            fade
                        );
                    }
                };
                if (revealBlocksAnim(state)) {
                    // 阻塞型 reveal 启动即冻结 animTrack，避免 firstFrame 之前被提前推进，
                    // 导致开场视角与 animTrack t=0 不一致。
                    state.animationPaused = true;
                    lockDeferredEditingLayersForReveal();
                    events.once('revealComplete', afterReveal);
                    events.once('revealComplete', initAnnotations);
                    initSceneAssets(true);
                } else {
                    // persistent 等：与 revealComplete 语义对齐的即时管线
                    afterReveal();
                    initAnnotations();
                    initSceneAssets(false);
                }
            } else {
                initAnnotations();
                initSceneAssets(false);
            }

            applyCamera(this.cameraManager.camera);

            // Initialize camera path visualizer if there are animation tracks
            if (settings.animTracks && settings.animTracks.length > 0) {
                this.pathVisualizer = new CameraPathVisualizer(app);
                this.pathVisualizer.visualize(settings.animTracks[0]);
                this.pathVisualizer.setVisible(state.showCameraPath);

                // Listen for state changes
                events.on('showCameraPath:changed', (visible: boolean) => {
                    if (this.pathVisualizer) {
                        this.pathVisualizer.setVisible(visible);
                        app.renderNextFrame = true;
                    }
                });
            }

            // Handle get camera info request
            events.on('getCameraInfo', () => {
                if (this.cameraManager) {
                    const camera = this.cameraManager.camera;
                    const target = new Vec3();
                    camera.calcFocusPoint(target);
                    
                    const cameraInfo = {
                        position: {
                            x: camera.position.x,
                            y: camera.position.y,
                            z: camera.position.z
                        },
                        target: {
                            x: target.x,
                            y: target.y,
                            z: target.z
                        },
                        fov: camera.fov
                    };
                    
                    // 格式化输出
                    const formattedInfo = `相机位置 (Position):
x: ${cameraInfo.position.x.toFixed(6)}
y: ${cameraInfo.position.y.toFixed(6)}
z: ${cameraInfo.position.z.toFixed(6)}

相机目标 (Target):
x: ${cameraInfo.target.x.toFixed(6)}
y: ${cameraInfo.target.y.toFixed(6)}
z: ${cameraInfo.target.z.toFixed(6)}

视野角度 (FOV): ${cameraInfo.fov.toFixed(2)}°`;

                    // 输出到控制台
                    console.log('=== 相机信息 ===');
                    console.log(formattedInfo);
                    console.log('=== JSON格式 ===');
                    console.log(JSON.stringify(cameraInfo, null, 2));
                    
                    // 复制到剪贴板
                    const jsonString = JSON.stringify(cameraInfo, null, 2);
                    navigator.clipboard.writeText(jsonString).then(() => {
                        console.log('相机信息已复制到剪贴板');
                        // 可以显示一个提示消息
                        const message = document.createElement('div');
                        message.textContent = '相机信息已复制到剪贴板！';
                        message.style.cssText = 'position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); background: rgba(0, 0, 0, 0.8); color: white; padding: 20px 30px; border-radius: 8px; z-index: 10000; font-size: 16px;';
                        document.body.appendChild(message);
                        setTimeout(() => {
                            document.body.removeChild(message);
                        }, 2000);
                    }).catch((err) => {
                        console.error('复制到剪贴板失败:', err);
                    });
                }
            });

            // 编辑模式：初始化资产放置与 Gizmo
            const canvasEl = app.graphicsDevice?.canvas as HTMLCanvasElement | undefined;
            if (canvasEl && config.allowEditMode !== false) {
                this.cleanupAssetPlacementHandler = initAssetPlacementHandler(
                    global,
                    canvasEl,
                    sceneBound.center.y,
                    { pushEditHistory }
                );
                this.cleanupGizmoHandler = initGizmoHandler(global);
                this.cleanupAnnotationGizmoHandler = initAnnotationGizmoHandler(global);
            }

            const cleanupSceneAssetCollision = initSceneAssetCollision(global);
            const cleanupSceneAssetCollisionDebug = initSceneAssetCollisionDebug(global);
            this.cleanupSceneAssetCollision = () => {
                cleanupSceneAssetCollisionDebug();
                cleanupSceneAssetCollision();
            };

            this.cleanupMediaHotspotController = initMediaHotspotController(global);
            this.cleanupSceneAudioCallout = initSceneAudioCallout(global);
            this.cleanupVideoControlsTexture = initVideoControlsTexture(global);
            if (canvasEl) {
                this.cleanupVideoControlsInteraction = initVideoControlsInteraction(global, canvasEl);
            }

            const forceRenderBinding = {
                get: () => this.forceRenderNextFrame,
                set: (value: boolean) => {
                    this.forceRenderNextFrame = value;
                }
            };

            if (gsplat.instance) {
                bootstrapSogUnified({
                    global,
                    gsplat,
                    camera,
                    forceRender: forceRenderBinding,
                    ensureShadowPipelineReady,
                    revealController: this.revealController
                });
            } else {
                this.octreeLodBootstrap = bootstrapOctreeLod({
                    global,
                    settings,
                    gsplatEntity,
                    camera,
                    cameraManager: this.cameraManager,
                    forceRender: forceRenderBinding,
                    ensureShadowPipelineReady,
                    revealController: this.revealController,
                    onRefinementController: (controller) => {
                        this.octreeRefinementController = controller;
                    }
                });
            }
            } catch (e) {
                console.error('[Shadow] Error inside Promise.all .then() callback:', e);
            }
        }).catch((err) => {
            console.error('[Shadow] Promise.all REJECTED:', err);
        });
    }

    // configure camera based on application mode and post process settings
    configureCamera(settings: ExperienceSettings) {
        const { global } = this;
        const { app, config, camera } = global;
        const postEffectSettings = settings.postEffectSettings;
        const { background } = settings;
        const applyPersistentStylizationCameraEffects = !this.deferPersistentStylizationCameraEffects;
        const nostalgicComicActive = applyPersistentStylizationCameraEffects && isNostalgicComicPersistentActive(settings);
        const penSketchActive = applyPersistentStylizationCameraEffects
            && isPenSketchRuntimeActive(settings, this.revealController?.getGsplatEntity());
        const yiyunDianranPostEffectActive = applyPersistentStylizationCameraEffects && isYiyunDianranPostEffectActive(settings);
        const palettePixelActive = applyPersistentStylizationCameraEffects && isPalettePixelPersistentActive(settings);
        const charcoalSketchActive = applyPersistentStylizationCameraEffects
            && isCharcoalSketchRuntimeActive(settings, this.revealController?.getGsplatEntity());
        const watercolorActive = applyPersistentStylizationCameraEffects
            && isWatercolorRuntimeActive(settings, this.revealController?.getGsplatEntity());
        const pointillismPostActive = applyPersistentStylizationCameraEffects
            && isPointillismStipplePostEffectActive(settings);
        // 天空点彩仅在 skyboxPS；post 只做透传保护，避免平整化抹掉笔触
        const pointillismSkyboxActive = applyPersistentStylizationCameraEffects
            && isPointillismStippleEnabled(settings);

        // hpr override takes precedence over settings.highPrecisionRendering
        const highPrecisionRendering = config.hpr ?? settings.highPrecisionRendering;

        // 无 postEffectSettings 或未启用任一后处理时跳过，避免报错
        // Bloom 语义对齐：局部 Bloom 仅应改变 mask 区域，不应因 blur/enabled 开关导致整条渲染路径突变。
        // 因此将 Bloom 管线是否预热与 Bloom 叠加是否生效解耦：
        // - 管线预热（CameraFrame + HDR RT）：Bloom 强度 > 0 或 local 亮灯预览需求时保持开启，
        //   避免 intensity=0 时实时笔刷预览被整条管线关掉。
        // - 实际叠加：仍由 BloomController 中 enabled/blur/mask 控制。
        const bloomPipelineWanted = !!postEffectSettings
            && (
                Number(postEffectSettings.bloom?.intensity ?? 0) > 0 ||
                needsBloomPipeline(postEffectSettings)
            );

        const rendererMode = (config as any).renderer as string | undefined;
        const computeRequiresCameraFrame = rendererMode === 'compute';
        const postFxRequested = !config.nofx &&
            !!postEffectSettings &&
            (anyPostEffectEnabled(postEffectSettings, config, settings as ExperienceSettings) ||
                highPrecisionRendering ||
                bloomPipelineWanted);
        const enableCameraFrame = !app.xr.active && (
            computeRequiresCameraFrame ||
            postFxRequested ||
            palettePixelActive ||
            pointillismPostActive ||
            charcoalSketchActive ||
            watercolorActive
        );

        if (enableCameraFrame) {
            if (!this.cameraFrame) {
                this.cameraFrame = new CameraFrame(app, camera.camera);
            }

            const { cameraFrame } = this;
            cameraFrame.rendering.toneMapping = tonemapTable[settings.tonemapping];
            // 启用 bloom 时必须先设 HDR 格式再 enable，否则引擎会回退到 RGBA8 并关闭 bloom（_bloomEnabled=false）
            cameraFrame.rendering.renderFormats = (highPrecisionRendering || bloomPipelineWanted)
                ? [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F]
                : [];
            cameraFrame.rendering.sceneDepthMap =
                computeRequiresCameraFrame || yiyunDianranPostEffectActive;
            cameraFrame.enabled = true;
            const effectivePostFxSettings = postFxRequested ? postEffectSettings : noPostEffects;
            applyPostEffectSettings(cameraFrame, effectivePostFxSettings);
            this.bloomController?.applyToCameraFrame(cameraFrame, effectivePostFxSettings);
            cameraFrame.update();

            // force gsplat shader to write gamma-space colors
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', gammaChunkGlsl);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', gammaChunkWgsl);

            // force skybox shader to write gamma-space colors (inline pow replaces the
            // gammaCorrectOutput call which is a no-op under CameraFrame's GAMMA_NONE)
            this.syncSkyboxShaderChunks(app, pointillismSkyboxActive, true);

            // ensure the final compose blit doesn't perform linear->gamma conversion.
            RenderTarget.prototype.isColorBufferSrgb = function (index) {
                return this === app.graphicsDevice.backBuffer ? true : origIsColorBufferSrgb.call(this, index);
            };

            if (nostalgicComicActive) {
                camera.camera.clearColorBuffer = true;
                camera.camera.clearColor = new Color(1, 1, 1, 0);
            } else if (penSketchActive) {
                camera.camera.clearColorBuffer = true;
                camera.camera.clearColor = penPaperClearColor(readPenSketchEffectParams(settings));
            } else if (charcoalSketchActive) {
                camera.camera.clearColorBuffer = true;
                camera.camera.clearColor = charcoalPaperClearColor(readCharcoalSketchEffectParams(settings));
            } else if (watercolorActive) {
                camera.camera.clearColorBuffer = true;
                camera.camera.clearColor = watercolorPaperClearColor(readWatercolorEffectParams(settings));
            } else if (yiyunDianranPostEffectActive) {
                camera.camera.clearColorBuffer = true;
                camera.camera.clearColor = YIYUN_DIANRAN_PAPER_CLEAR.clone();
            } else {
                camera.camera.clearColor = new Color(background.color);
            }
        } else {
            if (this.cameraFrame) {
                this.bloomController?.onCameraFrameDestroyed();
                this.cameraFrame.destroy();
                this.cameraFrame = null;
            }
            if (this.nightModeScript) {
                this.nightModeScript.setBloomBrushParams(false, null, 0.2, undefined);
            }

            // restore shader chunks to engine defaults
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', this.origChunks.glsl.gsplatOutputVS);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', this.origChunks.wgsl.gsplatOutputVS);
            this.syncSkyboxShaderChunks(app, pointillismSkyboxActive, false);

            // restore original isColorBufferSrgb behavior
            RenderTarget.prototype.isColorBufferSrgb = origIsColorBufferSrgb;

            if (!app.xr.active) {
                camera.camera.toneMapping = tonemapTable[settings.tonemapping];
                if (nostalgicComicActive) {
                    camera.camera.clearColorBuffer = true;
                    camera.camera.clearColor = new Color(1, 1, 1, 0);
                } else if (penSketchActive) {
                    camera.camera.clearColorBuffer = true;
                    camera.camera.clearColor = penPaperClearColor(readPenSketchEffectParams(settings));
                } else if (charcoalSketchActive) {
                    camera.camera.clearColorBuffer = true;
                    camera.camera.clearColor = charcoalPaperClearColor(readCharcoalSketchEffectParams(settings));
                } else if (watercolorActive) {
                    camera.camera.clearColorBuffer = true;
                    camera.camera.clearColor = watercolorPaperClearColor(readWatercolorEffectParams(settings));
                } else if (yiyunDianranPostEffectActive) {
                    camera.camera.clearColorBuffer = true;
                    camera.camera.clearColor = YIYUN_DIANRAN_PAPER_CLEAR.clone();
                } else {
                    camera.camera.clearColor = new Color(background.color);
                }
            }
        }

        // Mesh overlay 依赖当前 gamma 路径；CameraFrame 开关变化时需要同步。
        this.meshOverlay?.setCameraFrameEnabled(!!this.cameraFrame);
    }

    /** patch skyboxPS 后重建 SkyMaterial（创建时拷贝 chunk，不会自动跟随 ShaderChunks 更新） */
    private syncSkyboxShaderChunks(
        app: import('playcanvas').AppBase,
        pointillismActive: boolean,
        gammaOverride: boolean
    ): void {
        ShaderChunks.get(app.graphicsDevice, 'glsl').set('skyboxPS',
            buildSkyboxPsChunk(this.origChunks.glsl.skyboxPS, 'glsl', {
                gammaOverride,
                pointillism: pointillismActive
            })
        );
        ShaderChunks.get(app.graphicsDevice, 'wgsl').set('skyboxPS',
            buildSkyboxPsChunk(this.origChunks.wgsl.skyboxPS, 'wgsl', {
                gammaOverride,
                pointillism: pointillismActive
            })
        );
        refreshSkyboxMaterialShader(app);
        this.global.events?.fire('skyboxShader:patched');
    }

    private setPersistentStylizationCameraEffectsDeferred(deferred: boolean): void {
        if (this.deferPersistentStylizationCameraEffects === deferred) {
            return;
        }
        this.deferPersistentStylizationCameraEffects = deferred;
        this.configureCamera(this.global.settings);
        this.global.app.renderNextFrame = true;
    }

    /**
     * 接影 GLB / 阴影管线挂载延后到下一帧 frameend，避免与进编辑、postEffect:changed 等同帧 forward draw 竞态（impl undefined）。
     */
    private scheduleShadowPipelineNextFrame(): void {
        const { global } = this;
        const { app } = global;
        if (!this.shadowPipelineMount || !isShadowSystemEnabled(global)) {
            return;
        }
        if (this.shadowPipelineFrameScheduled) {
            return;
        }
        this.shadowPipelineFrameScheduled = true;
        app.renderNextFrame = true;
        app.once('frameend', () => {
            this.shadowPipelineFrameScheduled = false;
            const mount = this.shadowPipelineMount;
            if (!mount || !isShadowSystemEnabled(global)) {
                return;
            }
            scheduleShadowPipeline(global, mount);
            if (global.state.readyToRender) {
                notifyViewportReadyForShadow(global);
            }
            app.renderNextFrame = true;
        });
    }

    /** 接影 GLB 懒加载完成后更新 shadow mount 并尝试挂载阴影管线 */
    private applyShadowMeshEntity(meshEntity: Entity | null): void {
        if (!meshEntity || !this.shadowPipelineMount) {
            return;
        }
        this.shadowPipelineMount.meshEntity = meshEntity;
        const { global } = this;
        if (!isShadowSystemEnabled(global)) {
            return;
        }
        // regenerate 可能与上一次 frameend 调度重叠；允许再排一次，确保新 mesh 进入 catcher
        this.shadowPipelineFrameScheduled = false;
        this.scheduleShadowPipelineNextFrame();
    }

    /** urlParam 碰撞懒加载完成后挂载 debug 线框（与门控无关，仅可视化） */
    private bindSceneCollisionDebugOverlay(collision: Collision): void {
        const { app, config, state, camera } = this.global;
        // regenerate 替换 mesh 时需重建 overlay
        if (this.baseSceneCollision && this.baseSceneCollision !== collision) {
            this.destroySceneCollisionDebugOverlay();
        }
        this.baseSceneCollision = collision;
        const rendererMode = (config as { renderer?: string }).renderer;
        if (collision instanceof VoxelCollision && rendererMode !== 'webgl') {
            if (this.voxelOverlay) {
                return;
            }
            this.voxelOverlay = new VoxelDebugOverlay(app, collision, camera);
            this.voxelOverlay.mode = (config as { heatmap?: boolean }).heatmap ? 'heatmap' : 'overlay';
            this.voxelOverlay.enabled = !!state.collisionOverlayEnabled;
            state.hasCollisionOverlay = true;
        } else if (collision instanceof MeshCollision) {
            if (this.meshOverlay) {
                return;
            }
            const cameraFrameEnabled = !!this.cameraFrame;
            const overlayEnabled = !!state.collisionOverlayEnabled;
            app.once('frameend', () => {
                if (this.meshOverlay) {
                    return;
                }
                if (this.baseSceneCollision !== collision) {
                    return;
                }
                this.meshOverlay = new MeshDebugOverlay(app, collision, camera, cameraFrameEnabled);
                this.meshOverlay.enabled = overlayEnabled;
                state.hasCollisionOverlay = true;
            });
            app.renderNextFrame = true;
        }
    }

    private destroySceneCollisionDebugOverlay(): void {
        const { state } = this.global;
        if (this.meshOverlay) {
            this.meshOverlay.destroy();
            this.meshOverlay = null;
        }
        if (this.voxelOverlay) {
            this.voxelOverlay.destroy();
            this.voxelOverlay = null;
        }
        this.baseSceneCollision = null;
        if (state.hasCollisionOverlay) {
            state.hasCollisionOverlay = false;
        }
    }

    // Camera path visualizer methods
    updateCameraPathVisualizer(options: VisualizerOptions) {
        if (!this.pathVisualizer) {
            this.pathVisualizer = new CameraPathVisualizer(this.global.app, options);
        }

        const { settings } = this.global;
        if (settings.animTracks && settings.animTracks.length > 0) {
            this.pathVisualizer.visualize(settings.animTracks[0]);
        }
    }

    setCameraPathVisible(type: 'path' | 'keyframes' | 'directions' | 'all', visible: boolean) {
        if (!this.pathVisualizer) return;

        switch (type) {
            case 'path':
                this.pathVisualizer.setPathVisible(visible);
                break;
            case 'keyframes':
                this.pathVisualizer.setKeyframesVisible(visible);
                break;
            case 'directions':
                this.pathVisualizer.setDirectionsVisible(visible);
                break;
            case 'all':
                this.pathVisualizer.setVisible(visible);
                break;
        }
    }

    destroyCameraPathVisualizer() {
        if (this.pathVisualizer) {
            this.pathVisualizer.destroy();
            this.pathVisualizer = null;
        }
    }

    /**
     * 可持续 GSplat：经 {@link runPersistentGsplatEntityLifecycle} 单入口同步 registry、读 settings、remount；与 `RevealController` 的 persistent 桥接 API 协作。
     */
    private syncPersistentRevealGsplat(gsplatEntity: Entity, restartAnimTrack: boolean) {
        const { global } = this;
        runPersistentGsplatEntityLifecycle({
            global,
            gsplatEntity,
            revealController: this.revealController,
            restartAnimTrack
        });
    }

    private applyPersistentSceneEffectEnable(
        gsplatEntity: Entity,
        effectType: string,
        enabled: boolean
    ): void {
        applyPersistentSceneEffectEnableChange({
            global: this.global,
            gsplatEntity,
            revealController: this.revealController,
            effectType,
            enabled
        });
    }

    /**
     * 加载 / reveal 结束后写回 nightMode：点彩等占用 gsplatModifyVS 时只调主光/天空盒，不写 gsplat shader。
     */
    private applyNightModeFromSettingsAfterLoad(
        settings: ExperienceSettings,
        nightCfg: { enabled?: boolean; fade?: number } | undefined,
        fade: number
    ): void {
        if (!this.nightModeScript) {
            return;
        }
        if (hasEnabledPersistentGsplatMaterialShaderEffect(settings)) {
            this.nightModeScript.applyLightingFromSettings({ enabled: nightCfg?.enabled, fade });
            return;
        }
        this.nightModeScript.applyFromSettings({ enabled: nightCfg?.enabled, fade });
    }
}

export { Viewer };
