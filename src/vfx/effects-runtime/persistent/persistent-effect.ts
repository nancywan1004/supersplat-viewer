import type { Entity } from 'playcanvas';
import type { ExperienceSettings } from '../../../schemas/v2';
import type { PersistentSceneEffectEntry } from '../../../schemas/v2-custom';
import { readPersistentSceneEffects } from '../../../settings-serialize/effects-sync';
import { destroyAllPersistentGsplatScriptsOnEntity, getMountedPersistentGsplatScript } from '../gsplat-effect-script-registry';
import { PERSISTENT_EFFECT_TYPES } from '../effect-types';
import { isPersistentVfx } from '../reveal/reveal-policy';
import { GsplatRevealPerlinWave } from './gsplat-perlin-wave';
import { GsplatPersistentOverallWave } from './gsplat-overall-wave';
import { GsplatPersistentButterflyParticle } from './gsplat-butterfly-particle';
import { GsplatPersistentSparkleTwinkle } from './gsplat-sparkle-twinkle';
import { applyPersistentEffectParamsToScript } from './persistent-effect-params';

/**
 * **可持续（persistent）GSplat 特效**：脚本创建、默认参数与导出/阈值辅助。
 *
 * 后续新增 persistent 类型时：先在 **`effect-types.ts`** 扩展 **`PERSISTENT_EFFECT_TYPE_VALUES`**，再在 **`gsplat-effect-script-registry.ts`** 的 `GSPLAT_PERSISTENT_SCRIPT_NAME_BY_TYPE` 登记 `scriptName`；一次性 reveal 同理扩展 **`REVEAL_EFFECT_TYPE_VALUES`** 与 **`GSPLAT_REVEAL_SCRIPT_NAME_BY_TYPE`**。在本文件 `mountPersistentGsplatByEffectType` 增加分支；专参白名单见 **`persistent-effect-params.ts`**。Viewer 侧 remount 入口见 **`persistent-gsplat-lifecycle.ts`** 的 **`runPersistentGsplatEntityLifecycle`**。
 */

/**
 * 按 `effectType` 挂载已知 persistent GSplat 脚本；未在分派表实现的类型返回 `null`。
 */
export function mountPersistentGsplatByEffectType(
    effectType: string,
    gsplatEntity: Entity,
    updateScriptCenter: (script: any) => void,
    autoStart: boolean,
    effectParams?: Record<string, unknown> | null
): any | null {
    if (!PERSISTENT_EFFECT_TYPES.has(effectType)) {
        return null;
    }
    switch (effectType) {
        case 'perlin-wave':
            return createPerlinWaveRevealScript(gsplatEntity, updateScriptCenter, autoStart, effectParams);
        case 'sparkle-twinkle':
            return createSparkleTwinkleScript(gsplatEntity, updateScriptCenter, autoStart, effectParams);
        case 'overall-wave':
            return createOverallWaveScript(gsplatEntity, updateScriptCenter, autoStart, effectParams);
        case 'butterfly-particle':
            return createButterflyParticleScript(gsplatEntity, updateScriptCenter, autoStart, effectParams);
        default:
            console.warn('[persistent-effect] persistent type in registry but no mount branch:', effectType);
            return null;
    }
}

/** `perlin-wave`：挂载脚本与默认参数 */
export function createPerlinWaveRevealScript(
    gsplatEntity: Entity,
    updateScriptCenter: (script: any) => void,
    autoStart: boolean,
    effectParams?: Record<string, unknown> | null
): any | null {
    if (!gsplatEntity.script) {
        console.warn('Cannot create perlin-wave script - entity or script component not ready');
        return null;
    }

    console.log('Creating perlin-wave reveal script');

    try {
        const script = gsplatEntity.script.create(GsplatRevealPerlinWave) as any;
        if (script) {
            script.intensity = 0.8;
            script.waveAmplitude = 0.2;
            script.wavelength = 2.5;
            script.waveSpeed = 0.5;
            script.scaleBlend = 0.75;

            updateScriptCenter(script);

            applyPersistentEffectParamsToScript(script, 'perlin-wave', effectParams ?? undefined);

            script.enabled = autoStart;
            script.effectTime = 0;

            console.log('Perlin-wave script created with config:', {
                center: script.center,
                intensity: script.intensity,
                waveAmplitude: script.waveAmplitude,
                wavelength: script.wavelength,
                waveFrequency: script.waveFrequency,
                waveSpeed: script.waveSpeed,
                scaleBlend: script.scaleBlend,
                enabled: script.enabled
            });
        }
        return script;
    } catch (error) {
        console.error('Failed to create perlin-wave reveal script:', error);
        return null;
    }
}

