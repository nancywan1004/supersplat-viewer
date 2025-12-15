import {
    Pose,
    Vec2,
    Vec3,
    Quat,
    math
} from 'playcanvas';

import type { CameraFrame, Camera, CameraController } from './camera';

const angles = new Vec3();
const rotation = new Quat();
const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const offset = new Vec3();

// Damping helper function
const damp = (damping: number, dt: number) => {
    return 1 - Math.pow(damping, dt * 60);
};

class FlyController implements CameraController {
    private _targetPose: Pose;
    private _pose: Pose;
    rotateDamping: number = 0.1; // Lower damping for more responsive rotation (was 0.9)
    moveDamping: number = 0.9;
    pitchRange: Vec2 = new Vec2(-90, 90);

    constructor() {
        this._targetPose = new Pose();
        this._pose = new Pose();
    }

    onEnter(camera: Camera): void {
        this._targetPose.set(camera.position, camera.angles, camera.distance);
        this._pose.copy(this._targetPose);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const { move, rotate } = inputFrame.read();
        
        // Apply rotation with roll support
        // rotate[0] = mouse/touch X (yaw)
        // rotate[1] = mouse/touch Y (pitch)
        // rotate[2] = Q/E keys (roll)
        angles.set(-rotate[1], -rotate[0], rotate[2]);
        this._targetPose.rotate(angles);
        
        // Clamp pitch
        this._targetPose.angles.x = math.clamp(
            this._targetPose.angles.x,
            this.pitchRange.x,
            this.pitchRange.y
        );
        
        // Apply movement in local space
        rotation.setFromEulerAngles(this._pose.angles);
        rotation.transformVector(Vec3.FORWARD, forward);
        rotation.transformVector(Vec3.RIGHT, right);
        rotation.transformVector(Vec3.UP, up);
        
        offset.set(0, 0, 0);
        offset.add(forward.mulScalar(move[2]));
        offset.add(right.mulScalar(move[0]));
        offset.add(up.mulScalar(move[1]));
        
        this._targetPose.move(offset);
        
        // Apply damping using Pose.lerp
        this._pose.lerp(
            this._pose,
            this._targetPose,
            damp(this.moveDamping, deltaTime),
            damp(this.rotateDamping, deltaTime),
            1
        );
        
        // Update camera
        camera.position.copy(this._pose.position);
        camera.angles.copy(this._pose.angles);
        camera.distance = this._pose.distance;

    }

    onExit(_camera: Camera): void {
        // No cleanup needed
    }

    goto(pose: Pose) {
        this._targetPose.copy(pose);
        this._pose.copy(pose);
    }
}

export { FlyController };
