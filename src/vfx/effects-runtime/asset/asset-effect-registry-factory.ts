import type { ExperienceSettings } from '../../../schemas/v2';
import type { EffectRegistry } from '../effect-registry';
import { ASSET_EFFECT_TYPE_VALUES } from '../effect-types';

/**
 * 按 `settings.effects.asset` 将物体特效注册到 `EffectRegistry`（M1：元数据占位，无 composer 贡献）。
 */
export function syncAssetEffectRegistryFactories(
    _settings: ExperienceSettings,
    registry: EffectRegistry
): void {
    for (const effectId of ASSET_EFFECT_TYPE_VALUES) {
        if (!registry.has(effectId)) {
            registry.register({ id: effectId });
        }
    }
}
