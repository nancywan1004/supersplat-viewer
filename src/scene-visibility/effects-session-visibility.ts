/**
 * 场景内容容器专用的特效「会话显隐」路径。
 * 仅纯 Viewer 写入 `viewSettings.effectsSession`（经 `getEffectsWriteTarget`），
 * **不得**在编辑态（含预览）改写 `global.settings`。
 * 与编辑协议 `EFFECT_*` / `applyGsplatRevealParamsPatch` 分离：
 * - 关开场：不 `revealRestart`、不因停播误 remount persistent
 * - 关/开 persistent：直接写轨包 + 一次 teardown/remount
 */

import {
    getPersistentTrackEffect,
    hasEnabledPersistentEffects,
    patchPersistentTrackFromProtocolParams,
    patchRevealSettingsFromParams,
    readPersistentCameraEffects,
    readPersistentSceneEffects,
    readPersistentStylizationEffects,
    readPersistentTrackEffects,
    readRevealParams,
    syncEffectsRuntimeStateFromSettings,
    type PersistentTrackName
} from '../settings-serialize/effects-sync';
import { finalizePersistentGsplatTrackOff } from '../editor-modules/protocol-adapters/effects-protocol-adapter';
import {
    clearViewEffectsSession,
    getEffectsReadSource,
    getEffectsWriteTarget
} from '../view-settings';
import type { ExperienceSettings } from '../schemas/v2';
import type { Global } from '../types';

export type PersistentSessionSnapshot = { scene: string[]; camera: string[] };

function writePersistentTypesEnabled(
    global: Global,
    trackName: PersistentTrackName,
    types: string[],
    enabled: boolean
): void {
    if (types.length === 0) return;
    const nested: Record<string, unknown> = {};
    for (const t of types) {
        nested[t] = { enabled };
    }
    const settings = getEffectsWriteTarget(global);
    patchPersistentTrackFromProtocolParams(settings, trackName, nested);
}

function syncPersistentRuntimeAfterSessionWrite(global: Global): void {
    const settings = getEffectsReadSource(global);
    syncEffectsRuntimeStateFromSettings(global.state, settings);
    global.events.fire('persistentSceneEffectsChanged');
    if (!hasEnabledPersistentEffects(settings)) {
        finalizePersistentGsplatTrackOff(global);
        return;
    }
    global.events.fire('persistentGsplatEffectRemountRequested', false);
}

/**
 * 进入编辑：丢弃 View 特效 session，按入库 settings 恢复运行态（不自动重播开场）。
 */
export function restoreEffectsFromExperienceSettings(global: Global): void {
    clearViewEffectsSession(global);
    const settings = global.settings as ExperienceSettings;
    syncEffectsRuntimeStateFromSettings(global.state, settings);
    const reveal = readRevealParams(settings);
    if (reveal) {
        global.events.fire('revealConfigChanged', reveal);
    }
    global.events.fire('persistentSceneEffectsChanged');
    if (!hasEnabledPersistentEffects(settings)) {
        finalizePersistentGsplatTrackOff(global);
        return;
    }
    global.events.fire('persistentGsplatEffectRemountRequested', false);
}

/**
 * 会话显隐开场 reveal（仅 View overlay 路径调用）。
 * - false：写 enabled=false + `revealSessionHide`（拆一次性、skip remount）
 * - true：只恢复 enabled，**不**自动重播
 */
export function applyRevealSessionVisible(global: Global, visible: boolean): void {
    const settings = getEffectsWriteTarget(global);
    const current = readRevealParams(settings);
    const type = (current?.type ?? 'none') as string;
    if (!type || type === 'none') return;

    const merged = patchRevealSettingsFromParams(settings, { enabled: visible });
    syncEffectsRuntimeStateFromSettings(global.state, settings);
    global.events.fire('revealConfigChanged', merged);

    if (!visible) {
        global.events.fire('revealSessionHide');
    }
}

export function readPersistentSessionSnapshot(global: Global): PersistentSessionSnapshot {
    const settings = getEffectsReadSource(global);
    return {
        scene: readPersistentSceneEffects(settings).map((e) => e.type),
        camera: readPersistentCameraEffects(settings).map((e) => e.type)
    };
}

/** 会话显隐 persistent.scene + persistent.camera */
export function applyPersistentSessionVisible(
    global: Global,
    visible: boolean,
    snapshot: PersistentSessionSnapshot | undefined
): PersistentSessionSnapshot {
    if (!visible) {
        const snap = readPersistentSessionSnapshot(global);
        writePersistentTypesEnabled(global, 'scene', snap.scene, false);
        writePersistentTypesEnabled(global, 'camera', snap.camera, false);
        syncPersistentRuntimeAfterSessionWrite(global);
        return snap;
    }
    const settings = getEffectsWriteTarget(global);
    const snap = snapshot ?? readPersistentSessionSnapshot(global);
    const sceneTypes =
        snap.scene.length > 0 ?
            snap.scene :
            readPersistentTrackEffects(settings, 'scene', { includeDisabled: true }).map((e) => e.type);
    const cameraTypes =
        snap.camera.length > 0 ?
            snap.camera :
            readPersistentTrackEffects(settings, 'camera', { includeDisabled: true }).map((e) => e.type);
    writePersistentTypesEnabled(global, 'scene', sceneTypes, true);
    writePersistentTypesEnabled(global, 'camera', cameraTypes, true);
    syncPersistentRuntimeAfterSessionWrite(global);
    return snap;
}

/** 会话显隐 persistent.stylization */
export function applyStylizationSessionVisible(
    global: Global,
    visible: boolean,
    snapshot: string[] | undefined
): string[] {
    if (!visible) {
        const settings = getEffectsReadSource(global);
        const types = readPersistentStylizationEffects(settings).map((e) => e.type);
        writePersistentTypesEnabled(global, 'stylization', types, false);
        syncPersistentRuntimeAfterSessionWrite(global);
        return types;
    }
    const settings = getEffectsWriteTarget(global);
    const types =
        snapshot && snapshot.length > 0 ?
            snapshot :
            readPersistentTrackEffects(settings, 'stylization', { includeDisabled: true }).map((e) => e.type);
    const existing = types.filter((t) => getPersistentTrackEffect(settings, 'stylization', t));
    writePersistentTypesEnabled(global, 'stylization', existing, true);
    syncPersistentRuntimeAfterSessionWrite(global);
    return existing;
}
