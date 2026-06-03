import {
    BoundingBox,
    Color,
    Entity,
    FOG_EXP,
    FOG_EXP2,
    FOG_LINEAR,
    FOG_NONE,
    GSplatContainer,
    GSplatFormat,
    Layer,
    PIXELFORMAT_RGBA8,
    Script,
    Vec3,
    type AppBase
} from 'playcanvas';

export type GsplatFallingWeatherMode = 'rain' | 'snow' | 'none';

export interface GsplatFallingWeatherPreset {
    speed: number;
    drift: number;
    opacity: number;
    globalOpacity: number;
    farOpacity: number;
    color: [number, number, number];
    particleMinSize: number;
    particleMaxSize: number;
    elongate: number;
    flutter: number;
    tumble: number;
    density?: number;
    extents?: [number, number, number];
    angle?: number;
    fogDensity?: number;
    fogType?: typeof FOG_EXP | typeof FOG_EXP2 | typeof FOG_LINEAR;
    fogStart?: number;
    fogEnd?: number;
    fogColor?: [number, number, number];
    exposure?: number;
    useFog?: boolean;
    cameraClearColor?: [number, number, number];
    useCameraClearColor?: boolean;
}

export interface GsplatFallingWeatherOptions extends Partial<GsplatFallingWeatherPreset> {
    mode?: GsplatFallingWeatherMode;
    enabled?: boolean;
    followEntity?: Entity | null;
    continuousRender?: boolean;
    restoreSceneAtmosphere?: boolean;
}

const WEATHER_PRESETS: Record<Exclude<GsplatFallingWeatherMode, 'none'>, GsplatFallingWeatherPreset> = {
    snow: {
        speed: 2.0,
        drift: 0.4,
        opacity: 0.85,
        globalOpacity: 1.0,
        farOpacity: 0.4,
        color: [1, 1, 1],
        particleMinSize: 0.006,
        particleMaxSize: 0.012,
        elongate: 1.0,
        flutter: 0.0,
        tumble: 0.0,
        density: 1.5,
        extents: [12, 12, 24],
        angle: 0,
        fogDensity: 0.010,
        fogType: FOG_EXP,
        fogStart: 0,
        fogEnd: 0,
        fogColor: [1, 1, 1],
        exposure: 0.5,
        useFog: true,
        cameraClearColor: [0.8, 0.8, 0.8],
        useCameraClearColor: true
    },
    rain: {
        speed: 10,
        drift: 0.02,
        opacity: 0.65,
        globalOpacity: 1.0,
        farOpacity: 0.4,
        color: [0.812, 0.812, 0.812],
        particleMinSize: 0.003,
        particleMaxSize: 0.003,
        elongate: 20,
        flutter: 0.0,
        tumble: 0.0,
        density: 1.5,
        extents: [12, 12, 24],
        angle: 0,
        fogDensity: 0.010,
        fogType: FOG_EXP,
        fogStart: 0,
        fogEnd: 0,
        fogColor: [1, 1, 1],
        exposure: 0.5,
        useFog: true,
        cameraClearColor: [0.8, 0.8, 0.8],
        useCameraClearColor: true
    }
};

/** 雨雪 gsplat 专用层，与场景 World 材质隔离 */
const WEATHER_GSPLAT_LAYER_NAME = 'GsplatCameraWeather';

let weatherGsplatLayerId: number | null = null;

type WeatherCameraLayers = { layers: number[] };

type WeatherApp = AppBase & {
    __global?: { camera?: { camera?: WeatherCameraLayers } };
    viewer?: { cameraFrame?: { enabled?: boolean; update: () => void } };
};

function getOrCreateWeatherGsplatLayer(app: AppBase): number {
    if (weatherGsplatLayerId != null) {
        return weatherGsplatLayerId;
    }

    const layers = app.scene.layers;
    let layer = layers.getLayerByName(WEATHER_GSPLAT_LAYER_NAME);
    if (!layer) {
        const world = layers.getLayerByName('World');
        layer = new Layer({ name: WEATHER_GSPLAT_LAYER_NAME });
        if (world) {
            layers.insert(layer, layers.getTransparentIndex(world) + 1);
        } else {
            layers.push(layer);
        }
    }
    weatherGsplatLayerId = layer.id;
    return weatherGsplatLayerId;
}

