import { Color, Entity, Vec3, StandardMaterial, TEXTUREPROJECTION_CUBE } from 'playcanvas';
import type { Global } from './types';
import type { DirectionalLightConfig, SpotLightConfig } from './schemas/v2';

const MAX_POINT_LIGHTS = 10;
const MAX_SPOT_LIGHTS = 10;

const isDirectionalLightConfig = (cfg: any): cfg is DirectionalLightConfig =>
    cfg && cfg.type === 'directional';

const isSpotLightConfig = (cfg: any): cfg is SpotLightConfig =>
    cfg && cfg.type === 'spot';

/** 点光源在场景中的可视化球体默认半径（世界单位） */
const LIGHT_VISUAL_RADIUS = 0.25;

/** 平行光实体默认位置（用于主方向光） */
const DIRECTIONAL_DEFAULT_POSITION: [number, number, number] = [0, 8, 8];

/** 聚光灯锥体可视化缩放（放大以便在大场景中易见） */
const SPOT_VISUAL_SCALE = 1.2;

export type PointLightInfo = {
    position: Vec3;
    color: Color;
    intensity: number;
};

export type SpotLightInfo = {
    position: Vec3;
    direction: Vec3;  // 归一化，照射方向（实体 forward = -Z）
    color: Color;
    intensity: number;
    innerConeAngle: number;  // 弧度
    outerConeAngle: number;  // 弧度
    range: number;
};

/**
 * 从场景中收集点光源信息（Light 组件 type === 'point'），上限 10 个。
 * 无额外点光源时返回空数组。
 */
const collectPointLights = (global: Global): PointLightInfo[] => {
    const { app } = global;
    const result: PointLightInfo[] = [];
    const visit = (e: Entity) => {
        if (result.length >= MAX_POINT_LIGHTS) return;
        if (e.light && (e.light as any).type === 'point' && e.light.enabled) {
            const pos = e.getPosition();
            result.push({
                position: new Vec3(pos.x, pos.y, pos.z),
                color: new Color(e.light.color.r, e.light.color.g, e.light.color.b),
                intensity: e.light.intensity ?? 1
            });
        }
        e.children.forEach(visit);
    };
    app.root.children.forEach(visit);
    return result;
};

/**
 * 从场景中收集聚光灯信息（spotLights 容器下 type === 'spot' 的实体），上限 10 个。
 * 供 night-mode 等 shader 对高斯施加聚光照明。
 */
const collectSpotLights = (global: Global): SpotLightInfo[] => {
    const { app } = global;
    const result: SpotLightInfo[] = [];
    const container = app.root.findByName('spotLights') as Entity | null;
    if (!container) return result;
    const zAxis = new Vec3();
    for (let i = 0; i < container.children.length && result.length < MAX_SPOT_LIGHTS; i++) {
        const e = container.children[i] as Entity;
        if (!e.name.startsWith('spotLight_') || e.name === 'spotLight_visual') continue;
        if (!e.light || (e.light as any).type !== 'spot' || !e.light.enabled) continue;
        const position = e.getPosition().clone();
        e.getWorldTransform().getZ(zAxis);
        const direction = new Vec3(-zAxis.x, -zAxis.y, -zAxis.z).normalize();
        let innerRad = ((e.light as any).innerConeAngle ?? 25) * (Math.PI / 180);
        let outerRad = ((e.light as any).outerConeAngle ?? 45) * (Math.PI / 180);
        if (innerRad > outerRad) {
            [innerRad, outerRad] = [outerRad, innerRad];
        }
        const range = (e.light as any).range ?? 10;
        result.push({
            position,
            direction,
            color: new Color(e.light.color.r, e.light.color.g, e.light.color.b),
            intensity: e.light.intensity ?? 1,
            innerConeAngle: innerRad,
            outerConeAngle: outerRad,
            range
        });
    }
    return result;
};

/**
 * 为点光源实体添加场景内可视化小球（子实体，与光同色）
 * 使用 diffuse 为主、低 emissive，避免小球本身照亮场景导致“整屏变亮”。
 * @param app - 应用实例（创建时实体可能尚未挂到场景，需显式传入）
 */
const addLightVisual = (app: Global['app'], lightEntity: Entity, r: number, g: number, b: number): void => {
    const mat = new StandardMaterial();
    mat.diffuse.set(r, g, b);
    mat.emissive.set(r, g, b);
    mat.emissiveIntensity = 0.12;
    mat.update();
    const visual = new Entity('pointLight_visual');
    visual.addComponent('render', {
        type: 'sphere',
        material: mat
    });
    const scale = LIGHT_VISUAL_RADIUS * 2;
    visual.setLocalScale(scale, scale, scale);
    const rc = visual.render;
    if (rc) {
        rc.castShadows = false;
        rc.receiveShadows = false;
        rc.enabled = !!(app as any).__pointLightsVisualVisible;
    }
    lightEntity.addChild(visual);
    (lightEntity as any).__lightVisualMaterial = mat;
    (lightEntity as any).__lightVisualEntity = visual;
};

