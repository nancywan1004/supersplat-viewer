/**
 * 阴影子系统统一入口。
 *
 * 两层门控（均需满足才完整出阴影）：
 * 1. **Capability** `hasShadowCapability` — 场景是否配置 GLB 型 `?collision=`
 *    - 放置高斯 / mesh 的 castShadows（主场景高斯恒 false）、平行光 shadow map、接影管线
 *    - 放置 mesh：引擎 receiveShadows（A）；高斯接影叠屏（B）由 shadow-apply 处理
 * 2. **Enablement/Output** `isShadowSystemEnabled` + `isShadowOutputEnabled`
 *    - 手动开关 `settings.postEffectSettings.shadow.enabled`
 *    - `readyToRender` + 管线已 `activateOutput`（含 reveal 门控）
 *
 * 渲染实现仍分散在 shadow-catcher / shadow-apply；本文件只负责策略与生命周期。
 */
import type { BoundingBox, Entity, GSplatComponent } from 'playcanvas';

import type { ExperienceSettings } from '../../schemas/v2';
import type { Global } from '../../types';
import { setDirectionalCastShadowsEnabled, updatePointLightsFromSettings, updateShadowDistance } from '../../light';
import { readRevealParams } from '../../settings-serialize/effects-sync';
import { isRevealTimedVfxType, revealBlocksAnim } from '../effects-runtime/reveal/reveal-policy';
import { syncPlacedMeshExcludeLayers } from './shadow-apply-exclude-mask';
import { initShadowCatcher } from './shadow-catcher';
import { ShadowApplyRt } from './shadow-apply';
import {
    hasShadowCapability,
    isShadowSystemEnabled
} from './shadow-policy';

/** 主场景 unified 高斯不参与 GSPLAT_SHADOW 投射，勿与 shadow.enabled 同步。 */
const MAIN_GSPLAT_CAST_SHADOWS = false;

// ─── Capability：场景是否具备 mesh 阴影能力 ─────────────────────────────────

export function applyGsplatCastShadows(gsplat: GSplatComponent | null | undefined, enabled: boolean): void {
    if (gsplat) {
        gsplat.castShadows = enabled;
    }
}

/** 放置 mesh：投射进 shadow map（A）；引擎 receiveShadows；不参与 B 叠影（exclude mask）。 */
export function applyPlacedMeshShadowFlags(entity: Entity, shadowEnabled: boolean): void {
    const visit = (node: Entity) => {
        if (node.render) {
            node.render.castShadows = shadowEnabled;
            node.render.receiveShadows = shadowEnabled;
        }
        node.children.forEach((child) => visit(child as Entity));
    };
    visit(entity);
}

/**
 * 主场景高斯 castShadows 恒 false；放置高斯随 shadow.enabled 投射（unified 花屏风险需实测）。
 * 放置 mesh：cast + receiveShadows（A），shadow-apply 通过 exclude mask 排除 B。
 * 放置高斯：可 cast；B 叠影在自身屏幕区域由 exclude mask 排除。
 * 放置 image / video：与 mesh 相同，exclude 层 + 白模 mask，避免 B 横切叠影。
 */
export function syncGsplatShadowCastingFromSettings(global: Global, mainGsplatEntity?: Entity | null): void {
    const enabled = isShadowSystemEnabled(global);
    const shadowFlagsEnabled = enabled && !isShadowPipelineSuspended(global);
    const main = mainGsplatEntity ?? (global.app.root.findByName('gsplat') as Entity | null);
    applyGsplatCastShadows(main?.gsplat, MAIN_GSPLAT_CAST_SHADOWS);

    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!entry.entity) continue;
        if (entry.assetType === 'gaussian' && entry.entity.gsplat) {
            applyGsplatCastShadows(entry.entity.gsplat, shadowFlagsEnabled);
        } else if (entry.assetType === 'mesh') {
            applyPlacedMeshShadowFlags(entry.entity, shadowFlagsEnabled);
        }
    }
    syncPlacedMeshExcludeLayers(global);
}

// ─── Pipeline：接影挂载、reveal 门控与输出时序 ─────────────────────────────

export type ShadowPipelineMount = {
    sceneBound: BoundingBox;
    gsplatEntity: Entity;
    meshEntity?: Entity | null;
};

type ShadowPipelineRuntime = {
    apply: ShadowApplyRt | null;
    /** 允许接影叠屏与接影 mesh 参与本帧（仍须 `readyToRender`） */
    outputEnabled: boolean;
    /** 高斯资产加载 / 初次稳定渲染期间暂停 shadow 输出与 placed gaussian caster。 */
    suspendCount: number;
    /** 暂停前是否有激活的 shadow output，释放最后一个暂停锁时用于恢复。 */
    restoreOutputAfterSuspend: boolean;
};

const runtimeByGlobal = new WeakMap<Global, ShadowPipelineRuntime>();

const getRuntime = (global: Global): ShadowPipelineRuntime => {
    let runtime = runtimeByGlobal.get(global);
    if (!runtime) {
        runtime = { apply: null, outputEnabled: false, suspendCount: 0, restoreOutputAfterSuspend: false };
        runtimeByGlobal.set(global, runtime);
    }
    return runtime;
};

const isShadowPipelineSuspended = (global: Global): boolean =>
    getRuntime(global).suspendCount > 0;

const shouldDeferShadowMountUntilRevealComplete = (global: Global): boolean => {
    const revealStatus = global.state.effectsRuntimeState?.reveal?.status;
    if (revealStatus === 'playing') {
        return true;
    }
    if (revealStatus === 'completed' || revealStatus === 'inactive') {
        return false;
    }
    const revealType = readRevealParams(global.settings as ExperienceSettings)?.type ?? 'none';
    if (isRevealTimedVfxType(revealType)) {
        return true;
    }
    return revealBlocksAnim(global.state);
};

