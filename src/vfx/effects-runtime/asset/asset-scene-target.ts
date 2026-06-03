import type { Entity } from 'playcanvas';

import type { Global, ScenePlacedItem } from '../../../types';

/** 已放置条目是否为 Gaussian（含 gsplat） */
export function isPlacedGaussianItem(item: ScenePlacedItem | null | undefined): boolean {
    if (!item) {
        return false;
    }
    if (item.assetType && item.assetType !== 'gaussian') {
        return false;
    }
    return !!item.entity?.gsplat;
}

/** 已放置 Gaussian 的源文件 URL（scenePlaced.url 或资产库 url） */
export function resolvePlacedGaussianSourceUrl(global: Global, targetId: string): string | null {
    const placed = getScenePlacedItemByTargetId(global, targetId);
    if (!isPlacedGaussianItem(placed)) {
        return null;
    }
    if (typeof placed!.url === 'string' && placed!.url.trim().length > 0) {
        return placed!.url.trim();
    }
    if (placed!.assetId) {
        const lib = global.state.uploadedAssets?.find((a) => a.id === placed!.assetId);
        if (typeof lib?.url === 'string' && lib.url.trim().length > 0) {
            return lib.url.trim();
        }
    }
    return null;
}

/**
 * 将 morph 关键帧 targetId 序列解析为 GS 源 URL 列表；任一项无法解析则返回 null。
 */
export function resolveMorphKeyframeUrlsFromTargetIds(global: Global, targetIds: string[]): string[] | null {
    if (!Array.isArray(targetIds) || targetIds.length < 2) {
        return null;
    }
    const urls: string[] = [];
    for (const id of targetIds) {
        if (typeof id !== 'string' || id.length === 0) {
            return null;
        }
        const url = resolvePlacedGaussianSourceUrl(global, id);
        if (!url) {
            return null;
        }
        urls.push(url);
    }
    return urls;
}

/** 按 `sceneAsset.id` / `scenePlacedEntities[].id` 查找已放置条目 */
export function getScenePlacedItemByTargetId(global: Global, targetId: string): ScenePlacedItem | null {
    const list = global.state.scenePlacedEntities ?? [];
    return list.find((it) => it?.id === targetId) ?? null;
}

/** 已放置条目上的 PlayCanvas 实体（无则 null） */
export function getScenePlacedEntityByTargetId(global: Global, targetId: string): Entity | null {
    return getScenePlacedItemByTargetId(global, targetId)?.entity ?? null;
}

/** 静物活化要求目标为带 `gsplat` 组件的高斯资产 */
export function getScenePlacedGsplatEntityByTargetId(global: Global, targetId: string): Entity | null {
    const item = getScenePlacedItemByTargetId(global, targetId);
    if (!item) {
        return null;
    }
    if (item.assetType && item.assetType !== 'gaussian') {
        return null;
    }
    const entity = item.entity;
    if (!entity?.gsplat) {
        return null;
    }
    return entity;
}
