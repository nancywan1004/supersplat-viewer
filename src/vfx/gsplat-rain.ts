// Adapted from spark: https://github.com/sparkjsdev/spark 

import { Script, Vec3, Color } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform float uIntensity;
uniform vec3 uCenter;
uniform vec3 uHitTint;
uniform float uHitDuration;
uniform float uBottomY;
uniform float uRainHeight;

vec3 hash2(vec3 p) {
    p = fract(p * 0.3183099 + 0.1);
    p *= 17.0;
    return fract(vec3(p.x * p.y * p.z, p.x + p.y * p.z, p.x * p.y + p.z));
}

// Shared globals for consistent calculations
float g_rainProgress;
float g_originalY;
float g_rainY;
float g_hasReached;
float g_redFadeFactor;

void initShared(vec3 originalCenter) {
    vec3 h = hash2(originalCenter);
    float dist2D = length(originalCenter.xz - uCenter.xz);
    float rawProgress = uTime*uTime*0.1 - dist2D*2.0 + 1.0;
    g_rainProgress = pow(smoothstep(0., 5., rawProgress), 0.5 + h.x);
    g_originalY = originalCenter.y;
    g_rainY = min(uBottomY + g_rainProgress*uRainHeight, g_originalY);
    
    // Check if splat has reached its original position
    // Only mark as reached if:
    // 1. Animation wave has reached this splat (rawProgress > 0, meaning smoothstep will give non-zero result)
    // 2. Progress is significant enough that the splat has moved from below
    // 3. The splat is at or very close to its original position
    float progressWhenReached = max(0.001, (g_originalY - uBottomY) / uRainHeight);
    float hasStartedAnimating = step(0.0, rawProgress); // 1.0 if wave has started
    float hasMovedEnough = step(progressWhenReached * 0.8, g_rainProgress); // Must have moved at least 80% to reach point
    float isAtOriginalY = step(g_originalY - 0.01, g_rainY); // 1.0 if at original position
    g_hasReached = hasStartedAnimating * hasMovedEnough * isAtOriginalY;
    
    // Calculate fade factor for red tint effect
    // Red tint appears when splat reaches original position and fades out as progress continues
    if (g_hasReached > 0.5) {
        // Calculate progress range for red effect
        float progressAfterReach = max(0.0, g_rainProgress - progressWhenReached);
        float maxProgressForFade = 0.3; // Progress range for fade-out (can be adjusted via uniform if needed)
        
        // Calculate fade: starts at 1.0 when just reached, fades to 0.0 after maxProgressForFade
        // Use smoothstep for smooth transition
        g_redFadeFactor = 1.0 - smoothstep(0.0, maxProgressForFade, progressAfterReach);
        
        // Ensure that when progress reaches 1.0 or beyond, red completely disappears
        // This prevents red from persisting for splats that have fully completed animation
        if (g_rainProgress >= 1.0 - 0.001) {
            g_redFadeFactor = 0.0;
        }
    } else {
        g_redFadeFactor = 0.0; // No red if not reached
    }
}

void modifyCenter(inout vec3 center) {
    vec3 originalCenter = center;
    initShared(originalCenter);
    
    float newY = min(uBottomY + g_rainProgress*uRainHeight, g_originalY);
    center.y = newY;
    center.x = originalCenter.x + (newY - g_originalY)*0.2;
    vec2 xz = mix(originalCenter.xz*0.3, originalCenter.xz, g_rainProgress);
    center.xz = xz;
}

