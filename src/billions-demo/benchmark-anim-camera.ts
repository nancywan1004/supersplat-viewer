import {
    Mat4,
    Vec3,
    type AppBase,
    type Entity
} from 'playcanvas';

import { AnimState } from '../animation/anim-state';
import type { AnimTrack } from '../settings';

const ANIM_TIME_EPSILON_SEC = 0.05;
const tmpMat = new Mat4();
const tmpVec = new Vec3();

export type BillionsTileBounds = {
    localCenter: Vec3;
    halfExtents: Vec3;
};

/** Map keyframe index → instance index, spread across [0, instanceCount - 1]. */
export function spreadKeyframeInstanceIndex(
    keyframeIndex: number,
    keyframeCount: number,
    instanceCount: number
): number {
    if (instanceCount <= 1 || keyframeCount <= 1) {
        return 0;
    }
    return Math.round(keyframeIndex * (instanceCount - 1) / (keyframeCount - 1));
}

function worldTileCenter(entity: Entity, localCenter: Vec3, out = new Vec3()): Vec3 {
    return entity.getWorldTransform().transformPoint(localCenter, out);
}

/** Calibrate aerial patrol from tile-0 keyframe 0 (and optional keyframe 1 for radius). */
function derivePatrolCalibration(
    sourceTrack: AnimTrack,
    instanceRoot: Entity,
    tileBounds: BillionsTileBounds
): { baseAngle: number; radius: number; height: number; targetDrop: number; targetOffsetX: number; targetOffsetZ: number } {
    const worldCenter = worldTileCenter(instanceRoot, tileBounds.localCenter);
    const { position, target } = sourceTrack.keyframes.values;
    const kf0Pos = new Vec3(position[0], position[1], position[2]);
    const kf0Tgt = new Vec3(target[0], target[1], target[2]);

    const dx0 = kf0Pos.x - worldCenter.x;
    const dz0 = kf0Pos.z - worldCenter.z;
    let radius = Math.hypot(dx0, dz0);
    if (radius < 1e-3 && position.length >= 6) {
        const dx1 = position[3] - worldCenter.x;
        const dz1 = position[5] - worldCenter.z;
        radius = Math.hypot(dx1, dz1);
    }
    if (radius < 1e-3) {
        radius = Math.max(tileBounds.halfExtents.x, tileBounds.halfExtents.z) * 0.42;
    }

    return {
        baseAngle: Math.atan2(dx0, dz0),
        radius,
        height: kf0Pos.y - worldCenter.y,
        targetDrop: kf0Tgt.y - worldCenter.y,
        targetOffsetX: kf0Tgt.x - worldCenter.x,
        targetOffsetZ: kf0Tgt.z - worldCenter.z
    };
}

/**
 * Multi-tile benchmark path: each keyframe orbits a different instance's world center
 * using horizontal offsets (world XZ), keeping the camera aimed at that tile's center.
 */
export function buildTileTourAnimTrack(
    sourceTrack: AnimTrack,
    instanceEntities: Entity[],
    tileBounds: BillionsTileBounds
): AnimTrack {
    const { times } = sourceTrack.keyframes;
    const { fov } = sourceTrack.keyframes.values;
    const keyframeCount = times.length;
    const instanceCount = instanceEntities.length;
    const calibration = derivePatrolCalibration(sourceTrack, instanceEntities[0], tileBounds);

    const position: number[] = [];
    const target: number[] = [];
    const worldCenter = new Vec3();

    for (let i = 0; i < keyframeCount; i++) {
        const instanceIdx = spreadKeyframeInstanceIndex(i, keyframeCount, instanceCount);
        worldTileCenter(instanceEntities[instanceIdx], tileBounds.localCenter, worldCenter);

        const sweep = keyframeCount > 1 ? (i / (keyframeCount - 1)) * Math.PI * 1.1 : 0;
        const angle = calibration.baseAngle + sweep;

        position.push(
            worldCenter.x + Math.sin(angle) * calibration.radius,
            worldCenter.y + calibration.height,
            worldCenter.z + Math.cos(angle) * calibration.radius
        );
        target.push(
            worldCenter.x + calibration.targetOffsetX,
            worldCenter.y + calibration.targetDrop,
            worldCenter.z + calibration.targetOffsetZ
        );
    }

    return {
        ...sourceTrack,
        keyframes: {
            ...sourceTrack.keyframes,
            values: {
                position,
                target,
                fov: [...fov]
            }
        }
    };
}

