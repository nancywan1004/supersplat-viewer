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
const tmpPrevPos = new Vec3();

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
     * Fly 模式：将相机 position 限制在 bbox 内
     * @returns 是否发生了 clamp
     */
    private clampPositionIntoBox(position: Vec3, result: Vec3): boolean {
        if (!this.targetConstraint) {
            result.copy(position);
            return false;
        }
        return this.targetConstraint.clampPoint(position, result);
    }

    onEnter(camera: Camera): void {
        this._targetPose.set(camera.position, camera.angles, camera.distance);
        this._pose.copy(this._targetPose);

        // 进入 fly 模式：**不做 snap/clamp**（避免 orbit→fly 时因位置在 box 外而瞬移跳变）
        // 约束仅在“inside→outside”或“继续远离 box”时生效（见 update）
        if (!this.targetConstraint && this.constraint) {
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
        
        // 应用约束（位置层面）：硬边界兜底，避免相机穿出范围
        if (this.targetConstraint) {
            const currentIn = this.targetConstraint.containsPoint(this._pose.position);
            if (currentIn) {
                // inside -> (maybe) outside：沿 current->desired 截断到 AABB（比直接 clamp 更不“滑”）
                this.targetConstraint.constrainSegment(this._pose.position, tmpPos, tmpPos);
                this._targetPose.position.copy(tmpPos);
            } else {
                // 若当前已经在 box 外：不进行 snap（避免跳变）
                // 仅阻止继续远离 box；允许用户飞回 box 内
                this.targetConstraint.clampPoint(this._pose.position, tmpClamp);
                const curDist = this._pose.position.distance(tmpClamp);
                this.targetConstraint.clampPoint(tmpPos, tmpClamp);
                const nextDist = tmpPos.distance(tmpClamp);

                if (nextDist > curDist + 1e-5) {
                    // 继续远离：吃掉这次位移
                    this._targetPose.position.copy(this._pose.position);
                } else {
                    // 朝向 box 或保持：允许移动（即使仍在 box 外）
                    this._targetPose.position.copy(tmpPos);
                }
            }
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
        
        // 输出阶段：
        // - 若在 box 内：保持 box 内（保险）
        // - 若在 box 外：不做 snap（避免跳变），由“继续远离限制 + 允许飞回”机制逐步回到 box 内
        tmpPrevPos.copy(camera.position);

        camera.position.copy(this._pose.position);
        if (this.targetConstraint) {
            if (this.targetConstraint.containsPoint(camera.position)) {
                const clamped = this.clampPositionIntoBox(camera.position, tmpClamp);
                if (clamped) {
                    camera.position.copy(tmpClamp);
                    // 同步回写，避免内部状态继续“顶着边界”累计导致卡死
                    this._pose.position.copy(tmpClamp);
                    this._targetPose.position.copy(tmpClamp);
                }
            }
        } else if (this.constraint) {
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
            const changed = this.clampPositionIntoBox(pose.position, tmpPos);
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