export function createOverallWaveScript(
    gsplatEntity: Entity,
    updateScriptCenter: (script: any) => void,
    autoStart: boolean,
    effectParams?: Record<string, unknown> | null
): any | null {
    if (!gsplatEntity.script) {
        console.warn('Cannot create overall-wave script - entity or script component not ready');
        return null;
    }

    console.log('Creating overall-wave script');

    try {
        const script = gsplatEntity.script.create(GsplatPersistentOverallWave) as any;
        if (script) {
            updateScriptCenter(script);
            applyPersistentEffectParamsToScript(script, 'overall-wave', effectParams ?? undefined);
            script.enabled = autoStart;
            script.effectTime = 0;

            console.log('Overall-wave script created with config:', {
                center: script.center,
                noiseType: script.noiseType,
                waveDirection: script.waveDirection,
                waveAmplitude: script.waveAmplitude,
                wavelength: script.wavelength,
                waveSpeed: script.waveSpeed,
                intensity: script.intensity,
                crestTint: script.crestTint,
                troughTint: script.troughTint,
                enabled: script.enabled
            });
        }
        return script;
    } catch (error) {
        console.error('Failed to create overall-wave script:', error);
        return null;
    }
}

export function createButterflyParticleScript(
    gsplatEntity: Entity,
    updateScriptCenter: (script: any) => void,
    autoStart: boolean,
    effectParams?: Record<string, unknown> | null
): any | null {
    if (!gsplatEntity.script) {
        console.warn('Cannot create butterfly-particle script - entity or script component not ready');
        return null;
    }

    console.log('Creating butterfly-particle script');

    try {
        const script = gsplatEntity.script.create(GsplatPersistentButterflyParticle) as any;
        if (script) {
            updateScriptCenter(script);
            applyPersistentEffectParamsToScript(script, 'butterfly-particle', effectParams ?? undefined);
            script.requestRebuild?.();
            script.enabled = autoStart;
            script.effectTime = 0;

            console.log('Butterfly-particle script created with config:', {
                center: script.center,
                pointSize: script.pointSize,
                twinkleSpeed: script.twinkleSpeed,
                twinkleMin: script.twinkleMin,
                brightness: script.brightness,
                gsLightEnabled: script.gsLightEnabled,
                gsLightIntensity: script.gsLightIntensity,
                gsLightRange: script.gsLightRange,
                enabled: script.enabled
            });
        }
        return script;
    } catch (error) {
        console.error('Failed to create butterfly-particle script:', error);
        return null;
    }
}

export function createSparkleTwinkleScript(
    gsplatEntity: Entity,
    updateScriptCenter: (script: any) => void,
    autoStart: boolean,
    effectParams?: Record<string, unknown> | null
): any | null {
    if (!gsplatEntity.script) {
        console.warn('Cannot create sparkle-twinkle script - entity or script component not ready');
        return null;
    }

    console.log('Creating sparkle-twinkle script');

    try {
        const script = gsplatEntity.script.create(GsplatPersistentSparkleTwinkle) as any;
        if (script) {
            updateScriptCenter(script);
            applyPersistentEffectParamsToScript(script, 'sparkle-twinkle', effectParams ?? undefined);
            script.requestRebuild?.();
            script.enabled = autoStart;
            script.effectTime = 0;

            console.log('Sparkle-twinkle script created with config:', {
                center: script.center,
                pointSize: script.pointSize,
                sparkleDensity: script.sparkleDensity,
                twinkleSpeed: script.twinkleSpeed,
                twinkleMin: script.twinkleMin,
                twinkleSharpness: script.twinkleSharpness,
                brightness: script.brightness,
                lightTint1: script.lightTint1,
                lightTint2: script.lightTint2,
                lightTint3: script.lightTint3,
                colorBlendMode: script.colorBlendMode,
                enabled: script.enabled
            });
        }
        return script;
    } catch (error) {
        console.error('Failed to create sparkle-twinkle script:', error);
        return null;
    }
}

/**
 * 导出时间轴上的 effectTime 截断策略。
 * `unboundedOnVideoExport === true` 时（如 perlin-wave）覆盖整段视频时长，不按 `exportCeiling` 截断。
 */
export function clampExportEffectTimeForPersistent(
    unboundedOnVideoExport: boolean,
    time: number,
    exportCeiling: number
): number {
    if (unboundedOnVideoExport) {
        return Math.max(0, time);
    }
    return Math.max(0, Math.min(time, exportCeiling));
}

