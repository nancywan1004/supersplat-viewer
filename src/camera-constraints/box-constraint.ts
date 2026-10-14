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
     * 从原始 bbox 创建一个"收缩"的有效 bbox，用于限制 target 活动范围
     * scaleFactor: 建议 >0；<1 表示收缩，>1 表示放大（例如 1.2 表示各轴 halfExtents 乘 1.2）
     */
    static fromBoundingBox(bbox: BoundingBox, scaleFactor: number = 0.7): BoxConstraint {
        const center = bbox.center.clone();
        const half = bbox.halfExtents.clone().mulScalar(scaleFactor);
        return new BoxConstraint(new BoundingBox(center, half));
    }

    /**
     * 从原始 bbox 创建一个"收缩"的有效 bbox，支持分别设置左右和上下的缩放系数
     * scaleX: X 轴方向的缩放系数，可以是单个数值（左右相同）或数组 [left, right]
     * scaleY: Y 轴方向的缩放系数，可以是单个数值（上下相同）或数组 [top, bottom]
     * scaleZ: Z 轴方向的缩放系数，可以是单个数值（两侧相同）或数组 [负 Z, 正 Z]（对应 min.z / max.z 方向）
     * scaleFactor: 默认缩放系数，当某个轴未指定时使用
     */
    static fromBoundingBoxWithAsymmetricScales(
        bbox: BoundingBox,
        scaleFactor: number = 0.7,
        scaleX?: number | [number, number],
        scaleY?: number | [number, number],
        scaleZ?: number | [number, number]
    ): BoxConstraint {
        const min = bbox.getMin();
        const max = bbox.getMax();
        const center = bbox.center.clone();
        const halfExtents = bbox.halfExtents.clone();

        // 处理 X 轴缩放（左右）
        let newMinX: number, newMaxX: number;
        if (scaleX === undefined) {
            // 使用默认缩放
            const scale = scaleFactor;
            const halfX = halfExtents.x * scale;
            newMinX = center.x - halfX;
            newMaxX = center.x + halfX;
        } else if (typeof scaleX === 'number') {
            // 单个数值，左右相同
            const halfX = halfExtents.x * scaleX;
            newMinX = center.x - halfX;
            newMaxX = center.x + halfX;
        } else {
            // 数组 [left, right]
            const [leftScale, rightScale] = scaleX;
            newMinX = center.x - halfExtents.x * leftScale;
            newMaxX = center.x + halfExtents.x * rightScale;
        }

        // 处理 Y 轴缩放（上下）
        // 注意：Y 轴向上为正，所以 max.y 是上面，min.y 是下面
        let newMinY: number, newMaxY: number;
        if (scaleY === undefined) {
            // 使用默认缩放
            const scale = scaleFactor;
            const halfY = halfExtents.y * scale;
            newMinY = center.y - halfY;
            newMaxY = center.y + halfY;
        } else if (typeof scaleY === 'number') {
            // 单个数值，上下相同
            const halfY = halfExtents.y * scaleY;
            newMinY = center.y - halfY;
            newMaxY = center.y + halfY;
        } else {
            // 数组 [top, bottom]，第一个值是上面（max.y），第二个值是下面（min.y）
            const [topScale, bottomScale] = scaleY;
            newMaxY = center.y + halfExtents.y * topScale;  // 上面
            newMinY = center.y - halfExtents.y * bottomScale; // 下面
        }

        // 处理 Z 轴缩放（与 X 相同：数组为 [min.z 侧, max.z 侧]）
        let newMinZ: number, newMaxZ: number;
        if (scaleZ === undefined) {
            const scale = scaleFactor;
            const halfZ = halfExtents.z * scale;
            newMinZ = center.z - halfZ;
            newMaxZ = center.z + halfZ;
        } else if (typeof scaleZ === 'number') {
            const halfZ = halfExtents.z * scaleZ;
            newMinZ = center.z - halfZ;
            newMaxZ = center.z + halfZ;
        } else {
            const [negZScale, posZScale] = scaleZ;
            newMinZ = center.z - halfExtents.z * negZScale;
            newMaxZ = center.z + halfExtents.z * posZScale;
        }

        // 构建新的 bounding box
        const newMin = new Vec3(newMinX, newMinY, newMinZ);
        const newMax = new Vec3(newMaxX, newMaxY, newMaxZ);
        const newCenter = newMin.clone().add(newMax).mulScalar(0.5);
        const newHalf = newMax.clone().sub(newMin).mulScalar(0.5);

        return new BoxConstraint(new BoundingBox(newCenter, newHalf));
    }

    /**
     * `fromBoundingBoxWithAsymmetricScales` 的反解：
     * 给定基准盒 `base` 与目标盒 `target`，求让缩放后的盒等于 `target` 的各轴系数。
     *
     * 轴序与正向一致：`scaleX = [left, right]`、`scaleY = [top, bottom]`、`scaleZ = [negZ, posZ]`。
     * 注意：结果对基准盒尺寸高度敏感（系数可能正负相近形成相消），写入 settings 后基准盒一变即失效。
     * @param base - 基准盒（`BoxConstraint` 实际使用、未乘 animScale 的那个盒）
     * @param target - 目标盒（希望缩放后的盒与之重合）
     * @returns 各轴系数 `{ scaleX, scaleY, scaleZ }`
     */
    static solveAsymmetricScales(
        base: BoundingBox,
        target: BoundingBox
    ): { scaleX: [number, number]; scaleY: [number, number]; scaleZ: [number, number] } {
        const c = base.center;
        const h = base.halfExtents;
        const tMin = target.getMin().clone();
        const tMax = target.getMax().clone();
        // 基准盒退化（half=0）时给一个极小值，避免除零得到 Infinity/NaN
        const safe = (v: number) => (Math.abs(v) < 1e-12 ? 1e-12 : v);
        const hx = safe(h.x);
        const hy = safe(h.y);
        const hz = safe(h.z);
        return {
            scaleX: [(c.x - tMin.x) / hx, (tMax.x - c.x) / hx],
            scaleY: [(tMax.y - c.y) / hy, (c.y - tMin.y) / hy],
            scaleZ: [(c.z - tMin.z) / hz, (tMax.z - c.z) / hz]
        };
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


