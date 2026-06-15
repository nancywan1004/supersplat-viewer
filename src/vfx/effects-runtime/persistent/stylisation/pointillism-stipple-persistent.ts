import {
    Entity,
    Material,
    SHADERLANGUAGE_GLSL,
    SHADERLANGUAGE_WGSL,
    ShaderChunks,
    Vec3,
    type CameraComponent,
    type CameraFrame,
    type GraphicsDevice
} from 'playcanvas';

import {
    POINTILLISM_DEFAULTS,
    POINTILLISM_DOT_RADIUS_PX_MAX,
    POINTILLISM_GAP_SPACING_MAX,
    POINTILLISM_GAP_SPACING_MIN,
    POINTILLISM_PAINT_GRAIN_MAX,
    POINTILLISM_PAINT_GRAIN_MIN,
    POINTILLISM_PAINT_OPACITY_MAX,
    POINTILLISM_PAINT_OPACITY_MIN,
    POINTILLISM_STROKE_LENGTH_MAX,
    POINTILLISM_STROKE_LENGTH_MIN,
    POINTILLISM_STROKE_WIDTH_MAX,
    POINTILLISM_STROKE_WIDTH_MIN,
    POINTILLISM_UNIFORM_NAMES as PU,
    pointillismModifyGlsl,
    pointillismModifyWgsl,
    resolvePointillismComplementaryMix,
    resolvePointillismDotRadiusPx,
    resolvePointillismEdgeThreshold,
    resolvePointillismMinVisibleAlpha,
    POINTILLISM_CONTRAST_DOT_MIX_MAX
} from './pointillism-stipple-shaders';
import {
    coercePointillismBool,
    DEFAULT_POINTILLISM_POST_SETTINGS,
    PointillismPostController
} from './pointillism-stipple-post';
import { isOneShotRevealPlayingExclusiveGsplat } from '../../effects-pipeline-policy';
import { GsplatShaderEffect } from '../../gsplat-shader-effect';

