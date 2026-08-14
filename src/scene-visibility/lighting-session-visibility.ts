import type { Global } from '../types';
import {
    readLightingVisibility,
    writeLightingVisibility,
    type LightingVisibilityKey
} from '../view-settings';
import { hasConfiguredShadowSceneMesh } from '../vfx/shadow/shadow-policy';
import { requestLightingVisibilityReconcile } from './lighting-visibility-coordinator';
import { reportLightingVisibilityShadow } from './lighting-visibility-resolver';

/** 无已配置 GLB sceneMesh 时不允许改阴影会话显隐（也不触发 generate）。 */
export function canToggleLightingShadowSession(global: Global): boolean {
    return hasConfiguredShadowSceneMesh(global);
}

/**
 * 只写 brightness/bloom/shadow 子 flag，不套画面。
 * 无已配置 sceneMesh 时**跳过** shadow 子项（保持原值）。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {boolean} visible - 目标值
 * @returns {LightingVisibilityKey[]} 实际写入的子项
 */
export function writeLightingSubsFromLightsCategory(global: Global, visible: boolean): LightingVisibilityKey[] {
    const next = !!visible;
    const synced: LightingVisibilityKey[] = [];
    for (const key of ['brightness', 'bloom', 'shadow'] as const) {
        if (key === 'shadow' && !canToggleLightingShadowSession(global)) {
            continue;
        }
        writeLightingVisibility(global, key, next);
        synced.push(key);
    }
    return synced;
}

/**
 * 大类扫描：把 brightness/bloom/shadow 写成同一值后套用画面（之后子项仍可单独开）。
 * 无已配置 sceneMesh 时**跳过** shadow 子项（保持原值）。
 * @returns 实际参与同步的子项 key 列表（供出站 CHANGED）
 */
export function syncLightingSubsFromLightsCategory(global: Global, visible: boolean): LightingVisibilityKey[] {
    const synced = writeLightingSubsFromLightsCategory(global, visible);
    requestLightingVisibilityReconcile(global, `syncLightingSubs:${visible}`);
    return synced;
}

/**
 * 子接口：写单一子 flag 后套用画面（大类勾选不覆盖该 intent）。
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
    requestLightingVisibilityReconcile(global, `setLightingSessionAspectVisible:${key}:${next}`);
    global.events.fire('lightingSessionVisibility:changed', { key, value: next });
    reportLightingVisibilityShadow(global, `setLightingSessionAspectVisible:${key}:${next}`);
    return true;
}

export function readLightingSessionAspectVisible(global: Global, key: LightingVisibilityKey): boolean {
    return readLightingVisibility(global, key);
}
