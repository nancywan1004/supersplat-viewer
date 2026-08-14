/**
 * Viewer 资产显隐 Facade：会话 overlay + 根节点。不引用 adapters，避免测试拉到 OSS。
 */
import { pauseAllSceneMedia } from '../scene-assets/media/scene-media-playback';
import { findAssetMorphOwnerTargetId } from '../settings-serialize/effects-sync';
import type { ExperienceSettings } from '../schemas/v2';
import type { Global, ScenePlacedItem } from '../types';
import { readContentCategoryVisible, readSessionAssetVisible, writeSessionAssetVisible } from '../view-settings';

const PLACED_ASSETS_NAME = 'placedAssets';

function overlayActive(global: Global): boolean {
    return global.state.editMode !== true;
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

function setPlacedAssetsRootEnabled(global: Global, on: boolean): void {
    const entity = global.app?.root?.findByName?.(PLACED_ASSETS_NAME) as { enabled?: boolean } | null;
    if (entity && typeof entity.enabled === 'boolean') {
        entity.enabled = on;
    }
}

function readRuntimeGateOpen(global: Global): boolean {
    const registry = (global as {
        __sceneContentVisibility?: { isRuntimeGateOpen?: () => boolean };
    }).__sceneContentVisibility;
    return registry?.isRuntimeGateOpen?.() !== false;
}

/**
 * 按 `entry.visible` × 会话 overlay 套用子实体。不写 `entry.visible`。
 *
 * @returns 是否有任一资产应对画面显示
 */
export function applyPlacedAssetEntities(global: Global): boolean {
    const items = global.state.scenePlacedEntities;
    if (!Array.isArray(items)) {
        return false;
    }

    const settingsVisible = new Map<string, boolean>();
    for (const sa of global.settings?.sceneAssets ?? []) {
        if (typeof sa?.id === 'string') {
            settingsVisible.set(sa.id, sa.visible !== false);
        }
    }

    const sessionActive = overlayActive(global);
    let anyShown = false;
    for (const item of items as ScenePlacedItem[]) {
        if (!item?.entity) {
            continue;
        }
        const fromSettings = settingsVisible.get(item.id);
        if (fromSettings === true && item.visible === false) {
            item.visible = true;
        }
        if (item.visible !== false && isDeformedMorphGsplat(global, item)) {
            continue;
        }
        const on = item.visible !== false && (!sessionActive || readSessionAssetVisible(global, item.id));
        item.entity.enabled = on;
        if (on) {
            anyShown = true;
        }
    }
    return anyShown;
}

export function syncPlacedAssetsRoot(global: Global, gateOpen: boolean, categoryOn: boolean, anyShown: boolean): void {
    const rootOn = gateOpen && (categoryOn || anyShown);
    setPlacedAssetsRootEnabled(global, rootOn);
    if (!rootOn) {
        pauseAllSceneMedia(global);
    }
}

/** 子实体 + 根节点。`gateOpen` 缺省读 registry。 */
export function applyAssetsVisibility(global: Global, gateOpen?: boolean): void {
    const anyShown = applyPlacedAssetEntities(global);
    const categoryOn = !overlayActive(global) || readContentCategoryVisible(global, 'assets');
    syncPlacedAssetsRoot(global, gateOpen ?? readRuntimeGateOpen(global), categoryOn, anyShown);
}

/**
 * Viewer `ASSET_SHOW_HIDE_SET`：只写会话 overlay，不改 `entry.visible`。
 */
export function applyViewerAssetShowHide(global: Global, id: string, visible: boolean): void {
    if (!id) {
        return;
    }
    writeSessionAssetVisible(global, id, visible);
    applyAssetsVisibility(global);
}
