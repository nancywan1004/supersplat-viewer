import { Script, type CameraComponent } from 'playcanvas';

import {
    bindPaperStylisationScriptLifecycle,
    notifyCameraPipelineChanged,
    readCameraFrame,
    requireCameraForStylisation
} from './stylisation-script-utils';
import {
    DEFAULT_WATERCOLOR_SETTINGS,
    WatercolorController,
    type WatercolorSettings
} from './watercolor';

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
        const camera = requireCameraForStylisation(this.app, 'watercolor');
        if (!camera) {
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
        this._unbindLifecycle?.();
        this._unbindLifecycle = null;
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
}
