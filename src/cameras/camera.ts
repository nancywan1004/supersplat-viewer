import { math, Vec3, Quat } from 'playcanvas';
import type { InputFrame } from 'playcanvas';

import { vecToAngles } from '../core/math';

type CameraFrame = InputFrame<{
    move: [number, number, number];
    rotate: [number, number, number];
}>;

const rotation = new Quat();
const avec = new Vec3();
const bvec = new Vec3();
const CAMERA_LOOK_EPSILON = 1e-6;
const isFiniteVec3Like = (v: Vec3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

class Camera {
    position = new Vec3();

    angles = new Vec3();

    distance = 1;

    fov = 65;

    constructor(other?: Camera) {
        if (other) {
            this.copy(other);
        }
    }

    copy(source: Camera) {
        this.position.copy(source.position);
        this.angles.copy(source.angles);
        this.distance = source.distance;
        this.fov = source.fov;
    }

    lerp(a: Camera, b: Camera, t: number) {
        if (!isFiniteVec3Like(a.position) || !isFiniteVec3Like(b.position) ||
            !isFiniteVec3Like(a.angles) || !isFiniteVec3Like(b.angles) ||
            !Number.isFinite(a.distance) || !Number.isFinite(b.distance) ||
            !Number.isFinite(a.fov) || !Number.isFinite(b.fov)) {
            return;
        }

        a.calcFocusPoint(avec);
        b.calcFocusPoint(bvec);

        this.position.lerp(a.position, b.position, t);
        avec.lerp(avec, bvec, t).sub(this.position);

        const distance = avec.length();
        if (!Number.isFinite(distance) || distance <= CAMERA_LOOK_EPSILON) {
            // Guard transition interpolation from normalize(0) / invalid vectors.
            // Keep previous orientation and a sane positive focus distance to avoid camera NaN (black screen).
            this.distance = Math.max(CAMERA_LOOK_EPSILON, this.distance);
        } else {
            this.distance = distance;
            vecToAngles(this.angles, avec.mulScalar(1.0 / distance));
        }
        
        // Preserve roll by interpolating it separately
        // vecToAngles only calculates pitch and yaw, setting roll to 0
        this.angles.z = math.lerp(a.angles.z, b.angles.z, t);

        this.fov = math.lerp(a.fov, b.fov, t);
    }

    look(from: Vec3, to: Vec3) {
        if (!isFiniteVec3Like(from) || !isFiniteVec3Like(to)) {
            return;
        }
        this.position.copy(from);
        const dir = avec.sub2(to, from);
        const distance = dir.length();
        if (!Number.isFinite(distance) || distance <= CAMERA_LOOK_EPSILON) {
            // Preserve the previous orientation and keep a sane positive focus distance.
            // This prevents invalid normalize(0) from corrupting camera angles and causing black screens.
            this.distance = Math.max(CAMERA_LOOK_EPSILON, this.distance);
            return;
        }
        this.distance = distance;
        dir.mulScalar(1 / distance);
        vecToAngles(this.angles, dir);
    }

    calcFocusPoint(result: Vec3) {
        rotation.setFromEulerAngles(this.angles)
        .transformVector(Vec3.FORWARD, result)
        .mulScalar(this.distance)
        .add(this.position);
    }
}

interface CameraController {
    onEnter(camera: Camera): void;
    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera): void;
    onExit(camera: Camera): void;
}

export type { CameraFrame, CameraController };

export { Camera };
