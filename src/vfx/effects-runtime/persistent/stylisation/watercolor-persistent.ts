import { Entity, Script, type CameraComponent } from 'playcanvas';

import {
    DEFAULT_WATERCOLOR_SETTINGS,
    WatercolorController
} from './watercolor';

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
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

    initialize() {
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this.applyConfig());
    }

    applyConfig() {
        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera ?? null;
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

        const getCameraFrame = () => (this.app as { getCameraFrame?: () => unknown }).getCameraFrame?.() ?? null;

        this._controller.apply({
            enabled: this.enabled,
            bleed: this.bleed,
            wash: this.wash,
            blur: this.blur,
            paper: this.paper,
            paperColor: [...this.paperColor],
            clarity: this.clarity,
            saturation: this.saturation
        }, { getCameraFrame: getCameraFrame as () => import('playcanvas').CameraFrame | null });

        this._controller.setTime(this.effectTime);
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
        this._controller?.destroy();
        this._controller = null;
        this._camera = null;
    }
}
