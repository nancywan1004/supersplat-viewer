import {
    Color,
    PostEffect,
    type AppBase,
    type CameraComponent,
    type CameraFrame
} from 'playcanvas';

import { colorsRoughlyEqual } from './stylisation-paper-utils';

export type StylisationPaperApplyOptions = {
    getCameraFrame?: () => CameraFrame | null | undefined;
};

export interface StylisationCameraFrameBridge {
    mount(cameraFrame: CameraFrame): boolean;
    unmount(): void;
    isMounted(): boolean;
}

export type StylisationPaperControllerDeps<TSettings extends { enabled: boolean }> = {
    app: AppBase;
    camera: CameraComponent;
    logTag: string;
    bridge: StylisationCameraFrameBridge;
    postEffect: PostEffect;
    normalizeSettings: (raw: unknown) => TSettings;
    paperClearColor: (settings: TSettings) => Color;
    applyEffectSettings: (settings: TSettings) => void;
};

export class StylisationPaperPostController<TSettings extends { enabled: boolean }> {
    private legacyMounted = false;

    private originalClearColor: Color | null = null;

    private revealSuspended = false;

    private deferredSyncGeneration = 0;

    private lastApplySettings: unknown = null;

    private lastApplyOptions: StylisationPaperApplyOptions | undefined;

    constructor(private readonly deps: StylisationPaperControllerDeps<TSettings>) {}

    apply(rawSettings: unknown, options?: StylisationPaperApplyOptions): void {
        const settings = this.deps.normalizeSettings(rawSettings);
        this.lastApplySettings = rawSettings;
        this.lastApplyOptions = options;
        this.deps.applyEffectSettings(settings);

        if (!settings.enabled) {
            this.revealSuspended = false;
            this.unmountAll();
            return;
        }

        if (this.revealSuspended) {
            return;
        }

        this.mountActivePostEffect(options);
        this.applyPaperClearColor(settings);
        this.deps.app.renderNextFrame = true;
        this.scheduleDeferredSync();
    }

    suspendForReveal(): void {
        if (this.revealSuspended) {
            return;
        }
        this.revealSuspended = true;
        this.cancelDeferredSync();
        this.deps.bridge.unmount();
        this.unmountLegacy();
        this.originalClearColor = null;
        this.deps.app.renderNextFrame = true;
    }

    resumeFromReveal(): void {
        this.revealSuspended = false;
    }

    destroy(): void {
        this.unmountAll();
    }

    private mountActivePostEffect(options?: StylisationPaperApplyOptions): void {
        const cameraFrame = options?.getCameraFrame?.();
        if (cameraFrame?.enabled && this.deps.bridge.mount(cameraFrame)) {
            this.unmountLegacy();
            return;
        }
        this.deps.bridge.unmount();
        this.mountLegacy();
    }

    private mountLegacy(): void {
        const { camera, postEffect, logTag } = this.deps;
        if (!camera.postEffects) {
            console.warn(`[${logTag}] camera postEffects unavailable`);
            return;
        }
        if (!this.legacyMounted) {
            camera.postEffects.addEffect(postEffect);
            this.legacyMounted = true;
        }
    }

    private unmountLegacy(): void {
        const { camera, postEffect } = this.deps;
        if (!camera.postEffects || !this.legacyMounted) {
            return;
        }
        camera.postEffects.removeEffect(postEffect);
        this.legacyMounted = false;
    }

    private unmountAll(): void {
        this.cancelDeferredSync();
        this.deps.bridge.unmount();
        this.unmountLegacy();
        this.restoreClearColor();
        this.deps.app.renderNextFrame = true;
    }

    private cancelDeferredSync(): void {
        this.deferredSyncGeneration++;
    }

    private applyPaperClearColor(settings?: TSettings): void {
        if (this.revealSuspended) {
            return;
        }
        const resolved = settings ?? this.deps.normalizeSettings(this.lastApplySettings);
        if (!resolved.enabled) {
            return;
        }
        const paper = this.deps.paperClearColor(resolved);
        if (!this.originalClearColor && !colorsRoughlyEqual(this.deps.camera.clearColor, paper)) {
            this.originalClearColor = this.deps.camera.clearColor.clone();
        }
        this.deps.camera.clearColorBuffer = true;
        this.deps.camera.clearColor = paper;
    }

    private restoreClearColor(): void {
        if (!this.originalClearColor) {
            return;
        }
        this.deps.camera.clearColor = this.originalClearColor.clone();
        this.originalClearColor = null;
    }

    private scheduleDeferredSync(): void {
        if (this.revealSuspended) {
            return;
        }
        const generation = ++this.deferredSyncGeneration;
        this.deps.app.once('frameend', () => {
            if (generation !== this.deferredSyncGeneration) {
                return;
            }
            const settings = this.deps.normalizeSettings(this.lastApplySettings);
            if (!settings.enabled || this.revealSuspended) {
                return;
            }
            const cameraFrame = this.lastApplyOptions?.getCameraFrame?.();
            if (cameraFrame?.enabled && !this.deps.bridge.isMounted()) {
                if (this.deps.bridge.mount(cameraFrame)) {
                    this.unmountLegacy();
                }
            }
            this.applyPaperClearColor(settings);
            this.deps.app.renderNextFrame = true;
        });
    }
}
