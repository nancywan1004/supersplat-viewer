import type { Global } from '../types';

/** 物理碰撞总开关（`settings.sceneAssetCollision.enabled` 同步到 state） */
export function readSceneAssetCollisionEnabled(global: Global): boolean {
    const rs = global.state.sceneAssetCollisionRuntimeState;
    return rs?.enabled === true;
}

/** Viewer 或编辑预览上下文 */
export function isCameraCollisionEditContextActive(global: Global): boolean {
    const { state } = global;
    if (!state.editMode) {
        return true;
    }
    return state.previewMode === true;
}

/** 总开关开启且处于可挡相机上下文（与 CameraCollisionManager.isRuntimeActive 一致） */
export function isCameraCollisionRuntimeActive(global: Global): boolean {
    if (!readSceneAssetCollisionEnabled(global)) {
        return false;
    }
    return isCameraCollisionEditContextActive(global);
}
