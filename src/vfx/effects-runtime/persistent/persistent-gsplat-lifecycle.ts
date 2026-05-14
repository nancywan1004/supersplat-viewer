import type { Entity } from 'playcanvas';
import type { ExperienceSettings } from '../../../schemas/v2';
import type { Global } from '../../../types';
import { readPersistentRevealParams } from '../../../settings-serialize/effects-sync';
import { destroyAllPersistentGsplatScriptsOnEntity } from '../gsplat-effect-script-registry';
import type { RevealController } from '../reveal/reveal-controller';
import { remountPersistentGsplatOnEntity } from './persistent-effect';

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
    const persistentReveal = readPersistentRevealParams(global.settings as ExperienceSettings);
    if (!persistentReveal?.type) {
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
    const mounted = remountPersistentGsplatOnEntity(gsplatEntity, persistentReveal, {
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
