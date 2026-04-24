/**
 * 环境模块协议映射：LIGHT_* / BLOOM_* / SHADOW_* 及局部亮灯笔刷联动的 settings 写入与事件派发。
 * 由 EnvironmentFacade 调用；其它模块如需相同语义可直接 import 本文件。
 */

import { getPositionInFrontOfCamera } from '../../asset-placement-handler';
import { spotApexToHalfDeg, updatePointLightsFromSettings } from '../../light';
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
 */
export function applyLightAdd(
    global: Global,
    id: string,
    isThreeSixty = true,
    positionOverride?: [number, number, number] | null
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

/** 与 `ASSET_COPY` 一致：`copyId` 由父级生成并下发；复制点光/聚光配置，略平移位置避免与源灯完全重合。 */
export function applyLightCopy(global: Global, sourceId: string, copyId: string): void {
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
 * 将整场景用户灯总闸同步到 `global.viewSettings.bloom.localLightsEnabled`（仅观看路径已注入 `viewSettings` 时）。
 *
 * @param {Global} global - 全局上下文
 * @param {boolean} enabled - 与 `LIGHT_TOGGLE_ALL` / `applyLightToggleAll` 一致
 */
function syncViewSettingsBloomLocalLightsFromToggleAll(global: Global, enabled: boolean): void {
    const bloom = global.viewSettings?.bloom;
    if (!bloom) return;
    bloom.localLightsEnabled = enabled;
}

/**
 * LIGHT_TOGGLE_ALL：用户点光/聚光整闸 + 夜景 fade + `viewSettings.bloom.localLightsEnabled` + 绑灯全关。
 * 灯光数组与 Bloom 总闸分层，避免把「局部亮灯合成」写回 settings。
 */
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
    syncViewSettingsBloomLocalLightsFromToggleAll(global, enabled);
    if (!enabled && disableLinkedLightsForAllLocalLightRegions(global)) {
        changed = true;
    }
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
