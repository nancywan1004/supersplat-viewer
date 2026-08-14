/**
 * 环境模块协议映射：LIGHT_* / BLOOM_* / SHADOW_* 及局部亮灯笔刷联动的 settings 写入与事件派发。
 * 由 EnvironmentFacade 调用；其它模块如需相同语义可直接 import 本文件。
 */

import { getPositionInFrontOfCamera } from '../../scene-assets/asset-placement-handler';
import {
    spotApexToHalfDeg,
    updatePointLightsFromSettings
} from '../../light';
import { ensureSceneMeshForIntent } from '../../collision/scene-mesh-load-orchestrator';
import { syncGsplatShadowCastingFromSettings } from '../../vfx/shadow';
import type { ExperienceSettings } from '../../schemas/v2';
import {
    ensureBloom,
    ensureBloomEditorSession,
    ensureLighting,
    ensureNightMode,
    ensureShadow,
    addTorchLight,
    hasTorchLight,
    patchTorchLight,
    removeTorchLight,
    type LightWithId
} from '../../settings-serialize/settings-serialize-helper';
import { applyViewBloomLocalLightsEnabled, applyViewTorchActive } from '../../view-settings';
import type { Global } from '../../types';
import type { TorchLightSettings } from '../../schemas/v2-custom';

/**
 * 分配不与现有 `lighting.lights[*].id` 冲突的用户光 id（`light-<n>`，与 Lighting 面板一致）。
 *
 * @param {ExperienceSettings} settings -
 * @returns {string}
 */
export function allocateNextUserLightId(settings: ExperienceSettings): string {
    const lighting = ensureLighting(settings);
    const existingIds = (lighting.lights as any[])
        .map((l) => (l && typeof l === 'object' ? (l as any).id as string | undefined : undefined))
        .filter((id): id is string => typeof id === 'string');
    let maxIndex = -1;
    for (const id of existingIds) {
        const m = /^light-(\d+)$/.exec(id);
        if (m) {
            const n = parseInt(m[1], 10);
            if (Number.isFinite(n) && n > maxIndex) maxIndex = n;
        }
    }
    return `light-${maxIndex + 1}`;
}

function isUserControllableLight(light: LightWithId): boolean {
    const anyLight = light as any;
    const type = anyLight.type as string | undefined;
    return type === 'point' || type === 'spot' || type === undefined;
}

const finiteOr = (value: unknown, fallback: number): number =>
    (typeof value === 'number' && Number.isFinite(value)) ? value : fallback;

/** 输入/输出均为存库整锥顶角（度）；内部用引擎半角做 inner<outer 约束。 */
const normalizeSpotConeAngles = (inner: number, outer: number): { inner: number; outer: number } => {
    const outerH = spotApexToHalfDeg(Number.isFinite(outer) ? outer : 90);
    const innerH = spotApexToHalfDeg(Number.isFinite(inner) ? inner : 50);
    const safeOuter = Math.max(0.01, Math.min(89.9, outerH));
    const maxInner = Math.max(0, safeOuter - 1);
    const safeInner = Math.max(0, Math.min(maxInner, innerH));
    return { inner: safeInner * 2, outer: safeOuter * 2 };
};

/** LIGHT_GLOBAL_SET：写 nightMode.fade，并触发 nightFade:set */
export function applyLightGlobalSet(global: Global, value: number): void {
    const settings = global.settings as ExperienceSettings;
    const v = Math.max(-1, Math.min(1, value));
    const nm = ensureNightMode(settings);
    nm.fade = v;
    (global.app as { fire: (name: string, value?: unknown) => void }).fire('nightFade:set', v);
}

/**
 * LIGHT_ADD：isThreeSixty=true 创建点光；false 创建聚光灯（带 id）。
 * 位置优先 `positionOverride`，否则 `draftLightRegionCenter`，再否则相机前。
 *
 * 与 `LIGHT_BRUSH_FINISH` 分步：`skipAutoLinkedLight` **未传或 true** 时不自动建灯；FINISH 后 `activeLocalLightRegionId` 已指向新区域且
 * `draftLightRegionCenter` 已写入与自动绑灯相同的位置优先级；父级再发本方法并传入 `id` 即可绑定，无需额外关联字段。
 *
 * @param {Global} global -
 * @param {string} id - 新光源 id
 * @param {boolean} [isThreeSixty=true] - true 点光 / false 聚光
 * @param {[number, number, number] | null | undefined} [positionOverride] - 可选世界坐标（亮灯区域完成落盘时传入 committed 质心）
 * @param {string} [name] - 可选光源显示名称
 */
