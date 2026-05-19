/**
 * 场景 GSplat reveal / persistent 协议映射：`EFFECT_PARAMS_PATCH` / `EFFECT_TOGGLE` 对 settings、state 的写入及事件派发。
 * reveal：`params` → `patchRevealSettingsFromParams`；persistent：`params`（`type` / `enabled` / `autoStart` / `effectParams`）→ `patchPersistentSettingsFromParams`（**persistent 包无** `totalDuration`）。
 * 由 EffectsFacade 调用；payload 须含合法 `effectId`（见 `SCENE_GSPLAT_REVEAL_EFFECT_ID`）。`module` 可选。
 */

import type { ExperienceSettings } from '../../schemas/v2';
import type { LegacyRevealEffect } from '../../schemas/v2-custom';
import {
    clearPersistentRevealTrack,
    ensureEffectsSettings,
    getRevealStatus,
    patchPersistentSettingsFromParams,
    patchRevealRuntimeMirror,
    patchRevealSettingsFromParams,
    readRevealParams,
    syncEffectsRuntimeStateFromSettings
} from '../../settings-serialize/effects-sync';
import { PERSISTENT_EFFECT_TYPE_VALUES } from '../../types';
import type { Global, PersistentEffectType } from '../../types';
import { SCENE_GSPLAT_PERSISTENT_EFFECT_ID } from '../../vfx/effects-runtime/effects-runtime';
import { isPersistentVfx } from '../../vfx/effects-runtime/reveal/reveal-policy';
import { EFFECTS_PROTOCOL_MODULE, type EffectsProtocolModule } from '../modules-types';

export { SCENE_GSPLAT_REVEAL_EFFECT_ID, SCENE_GSPLAT_PERSISTENT_EFFECT_ID } from '../../vfx/effects-runtime/effects-runtime';

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

export function isEffectProtocolEnvelope(
    p: unknown
): p is { effectId: string; module?: EffectsProtocolModule } {
    if (typeof p !== 'object' || p === null) return false;
    const o = p as Record<string, unknown>;
    if (typeof o.effectId !== 'string') return false;
    if (o.module === undefined) return true;
    return o.module === EFFECTS_PROTOCOL_MODULE;
}

const PATCH_KEYS = ['type', 'totalDuration', 'autoStart'] as const;

export function paramsPatchHasRevealKeys(params: Record<string, unknown>): boolean {
    if (params.effectParams !== undefined) {
        if (params.effectParams === null) return true;
        return typeof params.effectParams === 'object' && !Array.isArray(params.effectParams);
    }
    return PATCH_KEYS.some(k => params[k] !== undefined);
}

export function paramsPatchHasPersistentKeys(params: Record<string, unknown>): boolean {
    if (Object.prototype.hasOwnProperty.call(params, 'type')) return true;
    if (typeof params.enabled === 'boolean') return true;
    if (Object.prototype.hasOwnProperty.call(params, 'effectParams')) return true;
    if (typeof params.autoStart === 'boolean') return true;
    return false;
}

/**
 * EFFECT_PARAMS_PATCH（scene reveal）：增量写 `settings.effects.reveal`（运行期真源），
 * 并同步 `effectsRuntimeState`（`syncEffectsRuntimeStateFromSettings`）后派发 `revealConfigChanged`。
 * @param global
 * @param params
 */
export function applyGsplatRevealParamsPatch(global: Global, params: Record<string, unknown>): void {
    if (!paramsPatchHasRevealKeys(params)) return;
    const settings = global.settings;
    const current = readRevealParams(settings);

    const patch: Partial<LegacyRevealEffect> = {};

    if (typeof params.type === 'string') {
        const oldType = (current?.type ?? 'none') as string;
        if (isPersistentVfx(oldType as any) && !isPersistentVfx(params.type as any)) {
            clearPersistentRevealTrack(settings as ExperienceSettings);
        }
        patch.type = params.type as LegacyRevealEffect['type'];
    }
    if (typeof params.totalDuration === 'number' && !Number.isNaN(params.totalDuration) && params.totalDuration > 0) {
        patch.totalDuration = params.totalDuration;
    }
    if (typeof params.autoStart === 'boolean') {
        patch.autoStart = params.autoStart;
    }
    if (params.effectParams !== undefined) {
        if (params.effectParams === null) {
            patch.effectParams = {};
        } else if (typeof params.effectParams === 'object' && !Array.isArray(params.effectParams)) {
            patch.effectParams = params.effectParams as Record<string, unknown>;
        }
    }

    if (Object.keys(patch).length === 0) return;

    const merged = patchRevealSettingsFromParams(settings as ExperienceSettings, patch);
    syncEffectsRuntimeStateFromSettings(global.state, settings);
    global.events.fire('revealConfigChanged', merged);
}

