import '@playcanvas/web-components';
import {
    Asset,
    Entity,
    EventHandler,
    type Texture,
    type AppBase,
    GSplatResource,
    revision as engineRevision,
    version as engineVersion,
    Vec3
} from 'playcanvas';

import { applySkyboxSphere, removeSkyboxSphere, applySkyboxTexture, type SkyboxOptions } from './loaders/skybox-loader';

import { observe } from './core/observe';
import { importSettings } from './settings';
import type { Config, Global } from './types';
import { initPoster, initUI } from './ui';
import { Viewer } from './viewer';
import { initXr } from './xr';
import { LodLoader } from './loaders/lod-loader';
import { loadSplat } from './loaders/splat-loader';
import type { AssetSource } from './loaders/asset-source';
import { version as appVersion } from '../package.json';
import { initPostMessageBridge } from './message-bridge';

/**
 * 加载 gsplat Asset（参照提供的 load 函数模式）
 * 用于处理 .splat 格式和其他格式的 gsplat 文件
 */
const loadGsplatAsset = async (app: AppBase, assetSource: AssetSource): Promise<Asset> => {
    const filename = (assetSource.filename || assetSource.url || '').toLowerCase();
    let asset: Asset;

    if (filename.endsWith('.splat')) {
        // 对于 .splat 格式，加载并转换为 GSplatData
        const gsplatData = await loadSplat(assetSource);
        
        // 创建 Asset 并设置 resource
        asset = new Asset(assetSource.filename || assetSource.url, 'gsplat', {
            url: assetSource.contents ? `local-asset-${Date.now()}` : assetSource.url ?? assetSource.filename,
            filename: assetSource.filename
        });
        
        app.assets.add(asset);
        // 使用 GSplatResource 包装 GSplatData
        asset.resource = new GSplatResource(app.graphicsDevice, gsplatData);
        // 标记为已加载，并触发 load 事件
        asset.loaded = true;
        asset.fire('load', asset);
    } else {
        // 对于其他格式，使用 PlayCanvas 的标准加载方式
        const c = assetSource.contents ? await assetSource.contents.arrayBuffer() : undefined;
        asset = new Asset(assetSource.filename || assetSource.url, 'gsplat', {
            url: assetSource.url ?? assetSource.filename,
            filename: assetSource.filename,
            contents: c
        });
        app.assets.add(asset);
        app.assets.load(asset);
    }

    return asset;
};

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
                unified: unified || shouldEnableLod,
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
                    unified: unified || shouldEnableLod,
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

const main = (app: AppBase, camera: Entity, settingsJson: any, config: Config) => {
    const events = new EventHandler();

    const state = observe(events, {
        readyToRender: false,
        hqMode: true,
        progress: 0,
        inputMode: 'desktop',
        cameraMode: 'orbit',
        hasAnimation: false,
        animationDuration: 0,
        animationTime: 0,
        animationPaused: true,
        hasAR: false,
        hasVR: false,
        isFullscreen: false,
        controlsHidden: false,
        hasRevealEffect: false,
        showCameraPath: false
    });

    // 如果设置了 noreveal 参数，清除 reveal effect 配置
    const processedSettings = importSettings(settingsJson);
    if (config.noreveal) {
        processedSettings.revealEffect = undefined;
    }

    const global: Global = {
        app,
        settings: processedSettings,
        config,
        state,
        events,
        camera
    };

    const lodLoader = new LodLoader(global);
    if (lodLoader.shouldEnableLod(config.contentUrl)) {
        lodLoader.initializeLodSettings();
    }

    // Initialize the load-time poster
    if (config.poster) {
        initPoster(events);
    }

    camera.addComponent('camera');

    // Initialize XR support
    initXr(global);

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

    // Create the viewer
    initPostMessageBridge(global);

    return new Viewer(global, gsplatLoad, skyboxLoad);
};

console.log(`SuperSplat Viewer v${appVersion} | Engine v${engineVersion} (${engineRevision})`);

export { main };
