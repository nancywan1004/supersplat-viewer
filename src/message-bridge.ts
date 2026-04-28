/**
 * 父级↔Viewer 统一 postMessage 协议桥接
 * 事件名与 payload 以 docs/SaaS第三期 编辑模式交互职责划分.md 为准
 */

import { Global } from './types';
import type { AssetLibraryItem } from './types';
import type { EditLeftModule } from './types';
import type { AnnotationData } from './annotation-toolbar/types';
import {
    serializeExperienceSettings,
    getComparableSettingsString,
    getComparableSettingsStringFromSnapshot,
    applySettingsSnapshot
} from './settings-serialize/settings-serialize';
import {
    requestSceneAssetsRestore
} from './asset-placement-handler';
import {
    initEditHistory,
    canUndo,
    canRedo,
    restoreAnnotationsFromSettings,
    restoreLightingFromSettings,
    restorePostEffectsFromSettings
} from './edit-history';
import type { ExperienceSettings } from './schemas/v2';
import { DEFAULT_VFX_TOTAL_DURATION } from './schemas/v2-custom';
import type { CommandRegistry } from './editor-modules/command-registry';
import { uploadProjectData } from './universe/service';

/** 父级 → Viewer 的 postMessage payload 类型（按文档事件表） */
type InboundPayload =
    | { type: 'CAMERA_MODE_SWITCH'; value?: 'orbit' | 'fly' }
    | { type: 'CAMERA_RESET' }
    | { type: 'SKYBOX_SWITCH'; value?: string }
    | { type: 'ANIMATION_RESET' }
    | { type: 'ANIMATION_PLAY_PAUSE' }
    | { type: 'EDIT_MODE_SET'; value?: boolean }
    | { type: 'EDIT_MODE_EXIT_REQUEST' }
    | { type: 'EDIT_MODE_EXIT_DISCARD' }
    | { type: 'EDIT_UNDO' }
    | { type: 'EDIT_REDO' }
    | { type: 'PREVIEW_MODE_SET'; value?: boolean }
    | { type: 'SETTINGS_SAVE' }
    | { type: 'EDIT_MODULE_SET'; value?: EditLeftModule | null }
    | { type: 'ASSET_SHOW_HIDE_SET'; id?: string; value?: boolean }
    | { type: 'ASSETS_SHOW_HIDE_SET'; value?: boolean }
    | { type: 'ASSET_PLACE'; value?: AssetLibraryItem }
    | { type: 'ASSET_SELECT'; id?: string | null }
    | { type: 'ASSET_COPY'; id?: string; copyId?: string }
    | { type: 'ASSET_DELETE'; id?: string }
    | { type: 'ASSET_TRANSFORM_MODE'; value?: 'move' | 'rotate' | 'scale' }
    | { type: 'ANNOTATION_PLACEMENT_START'; id?: string }
    | { type: 'ANNOTATION_PLACEMENT_CANCEL' }
    | { type: 'ANNOTATION_CONFIRM'; id?: string; value?: Partial<AnnotationData> }
    | { type: 'ANNOTATION_UPDATE'; id?: string; value?: Partial<AnnotationData> }
    | { type: 'ANNOTATION_DELETE'; id?: string }
    | { type: 'ANNOTATION_EDIT'; id?: string }
    | { type: 'ANNOTATION_TRANSFORM_MODE'; value?: 'move' | null }
    | { type: 'LIGHT_GLOBAL_SET'; value?: number }
    | { type: 'LIGHT_ADD'; id?: string; isThreeSixty?: boolean; name?: string }
    | { type: 'LIGHT_COPY'; id?: string; copyId?: string; copyName?: string }
    | { type: 'LIGHT_DELETE'; id?: string }
    | { type: 'LIGHT_TOGGLE_ALL'; value?: boolean }
    | { type: 'LIGHT_TOGGLE'; id?: string; value?: boolean }
    | { type: 'LIGHT_SELECT'; id?: string | null }
    | { type: 'LIGHT_TRANSFORM_MODE'; value?: 'move' | 'rotate' | null }
    | { type: 'LIGHT_INTENSITY_UPDATE'; id?: string; value?: number }
    | { type: 'LIGHT_COLOR_UPDATE'; id?: string; value?: number[] }
    | { type: 'LIGHT_INNER_ANGLE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_OUTER_ANGLE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_RANGE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_UPDATE'; id?: string; value?: { name?: string } }
    | { type: 'LIGHT_BRUSH_INTENSITY_UPDATE'; id?: string; value?: number }
    | { type: 'LIGHT_BRUSH_INNER_ANGLE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_BRUSH_OUTER_ANGLE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_BRUSH_RANGE_SET'; id?: string; value?: number }
    | { type: 'LIGHT_BRUSH_START' }
    | { type: 'LIGHT_ERASER_START' }
    | { type: 'LIGHT_BRUSH_CLEAR' }
    | { type: 'LIGHT_BRUSH_COLOR_UPDATE'; id?: string; value?: { tintColor?: number[]; tintBlend?: number } }
    | { type: 'LIGHT_BRUSH_FINISH'; id?: string; skipAutoLinkedLight?: boolean }
    | { type: 'LIGHT_BRUSH_DELETE'; id?: string }
    | { type: 'LIGHT_BRUSH_BLOOM_UPDATE'; value?: number }
    | { type: 'BLOOM_INTENSITY_UPDATE'; value?: number }
    | { type: 'BLOOM_THRESHOLD_UPDATE'; value?: number }
    | { type: 'BLOOM_BLUR_SET'; value?: number }
    | { type: 'BLOOM_IS_LOCAL_SET'; value?: boolean }
    | { type: 'SHADOW_SET'; value?: boolean }
    | { type: 'SHADOW_INTENSITY_UPDATE'; value?: number }
    | { type: 'SHADOW_DIRECTION_SET'; value?: number }
    | { type: 'VFX_TYPE_SET'; value?: string }
    | { type: 'VFX_EXIT' }
    | { type: 'VFX_RESTART'; restartAnim?: boolean }
    | { type: 'VIDEO_EXPORT_START'; includeVfx?: boolean }
    | { type: 'VIDEO_EXPORT_CANCEL' };

