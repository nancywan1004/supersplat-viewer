import * as pc from 'playcanvas';

/** 相机世界空间前向（PlayCanvas 实体 +Z 为背向） */
export function cameraForwardWorld(cam: pc.Entity): pc.Vec3 {
    const z = cam.getWorldTransform().getZ();
    z.mulScalar(-1);
    z.normalize();
    return z;
}

/**
 * 锚点相对相机的视轴深度：沿相机 forward 的分量，仅取前方（≥0）。
 * 与热区 `videoTriggerDistanceM` / `audioTriggerDistanceM` 及 baseline 共用。
 */
export function viewAxisDepthM(cam: pc.Entity, anchorWorld: pc.Vec3): number {
    const eye = cam.getPosition();
    const to = anchorWorld.clone().sub(eye);
    const depth = cameraForwardWorld(cam).dot(to);
    return depth > 0 ? depth : 0;
}
