import { Texture, Entity, Vec3, AppBase, StandardMaterial, CULLFACE_NONE, Asset, BoundingBox, Color } from "playcanvas";

const skyboxTextureCache = new Map<string, Texture>();
const skyboxEntityCache = new Map<string, Entity>();

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

export { applySkyboxSphere, removeSkyboxSphere, applySkyboxTexture, getSkyboxRadius };