import { Entity, Script, type CameraComponent } from 'playcanvas';

import {
    DEFAULT_NOSTALGIC_COMIC_SETTINGS,
    NostalgicComicController
} from './nostalgic-comic';

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
}

export class GsplatPersistentNostalgicComic extends Script {
    static scriptName = 'gsplatPersistentNostalgicComic';

    effectTime = 0;

    isPaused = false;

    levelCount = DEFAULT_NOSTALGIC_COMIC_SETTINGS.levelCount;

    edgeThreshold = DEFAULT_NOSTALGIC_COMIC_SETTINGS.edgeThreshold;

    paperColor: [number, number, number] = [...DEFAULT_NOSTALGIC_COMIC_SETTINGS.paperColor];

    lightColor: [number, number, number] = [...DEFAULT_NOSTALGIC_COMIC_SETTINGS.lightColor];

    strokeColor: [number, number, number] = [...DEFAULT_NOSTALGIC_COMIC_SETTINGS.strokeColor];

    private _controller: NostalgicComicController | null = null;

    private _camera: CameraComponent | null = null;

    initialize() {
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this.applyConfig());
    }

    applyConfig() {
        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera ?? null;
        if (!camera) {
            console.warn('[nostalgic-comic] camera not found');
            return;
        }
        if (!camera.postEffects) {
            console.warn('[nostalgic-comic] camera postEffects unavailable — enable CameraFrame / post-processing');
            return;
        }

        if (!this._controller || this._camera !== camera) {
            this._controller?.apply({ ...DEFAULT_NOSTALGIC_COMIC_SETTINGS, enabled: false });
            this._controller = new NostalgicComicController(this.app, camera);
            this._camera = camera;
        }

        const getCameraFrame = () => (this.app as { getCameraFrame?: () => unknown }).getCameraFrame?.() ?? null;

        this._controller.apply({
            enabled: this.enabled,
            levelCount: this.levelCount,
            edgeThreshold: this.edgeThreshold,
            paperColor: [...this.paperColor],
            lightColor: [...this.lightColor],
            strokeColor: [...this.strokeColor]
        }, { getCameraFrame: getCameraFrame as () => import('playcanvas').CameraFrame | null });
    }

    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
    }

    destroy() {
        this._controller?.apply({ ...DEFAULT_NOSTALGIC_COMIC_SETTINGS, enabled: false });
        this._controller = null;
        this._camera = null;
    }
}
