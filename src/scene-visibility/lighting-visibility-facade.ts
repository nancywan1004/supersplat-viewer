/**
 * Viewer 光照显隐 Facade：会话态 TOGGLE 写 instances；级联 TOGGLE(false)+大类 hide 不落 overlay。
 * 不引用 Environment 编辑适配器（避免测试/模块图拉到 OSS）。
 */
import type { Global } from '../types';
import {
    applyViewBloomLocalLightsEnabled,
    writeSessionLightVisible,
    writeSessionLightVisibleMany
} from '../view-settings';
import { requestLightingVisibilityReconcile } from './lighting-visibility-coordinator';
import { readConfiguredUserPointSpotEnabled } from './lighting-visibility-resolver';

const CASCADE_WINDOW_MS = 80;

type CascadeState = {
    recentFalseAt: Map<string, number>;
};

function cascadeState(global: Global): CascadeState {
    const g = global as Global & { __lightingToggleCascade?: CascadeState };
    if (!g.__lightingToggleCascade) {
        g.__lightingToggleCascade = { recentFalseAt: new Map() };
    }
    return g.__lightingToggleCascade;
}

function listUserLightIds(global: Global): string[] {
    return Object.keys(readConfiguredUserPointSpotEnabled(global));
}

/**
 * 大类即将隐藏：短窗内的逐灯 TOGGLE(false) 视为父级级联，撤回 overlay。
 *
 * @param {Global} global - Viewer 全局对象
 * @returns {boolean} 是否撤回了任一 overlay
 */
export function revertCascadedLightToggleOverlays(global: Global): boolean {
    const state = cascadeState(global);
    const now = Date.now();
    let changed = false;
    for (const [id, at] of state.recentFalseAt) {
        if (now - at <= CASCADE_WINDOW_MS) {
            if (writeSessionLightVisible(global, id, true)) {
                changed = true;
            }
        }
    }
    state.recentFalseAt.clear();
    return changed;
}

/**
 * Viewer `LIGHT_TOGGLE`：只写会话 overlay，不写 settings。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {string} id - 灯 id
 * @param {boolean} enabled - 目标可见
 * @returns {void}
 */
export function applyViewerLightToggle(global: Global, id: string, enabled: boolean): void {
    if (!id) {
        return;
    }
    const configured = readConfiguredUserPointSpotEnabled(global);
    if (!(id in configured)) {
        return;
    }
    writeSessionLightVisible(global, id, enabled);
    const state = cascadeState(global);
    if (!enabled) {
        state.recentFalseAt.set(id, Date.now());
    } else {
        state.recentFalseAt.delete(id);
    }
    requestLightingVisibilityReconcile(global, `LIGHT_TOGGLE:${id}:${enabled}`);
    global.events.fire('lighting:changed');
    global.events.fire('postEffect:changed');
}

/**
 * Viewer `LIGHT_TOGGLE_ALL`：批量 overlay + 局部亮灯闸，不写 settings。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {boolean} enabled - 全开/全关
 * @returns {void}
 */
export function applyViewerLightToggleAll(global: Global, enabled: boolean): void {
    const ids = listUserLightIds(global);
    writeSessionLightVisibleMany(global, ids, enabled);
    applyViewBloomLocalLightsEnabled(global, enabled);
    requestLightingVisibilityReconcile(global, `LIGHT_TOGGLE_ALL:${enabled}`);
    global.events.fire('lighting:changed');
    global.events.fire('postEffect:changed');
}
