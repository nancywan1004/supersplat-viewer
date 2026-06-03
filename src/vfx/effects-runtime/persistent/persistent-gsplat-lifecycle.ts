import type { Entity } from 'playcanvas';
import type { ExperienceSettings } from '../../../schemas/v2';
import type { Global } from '../../../types';
import {
    getPersistentTrackEffect,
    persistentTrackNameForType,
    readActivePersistentEffects
} from '../../../settings-serialize/effects-sync';
import {
    destroyAllPersistentGsplatScriptsOnEntity,
    destroyPersistentGsplatScriptOnEntity,
    getMountedPersistentGsplatScript
} from '../gsplat-effect-script-registry';
import type { RevealController } from '../reveal/reveal-controller';
import {
    getPersistentGsplatEffectsRuntimeScriptType,
    mountPersistentGsplatByEffectType,
    remountPersistentSceneGsplatOnEntity
} from './persistent-effect';

/**
 * Viewer 侧 **可持续 GSplat 实体生命周期** 单入口（M20）：registry 同步、读 settings、destroy/remount、animTrack。
 * 与 {@link RevealController} 仅通过其 **persistent 桥接 API** 交互，避免在 `viewer.ts` 堆叠业务细节。
 */
export function runPersistentGsplatEntityLifecycle(input: {
    global: Global;
    gsplatEntity: Entity;
    revealController: RevealController | null | undefined;
    restartAnimTrack: boolean;
}): void {
    const { global, gsplatEntity, revealController: rc, restartAnimTrack } = input;
    (global.app as any).effectsRuntime?.syncPersistentGsplatRegistryFromSettings?.();
    const persistentEntries = readActivePersistentEffects(global.settings as ExperienceSettings);
    if (persistentEntries.length === 0) {
        destroyAllPersistentGsplatScriptsOnEntity(gsplatEntity);
        if (rc) {
            rc.finishPersistentGsplatExternalUnmount();
        } else {
            (global.app as any).effectsRuntime?.notifyRevealScriptApplied('none');
        }
        return;
    }
    if (!rc || !gsplatEntity?.script) {
        return;
    }
    const mounted = remountPersistentSceneGsplatOnEntity(gsplatEntity, persistentEntries, {
        prepareExternalPersistentScriptMount: () => rc.prepareExternalPersistentScriptMount(),
        applyGsplatShaderScriptCenter: (s) => rc.applyGsplatShaderScriptCenter(s),
        bindPersistentTimelineScript: (s) => rc.bindPersistentTimelineScript(s),
        notifyRevealScriptApplied: (effectType) =>
            (global.app as any).effectsRuntime?.notifyRevealScriptApplied(effectType)
    });
    if (!mounted) {
        return;
    }
    if (restartAnimTrack) {
        global.events.fire('inputEvent', 'resetAnim');
    }
}

function pickPrimaryMountedPersistentScript(
    gsplatEntity: Entity,
    settings: ExperienceSettings
): { effectType: string; script: any } | null {
    for (const entry of readActivePersistentEffects(settings)) {
        const script = getMountedPersistentGsplatScript(gsplatEntity, entry.type) as any;
        if (script) {
            return { effectType: entry.type, script };
        }
    }
    return null;
}

function notifyPersistentGsplatRuntimeType(
    global: Global,
    gsplatEntity: Entity,
    settings: ExperienceSettings
): void {
    const t = getPersistentGsplatEffectsRuntimeScriptType(gsplatEntity, settings);
    (global.app as any).effectsRuntime?.notifyRevealScriptApplied(t);
}

/**
 * 仅切换某一 persistent 类型的场景挂载（`EFFECT_PARAMS_PATCH` 仅含 `enabled` 时使用，避免全量 remount）。
 */
export function applyPersistentSceneEffectEnableChange(input: {
    global: Global;
    gsplatEntity: Entity;
    revealController: RevealController | null | undefined;
    effectType: string;
    enabled: boolean;
}): void {
    const { global, gsplatEntity, revealController: rc, effectType, enabled } = input;
    const settings = global.settings as ExperienceSettings;
    const entry = getPersistentTrackEffect(settings, persistentTrackNameForType(effectType), effectType);
    if (!entry) {
        return;
    }

    (global.app as any).effectsRuntime?.syncPersistentGsplatRegistryFromSettings?.();

    if (!enabled) {
        destroyPersistentGsplatScriptOnEntity(gsplatEntity, effectType);
        const stillEnabled = readActivePersistentEffects(settings);
        if (stillEnabled.length === 0) {
            if (rc) {
                rc.finishPersistentGsplatExternalUnmount();
            } else {
                (global.app as any).effectsRuntime?.notifyRevealScriptApplied('none');
            }
            return;
        }
        if (rc) {
            const primary = pickPrimaryMountedPersistentScript(gsplatEntity, settings);
            rc.bindPersistentTimelineScript(primary?.script ?? null);
        }
        notifyPersistentGsplatRuntimeType(global, gsplatEntity, settings);
        return;
    }

    if (getMountedPersistentGsplatScript(gsplatEntity, effectType)) {
        notifyPersistentGsplatRuntimeType(global, gsplatEntity, settings);
        return;
    }
    if (!rc || !gsplatEntity?.script) {
        return;
    }

    const primaryBefore = pickPrimaryMountedPersistentScript(gsplatEntity, settings);

    rc.prepareExternalPersistentScriptMount();
    const script = mountPersistentGsplatByEffectType(
        effectType,
        gsplatEntity,
        (s) => rc.applyGsplatShaderScriptCenter(s),
        entry.autoStart ?? true,
        entry.effectParams
    );
    if (!script) {
        return;
    }
    if (!primaryBefore) {
        rc.bindPersistentTimelineScript(script);
    }
    notifyPersistentGsplatRuntimeType(global, gsplatEntity, settings);
}
