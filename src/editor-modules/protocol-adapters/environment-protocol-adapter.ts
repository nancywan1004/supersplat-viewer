/**
 * 环境模块协议映射：LIGHT_* / BLOOM_* / SHADOW_* 及局部亮灯笔刷联动的 settings 写入与事件派发。
 * 由 EnvironmentFacade 调用；其它模块如需相同语义可直接 import 本文件。
 */

import { getPositionInFrontOfCamera } from '../../asset-placement-handler';
import { updatePointLightsFromSettings } from '../../light';
import type { ExperienceSettings } from '../../schemas/v2';
import {
    ensureBloom,
    ensureBloomEditorSession,
    ensureLighting,
    ensureNightMode,
    ensureShadow,
    type LightWithId
} from '../../settings-serialize/settings-serialize-helper';
import type { Global } from '../../types';

function isUserControllableLight(light: LightWithId): boolean {
    const anyLight = light as any;
    const type = anyLight.type as string | undefined;
    return type === 'point' || type === 'spot' || type === undefined;
}

/** LIGHT_GLOBAL_SET：写 nightMode.fade，并触发 nightFade:set */
export function applyLightGlobalSet(global: Global, value: number): void {
    const settings = global.settings as ExperienceSettings;
    const v = Math.max(-1, Math.min(1, value));
    const nm = ensureNightMode(settings);
    nm.fade = v;
    (global.app as { fire: (name: string, value?: unknown) => void }).fire('nightFade:set', v);
}

/** LIGHT_ADD：isThreeSixty=true 创建点光；false 创建聚光灯（带 id），优先在草稿区域中心生成 */
export function applyLightAdd(global: Global, id: string, isThreeSixty = true): void {
    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    const bloom = ensureBloom(settings);
    const bloomSes = ensureBloomEditorSession(settings);
    const center = bloomSes.draftLightRegionCenter ?? null;
    const camPos = getPositionInFrontOfCamera(global);
    const position: [number, number, number] = center
        ? [center[0], center[1], center[2]]
        : [camPos.x, camPos.y, camPos.z];
    if (isThreeSixty) {
        lighting.lights.push({
            id,
            type: 'point',
            position,
            color: [1, 1, 1],
            intensity: 1,
            range: 10,
            enabled: true
        } as LightWithId);
    } else {
        lighting.lights.push({
            id,
            type: 'spot',
            position,
            color: [1, 1, 1],
            intensity: 1,
            range: 10,
            innerConeAngle: 25,
            outerConeAngle: 45,
            enabled: true
        } as LightWithId);
    }
    if (bloomSes.activeLocalLightRegionId && Array.isArray(bloom.localLightRegions)) {
        const region = bloom.localLightRegions.find((r) => r && r.id === bloomSes.activeLocalLightRegionId);
        if (region) {
            (region as any).linkedLightId = id;
        }
    }
    bloomSes.draftLightRegionCenter = null;
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
    global.events.fire('postEffect:changed');
}

/** LIGHT_SELECT：仅更新内部选中光源 id（可选，供 UI 使用），并派发 sceneLight:selected 事件 */
export function applyLightSelect(global: Global, id: string | null, source: 'host' | 'scene' | 'unknown' = 'unknown'): void {
    (global.state as Record<string, unknown>).selectedLightId = id;
    global.events.fire('sceneLight:selected', { id, source });
}

/**
 * LIGHT_TRANSFORM_MODE：切换环境模块下光源 Gizmo。
 * 协议约定：点光源仅 `move` | null；聚光灯 `move` | `rotate` | null。
 * 对点光下发 `rotate` 时按协议忽略并关闭 Gizmo。
 */
export function applyLightTransformMode(
    global: Global,
    value: 'move' | 'rotate' | null | undefined
): void {
    const { state, settings, events } = global;
    if (value !== 'move' && value !== 'rotate') {
        state.lightTransformMode = null;
        events.fire('lightTransformMode:changed', null);
        return;
    }
    const id = state.selectedLightId;
    const lighting = ensureLighting(settings);
    const cfg = id ? lighting.lights.find((l) => (l as LightWithId).id === id) : undefined;
    if (value === 'rotate' && (cfg as { type?: string } | undefined)?.type !== 'spot') {
        state.lightTransformMode = null;
        events.fire('lightTransformMode:changed', null);
        return;
    }
    state.lightTransformMode = value;
    events.fire('lightTransformMode:changed', value);
}