/**
 * 更新点光源实体的可视化小球颜色
 */
const updateLightVisual = (lightEntity: Entity, r: number, g: number, b: number): void => {
    const mat = (lightEntity as any).__lightVisualMaterial as StandardMaterial | undefined;
    if (mat) {
        mat.diffuse.set(r, g, b);
        mat.emissive.set(r, g, b);
        mat.update();
    }
};

/**
 * 为聚光灯实体添加锥体可视化。锥尖指向照射方向（实体 -Z = forward），
 * 与「Show lights in scene」联动。锥体几何与 inner/outer 角无关，仅表示方向。
 */
const addSpotLightVisual = (app: Global['app'], spotEntity: Entity, r: number, g: number, b: number): void => {
    let visual = spotEntity.findByName('spotLight_visual') as Entity | null;
    if (visual) return;
    const mat = new StandardMaterial();
    mat.diffuse.set(r, g, b);
    mat.emissive.set(r, g, b);
    mat.emissiveIntensity = 0.15;
    mat.update();
    visual = new Entity('spotLight_visual');
    visual.addComponent('render', { type: 'cone', material: mat });
    const rc = visual.render;
    if (rc) {
        rc.castShadows = false;
        rc.receiveShadows = false;
        rc.enabled = !!(app as any).__pointLightsVisualVisible;
    }
    visual.setLocalPosition(0, 0, -SPOT_VISUAL_SCALE);
    visual.setLocalEulerAngles(-90, 0, 0);
    visual.setLocalScale(SPOT_VISUAL_SCALE, SPOT_VISUAL_SCALE, SPOT_VISUAL_SCALE * 2);
    spotEntity.addChild(visual);
    (spotEntity as any).__spotVisualMaterial = mat;
    (spotEntity as any).__spotVisualEntity = visual;
};

const updateSpotLightVisual = (spotEntity: Entity, r: number, g: number, b: number): void => {
    const mat = (spotEntity as any).__spotVisualMaterial as StandardMaterial | undefined;
    if (mat) {
        mat.diffuse.set(r, g, b);
        mat.emissive.set(r, g, b);
        mat.update();
    }
};

/**
 * 从 settings.lighting.lights 应用平行光到主方向光实体（name='light'）。
 * 若有 type==='directional' 的项则用其配置；否则用默认值。
 */
const applyDirectionalLightFromSettings = (global: Global): void => {
    const { app, settings } = global;
    const configs = settings.lighting?.lights;
    let cfg = configs && Array.isArray(configs) ? configs.find(isDirectionalLightConfig) : undefined;
    const shadow = (settings as any).postEffectSettings?.shadow;
    if (!cfg && shadow && (typeof shadow.lightPitch === 'number' || typeof shadow.lightYaw === 'number')) {
        cfg = {
            type: 'directional',
            position: DIRECTIONAL_DEFAULT_POSITION,
            color: [1, 1, 1],
            intensity: 1.5,
            pitch: typeof shadow.lightPitch === 'number' ? shadow.lightPitch : 35,
            yaw: typeof shadow.lightYaw === 'number' ? shadow.lightYaw : 45,
            shadowBias: typeof shadow.shadowBias === 'number' ? shadow.shadowBias : 0.05,
            castShadows: true,
            enabled: true
        };
    }

    let lightEntity = app.root.findByName('light') as Entity | null;
    if (!lightEntity) {
        lightEntity = new Entity('light');
        lightEntity.addComponent('light', {
            type: 'directional',
            color: new Color(1, 1, 1),
            intensity: 1.5,
            castShadows: true,
            shadowBias: 0.05,
            normalOffsetBias: 0.05
        });
        lightEntity.tags.add('light');
        app.root.addChild(lightEntity);
    }
    if (!lightEntity.light) {
        lightEntity.addComponent('light', {
            type: 'directional',
            color: new Color(1, 1, 1),
            intensity: 1.5,
            castShadows: true,
            shadowBias: 0.05,
            normalOffsetBias: 0.05
        });
    }

    const pitch = cfg?.pitch ?? 35;
    const yaw = cfg?.yaw ?? 45;
    const pos = cfg?.position ?? DIRECTIONAL_DEFAULT_POSITION;
    const [r, g, b] = cfg?.color ?? [1, 1, 1];
    const intensity = typeof cfg?.intensity === 'number' ? cfg.intensity : 1.5;
    const castShadows = cfg?.castShadows !== false;
    const shadowBias = typeof cfg?.shadowBias === 'number' ? cfg.shadowBias : 0.05;
    const enabled = cfg?.enabled !== false;

    lightEntity.setPosition(pos[0], pos[1], pos[2]);
    lightEntity.setEulerAngles(pitch, yaw, 0);
    if (lightEntity.light) {
        lightEntity.light.enabled = enabled;
        lightEntity.light.color.set(r, g, b);
        lightEntity.light.intensity = intensity;
        lightEntity.light.castShadows = castShadows;
        lightEntity.light.shadowBias = shadowBias;
        lightEntity.light.shadowDistance = lightEntity.light.shadowDistance ?? 200;
        lightEntity.light.shadowResolution = lightEntity.light.shadowResolution ?? 2048;
    }
};


