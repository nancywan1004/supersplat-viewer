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
const tmpClamp = new Vec3();

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
        
        // 进入 fly 模式时也应用“软边界回弹”，避免直接贴硬边界导致移动受限
        if (this.constraint) {
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
        if (this.constraint) {
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
        
        // 输出阶段：叠加软边界阻尼回弹（spring/damping 感）
        if (this.constraint) {
            // 先把相机输出设置为 _pose
            camera.position.copy(this._pose.position);

            // 如果落在软边界外，则以 damping 形式回弹到软边界
            const clampedSoft = this.constraint.clampToSoft(camera.position, tmpClamp);
            if (clampedSoft) {
                const a = damp(this.constraint.reboundDamping, deltaTime);
                camera.position.lerp(camera.position, tmpClamp, a);
                // 同步回写，避免下一帧又从外侧继续积分
                this._pose.position.copy(camera.position);
            }

            // 硬边界兜底
            this.constraint.clampToHard(camera.position, camera.position);
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
        // goto 时应用“软边界回弹”
        if (this.constraint) {
            this.constraint.clampToSoft(pose.position, tmpPos);
            this._targetPose.set(tmpPos, pose.angles, pose.distance);
        } else {
            this._targetPose.copy(pose);
        }
        this._pose.copy(this._targetPose);
    }
}

export { FlyController };
