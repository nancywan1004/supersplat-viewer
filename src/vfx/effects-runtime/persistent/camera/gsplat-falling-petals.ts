import {
    Asset,
    BLEND_ADDITIVEALPHA,
    BLEND_NONE,
    BoundingBox,
    CULLFACE_NONE,
    Entity,
    Mesh,
    MeshInstance,
    Script,
    SEMANTIC_COLOR,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    SEMANTIC_TEXCOORD1,
    SEMANTIC_TEXCOORD2,
    SEMANTIC_TEXCOORD3,
    ShaderMaterial,
    Texture,
    Vec3,
    type AppBase
} from 'playcanvas';

export interface GsplatFallingPetalsOptions {
    enabled?: boolean;
    followEntity?: Entity | null;
    continuousRender?: boolean;
    petalTexture?: Texture | null;
    petalTextureUrl?: string;
    density?: number;
    /** @deprecated Use density. 3000 petals maps to density 0.5. */
    petalParticleCount?: number;
    opacity?: number;
    color?: [number, number, number];
    glowColor?: [number, number, number];
    glowStrength?: number;
    glowWidth?: number;
    extents?: [number, number, number];
    speed?: number;
    drift?: number;
    flutter?: number;
    petalMinSize?: number;
    petalMaxSize?: number;
    atlasColumns?: number;
    atlasRows?: number;
}

const DEFAULT_ATLAS_URL = '/assets/textures/petal-atlas.png';
const PETAL_COUNT_PER_DENSITY = 6000;

/** 统一花瓣 atlas 路径（修正历史错误 `/textures/petal-atlas.png` 等）。 */
export function resolvePetalTextureUrl(url?: string | null): string {
    const raw = typeof url === 'string' && url.trim().length > 0 ? url.trim() : DEFAULT_ATLAS_URL;
    if (
        raw === '/textures/petal-atlas.png' ||
        raw === '/textures/petal-atlas.png-texture' ||
        raw === '/assets/petal-atlas.png'
    ) {
        return DEFAULT_ATLAS_URL;
    }
    const legacyFlat = raw.match(/^\/assets\/(petal[^/]*)\.png$/i);
    if (legacyFlat) {
        return `/assets/textures/${legacyFlat[1]}.png`;
    }
    return raw;
}

const PETAL_PRESET = {
    opacity: 0.92,
    color: [1, 1, 1] as [number, number, number],
    glowColor: [1, 1, 1] as [number, number, number],
    glowStrength: 0.3,
    glowWidth: 1,
    extents: [36, 24, 72] as [number, number, number],
    density: 1,
    /** @deprecated Use density. 6000 petals maps to density 1. */
    petalParticleCount: 6000,
    speed: 2.2,
    drift: 0.5,
    flutter: 0.28,
    petalMinSize: 0.12,
    petalMaxSize: 0.42,
    atlasColumns: 4,
    atlasRows: 4
};

interface PetalSeed {
    ox: number;
    oy: number;
    oz: number;
    tile: number;
    size: number;
    aspect: number;
    speed: number;
    phase: number;
    roll: number;
    tumbleX: number;
    tumbleY: number;
    driftX: number;
    driftZ: number;
    shade: number;
    warm: number;
}

function lerp(a: number, b: number, t: number) {
    return a + (b - a) * t;
}

function makeRng(seed: number) {
    let s = seed >>> 0;
    return () => {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 0x100000000;
    };
}

export class GsplatFallingPetals extends Script {
    static scriptName = 'gsplatFallingPetals';

    followEntity: Entity | null = null;

    continuousRender = true;

    opacity = PETAL_PRESET.opacity;

    color: [number, number, number] = [...PETAL_PRESET.color];

    glowColor: [number, number, number] = [...PETAL_PRESET.glowColor];

    glowStrength = PETAL_PRESET.glowStrength;

    glowWidth = PETAL_PRESET.glowWidth;

    extents = new Vec3(...PETAL_PRESET.extents);

    speed = PETAL_PRESET.speed;

    drift = PETAL_PRESET.drift;

    flutter = PETAL_PRESET.flutter;

    petalMinSize = PETAL_PRESET.petalMinSize;

    petalMaxSize = PETAL_PRESET.petalMaxSize;

    atlasColumns = PETAL_PRESET.atlasColumns;

    atlasRows = PETAL_PRESET.atlasRows;

    private _petalEntity: Entity | null = null;

    private _mesh: Mesh | null = null;

    private _bodyMaterial: ShaderMaterial | null = null;

    private _glowMaterial: ShaderMaterial | null = null;

    private _bodyMeshInstance: MeshInstance | null = null;

    private _glowMeshInstance: MeshInstance | null = null;

    private _petalTexture: Texture | null = null;

    private _petalTextureAsset: Asset | null = null;

    private _textureLoadUrl: string | null = null;

    density = PETAL_PRESET.density;

    private _savedAppAutoRender: boolean | undefined;

