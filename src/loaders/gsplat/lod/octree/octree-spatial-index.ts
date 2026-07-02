import { Frustum, Mat4 } from 'playcanvas';

const BVH_LEAF_SIZE = 8;
const BVH_MAX_DEPTH = 32;
/** 小于该 leaf 数时 BVH 构建/遍历开销不值得 */
export const OCTREE_SPATIAL_INDEX_MIN_LEAVES = 64;

type BvhNode = {
    minX: number;
    minY: number;
    minZ: number;
    maxX: number;
    maxY: number;
    maxZ: number;
    left: number;
    right: number;
    /** leaf bucket：indices 数组中的起始下标 */
    leafStart: number;
    /** >0 表示叶桶；0 表示 internal */
    leafCount: number;
};

export type OctreeLeafVisitOptions = {
    /** 0 表示不限制；>0 时按 PQ 顺序评估至多 N 个 leaf */
    maxLeafEvaluations?: number;
};

function aabbIntersectsFrustum(
    frustum: Frustum,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number
): boolean {
    for (let p = 0; p < 6; p++) {
        const plane = frustum.planes[p];
        const nx = plane.normal.x;
        const ny = plane.normal.y;
        const nz = plane.normal.z;
        const d = plane.distance;
        const px = nx >= 0 ? maxX : minX;
        const py = ny >= 0 ? maxY : minY;
        const pz = nz >= 0 ? maxZ : minZ;
        if (nx * px + ny * py + nz * pz + d <= 0) {
            return false;
        }
    }
    return true;
}

const _worldMin = { x: 0, y: 0, z: 0 };
const _worldMax = { x: 0, y: 0, z: 0 };
const _scratchMin = { x: 0, y: 0, z: 0 };
const _scratchMax = { x: 0, y: 0, z: 0 };

function localBoundsToWorld(
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    worldTransform: Mat4,
    outMin: { x: number; y: number; z: number },
    outMax: { x: number; y: number; z: number }
): void {
    _scratchMin.x = minX;
    _scratchMin.y = minY;
    _scratchMin.z = minZ;
    _scratchMax.x = maxX;
    _scratchMax.y = maxY;
    _scratchMax.z = maxZ;
    worldTransform.transformPoint(_scratchMin, _worldMin);
    worldTransform.transformPoint(_scratchMax, _worldMax);
    outMin.x = Math.min(_worldMin.x, _worldMax.x);
    outMin.y = Math.min(_worldMin.y, _worldMax.y);
    outMin.z = Math.min(_worldMin.z, _worldMax.z);
    outMax.x = Math.max(_worldMin.x, _worldMax.x);
    outMax.y = Math.max(_worldMin.y, _worldMax.y);
    outMax.z = Math.max(_worldMin.z, _worldMax.z);
}

class MaxHeap {
    private readonly heap: { nodeIndex: number; priority: number }[] = [];

    get length(): number {
        return this.heap.length;
    }

    push(nodeIndex: number, priority: number): void {
        const entry = { nodeIndex, priority };
        this.heap.push(entry);
        this.siftUp(this.heap.length - 1);
    }

    pop(): { nodeIndex: number; priority: number } | null {
        const n = this.heap.length;
        if (n === 0) {
            return null;
        }
        const top = this.heap[0];
        const last = this.heap.pop()!;
        if (n > 1) {
            this.heap[0] = last;
            this.siftDown(0);
        }
        return top;
    }

    private siftUp(i: number): void {
        const heap = this.heap;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p].priority >= heap[i].priority) {
                break;
            }
            const t = heap[p];
            heap[p] = heap[i];
            heap[i] = t;
            i = p;
        }
    }

    private siftDown(i: number): void {
        const heap = this.heap;
        const n = heap.length;
        while (true) {
            let largest = i;
            const l = (i << 1) + 1;
            const r = l + 1;
            if (l < n && heap[l].priority > heap[largest].priority) {
                largest = l;
            }
            if (r < n && heap[r].priority > heap[largest].priority) {
                largest = r;
            }
            if (largest === i) {
                break;
            }
            const t = heap[largest];
            heap[largest] = heap[i];
            heap[i] = t;
            i = largest;
        }
    }
}

/**
 * 由 PlayCanvas 压平后的 leaf bounds 构建 BVH（引擎会丢弃 meta.tree）。
 * 遍历：PQ 下降 + 视锥剪枝，只评估可见子树中的 leaf。
 */
export class OctreeLeafSpatialIndex {
    readonly leafCount: number;

    private readonly boundsFlat: Float32Array;
    private readonly nodes: BvhNode[];
    private readonly indices: Int32Array;
    private readonly root: number;

    private constructor(
        boundsFlat: Float32Array,
        leafCount: number,
        nodes: BvhNode[],
        indices: Int32Array,
        root: number
    ) {
        this.boundsFlat = boundsFlat;
        this.leafCount = leafCount;
        this.nodes = nodes;
        this.indices = indices;
        this.root = root;
    }

    static build(boundsFlat: Float32Array, leafCount: number): OctreeLeafSpatialIndex | null {
        if (leafCount < OCTREE_SPATIAL_INDEX_MIN_LEAVES) {
            return null;
        }
        const indices = new Int32Array(leafCount);
        for (let i = 0; i < leafCount; i++) {
            indices[i] = i;
        }
        const nodes: BvhNode[] = [];
        const root = buildBvhNode(boundsFlat, indices, 0, leafCount, 0, nodes);
        if (root < 0) {
            return null;
        }
        return new OctreeLeafSpatialIndex(boundsFlat, leafCount, nodes, indices, root);
    }

