import type { AppBase, Entity } from 'playcanvas';

import { MeshCollision } from '../collision/mesh-collision';

export type SceneMeshLoadResult = {
    meshEntity: Entity;
    meshCollision: MeshCollision;
};

export function isGlbUrl(url: string): boolean {
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

/** GLB 型 `?collision=`：同时用于物理碰撞与阴影接影。 */
export function resolveSceneMeshUrl(collisionUrl?: string): string | undefined {
    const collision = typeof collisionUrl === 'string' ? collisionUrl.trim() : '';
    if (collision && isGlbUrl(collision)) {
        return collision;
    }
    return undefined;
}

/**
 * 单次加载 GLB：同时产出接影 Entity 与 MeshCollision（同一 container，一次网络请求）。
 */
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
                    const meshEntity = asset.resource.instantiateRenderEntity({
                        castShadows: false,
                        receiveShadows: true
                    });
                    resolve({ meshEntity, meshCollision });
                } catch (loadErr) {
                    console.warn('[SceneMesh] parse failed:', url, loadErr);
                    resolve(null);
                }
            }
        );
    });
}
