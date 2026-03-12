/**
 * 协议 → ExperienceSettings / PostEffectSettings / LightingSettings 映射层
 * 将 LIGHT_* / BLOOM_* / SHADOW_* / VFX_* 等协议事件转换为对 settings/state 的写入与 events 派发，
 * 与 UI 逻辑解耦：message-bridge 与内部 UI 均可通过本模块复用同一套映射逻辑。
 */

import type { Global } from './types';
import type { ExperienceSettings } from './schemas/v2';
import type { PointLightConfig, DirectionalLightConfig, SpotLightConfig } from './schemas/v2';

/** 协议中光源项带 id（用于 LIGHT_SELECT / LIGHT_INTENSITY_UPDATE 等） */
type LightWithId = (PointLightConfig | DirectionalLightConfig | SpotLightConfig) & { id?: string };

// --- 默认值（与 post-effect-ui / settings 一致） ---

const DEFAULT_BLOOM = {
    enabled: false,
    intensity: 0.1,
    blurLevel: 2,
    threshold: 0.2,
    bloomDebug: false,
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
    totalDuration: 20
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
    return lighting;
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
    if (b.bloomBrush === undefined) b.bloomBrush = false;
    if (b.bloomBrushSize === undefined) b.bloomBrushSize = 30;
    if (typeof b.bloomBrushBrightness !== 'number') b.bloomBrushBrightness = 0;
    if (typeof b.bloomBrushCommittedBrightness !== 'number') b.bloomBrushCommittedBrightness = 0;
    if (!Array.isArray(b.localLightRegions)) b.localLightRegions = [];
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

/** LIGHT_ADD：在 lighting.lights 中追加一盏点光（带 id） */
export function applyLightAdd(global: Global, id: string): void {
    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    lighting.lights.push({
        id,
        position: [0, 2, 0],
        color: [1, 1, 1],
        intensity: 1,
        range: 10,
        enabled: true
    } as LightWithId);
    global.events.fire('postEffect:changed');
}

/** LIGHT_SELECT：仅更新内部选中光源 id（可选，供 UI 使用） */
export function applyLightSelect(global: Global, id: string | null): void {
    (global.state as Record<string, unknown>).selectedLightId = id;
}

/** LIGHT_INTENSITY_UPDATE / LIGHT_COLOR_UPDATE / LIGHT_IS_THREE_SIXTY_UPDATE / LIGHT_INNER_ANGLE_SET / LIGHT_OUTER_ANGLE_SET / LIGHT_RANGE_SET */
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
    case 'LIGHT_IS_THREE_SIXTY_UPDATE':
        if (typeof payload.value === 'boolean') (light as Record<string, unknown>).isThreeSixty = payload.value;
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

/** LIGHT_BRUSH_DELETE：按 id 删除局部亮灯区域（LIGHT_BRUSH_FINISH 生成的带 id 区域） */
export function applyBloomLocalLightRegionDelete(global: Global, regionId: string): void {
    if (!regionId) return;
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    if (!Array.isArray(b.localLightRegions)) return;
    const before = b.localLightRegions.length;
    (b as any).localLightRegions = b.localLightRegions.filter((r: { id: string }) => r.id !== regionId);
    if ((b as any).localLightRegions.length === before) return;
    if ((b as any).activeLocalLightRegionId === regionId) {
        (b as any).activeLocalLightRegionId = (b as any).localLightRegions.length > 0
            ? (b as any).localLightRegions[0].id
            : null;
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

// --- VFX 映射 ---

/** VFX_TYPE_SET：写 settings.revealEffect.type、state.vfxType，并触发 revealConfigChanged */
export function applyVfxTypeSet(global: Global, value: string): void {
    const settings = global.settings as ExperienceSettings;
    const rev = ensureRevealEffect(settings);
    (rev as Record<string, unknown>).type = value;
    (global.state as Record<string, unknown>).vfxType = value;
    global.events.fire('revealConfigChanged', { type: value });
}

/** VFX_EXIT：关闭当前特效，state.vfxActive=false、vfxType='none'，并触发 revealConfigChanged({ type: 'none' }) */
export function applyVfxExit(global: Global): void {
    const settings = global.settings as ExperienceSettings;
    ensureRevealEffect(settings);
    const rev = settings.revealEffect!;
    (rev as Record<string, unknown>).type = 'none';
    (global.state as Record<string, unknown>).vfxActive = false;
    (global.state as Record<string, unknown>).vfxType = 'none';
    global.events.fire('revealConfigChanged', { type: 'none' });
}
