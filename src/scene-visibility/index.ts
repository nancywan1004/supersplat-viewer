import type { Global } from '../types';
import { BUILTIN_SCENE_CONTENT_VISIBILITY_ADAPTERS } from './adapters';
import { SceneContentVisibilityRegistry } from './registry';

export type {
    SceneContentCategoryId,
    SceneContentVisibilityAdapter,
    SceneContentVisibilityMap
} from './types';
export {
    SCENE_CONTENT_CATEGORY_IDS,
    SCENE_CONTENT_DEFER_CATEGORY_IDS,
    isSceneContentCategoryId
} from './types';
export { SceneContentVisibilityRegistry, getSceneContentVisibilityRegistry } from './registry';
export {
    BUILTIN_SCENE_CONTENT_VISIBILITY_ADAPTERS,
    isContentVisibilityOverlayActive,
    restoreEditSceneContentVisibility
} from './adapters';
export {
    SCENE_CONTENT_ALL_SET_HIDE_ORDER,
    SCENE_CONTENT_ALL_SET_SHOW_ORDER
} from './adapters';
export {
    applyRevealSessionVisible,
    applyPersistentSessionVisible,
    applyStylizationSessionVisible,
    restoreEffectsFromExperienceSettings
} from './effects-session-visibility';
export {
    applyLightingBrightnessSession,
    applyLightingSessionAspects,
    canToggleLightingShadowSession,
    setLightingSessionAspectVisible,
    syncLightingSubsFromLightsCategory
} from './lighting-session-visibility';

/** 注册六类内置 adapter，挂到 `global.__sceneContentVisibility` */
export function initSceneContentVisibility(global: Global): SceneContentVisibilityRegistry {
    const existing = (global as { __sceneContentVisibility?: SceneContentVisibilityRegistry })
        .__sceneContentVisibility;
    if (existing) {
        return existing;
    }
    const registry = new SceneContentVisibilityRegistry(global);
    for (const adapter of BUILTIN_SCENE_CONTENT_VISIBILITY_ADAPTERS) {
        registry.register(adapter);
    }
    (global as { __sceneContentVisibility?: SceneContentVisibilityRegistry }).__sceneContentVisibility =
        registry;

    const onEditingContextChanged = () => {
        registry.syncAfterEditingContextChanged();
    };
    global.events.on('editMode:changed', onEditingContextChanged);
    global.events.on('previewMode:changed', onEditingContextChanged);

    return registry;
}
