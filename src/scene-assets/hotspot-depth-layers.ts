/**
 * Annotation / 音频 callout 共用的 Hotspot 深度层。
 * 须排在 World 透明（含 unified 高斯）之后，且 Base 不写 depth，避免高斯叠色出现黑边。
 */

import { Layer, type AppBase, type Entity } from 'playcanvas';

export type HotspotDepthLayers = {
    baseLayer: Layer;
    overlayLayer: Layer;
};

/** 将 Hotspot 透明子层挪到 World 透明子层之后（高斯合成之后再画 UI）。 */
export function syncHotspotLayersAfterGsplat(app: AppBase): void {
    const sceneLayers = app.scene.layers;
    const world = sceneLayers.getLayerByName('World');
    if (!world) return;

    const base = sceneLayers.getLayerByName('HotspotBase');
    const overlay = sceneLayers.getLayerByName('HotspotOverlay');
    if (!base) return;

    const worldTransIdx = sceneLayers.getTransparentIndex(world);
    if (worldTransIdx < 0) return;

    sceneLayers.remove(base);
    if (overlay) sceneLayers.remove(overlay);

    sceneLayers.insertTransparent(base, worldTransIdx + 1);
    if (overlay) {
        const baseListIdx = sceneLayers.layerList.indexOf(base);
        sceneLayers.insertTransparent(overlay, baseListIdx + 1);
    }

    sceneLayers.markDirty();
}

export function ensureHotspotDepthLayers(app: AppBase, camEntity: Entity): HotspotDepthLayers {
    const sceneLayers = app.scene.layers;
    const world = sceneLayers.getLayerByName('World');
    if (!world) {
        throw new Error('World layer missing for hotspot depth layers');
    }

    let baseLayer = sceneLayers.getLayerByName('HotspotBase');
    let overlayLayer = sceneLayers.getLayerByName('HotspotOverlay');

    if (!baseLayer) {
        baseLayer = new Layer({ name: 'HotspotBase' });
    }
    if (!overlayLayer) {
        overlayLayer = new Layer({ name: 'HotspotOverlay' });
    }

    if (!sceneLayers.layerList.includes(baseLayer)) {
        const worldTransIdx = sceneLayers.getTransparentIndex(world);
        sceneLayers.insertTransparent(baseLayer, worldTransIdx + 1);
        const baseListIdx = sceneLayers.layerList.indexOf(baseLayer);
        sceneLayers.insertTransparent(overlayLayer, baseListIdx + 1);
    } else {
        syncHotspotLayersAfterGsplat(app);
    }

    const cam = camEntity.camera;
    const layerIds = new Set(cam.layers);
    layerIds.add(baseLayer.id);
    layerIds.add(overlayLayer.id);
    cam.layers = [...layerIds];

    return { baseLayer, overlayLayer };
}