export function applyLightAdd(
    global: Global,
    id: string,
    isThreeSixty = true,
    positionOverride?: [number, number, number] | null,
    name?: string
): void {
    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    const bloom = ensureBloom(settings);
    const bloomSes = ensureBloomEditorSession(settings);
    const center = bloomSes.draftLightRegionCenter ?? null;
    const camPos = getPositionInFrontOfCamera(global);
    const fallbackPos: [number, number, number] = [camPos.x, camPos.y, camPos.z];
    const position: [number, number, number] = Array.isArray(positionOverride) && positionOverride.length >= 3
        ? [
            finiteOr(positionOverride[0], fallbackPos[0]),
            finiteOr(positionOverride[1], fallbackPos[1]),
            finiteOr(positionOverride[2], fallbackPos[2])
        ]
        : center
            ? [
                finiteOr(center[0], fallbackPos[0]),
                finiteOr(center[1], fallbackPos[1]),
                finiteOr(center[2], fallbackPos[2])
            ]
            : fallbackPos;
    if (isThreeSixty) {
        lighting.lights.push({
            id,
            name: name || id,
            type: 'point',
            position,
            color: [1, 1, 1],
            intensity: 1,
            range: 1,
            enabled: true
        } as LightWithId);
    } else {
        lighting.lights.push({
            id,
            name: name || id,
            type: 'spot',
            position,
            color: [1, 1, 1],
            intensity: 1,
            range: 1,
            innerConeAngle: 50,
            outerConeAngle: 90,
            enabled: true
        } as LightWithId);
    }
    if (bloomSes.activeLocalLightRegionId && Array.isArray(bloom.localLightRegions)) {
        const region = bloom.localLightRegions.find((r) => r && r.id === bloomSes.activeLocalLightRegionId);
        if (region) {
            const cur = (region as { linkedLightId?: string | null }).linkedLightId;
            const unbound = cur == null || (typeof cur === 'string' && cur.trim().length === 0);
            if (unbound) {
                (region as any).linkedLightId = id;
            }
        }
    }
    bloomSes.draftLightRegionCenter = null;
    updatePointLightsFromSettings(global);
    // 父级常紧跟 LIGHT_SELECT / LIGHT_TRANSFORM_MODE，下游先完成本地选中可避免瞬时“有模式无实体”状态。
    global.state.selectedLightId = id;
    global.events.fire('sceneLight:selected', { id, source: 'host' });
    global.events.fire('lighting:changed');
    global.events.fire('postEffect:changed');
}

