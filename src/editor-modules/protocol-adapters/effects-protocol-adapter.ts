/**
 * 场景 GSplat reveal / persistent 协议映射：`EFFECT_PARAMS_PATCH` / `EFFECT_TOGGLE` / `EFFECT_ADD` / `EFFECT_DELETE`。
 * reveal：**切换 type 仅 `EFFECT_ADD`**；`EFFECT_PARAMS_PATCH` 的 `params` 嵌套键须为当前 type，只改参数 / `enabled` / `autoStart` / `totalDuration`；
 * persistent scene（postMessage）：`params` 为 `{ [type]: { enabled?, autoStart?, …专参 } }`（与 reveal / 存盘一致）；
 *   每条消息仅一个 type 键。由 `effectId` 区分 reveal / persistent 轨。
 * persistent：**增删类型** `EFFECT_ADD` / `EFFECT_DELETE`（`effectType`）；**改参 / enabled** `EFFECT_PARAMS_PATCH` 或 `EFFECT_TOGGLE`。`module` 可选。
 */

import type { ExperienceSettings } from '../../schemas/v2';
import type { LegacyRevealEffect } from '../../schemas/v2-custom';
import { DEFAULT_VFX_TOTAL_DURATION } from '../../schemas/v2-custom';
import {
    getRevealStatus,
    getPersistentTrackEffect,
    hasEnabledPersistentEffects,
    clearPersistentTrackEffects,
    clearRevealScenePack,
    coercePersistentProtocolParamsInbound,
    parsePersistentProtocolParamsToPatch,
    patchPersistentTrackEffect,
    patchPersistentTrackFromProtocolParams,
    patchRevealRuntimeMirror,
    persistentProtocolParamsHasPatchKeys,
    persistentTrackNameForEffectId,
    persistentTrackNameForType,
    readActivePersistentEffects,
    readPersistentTrackEffects,
    removePersistentTrackEffect,
    buildRevealProtocolParams,
    parseRevealProtocolParamsToPatch,
    patchRevealSettingsFromParams,
    readRevealParams,
    replaceRevealSceneEffect,
    revealProtocolParamsHasPatchKeys,
    syncEffectsRuntimeStateFromSettings
} from '../../settings-serialize/effects-sync';
import { getEffectsReadSource, getEffectsWriteTarget } from '../../view-settings';

export {
    buildRevealProtocolParams,
    buildPersistentProtocolParams,
    coercePersistentProtocolParamsInbound
} from '../../settings-serialize/effects-sync';
import { PERSISTENT_EFFECT_TYPE_VALUES } from '../../types';
import type { Global, PersistentEffectType } from '../../types';
import {
    SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID
} from '../../vfx/effects-runtime/effects-runtime';
import { REVEAL_EFFECT_TYPES } from '../../vfx/effects-runtime/effect-types';
import { isPersistentVfx, isRevealEffectActiveInScene } from '../../vfx/effects-runtime/reveal/reveal-policy';
import { EFFECTS_PROTOCOL_MODULE, type EffectsProtocolModule } from '../modules-types';

export {
    SCENE_GSPLAT_REVEAL_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID
} from '../../vfx/effects-runtime/effects-runtime';

export type EffectProtocolParamsPatchPayload = {
    module?: EffectsProtocolModule;
    effectId: string;
    params: Record<string, unknown>;
};

export type EffectProtocolStopPayload = {
    module?: EffectsProtocolModule;
    effectId: string;
};

export type EffectProtocolReplayPayload = {
    module?: EffectsProtocolModule;
    effectId: string;
    restartAnim?: boolean;
};

export type EffectProtocolAddDeletePayload = {
    module?: EffectsProtocolModule;
    effectId: string;
    effectType: string;
};

export function isEffectProtocolEnvelope(
    p: unknown
): p is { effectId: string; module?: EffectsProtocolModule } {
    if (typeof p !== 'object' || p === null) return false;
    const o = p as Record<string, unknown>;
    if (typeof o.effectId !== 'string') return false;
    if (o.module === undefined) return true;
    return o.module === EFFECTS_PROTOCOL_MODULE;
}

