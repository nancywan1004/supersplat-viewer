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
const tmpv = new Vec3();

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
    private moveLimitCenter: Vec3 | null = null;
    private maxMoveRadius: number = Infinity;

    constructor() {
        this._targetPose = new Pose();
        this._pose = new Pose();
    }

    setMoveLimit(center: Vec3, maxRadius: number) {
        this.moveLimitCenter = center.clone();
        this.maxMoveRadius = maxRadius;
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
        
        // 应用移动范围限制 - 在移动前检查，只允许在边界内的移动
        if (this.moveLimitCenter && this.maxMoveRadius < Infinity) {
            // 计算当前位置到中心的距离
            const currentDistance = tmpv.sub2(this._targetPose.position, this.moveLimitCenter).length();
            
            // 计算移动后的位置
            const newPosition = new Vec3().add2(this._targetPose.position, offset);
            const newDistance = tmpv.sub2(newPosition, this.moveLimitCenter).length();
            
            if (newDistance > this.maxMoveRadius) {
                if (currentDistance >= this.maxMoveRadius) {
                    // 如果已经在边界上或超出边界，只允许向内的移动
                    const toCenter = new Vec3().sub2(this.moveLimitCenter, this._targetPose.position).normalize();
                    const moveDirection = offset.length() > 0 ? offset.clone().normalize() : new Vec3();
                    const dot = toCenter.dot(moveDirection);
                    
                    if (dot > 0) {
                        // 向内的移动，允许但限制距离
                        const maxMove = Math.min(offset.length(), this.maxMoveRadius * 0.1);
                        offset.normalize().mulScalar(maxMove);
                    } else {
                        // 向外的移动，阻止
                        offset.set(0, 0, 0);
                    }
                } else {
                    // 在边界内，允许移动但限制不超过边界
                    const allowedDistance = this.maxMoveRadius - currentDistance;
                    const moveLength = offset.length();
                    if (moveLength > allowedDistance) {
                        offset.normalize().mulScalar(allowedDistance);
                    }
                }
            }
        }
        
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
