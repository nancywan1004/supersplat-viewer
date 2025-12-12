import {
    OrbitController as OrbitControllerPC,
    Pose,
    Quat,
    Vec2,
    Vec3
} from 'playcanvas';

import type { Camera, CameraFrame, CameraController } from './camera';

const p = new Pose();
const tmpv = new Vec3();

class OrbitController implements CameraController {
    controller: OrbitControllerPC;
    private moveLimitCenter: Vec3 | null = null;
    private maxMoveRadius: number = Infinity;

    constructor() {
        this.controller = new OrbitControllerPC();
        this.controller.zoomRange = new Vec2(0.5, Infinity); // Minimum zoom distance to preserve pan functionality
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = 0.97;
        this.controller.moveDamping = 0.97;
        this.controller.zoomDamping = 0.97;
    }

    setMoveLimit(center: Vec3, maxRadius: number) {
        this.moveLimitCenter = center.clone();
        this.maxMoveRadius = maxRadius;
    }

    onEnter(camera: Camera): void {
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, false);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const pose = this.controller.update(inputFrame, deltaTime);

        // 应用移动范围限制 - 使用更智能的方式，避免改变移动方向
        if (this.moveLimitCenter && this.maxMoveRadius < Infinity) {
            tmpv.sub2(pose.position, this.moveLimitCenter);
            const distance = tmpv.length();
            if (distance > this.maxMoveRadius) {
                // 计算从当前位置到限制中心的方向
                const direction = tmpv.normalize();
                // 将位置限制在最大半径内，保持方向不变
                pose.position.add2(this.moveLimitCenter, direction.mulScalar(this.maxMoveRadius));
                
                // 重新计算 distance，使其与限制后的位置匹配
                // 计算焦点位置：焦点 = 相机位置 - 方向 * distance
                const focusPoint = new Vec3();
                const forward = new Vec3();
                const rotation = new Quat();
                rotation.setFromEulerAngles(pose.angles);
                rotation.transformVector(Vec3.FORWARD, forward);
                focusPoint.add2(pose.position, forward.mulScalar(pose.distance));
                
                // 重新计算 distance 为限制后的位置到焦点的距离
                const newDistance = pose.position.distance(focusPoint);
                pose.distance = newDistance;
                
                // 同步更新 OrbitControllerPC 的内部 pose，防止继续移动
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
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, true);
    }
}

export { OrbitController };
