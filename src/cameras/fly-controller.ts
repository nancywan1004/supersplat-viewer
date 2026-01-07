import {
    Pose,
    Vec2,
    Vec3,
    Quat,
    math
} from 'playcanvas';

import type { CameraFrame, Camera, CameraController } from './camera';
import type { SphereConstraint } from '../camera-constraints/sphere-constraint';
import type { BoxConstraint } from '../camera-constraints/box-constraint';

const angles = new Vec3();
const rotation = new Quat();
const forward = new Vec3();
const right = new Vec3();
const up = new Vec3();
const offset = new Vec3();
const tmpPos = new Vec3();
const tmpClamp = new Vec3();
const tmpQuat = new Quat();
const tmpForward = new Vec3();
const tmpFocus = new Vec3();
const tmpCurrentFocus = new Vec3();
const tmpPrevPos = new Vec3();
const tmpPrevAngles = new Vec3();

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
    private targetConstraint: BoxConstraint | null = null;

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

    /**
     * 设置 target/focus 约束（与 Orbit 保持一致，用于限制相机活动范围）
     */
    setTargetConstraint(constraint: BoxConstraint | null): void {
        this.targetConstraint = constraint;
    }

    /**
     * 将 focus/target 点限制在 bbox 内，并反解位置（保持 distance 不变）
     * @returns 是否发生了修正
     */
    private constrainTargetSegment(
        currentPosition: Vec3,
        currentAngles: Vec3,
        desiredPosition: Vec3,
        desiredAngles: Vec3,
        distance: number,
        result: Vec3
    ): boolean {
        if (!this.targetConstraint) {
            result.copy(desiredPosition);
            return false;
        }

        // current focus（上一帧输出）
        tmpQuat.setFromEulerAngles(currentAngles);
        tmpQuat.transformVector(Vec3.FORWARD, tmpForward);
        tmpCurrentFocus.copy(tmpForward).mulScalar(distance).add(currentPosition);

        // desired focus（本帧期望）
        tmpQuat.setFromEulerAngles(desiredAngles);
        tmpQuat.transformVector(Vec3.FORWARD, tmpForward);
        tmpFocus.copy(tmpForward).mulScalar(distance).add(desiredPosition);

        // 沿 current->desired 方向截断到 AABB（避免贴边产生切向滑动）
        const constrained = this.targetConstraint.constrainSegment(tmpCurrentFocus, tmpFocus, tmpFocus);
        if (!constrained) {
            result.copy(desiredPosition);
            return false;
        }

        // position = focus - forward * distance
        result.copy(tmpFocus).sub(tmpForward.mulScalar(distance));
        return true;
    }

    /**
     * 初始化/跳转时把 focus 直接 snap 到 box 内（不做 segment/damping）
     */
    private snapTargetIntoBox(position: Vec3, anglesIn: Vec3, distance: number, result: Vec3): boolean {
        if (!this.targetConstraint) {
            result.copy(position);
            return false;
        }

        tmpQuat.setFromEulerAngles(anglesIn);
        tmpQuat.transformVector(Vec3.FORWARD, tmpForward);
        tmpFocus.copy(tmpForward).mulScalar(distance).add(position);

        const clamped = this.targetConstraint.clampPoint(tmpFocus, tmpFocus);
        if (!clamped) {
            result.copy(position);
            return false;
        }

        result.copy(tmpFocus).sub(tmpForward.mulScalar(distance));
        return true;
    }

    onEnter(camera: Camera): void {
        this._targetPose.set(camera.position, camera.angles, camera.distance);
        this._pose.copy(this._targetPose);
        
        // 进入 fly 模式时也应用“软边界回弹”，避免直接贴硬边界导致移动受限
        // 这里优先保证与 Orbit 一致：focus/target 在 bbox 内
        if (this.targetConstraint) {
            const changed = this.snapTargetIntoBox(
                this._targetPose.position,
                this._targetPose.angles,
                this._targetPose.distance,
                tmpClamp
            );
            if (changed) {
                this._targetPose.position.copy(tmpClamp);
                this._pose.position.copy(tmpClamp);
            }
        } else if (this.constraint) {
            // 兼容旧逻辑：没有 box 约束时，仍可用球形软边界兜底
            this.constraint.clampToSoft(this._targetPose.position, this._targetPose.position);
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
        
        // 应用约束（目标层面）：硬边界兜底，避免目标跑出范围
        // 真正的“软边界回弹 damping”在后面输出阶段叠加（这样更像弹簧效果）
        if (this.targetConstraint) {
            // 与 Orbit 对齐：有 box 约束时不再应用 sphere（否则会出现范围很小/回弹/跳变）
            this._targetPose.position.copy(tmpPos);
        } else if (this.constraint) {
            this.constraint.clampToHard(tmpPos, this._targetPose.position);
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
        
        // 输出阶段：与 Orbit 一致，限制 focus/target 在 bbox 内
        // 关键：segment 截断需要上一帧输出作为 current
        tmpPrevPos.copy(camera.position);
        tmpPrevAngles.copy(camera.angles);

        camera.position.copy(this._pose.position);
        const changed = this.targetConstraint ? this.constrainTargetSegment(
            tmpPrevPos,
            tmpPrevAngles,
            camera.position,
            this._pose.angles,
            this._pose.distance,
            tmpClamp
        ) : false;
        if (changed) {
            camera.position.copy(tmpClamp);
            // 同步回写，避免内部状态继续“顶着边界”累计导致卡死
            this._pose.position.copy(tmpClamp);
            this._targetPose.position.copy(tmpClamp);
        } else if (!this.targetConstraint && this.constraint) {
            // 没有 box 约束时，用球形硬边界兜底（防止飞到特别远）
            this.constraint.clampToHard(camera.position, camera.position);
            this._pose.position.copy(camera.position);
        }
        
        camera.angles.copy(this._pose.angles);
        camera.distance = this._pose.distance;
    }

    onExit(_camera: Camera): void {
        // No cleanup needed
    }

    goto(pose: Pose) {
        // goto 时应用“软边界回弹”
        if (this.targetConstraint) {
            const changed = this.snapTargetIntoBox(pose.position, pose.angles, pose.distance, tmpPos);
            this._targetPose.set(changed ? tmpPos : pose.position, pose.angles, pose.distance);
        } else if (this.constraint) {
            this.constraint.clampToSoft(pose.position, tmpPos);
            this._targetPose.set(tmpPos, pose.angles, pose.distance);
        } else {
            this._targetPose.copy(pose);
        }
        this._pose.copy(this._targetPose);
    }
}

export { FlyController };
