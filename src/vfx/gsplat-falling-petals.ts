import {
    Asset,
    BLEND_NORMAL,
    BoundingBox,
    CULLFACE_NONE,
    Entity,
    Layer,
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
    petalParticleCount?: number;
    opacity?: number;
    color?: [number, number, number];
    glowColor?: [number, number, number];
    glowStrength?: number;
    extents?: [number, number, number];
    speed?: number;
    drift?: number;
    flutter?: number;
    petalMinSize?: number;
    petalMaxSize?: number;
    atlasColumns?: number;
    atlasRows?: number;
}

const DEFAULT_ATLAS_URL = '/textures/petal-atlas.png';

const PETAL_PRESET = {
    opacity: 0.92,
    color: [1, 1, 1] as [number, number, number],
    glowColor: [1, 1, 1] as [number, number, number],
    glowStrength: 0.3,
    extents: [36, 42, 32] as [number, number, number],
    petalParticleCount: 3000,
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

    private _material: ShaderMaterial | null = null;

    private _meshInstance: MeshInstance | null = null;

    private _petalTexture: Texture | null = null;

    private _petalTextureAsset: Asset | null = null;

    private _petalParticleCount = PETAL_PRESET.petalParticleCount;

    private _petalLayer: Layer | null = null;

    private _cameraEntity: Entity | null = null;

    private _savedAppAutoRender: boolean | undefined;

    private _autoRenderOverridden = false;

    private _time = 0;

    private _gridHalfArray = [0, 0, 0];

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
        if (options.petalTextureUrl) this.loadPetalTexture(options.petalTextureUrl);
        if (options.petalParticleCount !== undefined && options.petalParticleCount !== this._petalParticleCount) {
            this._petalParticleCount = options.petalParticleCount;
            rebuild = true;
        }
        if (options.opacity !== undefined) this.opacity = options.opacity;
        if (options.color) this.color = [...options.color];
        if (options.glowColor) this.glowColor = [...options.glowColor];
        if (options.glowStrength !== undefined) this.glowStrength = options.glowStrength;
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

        if (this.enabled) {
            this.ensurePetalSystem(rebuild);
            this.updateCustomAabb();
        }

        this.syncRenderer();
        this.syncContinuousRender();
    }

    show(options: GsplatFallingPetalsOptions = {}) {
        this.setOptions({
            ...PETAL_PRESET,
            petalTextureUrl: DEFAULT_ATLAS_URL,
            ...options,
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
        const normalizedUrl = url.replace(/^\/assets\/(petal[^/]*)\.png$/i, '/textures/$1.png');
        if (this._petalTextureAsset) {
            this.app.assets.remove(this._petalTextureAsset);
            this._petalTextureAsset = null;
        }

        const asset = new Asset('gsplat-petal-atlas-texture', 'texture', { url: normalizedUrl });
        this._petalTextureAsset = asset;
        asset.once('load', () => {
            this.setPetalTexture(asset.resource as Texture);
        });
        asset.once('error', (err) => {
            console.warn('[GsplatFallingPetals] failed to load petal texture:', normalizedUrl, err);
        });
        this.app.assets.add(asset);
        this.app.assets.load(asset);
    }

    update(_dt: number) {
    }

    destroy() {
        this.app.off('update', this._onAppUpdate);
        this.disarmContinuousRender();
        this.removePetalLayer();
        if (this._petalEntity) {
            this._petalEntity.destroy();
            this._petalEntity = null;
        }
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
        if (!this.enabled || !this._petalEntity || !this._material) {
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

        this._material = this.createMaterial();
        this.applyTextureToMaterial();

        this._meshInstance = new MeshInstance(this._mesh, this._material, this._petalEntity);
        this._meshInstance.castShadow = false;
        this._meshInstance.receiveShadow = false;

        this._petalEntity.addComponent('render', {
            type: 'asset',
            meshInstances: [this._meshInstance],
            layers: [this.ensurePetalLayer().id]
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
        const gridY = halfY * 2;
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
                ox: Math.floor(lerp(-halfX, halfX, rng())),
                oy: Math.floor(rng() * gridY),
                oz: Math.floor(lerp(-halfZ, halfZ, rng())),
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

    private createMaterial() {
        const material = new ShaderMaterial();
        material.cull = CULLFACE_NONE;
        material.blendType = BLEND_NORMAL;
        material.depthTest = false;
        material.depthWrite = false;
        material.shaderDesc = {
            uniqueName: 'GsplatTexturedFallingPetalsGpu',
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

                void main(void) {
                    vec4 s0 = vertex_texCoord1;
                    vec4 s1 = vertex_texCoord2;
                    vec4 s2 = vertex_texCoord3;
                    float gridY = uGridHalf.y * 2.0;
                    float fall = fract((s0.y + s1.y * 0.159154943) / gridY - uTime * uSpeed * s1.x / gridY);
                    float sway = sin(uTime * mix(0.55, 1.25, s1.x) + s1.y);
                    float flutterWave = sin(uTime * mix(1.2, 2.8, s1.x) + s1.y * 1.73);
                    vec3 center = vec3(
                        (s0.x + 0.5 + (sway * s2.z + flutterWave * 0.35) * uDrift) * uCellSize,
                        (-uGridHalf.y + fall * gridY) * uCellSize,
                        (s0.z + 0.5 + (cos(uTime * 0.7 + s1.y) * s2.w + flutterWave * 0.25) * uDrift) * uCellSize
                    );

                    float roll = s1.z + sin(uTime * 1.1 + s1.y) * 0.85;
                    float tiltX = sin(uTime * s2.x + s1.y) * (0.3 + uFlutter);
                    float tiltY = cos(uTime * s2.y + s1.y * 1.41) * (0.22 + uFlutter * 0.75);
                    float cr = cos(roll);
                    float sr = sin(roll);
                    vec3 axisU = (uRight * cr + uUp * sr) * s0.w + uForward * tiltY * s0.w * 0.35;
                    vec3 axisV = (-uRight * sr + uUp * cr) * s0.w * s1.w + uForward * tiltX * s0.w * 0.55;
                    vec3 localPos = center + axisU * vertex_position.x + axisV * vertex_position.y;

                    float yNorm = (center.y / uCellSize + uGridHalf.y) / gridY;
                    float wrapFade = smoother(0.015, 0.1, yNorm) * (1.0 - smoother(0.9, 0.985, yNorm));
                    float shade = saturate(vertex_color.r);
                    float warm = vertex_color.g;
                    vec3 tint = uColor * shade * vec3(1.0 + warm * 0.45, 1.0 - warm * 0.18, 1.0 + warm * 0.08);

                    gl_Position = matrix_viewProjection * matrix_model * vec4(localPos, 1.0);
                    vUv0 = vertex_texCoord0;
                    vColor = vec4(tint, uOpacity * wrapFade);
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

                @vertex fn vertexMain(input: VertexInput) -> VertexOutput {
                    var output: VertexOutput;
                    let s0 = input.vertex_texCoord1;
                    let s1 = input.vertex_texCoord2;
                    let s2 = input.vertex_texCoord3;
                    let gridY = uniform.uGridHalf.y * 2.0;
                    let fall = fract((s0.y + s1.y * 0.159154943) / gridY - uniform.uTime * uniform.uSpeed * s1.x / gridY);
                    let sway = sin(uniform.uTime * mix(0.55, 1.25, s1.x) + s1.y);
                    let flutterWave = sin(uniform.uTime * mix(1.2, 2.8, s1.x) + s1.y * 1.73);
                    let center = vec3f(
                        (s0.x + 0.5 + (sway * s2.z + flutterWave * 0.35) * uniform.uDrift) * uniform.uCellSize,
                        (-uniform.uGridHalf.y + fall * gridY) * uniform.uCellSize,
                        (s0.z + 0.5 + (cos(uniform.uTime * 0.7 + s1.y) * s2.w + flutterWave * 0.25) * uniform.uDrift) * uniform.uCellSize
                    );

                    let roll = s1.z + sin(uniform.uTime * 1.1 + s1.y) * 0.85;
                    let tiltX = sin(uniform.uTime * s2.x + s1.y) * (0.3 + uniform.uFlutter);
                    let tiltY = cos(uniform.uTime * s2.y + s1.y * 1.41) * (0.22 + uniform.uFlutter * 0.75);
                    let cr = cos(roll);
                    let sr = sin(roll);
                    let axisU = (uniform.uRight * cr + uniform.uUp * sr) * s0.w + uniform.uForward * tiltY * s0.w * 0.35;
                    let axisV = (-uniform.uRight * sr + uniform.uUp * cr) * s0.w * s1.w + uniform.uForward * tiltX * s0.w * 0.55;
                    let localPos = center + axisU * input.vertex_position.x + axisV * input.vertex_position.y;

                    let yNorm = (center.y / uniform.uCellSize + uniform.uGridHalf.y) / gridY;
                    let wrapFade = smoother(0.015, 0.1, yNorm) * (1.0 - smoother(0.9, 0.985, yNorm));
                    let shade = saturate(input.vertex_color.r);
                    let warm = input.vertex_color.g;
                    let tint = uniform.uColor * shade * vec3f(1.0 + warm * 0.45, 1.0 - warm * 0.18, 1.0 + warm * 0.08);

                    output.position = uniform.matrix_viewProjection * uniform.matrix_model * vec4f(localPos, 1.0);
                    output.vUv0 = input.vertex_texCoord0;
                    output.vColor = vec4f(tint, uniform.uOpacity * wrapFade);
                    return output;
                }
            `,
            fragmentGLSL: /* glsl */`
                varying vec2 vUv0;
                varying vec4 vColor;
                uniform sampler2D colorMap;
                uniform vec3 uGlowColor;
                uniform float uGlowStrength;

                float sampleMaxAlpha(vec2 uv, float r) {
                    float a = texture2D(colorMap, uv + vec2( r,  0.0)).a;
                    a = max(a, texture2D(colorMap, uv + vec2(-r,  0.0)).a);
                    a = max(a, texture2D(colorMap, uv + vec2(0.0,  r)).a);
                    a = max(a, texture2D(colorMap, uv + vec2(0.0, -r)).a);
                    a = max(a, texture2D(colorMap, uv + vec2( r,  r)).a);
                    a = max(a, texture2D(colorMap, uv + vec2(-r,  r)).a);
                    a = max(a, texture2D(colorMap, uv + vec2( r, -r)).a);
                    a = max(a, texture2D(colorMap, uv + vec2(-r, -r)).a);
                    return a;
                }

                void main(void) {
                    vec4 tex = texture2D(colorMap, vUv0);
                    float nearAlpha = sampleMaxAlpha(vUv0, 0.0045);
                    float midAlpha = sampleMaxAlpha(vUv0, 0.010);
                    float farAlpha = sampleMaxAlpha(vUv0, 0.018);

                    float baseAlpha = tex.a * vColor.a;
                    float glowMask = max(nearAlpha - tex.a, 0.0) * 0.54;
                    glowMask += max(midAlpha - tex.a, 0.0) * 0.30;
                    glowMask += max(farAlpha - tex.a, 0.0) * 0.16;
                    float glowAlpha = glowMask * vColor.a * uGlowStrength * 0.72;
                    float alpha = max(baseAlpha, glowAlpha);
                    if (alpha < 0.015) {
                        discard;
                    }

                    vec3 baseColor = tex.rgb * vColor.rgb;
                    float glowMix = clamp(glowAlpha / max(alpha, 0.0001), 0.0, 1.0);
                    vec3 color = mix(baseColor, uGlowColor, glowMix);
                    gl_FragColor = vec4(color, alpha);
                }
            `,
            fragmentWGSL: /* wgsl */`
                varying vUv0: vec2f;
                varying vColor: vec4f;
                uniform uGlowColor: vec3f;
                uniform uGlowStrength: f32;
                var colorMap: texture_2d<f32>;
                var colorMapSampler: sampler;

                fn sampleMaxAlpha(uv: vec2f, r: f32) -> f32 {
                    var a = textureSample(colorMap, colorMapSampler, uv + vec2f( r, 0.0)).a;
                    a = max(a, textureSample(colorMap, colorMapSampler, uv + vec2f(-r, 0.0)).a);
                    a = max(a, textureSample(colorMap, colorMapSampler, uv + vec2f(0.0,  r)).a);
                    a = max(a, textureSample(colorMap, colorMapSampler, uv + vec2f(0.0, -r)).a);
                    a = max(a, textureSample(colorMap, colorMapSampler, uv + vec2f( r,  r)).a);
                    a = max(a, textureSample(colorMap, colorMapSampler, uv + vec2f(-r,  r)).a);
                    a = max(a, textureSample(colorMap, colorMapSampler, uv + vec2f( r, -r)).a);
                    a = max(a, textureSample(colorMap, colorMapSampler, uv + vec2f(-r, -r)).a);
                    return a;
                }

                @fragment fn fragmentMain(input: FragmentInput) -> FragmentOutput {
                    var output: FragmentOutput;
                    let tex = textureSample(colorMap, colorMapSampler, input.vUv0);
                    let nearAlpha = sampleMaxAlpha(input.vUv0, 0.0045);
                    let midAlpha = sampleMaxAlpha(input.vUv0, 0.010);
                    let farAlpha = sampleMaxAlpha(input.vUv0, 0.018);

                    let baseAlpha = tex.a * input.vColor.a;
                    var glowMask = max(nearAlpha - tex.a, 0.0) * 0.54;
                    glowMask = glowMask + max(midAlpha - tex.a, 0.0) * 0.30;
                    glowMask = glowMask + max(farAlpha - tex.a, 0.0) * 0.16;
                    let glowAlpha = glowMask * input.vColor.a * uniform.uGlowStrength * 0.72;
                    let alpha = max(baseAlpha, glowAlpha);
                    if (alpha < 0.015) {
                        discard;
                    }

                    let baseColor = tex.rgb * input.vColor.rgb;
                    let glowMix = clamp(glowAlpha / max(alpha, 0.0001), 0.0, 1.0);
                    let color = mix(baseColor, uniform.uGlowColor, glowMix);
                    output.color = vec4f(color, alpha);
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
        if (!this._material || !this._petalTexture) {
            return;
        }
        this._material.setParameter('colorMap', this._petalTexture);
        this._material.update();
    }

    private syncPetalField(target: Entity) {
        const cs = this.getCellSize();
        const pos = target.getPosition();
        const bcX = Math.floor(pos.x / cs);
        const bcY = Math.floor(pos.y / cs);
        const bcZ = Math.floor(pos.z / cs);

        this._petalEntity!.setPosition(bcX * cs, bcY * cs, bcZ * cs);
        this._cameraOffsetArray[0] = pos.x - bcX * cs;
        this._cameraOffsetArray[1] = pos.y - bcY * cs;
        this._cameraOffsetArray[2] = pos.z - bcZ * cs;
        this.syncCameraLayer();
    }

    private syncMaterialUniforms(target: Entity) {
        if (!this._material) {
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

        this._material.setParameter('uTime', this._time);
        this._material.setParameter('uCellSize', this.getCellSize());
        this._material.setParameter('uGridHalf', this._gridHalfArray);
        this._material.setParameter('uCameraOffset', this._cameraOffsetArray);
        this._material.setParameter('uRight', this._rightArray);
        this._material.setParameter('uUp', this._upArray);
        this._material.setParameter('uForward', this._forwardArray);
        this._material.setParameter('uSpeed', this.speed);
        this._material.setParameter('uDrift', this.drift);
        this._material.setParameter('uFlutter', this.flutter);
        this._material.setParameter('uOpacity', this.opacity);
        this._material.setParameter('uColor', this.color);
        this._material.setParameter('uGlowColor', this.glowColor);
        this._material.setParameter('uGlowStrength', this.glowStrength);
    }

    private getCellSize() {
        const volume = Math.max(1, this.extents.x * this.extents.y * this.extents.z);
        const densitySize = Math.cbrt(volume / this.getParticleCount()) * 0.55;
        return Math.min(1.45, Math.max(0.62, densitySize));
    }

    private getParticleCount() {
        return Math.min(12000, Math.max(1, Math.floor(this._petalParticleCount)));
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
            this._petalEntity.render.layers = [this.ensurePetalLayer().id];
        }
        this.syncCameraLayer();
    }

    private ensurePetalLayer() {
        if (this._petalLayer) {
            return this._petalLayer;
        }

        const layers = this.app.scene.layers;
        const worldLayer = layers.getLayerByName('World');
        const layer = new Layer({
            name: 'FallingPetalsOverlay',
            clearColorBuffer: false,
            clearDepthBuffer: false
        });

        if (worldLayer) {
            layers.insert(layer, layers.getTransparentIndex(worldLayer) + 1);
        } else {
            layers.push(layer);
        }

        this._petalLayer = layer;
        this.syncCameraLayer();
        return layer;
    }

    private syncCameraLayer() {
        const layer = this._petalLayer;
        const cameraEntity = this.followEntity?.camera ? this.followEntity : null;
        if (!layer || !cameraEntity?.camera) {
            return;
        }

        if (this._cameraEntity && this._cameraEntity !== cameraEntity && this._cameraEntity.camera) {
            this._cameraEntity.camera.layers = this._cameraEntity.camera.layers.filter(id => id !== layer.id);
        }

        if (!cameraEntity.camera.layers.includes(layer.id)) {
            cameraEntity.camera.layers = [...cameraEntity.camera.layers, layer.id];
        }
        this._cameraEntity = cameraEntity;
    }

    private removePetalLayer() {
        const layer = this._petalLayer;
        if (!layer) {
            return;
        }

        if (this._cameraEntity?.camera) {
            this._cameraEntity.camera.layers = this._cameraEntity.camera.layers.filter(id => id !== layer.id);
        }
        this.app.scene.layers.remove(layer);
        this._petalLayer = null;
        this._cameraEntity = null;
    }

    private updateCustomAabb() {
        if (!this._petalEntity?.render) {
            return;
        }
        const half = new Vec3(
            Math.max(this.extents.x, this.petalMaxSize * 4),
            Math.max(this.extents.y, this.petalMaxSize * 4),
            Math.max(this.extents.z, this.petalMaxSize * 4)
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
