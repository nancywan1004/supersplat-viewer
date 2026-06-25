import { Script, Vec3, type CameraComponent } from 'playcanvas';

import {
    DEFAULT_PEN_SKETCH_SETTINGS,
    PenSketchController,
    type PenSketchSettings
} from './pen-sketch';
import {
    bindPaperStylisationScriptLifecycle,
    findCameraEntity,
    notifyCameraPipelineChanged,
    readCameraFrame,
    requireCameraForStylisation
} from './stylisation-script-utils';

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

    private _unbindLifecycle: (() => void) | null = null;

    initialize() {
        this._unbindLifecycle = bindPaperStylisationScriptLifecycle({
            script: this,
            applyConfig: () => this.applyConfig(),
            getController: () => this._controller,
            isEnabled: () => this.enabled
        });
    }

    applyConfig() {
        const camera = requireCameraForStylisation(this.app, 'pen-sketch');
        if (!camera) {
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
        this._unbindLifecycle?.();
        this._unbindLifecycle = null;
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
}