/** LIGHT_INTENSITY_UPDATE / LIGHT_COLOR_UPDATE / LIGHT_INNER_ANGLE_SET / LIGHT_OUTER_ANGLE_SET / LIGHT_RANGE_SET（点光与聚光，0–20；忽略 directional） */
export function applyLightDetail(
    global: Global,
    type: string,
    payload: { id?: string; value?: number | number[] | boolean }
): void {
    const settings = global.settings as ExperienceSettings;
    const lighting = settings.lighting;
    if (!lighting?.lights || !Array.isArray(lighting.lights)) return;
    const id = payload.id;
    if (id == null) return;
    const light = lighting.lights.find((l: LightWithId) => (l as LightWithId).id === id) as LightWithId | undefined;
    if (!light) return;

    let changed = false;
    switch (type) {
    case 'LIGHT_INTENSITY_UPDATE':
        if (typeof payload.value === 'number') {
            light.intensity = payload.value;
            changed = true;
        }
        break;
    case 'LIGHT_COLOR_UPDATE':
        if (Array.isArray(payload.value) && payload.value.length >= 3) {
            light.color = [payload.value[0], payload.value[1], payload.value[2]];
            changed = true;
        }
        break;
    case 'LIGHT_INNER_ANGLE_SET':
        if (typeof payload.value === 'number') {
            const v = Math.max(0, Math.min(180, payload.value));
            (light as Record<string, unknown>).innerConeAngle = v;
            changed = true;
        }
        break;
    case 'LIGHT_OUTER_ANGLE_SET':
        if (typeof payload.value === 'number') {
            const v = Math.max(0, Math.min(180, payload.value));
            (light as Record<string, unknown>).outerConeAngle = v;
            changed = true;
        }
        break;
    case 'LIGHT_RANGE_SET':
        if ((light as { type?: string }).type === 'directional') break;
        if (typeof payload.value === 'number') {
            (light as Record<string, unknown>).range = Math.max(0, Math.min(20, payload.value));
            changed = true;
        }
        break;
    default:
        return;
    }
    if (!changed) return;
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
    global.events.fire('postEffect:changed');
}

/** LIGHT_DELETE：从 settings 移除光源并重建场景灯实体（不可删 directional） */
export function applyLightDelete(global: Global, id: string): void {
    if (!id) return;
    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    const lightsAny = lighting.lights as any[];
    const idx = lightsAny.findIndex((l) => l && l.id === id);
    if (idx < 0) return;
    const target = lightsAny[idx];
    if (target?.type === 'directional') return;
    lightsAny.splice(idx, 1);
    if (global.state.selectedLightId === id) {
        global.state.selectedLightId = null;
        global.events.fire('sceneLight:selected', { id: null, source: 'host' });
    }
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
    global.events.fire('postEffect:changed');
}

/** LIGHT_TOGGLE_ALL：仅对用户添加的点光源/聚光灯生效，排除场景默认平行光 */
export function applyLightToggleAll(global: Global, enabled: boolean): void {
    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    let changed = false;
    for (const l of lighting.lights) {
        if (!isUserControllableLight(l)) continue;
        const anyLight = l as any;
        if (anyLight.enabled !== enabled) {
            anyLight.enabled = enabled;
            changed = true;
        }
    }
    const bloom = ensureBloom(settings) as any;
    bloom.localLightsEnabled = enabled;
    const app = global.app as { fire: (name: string, value?: unknown) => void };
    // Viewer 模式：全关时全局亮度仅运行时压到 0（不改 global.settings.nightMode.fade，配置真源仍在 settings）
    // 全开时用 ensureNightMode(settings).fade 恢复，与 LIGHT_GLOBAL_SET 写入的 settings 一致，无需额外备份字段
    if (!global.state.editMode) {
        const nm = ensureNightMode(settings);
        if (!enabled) {
            app.fire('nightFade:set', 0);
        } else {
            const raw = typeof nm.fade === 'number' ? nm.fade : 0;
            const v = Math.max(-1, Math.min(1, raw));
            app.fire('nightFade:set', v);
        }
    }

    if (changed) {
        updatePointLightsFromSettings(global);
        global.events.fire('lighting:changed');
    }
    global.events.fire('postEffect:changed');
}