type SavedPsChunks = {
    glsl?: string;
    wgsl?: string;
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

const patchReplace = (src: string, find: string, repl: string, label: string): string => {
    const out = src.replace(find, repl);
    if (out === src) {
        throw new Error(`[pointillism-stipple] gsplatPS patch failed: ${label}`);
    }
    return out;
};

const GLSL_INSERT = /* glsl */`

uniform float uPointillismStrokeLength;
uniform float uPointillismStrokeWidth;
uniform float uPointillismBrushAspect;
uniform float uPointillismBrushHardness;
uniform float uPointillismPaintOpacity;
uniform float uPointillismPaintGrain;
uniform float uPointillismSeed;

const float POINTILLISM_STROKE_LEN_MIN = 0.15;
const float POINTILLISM_STROKE_LEN_MAX = 2.5;
const float POINTILLISM_STROKE_WID_MIN = 0.15;
const float POINTILLISM_STROKE_WID_MAX = 1.85;

float pointillismStrokeT(float v, float lo, float hi) {
    return clamp((v - lo) / (hi - lo), 0.0, 1.0);
}

float pointillismPsHash(vec2 p) {
    return fract(sin(dot(p, vec2(12.9898, 78.233)) + uPointillismSeed * 0.13) * 43758.5453);
}

float pointillismValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = pointillismPsHash(i);
    float b = pointillismPsHash(i + vec2(1.0, 0.0));
    float c = pointillismPsHash(i + vec2(0.0, 1.0));
    float d = pointillismPsHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float pointillismFbm3(vec2 p) {
    float v = 0.0;
    v += 0.5 * pointillismValueNoise(p);
    v += 0.25 * pointillismValueNoise(p * 2.1 + vec2(1.7, 9.2));
    v += 0.125 * pointillismValueNoise(p * 4.2 + vec2(8.3, 2.8));
    return v / 0.875;
}

vec2 pointillismShapeUV(vec2 uv) {
    float angle = pointillismPsHash(gaussianColor.rg + uPointillismSeed * 0.13) * 6.2831853;
    float c = cos(angle);
    float s = sin(angle);
    vec2 rot = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
    float lenT = pointillismStrokeT(uPointillismStrokeLength, POINTILLISM_STROKE_LEN_MIN, POINTILLISM_STROKE_LEN_MAX);
    float widT = pointillismStrokeT(uPointillismStrokeWidth, POINTILLISM_STROKE_WID_MIN, POINTILLISM_STROKE_WID_MAX);
    float lenAxis = 1.0 + mix(0.02, 0.82, lenT);
    float widAxis = mix(1.16, 0.52, widT);
    widAxis *= mix(0.90, 1.10, clamp(uPointillismBrushAspect, 0.5, 1.2));
    return vec2(rot.x / lenAxis, rot.y * widAxis);
}

float pointillismRadialAlpha(float A) {
    float hard = clamp(uPointillismBrushHardness, 0.0, 1.0);
    float coreEnd = mix(0.52, 0.82, hard);
    float aa = max(fwidth(A) * 1.6, 0.004);
    return (1.0 - smoothstep(coreEnd - aa, 1.0 + aa * 0.5, A)) * clamp(uPointillismPaintOpacity, 0.0, 1.0);
}

// 笔触内颜料肌理（gsplatPS UV）；边缘 fade 保硬边
vec4 pointillismPigmentDaub(vec2 shapeUV, float A) {
    float grain = clamp(uPointillismPaintGrain, 0.0, 1.0);
    if (grain < 0.001) {
        return vec4(1.0);
    }

    vec2 strokeSeed = gaussianColor.rg * 13.7 + gaussianColor.ba * 9.3 + uPointillismSeed * 0.07;
    vec2 p = shapeUV * mix(3.2, 8.0, grain) + strokeSeed;
    float coarse = pointillismFbm3(p);
    float fine = pointillismValueNoise(p * 11.0 + vec2(strokeSeed.y, strokeSeed.x));
    float streak = pointillismValueNoise(vec2(shapeUV.x * 1.55 + strokeSeed.x, shapeUV.y * 6.4 + strokeSeed.y));
    float pigment = coarse * 0.46 + fine * 0.34 + streak * 0.20;

    float edgeFade = 1.0 - smoothstep(mix(0.48, 0.80, grain), 0.96, A);
    float g = (pigment - 0.5) * grain * edgeFade * 1.18;
    float luma = 1.0 + g * 0.54;
    float alpha = 1.0 + g * 0.66;
    float warm = g * 0.11;
    vec3 rgb = vec3(luma + warm, luma, luma - warm * 0.58);
    return vec4(rgb, alpha);
}
`;

const WGSL_INSERT = /* wgsl */`

uniform uPointillismStrokeLength: f32;
uniform uPointillismStrokeWidth: f32;
uniform uPointillismBrushAspect: f32;
uniform uPointillismBrushHardness: f32;
uniform uPointillismPaintOpacity: f32;
uniform uPointillismPaintGrain: f32;
uniform uPointillismSeed: f32;

const POINTILLISM_STROKE_LEN_MIN: f32 = 0.15;
const POINTILLISM_STROKE_LEN_MAX: f32 = 2.5;
const POINTILLISM_STROKE_WID_MIN: f32 = 0.15;
const POINTILLISM_STROKE_WID_MAX: f32 = 1.85;

fn pointillismStrokeT(v: f32, lo: f32, hi: f32) -> f32 {
    return clamp((v - lo) / (hi - lo), 0.0, 1.0);
}

fn pointillismPsHash(p: vec2f) -> f32 {
    return fract(sin(dot(p, vec2f(12.9898, 78.233)) + uniform.uPointillismSeed * 0.13) * 43758.5453);
}

fn pointillismValueNoise(p: vec2f) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    let a = pointillismPsHash(i);
    let b = pointillismPsHash(i + vec2f(1.0, 0.0));
    let c = pointillismPsHash(i + vec2f(0.0, 1.0));
    let d = pointillismPsHash(i + vec2f(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn pointillismFbm3(p: vec2f) -> f32 {
    var v: f32 = 0.0;
    v += 0.5 * pointillismValueNoise(p);
    v += 0.25 * pointillismValueNoise(p * 2.1 + vec2f(1.7, 9.2));
    v += 0.125 * pointillismValueNoise(p * 4.2 + vec2f(8.3, 2.8));
    return v / 0.875;
}

fn pointillismShapeUV(uv: vec2f) -> vec2f {
    let angle = pointillismPsHash(vec2f(gaussianColor.r, gaussianColor.g) + uniform.uPointillismSeed * 0.13) * 6.2831853;
    let c = cos(angle);
    let s = sin(angle);
    let rot = vec2f(c * uv.x - s * uv.y, s * uv.x + c * uv.y);
    let lenT = pointillismStrokeT(uniform.uPointillismStrokeLength, POINTILLISM_STROKE_LEN_MIN, POINTILLISM_STROKE_LEN_MAX);
    let widT = pointillismStrokeT(uniform.uPointillismStrokeWidth, POINTILLISM_STROKE_WID_MIN, POINTILLISM_STROKE_WID_MAX);
    let lenAxis = 1.0 + mix(0.02, 0.82, lenT);
    var widAxis = mix(1.16, 0.52, widT);
    widAxis *= mix(0.90, 1.10, clamp(uniform.uPointillismBrushAspect, 0.5, 1.2));
    return vec2f(rot.x / lenAxis, rot.y * widAxis);
}

fn pointillismRadialAlpha(A: half) -> half {
    let hard = clamp(uniform.uPointillismBrushHardness, 0.0, 1.0);
    let coreEnd = mix(0.52, 0.82, hard);
    let aa = max(fwidth(A) * 1.6, 0.004);
    let radial = 1.0 - smoothstep(coreEnd - aa, 1.0 + aa * 0.5, f32(A));
    return half(radial * clamp(uniform.uPointillismPaintOpacity, 0.0, 1.0));
}

fn pointillismPigmentDaub(shapeUV: vec2f, A: f32) -> vec4f {
    let grain = clamp(uniform.uPointillismPaintGrain, 0.0, 1.0);
    if (grain < 0.001) {
        return vec4f(1.0);
    }

    let strokeSeed = vec2f(gaussianColor.r, gaussianColor.g) * 13.7 + vec2f(gaussianColor.b, gaussianColor.a) * 9.3 + uniform.uPointillismSeed * 0.07;
    let p = shapeUV * mix(3.2, 8.0, grain) + strokeSeed;
    let coarse = pointillismFbm3(p);
    let fine = pointillismValueNoise(p * 11.0 + vec2f(strokeSeed.y, strokeSeed.x));
    let streak = pointillismValueNoise(vec2f(shapeUV.x * 1.55 + strokeSeed.x, shapeUV.y * 6.4 + strokeSeed.y));
    let pigment = coarse * 0.46 + fine * 0.34 + streak * 0.20;

    let edgeFade = 1.0 - smoothstep(mix(0.48, 0.80, grain), 0.96, A);
    let g = (pigment - 0.5) * grain * edgeFade * 1.18;
    let luma = 1.0 + g * 0.54;
    let alpha = 1.0 + g * 0.66;
    let warm = g * 0.11;
    return vec4f(luma + warm, luma, luma - warm * 0.58, alpha);
}
`;

function patchGsplatPsGlsl(chunk: string): string {
    const withDecls = patchReplace(
        chunk,
        'varying mediump vec4 gaussianColor;\n',
        `varying mediump vec4 gaussianColor;\n${GLSL_INSERT}`,
        'glsl insert shape'
    );
    const withShape = patchReplace(
        withDecls,
        `	mediump float A = dot(gaussianUV, gaussianUV);
	if (A > 1.0) {
		discard;
	}
	mediump float alpha = normExp(A) * gaussianColor.a;`,
        `	vec2 shapeUV = pointillismShapeUV(gaussianUV);
	mediump float A = dot(shapeUV, shapeUV);
	if (A > 1.0) {
		discard;
	}
	vec4 daub = pointillismPigmentDaub(shapeUV, A);
	mediump float alpha = pointillismRadialAlpha(A) * daub.a;`,
        'glsl elliptical A'
    );
    return patchReplace(
        withShape,
        `		gl_FragColor = vec4(gaussianColor.xyz * alpha, alpha);`,
        `		gl_FragColor = vec4(gaussianColor.xyz * daub.rgb * alpha, alpha);`,
        'glsl pigment daub color'
    );
}

function patchGsplatPsWgsl(chunk: string): string {
    const withDecls = patchReplace(
        chunk,
        'varying gaussianColor: half4;\n',
        `varying gaussianColor: half4;\n${WGSL_INSERT}`,
        'wgsl insert shape'
    );
    const withShape = patchReplace(
        withDecls,
        `	let A: half = dot(gaussianUV, gaussianUV);
	if (A > half(1.0)) {
		discard;
		return output;
	}
	var alpha: half = normExp(A) * gaussianColor.a;`,
        `	let shapeUV = pointillismShapeUV(vec2f(gaussianUV));
	let A: half = dot(shapeUV, shapeUV);
	if (A > half(1.0)) {
		discard;
		return output;
	}
	let daub = pointillismPigmentDaub(shapeUV, f32(A));
	var alpha: half = pointillismRadialAlpha(A) * half(daub.a);`,
        'wgsl elliptical A'
    );
    return patchReplace(
        withShape,
        `		output.color = vec4f(vec3f(gaussianColor.xyz * alpha), f32(alpha));`,
        `		output.color = vec4f(vec3f(gaussianColor.xyz * daub.rgb * alpha), f32(alpha));`,
        'wgsl pigment daub color'
    );
}

function resolveGsplatPsChunk(device: GraphicsDevice, lang: string): string | null {
    return ShaderChunks.get(device, lang).get('gsplatPS') ?? null;
}

function findCameraEntity(root: Entity): Entity | null {
    return root.findComponent('camera')?.entity ?? null;
}

class GsplatPersistentPointillismStipple extends GsplatShaderEffect {
    static scriptName = 'gsplatPersistentPointillismStipple';

    private readonly _savedPsChunks = new Map<Material, SavedPsChunks>();

    private _postController: PointillismPostController | null = null;

    private _camera: CameraComponent | null = null;

    brushSize = Number.NaN;

    brushAspect = Number.NaN;

    brushHardness = POINTILLISM_DEFAULTS.brushHardness;

    colorVibration = Number.NaN;

    darkPaintBoost = Number.NaN;

    highlightSkip = Number.NaN;

    dotScale = POINTILLISM_DEFAULTS.dotScale;

    dotSizeFactor = POINTILLISM_DEFAULTS.dotSizeFactor;

    strokeAspect = POINTILLISM_DEFAULTS.strokeAspect;

    roundness = POINTILLISM_DEFAULTS.roundness;

    strokeSoftness = POINTILLISM_DEFAULTS.strokeSoftness;

    strokeLength = POINTILLISM_DEFAULTS.strokeLength;

    strokeWidth = POINTILLISM_DEFAULTS.strokeWidth;

    shapeJitter = POINTILLISM_DEFAULTS.shapeJitter;

    paintThickness = POINTILLISM_DEFAULTS.paintThickness;

    paintOpacity = POINTILLISM_DEFAULTS.paintOpacity;

    paintGrain = POINTILLISM_DEFAULTS.paintGrain;

    saturation = POINTILLISM_DEFAULTS.saturation;

    lumaLevels = POINTILLISM_DEFAULTS.lumaLevels;

    contrastDotMix = POINTILLISM_DEFAULTS.contrastDotMix;

    warmCoolSplit = POINTILLISM_DEFAULTS.warmCoolSplit;

    paletteStrength = POINTILLISM_DEFAULTS.paletteStrength;

    paletteIndex = POINTILLISM_DEFAULTS.paletteIndex;

    sourceStructureBlend = POINTILLISM_DEFAULTS.sourceStructureBlend;

    highlightSparsity = POINTILLISM_DEFAULTS.highlightSparsity;

    darkDensityBoost = POINTILLISM_DEFAULTS.darkDensityBoost;

    seed = POINTILLISM_DEFAULTS.seed;

    minVisibleAlpha = POINTILLISM_DEFAULTS.minVisibleAlpha;

    dotRadiusPx = POINTILLISM_DEFAULTS.dotRadiusPx;

    gapSpacing = POINTILLISM_DEFAULTS.gapSpacing;

    denoiseStrength = POINTILLISM_DEFAULTS.denoiseStrength;

    gapFill = POINTILLISM_DEFAULTS.gapFill;

    postEffectEnabled = POINTILLISM_DEFAULTS.postEffectEnabled;

    stippleSize = POINTILLISM_DEFAULTS.stippleSize;

    levels = POINTILLISM_DEFAULTS.levels;

    levelRange = POINTILLISM_DEFAULTS.levelRange;

    ditherSpread = POINTILLISM_DEFAULTS.ditherSpread;

    paperStrength = POINTILLISM_DEFAULTS.paperStrength;

    paperTint: [number, number, number] = [...POINTILLISM_DEFAULTS.paperTint];

    edgeStrength = POINTILLISM_DEFAULTS.edgeStrength;

    initialize() {
        super.initialize();
        this.on('enable', () => this.applyPostConfig(true));
        this.on('disable', () => {
            this._postController?.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
            this.app.renderNextFrame = true;
        });

        const global = (this.app as { __global?: { events?: { on: Function; off: Function } } }).__global;
        const onCameraPipelineChanged = () => {
            if (!this.enabled) {
                return;
            }
            this.app.once('frameend', () => {
                this.syncMaterialsAndShaders();
                this.updateEffect(this.effectTime, 0);
            });
        };
        global?.events?.on('postEffect:changed', onCameraPipelineChanged);
        this.on('destroy', () => {
            global?.events?.off('postEffect:changed', onCameraPipelineChanged);
        });
    }

    private getAppState() {
        return (this.app as { __global?: { state?: import('../../../../types').State } }).__global?.state;
    }

    /** 一次性 reveal 独占 gsplatModifyVS 时，点彩仅保留 gsplatPS patch，不写 modify */
    private shouldSuppressPointillismModifyForOneShotReveal(): boolean {
        return isOneShotRevealPlayingExclusiveGsplat(this.getAppState());
    }

    private _postMountWanted: boolean | undefined;

    /** UI / 协议热更新：同步 uniform 与后处理（对齐 palette-pixel / yiyun-dianran） */
    applyConfig() {
        this.syncMaterialsAndShaders();
        this.updateEffect(this.effectTime, 0);
        this.applyPostConfig(false);
        this.app.renderNextFrame = true;
    }

    /** 仅刷新后处理挂载（对齐 yiyun-dianran.applyPostEffectConfig） */
    applyPostEffectConfig() {
        this.applyPostConfig(true);
        this.app.renderNextFrame = true;
    }

    getShaderGLSL() {
        return pointillismModifyGlsl;
    }

    getShaderWGSL() {
        return pointillismModifyWgsl;
    }

    private readonly resolveCameraFrame = (): CameraFrame | null => {
        return (this.app as { getCameraFrame?: () => CameraFrame | null | undefined }).getCameraFrame?.() ?? null;
    };

    applyPostConfig(forceCameraReconfigure = false) {
        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera ?? null;
        if (!camera) {
            return;
        }

        const cameraRecreated = !this._postController || this._camera !== camera;
        if (cameraRecreated) {
            this._postController?.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
            this._postController = new PointillismPostController(this.app, camera);
            this._camera = camera;
        }

        const wantPost = this.enabled && coercePointillismBool(
            this.postEffectEnabled,
            POINTILLISM_DEFAULTS.postEffectEnabled
        );
        const mountChanged = forceCameraReconfigure
            || cameraRecreated
            || this._postMountWanted !== wantPost;
        this._postMountWanted = wantPost;

        const global = (this.app as { __global?: { events?: { fire: (name: string) => void } } }).__global;

        // 仅在挂载状态变化时通知 CameraFrame；避免调点径等参数时反复 configureCamera 导致材质脱节
        if (mountChanged && wantPost) {
            global?.events?.fire('postEffect:changed');
        }

        this._postController.apply(this.buildPostSettings(), {
            getCameraFrame: this.resolveCameraFrame
        });

        if (mountChanged && !wantPost) {
            global?.events?.fire('postEffect:changed');
        }
    }

    private buildPostSettings() {
        const contrastDotMix = clamp(this.contrastDotMix, 0, POINTILLISM_CONTRAST_DOT_MIX_MAX);
        const edgeStrength = clamp(this.edgeStrength, 0, 1);
        return {
            enabled: this.enabled,
            postEffectEnabled: coercePointillismBool(
                this.postEffectEnabled,
                POINTILLISM_DEFAULTS.postEffectEnabled
            ),
            stippleSize: this.stippleSize,
            paletteIndex: this.paletteIndex,
            paletteStrength: this.paletteStrength,
            levels: this.levels,
            levelRange: this.levelRange,
            ditherSpread: this.ditherSpread,
            warmCoolSplit: this.warmCoolSplit,
            sourceStructureBlend: this.sourceStructureBlend,
            saturation: this.saturation,
            complementaryMix: resolvePointillismComplementaryMix(contrastDotMix),
            contrastDotMix,
            seed: this.seed,
            paperStrength: this.paperStrength,
            paperTint: [...this.paperTint],
            edgeThreshold: resolvePointillismEdgeThreshold(edgeStrength),
            edgeStrength,
            denoiseStrength: clamp(
                Number.isFinite(this.denoiseStrength)
                    ? this.denoiseStrength
                    : POINTILLISM_DEFAULTS.denoiseStrength,
                0,
                1
            ),
            gapFill: clamp(
                Number.isFinite(this.gapFill) ? this.gapFill : POINTILLISM_DEFAULTS.gapFill,
                0,
                1
            ),
            dotRadiusPx: this.dotRadiusPx,
            gapSpacing: this.gapSpacing,
            brushHardness: clamp(
                Number.isFinite(this.brushHardness)
                    ? this.brushHardness
                    : POINTILLISM_DEFAULTS.brushHardness,
                0,
                1
            ),
            brushSize: Number.isFinite(this.brushSize) ? this.brushSize : POINTILLISM_DEFAULTS.brushSize
        };
    }

    applyShaderToMaterial(material: Material) {
        this.patchFragmentShader(material);
        if (!this.shouldSuppressPointillismModifyForOneShotReveal()) {
            super.applyShaderToMaterial(material);
        }
        this.pushPointillismUniforms();
    }

    applyShaders() {
        super.applyShaders();
        if (!this.shouldSuppressPointillismModifyForOneShotReveal()) {
            for (const material of this.materialsApplied) {
                this.ensureModifyShader(material);
            }
        }
        this.pushPointillismUniforms();
        this.applyPostConfig(true);
    }

    private collectActiveUnifiedMaterials(): Set<Material> {
        const out = new Set<Material>();
        // @ts-ignore runtime gsplat system
        const gsplatSystem = this.app.systems.gsplat;
        const scene = this.app.scene;
        const composition = scene.layers;
        const componentLayers = this.entity.gsplat?.layers;
        if (!gsplatSystem || !componentLayers) {
            return out;
        }

        let targetCameras;
        if (this.camera?.camera) {
            const inner = this.camera.camera.camera;
            targetCameras = inner ? [inner] : composition.cameras.map((c) => c.camera);
        } else {
            targetCameras = composition.cameras.map((cameraComponent) => cameraComponent.camera);
        }

        for (const camera of targetCameras) {
            for (const layerId of componentLayers) {
                if (camera.layers.indexOf(layerId) < 0) {
                    continue;
                }
                const layer = composition.getLayerById(layerId);
                if (!layer) {
                    continue;
                }
                const material = gsplatSystem.getGSplatMaterial(camera, layer);
                if (material) {
                    out.add(material);
                }
            }
        }
        return out;
    }

    /** LOD / CameraFrame 换材质后：刷新材质集合并补 gsplatPS / gsplatModifyVS */
    private syncMaterialsAndShaders(): boolean {
        if (!this.enabled || !this.initialized) {
            return false;
        }

        let repaired = false;

        if (this.entity.gsplat?.unified) {
            const active = this.collectActiveUnifiedMaterials();
            for (const material of [...this.materialsApplied]) {
                if (!active.has(material)) {
                    this.restoreFragmentShader(material);
                    this.materialsApplied.delete(material);
                }
            }
            for (const material of active) {
                if (!this.materialsApplied.has(material)) {
                    this.applyShaderToMaterial(material);
                    this.materialsApplied.add(material);
                    repaired = true;
                } else if (this.ensureFragmentShaderPatch(material)) {
                    repaired = true;
                }
            }
            if (active.size > 0) {
                this.needsRetry = false;
            }
        } else {
            for (const material of [...this.materialsApplied]) {
                if (this.ensureFragmentShaderPatch(material)) {
                    repaired = true;
                }
            }
        }

        if (!this.shouldSuppressPointillismModifyForOneShotReveal()) {
            for (const material of this.materialsApplied) {
                if (this.ensureModifyShader(material)) {
                    repaired = true;
                }
            }
        }

        return repaired;
    }

    private ensureFragmentShaderPatch(material: Material): boolean {
        const device = this.app.graphicsDevice as GraphicsDevice;
        const lang = device?.isWebGPU ? SHADERLANGUAGE_WGSL : SHADERLANGUAGE_GLSL;
        const psChunk = material.getShaderChunks(lang).get('gsplatPS');
        const psOk = typeof psChunk === 'string' && psChunk.includes('pointillismShapeUV');
        if (psOk) {
            return false;
        }
        if (this._savedPsChunks.has(material)) {
            this._savedPsChunks.delete(material);
        }
        this.patchFragmentShader(material);
        return true;
    }

    private ensureModifyShader(material: Material): boolean {
        const device = this.app.graphicsDevice as GraphicsDevice;
        const lang = device?.isWebGPU ? SHADERLANGUAGE_WGSL : SHADERLANGUAGE_GLSL;
        const expectedModify = lang === SHADERLANGUAGE_WGSL ? this.getShaderWGSL() : this.getShaderGLSL();
        const modifyChunk = material.getShaderChunks(lang).get('gsplatModifyVS');
        const modifyOk = typeof modifyChunk === 'string' && modifyChunk.includes('modifySplatRotationScale');
        if (modifyOk) {
            return false;
        }
        material.getShaderChunks(lang).set('gsplatModifyVS', expectedModify);
        material.update();
        return true;
    }

    removeShaders() {
        const mats = new Set(this.materialsApplied);
        for (const material of mats) {
            this.restoreFragmentShader(material);
        }
        for (const material of this._savedPsChunks.keys()) {
            if (!mats.has(material)) {
                this.restoreFragmentShader(material);
            }
        }

        super.removeShaders();

        this._postMountWanted = undefined;
        this._postController?.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
    }

    private patchFragmentShader(material: Material): void {
        if (this._savedPsChunks.has(material)) return;

        const device = this.app.graphicsDevice as GraphicsDevice;
        const saved: SavedPsChunks = {};
        const glslBase = resolveGsplatPsChunk(device, SHADERLANGUAGE_GLSL);
        const wgslBase = resolveGsplatPsChunk(device, SHADERLANGUAGE_WGSL);

        try {
            if (glslBase) {
                saved.glsl = material.getShaderChunks(SHADERLANGUAGE_GLSL).get('gsplatPS') ?? undefined;
                material.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatPS', patchGsplatPsGlsl(glslBase));
            }
            if (wgslBase) {
                saved.wgsl = material.getShaderChunks(SHADERLANGUAGE_WGSL).get('gsplatPS') ?? undefined;
                material.getShaderChunks(SHADERLANGUAGE_WGSL).set('gsplatPS', patchGsplatPsWgsl(wgslBase));
            }
            material.clearVariants();
            material.update();
            this._savedPsChunks.set(material, saved);
        } catch (e) {
            console.warn('[pointillism-stipple] failed to patch gsplatPS:', e);
            if (saved.glsl === undefined) {
                material.getShaderChunks(SHADERLANGUAGE_GLSL).delete('gsplatPS');
            } else {
                material.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatPS', saved.glsl);
            }
            if (saved.wgsl === undefined) {
                material.getShaderChunks(SHADERLANGUAGE_WGSL).delete('gsplatPS');
            } else {
                material.getShaderChunks(SHADERLANGUAGE_WGSL).set('gsplatPS', saved.wgsl);
            }
            material.clearVariants();
            material.update();
        }
    }

    private restoreFragmentShader(material: Material): void {
        const saved = this._savedPsChunks.get(material);
        if (!saved) return;
        if (saved.glsl === undefined) {
            material.getShaderChunks(SHADERLANGUAGE_GLSL).delete('gsplatPS');
        } else {
            material.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatPS', saved.glsl);
        }
        if (saved.wgsl === undefined) {
            material.getShaderChunks(SHADERLANGUAGE_WGSL).delete('gsplatPS');
        } else {
            material.getShaderChunks(SHADERLANGUAGE_WGSL).set('gsplatPS', saved.wgsl);
        }
        material.clearVariants();
        material.update();
        this._savedPsChunks.delete(material);
    }

    private readonly _viewPos = new Float32Array(3);
    private readonly _viewPosScratch = new Vec3();
    private _refViewDistCache = 0;

    private resolveRefViewDist(camWorld: Vec3 | undefined): number {
        if (this._refViewDistCache > 0) {
            return this._refViewDistCache;
        }
        const gsplat = this.entity.gsplat as {
            customAabb?: { halfExtents: Vec3 };
            resource?: { aabb?: { halfExtents: Vec3 } };
        } | undefined;
        const he = gsplat?.customAabb?.halfExtents ?? gsplat?.resource?.aabb?.halfExtents;
        if (he) {
            this._refViewDistCache = Math.max(he.x, he.y, he.z) * 3.0;
        } else if (camWorld) {
            this._refViewDistCache = Math.max(this.entity.getPosition().distance(camWorld), 1.0);
        } else {
            this._refViewDistCache = 10.0;
        }
        return this._refViewDistCache;
    }

    updateEffect(_effectTime: number, _dt: number) {
        this.pushPointillismUniforms();
    }

    private pushPointillismUniforms() {
        const brushSize = Number.isFinite(this.brushSize)
            ? this.brushSize
            : POINTILLISM_DEFAULTS.brushSize;
        const brushAspect = Number.isFinite(this.brushAspect)
            ? this.brushAspect
            : this.strokeAspect;
        const brushHardness = Number.isFinite(this.brushHardness)
            ? this.brushHardness
            : 1 - this.strokeSoftness;
        const colorVibration = Number.isFinite(this.colorVibration)
            ? this.colorVibration
            : this.contrastDotMix;
        const darkPaintBoost = Number.isFinite(this.darkPaintBoost)
            ? this.darkPaintBoost
            : this.darkDensityBoost;
        const highlightSkip = Number.isFinite(this.highlightSkip)
            ? this.highlightSkip
            : this.highlightSparsity;

        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera;
        const camWorld = cameraEntity?.getPosition();
        const unified = !!(this.entity.gsplat as { unified?: boolean } | undefined)?.unified;
        if (camWorld) {
            if (unified) {
                this._viewPosScratch.copy(camWorld);
            } else {
                // modify 非 unified 路径为 model space（与 Reveal 约定一致）
                this._viewPosScratch.set(-camWorld.x, -camWorld.y, camWorld.z);
            }
            this._viewPos[0] = this._viewPosScratch.x;
            this._viewPos[1] = this._viewPosScratch.y;
            this._viewPos[2] = this._viewPosScratch.z;
        }

        const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement | undefined;
        const canvasHeight = Math.max(canvas?.clientHeight ?? 720, 1);
        const fovRad = ((camera?.fov ?? 45) * Math.PI) / 180;
        const tanHalfFov = Math.tan(fovRad * 0.5);
        const targetPx = resolvePointillismDotRadiusPx(this.dotRadiusPx, this.stippleSize, brushSize);
        const maxPx = Math.min(POINTILLISM_DOT_RADIUS_PX_MAX, targetPx * 1.25);
        const dotRadiusSlope = (targetPx * 2 * tanHalfFov) / canvasHeight;
        const maxDotRadiusSlope = (maxPx * 2 * tanHalfFov) / canvasHeight;
        const refViewDist = this.resolveRefViewDist(camWorld);
        const bucketSlope = dotRadiusSlope * 1.75;

        this.setUniform(PU.viewPos, this._viewPos);
        this.setUniform(PU.dotRadiusSlope, dotRadiusSlope);
        this.setUniform(PU.maxDotRadiusSlope, maxDotRadiusSlope);
        this.setUniform(PU.refViewDist, refViewDist);
        this.setUniform(PU.bucketSlope, bucketSlope);
        this.setUniform(PU.brushSize, 1.0);
        this.setUniform(PU.brushAspect, clamp(brushAspect, 0.5, 1.2));
        this.setUniform(PU.brushHardness, clamp(brushHardness, 0, 1));
        this.setUniform(PU.colorVibration, clamp(colorVibration, 0, 1));
        this.setUniform(PU.darkPaintBoost, clamp(darkPaintBoost, 0, 1));
        this.setUniform(PU.highlightSkip, clamp(highlightSkip, 0, 1));
        this.setUniform(PU.dotScale, clamp(this.dotScale, 0.85, 1.15));
        this.setUniform(PU.dotSizeFactor, clamp(this.dotSizeFactor, 0.01, 0.32));
        this.setUniform(PU.strokeAspect, clamp(this.strokeAspect, 0.85, 2.2));
        this.setUniform(PU.roundness, clamp(this.roundness, 0, 1));
        this.setUniform(PU.strokeSoftness, clamp(this.strokeSoftness, 0.08, 0.55));
        this.setUniform(PU.strokeLength, clamp(this.strokeLength, POINTILLISM_STROKE_LENGTH_MIN, POINTILLISM_STROKE_LENGTH_MAX));
        this.setUniform(PU.strokeWidth, clamp(this.strokeWidth, POINTILLISM_STROKE_WIDTH_MIN, POINTILLISM_STROKE_WIDTH_MAX));
        this.setUniform(PU.shapeJitter, clamp(this.shapeJitter, 0, 0.08));
        this.setUniform(PU.paintThickness, clamp(this.paintThickness, 0.5, 1.5));
        this.setUniform(PU.paintOpacity, clamp(this.paintOpacity, POINTILLISM_PAINT_OPACITY_MIN, POINTILLISM_PAINT_OPACITY_MAX));
        this.setUniform(
            PU.paintGrain,
            clamp(
                Number.isFinite(this.paintGrain) ? this.paintGrain : POINTILLISM_DEFAULTS.paintGrain,
                POINTILLISM_PAINT_GRAIN_MIN,
                POINTILLISM_PAINT_GRAIN_MAX
            )
        );
        this.setUniform(PU.saturation, clamp(this.saturation, 0, 3));
        this.setUniform(PU.lumaLevels, clamp(Math.floor(this.lumaLevels), 2, 24));
        this.setUniform(PU.contrastDotMix, clamp(this.contrastDotMix, 0, POINTILLISM_CONTRAST_DOT_MIX_MAX));
        this.setUniform(
            PU.complementaryMix,
            resolvePointillismComplementaryMix(clamp(this.contrastDotMix, 0, POINTILLISM_CONTRAST_DOT_MIX_MAX))
        );
        this.setUniform(PU.warmCoolSplit, clamp(this.warmCoolSplit, 0, 1));
        this.setUniform(PU.paletteStrength, clamp(this.paletteStrength, 0, 1));
        this.setUniform(PU.paletteIndex, clamp(Math.floor(this.paletteIndex), 0, 3));
        this.setUniform(PU.sourceStructureBlend, clamp(this.sourceStructureBlend, 0, 1));
        this.setUniform(PU.highlightSparsity, clamp(this.highlightSparsity, 0, 1));
        this.setUniform(PU.darkDensityBoost, clamp(this.darkDensityBoost, 0, 1));
        this.setUniform(PU.seed, Number.isFinite(this.seed) ? this.seed : POINTILLISM_DEFAULTS.seed);
        const denoiseT = clamp(
            Number.isFinite(this.denoiseStrength)
                ? this.denoiseStrength
                : POINTILLISM_DEFAULTS.denoiseStrength,
            0,
            1
        );
        this.setUniform(PU.denoiseStrength, denoiseT);
        this.setUniform(
            PU.minVisibleAlpha,
            resolvePointillismMinVisibleAlpha(denoiseT)
        );
        this.setUniform(
            PU.gapFill,
            clamp(
                Number.isFinite(this.gapFill) ? this.gapFill : POINTILLISM_DEFAULTS.gapFill,
                0,
                1
            )
        );
        this.setUniform(
            PU.gapSpacing,
            clamp(
                Number.isFinite(this.gapSpacing) ? this.gapSpacing : POINTILLISM_DEFAULTS.gapSpacing,
                POINTILLISM_GAP_SPACING_MIN,
                POINTILLISM_GAP_SPACING_MAX
            )
        );

        if (!this.shouldSuppressPointillismModifyForOneShotReveal()) {
            for (const material of this.materialsApplied) {
                this.ensureModifyShader(material);
            }
        }
    }

    destroy() {
        super.destroy();
        this._postController?.destroy();
        this._postController = null;
        this._camera = null;
    }
}

export { GsplatPersistentPointillismStipple };
