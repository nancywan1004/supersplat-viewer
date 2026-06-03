/**
 * 父级↔Viewer 统一 postMessage 协议桥接
 * 入站 `EFFECT_*`：`module` 可选；若传则须为 **`effects`**（与 {@link MESSAGE_BRIDGE_MODULE.effects} 一致）。`effectId` 与参数见 **docs/SaaS第四期编辑模式接口文档.md**。
 * 出站：与 **`editLeftModule`** 域相关的事件在 payload 中带 **`module`**（`asset` / `annotation` / `environment` / `camera` / `effects`），定义见 **`editor-modules/modules-types`** 中的 {@link MESSAGE_BRIDGE_MODULE}。
 */

import type { AnnotationData } from './annotation-toolbar/types';
import {
    applySceneAssetTriggerDistanceM,
    requestSceneAssetsRestore
} from './scene-assets/asset-placement-handler';
import {
    initEditHistory,
    canUndo,
    canRedo,
    restoreAnnotationsFromSettings,
    restoreLightingFromSettings,
    restorePostEffectsFromSettings,
    restoreSkyboxFromSettings
} from './edit-history';
import type { CommandRegistry } from './editor-modules/command-registry';
import { MESSAGE_BRIDGE_MODULE } from './editor-modules/modules-types';
import {
    normalizeAssetEffectEnvelope,
    type AssetEffectProtocolEnvelope
} from './editor-modules/protocol-adapters/asset-effects-protocol-adapter';
import {
    paramsPatchHasPersistentKeys,
    paramsPatchHasRevealKeys,
    isPersistentProtocolEffectId,
    SCENE_GSPLAT_REVEAL_EFFECT_ID
} from './editor-modules/protocol-adapters/effects-protocol-adapter';
import { getAssetLoader } from './loaders/asset-loader';
import { resolveExportTimelinePlan } from './render/export-timeline-resolver';
import { buildVideoExportFilename } from './render/video-export';
import type { ExperienceSettings, SceneMediaHotspotPatch, TorchLightSettings } from './schemas/v2';
import { DEFAULT_VFX_TOTAL_DURATION } from './schemas/v2-custom';
import { getRevealActiveType, getRevealTotalDuration } from './settings-serialize/effects-sync';
import {
    serializeExperienceSettings,
    getComparableSettingsString,
    getComparableSettingsStringFromSnapshot,
    applySettingsSnapshot
} from './settings-serialize/settings-serialize';
import {
    applySceneMediaHotspotBaselineFromView,
    patchSceneMediaHotspot
} from './settings-serialize/settings-serialize-helper';
import { applyViewMediaMuteSet } from './view-settings';
import { getSelectedSceneAssetType } from './state-selectors';
import type { AssetLibraryItem, EditLeftModule, Global } from './types';
import { paramsPatchHasAssetKeys } from './vfx/effects-runtime/asset/asset-effect-params';
import {
    ASSET_EFFECT_TYPES,
    ASSET_GSPLAT_EFFECT_ID,
    PERSISTENT_CAMERA_EFFECT_TYPES,
    PERSISTENT_STYLIZATION_EFFECT_TYPES,
    SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID,
    resolveAssetEffectType
} from './vfx/effects-runtime/effect-types';
import {
    captureDefaultViewAndStageThumbnail,
    persistExperienceSettingsToCloud
} from './render/project-thumbnail';
import { resetSceneSettings } from './settings-reset';
import type { SceneCollisionSettingsPatch } from './schemas/v2-custom';
import {
    applyCollisionPatchFromHost,
    applyCollisionSetFromHost,
    buildSceneMeshLoadFailedPayload,
    buildSceneMeshLoadFinishedPayload,
    resolveSceneMeshLoadOutboundModules
} from './editor-modules/protocol-adapters/collision-protocol-adapter';
import { applyShadowSetFromHost } from './editor-modules/protocol-adapters/environment-protocol-adapter';
import {
    COLLISION_SYSTEM_READY,
    type CollisionLoadPayload
} from './collision/camera-collision-manager';
import { resolveCollisionUrl } from './collision/scene-collision-source';
import { SHADOW_SYSTEM_READY, isShadowOutputEnabled } from './vfx/shadow';

