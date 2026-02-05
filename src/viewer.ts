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
    Texture,
    type TextureHandler,
    PIXELFORMAT_R8,
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
import { BloomDebugFilter } from './vfx/bloom-debug-filter';
import { BloomBrushFilter } from './vfx/bloom-brush-filter';
import { BloomBrushPainter } from './vfx/bloom-brush-painter';
import { NightMode } from './vfx/lighting/night-mode';

// override global pick to pack depth instead of meshInstance id
const pickDepthGlsl = /* glsl */ `
uniform vec4 camera_params;     // 1/far, far, near, isOrtho
vec4 getPickOutput() {
    float linearDepth = 1.0 / gl_FragCoord.w;
    float normalizedDepth = (linearDepth - camera_params.z) / (camera_params.y - camera_params.z);
    return vec4(gaussianColor.a * normalizedDepth, 0.0, 0.0, gaussianColor.a);
}
`;

const gammaChunk = `
vec3 prepareOutputFromGamma(vec3 gammaColor) {
    return gammaColor;
}
`;

const pickDepthWgsl = /* wgsl */ `
    uniform camera_params: vec4f;       // 1/far, far, near, isOrtho
    fn getPickOutput() -> vec4f {
        let linearDepth = 1.0 / pcPosition.w;
        let normalizedDepth = (linearDepth - uniform.camera_params.z) / (uniform.camera_params.y - uniform.camera_params.z);
        return vec4f(gaussianColor.a * normalizedDepth, 0.0, 0.0, gaussianColor.a);
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

/**
 * Bloom 的 threshold（亮度阈值）与 bright-pass 说明：
 * - Bright-pass：常见 bloom 管线会先做一步「亮部提取」——只保留亮度高于某阈值的像素，得到一张仅高光区域有值的图，再对该图做模糊并叠回原图。这样只有「超过阈值的部分」会发光。
 * - 当前 PlayCanvas CameraFrame 的 bloom 没有 bright-pass 阶段：它直接把半分辨率场景图做 downsample/upsample 模糊，没有「先按阈值过滤再模糊」的步骤，因此引擎未暴露 threshold 参数。settings 里的 threshold 仅作配置保留，后续若自建 bloom 管线或扩展引擎时可接入。
 */
const applyPostEffectSettings = (cameraFrame: CameraFrame, settings: PostEffectSettings) => {
    if (settings.sharpness.enabled) {
        cameraFrame.rendering.sharpness = settings.sharpness.amount;
    } else {
        cameraFrame.rendering.sharpness = 0;
    }

    const { bloom } = cameraFrame;
    const bloomDebug = (settings.bloom as { bloomDebug?: boolean }).bloomDebug ?? false;
    if (settings.bloom.enabled) {
        bloom.intensity = Math.max(0, Math.min(0.2, Number(settings.bloom.intensity)));
        bloom.blurLevel = settings.bloom.blurLevel;
        cameraFrame.debug = bloomDebug ? 'bloom' : null;
    } else {
        bloom.intensity = 0;
        cameraFrame.debug = null;
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
    const bloomOn = settings.bloom.enabled && (Number(settings.bloom.intensity) > 0);
    return (settings.sharpness.enabled && settings.sharpness.amount > 0) ||
        bloomOn ||
        (settings.grading.enabled) ||
        (settings.vignette.enabled && settings.vignette.intensity > 0) ||
        (settings.fringing.enabled && settings.fringing.intensity > 0);
};

const vec = new Vec3();

class Viewer {
    global: Global;

    cameraFrame: CameraFrame;

    inputController: InputController;

    revealController: RevealController;

    cameraManager: CameraManager;

    annotations: Annotations;

    forceRenderNextFrame = false;
    pathVisualizer: CameraPathVisualizer | null = null;

    /** Bloom Debug：按亮度阈值过滤 gsplat，仅亮部参与绘制；threshold 由此处从 settings 同步 */
    bloomDebugFilter: InstanceType<typeof BloomDebugFilter> | null = null;
    /** Bloom Brush：2D 屏幕空间局部 bloom，笔刷 mask 在 compose 阶段乘 bloom */
    bloomBrushFilter: InstanceType<typeof BloomBrushFilter> | null = null;
    bloomBrushPainter: BloomBrushPainter | null = null;
    /** 1x1 白纹理，未开 brush 时 compose 用此作 bloomMaskTexture（全屏 bloom） */
    bloomBrushWhiteTexture: Texture | null = null;

    /** Night Mode 脚本（用于 Night Mode + Bloom Brush 合成） */
    nightModeScript: InstanceType<typeof NightMode> | null = null;

    private _cameraFrameUpdateWrapped = false;

    /** 将 cameraManager 的相机姿态应用到实体（导出时 seek anim 后调用） */
    applyCameraFromManager: () => void = () => {};

    constructor(global: Global, gsplatLoad: Promise<Entity>, skyboxLoad: Promise<void>) {
        this.global = global;

        const { app, settings, config, events, state, camera } = global;
        const { graphicsDevice } = app;

        // enable anonymous CORS for image loading in safari
        (app.loader.getHandler('texture') as TextureHandler).imgParser.crossOrigin = 'anonymous';

        // render skybox as plain equirect
        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        glsl.set('skyboxPS', glsl.get('skyboxPS').replace('mapRoughnessUv(uv, mipLevel)', 'uv'));
        glsl.set('pickPS', pickDepthGlsl);

        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        wgsl.set('skyboxPS', wgsl.get('skyboxPS').replace('mapRoughnessUv(uv, uniform.mipLevel)', 'uv'));
        wgsl.set('pickPS', pickDepthWgsl);

        // 2D 局部 bloom：compose 时用 mask 乘 bloom，仅 mask=1 区域叠加光晕（Bloom Brush）
        // 亮度 threshold：仅当 luminance(color) >= bloomThreshold 时参与 bloom（复用 bloom 面板的 Threshold 滑杆）
        const composeBloomPSGlsl = `
