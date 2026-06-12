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
    POINTILLISM_UNIFORM_NAMES as PU,
    pointillismModifyGlsl,
    pointillismModifyWgsl
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

uniform float uPointillismStrokeSoftness;
uniform float uPointillismStrokeLength;
uniform float uPointillismStrokeWidth;
uniform float uPointillismShapeJitter;
uniform float uPointillismStrokeAspect;
uniform float uPointillismBrushAspect;
uniform float uPointillismBrushHardness;
uniform float uPointillismPaintThickness;
uniform float uPointillismSeed;
uniform float uPointillismMinVisibleAlpha;

float pointillismStrokeAngle(float splatId, vec4 color) {
    float seed = splatId;
    #ifdef DITHER_NONE
        seed = dot(color.rgb, vec3(12.9898, 78.233, 45.164)) * 997.0;
    #endif
    return seed * 2.399963 + uPointillismSeed * 0.01;
}

float pointillismDaubMask(vec2 uv, float splatId, vec4 color) {
    float angle = pointillismStrokeAngle(splatId, color);
    float c = cos(angle);
    float s = sin(angle);
    vec2 ruv = vec2(c * uv.x - s * uv.y, s * uv.x + c * uv.y);

    float aspect = clamp(uPointillismBrushAspect, 0.85, 2.2);
    float strokeLen = clamp(uPointillismStrokeLength, 0.58, 1.18) * mix(1.0, aspect, 0.38);
    float strokeWid = clamp(uPointillismStrokeWidth, 0.42, 1.0) / mix(1.0, sqrt(aspect), 0.34);

    float hardness = clamp(uPointillismBrushHardness, 0.0, 1.0);
    float jitter = clamp(uPointillismShapeJitter, 0.0, 0.22);
    float wobble = sin(atan(ruv.y, ruv.x) * 6.0 + splatId * 0.73) * jitter;
    vec2 suv = ruv / vec2(max(strokeLen + wobble, 0.56), max(strokeWid - wobble * 0.28, 0.36));
    float ellipse = dot(suv, suv);
    float block = max(abs(suv.x), abs(suv.y) * mix(1.18, 1.42, jitter));
    float stamp = pow(abs(suv.x), 4.0) + pow(abs(suv.y) * mix(1.05, 1.32, jitter), 4.0);
    float shape = mix(mix(ellipse, block * block, 0.72), stamp, 0.22 + hardness * 0.28);

    float edgeWidth = mix(0.42, 0.012, hardness);
    float mask = 1.0 - smoothstep(1.0 - edgeWidth, 1.0 + edgeWidth, shape);
    float chip = step(0.10 + jitter * 0.06, fract(sin(dot(floor(suv * 7.0), vec2(41.17, 17.31)) + splatId) * 43758.5453));
    return clamp(mask * mix(0.78, 1.0, chip), 0.0, 1.0);
}

float pointillismPaintAlpha(float baseAlpha, vec2 uv, float splatId, vec4 color) {
    float mask = pointillismDaubMask(uv, splatId, color);
    float thickness = clamp(uPointillismPaintThickness, 0.5, 1.5);
    float bodyAlpha = baseAlpha * mix(0.88, 1.18, clamp(thickness - 0.5, 0.0, 1.0));
    return clamp(bodyAlpha * mask, 0.0, 1.0);
}
`;

const WGSL_INSERT = /* wgsl */`

uniform uPointillismStrokeSoftness: f32;
uniform uPointillismStrokeLength: f32;
uniform uPointillismStrokeWidth: f32;
uniform uPointillismShapeJitter: f32;
uniform uPointillismStrokeAspect: f32;
uniform uPointillismBrushAspect: f32;
uniform uPointillismBrushHardness: f32;
uniform uPointillismPaintThickness: f32;
uniform uPointillismSeed: f32;
uniform uPointillismMinVisibleAlpha: f32;

fn pointillismStrokeAngle(splatId: f32, color: half4) -> f32 {
    var seed = splatId;
    #ifdef DITHER_NONE
        seed = dot(vec3f(color.rgb), vec3f(12.9898, 78.233, 45.164)) * 997.0;
    #endif
    return seed * 2.399963 + uniform.uPointillismSeed * 0.01;
}