    private _autoRenderOverridden = false;

    private _time = 0;

    private _gridHalfArray = [0, 0, 0];

    private _baseCellArray = [0, 0, 0];

    private _cameraOffsetArray = [0, 0, 0];

    private _rightArray = [1, 0, 0];

    private _upArray = [0, 1, 0];

    private _forwardArray = [0, 0, -1];

    initialize() {
        this.on('enable', () => this.syncContinuousRender());
        this.on('disable', () => this.disarmContinuousRender());
        this.app.on('update', this._onAppUpdate);
        this.syncContinuousRender();
    }

    setOptions(options: GsplatFallingPetalsOptions = {}) {
        let rebuild = false;

        if (options.followEntity !== undefined) this.followEntity = options.followEntity;
        if (options.continuousRender !== undefined) this.continuousRender = options.continuousRender;
        if (options.petalTexture !== undefined) this.setPetalTexture(options.petalTexture);
        if (options.petalTextureUrl) {
            this.loadPetalTexture(options.petalTextureUrl);
        }
        const nextDensity = options.density ?? (
            options.petalParticleCount !== undefined ? options.petalParticleCount / PETAL_COUNT_PER_DENSITY : undefined
        );
        if (nextDensity !== undefined && nextDensity !== this.density) {
            this.density = nextDensity;
            rebuild = true;
        }
        if (options.opacity !== undefined) this.opacity = 1;
        if (options.color) this.color = [...options.color];
        if (options.glowColor) this.glowColor = [...options.glowColor];
        if (options.glowStrength !== undefined) this.glowStrength = options.glowStrength;
        if (options.glowWidth !== undefined && options.glowWidth !== this.glowWidth) {
            this.glowWidth = options.glowWidth;
            rebuild = true;
        }
        if (options.extents) this.extents.set(options.extents[0], options.extents[1], options.extents[2]);
        if (options.speed !== undefined) this.speed = options.speed;
        if (options.drift !== undefined) this.drift = options.drift;
        if (options.flutter !== undefined) this.flutter = options.flutter;
        if (options.petalMinSize !== undefined && options.petalMinSize !== this.petalMinSize) {
            this.petalMinSize = options.petalMinSize;
            rebuild = true;
        }
        if (options.petalMaxSize !== undefined && options.petalMaxSize !== this.petalMaxSize) {
            this.petalMaxSize = options.petalMaxSize;
            rebuild = true;
        }
        if (options.atlasColumns !== undefined && options.atlasColumns !== this.atlasColumns) {
            this.atlasColumns = Math.max(1, Math.floor(options.atlasColumns));
            rebuild = true;
        }
        if (options.atlasRows !== undefined && options.atlasRows !== this.atlasRows) {
            this.atlasRows = Math.max(1, Math.floor(options.atlasRows));
            rebuild = true;
        }
        if (options.enabled !== undefined) this.enabled = options.enabled;

        if (this.enabled && this._petalTexture) {
            this.ensurePetalSystem(rebuild);
            this.updateCustomAabb();
        }

        this.syncRenderer();
        this.syncContinuousRender();
    }

    show(options: GsplatFallingPetalsOptions = {}) {
        const petalTextureUrl = resolvePetalTextureUrl(options.petalTextureUrl);
        this.setOptions({
            ...PETAL_PRESET,
            ...options,
            petalTextureUrl,
            enabled: options.enabled ?? true
        });
    }

    hide() {
        this.enabled = false;
        this.syncRenderer();
        this.syncContinuousRender();
    }

    setPetalTexture(texture: Texture | null | undefined) {
        this._petalTexture = texture ?? null;
        this.applyTextureToMaterial();
    }

    loadPetalTexture(url: string) {
        const normalizedUrl = resolvePetalTextureUrl(url);
        if (this._petalTexture && this._textureLoadUrl === normalizedUrl) {
            return;
        }
        if (this._textureLoadUrl === normalizedUrl && this._petalTextureAsset && !this._petalTexture) {
            return;
        }

        if (this._petalTextureAsset) {
            this.app.assets.remove(this._petalTextureAsset);
            this._petalTextureAsset = null;
        }

        this._textureLoadUrl = normalizedUrl;
        const asset = new Asset(`gsplat-petal-atlas-${normalizedUrl}`, 'texture', { url: normalizedUrl });
        this._petalTextureAsset = asset;
        asset.once('load', () => {
            if (this._textureLoadUrl !== normalizedUrl) {
                return;
            }
            this.setPetalTexture(asset.resource as Texture);
            if (this.enabled) {
                this.ensurePetalSystem();
                this.updateCustomAabb();
                this.syncRenderer();
                this.syncContinuousRender();
            }
        });
        asset.once('error', (err) => {
            if (this._textureLoadUrl !== normalizedUrl) {
                return;
            }
            console.warn('[GsplatFallingPetals] failed to load petal texture:', normalizedUrl, err);
            this._textureLoadUrl = null;
        });
        this.app.assets.add(asset);
        this.app.assets.load(asset);
    }