/**
 * 根据 settings.lighting 创建聚光灯实体（type==='spot'），最多 MAX_SPOT_LIGHTS 个
 */
const createSpotLightsFromSettings = (global: Global): void => {
    const { app, settings } = global;
    const configs = settings.lighting?.lights;
    if (!configs || !Array.isArray(configs)) return;

    const spotConfigs = configs.filter((c: any) => isSpotLightConfig(c)).slice(0, MAX_SPOT_LIGHTS);
    if (spotConfigs.length === 0) return;

    let container = app.root.findByName('spotLights') as Entity | null;
    if (!container) {
        container = new Entity('spotLights');
        app.root.addChild(container);
    }

    spotConfigs.forEach((cfg: SpotLightConfig, i: number) => {
        const [x, y, z] = cfg.position ?? [0, 2, 0];
        const [r, g, b] = cfg.color ?? [1, 1, 1];
        const intensity = typeof cfg.intensity === 'number' ? cfg.intensity : 1;
        const pitch = cfg.pitch ?? -45;
        const yaw = cfg.yaw ?? 0;
        const innerCone = cfg.innerConeAngle ?? 25;
        const outerCone = cfg.outerConeAngle ?? 45;
        const range = typeof cfg.range === 'number' ? cfg.range : 10;
        const enabled = cfg.enabled !== false;

        let entity = container!.findByName(`spotLight_${i}`) as Entity | undefined;
        if (!entity) {
            entity = new Entity(`spotLight_${i}`);
            entity.addComponent('light', {
                type: 'spot',
                color: new Color(r, g, b),
                intensity,
                innerConeAngle: innerCone,
                outerConeAngle: outerCone,
                range,
                castShadows: false
            });
            entity.tags.add('spotLight');
            addSpotLightVisual(app, entity, r, g, b);
            container!.addChild(entity);
        }
        entity.setPosition(x, y, z);
        entity.setEulerAngles(pitch, yaw, 0);
        if (entity.light) {
            entity.light.enabled = enabled;
            entity.light.color.set(r, g, b);
            entity.light.intensity = intensity;
            entity.light.castShadows = false;
            (entity.light as any).innerConeAngle = innerCone;
            (entity.light as any).outerConeAngle = outerCone;
            (entity.light as any).range = range;
        }
        updateSpotLightVisual(entity, r, g, b);
    });

    const existing = container!.children.filter(c => c.name.startsWith('spotLight_'));
    existing.forEach((child, i) => {
        if (i >= spotConfigs.length) container!.removeChild(child);
    });
};

/**
 * 根据 settings.lighting 创建点光源实体（仅处理无 type 或 type 非 directional/spot 的项），最多 10 个
 */
const createPointLightsFromSettings = (global: Global): void => {
    const { app, settings } = global;
    const configs = settings.lighting?.lights;
    if (!configs || !Array.isArray(configs)) return;

    const pointConfigs = configs.filter((c: any) => !isDirectionalLightConfig(c) && !isSpotLightConfig(c)).slice(0, MAX_POINT_LIGHTS);
    if (pointConfigs.length === 0) return;

    let container = app.root.findByName('pointLights') as Entity | null;
    if (!container) {
        container = new Entity('pointLights');
        app.root.addChild(container);
    }

    pointConfigs.forEach((cfg: any, i: number) => {
        const [x, y, z] = cfg.position ?? [0, 0, 0];
        const [r, g, b] = cfg.color ?? [1, 1, 1];
        const intensity = typeof cfg.intensity === 'number' ? cfg.intensity : 1;
        const enabled = cfg.enabled !== false;

        let entity = container!.findByName(`pointLight_${i}`) as Entity | undefined;
        if (!entity) {
            entity = new Entity(`pointLight_${i}`);
            entity.addComponent('light', {
                type: 'point',
                color: new Color(r, g, b),
                intensity,
                castShadows: false
            });
            entity.tags.add('pointLight');
            addLightVisual(app, entity, r, g, b);
            container!.addChild(entity);
        }
        entity.setPosition(x, y, z);
        if (entity.light) {
            entity.light.enabled = enabled;
            entity.light.color.set(r, g, b);
            entity.light.intensity = intensity;
            entity.light.castShadows = false;
        }
        updateLightVisual(entity, r, g, b);
    });

    const existing = container!.children.filter(c => c.name.startsWith('pointLight_'));
    existing.forEach((child, i) => {
        if (i >= pointConfigs.length) container!.removeChild(child);
    });
};

