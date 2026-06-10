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

/** Viewer 浏览或编辑预览（与 media 热区 `isMediaConsumptionMode` 判定一致） */
export function isViewerOrPreviewMode(state: State): boolean {
    return !state.editMode || state.previewMode === true;
}

/** Viewer / 编辑预览：场景单击仅上报拾取事件，不走放置、Gizmo、相机聚焦等编辑侧效 */
export function isAssetScenePickEventOnlyMode(state: State): boolean {
    return isViewerOrPreviewMode(state);
}

/** 资产模块下由 `MORPH_ASSET_ADD_START` 开启的 Gaussian 拾取模式（与常规资产选中并存于 asset 域） */
export function isMorphAssetAddPickMode(state: State): boolean {
    return !!(
        state.editMode
        && state.editLeftModule === 'asset'
        && state.morphAssetAddActive
    );
}

/** Viewer / 编辑预览下允许场景拾取上报的资产类型（暂不含 image / video / audio） */
export function isSceneAssetPickableInViewerMode(assetType: AssetLibraryType | undefined): boolean {
    return assetType === 'mesh' || assetType === 'gaussian';
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

export function isCameraInteractionBlocked(state: State): boolean {
    return state.cameraControlsEnabled === false || state.loadingCameraControlsLocked === true;
}