    update(_dt: number) {
    }

    destroy() {
        this.app.off('update', this._onAppUpdate);
        this.disarmContinuousRender();
        if (this._petalEntity) {
            this._petalEntity.destroy();
            this._petalEntity = null;
        }
        this.destroyMaterials();
        if (this._mesh) {
            this._mesh.destroy();
            this._mesh = null;
        }
        if (this._petalTextureAsset) {
            this.app.assets.remove(this._petalTextureAsset);
            this._petalTextureAsset = null;
        }
    }

    private _onAppUpdate = (dt: number) => {
        if (!this.enabled || !this._petalEntity || !this._bodyMaterial) {
            return;
        }

        this._time += dt;
        this.syncPetalField(this.followEntity ?? this.entity);
        this.syncMaterialUniforms(this.followEntity ?? this.entity);
    };

    private ensurePetalSystem(forceRebuild = false) {
        if (this._petalEntity && this._mesh && !forceRebuild) {
            return;
        }

        if (this._petalEntity) {
            this._petalEntity.destroy();
            this._petalEntity = null;
        }
        this.destroyMaterials();
        if (this._mesh) {
            this._mesh.destroy();
            this._mesh = null;
        }

        const meshData = this.buildMeshData();

        this._petalEntity = new Entity('falling petal field');
        this.entity.addChild(this._petalEntity);

        this._mesh = new Mesh(this.app.graphicsDevice);
        this._mesh.clear(false, false, meshData.positions.length / 3, meshData.indices.length);
        this._mesh.setPositions(meshData.positions);
        this._mesh.setUvs(0, meshData.uvs);
        this._mesh.setVertexStream(SEMANTIC_TEXCOORD1, meshData.seed0, 4);
        this._mesh.setVertexStream(SEMANTIC_TEXCOORD2, meshData.seed1, 4);
        this._mesh.setVertexStream(SEMANTIC_TEXCOORD3, meshData.seed2, 4);
        this._mesh.setColors(meshData.colors);
        this._mesh.setIndices(meshData.indices);
        this._mesh.update();

        this._bodyMaterial = this.createMaterial('body');
        this.applyTextureToMaterial();

        this._bodyMeshInstance = new MeshInstance(this._mesh, this._bodyMaterial, this._petalEntity);
        this._bodyMeshInstance.castShadow = false;
        this._bodyMeshInstance.receiveShadow = false;

        this._petalEntity.addComponent('render', {
            type: 'asset',
            meshInstances: [this._bodyMeshInstance],
            layers: [this.getWorldLayerId()]
        } as any);
        this.updateCustomAabb();
    }

