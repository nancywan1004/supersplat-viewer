import { Entity, Script, type AppBase, type CameraComponent, type CameraFrame } from 'playcanvas';

import type { ExperienceSettings } from '../../../../settings';
import { shouldDeferPersistentMount } from '../../../../settings-serialize/effects-sync';
import type { Global } from '../../../../types';
import {
    DEFAULT_WATERCOLOR_SETTINGS,
    WatercolorController,
    type WatercolorSettings
} from './watercolor';

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
}

function readScriptGlobal(app: AppBase): Global | undefined {
    return (app as { __global?: Global }).__global;
}

function readCameraFrame(app: AppBase): CameraFrame | null {
    return (app as { getCameraFrame?: () => CameraFrame | null }).getCameraFrame?.() ?? null;
}

function notifyCameraPipelineChanged(app: AppBase): void {
    readScriptGlobal(app)?.events?.fire('postEffect:changed');
    app.renderNextFrame = true;
}

export class GsplatPersistentWatercolor extends Script {
    static scriptName = 'gsplatPersistentWatercolor';

    effectTime = 0;

    isPaused = false;

    bleed = DEFAULT_WATERCOLOR_SETTINGS.bleed;

    wash = DEFAULT_WATERCOLOR_SETTINGS.wash;

    blur = DEFAULT_WATERCOLOR_SETTINGS.blur;

    paper = DEFAULT_WATERCOLOR_SETTINGS.paper;

    paperColor: [number, number, number] = [...DEFAULT_WATERCOLOR_SETTINGS.paperColor];

    clarity = DEFAULT_WATERCOLOR_SETTINGS.clarity;

    saturation = DEFAULT_WATERCOLOR_SETTINGS.saturation;

    private _controller: WatercolorController | null = null;

    private _camera: CameraComponent | null = null;

    private readonly _onPostEffectChanged = () => {
        if (!this.enabled || this._isRevealDeferred()) {
            return;
        }
        this.applyConfig();
    };

    private readonly _onRevealRestart = () => {
        if (this._isRevealDeferred()) {
            this._controller?.suspendForReveal();
            return;
        }
        this._controller?.resumeFromReveal();
        this.app.once('frameend', () => {
            if (this.enabled) {
                this.applyConfig();
            }
        });
    };

    private readonly _onRevealComplete = () => {
        this._controller?.resumeFromReveal();
        if (this.enabled) {
            this.applyConfig();
        }
    };

    initialize() {
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this.applyConfig());

        const global = readScriptGlobal(this.app);
        global?.events?.on('postEffect:changed', this._onPostEffectChanged);
        global?.events?.on('revealRestart', this._onRevealRestart);
        global?.events?.on('revealComplete', this._onRevealComplete);
        this.app.on('nightFade:changedDetailed', this._onPostEffectChanged);

        this.app.once('frameend', () => {
            if (this.enabled && !this._isRevealDeferred()) {
                this.applyConfig();
            }
        });
    }

    applyConfig() {
        const camera = findCameraEntity(this.app.root)?.camera ?? null;
        if (!camera) {
            console.warn('[watercolor] camera not found');
            return;
        }
        if (!camera.postEffects) {
            console.warn('[watercolor] camera postEffects unavailable — enable CameraFrame / post-processing');
            return;
        }

        if (!this._controller || this._camera !== camera) {
            this._controller?.destroy();
            this._controller = new WatercolorController(this.app, camera);
            this._camera = camera;
        }

        this._controller.apply(this._buildSettings(), {
            getCameraFrame: () => readCameraFrame(this.app)
        });
        this._controller.setTime(this.effectTime);

        if (!this.enabled) {
            notifyCameraPipelineChanged(this.app);
        }
    }

    update(dt: number) {
        if (!this.enabled || !this._controller || this.isPaused) {
            return;
        }
        this.effectTime += dt;
        this._controller.setTime(this.effectTime);
    }

    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
        this._controller?.setTime(this.effectTime);
    }

    destroy() {
        const global = readScriptGlobal(this.app);
        global?.events?.off('postEffect:changed', this._onPostEffectChanged);
        global?.events?.off('revealRestart', this._onRevealRestart);
        global?.events?.off('revealComplete', this._onRevealComplete);
        this.app.off('nightFade:changedDetailed', this._onPostEffectChanged);

        this._controller?.destroy();
        this._controller = null;
        this._camera = null;
    }

    private _buildSettings(): WatercolorSettings {
        return {
            enabled: this.enabled,
            bleed: this.bleed,
            wash: this.wash,
            blur: this.blur,
            paper: this.paper,
            paperColor: [...this.paperColor],
            clarity: this.clarity,
            saturation: this.saturation
        };
    }

    private _isRevealDeferred(): boolean {
        const settings = readScriptGlobal(this.app)?.settings as ExperienceSettings | undefined;
        return settings ? shouldDeferPersistentMount(settings) : false;
    }
}
