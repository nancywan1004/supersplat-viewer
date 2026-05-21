/**
 * 物体特效协议：`EFFECT_START` / `EFFECT_STOP` / `EFFECT_PARAMS_PATCH`（asset 轨）→ settings + 运行态 + 事件。
 * 与 scene 对齐：`effectId` 固定为 `asset.gsplat-effects`，样式在 `params.type`。
 */

import type { ExperienceSettings } from '../../schemas/v2';
import {
    patchAssetInstanceFromParams,
    patchAssetRuntimeMirror,
    readAssetInstanceParams,
    syncAssetInstancesRuntimeFromSettings,
    syncEffectsRuntimeStateFromSettings
} from '../../settings-serialize/effects-sync';
import type { Global } from '../../types';
import { filterAssetEffectParams, paramsPatchHasAssetKeys } from '../../vfx/effects-runtime/asset/asset-effect-params';
import {
    readMorphKeyframeEntityIds,
    resolveAssetEffectGsplatEntity,
    validateAssetEffectStartEntities,
    type AssetEffectStartEntities
} from '../../vfx/effects-runtime/asset/asset-effect-entity';
import {
    ASSET_GSPLAT_EFFECT_ID,
    isAssetGsplatPackageId,
    resolveAssetEffectType,
    type AssetEffectType
} from '../../vfx/effects-runtime/effect-types';
import { EFFECTS_PROTOCOL_MODULE, type EffectsProtocolModule } from '../modules-types';

export type AssetEffectProtocolEnvelope = {
    module?: EffectsProtocolModule;
    effectId: string;
    targetId: string;
    params?: Record<string, unknown>;
};

export function isAssetEffectProtocolEnvelope(
    p: unknown
): p is AssetEffectProtocolEnvelope {
    if (typeof p !== 'object' || p === null) {
        return false;
    }
    const o = p as Record<string, unknown>;
    if (typeof o.effectId !== 'string' || typeof o.targetId !== 'string') {
        return false;
    }
    if (!isAssetGsplatPackageId(o.effectId) && resolveAssetEffectType(o.effectId, undefined) === null) {
        return false;
    }
    if (o.module === undefined) {
        return true;
    }
    return o.module === EFFECTS_PROTOCOL_MODULE;
}

export function sceneAssetTargetExists(global: Global, targetId: string): boolean {
    const placed = global.state.scenePlacedEntities ?? [];
    if (placed.some((it) => it?.id === targetId)) {
        return true;
    }
    const assets = (global.settings as ExperienceSettings).sceneAssets ?? [];
    return assets.some((a) => a?.id === targetId);
}

function mergeStartParams(
    effectType: string,
    params?: Record<string, unknown>
): {
    type: string;
    enabled?: boolean;
    autoStart?: boolean;
    effectParams?: Record<string, unknown>;
} {
    const patch: {
        type: string;
        enabled?: boolean;
        autoStart?: boolean;
        effectParams?: Record<string, unknown>;
    } = { type: effectType, enabled: true };

    if (typeof params?.enabled === 'boolean') {
        patch.enabled = params.enabled;
    }
    if (typeof params?.autoStart === 'boolean') {
        patch.autoStart = params.autoStart;
    }
    const rawEp = params?.effectParams;
    if (rawEp !== undefined && typeof rawEp === 'object' && !Array.isArray(rawEp)) {
        patch.effectParams = filterAssetEffectParams(effectType, rawEp as Record<string, unknown>);
    } else if (params && typeof params === 'object') {
        const flat = filterAssetEffectParams(effectType, params);
        if (Object.keys(flat).length > 0) {
            patch.effectParams = flat;
        }
    }
    return patch;
}

/**
 * 由 effectParams 中的 entity id 解析运行时 Entity（供 controller 统一入口使用）。
 * @ignore
 */
function buildRuntimeEntitiesFromEffectParams(
    global: Global,
    effectType: string,
    configTargetId: string,
    effectParams: Record<string, unknown> | undefined
): AssetEffectStartEntities | undefined {
    const ep = effectParams ?? {};
    if (effectType === 'gsplat-wobble') {
        const entityId =
            typeof ep.entityId === 'string' && ep.entityId.length > 0 ? ep.entityId : configTargetId;
        const ent = resolveAssetEffectGsplatEntity(global, entityId);
        return ent ? { primary: ent } : undefined;
    }
    if (effectType === 'gsplat-morph') {
        const ids = readMorphKeyframeEntityIds(ep);
        if (!ids) {
            return undefined;
        }
        const keyframeEntities = ids
            .map((id) => resolveAssetEffectGsplatEntity(global, id))
            .filter((e): e is NonNullable<typeof e> => !!e);
        if (keyframeEntities.length !== ids.length) {
            return undefined;
        }
        return { keyframeEntities };
    }
    return undefined;
}

/**
 * `EFFECT_START`：写入实例配置并派发 `assetEffect:start`。
 */
