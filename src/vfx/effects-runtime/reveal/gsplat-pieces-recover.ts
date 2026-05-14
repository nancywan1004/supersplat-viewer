import { Vec3, Color } from 'playcanvas';
import { GsplatShaderEffect } from '../gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform vec3 uCenter;
uniform float uScatterDistance;
uniform float uScatterDuration;
uniform float uHoldDuration;
uniform float uRecoverDuration;
uniform float uNoiseIntensity;
uniform float uSpringStiffness;
uniform vec3 uScatterDirection;
uniform float uEndRadius;
uniform float uMaxScatterRadius;
uniform float uWaveSpeed;
uniform float uWaveSpeedDistScale;   // 随距离增大波速的系数，>0 时远处点更早进入散射，缩短整体 Phase 0
uniform float uPointSize;   // 散射阶段点云模式固定点大小（与 gsplat-growth-wave 聚拢生长一致）
uniform float uScatterIntensity;   // 统一控制点云扩散程度的系数（0~1），值越大扩散越明显
uniform float uTangentTwist;   // 统一控制切线扭曲程度的系数（0~1），值越大扭曲越明显
uniform float uRadialExpand;   // 统一控制径向外扩程度的系数（0~1），值越大沿法线方向外扩越明显
uniform float uSmokeDrift;     // 烟雾感：切平面内随时间轻柔漂移的强度（0~1）

// Hash function for per-splat randomization
float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// Generate random direction from hash
vec3 randomDir(vec3 p) {
    float h1 = hash(p);
    float h2 = hash(p + vec3(1.0, 0.0, 0.0));
    float h3 = hash(p + vec3(0.0, 1.0, 0.0));
    
    // Generate random point on unit sphere
    float theta = h1 * 6.28318; // 0 to 2π
    float phi = acos(2.0 * h2 - 1.0); // 0 to π
    float r = pow(h3, 1.0/3.0); // Better distribution in 3D
    
    return vec3(
        sin(phi) * cos(theta),
        sin(phi) * sin(theta),
        cos(phi)
    );
}

// Shared globals
float g_dist;   // 当前 splat 到效果中心 uCenter 的 3D 欧氏距离（单位与场景一致）
float g_tScatter;
float g_tRecover;
float g_phase;

void initShared(vec3 center) {
    g_dist = length(center - uCenter);
    
    // Wave propagation: points start scattering based on distance from center
    // effectiveWaveSpeed 可随 g_dist 增大（uWaveSpeedDistScale > 0），远处点更早进入散射，缩短整体 Phase 0
    float effectiveWaveSpeed = uWaveSpeed * max(1.0, 1.0 + uWaveSpeedDistScale * g_dist);
    g_tScatter = g_dist / effectiveWaveSpeed;
    
    // NO HOLDING PHASE - direct transition from scatter to recover
    g_tRecover = g_tScatter + uScatterDuration;
    g_phase = 0.0;
    
    // Determine current phase
    if (uTime < g_tScatter) {
        g_phase = 0.0; // Before scatter
    } else if (uTime < g_tRecover) {
        g_phase = 1.0; // Scattering (ENABLED)
    } else if (uTime < g_tRecover + uRecoverDuration) {
        g_phase = 2.0; // Recovering
    } else {
        g_phase = 3.0; // Complete
    }
}

