import {
    Asset,
    Color,
    createGraphicsDevice,
    Entity,
    EventHandler,
    Keyboard,
    Mouse,
    platform,
    TouchDevice,
    type Texture,
    type AppBase,
    GSplatResource,
    revision as engineRevision,
    version as engineVersion,
    Vec3
} from 'playcanvas';

import { applySkyboxSphere, removeSkyboxSphere, applySkyboxTexture, type SkyboxOptions } from './loaders/skybox-loader';

import { App } from './app';
import { observe } from './core/observe';
import { importSettings } from './settings';
import type { Config, Global } from './types';
import type { ExperienceSettings } from './schemas/v2';
import { initPoster, initUI } from './ui/ui';
import { Viewer } from './viewer';
import { initXr } from './xr';
import { initLight } from './light';
import { LodLoader } from './loaders/lod-loader';
import { loadSplat } from './loaders/splat-loader';
import type { AssetSource } from './loaders/asset-source';
import { loadGsplatAsset } from './loaders/gsplat-asset-loader';
import { version as appVersion } from '../package.json';
import { initPostMessageBridge } from './message-bridge';
import { initVideoExport } from './render/video-export';

export { loadGsplatAsset };

const loadGsplat = async (app: AppBase, config: Config, progressCallback: (progress: number) => void, lodLoader?: LodLoader) => {
    const { contents, contentUrl, unified, aa } = config;
    const filename = new URL(contentUrl, location.href).pathname.split('/').pop();
    const shouldEnableLod = lodLoader?.shouldEnableLod(contentUrl) ?? false;
    
    // 检查是否为 .splat 格式
    const isSplat = (filename || contentUrl || '').toLowerCase().endsWith('.splat');
    
    if (isSplat) {
        // 对于 .splat 格式，需要先获取 contents
        let assetSource: AssetSource = {
            url: contentUrl,
            filename: filename
        };
        
        if (contents) {
            const response = await contents;
            const arrayBuffer = await response.arrayBuffer();
            const blob = new Blob([arrayBuffer]);
            assetSource.contents = new File([blob], filename || 'model', { type: 'application/octet-stream' });
        }
        
        // 使用 loadGsplatAsset 加载
        progressCallback(10);
        const asset = await loadGsplatAsset(app, assetSource);
        progressCallback(90);
        
        // 创建实体的辅助函数
        const createEntity = () => {
            const entity = new Entity('gsplat');
            entity.setLocalEulerAngles(0, 0, 180);
            entity.addComponent('gsplat', {
                unified: true,
                asset
            });
            const material = entity.gsplat.unified ? app.scene.gsplat.material : entity.gsplat.material;
            material.setDefine('GSPLAT_AA', aa);
            material.setParameter('alphaClip', 1 / 255);
            app.root.addChild(entity);

            if (shouldEnableLod && lodLoader) {
                const gsplatComponent = entity.gsplat;
                if (gsplatComponent) {
                    lodLoader.applyLodPreset(gsplatComponent);
                }
            }

            progressCallback(100);
            return entity;
        };
        
        // 如果 asset 已经加载完成，直接创建实体
        if (asset.loaded) {
            return createEntity();
        }
        
        // 否则等待 load 事件
        return new Promise<Entity>((resolve, reject) => {
            asset.once('load', () => {
                resolve(createEntity());
            });

            asset.on('error', (err) => {
                console.log(err);
                reject(err);
            });
        });
    } else {
        // 对于其他格式，使用原始代码的方式
        // 注意：不要提前消费 contents，让 PlayCanvas 自己处理
        const data = filename.toLowerCase() === 'meta.json' ? await (await contents).json() : undefined;
        const asset = new Asset(filename, 'gsplat', { url: contentUrl, filename }, data);

        return new Promise<Entity>((resolve, reject) => {
            asset.on('load', () => {
                const entity = new Entity('gsplat');
                entity.setLocalEulerAngles(0, 0, 180);
                entity.addComponent('gsplat', {
                    unified: true,
                    asset
                });
                // don't support AA in unified mode yet
                if (aa && !entity.gsplat.unified) {
                    entity.gsplat.material.setDefine('GSPLAT_AA', true);
                }
                app.root.addChild(entity);

                if (shouldEnableLod && lodLoader) {
                    const gsplatComponent = entity.gsplat;
                    if (gsplatComponent) {
                        lodLoader.applyLodPreset(gsplatComponent);
                    }
                }

                resolve(entity);
            });

            let watermark = 0;
            asset.on('progress', (received, length) => {
                const progress = Math.min(1, received / length) * 100;
                if (progress > watermark) {
                    watermark = progress;
                    progressCallback(Math.trunc(watermark));
                }
            });

            asset.on('error', (err) => {
                console.log(err);
                reject(err);
            });

            app.assets.add(asset);
            app.assets.load(asset);
        });
    }
};

