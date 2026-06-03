import { Entity, FOG_EXP, FOG_EXP2, FOG_LINEAR, Script, Vec3 } from 'playcanvas';

import {
    createGsplatFallingPetals,
    destroyGsplatFallingPetals,
    GSPLAT_FALLING_PETALS_PRESET,
    type GsplatFallingPetals
} from '../../../gsplat-falling-petals';
import {
    createGsplatFallingWeather,
    destroyGsplatFallingWeather,
    GSPLAT_FALLING_WEATHER_PRESETS,
    type GsplatFallingWeather,
    type GsplatFallingWeatherMode
} from '../../../gsplat-falling-weather';

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

    glowColor: [number, number, number] = [...GSPLAT_FALLING_PETALS_PRESET.glowColor];

    glowStrength = GSPLAT_FALLING_PETALS_PRESET.glowStrength;

    glowWidth = GSPLAT_FALLING_PETALS_PRESET.glowWidth;

    extents = new Vec3(...GSPLAT_FALLING_PETALS_PRESET.extents);

    density = GSPLAT_FALLING_PETALS_PRESET.density;

    /** @deprecated Use density. Kept for old persistent configs. */
    petalParticleCount = GSPLAT_FALLING_PETALS_PRESET.petalParticleCount;

    petalTextureUrl = '/textures/petal-atlas.png';

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
            glowColor: [...this.glowColor] as [number, number, number],
            glowStrength: this.glowStrength,
            glowWidth: this.glowWidth,
            extents: [this.extents.x, this.extents.y, this.extents.z] as [number, number, number],
            density: this.density,
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

    extents = new Vec3(12, 12, 24);

    density = 1.5;

    speed = 2;

    drift = 0.4;

    opacity = 0.8;

    globalOpacity = 1;

    farOpacity = 0.4;

    color: [number, number, number] = [1, 1, 1];

    particleMinSize = 0.006;

    particleMaxSize = 0.012;

    elongate = 1;

    flutter = 0;

    tumble = 0;

    angle = 0;

    fogDensity = 0.010;

    fogType: typeof FOG_EXP | typeof FOG_EXP2 | typeof FOG_LINEAR = FOG_EXP;

    fogStart = 0;

    fogEnd = 0;

    fogColor: [number, number, number] = [1, 1, 1];

    exposure = 0.5;

    useFog = true;

    cameraClearColor: [number, number, number] = [0.8, 0.8, 0.8];

    useCameraClearColor = true;

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
        this.globalOpacity = preset.globalOpacity;
        this.farOpacity = preset.farOpacity;
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
        this.fogType = preset.fogType ?? this.fogType;
        this.fogStart = preset.fogStart ?? this.fogStart;
        this.fogEnd = preset.fogEnd ?? this.fogEnd;
        this.fogColor = preset.fogColor ? [...preset.fogColor] : this.fogColor;
        this.exposure = preset.exposure ?? this.exposure;
        this.useFog = preset.useFog ?? this.useFog;
        this.cameraClearColor = preset.cameraClearColor ? [...preset.cameraClearColor] : this.cameraClearColor;
        this.useCameraClearColor = preset.useCameraClearColor ?? this.useCameraClearColor;
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
            globalOpacity: this.globalOpacity,
            farOpacity: this.farOpacity,
            color: [...this.color] as [number, number, number],
            particleMinSize: this.particleMinSize,
            particleMaxSize: this.particleMaxSize,
            elongate: this.elongate,
            flutter: this.flutter,
            tumble: this.tumble,
            angle: this.angle,
            fogDensity: this.fogDensity,
            fogType: this.fogType,
            fogStart: this.fogStart,
            fogEnd: this.fogEnd,
            fogColor: [...this.fogColor] as [number, number, number],
            exposure: this.exposure,
            useFog: this.useFog,
            cameraClearColor: [...this.cameraClearColor] as [number, number, number],
            useCameraClearColor: this.useCameraClearColor
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
