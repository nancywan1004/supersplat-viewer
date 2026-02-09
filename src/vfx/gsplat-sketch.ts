import { Vec3, Color } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform vec3 uCenter;
uniform vec3 uCameraPos;
uniform float uUseCameraDistance;
uniform float uWaveSpeed;
uniform float uSketchDuration;
uniform float uColorizeDuration;
uniform float uFadeWidthRatio;
uniform float uSketchIntensity;
uniform float uSketchContrast;
uniform float uDraftFeel;
uniform float uShadeLevels;
uniform float uHatchDensity;
uniform float uHatchStrength;
uniform float uGrainFreq;
uniform float uGrainAmp;
uniform float uPaperTintAmount;
uniform vec3 uPaperTint;
uniform float uColorizeSpread;
uniform float uColorizeDensity;
uniform float uColorizeAlphaGrain;
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

// Value noise: 晶格顶点 hash + 平滑插值(smoothstep)，输出 [0,1]
// 比纯 hash 更柔和，适合做颗粒/纤维
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

// FBM：多层 valueNoise 叠加，产生更丰富自然的纹路（纸张纤维/炭笔粗糙感）
float fbmValueNoise(vec3 p) {
    float v = 0.0, a = 0.5, f = 1.0;
    v += a * valueNoise(p * f); f *= 2.0; a *= 0.5;
    v += a * valueNoise(p * f); f *= 2.0; a *= 0.5;
    v += a * valueNoise(p * f); f *= 2.0; a *= 0.5;
    v += a * valueNoise(p * f);
    return v;
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
    
    // 计算上色进度：可选择基于相机距离或中心距离
    float colorizeDist = g_dist;
    if (uUseCameraDistance > 0.5) {
        // 使用到相机的距离（基于相机视角由近至远上色）
        colorizeDist = length(center - uCameraPos);
    }
    
    // 上色波前半径随时间扩张
    float colorizeRadius = 0.0;
    if (uTime > g_tColorizeStart) {
        float colorizeT = min(uTime - g_tColorizeStart, uColorizeDuration);
        colorizeRadius = (colorizeT / uColorizeDuration) * uEndRadius;
    }
    // 上色过渡带加宽，使素描→彩色过渡更明显
    float colorizeBand = uEndRadius * uFadeWidthRatio * 6.0;
    float colorizeOuter = colorizeRadius + colorizeBand * 0.5;
    float colorizeInner = max(0.0, colorizeRadius - colorizeBand * 0.5);
    if (colorizeDist <= colorizeInner) {
        g_colorizeProgress = 1.0;
    } else if (colorizeDist >= colorizeOuter) {
        g_colorizeProgress = 0.0;
    } else {
        g_colorizeProgress = 1.0 - smoothstep(colorizeInner, colorizeOuter, colorizeDist);
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

void modifySplatCenter(inout vec3 center) {
    // 素描效果不修改中心点位置
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    initShared(originalCenter);
    
    if (g_phase == 0.0) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
    if (g_phase >= 3.0) {
        return;
    }
    // 上色阶段：过渡区内均匀放大，模拟笔触涂抹扩散
    if (g_phase == 2.0 && uColorizeSpread > 0.0) {
        float peak = smoothstep(0.2, 0.5, g_colorizeProgress) * smoothstep(0.8, 0.5, g_colorizeProgress);
        float spread = 1.0 + uColorizeSpread * peak;
        scale *= spread;
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {
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
        // 上色阶段：与素描一致的时空顺序，加宽过渡带使过渡更明显
        float transitionBand = mix(1.0, 0.2, uColorizeSharpness);
        float tMin = 0.5 - transitionBand * 0.5;
        float tMax = 0.5 + transitionBand * 0.5;
        float t = smoothstep(tMin, tMax, g_colorizeProgress);
        sketchProgress = 1.0 - t;
        // 轻微缓动，让半素描半彩色的过渡区更可见
        sketchProgress = pow(sketchProgress, 0.9);
    } else {
        // 完成阶段：完全彩色
        sketchProgress = 0.0;
    }
    
    sketchProgress = clamp(sketchProgress, 0.0, 1.0);
    
    // === 素描 NPR：明暗正确 + 排线 + 颗粒 ===
    // 1. 基础亮度（暗部=深色，亮部=浅色）
    float luminance = dot(originalColor.rgb, vec3(0.299, 0.587, 0.114));
    float effectiveContrast = mix(uSketchContrast, 1.0, uDraftFeel * 0.5);
    float brightness = pow(luminance, effectiveContrast);
    float darkness = 1.0 - brightness;
    
    // 2. 排线（hatching）：草稿感 = 更松的线条、更大抖动、更块面
    vec2 worldPos = center.xz;
    vec2 radialDir = normalize((center - uCenter).xz);
    vec2 lineDir = vec2(-radialDir.y, radialDir.x);
    float draft = 1.0 + 0.7 * uDraftFeel;
    float angleOff = 0.2 * draft * sin(center.x * 0.37 + center.z * 0.21) * cos(center.z * 0.31 + center.y * 0.1);
    vec2 lineDirR = rot2D(angleOff) * lineDir;
    float wobble = 0.25 * draft * sin(center.x * 0.41 + center.z * 0.29) * cos(center.z * 0.33 + 1.0);
    float phaseJitter = (valueNoise(center * 0.7 + 1.0) - 0.5) * (1.2 + 0.8 * uDraftFeel);
    float lineCoord = (dot(worldPos, lineDirR) + wobble + phaseJitter) * uHatchDensity;
    float linePattern = smoothstep(0.68, 0.96, abs(sin(lineCoord * 3.14159)));
    vec2 lineDir2 = rot2D(0.73 + angleOff * 0.5) * lineDir;
    float wobble2 = 0.22 * draft * sin(center.x * 0.43 + center.z * 0.19) * cos(center.z * 0.27 + 0.5);
    float phaseJitter2 = (valueNoise(center * 0.6 + 3.0) - 0.5) * (1.0 + 0.6 * uDraftFeel);
    float lineCoord2 = (dot(worldPos, lineDir2) + wobble2 + phaseJitter2) * uHatchDensity * 0.82;
    float linePattern2 = smoothstep(0.68, 0.96, abs(sin(lineCoord2 * 3.14159)));
    vec2 lineDir3 = rot2D(1.43 + angleOff * 0.3) * lineDir;
    float wobble3 = 0.2 * draft * sin(center.x * 0.39 + center.z * 0.23) * cos(center.z * 0.35 + 1.3);
    float phaseJitter3 = (valueNoise(center * 0.65 + 5.0) - 0.5) * (0.9 + 0.5 * uDraftFeel);
    float lineCoord3 = (dot(worldPos, lineDir3) + wobble3 + phaseJitter3) * uHatchDensity * 0.63;
    float linePattern3 = smoothstep(0.7, 0.96, abs(sin(lineCoord3 * 3.14159)));
    float hatchInDark = uHatchStrength * (1.0 - smoothstep(0.42, 0.72, darkness));
    brightness -= (linePattern + linePattern2 * 0.55 + linePattern3 * 0.35) * darkness * hatchInDark;
    
    // 3. 量化层次：草稿感=更块面，写实感=更平滑
    float levels = max(2.0, uShadeLevels);
    float preQuant = brightness;
    float quantized = (floor(brightness * levels) + 0.5) / levels;
    float quantBlend = mix(0.06, 0.18, 1.0 - uDraftFeel);
    brightness = mix(quantized, preQuant, quantBlend);
    
    // 4. 肌理层（暗处减弱，避免黑洞感）
    float grain = (valueNoise(center * uGrainFreq) - 0.5) * uGrainAmp;
    float paperFiber = (fbmValueNoise(center * uGrainFreq * 0.4 + 2.0) - 0.5) * uGrainAmp * 0.8;
    float roughGrit = (valueNoise(center * uGrainFreq * 2.5 + 5.0) - 0.5) * uGrainAmp * 0.5;
    float darkMask = 1.0 - 0.55 * smoothstep(0.5, 0.92, darkness);
    brightness += (grain + paperFiber + roughGrit) * 1.5 * darkMask;
    
    brightness = mix(brightness, 0.5, uDraftFeel * mix(0.06, 0.12, 1.0 - uDraftFeel));
    
    float sketchValue = clamp(brightness, 0.03, 1.0);
    
    // 纸张色调：灰度乘暖色，不改变明暗次序，仅整体偏暖
    vec3 pureGray = vec3(sketchValue);
    vec3 tinted = pureGray * uPaperTint;
    vec3 sketchColor = mix(pureGray, tinted, uPaperTintAmount);
    vec3 colorizedColor = originalColor.rgb; // 原始彩色
    
    // 混合素描和彩色
    float mixFactor = sketchProgress * uSketchIntensity;
    
    // 上色阶段笔触增强：密度叠加（过渡区中心颜色更实，边缘渐浅）
    if (g_phase == 2.0 && uColorizeDensity > 0.0) {
        float densityPeak = smoothstep(0.2, 0.5, g_colorizeProgress) * smoothstep(0.8, 0.5, g_colorizeProgress);
        mixFactor *= (1.0 - uColorizeDensity * densityPeak);
    }
    
    vec3 finalColor = mix(colorizedColor, sketchColor, mixFactor);
    
    // 上色阶段：Alpha 颗粒抖动（纸张/彩铅质感）
    float alphaGrain = 1.0;
    if (g_phase == 2.0 && uColorizeAlphaGrain > 0.0) {
        alphaGrain = 0.9 + 0.1 * valueNoise(center * uGrainFreq * 2.0);
        alphaGrain = mix(1.0, alphaGrain, uColorizeAlphaGrain);
    }
    
    color.rgb = finalColor;
    color.a *= alphaMultiplier * alphaGrain;
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uCameraPos: vec3f;
uniform uUseCameraDistance: f32;
uniform uWaveSpeed: f32;
uniform uSketchDuration: f32;
uniform uColorizeDuration: f32;
uniform uFadeWidthRatio: f32;
uniform uSketchIntensity: f32;
uniform uSketchContrast: f32;
uniform uDraftFeel: f32;
uniform uShadeLevels: f32;
uniform uHatchDensity: f32;
uniform uHatchStrength: f32;
uniform uGrainFreq: f32;
uniform uGrainAmp: f32;
uniform uPaperTintAmount: f32;
uniform uPaperTint: vec3f;
uniform uColorizeSpread: f32;
uniform uColorizeDensity: f32;
uniform uColorizeAlphaGrain: f32;
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

fn fbmValueNoise(p: vec3f) -> f32 {
    var v: f32 = 0.0;
    var a: f32 = 0.5;
    var f: f32 = 1.0;
    v += a * valueNoise(p * f); f *= 2.0; a *= 0.5;
    v += a * valueNoise(p * f); f *= 2.0; a *= 0.5;
    v += a * valueNoise(p * f); f *= 2.0; a *= 0.5;
    v += a * valueNoise(p * f);
    return v;
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
    
    // 计算上色进度：可选择基于相机距离或中心距离
    var colorizeDist: f32 = g_dist;
    if (uniform.uUseCameraDistance > 0.5) {
        // 使用到相机的距离（基于相机视角由近至远上色）
        colorizeDist = length(center - uniform.uCameraPos);
    }
    
    // 上色波前半径随时间扩张
    var colorizeRadius: f32 = 0.0;
    if (uniform.uTime > g_tColorizeStart) {
        let colorizeT = min(uniform.uTime - g_tColorizeStart, uniform.uColorizeDuration);
        colorizeRadius = (colorizeT / uniform.uColorizeDuration) * uniform.uEndRadius;
    }
    // 上色过渡带加宽，使素描→彩色过渡更明显
    let colorizeBand = uniform.uEndRadius * uniform.uFadeWidthRatio * 6.0;
    let colorizeOuter = colorizeRadius + colorizeBand * 0.5;
    let colorizeInner = max(0.0, colorizeRadius - colorizeBand * 0.5);
    if (colorizeDist <= colorizeInner) {
        g_colorizeProgress = 1.0;
    } else if (colorizeDist >= colorizeOuter) {
        g_colorizeProgress = 0.0;
    } else {
        g_colorizeProgress = 1.0 - smoothstep(colorizeInner, colorizeOuter, colorizeDist);
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

fn modifySplatCenter(center: ptr<function, vec3f>) {
    // 素描效果不修改中心点位置
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    initShared(originalCenter);
    
    if (g_phase == 0.0) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
    if (g_phase >= 3.0) {
        return;
    }
    if (g_phase == 2.0 && uniform.uColorizeSpread > 0.0) {
        let peak = smoothstep(0.2, 0.5, g_colorizeProgress) * smoothstep(0.8, 0.5, g_colorizeProgress);
        let spread = 1.0 + uniform.uColorizeSpread * peak;
        *scale = *scale * spread;
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
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
        // 上色阶段：与素描一致的时空顺序，加宽过渡带使过渡更明显
        let transitionBand = mix(1.0, 0.2, uniform.uColorizeSharpness);
        let tMin = 0.5 - transitionBand * 0.5;
        let tMax = 0.5 + transitionBand * 0.5;
        let t = smoothstep(tMin, tMax, g_colorizeProgress);
        sketchProgress = 1.0 - t;
        // 轻微缓动，让半素描半彩色的过渡区更可见
        sketchProgress = pow(sketchProgress, 0.9);
    } else {
        // 完成阶段：完全彩色
        sketchProgress = 0.0;
    }
    
    sketchProgress = clamp(sketchProgress, 0.0, 1.0);
    
    // === 素描 NPR：明暗正确 + 排线 + 颗粒 ===
    let luminance = dot(originalColor.rgb, vec3f(0.299, 0.587, 0.114));
    var effectiveContrast = mix(uniform.uSketchContrast, 1.0, uniform.uDraftFeel * 0.5);
    var brightness = pow(luminance, effectiveContrast);
    let darkness = 1.0 - brightness;
    
    let worldPos = vec2f(center.x, center.z);
    let radialDir = normalize(vec2f((center - uniform.uCenter).x, (center - uniform.uCenter).z));
    let lineDir = vec2f(-radialDir.y, radialDir.x);
    let draft = 1.0 + 0.7 * uniform.uDraftFeel;
    let angleOff = 0.2 * draft * sin(center.x * 0.37 + center.z * 0.21) * cos(center.z * 0.31 + center.y * 0.1);
    let lineDirR = rot2D(angleOff) * lineDir;
    let wobble = 0.25 * draft * sin(center.x * 0.41 + center.z * 0.29) * cos(center.z * 0.33 + 1.0);
    let phaseJitter = (valueNoise(center * 0.7 + 1.0) - 0.5) * (1.2 + 0.8 * uniform.uDraftFeel);
    let lineCoord = (dot(worldPos, lineDirR) + wobble + phaseJitter) * uniform.uHatchDensity;
    let linePattern = smoothstep(0.68, 0.96, abs(sin(lineCoord * 3.14159)));
    let lineDir2 = rot2D(0.73 + angleOff * 0.5) * lineDir;
    let wobble2 = 0.22 * draft * sin(center.x * 0.43 + center.z * 0.19) * cos(center.z * 0.27 + 0.5);
    let phaseJitter2 = (valueNoise(center * 0.6 + 3.0) - 0.5) * (1.0 + 0.6 * uniform.uDraftFeel);
    let lineCoord2 = (dot(worldPos, lineDir2) + wobble2 + phaseJitter2) * uniform.uHatchDensity * 0.82;
    let linePattern2 = smoothstep(0.68, 0.96, abs(sin(lineCoord2 * 3.14159)));
    let lineDir3 = rot2D(1.43 + angleOff * 0.3) * lineDir;
    let wobble3 = 0.2 * draft * sin(center.x * 0.39 + center.z * 0.23) * cos(center.z * 0.35 + 1.3);
    let phaseJitter3 = (valueNoise(center * 0.65 + 5.0) - 0.5) * (0.9 + 0.5 * uniform.uDraftFeel);
    let lineCoord3 = (dot(worldPos, lineDir3) + wobble3 + phaseJitter3) * uniform.uHatchDensity * 0.63;
    let linePattern3 = smoothstep(0.7, 0.96, abs(sin(lineCoord3 * 3.14159)));
    let hatchInDark = uniform.uHatchStrength * (1.0 - smoothstep(0.42, 0.72, darkness));
    brightness -= (linePattern + linePattern2 * 0.55 + linePattern3 * 0.35) * darkness * hatchInDark;
    
    let levels = max(2.0, uniform.uShadeLevels);
    let preQuant = brightness;
    let quantized = (floor(brightness * levels) + 0.5) / levels;
    let quantBlend = mix(0.06, 0.18, 1.0 - uniform.uDraftFeel);
    brightness = mix(quantized, preQuant, quantBlend);
    
    let grain = (valueNoise(center * uniform.uGrainFreq) - 0.5) * uniform.uGrainAmp;
    let paperFiber = (fbmValueNoise(center * uniform.uGrainFreq * 0.4 + 2.0) - 0.5) * uniform.uGrainAmp * 0.8;
    let roughGrit = (valueNoise(center * uniform.uGrainFreq * 2.5 + 5.0) - 0.5) * uniform.uGrainAmp * 0.5;
    let darkMask = 1.0 - 0.55 * smoothstep(0.5, 0.92, darkness);
    brightness += (grain + paperFiber + roughGrit) * 1.5 * darkMask;
    
    brightness = mix(brightness, 0.5, uniform.uDraftFeel * mix(0.06, 0.12, 1.0 - uniform.uDraftFeel));
    
    var sketchValue = clamp(brightness, 0.03, 1.0);
    
    let pureGray = vec3f(sketchValue);
    let tinted = pureGray * uniform.uPaperTint;
    let sketchColor = mix(pureGray, tinted, uniform.uPaperTintAmount);
    let colorizedColor = originalColor.rgb;
    
    var mixFactor = sketchProgress * uniform.uSketchIntensity;
    
    if (g_phase == 2.0 && uniform.uColorizeDensity > 0.0) {
        let densityPeak = smoothstep(0.2, 0.5, g_colorizeProgress) * smoothstep(0.8, 0.5, g_colorizeProgress);
        mixFactor *= (1.0 - uniform.uColorizeDensity * densityPeak);
    }
    
    let finalColor = mix(colorizedColor, sketchColor, mixFactor);
    
    var alphaGrain: f32 = 1.0;
    if (g_phase == 2.0 && uniform.uColorizeAlphaGrain > 0.0) {
        alphaGrain = 0.9 + 0.1 * valueNoise(center * uniform.uGrainFreq * 2.0);
        alphaGrain = mix(1.0, alphaGrain, uniform.uColorizeAlphaGrain);
    }
    
    (*color).rgb = finalColor;
    (*color).a *= alphaMultiplier * alphaGrain;
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
 * sketchEffect.sketchDuration = 1.5;
 * sketchEffect.colorizeDuration = 5.0;
 */
class GsplatSketch extends GsplatShaderEffect {
    static scriptName = 'gsplatSketch';

    // 可重用数组用于 uniform 更新
    _centerArray = [0, 0, 0];
    _cameraPosArray = [0, 0, 0];

    /**
     * 效果的中心点
     * @attribute
     */
    center = new Vec3(0, 0, 0);

    /**
     * 上色时使用相机距离（而不是中心距离）
     * 启用后，上色会从相机视角由近至远扩散
     * @attribute
     */
    useCameraDistance = false;

    /**
     * 相机位置（在上色开始时记录）
     * 仅当 useCameraDistance = true 时使用
     * @attribute
     */
    cameraPos = new Vec3(0, 0, 0);

    /**
     * 是否已记录相机位置
     * @private
     */
    _cameraPosCaptured = false;

    initialize() {
        super.initialize();
        // 每次启用效果时重置相机捕获，restart 或时间轴回拉后上色阶段会使用当前相机位姿
        this.on('enable', () => {
            this._cameraPosCaptured = false;
        });
    }

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
    sketchDuration = 1.5;

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
     * 草稿感（0-1）：线条松度、抖动、块面感、柔和度，统一控制
     * @attribute
     * @range [0, 1]
     */
    draftFeel = 1.0;

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
     * 纸张色调强度（0-1）：整体偏暖，不改变明暗
     * @attribute
     * @range [0, 1]
     */
    paperTintAmount = 0.8;

    /**
     * 纸张色调 [r,g,b]，如 [0.97, 0.95, 0.90] 米色
     * @attribute
     */
    paperTint = [0.97, 0.95, 0.90];

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
    grainAmp = 0.06;

    /**
     * 上色过渡边缘锐度（0-1），越小过渡带越宽、过渡越明显
     * @attribute
     * @range [0, 1]
     */
    colorizeSharpness = 0.35;

    /**
     * 上色高斯扩散（0-0.2）：过渡区高斯拉长，模拟笔触涂抹
     * @attribute
     * @range [0, 0.2]
     */
    colorizeSpread = 0.2;

    /**
     * 上色密度（0-0.5）：过渡区中心颜色更实，边缘渐浅
     * @attribute
     * @range [0, 0.5]
     */
    colorizeDensity = 0.5;

    /**
     * 上色 Alpha 颗粒（0-1）：纸张/彩铅质感
     * @attribute
     * @range [0, 1]
     */
    colorizeAlphaGrain = 1.0;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // 效果开始的首帧立即记录相机位置，保证 Restart / 导出 VFX 时从当前视角中心开始上色
        if (this.useCameraDistance && !this._cameraPosCaptured) {
            const cameraEntity = this.camera || this.app?.root?.findByName('Camera');
            if (cameraEntity) {
                this.cameraPos.copy(cameraEntity.getPosition());
                this._cameraPosCaptured = true;
                console.log('Captured camera position for colorize:', this.cameraPos);
            }
        }

        // 更新 uniforms
        this.setUniform('uTime', effectTime);

        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        this._cameraPosArray[0] = this.cameraPos.x;
        this._cameraPosArray[1] = this.cameraPos.y;
        this._cameraPosArray[2] = this.cameraPos.z;
        this.setUniform('uCameraPos', this._cameraPosArray);
        this.setUniform('uUseCameraDistance', this.useCameraDistance ? 1.0 : 0.0);

        this.setUniform('uWaveSpeed', this.waveSpeed);
        this.setUniform('uSketchDuration', this.sketchDuration);
        this.setUniform('uColorizeDuration', this.colorizeDuration);
        this.setUniform('uFadeWidthRatio', this.fadeWidthRatio);
        this.setUniform('uEndRadius', this.endRadius);

        // 素描效果相关 uniforms
        this.setUniform('uSketchIntensity', this.sketchIntensity);
        this.setUniform('uSketchContrast', this.sketchContrast);
        this.setUniform('uDraftFeel', this.draftFeel);
        this.setUniform('uShadeLevels', this.shadeLevels);
        this.setUniform('uHatchDensity', this.hatchDensity);
        this.setUniform('uHatchStrength', this.hatchStrength);
        this.setUniform('uPaperTintAmount', this.paperTintAmount);
        this.setUniform('uPaperTint', this.paperTint);
        this.setUniform('uColorizeSpread', this.colorizeSpread);
        this.setUniform('uColorizeDensity', this.colorizeDensity);
        this.setUniform('uColorizeAlphaGrain', this.colorizeAlphaGrain);
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
     * 设置特效时间（重写以在“回到上色开始前”时重置相机捕获，restart/时间轴回拉时使用当前相机位姿）
     */
    setEffectTime(time: number) {
        super.setEffectTime(time);
        // 时间回到上色开始之前时，下次进入上色阶段需重新捕获当前相机位姿
        if (time < this.sketchDuration) {
            this._cameraPosCaptured = false;
        }
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
