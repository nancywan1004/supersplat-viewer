import type { BoundingBox, Entity } from 'playcanvas';

import type { ExperienceSettings } from '../../schemas/v2';
import type { Global } from '../../types';
import { setDirectionalCastShadowsEnabled, updatePointLightsFromSettings, updateShadowDistance } from '../../light';
import { readRevealParams } from '../../settings-serialize/effects-sync';
import { isRevealTimedVfxType, revealBlocksAnim } from '../effects-runtime/reveal/reveal-policy';
import { initShadowCatcher } from './shadow-catcher';
import { ShadowApplyRt } from './shadow-apply';

export type ShadowPipelineMount = {
    sceneBound: BoundingBox;
    gsplatEntity: Entity;
    meshEntity?: Entity | null;
};

type ShadowPipelineRuntime = {
    apply: ShadowApplyRt | null;
    /** 允许接影叠屏与 mesh 投射阴影（readyToRender 仍须为 true） */
    outputEnabled: boolean;
};

const runtimeByGlobal = new WeakMap<Global, ShadowPipelineRuntime>();

const getRuntime = (global: Global): ShadowPipelineRuntime => {
    let runtime = runtimeByGlobal.get(global);
    if (!runtime) {
        runtime = { apply: null, outputEnabled: false };
        runtimeByGlobal.set(global, runtime);
    }
    return runtime;
};

const isShadowEnabledInSettings = (global: Global): boolean =>
    (global.settings.postEffectSettings?.shadow as { enabled?: boolean } | undefined)?.enabled === true;

/**
 * 是否应推迟接影 mount/输出至 `revealComplete`。
 * 优先用 settings 中的 timed reveal 类型（与 Bloom 一致），避免 `scheduleShadowPipeline`
 * 早于 RevealController 时 `effectsRuntimeState.reveal.activeType` 仍为 `none` 而误走立即 mount。
 */
const shouldDeferShadowMountUntilRevealComplete = (global: Global): boolean => {
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

/** 接影叠屏与接影 mesh 是否允许参与本帧渲染 */
export const isShadowOutputEnabled = (global: Global): boolean =>
    global.state.readyToRender === true && getRuntime(global).outputEnabled;

const syncDirectionalShadowCasting = (global: Global) => {
    if (!isShadowEnabledInSettings(global)) {
        return;
    }
    const { app } = global;
    delete (app as { __directionalLightSignature?: string }).__directionalLightSignature;
    updatePointLightsFromSettings(global);
};

const activateOutput = (global: Global) => {
    const runtime = getRuntime(global);
    runtime.outputEnabled = true;
    setCatcherActive(global, true);
    syncDirectionalShadowCasting(global);
    (global.app as { renderNextFrame?: boolean }).renderNextFrame = true;
};

const deactivateOutput = (global: Global) => {
    const runtime = getRuntime(global);
    runtime.outputEnabled = false;
    setCatcherActive(global, false);
    if (isShadowEnabledInSettings(global)) {
        setDirectionalCastShadowsEnabled(global, false);
    }
    (global.app as { renderNextFrame?: boolean }).renderNextFrame = true;
};

/**
 * 挂载接影几何与 ShadowApplyRt（幂等）。
 * @param active 创建后是否立即可输出；开场 reveal 应在 `revealComplete` 后再 mount 并置 true。
 */
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

/**
 * 按场景配置挂载阴影管线并绑定与开场 reveal 的门控。
 * - 阻塞型开场 reveal：推迟 mount 至 `revealComplete`，此前无接影 GLB、无方向光投影。
 * - 其余场景：立即 mount，在 `notifyViewportReadyForShadow` 后启用输出。
 */
export const scheduleShadowPipeline = (global: Global, mount: ShadowPipelineMount): ShadowApplyRt | null => {
    if (!isShadowEnabledInSettings(global)) {
        return null;
    }

    if (shouldDeferShadowMountUntilRevealComplete(global)) {
        if (isShadowEnabledInSettings(global)) {
            setDirectionalCastShadowsEnabled(global, false);
        }
        bindOpeningRevealGate(global, mount);
        return null;
    }

    const apply = mountShadowPipeline(global, mount, false);
    setDirectionalCastShadowsEnabled(global, false);
    return apply;
};

/**
 * 首屏可上屏（`readyToRender`）后调用，启用接影输出。无开场 reveal 时与 mount 配对使用。
 */
export const notifyViewportReadyForShadow = (global: Global) => {
    if (!getRuntime(global).apply || shouldDeferShadowMountUntilRevealComplete(global)) {
        return;
    }
    activateOutput(global);
};

export const getShadowApplyScript = (global: Global): ShadowApplyRt | null =>
    getRuntime(global).apply ?? null;