/** 确保相机渲染雨雪层；layer 有变更时触发 CameraFrame 重建 */
function syncWeatherGsplatRenderLayer(app: AppBase): number {
    const layerId = getOrCreateWeatherGsplatLayer(app);
    let patched = false;

    const addLayer = (cam: WeatherCameraLayers) => {
        if (cam.layers.indexOf(layerId) >= 0) {
            return;
        }
        cam.layers = [...cam.layers, layerId];
        patched = true;
    };

    const appEx = app as WeatherApp;
    const mainCam = appEx.__global?.camera?.camera;
    if (mainCam) {
        addLayer(mainCam);
    } else {
        const found = app.root.findComponent('camera') as { camera?: WeatherCameraLayers } | null;
        if (found?.camera) {
            addLayer(found.camera);
        }
    }

    for (const { camera } of app.scene.layers.cameras) {
        addLayer(camera);
    }

    if (patched) {
        const cf = appEx.viewer?.cameraFrame;
        if (cf?.enabled) {
            cf.update();
            app.renderNextFrame = true;
        }
    }

    return layerId;
}

export class GsplatFallingWeather extends Script {
    static scriptName = 'gsplatFallingWeather';

    extents = new Vec3(12, 12, 24);

    density = 2;

    followEntity: Entity | null = null;

    mode: GsplatFallingWeatherMode = 'none';

    speed = 1.0;

    drift = 0.15;

    opacity = 0.8;

    globalOpacity = 1.0;

    farOpacity = 0.4;

    color: [number, number, number] = [1, 1, 1];

    particleMinSize = 0.006;

    particleMaxSize = 0.012;

    elongate = 1.0;

    flutter = 0.0;

    tumble = 0.0;

    fogDensity = 0;

    fogType: typeof FOG_EXP | typeof FOG_EXP2 | typeof FOG_LINEAR = FOG_EXP;

    fogStart = 0;

    fogEnd = 0;

    fogColor: [number, number, number] = [1, 1, 1];

    exposure = 1;

    useFog = true;

    cameraClearColor: [number, number, number] = [0.6, 0.65, 0.75];

    useCameraClearColor = true;

    restoreSceneAtmosphere = true;

    continuousRender = true;

    private _container: GSplatContainer | null = null;

    private _format: GSplatFormat | null = null;

    private _time = 0;

    private _baseCellArray = [0, 0, 0];

    private _camPosArray = [0, 0, 0];

    private _gridHalfArray = [0, 0, 0];

    private _particleSizeArray = [0, 0];

    private _savedAppAutoRender: boolean | undefined;

    private _autoRenderOverridden = false;

    private _sceneAtmosphereSnapshot: {
        fogType: typeof FOG_NONE | typeof FOG_EXP | typeof FOG_EXP2 | typeof FOG_LINEAR | string;
        fogDensity: number;
        fogStart: number;
        fogEnd: number;
        fogColor: Color;
        exposure: number;
        cameraClearColor?: Color;
        gsplatUseFog?: boolean;
    } | null = null;

    get cellSize() {
        return 1 / Math.max(this.density, 0.1);
    }

    get numParticles() {
        const hx = this._halfCells(this.extents.x);
        const hy = this._halfCells(this.extents.y);
        const hz = this._halfCells(this.extents.z);
        return hx * 2 * hy * 2 * hz * 2;
    }