fn pointillismDaubMask(uv: half2, splatId: f32, color: half4) -> half {
    let uvf = vec2f(uv);
    let angle = pointillismStrokeAngle(splatId, color);
    let c = cos(angle);
    let s = sin(angle);
    let ruv = vec2f(c * uvf.x - s * uvf.y, s * uvf.x + c * uvf.y);

    let aspect = clamp(uniform.uPointillismBrushAspect, 0.85, 2.2);
    let strokeLen = clamp(uniform.uPointillismStrokeLength, 0.58, 1.18) * mix(1.0, aspect, 0.38);
    let strokeWid = clamp(uniform.uPointillismStrokeWidth, 0.42, 1.0) / mix(1.0, sqrt(aspect), 0.34);

    let hardness = clamp(uniform.uPointillismBrushHardness, 0.0, 1.0);
    let jitter = clamp(uniform.uPointillismShapeJitter, 0.0, 0.22);
    let wobble = sin(atan2(ruv.y, ruv.x) * 6.0 + splatId * 0.73) * jitter;
    let suv = ruv / vec2f(max(strokeLen + wobble, 0.56), max(strokeWid - wobble * 0.28, 0.36));
    let ellipse = dot(suv, suv);
    let block = max(abs(suv.x), abs(suv.y) * mix(1.18, 1.42, jitter));
    let stamp = pow(abs(suv.x), 4.0) + pow(abs(suv.y) * mix(1.05, 1.32, jitter), 4.0);
    let shape = mix(mix(ellipse, block * block, 0.72), stamp, 0.22 + hardness * 0.28);

    let edgeWidth = mix(0.42, 0.012, hardness);
    let mask = 1.0 - smoothstep(1.0 - edgeWidth, 1.0 + edgeWidth, shape);
    let chip = step(0.10 + jitter * 0.06, fract(sin(dot(floor(suv * 7.0), vec2f(41.17, 17.31)) + splatId) * 43758.5453));
    return half(clamp(mask * mix(0.78, 1.0, chip), 0.0, 1.0));
}