    private buildMeshData() {
        const rng = makeRng(0x5eedf10a);
        const count = this.getParticleCount();
        const vertexCount = count * 4;
        const positions = new Float32Array(vertexCount * 3);
        const uvs = new Float32Array(vertexCount * 2);
        const seed0 = new Float32Array(vertexCount * 4);
        const seed1 = new Float32Array(vertexCount * 4);
        const seed2 = new Float32Array(vertexCount * 4);
        const colors = new Float32Array(vertexCount * 4);
        const indices = new Uint16Array(count * 6);

        const halfX = this.getHalfCells(this.extents.x);
        const halfY = this.getHalfCells(this.extents.y);
        const halfZ = this.getHalfCells(this.extents.z);
        const gridX = halfX * 2;
        const gridY = halfY * 2;
        const gridZ = halfZ * 2;
        const tileCount = Math.max(1, this.atlasColumns * this.atlasRows);
        const corners = [
            [-1, -1],
            [1, -1],
            [1, 1],
            [-1, 1]
        ];

        for (let i = 0; i < count; i++) {
            const hero = rng() > 0.96 ? lerp(1.25, 1.85, rng()) : 1;
            const seed: PetalSeed = {
                ox: Math.floor(rng() * gridX),
                oy: Math.floor(rng() * gridY),
                oz: Math.floor(rng() * gridZ),
                tile: Math.floor(rng() * tileCount),
                size: lerp(this.petalMinSize, this.petalMaxSize, Math.pow(rng(), 1.75)) * hero,
                aspect: lerp(0.55, 0.95, rng()),
                speed: lerp(0.55, 1.35, rng()),
                phase: rng() * Math.PI * 2,
                roll: rng() * Math.PI * 2,
                tumbleX: lerp(0.35, 1.15, rng()) * (rng() > 0.5 ? 1 : -1),
                tumbleY: lerp(0.55, 1.6, rng()) * (rng() > 0.5 ? 1 : -1),
                driftX: lerp(-1, 1, rng()),
                driftZ: lerp(-1, 1, rng()),
                shade: lerp(0.72, 1.18, rng()),
                warm: lerp(-0.08, 0.14, rng())
            };

            const tileX = seed.tile % this.atlasColumns;
            const tileY = Math.floor(seed.tile / this.atlasColumns);
            const inset = 0.014;
            const u0 = (tileX + inset) / this.atlasColumns;
            const v0 = (tileY + inset) / this.atlasRows;
            const u1 = (tileX + 1 - inset) / this.atlasColumns;
            const v1 = (tileY + 1 - inset) / this.atlasRows;
            const cornerUvs = [
                [u0, v1],
                [u1, v1],
                [u1, v0],
                [u0, v0]
            ];

            const vi = i * 4;
            const ii = i * 6;
            indices[ii + 0] = vi + 0;
            indices[ii + 1] = vi + 1;
            indices[ii + 2] = vi + 2;
            indices[ii + 3] = vi + 0;
            indices[ii + 4] = vi + 2;
            indices[ii + 5] = vi + 3;

            for (let j = 0; j < 4; j++) {
                const v = vi + j;
                positions[v * 3 + 0] = corners[j][0];
                positions[v * 3 + 1] = corners[j][1];
                positions[v * 3 + 2] = 0;
                uvs[v * 2 + 0] = cornerUvs[j][0];
                uvs[v * 2 + 1] = cornerUvs[j][1];
                seed0[v * 4 + 0] = seed.ox;
                seed0[v * 4 + 1] = seed.oy;
                seed0[v * 4 + 2] = seed.oz;
                seed0[v * 4 + 3] = seed.size;
                seed1[v * 4 + 0] = seed.speed;
                seed1[v * 4 + 1] = seed.phase;
                seed1[v * 4 + 2] = seed.roll;
                seed1[v * 4 + 3] = seed.aspect;
                seed2[v * 4 + 0] = seed.tumbleX;
                seed2[v * 4 + 1] = seed.tumbleY;
                seed2[v * 4 + 2] = seed.driftX;
                seed2[v * 4 + 3] = seed.driftZ;
                colors[v * 4 + 0] = seed.shade;
                colors[v * 4 + 1] = seed.warm;
                colors[v * 4 + 2] = 0;
                colors[v * 4 + 3] = 1;
            }
        }

        return { positions, uvs, seed0, seed1, seed2, colors, indices };
    }

