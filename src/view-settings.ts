import type { Global, ViewSettings } from './types';
import type { ExperienceSettings } from './schemas/v2';

/** 观看态 Bloom 用户灯总闸默认开启 */
export const DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED = true;

/** 观看态场景 video/audio 热区默认不静音 */
export const DEFAULT_VIEW_MEDIA_MUTED = false;

/** 观看态标注默认可见 */
export const DEFAULT_VIEW_ANNOTATIONS_VISIBLE = true;

/** 全局手电筒默认关闭（仅会话态，不入库） */
export const DEFAULT_VIEW_TORCH_ACTIVE = false;

export function createDefaultViewSettings(): ViewSettings {
    return {
        bloom: { localLightsEnabled: DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED },
        mediaMuted: DEFAULT_VIEW_MEDIA_MUTED,
        annotationsVisible: DEFAULT_VIEW_ANNOTATIONS_VISIBLE,
        torch: { active: DEFAULT_VIEW_TORCH_ACTIVE }
    };
}

/**
 * 确保 `global.viewSettings` 存在并完成缺省字段补齐（不入库；Viewer 进入编辑时继承同一会话对象）。
 */
export function ensureViewSettings(global: Global): ViewSettings {
    if (!global.viewSettings) {
        global.viewSettings = createDefaultViewSettings();
        return global.viewSettings;
    }
    const vs = global.viewSettings;
    if (!vs.bloom) {
        vs.bloom = { localLightsEnabled: DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED };
    } else if (typeof vs.bloom.localLightsEnabled !== 'boolean') {
        vs.bloom.localLightsEnabled = DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED;
    }
    if (typeof vs.mediaMuted !== 'boolean') {
        vs.mediaMuted = DEFAULT_VIEW_MEDIA_MUTED;
    }
    if (typeof vs.annotationsVisible !== 'boolean') {
        vs.annotationsVisible = DEFAULT_VIEW_ANNOTATIONS_VISIBLE;
    }
    if (!vs.torch || typeof vs.torch !== 'object') {
        vs.torch = { active: DEFAULT_VIEW_TORCH_ACTIVE };
    } else if (typeof vs.torch.active !== 'boolean') {
        vs.torch.active = DEFAULT_VIEW_TORCH_ACTIVE;
    }
    return vs;
}

/** `LIGHT_TOGGLE_ALL`（local）→ 观看态局部亮灯总闸镜像 */
export function applyViewBloomLocalLightsEnabled(global: Global, enabled: boolean): void {
    ensureViewSettings(global).bloom.localLightsEnabled = enabled;
}

/** `ASSETS_SHOW_HIDE_SET` → 观看态标注显隐意图 */
export function applyViewAnnotationsVisible(global: Global, visible: boolean): void {
    ensureViewSettings(global).annotationsVisible = visible;
}

/**
 * `VIEW_MEDIA_MUTE_SET`：场景 video/audio 全局静音（`viewSettings.mediaMuted`，不入库）。
 * Viewer 与编辑模式共用同一会话值；进入编辑继承，编辑内可调，退出 View 仍保留。
 * @returns 是否发生变更
 */
export function applyViewMediaMuteSet(global: Global, muted: boolean): boolean {
    const vs = ensureViewSettings(global);
    const next = !!muted;
    if (vs.mediaMuted === next) return false;
    vs.mediaMuted = next;
    global.events.fire('viewMediaMuted:changed', { value: next });
    return true;
}

export function readViewMediaMuted(global: Global): boolean {
    return ensureViewSettings(global).mediaMuted === true;
}

export function readViewAnnotationsVisible(global: Global): boolean {
    return ensureViewSettings(global).annotationsVisible !== false;
}

export function readViewBloomLocalLightsEnabled(global: Global): boolean {
    return ensureViewSettings(global).bloom.localLightsEnabled !== false;
}

/**
 * `TORCH_TOGGLE`：全局手电筒开关（仅 viewSettings，不入库）。
 * 与 `applyViewMediaMuteSet` 保持相同返回与事件语义。
 * @returns 是否发生变更
 */
export function applyViewTorchActive(global: Global, active: boolean): boolean {
    const vs = ensureViewSettings(global);
    const next = !!active;
    if (!vs.torch) vs.torch = { active: next };
    if (vs.torch.active === next) return false;
    vs.torch.active = next;
    global.events.fire('torchActive:changed', { value: next });
    return true;
}

export function readViewTorchActive(global: Global): boolean {
    return ensureViewSettings(global).torch?.active === true;
}

/** 进入编辑 / 恢复快照时丢弃观看态特效 session */
export function clearViewEffectsSession(global: Global): void {
    delete global.viewSettings?.effectsSession;
}

/** 编辑写 `global.settings`；观看写 `viewSettings.effectsSession` */
export function getEffectsWriteTarget(global: Global): ExperienceSettings {
    if (global.state.editMode) {
        clearViewEffectsSession(global);
        return global.settings as ExperienceSettings;
    }
    const vs = ensureViewSettings(global);
    if (!vs.effectsSession) {
        vs.effectsSession = JSON.parse(JSON.stringify(global.settings)) as ExperienceSettings;
    }
    return vs.effectsSession;
}

/** 有 session 时读 session，否则读 settings */
export function getEffectsReadSource(global: Global): ExperienceSettings {
    const session = global.viewSettings?.effectsSession;
    if (!global.state.editMode && session) {
        return session;
    }
    return global.settings as ExperienceSettings;
}
