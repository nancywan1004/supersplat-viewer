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
    /** Phase 0：会话实例 overlay 尚未独立；Viewer TOGGLE 仍写 settings，故与 configured 同形 */
    sessionLightVisible: Record<string, boolean> | null;
    effective: {
        brightness: boolean;
        bloom: boolean;
        shadow: boolean;
    };
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

function trimUrl(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 与 `hasConfiguredShadowSceneMesh` 同语义：已有 GLB collision URL。避免 snapshot 测试拉 Universe/OSS。
 *
 * @param {Global} global - Viewer 全局对象
 * @returns {boolean} 是否已配置 sceneMesh GLB
 */
function shadowSceneMeshConfigured(global: Global): boolean {
    const url = trimUrl(global.config?.collisionUrl) ||
        trimUrl((global.settings as { collision?: { url?: string } } | undefined)?.collision?.url);
    return url.toLowerCase().endsWith('.glb');
}

function isUserPointOrSpotConfig(cfg: { id?: string; type?: string } | null | undefined): boolean {
    if (!cfg || typeof cfg.id !== 'string') {
        return false;
    }
    return cfg.type === 'point' || cfg.type === 'spot' || cfg.type === undefined;
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

function readConfiguredLightEnabled(global: Global): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    const configs = global.settings?.lighting?.lights;
    if (!Array.isArray(configs)) {
        return out;
    }
    for (const cfg of configs) {
        const row = cfg as { id?: string; type?: string; enabled?: boolean };
        if (!isUserPointOrSpotConfig(row) || typeof row.id !== 'string') {
            continue;
        }
        out[row.id] = row.enabled !== false;
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
    const configuredLightEnabled = readConfiguredLightEnabled(global);
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
            shadowSceneMeshConfigured: shadowSceneMeshConfigured(global)
        },
        configuredLightEnabled,
        sessionLightVisible: null,
        effective: {
            brightness: isLightingSessionAspectVisible(global, 'brightness'),
            bloom: isLightingSessionAspectVisible(global, 'bloom'),
            shadow: isLightingSessionAspectVisible(global, 'shadow')
        },
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