    /**
     * Spark 式 PQ 遍历：按节点距相机近似优先级展开，视锥外子树直接跳过。
     * visitor 返回 false 时提前停止。
     */
    visitFrustumLeaves(
        frustum: Frustum,
        worldTransform: Mat4,
        worldCameraPos: { x: number; y: number; z: number },
        visitor: (leafIndex: number) => boolean | void,
        options?: OctreeLeafVisitOptions
    ): number {
        const maxLeaves = options?.maxLeafEvaluations ?? 0;
        const heap = new MaxHeap();
        const wMin = { x: 0, y: 0, z: 0 };
        const wMax = { x: 0, y: 0, z: 0 };
        heap.push(this.root, Number.POSITIVE_INFINITY);

        let evaluated = 0;
        while (heap.length > 0) {
            const entry = heap.pop();
            if (!entry) {
                break;
            }
            const node = this.nodes[entry.nodeIndex];
            localBoundsToWorld(
                node.minX,
                node.minY,
                node.minZ,
                node.maxX,
                node.maxY,
                node.maxZ,
                worldTransform,
                wMin,
                wMax
            );
            if (!aabbIntersectsFrustum(frustum, wMin.x, wMin.y, wMin.z, wMax.x, wMax.y, wMax.z)) {
                continue;
            }

            if (node.leafCount > 0) {
                for (let i = 0; i < node.leafCount; i++) {
                    const leafIndex = this.indices[node.leafStart + i];
                    const keepGoing = visitor(leafIndex);
                    evaluated++;
                    if (keepGoing === false) {
                        return evaluated;
                    }
                    if (maxLeaves > 0 && evaluated >= maxLeaves) {
                        return evaluated;
                    }
                }
                continue;
            }

            const cx = (wMin.x + wMax.x) * 0.5;
            const cy = (wMin.y + wMax.y) * 0.5;
            const cz = (wMin.z + wMax.z) * 0.5;
            const dx = cx - worldCameraPos.x;
            const dy = cy - worldCameraPos.y;
            const dz = cz - worldCameraPos.z;
            const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
            const childPriority = 1 / (1 + dist * 0.02);

            if (node.left >= 0) {
                heap.push(node.left, childPriority);
            }
            if (node.right >= 0) {
                heap.push(node.right, childPriority);
            }
        }
        return evaluated;
    }
}

function buildBvhNode(
    boundsFlat: Float32Array,
    indices: Int32Array,
    start: number,
    end: number,
    depth: number,
    nodes: BvhNode[]
): number {
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;

    for (let i = start; i < end; i++) {
        const leafIndex = indices[i];
        const b = leafIndex * 6;
        const lx = boundsFlat[b];
        const ly = boundsFlat[b + 1];
        const lz = boundsFlat[b + 2];
        const hx = boundsFlat[b + 3];
        const hy = boundsFlat[b + 4];
        const hz = boundsFlat[b + 5];
        if (lx < minX) minX = lx;
        if (ly < minY) minY = ly;
        if (lz < minZ) minZ = lz;
        if (hx > maxX) maxX = hx;
        if (hy > maxY) maxY = hy;
        if (hz > maxZ) maxZ = hz;
    }

    const nodeIndex = nodes.length;
    nodes.push({
        minX,
        minY,
        minZ,
        maxX,
        maxY,
        maxZ,
        left: -1,
        right: -1,
        leafStart: start,
        leafCount: 0
    });

    const count = end - start;
    if (count <= BVH_LEAF_SIZE || depth >= BVH_MAX_DEPTH) {
        nodes[nodeIndex].leafCount = count;
        return nodeIndex;
    }

    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    let axis = 0;
    if (extentY > extentX && extentY >= extentZ) {
        axis = 1;
    } else if (extentZ > extentX && extentZ > extentY) {
        axis = 2;
    }

    const mid = start + (count >> 1);
    const slice = indices.subarray(start, end);
    const axisOffset = axis;
    slice.sort((a, b) => {
        const ca = (boundsFlat[a * 6 + axisOffset] + boundsFlat[a * 6 + 3 + axisOffset]) * 0.5;
        const cb = (boundsFlat[b * 6 + axisOffset] + boundsFlat[b * 6 + 3 + axisOffset]) * 0.5;
        return ca - cb;
    });

    const left = buildBvhNode(boundsFlat, indices, start, mid, depth + 1, nodes);
    const right = buildBvhNode(boundsFlat, indices, mid, end, depth + 1, nodes);
    nodes[nodeIndex].left = left;
    nodes[nodeIndex].right = right;
    nodes[nodeIndex].leafStart = -1;
    return nodeIndex;
}

export function ensureOctreeLeafSpatialIndex(octree: {
    nodes: unknown[];
    nodeBoundsMinMax: Float32Array;
    __leafSpatialIndex?: OctreeLeafSpatialIndex | null;
}): OctreeLeafSpatialIndex | null {
    if (octree.__leafSpatialIndex !== undefined) {
        return octree.__leafSpatialIndex;
    }
    const leafCount = octree.nodes.length;
    const index = OctreeLeafSpatialIndex.build(octree.nodeBoundsMinMax, leafCount);
    octree.__leafSpatialIndex = index;
    return index;
}
