import { Entity, Script, type AppBase, type CameraComponent, type CameraFrame } from 'playcanvas';

import type { ExperienceSettings } from '../../../../settings';
import { shouldDeferPersistentMount } from '../../../../settings-serialize/effects-sync';
import type { Global } from '../../../../types';
import {
    DEFAULT_CHARCOAL_SKETCH_SETTINGS,
    CharcoalSketchController,
    type CharcoalSketchSettings
} from './charcoal-sketch';

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
}

function readScriptGlobal(app: AppBase): Global | undefined {
    return (app as { __global?: Global }).__global;
}

function readCameraFrame(app: AppBase): CameraFrame | null {
    return (app as { getCameraFrame?: () => CameraFrame | null }).getCameraFrame?.() ?? null;
}

/** 通知 viewer 重配相机管线（清屏色 / CameraFrame）。 */
function notifyCameraPipelineChanged(app: AppBase): void {
    readScriptGlobal(app)?.events?.fire('postEffect:changed');
    app.renderNextFrame = true;
}

export class GsplatPersistentCharcoalSketch extends Script {
    static scriptName = 'gsplatPersistentCharcoalSketch';

    effectTime = 0;

    isPaused = false;

    outline = DEFAULT_CHARCOAL_SKETCH_SETTINGS.outline;

    hatching = DEFAULT_CHARCOAL_SKETCH_SETTINGS.hatching;

    contrast = DEFAULT_CHARCOAL_SKETCH_SETTINGS.contrast;

    stroke = DEFAULT_CHARCOAL_SKETCH_SETTINGS.stroke;

    smudge = DEFAULT_CHARCOAL_SKETCH_SETTINGS.smudge;

    focus = DEFAULT_CHARCOAL_SKETCH_SETTINGS.focus;

    paper = DEFAULT_CHARCOAL_SKETCH_SETTINGS.paper;

    paperColor: [number, number, number] = [...DEFAULT_CHARCOAL_SKETCH_SETTINGS.paperColor];

    private _controller: CharcoalSketchController | null = null;

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
        // 非阻塞 reveal（如 persistent VFX 重播）：下一帧重挂后处理。
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
            console.warn('[charcoal-sketch] camera not found');
            return;
        }
        if (!camera.postEffects) {
            console.warn('[charcoal-sketch] camera postEffects unavailable — enable CameraFrame / post-processing');
            return;
        }

        if (!this._controller || this._camera !== camera) {
            this._controller?.destroy();
            this._controller = new CharcoalSketchController(this.app, camera);
            this._camera = camera;
        }

        this._controller.apply(this._buildSettings(), {
            getCameraFrame: () => readCameraFrame(this.app)
        });

        if (!this.enabled) {
            notifyCameraPipelineChanged(this.app);
        }
    }

    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
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

    private _buildSettings(): CharcoalSketchSettings {
        return {
            enabled: this.enabled,
            outline: this.outline,
            hatching: this.hatching,
            contrast: this.contrast,
            stroke: this.stroke,
            smudge: this.smudge,
            focus: this.focus,
            paper: this.paper,
            paperColor: [...this.paperColor]
        };
    }

    private _isRevealDeferred(): boolean {
        const settings = readScriptGlobal(this.app)?.settings as ExperienceSettings | undefined;
        return settings ? shouldDeferPersistentMount(settings) : false;
    }
}
