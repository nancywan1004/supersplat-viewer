import type { AppBase, Entity } from 'playcanvas';

import { MeshCollision } from '../../collision/mesh-collision';
import { loadContainerAsset } from './container-loader';

export type SceneMeshLoadResult = {
    sceneMeshEntity: Entity;
    meshCollision: MeshCollision;
};

export function isSceneMeshGlbUrl(url: string): boolean {
    try {
        const ext = new URL(url, typeof location !== 'undefined' ? location.href : undefined).pathname
            .split('.')
            .pop()
            ?.toLowerCase();
        // The local collision service exposes GLB through a REST endpoint whose
        // path ends in `/glb` rather than a `.glb` filename.
        const pathname = new URL(url, typeof location !== 'undefined' ? location.href : undefined).pathname;
        return ext === 'glb' || pathname.endsWith('/glb');
    } catch {
        const normalized = url.toLowerCase();
        return normalized.endsWith('.glb') || normalized.includes('/glb');
    }
}

/** 从 collision URL 解析 scene mesh（GLB）地址；非 GLB（如 voxel 包）返回 undefined。 */
export function sceneMeshUrl(collisionUrl?: string): string | undefined {
    const collision = typeof collisionUrl === 'string' ? collisionUrl.trim() : '';
    if (collision && isSceneMeshGlbUrl(collision)) {
        return collision;
    }
    return undefined;
}

export async function loadSceneMesh(app: AppBase, url: string): Promise<SceneMeshLoadResult | null> {
    try {
        const asset = await loadContainerAsset(app, url);
        const resource = asset.resource as {
            renders?: unknown[];
            instantiateRenderEntity?: (opts: {
                castShadows: boolean;
                receiveShadows: boolean;
            }) => Entity;
        } | null;

        if (!resource?.instantiateRenderEntity) {
            console.warn('[SceneMesh] load failed: missing container resource', url);
            return null;
        }

        const renders = resource.renders ?? [];
        const meshCollision = MeshCollision.fromContainerRenders(renders);
        const sceneMeshEntity = resource.instantiateRenderEntity({
            castShadows: false,
            receiveShadows: true
        });
        return { sceneMeshEntity, meshCollision };
    } catch (loadErr) {
        console.warn('[SceneMesh] load failed:', url, loadErr);
        return null;
    }
}
