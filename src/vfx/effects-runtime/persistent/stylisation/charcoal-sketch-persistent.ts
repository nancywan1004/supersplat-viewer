import { Entity, Script, type CameraComponent } from 'playcanvas';

import {
    DEFAULT_CHARCOAL_SKETCH_SETTINGS,
    CharcoalSketchController
} from './charcoal-sketch';

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
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

    private _controller: CharcoalSketchController | null = null;

    private _camera: CameraComponent | null = null;

    initialize() {
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this.applyConfig());
    }

    applyConfig() {
        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera ?? null;
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

        const getCameraFrame = () => (this.app as { getCameraFrame?: () => unknown }).getCameraFrame?.() ?? null;

        this._controller.apply({
            enabled: this.enabled,
            outline: this.outline,
            hatching: this.hatching,
            contrast: this.contrast,
            stroke: this.stroke,
            smudge: this.smudge,
            focus: this.focus,
            paper: this.paper
        }, { getCameraFrame: getCameraFrame as () => import('playcanvas').CameraFrame | null });
    }

    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
    }

    destroy() {
        this._controller?.destroy();
        this._controller = null;
        this._camera = null;
    }
}
