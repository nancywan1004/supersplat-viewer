/**
 * 父级↔Viewer 统一 postMessage 协议桥接
 * 事件名与 payload 以 docs/SaaS第三期 编辑模式交互职责划分.md 为准
 */

import { Global } from './types';
import type { AssetLibraryItem } from './types';
import type { EditLeftModule } from './types';
import type { AnnotationData } from './annotation-toolbar/types';
import { getPositionInFrontOfCamera } from './asset-placement-handler';
import {
    serializeExperienceSettings,
    getComparableSettingsString,
    applySettingsSnapshot
} from './settings-serialize';
import {
    clearScenePlacedEntities,
    restoreSceneAssetsFromSettings
} from './asset-placement-handler';
import {
    restoreAnnotationsFromSettings,
    restoreLightingFromSettings,
    restorePostEffectsFromSettings
} from './edit-history';
import type { ExperienceSettings } from './schemas/v2';
import {
    applyLightGlobalSet,
    applyLightAdd,
    applyLightSelect,
    applyLightDetail,
    applyLightToggleAll,
    applyLightToggle,
    applyBloomIntensityUpdate,
    applyBloomThresholdUpdate,
    applyBloomBlurSet,
    applyBloomIsLocalSet,
    applyBloomLocalLightRegionDelete,
    applyBloomLocalLightRegionIntensityUpdate,
    applyBloomLocalLightRegionInnerAngleSet,
    applyBloomLocalLightRegionOuterAngleSet,
    applyShadowSet,
    applyShadowIntensityUpdate,
    applyVfxTypeSet,
    applyVfxExit
} from './protocol-settings-adapter';

/** 父级 → Viewer 的 postMessage payload 类型（按文档事件表） */
type InboundPayload =
    | { type: 'CAMERA_MODE_SWITCH'; value?: 'orbit' | 'fly' }
    | { type: 'CAMERA_RESET' }
    | { type: 'SKYBOX_SWITCH'; value?: string }
    | { type: 'ANIMATION_RESET' }
    | { type: 'ANIMATION_PLAY_PAUSE' }
    | { type: 'EDIT_MODE_ENTER' }
    | { type: 'EDIT_MODE_EXIT' }
    | { type: 'EDIT_MODE_SET'; value?: boolean }
    | { type: 'EDIT_MODE_EXIT_REQUEST' }
    | { type: 'EDIT_MODE_EXIT_DISCARD' }
    | { type: 'EDIT_UNDO' }
    | { type: 'EDIT_REDO' }
    | { type: 'SETTINGS_SAVE' }
    | { type: 'EDIT_MODULE_SET'; value?: EditLeftModule }
    | { type: 'ASSET_SHOW_HIDE_SET'; value?: boolean }
    | { type: 'ASSET_PLACE'; value?: AssetLibraryItem }
    | { type: 'ASSET_SELECT'; id?: string | null }
    | { type: 'ASSET_COPY'; id?: string }
    | { type: 'ASSET_DELETE'; id?: string }
    | { type: 'ASSET_TRANSFORM_MODE'; value?: 'move' | 'rotate' | 'scale' }
    | { type: 'ANNOTATION_PLACEMENT_START'; id?: string }
    | { type: 'ANNOTATION_PLACEMENT_CANCEL' }
    | { type: 'ANNOTATION_CONFIRM'; id?: string; value?: Partial<AnnotationData> }
    | { type: 'ANNOTATION_DELETE'; id?: string }
    | { type: 'ANNOTATION_EDIT'; id?: string }
    | { type: 'ANNOTATION_TRANSFORM_MODE'; value?: 'move' | null }
    | { type: 'LIGHT_GLOBAL_SET'; value?: number }
    | { type: 'LIGHT_ADD'; id?: string }
    | { type: 'LIGHT_TOGGLE_ALL'; value?: boolean }
    | { type: 'LIGHT_TOGGLE'; id?: string; value?: boolean }
    | { type: 'LIGHT_SELECT'; id?: string | null }
    | { type: 'LIGHT_INTENSITY_UPDATE'; id?: string; value?: number }
    | { type: 'LIGHT_COLOR_UPDATE'; id?: string; value?: number[] }
    | { type: 'LIGHT_INNER_ANGLE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_OUTER_ANGLE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_RANGE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_BRUSH_INTENSITY_UPDATE'; id?: string; value?: number }
    | { type: 'LIGHT_BRUSH_INNER_ANGLE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_BRUSH_OUTER_ANGLE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_BRUSH_START' }
    | { type: 'LIGHT_ERASER_START' }
    | { type: 'LIGHT_BRUSH_CLEAR' }
    | { type: 'LIGHT_BRUSH_COLOR_UPDATE'; id?: string; value?: { tintColor?: number[]; tintBlend?: number } }
    | { type: 'LIGHT_BRUSH_FINISH' }
    | { type: 'LIGHT_BRUSH_DELETE'; id?: string }
    | { type: 'LIGHT_BRUSH_BLOOM_UPDATE'; value?: number }
    | { type: 'BLOOM_INTENSITY_UPDATE'; value?: number }
    | { type: 'BLOOM_THRESHOLD_UPDATE'; value?: number }
    | { type: 'BLOOM_BLUR_SET'; value?: number }
    | { type: 'BLOOM_IS_LOCAL_SET'; value?: boolean }
    | { type: 'SHADOW_SET'; value?: boolean }
    | { type: 'SHADOW_INTENSITY_UPDATE'; value?: number }
    | { type: 'VFX_TYPE_SET'; value?: string }
    | { type: 'VFX_EXIT' }
    | { type: 'VFX_RESTART'; restartAnim?: boolean }
    | { type: 'VIDEO_EXPORT_START'; includeVfx?: boolean };