    initialize() {
        this._format = new GSplatFormat(this.app.graphicsDevice, [
            { name: 'data', format: PIXELFORMAT_RGBA8 }
        ], {
            readGLSL: /* glsl */`
                uniform float uTime;
                uniform float uCellSize;
                uniform vec3 uGridHalf;
                uniform vec3 uBaseCell;
                uniform vec3 uCameraPos;
                uniform float uSpeed;
                uniform float uDrift;
                uniform float uOpacity;
                uniform float uGlobalOpacity;
                uniform float uFarOpacity;
                uniform vec3 uColor;
                uniform vec2 uParticleSize;
                uniform float uElongate;
                uniform float uFlutter;
                uniform float uTumble;

                vec3 weatherLocalPos;
                vec3 weatherWC;
                vec4 sd;

                float weatherHash(vec3 p) {
                    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
                }

                vec3 getCenter() {
                    sd = loadData();

                    float dx = floor(sd.r * 255.0 + 0.5) - uGridHalf.x;
                    float dz = floor(sd.b * 255.0 + 0.5) - uGridHalf.z;
                    float dy = floor(sd.g * 255.0 + 0.5);

                    vec3 worldCell = uBaseCell + vec3(dx, dy - uGridHalf.y, dz);
                    weatherWC = worldCell;

                    vec3 col = vec3(worldCell.x, 0.0, worldCell.z);

                    float fx = weatherHash(col + vec3(1.0, 0.0, 0.0));
                    float fz = weatherHash(col + vec3(0.0, 0.0, 3.0));

                    fx += (weatherHash(worldCell + vec3(4.0, 0.0, 0.0)) - 0.5) * 0.4;
                    fz += (weatherHash(worldCell + vec3(0.0, 0.0, 5.0)) - 0.5) * 0.4;

                    float spd = mix(0.3, 0.8, weatherHash(col)) * uSpeed;
                    float gridYf = uGridHalf.y * 2.0;
                    float colY = (dy + weatherHash(worldCell + vec3(0.0, 2.0, 0.0))) / gridYf;
                    colY = fract(colY - uTime * spd / gridYf);

                    float phase = weatherHash(col + vec3(7.0, 0.0, 0.0)) * 6.28318;
                    float flutterWave = sin(uTime * mix(0.8, 2.4, weatherHash(worldCell + 9.0)) + phase) * uFlutter;
                    fx += sin(uTime * 0.8 + phase) * uDrift + flutterWave;
                    fz += cos(uTime * 0.6 + phase) * uDrift + cos(uTime * 1.3 + phase) * uFlutter * 0.55;

                    weatherLocalPos = vec3(
                        (dx + fx) * uCellSize,
                        (-uGridHalf.y + colY * gridYf) * uCellSize,
                        (dz + fz) * uCellSize
                    );
                    return weatherLocalPos;
                }

                vec4 getColor() {
                    vec3 camOffset = uCameraPos - uBaseCell * uCellSize;
                    float dist = length(weatherLocalPos - camOffset);
                    float maxDist = min(uGridHalf.x, uGridHalf.z) * uCellSize * 0.9;
                    float fade = 1.0 - smoothstep(maxDist * 0.6, maxDist, dist);
                    float distanceOpacity = mix(clamp(uFarOpacity, 0.0, 1.0), 1.0, fade);
                    float alpha = mix(0.5, 0.9, weatherHash(weatherWC + 20.0)) * distanceOpacity * uOpacity * uGlobalOpacity;
                    return vec4(uColor, alpha);
                }

                vec3 getScale() {
                    float size = mix(uParticleSize.x, uParticleSize.y, weatherHash(weatherWC + 10.0));
                    return vec3(size, max(size * uElongate, 0.0001), size);
                }

                vec4 getRotation() {
                    float spinMask = step(0.001, uTumble);
                    float angle = (weatherHash(weatherWC + 50.0) * 6.28318 + sin(uTime * 2.0 + weatherHash(weatherWC + 60.0) * 6.28318) * uTumble) * spinMask;
                    float halfAngle = angle * 0.5;
                    return vec4(0.0, 0.0, sin(halfAngle), cos(halfAngle));
                }
            `,
            readWGSL: /* wgsl */`
                uniform uTime: f32;
                uniform uCellSize: f32;
                uniform uGridHalf: vec3f;
                uniform uBaseCell: vec3f;
                uniform uCameraPos: vec3f;
                uniform uSpeed: f32;
                uniform uDrift: f32;
                uniform uOpacity: f32;
                uniform uGlobalOpacity: f32;
                uniform uFarOpacity: f32;
                uniform uColor: vec3f;
                uniform uParticleSize: vec2f;
                uniform uElongate: f32;
                uniform uFlutter: f32;
                uniform uTumble: f32;

                var<private> weatherLocalPos: vec3f;
                var<private> weatherWC: vec3f;
                var<private> sd: vec4f;

                fn weatherHash(p: vec3f) -> f32 {
                    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
                }

                fn getCenter() -> vec3f {
                    sd = loadData();

                    let dx = floor(sd.r * 255.0 + 0.5) - uniform.uGridHalf.x;
                    let dz = floor(sd.b * 255.0 + 0.5) - uniform.uGridHalf.z;
                    let dy = floor(sd.g * 255.0 + 0.5);

                    let worldCell = uniform.uBaseCell + vec3f(dx, dy - uniform.uGridHalf.y, dz);
                    weatherWC = worldCell;

                    let col = vec3f(worldCell.x, 0.0, worldCell.z);

                    var fx = weatherHash(col + vec3f(1.0, 0.0, 0.0));
                    var fz = weatherHash(col + vec3f(0.0, 0.0, 3.0));

                    fx = fx + (weatherHash(worldCell + vec3f(4.0, 0.0, 0.0)) - 0.5) * 0.4;
                    fz = fz + (weatherHash(worldCell + vec3f(0.0, 0.0, 5.0)) - 0.5) * 0.4;

                    let spd = mix(0.3, 0.8, weatherHash(col)) * uniform.uSpeed;
                    let gridYf = uniform.uGridHalf.y * 2.0;
                    var colY = (dy + weatherHash(worldCell + vec3f(0.0, 2.0, 0.0))) / gridYf;
                    colY = fract(colY - uniform.uTime * spd / gridYf);

                    let phase = weatherHash(col + vec3f(7.0, 0.0, 0.0)) * 6.28318;
                    let flutterWave = sin(uniform.uTime * mix(0.8, 2.4, weatherHash(worldCell + 9.0)) + phase) * uniform.uFlutter;
                    fx = fx + sin(uniform.uTime * 0.8 + phase) * uniform.uDrift + flutterWave;
                    fz = fz + cos(uniform.uTime * 0.6 + phase) * uniform.uDrift + cos(uniform.uTime * 1.3 + phase) * uniform.uFlutter * 0.55;

                    weatherLocalPos = vec3f(
                        (dx + fx) * uniform.uCellSize,
                        (-uniform.uGridHalf.y + colY * gridYf) * uniform.uCellSize,
                        (dz + fz) * uniform.uCellSize
                    );
                    return weatherLocalPos;
                }

                fn getColor() -> vec4f {
                    let camOffset = uniform.uCameraPos - uniform.uBaseCell * uniform.uCellSize;
                    let dist = length(weatherLocalPos - camOffset);
                    let maxDist = min(uniform.uGridHalf.x, uniform.uGridHalf.z) * uniform.uCellSize * 0.9;
                    let fade = 1.0 - smoothstep(maxDist * 0.6, maxDist, dist);
                    let distanceOpacity = mix(clamp(uniform.uFarOpacity, 0.0, 1.0), 1.0, fade);
                    let alpha = mix(0.5, 0.9, weatherHash(weatherWC + 20.0)) * distanceOpacity * uniform.uOpacity * uniform.uGlobalOpacity;
                    return vec4f(uniform.uColor, alpha);
                }

                fn getScale() -> vec3f {
                    let size = mix(uniform.uParticleSize.x, uniform.uParticleSize.y, weatherHash(weatherWC + 10.0));
                    return vec3f(size, max(size * uniform.uElongate, 0.0001), size);
                }

                fn getRotation() -> vec4f {
                    let spinMask = step(0.001, uniform.uTumble);
                    let angle = (weatherHash(weatherWC + 50.0) * 6.28318 + sin(uniform.uTime * 2.0 + weatherHash(weatherWC + 60.0) * 6.28318) * uniform.uTumble) * spinMask;
                    let halfAngle = angle * 0.5;
                    return vec4f(0.0, 0.0, sin(halfAngle), cos(halfAngle));
                }
            `
        });

        this.on('enable', () => this.syncContinuousRender());
        this.on('disable', () => this.disarmContinuousRender());
        this.app.on('update', this._onAppUpdate);
        this.syncContinuousRender();
    }

