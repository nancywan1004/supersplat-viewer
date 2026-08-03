import type { Global, ViewSettings } from './types';
import type { ExperienceSettings } from './schemas/v2';
import {
    SCENE_CONTENT_CATEGORY_IDS,
    type SceneContentCategoryId
} from './scene-visibility/types';

/** 观看态 Bloom 用户灯总闸默认开启 */
export const DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED = true;

/** 观看态场景 video/audio 热区默认不静音 */
export const DEFAULT_VIEW_MEDIA_MUTED = false;

/** 观看态标注 / 各大类默认可见 */
export const DEFAULT_VIEW_ANNOTATIONS_VISIBLE = true;

/** 全局手电筒默认关闭（仅会话态，不入库；TORCH_TOGGLE 控制，与 TORCH_ADD 解耦） */
export const DEFAULT_VIEW_TORCH_ACTIVE = false;

function createDefaultContentVisibility(): NonNullable<ViewSettings['contentVisibility']> {
    const out: NonNullable<ViewSettings['contentVisibility']> = {};
    for (const id of SCENE_CONTENT_CATEGORY_IDS) {
        out[id] = true;
    }
    return out;
}

export function createDefaultViewSettings(): ViewSettings {
    return {
        bloom: { localLightsEnabled: DEFAULT_VIEW_BLOOM_LOCAL_LIGHTS_ENABLED },
        mediaMuted: DEFAULT_VIEW_MEDIA_MUTED,
        contentVisibility: createDefaultContentVisibility(),
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
    if (!vs.contentVisibility || typeof vs.contentVisibility !== 'object') {
        vs.contentVisibility = createDefaultContentVisibility();
    } else {
        for (const id of SCENE_CONTENT_CATEGORY_IDS) {
            if (typeof vs.contentVisibility[id] !== 'boolean') {
                vs.contentVisibility[id] = true;
            }
        }
    }
    // 旧字段迁移：仅当 annotations 仍为默认 true 且 legacy 明确为 false 时写入
    if (typeof vs.annotationsVisible === 'boolean') {
        if (vs.annotationsVisible === false && vs.contentVisibility.annotations !== false) {
            vs.contentVisibility.annotations = false;
        }
        delete vs.annotationsVisible;
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

/** 读 View 会话大类显隐（`viewSettings.contentVisibility`，缺省 true） */
export function readContentCategoryVisible(global: Global, category: SceneContentCategoryId): boolean {
    const vs = ensureViewSettings(global);
    return vs.contentVisibility?.[category] !== false;
}

/**
 * 写 View 会话大类显隐（仅 viewSettings，不入库）。
 * 画面套用由 `SceneContentVisibilityRegistry` 负责；编辑态（含预览）不套用。
 * @returns 是否变更
 */
export function writeContentCategoryVisible(
    global: Global,
    category: SceneContentCategoryId,
    visible: boolean
): boolean {
    const vs = ensureViewSettings(global);
    if (!vs.contentVisibility) {
        vs.contentVisibility = createDefaultContentVisibility();
    }
    const next = !!visible;
    if (vs.contentVisibility[category] === next) return false;
    vs.contentVisibility[category] = next;
    return true;
}

/**
 * 标注全局 overlay（收敛到 `contentVisibility.annotations`）。
 * @returns 是否发生变更
 */
export function applyViewAnnotationsVisible(global: Global, visible: boolean): boolean {
    return writeContentCategoryVisible(global, 'annotations', visible);
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
    return readContentCategoryVisible(global, 'annotations');
}

export function readViewBloomLocalLightsEnabled(global: Global): boolean {
    return ensureViewSettings(global).bloom.localLightsEnabled !== false;
}

/**
 * `TORCH_TOGGLE`：全局手电筒运行时开关（仅 viewSettings，不入库；初始恒为关）。
 * 入库需先 `TORCH_ADD` 写入 `settings.lighting.torch`。
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
