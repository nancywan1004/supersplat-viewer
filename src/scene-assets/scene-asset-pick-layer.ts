import { type AppBase, Layer } from 'playcanvas';

let cachedPickLayer: Layer | null = null;

/**
 * 仅用于场景资产 Picker 的图层，不加入相机 layers，避免音频拾取球等在画面上透出。
 */
export function getSceneAssetPickLayer(app: AppBase): Layer {
    if (cachedPickLayer) return cachedPickLayer;

    const sceneLayers = app.scene.layers;
    let layer = sceneLayers.getLayerByName('SceneAssetPick');
    if (!layer) {
        layer = new Layer({ name: 'SceneAssetPick' });
        const worldLayer = sceneLayers.getLayerByName('World');
        const insertAt = worldLayer
            ? sceneLayers.getOpaqueIndex(worldLayer)
            : sceneLayers.getOpaqueIndex(sceneLayers.layerList[0]);
        sceneLayers.insert(layer, insertAt);
    }

    cachedPickLayer = layer;
    return layer;
}

/** Picker.prepare 用的 layer 列表：World + SceneAssetPick */
export function getSceneAssetPickerLayers(app: AppBase): Layer[] {
    const world = app.scene.layers.getLayerByName('World');
    const pick = getSceneAssetPickLayer(app);
    return world ? [world, pick] : [pick];
}

export function resetSceneAssetPickLayerCache(): void {
    cachedPickLayer = null;
}