    setOptions(options: GsplatFallingWeatherOptions = {}) {
        let gridChanged = false;

        if (options.followEntity !== undefined) this.followEntity = options.followEntity;
        if (options.continuousRender !== undefined) this.continuousRender = options.continuousRender;
        if (options.restoreSceneAtmosphere !== undefined) this.restoreSceneAtmosphere = options.restoreSceneAtmosphere;
        if (options.extents) {
            gridChanged = this.extents.x !== options.extents[0] ||
                this.extents.y !== options.extents[1] ||
                this.extents.z !== options.extents[2];
            this.extents.set(options.extents[0], options.extents[1], options.extents[2]);
        }
        if (options.density !== undefined) {
            gridChanged = gridChanged || this.density !== options.density;
            this.density = options.density;
        }
        if (options.speed !== undefined) this.speed = options.speed;
        if (options.drift !== undefined) this.drift = options.drift;
        if (options.opacity !== undefined) this.opacity = options.opacity;
        if (options.globalOpacity !== undefined) this.globalOpacity = options.globalOpacity;
        if (options.farOpacity !== undefined) this.farOpacity = options.farOpacity;
        if (options.color) this.color = [...options.color];
        if (options.particleMinSize !== undefined) this.particleMinSize = options.particleMinSize;
        if (options.particleMaxSize !== undefined) this.particleMaxSize = options.particleMaxSize;
        if (options.elongate !== undefined) this.elongate = options.elongate;
        if (options.flutter !== undefined) this.flutter = options.flutter;
        if (options.tumble !== undefined) this.tumble = options.tumble;
        if (options.fogDensity !== undefined) this.fogDensity = options.fogDensity;
        if (options.fogType === FOG_EXP || options.fogType === FOG_EXP2 || options.fogType === FOG_LINEAR) this.fogType = options.fogType;
        if (options.fogStart !== undefined) this.fogStart = options.fogStart;
        if (options.fogEnd !== undefined) this.fogEnd = options.fogEnd;
        if (options.fogColor) this.fogColor = [...options.fogColor];
        if (options.exposure !== undefined) this.exposure = options.exposure;
        if (options.useFog !== undefined) this.useFog = options.useFog;
        if (options.cameraClearColor) this.cameraClearColor = [...options.cameraClearColor];
        if (options.useCameraClearColor !== undefined) this.useCameraClearColor = options.useCameraClearColor;
        if (options.angle !== undefined) this.entity.setLocalEulerAngles(options.angle, 0, 0);
        if (options.enabled !== undefined) this.enabled = options.enabled;
        if (this.enabled && (!this._container || gridChanged)) {
            this.rebuild();
        }
        this.syncSceneAtmosphere();
        this.syncContinuousRender();
    }

