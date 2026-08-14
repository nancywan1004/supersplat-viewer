/**
 * Lighting 显隐 Resolver（Phase 1：shadow mode）。
 * 纯函数求值，不写 settings / viewSettings，不改实体，不发事件。
 */
import type { Global } from '../types';
import {
    interpretLightingContentVisibility,
    isLightingSessionAspectVisible
} from '../view-settings';

export type LightingVisibilityResolveInput = {
    editMode: boolean;
    runtimeGateOpen: boolean;
    lightsVisible: boolean;
    brightness: boolean;
    bloom: boolean;
    shadow: boolean;
    shadowCapabilityAvailable: boolean;
    configuredLightEnabled: Record<string, boolean>;
    /** 缺省跟大类：开时缺省 true，关时缺省 false；只存非默认 */
    sessionLightVisible: Record<string, boolean>;
    /** `viewSettings.bloom.localLightsEnabled`；TOGGLE_ALL 总闸，缺省 true */
    localLightsEnabled?: boolean;
};

export type LightingVisibilityProjection = {
    /** 大类勾选（上次全局扫描结果）；不覆盖 brightness/bloom/shadow/单灯的独立 intent */
    lightsEffective: boolean;
    lightRootEffective: boolean;
    brightnessEffective: boolean;
    bloomEffective: boolean;
    /** 含 shadow capability：无 sceneMesh 时为 false */
    shadowEffective: boolean;
    lights: Record<string, boolean>;
};

function sessionShows(input: LightingVisibilityResolveInput, id: string): boolean {
    if (input.editMode) {
        return true;
    }
    const overlay = input.sessionLightVisible[id];
    if (input.lightsVisible) {
        return overlay !== false;
    }
    return overlay === true;
}

function aspectEffective(input: LightingVisibilityResolveInput, intent: boolean): boolean {
    if (input.editMode) {
        return true;
    }
    return !!intent;
}

/**
 * 纯求值。相同输入得到相同 Projection。
 *
 * @param {LightingVisibilityResolveInput} input - 求值输入
 * @returns {LightingVisibilityProjection} 有效显隐投影
 */
export function resolveLightingVisibility(input: LightingVisibilityResolveInput): LightingVisibilityProjection {
    const lightsEffective = input.editMode ? true : !!input.lightsVisible;
    const masterOn = input.editMode || input.localLightsEnabled !== false;
    const brightnessEffective = aspectEffective(input, input.brightness) && masterOn;
    const bloomEffective = aspectEffective(input, input.bloom) && masterOn;
    const shadowEffective = aspectEffective(input, input.shadow) && !!input.shadowCapabilityAvailable;
    const lights: Record<string, boolean> = {};
    let anyShown = false;
    for (const id of Object.keys(input.configuredLightEnabled)) {
        const on = !!input.runtimeGateOpen
            && input.configuredLightEnabled[id] === true
            && sessionShows(input, id);
        lights[id] = on;
        if (on) {
            anyShown = true;
        }
    }
    const lightRootEffective = input.editMode
        ? !!input.runtimeGateOpen
        : !!input.runtimeGateOpen && (input.lightsVisible || anyShown);
    return {
        lightsEffective,
        lightRootEffective,
        brightnessEffective,
        bloomEffective,
        shadowEffective,
        lights
    };
}

function isUserPointOrSpotConfig(cfg: { id?: string; type?: string } | null | undefined): cfg is { id: string; type?: string } {
    if (!cfg || typeof cfg.id !== 'string' || !cfg.id) {
        return false;
    }
    return cfg.type === 'point' || cfg.type === 'spot' || cfg.type === undefined;
}

/**
 * 只读采集用户点光/聚光 `settings.enabled`。不写 settings。
 *
 * @param {Global} global - Viewer 全局对象
 * @returns {Record<string, boolean>} id → configuredEnabled
 */
export function readConfiguredUserPointSpotEnabled(global: Global): Record<string, boolean> {
    const out: Record<string, boolean> = {};
    const configs = global.settings?.lighting?.lights;
    if (!Array.isArray(configs)) {
        return out;
    }
    for (const cfg of configs) {
        const row = cfg as { id?: string; type?: string; enabled?: boolean };
        if (!isUserPointOrSpotConfig(row)) {
            continue;
        }
        out[row.id] = row.enabled !== false;
    }
    return out;
}

