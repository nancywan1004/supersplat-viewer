import {
    OrbitController as OrbitControllerPC,
    Pose,
    Vec2,
    Vec3,
    Quat
} from 'playcanvas';

import type { Camera, CameraFrame, CameraController } from './camera';
import type { BoxConstraint } from '../camera-constraints/box-constraint';

const p = new Pose();
const tmpVec = new Vec3();
const tmpTarget = new Vec3();
const tmpForward = new Vec3();
const tmpQuat = new Quat();

class OrbitController implements CameraController {
    controller: OrbitControllerPC;
    private targetConstraint: BoxConstraint | null = null;

    constructor() {
        this.controller = new OrbitControllerPC();
        this.controller.zoomRange = new Vec2(0.5, Infinity); // Minimum zoom distance to preserve pan functionality
        this.controller.pitchRange = new Vec2(0, 90);
        this.controller.rotateDamping = 0.97;
        this.controller.moveDamping = 0.97;
        this.controller.zoomDamping = 0.97;
    }

    /**
     * 设置 target 约束（用于 pan 平移）
     */
    setTargetConstraint(constraint: BoxConstraint | null): void {
        this.targetConstraint = constraint;
    }

    onEnter(camera: Camera): void {
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, false);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const pose = this.controller.update(inputFrame, deltaTime);

        // 约束策略：
        // - **target/focus point** 限制在收缩后的 BoundingBox 内（符合“场景核心区域”）
        // - zoom 只通过 distance 控制（不再用球形位置约束，避免贴球面滑动）
        if (this.targetConstraint) {
            // 计算 desired target（本帧输入）
            tmpQuat.setFromEulerAngles(pose.angles);
            tmpQuat.transformVector(Vec3.FORWARD, tmpForward);
            tmpTarget.copy(tmpForward).mulScalar(pose.distance).add(pose.position);

            // clamp target 到 box 内
            const clamped = this.targetConstraint.clampPoint(tmpTarget, tmpTarget);
            if (clamped) {
                // 反解 position = target - forward * distance
                pose.position.copy(tmpTarget).sub(tmpForward.mulScalar(pose.distance));
            }
        }

        camera.position.copy(pose.position);

        camera.angles.copy(pose.angles);
        camera.distance = pose.distance;
    }

    onExit(_camera: Camera): void {

    }

    goto(camera: Camera) {
        // goto 时让 target 落入 box 内（避免初始就处在边界外导致 pan 手感异常）
        if (this.targetConstraint) {
            tmpQuat.setFromEulerAngles(camera.angles);
            tmpQuat.transformVector(Vec3.FORWARD, tmpForward);
            tmpTarget.copy(tmpForward).mulScalar(camera.distance).add(camera.position);
            const clamped = this.targetConstraint.clampPoint(tmpTarget, tmpTarget);
            if (clamped) {
                camera.position.copy(tmpTarget).sub(tmpForward.mulScalar(camera.distance));
            }
        }

        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, true);
    }
}

export { OrbitController };
