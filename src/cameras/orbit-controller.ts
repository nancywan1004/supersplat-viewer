import {
    OrbitController as OrbitControllerPC,
    Pose,
    Vec2,
    Vec3
} from 'playcanvas';

import type { Camera, CameraFrame, CameraController } from './camera';
import type { SphereConstraint } from '../camera-constraints/sphere-constraint';

const p = new Pose();
const tmpVec = new Vec3();
const tmpTarget = new Vec3();

// Damping helper function (same shape as fly-controller.ts)
const damp = (damping: number, dt: number) => {
    return 1 - Math.pow(damping, dt * 60);
};

class OrbitController implements CameraController {
    controller: OrbitControllerPC;
    private constraint: SphereConstraint | null = null;

    constructor() {
        this.controller = new OrbitControllerPC();
        this.controller.zoomRange = new Vec2(0.5, Infinity); // Minimum zoom distance to preserve pan functionality
        this.controller.pitchRange = new Vec2(-90, 90);
        this.controller.rotateDamping = 0.97;
        this.controller.moveDamping = 0.97;
        this.controller.zoomDamping = 0.97;
    }

    /**
     * 设置约束
     */
    setConstraint(constraint: SphereConstraint | null): void {
        this.constraint = constraint;
    }

    onEnter(camera: Camera): void {
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, false);
    }

    update(deltaTime: number, inputFrame: CameraFrame, camera: Camera) {
        const pose = this.controller.update(inputFrame, deltaTime);

        // 应用约束：使用“软边界 + 阻尼回弹”
        // - 超出软边界：以 damping 形式回弹到软边界
        // - 任何情况下：硬边界兜底，确保不会跑出 radius
        if (this.constraint) {
            const clampedSoft = this.constraint.clampToSoft(pose.position, tmpTarget);
            if (clampedSoft) {
                const a = damp(this.constraint.reboundDamping, deltaTime);
                camera.position.lerp(camera.position, tmpTarget, a);
            } else {
                camera.position.copy(pose.position);
            }

            // 硬边界兜底
            this.constraint.clampToHard(camera.position, camera.position);

            // 回写给底层 controller，避免“相机显示位置”和“控制器内部状态”分离
            pose.position.copy(camera.position);
        } else {
            camera.position.copy(pose.position);
        }

        camera.angles.copy(pose.angles);
        camera.distance = pose.distance;
    }

    onExit(_camera: Camera): void {

    }

    goto(camera: Camera) {
        // goto 时也应用“软边界回弹”，避免直接贴到硬边界导致后续交互卡死/抖动
        if (this.constraint) {
            // goto 这里直接 snap 到软边界内（不做 damping），避免初始状态就贴边
            this.constraint.clampToSoft(camera.position, tmpVec);
            camera.position.copy(tmpVec);
        }
        
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, true);
    }
}

export { OrbitController };