    private createMaterial(pass: 'body' | 'glow') {
        const glowWidth = this.getClampedGlowWidth();
        const glowMaxScale = this.formatShaderFloat(1 + 0.58 * glowWidth);
        const material = new ShaderMaterial();
        material.name = pass === 'body' ? 'GsplatFallingPetalsBody' : 'GsplatFallingPetalsGlow';
        material.cull = CULLFACE_NONE;
        material.blendType = pass === 'body' ? BLEND_NONE : BLEND_ADDITIVEALPHA;
        material.depthTest = true;
        material.depthWrite = pass === 'body';
        material.alphaTest = pass === 'body' ? 0.34 : 0;
        material.shaderDesc = {
            uniqueName: pass === 'body' ? 'GsplatTexturedFallingPetalsBodyGpu' : 'GsplatTexturedFallingPetalsGlowGpu',
            vertexGLSL: /* glsl */`
                attribute vec3 vertex_position;
                attribute vec2 vertex_texCoord0;
                attribute vec4 vertex_texCoord1;
                attribute vec4 vertex_texCoord2;
                attribute vec4 vertex_texCoord3;
                attribute vec4 vertex_color;

                uniform mat4 matrix_model;
                uniform mat4 matrix_viewProjection;
                uniform float uTime;
                uniform float uCellSize;
                uniform vec3 uGridHalf;
                uniform vec3 uBaseCell;
                uniform vec3 uCameraOffset;
                uniform vec3 uRight;
                uniform vec3 uUp;
                uniform vec3 uForward;
                uniform float uSpeed;
                uniform float uDrift;
                uniform float uFlutter;
                uniform float uOpacity;
                uniform vec3 uColor;
                uniform vec3 uGlowColor;
                uniform float uGlowStrength;

                varying vec2 vUv0;
                varying vec4 vColor;

                float saturate(float v) {
                    return clamp(v, 0.0, 1.0);
                }

                float smoother(float edge0, float edge1, float x) {
                    float t = saturate((x - edge0) / max(0.000001, edge1 - edge0));
                    return t * t * (3.0 - 2.0 * t);
                }

                float positiveMod(float v, float m) {
                    return v - floor(v / m) * m;
                }

                float wrappedCell(float seedCell, float baseCell, float gridSize, float halfGrid) {
                    return positiveMod(seedCell - positiveMod(baseCell, gridSize) + gridSize, gridSize) - halfGrid;
                }

                void main(void) {
                    vec4 s0 = vertex_texCoord1;
                    vec4 s1 = vertex_texCoord2;
                    vec4 s2 = vertex_texCoord3;
                    float gridX = uGridHalf.x * 2.0;
                    float gridY = uGridHalf.y * 2.0;
                    float gridZ = uGridHalf.z * 2.0;
                    float cellX = wrappedCell(s0.x, uBaseCell.x, gridX, uGridHalf.x);
                    float cellY = wrappedCell(s0.y, uBaseCell.y, gridY, uGridHalf.y);
                    float cellZ = wrappedCell(s0.z, uBaseCell.z, gridZ, uGridHalf.z);
                    float fall = fract((cellY + uGridHalf.y + s1.y * 0.159154943) / gridY - uTime * uSpeed * s1.x / gridY);
                    float sway = sin(uTime * mix(0.55, 1.25, s1.x) + s1.y);
                    float flutterWave = sin(uTime * mix(1.2, 2.8, s1.x) + s1.y * 1.73);
                    vec3 gridCenter = vec3(
                        (cellX + 0.5 + (sway * s2.z + flutterWave * 0.35) * uDrift) * uCellSize,
                        (-uGridHalf.y + fall * gridY) * uCellSize,
                        (cellZ + 0.5 + (cos(uTime * 0.7 + s1.y) * s2.w + flutterWave * 0.25) * uDrift) * uCellSize
                    );
                    vec3 center = gridCenter;

                    float roll = s1.z + sin(uTime * 1.1 + s1.y) * 0.85;
                    float tiltX = sin(uTime * s2.x + s1.y) * (0.3 + uFlutter);
                    float tiltY = cos(uTime * s2.y + s1.y * 1.41) * (0.22 + uFlutter * 0.75);
                    float cr = cos(roll);
                    float sr = sin(roll);
                    vec3 axisU = (uRight * cr + uUp * sr) * s0.w + uForward * tiltY * s0.w * 0.35;
                    vec3 axisV = (-uRight * sr + uUp * cr) * s0.w * s1.w + uForward * tiltX * s0.w * 0.55;
                    vec3 localPos = center + axisU * vertex_position.x + axisV * vertex_position.y;

                    float yNorm = (gridCenter.y / uCellSize + uGridHalf.y) / gridY;
                    float viewDepth = dot(gridCenter - uCameraOffset, uForward);
                    float depthNorm = saturate((viewDepth / uCellSize + uGridHalf.z) / max(0.000001, uGridHalf.z * 2.0));
                    float depthFade = mix(1.0, 0.4, smoother(0.82, 1.0, depthNorm));
                    float wrapFade = smoother(0.015, 0.1, yNorm) * (1.0 - smoother(0.9, 0.985, yNorm));
                    float shade = saturate(vertex_color.r);
                    float warm = vertex_color.g;
                    vec3 tint = uColor * shade * vec3(1.0 + warm * 0.45, 1.0 - warm * 0.18, 1.0 + warm * 0.08);

                    gl_Position = matrix_viewProjection * matrix_model * vec4(localPos, 1.0);
                    vUv0 = vertex_texCoord0;
                    vColor = vec4(tint, uOpacity * wrapFade * depthFade);
                }
            `,
            vertexWGSL: /* wgsl */`
                attribute vertex_position: vec3f;
                attribute vertex_texCoord0: vec2f;
                attribute vertex_texCoord1: vec4f;
                attribute vertex_texCoord2: vec4f;
                attribute vertex_texCoord3: vec4f;
                attribute vertex_color: vec4f;

                uniform matrix_model: mat4x4f;
                uniform matrix_viewProjection: mat4x4f;
                uniform uTime: f32;
                uniform uCellSize: f32;
                uniform uGridHalf: vec3f;
                uniform uBaseCell: vec3f;
                uniform uCameraOffset: vec3f;
                uniform uRight: vec3f;
                uniform uUp: vec3f;
                uniform uForward: vec3f;
                uniform uSpeed: f32;
                uniform uDrift: f32;
                uniform uFlutter: f32;
                uniform uOpacity: f32;
                uniform uColor: vec3f;
                uniform uGlowColor: vec3f;
                uniform uGlowStrength: f32;

                varying vUv0: vec2f;
                varying vColor: vec4f;

                fn saturate(v: f32) -> f32 {
                    return clamp(v, 0.0, 1.0);
                }

                fn smoother(edge0: f32, edge1: f32, x: f32) -> f32 {
                    let t = saturate((x - edge0) / max(0.000001, edge1 - edge0));
                    return t * t * (3.0 - 2.0 * t);
                }

                fn positiveMod(v: f32, m: f32) -> f32 {
                    return v - floor(v / m) * m;
                }

                fn wrappedCell(seedCell: f32, baseCell: f32, gridSize: f32, halfGrid: f32) -> f32 {
                    return positiveMod(seedCell - positiveMod(baseCell, gridSize) + gridSize, gridSize) - halfGrid;
                }

                @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    let s0 = input.vertex_texCoord1;
                    let s1 = input.vertex_texCoord2;
                    let s2 = input.vertex_texCoord3;
                    let gridX = uniform.uGridHalf.x * 2.0;
                    let gridY = uniform.uGridHalf.y * 2.0;
                    let gridZ = uniform.uGridHalf.z * 2.0;
                    let cellX = wrappedCell(s0.x, uniform.uBaseCell.x, gridX, uniform.uGridHalf.x);
                    let cellY = wrappedCell(s0.y, uniform.uBaseCell.y, gridY, uniform.uGridHalf.y);
                    let cellZ = wrappedCell(s0.z, uniform.uBaseCell.z, gridZ, uniform.uGridHalf.z);
                    let fall = fract((cellY + uniform.uGridHalf.y + s1.y * 0.159154943) / gridY - uniform.uTime * uniform.uSpeed * s1.x / gridY);
                    let sway = sin(uniform.uTime * mix(0.55, 1.25, s1.x) + s1.y);
                    let flutterWave = sin(uniform.uTime * mix(1.2, 2.8, s1.x) + s1.y * 1.73);
                    let gridCenter = vec3f(
                        (cellX + 0.5 + (sway * s2.z + flutterWave * 0.35) * uniform.uDrift) * uniform.uCellSize,
                        (-uniform.uGridHalf.y + fall * gridY) * uniform.uCellSize,
                        (cellZ + 0.5 + (cos(uniform.uTime * 0.7 + s1.y) * s2.w + flutterWave * 0.25) * uniform.uDrift) * uniform.uCellSize
                    );
                    let center = gridCenter;

                    let roll = s1.z + sin(uniform.uTime * 1.1 + s1.y) * 0.85;
                    let tiltX = sin(uniform.uTime * s2.x + s1.y) * (0.3 + uniform.uFlutter);
                    let tiltY = cos(uniform.uTime * s2.y + s1.y * 1.41) * (0.22 + uniform.uFlutter * 0.75);
                    let cr = cos(roll);
                    let sr = sin(roll);
                    let axisU = (uniform.uRight * cr + uniform.uUp * sr) * s0.w + uniform.uForward * tiltY * s0.w * 0.35;
                    let axisV = (-uniform.uRight * sr + uniform.uUp * cr) * s0.w * s1.w + uniform.uForward * tiltX * s0.w * 0.55;
                    let localPos = center + axisU * input.vertex_position.x + axisV * input.vertex_position.y;

                    let yNorm = (gridCenter.y / uniform.uCellSize + uniform.uGridHalf.y) / gridY;
                    let viewDepth = dot(gridCenter - uniform.uCameraOffset, uniform.uForward);
                    let depthNorm = saturate((viewDepth / uniform.uCellSize + uniform.uGridHalf.z) / max(0.000001, uniform.uGridHalf.z * 2.0));
                    let depthFade = mix(1.0, 0.4, smoother(0.82, 1.0, depthNorm));
                    let wrapFade = smoother(0.015, 0.1, yNorm) * (1.0 - smoother(0.9, 0.985, yNorm));
                    let shade = saturate(input.vertex_color.r);
                    let warm = input.vertex_color.g;
                    let tint = uniform.uColor * shade * vec3f(1.0 + warm * 0.45, 1.0 - warm * 0.18, 1.0 + warm * 0.08);

                    output.position = uniform.matrix_viewProjection * uniform.matrix_model * vec4f(localPos, 1.0);
                    output.vUv0 = input.vertex_texCoord0;
                    output.vColor = vec4f(tint, uniform.uOpacity * wrapFade * depthFade);
                    return output;
                }
            `,
            fragmentGLSL: /* glsl */`
                varying vec2 vUv0;
                varying vec4 vColor;
                uniform sampler2D colorMap;
                uniform vec3 uGlowColor;
                uniform float uGlowStrength;

                float expandedPetalAlpha(vec2 uv, float scale) {
                    vec2 atlasGrid = vec2(${this.atlasColumns}.0, ${this.atlasRows}.0);
                    vec2 tile = floor(uv * atlasGrid);
                    vec2 local = fract(uv * atlasGrid);
                    vec2 scaledLocal = vec2(0.5) + (local - vec2(0.5)) / scale;
                    scaledLocal = clamp(scaledLocal, vec2(0.018), vec2(0.982));
                    return texture2D(colorMap, (tile + scaledLocal) / atlasGrid).a;
                }

                float softGlowAlpha(vec2 uv, float baseA) {
                    float maxScale = ${glowMaxScale};
                    float outerA = expandedPetalAlpha(uv, maxScale);
                    float hit = smoothstep(0.03, 0.28, outerA);
                    float lo = 1.0;
                    float hi = maxScale;
                    for (int i = 0; i < 6; i++) {
                        float mid = (lo + hi) * 0.5;
                        float a = expandedPetalAlpha(uv, mid);
                        if (a > 0.18) {
                            hi = mid;
                        } else {
                            lo = mid;
                        }
                    }
                    float edgeDist = clamp((hi - 1.0) / max(0.0001, maxScale - 1.0), 0.0, 1.0);
                    float halo = pow(1.0 - smoothstep(0.0, 1.0, edgeDist), 1.35) * hit;
                    float outside = 1.0 - smoothstep(0.03, 0.62, baseA);
                    return halo * outside;
                }

                void main(void) {
                    vec4 tex = texture2D(colorMap, vUv0);

                    float baseAlpha = tex.a * vColor.a;
                    if (${pass === 'body' ? 'true' : 'false'}) {
                        if (baseAlpha < 0.34) {
                            discard;
                        }
                        gl_FragColor = vec4(tex.rgb * vColor.rgb, 1.0);
                        return;
                    }

                    float glowAlpha = softGlowAlpha(vUv0, tex.a) * vColor.a * uGlowStrength * 1.05;
                    if (glowAlpha < 0.01) {
                        discard;
                    }

                    gl_FragColor = vec4(uGlowColor, glowAlpha);
                }
            `,
            fragmentWGSL: /* wgsl */`
                varying vUv0: vec2f;
                varying vColor: vec4f;
                uniform uGlowColor: vec3f;
                uniform uGlowStrength: f32;
                var colorMap: texture_2d<f32>;
                var colorMapSampler: sampler;

                fn expandedPetalAlpha(uv: vec2f, scale: f32) -> f32 {
                    let atlasGrid = vec2f(${this.atlasColumns}.0, ${this.atlasRows}.0);
                    let tile = floor(uv * atlasGrid);
                    let local = fract(uv * atlasGrid);
                    var scaledLocal = vec2f(0.5) + (local - vec2f(0.5)) / scale;
                    scaledLocal = clamp(scaledLocal, vec2f(0.018), vec2f(0.982));
                    return textureSample(colorMap, colorMapSampler, (tile + scaledLocal) / atlasGrid).a;
                }

                fn softGlowAlpha(uv: vec2f, baseA: f32) -> f32 {
                    let maxScale = ${glowMaxScale};
                    let outerA = expandedPetalAlpha(uv, maxScale);
                    let hit = smoothstep(0.03, 0.28, outerA);
                    var lo = 1.0;
                    var hi = maxScale;
                    for (var i = 0; i < 6; i = i + 1) {
                        let mid = (lo + hi) * 0.5;
                        let a = expandedPetalAlpha(uv, mid);
                        if (a > 0.18) {
                            hi = mid;
                        } else {
                            lo = mid;
                        }
                    }
                    let edgeDist = clamp((hi - 1.0) / max(0.0001, maxScale - 1.0), 0.0, 1.0);
                    let halo = pow(1.0 - smoothstep(0.0, 1.0, edgeDist), 1.35) * hit;
                    let outside = 1.0 - smoothstep(0.03, 0.62, baseA);
                    return halo * outside;
                }

                @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
                    var output: FragmentOutput;
                    let tex = textureSample(colorMap, colorMapSampler, input.vUv0);

                    let baseAlpha = tex.a * input.vColor.a;
                    if (${pass === 'body' ? 'true' : 'false'}) {
                        if (baseAlpha < 0.34) {
                            discard;
                        }
                        output.color = vec4f(tex.rgb * input.vColor.rgb, 1.0);
                        return output;
                    }

                    let glowAlpha = softGlowAlpha(input.vUv0, tex.a) * input.vColor.a * uniform.uGlowStrength * 1.05;
                    if (glowAlpha < 0.01) {
                        discard;
                    }

                    output.color = vec4f(uniform.uGlowColor, glowAlpha);
                    return output;
                }
            `,
            attributes: {
                vertex_position: SEMANTIC_POSITION,
                vertex_texCoord0: SEMANTIC_TEXCOORD0,
                vertex_texCoord1: SEMANTIC_TEXCOORD1,
                vertex_texCoord2: SEMANTIC_TEXCOORD2,
                vertex_texCoord3: SEMANTIC_TEXCOORD3,
                vertex_color: SEMANTIC_COLOR
            }
        };
        material.update();
        return material;
    }

