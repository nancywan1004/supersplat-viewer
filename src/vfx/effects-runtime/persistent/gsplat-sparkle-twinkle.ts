import {
    BLEND_ADDITIVE,
    Color,
    CULLFACE_NONE,
    Entity,
    GSplatData,
    Layer,
    Mat4,
    Mesh,
    MeshInstance,
    PRIMITIVE_TRIANGLES,
    Script,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    SEMANTIC_TEXCOORD1,
    ShaderMaterial,
    Vec3,
    type AppBase,
    type BoundingBox,
    type GraphicsDevice
} from 'playcanvas';
import { fragmentShaderGLSL, shaderGLSL } from './gsplat-sparkle-twinkle-shaders';
import type { Global } from '../../../types';

const SPARKLE_LAYER_NAME = 'SparkleAfterGsplat';
const OVERLAY_ROOT_NAME = 'sparkleTwinkleOverlay';
const SCENE_REF_RADIUS = 25;
const DENSITY_SPACING_BASE = 0.28;
const DENSITY_COVERAGE_CAP = 0.45;
const MAX_SPARKLES = 6000;
const SOURCE_SCAN_STRIDE_THRESHOLD = 120000;
const MOUNT_RETRY_INTERVAL = 0.2;

const QUAD_CORNERS: ReadonlyArray<readonly [number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
];

const _invWorld = new Mat4();
const _samplingCenter = new Vec3();

let sparkleLayerId: number | null = null;

type AppWithExtras = AppBase & {
    viewer?: { cameraFrame?: { enabled?: boolean; update: () => void } };
    __global?: Global;
};

type GsplatBboxSource = {
    customAabb?: BoundingBox;
    resource?: { aabb?: BoundingBox };
} | null | undefined;

type CameraLayers = { layers: number[] };

/** 脚本初始属性默认值（与 settings `effectParams` 未指定时一致） */
export const SPARKLE_TWINKLE_DEFAULTS = {
    center: [0, 0, 0] as [number, number, number],
    pointSize: 0.02,
    sparkleDensity: 0.5,
    twinkleSpeed: 5,
    twinkleMin: 0,
    twinkleSharpness: 3,
    brightness: 2,
    lightTint1: [1, 1, 1] as [number, number, number],
    lightTint2: [0.2, 1, 1] as [number, number, number],
    lightTint3: [0.2, 0.5, 1] as [number, number, number],
    colorBlendMode:true
} as const;

function getOrCreateSparkleLayer(app: AppBase): number {
    if (sparkleLayerId != null) {
        return sparkleLayerId;
    }
    const layers = app.scene.layers;
    let layer = layers.getLayerByName(SPARKLE_LAYER_NAME);
    if (!layer) {
        const world = layers.getLayerByName('World');
        layer = new Layer({ name: SPARKLE_LAYER_NAME });
        if (world) {
            layers.insert(layer, layers.getTransparentIndex(world) + 1);
        } else {
            layers.push(layer);
        }
    }
    sparkleLayerId = layer.id;
    return sparkleLayerId;
}

/** 确保 Sparkle 渲染层在相机列表中；有变更时触发 CameraFrame 重建 */
function syncSparkleRenderLayer(app: AppBase): number {
    const layerId = getOrCreateSparkleLayer(app);
    let patched = false;

    const addLayer = (cam: CameraLayers) => {
        if (cam.layers.indexOf(layerId) >= 0) {
            return;
        }
        cam.layers = [...cam.layers, layerId];
        patched = true;
    };

    const mainCam = (app as AppWithExtras).__global?.camera?.camera as CameraLayers | undefined;
    if (mainCam) {
        addLayer(mainCam);
    } else {
        const found = app.root.findComponent('camera') as { camera?: CameraLayers } | null;
        if (found?.camera) {
            addLayer(found.camera);
        }
    }
    for (const { camera } of app.scene.layers.cameras) {
        addLayer(camera);
    }

    if (patched) {
        const cf = (app as AppWithExtras).viewer?.cameraFrame;
        if (cf?.enabled) {
            cf.update();
            app.renderNextFrame = true;
        }
    }
    return layerId;
}

