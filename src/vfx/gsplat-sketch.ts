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
uniform float uSketchContrast;
uniform float uShadeLevels;
uniform float uHatchDensity;
uniform float uHatchStrength;
uniform float uSketchFeel;
uniform float uGrainFreq;
uniform float uGrainAmp;
uniform float uColorizeSharpness;
uniform float uEndRadius;

// Hash for noise
float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// 2D 旋转
mat2 rot2D(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat2(c, -s, s, c);
}

// Value noise (smoother than raw hash)
float valueNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float n = mix(
        mix(mix(hash(i), hash(i + vec3(1,0,0)), f.x),
            mix(hash(i + vec3(0,1,0)), hash(i + vec3(1,1,0)), f.x), f.y),
        mix(mix(hash(i + vec3(0,0,1)), hash(i + vec3(1,0,1)), f.x),
            mix(hash(i + vec3(0,1,1)), hash(i + vec3(1,1,1)), f.x), f.y), f.z);
    return n;
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
    // 与素描阶段保持一致：基于每个点自身的进度，从近（中心）至远传播
    // 近处的点先完成素描、先开始上色；远处的点后完成素描、后开始上色
    float sketchProgress = 0.0;
    
    if (g_phase == 1.0) {
        // 素描阶段：完全素描
        sketchProgress = 1.0;
    } else if (g_phase == 2.0) {
        // 上色阶段：与素描一致的时空顺序
        float transitionBand = mix(1.0, 0.25, uColorizeSharpness);
        float tMin = 0.5 - transitionBand * 0.5;
        float tMax = 0.5 + transitionBand * 0.5;
        float t = smoothstep(tMin, tMax, g_colorizeProgress);
        sketchProgress = 1.0 - t;
    } else {
        // 完成阶段：完全彩色
        sketchProgress = 0.0;
    }
    
    sketchProgress = clamp(sketchProgress, 0.0, 1.0);
    
    // === 素描 NPR：明暗正确 + 排线 + 颗粒 ===
    // 1. 基础亮度（暗部=深色，亮部=浅色）
    float luminance = dot(originalColor.rgb, vec3(0.299, 0.587, 0.114));
    float brightness = pow(luminance, uSketchContrast);
    float darkness = 1.0 - brightness;
    
    // 2. 排线（hatching）：多向交叉 + 速写感（仅用 sin/cos，无 hash）
    vec2 worldPos = center.xz;
    vec2 radialDir = normalize((center - uCenter).xz);
    vec2 lineDir = vec2(-radialDir.y, radialDir.x);
    // 速写感：区域角度微变、线条轻微起伏（纯 deterministic）
    float angleOff = 0.15 * uSketchFeel * sin(center.x * 0.25) * cos(center.z * 0.25);
    vec2 lineDirR = rot2D(angleOff) * lineDir;
    float wobble = 0.2 * uSketchFeel * sin(center.x * 0.35) * cos(center.z * 0.35);
    float lineCoord = (dot(worldPos, lineDirR) + wobble) * uHatchDensity;
    float linePattern = smoothstep(0.78, 0.98, abs(sin(lineCoord * 3.14159)));
    vec2 lineDir2 = rot2D(0.78 + angleOff * 0.5) * lineDir;
    float wobble2 = 0.18 * uSketchFeel * sin(center.x * 0.4 + 1.0) * cos(center.z * 0.3);
    float lineCoord2 = (dot(worldPos, lineDir2) + wobble2) * uHatchDensity * 0.75;
    float linePattern2 = smoothstep(0.78, 0.98, abs(sin(lineCoord2 * 3.14159)));
    vec2 lineDir3 = rot2D(1.57 + angleOff * 0.3) * lineDir;
    float wobble3 = 0.15 * uSketchFeel * sin(center.x * 0.3) * cos(center.z * 0.45 + 0.5);
    float lineCoord3 = (dot(worldPos, lineDir3) + wobble3) * uHatchDensity * 0.6;
    float linePattern3 = smoothstep(0.82, 0.98, abs(sin(lineCoord3 * 3.14159)));
    brightness -= (linePattern + linePattern2 * 0.55 + linePattern3 * 0.35) * darkness * uHatchStrength;
    
    // 3. 量化层次
    float levels = max(2.0, uShadeLevels);
    brightness = (floor(brightness * levels) + 0.5) / levels;
    
    // 4. 铅笔颗粒
    float grain = (valueNoise(center * uGrainFreq) - 0.5) * uGrainAmp;
    brightness += grain;
    
    float sketchValue = clamp(brightness, 0.0, 1.0);
    
    // 应用素描效果：素描 = 黑白，彩色 = 原始颜色
    vec3 sketchColor = vec3(sketchValue); // 黑白素描
    vec3 colorizedColor = originalColor.rgb; // 原始彩色
    
    // 根据进度混合素描和彩色（简化，避免随机扰动造成杂乱）
    float mixFactor = sketchProgress * uSketchIntensity;
    vec3 finalColor = mix(colorizedColor, sketchColor, mixFactor);
    
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
uniform uSketchContrast: f32;
uniform uShadeLevels: f32;
uniform uHatchDensity: f32;
uniform uHatchStrength: f32;
uniform uSketchFeel: f32;
uniform uGrainFreq: f32;
uniform uGrainAmp: f32;
uniform uColorizeSharpness: f32;
uniform uEndRadius: f32;