/** LIGHT_SELECT：仅更新内部选中光源 id（可选，供 UI 使用），并派发 sceneLight:selected 事件 */
export function applyLightSelect(global: Global, id: string | null, source: 'host' | 'scene' | 'unknown' = 'unknown'): void {
    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    const resolvedId = (typeof id === 'string' && id.trim().length > 0)
        ? (lighting.lights.some((l) => (l as LightWithId).id === id) ? id : null)
        : null;
    (global.state as Record<string, unknown>).selectedLightId = resolvedId;
    global.events.fire('sceneLight:selected', { id: resolvedId, source });
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
            const currentOuter = Number((light as any).outerConeAngle ?? 90);
            const normalized = normalizeSpotConeAngles(payload.value, currentOuter);
            (light as Record<string, unknown>).innerConeAngle = normalized.inner;
            (light as Record<string, unknown>).outerConeAngle = normalized.outer;
            changed = true;
        }
        break;
    case 'LIGHT_OUTER_ANGLE_SET':
        if (typeof payload.value === 'number') {
            const currentInner = Number((light as any).innerConeAngle ?? 50);
            const normalized = normalizeSpotConeAngles(currentInner, payload.value);
            (light as Record<string, unknown>).innerConeAngle = normalized.inner;
            (light as Record<string, unknown>).outerConeAngle = normalized.outer;
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

/**
 * LIGHT_UPDATE：更新光源通用属性（目前支持 name）。
 * 与 LIGHT_DETAIL 区分：LIGHT_DETAIL 用于光照参数（intensity/color/angle/range），
 * LIGHT_UPDATE 用于元数据（name 等）及未来可能的其他通用字段。
 *
 * @param {Global} global -
 * @param {string} id - 光源 id
 * @param {{ name?: string }} value - 要更新的属性
 */
export function applyLightUpdate(global: Global, id: string, value: { name?: string }): void {
    if (!id || !value || typeof value !== 'object') return;
    const settings = global.settings as ExperienceSettings;
    const lighting = settings.lighting;
    if (!lighting?.lights || !Array.isArray(lighting.lights)) return;

    const light = lighting.lights.find((l: LightWithId) => (l as LightWithId).id === id) as LightWithId | undefined;
    if (!light) return;

    let changed = false;

    // 更新名称
    if (typeof value.name === 'string') {
        (light as any).name = value.name;
        changed = true;
    }

    if (!changed) return;

    // 派发 lighting:changed 以通知 UI 刷新列表
    global.events.fire('lighting:changed');
}

/**
 * LIGHT_REGION_UPDATE：更新局部亮灯区域通用属性（目前支持 name）。
 * 与 LIGHT_UPDATE 对齐：用于元数据更新，不承载亮度/颜色等专用参数协议。
 *
 * @param {Global} global -
 * @param {string} id - 区域 id
 * @param {{ name?: string }} value - 要更新的属性
 */
export function applyLightRegionUpdate(global: Global, id: string, value: { name?: string }): void {
    if (!id || !value || typeof value !== 'object') return;
    const settings = global.settings as ExperienceSettings;
    const bloom = ensureBloom(settings);
    const regions = (bloom as { localLightRegions?: Array<{ id: string; name?: string }> }).localLightRegions;
    if (!Array.isArray(regions)) return;

    const region = regions.find((r) => r && r.id === id);
    if (!region) return;

    let changed = false;

    // 更新名称
    if (typeof value.name === 'string') {
        (region as { name?: string }).name = value.name;
        changed = true;
    }

    if (!changed) return;

    // 派发区域列表刷新事件，供 UI/监听方更新区域名称显示
    global.events.fire('bloomLocalLightRegion:listChanged');
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

/**
 * 与 `ASSET_COPY` 一致：`copyId` 由父级生成并下发；复制点光/聚光配置，略平移位置避免与源灯完全重合。
 * @param copyName - 可选，副本光源的显示名称
 */
export function applyLightCopy(global: Global, sourceId: string, copyId: string, copyName?: string): void {
    const sid = typeof sourceId === 'string' ? sourceId.trim() : '';
    const cid = typeof copyId === 'string' ? copyId.trim() : '';
    if (!sid || !cid || sid === cid) return;

    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    const lightsAny = lighting.lights as any[];
    const src = lightsAny.find((l) => l && l.id === sid);
    if (!src) return;
    if (src.type === 'directional') return;
    if (lightsAny.some((l) => l && l.id === cid)) return;

    const clone = JSON.parse(JSON.stringify(src)) as Record<string, unknown>;
    clone.id = cid;
    if (typeof copyName === 'string' && copyName.trim().length > 0) {
        clone.name = copyName.trim();
    }
    const pos = clone.position;
    if (Array.isArray(pos) && pos.length >= 3) {
        clone.position = [
            finiteOr(pos[0], 0) + 0.5,
            finiteOr(pos[1], 0),
            finiteOr(pos[2], 0)
        ];
    }

    lightsAny.push(clone as LightWithId);
    updatePointLightsFromSettings(global);
    (global.state as Record<string, unknown>).selectedLightId = cid;
    global.events.fire('sceneLight:selected', { id: cid, source: 'host' });
    global.events.fire('lighting:changed');
    global.events.fire('postEffect:changed');
}

/**
 * 遍历 `bloom.localLightRegions` 的 `linkedLightId`，将对应 `lighting.lights[*].enabled` 置为 `false`。
 * 用于整灯总闸关等路径，与「关区域 ⇒ 绑灯全关」单向语义对齐（不做反向自动开灯）。
 *
 * @param {Global} global - 全局上下文
 * @returns {boolean} 是否有任意光源被改写
 */
export function disableLinkedLightsForAllLocalLightRegions(global: Global): boolean {
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    const regions = b.localLightRegions;
    if (!Array.isArray(regions) || regions.length === 0) return false;
    const lighting = ensureLighting(settings);
    const lights = lighting.lights;
    let changed = false;
    for (const r of regions) {
        if (!r || typeof r !== 'object') continue;
        const lid = (r as { linkedLightId?: string | null }).linkedLightId;
        if (!lid || typeof lid !== 'string') continue;
        const light = lights.find(l => l && (l as LightWithId).id === lid);
        if (light && (light as { enabled?: boolean }).enabled !== false) {
            (light as { enabled?: boolean }).enabled = false;
            changed = true;
        }
    }
    return changed;
}

/**
 * LIGHT_TOGGLE_ALL：用户点光/聚光整闸 + Bloom 总闸同步（编辑态写 settings）。
 * - `bloomScope=local`：沿用 `viewSettings.bloom.localLightsEnabled` 仅控制观看态局部亮灯可见性。
 * - `bloomScope=global`：同步 `settings.postEffectSettings.bloom.enabled`，支持整场辉光开关。
 */
export function applyLightToggleAll(global: Global, enabled: boolean): void {
    const settings = global.settings as ExperienceSettings;
    const lighting = ensureLighting(settings);
    const bloom = ensureBloom(settings) as { bloomScope?: 'global' | 'local'; enabled?: boolean };
    let changed = false;
    for (const l of lighting.lights) {
        if (!isUserControllableLight(l)) continue;
        const anyLight = l as any;
        if (anyLight.enabled !== enabled) {
            anyLight.enabled = enabled;
            changed = true;
        }
    }
    applyViewBloomLocalLightsEnabled(global, enabled);
    // 全局 Bloom 模式下，LIGHT_TOGGLE_ALL 直接控制整体辉光总开关。
    if ((bloom.bloomScope ?? 'local') === 'global' && bloom.enabled !== enabled) {
        bloom.enabled = enabled;
        changed = true;
    }
    if (!enabled && disableLinkedLightsForAllLocalLightRegions(global)) {
        changed = true;
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

/** BLOOM_INTENSITY_UPDATE：直接更新 Bloom 真实 intensity（不做 clamp/映射）。 */
export function applyBloomIntensityUpdate(global: Global, value: number): void {
    const settings = global.settings as ExperienceSettings;
    const b = ensureBloom(settings);
    const intensity = Number.isFinite(value) ? value : 0;
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
    // 切到 global 时，按当前 intensity/blurLevel 归一 enabled，
    // 避免出现 scope 已切换但 enabled 仍为 false 导致“全局辉光不显示”。
    if (!value) {
        const intensity = Number((b as { intensity?: number }).intensity ?? 0);
        const blurLevel = Number((b as { blurLevel?: number }).blurLevel ?? 0);
        b.enabled = Number.isFinite(intensity) && intensity > 0 && Number.isFinite(blurLevel) && blurLevel > 0;
    }
    global.events.fire('postEffect:changed');
}

/** LIGHT_BRUSH_INTENSITY_UPDATE：根据亮灯区域 id，更新其绑定光源的 intensity（0-100） */
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
    const clamped = Math.max(0, Math.min(100, value));
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
    const normalized = normalizeSpotConeAngles(
        value,
        Number((light as any).outerConeAngle ?? 90)
    );
    (light as any).innerConeAngle = normalized.inner;
    (light as any).outerConeAngle = normalized.outer;
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
    const normalized = normalizeSpotConeAngles(
        Number((light as any).innerConeAngle ?? 50),
        value
    );
    (light as any).innerConeAngle = normalized.inner;
    (light as any).outerConeAngle = normalized.outer;
    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
}

/** LIGHT_BRUSH_RANGE_SET：根据亮灯区域 id，更新其绑定光源的 range（0-20）；点光/聚光均适用 */
export function applyBloomLocalLightRegionRangeSet(global: Global, regionId: string, value: number): void {
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

/** SHADOW_SET：写 `shadow.enabled`（GLB 型 `collision` URL 为接影前置条件）。 */
export function applyShadowSet(global: Global, enabled: boolean): void {
    const settings = global.settings as ExperienceSettings;
    const s = ensureShadow(settings) as Record<string, unknown>;
    s.enabled = enabled;
    syncGsplatShadowCastingFromSettings(global);
    (global.app as { __directionalLightSignature?: string }).__directionalLightSignature = undefined;
    updatePointLightsFromSettings(global);
    global.events.fire('postEffect:changed');
}

/** 父级 / 协议开启阴影：先确保 scene mesh 已加载，再写入 settings。 */
export async function applyShadowSetFromHost(global: Global, enabled: boolean): Promise<void> {
    if (!enabled) {
        applyShadowSet(global, false);
        return;
    }
    const meshResult = await ensureSceneMeshForIntent(global, { wantShadow: true });
    if (meshResult.ok === false) {
        console.warn('[Shadow] SHADOW_SET enable failed:', meshResult.message);
        return;
    }
    applyShadowSet(global, true);
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

    // 清除方向光签名缓存，强制 updatePointLightsFromSettings 重新应用方向光
    (global.app as any).__directionalLightSignature = null;

    updatePointLightsFromSettings(global);
    global.events.fire('lighting:changed');
}

/**
 * `TORCH_ADD`：把手电筒写入 `settings.lighting.torch`（可带 partial）。
 * - 仅此路径（及已保存 JSON）会让 torch 进入持久化 settings
 * - 不改变 `viewSettings.torch.active`（初始/默认保持关闭；开闭用 `TORCH_TOGGLE`）
 */
export function applyTorchAdd(
    global: Global,
    partial?: Partial<TorchLightSettings> | null
): TorchLightSettings {
    const settings = global.settings as ExperienceSettings;
    const next = addTorchLight(settings, partial);
    global.events.fire('torch:added', { value: next });
    global.events.fire('torchParams:changed', { value: next });
    global.events.fire('lighting:changed');
    return next;
}

/**
 * `TORCH_DELETE`：移除 `settings.lighting.torch`；并关闭运行时开关。
 * - 未 ADD 时返回 false
 */
export function applyTorchDelete(global: Global): boolean {
    const settings = global.settings as ExperienceSettings;
    if (!hasTorchLight(settings)) return false;
    removeTorchLight(settings);
    applyViewTorchActive(global, false);
    global.events.fire('torch:deleted');
    global.events.fire('torchParams:changed', { value: null });
    global.events.fire('lighting:changed');
    return true;
}

/**
 * `TORCH_TOGGLE`：全局手电筒运行时开关。
 * - 只写 `viewSettings.torch.active`（不入库），由 `TorchLightController` 在 update 中读取
 * - 与是否已 `TORCH_ADD` 解耦：未入库也可临时开关（用默认参数），但保存不会出现 torch
 * - 与 `LIGHT_TOGGLE_ALL` 解耦：关用户灯时手电筒仍可独立开启
 */
export function applyTorchToggle(global: Global, enabled: boolean): boolean {
    return applyViewTorchActive(global, enabled);
}

/**
 * `TORCH_PARAMS_SET`：仅在已 `TORCH_ADD` 时合并参数到 `settings.lighting.torch`。
 * - 未 ADD 时返回 null（不隐式入库）
 * - 派发 `torchParams:changed`，`TorchLightController` 监听并写到实体光源组件
 */
export function applyTorchParamsSet(
    global: Global,
    partial: Partial<TorchLightSettings>
): TorchLightSettings | null {
    const settings = global.settings as ExperienceSettings;
    if (!hasTorchLight(settings)) return null;
    const next = patchTorchLight(settings, partial);
    if (!next) return null;
    global.events.fire('torchParams:changed', { value: next });
    global.events.fire('lighting:changed');
    return next;
}