    show(mode: GsplatFallingWeatherMode, options: GsplatFallingWeatherOptions = {}) {
        if (mode === 'none') {
            this.hide();
            return;
        }

        this.mode = mode;
        this.setOptions({
            ...WEATHER_PRESETS[mode],
            ...options,
            enabled: options.enabled ?? true
        });
        this.syncModeRenderer();
    }

    showRain(options: GsplatFallingWeatherOptions = {}) {
        this.show('rain', options);
    }

    showSnow(options: GsplatFallingWeatherOptions = {}) {
        this.show('snow', options);
    }

    hide() {
        this.mode = 'none';
        this.enabled = false;
        this.syncModeRenderer();
        this.restoreAtmosphereSnapshot();
        this.syncContinuousRender();
    }

    rebuild() {
        this._buildContainer();
    }

    update(_dt: number) {
    }

    private _onAppUpdate = (dt: number) => {
        if (!this.enabled) {
            return;
        }

        syncWeatherGsplatRenderLayer(this.app);

        this._time += dt;

        const cs = this.cellSize;
        const target = this.followEntity ?? this.entity;
        const pos = target.getPosition();
        const camX = pos.x;
        const camY = pos.y;
        const camZ = pos.z;

        const bcX = Math.floor(camX / cs);
        const bcY = Math.floor(camY / cs);
        const bcZ = Math.floor(camZ / cs);

        this.entity.setPosition(bcX * cs, bcY * cs, bcZ * cs);
        if (!this._container || !this.entity.gsplat) {
            return;
        }

        this._baseCellArray[0] = bcX;
        this._baseCellArray[1] = bcY;
        this._baseCellArray[2] = bcZ;

        this._camPosArray[0] = camX;
        this._camPosArray[1] = camY;
        this._camPosArray[2] = camZ;

        this._gridHalfArray[0] = this._halfCells(this.extents.x);
        this._gridHalfArray[1] = this._halfCells(this.extents.y);
        this._gridHalfArray[2] = this._halfCells(this.extents.z);

        this._particleSizeArray[0] = this.particleMinSize;
        this._particleSizeArray[1] = this.particleMaxSize;

        const gs = this.entity.gsplat;
        gs.setParameter('uTime', this._time);
        gs.setParameter('uCellSize', cs);
        gs.setParameter('uGridHalf', this._gridHalfArray);
        gs.setParameter('uBaseCell', this._baseCellArray);
        gs.setParameter('uCameraPos', this._camPosArray);
        gs.setParameter('uSpeed', this.speed);
        gs.setParameter('uDrift', this.drift);
        gs.setParameter('uOpacity', this.opacity);
        gs.setParameter('uGlobalOpacity', this.globalOpacity);
        gs.setParameter('uFarOpacity', this.farOpacity);
        gs.setParameter('uColor', this.color);
        gs.setParameter('uParticleSize', this._particleSizeArray);
        gs.setParameter('uElongate', this.elongate);
        gs.setParameter('uFlutter', this.flutter);
        gs.setParameter('uTumble', this.tumble);
    };

