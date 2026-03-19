/**
 * 协议 → ExperienceSettings / PostEffectSettings / LightingSettings 映射层
 * 将 LIGHT_* / BLOOM_* / SHADOW_* / VFX_* 等协议事件转换为对 settings/state 的写入与 events 派发，
 * 与 UI 逻辑解耦：message-bridge 与内部 UI 均可通过本模块复用同一套映射逻辑。
 */

import type { Global } from './types';
import type { ExperienceSettings } from './schemas/v2';
import type { PointLightConfig, DirectionalLightConfig, SpotLightConfig } from './schemas/v2';
import { DEFAULT_VFX_TOTAL_DURATION } from './schemas/v2-custom';
import { updatePointLightsFromSettings } from './light';
import { getPositionInFrontOfCamera } from './asset-placement-handler';

/** 协议中光源项带 id（用于 LIGHT_SELECT / LIGHT_INTENSITY_UPDATE 等） */
type LightWithId = (PointLightConfig | DirectionalLightConfig | SpotLightConfig) & { id?: string };

// --- 默认值（与 post-effect-ui / settings 一致） ---

const DEFAULT_BLOOM = {
    enabled: false,
    intensity: 0.1,
    blurLevel: 2,
    threshold: 0.2,
    bloomDebug: false,
    bloomScope: 'local' as const,
    bloomBrush: false,
    bloomBrushSize: 30,
    bloomBrushBrightness: 0
} as const;

const DEFAULT_SHADOW = {
    enabled: true,
    darken: 0,
    castShadows: true,
    debugVisual: false,
    sphereRadius: 0.5
} as const;

const DEFAULT_REVEAL_EFFECT = {
    type: 'none' as const,
    radius: 10,
    autoStart: true,
    totalDuration: DEFAULT_VFX_TOTAL_DURATION
};

// --- ensure 系列：保证 settings 上存在对应结构 ---

export function ensureNightMode(settings: ExperienceSettings): { fade?: number } {
    if (!settings.nightMode || typeof settings.nightMode !== 'object') {
        (settings as Record<string, unknown>).nightMode = { fade: 0 };
    }
    return settings.nightMode!;
}

export function ensureLighting(settings: ExperienceSettings): { lights: LightWithId[] } {
    if (!(settings as Record<string, unknown>).lighting) {
        (settings as Record<string, unknown>).lighting = { lights: [] };
    }
    const lighting = (settings as Record<string, unknown>).lighting as { lights: LightWithId[] };
    if (!Array.isArray(lighting.lights)) lighting.lights = [];
    // 确保每盏光源（尤其是 internal UI 新建的点光/聚光）都有一个 id，便于场景/列表/Gizmo 之间通过 id 关联
    lighting.lights.forEach((light, index) => {
        if (!light.id) {
            (light as LightWithId).id = `light-${index}`;
        }
    });
    return lighting;
}

/** 判断是否为「用户添加的可控光源」：排除场景内默认平行光，仅保留点光/聚光灯 */
function isUserControllableLight(light: LightWithId): boolean {
    const anyLight = light as any;
    const type = anyLight.type as string | undefined;
    // 约定：directional 为场景主方向光，始终不参与 LIGHT_TOGGLE / LIGHT_TOGGLE_ALL
    return type === 'point' || type === 'spot' || type === undefined;
}

export function ensurePostEffectSettings(settings: ExperienceSettings): NonNullable<ExperienceSettings['postEffectSettings']> {
    if (!settings.postEffectSettings || typeof settings.postEffectSettings !== 'object') {
        (settings as Record<string, unknown>).postEffectSettings = {};
    }
    return settings.postEffectSettings!;
}

export function ensureBloom(settings: ExperienceSettings): NonNullable<ExperienceSettings['postEffectSettings']>['bloom'] {
    const pe = ensurePostEffectSettings(settings);
    if (!pe.bloom || typeof pe.bloom !== 'object') {
        (pe as Record<string, unknown>).bloom = { ...DEFAULT_BLOOM };
    }
    const b = pe.bloom as Record<string, unknown>;
    if (b.threshold === undefined) b.threshold = 0.2;
    if (b.bloomDebug === undefined) b.bloomDebug = false;
    if (b.bloomScope !== 'global' && b.bloomScope !== 'local') b.bloomScope = 'local';
    if (b.bloomBrush === undefined) b.bloomBrush = false;
    if (b.bloomBrushSize === undefined) b.bloomBrushSize = 30;
    if (typeof b.bloomBrushBrightness !== 'number') b.bloomBrushBrightness = 0;
    if (typeof b.bloomBrushCommittedBrightness !== 'number') b.bloomBrushCommittedBrightness = 0;
    if (!Array.isArray(b.localLightRegions)) b.localLightRegions = [];
    if (typeof (b as any).localLightsEnabled !== 'boolean') (b as any).localLightsEnabled = true;
    if (b.activeLocalLightRegionId === undefined) b.activeLocalLightRegionId = null;
    return pe.bloom!;
}

export function ensureShadow(settings: ExperienceSettings): NonNullable<ExperienceSettings['postEffectSettings']>['shadow'] {
    const pe = ensurePostEffectSettings(settings);
    const s = (pe as Record<string, unknown>).shadow;
    if (!s || typeof s !== 'object') {
        (pe as Record<string, unknown>).shadow = { ...DEFAULT_SHADOW };
    } else {
        const sh = (pe as Record<string, unknown>).shadow as Record<string, unknown>;
        if (typeof sh.darken !== 'number') sh.darken = 0;
        if (sh.castShadows === undefined) sh.castShadows = true;
        if (sh.debugVisual === undefined) sh.debugVisual = false;
        if (typeof sh.sphereRadius !== 'number') sh.sphereRadius = 0.5;
    }
    return (pe as Record<string, unknown>).shadow as NonNullable<ExperienceSettings['postEffectSettings']>['shadow'];
}

