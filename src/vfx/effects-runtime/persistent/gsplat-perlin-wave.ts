import { Vec3, type Material } from 'playcanvas';
import { GsplatShaderEffect } from '../gsplat-shader-effect';
import { extractGlslWgslModifyBlocks, PERLIN_WAVE_COMPOSER_ID } from '../gsplat-effect-layers-extractor';
import { nightModeUsesComposerPath } from '../../lighting/night-mode';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform vec3 uCenter;
uniform float uIntensity;
uniform float uWaveAmplitude;
uniform float uWaveFrequency;
uniform float uWaveSpeed;
uniform float uScaleBlend;
uniform float uEndRadius;

// Helper functions
mat2 rot(float a) {
    float s = sin(a);
    float c = cos(a);
    return mat2(c, -s, s, c);
}

         // Pseudo-random hash function
          vec3 hash2(vec3 p) {
            p = fract(p * 0.3183099 + 0.1);
            p *= 17.0;
            return fract(vec3(p.x * p.y * p.z, p.x + p.y * p.z, p.x * p.y + p.z));
          }

          // 3D Perlin-style noise function
          vec3 noise2(vec3 p) {
            vec3 i = floor(p);
            vec3 f = fract(p);
            f = f * f * (3.0 - 2.0 * f);
            
    vec3 n000 = hash2(i + vec3(0, 0, 0));
    vec3 n100 = hash2(i + vec3(1, 0, 0));
    vec3 n010 = hash2(i + vec3(0, 1, 0));
    vec3 n110 = hash2(i + vec3(1, 1, 0));
    vec3 n001 = hash2(i + vec3(0, 0, 1));
    vec3 n101 = hash2(i + vec3(1, 0, 1));
    vec3 n011 = hash2(i + vec3(0, 1, 1));
    vec3 n111 = hash2(i + vec3(1, 1, 1));
            
            vec3 x0 = mix(n000, n100, f.x);
            vec3 x1 = mix(n010, n110, f.x);
            vec3 x2 = mix(n001, n101, f.x);
            vec3 x3 = mix(n011, n111, f.x);
            
            vec3 y0 = mix(x0, x1, f.y);
            vec3 y1 = mix(x2, x3, f.y);
            
            return mix(y0, y1, f.z);
          }

// 3D sine wave effect for color (spatialScale、timeScale 与位移一致，波长/波速都能同时影响位移和颜色)
vec4 sin3D(vec3 p, float t, float spatialScale, float timeScale) {
    float m = exp(-2.0 * length(sin(p * 2.0 * spatialScale + t * timeScale))) * 5.0;
    return vec4(m) + 0.3;
}

// Shared globals
float g_dist;

void initShared(vec3 center) {
    g_dist = length(center - uCenter);
}

void modifySplatCenter(inout vec3 center) {
    initShared(center);
    
    // Apply Perlin noise offset for wave motion
    vec3 noiseOffset = uWaveAmplitude * noise2(center * uWaveFrequency + uTime * uWaveSpeed);
    center += noiseOffset;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    initShared(modifiedCenter);
    // No scale modification for perlin wave
}