    private applyTextureToMaterial() {
        if (!this._petalTexture) {
            return;
        }
        for (const material of this.getMaterials()) {
            material.setParameter('colorMap', this._petalTexture);
            material.update();
        }
    }

    private syncPetalField(target: Entity) {
        const cs = this.getCellSize();
        const pos = target.getPosition();
        const bcX = Math.floor(pos.x / cs);
        const bcY = Math.floor(pos.y / cs);
        const bcZ = Math.floor(pos.z / cs);

        this._petalEntity!.setPosition(bcX * cs, bcY * cs, bcZ * cs);
        this._baseCellArray[0] = bcX;
        this._baseCellArray[1] = bcY;
        this._baseCellArray[2] = bcZ;
        this._cameraOffsetArray[0] = pos.x - bcX * cs;
        this._cameraOffsetArray[1] = pos.y - bcY * cs;
        this._cameraOffsetArray[2] = pos.z - bcZ * cs;
    }

    private syncMaterialUniforms(target: Entity) {
        const materials = this.getMaterials();
        if (!materials.length) {
            return;
        }

        this._gridHalfArray[0] = this.getHalfCells(this.extents.x);
        this._gridHalfArray[1] = this.getHalfCells(this.extents.y);
        this._gridHalfArray[2] = this.getHalfCells(this.extents.z);

        const right = target.right;
        const up = target.up;
        const forward = target.forward;
        this._rightArray[0] = right.x;
        this._rightArray[1] = right.y;
        this._rightArray[2] = right.z;
        this._upArray[0] = up.x;
        this._upArray[1] = up.y;
        this._upArray[2] = up.z;
        this._forwardArray[0] = forward.x;
        this._forwardArray[1] = forward.y;
        this._forwardArray[2] = forward.z;

        for (const material of materials) {
            material.setParameter('uTime', this._time);
            material.setParameter('uCellSize', this.getCellSize());
            material.setParameter('uGridHalf', this._gridHalfArray);
            material.setParameter('uBaseCell', this._baseCellArray);
            material.setParameter('uCameraOffset', this._cameraOffsetArray);
            material.setParameter('uRight', this._rightArray);
            material.setParameter('uUp', this._upArray);
            material.setParameter('uForward', this._forwardArray);
            material.setParameter('uSpeed', this.speed);
            material.setParameter('uDrift', this.drift);
            material.setParameter('uFlutter', this.flutter);
            material.setParameter('uOpacity', 1);
            material.setParameter('uColor', this.color);
            material.setParameter('uGlowColor', this.glowColor);
            material.setParameter('uGlowStrength', this.glowStrength);
        }
    }

