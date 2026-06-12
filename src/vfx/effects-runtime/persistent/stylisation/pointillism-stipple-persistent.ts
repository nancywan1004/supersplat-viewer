import {
    Entity,
    Material,
    SHADERLANGUAGE_GLSL,
    SHADERLANGUAGE_WGSL,
    ShaderChunks,
    type CameraComponent,
    type CameraFrame,
    type GraphicsDevice
} from 'playcanvas';

import {
    POINTILLISM_DEFAULTS,
    POINTILLISM_DOT_RADIUS_PX_MAX,
    POINTILLISM_PAINT_OPACITY_MAX,
    POINTILLISM_PAINT_OPACITY_MIN,
    POINTILLISM_STROKE_LENGTH_MAX,
    POINTILLISM_STROKE_LENGTH_MIN,
    POINTILLISM_STROKE_WIDTH_MAX,
    POINTILLISM_STROKE_WIDTH_MIN,
    POINTILLISM_UNIFORM_NAMES as PU,
    pointillismModifyGlsl,
    pointillismModifyWgsl,
    resolvePointillismDotRadiusPx
} from './pointillism-stipple-shaders';
import {
    coercePointillismBool,
    DEFAULT_POINTILLISM_POST_SETTINGS,
    PointillismPostController
} from './pointillism-stipple-post';
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
`;

const WGSL_INSERT = /* wgsl */`

uniform uPointillismStrokeLength: f32;
uniform uPointillismStrokeWidth: f32;
uniform uPointillismBrushAspect: f32;
uniform uPointillismBrushHardness: f32;
uniform uPointillismPaintOpacity: f32;
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
`;

function patchGsplatPsGlsl(chunk: string): string {
    const withDecls = patchReplace(
        chunk,
        'varying mediump vec4 gaussianColor;\n',
        `varying mediump vec4 gaussianColor;\n${GLSL_INSERT}`,
        'glsl insert shape'
    );
    return patchReplace(
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
	mediump float alpha = pointillismRadialAlpha(A);`,
        'glsl elliptical A'
    );
}

