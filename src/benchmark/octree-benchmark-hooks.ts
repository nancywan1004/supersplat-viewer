import type { OctreeLike } from '../loaders/gsplat/lod/octree/refinement-controller';

export type OctreeRefCountDiagnostics = {
    available: boolean;
    negative: number;
    min: number | null;
    max: number | null;
};

let lodOctree: OctreeLike | null = null;

/** benchmark / acceptance 专用：同步当前 LOD octree 引用，供预热与 refcount 诊断 */
export function setOctreeBenchmarkLod(octree: OctreeLike | null | undefined): void {
    lodOctree = octree ?? null;
}

export function getOctreeBenchmarkLod(): OctreeLike | null {
    return lodOctree;
}

export function readOctreeRefCountDiagnostics(octree: OctreeLike | null = lodOctree): OctreeRefCountDiagnostics {
    const counts = (octree as { fileRefCounts?: Int32Array } | null)?.fileRefCounts;
    if (!counts?.length) {
        return { available: false, negative: 0, min: null, max: null };
    }
    let negative = 0;
    let min = counts[0];
    let max = counts[0];
    for (let i = 0; i < counts.length; i++) {
        const v = counts[i];
        if (v < 0) {
            negative++;
        }
        if (v < min) {
            min = v;
        }
        if (v > max) {
            max = v;
        }
    }
    return { available: true, negative, min, max };
}

/** 选出尚未 loaded 的 file 下标，供验收轮询预热 */
export function selectOrphanOctreeFileIndices(targetCount: number): number[] {
    const octree = lodOctree;
    if (!octree?.files?.length) {
        return [];
    }
    const indices: number[] = [];
    for (let fi = octree.files.length - 1; fi >= 0 && indices.length < targetCount; fi--) {
        if (octree.getFileResource(fi)) {
            continue;
        }
        indices.push(fi);
    }
    return indices;
}

export function tickPrewarmOrphanOctreeFiles(indices: number[]): number {
    const octree = lodOctree;
    const loader = octree?.assetLoader;
    if (!octree || !loader) {
        return 0;
    }
    // v5 未迁 idle-freeze；预热时尽力清 gate，字段用可选写避免强依赖
    const loaderAny = loader as {
        __refinementIdleFreeze?: boolean;
        __refinementGateActive?: boolean;
        __refinementPriorityUrls?: unknown;
        _processQueue?: () => void;
    };
    const octreeAny = octree as OctreeLike & {
        __refinementIdleFreeze?: boolean;
        __refinementPriorityUrls?: unknown;
    };
    loaderAny.__refinementIdleFreeze = false;
    octreeAny.__refinementIdleFreeze = false;
    loaderAny.__refinementGateActive = false;
    loaderAny.__refinementPriorityUrls = undefined;
    octreeAny.__refinementPriorityUrls = undefined;
    const ensure =
        octree.__originalEnsureFileResource?.bind(octree) ?? octree.ensureFileResource?.bind(octree);
    for (let i = 0; i < indices.length; i++) {
        if (!octree.getFileResource(indices[i])) {
            ensure?.(indices[i]);
        }
    }
    loader._processQueue?.();
    return indices.filter((fi) => !!octree.getFileResource(fi)).length;
}
