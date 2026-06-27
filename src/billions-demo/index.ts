import {
    AppBase,
    AppOptions,
    Asset,
    AssetListLoader,
    CameraComponentSystem,
    Color,
    ContainerHandler,
    Entity,
    FILLMODE_FILL_WINDOW,
    GSPLATDATA_COMPACT,
    GSPLAT_DEBUG_LOD,
    GSPLAT_DEBUG_NONE,
    GSPLAT_RENDERER_RASTER_CPU_SORT,
    GSPLAT_RENDERER_RASTER_GPU_SORT,
    GSplatComponent,
    GSplatComponentSystem,
    GSplatHandler,
    Keyboard,
    LightComponentSystem,
    Mouse,
    RESOLUTION_AUTO,
    RenderComponentSystem,
    SKYTYPE_INFINITE,
    ScriptComponentSystem,
    ScriptHandler,
    TextureHandler,
    TONEMAP_LINEAR,
    TouchDevice,
    Vec3,
    createGraphicsDevice,
    math,
    platform,
    type BoundingBox,
    type GraphicsDevice,
    type GSplatResourceBase,
    type Texture
} from 'playcanvas';

import { CylinderController } from './cylinder-controller';

const MAX_INSTANCES = 100;
const DEFAULT_INSTANCES_DESKTOP = 12;
const DEFAULT_INSTANCES_MOBILE = 2;
const DEFAULT_LOD_BASE_DISTANCE = 40;
const DEFAULT_LOD_MULTIPLIER = platform.mobile ? 1.6 : 1.8;

const config = {
    name: 'Poland-village',
    url: 'https://unicity-dev2.bdnrc.org.cn/upload/scene/20260605/yunji/LOD/finland/lod-meta.json', // https://s3.eu-west-1.amazonaws.com/code.playcanvas.com/examples_data/example_poland_02/lod-meta.json
    lodUpdateDistance: 32,
    lodUnderfillLimit: 5,
    cameraPosition: [10.3, 2, -10] as const,
    moveSpeed: 40,
    moveFastSpeed: 1200
};

const layout = {
    maxCols: 4,
    spacingFactor: 0.8
};

const state = {
    instances: platform.mobile ? DEFAULT_INSTANCES_MOBILE : DEFAULT_INSTANCES_DESKTOP,
    lodBaseDistance: DEFAULT_LOD_BASE_DISTANCE,
    lodMultiplier: DEFAULT_LOD_MULTIPLIER,
    colorizeLods: false
};

const canvas = document.getElementById('application-canvas') as HTMLCanvasElement | null;
if (!canvas) {
    throw new Error('Missing #application-canvas');
}

const $ = <T extends HTMLElement>(id: string): T => {
    const el = document.getElementById(id) as T | null;
    if (!el) {
        throw new Error(`Missing #${id}`);
    }
    return el;
};

const ui = {
    instances: $('billions-instances') as HTMLInputElement,
    instancesValue: $('billions-instances-value'),
    lodBase: $('billions-lod-base') as HTMLInputElement,
    lodBaseValue: $('billions-lod-base-value'),
    lodMult: $('billions-lod-mult') as HTMLInputElement,
    lodMultValue: $('billions-lod-mult-value'),
    total: $('billions-total'),
    active: $('billions-active'),
    renderer: $('billions-renderer'),
    lodState: $('billions-lod-state'),
    status: $('billions-status')
};

ui.instances.value = String(state.instances);
ui.instancesValue.textContent = String(state.instances);
ui.lodBase.value = String(state.lodBaseDistance);
ui.lodBaseValue.textContent = String(state.lodBaseDistance);
ui.lodMult.value = String(state.lodMultiplier);
ui.lodMultValue.textContent = state.lodMultiplier.toFixed(2);

const toM = (v: number) => `${(v / 1e6).toFixed(1)}M`;
const toB = (v: number) => `${(v / 1e9).toFixed(1)}B`;

