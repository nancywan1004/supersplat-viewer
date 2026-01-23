import { Vec3, Color } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform vec3 uCenter;
uniform float uWaveSpeed;
uniform float uSketchDuration;
uniform float uColorizeDuration;
uniform float uFadeWidthRatio;
uniform float uSketchIntensity;
uniform float uSketchLineDensity;
uniform float uSketchEdgeThreshold;
uniform float uColorTransitionStart;
uniform float uEndRadius;

// Hash function for per-splat randomization
float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// 2D 旋转矩阵
mat2 rot2D(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat2(c, -s, s, c);
}

// Shared globals
float g_dist;
float g_tSketchStart;
float g_tSketchEnd;
float g_tColorizeStart;
float g_tColorizeEnd;
float g_sketchProgress;
float g_colorizeProgress;
float g_phase;
float g_currentRadius;

void initShared(vec3 center) {
    g_dist = length(center - uCenter);
    
    // 素描阶段：从中心向外传播
    // 距离中心越远的点，素描效果开始得越晚
    g_tSketchStart = g_dist / uWaveSpeed;
    g_tSketchEnd = g_tSketchStart + uSketchDuration;
    
    // 上色阶段：素描完成后开始上色
    g_tColorizeStart = g_tSketchEnd;
    g_tColorizeEnd = g_tColorizeStart + uColorizeDuration;
    
    // 计算当前半径（基于时间）
    g_currentRadius = uTime * uWaveSpeed;
    
    // 计算素描进度
    if (uTime < g_tSketchStart) {
        g_sketchProgress = 0.0;
    } else if (uTime >= g_tSketchEnd) {
        g_sketchProgress = 1.0;
    } else {
        g_sketchProgress = (uTime - g_tSketchStart) / uSketchDuration;
        g_sketchProgress = clamp(g_sketchProgress, 0.0, 1.0);
    }
    
    // 计算上色进度
    if (uTime < g_tColorizeStart) {
        g_colorizeProgress = 0.0;
    } else if (uTime >= g_tColorizeEnd) {
        g_colorizeProgress = 1.0;
    } else {
        g_colorizeProgress = (uTime - g_tColorizeStart) / uColorizeDuration;
        g_colorizeProgress = clamp(g_colorizeProgress, 0.0, 1.0);
    }
    
    // 确定当前阶段
    if (g_dist > uEndRadius) {
        g_phase = 0.0; // 超出范围，隐藏
    } else if (uTime < g_tSketchStart) {
        g_phase = 0.0; // 素描未开始，隐藏
    } else if (uTime < g_tSketchEnd) {
        g_phase = 1.0; // 素描阶段
    } else if (uTime < g_tColorizeEnd) {
        g_phase = 2.0; // 上色阶段
    } else {
        g_phase = 3.0; // 完成
    }
}

void modifyCenter(inout vec3 center) {
    // 素描效果不修改中心点位置
}

void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
    initShared(originalCenter);
    
    // 超出范围或未开始：隐藏
    if (g_phase == 0.0) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // 完成阶段：保持原始形状
    if (g_phase >= 3.0) {
        return;
    }
    
    // 素描和上色阶段：保持原始形状
    // 形状修改在 modifyColor 中通过颜色处理
}

