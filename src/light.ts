import { Color, Entity, Vec3, StandardMaterial } from 'playcanvas';
import type { Global } from './types';

const MAX_POINT_LIGHTS = 10;

/** 点光源在场景中的可视化球体默认半径（世界单位） */
const LIGHT_VISUAL_RADIUS = 0.25;

export type PointLightInfo = {
    position: Vec3;
    color: Color;
    intensity: number;
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
 * 根据 settings.lighting 创建点光源实体（Light 组件 type='point'），最多 10 个
 */
const createPointLightsFromSettings = (global: Global): void => {
    const { app, settings } = global;
    const configs = settings.lighting?.lights;
    if (!configs || !Array.isArray(configs) || configs.length === 0) return;

    let container = app.root.findByName('pointLights') as Entity | null;
    if (!container) {
        container = new Entity('pointLights');
        app.root.addChild(container);
    }

    const toCreate = configs.slice(0, MAX_POINT_LIGHTS);
    toCreate.forEach((cfg, i) => {
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
            // 场景内可视化：在光源位置显示一个与光同色的小球
            addLightVisual(app, entity, r, g, b);
            container!.addChild(entity);
        }
        entity.setPosition(x, y, z);
        if (entity.light) {
            entity.light.enabled = enabled;
            entity.light.color.set(r, g, b);
            entity.light.intensity = intensity;
        }
        updateLightVisual(entity, r, g, b);
    });

    // 移除多余的子实体（若配置数量减少）
    const existing = container!.children.filter(c => c.name.startsWith('pointLight_'));
    existing.forEach((child, i) => {
        if (i >= toCreate.length) container!.removeChild(child);
    });
};

/**
 * 设置场景中点光源可视化小球（彩色球体）的显示/隐藏。
 * 仅切换可视化 mesh，不改变点光源光照。工具栏通过此接口与「可视化光源」开关联动。
 */
const setPointLightsVisualVisible = (global: Global, visible: boolean): void => {
    const { app } = global;
    (app as any).__pointLightsVisualVisible = visible;
    const container = app.root.findByName('pointLights') as Entity | null;
    if (!container) return;
    container.children.forEach((node) => {
        const entity = node as Entity;
        if (!entity.name.startsWith('pointLight_') || entity.name === 'pointLight_visual') return;
        const visual = (entity as any).__lightVisualEntity as Entity | undefined;
        if (visual?.render) visual.render.enabled = visible;
    });
};

/**
 * 根据当前 settings.lighting 重新创建/更新点光源实体（供运行时 UI 修改配置后调用）
 */
const updatePointLightsFromSettings = (global: Global): void => {
    const { app } = global;
    const configs = global.settings.lighting?.lights;
    if (!configs || !Array.isArray(configs) || configs.length === 0) {
        const container = app.root.findByName('pointLights') as Entity | null;
        if (container) {
            app.root.removeChild(container);
        }
        return;
    }
    createPointLightsFromSettings(global);
};

/**
 * 初始化场景光照
 * - 创建主方向光（directional）
 * - 根据 settings.lighting 创建点光源实体（point），最多 10 个
 *
 * @param global - 全局对象，包含 app、settings 等
 * @returns 主方向光实体
 */
const initLight = (global: Global): Entity => {
    const { app } = global;

    let lightEntity = app.root.findByName('light') as Entity | null;

    if (!lightEntity) {
        lightEntity = new Entity('light');
        lightEntity.setEulerAngles(35, 45, 0);
        lightEntity.addComponent('light', {
            type: 'directional',
            color: new Color(1, 1, 1),
            intensity: 1.5,
            castShadows: false,
            shadowBias: 0.05,
            normalOffsetBias: 0.05
        });
        app.root.addChild(lightEntity);
    } else {
        if (!lightEntity.light) {
            lightEntity.addComponent('light', {
                type: 'directional',
                color: new Color(1, 1, 1),
                intensity: 1.5,
                castShadows: false,
                shadowBias: 0.05,
                normalOffsetBias: 0.05
            });
        }
    }

    lightEntity.tags.add('light');

    createPointLightsFromSettings(global);

    return lightEntity;
};

export { initLight, collectPointLights, updatePointLightsFromSettings, setPointLightsVisualVisible };
