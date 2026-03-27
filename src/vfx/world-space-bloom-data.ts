import { Vec3 } from 'playcanvas';

/**
 * Represents a single bloom point in world space
 */
export interface BloomPoint {
    position: Vec3;      // World coordinate
    radius: number;      // Influence radius in world space units
    intensity: number;   // Bloom intensity [0, 1]
}

/**
 * Manages world-space bloom marker points.
 *
 * ── 角色定位（配合 LocalLightRegion 多区域架构）──
 *
 * - 本类只代表「单个局部亮灯区域」的工作区（当前正在编辑的 LocalLightRegion 或其 draft-* 草稿）：
 *   - points：当前未提交的笔刷轨迹；
 *   - committed：当前区域已提交的点集；
 *   - committedBrightness：当前区域的局部亮度 -1～1。
 *
 * - 多区域场景下：
 *   - 所有 LocalLightRegion 的持久化 worldSpace/brightness 均由 settings.postEffectSettings.bloom.localLightRegions 持有；
 *   - BloomController 在需要时将「某一个区域」加载到 WorldSpaceBloomData（loadRegion），
 *     或把当前 WorldSpaceBloomData 导出回单个 LocalLightRegion（exportRegion）；
 *   - WorldSpaceBloomData 不保存「所有区域的汇总」，也不直接关心 activeLocalLightRegionId，
 *     只专注于当前区域的数据读写与擦除操作。
 *
 * - 擦除语义：
 *   - eraseAt() 同时作用于当前区域的绘制点 points 与已提交点 committed，表示「只对当前区域做局部修剪」；
 *   - 哪个区域被擦除、何时写回 settings 由上层 BloomController/UI 决定，
 *     保证「擦除只影响当前区域」这一交互原则。
 *
 * - 配置语义：
 *   - legacy 的 bloom.worldSpacePoints 已下线；本类只处理当前区域的 worldSpace 数据对象。
 *
 * Stores bloom points in 3D world coordinates and provides spatial queries.
 */
export class WorldSpaceBloomData {
    private points: BloomPoint[] = [];
    private committed: BloomPoint[] = [];  // "Set bloom" committed points
    /** 已提交区域对应的局部亮度 -1～1，与 committed 一起持久化；Set 时写入并用于 bake 到顶点 */
    private committedBrightness: number = 0;
    /** 当前是否处于「橡皮擦」模式，仅由上层控制；本类只提供擦除 API */
    // eraseMode 不参与序列化，仅影响运行时行为
    private eraseMode: boolean = false;

    /**
     * Add a new bloom point
     * @param position World coordinate
     * @param radius Influence radius in world space units
     * @param intensity Bloom intensity [0, 1]
     */
    addPoint(position: Vec3, radius: number, intensity: number): void {
        this.points.push({
            position: position.clone(),
            radius,
            intensity
        });
    }

    /**
     * Clear current drawing points only (does not affect committed points).
     * "Clear mask" in UI: remove only uncommitted strokes.
     */
    clear(): void {
        this.points = [];
    }

    /**
     * Reset: clear all bloom points (current + committed).
     * "Reset mask" in UI: remove everything including previously committed regions.
     */
    reset(): void {
        this.points = [];
        this.committed = [];
        this.committedBrightness = 0;
    }

    /**
     * 设置是否为橡皮擦模式。
     * 橡皮擦模式本身不改变数据，仅用于上层决定是 add 还是 erase。
     */
    setEraseMode(on: boolean): void {
        this.eraseMode = on;
    }

    /**
     * 在给定世界坐标半径内执行局部擦除。
     * - 默认会同时作用于「当前绘制点」与「已提交点」；
     * - 这样可以通过橡皮擦对既有亮度区域做局部修剪。
     */
    eraseAt(position: Vec3, radius: number): void {
        if (radius <= 0) return;
        const r2 = radius * radius;
        const shouldKeep = (p: BloomPoint) => {
            const dx = p.position.x - position.x;
            const dy = p.position.y - position.y;
            const dz = p.position.z - position.z;
            const dist2 = dx * dx + dy * dy + dz * dz;
            return dist2 > r2;
        };
        this.points = this.points.filter(shouldKeep);
        this.committed = this.committed.filter(shouldKeep);
    }

    getCommittedBrightness(): number {
        return this.committedBrightness;
    }

    setCommittedBrightness(b: number): void {
        this.committedBrightness = Math.max(-1, Math.min(1, b));
    }

    /**
     * Commit current points to persistent state
     */
    commit(): void {
        // Move all current points to committed
        this.committed.push(...this.points);
        this.points = [];
    }

    /**
     * Get all valid points (current + committed)
     */
    getAllPoints(): BloomPoint[] {
        return [...this.committed, ...this.points];
    }

    /**
     * Get committed points only (for persisted brightness regions).
     */
    getCommittedPoints(): BloomPoint[] {
        return [...this.committed];
    }

    /**
     * Check if a world position is within any bloom region.
     * This check is purely based on world-space distance — it does NOT consider
     * visibility or occlusion. An occluded bloom point still affects splats
     * within its radius (Requirement 7.3). This is by design: bloom regions
     * are anchored to 3D world coordinates and influence all splats in range
     * regardless of the camera's viewing direction.
     * @param worldPos World coordinate to test
     * @returns true if position is within influence radius of any bloom point
     */
    isInBloomRegion(worldPos: Vec3): boolean {
        const allPoints = this.getAllPoints();
        for (const point of allPoints) {
            const distance = worldPos.distance(point.position);
            if (distance < point.radius) {
                return true;
            }
        }
        return false;
    }

    /**
     * Serialize to JSON
     */
    toJSON(): object {
        return {
            points: this.points.map(p => ({
                position: [p.position.x, p.position.y, p.position.z],
                radius: p.radius,
                intensity: p.intensity
            })),
            committed: this.committed.map(p => ({
                position: [p.position.x, p.position.y, p.position.z],
                radius: p.radius,
                intensity: p.intensity
            })),
            committedBrightness: this.committedBrightness
        };
    }

    /**
     * Deserialize from JSON
     * @param data JSON object containing bloom data
     */
    fromJSON(data: any): void {
        try {
            this.points = [];
            this.committed = [];

            if (data.points && Array.isArray(data.points)) {
                for (const p of data.points) {
                    if (p.position && Array.isArray(p.position) && p.position.length === 3) {
                        this.points.push({
                            position: new Vec3(p.position[0], p.position[1], p.position[2]),
                            radius: p.radius ?? 1.0,
                            intensity: p.intensity ?? 1.0
                        });
                    }
                }
            }

            if (data.committed && Array.isArray(data.committed)) {
                for (const p of data.committed) {
                    if (p.position && Array.isArray(p.position) && p.position.length === 3) {
                        this.committed.push({
                            position: new Vec3(p.position[0], p.position[1], p.position[2]),
                            radius: p.radius ?? 1.0,
                            intensity: p.intensity ?? 1.0
                        });
                    }
                }
            }
            if (typeof data.committedBrightness === 'number') {
                this.committedBrightness = Math.max(-1, Math.min(1, data.committedBrightness));
            }
        } catch (error) {
            console.warn('WorldSpaceBloomData.fromJSON: Failed to parse data, using defaults', error);
            this.points = [];
            this.committed = [];
        }
    }
}