function trimUrl(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/**
 * 与 DebugSnapshot 同语义：已配置 GLB collision URL。不走 Universe generate。
 *
 * @param {Global} global - Viewer 全局对象
 * @returns {boolean} 是否已配置 sceneMesh GLB
 */
export function readShadowSceneMeshConfigured(global: Global): boolean {
    const url = trimUrl(global.config?.collisionUrl) ||
        trimUrl((global.settings as { collision?: { url?: string } } | undefined)?.collision?.url);
    return url.toLowerCase().endsWith('.glb');
}

function readRuntimeGateOpen(global: Global, explicit?: boolean): boolean {
    if (typeof explicit === 'boolean') {
        return explicit;
    }
    const registry = (global as {
        __sceneContentVisibility?: { isRuntimeGateOpen?: () => boolean };
    }).__sceneContentVisibility;
    return registry?.isRuntimeGateOpen?.() !== false;
}

/**
 * 从 global 采集 Resolver 输入。不调用 `ensureViewSettings`，不迁移、不写字段。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {object} [opts] - 可选 gate
 * @param {boolean} [opts.runtimeGateOpen] - 显式 runtime gate
 * @returns {LightingVisibilityResolveInput} 求值输入
 */
export function collectLightingVisibilityResolveInput(
    global: Global,
    opts?: { runtimeGateOpen?: boolean }
): LightingVisibilityResolveInput {
    const vs = global.viewSettings;
    const lights = interpretLightingContentVisibility(vs?.contentVisibility?.lights);
    return {
        editMode: global.state?.editMode === true,
        runtimeGateOpen: readRuntimeGateOpen(global, opts?.runtimeGateOpen),
        lightsVisible: lights.visible !== false,
        brightness: lights.brightness !== false,
        bloom: lights.bloom !== false,
        shadow: lights.shadow !== false,
        shadowCapabilityAvailable: readShadowSceneMeshConfigured(global),
        configuredLightEnabled: readConfiguredUserPointSpotEnabled(global),
        sessionLightVisible: lights.instances ?? {},
        localLightsEnabled: vs?.bloom?.localLightsEnabled !== false
    };
}

/**
 * `resolveLightingVisibility(global)` 入口：采集 + 纯求值。无副作用。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {object} [opts] - 可选 gate
 * @returns {LightingVisibilityProjection} 有效显隐投影
 */
export function resolveLightingVisibilityFromGlobal(
    global: Global,
    opts?: { runtimeGateOpen?: boolean }
): LightingVisibilityProjection {
    return resolveLightingVisibility(collectLightingVisibilityResolveInput(global, opts));
}

export type LightingVisibilityShadowDiff = {
    reason: string;
    diffs: string[];
    projection: LightingVisibilityProjection;
};

/**
 * 对照旧会话 effective（`isLightingSessionAspectVisible`）。
 * shadowEffective 含 capability，与旧 aspect 的差异不记为回归（无 mesh 时旧 aspect 仍可为 true）。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {LightingVisibilityProjection} projection - 新投影
 * @returns {string[]} 不一致说明
 */
export function diffLightingVisibilityAgainstLegacy(
    global: Global,
    projection: LightingVisibilityProjection
): string[] {
    const diffs: string[] = [];
    const brightness = isLightingSessionAspectVisible(global, 'brightness');
    const bloom = isLightingSessionAspectVisible(global, 'bloom');
    const shadowAspect = isLightingSessionAspectVisible(global, 'shadow');
    if (projection.brightnessEffective !== brightness) {
        diffs.push(`brightnessEffective ${projection.brightnessEffective} vs legacy ${brightness}`);
    }
    if (projection.bloomEffective !== bloom) {
        diffs.push(`bloomEffective ${projection.bloomEffective} vs legacy ${bloom}`);
    }
    const capability = readShadowSceneMeshConfigured(global);
    const expectedShadowEffective = shadowAspect && capability;
    if (projection.shadowEffective !== expectedShadowEffective) {
        diffs.push(`shadowEffective ${projection.shadowEffective} vs legacyAspect×capability ${expectedShadowEffective}`);
    }
    return diffs;
}

/**
 * 开发态对照：有差异时 `console.debug`，不改画面。
 *
 * @param {Global} global - Viewer 全局对象
 * @param {string} reason - 调用原因
 * @param {object} [opts] - 可选 gate
 * @returns {LightingVisibilityShadowDiff} 对照结果
 */
export function reportLightingVisibilityShadow(
    global: Global,
    reason: string,
    opts?: { runtimeGateOpen?: boolean }
): LightingVisibilityShadowDiff {
    const projection = resolveLightingVisibilityFromGlobal(global, opts);
    const diffs = diffLightingVisibilityAgainstLegacy(global, projection);
    if (diffs.length > 0) {
        console.debug(`[LightingVisibility:shadow] ${reason}`, diffs, projection);
    }
    return { reason, diffs, projection };
}
