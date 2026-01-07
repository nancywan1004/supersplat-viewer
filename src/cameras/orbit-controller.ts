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

        // 应用约束：限制相机位置在sphere内
        if (this.constraint) {
            this.constraint.clampPoint(pose.position, camera.position);
        } else {
            camera.position.copy(pose.position);
        }

        camera.angles.copy(pose.angles);
        camera.distance = pose.distance;
    }

    onExit(_camera: Camera): void {

    }

    goto(camera: Camera) {
        // goto时，如果目标位置超出约束，则移动到约束边界
        // 这样可以确保相机始终在有效范围内
        if (this.constraint) {
            if (!this.constraint.containsPoint(camera.position)) {
                // 如果目标位置超出约束，移动到sphere表面
                this.constraint.clampPoint(camera.position, tmpVec);
                camera.position.copy(tmpVec);
            }
        }
        
        p.position.copy(camera.position);
        p.angles.copy(camera.angles);
        p.distance = camera.distance;
        this.controller.attach(p, true);
    }
}

export { OrbitController };
