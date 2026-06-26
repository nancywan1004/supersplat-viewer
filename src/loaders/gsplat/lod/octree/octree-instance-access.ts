import type { AppBase, Entity } from 'playcanvas';

export type OctreeInstanceLike = {
    octree: unknown;
    nodeInfos: Array<{ currentLod: number; optimalLod: number }>;
    filePlacements?: Array<{ resource?: unknown } | null>;
    needsLodUpdate?: boolean;
    update?: () => boolean;
};

type OctreeInstancesMap = Map<unknown, OctreeInstanceLike>;

type GsplatManagerLike = {
    world?: {
        _octreeInstances?: OctreeInstancesMap;
    };
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