const postToParent = (type: string, data?: Record<string, unknown>) => {
    window.parent.postMessage(data ? { type, ...data } : { type }, '*');
    console.log('[MessageBridge] postToParent', type, data);
};

type SelectionSource = 'host' | 'scene' | 'unknown';

/** 编辑协议经 CommandRegistry → Facade 单路径；须在 Viewer 构造（注册 registry）之后再挂载 message 监听。 */
const editRegistry = (g: Global): CommandRegistry => {
    const r = (g as unknown as { __commandRegistry?: CommandRegistry }).__commandRegistry;
    if (!r) {
        throw new Error(
            '[MessageBridge] CommandRegistry 未初始化：请保证 initPostMessageBridge 在 Viewer 构造完成之后调用。'
        );
    }
    return r;
};

const HOST_CMD_SOURCE = 'host' as SelectionSource;

/** 父级协议 → registry → 各模块 facade；与 `editRegistry` 同级，统一 `source: host`。 */
const dispatchAsset = (g: Global, cmdType: string, payload?: unknown) => {
    editRegistry(g).dispatch({
        module: 'asset',
        command:
            payload === undefined
                ? { type: cmdType, source: HOST_CMD_SOURCE }
                : { type: cmdType, payload, source: HOST_CMD_SOURCE }
    });
};

const dispatchAnnotation = (g: Global, cmdType: string, payload?: unknown) => {
    editRegistry(g).dispatch({
        module: 'annotation',
        command:
            payload === undefined
                ? { type: cmdType, source: HOST_CMD_SOURCE }
                : { type: cmdType, payload, source: HOST_CMD_SOURCE }
    });
};

const dispatchEnvironment = (g: Global, cmdType: string, payload: Record<string, unknown>) => {
    editRegistry(g).dispatch({
        module: 'environment',
        command: { type: cmdType, payload, source: HOST_CMD_SOURCE }
    });
};

const dispatchEffects = (g: Global, cmdType: string, payload?: unknown) => {
    editRegistry(g).dispatch({
        module: 'effects',
        command:
            payload === undefined
                ? { type: cmdType, source: HOST_CMD_SOURCE }
                : { type: cmdType, payload, source: HOST_CMD_SOURCE }
    });
};