/** 父级 → Viewer 的 postMessage payload 类型（按文档事件表） */
type InboundPayload =
    | { type: 'CAMERA_MODE_SWITCH'; value?: 'orbit' | 'fly' }
    | { type: 'CAMERA_RESET' }
    | { type: 'CAMERA_PITCH_RANGE_SET'; value?: [number, number] }
    | { type: 'SKYBOX_SET'; value?: string }
    | { type: 'ANIMATION_RESET' }
    | { type: 'ANIMATION_PLAY_PAUSE' }
    | { type: 'EDIT_MODE_SET'; value?: boolean }
    | { type: 'EDIT_MODE_EXIT_REQUEST' }
    | { type: 'EDIT_MODE_EXIT_DISCARD' }
    | { type: 'EDIT_UNDO' }
    | { type: 'EDIT_REDO' }
    | { type: 'PREVIEW_MODE_SET'; value?: boolean }
    | { type: 'MEDIA_HOTSPOT_SET'; value?: SceneMediaHotspotPatch }
    | { type: 'ASSET_MEDIA_HOTSPOT_BASELINE_SET'; id: string }
    | { type: 'ASSET_MEDIA_HOTSPOT_RANGE_SET'; id?: string; value?: number }
    | { type: 'VIEW_MEDIA_MUTE_SET'; value?: boolean }
    | { type: 'TORCH_TOGGLE'; value?: boolean }
    | { type: 'TORCH_PARAMS_SET'; value?: Partial<TorchLightSettings> }
    | { type: 'SETTINGS_SAVE' }
    | { type: 'SETTINGS_RESET' }
    | { type: 'EDIT_MODULE_SET'; value?: EditLeftModule | null }
    | { type: 'ASSET_SHOW_HIDE_SET'; id?: string; value?: boolean }
    | { type: 'ASSETS_SHOW_HIDE_SET'; value?: boolean }
    | { type: 'ASSET_PLACE'; value?: AssetLibraryItem }
    | { type: 'ASSET_SELECT'; id?: string | null }
    | { type: 'ASSET_COPY'; id?: string; copyId?: string }
    | { type: 'ASSET_DELETE'; id?: string }
    | { type: 'ASSET_TRANSFORM_MODE'; value?: 'move' | 'rotate' | 'scale' }
    | { type: 'ASSET_VIDEO_CURVATURE_SET'; id?: string; value?: number }
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
    | { type: 'LIGHT_REGION_UPDATE'; id?: string; value?: { name?: string } }
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
    | { type: 'EFFECT_PARAMS_PATCH'; module?: 'effects'; effectId: string; params?: Record<string, unknown>; targetId?: string }
    | { type: 'EFFECT_TOGGLE'; module?: 'effects'; effectId: string; params: Record<string, unknown> }
    | { type: 'EFFECT_REPLAY'; module?: 'effects'; effectId: string; restartAnim?: boolean }
    | { type: 'EFFECT_START'; module?: 'effects'; effectId: string; targetId: string; params?: Record<string, unknown> }
    | { type: 'EFFECT_STOP'; module?: 'effects'; effectId: string; targetId: string }
    | { type: 'EFFECT_ADD'; module?: 'effects'; effectId: string; effectType: string; targetId?: string; params?: Record<string, unknown> }
    | { type: 'EFFECT_DELETE'; module?: 'effects'; effectId: string; effectType?: string; targetId?: string }
    | { type: 'VIDEO_EXPORT_START'; includeVfx?: boolean; projectName?: string }
    | { type: 'VIDEO_EXPORT_CANCEL' }
    | { type: 'CAMERA_DEFAULT_VIEW_CAPTURE' }
    | { type: 'COLLISION_SET'; value?: boolean }
    | { type: 'COLLISION_PATCH'; value?: SceneCollisionSettingsPatch };

const postToParent = (type: string, data?: Record<string, unknown>) => {
    const message = (data ? { type, ...data } : { type }) as Record<string, unknown>;
    window.parent.postMessage(message, '*');
    // 与父级实际收到的 body 一致（避免只看 `data` 时与 `{ type, ...data }` 合并结果不一致）
    console.log('[MessageBridge] postToParent', message);
};

type SelectionSource = 'host' | 'scene' | 'unknown';

/**
 * 编辑协议经 CommandRegistry → Facade 单路径；须在 Viewer 构造（注册 registry）之后再挂载 message 监听。
 * @param g
 */
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

/**
 * 父级协议 → registry → 各模块 facade；与 `editRegistry` 同级，统一 `source: host`。
 * @param g
 * @param cmdType
 * @param payload
 */
const dispatchAsset = (g: Global, cmdType: string, payload?: unknown) => {
    editRegistry(g).dispatch({
        module: MESSAGE_BRIDGE_MODULE.asset,
        command:
            payload === undefined ?
                { type: cmdType, source: HOST_CMD_SOURCE } :
                { type: cmdType, payload, source: HOST_CMD_SOURCE }
    });
};

const dispatchAnnotation = (g: Global, cmdType: string, payload?: unknown) => {
    editRegistry(g).dispatch({
        module: MESSAGE_BRIDGE_MODULE.annotation,
        command:
            payload === undefined ?
                { type: cmdType, source: HOST_CMD_SOURCE } :
                { type: cmdType, payload, source: HOST_CMD_SOURCE }
    });
};

const dispatchEnvironment = (g: Global, cmdType: string, payload: Record<string, unknown>) => {
    editRegistry(g).dispatch({
        module: MESSAGE_BRIDGE_MODULE.environment,
        command: { type: cmdType, payload, source: HOST_CMD_SOURCE }
    });
};

const dispatchEffects = (g: Global, cmdType: string, payload?: unknown) => {
    editRegistry(g).dispatch({
        module: MESSAGE_BRIDGE_MODULE.effects,
        command:
            payload === undefined ?
                { type: cmdType, source: HOST_CMD_SOURCE } :
                { type: cmdType, payload, source: HOST_CMD_SOURCE }
    });
};

