import { ensureNightMode } from '../settings-serialize/settings-serialize-helper';
import type { ExperienceSettings } from '../schemas/v2';
import type { Global } from '../types';
import {
    isLightingSessionAspectVisible,
    readLightingVisibility,
    writeLightingVisibility,
    type LightingVisibilityKey
} from '../view-settings';
import { hasConfiguredShadowSceneMesh } from '../vfx/shadow/shadow-policy';

/** 与 `isContentVisibilityOverlayActive` 同语义；避免与 adapters 循环依赖。 */
function isViewerOverlayActive(global: Global): boolean {
    return global.state.editMode !== true;
}

/** 无已配置 GLB sceneMesh 时不允许改阴影会话显隐（也不触发 generate）。 */
export function canToggleLightingShadowSession(global: Global): boolean {
    return hasConfiguredShadowSceneMesh(global);
}

function fireNightFade(global: Global, value: number): void {
    const v = Math.max(-1, Math.min(1, value));
    (global.app as { fire: (name: string, value?: unknown) => void }).fire('nightFade:set', v);
}

/** 按会话门控套用全局亮度（隐 → 0；显 → settings.nightMode.fade）。不写 settings。 */
export function applyLightingBrightnessSession(global: Global): void {
    if (!isViewerOverlayActive(global)) return;
    if (!isLightingSessionAspectVisible(global, 'brightness')) {
        fireNightFade(global, 0);
        return;
    }
    const nm = ensureNightMode(global.settings as ExperienceSettings);
    const raw = typeof nm.fade === 'number' ? nm.fade : 0;
    fireNightFade(global, raw);
}

/** 触发后处理刷新，使 bloom / shadow 会话门控在下一帧生效（不触发 sceneMesh generate）。 */
export function refreshLightingSessionPostEffects(global: Global): void {
    global.events.fire('postEffect:changed');
    const app = global.app as { renderNextFrame?: boolean };
    app.renderNextFrame = true;
}

/**
 * 按当前 `lightingVisibility` + `contentVisibility.lights` 套用亮度，并刷新 bloom/shadow 门控消费方。
 * 仅纯 Viewer；编辑态 no-op。
 */
export function applyLightingSessionAspects(global: Global): void {
    if (!isViewerOverlayActive(global)) return;
    applyLightingBrightnessSession(global);
    refreshLightingSessionPostEffects(global);
}

/**
 * `contentVisibility.lights` 总闸：同步子 flag 后套用画面。
 * 无已配置 sceneMesh 时**跳过** shadow 子项（保持原值）。
 * @returns 实际参与同步的子项 key 列表（供出站 CHANGED）
 */
export function syncLightingSubsFromLightsCategory(global: Global, visible: boolean): LightingVisibilityKey[] {
    const next = !!visible;
    const synced: LightingVisibilityKey[] = [];
    for (const key of ['brightness', 'bloom', 'shadow'] as const) {
        if (key === 'shadow' && !canToggleLightingShadowSession(global)) {
            continue;
        }
        writeLightingVisibility(global, key, next);
        synced.push(key);
    }
    applyLightingSessionAspects(global);
    return synced;
}

/**
 * 子接口：写单一子 flag；纯 Viewer 且 lights 总闸开时套用画面。
 * 阴影在无已配置 sceneMesh 时恒 no-op（不改 flag、不刷新）。
 * @returns 是否发生 intent 变更
 */
export function setLightingSessionAspectVisible(
    global: Global,
    key: LightingVisibilityKey,
    visible: boolean
): boolean {
    if (key === 'shadow' && !canToggleLightingShadowSession(global)) {
        return false;
    }
    const next = !!visible;
    const changed = writeLightingVisibility(global, key, next);
    if (!changed) {
        return false;
    }
    if (!isViewerOverlayActive(global)) {
        return true;
    }
    // lights 总闸关时只记账，画面仍由总闸压住
    if (key === 'brightness') {
        applyLightingBrightnessSession(global);
    } else {
        refreshLightingSessionPostEffects(global);
    }
    global.events.fire('lightingSessionVisibility:changed', { key, value: next });
    return true;
}

export function readLightingSessionAspectVisible(global: Global, key: LightingVisibilityKey): boolean {
    return readLightingVisibility(global, key);
}
