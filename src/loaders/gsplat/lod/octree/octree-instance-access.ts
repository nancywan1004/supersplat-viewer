import type { AppBase, Entity } from 'playcanvas';

export type OctreeInstanceLike = {
    octree: unknown;
    nodeInfos: Array<{ currentLod: number; optimalLod: number }>;
    filePlacements?: Array<{ resource?: unknown } | null>;
    needsLodUpdate?: boolean;
    update?: () => boolean;
    consumePlacementSetChanged?: () => boolean;
};

type OctreeInstancesMap = Map<unknown, OctreeInstanceLike>;

export type GsplatWorldLike = {
    requestOctreePlacementUpdate?: () => void;
    invalidate?: (opts?: { worldState?: boolean; workBuffer?: boolean }) => void;
    _octreeInstances?: OctreeInstancesMap;
    _layerPlacementsDirty?: boolean;
    _placementSetChanged?: boolean;
    _worldStateDirty?: boolean;
    _lodUpdateRequested?: boolean;
    _octreePlacementUpdateRequested?: boolean;
    _framesTillFullUpdate?: number;
};

type GsplatManagerLike = {
    world?: GsplatWorldLike;
};

type GsplatDirectorLike = {
    camerasMap: Map<unknown, {
        layersMap: Map<unknown, {
            gsplatManager?: GsplatManagerLike | null;
        }>;
    }>;
};

function getOctreeInstancesMap(manager: GsplatManagerLike | null | undefined): OctreeInstancesMap | null {
    return manager?.world?._octreeInstances ?? null;
}

function getGsplatDirector(app: AppBase): GsplatDirectorLike | null {
    return (app.renderer as unknown as { gsplatDirector?: GsplatDirectorLike }).gsplatDirector ?? null;
}

function worldOwnsOctree(world: GsplatWorldLike | undefined, octree: unknown): boolean {
    const instances = world?._octreeInstances;
    if (!instances) {
        return false;
    }
    for (const inst of instances.values()) {
        if (inst.octree === octree) {
            return true;
        }
    }
    return false;
}

/** PlayCanvas 2.20：octree 实例挂在 gsplatManager.world._octreeInstances */
export function findAllOctreeInstances(
    app: AppBase,
    octree: unknown,
    gsplatEntity?: Entity
): OctreeInstanceLike[] {
    const found: OctreeInstanceLike[] = [];
    const seen = new Set<OctreeInstanceLike>();

    const addInstance = (inst: OctreeInstanceLike | undefined | null) => {
        if (!inst || inst.octree !== octree || seen.has(inst)) {
            return;
        }
        seen.add(inst);
        found.push(inst);
    };

    const director = getGsplatDirector(app);
    if (director) {
        for (const cameraData of director.camerasMap.values()) {
            for (const layerData of cameraData.layersMap.values()) {
                const instances = getOctreeInstancesMap(layerData.gsplatManager ?? undefined);
                if (!instances) {
                    continue;
                }
                for (const inst of instances.values()) {
                    addInstance(inst);
                }
            }
        }
    }

    if (!found.length && gsplatEntity && director) {
        const placement = (gsplatEntity.gsplat as unknown as { _placement?: unknown } | null)?._placement;
        if (placement) {
            for (const cameraData of director.camerasMap.values()) {
                for (const layerData of cameraData.layersMap.values()) {
                    const instances = getOctreeInstancesMap(layerData.gsplatManager ?? undefined);
                    addInstance(instances?.get(placement));
                }
            }
        }
    }

    return found;
}

export function findOctreeInstanceForEntity(
    app: AppBase,
    octree: unknown,
    gsplatEntity: Entity
): OctreeInstanceLike | null {
    const instances = findAllOctreeInstances(app, octree, gsplatEntity);
    return instances[0] ?? null;
}

/** 收集拥有给定 octree 的 GSplatWorld（去重） */
export function findGsplatWorldsForOctree(app: AppBase, octree: unknown): GsplatWorldLike[] {
    const worlds: GsplatWorldLike[] = [];
    const seen = new Set<GsplatWorldLike>();
    const director = getGsplatDirector(app);
    if (!director) {
        return worlds;
    }
    for (const cameraData of director.camerasMap.values()) {
        for (const layerData of cameraData.layersMap.values()) {
            const world = layerData.gsplatManager?.world;
            if (!world || seen.has(world) || !worldOwnsOctree(world, octree)) {
                continue;
            }
            seen.add(world);
            worlds.push(world);
        }
    }
    return worlds;
}

/**
 * Fallback：无引擎 API 时同步轮询 instance，只 invalidate WorldState（不碰 workBuffer rebuild）。
 * 不置 needsLodUpdate / 不拉满 updateLod（否则会退化成全树换档）。
 */
function requestOctreePlacementUpdateFallback(world: GsplatWorldLike): void {
    const instances = world._octreeInstances;
    if (!instances) {
        return;
    }
    let anyDirty = false;
    for (const [, inst] of instances) {
        const dirty = inst.update?.() === true;
        if (dirty) {
            world._layerPlacementsDirty = true;
            anyDirty = true;
        }
        if (inst.consumePlacementSetChanged?.()) {
            world._placementSetChanged = true;
            anyDirty = true;
        }
    }
    if (anyDirty || world._layerPlacementsDirty || world._placementSetChanged) {
        if (typeof world.invalidate === 'function') {
            world.invalidate({ worldState: true });
        } else {
            world._worldStateDirty = true;
        }
    }
}

/**
 * 增量 WorldState invalidation 入口：请求 world 下一拍立即轮询 octree instance。
 * 语义：placement dirty → WorldState → needsUploadIds → 增量 bake；不强制 Work Buffer 全量 rebuild。
 */
export function requestOctreePlacementUpdate(app: AppBase, octree: unknown): number {
    const worlds = findGsplatWorldsForOctree(app, octree);
    for (let i = 0; i < worlds.length; i++) {
        const world = worlds[i];
        if (typeof world.requestOctreePlacementUpdate === 'function') {
            world.requestOctreePlacementUpdate();
        } else {
            requestOctreePlacementUpdateFallback(world);
        }
    }
    return worlds.length;
}