void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
    initShared(originalCenter);
    
    // 如果已经完全到达并恢复，保持原始形状
    if (g_hasReached > 0.5 && g_rainProgress >= 1.0) {
        // 已经完全恢复，保持原始大小和形状
        return;
    }
    
    // 在下落过程中，缩小为小点云（模拟雨点）
    // 计算缩放因子：在下落过程中保持小尺寸，到达时恢复
    float progressWhenReached = max(0.001, (g_originalY - uBottomY) / uRainHeight);
    
    // 小点云的相对大小（可以调整）
    float smallDotSize = 0.05;
    float scaleFactor;
    
    if (g_hasReached > 0.5) {
        // 已经到达原始位置：平滑过渡到原始大小和形状
        // 使用 redFadeFactor 的逆作为过渡因子（到达时开始恢复）
        float restoreProgress = 1.0 - g_redFadeFactor;
        scaleFactor = mix(smallDotSize, 1.0, restoreProgress);
        
        // 如果已经完全恢复，直接返回原始形状
        if (restoreProgress >= 1.0) {
            return;
        }
    } else if (g_rainProgress < progressWhenReached * 0.9) {
        // 下落阶段：保持小点云
        scaleFactor = smallDotSize;
    } else {
        // 接近到达时：平滑过渡到原始大小
        float transitionStart = progressWhenReached * 0.9;
        float transitionEnd = progressWhenReached;
        float t = smoothstep(transitionStart, transitionEnd, g_rainProgress);
        scaleFactor = mix(smallDotSize, 1.0, t);
    }
    
    // 提取原始大小并应用缩放
    float originalSize = gsplatExtractSize(covA, covB);
    float newSize = originalSize * scaleFactor;
    
    // 在下落阶段和过渡阶段，创建圆形小点云
    // 到达后逐渐恢复原始形状
    if (g_hasReached > 0.5) {
        // 到达后：混合圆形和原始形状
        float restoreProgress = 1.0 - g_redFadeFactor;
        vec3 originalCovA = covA;
        vec3 originalCovB = covB;
        gsplatMakeRound(covA, covB, newSize);
        vec3 roundCovA = covA;
        vec3 roundCovB = covB;
        // 从圆形逐渐过渡到原始形状
        covA = mix(roundCovA, originalCovA, restoreProgress);
        covB = mix(roundCovB, originalCovB, restoreProgress);
    } else {
        // 下落阶段：创建圆形小点云
        gsplatMakeRound(covA, covB, newSize);
    }
}

