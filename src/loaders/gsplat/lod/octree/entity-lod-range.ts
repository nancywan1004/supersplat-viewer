import type { Entity, GSplatComponent } from 'playcanvas';

/** PlayCanvas 2.20：lodRange 必须写在 gsplat component 上 */
export function applyLodRangeToGsplatEntity(
    entity: Entity,
    rangeMin: number,
    rangeMax: number
): void {
    const comp = entity.gsplat as GSplatComponent | null;
    if (!comp) {
        return;
    }
    comp.lodRangeMin = rangeMin;
    comp.lodRangeMax = rangeMax;
}

export function resolveEntityLodRange(
    entity: Entity,
    maxLod: number
): { rangeMin: number; rangeMax: number } {
    const comp = entity.gsplat as GSplatComponent | null;
    const rangeMin = Math.max(0, Math.min(comp?.lodRangeMin ?? 0, maxLod));
    const rangeMax = Math.max(rangeMin, Math.min(comp?.lodRangeMax ?? maxLod, maxLod));
    return { rangeMin, rangeMax };
}
