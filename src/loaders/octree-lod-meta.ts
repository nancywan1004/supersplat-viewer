type OctreeLodEntry = {
    fileIndex: number;
    count?: number;
};

type OctreeNodeLike = {
    lods: OctreeLodEntry[];
};

type OctreeBootstrapHost = {
    lodLevels: number;
    nodes: OctreeNodeLike[];
};

/** streaming bootstrap 阶段只显示最粗档 */
export function getOctreeBootstrapLod(octree: OctreeBootstrapHost): number {
    return Math.max(0, octree.lodLevels - 1);
}

/** 粗档无有效 file/count 的 leaf 不参与 bootstrap 上屏统计 */
export function isOctreeBootstrapPlaceableNode(node: OctreeNodeLike, bootstrapLod: number): boolean {
    const lod = node.lods[bootstrapLod];
    return !!lod && lod.fileIndex >= 0 && (lod.count ?? 0) > 0;
}
