export { hasShadowSceneMesh, isShadowSystemEnabled } from './shadow-policy';
export {
    applyGsplatCastShadows,
    applyPlacedMeshShadowFlags,
    syncGsplatShadowCastingFromSettings,
    isShadowOutputEnabled,
    mountShadowPipeline,
    suspendShadowPipelineForGsplatLoad,
    scheduleShadowPipeline,
    notifyViewportReadyForShadow,
    getShadowApplyScript
} from './shadow-system';
export type { ShadowPipelineMount } from './shadow-system';
export { initShadowCatcher, ShadowCatcher } from './shadow-catcher';
export { ShadowApplyRt } from './shadow-apply';
