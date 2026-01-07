import { Vec3, BoundingBox } from 'playcanvas';
import { BoundingSphere } from '../core/bounding-sphere';

const tmpDir = new Vec3();

/**
 * 简单的Sphere约束
 * Orbit和Fly模式共享同一个约束
 */
export class SphereConstraint {
    sphere: BoundingSphere;
    /**
     * 回弹边距：相机会被“推回”到 (radius - reboundMargin) 的范围内
     * 目的：避免贴着边界时因为浮点误差/切向移动导致反复超界，从而出现卡死或抖动
     */
    reboundMargin: number;
    /**
     * 回弹阻尼系数（越接近 1 越“软”，回弹越慢；越小越“硬”，回弹越快）
     * 建议范围：0.90 ~ 0.99
     */
    reboundDamping: number;

    constructor(
        center: Vec3 = new Vec3(),
        radius: number = 1,
        reboundMargin: number = 0,
        reboundDamping: number = 0.95
    ) {
        this.sphere = new BoundingSphere(center, radius);
        this.reboundMargin = reboundMargin;
        this.reboundDamping = reboundDamping;
    }

    /**
     * 从BoundingBox创建约束
     */
    static fromBoundingBox(bbox: BoundingBox, shrinkFactor: number = 0.7): SphereConstraint {
        const center = bbox.center.clone();
        const radius = bbox.halfExtents.length() * shrinkFactor;
        // 默认给一个很小的“软边界”缓冲带：半径的 1%
        const reboundMargin = Math.max(0.05, radius * 0.01);
        return new SphereConstraint(center, radius, reboundMargin, 0.95);
    }

    private effectiveRadius(): number {
        // 保证有效半径为正
        return Math.max(1e-6, this.sphere.radius - this.reboundMargin);
    }

    private clampToRadius(point: Vec3, radius: number, result: Vec3): boolean {
        const center = this.sphere.center;
        tmpDir.sub2(point, center);
        const len = tmpDir.length();
        if (len <= radius) {
            result.copy(point);
            return false;
        }
        if (len < 1e-6) {
            result.copy(center).add(Vec3.UP.mulScalar(radius));
            return true;
        }
        tmpDir.mulScalar(radius / len);
        result.copy(center).add(tmpDir);
        return true;
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
     * 硬边界 clamp：保证点一定在 radius 内
     * @returns 是否发生了 clamp
     */
    clampToHard(point: Vec3, result: Vec3): boolean {
        return this.clampToRadius(point, this.sphere.radius, result);
    }

    /**
     * 软边界 clamp：将点限制在 (radius - reboundMargin) 内
     * @returns 是否发生了 clamp
     */
    clampToSoft(point: Vec3, result: Vec3): boolean {
        return this.clampToRadius(point, this.effectiveRadius(), result);
    }

    /**
     * 检查移动是否被允许（新位置是否在约束范围内）
     * 新策略（回弹机制）：
     * - 在“有效半径”（radius - reboundMargin）内自由移动
     * - 超出有效半径时，将位置沿半径方向回弹到有效半径上（保留方向/切向变化）
     *
     * 这样可以在临近边界时仍允许左右/切向移动，不会因为反复超界而卡死；
     * 同时也避免继续往外推导致相机跑出约束范围。
     */
    checkMovement(currentPos: Vec3, newPos: Vec3, result: Vec3): boolean {
        // 兼容旧调用：这里做“立即软边界 clamp”
        // 真正的 damping 回弹在控制器层根据 deltaTime 实现
        this.clampToSoft(newPos, result);
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

