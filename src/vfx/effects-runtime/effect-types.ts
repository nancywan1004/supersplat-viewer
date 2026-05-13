/** 通用特效生命周期（协议 / `settings.effects` 语义）。Reveal 子系统里「reveal / persistent **槽位**」见 `effects-runtime.ts` 的 `RevealRuntimeTrackKind`。 */
export type EffectLifecycle = 'oneShot' | 'persistent';

/** 场景级 / 资产级 / 镜头级（架构占位，M1 仅占位） */
export type EffectScope = 'scene' | 'asset' | 'camera';

/** 一次性 reveal：仅播放中或已完成 */
export type RevealEffectRuntimeStatus = 'inactive' | 'playing' | 'completed';
/** 可持续 persistent：仅播放中或暂停 */
export type PersistentEffectRuntimeStatus = 'inactive' | 'playing' | 'paused';
/** 资产特效：当前仅区分播放中与完成 */
export type AssetEffectRuntimeStatus = 'inactive' | 'playing' | 'completed';
/** 兼容聚合类型（无 idle/stopped/error） */
export type EffectRuntimeStatus = RevealEffectRuntimeStatus | PersistentEffectRuntimeStatus | AssetEffectRuntimeStatus;

/** 协议入站/出站固定 module 值 */
export const EFFECTS_PROTOCOL_MODULE = 'effect' as const;
export type EffectsProtocolModule = typeof EFFECTS_PROTOCOL_MODULE;
