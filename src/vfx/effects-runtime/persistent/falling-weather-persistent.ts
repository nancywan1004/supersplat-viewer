import { Entity, Script, Vec3 } from 'playcanvas';

import {
    createGsplatFallingPetals,
    destroyGsplatFallingPetals,
    GSPLAT_FALLING_PETALS_PRESET,
    type GsplatFallingPetals
} from '../../gsplat-falling-petals';
import {
    createGsplatFallingWeather,
    destroyGsplatFallingWeather,
    GSPLAT_FALLING_WEATHER_PRESETS,
    type GsplatFallingWeather,
    type GsplatFallingWeatherMode
} from '../../gsplat-falling-weather';

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
}

export class GsplatPersistentFallingPetals extends Script {
    static scriptName = 'gsplatPersistentFallingPetals';

    effectTime = 0;

    isPaused = false;

    followEntity: Entity | null = null;

    continuousRender = true;

    opacity = GSPLAT_FALLING_PETALS_PRESET.opacity;

    color: [number, number, number] = [...GSPLAT_FALLING_PETALS_PRESET.color];

    extents = new Vec3(...GSPLAT_FALLING_PETALS_PRESET.extents);

    petalParticleCount = GSPLAT_FALLING_PETALS_PRESET.petalParticleCount;

    petalTextureUrl = '/textures/petal.png';

    private _petals: GsplatFallingPetals | null = null;

    initialize() {
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this._petals?.hide());
    }

    applyConfig() {
        if (!this._petals) {
            this._petals = createGsplatFallingPetals(this.app, { enabled: false });
        }

        const followEntity = this.followEntity ?? findCameraEntity(this.app.root) ?? this.entity;
        const options = {
            followEntity,
            continuousRender: this.continuousRender,
            opacity: this.opacity,
            color: [...this.color] as [number, number, number],
            extents: [this.extents.x, this.extents.y, this.extents.z] as [number, number, number],
            petalParticleCount: this.petalParticleCount,
            petalTextureUrl: this.petalTextureUrl
        };

        if (this.enabled) {
            this._petals.show(options);
        } else {
            this._petals.setOptions(options);
            this._petals.hide();
        }
    }

    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
    }

    destroy() {
        destroyGsplatFallingPetals(this._petals);
        this._petals = null;
    }
}

export class GsplatPersistentFallingWeather extends Script {
    static scriptName = 'gsplatPersistentFallingWeather';

    effectTime = 0;

    isPaused = false;

    mode: Exclude<GsplatFallingWeatherMode, 'none'> = 'rain';

    followEntity: Entity | null = null;

    continuousRender = true;

    restoreSceneAtmosphere = true;

    extents = new Vec3(12, 12, 12);

    density = 1.5;

    speed = 2;

    drift = 0.4;

    opacity = 0.85;

    color: [number, number, number] = [1, 1, 1];

    particleMinSize = 0.006;

    particleMaxSize = 0.012;

    elongate = 1;

    flutter = 0.12;

    tumble = 0.15;

    angle = 0;

    fogDensity = 0.005;

    fogColor: [number, number, number] = [1, 1, 1];

    exposure = 0.3;

    useFog = true;

    private _weather: GsplatFallingWeather | null = null;

    initialize() {
        this.on('enable', () => this.applyConfig());
        this.on('disable', () => this._weather?.hide());
    }

    setModeDefaults(mode: Exclude<GsplatFallingWeatherMode, 'none'>) {
        this.mode = mode;
        const preset = GSPLAT_FALLING_WEATHER_PRESETS[mode];
        this.speed = preset.speed;
        this.drift = preset.drift;
        this.opacity = preset.opacity;
        this.color = [...preset.color];
        this.particleMinSize = preset.particleMinSize;
        this.particleMaxSize = preset.particleMaxSize;
        this.elongate = preset.elongate;
        this.flutter = preset.flutter;
        this.tumble = preset.tumble;
        this.density = preset.density ?? this.density;
        if (preset.extents) {
            this.extents.set(preset.extents[0], preset.extents[1], preset.extents[2]);
        }
        this.angle = preset.angle ?? this.angle;
        this.fogDensity = preset.fogDensity ?? this.fogDensity;
        this.fogColor = preset.fogColor ? [...preset.fogColor] : this.fogColor;
        this.exposure = preset.exposure ?? this.exposure;
        this.useFog = preset.useFog ?? this.useFog;
    }

    applyConfig() {
        if (!this._weather) {
            this._weather = createGsplatFallingWeather(this.app, { enabled: false });
        }

        const followEntity = this.followEntity ?? findCameraEntity(this.app.root) ?? this.entity;
        const options = {
            followEntity,
            continuousRender: this.continuousRender,
            restoreSceneAtmosphere: this.restoreSceneAtmosphere,
            extents: [this.extents.x, this.extents.y, this.extents.z] as [number, number, number],
            density: this.density,
            speed: this.speed,
            drift: this.drift,
            opacity: this.opacity,
            color: [...this.color] as [number, number, number],
            particleMinSize: this.particleMinSize,
            particleMaxSize: this.particleMaxSize,
            elongate: this.elongate,
            flutter: this.flutter,
            tumble: this.tumble,
            angle: this.angle,
            fogDensity: this.fogDensity,
            fogColor: [...this.fogColor] as [number, number, number],
            exposure: this.exposure,
            useFog: this.useFog
        };

        if (!this.enabled) {
            this._weather.setOptions(options);
            this._weather.hide();
            return;
        }

        if (this.mode === 'rain') {
            this._weather.showRain(options);
        } else {
            this._weather.showSnow(options);
        }
    }

    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
    }

    destroy() {
        destroyGsplatFallingWeather(this._weather);
        this._weather = null;
    }
}
