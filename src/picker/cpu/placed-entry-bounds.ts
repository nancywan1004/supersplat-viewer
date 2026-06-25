import { BoundingBox, Entity } from 'playcanvas';

import type { ScenePlacedItem } from '../../types';

/** 已放置资产（mesh 子树或 gsplat）的世界空间 AABB。 */
export function computePlacedEntryWorldBounds(entry: ScenePlacedItem): BoundingBox | null {
    const entity = entry.entity;
    const meshInstances: Array<{ aabb?: BoundingBox }> = [];

    const collectMeshInstances = (node: Entity) => {
        const renderComp = (node as Entity & { render?: { meshInstances?: Array<{ aabb?: BoundingBox }> } }).render;
        const instances = renderComp?.meshInstances;
        if (instances?.length) {
            for (const mi of instances) meshInstances.push(mi);
        }
        for (const child of node.children as Entity[]) {
            collectMeshInstances(child);
        }
    };
    collectMeshInstances(entity);

    let bounds: BoundingBox | null = null;
    for (const mi of meshInstances) {
        if (!mi.aabb) continue;
        if (!bounds) {
            bounds = mi.aabb.clone();
        } else {
            bounds.add(mi.aabb);
        }
    }
    if (bounds) return bounds;

    const gsplat = (entity as Entity & { gsplat?: { customAabb?: BoundingBox | null; aabb?: BoundingBox } }).gsplat;
    const gsAabb = gsplat?.customAabb ?? gsplat?.aabb;
    if (!gsAabb) return null;

    bounds = new BoundingBox();
    bounds.setFromTransformedAabb(gsAabb, entity.getWorldTransform());
    return bounds;
}