const setCatcherActive = (global: Global, active: boolean) => {
    const root = global.app.root.findByName('shadowCatcher') as Entity | null;
    if (root) {
        root.enabled = active;
    }
};

/** 接影叠屏是否允许参与本帧渲染（须同时具备 mesh 能力与管线 output）。 */
export const isShadowOutputEnabled = (global: Global): boolean =>
    isShadowSystemEnabled(global)
    && global.state.readyToRender === true
    && !isShadowPipelineSuspended(global)
    && getRuntime(global).outputEnabled;

const syncDirectionalShadowCasting = (global: Global) => {
    if (!isShadowSystemEnabled(global)) {
        return;
    }
    const { app } = global;
    delete (app as { __directionalLightSignature?: string }).__directionalLightSignature;
    updatePointLightsFromSettings(global);
};

const activateOutput = (global: Global) => {
    const runtime = getRuntime(global);
    runtime.outputEnabled = true;
    (global.app as { __shadowOutputEnabled?: boolean }).__shadowOutputEnabled = true;
    setCatcherActive(global, true);
    syncDirectionalShadowCasting(global);
    (global.app as { renderNextFrame?: boolean }).renderNextFrame = true;
};

const deactivateOutput = (global: Global) => {
    const runtime = getRuntime(global);
    runtime.outputEnabled = false;
    (global.app as { __shadowOutputEnabled?: boolean }).__shadowOutputEnabled = false;
    setCatcherActive(global, false);
    if (isShadowSystemEnabled(global)) {
        setDirectionalCastShadowsEnabled(global, false);
    }
    (global.app as { renderNextFrame?: boolean }).renderNextFrame = true;
};

export const suspendShadowPipelineForGsplatLoad = (global: Global): (() => void) => {
    const runtime = getRuntime(global);
    if (runtime.outputEnabled) {
        runtime.restoreOutputAfterSuspend = true;
    }
    runtime.suspendCount += 1;
    syncGsplatShadowCastingFromSettings(global);
    deactivateOutput(global);

    let released = false;
    return () => {
        if (released) return;
        released = true;
        runtime.suspendCount = Math.max(0, runtime.suspendCount - 1);
        syncGsplatShadowCastingFromSettings(global);
        if (
            runtime.suspendCount === 0
            && runtime.apply
            && runtime.restoreOutputAfterSuspend
            && isShadowSystemEnabled(global)
            && global.state.readyToRender
            && !shouldDeferShadowMountUntilRevealComplete(global)
        ) {
            runtime.restoreOutputAfterSuspend = false;
            activateOutput(global);
        } else if (runtime.suspendCount === 0) {
            runtime.restoreOutputAfterSuspend = false;
        }
    };
};

export const mountShadowPipeline = (
    global: Global,
    mount: ShadowPipelineMount,
    active = false
): ShadowApplyRt => {
    const runtime = getRuntime(global);
    if (runtime.apply) {
        return runtime.apply;
    }

    const { app, settings } = global;
    const shadow = settings.postEffectSettings?.shadow as { debugVisual?: boolean } | undefined;

    initShadowCatcher(app, mount.sceneBound, {
        debugVisual: shadow?.debugVisual ?? false,
        parentEntity: mount.gsplatEntity,
        meshEntity: mount.meshEntity ?? undefined,
        active
    });

    (app as { __shadowApplyGlobal?: Global }).__shadowApplyGlobal = global;
    if (!app.root.script) {
        app.root.addComponent('script');
    }
    const apply = app.root.script!.create(ShadowApplyRt) as unknown as ShadowApplyRt;
    apply.global = global;
    delete (app as { __shadowApplyGlobal?: Global }).__shadowApplyGlobal;

    updateShadowDistance(global, mount.sceneBound.halfExtents.length());

    runtime.apply = apply;
    runtime.outputEnabled = active;
    (global.app as { __shadowOutputEnabled?: boolean }).__shadowOutputEnabled = active;
    return apply;
};

const bindOpeningRevealGate = (global: Global, mount: ShadowPipelineMount) => {
    const { events } = global;

    const onRevealComplete = () => {
        mountShadowPipeline(global, mount, true);
        activateOutput(global);
    };

    const onRevealRestart = () => {
        if (!shouldDeferShadowMountUntilRevealComplete(global)) {
            return;
        }
        deactivateOutput(global);
    };

    events.on('revealComplete', onRevealComplete);
    events.on('revealRestart', onRevealRestart);
};

export const scheduleShadowPipeline = (global: Global, mount: ShadowPipelineMount): ShadowApplyRt | null => {
    syncGsplatShadowCastingFromSettings(global, mount.gsplatEntity);

    if (!isShadowSystemEnabled(global)) {
        return null;
    }

    if (shouldDeferShadowMountUntilRevealComplete(global)) {
        setDirectionalCastShadowsEnabled(global, false);
        bindOpeningRevealGate(global, mount);
        return null;
    }

    const apply = mountShadowPipeline(global, mount, false);
    setDirectionalCastShadowsEnabled(global, false);
    return apply;
};

export const notifyViewportReadyForShadow = (global: Global) => {
    if (!getRuntime(global).apply || shouldDeferShadowMountUntilRevealComplete(global)) {
        return;
    }
    activateOutput(global);
};

export const getShadowApplyScript = (global: Global): ShadowApplyRt | null =>
    getRuntime(global).apply ?? null;
