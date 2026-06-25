import { Entity, Script, Vec3, type AppBase, type CameraComponent, type CameraFrame } from 'playcanvas';

import type { ExperienceSettings } from '../../../../settings';
import { shouldDeferPersistentMount } from '../../../../settings-serialize/effects-sync';
import type { Global } from '../../../../types';
import {
    DEFAULT_PEN_SKETCH_SETTINGS,
    PenSketchController,
    type PenSketchSettings
} from './pen-sketch';

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

export class GsplatPersistentPenSketch extends Script {
    static scriptName = 'gsplatPersistentPenSketch';

    effectTime = 0;

    isPaused = false;

    outlineWidth = DEFAULT_PEN_SKETCH_SETTINGS.outlineWidth;

    edgeStrength = DEFAULT_PEN_SKETCH_SETTINGS.edgeStrength;

    hatching = DEFAULT_PEN_SKETCH_SETTINGS.hatching;

    contrast = DEFAULT_PEN_SKETCH_SETTINGS.contrast;

    toneStrength = DEFAULT_PEN_SKETCH_SETTINGS.toneStrength;

    stroke = DEFAULT_PEN_SKETCH_SETTINGS.stroke;

    focus = DEFAULT_PEN_SKETCH_SETTINGS.focus;

    inkHue = DEFAULT_PEN_SKETCH_SETTINGS.inkHue;

    paperColor: [number, number, number] = [...DEFAULT_PEN_SKETCH_SETTINGS.paperColor];

    private _controller: PenSketchController | null = null;

    private _camera: CameraComponent | null = null;

    private _referenceViewDistance = 0;

    private readonly _cameraPos = new Vec3();

    private readonly _focusPos = new Vec3();

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
            console.warn('[pen-sketch] camera not found');
            return;
        }
        if (!camera.postEffects) {
            console.warn('[pen-sketch] camera postEffects unavailable — enable CameraFrame / post-processing');
            return;
        }

        if (!this._controller || this._camera !== camera) {
            this._controller?.destroy();
            this._controller = new PenSketchController(this.app, camera);
            this._camera = camera;
            this._referenceViewDistance = 0;
        }

        this._controller.apply(this._buildSettings(), {
            getCameraFrame: () => readCameraFrame(this.app)
        });

        if (!this.enabled) {
            notifyCameraPipelineChanged(this.app);
        }
    }

    update() {
        if (!this.enabled || !this._controller) {
            return;
        }

        const cameraEntity = findCameraEntity(this.app.root);
        if (!cameraEntity) {
            return;
        }

        this._cameraPos.copy(cameraEntity.getPosition());
        this._focusPos.copy(this.entity.getPosition());
        const distance = this._cameraPos.distance(this._focusPos);
        if (this._referenceViewDistance <= 0 && distance > 0.0001) {
            this._referenceViewDistance = distance;
        }
        if (this._referenceViewDistance > 0) {
            const viewScale = Math.min(4, Math.max(0.12, this._referenceViewDistance / Math.max(distance, 0.0001)));
            this._controller.setViewScale(viewScale);
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

    private _buildSettings(): PenSketchSettings {
        return {
            enabled: this.enabled,
            outlineWidth: this.outlineWidth,
            edgeStrength: this.edgeStrength,
            hatching: this.hatching,
            contrast: this.contrast,
            toneStrength: this.toneStrength,
            stroke: this.stroke,
            focus: this.focus,
            inkHue: this.inkHue,
            paperColor: [...this.paperColor]
        };
    }

    private _isRevealDeferred(): boolean {
        const settings = readScriptGlobal(this.app)?.settings as ExperienceSettings | undefined;
        return settings ? shouldDeferPersistentMount(settings) : false;
    }
}