/**
 * 在已拆掉一次性 reveal 脚本之后调用：按当前 `settings` 是否仍启用 persistent、以及实体上是否已有对应脚本，
 * 调用 `bindPersistentTimelineScript(script | null)`，与 `vfxExit` / `teardownOneShotRevealGsplatScripts('stopOneShotRebindPersistentIfConfigured')` 语义一致。
 * 逻辑集中在此文件，避免在 `RevealController` 内散落 settings 与 registry 对齐代码。
 */
export function rebindPersistentGsplatTimelineFromSettings(
    gsplatEntity: Entity | null | undefined,
    settings: ExperienceSettings,
    bindPersistentTimelineScript: (script: any | null) => void
): void {
    if (!gsplatEntity?.script) {
        bindPersistentTimelineScript(null);
        return;
    }
    const enabled = readPersistentSceneEffects(settings);
    let primary: any = null;
    for (const entry of enabled) {
        const script = getMountedPersistentGsplatScript(gsplatEntity, entry.type) as any;
        if (script && !primary) {
            primary = script;
        }
    }
    bindPersistentTimelineScript(primary);
}

/** `forceStopVfx` 末尾与 `EffectsRuntime` 快照对齐：当前 persistent 轨应对应的 effectType（无则 `'none'`）。 */
export function getPersistentGsplatEffectsRuntimeScriptType(
    gsplatEntity: Entity | null | undefined,
    settings: ExperienceSettings
): string {
    const enabled = readPersistentSceneEffects(settings);
    if (enabled.length === 0) {
        return 'none';
    }
    for (const entry of enabled) {
        if (getMountedPersistentGsplatScript(gsplatEntity, entry.type)) {
            return entry.type;
        }
    }
    return enabled[0].type;
}

/** Viewer 注入：与 `RevealController` / `EffectsRuntime` 解耦，仅保留挂载所需回调。 */
export type PersistentGsplatRemountCallbacks = {
    prepareExternalPersistentScriptMount: () => void;
    applyGsplatShaderScriptCenter: (script: any) => void;
    bindPersistentTimelineScript: (script: any | null) => void;
    notifyRevealScriptApplied: (effectType: string) => void;
};

/**
 * 配置启用 persistent 时的**唯一推荐挂载顺序**（先 prepare → 拆掉旧 persistent → create → bind → 快照）。
 * 与一次性 reveal 的 teardown 分属不同调用栈，由 `persistentGsplatEffectRemountRequested` / 首帧 sync 统一进入。
 *
 * @returns 是否成功创建并绑定脚本（`mount` 失败则为 `false`，调用方勿再假定已挂载）
 */
/** 按 scene persistent 多选配置挂载全部 `enable` 为 true 的类型；时间轴绑定第一个成功挂载的脚本。 */
export function remountPersistentSceneGsplatOnEntity(
    gsplatEntity: Entity,
    entries: PersistentSceneEffectEntry[],
    callbacks: PersistentGsplatRemountCallbacks
): boolean {
    callbacks.prepareExternalPersistentScriptMount();
    destroyAllPersistentGsplatScriptsOnEntity(gsplatEntity);
    let primary: any = null;
    const mountedTypes: string[] = [];
    for (const entry of entries) {
        if (!entry.enable) {
            continue;
        }
        const script = mountPersistentGsplatByEffectType(
            entry.type,
            gsplatEntity,
            callbacks.applyGsplatShaderScriptCenter,
            entry.autoStart ?? true,
            entry.effectParams
        );
        if (script) {
            mountedTypes.push(entry.type);
            if (!primary) {
                primary = script;
            }
        }
    }
    if (!primary) {
        return false;
    }
    callbacks.bindPersistentTimelineScript(primary);
    callbacks.notifyRevealScriptApplied(mountedTypes.join('+') || 'none');
    return true;
}

/** @deprecated 使用 {@link remountPersistentSceneGsplatOnEntity} */
export function remountPersistentGsplatOnEntity(
    gsplatEntity: Entity,
    persistentReveal: { type: string; autoStart?: boolean; effectParams?: Record<string, unknown> },
    callbacks: PersistentGsplatRemountCallbacks
): boolean {
    return remountPersistentSceneGsplatOnEntity(
        gsplatEntity,
        [
            {
                type: persistentReveal.type,
                enable: true,
                autoStart: persistentReveal.autoStart ?? true,
                effectParams: persistentReveal.effectParams
            }
        ],
        callbacks
    );
}
