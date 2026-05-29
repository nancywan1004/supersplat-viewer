import { Entity, Script, type CameraComponent } from 'playcanvas';

import {
    DEFAULT_YIYUN_DIANRAN_SETTINGS,
    YiyunDianranController
} from '../../stylisation/yiyun-dianran-stylisation';

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
}

export class GsplatPersistentYiyunDianran extends Script {
    static scriptName = 'gsplatPersistentYiyunDianran';

    effectTime = 0;

    isPaused = false;

    saturation = DEFAULT_YIYUN_DIANRAN_SETTINGS.saturation;

    glowIntensity = DEFAULT_YIYUN_DIANRAN_SETTINGS.glowIntensity;

    glowColor: [number, number, number] = [...DEFAULT_YIYUN_DIANRAN_SETTINGS.glowColor];

    private _controller: YiyunDianranController | null = null;

    private _camera: CameraComponent | null = null;

    private _gsplatEntity: Entity | null = null;

    initialize() {
        this._gsplatEntity = this.entity;
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this.applyConfig());
    }

    update(dt: number) {
        if (!this.enabled || this.isPaused) {
            return;
        }
        this._controller?.tick(dt);
    }

    applyConfig() {
        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera ?? null;
        if (!camera) {
            console.warn('[yiyun-dianran] camera not found');
            return;
        }
        if (!camera.postEffects) {
            console.warn('[yiyun-dianran] camera postEffects unavailable — enable CameraFrame / post-processing');
            return;
        }

        if (!this._controller || this._camera !== camera) {
            this._controller?.apply({ ...DEFAULT_YIYUN_DIANRAN_SETTINGS, enabled: false }, {
                gsplatEntity: this._gsplatEntity ?? this.entity
            });
            this._controller = new YiyunDianranController(this.app, camera);
            this._camera = camera;
        }

        const getCameraFrame = () => (this.app as { getCameraFrame?: () => unknown }).getCameraFrame?.() ?? null;

        this._controller.apply({
            enabled: this.enabled,
            saturation: this.saturation,
            glowIntensity: this.glowIntensity,
            glowColor: [...this.glowColor]
        }, {
            gsplatEntity: this._gsplatEntity ?? this.entity,
            getCameraFrame: getCameraFrame as () => import('playcanvas').CameraFrame | null
        });
    }

    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
        this._controller?.setEffectTime(this.effectTime);
    }

    destroy() {
        this._controller?.apply({ ...DEFAULT_YIYUN_DIANRAN_SETTINGS, enabled: false }, {
            gsplatEntity: this._gsplatEntity ?? this.entity
        });
        this._controller = null;
        this._camera = null;
        this._gsplatEntity = null;
    }
}
