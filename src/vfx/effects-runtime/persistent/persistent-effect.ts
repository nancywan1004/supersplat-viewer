import type { Entity } from 'playcanvas';
import { PERSISTENT_EFFECT_TYPES } from '../effect-types';
import { GsplatRevealPerlinWave } from './gsplat-perlin-wave';

/**
 * **可持续（persistent）GSplat 特效**：脚本创建、默认参数与导出/阈值辅助。
 *
 * 后续新增 persistent 类型时：先在 **`effect-types.ts`** 扩展 **`PERSISTENT_EFFECT_TYPE_VALUES`**（及由此衍生的 **`PERSISTENT_EFFECT_TYPES`**），再在本文件 `mountPersistentGsplatByEffectType` 增加 `switch` 分支与脚本工厂。
 */

/**
 * 按 `effectType` 挂载已知 persistent GSplat 脚本；未在分派表实现的类型返回 `null`。
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
        console.error('Failed to create perlin-wave reveal script:', error);
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