type NormalizedEffectParamsPatch = {
    params: Record<string, unknown>;
    enable?: boolean;
    isNewShape: boolean;
};

const EFFECT_PARAMS_LEGACY_KEYS = new Set(['type', 'effectId', 'enable', 'autoStart', 'effectParams']);
const MESSAGE_BRIDGE_STYLIZATION_EFFECT_TYPES = new Set(
    [...PERSISTENT_STYLIZATION_EFFECT_TYPES].filter(type => type !== 'perlin-wave')
);

/**
 * New host protocol:
 * params: { "<effect-type>": { enable?: boolean, ...effectParams } }
 * Internal adapters still consume { type, enabled, effectParams }, so normalize at the bridge boundary.
 * @param effectId - Protocol effect package id.
 * @param params - Incoming `EFFECT_PARAMS_PATCH.params`.
 * @returns Normalized params, or null when the new shape is malformed.
 */
function normalizeEffectParamsPatch(
    effectId: string,
    params: Record<string, unknown>
): NormalizedEffectParamsPatch | null {
    if (effectId !== ASSET_GSPLAT_EFFECT_ID && !ASSET_EFFECT_TYPES.has(effectId)) {
        return { params, isNewShape: false };
    }

    const entries = Object.entries(params).filter(([key]) => !EFFECT_PARAMS_LEGACY_KEYS.has(key));
    if (entries.length === 0) {
        return { params, isNewShape: false };
    }
    if (entries.length !== 1) {
        return null;
    }

    const [effectType, rawPatch] = entries[0]!;
    if (typeof rawPatch !== 'object' || rawPatch === null || Array.isArray(rawPatch)) {
        return null;
    }

    if ((effectId === ASSET_GSPLAT_EFFECT_ID || ASSET_EFFECT_TYPES.has(effectId)) && !ASSET_EFFECT_TYPES.has(effectType)) {
        return null;
    }
    if (
        effectId === SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID &&
        !PERSISTENT_CAMERA_EFFECT_TYPES.has(effectType)
    ) {
        return null;
    }
    if (
        effectId === SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID &&
        !MESSAGE_BRIDGE_STYLIZATION_EFFECT_TYPES.has(effectType)
    ) {
        return null;
    }

    const raw = rawPatch as Record<string, unknown>;
    const effectParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (key !== 'enable') {
            effectParams[key] = value;
        }
    }

    const normalized: Record<string, unknown> = { type: effectType };
    if (typeof raw.enable === 'boolean') {
        normalized.enable = raw.enable;
    }
    if (Object.keys(effectParams).length > 0) {
        normalized.effectParams = effectParams;
    }

    return {
        params: normalized,
        enable: typeof raw.enable === 'boolean' ? raw.enable : undefined,
        isNewShape: true
    };
}

