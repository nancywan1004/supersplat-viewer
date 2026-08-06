import { findAssetMorphOwnerTargetId } from '../settings-serialize/effects-sync';
import { pauseAllSceneMedia } from '../scene-assets/media/scene-media-playback';
import {
    applyViewBloomLocalLightsEnabled,
    readViewBloomLocalLightsEnabled
} from '../view-settings';
import type { ExperienceSettings } from '../schemas/v2';
import type { Global, ScenePlacedItem } from '../types';
import {
    applyPersistentSessionVisible,
    applyRevealSessionVisible,
    applyStylizationSessionVisible,
    restoreEffectsFromExperienceSettings,
    type PersistentSessionSnapshot
} from './effects-session-visibility';
import { syncLightingSubsFromLightsCategory } from './lighting-session-visibility';
import type { SceneContentCategoryId, SceneContentVisibilityAdapter } from './types';

const ENTITY_NAMES = {
    placedAssets: 'placedAssets',
    pointLights: 'pointLights',
    spotLights: 'spotLights'
} as const;

function setRootEntityEnabled(global: Global, name: string, visible: boolean): void {
    const entity = global.app.root.findByName(name) as { enabled?: boolean } | null;
    if (entity && typeof entity.enabled === 'boolean') {
        entity.enabled = visible;
    }
}

/**
 * 仅纯 Viewer（`!editMode`）套用 `viewSettings.contentVisibility`。
 * 编辑态（含预览）只记账到 viewSettings，不改编辑态 scene content。
 */
export function isContentVisibilityOverlayActive(global: Global): boolean {
    return global.state.editMode !== true;
}

/** overlay 未激活时 intent 视为 true（编辑态按 settings / 单条显隐） */
function effectiveCategoryIntent(global: Global, intentVisible: boolean): boolean {
    return isContentVisibilityOverlayActive(global) ? !!intentVisible : true;
}

function isDeformedMorphGsplat(
    global: Global,
    item: { id?: string; assetType?: string } | null | undefined
): boolean {
    if (!item?.id || item.assetType !== 'gaussian') {
        return false;
    }
    const morphOwner = findAssetMorphOwnerTargetId(global.settings as ExperienceSettings, item.id);
    return !!morphOwner && morphOwner !== item.id;
}

/**
 * 按单条 `entry.visible` / settings 恢复 entity.enabled。
 * 不把会话大类开关写入 `entry.visible`。
 */
function syncPlacedAssetEntitiesFromPerItemVisible(global: Global): void {
    const items = global.state.scenePlacedEntities;
    if (!Array.isArray(items)) return;

    const settingsVisible = new Map<string, boolean>();
    for (const sa of global.settings?.sceneAssets ?? []) {
        if (typeof sa?.id === 'string') {
            settingsVisible.set(sa.id, sa.visible !== false);
        }
    }

    for (const item of items as ScenePlacedItem[]) {
        if (!item?.entity) continue;
        const fromSettings = settingsVisible.get(item.id);
        if (fromSettings === true && item.visible === false) {
            item.visible = true;
        }
        if (item.visible !== false && isDeformedMorphGsplat(global, item)) {
            continue;
        }
        item.entity.enabled = item.visible !== false;
    }
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
 * 不改写 `viewSettings.contentVisibility` / `lightingVisibility`（退出到纯 Viewer 时再套用）。
 */
export function restoreEditSceneContentVisibility(global: Global): void {
    syncPlacedAssetEntitiesFromPerItemVisible(global);
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
            pauseAllSceneMedia(global);
            return;
        }
        syncPlacedAssetEntitiesFromPerItemVisible(global);
    },
    applyRuntimeGate(global, gateOpen, intentVisible) {
        const show = effectiveCategoryIntent(global, intentVisible);
        const rootOn = gateOpen && show;
        setRootEntityEnabled(global, ENTITY_NAMES.placedAssets, rootOn);
        if (!rootOn) {
            pauseAllSceneMedia(global);
        }
    }
};

const annotationsAdapter: SceneContentVisibilityAdapter = {
    id: 'annotations',
    applyCategoryIntent(global, intentVisible) {
        const am = getAnnotationManager(global);
        if (!am) return;
        if (effectiveCategoryIntent(global, intentVisible)) {
            am.applyVisibilityFromSettings?.();
        } else {
            am.setAllAnnotationsVisible?.(false);
        }
    },
    applyRuntimeGate(global, gateOpen, intentVisible) {
        const am = getAnnotationManager(global);
        if (!am) return;
        if (!gateOpen || !effectiveCategoryIntent(global, intentVisible)) {
            am.setAllAnnotationsVisible?.(false);
            return;
        }
        am.applyVisibilityFromSettings?.();
    }
};

const lightsAdapter: SceneContentVisibilityAdapter = {
    id: 'lights',
    applyCategoryIntent(global, intentVisible) {
        // 子项 flag 在编辑态也可记账；画面套用由 sync 内 overlay 判断
        const show = !!intentVisible;
        syncLightingSubsFromLightsCategory(global, show);
        if (!isContentVisibilityOverlayActive(global)) return;
        const g = global as Global & { __sceneContentLightsBloomSnap?: boolean };
        if (!show) {
            if (typeof g.__sceneContentLightsBloomSnap !== 'boolean') {
                g.__sceneContentLightsBloomSnap = readViewBloomLocalLightsEnabled(global);
            }
            applyViewBloomLocalLightsEnabled(global, false);
            global.events.fire('postEffect:changed');
            return;
        }
        const snap = g.__sceneContentLightsBloomSnap;
        delete g.__sceneContentLightsBloomSnap;
        applyViewBloomLocalLightsEnabled(global, snap !== false);
        global.events.fire('postEffect:changed');
    },
    applyRuntimeGate(global, gateOpen, intentVisible) {
        const rootOn = gateOpen && effectiveCategoryIntent(global, intentVisible);
        setRootEntityEnabled(global, ENTITY_NAMES.pointLights, rootOn);
        setRootEntityEnabled(global, ENTITY_NAMES.spotLights, rootOn);
        // 手电筒独立于 contentVisibility.lights（viewSettings.torch.active），不在此门控
        // 亮度 / 全局辉光 / 阴影由 lightingVisibility 会话门控（见 lighting-session-visibility）
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

/**
 * ALL_SET 遍历顺序。
 * **lights 必须最后**：否则 reveal/persistent 拆卸会 `forceReapply(settings.nightMode.fade)`，
 * 盖掉光照会话「隐亮度 → nightFade=0」。
 */
export const SCENE_CONTENT_ALL_SET_HIDE_ORDER: readonly SceneContentCategoryId[] = [
    'assets',
    'annotations',
    'persistent',
    'stylization',
    'reveal',
    'lights'
];

export const SCENE_CONTENT_ALL_SET_SHOW_ORDER: readonly SceneContentCategoryId[] = [
    'assets',
    'annotations',
    'reveal',
    'persistent',
    'stylization',
    'lights'
];
