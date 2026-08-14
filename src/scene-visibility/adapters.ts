import { applyAnnotationShowHideSet } from '../annotation-toolbar/annotation-visibility';
import { pauseAllSceneMedia } from '../scene-assets/media/scene-media-playback';
import { writeSessionLightVisible } from '../view-settings';
import type { ExperienceSettings } from '../schemas/v2';
import type { Global } from '../types';
import {
    applyPersistentSessionVisible,
    applyRevealSessionVisible,
    applyStylizationSessionVisible,
    restoreEffectsFromExperienceSettings,
    type PersistentSessionSnapshot
} from './effects-session-visibility';
import {
    applyPlacedAssetEntities,
    applyViewerAssetShowHide,
    syncPlacedAssetsRoot
} from './assets-visibility-facade';
import { writeLightingSubsFromLightsCategory } from './lighting-session-visibility';
import { requestLightingVisibilityReconcile } from './lighting-visibility-coordinator';
import { revertCascadedLightToggleOverlays } from './lighting-visibility-facade';
import type { SceneContentVisibilityAdapter } from './types';

export function isContentVisibilityOverlayActive(global: Global): boolean {
    return global.state.editMode !== true;
}

/** overlay 未激活时 intent 视为 true（编辑态按 settings / 单条显隐） */
function effectiveCategoryIntent(global: Global, intentVisible: boolean): boolean {
    return isContentVisibilityOverlayActive(global) ? !!intentVisible : true;
}

function getAnnotationManager(global: Global): {
    setAllAnnotationsVisible?: (x: boolean) => void;
    applyVisibilityFromSettings?: () => void;
} | undefined {
    return (global as {
        annotationManager?: {
            setAllAnnotationsVisible?: (x: boolean) => void;
            applyVisibilityFromSettings?: () => void;
        };
    }).annotationManager;
}

/**
 * 进入编辑（含预览）：丢弃 View 会话对画面的叠加，恢复编辑真源（settings / 单条）。
 * 不改写 `viewSettings.contentVisibility`（退出到纯 Viewer 时再套用）。
 */
export function restoreEditSceneContentVisibility(global: Global): void {
    applyPlacedAssetEntities(global);
    getAnnotationManager(global)?.applyVisibilityFromSettings?.();
    restoreEffectsFromExperienceSettings(global);
    // 亮度会话可能把 nightFade 压到 0；进编辑按 settings 真源恢复
    const nm = (global.settings as ExperienceSettings)?.nightMode as { fade?: number } | undefined;
    const raw = typeof nm?.fade === 'number' ? nm.fade : 0;
    const v = Math.max(-1, Math.min(1, raw));
    (global.app as { fire: (name: string, value?: unknown) => void }).fire('nightFade:set', v);
    global.events.fire('postEffect:changed');
}

const assetsAdapter: SceneContentVisibilityAdapter = {
    id: 'assets',
    applyCategoryIntent(global, intentVisible) {
        const show = effectiveCategoryIntent(global, intentVisible);
        if (!show) {
            global.events.fire('assetEffect:morphStopAll');
        }
        applyPlacedAssetEntities(global);
        if (!show) {
            pauseAllSceneMedia(global);
        }
    },
    applyRuntimeGate(global, gateOpen, intentVisible) {
        const show = effectiveCategoryIntent(global, intentVisible);
        const anyShown = applyPlacedAssetEntities(global);
        syncPlacedAssetsRoot(global, gateOpen, show, anyShown);
    },
    setInstanceVisible(global, instanceId, visible) {
        applyViewerAssetShowHide(global, instanceId, visible);
    }
};

const annotationsAdapter: SceneContentVisibilityAdapter = {
    id: 'annotations',
    applyCategoryIntent(global, _intentVisible) {
        getAnnotationManager(global)?.applyVisibilityFromSettings?.();
    },
    applyRuntimeGate(global, gateOpen, _intentVisible) {
        const am = getAnnotationManager(global);
        if (!am) return;
        if (!gateOpen) {
            am.setAllAnnotationsVisible?.(false);
            return;
        }
        am.applyVisibilityFromSettings?.();
    },
    setInstanceVisible(global, instanceId, visible) {
        applyAnnotationShowHideSet(global, instanceId, visible);
    }
};

const lightsAdapter: SceneContentVisibilityAdapter = {
    id: 'lights',
    applyCategoryIntent(global, intentVisible) {
        const show = !!intentVisible;
        if (!show) {
            revertCascadedLightToggleOverlays(global);
        }
        writeLightingSubsFromLightsCategory(global, show);
        requestLightingVisibilityReconcile(global, `lightsIntent:${show}`);
    },
    applyRuntimeGate(global, _gateOpen, _intentVisible) {
        requestLightingVisibilityReconcile(global, 'lightsGate');
    },
    setInstanceVisible(global, instanceId, visible) {
        writeSessionLightVisible(global, instanceId, visible);
        requestLightingVisibilityReconcile(global, `setInstanceVisible:${instanceId}:${visible}`);
    }
};

const revealAdapter: SceneContentVisibilityAdapter = {
    id: 'reveal',
    applyCategoryIntent(global, intentVisible) {
        if (!isContentVisibilityOverlayActive(global)) return;
        applyRevealSessionVisible(global, intentVisible);
    }
};

const persistentAdapter: SceneContentVisibilityAdapter = {
    id: 'persistent',
    applyCategoryIntent(global, intentVisible) {
        if (!isContentVisibilityOverlayActive(global)) return;
        const g = global as Global & { __sceneContentPersistentSnapshot?: PersistentSessionSnapshot };
        // hide 返回值可能是「保留的旧 snapshot」（已关后再 hide 时不为空数组覆盖）
        const snap = applyPersistentSessionVisible(global, intentVisible, g.__sceneContentPersistentSnapshot);
        if (!intentVisible) {
            g.__sceneContentPersistentSnapshot = snap;
        }
    }
};

const stylizationAdapter: SceneContentVisibilityAdapter = {
    id: 'stylization',
    applyCategoryIntent(global, intentVisible) {
        if (!isContentVisibilityOverlayActive(global)) return;
        const g = global as Global & { __sceneContentStylizationSnapshot?: string[] };
        const types = applyStylizationSessionVisible(global, intentVisible, g.__sceneContentStylizationSnapshot);
        if (!intentVisible) {
            g.__sceneContentStylizationSnapshot = types;
        }
    }
};

export const BUILTIN_SCENE_CONTENT_VISIBILITY_ADAPTERS: readonly SceneContentVisibilityAdapter[] = [
    assetsAdapter,
    annotationsAdapter,
    lightsAdapter,
    revealAdapter,
    persistentAdapter,
    stylizationAdapter
];

export {
    SCENE_CONTENT_ALL_SET_HIDE_ORDER,
    SCENE_CONTENT_ALL_SET_SHOW_ORDER
} from './types';
