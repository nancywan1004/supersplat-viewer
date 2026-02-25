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
 * Stores bloom points in 3D world coordinates and provides spatial queries.
 */
export class WorldSpaceBloomData {
    private points: BloomPoint[] = [];
    private committed: BloomPoint[] = [];  // "Set bloom" committed points
    /** 已提交区域对应的局部亮度 -1～1，与 committed 一起持久化；Set 时写入并用于 bake 到顶点 */
    private committedBrightness: number = 0;

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