#ifdef BLOOM
uniform sampler2D bloomTexture;
uniform float bloomIntensity;
uniform sampler2D bloomMaskTexture;
uniform float bloomThreshold;
vec3 dBloom;
vec3 applyBloom(vec3 color, vec2 uv) {
    dBloom = texture2DLod(bloomTexture, uv, 0.0).rgb;
    float mask = texture2DLod(bloomMaskTexture, uv, 0.0).r;
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float brightPass = step(bloomThreshold, lum);
    return color + dBloom * bloomIntensity * mask * brightPass;
}
#endif
`;
        const composeBloomPSWgsl = `
#ifdef BLOOM
var bloomTexture: texture_2d<f32>;
var bloomTextureSampler: sampler;
var bloomMaskTexture: texture_2d<f32>;
var bloomMaskTextureSampler: sampler;
uniform bloomIntensity: f32;
uniform bloomThreshold: f32;
var<private> dBloom: vec3f;
fn applyBloom(color: vec3f, uv: vec2f) -> vec3f {
    dBloom = textureSampleLevel(bloomTexture, bloomTextureSampler, uv, 0.0).rgb;
    let mask = textureSampleLevel(bloomMaskTexture, bloomMaskTextureSampler, uv, 0.0).r;
    let lum = dot(color, vec3f(0.2126, 0.7152, 0.0722));
    let brightPass = select(0.0, 1.0, lum >= uniform.bloomThreshold);
    return color + dBloom * uniform.bloomIntensity * mask * brightPass;
}
#endif
`;
        glsl.set('composeBloomPS', composeBloomPSGlsl);
        wgsl.set('composeBloomPS', composeBloomPSWgsl);

        // 1x1 白纹理：未开 Bloom Brush 时 bloomMaskTexture 用此（全屏 bloom）
        const whiteCanvas = document.createElement('canvas');
        whiteCanvas.width = 1;
        whiteCanvas.height = 1;
        const whiteCtx = whiteCanvas.getContext('2d')!;
        whiteCtx.fillStyle = '#ffffff';
        whiteCtx.fillRect(0, 0, 1, 1);
        this.bloomBrushWhiteTexture = new Texture(graphicsDevice, {
            name: 'bloomBrushWhite',
            width: 1,
            height: 1,
            format: PIXELFORMAT_R8,
            mipmaps: false
        });
        this.bloomBrushWhiteTexture.setSource(whiteCanvas);
        this.bloomBrushWhiteTexture.upload();

        app.on('frameUpdate', () => {
            if (!this.cameraFrame || !global.settings.postEffectSettings?.bloom?.enabled) return;
            const bloom = global.settings.postEffectSettings.bloom as { bloomBrush?: boolean; threshold?: number };
            if (bloom.bloomBrush && this.bloomBrushPainter) this.bloomBrushPainter.flushUpload();
            const maskTex = bloom.bloomBrush && this.bloomBrushPainter
                ? this.bloomBrushPainter.getTexture()
                : this.bloomBrushWhiteTexture;
            try {
                if (maskTex) graphicsDevice.scope.resolve('bloomMaskTexture').setValue(maskTex);
                const th = Math.max(0, Math.min(5, Number(bloom.threshold ?? 0.2)));
                graphicsDevice.scope.resolve('bloomThreshold').setValue(th);
            } catch (_) {}
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
        app.on('nightMode:changed', () => {
            this.configureCamera(global.settings);
            app.renderNextFrame = true;
        });
        events.on('bloomBrush:clear', () => {
            this.bloomBrushPainter?.clear();
            app.renderNextFrame = true;
        });

        // handle canvas resize - update aspect ratio and trigger render
        const handleResize = () => {
            camera.camera.aspectRatio = graphicsDevice.width / graphicsDevice.height;
            app.renderNextFrame = true;
        };
        graphicsDevice.on('resizecanvas', handleResize);

        // handle HQ mode changes
        const updateHqMode = () => {
            // limit the backbuffer to 4k on desktop and HD on mobile
            // we use the shorter dimension so ultra-wide (or high) monitors still work correctly.
            const maxRatio = (platform.mobile ? 1080 : 2160) / Math.min(screen.width, screen.height);

            // half pixel resolution with hq mode disabled
            graphicsDevice.maxPixelRatio = (state.hqMode ? 1.0 : 0.5) * Math.min(maxRatio, window.devicePixelRatio);

            app.renderNextFrame = true;
        };
        events.on('hqMode:changed', updateHqMode);
        updateHqMode();

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

        // unpause the animation on first frame
        events.on('firstFrame', () => {
            state.animationPaused = !!config.noanim;
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

            // 先创建 cameraManager，因为 revealController 需要它来获取 targetConstraint
            this.cameraManager = new CameraManager(global, sceneBound);
            
            this.revealController = new RevealController(global, sceneBound, results[0], this.cameraManager);
            
            // Initialize night mode script on root entity
            if (!app.root.script) {
                app.root.addComponent('script');
            }
            const nightModeScript = app.root.script.create(NightMode) as unknown as InstanceType<typeof NightMode>;
            this.nightModeScript = nightModeScript;
            // Find entities by name or tag
            const lightEntity = app.root.findByName('light') as Entity | null || (app.root.findByTag('light') as Entity[])?.[0] || null;
            const cameraEntity = global.camera;
            nightModeScript.light = lightEntity;
            nightModeScript.camera = cameraEntity || null;
            nightModeScript.splat = results[0];
            // Keep enabled = true so update() continues to run
            // We control night mode through nightMode property, not enabled
            nightModeScript.enabled = true;
            console.log('NightMode script initialized:', {
                light: lightEntity ? 'found' : 'not found',
                camera: cameraEntity ? 'found' : 'not found',
                splat: results[0] ? 'found' : 'not found'
            });

            // Bloom Debug / Bloom Brush：与 NightMode 同机制，threshold 在 configureCamera 中同步；Brush 与 Debug 互斥
            const gsplatEntity = results[0];
            if (!gsplatEntity.script) gsplatEntity.addComponent('script');
            this.bloomDebugFilter = gsplatEntity.script.create(BloomDebugFilter) as unknown as InstanceType<typeof BloomDebugFilter>;
            this.bloomDebugFilter.enabled = false;
            this.bloomBrushFilter = gsplatEntity.script.create(BloomBrushFilter) as unknown as InstanceType<typeof BloomBrushFilter>;
            this.bloomBrushFilter.enabled = false;
            this.bloomBrushFilter.cameraEntity = global.camera;
            const appCanvas = app.graphicsDevice?.canvas as HTMLCanvasElement | undefined ?? document.querySelector('canvas');
            if (appCanvas) {
                this.bloomBrushPainter = new BloomBrushPainter({
                    device: app.graphicsDevice,
                    appCanvas
                });
                this.bloomBrushFilter.maskTexture = this.bloomBrushPainter.getTexture();
            } else {
                console.warn('[Viewer] BloomBrushPainter not created: no appCanvas (graphicsDevice.canvas or querySelector("canvas"))');
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
                        low: {
                            range: [2, 8],
                            splatBudget: 1
                        },
                        high: {
                            range: [1, 8],
                            splatBudget: 2
                        }
                    },
                    desktop: {
                        low: {
                            range: [1, 8],
                            splatBudget: 3
                        },
                        high: {
                            range: [0, 8],
                            splatBudget: 6
                        }
                    }
                };

                const quality = platform.mobile ? ranges.mobile : ranges.desktop;

                // If using custom LOD (lodLoader), apply component-level parameters from preset stored in scene
                // Otherwise, use default LOD settings
                if (isCustomLod) {
                    const gsplatScene = (app.scene as any).gsplat;
                    if (gsplatScene && gsplatScene.lodRangeMax !== undefined) {
                        // Apply splatBudget from preset
                        if (gsplatScene.splatBudget !== undefined) {
                            results[0].gsplat.splatBudget = gsplatScene.splatBudget * 1000000;
                        }
                        // Force initial load to include lod0, temporarily set range to [0, max]
                        // The preset range will be restored after initial load completes via updateLod()
                        gsplat.lodRangeMin = 0;
                        gsplat.lodRangeMax = gsplatScene.lodRangeMax;
                    } else {
                        // Fallback: start with lod0 to ensure initial high quality
                        gsplat.lodRangeMin = 0;
                        gsplat.lodRangeMax = 5;
                    }
                } else {
                    // Use default LOD settings, start in low quality mode so we can get user interacting asap
                    gsplat.lodRangeMin = quality.low.range[0];
                    gsplat.lodRangeMax = quality.low.range[1];
                    results[0].gsplat.splatBudget = quality.low.splatBudget * 1000000;
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
                let animationStarted = false; // Track if animation has started
                let progressUIHidden = false; // Track if progress UI has been hidden
                const PROGRESS_THRESHOLD = 50; // Hide progress UI when progress reaches this threshold
                const readyHandler = (camera: CameraComponent, layer: Layer, ready: boolean, loading: number) => {

                    if (ready && loading === 0) {
                        // scene is done loading
                        eventHandler.off('frame:ready', readyHandler);

                        state.readyToRender = true;

                        // In LOD mode, ensure animation is started (in case it wasn't started earlier)
                        if (isCustomLod && settings.startMode === 'animTrack' && state.hasAnimation && !config.noanim) {
                            console.log('LOD mode: all chunks loaded, ensuring animation is playing');
                            state.animationPaused = false;
                        }

                        // handle quality mode changes
                        const updateLod = () => {
                            if (isCustomLod) {
                                // If using custom LOD (lodLoader), use the preset range and splatBudget from scene settings
                                const gsplatScene = (app.scene as any).gsplat;
                                if (gsplatScene && gsplatScene.lodRangeMin !== undefined) {
                                    gsplat.lodRangeMin = gsplatScene.lodRangeMin;
                                    gsplat.lodRangeMax = gsplatScene.lodRangeMax;
                                    // Ensure splatBudget is set from preset
                                    if (gsplatScene.splatBudget !== undefined) {
                                        results[0].gsplat.splatBudget = gsplatScene.splatBudget * 1000000;
                                    }
                                }
                            } else {
                                // For default LOD mode, use the quality ranges
                                const settings = state.hqMode ? quality.high : quality.low;
                                gsplat.lodRangeMin = settings.range[0];
                                gsplat.lodRangeMax = settings.range[1];
                                results[0].gsplat.splatBudget = settings.splatBudget * 1000000;
                            }
                        };
                        events.on('hqMode:changed', updateLod);
                        updateLod();

                        // debug colorize lods
                        gsplat.colorizeLod = config.colorize;

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
                        if (isCustomLod && animationStarted) {
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
                            
                            // Start animation if available
                            if (settings.startMode === 'animTrack' && state.hasAnimation && !config.noanim && !animationStarted) {
                                animationStarted = true;
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

    /** 在 cameraFrame.update 前设置 bloomMaskTexture 到 scope，并保证仅包装一次 update */
    private injectBloomMaskTextureBeforeUpdate(cameraFrame: CameraFrame) {
        const graphicsDevice = this.global.app.graphicsDevice;
        const setBloomMask = () => {
            const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrush?: boolean; threshold?: number } | undefined;
            const maskTex = (bloom?.bloomBrush && this.bloomBrushPainter)
                ? this.bloomBrushPainter.getTexture()
                : this.bloomBrushWhiteTexture;
            try {
                if (maskTex) graphicsDevice.scope.resolve('bloomMaskTexture').setValue(maskTex);
                const th = Math.max(0, Math.min(5, Number(bloom?.threshold ?? 0.2)));
                graphicsDevice.scope.resolve('bloomThreshold').setValue(th);
            } catch (_) {}
        };
        if (!this._cameraFrameUpdateWrapped) {
            this._cameraFrameUpdateWrapped = true;
            const orig = cameraFrame.update.bind(cameraFrame);
            cameraFrame.update = () => {
                setBloomMask();
                orig();
            };
        } else {
            setBloomMask();
        }
    }

    // configure camera based on application mode and post process settings
    configureCamera(settings: ExperienceSettings) {
        const { global } = this;
        const { app, camera } = global;
        const postEffectSettings = settings.postEffectSettings;
        const { background } = settings;

        // 无 postEffectSettings 或未启用任一后处理时跳过，避免报错
        const enableCameraFrame = !app.xr.active &&
            !!postEffectSettings &&
            (anyPostEffectEnabled(postEffectSettings) || settings.highPrecisionRendering);

        if (enableCameraFrame) {
            if (!this.cameraFrame) {
                this.cameraFrame = new CameraFrame(app, camera.camera);
            }

            const { cameraFrame } = this;
            cameraFrame.rendering.toneMapping = tonemapTable[settings.tonemapping];
            // 启用 bloom 时必须先设 HDR 格式再 enable，否则引擎会回退到 RGBA8 并关闭 bloom（_bloomEnabled=false）
            const bloomWanted = postEffectSettings.bloom.enabled && (Number(postEffectSettings.bloom.intensity) > 0);
            cameraFrame.rendering.renderFormats = (settings.highPrecisionRendering || bloomWanted)
                ? [PIXELFORMAT_RGBA16F, PIXELFORMAT_RGBA32F]
                : [];
            cameraFrame.enabled = true;
            applyPostEffectSettings(cameraFrame, postEffectSettings);

            // threshold 仅用于 Bloom Debug 视图；Bloom Brush 与 Bloom Debug 互斥
            const bloom = postEffectSettings.bloom as { bloomDebug?: boolean; bloomBrush?: boolean; bloomBrushSize?: number; threshold?: number };
            const bloomDebug = !!bloom.bloomDebug;
            const bloomBrush = !!bloom.bloomBrush;
            const th = Math.max(0, Math.min(5, Number(bloom.threshold ?? 0.2)));
            cameraFrame.debug = bloomDebug ? 'bloom' : null;
            if (this.bloomDebugFilter) {
                this.bloomDebugFilter.threshold = th;
                this.bloomDebugFilter.enabled = bloomDebug && !bloomBrush;
                this.bloomDebugFilter.camera = null;
            }
            // Night Mode + Bloom Brush 合成：同时开启时 BloomBrushFilter 不应用（避免覆盖 NightMode 的 gsplat chunk），
            // 由 NightMode 使用带 bloom brush 条件的 shader；仅 Bloom Brush 时正常启用 BloomBrushFilter
            const nightModeOn = this.nightModeScript?.isNightModeEnabled ?? false;
            const bloomBrushWithNight = bloomBrush && nightModeOn;
            if (this.bloomBrushFilter) {
                this.bloomBrushFilter.enabled = bloomBrush && !nightModeOn;
                this.bloomBrushFilter.maskTexture = this.bloomBrushPainter?.getTexture() ?? null;
            }
            if (this.bloomBrushPainter) {
                this.bloomBrushPainter.setEnabled(bloomBrush);
                this.bloomBrushPainter.setBrushSize(Math.max(1, Math.min(200, Number(bloom.bloomBrushSize ?? 30))));
            }
            if (this.nightModeScript) {
                const mask = bloomBrushWithNight ? this.bloomBrushPainter?.getTexture() ?? null : null;
                this.nightModeScript.setBloomBrushParams(bloomBrushWithNight, mask, th, undefined);
            }

            // 在 cameraFrame.update() 前注入 bloomMaskTexture，确保与引擎 bloom 合成使用同一 scope
            this.injectBloomMaskTextureBeforeUpdate(cameraFrame);

            cameraFrame.update();

            // force gsplat shader to write gamma-space colors
            ShaderChunks.get(app.graphicsDevice, 'glsl').set('gsplatOutputVS', gammaChunk);

            // ensure the final blit doesn't perform linear->gamma conversion
            RenderTarget.prototype.isColorBufferSrgb = function () {
                return true;
            };

            camera.camera.clearColor = new Color(background.color);
        } else {
            if (this.cameraFrame) {
                this.cameraFrame.destroy();
                this.cameraFrame = null;
                this._cameraFrameUpdateWrapped = false;
            }
            if (this.bloomDebugFilter) {
                this.bloomDebugFilter.enabled = false;
                this.bloomDebugFilter.camera = null;
            }
            if (this.nightModeScript) {
                this.nightModeScript.setBloomBrushParams(false, null, 0.2, undefined);
            }

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
