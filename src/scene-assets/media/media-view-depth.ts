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

export type MediaHotspotAnchorEval =
    | { ok: true; depthM: number }
    | {
        ok: false;
        reason: 'coincident' | 'behind' | 'out_of_range' | 'outside_cone';
    };

const tmpTo = new pc.Vec3();

/**
 * 热区锚点判定：先视轴深度（forward 分量 + 触发半径），再检查锚点是否在视锥锥内。
 *
 * - **距离**：`depthM = forward · (anchor − eye)`，须 `0 < depthM ≤ maxDepthM`
 * - **视锥**：`coneHalfDeg` 为半角（度）；总张角约 `2 × coneHalfDeg`（如 60° → 约 120°）
 * - **video / audio** 共用；锚点为 `entity.getPosition()`
 */
export function evaluateMediaHotspotAnchor(
    eye: pc.Vec3,
    forward: pc.Vec3,
    anchorWorld: pc.Vec3,
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
