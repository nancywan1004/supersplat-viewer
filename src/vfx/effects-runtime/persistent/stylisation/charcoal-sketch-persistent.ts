import { Script, type CameraComponent } from 'playcanvas';

import {
    DEFAULT_CHARCOAL_SKETCH_SETTINGS,
    CharcoalSketchController,
    type CharcoalSketchSettings
} from './charcoal-sketch';
import {
    bindPaperStylisationScriptLifecycle,
    notifyCameraPipelineChanged,
    readCameraFrame,
    requireCameraForStylisation
} from './stylisation-script-utils';

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
        const camera = requireCameraForStylisation(this.app, 'charcoal-sketch');
        if (!camera) {
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
        this._unbindLifecycle?.();
        this._unbindLifecycle = null;
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
}