const createApp = async (canvas: HTMLCanvasElement, config: Config) => {
    // Create the graphics device
    const device = await createGraphicsDevice(canvas, {
        deviceTypes: config.webgpu ? ['webgpu'] : [],
        antialias: false,
        depth: true,
        stencil: false,
        xrCompatible: !config.webgpu,
        powerPreference: 'high-performance'
    });

    // Set maxPixelRatio so the XR framebuffer scale factor is computed correctly.
    // Regular rendering bypasses maxPixelRatio via the custom initCanvas sizing.
    device.maxPixelRatio = window.devicePixelRatio;

    // Create the application
    const app = new App(canvas, {
        graphicsDevice: device,
        mouse: new Mouse(canvas),
        touch: new TouchDevice(canvas),
        keyboard: new Keyboard(window)
    });

    // Create entity hierarchy
    const cameraRoot = new Entity('camera root');
    app.root.addChild(cameraRoot);

    const camera = new Entity('camera');
    cameraRoot.addChild(camera);

    const light = new Entity('light');
    light.setEulerAngles(35, 45, 0);
    light.addComponent('light', {
        color: new Color(1.0, 0.98, 0.957),
        intensity: 1,
        castShadows: true
    });
    app.root.addChild(light);

    // 提高基础 ambient，保障 mesh 在无主光时仍具备可读性
    app.scene.ambientLight.set(1.22, 1.26, 1.34);

    return { app, camera };
};

// initialize canvas size and resizing
const initCanvas = (global: Global) => {
    const { app, events, state } = global;
    const { canvas } = app.graphicsDevice;

    // maximum pixel dimension we will allow along the shortest screen dimension based on platform
    const maxPixelDim = platform.mobile ? 1080 : 2160;

    // cap pixel ratio to limit resolution on high-DPI devices
    const calcPixelRatio = () => Math.min(maxPixelDim / Math.min(screen.width, screen.height), window.devicePixelRatio);

    // last known device pixel size (full resolution, before any quality scaling)
    const deviceSize = { width: 0, height: 0 };

    const set = (width: number, height: number) => {
        const ratio = calcPixelRatio();
        deviceSize.width = width * ratio;
        deviceSize.height = height * ratio;
    };

    const apply = () => {
        // don't resize the canvas during XR - the XR system manages its own framebuffers
        // and resetting canvas dimensions can invalidate the XRWebGLLayer
        if (app.xr?.active) return;

        const s = state.hqMode ? 1.0 : 0.5;
        const w = Math.ceil(deviceSize.width * s);
        const h = Math.ceil(deviceSize.height * s);
        if (w !== canvas.width || h !== canvas.height) {
            canvas.width = w;
            canvas.height = h;
        }
    };

    const resizeObserver = new ResizeObserver((entries: ResizeObserverEntry[]) => {
        const e = entries[0]?.contentBoxSize?.[0];
        if (e) {
            set(e.inlineSize, e.blockSize);
            app.renderNextFrame = true;
        }
    });
    resizeObserver.observe(canvas);

    events.on('hqMode:changed', () => {
        app.renderNextFrame = true;
    });

    // Resize canvas before render() so the swap chain texture is acquired at the correct size.
    app.on('framerender', apply);

    // Disable the engine's built-in canvas resize — we handle it via ResizeObserver
    // @ts-ignore
    app._allowResize = false;
    set(canvas.clientWidth, canvas.clientHeight);
    apply();
};