fn hash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

fn rot2D(angle: f32) -> mat2x2f {
    let s = sin(angle);
    let c = cos(angle);
    return mat2x2f(vec2f(c, -s), vec2f(s, c));
}

fn valueNoise(p: vec3f) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    let n = mix(
        mix(mix(hash(i), hash(i + vec3f(1.0, 0.0, 0.0)), f.x),
            mix(hash(i + vec3f(0.0, 1.0, 0.0)), hash(i + vec3f(1.0, 1.0, 0.0)), f.x), f.y),
        mix(mix(hash(i + vec3f(0.0, 0.0, 1.0)), hash(i + vec3f(1.0, 0.0, 1.0)), f.x),
            mix(hash(i + vec3f(0.0, 1.0, 1.0)), hash(i + vec3f(1.0, 1.0, 1.0)), f.x), f.y), f.z);
    return n;
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
    // 与素描阶段保持一致：基于每个点自身的进度，从近（中心）至远传播
    var sketchProgress: f32 = 0.0;
    
    if (g_phase == 1.0) {
        // 素描阶段：完全素描
        sketchProgress = 1.0;
    } else if (g_phase == 2.0) {
        // 上色阶段：与素描一致的时空顺序
        let transitionBand = mix(1.0, 0.25, uniform.uColorizeSharpness);
        let tMin = 0.5 - transitionBand * 0.5;
        let tMax = 0.5 + transitionBand * 0.5;
        let t = smoothstep(tMin, tMax, g_colorizeProgress);
        sketchProgress = 1.0 - t;
    } else {
        // 完成阶段：完全彩色
        sketchProgress = 0.0;
    }
    
    sketchProgress = clamp(sketchProgress, 0.0, 1.0);
    
    // === 素描 NPR：明暗正确 + 排线 + 颗粒 ===
    let luminance = dot(originalColor.rgb, vec3f(0.299, 0.587, 0.114));
    var brightness = pow(luminance, uniform.uSketchContrast);
    let darkness = 1.0 - brightness;
    
    let worldPos = vec2f(center.x, center.z);
    let radialDir = normalize(vec2f((center - uniform.uCenter).x, (center - uniform.uCenter).z));
    let lineDir = vec2f(-radialDir.y, radialDir.x);
    let angleOff = 0.15 * uniform.uSketchFeel * sin(center.x * 0.25) * cos(center.z * 0.25);
    let lineDirR = rot2D(angleOff) * lineDir;
    let wobble = 0.2 * uniform.uSketchFeel * sin(center.x * 0.35) * cos(center.z * 0.35);
    let lineCoord = (dot(worldPos, lineDirR) + wobble) * uniform.uHatchDensity;
    let linePattern = smoothstep(0.78, 0.98, abs(sin(lineCoord * 3.14159)));
    let lineDir2 = rot2D(0.78 + angleOff * 0.5) * lineDir;
    let wobble2 = 0.18 * uniform.uSketchFeel * sin(center.x * 0.4 + 1.0) * cos(center.z * 0.3);
    let lineCoord2 = (dot(worldPos, lineDir2) + wobble2) * uniform.uHatchDensity * 0.75;
    let linePattern2 = smoothstep(0.78, 0.98, abs(sin(lineCoord2 * 3.14159)));
    let lineDir3 = rot2D(1.57 + angleOff * 0.3) * lineDir;
    let wobble3 = 0.15 * uniform.uSketchFeel * sin(center.x * 0.3) * cos(center.z * 0.45 + 0.5);
    let lineCoord3 = (dot(worldPos, lineDir3) + wobble3) * uniform.uHatchDensity * 0.6;
    let linePattern3 = smoothstep(0.82, 0.98, abs(sin(lineCoord3 * 3.14159)));
    brightness -= (linePattern + linePattern2 * 0.55 + linePattern3 * 0.35) * darkness * uniform.uHatchStrength;
    
    let levels = max(2.0, uniform.uShadeLevels);
    brightness = (floor(brightness * levels) + 0.5) / levels;
    
    let grain = (valueNoise(center * uniform.uGrainFreq) - 0.5) * uniform.uGrainAmp;
    brightness += grain;
    
    var sketchValue = clamp(brightness, 0.0, 1.0);
    
    // 应用素描效果：素描 = 黑白，彩色 = 原始颜色
    let sketchColor = vec3f(sketchValue); // 黑白素描
    let colorizedColor = originalColor.rgb; // 原始彩色
    
    var mixFactor = sketchProgress * uniform.uSketchIntensity;
    let finalColor = mix(colorizedColor, sketchColor, mixFactor);
    
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
     * 素描明暗对比度（>1 增强对比，<1 减弱对比）
     * @attribute
     * @range [0.5, 3]
     */
    sketchContrast = 1.2;

    /**
     * 明暗量化层数（块面感，2-8）
     * @attribute
     * @range [2, 8]
     */
    shadeLevels = 5.0;

    /**
     * 排线密度（素描线条密度）
     * @attribute
     * @range [1, 25]
     */
    hatchDensity = 25.0;

    /**
     * 排线强度（0-1）
     * @attribute
     * @range [0, 1]
     */
    hatchStrength = 1.0;

    /**
     * 速写感（0-1）：线条角度微变、轻微起伏，纯 deterministic 无黑洞
     * @attribute
     * @range [0, 1]
     */
    sketchFeel = 1.0;

    /**
     * 铅笔颗粒噪声频率
     * @attribute
     * @range [5, 50]
     */
    grainFreq = 25.0;

    /**
     * 铅笔颗粒强度（炭笔感）
     * @attribute
     * @range [0, 0.15]
     */
    grainAmp = 0.04;

    /**
     * 上色过渡边缘锐度（0-1）
     * @attribute
     * @range [0, 1]
     */
    colorizeSharpness = 0.6;

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
        this.setUniform('uSketchContrast', this.sketchContrast);
        this.setUniform('uShadeLevels', this.shadeLevels);
        this.setUniform('uHatchDensity', this.hatchDensity);
        this.setUniform('uHatchStrength', this.hatchStrength);
        this.setUniform('uSketchFeel', this.sketchFeel);
        this.setUniform('uGrainFreq', this.grainFreq);
        this.setUniform('uGrainAmp', this.grainAmp);
        this.setUniform('uColorizeSharpness', this.colorizeSharpness);

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