    private getMaterials() {
        return [this._bodyMaterial].filter((material): material is ShaderMaterial => !!material);
    }

    private destroyMaterials() {
        this._bodyMaterial?.destroy();
        this._glowMaterial?.destroy();
        this._bodyMaterial = null;
        this._glowMaterial = null;
        this._bodyMeshInstance = null;
        this._glowMeshInstance = null;
    }

    private getCellSize() {
        const volume = Math.max(1, this.extents.x * this.extents.y * this.extents.z);
        const densitySize = Math.cbrt(volume / this.getParticleCount()) * 0.55;
        return Math.min(1.45, Math.max(0.62, densitySize));
    }

    private getParticleCount() {
        return Math.min(12000, Math.max(1, Math.floor(this.density * PETAL_COUNT_PER_DENSITY)));
    }

    private getClampedGlowWidth() {
        return Math.min(3, Math.max(0.1, Number.isFinite(this.glowWidth) ? this.glowWidth : PETAL_PRESET.glowWidth));
    }

    private formatShaderFloat(value: number) {
        const finite = Number.isFinite(value) ? value : 0;
        return finite.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.0');
    }

    private getHalfCells(extent: number) {
        return Math.max(2, Math.floor(extent / Math.max(0.001, this.getCellSize()) * 0.5));
    }

