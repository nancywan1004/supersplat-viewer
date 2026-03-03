import {
    BoundingBox,
    CameraFrame,
    type CameraComponent,
    Color,
    Entity,
    type Layer,
    RenderTarget,
    Mat4,
    MiniStats,
    ShaderChunks,
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
import { RevealController } from './reveal';
import { CameraPathVisualizer, type VisualizerOptions } from './camera-path-visualizer';
import { getSkyboxRadius } from './loaders/skybox-loader';
import { isLodMetaFile } from './loaders/lod-loader';

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

const applyPostEffectSettings = (cameraFrame: CameraFrame, settings: PostEffectSettings) => {
    if (settings.sharpness.enabled) {
        cameraFrame.rendering.sharpness = settings.sharpness.amount;
    } else {
        cameraFrame.rendering.sharpness = 0;
    }

    const { bloom } = cameraFrame;
    if (settings.bloom.enabled) {
        bloom.intensity = settings.bloom.intensity;
        bloom.blurLevel = settings.bloom.blurLevel;
    } else {
        bloom.intensity = 0;
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

const anyPostEffectEnabled = (settings: PostEffectSettings): boolean => {
    return (settings.sharpness.enabled && settings.sharpness.amount > 0) ||
        (settings.bloom.enabled && settings.bloom.intensity > 0) ||
        (settings.grading.enabled) ||
        (settings.vignette.enabled && settings.vignette.intensity > 0) ||
        (settings.fringing.enabled && settings.fringing.intensity > 0);
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

    annotations: Annotations;

    forceRenderNextFrame = false;
    pathVisualizer: CameraPathVisualizer | null = null;

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

        // disable auto render, we'll render only when camera changes
        app.autoRender = false;

        // apply camera animation settings
        camera.camera.aspectRatio = graphicsDevice.width / graphicsDevice.height;

        // configure the camera
        this.configureCamera(settings);

        // reconfigure camera when entering/exiting XR
        app.xr.on('start', () => this.configureCamera(settings));
        app.xr.on('end', () => this.configureCamera(settings));

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

        // handle application update
        app.on('update', (deltaTime) => {
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
        });

        // unpause the animation on first frame（有 reveal 时保持暂停，等 reveal 播完再由 revealComplete 回调解除）
        events.on('firstFrame', () => {
            state.loaded = true;
            if (state.hasRevealEffect) {
                state.animationPaused = true;
            } else {
                state.animationPaused = !!config.noanim;
            }
        });

        // wait for the model to load
        Promise.all([gsplatLoad, skyboxLoad]).then((results) => {
            const gsplat = results[0].gsplat as GSplatComponent;

            // get scene bounding box
            const gsplatBbox = gsplat.customAabb;
            if (gsplatBbox) {
                sceneBound.setFromTransformedAabb(gsplatBbox, results[0].getWorldTransform());
            }

            if (!config.noui) {
                this.annotations = new Annotations(global, this.cameraFrame != null);
            }

            this.inputController = new InputController(global);
            
            // Set move speed based on scene size
            const sceneSize = sceneBound.halfExtents.length();
            this.inputController.setMoveSpeedFromSceneSize(sceneSize);

            this.revealController = new RevealController(global, sceneBound, results[0]);

            // 有 reveal 时：等 reveal 播完再开始动画（监听 revealComplete）
            if (state.hasRevealEffect) {
                events.once('revealComplete', () => {
                    if (settings.startMode === 'animTrack' && state.hasAnimation && !config.noanim) {
                        state.animationStarted = true;
                        state.animationPaused = false;
                        events.fire('animationStarted');
                    }
                });
            }

            this.cameraManager = new CameraManager(global, sceneBound);
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
                        if (isCustomLod && settings.startMode === 'animTrack' && state.hasAnimation && !config.noanim && !state.hasRevealEffect) {
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
                            if (settings.startMode === 'animTrack' && state.hasAnimation && !config.noanim && !state.animationStarted && !state.hasRevealEffect) {
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
        });
    }

    // configure camera based on application mode and post process settings
    configureCamera(settings: ExperienceSettings) {
        const { global } = this;
        const { app, config, camera } = global;
        const { postEffectSettings } = settings;
        const { background } = settings;

        // hpr override takes precedence over settings.highPrecisionRendering
        const highPrecisionRendering = config.hpr ?? settings.highPrecisionRendering;

        const enableCameraFrame = !app.xr.active && !config.nofx && (anyPostEffectEnabled(postEffectSettings) || highPrecisionRendering);

        if (enableCameraFrame) {
            // create instance
            if (!this.cameraFrame) {
                this.cameraFrame = new CameraFrame(app, camera.camera);
            }

            const { cameraFrame } = this;
            cameraFrame.enabled = true;
            cameraFrame.rendering.toneMapping = tonemapTable[settings.tonemapping];
            cameraFrame.rendering.renderFormats = highPrecisionRendering ? [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F] : [];
            applyPostEffectSettings(cameraFrame, postEffectSettings);
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
            // no post effects needed, destroy camera frame if it exists
            if (this.cameraFrame) {
                this.cameraFrame.destroy();
                this.cameraFrame = null;
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
