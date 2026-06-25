import { Entity, type AppBase, type CameraComponent, type CameraFrame, type Script } from 'playcanvas';

import type { ExperienceSettings } from '../../../../settings';
import { shouldDeferPersistentMount } from '../../../../settings-serialize/effects-sync';
import type { Global } from '../../../../types';

export function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
}

export function readScriptGlobal(app: AppBase): Global | undefined {
    return (app as { __global?: Global }).__global;
}

export function readCameraFrame(app: AppBase): CameraFrame | null {
    return (app as { getCameraFrame?: () => CameraFrame | null }).getCameraFrame?.() ?? null;
}

export function notifyCameraPipelineChanged(app: AppBase): void {
    readScriptGlobal(app)?.events?.fire('postEffect:changed');
    app.renderNextFrame = true;
}

export function isRevealDeferredForApp(app: AppBase): boolean {
    const settings = readScriptGlobal(app)?.settings as ExperienceSettings | undefined;
    return settings ? shouldDeferPersistentMount(settings) : false;
}

export function requireCameraForStylisation(
    app: AppBase,
    logTag: string
): CameraComponent | null {
    const camera = findCameraEntity(app.root)?.camera ?? null;
    if (!camera) {
        console.warn(`[${logTag}] camera not found`);
        return null;
    }
    if (!camera.postEffects) {
        console.warn(`[${logTag}] camera postEffects unavailable — enable CameraFrame / post-processing`);
        return null;
    }
    return camera;
}

export type PaperStylisationRevealController = {
    suspendForReveal(): void;
    resumeFromReveal(): void;
};

export function bindPaperStylisationScriptLifecycle(input: {
    script: Script;
    applyConfig: () => void;
    getController: () => PaperStylisationRevealController | null;
    isEnabled: () => boolean;
}): () => void {
    const { script, applyConfig, getController, isEnabled } = input;
    const app = script.app;

    const onPostEffectChanged = () => {
        if (!isEnabled() || isRevealDeferredForApp(app)) {
            return;
        }
        applyConfig();
    };

    const onRevealRestart = () => {
        if (isRevealDeferredForApp(app)) {
            getController()?.suspendForReveal();
            return;
        }
        getController()?.resumeFromReveal();
        app.once('frameend', () => {
            if (isEnabled()) {
                applyConfig();
            }
        });
    };

    const onRevealComplete = () => {
        getController()?.resumeFromReveal();
        if (isEnabled()) {
            applyConfig();
        }
    };

    script.on('enable', applyConfig);
    script.on('disable', applyConfig);

    const global = readScriptGlobal(app);
    global?.events?.on('postEffect:changed', onPostEffectChanged);
    global?.events?.on('revealRestart', onRevealRestart);
    global?.events?.on('revealComplete', onRevealComplete);
    app.on('nightFade:changedDetailed', onPostEffectChanged);

    app.once('frameend', () => {
        if (isEnabled() && !isRevealDeferredForApp(app)) {
            applyConfig();
        }
    });

    return () => {
        script.off('enable', applyConfig);
        script.off('disable', applyConfig);
        global?.events?.off('postEffect:changed', onPostEffectChanged);
        global?.events?.off('revealRestart', onRevealRestart);
        global?.events?.off('revealComplete', onRevealComplete);
        app.off('nightFade:changedDetailed', onPostEffectChanged);
    };
}