export function buildMultiTileAnimTrack(
    sourceTrack: AnimTrack,
    instanceEntities: Entity[],
    options: {
        useWorldSpace: boolean;
        instanceRoot: Entity;
        multiTile: boolean;
        tileBounds: BillionsTileBounds;
    }
): AnimTrack {
    const instanceCount = instanceEntities.length;
    if (!options.multiTile || instanceCount <= 1) {
        if (options.useWorldSpace) {
            return sourceTrack;
        }
        return transformAnimTrackForBillionsInstance(
            sourceTrack,
            cloneWorldTransform(options.instanceRoot)
        );
    }

    return buildTileTourAnimTrack(sourceTrack, instanceEntities, options.tileBounds);
}

/**
 * Map finland animTrack (asset-space coords) onto billions instance 0.
 * Instance layout applies eulerX≈180°; full transformPoint flips Y and puts the
 * camera under the scene. Keep settings Y (aerial ~27–34m) and transform X/Z only.
 */
export function transformAnimTrackForBillionsInstance(
    track: AnimTrack,
    worldTransform: Mat4
): AnimTrack {
    const { times } = track.keyframes;
    const { position, target, fov } = track.keyframes.values;
    const newPos = [...position];
    const newTgt = [...target];

    for (let i = 0; i < times.length; i++) {
        const base = i * 3;
        tmpVec.set(position[base], position[base + 1], position[base + 2]);
        worldTransform.transformPoint(tmpVec, tmpVec);
        newPos[base] = tmpVec.x;
        newPos[base + 1] = position[base + 1];
        newPos[base + 2] = tmpVec.z;

        tmpVec.set(target[base], target[base + 1], target[base + 2]);
        worldTransform.transformPoint(tmpVec, tmpVec);
        newTgt[base] = tmpVec.x;
        newTgt[base + 1] = target[base + 1];
        newTgt[base + 2] = tmpVec.z;
    }

    return {
        ...track,
        keyframes: {
            ...track.keyframes,
            values: {
                position: newPos,
                target: newTgt,
                fov: [...fov]
            }
        }
    };
}

async function waitFrameEnd(app: AppBase): Promise<void> {
    app.renderNextFrame = true;
    await new Promise<void>((resolve) => app.once('frameend', () => resolve()));
}

export class BillionsAnimCameraController {
    private readonly animState: AnimState;
    private readonly camera: Entity;
    private readonly app: AppBase;

    constructor(track: AnimTrack, camera: Entity, app: AppBase) {
        this.animState = AnimState.fromTrack(track);
        this.camera = camera;
        this.app = app;
    }

    private applyPose() {
        const { position, target } = this.animState;
        this.camera.setPosition(position);
        this.camera.lookAt(target);
        const cam = this.camera.camera;
        if (cam) {
            cam.fov = this.animState.getFov();
        }
    }

    private setAnimTime(timeSec: number) {
        this.animState.cursor.cursor = timeSec;
        this.animState.cursor.timer = 0;
        this.animState.update(0);
        this.applyPose();
    }

    async scrubToAnimTime(timeSec: number): Promise<void> {
        this.setAnimTime(timeSec);
        await waitFrameEnd(this.app);
    }

    async playUntilAnimTime(
        fromSec: number,
        targetSec: number,
        fpsSamples: number[]
    ): Promise<number> {
        this.setAnimTime(fromSec);
        const startMs = performance.now();
        this.app.renderNextFrame = true;

        return new Promise((resolve) => {
            const onUpdate = (dt: number) => {
                const fps = this.app.stats.frame.fps;
                if (Number.isFinite(fps) && fps > 0) {
                    fpsSamples.push(fps);
                }

                this.animState.update(dt);
                this.applyPose();

                if (this.animState.cursor.cursor >= targetSec - ANIM_TIME_EPSILON_SEC) {
                    this.setAnimTime(targetSec);
                    this.app.off('update', onUpdate);
                    resolve(performance.now() - startMs);
                }
            };
            this.app.on('update', onUpdate);
        });
    }
}

export function keyframeTimesSec(track: AnimTrack): number[] {
    const frameRate = track.frameRate || 30;
    return track.keyframes.times.map((frame) => frame / frameRate);
}

export function cloneWorldTransform(entity: Entity): Mat4 {
    return tmpMat.copy(entity.getWorldTransform());
}
