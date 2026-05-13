import type { Entity } from 'playcanvas';
import { PERSISTENT_EFFECT_TYPE_VALUES } from '../../../types';
import { GsplatRevealPerlinWave } from './gsplat-perlin-wave';

/**
 * 可持续 GSplat scene reveal 的类型取值集合（与 `settings.revealEffect.type` / runtime reveal type 对齐）。
 * **单一真源**：`reveal-policy` 的 `PERSISTENT_VFX`、`effects-runtime` 内置轨 provider、`mountPersistentGsplatByEffectType` 均与此同一 `Set` 引用对齐。
 */
export const PERSISTENT_EFFECT_TYPES: ReadonlySet<string> = new Set(PERSISTENT_EFFECT_TYPE_VALUES);

/**
 * **可持续（persistent）GSplat 特效**：脚本创建、默认参数与导出/阈值辅助。
 *
 * 后续新增 persistent 类型时，在本模块增加对应的 `create*Script` 与门控/导出辅助，
 * 由 `viewer.ts`（或后续 `EffectsRuntime` 调度器）在 `RevealController` 之外挂载；**分派表**与本文件导出的 `PERSISTENT_REVEAL_EFFECT_TYPES` 对齐。
 */

/**
 * 按 `effectType` 挂载已知 persistent GSplat 脚本；未在分派表实现的类型返回 `null`。
 * 新增可持续类型时：先向 **`PERSISTENT_EFFECT_TYPES`** 添加 id，再在此 `switch` 增加分支。
 */
export function mountPersistentGsplatByEffectType(
    effectType: string,
    gsplatEntity: Entity,
    updateScriptCenter: (script: any) => void,
    autoStart: boolean
): any | null {
    if (!PERSISTENT_EFFECT_TYPES.has(effectType)) {
        return null;
    }
    switch (effectType) {
        case 'perlin-wave':
            return createPerlinWaveRevealScript(gsplatEntity, updateScriptCenter, autoStart);
        default:
            console.warn('[persistent-effect] persistent type in registry but no mount branch:', effectType);
            return null;
    }
}

/** `perlin-wave`：挂载脚本与默认参数 */
export function createPerlinWaveRevealScript(
    gsplatEntity: Entity,
    updateScriptCenter: (script: any) => void,
    autoStart: boolean
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
        console.error('Failed to create perlin-wave script:', error);
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
