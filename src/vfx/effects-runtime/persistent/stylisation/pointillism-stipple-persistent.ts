import {
    Material,
    SHADERLANGUAGE_GLSL,
    SHADERLANGUAGE_WGSL,
    ShaderChunks,
    type GraphicsDevice
} from 'playcanvas';

import {
    POINTILLISM_COMPOSER_ID,
    POINTILLISM_DEFAULTS,
    POINTILLISM_UNIFORM_NAMES as PU,
    pointillismModifyGlsl,
    pointillismModifyWgsl
} from './pointillism-stipple-shaders';
import { isOneShotRevealPlayingExclusiveGsplat } from '../../effects-pipeline-policy';
import { extractGlslWgslModifyBlocks } from '../../gsplat-effect-layers-extractor';
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
uniform float uPointillismPaintThickness;
uniform float uPointillismDensity;
uniform float uPointillismMinVisibleAlpha;

float pointillismDaubMask(vec2 uv) {
    float r = length(uv);
    float a = atan(uv.y, uv.x);
    float wobble = sin(a * 5.0 + 0.7) * 0.035 + sin(a * 9.0 - 1.3) * 0.022;
    float edge = 0.82 + wobble;
    float softness = clamp(uPointillismStrokeSoftness, 0.025, 0.45);
    return smoothstep(edge, max(0.02, edge - softness), r);
}

float pointillismPaintAlpha(float baseAlpha, vec2 uv) {
    float mask = pointillismDaubMask(uv);
    float thickness = max(0.0, uPointillismPaintThickness);
    float density = clamp(uPointillismDensity, 0.0, 2.0);
    return baseAlpha * mask * thickness * mix(0.72, 1.22, density * 0.5);
}
`;

const WGSL_INSERT = /* wgsl */`

uniform uPointillismStrokeSoftness: f32;
uniform uPointillismPaintThickness: f32;
uniform uPointillismDensity: f32;
uniform uPointillismMinVisibleAlpha: f32;

fn pointillismDaubMask(uv: half2) -> half {
    let uvf = vec2f(uv);
    let r = length(uvf);
    let a = atan2(uvf.y, uvf.x);
    let wobble = sin(a * 5.0 + 0.7) * 0.035 + sin(a * 9.0 - 1.3) * 0.022;
    let edge = 0.82 + wobble;
    let softness = clamp(uniform.uPointillismStrokeSoftness, 0.025, 0.45);
    return half(smoothstep(edge, max(0.02, edge - softness), r));
}

