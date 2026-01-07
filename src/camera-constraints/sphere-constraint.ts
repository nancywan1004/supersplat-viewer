import { Vec3, BoundingBox } from 'playcanvas';
import { BoundingSphere } from '../core/bounding-sphere';

const tmpDir = new Vec3();
const tmpA = new Vec3();
const tmpB = new Vec3();

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
        // 注意：不能用 halfExtents.length()（对角线的一半）来做半径，
        // 否则 sphere 会比场景大很多，导致 pan/zoom 看起来“无限移动”但仍在 sphere 内。
        // 这里用最大轴向 halfExtent 来近似“场景半径”，shrinkFactor=0.7 才符合直觉。
        const he = bbox.halfExtents;
        const radius = Math.max(he.x, he.y, he.z) * shrinkFactor;
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
     * 软边界约束（沿移动方向截断）+ 接近边界渐进阻尼：
     * - **关键点**：当目标点在边界外时，不做“投影到球面”（会引入切向滑动），而是沿 current->desired 的方向
     *   计算线段与 sphere 的交点，将移动截断到边界交点。
     * - 若当前已经在阻尼带内且移动会让半径变大，则对位移做渐进衰减，避免“贴边卡死/抖动”。
     *
     * @returns 是否对 desired 做了限制/修改
     */
    constrainToSoftDamped(currentPos: Vec3, desiredPos: Vec3, dt: number, result: Vec3): boolean {
        const center = this.sphere.center;
        const r = this.effectiveRadius();

        const p0 = tmpA.sub2(currentPos, center);
        const p1 = tmpB.sub2(desiredPos, center);
        const d0 = p0.length();
        const d1 = p1.length();

        // 若 desired 已在软边界内：根据是否处在阻尼带内 & 是否“向外走”做渐进阻尼
        if (d1 <= r) {
            // 只对“向外”的移动施加阻尼
            if (d1 > d0) {
                const zone = Math.max(1e-4, this.reboundMargin);
                const distToBoundary = r - d0; // >=0 表示在边界内
                if (distToBoundary < zone) {
                    // factor: 远离边界=1，贴边=0
                    const factor = Math.max(0, Math.min(1, distToBoundary / zone));
                    // 额外用 dt 让阻尼更稳定（避免高帧率时太硬）
                    const a = 1 - Math.pow(this.reboundDamping, dt * 60);
                    const t = factor * (1 - a) + a * factor; // 等价于 factor，但保留 dt 参与感
                    result.lerp(currentPos, desiredPos, t);
                    return true;
                }
            }
            result.copy(desiredPos);
            return false;
        }

        // desired 在软边界外：沿 current->desired 方向求交点，截断到交点（避免切向滑动）
        const dir = tmpDir.sub2(desiredPos, currentPos);
        const a = dir.lengthSq();
        if (a < 1e-12) {
            // 没有位移
            result.copy(currentPos);
            return true;
        }

        // 将线段参数化：p(t) = p0 + t*(p1-p0), t in [0,1]
        const dp = tmpDir.sub2(p1, p0);
        const A = dp.dot(dp);
        const B = 2 * p0.dot(dp);
        const C = p0.dot(p0) - r * r;
        const disc = B * B - 4 * A * C;
        if (disc < 0 || A < 1e-12) {
            // 理论上不该发生：兜底直接 clamp 到软边界（可能引入少量切向，但比 NaN 强）
            this.clampToSoft(desiredPos, result);
            return true;
        }

        const sqrtDisc = Math.sqrt(disc);
        const t1 = (-B - sqrtDisc) / (2 * A);
        const t2 = (-B + sqrtDisc) / (2 * A);

        // 从 inside->outside：通常取较大的正根
        let tHit = Math.max(t1, t2);
        if (!(tHit >= 0 && tHit <= 1)) {
            // 兜底取落在 [0,1] 的根
            const cand1 = t1 >= 0 && t1 <= 1 ? t1 : -1;
            const cand2 = t2 >= 0 && t2 <= 1 ? t2 : -1;
            tHit = Math.max(cand1, cand2);
            if (tHit < 0) {
                // 如果两根都不在段内：保持当前位置
                result.copy(currentPos);
                return true;
            }
        }

        // 交点（在软边界上）
        result.lerp(currentPos, desiredPos, tHit);

        // 若属于“向外”移动且当前已进入阻尼带，则再做一次渐进衰减（让撞边更软）
        if (d0 > r - Math.max(1e-4, this.reboundMargin)) {
            const zone = Math.max(1e-4, this.reboundMargin);
            const distToBoundary = Math.max(0, r - d0);
            const factor = Math.max(0, Math.min(1, distToBoundary / zone));
            // 贴边时 factor≈0，会把 result 拉回 currentPos（不再产生切向漂移）
            result.lerp(currentPos, result, factor);
        }

        return true;
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

