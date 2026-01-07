import { Vec3 } from 'playcanvas';

// 临时向量，避免在 projectToSurface 中重复创建
const tmpDirection = new Vec3();

/**
 * 简单的Bounding Sphere实现
 */
export class BoundingSphere {
    center: Vec3;
    radius: number;

    constructor(center: Vec3 = new Vec3(), radius: number = 1) {
        this.center = center.clone();
        this.radius = radius;
    }

    /**
     * 检查点是否在sphere内
     */
    containsPoint(point: Vec3): boolean {
        return point.distance(this.center) <= this.radius;
    }

    /**
     * 计算点到中心的距离
     */
    distanceToCenter(point: Vec3): number {
        return point.distance(this.center);
    }

    /**
     * 将点投影到sphere表面
     */
    projectToSurface(point: Vec3, result: Vec3): void {
        // 使用临时向量计算方向，避免修改 result
        tmpDirection.sub2(point, this.center);
        const distance = tmpDirection.length();
        
        if (distance < 1e-6) {
            // 点在中心，投影到任意方向
            result.copy(this.center).add(Vec3.UP.mulScalar(this.radius));
        } else {
            // 归一化并缩放到radius
            tmpDirection.normalize().mulScalar(this.radius);
            result.copy(this.center).add(tmpDirection);
        }
    }

    /**
     * 将点限制在sphere内（如果超出则投影到表面）
     */
    clampPoint(point: Vec3, result: Vec3): void {
        const distance = this.distanceToCenter(point);
        if (distance > this.radius) {
            this.projectToSurface(point, result);
        } else {
            result.copy(point);
        }
    }
}
