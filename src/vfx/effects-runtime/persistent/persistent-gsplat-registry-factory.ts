import type { ExperienceSettings } from '../../../settings';
import { readPersistentRevealParams } from '../../../settings-serialize/effects-sync';
import type { EffectRegistry } from '../effect-registry';
import { extractGlslWgslModifyBlocks, PERLIN_WAVE_COMPOSER_ID } from '../gsplat-effect-layers-extractor';
import { PERLIN_WAVE_REGISTRY_EFFECT_ID } from '../effect-types';
import { shaderGLSL, shaderWGSL } from './gsplat-perlin-wave-shaders';

/** key 与 `readPersistentRevealParams` 的 `type` 一致；无配置时不注册任何项 */
const PERSISTENT_GSPLAT_REGISTRY_FACTORIES: Record<string, (registry: EffectRegistry) => void> = {
    [PERLIN_WAVE_REGISTRY_EFFECT_ID]: (registry) => {
        registry.register({
            id: PERLIN_WAVE_REGISTRY_EFFECT_ID,
            createSceneGsplatContribution: (ctx) => {
                const shaderBlocks = extractGlslWgslModifyBlocks(shaderGLSL, shaderWGSL);
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
    }
};

/**
 * 按 settings 真源在 `EffectRegistry` 上按需注册 / 卸载 persistent 对应的 scene gsplat 工厂。
 */
export function syncPersistentGsplatRegistryFactories(settings: ExperienceSettings, registry: EffectRegistry): void {
    const p = readPersistentRevealParams(settings);
    const nextFactoryId = p?.type ?? '';

    for (const factoryId of Object.keys(PERSISTENT_GSPLAT_REGISTRY_FACTORIES)) {
        if (factoryId !== nextFactoryId && registry.has(factoryId)) {
            registry.unregister(factoryId);
        }
    }

    const registerFactory = PERSISTENT_GSPLAT_REGISTRY_FACTORIES[nextFactoryId];
    if (registerFactory && !registry.has(nextFactoryId)) {
        registerFactory(registry);
    }
}
