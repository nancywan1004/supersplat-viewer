import { Vec3 } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform float uIntensity;
uniform float uSpeed;
uniform float uWaveSpeed;
uniform float uWaveFrequency;
uniform float uTopY;
uniform float uBottomY;
uniform float uVerticalSpread;
uniform vec3 uAabbMin;
uniform vec3 uAabbMax;

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

void modifySplatCenter(inout vec3 center) {
    // AABB crop 效果：检查 splat 是否在 AABB 内
    bool insideAABB = all(greaterThanEqual(center, uAabbMin)) && all(lessThanEqual(center, uAabbMax));
    if (!insideAABB) {
        return; // 不在 AABB 内，不应用效果
    }
    
    // 计算整合因子（与整合效果同步，从底部向上传导，速度由uSpeed控制）
    // 使用传播波：从底部开始，向上传播
    float timeScaled = uTime * uSpeed;
    // 计算相对于底部的高度偏移
    // 统一约定：topY 是「顶部」，其数值更小；bottomY 是「底部」，其数值更大
    // 因此这里使用 bottomY - center.y，使得：
    //   - 底部附近（center.y ≈ bottomY）yOffset ≈ 0（最先整合）
    //   - 顶部附近（center.y < bottomY）yOffset 为正，数值更大（最后整合）
    float yOffset = center.y - uBottomY;
    // 计算传播相位：时间推进 - y坐标偏移（从底部开始）
    // 底部（yOffset=0，即center.y接近uBottomY）的wavePhase先达到阈值，所以底部先整合
    float wavePhase = timeScaled - yOffset * uVerticalSpread;
    // 使用smoothstep确保：开始时所有点tt=0（点云），传播到后tt逐渐变为1（高斯）
    // 增大过渡范围，使每层的整合更明显
    float tt = smoothstep(0.0, 1.0, wavePhase);
    tt = clamp(tt, 0.0, 1.0); // 确保在[0,1]范围内
    
    // 计算沿y轴传导的波形弹动效果（只向外扩，不向内收缩）
    // 波形应该基于层（y高度），同一层的点有相同的波形效果
    // 只使用y坐标和时间来计算波形，不使用x、z坐标
    // 波形只在整合过程中播放（tt在0到1之间），整合完成后（tt=1）就不播放了
    // 降低频率以增加波长（波长 = 2π / 频率）
    float layerWavePhase = timeScaled * uWaveSpeed - center.y * uWaveFrequency * 0.5;
    
    // 使用平滑的正弦波，使波形更自然
    // 将sin从[-1,1]映射到[0,1]，然后应用平滑过渡
    float rawWave = sin(layerWavePhase);
    float wave = rawWave * 0.5 + 0.5; // 映射到[0,1]
    // 应用平滑函数，使波形过渡更柔和
    wave = wave * wave * (3.0 - 2.0 * wave); // 平滑的缓动曲线（smoothstep的等价实现）
    
    // 波形因子：只在整合过程中（tt在0到1之间）有波形，整合完成后（tt=1）波形为0
    // 使用更平滑的钟形曲线，在tt=0.5时达到峰值，过渡更自然
    float waveFactor = smoothstep(0.0, 0.4, tt) * smoothstep(1.0, 0.6, tt);
    // 应用额外的平滑，使波形因子过渡更柔和
    waveFactor = waveFactor * waveFactor * (3.0 - 2.0 * waveFactor); // 平滑的缓动曲线
    
    float bounce = wave * waveFactor; // 弹动强度只在整合过程中，同一层的点有相同的波形
    
    // 计算xz平面的径向方向（向外扩展）
    vec2 xz = center.xz;
    float radius = length(xz);
    vec2 direction = radius > 0.001 ? normalize(xz) : vec2(1.0, 0.0);
    
    // 向外扩展，带弹动效果（减小振幅系数，使波形更柔和）
    float expandAmount = uIntensity * bounce * 0.5;
    xz += direction * expandAmount;
    
    center.xz = xz;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float timeScaled = uTime * uSpeed;
    float yOffset = originalCenter.y - uBottomY;
    float wavePhase = timeScaled - yOffset * uVerticalSpread;
    float tt = smoothstep(0.0, 1.0, wavePhase);
    tt = clamp(tt, 0.0, 1.0);
    
    if (tt <= 0.0) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
    if (tt >= 1.0) {
        return;
    }
    
    float fadeIn = smoothstep(0.0, 0.3, tt);
    float originalSize = gsplatGetSizeFromScale(scale);
    float newSize = originalSize * fadeIn;
    float shapeBlend = smoothstep(0.0, 1.0, tt);
    float finalSize = mix(newSize, originalSize, shapeBlend);
    gsplatMakeSpherical(scale, finalSize);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    // AABB crop 效果：检查 splat 是否在 AABB 内
    // 如果不在 AABB 内，不应用效果，保持原始颜色（正常显示）
    bool insideAABB = all(greaterThanEqual(center, uAabbMin)) && all(lessThanEqual(center, uAabbMax));
    if (!insideAABB) {
        return; // 不在 AABB 内，不参与效果，保持原始颜色
    }
    // Integrate effect doesn't modify color
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uIntensity: f32;
uniform uSpeed: f32;
uniform uWaveSpeed: f32;
uniform uWaveFrequency: f32;
uniform uTopY: f32;
uniform uBottomY: f32;
uniform uVerticalSpread: f32;
uniform uAabbMin: vec3f;
uniform uAabbMax: vec3f;

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

fn modifySplatCenter(center: ptr<function, vec3f>) {
    // AABB crop 效果：检查 splat 是否在 AABB 内
    let insideAABB = all((*center) >= uniform.uAabbMin) && all((*center) <= uniform.uAabbMax);
    if (!insideAABB) {
        return; // 不在 AABB 内，不应用效果
    }
    
    // 计算整合因子（与整合效果同步，从底部向上传导，速度由uSpeed控制）
    // 使用传播波：从底部开始，向上传播
    let timeScaled = uniform.uTime * uniform.uSpeed;
    // 计算相对于底部的高度偏移
    // 统一约定：topY 是「顶部」，其数值更小；bottomY 是「底部」，其数值更大
    // 因此这里使用 bottomY - center.y，使得：
    //   - 底部附近（center.y ≈ bottomY）yOffset ≈ 0（最先整合）
    //   - 顶部附近（center.y < bottomY）yOffset 为正，数值更大（最后整合）
    let yOffset = (*center).y - uniform.uBottomY;
    // 计算传播相位：时间推进 - y坐标偏移（从底部开始）
    // 底部（yOffset=0，即center.y接近uBottomY）的wavePhase先达到阈值，所以底部先整合
    let wavePhase = timeScaled - yOffset * uniform.uVerticalSpread;
    // 使用smoothstep确保：开始时所有点tt=0（点云），传播到后tt逐渐变为1（高斯）
    // 增大过渡范围，使每层的整合更明显
    var tt = smoothstep(0.0, 1.0, wavePhase);
    tt = clamp(tt, 0.0, 1.0); // 确保在[0,1]范围内
    
    // 计算沿y轴传导的波形弹动效果（只向外扩，不向内收缩）
    // 波形应该基于层（y高度），同一层的点有相同的波形效果
    // 只使用y坐标和时间来计算波形，不使用x、z坐标
    // 波形只在整合过程中播放（tt在0到1之间），整合完成后（tt=1）就不播放了
    // 降低频率以增加波长（波长 = 2π / 频率）
    let layerWavePhase = timeScaled * uniform.uWaveSpeed - (*center).y * uniform.uWaveFrequency * 0.5;
    
    // 使用平滑的正弦波，使波形更自然
    // 将sin从[-1,1]映射到[0,1]，然后应用平滑过渡
    let rawWave = sin(layerWavePhase);
    var wave = rawWave * 0.5 + 0.5; // 映射到[0,1]
    // 应用平滑函数，使波形过渡更柔和
    wave = wave * wave * (3.0 - 2.0 * wave); // 平滑的缓动曲线（smoothstep的等价实现）
    
    // 波形因子：只在整合过程中（tt在0到1之间）有波形，整合完成后（tt=1）波形为0
    // 使用更平滑的钟形曲线，在tt=0.5时达到峰值，过渡更自然
    var waveFactor = smoothstep(0.0, 0.4, tt) * smoothstep(1.0, 0.6, tt);
    // 应用额外的平滑，使波形因子过渡更柔和
    waveFactor = waveFactor * waveFactor * (3.0 - 2.0 * waveFactor); // 平滑的缓动曲线
    
    let bounce = wave * waveFactor; // 弹动强度只在整合过程中，同一层的点有相同的波形
    
    // 计算xz平面的径向方向（向外扩展）
    var xz = vec2f((*center).x, (*center).z);
    let radius = length(xz);
    let direction = select(vec2f(1.0, 0.0), normalize(xz), radius > 0.001);
    
    // 向外扩展，带弹动效果（减小振幅系数，使波形更柔和）
    let expandAmount = uniform.uIntensity * bounce * 0.5;
    xz = xz + direction * expandAmount;
    
    (*center).x = xz.x;
    (*center).z = xz.y;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let insideAABB = all(modifiedCenter >= uniform.uAabbMin) && all(modifiedCenter <= uniform.uAabbMax);
    if (!insideAABB) {
        return;
    }
    
    let timeScaled = uniform.uTime * uniform.uSpeed;
    let yOffset = originalCenter.y -uniform.uBottomY;
    let wavePhase = timeScaled - yOffset * uniform.uVerticalSpread;
    var tt = smoothstep(0.0, 1.0, wavePhase);
    tt = clamp(tt, 0.0, 1.0);
    
    if (tt <= 0.0) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
    if (tt >= 1.0) {
        return;
    }
    
    let fadeIn = smoothstep(0.0, 0.3, tt);
    let originalSize = gsplatGetSizeFromScale(*scale);
    let newSize = originalSize * fadeIn;
    let shapeBlend = smoothstep(0.0, 1.0, tt);
    let finalSize = mix(newSize, originalSize, shapeBlend);
    gsplatMakeSpherical(scale, finalSize);
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    // AABB crop 效果：检查 splat 是否在 AABB 内
    // 如果不在 AABB 内，不应用效果，保持原始颜色（正常显示）
    let insideAABB = all(center >= uniform.uAabbMin) && all(center <= uniform.uAabbMax);
    if (!insideAABB) {
        return; // 不在 AABB 内，不参与效果，保持原始颜色
    }
    // Integrate effect doesn't modify color
}
`;

/**
 * Integrate effect for gaussian splats.
 * Creates an integration effect that transforms point cloud particles into gaussian splats.
 * The effect propagates from bottom to top with wave-like expansion in xz plane.
 * 
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const integrateScript = entity.script.create(GsplatDisintegrate);
 * integrateScript.intensity = 0.5;
 * integrateScript.speed = 0.1;
 */
class GsplatIntegrate extends GsplatShaderEffect {
    static scriptName = 'gsplatIntegrate';

    // Reusable arrays for uniform updates
    _aabbMinArray = [0, 0, 0];
    _aabbMaxArray = [0, 0, 0];

    /**
     * Intensity of the integrate effect (0-1)
     * @attribute
     * @range [0, 1]
     */
    intensity = 0.5;

    /**
     * Speed of the integration effect (controls how fast the effect propagates)
     * Lower values = slower, more gradual integration
     * @attribute
     * @range [0, 1]
     */
    speed = 0.8;

    /**
     * Wave speed for the horizontal wave effect
     * @attribute
     * @range [0, 5]
     */
    waveSpeed = 1.0;

    /**
     * Wave frequency for the vertical propagation
     * @attribute
     * @range [0, 10]
     */
    waveFrequency = 3.0;

    /**
     * Bottom Y coordinate where integration starts.
     * 约定：bottomY 是视觉上的底部，对应更大的 Y 值；topY 是视觉上的顶部，对应更小的 Y 值。
     * @attribute
     */
    bottomY = 10.0;

    /**
     * Top Y coordinate where integration ends.
     * 约定：topY 是视觉上的顶部，对应更小的 Y 值。
     * @attribute
     */
    topY = -10.0;

    /**
     * Vertical spread coefficient for wave propagation
     * Controls how y-coordinate offset affects wave phase: wavePhase = timeScaled - yOffset * verticalSpread
     * Larger values = slower vertical propagation
     * This is typically calculated automatically based on totalDuration
     * @attribute
     */
    verticalSpread = 0.5;

    /**
     * Minimum corner of AABB in world space
     * @attribute
     */
    aabbMin = new Vec3(-0.5, -0.5, -0.5);

    /**
     * Maximum corner of AABB in world space
     * @attribute
     */
    aabbMax = new Vec3(0.5, 0.5, 0.5);

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
        this.setUniform('uSpeed', this.speed);
        this.setUniform('uWaveSpeed', this.waveSpeed);
        this.setUniform('uWaveFrequency', this.waveFrequency);
        this.setUniform('uTopY', this.topY);
        this.setUniform('uBottomY', this.bottomY);
        this.setUniform('uVerticalSpread', this.verticalSpread);

        // Set AABB uniforms
        this._aabbMinArray[0] = this.aabbMin.x;
        this._aabbMinArray[1] = this.aabbMin.y;
        this._aabbMinArray[2] = this.aabbMin.z;
        this.setUniform('uAabbMin', this._aabbMinArray);

        this._aabbMaxArray[0] = this.aabbMax.x;
        this._aabbMaxArray[1] = this.aabbMax.y;
        this._aabbMaxArray[2] = this.aabbMax.z;
        this.setUniform('uAabbMax', this._aabbMaxArray);

        // Check if effect is complete after updating uniforms
        // Temporarily disabled to debug - uncomment when effect is working
        if (this.isEffectComplete()) {
            console.log('[Integrate] effect time: ', this.effectTime);
            this.enabled = false;
            return;
        }
    }

    /**
     * Calculate when the effect is complete.
     * Effect completes when the integration wave has propagated from bottom to top.
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete() {
        // The integration effect propagates from top to bottom
        // The wave phase in shader is: wavePhase = timeScaled - yOffset * verticalSpread
        // where timeScaled = uTime * uSpeed, yOffset = uTopY - center.y
        // 
        // tt = smoothstep(0.0, 1.0, wavePhase)
        // Integration completes when wavePhase >= 1.0, i.e., tt = 1.0
        // 
        // For top point (y = topY):
        //   yOffset = 0, wavePhase = timeScaled
        //   Completes when: timeScaled >= 1.0, i.e., uTime >= 1.0 / speed
        // 
        // For bottom point (y = bottomY):
        //   yOffset = heightRange, wavePhase = timeScaled - heightRange * verticalSpread
        //   Completes when: wavePhase >= 1.0, i.e., timeScaled >= heightRange * verticalSpread + 1.0
        //   Therefore: uTime >= (heightRange * verticalSpread + 1.0) / speed
        
        const heightRange = Math.abs(this.topY - this.bottomY);
        
        // The bottom point is the last to complete, so the effect completes when
        // the bottom point reaches wavePhase = 1.0
        // Completion time = (heightRange * verticalSpread + 1.0) / speed
        const completionTime = (heightRange * this.verticalSpread + 1.0) / Math.max(this.speed, 0.001);
        
        return this.effectTime >= completionTime;
    }
}

export { GsplatIntegrate };