export function isPersistentProtocolEffectId(effectId: string): boolean {
    return persistentTrackNameForEffectId(effectId) !== null;
}
export function paramsPatchHasRevealKeys(params: Record<string, unknown>): boolean {
    return revealProtocolParamsHasPatchKeys(params);
}

export function paramsPatchHasPersistentKeys(params: Record<string, unknown>): boolean {
    return persistentProtocolParamsHasPatchKeys(params);
}

/**
 * EFFECT_PARAMS_PATCH（scene reveal）：仅改当前类型的参数 / `enabled` / `autoStart` / `totalDuration`（不可改 type）。
 * 写 `settings.effects.reveal` 后在 `revealConfigChanged` 之后触发 `revealRestart`（`enabled: false` 除外）。
 * @param global
 * @param params
 */
export function applyGsplatRevealParamsPatch(global: Global, params: Record<string, unknown>): void {
    if (!paramsPatchHasRevealKeys(params)) return;
    const settings = getEffectsWriteTarget(global);
    const current = readRevealParams(settings);
    const currentType = (current?.type ?? 'none') as string;
    const patch = parseRevealProtocolParamsToPatch(params, { lockToCurrentType: currentType });
    if (!patch || Object.keys(patch).length === 0) return;

    const merged = patchRevealSettingsFromParams(settings as ExperienceSettings, patch);
    syncEffectsRuntimeStateFromSettings(global.state, settings);
    syncRevealSceneActiveState(global, merged);
    global.events.fire('revealConfigChanged', merged);
    const disabling = typeof patch.enabled === 'boolean' && patch.enabled === false;
    if (!disabling) {
        requestRevealSceneReplayIfActive(global, merged);
    }
}

/** 一次性开场已启用时请求重播（与 `EFFECT_REPLAY` / UI Restart 同路径；须在 `revealConfigChanged` 之后调用）。 */
function requestRevealSceneReplayIfActive(global: Global, merged: LegacyRevealEffect): void {
    if (!isRevealEffectActiveInScene(merged)) {
        return;
    }
    global.events.fire('revealRestart', false);
}

/** 按 settings 中 reveal 的 `enabled` / `type` 同步 `hasRevealEffect`；未启用时停播（具体重播由 `revealConfigChanged` / `EFFECT_ADD` 触发）。 */
function syncRevealSceneActiveState(global: Global, merged: LegacyRevealEffect): void {
    const active = isRevealEffectActiveInScene(merged);
    const prev = global.state.hasRevealEffect;
    global.state.hasRevealEffect = active;
    if (prev !== active) {
        global.events.fire('hasRevealEffect:changed', active);
    }
    if (!active) {
        applyGsplatRevealStopPlayback(global);
    }
}

/**
 * `EFFECT_ADD`（scene.gsplat-reveal）：整包替换为新 `effectType`（丢弃旧类型及参数）；
 * `none` 写入 `{ none: {} }`；新特效默认 `enabled: true` 并触发场景应用。
 */
export function applyGsplatRevealEffectAdd(global: Global, effectType: string): void {
    const t = normalizeRevealEffectType(effectType);
    if (t === null) return;

    const settings = getEffectsWriteTarget(global);
    const merged = replaceRevealSceneEffect(settings, t, { enabled: t !== 'none' });
    syncEffectsRuntimeStateFromSettings(global.state, settings);
    syncRevealSceneActiveState(global, merged);
    global.events.fire('revealConfigChanged', merged);
    if (t !== 'none') {
        global.events.fire('revealType:changed', t);
        requestRevealSceneReplayIfActive(global, merged);
    } else if (hasEnabledPersistentEffects(settings)) {
        requestPersistentGsplatRemount(global);
    }
}