function modelCenterForSampling(center: Vec3, gsplatEntity: Entity, out: Vec3): void {
    const unified = !!(gsplatEntity.gsplat as { unified?: boolean } | undefined)?.unified;
    if (!unified) {
        out.copy(center);
        return;
    }
    _invWorld.copy(gsplatEntity.getWorldTransform()).invert();
    _invWorld.transformPoint(center, out);
}

function readSceneBboxRadius(gsplat: GsplatBboxSource): number {
    const aabb = gsplat?.customAabb ?? gsplat?.resource?.aabb;
    if (!aabb?.halfExtents) {
        return SCENE_REF_RADIUS;
    }
    const h = aabb.halfExtents;
    let radius = Math.max(h.x, h.y, h.z);
    if (!Number.isFinite(radius) || radius < 1e-6) {
        radius = h.length();
    }
    return Number.isFinite(radius) && radius > 1e-6 ? radius : SCENE_REF_RADIUS;
}

function splatHash(x: number, y: number, z: number): number {
    const d = x * 127.1 + y * 311.7 + z * 74.7;
    const v = Math.sin(d) * 43758.5453;
    return v - Math.floor(v);
}

function splitCenters(centers: Float32Array): [Float32Array, Float32Array, Float32Array] | null {
    if (centers.length < 3) {
        return null;
    }
    const n = Math.floor(centers.length / 3);
    if (n === 0) {
        return null;
    }
    const x = new Float32Array(n);
    const y = new Float32Array(n);
    const z = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const b = i * 3;
        x[i] = centers[b];
        y[i] = centers[b + 1];
        z[i] = centers[b + 2];
    }
    return [x, y, z];
}

function resolveSparkleSourcePositions(
    entity: Entity,
    app: AppBase
): [Float32Array, Float32Array, Float32Array] | null {
    const gsplat = entity.gsplat as {
        resource?: { centers?: Float32Array; gsplatData?: GSplatData };
        instance?: { resource?: { centers?: Float32Array; gsplatData?: GSplatData } };
        asset?: unknown;
    } | null;
    if (!gsplat) {
        return null;
    }

    const tryResource = (
        resource: { centers?: Float32Array; gsplatData?: GSplatData } | null | undefined
    ): [Float32Array, Float32Array, Float32Array] | null => {
        if (!resource) {
            return null;
        }
        const data = resource.gsplatData;
        if (data && typeof data.getProp === 'function') {
            const px = data.getProp('x') as Float32Array | undefined;
            const py = data.getProp('y') as Float32Array | undefined;
            const pz = data.getProp('z') as Float32Array | undefined;
            if (px?.length && py && pz) {
                return [px, py, pz];
            }
        }
        if (resource.centers instanceof Float32Array) {
            return splitCenters(resource.centers);
        }
        return null;
    };

    let xyz = tryResource(gsplat.resource ?? gsplat.instance?.resource);
    if (xyz) {
        return xyz;
    }

    const assetId = gsplat.asset;
    if (assetId != null) {
        const asset = typeof assetId === 'object' ? assetId : app.assets.get(assetId as number);
        xyz = tryResource((asset as { resource?: { centers?: Float32Array; gsplatData?: GSplatData } })?.resource);
        if (xyz) {
            return xyz;
        }
    }
    return null;
}

function resolveSparkleDensityParams(
    sparkleDensity: number,
    gsplat: GsplatBboxSource
): { sparkleSpacing: number; sparkleCoverage: number } {
    const density = Math.min(1, Math.max(0, sparkleDensity));
    const radius = readSceneBboxRadius(gsplat);
    const spacingScale = Math.max(0.25, Math.sqrt(density));
    const sceneSpacingScale = Math.max(1, Math.min(3, radius / SCENE_REF_RADIUS));
    return {
        sparkleSpacing: (DENSITY_SPACING_BASE * sceneSpacingScale) / spacingScale,
        sparkleCoverage: DENSITY_COVERAGE_CAP * density
    };
}

