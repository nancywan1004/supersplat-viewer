import '@playcanvas/web-components';
import {
    Asset,
    Entity,
    EventHandler,
    type Texture,
    type AppBase,
    revision as engineRevision,
    version as engineVersion
} from 'playcanvas';

import { observe } from './core/observe';
import { importSettings } from './settings';
import type { Config, Global } from './types';
import { initPoster, initUI } from './ui';
import { Viewer } from './viewer';
import { initXr } from './xr';
import { LodLoader } from './loaders/lod-loader';
import { version as appVersion } from '../package.json';
import { initPostMessageBridge } from './message-bridge';

const loadGsplat = async (app: AppBase, config: Config, progressCallback: (progress: number) => void, lodLoader?: LodLoader) => {
    const { contents, contentUrl, unified, aa } = config;
    const c = contents as unknown as ArrayBuffer;
    const filename = new URL(contentUrl, location.href).pathname.split('/').pop();
    const data = filename.toLowerCase() === 'meta.json' ? await (await contents).json() : undefined;
    const shouldEnableLod = lodLoader?.shouldEnableLod(contentUrl) ?? false;
    const asset = new Asset(filename, 'gsplat', { url: contentUrl, filename, contents: c }, data);

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
};

const loadSkybox = (app: AppBase, url: string) => {
    return new Promise<Asset>((resolve, reject) => {
        const asset = new Asset('skybox', 'texture', {
            url
        }, {
            type: 'rgbp',
            mipmaps: false,
            addressu: 'repeat',
            addressv: 'clamp'
        });

        asset.on('load', () => {
            resolve(asset);
        });

        asset.on('error', (err) => {
            console.log(err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

const skyboxTextureCache = new Map<string, Texture>();

const applySkyboxTexture = async (app: AppBase, url: string) => {
    const trimmedUrl = url?.trim();
    if (!trimmedUrl) {
        console.warn('[SuperSplat] SKYBOX_SWITCH 缺少有效的 URL');
        return;
    }

    const cachedTexture = skyboxTextureCache.get(trimmedUrl);
    if (cachedTexture) {
        app.scene.envAtlas = cachedTexture;
        app.renderNextFrame = true;
        return;
    }

    const asset = await loadSkybox(app, trimmedUrl);
    const texture = asset.resource as Texture;
    skyboxTextureCache.set(trimmedUrl, texture);
    app.scene.envAtlas = texture;
    app.renderNextFrame = true;
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

    const global: Global = {
        app,
        settings: importSettings(settingsJson),
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

    // Load skybox
    const skyboxLoad = config.skyboxUrl && applySkyboxTexture(app, config.skyboxUrl);

    if (skyboxLoad) {
        skyboxLoad.then(() => {
            events.fire('skyboxSelectionSynced', config.skyboxUrl ?? '');
        }).catch((err) => {
            console.warn('[SuperSplat] 初始化天空盒失败：', err);
        });
    }

    events.on('skyboxSwitch', async (url?: string | null) => {
        if (!url) {
            app.scene.envAtlas = null;
            app.renderNextFrame = true;
            events.fire('skyboxSelectionSynced', '');
            return;
        }

        try {
            await applySkyboxTexture(app, url);
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