/**
 * `EFFECT_DELETE`（scene.gsplat-reveal）：存盘为 `{ none: {} }`（`effectType` 可传但忽略）。
 */
export function applyGsplatRevealEffectDelete(global: Global): void {
    const settings = getEffectsWriteTarget(global);
    clearRevealScenePack(settings);
    const merged: LegacyRevealEffect = {
        type: 'none',
        enabled: false,
        autoStart: true,
        totalDuration: DEFAULT_VFX_TOTAL_DURATION
    };
    syncEffectsRuntimeStateFromSettings(global.state, settings);
    syncRevealSceneActiveState(global, merged);
    global.events.fire('revealConfigChanged', merged);
    global.events.fire('revealType:changed', 'none');
    if (hasEnabledPersistentEffects(settings)) {
        requestPersistentGsplatRemount(global);
    }
}

const PERSISTENT_TYPE_SET = new Set<string>(PERSISTENT_EFFECT_TYPE_VALUES as readonly string[]);

/**
 * 开场 reveal 轨 `effectType`：`none`、一次性 reveal 类型，或 legacy 挂在 reveal 上的 persistent 型（如 `perlin-wave`）。
 */
export function normalizeRevealEffectType(raw: unknown): LegacyRevealEffect['type'] | null {
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    if (t.length === 0) return null;
    const tl = t.toLowerCase();
    if (tl === 'none') return 'none';
    if (REVEAL_EFFECT_TYPES.has(tl)) return tl as LegacyRevealEffect['type'];
    if (isPersistentVfx(tl)) return tl as LegacyRevealEffect['type'];
    return null;
}

export function normalizePersistentType(raw: unknown): PersistentEffectType | 'none' | null {
    if (raw === undefined || raw === null || raw === false) return 'none';
    if (typeof raw !== 'string') return null;
    const t = raw.trim();
    if (t.length === 0) return 'none';
    const tl = t.toLowerCase();
    if (tl === 'none') return 'none';
    return PERSISTENT_TYPE_SET.has(tl) ? (tl as PersistentEffectType) : null;
}

/**
 * persistent 已在 settings 中处于「关」语义之后调用（M15 单内核）：
 * 先同步 `effectsRuntimeState`，再按需 `applyGsplatRevealStopPlayback`（一次性 reveal 独占播放时不误停），
 * 最后 `persistentGsplatEffectRemountRequested(false)` 驱动 viewer 拆实体脚本。
 */
export function finalizePersistentGsplatTrackOff(global: Global): void {
    syncEffectsRuntimeStateFromSettings(global.state, getEffectsReadSource(global));
    dispatchPersistentGsplatTeardownAfterSettingsSync(global);
}

/** 单类型 `enabled` 变更：仅挂载/卸载该类型脚本（与全量 remount 区分）。 */
function requestPersistentSceneEffectEnableChange(
    global: Global,
    effectType: string,
    enabled: boolean
): void {
    const dispatch = () => {
        global.events.fire('persistentGsplatEffectEnableChanged', { effectType, enabled });
    };
    const settings = getEffectsReadSource(global);
    const currentRevealType = readRevealParams(settings)?.type ?? 'none';
    if (currentRevealType === 'none') {
        dispatch();
        return;
    }
    if (getRevealStatus(global.state) === 'playing') {
        global.events.once('revealComplete', dispatch);
    } else {
        dispatch();
    }
}

/** postMessage / 协议写入 `settings.effects.persistent` 后通知编辑 UI 同步多选与参数面板 */
function notifyPersistentSceneEffectsUiSync(global: Global): void {
    global.events.fire('persistentSceneEffectsChanged');
}

function requestPersistentGsplatRemount(global: Global): void {
    const settings = getEffectsReadSource(global);
    const currentRevealType = readRevealParams(settings)?.type ?? 'none';
    if (currentRevealType === 'none') {
        global.events.fire('persistentGsplatEffectRemountRequested', false);
        return;
    }
    if (getRevealStatus(global.state) === 'playing') {
        global.events.once('revealComplete', () => {
            global.events.fire('persistentGsplatEffectRemountRequested', false);
        });
    } else {
        global.events.fire('persistentGsplatEffectRemountRequested', false);
    }
}

