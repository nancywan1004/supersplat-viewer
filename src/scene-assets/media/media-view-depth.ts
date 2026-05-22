import * as pc from 'playcanvas';
import { Vec3 } from 'playcanvas';

/** 相机世界空间前向（PlayCanvas 实体 +Z 为背向） */
export function cameraForwardWorld(cam: pc.Entity): Vec3 {
    const z = cam.getWorldTransform().getZ();
    z.mulScalar(-1);
    z.normalize();
    return z;
}

/**
 * 锚点相对相机的视轴深度：沿相机 forward 的分量，仅取前方（≥0）。
 * 与视频热区 `videoTriggerDistanceM` 及 video baseline 共用。
 */
export function viewAxisDepthM(cam: pc.Entity, anchorWorld: Vec3): number {
    const eye = cam.getPosition();
    const to = anchorWorld.clone().sub(eye);
    const depth = cameraForwardWorld(cam).dot(to);
    return depth > 0 ? depth : 0;
}

const tmpTo = new Vec3();

/** 相机到锚点的欧氏距离（米）；音频热区与 audio baseline 共用。 */
export function euclideanDistanceM(eye: Vec3, anchorWorld: Vec3): number {
    tmpTo.sub2(anchorWorld, eye);
    return tmpTo.length();
}

export type MediaHotspotAnchorEval =
    | { ok: true; depthM: number }
    | {
        ok: false;
        reason: 'coincident' | 'behind' | 'out_of_range' | 'outside_cone';
    };

export type AudioHotspotAnchorEval =
    | { ok: true; depthM: number }
    | {
        ok: false;
        reason: 'coincident' | 'out_of_range';
    };

/**
 * 视频热区锚点判定：先视轴深度（forward 分量 + 触发半径），再检查锚点是否在视锥锥内。
 *
 * - **距离**：`depthM = forward · (anchor − eye)`，须 `0 < depthM ≤ maxDepthM`
 * - **视锥**：`coneHalfDeg` 为半角（度）；总张角约 `2 × coneHalfDeg`
 */
export function evaluateMediaHotspotAnchor(
    eye: Vec3,
    forward: Vec3,
    anchorWorld: Vec3,
    maxDepthM: number,
    cosCone: number
): MediaHotspotAnchorEval {
    tmpTo.sub2(anchorWorld, eye);
    const euclidean = tmpTo.length();
    if (euclidean < 1e-6) {
        return { ok: false, reason: 'coincident' };
    }

    const depthM = forward.dot(tmpTo);
    if (depthM <= 0) {
        return { ok: false, reason: 'behind' };
    }

    const radius = Math.max(0.01, maxDepthM);
    if (depthM > radius) {
        return { ok: false, reason: 'out_of_range' };
    }

    tmpTo.mulScalar(1 / euclidean);
    if (forward.dot(tmpTo) < cosCone) {
        return { ok: false, reason: 'outside_cone' };
    }

    return { ok: true, depthM };
}

/**
 * 音频热区锚点判定：仅欧氏距离，与朝向/视锥无关。
 *
 * - **距离**：`depthM = ‖anchor − eye‖`，须 `0 < depthM ≤ maxDistanceM`
 */
export function evaluateAudioHotspotAnchor(
    eye: Vec3,
    anchorWorld: Vec3,
    maxDistanceM: number
): AudioHotspotAnchorEval {
    const depthM = euclideanDistanceM(eye, anchorWorld);
    if (depthM < 1e-6) {
        return { ok: false, reason: 'coincident' };
    }

    const radius = Math.max(0.01, maxDistanceM);
    if (depthM > radius) {
        return { ok: false, reason: 'out_of_range' };
    }

    return { ok: true, depthM };
}
