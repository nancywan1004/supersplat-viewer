import { BoundingBox, Vec3 } from 'playcanvas';

/**
 * 盒状约束：用于限制 Orbit/Fly 的 target/focus point 在有效 BoundingBox 内
 */
export class BoxConstraint {
    bbox: BoundingBox;
    /**
     * 数值容差/内缩距离：用于避免点恰好落在边界或因浮点误差被判定为“在盒外”，导致卡死
     */
    epsilon: number;

    constructor(bbox: BoundingBox) {
        // clone 避免外部修改
        this.bbox = new BoundingBox(bbox.center.clone(), bbox.halfExtents.clone());
        // 根据场景尺度给一个自适应 epsilon；同时设置下限，保证小场景也有效
        const size = this.bbox.halfExtents.length() * 2;
        this.epsilon = Math.max(1e-4, size * 1e-6);
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
        // 使用带容差的 contains，避免贴边时抖动/误判
        const min = this.bbox.getMin();
        const max = this.bbox.getMax();
        const e = this.epsilon;
        return (
            point.x >= min.x - e && point.x <= max.x + e &&
            point.y >= min.y - e && point.y <= max.y + e &&
            point.z >= min.z - e && point.z <= max.z + e
        );
    }

    /**
     * 将点 clamp 到 bbox 内
     * @returns 是否发生了 clamp
     */
    clampPoint(point: Vec3, result: Vec3): boolean {
        const min = this.bbox.getMin();
        const max = this.bbox.getMax();

        // 夹紧到“内缩后的盒子”：[min+e, max-e]，避免结果精确贴边导致下一帧误判在外
        const e = this.epsilon;
        const minX = (max.x - min.x > 2 * e) ? (min.x + e) : min.x;
        const maxX = (max.x - min.x > 2 * e) ? (max.x - e) : max.x;
        const minY = (max.y - min.y > 2 * e) ? (min.y + e) : min.y;
        const maxY = (max.y - min.y > 2 * e) ? (max.y - e) : max.y;
        const minZ = (max.z - min.z > 2 * e) ? (min.z + e) : min.z;
        const maxZ = (max.z - min.z > 2 * e) ? (max.z - e) : max.z;

        const x = Math.min(maxX, Math.max(minX, point.x));
        const y = Math.min(maxY, Math.max(minY, point.y));
        const z = Math.min(maxZ, Math.max(minZ, point.z));

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
        const currentIn = this.containsPoint(current);
        const desiredIn = this.containsPoint(desired);

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
        const e = this.epsilon;

        // slab method：求 current + t*(desired-current) 与 AABB 的交点，t ∈ [0,1]
        const dx = desired.x - current.x;
        const dy = desired.y - current.y;
        const dz = desired.z - current.z;

        let tMin = 0;
        let tMax = 1;

        const updateAxis = (p: number, d: number, minA: number, maxA: number) => {
            if (Math.abs(d) < 1e-12) {
                // 平行该轴：必须在区间内，否则无解（理论上 currentIn 保证）
                return p >= minA - e && p <= maxA + e;
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
        // 将交点内缩，避免精确贴边导致下一帧 “currentIn=false” 进而卡死
        this.clampPoint(result, result);
        return true;
    }
}


