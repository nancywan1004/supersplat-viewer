/**
 * 物体特效 Entity 统一解析（Bridge 与 Internal 共用）。
 *
 * - **Bridge**：`EFFECT_*` 的 `effectParams.entityId` / `keyframeEntityIds`（与 `ASSET_PLACE.sceneEntityId`、场景实例 id 一致）
 * - **Internal UI**：仅从场景列表挑选 entity id 写入 effectParams，再经 `dispatchEffectsModuleCommand` / message-bridge 同一协议路径
 * - **Runtime**：`assetEffect:start` 可附带 `entities`（同进程 host 已持有 Entity 时免二次查找；postMessage 协议不传）
 */

import type { Entity } from 'playcanvas';

import type { Global } from '../../../types';
import {
    getScenePlacedItemByTargetId,
    getScenePlacedGsplatEntityByTargetId,
    isPlacedGaussianItem,
    resolveMorphKeyframeUrlsFromTargetIds,
    resolvePlacedGaussianSourceUrl
} from './asset-scene-target';

/** 场景已放置实例 id（`scenePlacedEntities[].id` / bridge `sceneEntityId`） */
export type AssetEffectEntityId = string;

/** `assetEffect:start` 可选的运行时 Entity 注入（非 settings / 非 postMessage） */
export type AssetEffectStartEntities = {
    /** 静物活化目标 Entity */
    primary?: Entity;
    /** GS 变形关键帧 Entity（顺序即变形顺序） */
    keyframeEntities?: Entity[];
};

/**
 * 从 effectParams 读取 morph 关键帧 entity id 列表（兼容旧字段 `keyframeTargetIds`）。
 * @param {Record<string, unknown>} ep
 * @returns {string[] | null}
 */
export function readMorphKeyframeEntityIds(ep: Record<string, unknown>): string[] | null {
    const raw = ep.keyframeEntityIds ?? ep.keyframeTargetIds;
    if (!Array.isArray(raw) || raw.length < 2) {
        return null;
    }
    if (!raw.every((id) => typeof id === 'string' && id.length > 0)) {
        return null;
    }
    return raw as string[];
}

/**
 * 按 scene entity id 解析带 gsplat 的 PlayCanvas Entity。
 * @param {Global} global
 * @param {string} entityId
 * @returns {Entity | null}
 */
export function resolveAssetEffectGsplatEntity(global: Global, entityId: string): Entity | null {
    return getScenePlacedGsplatEntityByTargetId(global, entityId);
}

/**
 * scene entity id 是否已注册到当前场景（`scenePlacedEntities`）。
 * @param {Global} global
 * @param {string} entityId
 * @returns {boolean}
 */
export function assetEffectEntityRegistered(global: Global, entityId: string): boolean {
    return !!getScenePlacedItemByTargetId(global, entityId);
}

/**
 * 静物活化：解析目标 Entity。优先 runtime `primary`，其次 `effectParams.entityId`，最后配置槽 `configTargetId`。
 * @param {Global} global
 * @param {Record<string, unknown>} ep
 * @param {string} configTargetId settings 配置键 / envelope.targetId
 * @param {Entity} [runtimeEntity]
 * @returns {Entity | null}
 */
export function resolveWobbleEntityFromEffectParams(
    global: Global,
    ep: Record<string, unknown>,
    configTargetId: string,
    runtimeEntity?: Entity
): Entity | null {
    if (runtimeEntity?.gsplat) {
        return runtimeEntity;
    }
    const entityId =
        typeof ep.entityId === 'string' && ep.entityId.length > 0 ? ep.entityId : configTargetId;
    return resolveAssetEffectGsplatEntity(global, entityId);
}

/**
 * 将 scene entity id 序列解析为 morph 所需 GS 源 URL。
 * @param {Global} global
 * @param {string[]} entityIds
 * @returns {string[] | null}
 */
export function resolveMorphKeyframeUrlsFromEntityIds(global: Global, entityIds: string[]): string[] | null {
    return resolveMorphKeyframeUrlsFromTargetIds(global, entityIds);
}

