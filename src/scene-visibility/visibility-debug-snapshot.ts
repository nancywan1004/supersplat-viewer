/**
 * 只读显隐诊断快照。不写 settings / viewSettings，不发外部事件，不作为业务真源。
 */
import type { Global } from '../types';
import {
    isLightingSessionAspectVisible,
    readContentCategoryVisible,
    readLightingVisibility,
    readViewBloomLocalLightsEnabled,
    readViewTorchActive
} from '../view-settings';
import {
    collectLightingVisibilityResolveInput,
    readConfiguredUserPointSpotEnabled,
    readShadowSceneMeshConfigured,
    resolveLightingVisibility,
    type LightingVisibilityProjection
} from './lighting-visibility-resolver';

function readRuntimeGateOpen(global: Global, explicit?: boolean): boolean {
    if (typeof explicit === 'boolean') {
        return explicit;
    }
    const registry = (global as {
        __sceneContentVisibility?: { isRuntimeGateOpen?: () => boolean };
    }).__sceneContentVisibility;
    return registry?.isRuntimeGateOpen?.() !== false;
}

export type VisibilityDebugSnapshot = {
    revision: number;
    reason: string;
    mode: 'viewer' | 'edit';
    runtimeGateOpen: boolean;
    intents: {
        lightsCategory: boolean;
        brightness: boolean;
        bloom: boolean;
        shadow: boolean;
        localLightsEnabled: boolean;
        torchActive: boolean;
    };
    capability: {
        shadowSceneMeshConfigured: boolean;
    };
    configuredLightEnabled: Record<string, boolean>;
    /** 各配置灯的会话 overlay（相对大类展开：开时缺省 true，关时缺省 false） */
    sessionLightVisible: Record<string, boolean>;
    effective: {
        brightness: boolean;
        bloom: boolean;
        shadow: boolean;
    };
    projection: LightingVisibilityProjection;
    actual: {
        pointRootEnabled: boolean | null;
        spotRootEnabled: boolean | null;
        lightComponents: Record<string, boolean>;
        torchActive: boolean;
    };
};

type EntityLike = {
    name?: string;
    enabled?: boolean;
    children?: EntityLike[];
    light?: { enabled?: boolean };
    __lightConfig?: { id?: string; enabled?: boolean; type?: string };
};

function expandSessionLightVisible(
    configured: Record<string, boolean>,
    overlay: Record<string, boolean>,
    lightsVisible: boolean
): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    for (const id of Object.keys(configured)) {
        out[id] = lightsVisible ? overlay[id] !== false : overlay[id] === true;
    }
    return out;
}

function readRootEnabled(global: Global, name: string): boolean | null {
    const entity = global.app?.root?.findByName?.(name) as EntityLike | null | undefined;
    if (!entity || typeof entity.enabled !== 'boolean') {
        return null;
    }
    return entity.enabled;
}

function collectLightComponentEnabled(container: EntityLike | null | undefined, prefix: string): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    if (!container?.children) {
        return out;
    }
    for (const node of container.children) {
        const name = typeof node.name === 'string' ? node.name : '';
        if (!name.startsWith(prefix) || name.endsWith('_visual')) {
            continue;
        }
        const cfg = node.__lightConfig;
        const id = typeof cfg?.id === 'string' ? cfg.id : name;
        const componentOn = node.light && typeof node.light.enabled === 'boolean' ?
            node.light.enabled :
            node.enabled !== false;
        out[id] = componentOn;
    }
    return out;
}

/**
 * 采集只读显隐诊断快照。不写 settings / viewSettings，不发外部事件。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {object} [opts] - 诊断元数据
 * @param {string} [opts.reason] - 调用原因
 * @param {number} [opts.revision] - 快照序号
 * @param {boolean} [opts.runtimeGateOpen] - 显式传入的 runtime gate
 * @returns {VisibilityDebugSnapshot} 当前 intent / 配置 / 运行态
 */
export function captureVisibilityDebugSnapshot(
    global: Global,
    opts?: { reason?: string; revision?: number; runtimeGateOpen?: boolean }
): VisibilityDebugSnapshot {
    const input = collectLightingVisibilityResolveInput(global, {
        runtimeGateOpen: opts?.runtimeGateOpen
    });
    const projection = resolveLightingVisibility(input);
    const configuredLightEnabled = readConfiguredUserPointSpotEnabled(global);
    const pointRoot = global.app?.root?.findByName?.('pointLights') as EntityLike | null | undefined;
    const spotRoot = global.app?.root?.findByName?.('spotLights') as EntityLike | null | undefined;

    return {
        revision: opts?.revision ?? 0,
        reason: opts?.reason ?? 'manual',
        mode: global.state?.editMode === true ? 'edit' : 'viewer',
        runtimeGateOpen: readRuntimeGateOpen(global, opts?.runtimeGateOpen),
        intents: {
            lightsCategory: readContentCategoryVisible(global, 'lights'),
            brightness: readLightingVisibility(global, 'brightness'),
            bloom: readLightingVisibility(global, 'bloom'),
            shadow: readLightingVisibility(global, 'shadow'),
            localLightsEnabled: readViewBloomLocalLightsEnabled(global),
            torchActive: readViewTorchActive(global)
        },
        capability: {
            shadowSceneMeshConfigured: readShadowSceneMeshConfigured(global)
        },
        configuredLightEnabled,
        sessionLightVisible: expandSessionLightVisible(
            configuredLightEnabled,
            input.sessionLightVisible,
            input.lightsVisible
        ),
        effective: {
            brightness: isLightingSessionAspectVisible(global, 'brightness'),
            bloom: isLightingSessionAspectVisible(global, 'bloom'),
            shadow: isLightingSessionAspectVisible(global, 'shadow')
        },
        projection,
        actual: {
            pointRootEnabled: readRootEnabled(global, 'pointLights'),
            spotRootEnabled: readRootEnabled(global, 'spotLights'),
            lightComponents: {
                ...collectLightComponentEnabled(pointRoot, 'pointLight_'),
                ...collectLightComponentEnabled(spotRoot, 'spotLight_')
            },
            torchActive: readViewTorchActive(global)
        }
    };
}
