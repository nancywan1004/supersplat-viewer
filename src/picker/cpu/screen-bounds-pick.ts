import { Vec3 } from 'playcanvas';

import { computePlacedEntryWorldBounds } from './placed-entry-bounds';
import { clientToPickScreenCoords } from './pick-screen-coords';
import type { AssetLibraryType, Global, ScenePlacedItem } from '../../types';

export const DEFAULT_SCREEN_BOUNDS_PADDING_PX = 8;

export type ScreenBoundsPickOptions = {
    paddingPx?: number;
    assetType?: AssetLibraryType;
    filter?: (entry: ScenePlacedItem) => boolean;
};

const _screen = new Vec3();

/**
 * CPU：将已放置资产 AABB 投到屏幕，判断点击是否落在包围矩形内。
 * Viewer 点选、物体特效 toggle 等轻量路径共用。
 */
export function pickPlacedEntryAtScreenBounds(
    global: Global,
    list: ScenePlacedItem[],
    clientX: number,
    clientY: number,
    options: ScreenBoundsPickOptions = {}
): ScenePlacedItem | null {
    const coords = clientToPickScreenCoords(global, clientX, clientY);
    if (!coords) return null;

    const cameraComponent = global.camera.camera;
    if (!cameraComponent) return null;

    const { renderX, renderY } = coords;
    const renderWidth = global.app.graphicsDevice.width;
    const renderHeight = global.app.graphicsDevice.height;
    const paddingPx = options.paddingPx ?? DEFAULT_SCREEN_BOUNDS_PADDING_PX;

    let best: { entry: ScenePlacedItem; score: number } | null = null;

    for (const entry of list) {
        if (!entry.entity.enabled) continue;
        if (options.assetType && entry.assetType !== options.assetType) continue;
        if (options.filter && !options.filter(entry)) continue;

        const bounds = computePlacedEntryWorldBounds(entry);
        if (!bounds) continue;

        const center = bounds.center;
        const half = bounds.halfExtents;
        let minX = Number.POSITIVE_INFINITY;
        let minY = Number.POSITIVE_INFINITY;
        let maxX = Number.NEGATIVE_INFINITY;
        let maxY = Number.NEGATIVE_INFINITY;
        let visibleCorners = 0;
        let depthSum = 0;

        for (const sx of [-1, 1]) {
            for (const sy of [-1, 1]) {
                for (const sz of [-1, 1]) {
                    const corner = new Vec3(
                        center.x + half.x * sx,
                        center.y + half.y * sy,
                        center.z + half.z * sz
                    );
                    cameraComponent.camera.worldToScreen(corner, renderWidth, renderHeight, _screen);
                    if (!Number.isFinite(_screen.x) || !Number.isFinite(_screen.y) || !Number.isFinite(_screen.z)) continue;
                    if (_screen.z <= 0) continue;
                    visibleCorners++;
                    depthSum += _screen.z;
                    minX = Math.min(minX, _screen.x);
                    minY = Math.min(minY, _screen.y);
                    maxX = Math.max(maxX, _screen.x);
                    maxY = Math.max(maxY, _screen.y);
                }
            }
        }

        if (visibleCorners === 0) continue;
        minX -= paddingPx;
        minY -= paddingPx;
        maxX += paddingPx;
        maxY += paddingPx;
        if (renderX < minX || renderX > maxX || renderY < minY || renderY > maxY) continue;

        const centerX = (minX + maxX) * 0.5;
        const centerY = (minY + maxY) * 0.5;
        const dx = renderX - centerX;
        const dy = renderY - centerY;
        const score = (depthSum / visibleCorners) + Math.sqrt(dx * dx + dy * dy) * 0.001;
        if (!best || score < best.score) {
            best = { entry, score };
        }
    }

    return best?.entry ?? null;
}
