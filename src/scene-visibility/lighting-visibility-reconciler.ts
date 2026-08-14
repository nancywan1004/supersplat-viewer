/**
 * Lighting 显隐 Reconciler：把 Projection 幂等投影到运行态。不写 settings。
 */
import { ensureNightMode } from '../settings-serialize/settings-serialize-helper';
import type { ExperienceSettings } from '../schemas/v2';
import type { Global } from '../types';
import type { LightingVisibilityProjection } from './lighting-visibility-resolver';
import { resolveLightingVisibilityFromGlobal } from './lighting-visibility-resolver';
import { isOneShotRevealPlayingExclusiveGsplat } from '../vfx/effects-runtime/effects-pipeline-policy';

type EntityLike = {
    name?: string;
    enabled?: boolean;
    children?: EntityLike[];
    light?: { enabled?: boolean };
    __lightConfig?: { id?: string; enabled?: boolean; type?: string };
};

function projectionKey(projection: LightingVisibilityProjection): string {
    return JSON.stringify(projection);
}

function setContainerEnabled(global: Global, name: string, on: boolean): void {
    const entity = global.app?.root?.findByName?.(name) as EntityLike | null | undefined;
    if (entity && typeof entity.enabled === 'boolean') {
        entity.enabled = on;
    }
}

function applyUserLightEntities(global: Global, lights: Record<string, boolean>, rootOn: boolean): void {
    const walk = (containerName: string, prefix: string) => {
        const container = global.app?.root?.findByName?.(containerName) as EntityLike | null | undefined;
        if (!container?.children) {
            return;
        }
        for (const node of container.children) {
            const name = typeof node.name === 'string' ? node.name : '';
            if (!name.startsWith(prefix) || name.endsWith('_visual')) {
                continue;
            }
            const id = typeof node.__lightConfig?.id === 'string' ? node.__lightConfig.id : name;
            const on = rootOn && lights[id] === true;
            node.enabled = on;
            if (node.light && typeof node.light.enabled === 'boolean') {
                node.light.enabled = on;
            }
        }
    };
    walk('pointLights', 'pointLight_');
    walk('spotLights', 'spotLight_');
}

function applyBrightness(global: Global, brightnessEffective: boolean): void {
    // 一次性开场（growth-wave 等）独占 gsplatModifyVS；forceReapply 会 removeShaders / exit，把特效冲掉
    if (isOneShotRevealPlayingExclusiveGsplat(global.state)) {
        return;
    }
    if (global.state?.editMode === true) {
        const nm = ensureNightMode(global.settings as ExperienceSettings);
        const raw = typeof nm.fade === 'number' ? nm.fade : 0;
        const v = Math.max(-1, Math.min(1, raw));
        (global.app as { fire: (name: string, value?: unknown) => void }).fire('nightMode:forceReapply', v);
        return;
    }
    if (!brightnessEffective) {
        (global.app as { fire: (name: string, value?: unknown) => void }).fire('nightMode:forceReapply', 0);
        return;
    }
    const nm = ensureNightMode(global.settings as ExperienceSettings);
    const raw = typeof nm.fade === 'number' ? nm.fade : 0;
    const v = Math.max(-1, Math.min(1, raw));
    (global.app as { fire: (name: string, value?: unknown) => void }).fire('nightMode:forceReapply', v);
}

/**
 * 将 Projection 套到点光/聚光根节点、LightComponent、亮度与后处理门控。
 * 不写 `settings`。相同 Projection 且非 force 时跳过。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {object} [opts] - 选项
 * @param {boolean} [opts.force] - 忽略 equality，强制套用
 * @param {boolean} [opts.runtimeGateOpen] - 显式 gate
 * @param {boolean} [opts.skipPostEffect] - 同一次 flush 的后续 pass 不再 fire postEffect（避免重建循环）
 * @returns {LightingVisibilityProjection} 本次套用的投影
 */
export function reconcileLightingVisibility(
    global: Global,
    opts?: { force?: boolean; runtimeGateOpen?: boolean; skipPostEffect?: boolean }
): LightingVisibilityProjection {
    const projection = resolveLightingVisibilityFromGlobal(global, {
        runtimeGateOpen: opts?.runtimeGateOpen
    });
    const g = global as Global & { __lightingVisibilityProjectionKey?: string };
    const key = projectionKey(projection);
    if (!opts?.force && g.__lightingVisibilityProjectionKey === key) {
        return projection;
    }
    g.__lightingVisibilityProjectionKey = key;

    const rootOn = projection.lightRootEffective;
    setContainerEnabled(global, 'pointLights', rootOn);
    setContainerEnabled(global, 'spotLights', rootOn);
    applyUserLightEntities(global, projection.lights, rootOn);

    applyBrightness(global, projection.brightnessEffective);
    if (!opts?.skipPostEffect) {
        const gBloom = global as Global & { __lightingVisibilityBloomEffective?: boolean };
        if (gBloom.__lightingVisibilityBloomEffective !== projection.bloomEffective) {
            gBloom.__lightingVisibilityBloomEffective = projection.bloomEffective;
            global.events?.fire?.('postEffect:changed');
        }
    }
    const app = global.app as { renderNextFrame?: boolean } | undefined;
    if (app) {
        app.renderNextFrame = true;
    }
    return projection;
}
