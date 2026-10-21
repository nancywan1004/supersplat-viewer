import { Entity, Script, type CameraComponent } from 'playcanvas';

import { isRevealDeferredForApp, readScriptGlobal } from './stylisation-script-utils';
import {
    DEFAULT_YIYUN_DIANRAN_SETTINGS,
    YiyunDianranController
} from './yiyun-dianran-stylisation';

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

    postEffectEnabled = DEFAULT_YIYUN_DIANRAN_SETTINGS.postEffectEnabled;

    private _controller: YiyunDianranController | null = null;

    private _camera: CameraComponent | null = null;

    private _gsplatEntity: Entity | null = null;

    /**
     * 后处理管线变化（例如开阴影新建了 CameraFrame）时重新挂载：
     * legacy `camera.postEffects` 在 CameraFrame 下不会被引擎触发，必须切到 compose 桥接。
     */
    private readonly _onPostEffectChanged = (): void => {
        if (!this.enabled || isRevealDeferredForApp(this.app)) {
            return;
        }
        this.applyConfig();
    };

    initialize() {
        this._gsplatEntity = this.entity;
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this.applyConfig());
        readScriptGlobal(this.app)?.events?.on('postEffect:changed', this._onPostEffectChanged);
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
            postEffectEnabled: this.postEffectEnabled,
            saturation: this.saturation,
            glowIntensity: this.glowIntensity,
            glowColor: [...this.glowColor]
        }, {
            gsplatEntity: this._gsplatEntity ?? this.entity,
            getCameraFrame: getCameraFrame as () => import('playcanvas').CameraFrame | null
        });
    }

    applyPostEffectConfig() {
        if (!this._controller) {
            this.applyConfig();
            return;
        }
        const getCameraFrame = () => (this.app as { getCameraFrame?: () => unknown }).getCameraFrame?.() ?? null;
        this._controller.setPostEffectEnabled(
            this.enabled && this.postEffectEnabled,
            getCameraFrame as () => import('playcanvas').CameraFrame | null
        );
    }

    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
        this._controller?.setEffectTime(this.effectTime);
    }

    destroy() {
        readScriptGlobal(this.app)?.events?.off('postEffect:changed', this._onPostEffectChanged);
        this._controller?.apply({ ...DEFAULT_YIYUN_DIANRAN_SETTINGS, enabled: false }, {
            gsplatEntity: this._gsplatEntity ?? this.entity
        });
        this._controller = null;
        this._camera = null;
        this._gsplatEntity = null;
    }
}