const postToParent = (type: string, payload?: object) => {
    window.parent.postMessage(payload !== undefined ? { type, payload } : { type }, '*');
    console.log('[MessageBridge] postToParent', type, payload);
};

const initPostMessageBridge = (global: Global) => {
    const { state, events, config } = global;
    const g = global as any;

    // 退出编辑模式时用于比较与回退的基线（与 ui 内逻辑一致，供 postMessage 协议使用）
    let editModeBaselineData: ExperienceSettings | null = null;
    let editModeBaselineString: string | null = null;

    const setBaseline = () => {
        editModeBaselineData = JSON.parse(JSON.stringify(serializeExperienceSettings(global))) as ExperienceSettings;
        editModeBaselineString = getComparableSettingsString(global);
    };

    const handleMessage = async (event: MessageEvent) => {
        const payload = event.data as InboundPayload;
        if (!payload?.type) return;

        const p = payload as Record<string, unknown>;
        const type = payload.type;

        switch (type) {
        case 'CAMERA_MODE_SWITCH':
            if (p.value === 'orbit' || p.value === 'fly') {
                state.cameraMode = p.value;
            }
            break;
        case 'CAMERA_RESET':
            events.fire('inputEvent', 'reset');
            break;
        case 'SKYBOX_SWITCH':
            if (typeof p.value === 'string') events.fire('skyboxSwitch', p.value);
            break;
        case 'ANIMATION_RESET':
            events.fire('inputEvent', 'resetAnim');
            break;
        case 'ANIMATION_PLAY_PAUSE':
            events.fire('inputEvent', 'playPause');
            break;
        case 'EDIT_MODE_ENTER':
            if (config.allowEditMode !== false) {
                state.editMode = true;
                // 父级触发进入编辑模式时，同样重置左侧模块为默认 asset
                state.editLeftModule = 'asset';
                events.fire('editLeftModule:changed', 'asset');
                setBaseline();
            }
            break;
        case 'EDIT_MODE_EXIT':
            state.editMode = false;
            break;
        case 'EDIT_MODE_SET': {
            const value = p.value === true;
            if (value && config.allowEditMode === false) break;
            state.editMode = !!p.value;
            if (value) {
                // 通过 EDIT_MODE_SET 进入编辑模式时，也重置左侧模块为默认 asset
                state.editLeftModule = 'asset';
                events.fire('editLeftModule:changed', 'asset');
                setBaseline();
                if (config.trackEditHistory) {
                    const { canUndo, canRedo } = await import('./edit-history');
                    postToParent('EDIT_HISTORY_STATE', { canUndo: canUndo(global), canRedo: canRedo(global) });
                }
            }
            break;
        }
        case 'EDIT_MODE_EXIT_REQUEST': {
            const needsSave = editModeBaselineString != null && getComparableSettingsString(global) !== editModeBaselineString;
            postToParent('EDIT_EXIT_NEEDS_SAVE', { needsSave });
            break;
        }
        case 'EDIT_MODE_EXIT_DISCARD': {
            if (editModeBaselineData) {
                applySettingsSnapshot(global, editModeBaselineData);
                clearScenePlacedEntities(global);
                await restoreSceneAssetsFromSettings(global);
                restoreAnnotationsFromSettings(global);
                // 统一通过 helper 按当前 settings 重置 Lighting / NightMode / PostEffect
                restoreLightingFromSettings(global);
                restorePostEffectsFromSettings(global);
            }
            state.editMode = false;
            break;
        }
        case 'EDIT_UNDO': {
            const { undo } = await import('./edit-history');
            await undo(global);
            break;
        }
        case 'EDIT_REDO': {
            const { redo } = await import('./edit-history');
            await redo(global);
            break;
        }
        case 'SETTINGS_SAVE': {
            const serialized = serializeExperienceSettings(global);
            const jsonString = JSON.stringify(serialized, null, 2);
            postToParent('SETTINGS_UPDATED', { payload: jsonString });
            setBaseline();
            break;
        }
        case 'EDIT_MODULE_SET':
            if (p.value != null && typeof p.value === 'string') {
                const valid: EditLeftModule[] = ['gs', 'asset', 'annotation', 'environment', 'camera', 'effects'];
                if (valid.includes(p.value as EditLeftModule)) {
                    state.editLeftModule = p.value as EditLeftModule;
                    events.fire('editLeftModule:changed', p.value);
                }
            }
            break;
        case 'ASSET_PLACE':
            if (p.value && typeof p.value === 'object') {
                const pos = getPositionInFrontOfCamera(global);
                let value: AssetLibraryItem | null = null;
                const incoming = p.value as { id?: string } & Partial<AssetLibraryItem>;
                if (incoming.id && Array.isArray(state.uploadedAssets)) {
                    value = (state.uploadedAssets as AssetLibraryItem[]).find((it) => it.id === incoming.id) ?? null;
                }
                // 回退：若未在 uploadedAssets 中找到，则直接使用 payload（兼容外部宿主仅传 url/name 等字段的情况）
                const finalValue = (value ?? (p.value as AssetLibraryItem));
                events.fire('assetPlacement:place', { value: finalValue });
            }
            break;
        case 'ASSET_SHOW_HIDE_SET':
            if (typeof p.value === 'boolean' && Array.isArray(state.scenePlacedEntities)) {
                const visible = p.value;
                state.scenePlacedEntities.forEach((item: any) => {
                    if (item && item.entity) {
                        item.visible = visible;
                        item.entity.enabled = visible;
                    }
                });
            }
            break;
        case 'ASSET_SELECT':
            state.selectedSceneEntityId = (p.id !== undefined ? p.id : null) as string | null;
            events.fire('sceneAsset:selected');
            break;
        case 'ASSET_COPY':
            if (typeof p.id === 'string') {
                state.selectedSceneEntityId = p.id;
                events.fire('sceneAsset:selected');
                events.fire('assetEdit:copy');
            }
            break;
        case 'ASSET_DELETE':
            if (typeof p.id === 'string') {
                state.selectedSceneEntityId = p.id;
                events.fire('sceneAsset:selected');
                events.fire('assetEdit:delete');
            }
            break;
        case 'ASSET_TRANSFORM_MODE':
            if (p.value === 'move' || p.value === 'rotate' || p.value === 'scale') {
                state.assetTransformMode = p.value;
                events.fire('assetTransformMode:changed', p.value);
            } else {
                // 未传 value 或非合法值：清除模式，隐藏 Gizmo
                state.assetTransformMode = undefined;
                events.fire('assetTransformMode:changed', undefined as any);
            }
            break;
        case 'ANNOTATION_PLACEMENT_START':
            if (typeof p.id === 'string') {
                const am = g.annotationManager;
                if (am?.startPlacementWithId) am.startPlacementWithId(p.id);
            }
            break;
        case 'ANNOTATION_PLACEMENT_CANCEL': {
            const am = g.annotationManager;
            if (am?.cancelAnnotation) am.cancelAnnotation();
            break;
        }
        case 'ANNOTATION_CONFIRM': {
            const am = g.annotationManager;
            if (!am) break;
            const id = p.id as string | undefined;
            const value = p.value as Partial<AnnotationData> | undefined;
            if (!id) break;
            const formData = value
                ? {
                    title: value.title ?? '',
                    text: value.text ?? '',
                    imageUrl: value.imageUrl,
                    showTitleWhenCollapsed: value.showTitleWhenCollapsed ?? false
                }
                : { title: '', text: '', showTitleWhenCollapsed: false };
            const placeholder = am.getPlaceholderAnnotation?.();
            if (placeholder && placeholder.id === id) {
                am.confirmAnnotation(formData);
            } else {
                am.updateAnnotation(id, formData);
            }
            break;
        }
        case 'ANNOTATION_DELETE':
            if (typeof p.id === 'string') {
                const am = g.annotationManager;
                if (am?.deleteAnnotation) am.deleteAnnotation(p.id);
            }
            break;
        case 'ANNOTATION_EDIT': {
            const am = g.annotationManager;
            if (!am) break;
            const id = p.id as string | undefined;
            if (!id) break;
            if (am.selectAnnotation) {
                am.selectAnnotation(id, { showGizmo: false });
            }
            // 触发内部 UI 显示编辑表单（annotation-ui 中监听 annotationEdit:show）
            events.fire('annotationEdit:show');
            break;
        }
        case 'ANNOTATION_TRANSFORM_MODE': {
            const am = g.annotationManager;
            if (!am) break;
            const mode = p.value === 'move' ? 'move' : null;
            if (mode === 'move') {
                if (am.enableGizmoForSelected) {
                    am.enableGizmoForSelected();
                }
            } else if (am.disableGizmoForSelected) {
                am.disableGizmoForSelected();
            }
            break;
        }
        case 'LIGHT_GLOBAL_SET': {
            const lightGlobalVal = (p as { value?: number }).value;
            if (typeof lightGlobalVal === 'number') applyLightGlobalSet(global, lightGlobalVal);
            break;
        }
        case 'LIGHT_TOGGLE_ALL': {
            const v = (p as { value?: boolean }).value;
            if (typeof v === 'boolean') {
                applyLightToggleAll(global, v);
            }
            break;
        }
        case 'LIGHT_TOGGLE': {
            const id = (p as { id?: string }).id;
            const v = (p as { value?: boolean }).value;
            if (typeof id === 'string' && typeof v === 'boolean') {
                applyLightToggle(global, id, v);
            }
            break;
        }
        case 'BLOOM_INTENSITY_UPDATE':
        {
            const bloomIntVal = (p as { value?: number }).value;
            if (typeof bloomIntVal === 'number') applyBloomIntensityUpdate(global, bloomIntVal);
            break;
        }
        case 'BLOOM_THRESHOLD_UPDATE': {
            const bloomThrVal = (p as { value?: number }).value;
            if (typeof bloomThrVal === 'number') applyBloomThresholdUpdate(global, bloomThrVal);
            break;
        }
        case 'BLOOM_BLUR_SET': {
            const bloomBlurVal = (p as { value?: number }).value;
            if (typeof bloomBlurVal === 'number') applyBloomBlurSet(global, bloomBlurVal);
            break;
        }
        case 'BLOOM_IS_LOCAL_SET': {
            const v = (p as { value?: boolean }).value;
            if (typeof v === 'boolean') applyBloomIsLocalSet(global, v);
            break;
        }
        case 'SHADOW_SET': {
            const shadowVal = (p as { value?: boolean }).value;
            if (typeof shadowVal === 'boolean') applyShadowSet(global, shadowVal);
            break;
        }
        case 'SHADOW_INTENSITY_UPDATE': {
            const shadowIntVal = (p as { value?: number }).value;
            if (typeof shadowIntVal === 'number') applyShadowIntensityUpdate(global, shadowIntVal);
            break;
        }
        case 'LIGHT_ADD':
            if (typeof p.id === 'string') applyLightAdd(global, p.id);
            break;
        case 'LIGHT_SELECT':
            applyLightSelect(global, (p.id !== undefined ? p.id : null) as string | null);
            break;
        case 'LIGHT_INTENSITY_UPDATE':
        case 'LIGHT_COLOR_UPDATE':
        case 'LIGHT_INNER_ANGLE_SET':
        case 'LIGHT_OUTER_ANGLE_SET':
        case 'LIGHT_RANGE_SET':
            applyLightDetail(global, type, payload as { id?: string; value?: number | number[] | boolean });
            break;
        case 'LIGHT_BRUSH_DELETE':
            applyBloomLocalLightRegionDelete(global, (p as { id?: string }).id ?? '');
            break;
        case 'LIGHT_BRUSH_INTENSITY_UPDATE': {
            const id = (p as { id?: string }).id ?? '';
            const v = (p as { value?: number }).value;
            if (typeof v === 'number') {
                applyBloomLocalLightRegionIntensityUpdate(global, id, v);
            }
            break;
        }
        case 'LIGHT_BRUSH_INNER_ANGLE_SET': {
            const id = (p as { id?: string }).id ?? '';
            const v = (p as { value?: number }).value;
            if (typeof v === 'number') {
                applyBloomLocalLightRegionInnerAngleSet(global, id, v);
            }
            break;
        }
        case 'LIGHT_BRUSH_OUTER_ANGLE_SET': {
            const id = (p as { id?: string }).id ?? '';
            const v = (p as { value?: number }).value;
            if (typeof v === 'number') {
                applyBloomLocalLightRegionOuterAngleSet(global, id, v);
            }
            break;
        }
        case 'LIGHT_BRUSH_START':
        case 'LIGHT_ERASER_START':
        case 'LIGHT_BRUSH_CLEAR':
        case 'LIGHT_BRUSH_COLOR_UPDATE':
        case 'LIGHT_BRUSH_FINISH':
        case 'LIGHT_BRUSH_BLOOM_UPDATE':
            // 笔刷协议映射到内部事件，由 vfx/bloom-brush 等处理
            events.fire('messageBridge:lightBrush', { type, payload: p });
            break;
        case 'VFX_TYPE_SET':
            if (typeof p.value === 'string') applyVfxTypeSet(global, p.value);
            break;
        case 'VFX_EXIT':
            applyVfxExit(global);
            break;
        case 'VFX_RESTART':
            events.fire('revealRestart', (p as any).restartAnim !== false);
            break;
        case 'VIDEO_EXPORT_START': {
            const includeVfx = (p as any).includeVfx !== false;
            const resolution = { width: 1920, height: 1080 };
            const width = resolution.width % 2 === 0 ? resolution.width : resolution.width - 1;
            const height = resolution.height % 2 === 0 ? resolution.height : resolution.height - 1;
            const totalDuration = global.settings?.revealEffect?.totalDuration ?? 20;
            const videoSettings = {
                startFrame: 0,
                endFrame: 0,
                frameRate: 30,
                width,
                height,
                bitrate: 8_000_000,
                transparentBg: false,
                showDebug: false,
                format: 'mp4' as const,
                codec: 'h264' as const,
                totalDuration,
                includeVfx
            };
            events.fire('render.video', videoSettings, undefined);
            break;
        }
        default:
            break;
        }
    };

    window.addEventListener('message', handleMessage);

    // ---------- Viewer → 父级 上报 ----------
    events.on('cameraMode:changed', (value: string, _prev: string) => {
        if (value === 'orbit' || value === 'fly') {
            postToParent('CAMERA_MODE_CHANGED', { value });
        }
    });

    events.on('firstFrame', async () => {
        postToParent('VIEWER_READY');
        const { canUndo, canRedo } = await import('./edit-history');
        if (config.trackEditHistory) {
            postToParent('EDIT_HISTORY_STATE', { canUndo: canUndo(global), canRedo: canRedo(global) });
        }
    });

    events.on('editMode:changed', (value: boolean) => {
        postToParent('EDIT_MODE_CHANGED', { value });
    });

    events.on('editHistory:stateChanged', (data: { canUndo: boolean; canRedo: boolean }) => {
        if (config.trackEditHistory) {
            postToParent('EDIT_HISTORY_STATE', { canUndo: data.canUndo, canRedo: data.canRedo });
        }
    });

    events.on('sceneAsset:selected', () => {
        const id = state.selectedSceneEntityId ?? null;
        postToParent('SCENE_ASSET_SELECTED', { id });
    });

    events.on('sceneLight:selected', (data: { id: string | null }) => {
        postToParent('SCENE_LIGHT_SELECTED', { id: data.id ?? null });
    });

    events.on('annotation:selected', (data: { id: string }) => {
        postToParent('SCENE_ANNOTATION_SELECTED', { id: data.id });
    });

    events.on('progressEnd', () => {
        postToParent('VIDEO_EXPORT_END');
    });
};

export { initPostMessageBridge };