void modifySplatCenter(inout vec3 center) {
    vec3 originalCenter = center;
    
    initShared(center);
    
    // Phase 0.0: Before scatter - add subtle floating effect
    if (g_phase == 0.0) {
        // Generate per-splat random values for floating
        float randomSeed = hash(originalCenter);
        float randomSeed2 = hash(originalCenter + vec3(10.0, 20.0, 30.0));
        float randomSeed3 = hash(originalCenter + vec3(50.0, 100.0, 150.0));
        
        // Create random direction for floating
        vec3 floatDir = randomDir(originalCenter);
        
        // Use time-based sine wave for gentle floating motion
        float floatSpeed = 0.5 + randomSeed * 0.5; // 0.5 to 1.0 (variation per splat)
        float floatAmplitude = 0.05 + randomSeed2 * 0.05; // 0.05 to 0.1 (small movement)
        float floatPhase = randomSeed3 * 6.28318; // 0 to 2π (random phase offset)
        
        // Gentle floating motion using sine wave
        float floatAmount = sin(uTime * floatSpeed + floatPhase) * floatAmplitude;
        
        // Apply floating offset
        center = originalCenter + floatDir * floatAmount;
        return;
    }
    
    // Phase 3.0: Complete - keep original position (no modification)
    if (g_phase >= 3.0) {
        return;
    }
    
    // Generate per-splat random values for stream-based dust effect
    float randomSeed = hash(originalCenter);
    float randomSeed2 = hash(originalCenter + vec3(10.0, 20.0, 30.0));
    float randomSeed3 = hash(originalCenter + vec3(50.0, 100.0, 150.0));
    
    // Contour-following: radial from effect center（用于切平面）
    vec3 toSplat = originalCenter - uCenter;
    float distFromCenter = length(toSplat);
    vec3 radialDir = distFromCenter > 0.001 ? normalize(toSplat) : vec3(0.0, 1.0, 0.0);
    vec3 tangent1 = cross(radialDir, vec3(0.0, 1.0, 0.0));
    if (length(tangent1) < 0.01) tangent1 = cross(radialDir, vec3(1.0, 0.0, 0.0));
    tangent1 = normalize(tangent1);
    vec3 tangent2 = normalize(cross(radialDir, tangent1));
    float noiseScale1 = 1.2;
    float noiseScale2 = 3.5;
    float noiseScale3 = 12.0;
    vec3 noisePos1 = (originalCenter - uCenter) * noiseScale1;
    vec3 noisePos2 = (originalCenter - uCenter) * noiseScale2;
    vec3 noisePos3 = (originalCenter - uCenter) * noiseScale3;
    vec3 i1 = floor(noisePos1);
    vec3 f1 = fract(noisePos1);
    f1 = f1 * f1 * (3.0 - 2.0 * f1);
    float h000 = hash(i1);
    float h100 = hash(i1 + vec3(1.0, 0.0, 0.0));
    float h010 = hash(i1 + vec3(0.0, 1.0, 0.0));
    float h110 = hash(i1 + vec3(1.0, 1.0, 0.0));
    float h001 = hash(i1 + vec3(0.0, 0.0, 1.0));
    float h101 = hash(i1 + vec3(1.0, 0.0, 1.0));
    float h011 = hash(i1 + vec3(0.0, 1.0, 1.0));
    float h111 = hash(i1 + vec3(1.0, 1.0, 1.0));
    float angleHash = mix(
        mix(mix(h000, h100, f1.x), mix(h010, h110, f1.x), f1.y),
        mix(mix(h001, h101, f1.x), mix(h011, h111, f1.x), f1.y),
        f1.z
    );
    vec3 frac2 = fract(noisePos2);
    vec3 frac3 = fract(noisePos3);
    float smooth2 = smoothstep(0.0, 1.0, frac2.x) * smoothstep(0.0, 1.0, frac2.y) * smoothstep(0.0, 1.0, frac2.z);
    float smooth3 = smoothstep(0.0, 1.0, frac3.x) * smoothstep(0.0, 1.0, frac3.y) * smoothstep(0.0, 1.0, frac3.z);
    // 折中：以位置角度为主保留轮廓，只加小幅每点抖动(±0.35 rad)打破“齐刷刷”，不整点随机避免乱飞
    float angle = (angleHash * 6.28318 + (randomSeed - 0.5) * 0.7 + hash(floor(noisePos2)) * smooth2 * 1.2 + hash(floor(noisePos3)) * smooth3 * 0.6) * uTangentTwist;
    vec3 tangentDir = cos(angle) * tangent1 + sin(angle) * tangent2;
    vec3 perParticleDir = randomDir(originalCenter);
    // 大幅减少随机扰动（从0.06~0.14降至0.02~0.04），让点云更贴合原轮廓
    vec3 perParticleVariation = (tangent1 * (perParticleDir.x * 0.3) + tangent2 * (perParticleDir.y * 0.3)) * (0.02 + randomSeed * 0.02);
    // 使用 uRadialExpand 控制径向外扩：基础值 0.3（增大10倍以获得明显效果），由 uRadialExpand 缩放（0~1）
    vec3 scatterDir = normalize(tangentDir + radialDir * (0.3 * uRadialExpand) + perParticleVariation);
    
    float streamDist1 = mix(
        mix(mix(h000, h100, f1.x), mix(h010, h110, f1.x), f1.y),
        mix(mix(h001, h101, f1.x), mix(h011, h111, f1.x), f1.y),
        f1.z
    );
    float streamDist2 = hash(floor(noisePos2));
    // 使用 uScatterIntensity 统一控制扩散程度：基础值 + 噪声变化
    float streamScatterBase = 0.08 + streamDist1 * 0.12 + streamDist2 * smooth2 * 0.05;
    float perParticleVariationDist = 0.8 + randomSeed * 0.4;
    // scatterFactor 由 uScatterIntensity 缩放：0.06~0.25 的范围乘以 uScatterIntensity
    float scatterFactor = clamp(streamScatterBase * perParticleVariationDist * uScatterIntensity, 0.06 * uScatterIntensity, 0.25 * uScatterIntensity);
    
    
    if (g_phase == 1.0) {
        // 散射阶段：进度 0~1，不再乘 speed variation，确保位移严格受 uMaxScatterRadius 限制
        float t = (uTime - g_tScatter) / uScatterDuration;
        t = clamp(t, 0.0, 1.0);
        float easedT = t * t * (3.0 - 2.0 * t); // smoothstep，严格 [0,1]
        easedT = clamp(easedT, 0.0, 1.0);
        
        // 位移量：easedT * scatterFactor 恒 <= 1，故 scatterAmount <= uMaxScatterRadius
        float scatterAmount = easedT * uMaxScatterRadius * scatterFactor;
        scatterAmount = min(scatterAmount, uMaxScatterRadius);
        
        vec3 totalOffset = scatterDir * scatterAmount;
        // 硬性限制：总位移长度绝不超出 uMaxScatterRadius（防止 normalize 或精度问题）
        float totalLen = length(totalOffset);
        float maxLen = max(uMaxScatterRadius, 0.0001); // 避免除零
        if (totalLen > maxLen) {
            totalOffset = totalOffset * (maxLen / totalLen);
        }
        // 烟雾感：切平面内低频漂移，每点相位不同
        float smokeT1 = uTime * 0.45 + randomSeed * 6.28318;
        float smokeT2 = uTime * 0.6 + randomSeed2 * 6.28318;
        vec3 smokeDrift = (tangent1 * sin(smokeT1) + tangent2 * cos(smokeT2)) * 0.04 * uSmokeDrift;
        center = originalCenter + totalOffset + smokeDrift;
    } else if (g_phase == 2.0) {
        // Phase 2.0: Recovering phase: CLEAN and DIRECT return to original position
        float t = (uTime - g_tRecover) / uRecoverDuration; // 0 to 1
        t = clamp(t, 0.0, 1.0); // Ensure t is in valid range to prevent flickering
        
        // Slower, more graceful ease-out for natural deceleration
        // Use ease-out quartic for very smooth, gradual slowdown
        float easedT = 1.0 - pow(1.0 - t, 4.0);
        easedT = clamp(easedT, 0.0, 1.0); // Ensure easedT is in valid range
        
        // CRITICAL FIX: Reconstruct scatter phase end position using the ACTUAL last frame time
        // Use min(uTime, g_tRecover) to ensure we use the exact same time point as scatter phase last frame
        // This ensures perfect continuity - if scatter phase last frame had uTime = 6.999, we use 6.999, not 7.0
        float scatterEndTime = min(uTime, g_tRecover);
        float scatterEndT = (scatterEndTime - g_tScatter) / uScatterDuration;
        scatterEndT = clamp(scatterEndT, 0.0, 1.0);
        // 与 scatter 一致：smoothstep 缓动
        float baseEasedT = scatterEndT * scatterEndT * (3.0 - 2.0 * scatterEndT);
        baseEasedT = clamp(baseEasedT, 0.0, 1.0);
        
        // Reconstruct contour-based scatter direction（与 scatter 阶段一致：切线为主 + 径向 + 微扰）
        vec3 toSplatRec = originalCenter - uCenter;
        float distFromCenterRec = length(toSplatRec);
        vec3 radialDirRec = distFromCenterRec > 0.001 ? normalize(toSplatRec) : vec3(0.0, 1.0, 0.0);
        vec3 tangent1Rec = cross(radialDirRec, vec3(0.0, 1.0, 0.0));
        if (length(tangent1Rec) < 0.01) tangent1Rec = cross(radialDirRec, vec3(1.0, 0.0, 0.0));
        tangent1Rec = normalize(tangent1Rec);
        vec3 tangent2Rec = normalize(cross(radialDirRec, tangent1Rec));
        float noiseScale1R = 1.2;
        float noiseScale2R = 3.5;
        float noiseScale3R = 12.0;
        vec3 noisePos1R = (originalCenter - uCenter) * noiseScale1R;
        vec3 noisePos2R = (originalCenter - uCenter) * noiseScale2R;
        vec3 noisePos3R = (originalCenter - uCenter) * noiseScale3R;
        vec3 i1R = floor(noisePos1R);
        vec3 f1R = fract(noisePos1R);
        f1R = f1R * f1R * (3.0 - 2.0 * f1R);
        float h000R = hash(i1R);
        float h100R = hash(i1R + vec3(1.0, 0.0, 0.0));
        float h010R = hash(i1R + vec3(0.0, 1.0, 0.0));
        float h110R = hash(i1R + vec3(1.0, 1.0, 0.0));
        float h001R = hash(i1R + vec3(0.0, 0.0, 1.0));
        float h101R = hash(i1R + vec3(1.0, 0.0, 1.0));
        float h011R = hash(i1R + vec3(0.0, 1.0, 1.0));
        float h111R = hash(i1R + vec3(1.0, 1.0, 1.0));
        float angleHashRec = mix(
            mix(mix(h000R, h100R, f1R.x), mix(h010R, h110R, f1R.x), f1R.y),
            mix(mix(h001R, h101R, f1R.x), mix(h011R, h111R, f1R.x), f1R.y),
            f1R.z
        );
        vec3 frac2R = fract(noisePos2R);
        vec3 frac3R = fract(noisePos3R);
        float smooth2R = smoothstep(0.0, 1.0, frac2R.x) * smoothstep(0.0, 1.0, frac2R.y) * smoothstep(0.0, 1.0, frac2R.z);
        float smooth3R = smoothstep(0.0, 1.0, frac3R.x) * smoothstep(0.0, 1.0, frac3R.y) * smoothstep(0.0, 1.0, frac3R.z);
        // 与散射阶段一致：位置为主 + 小幅每点抖动
        float angleRec = (angleHashRec * 6.28318 + (randomSeed - 0.5) * 0.7 + hash(floor(noisePos2R)) * smooth2R * 1.2 + hash(floor(noisePos3R)) * smooth3R * 0.6) * uTangentTwist;
        vec3 tangentDirRec = cos(angleRec) * tangent1Rec + sin(angleRec) * tangent2Rec;
        vec3 perParticleDirRec = randomDir(originalCenter);
        // 与散射阶段保持一致：大幅减少随机扰动
        vec3 perParticleVariationRec = (tangent1Rec * (perParticleDirRec.x * 0.3) + tangent2Rec * (perParticleDirRec.y * 0.3)) * (0.02 + randomSeed * 0.02);
        // 与散射阶段保持一致：使用 uRadialExpand 控制径向外扩（基础值 0.3）
        vec3 scatterDir = normalize(tangentDirRec + radialDirRec * (0.3 * uRadialExpand) + perParticleVariationRec);
        
        float finalEasedT = baseEasedT;
        
        // 与 scatter 一致：由 uMaxScatterRadius 限制
        float scatterAmount = finalEasedT * uMaxScatterRadius * scatterFactor;
        scatterAmount = min(scatterAmount, uMaxScatterRadius);
        
        vec3 totalOffsetRec = scatterDir * scatterAmount;
        float totalLenRec = length(totalOffsetRec);
        float maxLenRec = max(uMaxScatterRadius, 0.0001);
        if (totalLenRec > maxLenRec) {
            totalOffsetRec = totalOffsetRec * (maxLenRec / totalLenRec);
        }
        // 与散射阶段一致的烟雾漂移（用 scatterEndTime 保证衔接）
        float smokeT1R = scatterEndTime * 0.45 + randomSeed * 6.28318;
        float smokeT2R = scatterEndTime * 0.6 + randomSeed2 * 6.28318;
        vec3 smokeDriftRec = (tangent1Rec * sin(smokeT1R) + tangent2Rec * cos(smokeT2R)) * 0.04 * uSmokeDrift;
        vec3 scatterPos = originalCenter + totalOffsetRec + smokeDriftRec;
        
        center = mix(scatterPos, originalCenter, easedT);
    }
    // Phase 0: before scatter - no modification
    // Phase 3: complete - no modification (already at original)
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    initShared(originalCenter);
    
    vec3 originalScale = scale;
    
    if (g_phase == 0.0) {
        gsplatMakeSpherical(scale, uPointSize);
        return;
    }
    if (g_phase == 1.0) {
        gsplatMakeSpherical(scale, uPointSize);
        return;
    }
    if (g_phase == 2.0) {
        float t = (uTime - g_tRecover) / uRecoverDuration;
        t = clamp(t, 0.0, 1.0);
        float easedT = clamp(1.0 - pow(1.0 - t, 4.0), 0.0, 1.0);
        // 直接对 scale 向量插值：从点大小过渡回原始各向异性，避免整段用球形导致的模糊感
        vec3 pointScale = vec3(uPointSize);
        scale = mix(pointScale, originalScale, easedT);
        return;
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {
    initShared(center);
    if (g_phase != 1.0) return;
    // 白金色辉光，一闪一闪，强度较弱（参照 growth-wave 金环 sparkle，减弱）
    vec3 toSplat = center - uCenter;
    float distFromCenter = length(toSplat);
    float normalizedDist = distFromCenter / max(uEndRadius, 1.0);
    float distanceFade = 1.0 - smoothstep(0.0, 0.9, normalizedDist);
    float h1 = hash(center);
    float h2 = hash(center + vec3(10.0, 20.0, 30.0));
    float h3 = hash(center + vec3(50.0, 100.0, 150.0));
    float t1 = uTime * 8.0 + h1 * 6.28318;
    float t2 = uTime * 13.0 + h2 * 6.28318;
    float t3 = uTime * 18.0 + h3 * 6.28318;
    float sparkle = 0.5 + 0.25 * sin(t1) + 0.2 * sin(t2) + 0.15 * sin(t3);
    sparkle = clamp(sparkle, 0.4, 1.0);
    vec3 goldWhite = vec3(0.98, 0.95, 0.88);
    color.rgb += goldWhite * sparkle * distanceFade * 0.18;
    color.rgb *= (1.0 + sparkle * distanceFade * 0.08);
    // 一点点蓝色辉光（散射阶段）
    vec3 blueGlow = vec3(0.5, 0.7, 1.0);
    color.rgb += blueGlow * distanceFade * 0.25;
    color.rgb = clamp(color.rgb, 0.0, 2.0);
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uScatterDistance: f32;
uniform uScatterDuration: f32;
uniform uHoldDuration: f32;
uniform uRecoverDuration: f32;
uniform uNoiseIntensity: f32;
uniform uSpringStiffness: f32;
uniform uScatterDirection: vec3f;
uniform uEndRadius: f32;
uniform uMaxScatterRadius: f32;
uniform uWaveSpeed: f32;
uniform uWaveSpeedDistScale: f32;   // 随距离增大波速的系数，>0 时远处点更早进入散射，缩短整体 Phase 0
uniform uPointSize: f32;   // 散射阶段点云模式固定点大小（与 gsplat-growth-wave 聚拢生长一致）
uniform uScatterIntensity: f32;   // 统一控制点云扩散程度的系数（0~1），值越大扩散越明显
uniform uTangentTwist: f32;   // 统一控制切线扭曲程度的系数（0~1），值越大扭曲越明显
uniform uRadialExpand: f32;   // 统一控制径向外扩程度的系数（0~1），值越大沿法线方向外扩越明显
uniform uSmokeDrift: f32;     // 烟雾感：切平面内随时间轻柔漂移的强度（0~1）

// Hash function for per-splat randomization
fn hash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

// Generate random direction from hash
fn randomDir(p: vec3f) -> vec3f {
    let h1 = hash(p);
    let h2 = hash(p + vec3f(1.0, 0.0, 0.0));
    let h3 = hash(p + vec3f(0.0, 1.0, 0.0));
    
    // Generate random point on unit sphere
    let theta = h1 * 6.28318; // 0 to 2π
    let phi = acos(2.0 * h2 - 1.0); // 0 to π
    let r = pow(h3, 1.0/3.0); // Better distribution in 3D
    
    return vec3f(
        sin(phi) * cos(theta),
        sin(phi) * sin(theta),
        cos(phi)
    );
}

// Shared globals
var<private> g_dist: f32;   // 当前 splat 到效果中心 uCenter 的 3D 欧氏距离（单位与场景一致）
var<private> g_tScatter: f32;
var<private> g_tRecover: f32;
var<private> g_phase: f32;

fn initShared(center: vec3f) {
    g_dist = length(center - uniform.uCenter);
    
    // Wave propagation: effectiveWaveSpeed 可随 g_dist 增大，远处点更早进入散射，缩短整体 Phase 0
    let effectiveWaveSpeed = uniform.uWaveSpeed * max(1.0, 1.0 + uniform.uWaveSpeedDistScale * g_dist);
    g_tScatter = g_dist / effectiveWaveSpeed;
    
    // NO HOLDING PHASE - direct transition from scatter to recover
    g_tRecover = g_tScatter + uniform.uScatterDuration;
    g_phase = 0.0;
    
    // Determine current phase
    if (uniform.uTime < g_tScatter) {
        g_phase = 0.0; // Before scatter
    } else if (uniform.uTime < g_tRecover) {
        g_phase = 1.0; // Scattering (ENABLED)
    } else if (uniform.uTime < g_tRecover + uniform.uRecoverDuration) {
        g_phase = 2.0; // Recovering
    } else {
        g_phase = 3.0; // Complete
    }
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let originalCenter = *center;
    
    initShared(*center);
    
    // Phase 0.0: Before scatter - add subtle floating effect
    if (g_phase == 0.0) {
        // Generate per-splat random values for floating
        let randomSeed = hash(originalCenter);
        let randomSeed2 = hash(originalCenter + vec3f(10.0, 20.0, 30.0));
        let randomSeed3 = hash(originalCenter + vec3f(50.0, 100.0, 150.0));
        
        // Create random direction for floating
        let floatDir = randomDir(originalCenter);
        
        // Use time-based sine wave for gentle floating motion
        let floatSpeed = 0.5 + randomSeed * 0.5; // 0.5 to 1.0 (variation per splat)
        let floatAmplitude = 0.05 + randomSeed2 * 0.05; // 0.05 to 0.1 (small movement)
        let floatPhase = randomSeed3 * 6.28318; // 0 to 2π (random phase offset)
        
        // Gentle floating motion using sine wave
        let floatAmount = sin(uniform.uTime * floatSpeed + floatPhase) * floatAmplitude;
        
        // Apply floating offset
        *center = originalCenter + floatDir * floatAmount;
        return;
    }
    
    // Phase 3.0: Complete - keep original position (no modification)
    if (g_phase >= 3.0) {
        return;
    }
    
    // Generate per-splat random values for stream-based dust effect
    let randomSeed = hash(originalCenter);
    let randomSeed2 = hash(originalCenter + vec3f(10.0, 20.0, 30.0));
    let randomSeed3 = hash(originalCenter + vec3f(50.0, 100.0, 150.0));
    
    // Contour-following: radial from effect center（用于切平面），贴合原轮廓
    let toSplat = originalCenter - uniform.uCenter;
    let distFromCenter = length(toSplat);
    var radialDir = select(vec3f(0.0, 1.0, 0.0), normalize(toSplat), distFromCenter > 0.001);
    var tangent1 = cross(radialDir, vec3f(0.0, 1.0, 0.0));
    if (length(tangent1) < 0.01) { tangent1 = cross(radialDir, vec3f(1.0, 0.0, 0.0)); }
    tangent1 = normalize(tangent1);
    let tangent2 = normalize(cross(radialDir, tangent1));
    let noiseScale1 = 1.2;
    let noiseScale2 = 3.5;
    let noiseScale3 = 12.0;
    let noisePos1 = (originalCenter - uniform.uCenter) * noiseScale1;
    let noisePos2 = (originalCenter - uniform.uCenter) * noiseScale2;
    let noisePos3 = (originalCenter - uniform.uCenter) * noiseScale3;
    let i1 = floor(noisePos1);
    var f1 = fract(noisePos1);
    f1 = f1 * f1 * (3.0 - 2.0 * f1);
    let h000 = hash(i1);
    let h100 = hash(i1 + vec3f(1.0, 0.0, 0.0));
    let h010 = hash(i1 + vec3f(0.0, 1.0, 0.0));
    let h110 = hash(i1 + vec3f(1.0, 1.0, 0.0));
    let h001 = hash(i1 + vec3f(0.0, 0.0, 1.0));
    let h101 = hash(i1 + vec3f(1.0, 0.0, 1.0));
    let h011 = hash(i1 + vec3f(0.0, 1.0, 1.0));
    let h111 = hash(i1 + vec3f(1.0, 1.0, 1.0));
    let angleHash = mix(
        mix(mix(h000, h100, f1.x), mix(h010, h110, f1.x), f1.y),
        mix(mix(h001, h101, f1.x), mix(h011, h111, f1.x), f1.y),
        f1.z
    );
    let frac2 = fract(noisePos2);
    let frac3 = fract(noisePos3);
    let smooth2 = smoothstep(0.0, 1.0, frac2.x) * smoothstep(0.0, 1.0, frac2.y) * smoothstep(0.0, 1.0, frac2.z);
    let smooth3 = smoothstep(0.0, 1.0, frac3.x) * smoothstep(0.0, 1.0, frac3.y) * smoothstep(0.0, 1.0, frac3.z);
    // 折中：位置角度为主保留轮廓，小幅每点抖动(±0.35 rad)打破齐刷刷
    let angle = (angleHash * 6.28318 + (randomSeed - 0.5) * 0.7 + hash(floor(noisePos2)) * smooth2 * 1.2 + hash(floor(noisePos3)) * smooth3 * 0.6) * uniform.uTangentTwist;
    let tangentDir = cos(angle) * tangent1 + sin(angle) * tangent2;
    let perParticleDir = randomDir(originalCenter);
    // 大幅减少随机扰动（从0.06~0.14降至0.02~0.04），让点云更贴合原轮廓
    let perParticleVariation = (tangent1 * (perParticleDir.x * 0.3) + tangent2 * (perParticleDir.y * 0.3)) * (0.02 + randomSeed * 0.02);
    // 使用 uRadialExpand 控制径向外扩：基础值 0.3（增大10倍以获得明显效果），由 uRadialExpand 缩放（0~1）
    var scatterDir = normalize(tangentDir + radialDir * (0.3 * uniform.uRadialExpand) + perParticleVariation);
    
    let streamDist1 = mix(
        mix(mix(h000, h100, f1.x), mix(h010, h110, f1.x), f1.y),
        mix(mix(h001, h101, f1.x), mix(h011, h111, f1.x), f1.y),
        f1.z
    );
    let streamDist2 = hash(floor(noisePos2));
    // 使用 uScatterIntensity 统一控制扩散程度：基础值 + 噪声变化
    let streamScatterBase = 0.08 + streamDist1 * 0.12 + streamDist2 * smooth2 * 0.05;
    let perParticleVariationDist = 0.8 + randomSeed * 0.4;
    // scatterFactor 由 uScatterIntensity 缩放：0.06~0.25 的范围乘以 uScatterIntensity
    var scatterFactor = clamp(streamScatterBase * perParticleVariationDist * uniform.uScatterIntensity, 0.06 * uniform.uScatterIntensity, 0.25 * uniform.uScatterIntensity);
    
    if (g_phase == 1.0) {
        // 散射阶段：进度 0~1，不再乘 speed variation，确保位移严格受 uMaxScatterRadius 限制（与 GLSL 一致）
        let t = clamp((uniform.uTime - g_tScatter) / uniform.uScatterDuration, 0.0, 1.0);
        var easedT = t * t * (3.0 - 2.0 * t); // smoothstep，严格 [0,1]
        easedT = clamp(easedT, 0.0, 1.0);
        
        // 位移量：easedT * scatterFactor 恒 <= 1，故 scatterAmount <= uMaxScatterRadius
        var scatterAmount = easedT * uniform.uMaxScatterRadius * scatterFactor;
        scatterAmount = min(scatterAmount, uniform.uMaxScatterRadius);
        
        var totalOffset = scatterDir * scatterAmount;
        let totalLen = length(totalOffset);
        let maxLen = max(uniform.uMaxScatterRadius, 0.0001);
        if (totalLen > maxLen) {
            totalOffset = totalOffset * (maxLen / totalLen);
        }
        // 烟雾感：切平面内低频漂移
        let smokeT1 = uniform.uTime * 0.45 + randomSeed * 6.28318;
        let smokeT2 = uniform.uTime * 0.6 + randomSeed2 * 6.28318;
        let smokeDrift = (tangent1 * sin(smokeT1) + tangent2 * cos(smokeT2)) * 0.04 * uniform.uSmokeDrift;
        *center = originalCenter + totalOffset + smokeDrift;
    } else if (g_phase == 2.0) {
        // Phase 2.0: Recovering phase: CLEAN and DIRECT return to original position
        let t = clamp((uniform.uTime - g_tRecover) / uniform.uRecoverDuration, 0.0, 1.0); // 0 to 1
        
        // Slower, more graceful ease-out for natural deceleration
        // Use ease-out quartic for very smooth, gradual slowdown
        let easedT = clamp(1.0 - pow(1.0 - t, 4.0), 0.0, 1.0);
        
        // CRITICAL FIX: Reconstruct scatter phase end position using the ACTUAL last frame time
        // Use min(uTime, g_tRecover) to ensure we use the exact same time point as scatter phase last frame
        // This ensures perfect continuity - if scatter phase last frame had uTime = 6.999, we use 6.999, not 7.0
        let scatterEndTime = min(uniform.uTime, g_tRecover);
        let scatterEndT = (scatterEndTime - g_tScatter) / uniform.uScatterDuration;
        scatterEndT = clamp(scatterEndT, 0.0, 1.0);
        
        // Calculate base easedT at scatter end using the exact same formula as scatter phase
        let baseEasedT = scatterEndT * scatterEndT * (3.0 - 2.0 * scatterEndT); // smoothstep，与 scatter 一致
        baseEasedT = clamp(baseEasedT, 0.0, 1.0);
        
        // Reconstruct contour-based scatter direction（与 scatter 阶段一致：切线为主 + 径向 + 微扰）
        let toSplatRec = originalCenter - uniform.uCenter;
        let distFromCenterRec = length(toSplatRec);
        var radialDirRec = select(vec3f(0.0, 1.0, 0.0), normalize(toSplatRec), distFromCenterRec > 0.001);
        var tangent1Rec = cross(radialDirRec, vec3f(0.0, 1.0, 0.0));
        if (length(tangent1Rec) < 0.01) { tangent1Rec = cross(radialDirRec, vec3f(1.0, 0.0, 0.0)); }
        tangent1Rec = normalize(tangent1Rec);
        let tangent2Rec = normalize(cross(radialDirRec, tangent1Rec));
        let noiseScale1R = 1.2;
        let noiseScale2R = 3.5;
        let noiseScale3R = 12.0;
        let noisePos1R = (originalCenter - uniform.uCenter) * noiseScale1R;
        let noisePos2R = (originalCenter - uniform.uCenter) * noiseScale2R;
        let noisePos3R = (originalCenter - uniform.uCenter) * noiseScale3R;
        let i1R = floor(noisePos1R);
        var f1R = fract(noisePos1R);
        f1R = f1R * f1R * (3.0 - 2.0 * f1R);
        let h000R = hash(i1R);
        let h100R = hash(i1R + vec3f(1.0, 0.0, 0.0));
        let h010R = hash(i1R + vec3f(0.0, 1.0, 0.0));
        let h110R = hash(i1R + vec3f(1.0, 1.0, 0.0));
        let h001R = hash(i1R + vec3f(0.0, 0.0, 1.0));
        let h101R = hash(i1R + vec3f(1.0, 0.0, 1.0));
        let h011R = hash(i1R + vec3f(0.0, 1.0, 1.0));
        let h111R = hash(i1R + vec3f(1.0, 1.0, 1.0));
        let angleHashRec = mix(
            mix(mix(h000R, h100R, f1R.x), mix(h010R, h110R, f1R.x), f1R.y),
            mix(mix(h001R, h101R, f1R.x), mix(h011R, h111R, f1R.x), f1R.y),
            f1R.z
        );
        let frac2R = fract(noisePos2R);
        let frac3R = fract(noisePos3R);
        let smooth2R = smoothstep(0.0, 1.0, frac2R.x) * smoothstep(0.0, 1.0, frac2R.y) * smoothstep(0.0, 1.0, frac2R.z);
        let smooth3R = smoothstep(0.0, 1.0, frac3R.x) * smoothstep(0.0, 1.0, frac3R.y) * smoothstep(0.0, 1.0, frac3R.z);
        // 与散射阶段一致：位置为主 + 小幅每点抖动
        let angleRec = (angleHashRec * 6.28318 + (randomSeed - 0.5) * 0.7 + hash(floor(noisePos2R)) * smooth2R * 1.2 + hash(floor(noisePos3R)) * smooth3R * 0.6) * uniform.uTangentTwist;
        let tangentDirRec = cos(angleRec) * tangent1Rec + sin(angleRec) * tangent2Rec;
        let perParticleDirRec = randomDir(originalCenter);
        // 与散射阶段保持一致：大幅减少随机扰动
        let perParticleVariationRec = (tangent1Rec * (perParticleDirRec.x * 0.3) + tangent2Rec * (perParticleDirRec.y * 0.3)) * (0.02 + randomSeed * 0.02);
        // 与散射阶段保持一致：使用 uRadialExpand 控制径向外扩（基础值 0.3）
        var scatterDir = normalize(tangentDirRec + radialDirRec * (0.3 * uniform.uRadialExpand) + perParticleVariationRec);
        
        // 与 scatter 一致：直接用 baseEasedT
        let finalEasedT = baseEasedT;
        
        // 与 scatter 一致：由 uMaxScatterRadius 限制
        var scatterAmount = finalEasedT * uniform.uMaxScatterRadius * scatterFactor;
        scatterAmount = min(scatterAmount, uniform.uMaxScatterRadius);
        
        var totalOffsetRec = scatterDir * scatterAmount;
        let totalLenRec = length(totalOffsetRec);
        let maxLenRec = max(uniform.uMaxScatterRadius, 0.0001);
        if (totalLenRec > maxLenRec) {
            totalOffsetRec = totalOffsetRec * (maxLenRec / totalLenRec);
        }
        // 与散射阶段一致的烟雾漂移（用 scatterEndTime 保证衔接）
        let smokeT1R = scatterEndTime * 0.45 + randomSeed * 6.28318;
        let smokeT2R = scatterEndTime * 0.6 + randomSeed2 * 6.28318;
        let smokeDriftRec = (tangent1Rec * sin(smokeT1R) + tangent2Rec * cos(smokeT2R)) * 0.04 * uniform.uSmokeDrift;
        let scatterPos = originalCenter + totalOffsetRec + smokeDriftRec;
        
        *center = mix(scatterPos, originalCenter, easedT);
    }
    // Phase 0: before scatter - no modification
    // Phase 3: complete - no modification (already at original)
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    initShared(originalCenter);
    
    let originalScale = *scale;
    
    if (g_phase == 0.0) {
        gsplatMakeSpherical(scale, uniform.uPointSize);
        return;
    }
    if (g_phase == 1.0) {
        gsplatMakeSpherical(scale, uniform.uPointSize);
        return;
    }
    if (g_phase == 2.0) {
        let t = clamp((uniform.uTime - g_tRecover) / uniform.uRecoverDuration, 0.0, 1.0);
        let easedT = clamp(1.0 - pow(1.0 - t, 4.0), 0.0, 1.0);
        let pointScale = vec3f(uniform.uPointSize);
        *scale = mix(pointScale, originalScale, easedT);
        return;
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    initShared(center);
    if (g_phase != 1.0) { return; }
    let toSplat = center - uniform.uCenter;
    let distFromCenter = length(toSplat);
    let normalizedDist = distFromCenter / max(uniform.uEndRadius, 1.0);
    let distanceFade = 1.0 - smoothstep(0.0, 0.9, normalizedDist);
    let h1 = hash(center);
    let h2 = hash(center + vec3f(10.0, 20.0, 30.0));
    let h3 = hash(center + vec3f(50.0, 100.0, 150.0));
    let t1 = uniform.uTime * 8.0 + h1 * 6.28318;
    let t2 = uniform.uTime * 13.0 + h2 * 6.28318;
    let t3 = uniform.uTime * 18.0 + h3 * 6.28318;
    var sparkle = 0.5 + 0.25 * sin(t1) + 0.2 * sin(t2) + 0.15 * sin(t3);
    sparkle = clamp(sparkle, 0.4, 1.0);
    let goldWhite = vec3f(0.98, 0.95, 0.88);
    (*color).rgb = (*color).rgb + goldWhite * sparkle * distanceFade * 0.28;
    (*color).rgb = (*color).rgb * (1.0 + sparkle * distanceFade * 0.18);
    // 一点点蓝色辉光（散射阶段）
    let blueGlow = vec3f(0.5, 0.7, 1.0);
    (*color).rgb = (*color).rgb + blueGlow * distanceFade * 0.25;
    (*color).rgb = clamp((*color).rgb, vec3f(0.0), vec3f(3.0));
}
`;

/**
 * Pieces Recover reveal effect for gaussian splats.
 * Splats scatter away from their original positions, hold for a duration,
 * then recover back to their original positions.
 *
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const piecesScript = entity.script.create(GsplatRevealPiecesRecover);
 * piecesScript.center.set(0, 0, 0);
 * piecesScript.scatterDistance = 2.0;
 * piecesScript.scatterDuration = 1.0;
 * piecesScript.holdDuration = 0.3;
 * piecesScript.recoverDuration = 1.5;
 */
class GsplatRevealPiecesRecover extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealPiecesRecover';

    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];
    _scatterDirectionArray = [0, 1, 0];
    
    // Track if center was updated on enable (to force uniform update)
    private _centerUpdatedOnEnable = false;

    /**
     * Focus point (center) for the effect - spray starts from here
     * @attribute
     */
    center = new Vec3(0, 0, 0);

    /**
     * Base scatter direction (will be normalized)
     * @attribute
     */
    scatterDirection = new Vec3(0, 1, 0);

    /**
     * Base scatter distance (effective displacement is clamped by maxScatterRadius for contour diffusion)
     * @attribute
     * @range [0, 50]
     */
    scatterDistance = 6.0;

    /**
     * 散射阶段时长（秒）。设大一点 = 在几何表面慢慢扩散，无抻拉感
     * @attribute
     * @range [0.1, 20]
     */
    scatterDuration = 6.0;

    /**
     * Duration of hold phase in seconds (splats stay at scattered position)
     * @attribute
     * @range [0, 5]
     */
    holdDuration = 0.0; // No hold phase - direct transition

    /**
     * 复原阶段时长（秒）
     * @attribute
     * @range [0.5, 20]
     */
    recoverDuration = 10.0;

    /**
     * Intensity of random noise/perturbation
     * @attribute
     * @range [0, 2]
     */
    noiseIntensity = 0.8;

    /**
     * Spring stiffness for recovery (currently unused, using lerp instead)
     * @attribute
     * @range [0, 10]
     */
    springStiffness = 5.0;

    /**
     * Distance at which to disable effect for performance
     * @attribute
     * @range [0, 500]
     */
    endRadius = 25;

    /**
     * 散射范围阈值：每个点沿轮廓（切线为主 + 少量径向）轻微扩散的最大位移（单位与场景一致）。贴合原轮廓外扩后复原
     * @attribute
     * @range [0, 50]
     */
    maxScatterRadius = 5.0;

    /**
     * Speed of wave propagation from center (units per second)
     * Controls how fast the scatter effect propagates outward from center
     * @attribute
     * @range [0.1, 100]
     */
    waveSpeed = 6.0;

    /**
     * 波速随距离的缩放系数（相对 g_dist）。>0 时远处点有效波速更大、更早进入散射，整体 Phase 0 缩短；0 为固定波速。
     * 例如 0.02 表示每单位距离波速增加 2%，大场景可设 0.01~0.05 以缩短开场等待。
     * @attribute
     * @range [0, 0.2]
     */
    waveSpeedDistScale = 0.02;

    /**
     * 散射阶段点云 outline 模式固定点大小（与 gsplat-growth-wave 聚拢生长一致，为模型/视空间绝对数值）。
     * 默认略大以保证一开始点云视觉上较密集（无筛选，所有点均参与显示）。
     * @attribute
     * @range [0.001, 0.5]
     */
    pointSize = 0.01;

    /**
     * 是否按场景尺度（endRadius）自动缩放 pointSize，使不同尺度场景的点密度更一致。默认开启以提升初始点云密度感。
     * @attribute
     */
    pointSizeScaleByScene = true;

    /**
     * 统一控制点云扩散程度的系数（0~1）。值越大扩散越明显，值越小点云越贴合原轮廓。
     * 建议范围：0.3（非常轻微）~ 1.0（明显扩散）
     * @attribute
     * @range [0, 1]
     */
    scatterIntensity = 1.8;

    /**
     * 统一控制切线扭曲程度的系数（0~1）。值越大扭曲越明显，值越小点云移动越直线。
     * 建议范围：0.5（温和扭曲）~ 1.0（明显扭曲）
     * @attribute
     * @range [0, 1]
     */
    tangentTwist = 0.2;

    /**
     * 统一控制径向外扩程度的系数（0~1）。值越大沿法线方向外扩越明显，0表示无径向外扩。
     * 建议范围：0.3（轻微外扩）~ 1.0（明显外扩）
     * @attribute
     * @range [0, 1]
     */
    radialExpand = 0;

    /**
     * 烟雾感强度（0~1）：散射时切平面内随时间轻柔漂移，0 为关闭。
     * @attribute
     * @range [0, 1]
     */
    smokeDrift = 0.5;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // Update all uniforms
        this.setUniform('uTime', effectTime);

        // Update center uniform (ensures latest center is used)
        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        // Normalize scatter direction
        const scatterDir = this.scatterDirection.clone().normalize();
        this._scatterDirectionArray[0] = scatterDir.x;
        this._scatterDirectionArray[1] = scatterDir.y;
        this._scatterDirectionArray[2] = scatterDir.z;
        this.setUniform('uScatterDirection', this._scatterDirectionArray);

        this.setUniform('uScatterDistance', this.scatterDistance);
        this.setUniform('uScatterDuration', this.scatterDuration);
        this.setUniform('uHoldDuration', this.holdDuration);
        this.setUniform('uRecoverDuration', this.recoverDuration);
        this.setUniform('uNoiseIntensity', this.noiseIntensity);
        this.setUniform('uSpringStiffness', this.springStiffness);
        this.setUniform('uEndRadius', this.endRadius);
        this.setUniform('uMaxScatterRadius', this.maxScatterRadius);
        this.setUniform('uWaveSpeed', this.waveSpeed);
        this.setUniform('uWaveSpeedDistScale', this.waveSpeedDistScale);
        this.setUniform('uScatterIntensity', this.scatterIntensity);
        this.setUniform('uTangentTwist', this.tangentTwist);
        this.setUniform('uRadialExpand', this.radialExpand);
        this.setUniform('uSmokeDrift', this.smokeDrift);
        const refRadius = 25;
        const effectivePointSize = this.pointSizeScaleByScene
            ? this.pointSize * Math.max(0.5, Math.min(2, this.endRadius / refRadius))
            : this.pointSize;
        this.setUniform('uPointSize', effectivePointSize);

        // Check if effect is complete
        if (this.isEffectComplete()) {
            console.log('Pieces recover effect completed, disabling');
            this.notifyRevealComplete();
            return;
        }
    }

    /** 与 `isEffectComplete` 一致，供 `getPostRevealContentThresholdSec` / 导出门控 */
    getCompletionTime(): number {
        const effectiveSpeedAtEnd = this.waveSpeed * Math.max(1, 1 + this.waveSpeedDistScale * this.endRadius);
        const maxScatterStartTime = this.endRadius / effectiveSpeedAtEnd;
        return maxScatterStartTime + this.scatterDuration + this.recoverDuration;
    }

    /**
     * Calculate when the effect is complete.
     * Effect completes when all splats have finished recovering.
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete() {
        return this.effectTime >= this.getCompletionTime();
    }
}

export { GsplatRevealPiecesRecover };

