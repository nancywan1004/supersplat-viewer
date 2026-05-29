import { Entity, Script, type CameraComponent } from 'playcanvas';

import {
    DEFAULT_PALETTE_PIXEL_SETTINGS,
    PalettePixelController
} from '../../stylisation/palette-pixel';

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
}

export class GsplatPersistentPalettePixel extends Script {
    static scriptName = 'gsplatPersistentPalettePixel';

    effectTime = 0;

    isPaused = false;

    pixelSize = DEFAULT_PALETTE_PIXEL_SETTINGS.pixelSize;

    paletteIndex = DEFAULT_PALETTE_PIXEL_SETTINGS.paletteIndex;

    levels = DEFAULT_PALETTE_PIXEL_SETTINGS.levels;

    ditherSpread = DEFAULT_PALETTE_PIXEL_SETTINGS.ditherSpread;

    private _controller: PalettePixelController | null = null;

    private _camera: CameraComponent | null = null;

    initialize() {
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this.applyConfig());
    }

    applyConfig() {
        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera ?? null;
        if (!camera) {
            console.warn('[palette-pixel] camera not found');
            return;
        }
        if (!camera.postEffects) {
            console.warn('[palette-pixel] camera postEffects unavailable — enable CameraFrame / post-processing');
        }

        if (!this._controller || this._camera !== camera) {
            this._controller?.apply({ ...DEFAULT_PALETTE_PIXEL_SETTINGS, enabled: false });
            this._controller = new PalettePixelController(this.app, camera);
            this._camera = camera;
        }

        const getCameraFrame = () => (this.app as { getCameraFrame?: () => unknown }).getCameraFrame?.() ?? null;

        this._controller.apply({
            enabled: this.enabled,
            pixelSize: this.pixelSize,
            paletteIndex: this.paletteIndex,
            levels: this.levels,
            ditherSpread: this.ditherSpread
        }, { getCameraFrame: getCameraFrame as () => import('playcanvas').CameraFrame | null });
    }

    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
    }

    destroy() {
        this._controller?.apply({ ...DEFAULT_PALETTE_PIXEL_SETTINGS, enabled: false });
        this._controller = null;
        this._camera = null;
    }
}