/** LIGHT_TOGGLE：按 id 开关某一盏用户光源；若为平行光则忽略 */
export function applyLightToggle(global: Global, id: string, enabled: boolean): void {
    if (!id) return;
    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    const light = lighting.lights.find((l) => (l as LightWithId).id === id) as LightWithId | undefined;
    if (!light || !isUserControllableLight(light)) return;

    const anyLight = light as any;
    if (anyLight.enabled === enabled) return;
    anyLight.enabled = enabled;
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
    global.events.fire('postEffect:changed');
}

/** BLOOM_INTENSITY_UPDATE（协议值 0–16 与内部 0–0.2 均可支持：若 > 1 则视为 0–16 并归一化到 0–0.2）。 */
export function applyBloomIntensityUpdate(global: Global, value: number): void {
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    const clamped = value > 1
        ? Math.max(0, Math.min(16, value)) / 80
        : Math.max(0, Math.min(1, value));
    const intensity = Math.min(0.2, Math.max(0, clamped));
    (b as Record<string, unknown>).intensity = intensity;
    (b as Record<string, unknown>).enabled = intensity > 0;
    global.events.fire('postEffect:changed');
}

/** BLOOM_THRESHOLD_UPDATE */
export function applyBloomThresholdUpdate(global: Global, value: number): void {
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    (b as Record<string, unknown>).threshold = value;
    global.events.fire('postEffect:changed');
}

/** BLOOM_IS_LOCAL_SET：true=仅局部亮灯区域（bloomScope='local'），false=全局 Bloom（bloomScope='global'） */
export function applyBloomIsLocalSet(global: Global, value: boolean): void {
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings) as Record<string, unknown>;
    b.bloomScope = value ? 'local' : 'global';
    global.events.fire('postEffect:changed');
}

/** LIGHT_BRUSH_INTENSITY_UPDATE：根据亮灯区域 id，更新其绑定光源的 intensity（0-10） */
export function applyBloomLocalLightRegionIntensityUpdate(global: Global, regionId: string, value: number): void {
    if (!regionId) return;
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    const regions = (b as any).localLightRegions as any[] | undefined;
    if (!Array.isArray(regions)) return;
    const region = regions.find((r) => r && r.id === regionId);
    if (!region || !region.linkedLightId) return;
    const lighting = ensureLighting(settings);
    const light = (lighting.lights as any[]).find((l) => l && (l as any).id === region.linkedLightId);
    if (!light) return;
    const clamped = Math.max(0, Math.min(10, value));
    (light as any).intensity = clamped;
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
}

/** LIGHT_BRUSH_INNER_ANGLE_SET：根据亮灯区域 id，更新其绑定聚光灯的 innerConeAngle（0-180） */
export function applyBloomLocalLightRegionInnerAngleSet(global: Global, regionId: string, value: number): void {
    if (!regionId) return;
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    const regions = (b as any).localLightRegions as any[] | undefined;
    if (!Array.isArray(regions)) return;
    const region = regions.find((r) => r && r.id === regionId);
    if (!region || !region.linkedLightId) return;
    const lighting = ensureLighting(settings);
    const light = (lighting.lights as any[]).find((l) => l && (l as any).id === region.linkedLightId && (l as any).type === 'spot');
    if (!light) return;
    const clamped = Math.max(0, Math.min(180, value));
    (light as any).innerConeAngle = clamped;
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
}

/** LIGHT_BRUSH_OUTER_ANGLE_SET：根据亮灯区域 id，更新其绑定聚光灯的 outerConeAngle（0-180） */
export function applyBloomLocalLightRegionOuterAngleSet(global: Global, regionId: string, value: number): void {
    if (!regionId) return;
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    const regions = (b as any).localLightRegions as any[] | undefined;
    if (!Array.isArray(regions)) return;
    const region = regions.find((r) => r && r.id === regionId);
    if (!region || !region.linkedLightId) return;
    const lighting = ensureLighting(settings);
    const light = (lighting.lights as any[]).find((l) => l && (l as any).id === region.linkedLightId && (l as any).type === 'spot');
    if (!light) return;
    const clamped = Math.max(0, Math.min(180, value));
    (light as any).outerConeAngle = clamped;
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
}