function patchGsplatPsWgsl(chunk: string): string {
    const withDecls = patchReplace(
        chunk,
        'varying gaussianColor: half4;\n',
        `varying gaussianColor: half4;\n${WGSL_INSERT}`,
        'wgsl insert shape'
    );
    return patchReplace(
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
	var alpha: half = pointillismRadialAlpha(A);`,
        'wgsl elliptical A'
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

    brushDensity = Number.NaN;

    brushAspect = Number.NaN;

    brushHardness = POINTILLISM_DEFAULTS.brushHardness;

    colorVibration = Number.NaN;

    darkPaintBoost = Number.NaN;

    highlightSkip = Number.NaN;

    dotScale = POINTILLISM_DEFAULTS.dotScale;

    dotSizeFactor = POINTILLISM_DEFAULTS.dotSizeFactor;

    strokeAspect = POINTILLISM_DEFAULTS.strokeAspect;

    roundness = POINTILLISM_DEFAULTS.roundness;

    density = POINTILLISM_DEFAULTS.density;

    strokeSoftness = POINTILLISM_DEFAULTS.strokeSoftness;

    strokeLength = POINTILLISM_DEFAULTS.strokeLength;

    strokeWidth = POINTILLISM_DEFAULTS.strokeWidth;

    shapeJitter = POINTILLISM_DEFAULTS.shapeJitter;

    paintThickness = POINTILLISM_DEFAULTS.paintThickness;

    paintOpacity = POINTILLISM_DEFAULTS.paintOpacity;

    saturation = POINTILLISM_DEFAULTS.saturation;

    lumaLevels = POINTILLISM_DEFAULTS.lumaLevels;

    contrastDotMix = POINTILLISM_DEFAULTS.contrastDotMix;

    complementaryMix = POINTILLISM_DEFAULTS.complementaryMix;

    warmCoolSplit = POINTILLISM_DEFAULTS.warmCoolSplit;

    paletteStrength = POINTILLISM_DEFAULTS.paletteStrength;

    paletteIndex = POINTILLISM_DEFAULTS.paletteIndex;

    sourceStructureBlend = POINTILLISM_DEFAULTS.sourceStructureBlend;

    highlightSparsity = POINTILLISM_DEFAULTS.highlightSparsity;

    darkDensityBoost = POINTILLISM_DEFAULTS.darkDensityBoost;

    seed = POINTILLISM_DEFAULTS.seed;

    minVisibleAlpha = POINTILLISM_DEFAULTS.minVisibleAlpha;

    dotRadiusPx = Number.NaN;

    postEffectEnabled = POINTILLISM_DEFAULTS.postEffectEnabled;

    stippleSize = POINTILLISM_DEFAULTS.stippleSize;

    levels = POINTILLISM_DEFAULTS.levels;

    levelRange = POINTILLISM_DEFAULTS.levelRange;

    ditherSpread = POINTILLISM_DEFAULTS.ditherSpread;

    paperStrength = POINTILLISM_DEFAULTS.paperStrength;

    paperTint: [number, number, number] = [...POINTILLISM_DEFAULTS.paperTint];

    edgeThreshold = POINTILLISM_DEFAULTS.edgeThreshold;

    edgeStrength = POINTILLISM_DEFAULTS.edgeStrength;

    initialize() {
        super.initialize();
        this.on('enable', () => this.applyPostConfig());
        this.on('disable', () => {
            this._postController?.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
            this.app.renderNextFrame = true;
        });
    }

    /** UI / 协议热更新：同步 uniform 与后处理（对齐 palette-pixel / yiyun-dianran） */
    applyConfig() {
        this.updateEffect(this.effectTime, 0);
        this.applyPostConfig();
        this.app.renderNextFrame = true;
    }

    /** 仅刷新后处理挂载（对齐 yiyun-dianran.applyPostEffectConfig） */
    applyPostEffectConfig() {
        this.applyPostConfig();
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

    applyPostConfig() {
        const cameraEntity = findCameraEntity(this.app.root);
        const camera = cameraEntity?.camera ?? null;
        if (!camera) {
            return;
        }

        if (!this._postController || this._camera !== camera) {
            this._postController?.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
            this._postController = new PointillismPostController(this.app, camera);
            this._camera = camera;
        }

        const wantPost = this.enabled && coercePointillismBool(
            this.postEffectEnabled,
            POINTILLISM_DEFAULTS.postEffectEnabled
        );
        const global = (this.app as { __global?: { events?: { fire: (name: string) => void } } }).__global;

        // 与 palette-pixel 一致：后处理依赖 CameraFrame，须先触发 configureCamera
        if (wantPost) {
            global?.events?.fire('postEffect:changed');
        }

        this._postController.apply(this.buildPostSettings(), {
            getCameraFrame: this.resolveCameraFrame
        });

        if (!wantPost) {
            global?.events?.fire('postEffect:changed');
        }
    }

    private buildPostSettings() {
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
            complementaryMix: this.complementaryMix,
            contrastDotMix: this.contrastDotMix,
            seed: this.seed,
            paperStrength: this.paperStrength,
            paperTint: [...this.paperTint],
            edgeThreshold: this.edgeThreshold,
            edgeStrength: this.edgeStrength
        };
    }

    applyShaderToMaterial(material: Material) {
        this.patchFragmentShader(material);
        super.applyShaderToMaterial(material);
        // LOD / unified 模式晚到的材质须立即写入 uniform，否则首帧 dotRadiusSlope=0 导致发糊或尺寸异常
        this.updateEffect(this.effectTime, 0);
    }

    applyShaders() {
        super.applyShaders();
        this.updateEffect(this.effectTime, 0);
        this.applyPostConfig();
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

    updateEffect(_effectTime: number, _dt: number) {
        const brushSize = Number.isFinite(this.brushSize)
            ? this.brushSize
            : POINTILLISM_DEFAULTS.brushSize;
        const brushDensity = Number.isFinite(this.brushDensity)
            ? this.brushDensity
            : this.density;
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
        const pos = cameraEntity?.getPosition();
        if (pos) {
            this._viewPos[0] = pos.x;
            this._viewPos[1] = pos.y;
            this._viewPos[2] = pos.z;
        }

        const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement | undefined;
        const canvasHeight = Math.max(canvas?.clientHeight ?? 720, 1);
        const fovRad = ((camera?.fov ?? 45) * Math.PI) / 180;
        const tanHalfFov = Math.tan(fovRad * 0.5);
        const targetPx = resolvePointillismDotRadiusPx(this.dotRadiusPx, this.stippleSize, brushSize);
        const maxPx = Math.min(POINTILLISM_DOT_RADIUS_PX_MAX, targetPx * 1.25);
        const dotRadiusSlope = (targetPx * 2 * tanHalfFov) / canvasHeight;
        const maxDotRadiusSlope = (maxPx * 2 * tanHalfFov) / canvasHeight;

        this.setUniform(PU.viewPos, this._viewPos);
        this.setUniform(PU.dotRadiusSlope, dotRadiusSlope);
        this.setUniform(PU.maxDotRadiusSlope, maxDotRadiusSlope);
        this.setUniform(PU.brushSize, 1.0);
        this.setUniform(PU.brushDensity, clamp(brushDensity, 0.15, 4.4));
        this.setUniform(PU.brushAspect, clamp(brushAspect, 0.5, 1.2));
        this.setUniform(PU.brushHardness, clamp(brushHardness, 0, 1));
        this.setUniform(PU.colorVibration, clamp(colorVibration, 0, 1));
        this.setUniform(PU.darkPaintBoost, clamp(darkPaintBoost, 0, 1));
        this.setUniform(PU.highlightSkip, clamp(highlightSkip, 0, 1));
        this.setUniform(PU.dotScale, clamp(this.dotScale, 0.85, 1.15));
        this.setUniform(PU.dotSizeFactor, clamp(this.dotSizeFactor, 0.01, 0.32));
        this.setUniform(PU.strokeAspect, clamp(this.strokeAspect, 0.85, 2.2));
        this.setUniform(PU.roundness, clamp(this.roundness, 0, 1));
        this.setUniform(PU.density, clamp(this.density, 0.15, 4.4));
        this.setUniform(PU.strokeSoftness, clamp(this.strokeSoftness, 0.08, 0.55));
        this.setUniform(PU.strokeLength, clamp(this.strokeLength, POINTILLISM_STROKE_LENGTH_MIN, POINTILLISM_STROKE_LENGTH_MAX));
        this.setUniform(PU.strokeWidth, clamp(this.strokeWidth, POINTILLISM_STROKE_WIDTH_MIN, POINTILLISM_STROKE_WIDTH_MAX));
        this.setUniform(PU.shapeJitter, clamp(this.shapeJitter, 0, 0.08));
        this.setUniform(PU.paintThickness, clamp(this.paintThickness, 0.5, 1.5));
        this.setUniform(PU.paintOpacity, clamp(this.paintOpacity, POINTILLISM_PAINT_OPACITY_MIN, POINTILLISM_PAINT_OPACITY_MAX));
        this.setUniform(PU.saturation, clamp(this.saturation, 0, 3));
        this.setUniform(PU.lumaLevels, clamp(Math.floor(this.lumaLevels), 2, 24));
        this.setUniform(PU.contrastDotMix, clamp(this.contrastDotMix, 0, 0.4));
        this.setUniform(PU.complementaryMix, clamp(this.complementaryMix, 0, 0.4));
        this.setUniform(PU.warmCoolSplit, clamp(this.warmCoolSplit, 0, 1));
        this.setUniform(PU.paletteStrength, clamp(this.paletteStrength, 0, 1));
        this.setUniform(PU.paletteIndex, clamp(Math.floor(this.paletteIndex), 0, 3));
        this.setUniform(PU.sourceStructureBlend, clamp(this.sourceStructureBlend, 0, 1));
        this.setUniform(PU.highlightSparsity, clamp(this.highlightSparsity, 0, 1));
        this.setUniform(PU.darkDensityBoost, clamp(this.darkDensityBoost, 0, 1));
        this.setUniform(PU.seed, Number.isFinite(this.seed) ? this.seed : POINTILLISM_DEFAULTS.seed);
        this.setUniform(PU.minVisibleAlpha, clamp(this.minVisibleAlpha, 0, 0.25));
    }

    destroy() {
        super.destroy();
        this._postController?.destroy();
        this._postController = null;
        this._camera = null;
    }
}

export { GsplatPersistentPointillismStipple };
