/** 通用特效生命周期（协议 / `settings.effects` 语义）。Reveal 子系统里「reveal / persistent **槽位**」见 `effects-runtime.ts` 的 `RevealRuntimeTrackKind`。 */
export type EffectLifecycle = 'oneShot' | 'persistent';

/** 场景级 / 资产级 / 镜头级（架构占位，M1 仅占位） */
export type EffectScope = 'scene' | 'asset' | 'camera';

/** 一次性 reveal：仅播放中或已完成 */
export type RevealEffectRuntimeStatus = 'inactive' | 'playing' | 'completed';
/** 可持续 persistent：仅播放中或暂停 */
export type PersistentEffectRuntimeStatus = 'inactive' | 'playing' | 'paused';
/** 资产特效：仅区分播放中与完成 */
export type AssetEffectRuntimeStatus = 'inactive' | 'playing' | 'completed';
/** 兼容聚合类型（无 idle/stopped/error） */
export type EffectRuntimeStatus = RevealEffectRuntimeStatus | PersistentEffectRuntimeStatus | AssetEffectRuntimeStatus;

// --- 协议 effectId（与 `settings.effects.*.activeEffectId` 对齐）；集中在此避免与 `types` / `effects-sync` 环依赖 ---

/** 协议与 `settings.effects.reveal` 共用的场景级 GSplat reveal 包 id */
export const SCENE_GSPLAT_REVEAL_EFFECT_ID = 'scene.gsplat-reveal' as const;
/** 协议与 `settings.effects.persistent` 共用的场景级 GSplat persistent 包 id */
export const SCENE_GSPLAT_PERSISTENT_EFFECT_ID = 'scene.gsplat-persistent' as const;

/** 一次性 reveal 类型清单（不含 persistent；不含 none）；`src/types.ts` 中 `RevealEffectType` 与此同源 re-export */
export const REVEAL_EFFECT_TYPE_VALUES = [
    'radial',
    'rain',
    'rain-v2',
    'smooth',
    'pieces-recover',
    'integrate',
    'growth-wave',
    'sketch'
] as const;

/**
 * 与 `RevealController.createEffect` 分派一致的一次性开场 `type` 集合；不含 `none`、不含可持续型。
 * 与 `effects-runtime` 内置 reveal 轨共用同一 `Set`。
 */
export const REVEAL_EFFECT_TYPES = new Set<string>([...REVEAL_EFFECT_TYPE_VALUES]);

/** 与持久类型 `perlin-wave` 一致，供 `EffectRegistry` 注册与 `tryCreateSceneGsplatContribution` 查询 */
export const PERLIN_WAVE_REGISTRY_EFFECT_ID = 'perlin-wave' as const;

export const SPARKLE_TWINKLE_REGISTRY_EFFECT_ID = 'sparkle-twinkle' as const;

export const OVERALL_WAVE_REGISTRY_EFFECT_ID = 'overall-wave' as const;

export const BUTTERFLY_PARTICLE_REGISTRY_EFFECT_ID = 'butterfly-particle' as const;

/** 可持续 persistent 类型清单；`src/types.ts` 中 `PersistentEffectType` 与此同源 re-export */
export const PERSISTENT_EFFECT_TYPE_VALUES = [
    'perlin-wave',
    'sparkle-twinkle',
    'overall-wave',
    'butterfly-particle'
] as const;

/**
 * 可持续 persistent 类型 id 集合（与 {@link PERSISTENT_EFFECT_TYPE_VALUES} 同源）。
 * `reveal-policy` 的 `PERSISTENT_VFX`、`effects-runtime` 内置 persistent 轨、`mountPersistentGsplatByEffectType` 均与此同一 `Set` 引用对齐。
 */
export const PERSISTENT_EFFECT_TYPES: ReadonlySet<string> = new Set(PERSISTENT_EFFECT_TYPE_VALUES);