function sampleSparklePositions(
    source: [Float32Array, Float32Array, Float32Array],
    center: Vec3,
    sparkleSpacing: number,
    sparkleCoverage: number
): [Float32Array, Float32Array, Float32Array] {
    const [x, y, z] = source;
    const count = x.length;
    const sp = Math.max(sparkleSpacing, 0.001);
    const cov = Math.min(1, Math.max(0, sparkleCoverage));
    const pickRadiusSq = (sp * 0.48) ** 2;
    const bestByCell = new Map<number, { index: number; distSq: number }>();

    let stride = 1;
    if (count > SOURCE_SCAN_STRIDE_THRESHOLD) {
        stride = Math.ceil(count / SOURCE_SCAN_STRIDE_THRESHOLD);
    }

    const cx = center.x;
    const cy = center.y;
    const cz = center.z;
    const invSp = 1 / sp;

    for (let i = 0; i < count; i += stride) {
        const px = x[i];
        const py = y[i];
        const pz = z[i];
        const cellX = Math.floor((px - cx) * invSp);
        const cellY = Math.floor((py - cy) * invSp);
        const cellZ = Math.floor((pz - cz) * invSp);
        if (splatHash(cellX, cellY, cellZ) > cov) {
            continue;
        }

        const ax = (cellX + 0.5) * sp + cx + (splatHash(cellX + 0.17, cellY, cellZ) - 0.5) * sp * 0.42;
        const ay = (cellY + 0.5) * sp + cy + (splatHash(cellX, cellY + 0.31, cellZ) - 0.5) * sp * 0.42;
        const az = (cellZ + 0.5) * sp + cz + (splatHash(cellX, cellY, cellZ + 0.47) - 0.5) * sp * 0.42;
        const distSq = (px - ax) ** 2 + (py - ay) ** 2 + (pz - az) ** 2;
        if (distSq > pickRadiusSq) {
            continue;
        }

        const key = ((cellX * 73856093) ^ (cellY * 19349663) ^ (cellZ * 83492791)) | 0;
        const prev = bestByCell.get(key);
        if (!prev || distSq < prev.distSq) {
            bestByCell.set(key, { index: i, distSq });
        }
    }

    let entries = Array.from(bestByCell.values());
    if (entries.length > MAX_SPARKLES) {
        entries.sort((a, b) => a.distSq - b.distSq);
        entries.length = MAX_SPARKLES;
    }

    const n = entries.length;
    const outX = new Float32Array(n);
    const outY = new Float32Array(n);
    const outZ = new Float32Array(n);
    for (let j = 0; j < n; j++) {
        const { index } = entries[j];
        outX[j] = x[index];
        outY[j] = y[index];
        outZ[j] = z[index];
    }
    return [outX, outY, outZ];
}

function buildSparkleBillboardMesh(
    device: GraphicsDevice,
    x: Float32Array,
    y: Float32Array,
    z: Float32Array
): Mesh {
    const n = x.length;
    const vertCount = n * 4;
    const positions = new Float32Array(vertCount * 3);
    const corners = new Float32Array(vertCount * 2);
    const phases = new Float32Array(vertCount);
    const indices = new Uint32Array(n * 6);

    for (let i = 0; i < n; i++) {
        const phase = splatHash(x[i], y[i], z[i]) * Math.PI * 2;
        const base = i * 4;
        for (let c = 0; c < 4; c++) {
            const vi = base + c;
            positions[vi * 3] = x[i];
            positions[vi * 3 + 1] = y[i];
            positions[vi * 3 + 2] = z[i];
            corners[vi * 2] = QUAD_CORNERS[c][0];
            corners[vi * 2 + 1] = QUAD_CORNERS[c][1];
            phases[vi] = phase;
        }
        indices[i * 6] = base;
        indices[i * 6 + 1] = base + 1;
        indices[i * 6 + 2] = base + 2;
        indices[i * 6 + 3] = base;
        indices[i * 6 + 4] = base + 2;
        indices[i * 6 + 5] = base + 3;
    }

    const mesh = new Mesh(device);
    mesh.setPositions(positions);
    mesh.setUvs(0, corners, 2);
    mesh.setVertexStream(SEMANTIC_TEXCOORD1, phases, 1);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
}

