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
    // 计算溶解因子（与溶解效果同步）
    float tt = smoothstep(-1.0, 0.5, -sin(uTime + -center.y * 0.5));
    
    // 计算沿y轴传导的波形弹动效果（只向外扩，不向内收缩）
    float wavePhase = uTime * 2.0 + center.y * 3.0;
    float wave = abs(sin(wavePhase)); // 使用绝对值确保只向外扩
    float bounce = wave * (1.0 - tt); // 弹动强度随溶解减弱
    
    // 计算xz平面的径向方向（向外扩展）
    vec2 xz = center.xz;
    float radius = length(xz);
    vec2 direction = radius > 0.001 ? normalize(xz) : vec2(1.0, 0.0);
    
    // 向外扩展，带弹动效果
    float expandAmount = uIntensity * bounce * 0.5;
    xz += direction * expandAmount;
    
    center.xz = xz;
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
    // 计算溶解因子（与溶解效果同步）
    let tt = smoothstep(-1.0, 0.5, -sin(uniform.uTime + -(*center).y * 0.5));
    
    // 计算沿y轴传导的波形弹动效果（只向外扩，不向内收缩）
    let wavePhase = uniform.uTime * 2.0 + (*center).y * 3.0;
    let wave = abs(sin(wavePhase)); // 使用绝对值确保只向外扩
    let bounce = wave * (1.0 - tt); // 弹动强度随溶解减弱
    
    // 计算xz平面的径向方向（向外扩展）
    var xz = vec2f((*center).x, (*center).z);
    let radius = length(xz);
    let direction = select(vec2f(1.0, 0.0), normalize(xz), radius > 0.001);
    
    // 向外扩展，带弹动效果
    let expandAmount = uniform.uIntensity * bounce * 0.5;
    xz = xz + direction * expandAmount;
    
    (*center).x = xz.x;
    (*center).z = xz.y;
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
 */
class GsplatDisintegrate extends GsplatShaderEffect {
    static scriptName = 'gsplatDisintegrate';

    /**
     * Intensity of the disintegrate effect (0-1)
     * @attribute
     * @range [0, 1]
     */
    intensity = 0.5;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // Update uniforms
        this.setUniform('uTime', effectTime);
        this.setUniform('uIntensity', this.intensity);
    }
}

export { GsplatDisintegrate };
