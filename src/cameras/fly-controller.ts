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
const tmpForward = new Vec3();
const tmpFocus = new Vec3();
const tmpCurForward = new Vec3();
const tmpCurFocus = new Vec3();
const tmpClamped = new Vec3();

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
    /**
     * 与 orbit zoomRange 语义一致：限制 distance 的范围（用于 fly 模式的 dolly 缩放）
     */
    zoomRange: Vec2 = new Vec2(0.5, Infinity);
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
        const { move, rotate, zoom } = inputFrame.read();
        
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

        // fly 模式下的“缩放”（dolly）：调整 distance 的同时**必须更新 position**
        // 否则 distance 只是元数据，画面不会有任何变化（你现在看到的“滚轮/W/S没反应”就是这个原因）。
        //
        // 这里用一个“虚拟 focus”保持不变：
        // focus = position + forward * distance
        // distance 改变后，position = focus - forward * newDistance
        if (zoom && zoom[0] !== 0) {
            // forward 使用 targetPose 的姿态（本帧期望姿态），让缩放方向与视线一致
            rotation.setFromEulerAngles(this._targetPose.angles);
            rotation.transformVector(Vec3.FORWARD, tmpForward);

            // focus 基于当前 targetPose 的 position/distance（缩放前）
            tmpFocus.copy(tmpForward).mulScalar(this._targetPose.distance).add(this._targetPose.position);

            const desired = this._targetPose.distance * (1 + zoom[0]);
            const newDistance = math.clamp(desired, this.zoomRange.x, this.zoomRange.y);
            this._targetPose.distance = newDistance;

            // 反解 position（产生真实的 dolly 位移）
            this._targetPose.position.copy(tmpFocus).sub(tmpForward.mulScalar(newDistance));
        }
        
        offset.set(0, 0, 0);
        // move[2] 在 fly 中仅用于“真正的前后平移/飞行”（例如摇杆/自定义移动），
        // 键盘 W/S、滚轮、pinch 已在 InputController 中改为 zoom(distance)。
        offset.add(forward.mulScalar(move[2]));
        offset.add(right.mulScalar(move[0]));
        offset.add(up.mulScalar(move[1]));
        
        // 预测下一个位置
        tmpPos.copy(this._targetPose.position).add(offset);
        
        // 应用约束（与 Orbit 行为一致）：
        // - Orbit 约束的是 target/focus point（position + forward * distance）
        // - Fly 若直接约束 position，贴边时容易出现“某个分量轻微越界 => move 被截断/卡死”的手感
        // 因此 Fly 也改为约束 focus point，再反解 position（撞墙停止但不切线滑动）
        if (this.targetConstraint) {
            // 使用 target angles（本帧期望姿态）计算 forward
            rotation.setFromEulerAngles(this._targetPose.angles);
            rotation.transformVector(Vec3.FORWARD, tmpForward);

            // desired focus = desiredPos + forward * distance
            tmpFocus.copy(tmpForward).mulScalar(this._targetPose.distance).add(tmpPos);

            // current focus = currentPos + forward(currentAngles) * currentDistance
            rotation.setFromEulerAngles(this._pose.angles);
            rotation.transformVector(Vec3.FORWARD, tmpCurForward);
            tmpCurFocus.copy(tmpCurForward).mulScalar(this._pose.distance).add(this._pose.position);

            const currentFocusIn = this.targetConstraint.containsPoint(tmpCurFocus);
            const hasMoveInput = (move[0] !== 0) || (move[1] !== 0) || (move[2] !== 0) || (zoom && zoom[0] !== 0);
            const isZoomOnly = (zoom && zoom[0] !== 0) && (move[0] === 0) && (move[1] === 0) && (move[2] === 0);

            if (currentFocusIn || hasMoveInput) {
                // 额外：即使当前 focus 在 box 外，也只在用户确实有移动输入时才开始 clamp，避免“无输入也突然 snap”
                //
                // 关键修复（你说的 zoom out 会沿切线漂移）：
                // - clampPoint 会把 focus 拉到盒面上，导致 position 反解时出现“切线方向漂移”
                // - 对于仅 zoom（沿 forward 前后移动）这种输入，更符合直觉的是“撞墙停止”：沿 currentFocus->desiredFocus 线段截断
                if (isZoomOnly && currentFocusIn) {
                    tmpClamped.copy(tmpCurFocus);
                    const constrained = this.targetConstraint.constrainSegment(tmpCurFocus, tmpFocus, tmpClamped);
                    if (constrained) {
                        tmpPos.copy(tmpClamped).sub(tmpForward.mulScalar(this._targetPose.distance));
                    }
                    this._targetPose.position.copy(tmpPos);
                } else {
                    // 默认：约束 focus；若 focus 被 clamp，则反解 position
                    tmpClamped.copy(tmpFocus);
                    const clamped = this.targetConstraint.clampPoint(tmpClamped, tmpClamped);
                    if (clamped) {
                        tmpPos.copy(tmpClamped).sub(tmpForward.mulScalar(this._targetPose.distance));
                    }
                    this._targetPose.position.copy(tmpPos);
                }
            } else {
                // 无移动输入且当前 focus 在 box 外：保持当前位置（不 snap）
                this._targetPose.position.copy(this._pose.position);
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
        // - Fly 与 Orbit 一致：约束 focus 点，而不是相机 position
        // - 不能在这里再对 position 做 clamp，否则会与 focus 约束互相打架，导致贴边平移“卡死”
        tmpPrevPos.copy(camera.position);

        camera.position.copy(this._pose.position);
        if (this.targetConstraint) {
            // 用当前 pose 计算 focus，并 clamp
            rotation.setFromEulerAngles(this._pose.angles);
            rotation.transformVector(Vec3.FORWARD, tmpForward);
            tmpFocus.copy(tmpForward).mulScalar(this._pose.distance).add(camera.position);

            const clamped = this.targetConstraint.clampPoint(tmpFocus, tmpFocus);
            if (clamped) {
                // 反解 position = focus - forward * distance
                camera.position.copy(tmpFocus).sub(tmpForward.mulScalar(this._pose.distance));
                // 同步回写，避免内部状态继续“顶着边界”累计导致卡死
                this._pose.position.copy(camera.position);
                this._targetPose.position.copy(camera.position);
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
