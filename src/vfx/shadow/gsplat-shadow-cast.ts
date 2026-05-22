import type { Entity, GSplatComponent } from 'playcanvas';
import type { Global } from '../../types';

/** 阴影系统是否启用：仅由 URL `?splatMesh=` 决定（`shadow.enabled` 已废弃，存盘字段可保留但不会被读取）。 */
export function isShadowSystemEnabled(global: Pick<Global, 'config'>): boolean {
    const url = typeof global.config.splatMeshUrl === 'string' ? global.config.splatMeshUrl.trim() : '';
    return url.length > 0;
}

export function applyGsplatCastShadows(gsplat: GSplatComponent | null | undefined, enabled: boolean): void {
    if (gsplat) {
        gsplat.castShadows = enabled;
    }
}

/**
 * 主场景与放置高斯须保持相同的 castShadows，否则 PlayCanvas unified 会为「仅投射阴影」的 placement
 * 单独创建 gsplatManagerShadow，在开启阴影时触发前向颜色异常（蓝绿花屏）。
 */
export function syncGsplatShadowCastingFromSettings(global: Global, mainGsplatEntity?: Entity | null): void {
    const enabled = isShadowSystemEnabled(global);
    const main = mainGsplatEntity ?? (global.app.root.findByName('gsplat') as Entity | null);
    applyGsplatCastShadows(main?.gsplat, enabled);

    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (entry.assetType !== 'gaussian' || !entry.entity?.gsplat) continue;
        applyGsplatCastShadows(entry.entity.gsplat, enabled);
    }
}