const initPostMessageBridge = (global: Global) => {
    const { state, events, config } = global;
    const g = global as any;
    let cameraModeChangeSource: SelectionSource = 'unknown';
    // 用闭包变量记录本次导出是否被外部取消，避免向 global.state（可能是 Proxy）新增属性
    let videoExportCancelled = false;

    // 退出编辑模式时用于比较与回退的基线（与 ui 内逻辑一致，供 postMessage 协议使用）
    let editModeBaselineData: ExperienceSettings | null = null;
    let editModeBaselineString: string | null = null;

    const setBaseline = (snapshot?: ExperienceSettings) => {
        const currentSnapshot = snapshot ?? serializeExperienceSettings(global);
        editModeBaselineData = JSON.parse(JSON.stringify(currentSnapshot)) as ExperienceSettings;
        editModeBaselineString = getComparableSettingsStringFromSnapshot(currentSnapshot);
    };

    const handleMessage = async (event: MessageEvent) => {
        const payload = event.data as InboundPayload;
        if (!payload?.type) return;

        const p = payload as Record<string, unknown>;
        const type = payload.type;

        switch (type) {
        case 'CAMERA_MODE_SWITCH':
            if (p.value === 'orbit' || p.value === 'fly') {
                if (state.cameraMode === p.value) break;
                cameraModeChangeSource = 'host';
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
        case 'EDIT_MODE_SET': {
            const value = p.value === true;
            if (value && config.allowEditMode === false) break;
            if (value) {
                editModeBaselineString = null;
                // 进入编辑统一停播当前 VFX（timed / persistent 一致），并在退出编辑后恢复。
                const hasVfxToResume = state.vfxType !== 'none';
                if (hasVfxToResume) {
                    events.fire('vfxExit');
                }
                // View -> Edit：先恢复到原始配置（View 模式的临时修改不保留）
                const originalSettings = (global as any).__originalSettings as ExperienceSettings | undefined;
                if (originalSettings) {
                    // 立即设置基线（使用原始配置，确保用户快速退出也能正确恢复）
                    editModeBaselineData = JSON.parse(JSON.stringify(originalSettings)) as ExperienceSettings;

                    applySettingsSnapshot(global, JSON.parse(JSON.stringify(originalSettings)) as ExperienceSettings);
                    await requestSceneAssetsRestore(global, { reason: 'edit-enter' });
                    restoreAnnotationsFromSettings(global);
                    restoreLightingFromSettings(global);
                    restorePostEffectsFromSettings(global);
                }
            }
            state.editMode = !!p.value;
            if (value) {
                // 通过 EDIT_MODE_SET 进入编辑模式时：默认不选中任何模块（null）
                state.editLeftModule = null;
                events.fire('editLeftModule:changed', null);
                const initialSnapshot = serializeExperienceSettings(global);
                setBaseline(initialSnapshot);
                initEditHistory(global, initialSnapshot);
                if (config.trackEditHistory) {
                    postToParent('EDIT_HISTORY_STATE', { canUndo: canUndo(global), canRedo: canRedo(global) });
                }
            }
            break;
        }
        case 'EDIT_MODE_EXIT_REQUEST': {
            const needsSave = editModeBaselineString != null && getComparableSettingsString(global) !== editModeBaselineString;
            postToParent('EDIT_EXIT_NEEDS_SAVE', { value: needsSave });
            break;
        }
        case 'EDIT_MODE_EXIT_DISCARD': {
            if (editModeBaselineData) {
                applySettingsSnapshot(global, editModeBaselineData);
                await requestSceneAssetsRestore(global, { reason: 'edit-discard' });
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
        case 'PREVIEW_MODE_SET': {
            state.previewMode = p.value === true;
            break;
        }
        case 'SETTINGS_SAVE': {
            const serialized = serializeExperienceSettings(global);
            const jsonString = JSON.stringify(serialized, null, 2);
            const projectId = global.config.projectId;
            const token = global.config.token;
            const uploadResult = await uploadProjectData(projectId ?? '', token ?? '', jsonString);
            if (uploadResult.ok === false) {
                console.error('[MessageBridge] SETTINGS_SAVE 上传失败，已取消 SETTINGS_UPDATED 回传', uploadResult.message);
                postToParent('SETTINGS_SAVE_FAILED', { message: uploadResult.message });
                break;
            }
            postToParent('SETTINGS_UPDATED');
            setBaseline();
            break;
        }
        case 'EDIT_MODULE_SET':
            if (p.value == null) {
                state.editLeftModule = null;
                events.fire('editLeftModule:changed', null);
                break;
            }
            if (typeof p.value === 'string') {
                const valid: EditLeftModule[] = ['gs', 'asset', 'annotation', 'environment', 'camera', 'effects'];
                if (valid.includes(p.value as EditLeftModule)) {
                    state.editLeftModule = p.value as EditLeftModule;
                    events.fire('editLeftModule:changed', p.value);
                }
            }
            break;
        case 'ASSET_PLACE':
            if (p.value && typeof p.value === 'object') {
                const placeValue = p.value as AssetLibraryItem;
                dispatchAsset(global, 'ASSET_PLACE', { value: placeValue });
            }
            break;
        case 'ASSET_SHOW_HIDE_SET':
            if (
                Array.isArray(state.scenePlacedEntities) &&
                typeof p.id === 'string' &&
                typeof p.value === 'boolean'
            ) {
                dispatchAsset(global, 'ASSET_SHOW_HIDE_SET', { id: p.id, value: p.value });
            }
            break;
        case 'ASSETS_SHOW_HIDE_SET':
            if (typeof p.value === 'boolean' && Array.isArray(state.scenePlacedEntities)) {
                dispatchAsset(global, 'ASSETS_SHOW_HIDE_SET', { value: p.value });
            }
            break;
        case 'ASSET_SELECT':
        {
            const targetId = (p.id !== undefined ? p.id : null) as string | null;
            dispatchAsset(global, 'ASSET_SELECT', { id: targetId });
            const resolvedId = state.selectedSceneEntityId;
            const requested = typeof targetId === 'string' && targetId.trim().length > 0 ? targetId : null;
            const resolvedEntry =
                typeof resolvedId === 'string'
                    ? state.scenePlacedEntities?.find((it) => it?.id === resolvedId) ?? null
                    : null;
            const matchedRequested =
                !!resolvedEntry &&
                !!requested &&
                resolvedEntry.id === requested;
            // 仅在“请求 id 成功命中场景实例”时触发 frame；未命中时不飞。
            if (state.editMode && matchedRequested) {
                events.fire('inputEvent', 'frame', { focusTarget: 'asset' as const });
            }
            break;
        }
        case 'ASSET_COPY':
            if (
                typeof p.id === 'string' &&
                typeof p.copyId === 'string' &&
                p.copyId.trim().length > 0
            ) {
                dispatchAsset(global, 'ASSET_COPY', { id: p.id, copyId: p.copyId });
            }
            break;
        case 'ASSET_DELETE':
            if (typeof p.id === 'string') {
                dispatchAsset(global, 'ASSET_DELETE', { id: p.id });
            }
            break;
        case 'ASSET_TRANSFORM_MODE': {
            dispatchAsset(global, 'ASSET_TRANSFORM_MODE', {
                value: p.value as 'move' | 'rotate' | 'scale' | undefined
            });
            break;
        }
        case 'ANNOTATION_PLACEMENT_START':
            if (typeof p.id === 'string') {
                dispatchAnnotation(global, 'ANNOTATION_PLACEMENT_START', { id: p.id });
            }
            break;
        case 'ANNOTATION_PLACEMENT_CANCEL': {
            dispatchAnnotation(global, 'ANNOTATION_PLACEMENT_CANCEL');
            break;
        }
        case 'ANNOTATION_CONFIRM': {
            const id = p.id as string | undefined;
            const value = p.value as Partial<AnnotationData> | undefined;
            if (!id) break;
            dispatchAnnotation(global, 'ANNOTATION_CONFIRM', { id, value });
            break;
        }
        case 'ANNOTATION_UPDATE': {
            const id = p.id as string | undefined;
            const value = p.value as Partial<AnnotationData> | undefined;
            if (!id || !value) break;
            dispatchAnnotation(global, 'ANNOTATION_UPDATE', { id, value });
            break;
        }
        case 'ANNOTATION_DELETE':
            if (typeof p.id === 'string') {
                dispatchAnnotation(global, 'ANNOTATION_DELETE', { id: p.id });
            }
            break;
        case 'ANNOTATION_EDIT': {
            const id = p.id as string | undefined;
            if (!id) break;
            dispatchAnnotation(global, 'ANNOTATION_EDIT', { id });
            break;
        }
        case 'ANNOTATION_TRANSFORM_MODE': {
            dispatchAnnotation(global, 'ANNOTATION_TRANSFORM_MODE', { value: p.value });
            break;
        }
        case 'LIGHT_GLOBAL_SET': {
            const lightGlobalVal = (p as { value?: number }).value;
            if (typeof lightGlobalVal === 'number') dispatchEnvironment(global, 'LIGHT_GLOBAL_SET', p);
            break;
        }
        case 'LIGHT_TOGGLE_ALL': {
            const v = (p as { value?: boolean }).value;
            if (typeof v === 'boolean') dispatchEnvironment(global, 'LIGHT_TOGGLE_ALL', p);
            break;
        }
        case 'LIGHT_TOGGLE': {
            const id = (p as { id?: string }).id;
            const v = (p as { value?: boolean }).value;
            if (typeof id === 'string' && typeof v === 'boolean') {
                dispatchEnvironment(global, 'LIGHT_TOGGLE', p);
            }
            break;
        }
        case 'BLOOM_INTENSITY_UPDATE':
        {
            const bloomIntVal = (p as { value?: number }).value;
            if (typeof bloomIntVal === 'number') dispatchEnvironment(global, 'BLOOM_INTENSITY_UPDATE', p);
            break;
        }
        case 'BLOOM_THRESHOLD_UPDATE': {
            const bloomThrVal = (p as { value?: number }).value;
            if (typeof bloomThrVal === 'number') dispatchEnvironment(global, 'BLOOM_THRESHOLD_UPDATE', p);
            break;
        }
        case 'BLOOM_BLUR_SET': {
            const bloomBlurVal = (p as { value?: number }).value;
            if (typeof bloomBlurVal === 'number') dispatchEnvironment(global, 'BLOOM_BLUR_SET', p);
            break;
        }
        case 'BLOOM_IS_LOCAL_SET': {
            const v = (p as { value?: boolean }).value;
            if (typeof v === 'boolean') dispatchEnvironment(global, 'BLOOM_IS_LOCAL_SET', p);
            break;
        }
        case 'SHADOW_SET': {
            const shadowVal = (p as { value?: boolean }).value;
            if (typeof shadowVal === 'boolean') dispatchEnvironment(global, 'SHADOW_SET', p);
            break;
        }
        case 'SHADOW_INTENSITY_UPDATE': {
            const shadowIntVal = (p as { value?: number }).value;
            if (typeof shadowIntVal === 'number') dispatchEnvironment(global, 'SHADOW_INTENSITY_UPDATE', p);
            break;
        }
        case 'SHADOW_DIRECTION_SET': {
            const shadowDirVal = (p as { value?: number }).value;
            if (typeof shadowDirVal === 'number') dispatchEnvironment(global, 'SHADOW_DIRECTION_SET', p);
            break;
        }
        case 'LIGHT_ADD':
            if (typeof p.id === 'string') {
                dispatchEnvironment(global, 'LIGHT_ADD', p);
            }
            break;
        case 'LIGHT_COPY':
            if (
                typeof p.id === 'string' &&
                typeof p.copyId === 'string' &&
                p.copyId.trim().length > 0
            ) {
                dispatchEnvironment(global, 'LIGHT_COPY', p);
            }
            break;
        case 'LIGHT_DELETE':
            if (typeof p.id === 'string') {
                dispatchEnvironment(global, 'LIGHT_DELETE', p);
            }
            break;
        case 'LIGHT_SELECT':
        {
            dispatchEnvironment(global, 'LIGHT_SELECT', p);
            break;
        }
        case 'LIGHT_TRANSFORM_MODE': {
            dispatchEnvironment(global, 'LIGHT_TRANSFORM_MODE', p);
            break;
        }
        case 'LIGHT_INTENSITY_UPDATE':
        case 'LIGHT_COLOR_UPDATE':
        case 'LIGHT_INNER_ANGLE_SET':
        case 'LIGHT_OUTER_ANGLE_SET':
        case 'LIGHT_RANGE_SET':
        case 'LIGHT_UPDATE':
            dispatchEnvironment(global, type, p);
            break;
        case 'LIGHT_BRUSH_DELETE':
            dispatchEnvironment(global, 'LIGHT_BRUSH_DELETE', p);
            break;
        case 'LIGHT_BRUSH_INTENSITY_UPDATE': {
            const v = (p as { value?: number }).value;
            if (typeof v === 'number') {
                dispatchEnvironment(global, 'LIGHT_BRUSH_INTENSITY_UPDATE', p);
            }
            break;
        }
        case 'LIGHT_BRUSH_INNER_ANGLE_SET': {
            const v = (p as { value?: number }).value;
            if (typeof v === 'number') {
                dispatchEnvironment(global, 'LIGHT_BRUSH_INNER_ANGLE_SET', p);
            }
            break;
        }
        case 'LIGHT_BRUSH_OUTER_ANGLE_SET': {
            const v = (p as { value?: number }).value;
            if (typeof v === 'number') {
                dispatchEnvironment(global, 'LIGHT_BRUSH_OUTER_ANGLE_SET', p);
            }
            break;
        }
        case 'LIGHT_BRUSH_RANGE_SET': {
            const v = (p as { value?: number }).value;
            if (typeof v === 'number') {
                dispatchEnvironment(global, 'LIGHT_BRUSH_RANGE_SET', p);
            }
            break;
        }
        case 'LIGHT_BRUSH_START':
        case 'LIGHT_ERASER_START':
        case 'LIGHT_BRUSH_CLEAR':
        case 'LIGHT_BRUSH_COLOR_UPDATE':
        case 'LIGHT_BRUSH_FINISH':
        case 'LIGHT_BRUSH_BLOOM_UPDATE':
            dispatchEnvironment(global, type, p);
            break;
        case 'VFX_TYPE_SET':
            if (typeof p.value === 'string') {
                dispatchEffects(global, 'VFX_TYPE_SET', p.value);
            }
            break;
        case 'VFX_EXIT': {
            dispatchEffects(global, 'VFX_EXIT');
            break;
        }
        case 'VFX_RESTART': {
            dispatchEffects(global, 'VFX_RESTART', { restartAnim: (p as any).restartAnim });
            break;
        }
        case 'VIDEO_EXPORT_START': {
            console.log('[MessageBridge] VIDEO_EXPORT_START → start export pipeline', {
                includeVfx: (p as any).includeVfx !== false
            });
            const includeVfx = (p as any).includeVfx !== false;
            const resolution = { width: 1920, height: 1080 };
            const width = resolution.width % 2 === 0 ? resolution.width : resolution.width - 1;
            const height = resolution.height % 2 === 0 ? resolution.height : resolution.height - 1;
            // 默认导出时长：VFX 总时长为下限；animTrack 更长则用 animTrack，更短则仍导出满 VFX totalDuration
            const vfxDuration = global.settings?.revealEffect?.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
            const animDuration = (global.state as any).animationDuration as number | undefined;
            const hasAnim =
                typeof animDuration === 'number' && Number.isFinite(animDuration) && animDuration > 0;
            const totalDuration = hasAnim ? Math.max(animDuration, vfxDuration) : vfxDuration;
            const videoSettings = {
                startFrame: 0,
                endFrame: 0,
                frameRate: 30,
                width,
                height,
                bitrate: 5_000_000,
                transparentBg: false,
                showDebug: false,
                // 协议默认走“极速导出 MP4”（实时渲染 + WebCodecs 编码）
                format: 'mp4' as const,
                codec: 'h264' as const,
                // 导出默认重启 animTrack
                syncAnimTrack: true,
                totalDuration,
                includeVfx,
                useFastExport: true
            };
            // 有 File System Access API 时先选保存路径；否则走无 fileStream 导出，由 video-export 在 finalize 后触发浏览器下载
            if (!('showSaveFilePicker' in window)) {
                console.warn('[MessageBridge] showSaveFilePicker unavailable, export will use in-memory encode + download');
                events.fire('render.video', videoSettings);
                break;
            }
            try {
                const handle = await (window as any).showSaveFilePicker({
                    types: [{ description: 'MP4 Video', accept: { 'video/mp4': ['.mp4'] } }],
                    suggestedName: 'vfx-timeline.mp4'
                });
                const fileStream = await handle.createWritable();
                events.fire('render.video', videoSettings, fileStream as any);
            } catch {
                console.log('file picker failed, auto export');
                events.fire('render.video', videoSettings);
                // console.log('[MessageBridge] file picker cancelled or denied');
                // postToParent('VIDEO_EXPORT_CANCELLED');
            }
            break;
        }
        case 'VIDEO_EXPORT_CANCEL': {
            // 停止当前导出（优先用于快速导出 MediaRecorder）
            // 注意：真正的“导出完成”仍由 Viewer 在 progressEnd 时 postToParent('VIDEO_EXPORT_END') 上报父级
            videoExportCancelled = true;
            events.fire('render.video.stop');
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
            const source = cameraModeChangeSource;
            cameraModeChangeSource = 'scene';
            if (source === 'host') {
                return;
            }
            postToParent('CAMERA_MODE_CHANGED', { value, source: 'scene' });
        }
    });

    events.on('firstFrame', async () => {
        postToParent('VIEWER_READY');
        const { canUndo, canRedo } = await import('./edit-history');
        if (config.trackEditHistory) {
            postToParent('EDIT_HISTORY_STATE', { canUndo: canUndo(global), canRedo: canRedo(global) });
        }
    });

    events.on('editHistory:stateChanged', (data: { canUndo: boolean; canRedo: boolean }) => {
        if (config.trackEditHistory) {
            postToParent('EDIT_HISTORY_STATE', { canUndo: data.canUndo, canRedo: data.canRedo });
        }
    });

    events.on('sceneAsset:selected', (data?: { source?: SelectionSource }) => {
        const source = data?.source ?? 'unknown';
        if (source !== 'scene') return;
        const id = state.selectedSceneEntityId ?? null;
        postToParent('SCENE_ASSET_SELECTED', { id });
    });

    events.on('sceneAsset:placed', (data?: { id?: string | null; source?: SelectionSource }) => {
        const source = data?.source ?? 'unknown';
        if (source !== 'scene') return;
        const id = typeof data?.id === 'string' ? data.id : null;
        if (!id) return;
        postToParent('SCENE_ASSET_PLACED', { id });
    });

    events.on('sceneLight:selected', (data: { id: string | null; source?: SelectionSource }) => {
        const source = data?.source ?? 'unknown';
        if (source !== 'scene') return;
        const id = data.id ?? null;
        postToParent('SCENE_LIGHT_SELECTED', { id });
    });

    events.on('sceneLight:placed', (data?: { id?: string | null; source?: SelectionSource }) => {
        const source = data?.source ?? 'unknown';
        if (source !== 'scene') return;
        const id = typeof data?.id === 'string' ? data.id : null;
        if (!id) return;
        postToParent('SCENE_LIGHT_PLACED', { id });
    });

    events.on('annotation:selected', (data: { id: string; source?: SelectionSource }) => {
        const source = data?.source ?? 'unknown';
        if (source !== 'scene') return;
        const id = data.id;
        postToParent('SCENE_ANNOTATION_SELECTED', { id });
    });

    // 统一上报“进入标注编辑”并附带初始化数据（不区分选中来源）
    events.on('annotationEdit:show', () => {
        const selected = g.annotationManager?.getSelectedAnnotation?.();
        const serialized = selected?.serialize?.();
        if (!serialized?.id) return;
        postToParent('SCENE_ANNOTATION_EDIT_START', {
            id: serialized.id,
            value: {
                title: serialized.title ?? '',
                text: serialized.text ?? '',
                imageUrl: serialized.imageUrl,
                showTitleWhenCollapsed: serialized.showTitleWhenCollapsed ?? false
            }
        });
    });

    // 导出取消通知：避免依赖往 global.state 写入临时属性（state 可能是 Proxy）
    events.on('videoExport:cancelled', () => {
        videoExportCancelled = true;
    });

    events.on('progressEnd', () => {
        if (videoExportCancelled) {
            postToParent('VIDEO_EXPORT_CANCELLED');
        } else {
            postToParent('VIDEO_EXPORT_END');
        }
        videoExportCancelled = false;
    });

    events.on('progressStart', () => {
        // 开始导出：默认认为走“结束”，除非后续收到取消
        videoExportCancelled = false;
        postToParent('VIDEO_EXPORT_STARTED');
    });
};

export { initPostMessageBridge };
