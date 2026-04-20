import {
    BoundingBox,
    CameraFrame,
    type CameraComponent,
    type Layer,
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
    platform
} from 'playcanvas';

import { Annotations } from './annotations';
import { CameraManager } from './camera-manager';
import { Camera } from './cameras/camera';
import { nearlyEquals } from './core/math';
import { InputController } from './input-controller';
import type { ExperienceSettings, PostEffectSettings } from './settings';
import type { Global } from './types';
import { nightDeferredByReveal, revealBlocksAnim } from './reveal-policy';
import { RevealController } from './reveal';
import { CameraPathVisualizer, type VisualizerOptions } from './camera-path-visualizer';
import { getSkyboxRadius } from './loaders/skybox-loader';
import { isLodMetaFile } from './loaders/lod-loader';
import { BloomController } from './vfx/bloom';
import { loadSplatMesh } from './loaders/splat-mesh-loader';
import { NightMode } from './vfx/lighting/night-mode';
import { initShadowCatcher } from './vfx/shadow/shadow-catcher';
import { ShadowApplyRt } from './vfx/shadow/shadow-apply';
import { updateShadowDistance } from './light';
import { initAssetPlacementHandler, requestSceneAssetsRestore } from './asset-placement-handler';
import { pushEditHistory } from './edit-history';
import { initGizmoHandler } from './gizmo-handler';
import { initAnnotationGizmoHandler } from './annotation-toolbar/annotation-gizmo-handler';
import { initAnnotationSystem } from './annotation-toolbar/init-annotation-system';
import { initModuleOrchestrator, type ModuleOrchestrator } from './editor-modules/module-orchestrator';
import { initAssetFacade } from './editor-modules/asset-facade';
import { initAnnotationFacade } from './editor-modules/annotation-facade';
import { initEnvironmentFacade } from './editor-modules/environment-facade';
import { initEffectsFacade } from './editor-modules/effects-facade';
import { initCommandRegistry } from './editor-modules/command-registry';
import { DEFAULT_DEFERRED_EDITING_LAYERS } from './render/deferred-editing-visual-sync';

const gammaChunkGlsl = `
vec3 prepareOutputFromGamma(vec3 gammaColor) {
    return gammaColor;
}
`;

