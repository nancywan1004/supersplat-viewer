import { Entity, Script, Vec3, type CameraComponent } from 'playcanvas';

import {
    DEFAULT_PEN_SKETCH_SETTINGS,
    PenSketchController
} from './pen-sketch';

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
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

    private _controller: PenSketchController | null = null;

    private _camera: CameraComponent | null = null;

    private _referenceViewDistance = 0;

    private readonly _cameraPos = new Vec3();

    private readonly _focusPos = new Vec3();

    initialize() {
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this.applyConfig());
    }

    applyConfig() {
        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera ?? null;
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

        const getCameraFrame = () => (this.app as { getCameraFrame?: () => unknown }).getCameraFrame?.() ?? null;

        this._controller.apply({
            enabled: this.enabled,
            outlineWidth: this.outlineWidth,
            edgeStrength: this.edgeStrength,
            hatching: this.hatching,
            contrast: this.contrast,
            toneStrength: this.toneStrength,
            stroke: this.stroke,
            focus: this.focus,
            inkHue: this.inkHue
        }, { getCameraFrame: getCameraFrame as () => import('playcanvas').CameraFrame | null });
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
        this._controller?.destroy();
        this._controller = null;
        this._camera = null;
    }
}
