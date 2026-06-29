import {
    GSPLAT_RENDERER_COMPUTE,
    GSPLAT_RENDERER_RASTER_CPU_SORT,
    GSPLAT_RENDERER_RASTER_GPU_SORT,
    platform,
} from 'playcanvas';

import type { Global } from '../../../types';
import { resolveLodUpdateDistance } from './scene-profile';

/**
 * 将 viewer Global（config / state / device）同步到 PlayCanvas `scene.gsplat` 运行时字段。
 * 供 octree 加载路径在 frame:ready 等时机写入 renderer、budget、LOD 参数。
 */

/** PlayCanvas scene.gsplat 运行时字段（类型定义未覆盖 LOD/streaming 属性） */
export type GsplatSceneRuntime = {
    renderer?: number;
    splatBudget?: number;
    colorUpdateAngle?: number;
    minContribution?: number;
    alphaClip?: number;
    antiAlias?: boolean | number;
    lodUpdateDistance?: number;
    lodUpdateAngle?: number;
    lodBehindPenalty?: number;
    radialSorting?: boolean;
    dirty?: boolean;
    debug?: number;
};

/** main 路径下 raster 模式：按实际 deviceType 选择 gsplat 排序器（compute 不走此表） */
export const RASTER_RENDERER_BY_DEVICE: Record<'webgl' | 'webgpu', number> = {
    webgl: GSPLAT_RENDERER_RASTER_CPU_SORT,
    webgpu: GSPLAT_RENDERER_RASTER_GPU_SORT
};

const SPLAT_BUDGETS = {
    mobile: { low: 1, high: 2 },
    desktop: { low: 2, high: 4 }
} as const;

/** 从 config.budget 或 performanceMode 解析 splat budget（单位：百万） */
export function getSplatBudgetMillions(global: Global): number {
    const quality = platform.mobile ? SPLAT_BUDGETS.mobile : SPLAT_BUDGETS.desktop;
    const { config, state } = global;
    if (config.budget !== undefined && Number.isFinite(config.budget) && config.budget > 0) {
        return config.budget;
    }
    return state.performanceMode ? quality.low : quality.high;
}

/** 按 config.renderer 与实际 device 写入 gsplat.renderer */
export function bindGsplatRenderer(
    gsplat: GsplatSceneRuntime,
    global: Global,
    rendererByDevice = RASTER_RENDERER_BY_DEVICE
): void {
    const { config, renderer: actualRenderer } = global;
    if (config.renderer === 'compute') {
        gsplat.renderer = GSPLAT_RENDERER_COMPUTE;
    } else if (config.renderer === 'gpu-sort') {
        gsplat.renderer = GSPLAT_RENDERER_RASTER_GPU_SORT;
    } else if (config.renderer === 'cpu-sort') {
        gsplat.renderer = GSPLAT_RENDERER_RASTER_CPU_SORT;
    } else if (actualRenderer === 'webgpu') {
        gsplat.renderer = rendererByDevice.webgpu;
    } else {
        gsplat.renderer = rendererByDevice.webgl;
    }
}

/**
 * Octree streaming 全局 LOD 节流（对齐 PlayCanvas Billions 示例）。
 * refinement burst 期间会临时覆盖 lodUpdateDistance。
 */
export function bindGsplatStreamingLodSettings(gsplat: GsplatSceneRuntime, global: Global): void {
    gsplat.lodUpdateDistance = resolveLodUpdateDistance(global);
    gsplat.lodUpdateAngle = 90;
    gsplat.lodBehindPenalty = 5;
    gsplat.radialSorting = true;
}

/** 写入 budget 与 performanceMode 相关渲染参数（lodRange 由 per-entity component 负责） */
export function bindGsplatPerfSettings(gsplat: GsplatSceneRuntime, global: Global): void {
    const { config, state } = global;
    gsplat.splatBudget = getSplatBudgetMillions(global) * 1_000_000;
    gsplat.colorUpdateAngle = state.performanceMode ? 4 : 2;
    gsplat.minContribution = 1;
    gsplat.alphaClip = 1 / 255;
    gsplat.antiAlias = config.aa;
}

/** config 请求 compute 但引擎实际未启用时打 warn（已回退到其他 renderer） */
export function warnOnComputeRendererFallback(global: Global): void {
    const { app, config, renderer: actualRenderer } = global;
    if (
        config.renderer === 'compute' &&
        (app.scene.gsplat as { currentRenderer?: number }).currentRenderer !== GSPLAT_RENDERER_COMPUTE
    ) {
        console.warn('[GSplat] compute renderer requested but unavailable; falling back to engine renderer:', {
            requested: config.renderer,
            actualDevice: actualRenderer,
            currentRenderer: (app.scene.gsplat as { currentRenderer?: number }).currentRenderer
        });
    }
}