    private syncRenderer() {
        if (this.enabled) {
            this.ensurePetalSystem();
        }

        if (!this._petalEntity) {
            return;
        }

        this._petalEntity.enabled = this.enabled;
        if (this._petalEntity.render) {
            this._petalEntity.render.enabled = this.enabled;
            this._petalEntity.render.layers = [this.getWorldLayerId()];
        }
    }

    private getWorldLayerId() {
        return this.app.scene.layers.getLayerByName('World')?.id ?? 0;
    }

    private updateCustomAabb() {
        if (!this._petalEntity?.render) {
            return;
        }
        const halfExtent = Math.max(this.extents.x, this.extents.y, this.extents.z, this.petalMaxSize * 4) + this.getCellSize();
        const half = new Vec3(
            halfExtent,
            halfExtent,
            halfExtent
        );
        this._petalEntity.render.customAabb = new BoundingBox(Vec3.ZERO, half);
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

export function createGsplatFallingPetals(app: AppBase, options: GsplatFallingPetalsOptions = {}) {
    const entity = new Entity('gsplat falling petals');
    entity.addComponent('script');
    app.root.addChild(entity);

    const script = entity.script!.create(GsplatFallingPetals) as unknown as GsplatFallingPetals;
    script.setOptions({ enabled: false, petalTextureUrl: DEFAULT_ATLAS_URL, ...options });
    if (options.enabled) {
        script.show(options);
    }
    return script;
}

export function destroyGsplatFallingPetals(script: GsplatFallingPetals | null | undefined) {
    const entity = script?.entity;
    if (!entity) {
        return;
    }
    entity.destroy();
}

export { PETAL_PRESET as GSPLAT_FALLING_PETALS_PRESET, DEFAULT_ATLAS_URL as GSPLAT_FALLING_PETALS_DEFAULT_ATLAS_URL };