void modifyColor(vec3 center, inout vec4 color) {
    // Use shared variables calculated in modifyCenter for consistency
    // These were computed from originalCenter in modifyCenter
    float alpha = smoothstep(uBottomY, g_originalY, g_rainY);
    
    // Apply intensity to alpha
    color.a *= mix(1.0, alpha, uIntensity);
    
    // Apply red tint when reaching original position (hit effect)
    // Use the fade factor calculated in initShared
    if (g_redFadeFactor > 0.001) {
        // Apply red tint with fade factor
        // This ensures red completely disappears after fade-out period
        color.rgb += uHitTint * g_redFadeFactor;
    }
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uIntensity: f32;
uniform uCenter: vec3f;
uniform uHitTint: vec3f;
uniform uHitDuration: f32;
uniform uBottomY: f32;
uniform uRainHeight: f32;

fn hash2(p: vec3f) -> vec3f {
    var p_fract = fract(p * 0.3183099 + 0.1);
    p_fract *= 17.0;
    return fract(vec3f(
        p_fract.x * p_fract.y * p_fract.z,
        p_fract.x + p_fract.y * p_fract.z,
        p_fract.x * p_fract.y + p_fract.z
    ));
}

// Shared globals for consistent calculations
var<private> g_rainProgress: f32;
var<private> g_originalY: f32;
var<private> g_rainY: f32;
var<private> g_hasReached: f32;
var<private> g_redFadeFactor: f32;

fn initShared(originalCenter: vec3f) {
    let h = hash2(originalCenter);
    let dist2D = length(originalCenter.xz - uniform.uCenter.xz);
    let rawProgress = uniform.uTime*uniform.uTime*0.1 - dist2D*2.0 + 1.0;
    g_rainProgress = pow(smoothstep(0.0, 5.0, rawProgress), 0.5 + h.x);
    g_originalY = originalCenter.y;
    g_rainY = min(uniform.uBottomY + g_rainProgress*uniform.uRainHeight, g_originalY);
    
    // Check if splat has reached its original position
    // Only mark as reached if:
    // 1. Animation wave has reached this splat (rawProgress > 0, meaning smoothstep will give non-zero result)
    // 2. Progress is significant enough that the splat has moved from below
    // 3. The splat is at or very close to its original position
    let progressWhenReached = max(0.001, (g_originalY - uniform.uBottomY) / uniform.uRainHeight);
    let hasStartedAnimating = select(0.0, 1.0, rawProgress > 0.0); // 1.0 if wave has started
    let hasMovedEnough = select(0.0, 1.0, g_rainProgress >= progressWhenReached * 0.8); // Must have moved at least 80% to reach point
    let isAtOriginalY = select(0.0, 1.0, g_rainY >= g_originalY - 0.01); // 1.0 if at original position
    g_hasReached = hasStartedAnimating * hasMovedEnough * isAtOriginalY;
    
    // Calculate fade factor for red tint effect
    // Red tint appears when splat reaches original position and fades out as progress continues
    if (g_hasReached > 0.5) {
        // Calculate progress range for red effect
        let progressAfterReach = max(0.0, g_rainProgress - progressWhenReached);
        let maxProgressForFade = 0.3; // Progress range for fade-out (can be adjusted via uniform if needed)
        
        // Calculate fade: starts at 1.0 when just reached, fades to 0.0 after maxProgressForFade
        // Use smoothstep for smooth transition
        g_redFadeFactor = 1.0 - smoothstep(0.0, maxProgressForFade, progressAfterReach);
        
        // Ensure that when progress reaches 1.0 or beyond, red completely disappears
        // This prevents red from persisting for splats that have fully completed animation
        if (g_rainProgress >= 1.0 - 0.001) {
            g_redFadeFactor = 0.0;
        }
    } else {
        g_redFadeFactor = 0.0; // No red if not reached
    }
}

fn modifyCenter(center: ptr<function, vec3f>) {
    let originalCenter = *center;
    initShared(originalCenter);
    
    let newY = min(uniform.uBottomY + g_rainProgress*uniform.uRainHeight, g_originalY);
    (*center).y = newY;
    (*center).x = originalCenter.x + (newY - g_originalY)*0.2;
    var xz = mix(originalCenter.xz*0.3, originalCenter.xz, g_rainProgress);
    (*center).x = xz.x;
    (*center).z = xz.y;
}

fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
    initShared(originalCenter);
    
    // 如果已经完全到达并恢复，保持原始形状
    if (g_hasReached > 0.5 && g_rainProgress >= 1.0) {
        // 已经完全恢复，保持原始大小和形状
        return;
    }
    
    // 在下落过程中，缩小为小点云（模拟雨点）
    // 计算缩放因子：在下落过程中保持小尺寸，到达时恢复
    let progressWhenReached = max(0.001, (g_originalY - uniform.uBottomY) / uniform.uRainHeight);
    
    // 小点云的相对大小（可以调整）
    let smallDotSize: f32 = 0.05;
    var scaleFactor: f32;
    
    if (g_hasReached > 0.5) {
        // 已经到达原始位置：平滑过渡到原始大小和形状
        // 使用 redFadeFactor 的逆作为过渡因子（到达时开始恢复）
        let restoreProgress = 1.0 - g_redFadeFactor;
        scaleFactor = mix(smallDotSize, 1.0, restoreProgress);
        
        // 如果已经完全恢复，直接返回原始形状
        if (restoreProgress >= 1.0) {
            return;
        }
    } else if (g_rainProgress < progressWhenReached * 0.9) {
        // 下落阶段：保持小点云
        scaleFactor = smallDotSize;
    } else {
        // 接近到达时：平滑过渡到原始大小
        let transitionStart = progressWhenReached * 0.9;
        let transitionEnd = progressWhenReached;
        let t = smoothstep(transitionStart, transitionEnd, g_rainProgress);
        scaleFactor = mix(smallDotSize, 1.0, t);
    }
    
    // 提取原始大小并应用缩放
    let originalSize = gsplatExtractSize(*covA, *covB);
    let newSize = originalSize * scaleFactor;
    
    // 在下落阶段和过渡阶段，创建圆形小点云
    // 到达后逐渐恢复原始形状
    if (g_hasReached > 0.5) {
        // 到达后：混合圆形和原始形状
        let restoreProgress = 1.0 - g_redFadeFactor;
        let originalCovA = *covA;
        let originalCovB = *covB;
        gsplatMakeRound(covA, covB, newSize);
        let roundCovA = *covA;
        let roundCovB = *covB;
        // 从圆形逐渐过渡到原始形状
        *covA = mix(roundCovA, originalCovA, restoreProgress);
        *covB = mix(roundCovB, originalCovB, restoreProgress);
    } else {
        // 下落阶段：创建圆形小点云
        gsplatMakeRound(covA, covB, newSize);
    }
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    // Use shared variables calculated in modifyCenter for consistency
    // These were computed from originalCenter in modifyCenter
    let alpha = smoothstep(uniform.uBottomY, g_originalY, g_rainY);
    
    // Apply intensity to alpha
    (*color).a *= mix(1.0, alpha, uniform.uIntensity);
    
    // Apply red tint when reaching original position (hit effect)
    // Use the fade factor calculated in initShared
    if (g_redFadeFactor > 0.001) {
        // Apply red tint with fade factor
        // This ensures red completely disappears after fade-out period
        (*color).rgb = (*color).rgb + uniform.uHitTint * g_redFadeFactor;
    }
}
`;

/**
 * Rain V2 effect for gaussian splats.
 * Creates a rain-like animation where splats appear from below and move upward,
 * with rotation and scaling effects based on time and distance from center.
 * This is a simplified version compared to GsplatRevealRain.
 * 
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const rainScript = entity.script.create(GsplatRainV2);
 * rainScript.intensity = 1.0;
 */
class GsplatRainV2 extends GsplatShaderEffect {
    static scriptName = 'gsplatRainV2';

    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];
    _hitTintArray = [0, 0, 0];

    /**
     * Effect intensity (0.0 to 1.0)
     * @attribute
     * @range [0, 1]
     */
    intensity: number = 1.0;

    /**
     * Center point for the rain effect
     * @attribute
     */
    center: Vec3 = new Vec3(0, 0, 0);

    /**
     * Additive color when splat reaches its original position (hit flash)
     * @attribute
     */
    hitTint: Color = new Color(2, 0, 0);

    /**
     * Duration of hit tint flash in seconds (longer duration creates wider boundary expansion effect)
     * @attribute
     * @range [0, 5]
     */
    hitDuration: number = 2.0;

    /**
     * Bottom Y position where splats start appearing (below scene)
     * @attribute
     */
    bottomY: number = -10.0;

    /**
     * Height range for rain effect (distance from bottomY to original position)
     * @attribute
     */
    rainHeight: number = 15.0;

    /**
     * Time scale factor for adjusting effect duration (default 1.0)
     * Used to fit the effect duration to a specific totalDuration
     * @attribute
     */
    timeScale: number = 1.0;

    /**
     * Maximum 2D distance from center to the farthest splat
     * Used to calculate actual completion time based on shader logic
     * @attribute
     */
    maxDist2D: number = 10.0;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // Apply timeScale to adjust effect duration
        const scaledTime = effectTime * this.timeScale;
        
        // Update uniforms
        this.setUniform('uTime', scaledTime);
        this.setUniform('uIntensity', this.intensity);
        
        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);
        
        this._hitTintArray[0] = this.hitTint.r;
        this._hitTintArray[1] = this.hitTint.g;
        this._hitTintArray[2] = this.hitTint.b;
        this.setUniform('uHitTint', this._hitTintArray);
        this.setUniform('uHitDuration', this.hitDuration);
        this.setUniform('uBottomY', this.bottomY);
        this.setUniform('uRainHeight', this.rainHeight);
        
        // Check if effect is complete
        if (this.isEffectComplete()) {
            console.log('Rain V2 effect completed, disabling');
            this.enabled = false;
            return;
        }
    }

    /**
     * Calculate when the effect is complete.
     * Effect completes when all splats have reached their original positions.
     * Based on shader logic: rawProgress = uTime*uTime*0.1 - dist2D*2.0 + 1.0
     * When rawProgress >= 5, smoothstep(0., 5., rawProgress) = 1.0, so effect is complete.
     * Solving: uTime*uTime*0.1 - dist2D*2.0 + 1.0 >= 5
     * => uTime*uTime*0.1 >= 4 + dist2D*2.0
     * => uTime >= sqrt((4 + dist2D*2.0) / 0.1)
     * 
     * Note: uTime in shader is scaledTime = effectTime * timeScale
     * So we need: effectTime * timeScale >= sqrt((4 + maxDist2D*2.0) / 0.1)
     * => effectTime >= sqrt((4 + maxDist2D*2.0) / 0.1) / timeScale
     * 
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete() {
        // 根据 shader 逻辑计算：rawProgress = uTime*uTime*0.1 - dist2D*2.0 + 1.0
        // 当 rawProgress >= 5 时完成
        // uTime 在 shader 中是 scaledTime = effectTime * timeScale
        const rawProgressThreshold = 5.0;
        const constant = 1.0;
        const timeCoeff = 0.1;
        const distCoeff = 2.0;
        
        // 计算最远点完成所需的时间（在 shader 中的 scaledTime）
        // rawProgress = scaledTime^2 * timeCoeff - maxDist2D * distCoeff + constant >= rawProgressThreshold
        // scaledTime^2 * timeCoeff >= rawProgressThreshold - constant + maxDist2D * distCoeff
        // scaledTime >= sqrt((rawProgressThreshold - constant + maxDist2D * distCoeff) / timeCoeff)
        const requiredScaledTime = Math.sqrt(
            (rawProgressThreshold - constant + this.maxDist2D * distCoeff) / timeCoeff
        );
        
        // 转换为实际的 effectTime（考虑 timeScale）
        const requiredEffectTime = requiredScaledTime / Math.max(this.timeScale, 0.001);
        
        return this.effectTime >= requiredEffectTime;
    }
}

export { GsplatRainV2 };