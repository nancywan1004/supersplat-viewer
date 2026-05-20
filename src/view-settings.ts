import type { Global, ViewSettings } from './types';

/** 观看态 Bloom 用户灯总闸默认开启 */
export const DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED = true;

/** 观看态场景 video/audio 热区默认不静音 */
export const DEFAULT_VIEW_MEDIA_MUTED = false;

/** 观看态标注默认可见 */
export const DEFAULT_VIEW_ANNOTATIONS_VISIBLE = true;

export function createDefaultViewSettings(): ViewSettings {
    return {
        bloom: { localLightsEnabled: DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED },
        mediaMuted: DEFAULT_VIEW_MEDIA_MUTED,
        annotationsVisible: DEFAULT_VIEW_ANNOTATIONS_VISIBLE
    };
}

/**
 * 确保 `global.viewSettings` 存在并完成缺省字段补齐（不入库，仅 Viewer 会话态）。
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
 * `VIEW_MEDIA_MUTE_SET`：场景 video/audio 热区全局静音（仅 viewSettings）。
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
