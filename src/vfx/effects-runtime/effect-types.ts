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

/** 可持续 persistent 类型清单；`src/types.ts` 中 `PersistentEffectType` 与此同源 re-export */
export const PERSISTENT_EFFECT_TYPE_VALUES = [
    'perlin-wave',
    'falling-petals',
    'falling-rain',
    'falling-snow',
    'nostalgic-comic',
    'yiyun-dianran',
    'palette-pixel'
] as const;

/**
 * 可持续 persistent 类型 id 集合（与 {@link PERSISTENT_EFFECT_TYPE_VALUES} 同源）。
 * `reveal-policy` 的 `PERSISTENT_VFX`、`effects-runtime` 内置 persistent 轨、`mountPersistentGsplatByEffectType` 均与此同一 `Set` 引用对齐。
 */
export const PERSISTENT_EFFECT_TYPES: ReadonlySet<string> = new Set(PERSISTENT_EFFECT_TYPE_VALUES);

// --- 物体轨 asset（与 reveal / persistent 同形：固定包 id + 包内 `type`）---

/** 协议与 `settings.effects.asset` 共用的物体轨 GSplat 包 id */
export const ASSET_GSPLAT_EFFECT_ID = 'asset.gsplat-effects' as const;

/**
 * 物体特效 `type` 清单（GS变形 / 静物活化）；`src/types.ts` 中 `AssetEffectType` 与此同源 re-export。
 * 存盘与协议样式字段为 **`type`**（`instancesByTargetId[targetId].type` 或 `params.type`），非包 id。
 */
export const ASSET_EFFECT_TYPE_VALUES = ['gsplat-morph', 'gsplat-wobble'] as const;

export type AssetEffectType = (typeof ASSET_EFFECT_TYPE_VALUES)[number];

/**
 * 与 `AssetEffectsController` 分派一致的物体 `type` 集合。
 */
export const ASSET_EFFECT_TYPES: ReadonlySet<string> = new Set(ASSET_EFFECT_TYPE_VALUES);

/** 协议 `effectId` 是否为物体轨固定包 id */
export function isAssetGsplatPackageId(id: string): boolean {
    return id === ASSET_GSPLAT_EFFECT_ID;
}

/**
 * 从协议 `effectId` + `params.type` 解析物体特效样式（与 scene reveal 的 `params.type` 一致）。
 * 兼容旧协议：`effectId` 可直接为 `gsplat-morph` 等 type。
 * @param {string} effectId
 * @param {Record<string, unknown>} [params]
 * @returns {AssetEffectType | null}
 */
export function resolveAssetEffectType(
    effectId: string,
    params?: Record<string, unknown>
): AssetEffectType | null {
    if (ASSET_EFFECT_TYPES.has(effectId)) {
        return effectId as AssetEffectType;
    }
    if (!isAssetGsplatPackageId(effectId)) {
        return null;
    }
    const t = params?.type;
    if (typeof t === 'string' && ASSET_EFFECT_TYPES.has(t)) {
        return t as AssetEffectType;
    }
    return null;
}

/** 默认样式（清单首项，`gsplat-morph`） */
export function defaultAssetEffectType(): AssetEffectType {
    return ASSET_EFFECT_TYPE_VALUES[0];
}