export function resolveMorphKeyframeEntitiesFromEntityIds(global: Global, entityIds: string[]): Entity[] | null {
    if (!Array.isArray(entityIds) || entityIds.length < 2) {
        return null;
    }
    const entities: Entity[] = [];
    for (const id of entityIds) {
        const entity = resolveAssetEffectGsplatEntity(global, id);
        if (!entity) {
            return null;
        }
        entities.push(entity);
    }
    return entities;
}

export function resolveMorphKeyframeEntitiesFromEffectParams(
    global: Global,
    ep: Record<string, unknown>,
    runtimeKeyframeEntities?: Entity[]
): Entity[] | null {
    if (runtimeKeyframeEntities && runtimeKeyframeEntities.length >= 2 && runtimeKeyframeEntities.every((e) => !!e?.gsplat)) {
        return runtimeKeyframeEntities;
    }
    const entityIds = readMorphKeyframeEntityIds(ep);
    return entityIds ? resolveMorphKeyframeEntitiesFromEntityIds(global, entityIds) : null;
}

function resolveMorphUrlsFromRuntimeEntities(global: Global, entities: Entity[]): string[] | null {
    if (entities.length < 2) {
        return null;
    }
    const list = global.state.scenePlacedEntities ?? [];
    const urls: string[] = [];
    for (const ent of entities) {
        if (!ent?.gsplat) {
            return null;
        }
        const item = list.find((placed) => {
            if (placed.entity === ent) {
                return true;
            }
            const anyEnt = ent as Entity & { isDescendantOf?: (e: Entity) => boolean };
            return typeof anyEnt.isDescendantOf === 'function' && anyEnt.isDescendantOf(placed.entity);
        });
        if (!item || !isPlacedGaussianItem(item)) {
            return null;
        }
        const url = resolvePlacedGaussianSourceUrl(global, item.id);
        if (!url) {
            return null;
        }
        urls.push(url);
    }
    return urls;
}

/**
 * GS 变形：从 effectParams（及可选 runtime Entities）解析关键帧 URL 列表。
 * 优先级：runtime keyframeEntities → keyframeEntityIds → keyframeUrls。
 * @param {Global} global
 * @param {Record<string, unknown>} ep
 * @param {Entity[]} [runtimeKeyframeEntities]
 * @returns {string[] | null}
 */
export function resolveMorphKeyframeUrlsFromEffectParams(
    global: Global,
    ep: Record<string, unknown>,
    runtimeKeyframeEntities?: Entity[]
): string[] | null {
    if (runtimeKeyframeEntities && runtimeKeyframeEntities.length >= 2) {
        const fromRuntime = resolveMorphUrlsFromRuntimeEntities(global, runtimeKeyframeEntities);
        if (fromRuntime) {
            return fromRuntime;
        }
    }
    const entityIds = readMorphKeyframeEntityIds(ep);
    if (entityIds) {
        const fromIds = resolveMorphKeyframeUrlsFromEntityIds(global, entityIds);
        if (fromIds) {
            return fromIds;
        }
    }
    const rawUrls = ep.keyframeUrls;
    if (Array.isArray(rawUrls) && rawUrls.length >= 2 && rawUrls.every((u) => typeof u === 'string')) {
        return rawUrls as string[];
    }
    return null;
}

/**
 * EFFECT_START 前校验：按特效类型检查 entity / URL 是否可解析。
 * @param {Global} global
 * @param {string} effectType
 * @param {string} configTargetId
 * @param {Record<string, unknown>} ep
 * @param {AssetEffectStartEntities} [runtime]
 * @returns {string | null} 错误信息；可启动则 null
 */
export function validateAssetEffectStartEntities(
    global: Global,
    effectType: string,
    configTargetId: string,
    ep: Record<string, unknown>,
    runtime?: AssetEffectStartEntities
): string | null {
    if (effectType === 'gsplat-wobble') {
        if (!resolveWobbleEntityFromEffectParams(global, ep, configTargetId, runtime?.primary)) {
            return 'gsplat-wobble requires effectParams.entityId (or targetId) referencing a placed Gaussian with gsplat';
        }
        return null;
    }
    if (effectType === 'gsplat-morph') {
        if (!resolveMorphKeyframeUrlsFromEffectParams(global, ep, runtime?.keyframeEntities)) {
            return 'gsplat-morph requires effectParams.keyframeEntityIds (≥2) or keyframeUrls (≥2)';
        }
        return null;
    }
    return null;
}
