import type { ExperienceSettings } from '../../../settings';
import { readPersistentSceneEffects } from '../../../settings-serialize/effects-sync';
import type { EffectRegistry } from '../effect-registry';
import { extractGlslWgslModifyBlocks, OVERALL_WAVE_COMPOSER_ID, PERLIN_WAVE_COMPOSER_ID } from '../gsplat-effect-layers-extractor';
import { OVERALL_WAVE_REGISTRY_EFFECT_ID, PERLIN_WAVE_REGISTRY_EFFECT_ID } from '../effect-types';
import { overallWaveShaderGlsl, overallWaveShaderWgsl } from './gsplat-overall-wave-shaders';
import { perlinWaveShaderGlsl, perlinWaveShaderWgsl } from './gsplat-perlin-wave-shaders';

/** key 与 `settings.effects.persistent.scene` 条目的 `type` 一致 */
const PERSISTENT_GSPLAT_REGISTRY_FACTORIES: Record<string, (registry: EffectRegistry) => void> = {
    [PERLIN_WAVE_REGISTRY_EFFECT_ID]: (registry) => {
        registry.register({
            id: PERLIN_WAVE_REGISTRY_EFFECT_ID,
            createSceneGsplatContribution: (ctx) => {
                const shaderBlocks = extractGlslWgslModifyBlocks(perlinWaveShaderGlsl, perlinWaveShaderWgsl);
                return {
                    id: PERLIN_WAVE_COMPOSER_ID,
                    priority: 20,
                    scope: 'scene',
                    enabled: true,
                    version: ctx.revision ?? 0,
                    shaderBlocks,
                    capabilities: { allowConcurrentWithPersistent: true }
                };
            }
        });
    },
    [OVERALL_WAVE_REGISTRY_EFFECT_ID]: (registry) => {
        registry.register({
            id: OVERALL_WAVE_REGISTRY_EFFECT_ID,
            createSceneGsplatContribution: (ctx) => {
                const shaderBlocks = extractGlslWgslModifyBlocks(overallWaveShaderGlsl, overallWaveShaderWgsl);
                return {
                    id: OVERALL_WAVE_COMPOSER_ID,
                    priority: 21,
                    scope: 'scene',
                    enabled: true,
                    version: ctx.revision ?? 0,
                    shaderBlocks,
                    capabilities: { allowConcurrentWithPersistent: true }
                };
            }
        });
    }
};

/**
 * 按 settings 真源在 `EffectRegistry` 上按需注册 / 卸载 persistent 对应的 scene gsplat 工厂。
 */
export function syncPersistentGsplatRegistryFactories(settings: ExperienceSettings, registry: EffectRegistry): void {
    const enabledIds = new Set(readPersistentSceneEffects(settings).map(e => e.type));

    for (const factoryId of Object.keys(PERSISTENT_GSPLAT_REGISTRY_FACTORIES)) {
        if (!enabledIds.has(factoryId) && registry.has(factoryId)) {
            registry.unregister(factoryId);
        }
    }

    for (const factoryId of enabledIds) {
        const registerFactory = PERSISTENT_GSPLAT_REGISTRY_FACTORIES[factoryId];
        if (registerFactory && !registry.has(factoryId)) {
            registerFactory(registry);
        }
    }
}
