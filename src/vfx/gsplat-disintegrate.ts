import { Vec3 } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform float uIntensity;

// Helper functions
mat2 rot(float a) {
    float s = sin(a);
    float c = cos(a);
    return mat2(c, -s, s, c);
}

// Hash function for randomization
vec3 hash(vec3 p) {
    return fract(sin(p * 123.456) * 123.456);
}

void modifyCenter(inout vec3 center) {
    // Apply disintegrate effect: random offset + rotation based on time
    vec3 p = center + (hash(center) * 2.0 - 1.0) * uIntensity;
    float tt = smoothstep(-1.0, 0.5, -sin(uTime + -center.y * 0.5));
    p.xz *= rot(tt * 0.5 + center.y * 0.5 * tt);
    center = mix(p, center, tt);
}

void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
    // Calculate disintegrate factor (same calculation as in modifyCenter)
    float tt = smoothstep(-1.0, 0.5, -sin(uTime + -originalCenter.y * 0.5));
    
    // Mix scales based on disintegrate factor: smaller when disintegrating
    float originalSize = gsplatExtractSize(covA, covB);
    float minSize = 0.01;
    float newSize = mix(minSize, originalSize, tt);
    gsplatMakeRound(covA, covB, newSize);
}

void modifyColor(vec3 center, inout vec4 color) {
    // Disintegrate effect doesn't modify color
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uIntensity: f32;

// Helper functions
fn rot(a: f32) -> mat2x2f {
    let s = sin(a);
    let c = cos(a);
    return mat2x2f(
        vec2f(c, -s),
        vec2f(s, c)
    );
}

// Hash function for randomization
fn hash(p: vec3f) -> vec3f {
    return fract(sin(p * 123.456) * 123.456);
}

fn modifyCenter(center: ptr<function, vec3f>) {
    // Apply disintegrate effect: random offset + rotation based on time
    var p = *center + (hash(*center) * 2.0 - 1.0) * uniform.uIntensity;
    let tt = smoothstep(-1.0, 0.5, -sin(uniform.uTime + -(*center).y * 0.5));
    let rotMat = rot(tt * 0.5 + (*center).y * 0.5 * tt);
    let xz = vec2f((*p).x, (*p).z);
    let rotatedXz = rotMat * xz;
    p.x = rotatedXz.x;
    p.z = rotatedXz.y;
    *center = mix(p, *center, tt);
}

fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
    // Calculate disintegrate factor (same calculation as in modifyCenter)
    let tt = smoothstep(-1.0, 0.5, -sin(uniform.uTime + -originalCenter.y * 0.5));
    
    // Mix scales based on disintegrate factor: smaller when disintegrating
    let originalSize = gsplatExtractSize(*covA, *covB);
    let minSize = 0.01;
    let newSize = mix(minSize, originalSize, tt);
    gsplatMakeRound(covA, covB, newSize);
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    // Disintegrate effect doesn't modify color
}
`;

/**
 * Disintegrate effect for gaussian splats.
 * Creates a disintegration effect with random offset and rotation based on time.
 * 
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const disintegrateScript = entity.script.create(GsplatDisintegrate);
 * disintegrateScript.intensity = 0.5;
 * disintegrateScript.duration = 13.0;
 */
class GsplatDisintegrate extends GsplatShaderEffect {
    static scriptName = 'gsplatDisintegrate';

    /**
     * Intensity of the disintegrate effect (0-1)
     * @attribute
     * @range [0, 1]
     */
    intensity = 0.5;

    /**
     * Duration of one complete disintegrate cycle in seconds
     * After this duration, the effect will automatically disable
     * @attribute
     * @range [0.1, 60]
     */
    duration = 13.0;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // Scale time so that a full cycle (2π) completes in duration seconds
        // The shader uses sin(uTime + ...) which needs approximately 2π for one complete cycle
        const timeScale = (Math.PI * 2.0) / this.duration;
        const scaledTime = effectTime * timeScale;
        
        // Update uniforms
        this.setUniform('uTime', scaledTime);
        this.setUniform('uIntensity', this.intensity);

        // Check if effect is complete
        // if (this.isEffectComplete()) {
        //     this.enabled = false;
        //     return;
        // }
    }

    /**
     * Check if the disintegrate effect has completed one full cycle
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete() {
        return this.effectTime >= this.duration;
    }
}

export { GsplatDisintegrate };