export function applyAssetEffectStart(global: Global, envelope: AssetEffectProtocolEnvelope): boolean {
    const effectType = resolveAssetEffectType(envelope.effectId, envelope.params);
    if (!effectType) {
        console.warn('[asset-effects-protocol] EFFECT_START ignored: require effectId asset.gsplat-effects + params.type');
        return false;
    }
    if (!sceneAssetTargetExists(global, envelope.targetId)) {
        console.warn('[asset-effects-protocol] EFFECT_START ignored: unknown targetId', envelope.targetId);
        return false;
    }

    const patch = mergeStartParams(effectType, envelope.params);
    const merged = patchAssetInstanceFromParams(global.settings as ExperienceSettings, envelope.targetId, patch);
    const ep = (merged.effectParams ?? {}) as Record<string, unknown>;
    const runtimeEntities = buildRuntimeEntitiesFromEffectParams(
        global,
        merged.type,
        envelope.targetId,
        ep
    );
    const entityErr = validateAssetEffectStartEntities(
        global,
        merged.type,
        envelope.targetId,
        ep,
        runtimeEntities
    );
    if (entityErr) {
        console.warn('[asset-effects-protocol] EFFECT_START ignored:', entityErr, {
            targetId: envelope.targetId,
            type: merged.type
        });
        return false;
    }

    syncEffectsRuntimeStateFromSettings(global.state, global.settings);
    patchAssetRuntimeMirror(global.state, envelope.targetId, {
        activeType: merged.type as AssetEffectType,
        status: 'playing'
    });

    global.events.fire('assetEffect:start', {
        targetId: envelope.targetId,
        type: merged.type,
        params: merged,
        entities: runtimeEntities
    });
    return true;
}

/**
 * `EFFECT_STOP`：标记 inactive 并派发 `assetEffect:stop`。
 */
export function applyAssetEffectStop(global: Global, envelope: AssetEffectProtocolEnvelope): boolean {
    const effectType = resolveAssetEffectType(envelope.effectId, envelope.params);
    if (!effectType) {
        return false;
    }
    if (!sceneAssetTargetExists(global, envelope.targetId)) {
        return false;
    }

    patchAssetInstanceFromParams(global.settings as ExperienceSettings, envelope.targetId, { enabled: false });
    syncEffectsRuntimeStateFromSettings(global.state, global.settings);
    patchAssetRuntimeMirror(global.state, envelope.targetId, { status: 'inactive' });

    global.events.fire('assetEffect:stop', {
        targetId: envelope.targetId,
        type: effectType
    });
    return true;
}

/**
 * `EFFECT_PARAMS_PATCH`（asset 轨）：仅改 settings，不自动 start。
 */
export function applyAssetEffectParamsPatch(global: Global, envelope: AssetEffectProtocolEnvelope): boolean {
    const effectType = resolveAssetEffectType(envelope.effectId, envelope.params);
    if (!effectType) {
        return false;
    }
    if (!sceneAssetTargetExists(global, envelope.targetId)) {
        return false;
    }
    const params = envelope.params ?? {};
    if (!paramsPatchHasAssetKeys(params)) {
        return false;
    }

    const patch: {
        type?: string;
        enabled?: boolean;
        autoStart?: boolean;
        effectParams?: Record<string, unknown> | null;
    } = { type: effectType };

    if (typeof params.type === 'string') {
        patch.type = params.type;
    }
    if (typeof params.enabled === 'boolean') {
        patch.enabled = params.enabled;
    }
    if (typeof params.autoStart === 'boolean') {
        patch.autoStart = params.autoStart;
    }
    if (params.effectParams !== undefined) {
        if (params.effectParams === null) {
            patch.effectParams = null;
        } else if (typeof params.effectParams === 'object' && !Array.isArray(params.effectParams)) {
            const t = typeof patch.type === 'string' ? patch.type : effectType;
            patch.effectParams = filterAssetEffectParams(t, params.effectParams as Record<string, unknown>);
        }
    }

    const merged = patchAssetInstanceFromParams(global.settings as ExperienceSettings, envelope.targetId, patch);
    syncEffectsRuntimeStateFromSettings(global.state, global.settings);
    syncAssetInstancesRuntimeFromSettings(global.state, global.settings);

    global.events.fire('assetEffect:configChanged', {
        targetId: envelope.targetId,
        type: merged.type,
        params: merged
    });
    return true;
}

export function readAssetEffectInstanceForTarget(global: Global, targetId: string) {
    return readAssetInstanceParams(global.settings as ExperienceSettings, targetId);
}

/** 协议层归一化 envelope：`effectId` 统一为包 id（兼容旧 type 直传） */
export function normalizeAssetEffectEnvelope(envelope: AssetEffectProtocolEnvelope): AssetEffectProtocolEnvelope {
    const effectType = resolveAssetEffectType(envelope.effectId, envelope.params);
    if (!effectType) {
        return envelope;
    }
    if (isAssetGsplatPackageId(envelope.effectId)) {
        return envelope;
    }
    const params = { ...(envelope.params ?? {}), type: effectType };
    return { ...envelope, effectId: ASSET_GSPLAT_EFFECT_ID, params };
}
