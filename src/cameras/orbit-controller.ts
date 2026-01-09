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
const tmpPrevPos = new Vec3();
const tmpClampPos = new Vec3();
const tmpRemain = new Vec3();
const tmpNormal2 = new Vec3();

class OrbitController implements CameraController {
    controller: OrbitControllerPC;
    private targetConstraint: BoxConstraint | null = null;

    constructor() {
        this.controller = new OrbitControllerPC();
        this.controller.zoomRange = new Vec2(0.5, Infinity); // Minimum zoom distance to preserve pan functionality
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = 0.97;
        this.controller.moveDamping = 0.97;
        this.controller.zoomDamping = 0.97;
    }

    /**
     * 设置约束（与 Fly 保持一致：约束 camera.position 活动范围）
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
        // 记录上一帧位置，用于“撞墙后滑动”与 segment 约束
        tmpPrevPos.copy(camera.position);

        const pose = this.controller.update(inputFrame, deltaTime);

        // 约束策略：
        // - 为了与 Fly 边界一致：限制 **camera.position** 在 BoundingBox 内（含“撞墙后沿边界滑动”）
        // - zoom 仍由 distance 控制（OrbitControllerPC 的语义）
        if (this.targetConstraint) {
            const desiredPos = pose.position;
            const currentPos = tmpPrevPos;

            const currentIn = this.targetConstraint.containsPoint(currentPos);
            const desiredIn = this.targetConstraint.containsPoint(desiredPos);

            let changed = false;

            if (desiredIn) {
                // no-op
            } else if (currentIn) {
                // inside -> outside：先撞墙到盒边，再把剩余位移投影到盒面切向（允许沿边界滑动，避免卡死）
                this.targetConstraint.constrainSegment(currentPos, desiredPos, tmpClampPos);
                tmpRemain.sub2(desiredPos, tmpClampPos);

                const min = this.targetConstraint.bbox.getMin();
                const max = this.targetConstraint.bbox.getMax();
                const e = this.targetConstraint.epsilon;
                const tol = e * 2 + 1e-6;

                const minX = (max.x - min.x > 2 * e) ? (min.x + e) : min.x;
                const maxX = (max.x - min.x > 2 * e) ? (max.x - e) : max.x;
                const minY = (max.y - min.y > 2 * e) ? (min.y + e) : min.y;
                const maxY = (max.y - min.y > 2 * e) ? (max.y - e) : max.y;
                const minZ = (max.z - min.z > 2 * e) ? (min.z + e) : min.z;
                const maxZ = (max.z - min.z > 2 * e) ? (max.z - e) : max.z;

                tmpNormal2.set(0, 0, 0);
                if (Math.abs(tmpClampPos.x - minX) <= tol) tmpNormal2.x = -1;
                else if (Math.abs(tmpClampPos.x - maxX) <= tol) tmpNormal2.x = 1;
                if (Math.abs(tmpClampPos.y - minY) <= tol) tmpNormal2.y = -1;
                else if (Math.abs(tmpClampPos.y - maxY) <= tol) tmpNormal2.y = 1;
                if (Math.abs(tmpClampPos.z - minZ) <= tol) tmpNormal2.z = -1;
                else if (Math.abs(tmpClampPos.z - maxZ) <= tol) tmpNormal2.z = 1;

                if (tmpNormal2.x !== 0 && tmpRemain.x * tmpNormal2.x > 0) tmpRemain.x = 0;
                if (tmpNormal2.y !== 0 && tmpRemain.y * tmpNormal2.y > 0) tmpRemain.y = 0;
                if (tmpNormal2.z !== 0 && tmpRemain.z * tmpNormal2.z > 0) tmpRemain.z = 0;

                desiredPos.copy(tmpClampPos).add(tmpRemain);
                changed = this.targetConstraint.clampPoint(desiredPos, desiredPos) || changed;
            } else {
                // 当前在盒外：不 snap，只阻止继续远离；允许用户移动回盒内
                this.targetConstraint.clampPoint(currentPos, tmpClampPos);
                const curDist = currentPos.distance(tmpClampPos);
                this.targetConstraint.clampPoint(desiredPos, tmpClampPos);
                const nextDist = desiredPos.distance(tmpClampPos);
                if (nextDist > curDist + 1e-5) {
                    desiredPos.copy(currentPos);
                    changed = true;
                }
            }

            // damping 之后 controller 的 pose 仍可能短暂落在盒外，这里强制拉回并同步内部状态，避免切换到 fly 时出现回弹
            if (!desiredIn) {
                changed = this.targetConstraint.clampPoint(desiredPos, desiredPos) || changed;
            }

            if (changed) {
                // 同步 OrbitControllerPC 内部状态，避免后续输入“顶着边界”累计导致怪异手感
                p.position.copy(pose.position);
                p.angles.copy(pose.angles);
                p.distance = pose.distance;
                this.controller.attach(p, false);
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
