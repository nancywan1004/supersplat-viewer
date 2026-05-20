import type { AssetLibraryType, ScenePlacedItem, State } from './types';
import type { Entity } from 'playcanvas';

/** 根据 state.selectedSceneEntityId 从 scenePlacedEntities 中取当前选中的条目（无则 null） */
export function getSelectedScenePlacedItem(state: State): ScenePlacedItem | null {
    const id = state.selectedSceneEntityId;
    if (!id) return null;
    const list = state.scenePlacedEntities ?? [];
    return list.find((e) => e.id === id) ?? null;
}

/** 根据 state.selectedSceneEntityId 从 scenePlacedEntities 中取当前选中的实体 */
export function getSelectedSceneEntity(state: State): Entity | null {
    return getSelectedScenePlacedItem(state)?.entity ?? null;
}

/**
 * 当前选中场景资产的类型（与 `AssetLibraryType` 一致）。
 * 优先运行态 `scenePlacedEntities[].assetType`，缺失时回退 `settings.sceneAssets[].type`。
 */
export function getSelectedSceneAssetType(
    state: State,
    sceneAssetsFromSettings?: ReadonlyArray<{ id?: string; type?: string }> | undefined
): AssetLibraryType | undefined {
    const placed = getSelectedScenePlacedItem(state);
    if (placed?.assetType) return placed.assetType;
    const id = state.selectedSceneEntityId;
    if (typeof id !== 'string' || id.trim().length === 0) return undefined;
    if (!Array.isArray(sceneAssetsFromSettings)) return undefined;
    const row = sceneAssetsFromSettings.find((s) => s?.id === id);
    const t = row?.type;
    return t === 'image' || t === 'mesh' || t === 'gaussian' || t === 'video' || t === 'audio' ? t : undefined;
}

export function isAssetDebugVisualEnabled(state: State): boolean {
    return !!(state.editMode && state.editLeftModule === 'asset' && state.previewMode !== true);
}

export function isAnnotationDebugVisualEnabled(state: State): boolean {
    return !!(state.editMode && state.editLeftModule === 'annotation' && state.previewMode !== true);
}

export function isEnvironmentDebugVisualEnabled(state: State): boolean {
    return !!(state.editMode && state.editLeftModule === 'environment' && state.previewMode !== true);
}