fn pointillismPaintAlpha(baseAlpha: half, uv: half2, splatId: f32, color: half4) -> half {
    let mask = pointillismDaubMask(uv, splatId, color);
    let thickness = clamp(uniform.uPointillismPaintThickness, 0.5, 1.5);
    let bodyAlpha = f32(baseAlpha) * mix(0.88, 1.18, clamp(thickness - 0.5, 0.0, 1.0));
    return half(clamp(bodyAlpha * f32(mask), 0.0, 1.0));
}
`;

function patchGsplatPsGlsl(chunk: string): string {
    const withDecls = patchReplace(
        chunk,
        'varying mediump vec4 gaussianColor;\n',
        `varying mediump vec4 gaussianColor;\n${GLSL_INSERT}`,
        'glsl insert uniforms'
    );
    return patchReplace(
        withDecls,
        `		if (alpha < alphaClipForward) {
			discard;
		}
		#ifndef DITHER_NONE
			opacityDither(alpha, id * 0.013);
		#endif
		gl_FragColor = vec4(gaussianColor.xyz * alpha, alpha);`,
        `		#ifndef DITHER_NONE
			float pointillismSplatId = id;
		#else
			float pointillismSplatId = dot(gaussianColor.rgb, vec3(12.9898, 78.233, 45.164)) * 997.0;
		#endif
		float paintAlpha = pointillismPaintAlpha(gaussianColor.a, gaussianUV, pointillismSplatId, gaussianColor);
		if (paintAlpha < max(uPointillismMinVisibleAlpha, alphaClipForward)) {
			discard;
		}
		gl_FragColor = vec4(gaussianColor.xyz * paintAlpha, paintAlpha);`,
        'glsl main output'
    );
}

function patchGsplatPsWgsl(chunk: string): string {
    const withDecls = patchReplace(
        chunk,
        'varying gaussianColor: half4;\n',
        `varying gaussianColor: half4;\n${WGSL_INSERT}`,
        'wgsl insert uniforms'
    );
    return patchReplace(
        withDecls,
        `		if (alpha < half(uniform.alphaClipForward)) {
			discard;
			return output;
		}
		#ifndef DITHER_NONE
			opacityDither(f32(alpha), id * 0.013);
		#endif
		output.color = vec4f(vec3f(gaussianColor.xyz * alpha), f32(alpha));`,
        `		#ifndef DITHER_NONE
			let pointillismSplatId = id;
		#else
			let pointillismSplatId = dot(vec3f(gaussianColor.rgb), vec3f(12.9898, 78.233, 45.164)) * 997.0;
		#endif
		let paintAlpha: half = pointillismPaintAlpha(gaussianColor.a, gaussianUV, pointillismSplatId, gaussianColor);
		if (paintAlpha < half(max(uniform.uPointillismMinVisibleAlpha, uniform.alphaClipForward))) {
			discard;
			return output;
		}
		output.color = vec4f(vec3f(gaussianColor.xyz * paintAlpha), f32(paintAlpha));`,
        'wgsl main output'
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

    brushHardness = Number.NaN;

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
            paperStrength: this.paperStrength,
            paperTint: [...this.paperTint],
            edgeThreshold: this.edgeThreshold,
            edgeStrength: this.edgeStrength
        };
    }

    applyShaderToMaterial(material: Material) {
        this.patchFragmentShader(material);
        super.applyShaderToMaterial(material);
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

    updateEffect(_effectTime: number, _dt: number) {
        const brushSize = Number.isFinite(this.brushSize)
            ? this.brushSize
            : this.dotSizeFactor;
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

        this.setUniform(PU.brushSize, clamp(brushSize, 0.02, 0.48));
        this.setUniform(PU.brushDensity, clamp(brushDensity, 0.15, 4.4));
        this.setUniform(PU.brushAspect, clamp(brushAspect, 0.85, 2.2));
        this.setUniform(PU.brushHardness, clamp(brushHardness, 0, 1));
        this.setUniform(PU.colorVibration, clamp(colorVibration, 0, 1));
        this.setUniform(PU.darkPaintBoost, clamp(darkPaintBoost, 0, 1));
        this.setUniform(PU.highlightSkip, clamp(highlightSkip, 0, 1));
        this.setUniform(PU.dotScale, clamp(this.dotScale, 0.05, 1));
        this.setUniform(PU.dotSizeFactor, clamp(this.dotSizeFactor, 0.01, 0.48));
        this.setUniform(PU.strokeAspect, clamp(this.strokeAspect, 0.85, 2.2));
        this.setUniform(PU.roundness, clamp(this.roundness, 0, 1));
        this.setUniform(PU.density, clamp(this.density, 0.15, 4.4));
        this.setUniform(PU.strokeSoftness, clamp(this.strokeSoftness, 0.08, 0.55));
        this.setUniform(PU.strokeLength, clamp(this.strokeLength, 0.58, 1.2));
        this.setUniform(PU.strokeWidth, clamp(this.strokeWidth, 0.42, 1.0));
        this.setUniform(PU.shapeJitter, clamp(this.shapeJitter, 0, 0.22));
        this.setUniform(PU.paintThickness, clamp(this.paintThickness, 0.5, 1.5));
        this.setUniform(PU.saturation, clamp(this.saturation, 0, 3));
        this.setUniform(PU.lumaLevels, clamp(Math.floor(this.lumaLevels), 2, 24));
        this.setUniform(PU.contrastDotMix, clamp(this.contrastDotMix, 0, 1));
        this.setUniform(PU.complementaryMix, clamp(this.complementaryMix, 0, 1));
        this.setUniform(PU.warmCoolSplit, clamp(this.warmCoolSplit, 0, 1));
        this.setUniform(PU.paletteStrength, clamp(this.paletteStrength, 0, 1));
        this.setUniform(PU.paletteIndex, clamp(Math.floor(this.paletteIndex), 0, 3));
        this.setUniform(PU.sourceStructureBlend, clamp(this.sourceStructureBlend, 0, 1));
        this.setUniform(PU.highlightSparsity, clamp(this.highlightSparsity, 0, 1));
        this.setUniform(PU.darkDensityBoost, clamp(this.darkDensityBoost, 0, 1));
        this.setUniform(PU.seed, Number.isFinite(this.seed) ? this.seed : POINTILLISM_DEFAULTS.seed);
        this.setUniform(PU.minVisibleAlpha, clamp(this.minVisibleAlpha, 0, 0.05));
    }

    destroy() {
        super.destroy();
        this._postController?.destroy();
        this._postController = null;
        this._camera = null;
    }
}

export { GsplatPersistentPointillismStipple };