const main = async (canvas: HTMLCanvasElement, settingsJson: any, config: Config) => {
    const { app, camera } = await createApp(canvas, config);

    // create events
    const events = new EventHandler();

    const state = observe(events, {
        loaded: false,
        readyToRender: false,
        hqMode: true,
        progress: 0,
        inputMode: platform.mobile ? 'touch' : 'desktop',
        cameraMode: 'orbit',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: true,
        animationStarted: false,
        hasAR: false,
        hasVR: false,
        isFullscreen: false,
        controlsHidden: false,
        hasRevealEffect: false,
        showCameraPath: false,
        showCameraBoundingBox: false,
        vfxActive: false,
        vfxType: 'none' as 'none' | 'grow' | 'pieces-recover' | 'perlin-wave' | 'disintegrate' | 'integrate' | 'growth-wave',
        editMode: false,
        previewMode: false,
        editLeftModule: null,
        assetTransformMode: undefined,
        uploadedAssets: [],
        scenePlacedEntities: [],
        selectedSceneEntityId: null,
        cameraControlsEnabled: true,

        // 标注相关状态
        annotationEditMode: false,
        selectedAnnotationId: null,
        annotationTransformMode: null,
        annotationPlacementActive: false,

        // 光源编辑相关状态（环境模块）
        selectedLightId: null,
        lightTransformMode: null,

        // 导出 VFX 视频时的锁，防止实时更新干扰离线渲染
        isExportingVfxVideo: false,
        // 导出前 VFX 播放/暂停状态，导出结束后用于恢复（reveal 会在 setPlayPause 时同步）
        effectPaused: false
    });

    // 如果设置了 noreveal 参数，清除 reveal effect 配置
    const processedSettings = importSettings(settingsJson);
    if (config.noreveal) {
        processedSettings.revealEffect = undefined;
    }

    // 保留原始配置副本，供进入 Edit 模式时恢复使用（View 模式的临时修改不污染此副本）
    const originalSettings = JSON.parse(JSON.stringify(processedSettings)) as ExperienceSettings;

    const global: Global = {
        app,
        settings: processedSettings,
        config,
        state,
        events,
        camera
    };

    // 将原始配置挂载到 global 供后续恢复使用
    (global as any).__originalSettings = originalSettings;

    // 供 NightMode 等脚本读取点光源等（collectPointLights 需要 global）
    (app as any).__global = global;

    const lodLoader = new LodLoader(global);
    if (lodLoader.shouldEnableLod(config.contentUrl)) {
        lodLoader.initializeLodSettings();
    }
    initCanvas(global);

    // start the application
    app.start();

    // Initialize the load-time poster
    if (config.poster) {
        initPoster(events);
    }

    camera.addComponent('camera');

    // Initialize lighting
    initLight(global);

    // Initialize XR support
    if (!config.webgpu) {
        initXr(global);
    }

    // Initialize user interface
    initUI(global);

    // Load model
    const gsplatLoad = loadGsplat(
        app,
        config,
        (progress: number) => {
            state.progress = progress;
        },
        lodLoader
    );

    const skyboxOptions: SkyboxOptions = {
        center: new Vec3(0, 0, 0),
        radius: 5000,
        rotation: new Vec3(0, 0, 0)
    };

    // Load skybox
    const skyboxLoad = config.skyboxUrl && applySkyboxTexture(app, config.skyboxUrl);
    //const skyboxLoad = config.skyboxUrl ? applySkyboxSphere(app, config.skyboxUrl, skyboxOptions).then(() => {}) : Promise.resolve();

    if (skyboxLoad) {
        skyboxLoad.then(() => {
            events.fire('skyboxSelectionSynced', config.skyboxUrl ?? '');
        }).catch((err) => {
            console.warn('[SuperSplat] 初始化天空盒失败：', err);
        });
    }

    events.on('skyboxSwitch', async (url?: string | null) => {
        if (!url) {
            // 移除所有天空盒实体
            removeSkyboxSphere(app);
            app.scene.envAtlas = null;
            app.renderNextFrame = true;
            events.fire('skyboxSelectionSynced', '');
            return;
        }

        try {
            // 切换天空盒时，先移除旧的 sphere 实体（如果有不同 URL 的）
            // 注意：applySkyboxSphere 内部会处理相同 URL 的复用，所以这里可以不移除
            // 但如果需要确保只有一个天空盒，可以在这里移除所有旧的
            removeSkyboxSphere(app); // 可选：确保只有一个天空盒
            await applySkyboxTexture(app, url);
            //await applySkyboxSphere(app, url, skyboxOptions);
            events.fire('skyboxSelectionSynced', url);
        } catch (err) {
            console.warn('[SuperSplat] 切换天空盒失败：', err);
        }
    });

    // Load and play sound
    if (global.settings.soundUrl) {
        const sound = new Audio(global.settings.soundUrl);
        sound.crossOrigin = 'anonymous';
        document.body.addEventListener('click', () => {
            if (sound) {
                sound.play();
            }
        }, {
            capture: true,
            once: true
        });
    }

    // Viewer 构造内会 initCommandRegistry 并注册各 facade；postMessage 监听须在此之后挂载，否则编辑类协议无法经 registry 单路径执行。
    const viewer = new Viewer(global, gsplatLoad, skyboxLoad);

    initPostMessageBridge(global);

    // 将 viewer 存储到 app 上，方便其他模块访问（如 seekAnimToTimeAndApply）
    (app as any).viewer = viewer;

    // 视频导出需在 Viewer / RevealController 就绪后初始化，通过依赖注入传入 reveal 时间源
    initVideoExport(global, {
        getRevealExportTimingSource: () => viewer.revealController
    });

    return viewer;
};

console.log(`SuperSplat Viewer v${appVersion} | Engine v${engineVersion} (${engineRevision})`);

export { main };
