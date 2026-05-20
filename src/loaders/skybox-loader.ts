import { Texture, Entity, Vec3, AppBase, StandardMaterial, CULLFACE_NONE, Asset, BoundingBox, Color, EnvLighting, PIXELFORMAT_RGBA8, type TextureHandler } from "playcanvas";

const skyboxTextureCache = new Map<string, Texture>();
const skyboxCubemapCache = new Map<string, Texture>();
const skyboxEntityCache = new Map<string, Entity>();
let solidEnvAtlasTexture: Texture | null = null;
const SOLID_ENV_ATLAS_COLOR = new Color(1, 1, 1);

export interface SkyboxOptions {
    /** 中心点位置，默认为 (0, 0, 0) */
    center?: Vec3 | [number, number, number];
    /** 半径，默认为 5000 */
    radius?: number;
    /** 旋转角度（欧拉角，单位：度），默认为 (0, 0, 0) */
    rotation?: Vec3 | [number, number, number];
}

/**
 * 使用 Sphere 实体创建天空盒，支持设置中心、半径和旋转
 */
const applySkyboxSphere = async (
    app: AppBase,
    url: string,
    options: SkyboxOptions = {}
) => {
    const trimmedUrl = url?.trim();
    if (!trimmedUrl) {
        console.warn('[SuperSplat] SKYBOX_SWITCH 缺少有效的 URL');
        return;
    }

    // 解析选项
    const center = options.center instanceof Vec3 
        ? options.center 
        : new Vec3(...(options.center || [0, 0, 0]));
    const radius = options.radius ?? 5000; // 默认半径 5000
    
    const rotation = options.rotation instanceof Vec3
        ? options.rotation
        : new Vec3(...(options.rotation || [0, 0, 0]));

    // 检查是否已有该 URL 的实体
    let skyboxEntity = skyboxEntityCache.get(trimmedUrl);
    
    if (skyboxEntity) {
        // 更新现有实体的位置、缩放和旋转
        skyboxEntity.setPosition(center);
        skyboxEntity.setLocalScale(radius, radius, radius); // 使用正缩放
        skyboxEntity.setLocalEulerAngles(rotation.x, rotation.y, rotation.z);
        app.renderNextFrame = true;
        return skyboxEntity;
    }

    // 加载纹理
    let texture: Texture;
    const cachedTexture = skyboxTextureCache.get(trimmedUrl);
    if (cachedTexture) {
        texture = cachedTexture;
    } else {
        const asset = await loadSkybox(app, trimmedUrl);
        texture = asset.resource as Texture;
        skyboxTextureCache.set(trimmedUrl, texture);
    }

    // 创建材质
    const material = new StandardMaterial();
    // 使用 diffuseMap 作为主要纹理
    material.diffuseMap = texture;
    // 同时设置 emissive 以确保可见（即使没有光照）
    material.emissiveMap = texture;
    material.emissive = new Color(1, 1, 1); // 白色发光
    material.useLighting = false; // 天空盒不需要光照
    material.cull = CULLFACE_NONE; // 双面渲染，确保从内部能看到
    material.depthWrite = false; // 不写入深度，确保始终在背景
    material.depthTest = false; // 不进行深度测试
    material.update();

    // 创建 Sphere 实体
    skyboxEntity = new Entity('skybox');
    skyboxEntity.addComponent('render', {
        type: 'sphere',
        material: material
    });

    // 设置位置、缩放和旋转
    // 注意：使用正缩放，通过 CULLFACE_NONE 实现双面渲染
    skyboxEntity.setPosition(center);
    skyboxEntity.setLocalScale(radius, radius, radius);
    skyboxEntity.setLocalEulerAngles(rotation.x, rotation.y, rotation.z);
    
    // 确保实体启用渲染
    const renderComponent = skyboxEntity.render;
    if (renderComponent) {
        renderComponent.enabled = true;
    }

    // 添加到场景
    app.root.addChild(skyboxEntity);
    
    // 缓存实体
    skyboxEntityCache.set(trimmedUrl, skyboxEntity);
    
    app.renderNextFrame = true;
    return skyboxEntity;
};

/**
 * 移除天空盒实体
 */
const removeSkyboxSphere = (app: AppBase, url?: string) => {
    if (url) {
        const trimmedUrl = url.trim();
        const entity = skyboxEntityCache.get(trimmedUrl);
        if (entity) {
            entity.destroy();
            skyboxEntityCache.delete(trimmedUrl);
        }
    } else {
        // 移除所有天空盒实体
        skyboxEntityCache.forEach((entity) => {
            entity.destroy();
        });
        skyboxEntityCache.clear();
    }
    app.renderNextFrame = true;
};

const applySkyboxTexture = async (app: AppBase, url: string) => {
    const trimmedUrl = url?.trim();
    if (!trimmedUrl) {
        console.warn('[SuperSplat] SKYBOX_SWITCH 缺少有效的 URL');
        return;
    }

    let sourceTexture = skyboxTextureCache.get(trimmedUrl);
    if (!sourceTexture) {
        const asset = await loadSkybox(app, trimmedUrl);
        sourceTexture = asset.resource as Texture;
        skyboxTextureCache.set(trimmedUrl, sourceTexture);
    }

    let skyboxCubemap = skyboxCubemapCache.get(trimmedUrl);
    if (!skyboxCubemap) {
        skyboxCubemap = EnvLighting.generateSkyboxCubemap(sourceTexture);
        skyboxCubemapCache.set(trimmedUrl, skyboxCubemap);
    }

    // 背景显示：走场景 skybox cubemap（不再使用 skybox sphere）。
    app.scene.skybox = skyboxCubemap;
    // IBL 仍固定为纯色 envAtlas，便于与背景解耦控制反光基调。
    app.scene.envAtlas = getOrCreateSolidEnvAtlas(app);
    app.renderNextFrame = true;
};

