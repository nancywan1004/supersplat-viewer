import { BoundingBox, Vec3 } from 'playcanvas';

/**
 * 盒状约束：用于限制 Orbit/Fly 的 target/focus point 在有效 BoundingBox 内
 */
export class BoxConstraint {
    bbox: BoundingBox;

    constructor(bbox: BoundingBox) {
        // clone 避免外部修改
        this.bbox = new BoundingBox(bbox.center.clone(), bbox.halfExtents.clone());
    }

    /**
     * 从原始 bbox 创建一个“收缩”的有效 bbox，用于限制 target 活动范围
     * shrinkFactor: 0~1，越小范围越小（例如 0.7 表示各轴 halfExtents 乘 0.7）
     */
    static fromBoundingBox(bbox: BoundingBox, shrinkFactor: number = 0.7): BoxConstraint {
        const center = bbox.center.clone();
        const half = bbox.halfExtents.clone().mulScalar(shrinkFactor);
        return new BoxConstraint(new BoundingBox(center, half));
    }

    containsPoint(point: Vec3): boolean {
        return this.bbox.containsPoint(point);
    }

    /**
     * 将点 clamp 到 bbox 内
     * @returns 是否发生了 clamp
     */
    clampPoint(point: Vec3, result: Vec3): boolean {
        const min = this.bbox.getMin();
        const max = this.bbox.getMax();

        const x = Math.min(max.x, Math.max(min.x, point.x));
        const y = Math.min(max.y, Math.max(min.y, point.y));
        const z = Math.min(max.z, Math.max(min.z, point.z));

        const changed = (x !== point.x) || (y !== point.y) || (z !== point.z);
        result.set(x, y, z);
        return changed;
    }

    /**
     * 将从 current->desired 的移动约束在 bbox 内：
     * - desired 在盒内：直接通过
     * - desired 在盒外且 current 在盒内：返回线段与 AABB 的交点（停在边界上，不引入切向滑动）
     * - current 若在盒外：直接 clamp current（兜底）
     *
     * @returns 是否发生了限制/修改
     */
    constrainSegment(current: Vec3, desired: Vec3, result: Vec3): boolean {
        const currentIn = this.bbox.containsPoint(current);
        const desiredIn = this.bbox.containsPoint(desired);

        if (desiredIn) {
            result.copy(desired);
            return false;
        }

        if (!currentIn) {
            // 兜底：当前点都在外面，先拉回盒内
            this.clampPoint(current, result);
            return true;
        }

        const min = this.bbox.getMin();
        const max = this.bbox.getMax();

        // slab method：求 current + t*(desired-current) 与 AABB 的交点，t ∈ [0,1]
        const dx = desired.x - current.x;
        const dy = desired.y - current.y;
        const dz = desired.z - current.z;

        let tMin = 0;
        let tMax = 1;

        const updateAxis = (p: number, d: number, minA: number, maxA: number) => {
            if (Math.abs(d) < 1e-12) {
                // 平行该轴：必须在区间内，否则无解（理论上 currentIn 保证）
                return p >= minA && p <= maxA;
            }
            const inv = 1 / d;
            let t1 = (minA - p) * inv;
            let t2 = (maxA - p) * inv;
            if (t1 > t2) {
                const tmp = t1; t1 = t2; t2 = tmp;
            }
            tMin = Math.max(tMin, t1);
            tMax = Math.min(tMax, t2);
            return tMin <= tMax;
        };

        const ok =
            updateAxis(current.x, dx, min.x, max.x) &&
            updateAxis(current.y, dy, min.y, max.y) &&
            updateAxis(current.z, dz, min.z, max.z);

        if (!ok) {
            // 兜底：无交点就停在 current
            result.copy(current);
            return true;
        }

        // 对 currentIn && desiredOut 的情况：
        // tMin 通常 <= 0（进入盒子），tMax ∈ [0,1]（离开盒子）
        const tHit = Math.max(0, Math.min(1, tMax));
        result.set(
            current.x + dx * tHit,
            current.y + dy * tHit,
            current.z + dz * tHit
        );
        return true;
    }
}