function dispatchPersistentGsplatTeardownAfterSettingsSync(global: Global): void {
    const settings = getEffectsReadSource(global);
    const revealType = (readRevealParams(settings)?.type ?? 'none') as string;
    const persistentPlaying = global.state.effectsRuntimeState?.persistent?.status === 'playing';
    const oneShotRevealPlaying =
        getRevealStatus(global.state) === 'playing' &&
        revealType !== 'none' &&
        !isPersistentVfx(revealType) &&
        !persistentPlaying;
    if (!oneShotRevealPlaying) {
        applyGsplatRevealStopPlayback(global);
    }
    global.events.fire('persistentGsplatEffectRemountRequested', false);
}

/**
 * EFFECT_PARAMS_PATCH（scene reveal persistent 轨）：
 * - 仅写 `settings.effects.persistent`；
 * - 若 reveal 轨为空，则用 persistent 类型激活播放；
 * - 若 reveal 正在播放，则延迟到 `revealComplete` 后 remount persistent。
 * @param global
 * @param params
 */
export function applyGsplatPersistentParamsPatch(
    global: Global,
    params: Record<string, unknown>,
    effectId: string = SCENE_GSPLAT_PERSISTENT_EFFECT_ID
): void {
    if (!paramsPatchHasPersistentKeys(params)) return;

    const nested = coercePersistentProtocolParamsInbound(params);
    if (!nested) {
        return;
    }
    const trackName = persistentTrackNameForEffectId(effectId);
    if (!trackName) {
        return;
    }

    const settings = getEffectsWriteTarget(global);
    const patches = parsePersistentProtocolParamsToPatch(nested);
    const patchTypes = Object.keys(patches);

    if (patchTypes.length === 0) {
        return;
    }

    const hadEnabled = hasEnabledPersistentEffects(settings);
    patchPersistentTrackFromProtocolParams(settings, trackName, nested);
    syncEffectsRuntimeStateFromSettings(global.state, settings);

    const singlePatch = patchTypes.length === 1 ? patches[patchTypes[0]] : undefined;
    const singlePatchKeys = singlePatch ? Object.keys(singlePatch) : [];

    const onlyEffectParams = singlePatchKeys.length > 0 && singlePatchKeys.every(k => k === 'effectParams');
    if (onlyEffectParams) {
        const t = patchTypes[0];
        const entry = getPersistentTrackEffect(settings, trackName, t);
        // 已启用：热更新脚本参数；未启用：仅写入 settings，不 remount/teardown
        if (entry?.enabled) {
            global.events.fire('persistentRevealConfigChanged', {
                type: t,
                effectParams: singlePatch?.effectParams ?? entry.effectParams
            });
        }
        notifyPersistentSceneEffectsUiSync(global);
        return;
    }

    const enabledNow = readActivePersistentEffects(settings);

    if (enabledNow.length === 0) {
        notifyPersistentSceneEffectsUiSync(global);
        if (hadEnabled) {
            finalizePersistentGsplatTrackOff(global);
        }
        return;
    }

    const onlyEnabled = singlePatchKeys.length === 1 && singlePatchKeys[0] === 'enabled';
    if (onlyEnabled) {
        const t = patchTypes[0];
        const enabledVal = patches[t]?.enabled === true;
        notifyPersistentSceneEffectsUiSync(global);
        requestPersistentSceneEffectEnableChange(global, t, enabledVal);
        return;
    }

    notifyPersistentSceneEffectsUiSync(global);
    requestPersistentGsplatRemount(global);
}