fn pointillismPaintAlpha(baseAlpha: half, uv: half2) -> half {
    let mask = pointillismDaubMask(uv);
    let thickness = max(0.0, uniform.uPointillismPaintThickness);
    let density = clamp(uniform.uPointillismDensity, 0.0, 2.0);
    return baseAlpha * mask * half(thickness * mix(0.72, 1.22, density * 0.5));
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
        `        if (alpha < 1.0 / 255.0) {
            discard;
        }

        #ifndef DITHER_NONE
            opacityDither(alpha, id * 0.013);
        #endif

        gl_FragColor = vec4(gaussianColor.xyz * alpha, alpha);`,
        `        float paintAlpha = pointillismPaintAlpha(alpha, gaussianUV);
        if (paintAlpha < max(uPointillismMinVisibleAlpha, 1.0 / 255.0)) {
            discard;
        }

        #ifndef DITHER_NONE
            opacityDither(paintAlpha, id * 0.013);
        #endif

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
        `        if (alpha < half(1.0 / 255.0)) {
            discard;
            return output;
        }

        #ifndef DITHER_NONE
            opacityDither(f32(alpha), id * 0.013);
        #endif

        output.color = vec4f(vec3f(gaussianColor.xyz * alpha), f32(alpha));`,
        `        let paintAlpha: half = pointillismPaintAlpha(alpha, gaussianUV);
        if (paintAlpha < half(max(uniform.uPointillismMinVisibleAlpha, 1.0 / 255.0))) {
            discard;
            return output;
        }

        #ifndef DITHER_NONE
            opacityDither(f32(paintAlpha), id * 0.013);
        #endif

        output.color = vec4f(vec3f(gaussianColor.xyz * paintAlpha), f32(paintAlpha));`,
        'wgsl main output'
    );
}

function resolveGsplatPsChunk(device: GraphicsDevice, material: Material, lang: string): string | null {
    const materialChunk = material.getShaderChunks(lang).get('gsplatPS');
    if (materialChunk) return materialChunk;
    return ShaderChunks.get(device, lang).get('gsplatPS') ?? null;
}

class GsplatPersistentPointillismStipple extends GsplatShaderEffect {
    static scriptName = 'gsplatPersistentPointillismStipple';

    private readonly _savedPsChunks = new Map<Material, SavedPsChunks>();

    private readonly _composerRev = 1;

    private _composerSuppressed = false;

    dotScale = POINTILLISM_DEFAULTS.dotScale;

    strokeAspect = POINTILLISM_DEFAULTS.strokeAspect;

    roundness = POINTILLISM_DEFAULTS.roundness;

    density = POINTILLISM_DEFAULTS.density;

    strokeSoftness = POINTILLISM_DEFAULTS.strokeSoftness;

    paintThickness = POINTILLISM_DEFAULTS.paintThickness;

    saturation = POINTILLISM_DEFAULTS.saturation;

    lumaLevels = POINTILLISM_DEFAULTS.lumaLevels;

    contrastDotMix = POINTILLISM_DEFAULTS.contrastDotMix;

    complementaryMix = POINTILLISM_DEFAULTS.complementaryMix;

    warmCoolSplit = POINTILLISM_DEFAULTS.warmCoolSplit;

    paletteStrength = POINTILLISM_DEFAULTS.paletteStrength;

    paletteIndex = POINTILLISM_DEFAULTS.paletteIndex;

    sourceStructureBlend = POINTILLISM_DEFAULTS.sourceStructureBlend;

    seed = POINTILLISM_DEFAULTS.seed;

    minVisibleAlpha = POINTILLISM_DEFAULTS.minVisibleAlpha;

    getShaderGLSL() {
        return pointillismModifyGlsl;
    }

    getShaderWGSL() {
        return pointillismModifyWgsl;
    }

    private getEffectsRuntime(): any {
        return (this.app as any).effectsRuntime ?? null;
    }

    private usesComposerPath(): boolean {
        return !!this.getEffectsRuntime()?.composer;
    }

    private shouldSuppressComposerForOneShotReveal(): boolean {
        return isOneShotRevealPlayingExclusiveGsplat((this.app as any).__global?.state);
    }

    applyShaderToMaterial(material: Material) {
        this.patchFragmentShader(material);
        if (this.usesComposerPath()) {
            this.syncComposerContribution(new Set([material]));
            return;
        }
        super.applyShaderToMaterial(material);
    }

    applyShaders() {
        if (!this.usesComposerPath()) {
            super.applyShaders();
            this.updateEffect(this.effectTime, 0);
            return;
        }
        if (this.entity.gsplat?.unified) {
            this.applyToUnifiedMaterials();
        } else {
            this.applyToComponentMaterial();
        }
        if (this.shouldSuppressComposerForOneShotReveal()) {
            this.suppressComposerContribution();
            return;
        }
        this._composerSuppressed = false;
        this.syncComposerContribution(this.materialsApplied);
        this.updateEffect(this.effectTime, 0);
    }

    removeShaders() {
        if (!this.usesComposerPath()) {
            super.removeShaders();
        } else if (this.materialsApplied.size > 0) {
            const rt = this.getEffectsRuntime();
            rt?.removeSceneGsplatContribution?.(POINTILLISM_COMPOSER_ID, new Set(this.materialsApplied));
        }

        for (const material of this.materialsApplied) {
            this.restoreFragmentShader(material);
        }
        this.materialsApplied.clear();
        this._composerSuppressed = false;
    }

    private patchFragmentShader(material: Material): void {
        if (this._savedPsChunks.has(material)) return;

        const device = this.app.graphicsDevice as GraphicsDevice;
        const saved: SavedPsChunks = {};
        const glslBase = resolveGsplatPsChunk(device, material, SHADERLANGUAGE_GLSL);
        const wgslBase = resolveGsplatPsChunk(device, material, SHADERLANGUAGE_WGSL);

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

    private syncComposerContribution(materials: Set<Material>): void {
        const rt = this.getEffectsRuntime();
        if (!rt?.applySceneGsplatContribution || materials.size === 0) return;
        if (this.shouldSuppressComposerForOneShotReveal()) {
            this.suppressComposerContribution();
            return;
        }
        const shaderBlocks = extractGlslWgslModifyBlocks(pointillismModifyGlsl, pointillismModifyWgsl);
        rt.applySceneGsplatContribution(
            {
                id: POINTILLISM_COMPOSER_ID,
                priority: 80,
                scope: 'scene',
                enabled: true,
                version: this._composerRev,
                shaderBlocks,
                capabilities: { allowConcurrentWithPersistent: true }
            },
            materials
        );
    }

    private suppressComposerContribution(): void {
        const rt = this.getEffectsRuntime();
        if (!rt?.removeSceneGsplatContribution || this.materialsApplied.size === 0) return;
        if (this._composerSuppressed) return;
        rt.removeSceneGsplatContribution(POINTILLISM_COMPOSER_ID, new Set(this.materialsApplied));
        this._composerSuppressed = true;
    }

    updateEffect(_effectTime: number, _dt: number) {
        this.setUniform(PU.dotScale, clamp(this.dotScale, 0.05, 3));
        this.setUniform(PU.strokeAspect, clamp(this.strokeAspect, 1, 2.2));
        this.setUniform(PU.roundness, clamp(this.roundness, 0, 1));
        this.setUniform(PU.density, clamp(this.density, 0, 2));
        this.setUniform(PU.strokeSoftness, clamp(this.strokeSoftness, 0.025, 0.45));
        this.setUniform(PU.paintThickness, clamp(this.paintThickness, 0, 3));
        this.setUniform(PU.saturation, clamp(this.saturation, 0, 3));
        this.setUniform(PU.lumaLevels, clamp(Math.floor(this.lumaLevels), 2, 24));
        this.setUniform(PU.contrastDotMix, clamp(this.contrastDotMix, 0, 1));
        this.setUniform(PU.complementaryMix, clamp(this.complementaryMix, 0, 1));
        this.setUniform(PU.warmCoolSplit, clamp(this.warmCoolSplit, 0, 1));
        this.setUniform(PU.paletteStrength, clamp(this.paletteStrength, 0, 1));
        this.setUniform(PU.paletteIndex, clamp(Math.floor(this.paletteIndex), 0, 3));
        this.setUniform(PU.sourceStructureBlend, clamp(this.sourceStructureBlend, 0, 1));
        this.setUniform(PU.seed, Number.isFinite(this.seed) ? this.seed : POINTILLISM_DEFAULTS.seed);
        this.setUniform(PU.minVisibleAlpha, clamp(this.minVisibleAlpha, 0, 0.1));

        if (!this.usesComposerPath() || this.materialsApplied.size === 0) return;
        if (this.shouldSuppressComposerForOneShotReveal()) {
            this.suppressComposerContribution();
        } else if (this._composerSuppressed) {
            this._composerSuppressed = false;
            this.syncComposerContribution(this.materialsApplied);
        }
    }
}

export { GsplatPersistentPointillismStipple };