/** LIGHT_BRUSH_RANGE_SET：根据亮灯区域 id，更新其绑定聚光灯的 range（0-20） */
export function applyBloomLocalLightRegionRangeSet(global: Global, regionId: string, value: number): void {
    if (!regionId) return;
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    const regions = (b as any).localLightRegions as any[] | undefined;
    if (!Array.isArray(regions)) return;
    const region = regions.find((r) => r && r.id === regionId);
    if (!region || !region.linkedLightId) return;
    const lighting = ensureLighting(settings);
    const light = (lighting.lights as any[]).find((l) => l && (l as any).id === region.linkedLightId && (l as any).type === 'spot');
    if (!light) return;
    const clamped = Math.max(0, Math.min(20, value));
    (light as any).range = clamped;
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
}

/** BLOOM_BLUR_SET（0-10；0 关辉光，1-10 设模糊级别并开辉光） */
export function applyBloomBlurSet(global: Global, value: number): void {
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    const clamped = Math.max(0, Math.min(10, Math.round(value)));
    (b as Record<string, unknown>).blurLevel = clamped;
    (b as Record<string, unknown>).enabled = clamped > 0 && Number(b.intensity) > 0;
    global.events.fire('postEffect:changed');
}

/** LIGHT_BRUSH_DELETE：按 id 删除局部亮灯区域（LIGHT_BRUSH_FINISH 生成的带 id 区域） */
export function applyBloomLocalLightRegionDelete(global: Global, regionId: string): void {
    if (!regionId) return;
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    if (!Array.isArray(b.localLightRegions)) return;
    const list = b.localLightRegions as any[];
    let linkedLightId: string | null = null;
    const remaining = list.filter((r) => {
        if (r && r.id === regionId) {
            linkedLightId = (r as any).linkedLightId ?? null;
            return false;
        }
        return !!r;
    });
    if (remaining.length === list.length) return;
    (b as any).localLightRegions = remaining;
    const ses = ensureBloomEditorSession(settings);
    if (ses.activeLocalLightRegionId === regionId) {
        ses.activeLocalLightRegionId = (b as any).localLightRegions.length > 0
            ? (b as any).localLightRegions[0].id
            : null;
    }
    if (linkedLightId) {
        try {
            const lighting = ensureLighting(settings);
            if (Array.isArray((lighting as any).lights)) {
                const lightsAny = (lighting as any).lights as any[];
                const idx = lightsAny.findIndex((l) => l && (l as any).id === linkedLightId);
                if (idx >= 0) {
                    lightsAny.splice(idx, 1);
                    updatePointLightsFromSettings(global);
                    global.events.fire('lighting:changed');
                    const currentId = (global.state as any).selectedLightId ?? null;
                    if (currentId && currentId === linkedLightId) {
                        (global.state as any).selectedLightId = null;
                        global.events.fire('sceneLight:selected', { id: null });
                    }
                }
            }
        } catch {
            // 若联动失败，不影响区域本身的删除与协议行为
        }
    }
    global.events.fire('postEffect:changed');
    global.events.fire('bloomLocalLightRegion:listChanged');
}

/** SHADOW_SET */
export function applyShadowSet(global: Global, enabled: boolean): void {
    const settings = global.settings as ExperienceSettings;
    const s = ensureShadow(settings);
    (s as Record<string, unknown>).enabled = enabled;
    global.events.fire('postEffect:changed');
}

/** SHADOW_INTENSITY_UPDATE → shadow.darken (0~1) */
export function applyShadowIntensityUpdate(global: Global, value: number): void {
    const settings = global.settings as ExperienceSettings;
    const s = ensureShadow(settings);
    (s as Record<string, unknown>).darken = Math.max(0, Math.min(1, value));
    global.events.fire('postEffect:changed');
}

/** SHADOW_DIRECTION_SET：调节场景主方向光的航向角（yaw，度） */
export function applyShadowDirectionSet(global: Global, value: number): void {
    const settings = global.settings as ExperienceSettings;
    const yaw = Math.max(0, Math.min(360, Number.isFinite(value) ? value : 0));

    const lightingAny = (settings as any).lighting;
    if (lightingAny && Array.isArray(lightingAny.lights)) {
        const lights = lightingAny.lights as Array<Record<string, unknown>>;
        const dir = lights.find((l: any) => l && (l as any).type === 'directional');
        if (dir) {
            dir.yaw = yaw;
        }
    }

    const shadow = ensureShadow(settings) as Record<string, unknown>;
    shadow.lightYaw = yaw;

    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
}
