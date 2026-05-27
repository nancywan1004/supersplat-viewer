import type { AppBase } from 'playcanvas';
import type { Entity } from 'playcanvas';

/**
 * 加载接影用 GLB，返回带 render 层级的根实体（与 Physics_Relighting_Demo 一致：接影为 mesh）。
 * 使用 PlayCanvas ContainerResource.instantiateRenderEntity。
 */
export function loadSplatMesh(app: AppBase, url: string): Promise<Entity> {
    const baseUrl = typeof location !== 'undefined' && location?.href ? new URL(url, location.href).href : url;
    return new Promise((resolve, reject) => {
        (app.assets as any).loadFromUrl(baseUrl, 'container', (err: Error | null, asset: any) => {
            if (err) {
                reject(err);
                return;
            }
            if (!asset?.resource?.instantiateRenderEntity) {
                reject(new Error('splatMesh: container has no instantiateRenderEntity'));
                return;
            }
            // 接影 GLB：initShadowCatcher → ShadowMat 会再设 receiveShadows=true；此处仅作加载默认值。
            const entity = asset.resource.instantiateRenderEntity({
                castShadows: false,
                receiveShadows: true
            });
            console.log('splatMesh loaded', entity);
            resolve(entity);
        });
    });
}