void modifyColor(vec3 center, inout vec4 color) {
    initShared(center);
    
    // 超出范围或未开始：隐藏
    if (g_phase == 0.0) {
        color.a = 0.0;
        return;
    }
    
    // 保存原始颜色
    vec4 originalColor = color;
    
    // 计算透明度渐变（基于当前半径）
    float fadeStart = g_currentRadius * (1.0 - uFadeWidthRatio);
    float fadeWidth = g_currentRadius * uFadeWidthRatio;
    float alphaMultiplier = 1.0;
    
    if (g_dist > g_currentRadius) {
        // 超出当前半径：完全隐藏
        color.a = 0.0;
        return;
    } else if (g_dist >= fadeStart) {
        // 过渡区域：应用平滑透明度渐变
        float fadeProgress = (g_dist - fadeStart) / max(fadeWidth, 0.001);
        alphaMultiplier = (1.0 - smoothstep(0.0, 1.0, fadeProgress));
    }
    
    // 计算素描到彩色的过渡进度
    // 在素描阶段：完全素描
    // 在上色阶段：从素描逐渐过渡到彩色
    float normalizedDistance = g_dist / max(g_currentRadius, 0.001);
    float sketchProgress = 0.0;
    
    if (g_phase == 1.0) {
        // 素描阶段：完全素描
        sketchProgress = 1.0;
    } else if (g_phase == 2.0) {
        // 上色阶段：根据上色进度和距离混合
        // 距离中心越近，彩色出现得越快
        float distanceBasedProgress = 1.0 - smoothstep(uColorTransitionStart, 1.0, normalizedDistance);
        sketchProgress = mix(1.0, 0.0, g_colorizeProgress * distanceBasedProgress);
    } else {
        // 完成阶段：完全彩色
        sketchProgress = 0.0;
    }
    
    sketchProgress = clamp(sketchProgress, 0.0, 1.0);
    
    // 计算素描效果值
    // 使用颜色亮度作为明暗参考
    float luminance = dot(originalColor.rgb, vec3(0.299, 0.587, 0.114));
    float darkness = 1.0 - luminance;
    
    // 1. 边缘线检测（基于位置梯度和颜色变化）
    // 使用位置哈希来模拟边缘（在形状转折处）
    vec3 posHash = center * 0.5;
    float edgeNoise = hash(posHash);
    
    // 计算位置梯度（使用噪声场模拟）
    float gradientX = hash(posHash + vec3(0.1, 0.0, 0.0)) - hash(posHash - vec3(0.1, 0.0, 0.0));
    float gradientY = hash(posHash + vec3(0.0, 0.1, 0.0)) - hash(posHash - vec3(0.0, 0.1, 0.0));
    float gradientZ = hash(posHash + vec3(0.0, 0.0, 0.1)) - hash(posHash - vec3(0.0, 0.0, 0.1));
    float gradientMagnitude = length(vec3(gradientX, gradientY, gradientZ));
    
    // 边缘强度：梯度大的地方（转折处）边缘明显
    float edgeStrength = smoothstep(0.3, 1.0, gradientMagnitude);
    edgeStrength = max(edgeStrength, step(0.85, edgeNoise) * 0.6); // 添加一些随机边缘
    
    // 2. 排线方向（基于形体和位置）
    // 计算主方向（基于位置，模拟跟随形体）
    vec2 worldPos = center.xz;
    vec3 toCenter = center - uCenter;
    vec2 radialDir = normalize(toCenter.xz);
    
    // 排线方向垂直于径向（模拟跟随形体轮廓）
    vec2 lineDir = vec2(-radialDir.y, radialDir.x);
    
    // 也可以基于世界坐标创建不同方向的排线
    float angleVariation = hash(center * 0.3) * 6.28318; // 随机角度变化
    mat2 rotMat = rot2D(angleVariation);
    lineDir = rotMat * lineDir;
    
    // 3. 排线密度（基于明暗）
    // 计算排线坐标
    float lineCoord = dot(worldPos, lineDir) * uSketchLineDensity;
    
    // 创建排线模式（使用正弦波创建线条）
    float linePattern = sin(lineCoord * 3.14159);
    linePattern = abs(linePattern);
    
    // 根据明暗调整排线密度：暗部密度高，亮部密度低
    float lineDensity = mix(0.2, 1.0, darkness);
    linePattern = smoothstep(1.0 - lineDensity, 1.0, linePattern);
    
    // 添加多层排线效果（不同频率）
    float linePattern2 = abs(sin(lineCoord * 6.28318 * 0.5));
    linePattern2 = smoothstep(1.0 - lineDensity * 0.5, 1.0, linePattern2);
    linePattern = max(linePattern, linePattern2 * 0.3);
    
    // 4. 组合效果：边缘线 + 排线
    // 边缘处优先显示边缘线，非边缘处显示排线
    float sketchValue = max(edgeStrength, linePattern * (1.0 - edgeStrength * 0.6));
    
    // 添加一些随机性使效果更自然
    float random = hash(center * 10.0);
    sketchValue = mix(sketchValue, 1.0, random * 0.05);
    
    // 确保素描值在合理范围内
    sketchValue = clamp(sketchValue, 0.0, 1.0);
    
    // 应用素描效果：素描 = 黑白，彩色 = 原始颜色
    vec3 sketchColor = vec3(sketchValue); // 黑白素描
    vec3 colorizedColor = originalColor.rgb; // 原始彩色
    
    // 根据进度混合素描和彩色
    vec3 finalColor = mix(colorizedColor, sketchColor, sketchProgress * uSketchIntensity);
    
    // 应用最终颜色和透明度
    color.rgb = finalColor;
    color.a *= alphaMultiplier;
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uWaveSpeed: f32;
uniform uSketchDuration: f32;
uniform uColorizeDuration: f32;
uniform uFadeWidthRatio: f32;
uniform uSketchIntensity: f32;
uniform uSketchLineDensity: f32;
uniform uSketchEdgeThreshold: f32;
uniform uColorTransitionStart: f32;
uniform uEndRadius: f32;

// Hash function for per-splat randomization
fn hash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

// 2D 旋转矩阵
fn rot2D(angle: f32) -> mat2x2f {
    let s = sin(angle);
    let c = cos(angle);
    return mat2x2f(
        vec2f(c, -s),
        vec2f(s, c)
    );
}

// Shared globals
var<private> g_dist: f32;
var<private> g_tSketchStart: f32;
var<private> g_tSketchEnd: f32;
var<private> g_tColorizeStart: f32;
var<private> g_tColorizeEnd: f32;
var<private> g_sketchProgress: f32;
var<private> g_colorizeProgress: f32;
var<private> g_phase: f32;
var<private> g_currentRadius: f32;

fn initShared(center: vec3f) {
    g_dist = length(center - uniform.uCenter);
    
    // 素描阶段：从中心向外传播
    // 距离中心越远的点，素描效果开始得越晚
    g_tSketchStart = g_dist / uniform.uWaveSpeed;
    g_tSketchEnd = g_tSketchStart + uniform.uSketchDuration;
    
    // 上色阶段：素描完成后开始上色
    g_tColorizeStart = g_tSketchEnd;
    g_tColorizeEnd = g_tColorizeStart + uniform.uColorizeDuration;
    
    // 计算当前半径（基于时间）
    g_currentRadius = uniform.uTime * uniform.uWaveSpeed;
    
    // 计算素描进度
    if (uniform.uTime < g_tSketchStart) {
        g_sketchProgress = 0.0;
    } else if (uniform.uTime >= g_tSketchEnd) {
        g_sketchProgress = 1.0;
    } else {
        g_sketchProgress = (uniform.uTime - g_tSketchStart) / uniform.uSketchDuration;
        g_sketchProgress = clamp(g_sketchProgress, 0.0, 1.0);
    }
    
    // 计算上色进度
    if (uniform.uTime < g_tColorizeStart) {
        g_colorizeProgress = 0.0;
    } else if (uniform.uTime >= g_tColorizeEnd) {
        g_colorizeProgress = 1.0;
    } else {
        g_colorizeProgress = (uniform.uTime - g_tColorizeStart) / uniform.uColorizeDuration;
        g_colorizeProgress = clamp(g_colorizeProgress, 0.0, 1.0);
    }
    
    // 确定当前阶段
    if (g_dist > uniform.uEndRadius) {
        g_phase = 0.0; // 超出范围，隐藏
    } else if (uniform.uTime < g_tSketchStart) {
        g_phase = 0.0; // 素描未开始，隐藏
    } else if (uniform.uTime < g_tSketchEnd) {
        g_phase = 1.0; // 素描阶段
    } else if (uniform.uTime < g_tColorizeEnd) {
        g_phase = 2.0; // 上色阶段
    } else {
        g_phase = 3.0; // 完成
    }
}

fn modifyCenter(center: ptr<function, vec3f>) {
    // 素描效果不修改中心点位置
}

fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
    initShared(originalCenter);
    
    // 超出范围或未开始：隐藏
    if (g_phase == 0.0) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // 完成阶段：保持原始形状
    if (g_phase >= 3.0) {
        return;
    }
    
    // 素描和上色阶段：保持原始形状
    // 形状修改在 modifyColor 中通过颜色处理
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    initShared(center);
    
    // 超出范围或未开始：隐藏
    if (g_phase == 0.0) {
        (*color).a = 0.0;
        return;
    }
    
    // 保存原始颜色
    let originalColor = *color;
    
    // 计算透明度渐变（基于当前半径）
    let fadeStart = g_currentRadius * (1.0 - uniform.uFadeWidthRatio);
    let fadeWidth = g_currentRadius * uniform.uFadeWidthRatio;
    var alphaMultiplier: f32 = 1.0;
    
    if (g_dist > g_currentRadius) {
        // 超出当前半径：完全隐藏
        (*color).a = 0.0;
        return;
    } else if (g_dist >= fadeStart) {
        // 过渡区域：应用平滑透明度渐变
        let fadeProgress = (g_dist - fadeStart) / max(fadeWidth, 0.001);
        alphaMultiplier = (1.0 - smoothstep(0.0, 1.0, fadeProgress));
    }
    
    // 计算素描到彩色的过渡进度
    // 在素描阶段：完全素描
    // 在上色阶段：从素描逐渐过渡到彩色
    let normalizedDistance = g_dist / max(g_currentRadius, 0.001);
    var sketchProgress: f32 = 0.0;
    
    if (g_phase == 1.0) {
        // 素描阶段：完全素描
        sketchProgress = 1.0;
    } else if (g_phase == 2.0) {
        // 上色阶段：根据上色进度和距离混合
        // 距离中心越近，彩色出现得越快
        let distanceBasedProgress = 1.0 - smoothstep(uniform.uColorTransitionStart, 1.0, normalizedDistance);
        sketchProgress = mix(1.0, 0.0, g_colorizeProgress * distanceBasedProgress);
    } else {
        // 完成阶段：完全彩色
        sketchProgress = 0.0;
    }
    
    sketchProgress = clamp(sketchProgress, 0.0, 1.0);
    
    // 计算素描效果值
    // 使用颜色亮度作为明暗参考
    let luminance = dot(originalColor.rgb, vec3f(0.299, 0.587, 0.114));
    let darkness = 1.0 - luminance;
    
    // 1. 边缘线检测（基于位置梯度和颜色变化）
    // 使用位置哈希来模拟边缘（在形状转折处）
    let posHash = center * 0.5;
    let edgeNoise = hash(posHash);
    
    // 计算位置梯度（使用噪声场模拟）
    let gradientX = hash(posHash + vec3f(0.1, 0.0, 0.0)) - hash(posHash - vec3f(0.1, 0.0, 0.0));
    let gradientY = hash(posHash + vec3f(0.0, 0.1, 0.0)) - hash(posHash - vec3f(0.0, 0.1, 0.0));
    let gradientZ = hash(posHash + vec3f(0.0, 0.0, 0.1)) - hash(posHash - vec3f(0.0, 0.0, 0.1));
    let gradientMagnitude = length(vec3f(gradientX, gradientY, gradientZ));
    
    // 边缘强度：梯度大的地方（转折处）边缘明显
    var edgeStrength = smoothstep(0.3, 1.0, gradientMagnitude);
    edgeStrength = max(edgeStrength, select(0.0, 0.6, edgeNoise > 0.85)); // 添加一些随机边缘
    
    // 2. 排线方向（基于形体和位置）
    // 计算主方向（基于位置，模拟跟随形体）
    let worldPos = vec2f(center.x, center.z);
    let toCenter = center - uniform.uCenter;
    var radialDir = normalize(vec2f(toCenter.x, toCenter.z));
    
    // 排线方向垂直于径向（模拟跟随形体轮廓）
    var lineDir = vec2f(-radialDir.y, radialDir.x);
    
    // 也可以基于世界坐标创建不同方向的排线
    let angleVariation = hash(center * 0.3) * 6.28318; // 随机角度变化
    let rotMat = rot2D(angleVariation);
    lineDir = rotMat * lineDir;
    
    // 3. 排线密度（基于明暗）
    // 计算排线坐标
    let lineCoord = dot(worldPos, lineDir) * uniform.uSketchLineDensity;
    
    // 创建排线模式（使用正弦波创建线条）
    var linePattern = abs(sin(lineCoord * 3.14159));
    
    // 根据明暗调整排线密度：暗部密度高，亮部密度低
    let lineDensity = mix(0.2, 1.0, darkness);
    linePattern = smoothstep(1.0 - lineDensity, 1.0, linePattern);
    
    // 添加多层排线效果（不同频率）
    var linePattern2 = abs(sin(lineCoord * 6.28318 * 0.5));
    linePattern2 = smoothstep(1.0 - lineDensity * 0.5, 1.0, linePattern2);
    linePattern = max(linePattern, linePattern2 * 0.3);
    
    // 4. 组合效果：边缘线 + 排线
    // 边缘处优先显示边缘线，非边缘处显示排线
    var sketchValue = max(edgeStrength, linePattern * (1.0 - edgeStrength * 0.6));
    
    // 添加一些随机性使效果更自然
    let random = hash(center * 10.0);
    sketchValue = mix(sketchValue, 1.0, random * 0.05);
    
    // 确保素描值在合理范围内
    sketchValue = clamp(sketchValue, 0.0, 1.0);
    
    // 应用素描效果：素描 = 黑白，彩色 = 原始颜色
    let sketchColor = vec3f(sketchValue); // 黑白素描
    let colorizedColor = originalColor.rgb; // 原始彩色
    
    // 根据进度混合素描和彩色
    let finalColor = mix(colorizedColor, sketchColor, sketchProgress * uniform.uSketchIntensity);
    
    // 应用最终颜色和透明度
    (*color).rgb = finalColor;
    (*color).a *= alphaMultiplier;
}
`;

/**
 * 素描到彩色过渡效果，用于 Gaussian Splats
 * 从中心点向外扩散，先显示黑白素描线条效果，然后逐渐上色
 * 
 * @example
 * // 添加脚本到 gsplat entity
 * const sketchEffect = new GsplatSketch();
 * sketchEffect.center = new Vec3(0, 0, 0);
 * sketchEffect.waveSpeed = 10.0;
 * sketchEffect.sketchDuration = 5.0;
 * sketchEffect.colorizeDuration = 5.0;
 */
class GsplatSketch extends GsplatShaderEffect {
    static scriptName = 'gsplatSketch';

    // 可重用数组用于 uniform 更新
    _centerArray = [0, 0, 0];

    /**
     * 效果的中心点
     * @attribute
     */
    center = new Vec3(0, 0, 0);

    /**
     * 波传播速度（单位/秒）
     * @attribute
     * @range [0.1, 100]
     */
    waveSpeed = 10.0;

    /**
     * 素描阶段持续时间（秒）
     * @attribute
     * @range [0.5, 30]
     */
    sketchDuration = 5.0;

    /**
     * 上色阶段持续时间（秒）
     * @attribute
     * @range [0.5, 30]
     */
    colorizeDuration = 5.0;

    /**
     * 渐变宽度比例（相对于当前半径）
     * @attribute
     * @range [0, 1]
     */
    fadeWidthRatio = 0.1;

    /**
     * 最大处理半径（超出此半径的点不参与效果）
     * @attribute
     * @range [0, 1000]
     */
    endRadius = 200.0;

    /**
     * 素描效果强度（0-1）
     * 控制从素描到彩色的过渡强度
     * @attribute
     * @range [0, 1]
     */
    sketchIntensity = 1.0;

    /**
     * 素描排线密度
     * 控制排线的密集程度
     * @attribute
     * @range [0.1, 10]
     */
    sketchLineDensity = 2.0;

    /**
     * 素描边缘检测阈值
     * 控制边缘线的敏感度
     * @attribute
     * @range [1, 20]
     */
    sketchEdgeThreshold = 3.0;

    /**
     * 彩色过渡开始位置（相对于半径的比例，0-1）
     * 0 = 从中心开始就是彩色，1 = 边缘才开始彩色
     * @attribute
     * @range [0, 1]
     */
    colorTransitionStart = 0.3;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // 更新 uniforms
        this.setUniform('uTime', effectTime);

        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        this.setUniform('uWaveSpeed', this.waveSpeed);
        this.setUniform('uSketchDuration', this.sketchDuration);
        this.setUniform('uColorizeDuration', this.colorizeDuration);
        this.setUniform('uFadeWidthRatio', this.fadeWidthRatio);
        this.setUniform('uEndRadius', this.endRadius);

        // 素描效果相关 uniforms
        this.setUniform('uSketchIntensity', this.sketchIntensity);
        this.setUniform('uSketchLineDensity', this.sketchLineDensity);
        this.setUniform('uSketchEdgeThreshold', this.sketchEdgeThreshold);
        this.setUniform('uColorTransitionStart', this.colorTransitionStart);

        // 检查效果是否完成
        if (this.isEffectComplete()) {
            console.log('Sketch effect completed, disabling');
            this.enabled = false;
            return;
        }
    }

    /**
     * 计算效果完成时间
     * @returns {number} 效果完成的时间（秒）
     */
    getCompletionTime() {
        if (this.waveSpeed === 0) {
            return Infinity;
        }
        // 最远的点完成上色所需的时间
        const maxSketchStart = this.endRadius / this.waveSpeed;
        const maxSketchEnd = maxSketchStart + this.sketchDuration;
        const maxColorizeEnd = maxSketchEnd + this.colorizeDuration;
        return maxColorizeEnd;
    }

    /**
     * 检查效果是否完成
     * @returns {boolean} 如果效果完成返回 true
     */
    isEffectComplete() {
        return this.effectTime >= this.getCompletionTime();
    }
}

export { GsplatSketch };
