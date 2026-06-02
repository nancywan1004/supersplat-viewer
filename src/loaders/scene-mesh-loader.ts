import type { AppBase, Entity } from 'playcanvas';

import { MeshCollision } from '../collision/mesh-collision';

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
        return ext === 'glb';
    } catch {
        return url.toLowerCase().endsWith('.glb');
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

export function loadSceneMesh(app: AppBase, url: string): Promise<SceneMeshLoadResult | null> {
    const baseUrl =
        typeof location !== 'undefined' && location?.href ? new URL(url, location.href).href : url;

    return new Promise((resolve) => {
        (app.assets as { loadFromUrl: Function }).loadFromUrl(
            baseUrl,
            'container',
            (err: Error | null, asset: {
                resource?: {
                    renders?: unknown[];
                    instantiateRenderEntity?: (opts: {
                        castShadows: boolean;
                        receiveShadows: boolean;
                    }) => Entity;
                };
            } | null) => {
                if (err || !asset?.resource?.instantiateRenderEntity) {
                    console.warn('[SceneMesh] load failed:', url, err);
                    resolve(null);
                    return;
                }
                try {
                    const renders = asset.resource.renders ?? [];
                    const meshCollision = MeshCollision.fromContainerRenders(renders);
                    const sceneMeshEntity = asset.resource.instantiateRenderEntity({
                        castShadows: false,
                        receiveShadows: true
                    });
                    resolve({ sceneMeshEntity, meshCollision });
                } catch (loadErr) {
                    console.warn('[SceneMesh] parse failed:', url, loadErr);
                    resolve(null);
                }
            }
        );
    });
}
