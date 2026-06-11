import type { Entity, GSplatComponent } from 'playcanvas';

import type { Global } from '../../../types';
import type { RevealController } from '../../../vfx/effects-runtime/reveal/reveal-controller';
import type { ForceRenderBinding } from '../shared-types';

export type { ForceRenderBinding } from '../shared-types';

/** 纯 unified SOG（有 instance/sorter）：与 octree streaming / custom LOD 完全隔离 */
export type SogUnifiedBootstrapOptions = {
    global: Global;
    gsplat: GSplatComponent;
    camera: Entity;
    forceRender: ForceRenderBinding;
    ensureShadowPipelineReady: () => void;
    revealController?: RevealController | null;
};

/** unified instance 路径：sorter 完成后 firstFrame + 解锁进度 */
export function bootstrapSogUnified(options: SogUnifiedBootstrapOptions): void {
    const { global, gsplat, camera, forceRender, ensureShadowPipelineReady, revealController } = options;
    const { app, events, state } = global;
    const { instance } = gsplat;
    if (!instance) {
        return;
    }

    instance.sort(camera);

    instance.sorter?.on('updated', () => {
        app.renderNextFrame = true;

        if (!state.readyToRender) {
            revealController?.ensureInitialEffectCreatedBeforeFirstDisplay?.();
            forceRender.set(true);
            app.renderNextFrame = true;

            app.once('frameend', () => {
                if (state.readyToRender) {
                    return;
                }

                state.readyToRender = true;
                ensureShadowPipelineReady();
                forceRender.set(false);

                events.fire('firstFrame');
                window.firstFrame?.();
                events.fire('progressThresholdReached', 100);
            });
        }
    });
}