const createApp = async () => {
    const device = await createGraphicsDevice(canvas, {
        deviceTypes: ['webgpu', 'webgl2'],
        antialias: false,
        depth: true,
        powerPreference: 'high-performance'
    });

    const options = new AppOptions();
    options.graphicsDevice = device;
    options.mouse = new Mouse(document.body);
    options.touch = new TouchDevice(document.body);
    options.keyboard = new Keyboard(document.body);
    options.componentSystems = [
        RenderComponentSystem,
        CameraComponentSystem,
        LightComponentSystem,
        ScriptComponentSystem,
        GSplatComponentSystem
    ];
    options.resourceHandlers = [
        TextureHandler,
        ContainerHandler,
        ScriptHandler,
        GSplatHandler
    ];

    const app = new AppBase(canvas);
    app.init(options);
    app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
    app.setCanvasResolution(RESOLUTION_AUTO);

    const applyResolution = () => {
        const dpr = window.devicePixelRatio || 1;
        device.maxPixelRatio = dpr >= 2 ? dpr * 0.5 : dpr;
    };

    const resize = () => {
        applyResolution();
        app.resizeCanvas();
    };

    applyResolution();
    window.addEventListener('resize', resize);
    app.on('destroy', () => window.removeEventListener('resize', resize));

    return { app, device };
};

const applyGsplatDefaults = (app: AppBase, device: GraphicsDevice) => {
    const gsplat = app.scene.gsplat;
    gsplat.lodUpdateAngle = 90;
    gsplat.lodBehindPenalty = 3;
    gsplat.radialSorting = true;
    gsplat.lodUpdateDistance = config.lodUpdateDistance;
    gsplat.lodUnderfillLimit = config.lodUnderfillLimit;
    gsplat.minPixelSize = 2;
    gsplat.alphaClipForward = 1 / 255;
    gsplat.minContribution = 3;
    gsplat.dataFormat = GSPLATDATA_COMPACT;
    gsplat.debug = state.colorizeLods ? GSPLAT_DEBUG_LOD : GSPLAT_DEBUG_NONE;
    gsplat.renderer = device.isWebGPU ? GSPLAT_RENDERER_RASTER_GPU_SORT : GSPLAT_RENDERER_RASTER_CPU_SORT;
};

const loadSceneAsset = (app: AppBase) => new Promise<Asset>((resolve, reject) => {
    const assets = [
        new Asset('gsplat', 'gsplat', { url: config.url })
    ];

    const loader = new AssetListLoader(assets, app.assets);
    loader.load((err: unknown) => {
        if (err) {
            reject(err);
            return;
        }
        resolve(assets[0]);
    });
});

const maybeApplySky = (app: AppBase) => {
    app.scene.sky.type = SKYTYPE_INFINITE;

    const texture = app.assets.find('env-lighting', 'texture')?.resource as Texture | undefined;
    if (texture) {
        app.scene.skybox = texture;
    }
};