function createSparkleMaterial(): ShaderMaterial {
    const material = new ShaderMaterial();
    material.cull = CULLFACE_NONE;
    material.blendType = BLEND_ADDITIVE;
    material.depthWrite = false;
    material.depthTest = false;
    material.shaderDesc = {
        uniqueName: 'sparkleTwinkleBillboard',
        vertexGLSL: shaderGLSL,
        fragmentGLSL: fragmentShaderGLSL,
        attributes: {
            vertex_position: SEMANTIC_POSITION,
            corner: SEMANTIC_TEXCOORD0,
            aPhase: SEMANTIC_TEXCOORD1
        }
    };
    material.update();
    return material;
}

/**
 * 亮光细闪：在 gsplat 上采样光点位置，用独立 billboard 层叠加闪烁高光（不经 gsplat shader composer）。
 */
class GsplatPersistentSparkleTwinkle extends Script {
    static scriptName = 'gsplatPersistentSparkleTwinkle';

    effectTime = 0;
    isPaused = false;
    center = new Vec3(...SPARKLE_TWINKLE_DEFAULTS.center);
    pointSize = SPARKLE_TWINKLE_DEFAULTS.pointSize;
    sparkleDensity = SPARKLE_TWINKLE_DEFAULTS.sparkleDensity;
    twinkleSpeed = SPARKLE_TWINKLE_DEFAULTS.twinkleSpeed;
    twinkleMin = SPARKLE_TWINKLE_DEFAULTS.twinkleMin;
    twinkleSharpness = SPARKLE_TWINKLE_DEFAULTS.twinkleSharpness;
    brightness = SPARKLE_TWINKLE_DEFAULTS.brightness;
    lightTint1 = new Color(...SPARKLE_TWINKLE_DEFAULTS.lightTint1);
    lightTint2 = new Color(...SPARKLE_TWINKLE_DEFAULTS.lightTint2);
    lightTint3 = new Color(...SPARKLE_TWINKLE_DEFAULTS.lightTint3);
    colorBlendMode = SPARKLE_TWINKLE_DEFAULTS.colorBlendMode;

    private overlayEntity: Entity | null = null;
    private material: ShaderMaterial | null = null;
    private pendingMount = false;
    private lastLayoutKey = '';
    private mountRetryCooldown = 0;
    private cameraEntity: Entity | null = null;
    private cachedPointSize = -1;
    private readonly _cameraPos = new Vec3();

    private layoutKey(): string {
        const c = this.center;
        return `${this.sparkleDensity}|${c.x}|${c.y}|${c.z}|${this.pointSize}`;
    }

    initialize() {
        this.effectTime = 0;
        this.on('enable', () => {
            this.effectTime = 0;
            syncSparkleRenderLayer(this.app as AppBase);
            this.requestRebuild();
        });
        this.on('disable', () => this.destroyOverlay(true));
        if (this.enabled) {
            syncSparkleRenderLayer(this.app as AppBase);
        }
    }

    update(dt: number) {
        if (!this.enabled) {
            return;
        }

        syncSparkleRenderLayer(this.app as AppBase);

        if (this.layoutKey() !== this.lastLayoutKey) {
            this.pendingMount = true;
        }

        if (this.pendingMount) {
            this.mountRetryCooldown -= dt;
            if (this.mountRetryCooldown <= 0) {
                this.mountRetryCooldown = MOUNT_RETRY_INTERVAL;
                this.tryMountOverlay();
            }
        }

        if (!this.isPaused) {
            this.effectTime += dt;
        }

        this.pushUniforms();
    }

    destroy() {
        this.destroyOverlay(true);
    }

    /** 布局参数变更后重建 billboard 网格（如 density / center / pointSize） */
    requestRebuild() {
        this.lastLayoutKey = '';
        this.pendingMount = true;
        this.mountRetryCooldown = 0;
        if (this.enabled) {
            this.tryMountOverlay();
        }
    }