const initPostMessageBridge = (global: Global) => {
    const { state, events, config } = global;
    const g = global as any;
    let cameraModeChangeSource: SelectionSource = 'unknown';
    /** 父级下发 COLLISION_* / SHADOW_SET 时置 true，屏蔽由此触发的 scene mesh / 系统就绪出站（防回环）。 */
    let suppressCollisionOutbound = false;
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
            case 'CAMERA_PITCH_RANGE_SET': {
                const raw = (p as { value?: unknown }).value;
                if (!Array.isArray(raw) || raw.length !== 2) {
                    console.warn('[MessageBridge] CAMERA_PITCH_RANGE_SET ignored: value must be [min, max]');
                    break;
                }
                const min = Number(raw[0]);
                const max = Number(raw[1]);
                if (!Number.isFinite(min) || !Number.isFinite(max) || min > max) {
                    console.warn('[MessageBridge] CAMERA_PITCH_RANGE_SET ignored: invalid range', raw);
                    break;
                }
                const range: [number, number] = [
                    Math.max(-90, Math.min(90, min)),
                    Math.max(-90, Math.min(90, max))
                ];
                const cameras = (global.settings as ExperienceSettings).cameras;
                if (Array.isArray(cameras) && cameras[0]) {
                    cameras[0].pitchRange = range;
                }
                events.fire('camera:pitchRangeChanged', range);
                break;
            }
            case 'SKYBOX_SET':
                if (typeof p.value === 'string') {
                    events.fire('skyboxSet', p.value);
                }
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
                    // 进入编辑停播一次性 reveal，persistent 保留；退出编辑后再恢复 reveal 播放节奏。
                    const hasVfxToResume = getRevealActiveType(state) !== 'none';
                    if (hasVfxToResume) {
                        events.fire('vfxExit');
                    }
                    // 先清空模块，避免 sceneAssets 恢复结束后覆盖用户已选模块
                    state.editLeftModule = null;
                    events.fire('editLeftModule:changed', null);
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
                        restoreSkyboxFromSettings(global);
                    }
                }
                state.editMode = !!p.value;
                if (value) {
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
                    restoreSkyboxFromSettings(global);
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
                const next = p.value === true;
                if (state.previewMode !== next) {
                    state.previewMode = next;
                    events.fire('previewMode:changed', next);
                }
                if (next) {
                    events.fire('mediaHotspot:userActivate');
                }
                break;
            }
            case 'MEDIA_HOTSPOT_SET': {
                const patch = (payload as Extract<InboundPayload, { type: 'MEDIA_HOTSPOT_SET' }>).value;
                if (!patch) break;
                patchSceneMediaHotspot(global.settings as ExperienceSettings, patch);
                events.fire('sceneMediaHotspot:changed');
                break;
            }
            case 'VIEW_MEDIA_MUTE_SET':
                if (typeof p.value === 'boolean') {
                    applyViewMediaMuteSet(global, p.value);
                }
                break;
            case 'TORCH_TOGGLE':
                if (typeof p.value === 'boolean') {
                    dispatchEnvironment(global, 'TORCH_TOGGLE', p);
                }
                break;
            case 'TORCH_PARAMS_SET': {
                const torchVal = (p as { value?: unknown }).value;
                if (torchVal && typeof torchVal === 'object') {
                    dispatchEnvironment(global, 'TORCH_PARAMS_SET', p);
                }
                break;
            }
            case 'ASSET_MEDIA_HOTSPOT_BASELINE_SET': {
                const msg = payload as Extract<InboundPayload, { type: 'ASSET_MEDIA_HOTSPOT_BASELINE_SET' }>;
                const id = typeof msg.id === 'string' ? msg.id.trim() : '';
                if (!id) {
                    console.warn('[MessageBridge] ASSET_MEDIA_HOTSPOT_BASELINE_SET missing id');
                    break;
                }
                const result = applySceneMediaHotspotBaselineFromView(global, { sceneEntityId: id });
                if (result.ok === false) {
                    console.warn('[MessageBridge] ASSET_MEDIA_HOTSPOT_BASELINE_SET failed:', result.reason, { id });
                    break;
                }
                events.fire('sceneAsset:triggerDistanceChanged', {
                    id: result.id,
                    triggerDistanceM: result.triggerDistanceM
                });
                postToParent('SCENE_ASSET_MEDIA_TRIGGER_DISTANCE_CHANGED', {
                    module: MESSAGE_BRIDGE_MODULE.asset,
                    id: result.id,
                    value: { triggerDistanceM: result.triggerDistanceM }
                });
                break;
            }
            case 'ASSET_MEDIA_HOTSPOT_RANGE_SET': {
                const pl = payload as Extract<InboundPayload, { type: 'ASSET_MEDIA_HOTSPOT_RANGE_SET' }>;
                const id = typeof pl.id === 'string' ? pl.id.trim() : '';
                if (!id || typeof pl.value !== 'number') break;
                applySceneAssetTriggerDistanceM(global, id, pl.value);
                break;
            }
            case 'SETTINGS_SAVE': {
                const saveResult = await persistExperienceSettingsToCloud(global);
                if (saveResult.ok === false) {
                    console.error('[MessageBridge] SETTINGS_SAVE 失败', saveResult.message);
                    postToParent('SETTINGS_SAVE_FAILED', { message: saveResult.message });
                    break;
                }
                postToParent('SETTINGS_UPDATED');
                setBaseline();
                break;
            }
            case 'SETTINGS_RESET': {
                const resetResult = await resetSceneSettings(global);
                if (resetResult.ok === false) {
                    console.error('[MessageBridge] SETTINGS_RESET 失败', resetResult.message);
                    postToParent('SETTINGS_RESET_FAILED', { message: resetResult.message });
                    break;
                }
                if (state.editMode) {
                    const initialSnapshot = serializeExperienceSettings(global);
                    setBaseline(initialSnapshot);
                    if (config.trackEditHistory) {
                        initEditHistory(global, initialSnapshot);
                        postToParent('EDIT_HISTORY_STATE', { canUndo: canUndo(global), canRedo: canRedo(global) });
                    }
                } else {
                    (global as { __originalSettings?: ExperienceSettings }).__originalSettings =
                        JSON.parse(JSON.stringify(global.settings)) as ExperienceSettings;
                }
                postToParent('SETTINGS_RESET_APPLIED', { pathFrom: resetResult.pathFrom });
                break;
            }
            case 'EDIT_MODULE_SET':
                if (p.value == null) {
                    state.editLeftModule = null;
                    events.fire('editLeftModule:changed', null);
                    break;
                }
                if (typeof p.value === 'string') {
                    const valid: EditLeftModule[] = [
                        'gs',
                        'asset',
                        'annotation',
                        'environment',
                        'camera',
                        'effects',
                        'assetEffects'
                    ];
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
                typeof resolvedId === 'string' ?
                    state.scenePlacedEntities?.find(it => it?.id === resolvedId) ?? null :
                    null;
                const matchedRequested =
                !!resolvedEntry &&
                !!requested &&
                resolvedEntry.id === requested;
                // 仅在“请求 id 成功命中场景实例”时触发 frame；未命中时不飞。
                if (state.editMode && state.editLeftModule === 'asset' && matchedRequested) {
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
            case 'ASSET_VIDEO_CURVATURE_SET':
                if (typeof p.id === 'string' && typeof p.value === 'number') {
                    dispatchAsset(global, 'ASSET_VIDEO_CURVATURE_SET', { id: p.id, value: p.value });
                }
                break;
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
                if (typeof shadowVal !== 'boolean') {
                    break;
                }
                suppressCollisionOutbound = true;
                try {
                    void applyShadowSetFromHost(global, shadowVal);
                } finally {
                    suppressCollisionOutbound = false;
                }
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
            case 'LIGHT_REGION_UPDATE':
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
            case 'EFFECT_PARAMS_PATCH': {
                if (p.module !== undefined && p.module !== MESSAGE_BRIDGE_MODULE.effects) {
                    console.warn('[MessageBridge] EFFECT_PARAMS_PATCH ignored: module must be "effects" when present');
                    break;
                }
                const targetId = (p as { targetId?: unknown }).targetId;
                if (typeof targetId === 'string') {
                    const params = (p as { params?: unknown }).params;
                    const rawParams =
                        typeof params === 'object' && params !== null ?
                            { ...(params as Record<string, unknown>) } :
                            {};
                    const normalized = normalizeEffectParamsPatch(p.effectId as string, rawParams);
                    if (!normalized) {
                        console.warn('[MessageBridge] EFFECT_PARAMS_PATCH ignored: invalid asset params shape');
                        break;
                    }
                    const pr = normalized.isNewShape && normalized.params.effectParams === undefined ?
                        { ...normalized.params, effectParams: {} } :
                        normalized.params;
                    if (!resolveAssetEffectType(p.effectId as string, pr)) {
                        break;
                    }
                    if (!paramsPatchHasAssetKeys(pr)) {
                        console.warn('[MessageBridge] EFFECT_PARAMS_PATCH ignored: invalid asset params');
                        break;
                    }
                    const env = normalizeAssetEffectEnvelope({
                        effectId: p.effectId as string,
                        targetId,
                        params: pr
                    });
                    if (normalized.isNewShape && normalized.enable === true) {
                        dispatchEffects(global, 'EFFECT_START', env);
                    } else if (normalized.isNewShape && normalized.enable === false) {
                        dispatchEffects(global, 'EFFECT_PARAMS_PATCH', env);
                    } else {
                        dispatchEffects(global, 'EFFECT_PARAMS_PATCH', env);
                    }
                    break;
                }
                if (p.effectId !== SCENE_GSPLAT_REVEAL_EFFECT_ID && !isPersistentProtocolEffectId(p.effectId as string)) {
                    console.warn('[MessageBridge] EFFECT_PARAMS_PATCH ignored: unsupported effectId', p.effectId);
                    break;
                }
                const params = (p as { params?: unknown }).params;
                if (typeof params !== 'object' || params === null) {
                    console.warn('[MessageBridge] EFFECT_PARAMS_PATCH ignored: params must be object');
                    break;
                }
                const rawParams = { ...(params as Record<string, unknown>) };
                const normalized = normalizeEffectParamsPatch(p.effectId as string, rawParams);
                if (!normalized) {
                    console.warn('[MessageBridge] EFFECT_PARAMS_PATCH ignored: invalid params shape');
                    break;
                }
                const pr = normalized.params;
                const valid =
                p.effectId === SCENE_GSPLAT_REVEAL_EFFECT_ID ?
                    paramsPatchHasRevealKeys(pr) :
                    paramsPatchHasPersistentKeys(pr);
                if (!valid) {
                    console.warn('[MessageBridge] EFFECT_PARAMS_PATCH ignored: invalid params for current effectId');
                    break;
                }
                dispatchEffects(global, 'EFFECT_PARAMS_PATCH', {
                    effectId: p.effectId as string,
                    params: pr
                });
                break;
            }
            case 'EFFECT_START': {
                if (p.module !== undefined && p.module !== MESSAGE_BRIDGE_MODULE.effects) {
                    break;
                }
                const targetId = (p as { targetId?: unknown }).targetId;
                const effectId = (p as { effectId?: unknown }).effectId;
                if (typeof targetId !== 'string' || typeof effectId !== 'string') {
                    console.warn('[MessageBridge] EFFECT_START ignored: targetId and effectId required');
                    break;
                }
                const params =
                    typeof (p as { params?: unknown }).params === 'object' &&
                    (p as { params?: unknown }).params !== null ?
                        ((p as { params: Record<string, unknown> }).params) :
                        {};
                if (!resolveAssetEffectType(effectId, params)) {
                    console.warn(
                        '[MessageBridge] EFFECT_START ignored: require effectId',
                        ASSET_GSPLAT_EFFECT_ID,
                        '+ params.type (legacy: effectId as type)'
                    );
                    break;
                }
                dispatchEffects(
                    global,
                    'EFFECT_START',
                    normalizeAssetEffectEnvelope({ effectId, targetId, params } as AssetEffectProtocolEnvelope)
                );
                break;
            }
            case 'EFFECT_STOP': {
                if (p.module !== undefined && p.module !== MESSAGE_BRIDGE_MODULE.effects) {
                    break;
                }
                const targetId = (p as { targetId?: unknown }).targetId;
                const effectId = (p as { effectId?: unknown }).effectId;
                if (typeof targetId !== 'string' || typeof effectId !== 'string') {
                    console.warn('[MessageBridge] EFFECT_STOP ignored: targetId and effectId required');
                    break;
                }
                const params =
                    typeof (p as { params?: unknown }).params === 'object' &&
                    (p as { params?: unknown }).params !== null ?
                        ((p as { params: Record<string, unknown> }).params) :
                        {};
                if (!resolveAssetEffectType(effectId, params)) {
                    break;
                }
                dispatchEffects(
                    global,
                    'EFFECT_STOP',
                    normalizeAssetEffectEnvelope({ effectId, targetId, params } as AssetEffectProtocolEnvelope)
                );
                break;
            }
            case 'EFFECT_ADD': {
                if (p.module !== undefined && p.module !== MESSAGE_BRIDGE_MODULE.effects) {
                    console.warn('[MessageBridge] EFFECT_ADD ignored: module must be "effects" when present');
                    break;
                }
                const effectId = (p as { effectId?: unknown }).effectId;
                const effectType = (p as { effectType?: unknown }).effectType;
                const targetId = (p as { targetId?: unknown }).targetId;
                const paramsRaw = (p as { params?: unknown }).params;
                const params =
                    paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw) ?
                        (paramsRaw as Record<string, unknown>) :
                        {};
                if (typeof effectId !== 'string' || typeof effectType !== 'string') {
                    console.warn('[MessageBridge] EFFECT_ADD ignored: effectId and effectType must be string');
                    break;
                }
                if (effectId === SCENE_GSPLAT_REVEAL_EFFECT_ID) {
                    dispatchEffects(global, 'EFFECT_ADD', { effectId, effectType });
                    break;
                }
                if (effectId === SCENE_GSPLAT_PERSISTENT_EFFECT_ID) {
                    dispatchEffects(global, 'EFFECT_ADD', { effectId, effectType, params });
                    break;
                }
                if (effectId === SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID && effectType !== '') {
                    if (!PERSISTENT_CAMERA_EFFECT_TYPES.has(effectType)) {
                        console.warn('[MessageBridge] EFFECT_ADD ignored: invalid camera effectType', effectType);
                        break;
                    }
                    dispatchEffects(global, 'EFFECT_ADD', { effectId, effectType, params });
                    break;
                }
                if (effectId === SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID && effectType !== '') {
                    if (!MESSAGE_BRIDGE_STYLIZATION_EFFECT_TYPES.has(effectType)) {
                        console.warn('[MessageBridge] EFFECT_ADD ignored: invalid stylization effectType', effectType);
                        break;
                    }
                    dispatchEffects(global, 'EFFECT_ADD', { effectId, effectType, params });
                    break;
                }
                if (
                    (effectId === SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID ||
                        effectId === SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID) &&
                    effectType === ''
                ) {
                    dispatchEffects(global, 'EFFECT_ADD', { effectId, effectType, params });
                    break;
                }
                if (effectId === ASSET_GSPLAT_EFFECT_ID) {
                    if (typeof targetId !== 'string') {
                        console.warn('[MessageBridge] EFFECT_ADD ignored: targetId required for asset.gsplat-effects');
                        break;
                    }
                    if (effectType !== '' && !ASSET_EFFECT_TYPES.has(effectType)) {
                        console.warn('[MessageBridge] EFFECT_ADD ignored: invalid asset effectType', effectType);
                        break;
                    }
                    dispatchEffects(global, 'EFFECT_ADD', { effectId, effectType, targetId, params });
                    break;
                }
                console.warn('[MessageBridge] EFFECT_ADD ignored: unsupported effectId', effectId);
                break;
            }
            case 'EFFECT_DELETE': {
                if (p.module !== undefined && p.module !== MESSAGE_BRIDGE_MODULE.effects) {
                    console.warn('[MessageBridge] EFFECT_DELETE ignored: module must be "effects" when present');
                    break;
                }
                const effectId = (p as { effectId?: unknown }).effectId;
                const effectType = (p as { effectType?: unknown }).effectType;
                const targetId = (p as { targetId?: unknown }).targetId;
                if (typeof effectId !== 'string') {
                    console.warn('[MessageBridge] EFFECT_DELETE ignored: effectId must be string');
                    break;
                }
                if (effectType !== undefined && typeof effectType !== 'string') {
                    console.warn('[MessageBridge] EFFECT_DELETE ignored: effectType must be string when present');
                    break;
                }
                if (
                    effectId === SCENE_GSPLAT_PERSISTENT_EFFECT_ID ||
                    effectId === SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID ||
                    effectId === SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID
                ) {
                    dispatchEffects(global, 'EFFECT_DELETE', {
                        effectId,
                        ...(typeof effectType === 'string' ? { effectType } : {})
                    });
                    break;
                }
                if (effectId === SCENE_GSPLAT_REVEAL_EFFECT_ID) {
                    dispatchEffects(global, 'EFFECT_DELETE', { effectId });
                    break;
                }
                if (effectId === ASSET_GSPLAT_EFFECT_ID) {
                    if (typeof targetId !== 'string' || targetId.length === 0) {
                        console.warn('[MessageBridge] EFFECT_DELETE ignored: targetId required for asset.gsplat-effects');
                        break;
                    }
                    dispatchEffects(global, 'EFFECT_DELETE', {
                        effectId,
                        targetId
                    });
                    break;
                }
                console.warn('[MessageBridge] EFFECT_DELETE ignored: unsupported effectId', effectId);
                break;
            }
            case 'EFFECT_TOGGLE': {
                if (p.module !== undefined && p.module !== MESSAGE_BRIDGE_MODULE.effects) {
                    console.warn('[MessageBridge] EFFECT_TOGGLE ignored: module must be "effects" when present');
                    break;
                }
                if (!isPersistentProtocolEffectId(p.effectId as string)) {
                    console.warn('[MessageBridge] EFFECT_TOGGLE ignored: unsupported effectId', p.effectId);
                    break;
                }
                const toggleParams = (p as { params?: unknown }).params;
                if (typeof toggleParams !== 'object' || toggleParams === null) {
                    console.warn('[MessageBridge] EFFECT_TOGGLE ignored: params must be object');
                    break;
                }
                const tpr = { ...(toggleParams as Record<string, unknown>) };
                if (!paramsPatchHasPersistentKeys(tpr)) {
                    console.warn(
                        '[MessageBridge] EFFECT_TOGGLE ignored: params must be single nested persistent type block'
                    );
                    break;
                }
                dispatchEffects(global, 'EFFECT_PARAMS_PATCH', {
                    effectId: p.effectId as string,
                    params: tpr
                });
                break;
            }
            case 'EFFECT_REPLAY': {
                if (p.module !== undefined && p.module !== MESSAGE_BRIDGE_MODULE.effects) {
                    console.warn('[MessageBridge] EFFECT_REPLAY ignored: module must be "effects" when present');
                    break;
                }
                if (p.effectId !== SCENE_GSPLAT_REVEAL_EFFECT_ID) {
                    console.warn('[MessageBridge] EFFECT_REPLAY ignored: unsupported effectId', p.effectId);
                    break;
                }
                dispatchEffects(global, 'EFFECT_REPLAY', {
                    effectId: SCENE_GSPLAT_REVEAL_EFFECT_ID,
                    restartAnim: (p as { restartAnim?: boolean }).restartAnim
                });
                break;
            }
            case 'VIDEO_EXPORT_START': {
                const projectName =
                typeof (p as { projectName?: unknown }).projectName === 'string' ?
                    (p as { projectName: string }).projectName :
                    undefined;
                console.log('[MessageBridge] VIDEO_EXPORT_START → start export pipeline', {
                    includeVfx: (p as any).includeVfx !== false,
                    projectName
                });
                const includeVfx = (p as any).includeVfx !== false;
                const waitResult = await getAssetLoader(global).waitAllReady();
                // 与视频导出执行层保持一致：使用导出入口等待得到的真实就绪时刻（秒）。
                const allAssetsReadyAt = Math.max(0, waitResult.waitMs / 1000);
                const resolution = { width: 1920, height: 1080 };
                const width = resolution.width % 2 === 0 ? resolution.width : resolution.width - 1;
                const height = resolution.height % 2 === 0 ? resolution.height : resolution.height - 1;
                // 导出时长统一交给 timeline resolver 决策，避免 message-bridge 与导出执行层各自维护策略。
                const vfxDuration = getRevealTotalDuration(global.settings) ?? DEFAULT_VFX_TOTAL_DURATION;
                const animDuration = (global.state as any).animationDuration as number | undefined;
                const animLoopMode = ((global.settings as any)?.animTracks?.[0]?.loopMode as 'none' | 'repeat' | 'pingpong' | undefined) ?? 'repeat';
                const totalDuration = resolveExportTimelinePlan({
                    includeVfx,
                    syncAnimTrack: true,
                    vfxDuration,
                    requestedTotalDuration: vfxDuration,
                    animDuration,
                    animLoopMode,
                    allAssetsReadyAt
                }).totalDuration;
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
                    useFastExport: true,
                    projectName
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
                        suggestedName: buildVideoExportFilename(projectName, 'mp4')
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
            case 'CAMERA_DEFAULT_VIEW_CAPTURE': {
                const captureResult = await captureDefaultViewAndStageThumbnail(global);
                if (captureResult.ok === false) {
                    postToParent('CAMERA_DEFAULT_VIEW_CAPTURE_FAILED', {
                        module: MESSAGE_BRIDGE_MODULE.camera,
                        message: captureResult.message
                    });
                    break;
                }
                postToParent('CAMERA_DEFAULT_VIEW_CAPTURED', {
                    module: MESSAGE_BRIDGE_MODULE.camera
                });
                break;
            }
            case 'COLLISION_SET': {
                if (typeof p.value !== 'boolean') {
                    console.warn('[MessageBridge] COLLISION_SET ignored: value must be boolean');
                    break;
                }
                suppressCollisionOutbound = true;
                try {
                    void applyCollisionSetFromHost(global, p.value);
                } finally {
                    suppressCollisionOutbound = false;
                }
                break;
            }
            case 'COLLISION_PATCH': {
                const patch = (p as { value?: unknown }).value;
                if (!patch || typeof patch !== 'object') {
                    console.warn('[MessageBridge] COLLISION_PATCH ignored: value must be object');
                    break;
                }
                suppressCollisionOutbound = true;
                try {
                    void applyCollisionPatchFromHost(global, patch as SceneCollisionSettingsPatch);
                } finally {
                    suppressCollisionOutbound = false;
                }
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

    events.on('cameraCollision:load', (payload: CollisionLoadPayload) => {
        if (suppressCollisionOutbound) {
            return;
        }
        const modules = resolveSceneMeshLoadOutboundModules(global, payload.intent);
        if (payload.state === 'ready') {
            for (const module of modules) {
                postToParent('SCENE_MESH_LOAD_FINISHED', buildSceneMeshLoadFinishedPayload(global, module));
            }
        } else if (payload.state === 'failed') {
            for (const module of modules) {
                postToParent('SCENE_MESH_LOAD_FAILED', buildSceneMeshLoadFailedPayload(global, module, payload.error));
            }
        }
    });

    events.on(COLLISION_SYSTEM_READY, () => {
        if (suppressCollisionOutbound) {
            return;
        }
        const collisionUrl = resolveCollisionUrl(global)?.url;
        postToParent('COLLISION_SYSTEM_READY', {
            module: MESSAGE_BRIDGE_MODULE.camera,
            ...(collisionUrl ? { collisionUrl } : {})
        });
    });

    events.on(SHADOW_SYSTEM_READY, () => {
        if (suppressCollisionOutbound) {
            return;
        }
        if (!isShadowOutputEnabled(global)) {
            return;
        }
        postToParent('SHADOW_SYSTEM_READY', { module: MESSAGE_BRIDGE_MODULE.environment });
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
        const assetType = getSelectedSceneAssetType(state, global.settings.sceneAssets);
        const payload: Record<string, unknown> = { module: MESSAGE_BRIDGE_MODULE.asset, id };
        if (assetType !== undefined) {
            payload.assetType = assetType;
        }
        postToParent('SCENE_ASSET_SELECTED', payload);
    });

    events.on('sceneAsset:placed', (data?: { id?: string | null; source?: SelectionSource }) => {
        const source = data?.source ?? 'unknown';
        if (source !== 'scene') return;
        const id = typeof data?.id === 'string' ? data.id : null;
        if (!id) return;
        postToParent('SCENE_ASSET_PLACED', { module: MESSAGE_BRIDGE_MODULE.asset, id });
    });

    events.on('sceneLight:selected', (data: { id: string | null; source?: SelectionSource }) => {
        const source = data?.source ?? 'unknown';
        if (source !== 'scene') return;
        const id = data.id ?? null;
        postToParent('SCENE_LIGHT_SELECTED', { module: MESSAGE_BRIDGE_MODULE.environment, id });
    });

    events.on('sceneLight:placed', (data?: { id?: string | null; source?: SelectionSource }) => {
        const source = data?.source ?? 'unknown';
        if (source !== 'scene') return;
        const id = typeof data?.id === 'string' ? data.id : null;
        if (!id) return;
        postToParent('SCENE_LIGHT_PLACED', { module: MESSAGE_BRIDGE_MODULE.environment, id });
    });

    events.on('annotation:selected', (data: { id: string; source?: SelectionSource }) => {
        const source = data?.source ?? 'unknown';
        if (source !== 'scene') return;
        const id = data.id;
        postToParent('SCENE_ANNOTATION_SELECTED', { module: MESSAGE_BRIDGE_MODULE.annotation, id });
    });

    // 统一上报“进入标注编辑”并附带初始化数据（不区分选中来源）
    events.on('annotationEdit:show', () => {
        const selected = g.annotationManager?.getSelectedAnnotation?.();
        const serialized = selected?.serialize?.();
        if (!serialized?.id) return;
        postToParent('SCENE_ANNOTATION_EDIT_START', {
            module: MESSAGE_BRIDGE_MODULE.annotation,
            id: serialized.id,
            value: {
                title: serialized.title ?? '',
                text: serialized.text ?? '',
                imageUrl: serialized.imageUrl,
                videoUrl: serialized.videoUrl,
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
            postToParent('VIDEO_EXPORT_CANCELLED', { module: MESSAGE_BRIDGE_MODULE.effects });
        } else {
            postToParent('VIDEO_EXPORT_END', { module: MESSAGE_BRIDGE_MODULE.effects });
        }
        videoExportCancelled = false;
    });

    events.on('progressStart', () => {
        // 开始导出：默认认为走“结束”，除非后续收到取消
        videoExportCancelled = false;
        postToParent('VIDEO_EXPORT_STARTED', { module: MESSAGE_BRIDGE_MODULE.effects });
    });
};

export { initPostMessageBridge };