/**
 * `EFFECT_ADD`（scene.gsplat-persistent-scene）：
 * - 已存在同 `effectType` 且 `enabled: true` → 仍 remount（settings 已一致时兜底挂脚本）；
 * - 已存在且 `enabled: false` → 置 `enabled: true` 并 remount；
 * - 新类型 → 追加块（`enabled: true`），与其它已选类型并存写入 settings；
 * - `effectType === 'none'` → 清空 persistent 包并停播。
 */
export function applyGsplatPersistentEffectAdd(global: Global, effectType: string): void {
    return applyGsplatPersistentEffectAddForId(global, SCENE_GSPLAT_PERSISTENT_EFFECT_ID, effectType);
}

export function applyGsplatPersistentEffectAddForId(global: Global, effectId: string, effectType: string): void {
    const t = normalizePersistentType(effectType);
    if (t === null) return;

    const settings = getEffectsWriteTarget(global);
    const trackName = persistentTrackNameForEffectId(effectId) ?? persistentTrackNameForType(t === 'none' ? 'perlin-wave' : t);
    const hadEnabled = hasEnabledPersistentEffects(settings);
    const replaceTrack = trackName !== 'scene';

    if (t === 'none') {
        clearPersistentTrackEffects(settings, trackName);
        syncEffectsRuntimeStateFromSettings(global.state, settings);
        notifyPersistentSceneEffectsUiSync(global);
        if (hadEnabled) {
            finalizePersistentGsplatTrackOff(global);
        }
        return;
    }

    if (persistentTrackNameForType(t) !== trackName) {
        return;
    }

    const existing = getPersistentTrackEffect(settings, trackName, t);
    if (existing) {
        if (!existing.enabled) {
            patchPersistentTrackEffect(settings, trackName, t, { enabled: true }, { replaceTrack });
            syncEffectsRuntimeStateFromSettings(global.state, settings);
        }
        notifyPersistentSceneEffectsUiSync(global);
        requestPersistentGsplatRemount(global);
        return;
    }

    patchPersistentTrackEffect(settings, trackName, t, { enabled: true }, { replaceTrack });
    syncEffectsRuntimeStateFromSettings(global.state, settings);
    notifyPersistentSceneEffectsUiSync(global);

    if (readActivePersistentEffects(settings).length === 0) {
        return;
    }
    requestPersistentGsplatRemount(global);
}

/**
 * `EFFECT_DELETE`（scene.gsplat-persistent-scene）：从 settings 队列移除该类型及其参数块。
 */
export function applyGsplatPersistentEffectDelete(global: Global, effectType: string): void {
    return applyGsplatPersistentEffectDeleteForId(global, SCENE_GSPLAT_PERSISTENT_EFFECT_ID, effectType);
}

export function applyGsplatPersistentEffectDeleteForId(global: Global, effectId: string, effectType: string): void {
    const t = normalizePersistentType(effectType);
    if (t === null || t === 'none') return;

    const settings = getEffectsWriteTarget(global);
    const trackName = persistentTrackNameForEffectId(effectId) ?? persistentTrackNameForType(t);
    const hadBlock = getPersistentTrackEffect(settings, trackName, t) != null;
    if (!hadBlock) return;

    const hadEnabled = hasEnabledPersistentEffects(settings);
    removePersistentTrackEffect(settings, trackName, t);
    syncEffectsRuntimeStateFromSettings(global.state, settings);

    const enabledNow = readActivePersistentEffects(settings);
    notifyPersistentSceneEffectsUiSync(global);
    if (enabledNow.length === 0) {
        if (hadEnabled) {
            finalizePersistentGsplatTrackOff(global);
        }
        return;
    }
    requestPersistentGsplatRemount(global);
}

/**
 * 强制停止当前 reveal 播放（保留 `settings.effects.reveal` 配置）。
 * @param global
 */
export function applyGsplatRevealStopPlayback(global: Global): void {
    patchRevealRuntimeMirror(global.state, { status: 'completed' });
    syncEffectsRuntimeStateFromSettings(global.state, getEffectsReadSource(global));
    global.events.fire('vfxExit');
}
