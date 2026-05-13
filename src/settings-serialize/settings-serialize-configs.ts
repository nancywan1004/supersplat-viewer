import type { BloomEditorSession } from '../schemas/v2';
import type { EffectsSettings } from '../schemas/v2-custom';
import { DEFAULT_VFX_TOTAL_DURATION } from '../schemas/v2-custom';
import { SCENE_GSPLAT_PERSISTENT_EFFECT_ID, SCENE_GSPLAT_REVEAL_EFFECT_ID } from '../vfx/effects-runtime/effects-runtime';

/** nightMode 子树缺省（`ensureNightMode`） */
export const DEFAULT_NIGHT_MODE = { fade: 0 } as const;

/** lighting 根节点缺省（仅 `lights` 空数组，`ensureLighting`） */
export const DEFAULT_LIGHTING_ROOT: { lights: unknown[] } = { lights: [] };

export const DEFAULT_BLOOM = {
    enabled: false,
    intensity: 0,
    blurLevel: 10,
    threshold: 0,
    bloomDebug: false,
    bloomScope: 'global' as const,
    bloomBrushSize: 30,
    bloomBrushBrightness: 1
} as const;

export const DEFAULT_BLOOM_EDITOR_SESSION: BloomEditorSession = {
    bloomBrush: false,
    activeLocalLightRegionId: null,
    draftLightRegionCenter: null
};

export const DEFAULT_SHADOW = {
    enabled: true,
    darken: 0,
    castShadows: true,
    debugVisual: false,
    sphereRadius: 0.5
} as const;

export const DEFAULT_REVEAL_EFFECT = {
    type: 'none' as const,
    radius: 10,
    autoStart: true,
    totalDuration: DEFAULT_VFX_TOTAL_DURATION
};

/** `settings.effects` 缺省骨架（reveal / persistent / asset）；持久化 enabled 仅 persistent 使用 */
export const DEFAULT_EFFECTS: EffectsSettings = {
    reveal: { activeEffectId: SCENE_GSPLAT_REVEAL_EFFECT_ID, paramsById: {} },
    persistent: { activeEffectId: SCENE_GSPLAT_PERSISTENT_EFFECT_ID, enabled: false, paramsById: {} },
    asset: { defaultParamsById: {} }
};