const main = async () => {
    window.focus();

    const { app, device } = await createApp();
    applyGsplatDefaults(app, device);

    ui.renderer.textContent = device.isWebGPU ? 'WebGPU gpu-sort' : 'WebGL cpu-sort';

    const sceneAsset = await loadSceneAsset(app);
    app.start();
    maybeApplySky(app);

    const resource = sceneAsset.resource as GSplatResourceBase & {
        aabb: BoundingBox;
        octree?: { lodLevels?: number };
    };
    const aabb = resource.aabb;
    const mn = aabb.getMin();
    const mx = aabb.getMax();
    const spacingX = (mx.x - mn.x) * layout.spacingFactor;
    const spacingZ = (mx.z - mn.z) * layout.spacingFactor;
    const numSplatsPerInstance = Number(resource.numSplats);

    const instanceEntities: Entity[] = [];
    const gsInstances: GSplatComponent[] = [];
    const cols = layout.maxCols;
    const ringSize = Math.ceil(MAX_INSTANCES / cols);
    const offX = (cols - 1) * 0.5 * spacingX;
    const bendRadius = spacingZ * ringSize / (2 * Math.PI);
    const rowOffset = (r: number) => Math.ceil(r / 2) * (r % 2 === 1 ? 1 : -1);

    const layoutForIndex = (idx: number) => {
        const c = Math.floor(idx / ringSize);
        const r = idx % ringSize;
        const x = c * spacingX - offX;
        const s = rowOffset(r) * spacingZ;
        const theta = s / bendRadius;
        const z = bendRadius * Math.sin(theta);
        const y = bendRadius * (1 - Math.cos(theta));
        const eulerX = 180 - theta * math.RAD_TO_DEG;
        return { pos: [x, y, z] as const, eulerX };
    };

    const applyLod = () => {
        for (const gs of gsInstances) {
            gs.lodBaseDistance = state.lodBaseDistance;
            gs.lodMultiplier = state.lodMultiplier;
        }
    };

    const rebuildInstances = () => {
        while (instanceEntities.length < state.instances) {
            const idx = instanceEntities.length;
            const entity = new Entity(`${config.name}-${idx}`);
            entity.addComponent('gsplat', { asset: sceneAsset });
            const { pos, eulerX } = layoutForIndex(idx);
            entity.setLocalEulerAngles(eulerX, 0, 0);
            entity.setLocalPosition(pos[0], pos[1], pos[2]);
            app.root.addChild(entity);
            instanceEntities.push(entity);

            const gs = entity.gsplat as GSplatComponent;
            gs.lodBaseDistance = state.lodBaseDistance;
            gs.lodMultiplier = state.lodMultiplier;
            gsInstances.push(gs);
        }

        while (instanceEntities.length > state.instances) {
            instanceEntities.pop()?.destroy();
            gsInstances.pop();
        }

        ui.total.textContent = toB(numSplatsPerInstance * state.instances);
    };

    rebuildInstances();

    const lodLevels = resource.octree?.lodLevels ?? 1;
    const worstLod = lodLevels - 1;
    for (const gs of gsInstances) {
        gs.lodRangeMin = worstLod;
        gs.lodRangeMax = worstLod;
    }
    ui.lodState.textContent = `${worstLod} only`;

    const gsplatSystem = app.systems.gsplat as GSplatComponentSystem;
    const onFrameReady = (_cam: unknown, _layer: unknown, ready: boolean, loadingCount: number) => {
        if (ready && loadingCount === 0) {
            gsplatSystem.off(GSplatComponentSystem.EVENT_FRAMEREADY, onFrameReady);
            for (const gs of gsInstances) {
                gs.lodRangeMin = 0;
                gs.lodRangeMax = worstLod;
            }
            ui.lodState.textContent = `0-${worstLod}`;
            ui.status.textContent = 'Ready. Hold left mouse and drag to look; WASD/QE move, Shift sprints.';
        } else {
            ui.status.textContent = `Streaming initial LODs (${loadingCount} pending)...`;
        }
    };
    gsplatSystem.on(GSplatComponentSystem.EVENT_FRAMEREADY, onFrameReady);

    const tile0Center = instanceEntities[0].getWorldTransform().transformPoint(
        new Vec3((mn.x + mx.x) * 0.5, (mn.y + mx.y) * 0.5, (mn.z + mx.z) * 0.5),
        new Vec3()
    );

    const camera = new Entity('camera');
    camera.addComponent('camera', {
        clearColor: new Color(0, 0, 0),
        fov: 75,
        toneMapping: TONEMAP_LINEAR,
        farClip: 100000
    });
    const [camX, camY, camZ] = config.cameraPosition;
    camera.setLocalPosition(tile0Center.x + camX, camY, tile0Center.z + camZ);
    app.root.addChild(camera);

    const controller = new CylinderController(app, camera, {
        radius: bendRadius,
        axialStart: tile0Center.x,
        startHeight: camY,
        moveSpeed: config.moveSpeed,
        moveFastSpeed: config.moveFastSpeed,
        moveDamping: 0.997
    });
    app.on('update', (dt: number) => controller.update(dt));
    app.on('destroy', () => controller.destroy());

    ui.instances.addEventListener('input', () => {
        state.instances = Number(ui.instances.value);
        ui.instancesValue.textContent = String(state.instances);
        rebuildInstances();
        applyLod();
    });

    ui.lodBase.addEventListener('input', () => {
        state.lodBaseDistance = Number(ui.lodBase.value);
        ui.lodBaseValue.textContent = String(state.lodBaseDistance);
        applyLod();
    });

    ui.lodMult.addEventListener('input', () => {
        state.lodMultiplier = Number(ui.lodMult.value);
        ui.lodMultValue.textContent = state.lodMultiplier.toFixed(2);
        applyLod();
    });

    app.scene.gsplat.splatBudget = 0;
    app.on('update', () => {
        ui.active.textContent = toM(app.stats.frame.gsplats);
    });
};

main().catch((err: unknown) => {
    console.error(err);
    ui.status.textContent = err instanceof Error ? err.message : String(err);
});