export function ensureRevealEffect(settings: ExperienceSettings): NonNullable<ExperienceSettings['revealEffect']> {
    if (!settings.revealEffect || typeof settings.revealEffect !== 'object') {
        (settings as Record<string, unknown>).revealEffect = { ...DEFAULT_REVEAL_EFFECT };
    }
    return settings.revealEffect!;
}

// --- LIGHT 映射 ---

/** LIGHT_GLOBAL_SET：写 nightMode.fade，并触发 nightFade:set */
export function applyLightGlobalSet(global: Global, value: number): void {
    const settings = global.settings as ExperienceSettings;
    const v = Math.max(-1, Math.min(1, value));
    const nm = ensureNightMode(settings);
    nm.fade = v;
    (global.app as { fire: (name: string, value?: unknown) => void }).fire('nightFade:set', v);
}

/** LIGHT_ADD：在 lighting.lights 中追加一盏点光（带 id），默认在相机前方生成 */
export function applyLightAdd(global: Global, id: string): void {
    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    const camPos = getPositionInFrontOfCamera(global);
    lighting.lights.push({
        id,
        position: [camPos.x, camPos.y, camPos.z],
        color: [1, 1, 1],
        intensity: 1,
        range: 10,
        enabled: true
    } as LightWithId);
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
    global.events.fire('postEffect:changed');
}

/** LIGHT_SELECT：仅更新内部选中光源 id（可选，供 UI 使用），并派发 sceneLight:selected 事件 */
export function applyLightSelect(global: Global, id: string | null, source: 'host' | 'scene' | 'unknown' = 'unknown'): void {
    (global.state as Record<string, unknown>).selectedLightId = id;
    global.events.fire('sceneLight:selected', { id, source });
}

/** LIGHT_INTENSITY_UPDATE / LIGHT_COLOR_UPDATE / LIGHT_INNER_ANGLE_SET / LIGHT_OUTER_ANGLE_SET / LIGHT_RANGE_SET */
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

    switch (type) {
    case 'LIGHT_INTENSITY_UPDATE':
        if (typeof payload.value === 'number') light.intensity = payload.value;
        break;
    case 'LIGHT_COLOR_UPDATE':
        if (Array.isArray(payload.value) && payload.value.length >= 3) {
            light.color = [payload.value[0], payload.value[1], payload.value[2]];
        }
        break;
    case 'LIGHT_INNER_ANGLE_SET':
        if (typeof payload.value === 'number') (light as Record<string, unknown>).innerAngle = Math.max(0, Math.min(180, payload.value));
        break;
    case 'LIGHT_OUTER_ANGLE_SET':
        if (typeof payload.value === 'number') (light as Record<string, unknown>).outerAngle = Math.max(0, Math.min(180, payload.value));
        break;
    case 'LIGHT_RANGE_SET':
        if (typeof payload.value === 'number') (light as Record<string, unknown>).range = Math.max(0, Math.min(20, payload.value));
        break;
    default:
        return;
    }
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
    if (!changed) return;
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
    // 全局「所有光照开关」同时作为局部亮灯区域的主开关：
    // 关闭时，bloom.localLightsEnabled=false，所有 LocalLightRegion 在 Bloom 中整体失效。
    const bloom = ensureBloom(settings) as any;
    bloom.localLightsEnabled = enabled;
    // Bloom 配置/体积依赖灯光显隐，需要重新配置 postEffect 管线并强制渲染一帧
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

// --- BLOOM 映射 ---

/** BLOOM_INTENSITY_UPDATE（协议值 0–16 与内部 0–0.2 均可支持：若 > 1 则视为 0–16 并归一化到 0–0.2）。
 * 同时写 bloom.enabled：传 0 关辉光，非零开辉光并设强度，可完全取代 BLOOM_SET。 */
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
    if ((b as any).activeLocalLightRegionId === regionId) {
        (b as any).activeLocalLightRegionId = (b as any).localLightRegions.length > 0
            ? (b as any).localLightRegions[0].id
            : null;
    }
    // 若该区域绑定了光源，则通过 lighting 配置同步删除对应 light
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
                    // 若当前选中的光源就是被联动删除的那一盏，则清空选中状态
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

// --- SHADOW 映射 ---

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

/** SHADOW_DIRECTION_SET：调节场景主方向光的航向角（yaw，度）
 * - 优先写入 settings.lighting.lights 中的 directional 配置（如存在）
 * - 同步写入 postEffectSettings.shadow.lightYaw 以兼容旧配置
 * - 调整后通过 updatePointLightsFromSettings 立即应用到场景中的平行光实体
 */
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

// --- VFX 映射 ---

/** VFX_TYPE_SET：写 settings.revealEffect.type、state.vfxType，并触发 revealConfigChanged */
export function applyVfxTypeSet(global: Global, value: string): void {
    const settings = global.settings as ExperienceSettings;
    const rev = ensureRevealEffect(settings);
    (rev as Record<string, unknown>).type = value;
    (global.state as Record<string, unknown>).vfxType = value;
    global.events.fire('revealConfigChanged', { type: value });
}

/** VFX_EXIT：强制停止当前特效播放，但保留配置（不改 settings.revealEffect.type）。 */
export function applyVfxExit(global: Global): void {
    (global.state as Record<string, unknown>).vfxActive = false;
    // 交由 RevealController 执行停播与恢复 NightMode；不触碰 revealEffect.type（保证后续保存仍保留已选特效）
    global.events.fire('vfxExit');
}