const getOrCreateSolidEnvAtlas = (app: AppBase): Texture => {
    if (solidEnvAtlasTexture) return solidEnvAtlasTexture;
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        throw new Error('[SuperSplat] 无法创建纯色 envAtlas 画布');
    }
    const r = Math.round(Math.max(0, Math.min(1, SOLID_ENV_ATLAS_COLOR.r)) * 255);
    const g = Math.round(Math.max(0, Math.min(1, SOLID_ENV_ATLAS_COLOR.g)) * 255);
    const b = Math.round(Math.max(0, Math.min(1, SOLID_ENV_ATLAS_COLOR.b)) * 255);
    ctx.fillStyle = `rgb(${r}, ${g}, ${b})`;
    ctx.fillRect(0, 0, 1, 1);

    solidEnvAtlasTexture = new Texture(app.graphicsDevice, {
        name: 'solidEnvAtlas',
        width: 1,
        height: 1,
        format: PIXELFORMAT_RGBA8,
        mipmaps: false
    });
    solidEnvAtlasTexture.setSource(canvas);
    solidEnvAtlasTexture.upload();
    return solidEnvAtlasTexture;
};

/**
 * 检测是否是本地开发环境
 */
const isLocalDevelopment = (): boolean => {
    if (typeof window === 'undefined') {
        return false;
    }
    const hostname = window.location.hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
};

/**
 * 获取本地开发代理基址（与 index.html `toProxy` 一致：`/api/proxy?url=`）
 */
const getLocalDevProxyBase = (): string => {
    const params = new URLSearchParams(window.location.search);
    const proxyServer = params.get('proxyServer');
    if (proxyServer) {
        return `${proxyServer.replace(/\/$/, '')}/api/proxy?url=`;
    }
    const proxyPort = params.get('proxyPort') || '3001';
    return `http://localhost:${proxyPort}/api/proxy?url=`;
};

/**
 * 将 CDN URL 转换为代理 URL（如果需要）
 * - 本地开发：`scripts/proxy-server.js` 的 `/api/proxy?url=<encoded>`
 * - 生产环境：同域名 `/proxy/cdn/`（nginx rewrite）
 */
const getProxiedUrl = (url: string): string => {
    if (url.includes('unicity-cdn.bdnrc.org.cn')) {
        try {
            const urlObj = new URL(url);
            if (isLocalDevelopment()) {
                return `${getLocalDevProxyBase()}${encodeURIComponent(url)}`;
            }
            return `/proxy/cdn${urlObj.pathname}${urlObj.search}`;
        } catch (e) {
            console.warn('[SuperSplat] URL 解析失败，使用原始 URL:', e);
            return url;
        }
    }
    return url;
};

const loadSkybox = async (app: AppBase, url: string): Promise<Asset> => {
    // 将 URL 转换为代理 URL（如果需要）
    const proxiedUrl = getProxiedUrl(url);
    
    // 确保设置 crossOrigin 以支持跨域图片加载
    const textureHandler = app.loader.getHandler('texture') as TextureHandler;
    if (textureHandler && textureHandler.imgParser) {
        textureHandler.imgParser.crossOrigin = 'anonymous';
    }

    return await loadSkyboxDirect(app, proxiedUrl);
};

/**
 * 直接加载天空盒（不使用代理）
 */
const loadSkyboxDirect = (app: AppBase, url: string): Promise<Asset> => {
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
            console.error('[SuperSplat] 天空盒加载失败:', err);
            reject(err);
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
};

/** 清除 cubemap / sphere 天空盒显示，并恢复独立纯色 envAtlas */
const clearSkyboxDisplay = (app: AppBase) => {
    removeSkyboxSphere(app);
    app.scene.skybox = null;
    app.scene.envAtlas = getOrCreateSolidEnvAtlas(app);
    app.renderNextFrame = true;
};

/**
 * 获取天空盒的实际半径
 * 如果存在天空盒实体，返回其实际半径；否则返回 0
 */
const getSkyboxRadius = (app: AppBase, url?: string): number => {
    if (url) {
        const trimmedUrl = url.trim();
        const entity = skyboxEntityCache.get(trimmedUrl);
        if (entity) {
            // sphere 的默认半径是 0.5，所以实际半径 = localScale.x * 0.5
            // 但由于我们设置的是完整的半径值，所以直接使用 localScale.x
            const scale = entity.getLocalScale();
            return Math.abs(scale.x); // 使用绝对值，确保是正数
        }
    } else {
        // 如果没有指定 URL，返回第一个天空盒的半径
        for (const entity of skyboxEntityCache.values()) {
            const scale = entity.getLocalScale();
            return Math.abs(scale.x);
        }
    }
    return 0;
};

export { applySkyboxSphere, removeSkyboxSphere, applySkyboxTexture, clearSkyboxDisplay, getSkyboxRadius };