const gammaChunkWgsl = `
fn prepareOutputFromGamma(gammaColor: vec3f) -> vec3f {
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
    if (!bloom || bloom.enabled === false) return false;
    // 不依赖 bloomScope：transform.json 初始为 global，但局部亮灯会话仍需实时预览管线。
    const hasRegions = Array.isArray(bloom.localLightRegions) && bloom.localLightRegions.length > 0;
    const brushActive = !!settings?.bloomEditorSession?.bloomBrush;
    return hasRegions || brushActive;
};

const anyPostEffectEnabled = (settings: PostEffectSettings): boolean => {
    const bloomOn = settings.bloom.enabled && (
        Number(settings.bloom.intensity) > 0 ||
        needsBloomPipeline(settings)
    );
    const shadowOn = (settings as any).shadow?.enabled === true;
    return (settings.sharpness.enabled && settings.sharpness.amount > 0) ||
        bloomOn ||
        (settings.grading.enabled) ||
        (settings.vignette.enabled && settings.vignette.intensity > 0) ||
        (settings.fringing.enabled && settings.fringing.intensity > 0) ||
        shadowOn;
};

const vec = new Vec3();

// store the original isColorBufferSrgb so the override in updatePostEffects is idempotent
const origIsColorBufferSrgb = RenderTarget.prototype.isColorBufferSrgb;

class Viewer {
    global: Global;

    cameraFrame: CameraFrame;

    inputController: InputController;

    revealController: RevealController;

    cameraManager: CameraManager;

    annotations: Annotations | null = null;

    forceRenderNextFrame = false;
    pathVisualizer: CameraPathVisualizer | null = null;

    /** Bloom 统一由 BloomController 管理，不往 gsplat 挂脚本，避免覆盖 reveal */
    bloomController: BloomController | null = null;

    /** Night Mode 脚本（用于 Night Mode + Bloom Brush 合成） */
    nightModeScript: InstanceType<typeof NightMode> | null = null;

    /** 将 cameraManager 的相机姿态应用到实体（导出时 seek anim 后调用） */
    applyCameraFromManager: () => void = () => {};

    /** 资产放置 handler 清理函数 */
    cleanupAssetPlacementHandler: (() => void) | null = null;

    /** Gizmo handler 清理函数 */
    cleanupGizmoHandler: (() => void) | null = null;

    /** Annotation Gizmo handler 清理函数 */
    cleanupAnnotationGizmoHandler: (() => void) | null = null;

    /** 编辑模块生命周期编排器（orchestrator-core） */
    moduleOrchestrator: ModuleOrchestrator | null = null;

    origChunks: {
        glsl: {
            gsplatOutputVS: string
        },
        wgsl: {
            gsplatOutputVS: string
        }
    };

    constructor(global: Global, gsplatLoad: Promise<Entity>, skyboxLoad: Promise<void>) {
        this.global = global;

        const { app, settings, config, events, state, camera } = global;
        const { graphicsDevice } = app;

        // 仅初始化 orchestrator 核心骨架：后续 phase 再逐步注册各模块 facade
        this.moduleOrchestrator = initModuleOrchestrator(global);
        initCommandRegistry(global);
        (global as any).__moduleOrchestrator = this.moduleOrchestrator;
        initAssetFacade(global);
        initAnnotationFacade(global);
        initEnvironmentFacade(global);
        initEffectsFacade(global);

        // enable anonymous CORS for image loading in safari
        (app.loader.getHandler('texture') as TextureHandler).imgParser.crossOrigin = 'anonymous';

        this.origChunks = {
            glsl: {
                gsplatOutputVS: ShaderChunks.get(graphicsDevice, 'glsl').get('gsplatOutputVS')
            },
            wgsl: {
                gsplatOutputVS: ShaderChunks.get(graphicsDevice, 'wgsl').get('gsplatOutputVS')
            }
        };

        // render skybox as plain equirect
        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        glsl.set('skyboxPS', glsl.get('skyboxPS').replace('mapRoughnessUv(uv, mipLevel)', 'uv'));

        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', wgsl.get('skyboxPS').replace('mapRoughnessUv(uv, uniform.mipLevel)', 'uv'));

        this.bloomController = new BloomController(global, {
            getCameraFrame: () => this.cameraFrame,
            getAppCanvas: () => (app.graphicsDevice?.canvas as HTMLCanvasElement) ?? document.querySelector('canvas'),
            getNightModeScript: () => this.nightModeScript
        });

        // disable auto render, we'll render only when camera changes
        app.autoRender = false;

        // apply camera animation settings
        camera.camera.aspectRatio = graphicsDevice.width / graphicsDevice.height;

        // configure the camera
        this.configureCamera(settings);

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

            // suppress rendering till we're ready
            if (!state.readyToRender) {
                app.renderNextFrame = false;
            }

            if (this.forceRenderNextFrame) {
                app.renderNextFrame = true;
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

            // Apply position and pitch/yaw to the roll container
            // This keeps pitch/yaw separate from roll
            rollContainer.setPosition(camera.position);
            rollContainer.setEulerAngles(camera.angles.x, camera.angles.y, 0);
            
            // Apply roll to the camera entity (child of rollContainer)
            // Roll rotates around the local Z-axis (forward direction)
            cameraEntity.setLocalEulerAngles(0, 0, camera.angles.z);
            
            cameraEntity.camera.fov = camera.fov;

            // fit clipping planes to bounding box
            const boundRadius = sceneBound.halfExtents.length();

            // calculate the forward distance between the camera to the bound center
            vec.sub2(sceneBound.center, camera.position);
            const dist = vec.dot(cameraEntity.forward);

            // 计算基础 far clip（基于 bounding box）
            let far = Math.max(dist + boundRadius, 1e-2);
            
            // 获取天空盒的实际半径，如果存在天空盒，确保 farClip 足够大以包含它
            const skyboxRadius = getSkyboxRadius(app, config.skyboxUrl);
            if (skyboxRadius > 0) {
                // 使用固定的天空盒半径，计算相机到天空盒边缘的最大距离
                // 假设天空盒中心在原点 (0, 0, 0)，计算相机到原点的距离 + 半径
                const distToOrigin = camera.position.length();
                const requiredFar = distToOrigin + skyboxRadius;
                far = Math.max(far, requiredFar);
            }
            
            const near = Math.max(dist - boundRadius, far / (1024 * 16));

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

        // unpause the animation on first frame（仅「会结束的 reveal」暂停路径动画，等 revealComplete）
        events.on('firstFrame', () => {
            state.loaded = true;
            if (revealBlocksAnim(state)) {
                state.animationPaused = true;
            } else {
                state.animationPaused = !!config.noanim;
            }
        });

        // 接影几何：从 URL 参数 ?splatMesh= 读取 GLB 路径
        console.log('[Shadow] config.splatMeshUrl =', config.splatMeshUrl);
        const splatMeshLoad = config.splatMeshUrl
            ? loadSplatMesh(app, config.splatMeshUrl).then((entity) => {
                console.log('[Shadow] splatMesh loaded successfully:', entity?.name, 'render:', !!entity?.render, 'children:', entity?.children?.length);
                return entity;
            }).catch((err: unknown): null => {
                console.warn('[Shadow] splatMesh load failed, falling back to plane', config.splatMeshUrl, err);
                return null;
            })
            : (() => {
                console.log('[Shadow] No splatMeshUrl in URL params, will create default plane. Add ?splatMesh=/assets/mesh/blue.glb to URL to use GLB mesh.');
                return Promise.resolve(null as Entity | null);
            })();

        // wait for the model to load
        console.log('[Shadow] Waiting for Promise.all to resolve...');
        Promise.all([gsplatLoad, skyboxLoad ?? Promise.resolve(), splatMeshLoad]).then((results) => {
            console.log('[Shadow] Promise.all resolved, results count:', results.length);
            try {
            const gsplatEntity = results[0] as Entity;
            const gsplat = gsplatEntity.gsplat as GSplatComponent;
            const meshEntity = results[2] as Entity | null | undefined;
            // console.log('[Shadow] gsplatEntity:', gsplatEntity?.name, 'gsplat:', !!gsplat, 'meshEntity:', meshEntity?.name ?? 'null');

            // get scene bounding box
            const gsplatBbox = gsplat?.customAabb;
            if (gsplatBbox) {
                sceneBound.setFromTransformedAabb(gsplatBbox, gsplatEntity.getWorldTransform());
            }

            // 根据场景大小动态更新方向光的 shadowDistance
            const sceneSize = sceneBound.halfExtents.length();
            updateShadowDistance(global, sceneSize);

            // 阴影管线：有 GLB 则用 mesh 接影，否则用平面（与 Physics_Relighting_Demo 一致）
            const shadowOpts = settings.postEffectSettings.shadow as { debugVisual?: boolean } | undefined;
            // console.log('[Shadow] initShadowCatcher called with:', {
            //     hasMeshEntity: !!meshEntity,
            //     meshEntityName: meshEntity?.name,
            //     meshEntityChildren: meshEntity?.children?.length,
            //     sceneBoundCenter: sceneBound.center.toString(),
            //     sceneBoundHalf: sceneBound.halfExtents.toString()
            // });
            initShadowCatcher(app, sceneBound, {
                debugVisual: shadowOpts?.debugVisual ?? false,
                parentEntity: gsplatEntity,
                meshEntity: meshEntity ?? undefined
            });
            // 必须在 create 之前注入 global：initialize() 在 create() 时同步执行，此时 script.global 尚未被赋值
            (app as any).__shadowApplyGlobal = global;
            if (!app.root.script) {
                app.root.addComponent('script');
            }
            const applyScript = app.root.script.create(ShadowApplyRt) as unknown as ShadowApplyRt;
            applyScript.global = global;
            delete (app as any).__shadowApplyGlobal;

            // 标注系统初始化时机：
            // - 若有 reveal / VFX（开场播放），则等 revealComplete 后再初始化，避免动画期间热点/tooltip 干扰观感
            // - 否则加载完成后立即初始化
            const initAnnotations = () => {
                if (config.noui) return;
                // showEditUI=false 时也使用可交互标注系统（AnnotationManager + AnnotationEntity），避免走只读 Annotations
                // showEditUI=true 时 annotation-ui 会先创建 annotationManager，这里 initAnnotationSystem 会自动跳过
                initAnnotationSystem(global);
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

            this.inputController = new InputController(global);
            
            // Set move speed based on scene size (reuse sceneSize from above)
            this.inputController.setMoveSpeedFromSceneSize(sceneSize);

            // 先创建 cameraManager，因为 revealController 需要它来获取 targetConstraint
            this.cameraManager = new CameraManager(global, sceneBound);

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
                            this.nightModeScript.applyFromSettings({ fade: nightFade, enabled: nightCfg?.enabled });
                        }
                    });
                }
                console.log('NightMode script initialized:', {
                    light: lightEntity ? 'found' : 'not found',
                    camera: cameraEntity ? 'found' : 'not found',
                    splat: gsplatEntity ? 'found' : 'not found'
                });
            }
            
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
            let deferredEditingLayersLocked = false;
            const applyDeferredEditingLayersVisibility = (visible: boolean) => {
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
                        this.nightModeScript.applyFromSettings({ enabled: nightCfgAfterReveal.enabled, fade });
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

            const { instance } = gsplat;
            if (instance) {
                // kick off gsplat sorting immediately now that camera is in position
                instance.sort(camera);

                // listen for sorting updates to trigger first frame events
                instance.sorter?.on('updated', () => {
                    // request frame render when sorting changes
                    app.renderNextFrame = true;

                    if (!state.readyToRender) {
                        // we're ready to render once the first sort has completed
                        state.readyToRender = true;

                        // wait for the first valid frame to complete rendering
                        app.once('frameend', () => {
                            events.fire('firstFrame');

                            // emit first frame event on window
                            window.firstFrame?.();
                        });
                    }
                });
            } else {

                const { gsplat } = app.scene;

                // Check if custom LOD (lodLoader) is enabled
                // If not, use default LOD settings (ranges below)
                const isCustomLod = config.contentUrl ? isLodMetaFile(config.contentUrl) : false;

                // Default quality ranges (used when lodLoader is not enabled)
                const ranges = {
                    mobile: {
                        low: 1,
                        high: 2
                    },
                    desktop: {
                        low: 2,
                        high: 4
                    }
                };

                const quality = platform.mobile ? ranges.mobile : ranges.desktop;

                // If using custom LOD (lodLoader), apply component-level parameters from preset stored in scene
                if (isCustomLod) {
                    const gsplatScene = (app.scene as any).gsplat;
                    if (gsplatScene && gsplatScene.lodRangeMax !== undefined) {
                        if (gsplatScene.splatBudget !== undefined) {
                            results[0].gsplat.splatBudget = gsplatScene.splatBudget * 1000000;
                        }
                        gsplat.lodRangeMin = 0;
                        gsplat.lodRangeMax = gsplatScene.lodRangeMax;
                    } else {
                        gsplat.lodRangeMin = 0;
                        gsplat.lodRangeMax = 5;
                    }
                } else {
                    // Default LOD: start in low quality so we can get user interacting asap
                    results[0].gsplat.splatBudget = quality.low * 1000000;
                }

                // these two allow LOD behind camera to drop, saves lots of splats
                gsplat.lodUpdateAngle = 90;
                gsplat.lodBehindPenalty = 5;

                // same performance, but rotating on slow devices does not give us unsorted splats on sides
                gsplat.radialSorting = true;

                const eventHandler = app.systems.gsplat;

                // we must force continuous rendering with streaming & lod system
                this.forceRenderNextFrame = true;

                let current = 0;
                let watermark = 1;
                // For custom LOD mode, track the maximum progress to prevent regression
                let maxProgress = 0;
                let progressUIHidden = false; // Track if progress UI has been hidden
                const PROGRESS_THRESHOLD = 50; // Hide progress UI when progress reaches this threshold
                const readyHandler = (camera: CameraComponent, layer: Layer, ready: boolean, loading: number) => {

                    if (ready && loading === 0) {
                        // scene is done loading
                        eventHandler.off('frame:ready', readyHandler);

                        state.readyToRender = true;

                        // In LOD mode, ensure animation is started (in case it wasn't started earlier)
                        // 有 reveal 时不在此处启动动画，等 revealComplete 后再启动
                        if (isCustomLod && settings.startMode === 'animTrack' && state.hasAnimation && !config.noanim && !revealBlocksAnim(state)) {
                            console.log('LOD mode: all chunks loaded, ensuring animation is playing');
                            state.animationStarted = true;
                            state.animationPaused = false;
                        }

                        // handle quality mode changes
                        const updateLod = () => {
                            if (isCustomLod) {
                                const gsplatScene = (app.scene as any).gsplat;
                                if (gsplatScene && gsplatScene.lodRangeMin !== undefined) {
                                    gsplat.lodRangeMin = gsplatScene.lodRangeMin;
                                    gsplat.lodRangeMax = gsplatScene.lodRangeMax;
                                    if (gsplatScene.splatBudget !== undefined) {
                                        results[0].gsplat.splatBudget = gsplatScene.splatBudget * 1000000;
                                    }
                                }
                            } else {
                                const settings = state.hqMode ? quality.high : quality.low;
                                results[0].gsplat.splatBudget = settings * 1000000;
                            }
                        };
                        events.on('hqMode:changed', updateLod);
                        updateLod();

                        // debug colorize lods
                        gsplat.colorizeLod = config.colorize;

                        gsplat.gpuSorting = config.gpusort;

                        // wait for the first valid frame to complete rendering
                        app.once('frameend', () => {
                            events.fire('firstFrame');

                            // emit first frame event on window
                            window.firstFrame?.();
                        });
                    }

                    // update loading status
                    if (loading !== current) {
                        watermark = Math.max(watermark, loading);
                        current = watermark - loading;
                        
                        let progress: number;
                        // In custom LOD mode, if animation has started, show 100% progress
                        if (isCustomLod && state.animationStarted) {
                            progress = 100;
                        } else {
                            progress = Math.trunc(current / watermark * 100);
                            
                            // In custom LOD mode, ensure progress never decreases
                            if (isCustomLod) {
                                maxProgress = Math.max(maxProgress, progress);
                                progress = maxProgress;
                            }
                        }
                        
                        state.progress = progress;
                        
                        // When progress reaches threshold, hide progress UI and start animation if available
                        if (!progressUIHidden && progress >= PROGRESS_THRESHOLD) {
                            progressUIHidden = true;
                            // Fire event to hide progress UI
                            events.fire('progressThresholdReached', progress);
                            
                            // Start animation if available（有 reveal 时由 revealComplete 回调启动，此处不启动）
                            if (settings.startMode === 'animTrack' && state.hasAnimation && !config.noanim && !state.animationStarted && !revealBlocksAnim(state)) {
                                state.animationStarted = true;
                                console.log(`Progress reached ${PROGRESS_THRESHOLD}%, starting animation`);
                                state.animationPaused = false;
                                events.fire('animationStarted');
                            }
                        }
                    }
                };
                eventHandler.on('frame:ready', readyHandler);
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

        const enableCameraFrame = !app.xr.active &&
            !config.nofx &&
            !!postEffectSettings &&
            (anyPostEffectEnabled(postEffectSettings) || highPrecisionRendering || bloomPipelineWanted);

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
            cameraFrame.enabled = true;
            applyPostEffectSettings(cameraFrame, postEffectSettings);
            this.bloomController?.applyToCameraFrame(cameraFrame, postEffectSettings);

            cameraFrame.update();

            // force gsplat shader to write gamma-space colors
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', gammaChunkGlsl);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', gammaChunkWgsl);

            // ensure the final compose blit doesn't perform linear->gamma conversion.
            RenderTarget.prototype.isColorBufferSrgb = function (index) {
                return this === app.graphicsDevice.backBuffer ? true : origIsColorBufferSrgb.call(this, index);
            };

            camera.camera.clearColor = new Color(background.color);
        } else {
            if (this.cameraFrame) {
                this.bloomController?.onCameraFrameDestroyed();
                this.cameraFrame.destroy();
                this.cameraFrame = null;
            }
            if (this.nightModeScript) {
                this.nightModeScript.setBloomBrushParams(false, null, 0.2, undefined);
            }

            // restore gsplat output shader chunks to engine defaults
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', this.origChunks.glsl.gsplatOutputVS);
            ShaderChunks.get(app.graphicsDevice, 'wgsl').set('gsplatOutputVS', this.origChunks.wgsl.gsplatOutputVS);

            // restore original isColorBufferSrgb behavior
            RenderTarget.prototype.isColorBufferSrgb = origIsColorBufferSrgb;

            if (!app.xr.active) {
                camera.camera.toneMapping = tonemapTable[settings.tonemapping];
                camera.camera.clearColor = new Color(background.color);
            }
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
}

export { Viewer };