    private resolveEffectivePointSize(): number {
        const radius = readSceneBboxRadius(this.entity.gsplat as GsplatBboxSource);
        return this.pointSize * Math.max(0.75, Math.min(4, radius / SCENE_REF_RADIUS));
    }

    private resolveCameraEntity(): Entity | null {
        if (this.cameraEntity) {
            return this.cameraEntity;
        }
        const global = (this.app as AppWithExtras).__global;
        if (global?.camera) {
            this.cameraEntity = global.camera;
            return this.cameraEntity;
        }
        const cameras = this.app.root.findComponents('camera') as Array<{ entity?: Entity }>;
        this.cameraEntity = cameras[0]?.entity ?? null;
        return this.cameraEntity;
    }

    private pushUniforms() {
        const material = this.material;
        if (!material) {
            return;
        }

        const size = this.resolveEffectivePointSize();
        material.setParameter('uTime', this.effectTime);
        material.setParameter('uTwinkleSpeed', this.twinkleSpeed);
        material.setParameter('uTwinkleMin', this.twinkleMin);
        material.setParameter('uTwinkleSharpness', this.twinkleSharpness);
        material.setParameter('uBrightness', this.brightness);
        material.setParameter('uLightTint1', [this.lightTint1.r, this.lightTint1.g, this.lightTint1.b]);
        material.setParameter('uLightTint2', [this.lightTint2.r, this.lightTint2.g, this.lightTint2.b]);
        material.setParameter('uLightTint3', [this.lightTint3.r, this.lightTint3.g, this.lightTint3.b]);
        material.setParameter('uColorBlendMode', this.colorBlendMode ? 1 : 0);

        if (size !== this.cachedPointSize) {
            this.cachedPointSize = size;
            material.setParameter('uPointSize', size);
            material.setParameter('uViewBias', Math.max(0.001, size * 0.06));
        }

        const cam = this.resolveCameraEntity();
        if (cam) {
            this._cameraPos.copy(cam.getPosition());
            material.setParameter('uCameraPos', [this._cameraPos.x, this._cameraPos.y, this._cameraPos.z]);
        }
    }

    private tryMountOverlay() {
        const app = this.app as AppBase;
        const sourceXyz = resolveSparkleSourcePositions(this.entity, app);
        if (!sourceXyz) {
            this.pendingMount = true;
            return;
        }

        const sample = resolveSparkleDensityParams(this.sparkleDensity, this.entity.gsplat as GsplatBboxSource);
        modelCenterForSampling(this.center, this.entity, _samplingCenter);
        const positions = sampleSparklePositions(
            sourceXyz,
            _samplingCenter,
            sample.sparkleSpacing,
            sample.sparkleCoverage
        );
        if (positions[0].length === 0) {
            this.pendingMount = true;
            return;
        }

        this.destroyOverlay();

        const [x, y, z] = positions;
        const mesh = buildSparkleBillboardMesh(app.graphicsDevice, x, y, z);
        const material = createSparkleMaterial();
        const instance = new MeshInstance(mesh, material);
        instance.cull = false;

        const overlay = new Entity(OVERLAY_ROOT_NAME);
        overlay.addComponent('render', {
            meshInstances: [instance],
            layers: [syncSparkleRenderLayer(app)],
            castShadows: false
        });
        this.entity.addChild(overlay);
        this.overlayEntity = overlay;
        this.material = material;
        this.pendingMount = false;
        this.lastLayoutKey = this.layoutKey();
        this.cachedPointSize = -1;
        this.pushUniforms();
        app.renderNextFrame = true;
    }

    private destroyOverlay(clearPending = false) {
        if (clearPending) {
            this.pendingMount = false;
        }
        this.lastLayoutKey = '';
        this.material = null;
        this.cachedPointSize = -1;
        this.cameraEntity = null;
        if (this.overlayEntity) {
            this.overlayEntity.destroy();
            this.overlayEntity = null;
        }
    }
}

export { GsplatPersistentSparkleTwinkle };
