/**
 * 场景拾取（picker）— 三条路径，成本从低到高：
 *
 * | 路径 | 目录 | 用途 |
 * |------|------|------|
 * | 1. CPU 几何 | `cpu/` | Viewer 点选资产、物体特效 toggle（屏幕 bounds） |
 * | 2. GPU 实体 ID | `scene-asset/id-pick` | 编辑态点选已放置 mesh / 高斯（SceneAssetPick 层） |
 * | 3. GPU splat 深度 | `splat/depth-picker` | 标注/nav/Bloom、双击 orbit 聚焦 |
 *
 * Collision 射线拾取在 `nav-interaction._pickCollision`，不在此模块。
 */

// --- 1. CPU 几何 ---
export {
    DEFAULT_SCREEN_BOUNDS_PADDING_PX,
    pickPlacedEntryAtScreenBounds,
    type ScreenBoundsPickOptions
} from './cpu/screen-bounds-pick';

export { computePlacedEntryWorldBounds } from './cpu/placed-entry-bounds';

export { clientToPickScreenCoords, type CanvasPickCoords } from './cpu/pick-screen-coords';

// --- 2. GPU 实体 ID ---
export {
    getSceneAssetPickLayer,
    getSceneAssetPickerLayers,
    resetSceneAssetPickLayerCache
} from './scene-asset/pick-layer';

export {
    configurePlacedGaussianPickLayer,
    pickScenePlacedEntryAtScreen
} from './scene-asset/id-pick';

// --- 3. GPU splat 深度 ---
export {
    Picker,
    getSharedPicker,
    getWorldPoint,
    captureCameraSnapshot,
    pickWorldFromClientXY,
    type PickSurface,
    type PickCameraSnapshot,
    type PickerDepthMap
} from './splat/depth-picker';
