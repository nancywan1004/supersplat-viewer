import { Vec3, BoundingBox } from 'playcanvas';
import { BoundingSphere } from '../core/bounding-sphere';

/**
 * 简单的Sphere约束
 * Orbit和Fly模式共享同一个约束
 */
export class SphereConstraint {
    sphere: BoundingSphere;

    constructor(center: Vec3 = new Vec3(), radius: number = 1) {
        this.sphere = new BoundingSphere(center, radius);
    }

    /**
     * 从BoundingBox创建约束
     */
    static fromBoundingBox(bbox: BoundingBox, shrinkFactor: number = 0.7): SphereConstraint {
        const center = bbox.center.clone();
        const radius = bbox.halfExtents.length() * shrinkFactor;
        return new SphereConstraint(center, radius);
    }

    /**
     * 检查点是否在约束范围内
     */
    containsPoint(point: Vec3): boolean {
        return this.sphere.containsPoint(point);
    }

    /**
     * 将点限制在sphere内（如果超出则投影到表面）
     */
    clampPoint(point: Vec3, result: Vec3): void {
        this.sphere.clampPoint(point, result);
    }

    /**
     * 检查移动是否被允许（新位置是否在约束范围内）
     * 如果新位置在约束内，允许移动；如果超出，限制在边界
     */
    checkMovement(currentPos: Vec3, newPos: Vec3, result: Vec3): boolean {
        // 如果新位置在sphere内，允许移动
        if (this.sphere.containsPoint(newPos)) {
            result.copy(newPos);
            return true;
        }
        // 如果新位置超出sphere，将位置限制在边界（允许移动到边界）
        this.sphere.clampPoint(newPos, result);
        return true;
    }

    /**
     * 获取到sphere中心的距离
     */
    distanceToCenter(point: Vec3): number {
        return this.sphere.distanceToCenter(point);
    }

    /**
     * 更新约束
     */
    update(center: Vec3, radius: number): void {
        this.sphere.center.copy(center);
        this.sphere.radius = radius;
    }
}