/**
 * 仅切换类型时走增量补丁（与 `EFFECT_PARAMS_PATCH` 单字段语义一致）。
 * @param global
 * @param effectType
 */
export function applyGsplatRevealTypePatch(global: Global, effectType: string): void {
    applyGsplatRevealParamsPatch(global, { type: effectType });
}

const PERSISTENT_TYPE_SET = new Set<string>(PERSISTENT_EFFECT_TYPE_VALUES as readonly string[]);

/**
 * 供 `EFFECT_PARAMS_PATCH`（persistent 轨）与读回真源：`none` 含大小写/空白；未知字符串返回 `null`。
 * @param raw
 */
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
 * @param global
 */
export function finalizePersistentGsplatTrackOff(global: Global): void {
    syncEffectsRuntimeStateFromSettings(global.state, global.settings);
    dispatchPersistentGsplatTeardownAfterSettingsSync(global);
}

/**
 * 假定调用前已 `syncEffectsRuntimeStateFromSettings`：仅停播判定 + remount 事件。
 * @param global
 */
function dispatchPersistentGsplatTeardownAfterSettingsSync(global: Global): void {
    const settings = global.settings as ExperienceSettings;
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
export function applyGsplatPersistentParamsPatch(global: Global, params: Record<string, unknown>): void {
    if (!paramsPatchHasPersistentKeys(params)) return;

    const hasTypePatch = Object.prototype.hasOwnProperty.call(params, 'type');
    const hasEnabledPatch = typeof params.enabled === 'boolean';
    const hasEffectParamsPatch = Object.prototype.hasOwnProperty.call(params, 'effectParams');
    const hasAutoStartPatch = typeof params.autoStart === 'boolean';
    const nextPersistentType = hasTypePatch ? normalizePersistentType(params.type) : null;
    if (hasTypePatch && nextPersistentType === null) return;

    const settings = global.settings;
    const effects = ensureEffectsSettings(settings);
    const id = SCENE_GSPLAT_PERSISTENT_EFFECT_ID;

    // 与文档一致：`type` 为 none（含 `NONE` / 空白）即关闭可持续轨，清空 scene 包，避免 paramsById 残留脏 type
    if (hasTypePatch && nextPersistentType === 'none') {
        clearPersistentRevealTrack(settings as ExperienceSettings);
        finalizePersistentGsplatTrackOff(global);
        return;
    }

    const persistentPatch: Partial<LegacyRevealEffect> = {};
    if (hasTypePatch && nextPersistentType !== null) {
        persistentPatch.type = nextPersistentType as LegacyRevealEffect['type'];
    }
    if (hasAutoStartPatch) {
        persistentPatch.autoStart = params.autoStart as boolean;
    }
    if (hasEffectParamsPatch) {
        if (params.effectParams === null) {
            persistentPatch.effectParams = null;
        } else if (typeof params.effectParams === 'object' && !Array.isArray(params.effectParams)) {
            persistentPatch.effectParams = params.effectParams as Record<string, unknown>;
        }
    }

    if (Object.keys(persistentPatch).length > 0) {
        patchPersistentSettingsFromParams(settings as ExperienceSettings, persistentPatch);
    }

    if (hasEnabledPatch) {
        effects.persistent.enabled = params.enabled as boolean;
    } else if (hasTypePatch && nextPersistentType !== null && nextPersistentType !== 'none') {
        effects.persistent.enabled = true;
    }
    syncEffectsRuntimeStateFromSettings(global.state, settings);

    const nextPack = (effects.persistent.paramsById[id] as Record<string, unknown> | undefined) ?? {};
    const effectivePersistentType = normalizePersistentType(nextPack.type);
    const hasEffectivePersistentType = effectivePersistentType !== null && effectivePersistentType !== 'none';
    const currentRevealType = readRevealParams(settings)?.type ?? 'none';

    if (effects.persistent.enabled === false || !hasEffectivePersistentType) {
        dispatchPersistentGsplatTeardownAfterSettingsSync(global);
        return;
    }

    const effectParamsOnlyPatch =
        hasEffectParamsPatch &&
        !hasTypePatch &&
        !hasEnabledPatch &&
        !hasAutoStartPatch;
    if (effectParamsOnlyPatch) {
        global.events.fire('persistentRevealConfigChanged', {
            type: effectivePersistentType,
            effectParams: nextPack.effectParams
        });
        return;
    }

    const packMutated = Object.keys(persistentPatch).length > 0;
    if (!hasTypePatch && !hasEnabledPatch && !packMutated) {
        return;
    }
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

/**
 * 强制停止当前 reveal 播放（保留 `settings.effects.reveal` 配置）。
 * @param global
 */
export function applyGsplatRevealStopPlayback(global: Global): void {
    patchRevealRuntimeMirror(global.state, { status: 'completed' });
    syncEffectsRuntimeStateFromSettings(global.state, global.settings);
    global.events.fire('vfxExit');
}
