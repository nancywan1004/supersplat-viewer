import {
    Pose,
    Vec2,
    Vec3,
    Quat,
    math
} from 'playcanvas';

import type { CameraFrame, Camera, CameraController } from './camera';
import type { SphereConstraint } from '../camera-constraints/sphere-constraint';

const angles = new Vec3();
const rotation = new Quat();
const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const offset = new Vec3();
const tmpPos = new Vec3();

// Damping helper function
const damp = (damping: number, dt: number) => {
    return 1 - Math.pow(damping, dt * 60);
};

class FlyController implements CameraController {
    private _targetPose: Pose;
    private _pose: Pose;
    rotateDamping: number = 0.1; // Lower damping for more responsive rotation (was 0.9)
    moveDamping: number = 0.5;
    pitchRange: Vec2 = new Vec2(-90, 90);
    private constraint: SphereConstraint | null = null;

    constructor() {
        this._targetPose = new Pose();
        this._pose = new Pose();
    }

    /**
     * 设置约束
     */
    setConstraint(constraint: SphereConstraint | null): void {
        this.constraint = constraint;
    }

    onEnter(camera: Camera): void {
        this._targetPose.set(camera.position, camera.angles, camera.distance);
        this._pose.copy(this._targetPose);
        
        // 如果初始位置超出约束，移动到约束边界
        if (this.constraint && !this.constraint.containsPoint(camera.position)) {
            this.constraint.clampPoint(this._targetPose.position, this._targetPose.position);
            this._pose.position.copy(this._targetPose.position);
        }
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
        
        // 预测下一个位置
        tmpPos.copy(this._targetPose.position).add(offset);
        
        // 应用约束：限制在sphere内
        if (this.constraint) {
            this.constraint.clampPoint(tmpPos, this._targetPose.position);
        } else {
            this._targetPose.position.copy(tmpPos);
        }
        
        // Apply damping using Pose.lerp
        this._pose.lerp(
            this._pose,
            this._targetPose,
            damp(this.moveDamping, deltaTime),
            damp(this.rotateDamping, deltaTime),
            1
        );
        
        // 确保最终位置也在约束内
        if (this.constraint) {
            this.constraint.clampPoint(this._pose.position, camera.position);
        } else {
            camera.position.copy(this._pose.position);
        }
        
        camera.angles.copy(this._pose.angles);
        camera.distance = this._pose.distance;
    }

    onExit(_camera: Camera): void {
        // No cleanup needed
    }

    goto(pose: Pose) {
        // goto时，如果目标位置超出约束，则移动到约束边界
        if (this.constraint) {
            if (!this.constraint.containsPoint(pose.position)) {
                this.constraint.clampPoint(pose.position, tmpPos);
                this._targetPose.set(tmpPos, pose.angles, pose.distance);
            } else {
                this._targetPose.copy(pose);
            }
        } else {
            this._targetPose.copy(pose);
        }
        this._pose.copy(this._targetPose);
    }
}

export { FlyController };