void modifySplatColor(vec3 center, inout vec4 color) {
    initShared(center);
    
    // Apply 3D sine wave color effect（波长、波速与位移一致）
    vec4 e = sin3D(center, uTime, uWaveFrequency, uWaveSpeed * 3.0);
    color = mix(color, color * e, uIntensity);
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uIntensity: f32;
uniform uWaveAmplitude: f32;
uniform uWaveFrequency: f32;
uniform uWaveSpeed: f32;
uniform uScaleBlend: f32;

// Helper functions
fn rot(a: f32) -> mat2x2f {
    let s = sin(a);
    let c = cos(a);
    return mat2x2f(
        vec2f(c, -s),
        vec2f(s, c)
    );
}

// Pseudo-random hash function
fn hash2(p: vec3f) -> vec3f {
    var p2 = fract(p * 0.3183099 + 0.1);
    p2 *= 17.0;
    return fract(vec3f(
        p2.x * p2.y * p2.z,
        p2.x + p2.y * p2.z,
        p2.x * p2.y + p2.z
    ));
}

// 3D Perlin-style noise function
fn noise2(p: vec3f) -> vec3f {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    
    let n000 = hash2(i + vec3f(0.0, 0.0, 0.0));
    let n100 = hash2(i + vec3f(1.0, 0.0, 0.0));
    let n010 = hash2(i + vec3f(0.0, 1.0, 0.0));
    let n110 = hash2(i + vec3f(1.0, 1.0, 0.0));
    let n001 = hash2(i + vec3f(0.0, 0.0, 1.0));
    let n101 = hash2(i + vec3f(1.0, 0.0, 1.0));
    let n011 = hash2(i + vec3f(0.0, 1.0, 1.0));
    let n111 = hash2(i + vec3f(1.0, 1.0, 1.0));
    
    let x0 = mix(n000, n100, f.x);
    let x1 = mix(n010, n110, f.x);
    let x2 = mix(n001, n101, f.x);
    let x3 = mix(n011, n111, f.x);
    
    let y0 = mix(x0, x1, f.y);
    let y1 = mix(x2, x3, f.y);
    
    return mix(y0, y1, f.z);
}

// 3D sine wave effect for color (spatialScale、timeScale 与位移一致，波长/波速都能同时影响位移和颜色)
fn sin3D(p: vec3f, t: f32, spatialScale: f32, timeScale: f32) -> vec4f {
    let m = exp(-2.0 * length(sin(p * 2.0 * spatialScale + t * timeScale))) * 5.0;
    return vec4f(m, m, m, 1.0) + vec4f(0.3, 0.3, 0.3, 0.0);
}

// Shared globals
var<private> g_dist: f32;

fn initShared(center: vec3f) {
    g_dist = length(center - uniform.uCenter);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    initShared(*center);
    
    let noiseOffset = uniform.uWaveAmplitude * noise2(*center * uniform.uWaveFrequency + uniform.uTime * uniform.uWaveSpeed);
    *center = *center + noiseOffset;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    initShared(modifiedCenter);
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    initShared(center);
    
    // Apply 3D sine wave color effect（波长、波速与位移一致）
    let e = sin3D(center, uniform.uTime, uniform.uWaveFrequency, uniform.uWaveSpeed * 3.0);
    *color = mix(*color, *color * e, uniform.uIntensity);
}
`;

/**
 * Perlin Wave reveal effect for gaussian splats.
 * Creates a wave-like motion effect using Perlin noise, with color modulation via 3D sine waves.
 *
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const perlinWaveScript = entity.script.create(GsplatRevealPerlinWave);
 * perlinWaveScript.center.set(0, 0, 0);
 * perlinWaveScript.intensity = 0.5;
 * perlinWaveScript.waveAmplitude = 0.1;
 * perlinWaveScript.wavelength = 2.0;  // 波长（世界单位），优先于 waveFrequency；0 则用 waveFrequency
 * perlinWaveScript.waveSpeed = 1.0;
 * perlinWaveScript.scaleBlend = 1.0;
 */
class GsplatRevealPerlinWave extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealPerlinWave';

    /** 仅当 shader 源码变更时需递增以触发 composer 重编译 */
    private _perlinComposerRev = 0;

    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];

    /**
     * Origin point for the effect (used for distance culling)
     * @attribute
     */
    center = new Vec3(0, 0, 0);

    /**
     * Intensity of the color effect (0-1)
     * @attribute
     * @range [0, 1]
     */
    intensity = 0.5;

    /**
     * Amplitude of the Perlin wave motion
     * @attribute
     * @range [0, 2]
     */
    waveAmplitude = 0.1;

    /**
     * Frequency of the Perlin wave (used only when wavelength <= 0)
     * @attribute
     * @range [0, 10]
     */
    waveFrequency = 1.0;

    /**
     * 波长（世界单位）。当 > 0 时优先使用：uWaveFrequency = 1.0 / wavelength，调大波长 = 波更疏、周期更长
     * @attribute
     * @range [0, 100]
     */
    wavelength = 0;

    /**
     * Speed of the wave animation
     * @attribute
     * @range [0, 5]
     */
    waveSpeed = 1.0;

    /**
     * Scale blend factor (0-1). Values < 0.1 will hide splats
     * @attribute
     * @range [0, 1]
     */
    scaleBlend = 0;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    private usesPerlinComposerPath(): boolean {
        return nightModeUsesComposerPath() && !!(this.app as any).effectsRuntime?.composer;
    }

    applyShaderToMaterial(material: Material) {
        if (this.usesPerlinComposerPath()) {
            return;
        }
        super.applyShaderToMaterial(material);
    }

    applyShaders() {
        if (!this.usesPerlinComposerPath()) {
            super.applyShaders();
            return;
        }
        if (this.entity.gsplat?.unified) {
            this.applyToUnifiedMaterials();
        } else {
            this.applyToComponentMaterial();
        }
        this.syncPerlinComposerContribution();
    }

    removeShaders() {
        if (!this.usesPerlinComposerPath()) {
            super.removeShaders();
            return;
        }
        if (this.materialsApplied.size === 0) return;
        const rt = (this.app as any).effectsRuntime;
        const mats = new Set(this.materialsApplied);
        rt?.composer.removeContribution(PERLIN_WAVE_COMPOSER_ID);
        rt?.composer.compose();
        const last = rt?.composer.getLastComposition();
        if (last && mats.size > 0) {
            rt.composer.applyComposedToMaterials(mats, last);
        }
        this.materialsApplied.clear();
    }

    private syncPerlinComposerContribution() {
        const rt = (this.app as any).effectsRuntime;
        if (!rt?.composer || this.materialsApplied.size === 0) {
            return;
        }
        const shaderBlocks = extractGlslWgslModifyBlocks(shaderGLSL, shaderWGSL);
        rt.composer.setContribution({
            id: PERLIN_WAVE_COMPOSER_ID,
            priority: 20,
            scope: 'scene',
            enabled: true,
            version: this._perlinComposerRev,
            shaderBlocks,
            capabilities: { allowConcurrentWithPersistent: true }
        });
        rt.composer.compose();
        const last = rt.composer.getLastComposition();
        if (last) {
            rt.composer.applyComposedToMaterials(this.materialsApplied, last);
        }
    }

    updateEffect(effectTime: number, dt: number) {
        // Update uniforms
        this.setUniform('uTime', effectTime);

        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        this.setUniform('uIntensity', this.intensity);
        this.setUniform('uWaveAmplitude', this.waveAmplitude);
        const w = Number(this.wavelength) || 0;
        const effectiveFrequency = w > 0 ? 1.0 / w : this.waveFrequency;
        this.setUniform('uWaveFrequency', effectiveFrequency);
        this.setUniform('uWaveSpeed', this.waveSpeed);
        this.setUniform('uScaleBlend', this.scaleBlend);
    }
}

export { GsplatRevealPerlinWave };