/**
 * 设置场景中点光源、平行光、聚光灯可视化的显示/隐藏。与「Show lights in scene」联动。
 */
const setPointLightsVisualVisible = (global: Global, visible: boolean): void => {
    const { app } = global;
    (app as any).__pointLightsVisualVisible = visible;
    const pointContainer = app.root.findByName('pointLights') as Entity | null;
    if (pointContainer) {
        pointContainer.children.forEach((node) => {
            const entity = node as Entity;
            if (!entity.name.startsWith('pointLight_') || entity.name === 'pointLight_visual') return;
            const visual = (entity as any).__lightVisualEntity as Entity | undefined;
            if (visual?.render) visual.render.enabled = visible;
        });
    }
    const spotContainer = app.root.findByName('spotLights') as Entity | null;
    if (spotContainer) {
        spotContainer.children.forEach((node) => {
            const entity = node as Entity;
            if (!entity.name.startsWith('spotLight_') || entity.name === 'spotLight_visual') return;
            const visual = (entity as any).__spotVisualEntity as Entity | undefined;
            if (visual?.render) visual.render.enabled = visible;
        });
    }
};

/**
 * 根据当前 settings.lighting 重新应用平行光并创建/更新点光源实体（供运行时 UI 修改配置后调用）
 */
const updatePointLightsFromSettings = (global: Global): void => {
    const { app } = global;
    applyDirectionalLightFromSettings(global);
    const configs = global.settings.lighting?.lights;
    if (!configs || !Array.isArray(configs)) {
        const c1 = app.root.findByName('pointLights') as Entity | null;
        const c2 = app.root.findByName('spotLights') as Entity | null;
        if (c1) app.root.removeChild(c1);
        if (c2) app.root.removeChild(c2);
        return;
    }
    const hasPoint = configs.some((c: any) => !isDirectionalLightConfig(c) && !isSpotLightConfig(c));
    const hasSpot = configs.some((c: any) => isSpotLightConfig(c));
    if (!hasPoint) {
        const c = app.root.findByName('pointLights') as Entity | null;
        if (c) app.root.removeChild(c);
    } else {
        createPointLightsFromSettings(global);
    }
    if (!hasSpot) {
        const c = app.root.findByName('spotLights') as Entity | null;
        if (c) app.root.removeChild(c);
    } else {
        createSpotLightsFromSettings(global);
    }
};

/**
 * 初始化场景光照
 * - 主方向光（平行光）由 settings.lighting.lights 中 type==='directional' 的项驱动，若无则用默认
 * - 点光源由 settings.lighting.lights 中非 directional 的项创建，最多 10 个
 */
const initLight = (global: Global): Entity => {
    applyDirectionalLightFromSettings(global);
    const lightEntity = global.app.root.findByName('light') as Entity;
    if (lightEntity?.light) {
        lightEntity.light.shadowDistance = lightEntity.light.shadowDistance ?? 200;
        lightEntity.light.shadowResolution = lightEntity.light.shadowResolution ?? 2048;
    }
    createPointLightsFromSettings(global);
    createSpotLightsFromSettings(global);
    return lightEntity;
};

/**
 * 根据场景包围盒大小动态设置方向光的 shadowDistance。
 * 应在场景加载后、获得 sceneBound 时调用。
 */
const updateShadowDistance = (global: Global, sceneSize: number): void => {
    const lightEntity = global.app.root.findByName('light') as Entity | null;
    if (lightEntity?.light) {
        // shadowDistance 设为场景对角线长度的 1.5 倍，确保覆盖整个场景
        const dist = Math.max(200, sceneSize * 1.5);
        lightEntity.light.shadowDistance = dist;
        console.log(`[Light] shadowDistance updated to ${dist.toFixed(1)} (sceneSize=${sceneSize.toFixed(1)})`);
    }
};

export { initLight, collectPointLights, collectSpotLights, updatePointLightsFromSettings, setPointLightsVisualVisible, updateShadowDistance };