    destroy() {
        this.app.off('update', this._onAppUpdate);
        this.disarmContinuousRender();
        this.restoreAtmosphereSnapshot();
        if (this._container) {
            this._container.destroy();
            this._container = null;
        }
    }

    private _halfCells(extent: number) {
        return Math.min(128, Math.max(1, Math.floor(extent * Math.max(this.density, 0.1))));
    }

    private _buildContainer() {
        if (!this._format) {
            return;
        }

        if (this._container) {
            this._container.destroy();
            this._container = null;
        }

        const device = this.app.graphicsDevice;
        const halfX = this._halfCells(this.extents.x);
        const halfY = this._halfCells(this.extents.y);
        const halfZ = this._halfCells(this.extents.z);
        const gridX = halfX * 2;
        const gridY = halfY * 2;
        const gridZ = halfZ * 2;
        const cs = this.cellSize;
        const maxSplats = gridX * gridY * gridZ;

        this._container = new GSplatContainer(device, maxSplats, this._format);

        const texData = this._container.getTexture('data').lock();
        const centers = this._container.centers;
        let idx = 0;
        for (let x = 0; x < gridX; x++) {
            for (let y = 0; y < gridY; y++) {
                for (let z = 0; z < gridZ; z++) {
                    texData[idx * 4 + 0] = x;
                    texData[idx * 4 + 1] = y;
                    texData[idx * 4 + 2] = z;
                    texData[idx * 4 + 3] = Math.random() * 255;

                    centers[idx * 3 + 0] = (x - halfX + 0.5) * cs;
                    centers[idx * 3 + 1] = (y - halfY + 0.5) * cs;
                    centers[idx * 3 + 2] = (z - halfZ + 0.5) * cs;
                    idx++;
                }
            }
        }
        this._container.getTexture('data').unlock();

        this._container.aabb = new BoundingBox(Vec3.ZERO, new Vec3(halfX * cs, halfY * cs, halfZ * cs));
        this._container.update(maxSplats, true);

        const weatherLayerId = syncWeatherGsplatRenderLayer(this.app);

        if (!this.entity.gsplat) {
            this.entity.addComponent('gsplat', {
                resource: this._container,
                unified: true,
                layers: [weatherLayerId]
            });
        } else {
            this.entity.gsplat.resource = this._container;
            this.entity.gsplat.layers = [weatherLayerId];
        }
    }

    private syncModeRenderer() {
        if (this.entity.gsplat) {
            this.entity.gsplat.enabled = this.enabled;
        }
    }

    private syncSceneAtmosphere() {
        if (!this.enabled || this.mode === 'none') {
            return;
        }

        this.captureAtmosphereSnapshot();

        const scene = this.app.scene;
        const fogType = this.getEffectiveFogType();
        const fogRange = this.getEffectiveLinearFogRange();
        const wantFog = this.useFog && this.fogDensity > 0 && (fogType === FOG_LINEAR ? fogRange.end > fogRange.start : true);
        scene.fog.type = wantFog ? fogType : FOG_NONE;
        scene.fog.density = wantFog ? this.getEffectiveFogDensity() : 0;
        scene.fog.start = fogRange.start;
        scene.fog.end = fogRange.end;
        const fogColor = this.getEffectiveFogColor();
        scene.fog.color.set(fogColor[0], fogColor[1], fogColor[2]);
        scene.exposure = this.exposure;

        const gsplatScene = (scene as any).gsplat;
        if (gsplatScene && gsplatScene.useFog !== undefined) {
            gsplatScene.useFog = wantFog;
        }
        if (gsplatScene?.material?.update) {
            gsplatScene.material.update();
        }

        const camera = this.getFollowCameraComponent();
        if (camera && this.useCameraClearColor) {
            camera.clearColor.set(this.cameraClearColor[0], this.cameraClearColor[1], this.cameraClearColor[2]);
        }

        this.app.renderNextFrame = true;
    }

