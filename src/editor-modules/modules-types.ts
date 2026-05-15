/**
 * 与左侧 **`editLeftModule`** / `CommandRegistry` 门面键一致的 postMessage **`module`** 字面值（仅此四类）。
 * 入站 `EFFECT_*` 若带 `module`，须为 **`effects`**（与出站、门面键统一）。
 */
export const MESSAGE_BRIDGE_MODULE = {
    asset: 'asset' as const,
    annotation: 'annotation' as const,
    environment: 'environment' as const,
    effects: 'effects' as const
} as const;

/** 入站 `EFFECT_*` 的 `module` 字面值，等于 {@link MESSAGE_BRIDGE_MODULE.effects} */
export const EFFECTS_PROTOCOL_MODULE = MESSAGE_BRIDGE_MODULE.effects;

export type EffectsProtocolModule = typeof EFFECTS_PROTOCOL_MODULE;