    private captureAtmosphereSnapshot() {
        if (!this.restoreSceneAtmosphere || this._sceneAtmosphereSnapshot) {
            return;
        }

        const scene = this.app.scene;
        const gsplatScene = (scene as any).gsplat;
        const camera = this.getFollowCameraComponent();
        this._sceneAtmosphereSnapshot = {
            fogType: scene.fog.type,
            fogDensity: scene.fog.density,
            fogStart: scene.fog.start,
            fogEnd: scene.fog.end,
            fogColor: scene.fog.color.clone(),
            exposure: scene.exposure,
            cameraClearColor: camera?.clearColor?.clone?.(),
            gsplatUseFog: gsplatScene?.useFog
        };
    }

    private restoreAtmosphereSnapshot() {
        const snapshot = this._sceneAtmosphereSnapshot;
        if (!snapshot) {
            return;
        }

        const scene = this.app.scene;
        scene.fog.type = snapshot.fogType as any;
        scene.fog.density = snapshot.fogDensity;
        scene.fog.start = snapshot.fogStart;
        scene.fog.end = snapshot.fogEnd;
        scene.fog.color.copy(snapshot.fogColor);
        scene.exposure = snapshot.exposure;

        const gsplatScene = (scene as any).gsplat;
        if (gsplatScene && snapshot.gsplatUseFog !== undefined) {
            gsplatScene.useFog = snapshot.gsplatUseFog;
        }
        if (gsplatScene?.material?.update) {
            gsplatScene.material.update();
        }
        const camera = this.getFollowCameraComponent();
        if (camera && snapshot.cameraClearColor) {
            camera.clearColor.copy(snapshot.cameraClearColor);
        }

        this._sceneAtmosphereSnapshot = null;
        this.app.renderNextFrame = true;
    }

    private getFollowCameraComponent() {
        const target = this.followEntity ?? this.entity;
        return (target as any).camera ?? null;
    }

    private getEffectiveFogType() {
        return this.fogType;
    }

    private getEffectiveLinearFogRange() {
        const start = Math.max(0, this.fogStart);
        const visibility = this.getEffectiveLinearFogVisibility();
        return {
            start,
            end: start + visibility
        };
    }

    private getEffectiveLinearFogVisibility() {
        const referenceDensity = this.mode === 'rain' ? 0.0018 : 0.0025;
        const baseVisibility = Math.max(this.fogEnd, this.mode === 'rain' ? 420 : 360);
        const density = Math.max(this.fogDensity, 0.0001);
        const densityScale = Math.sqrt(Math.min(Math.max(density / referenceDensity, 0.05), 16));
        return Math.min(1200, Math.max(180, baseVisibility / densityScale));
    }

    private getEffectiveFogDensity() {
        const density = Math.max(this.fogDensity, 0);
        return density;
    }

    private getEffectiveFogColor(): [number, number, number] {
        return [
            Number.isFinite(this.fogColor[0]) ? this.fogColor[0] : 1,
            Number.isFinite(this.fogColor[1]) ? this.fogColor[1] : 1,
            Number.isFinite(this.fogColor[2]) ? this.fogColor[2] : 1
        ];
    }

    private syncContinuousRender() {
        const wantContinuous = this.enabled && this.continuousRender;
        if (wantContinuous && !this._autoRenderOverridden) {
            this._savedAppAutoRender = this.app.autoRender;
            this.app.autoRender = true;
            this._autoRenderOverridden = true;
            return;
        }

        if (!wantContinuous && this._autoRenderOverridden) {
            this.disarmContinuousRender();
        }
    }

    private disarmContinuousRender() {
        if (!this._autoRenderOverridden) {
            return;
        }
        if (this._savedAppAutoRender !== undefined) {
            this.app.autoRender = this._savedAppAutoRender;
        }
        this._savedAppAutoRender = undefined;
        this._autoRenderOverridden = false;
    }
}

export function createGsplatFallingWeather(app: AppBase, options: GsplatFallingWeatherOptions = {}) {
    const entity = new Entity('gsplat falling weather');
    entity.addComponent('script');
    app.root.addChild(entity);

    const script = entity.script!.create(GsplatFallingWeather) as unknown as GsplatFallingWeather;
    script.setOptions({ enabled: false, ...options });
    if (options.mode && options.mode !== 'none') {
        script.show(options.mode, options);
    }
    return script;
}

export function destroyGsplatFallingWeather(script: GsplatFallingWeather | null | undefined) {
    const entity = script?.entity;
    if (!entity) {
        return;
    }
    entity.destroy();
}

export { WEATHER_PRESETS as GSPLAT_FALLING_WEATHER_PRESETS };
