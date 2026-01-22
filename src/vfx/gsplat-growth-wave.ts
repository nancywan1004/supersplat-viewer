import { Vec3 } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform vec3 uCenter;
uniform float uGrowthSpeed;
uniform float uGrowthDuration;
uniform float uRecoverDuration;
uniform float uNoiseIntensity;
uniform float uScatterDistance;
uniform float uMinSize;
uniform float uEndRadius;
uniform float uGlobalRecoverStart;
uniform float uBottomY;
uniform float uTopY;
uniform float uEdgeAreaMin;
uniform float uEdgeAreaMax;
uniform float uEdgeAnisoMin;

// Hash function for per-splat randomization
float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

// Generate random direction from hash
vec3 randomDir(vec3 p) {
    float h1 = hash(p);
    float h2 = hash(p + vec3(1.0, 0.0, 0.0));
    float h3 = hash(p + vec3(0.0, 1.0, 0.0));
    
    float theta = h1 * 6.28318;
    float phi = acos(2.0 * h2 - 1.0);
    float r = pow(h3, 1.0/3.0);
    
    return vec3(
        sin(phi) * cos(theta),
        sin(phi) * sin(theta),
        cos(phi)
    );
}

// Shared globals
float g_dist;
float g_yOffset;
float g_wavePhase;
float g_growthProgress;
float g_tRecoverStart;
float g_tRecoverEnd;
float g_recoverProgress;
float g_phase;

void initShared(vec3 center) {
    g_dist = length(center - uCenter);
    
    // Calculate Y offset from bottom (bottom-up growth)
    // Note: Due to Y-axis inversion in coordinate system, larger Y values are visually at the bottom
    // So for bottom-to-top growth, we calculate offset from bottomY
    // Bottom particles (center.y close to bottomY, larger Y value) have small yOffset, start first
    // Use uBottomY - center.y (inverse of integrate effect) to make bottom start first
    g_yOffset = uBottomY - center.y;
    
    // Growth phase: wave propagation from bottom to top
    // Similar to integrate effect, but from bottom to top
    // Calculate wave phase: time progresses, wave propagates upward
    // Bottom particles (small yOffset) have wavePhase reach threshold first
    float timeScaled = uTime * uGrowthSpeed;
    // For bottom-up: bottom has yOffset=0, top has large yOffset
    // Wave phase = time - yOffset * spread, so bottom (yOffset=0) starts first
    float verticalSpread = uGrowthSpeed / abs(uTopY - uBottomY); // Speed per unit height (use abs for safety)
    g_wavePhase = timeScaled - g_yOffset * verticalSpread;
    
    // Growth progress: 0 = not reached, 1 = fully grown
    // Use smoothstep for smooth transition
    g_growthProgress = smoothstep(0.0, uGrowthDuration, g_wavePhase);
    g_growthProgress = clamp(g_growthProgress, 0.0, 1.0);
    
    // Recover phase: wait for ALL particles to finish growing before starting recovery
    // Recovery also propagates from bottom to top
    // Top particle has largest yOffset = uBottomY - uTopY (since uBottomY > uTopY due to Y-axis inversion)
    float globalGrowthEnd = abs(uBottomY - uTopY) * verticalSpread + uGrowthDuration;
    g_tRecoverStart = globalGrowthEnd;
    
    // Recovery wave phase: similar to growth, but for recovery
    float recoverTimeScaled = max(0.0, uTime - g_tRecoverStart) * uGrowthSpeed;
    float recoverWavePhase = recoverTimeScaled - g_yOffset * verticalSpread;
    g_recoverProgress = smoothstep(0.0, uRecoverDuration, recoverWavePhase);
    g_recoverProgress = clamp(g_recoverProgress, 0.0, 1.0);
    
    g_tRecoverEnd = g_tRecoverStart + uRecoverDuration;
    
    g_phase = 0.0;
    
    // Determine current phase
    if (g_wavePhase < 0.0) {
        g_phase = 0.0; // Before wave reaches (hidden)
    } else if (g_wavePhase < uGrowthDuration) {
        g_phase = 1.0; // Growth phase (wave scanning, showing edge particles)
    } else if (uTime < g_tRecoverEnd && g_recoverProgress < 1.0) {
        g_phase = 2.0; // Recover phase (wave scanning, recovering particles)
    } else {
        g_phase = 3.0; // Complete
    }
}

void modifyCenter(inout vec3 center) {
    vec3 originalCenter = center;
    
    initShared(center);
    
    // Phase 0: Hidden (before growth)
    if (g_phase == 0.0) {
        // Move particles far away to hide them
        // Since Y-axis is inverted, larger Y = visually bottom, so we move DOWN (increase Y) to hide below
        center = originalCenter + vec3(0.0, 1000.0, 0.0);
        return;
    }
    
    // Phase 3: Complete - keep original position
    if (g_phase >= 3.0) {
        return;
    }
    
    // Generate per-splat random values for smoke spray effect (same as pieces-recover)
    float randomSeed = hash(originalCenter);
    float randomSeed2 = hash(originalCenter + vec3(10.0, 20.0, 30.0));
    float randomSeed3 = hash(originalCenter + vec3(50.0, 100.0, 150.0));
    
    // Determine if this particle sprays outward or inward (50/50 split)
    float directionSeed = hash(originalCenter + vec3(999.0, 888.0, 777.0));
    float directionSign = (directionSeed > 0.5) ? 1.0 : -1.0; // 1.0 = outward, -1.0 = inward
    
    // Create SMOOTH stream-based direction using multi-frequency noise for natural smoke trails
    vec3 toSplat = originalCenter - uCenter;
    float distFromCenter = length(toSplat);
    vec3 radialDir = distFromCenter > 0.001 ? normalize(toSplat) : vec3(0.0, 1.0, 0.0);
    
    // Apply direction sign to create bidirectional spray effect (inward and outward)
    radialDir *= directionSign;
    
    // Multi-frequency noise for smooth, elongated smoke trails
    float noiseScale1 = 1.2;  // Large-scale stream patterns
    float noiseScale2 = 3.5;  // Medium-scale variations
    float noiseScale3 = 12.0;  // Fine-scale details
    
    vec3 noisePos1 = (originalCenter - uCenter) * noiseScale1;
    vec3 noisePos2 = (originalCenter - uCenter) * noiseScale2;
    vec3 noisePos3 = (originalCenter - uCenter) * noiseScale3;
    
    // Use trilinear interpolation for smooth, continuous stream directions
    vec3 i1 = floor(noisePos1);
    vec3 f1 = fract(noisePos1);
    f1 = f1 * f1 * (3.0 - 2.0 * f1); // Smoothstep
    
    // Sample 8 corners for trilinear interpolation
    vec3 d000 = randomDir(i1);
    vec3 d100 = randomDir(i1 + vec3(1.0, 0.0, 0.0));
    vec3 d010 = randomDir(i1 + vec3(0.0, 1.0, 0.0));
    vec3 d110 = randomDir(i1 + vec3(1.0, 1.0, 0.0));
    vec3 d001 = randomDir(i1 + vec3(0.0, 0.0, 1.0));
    vec3 d101 = randomDir(i1 + vec3(1.0, 0.0, 1.0));
    vec3 d011 = randomDir(i1 + vec3(0.0, 1.0, 1.0));
    vec3 d111 = randomDir(i1 + vec3(1.0, 1.0, 1.0));
    
    // Trilinear interpolation for smooth stream direction
    vec3 streamDir1 = mix(
        mix(mix(d000, d100, f1.x), mix(d010, d110, f1.x), f1.y),
        mix(mix(d001, d101, f1.x), mix(d011, d111, f1.x), f1.y),
        f1.z
    );
    
    // Medium and fine scale variations
    vec3 streamDir2 = randomDir(floor(noisePos2));
    vec3 streamDir3 = randomDir(floor(noisePos3));
    vec3 frac2 = fract(noisePos2);
    vec3 frac3 = fract(noisePos3);
    float smooth2 = smoothstep(0.0, 1.0, frac2.x) * smoothstep(0.0, 1.0, frac2.y) * smoothstep(0.0, 1.0, frac2.z);
    float smooth3 = smoothstep(0.0, 1.0, frac3.x) * smoothstep(0.0, 1.0, frac3.y) * smoothstep(0.0, 1.0, frac3.z);
    
    // Blend directions for elongated smoke trails
    vec3 streamDir = normalize(
        radialDir * 0.4 +
        streamDir1 * 1.2 +
        streamDir2 * 0.3 * smooth2 +
        streamDir3 * 0.15 * smooth3
    );
    
    // Per-particle variation
    vec3 perParticleDir = randomDir(originalCenter);
    vec3 perParticleVariation = perParticleDir * (0.12 + randomSeed * 0.18);
    
    // Final scatter direction
    vec3 scatterDir = normalize(streamDir + perParticleVariation);
    
    // Smooth distance variation
    float h000 = hash(i1);
    float h100 = hash(i1 + vec3(1.0, 0.0, 0.0));
    float h010 = hash(i1 + vec3(0.0, 1.0, 0.0));
    float h110 = hash(i1 + vec3(1.0, 1.0, 0.0));
    float h001 = hash(i1 + vec3(0.0, 0.0, 1.0));
    float h101 = hash(i1 + vec3(1.0, 0.0, 1.0));
    float h011 = hash(i1 + vec3(0.0, 1.0, 1.0));
    float h111 = hash(i1 + vec3(1.0, 1.0, 1.0));
    
    float streamDist1 = mix(
        mix(mix(h000, h100, f1.x), mix(h010, h110, f1.x), f1.y),
        mix(mix(h001, h101, f1.x), mix(h011, h111, f1.x), f1.y),
        f1.z
    );
    
    float streamDist2 = hash(floor(noisePos2));
    float streamScatterBase = 0.65 + streamDist1 * 0.5 + streamDist2 * smooth2 * 0.25;
    float perParticleVariationDist = 0.75 + randomSeed * 0.75;
    float scatterFactor = streamScatterBase * perParticleVariationDist;
    scatterFactor = max(0.4, scatterFactor);
    
    if (g_phase == 1.0) {
        // Growth phase: wave scanning from bottom to top, showing edge particles
        // Only show edge particles (far from center)
        float distFromCenter = length(originalCenter - uCenter);
        float edgeThreshold = uEndRadius * 0.3; // Only show particles in outer 30% of radius
        
        // Hide particles that are too close to center
        if (distFromCenter < edgeThreshold) {
            center = originalCenter + vec3(0.0, 1000.0, 0.0);
            return;
        }
        
        // Use growthProgress (0 to 1) for smooth wave scanning effect
        // g_growthProgress is calculated based on wave phase, so it creates a scanning effect
        float easedProgress = g_growthProgress * g_growthProgress * (3.0 - 2.0 * g_growthProgress); // Smoothstep
        
        // 从外部向内聚拢效果（类似pieces-recover的打散，但方向相反）
        // 使用scatterDir定义打散方向，然后反向实现聚拢
        // scatterDir已经在上面计算好了，包含了多频率噪声和平滑的流式方向
        
        // 计算打散距离：粒子从外部的一个较大范围开始
        float scatterAmount = uScatterDistance * scatterFactor;
        float maxScatterDistance = scatterAmount * 1.5; // 增加外部起始范围
        
        // 从打散位置开始（使用scatterDir的反向，即从外部向内的方向）
        vec3 scatterStartDir = -scatterDir; // 反向scatterDir，实现聚拢
        vec3 startPos = originalCenter + scatterStartDir * maxScatterDistance;
        
        // 内收进度：随着easedProgress增加，粒子从外部向内移动
        // 使用平滑的曲线，让内收过程更明显
        float inwardProgress = easedProgress;
        float inwardEase = inwardProgress * inwardProgress; // 二次方，让内收更平滑明显
        float currentScatterDistance = maxScatterDistance * (1.0 - inwardEase);
        
        // 轻微的螺旋旋转效果（降低强度，更柔和）
        vec3 radialIn = distFromCenter > 0.001 ? -normalize(toSplat) : vec3(0.0, 0.0, -1.0);
        vec3 upAxis = vec3(0.0, 1.0, 0.0);
        vec3 tangential = normalize(cross(upAxis, radialIn));
        if (length(tangential) < 0.001) {
            tangential = vec3(1.0, 0.0, 0.0);
        }
        
        // 柔和的螺旋旋转（降低强度）
        float twistSpeed = 1.0; // 降低旋转速度
        float twistAngle = uTime * twistSpeed + distFromCenter * 0.2 + randomSeed * 6.28318;
        float twistStrength = 0.25; // 大幅降低螺旋强度，使效果更柔和
        
        // 计算螺旋偏移（基于当前内收距离）
        float spiralRadius = currentScatterDistance * 0.3; // 降低螺旋半径
        vec3 spiralOffset = tangential * twistStrength * sin(twistAngle) * spiralRadius;
        vec3 spiralOffset2 = cross(radialIn, tangential) * twistStrength * 0.2 * cos(twistAngle) * spiralRadius;
        
        // 添加轻微的湍流，使运动更自然
        vec3 noisePos1 = (originalCenter - uCenter) * noiseScale1;
        vec3 i1 = floor(noisePos1);
        vec3 f1 = fract(noisePos1);
        f1 = f1 * f1 * (3.0 - 2.0 * f1);
        
        vec3 t000 = randomDir(i1);
        vec3 t100 = randomDir(i1 + vec3(1.0, 0.0, 0.0));
        vec3 t010 = randomDir(i1 + vec3(0.0, 1.0, 0.0));
        vec3 t110 = randomDir(i1 + vec3(1.0, 1.0, 0.0));
        vec3 t001 = randomDir(i1 + vec3(0.0, 0.0, 1.0));
        vec3 t101 = randomDir(i1 + vec3(1.0, 0.0, 1.0));
        vec3 t011 = randomDir(i1 + vec3(0.0, 1.0, 1.0));
        vec3 t111 = randomDir(i1 + vec3(1.0, 1.0, 1.0));
        
        vec3 turbDir = normalize(mix(
            mix(mix(t000, t100, f1.x), mix(t010, t110, f1.x), f1.y),
            mix(mix(t001, t101, f1.x), mix(t011, t111, f1.x), f1.y),
            f1.z
        ));
        
        float turbulenceAmount = uNoiseIntensity * 0.1 * easedProgress * (1.0 - easedProgress);
        vec3 turbulence = turbDir * turbulenceAmount;
        
        // 最终位置：从外部打散位置向内聚拢，伴随柔和的螺旋旋转
        vec3 targetPos = originalCenter + scatterStartDir * currentScatterDistance + spiralOffset + spiralOffset2 + turbulence;
        
        // 平滑插值：从起始外部位置到目标位置
        center = mix(startPos, targetPos, easedProgress);

        // At end of phase1, lock to original position to keep the correct point cloud
        if (easedProgress >= 0.999) {
            center = originalCenter;
        }
        
    } else if (g_phase == 2.0) {
        // Recover phase: wave scanning from bottom to top, recovering all particles
        // Use recoverProgress (0 to 1) for smooth wave scanning effect
        float easedRecover = g_recoverProgress * g_recoverProgress * (3.0 - 2.0 * g_recoverProgress); // Smoothstep
        
        // Recovery: force back to original (no scatter reconstruction)
        center = originalCenter;
    }
}

void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
    initShared(originalCenter);
    
    float originalSize = gsplatExtractSize(covA, covB);
    
    // Phase 0: Hidden - make very small
    if (g_phase == 0.0) {
        gsplatMakeRound(covA, covB, originalSize * 0.001);
        return;
    }
    
    // Phase 1: Growth phase - small particles (point cloud) with smoke spray
    if (g_phase == 1.0) {
        float randomSeed = hash(originalCenter);
        float sizeFactor = uMinSize + randomSeed * (0.25 - uMinSize); // Use uMinSize to 0.25 range
        float size = originalSize * sizeFactor;

        // Edge filter using approximate screen area & anisotropy (no projected ellipse available here)
        float lenA = length(covA);
        float lenB = length(covB);
        float small = 1e-4;
        float aniso = max(lenA, lenB) / max(min(lenA, lenB), small);
        float screenArea = size * size;
        bool edgeCandidate = (screenArea < uEdgeAreaMin) || (aniso > uEdgeAnisoMin && screenArea < uEdgeAreaMax);
        if (!edgeCandidate) {
            gsplatMakeRound(covA, covB, originalSize * 0.001); // hide non-edges
            return;
        }

        gsplatMakeRound(covA, covB, size);
        return;
    }
    
    // Phase 2: Recover phase - gradually restore original size and shape
    // ALL particles recover, not just edge particles
    if (g_phase == 2.0) {
        float t = (uTime - g_tRecoverStart) / uRecoverDuration;
        t = clamp(t, 0.0, 1.0);
        float easedT = 1.0 - pow(1.0 - t, 4.0);
        easedT = clamp(easedT, 0.0, 1.0);
        
        // Check if this particle was an edge particle during growth phase
        float distFromCenter = length(originalCenter - uCenter);
        float edgeThreshold = uEndRadius * 0.3;
        bool wasEdgeParticle = distFromCenter >= edgeThreshold;
        
        float randomSeed = hash(originalCenter);
        float minSizeFactor;
        
        if (wasEdgeParticle) {
            // Edge particles: recover from small point cloud size
            minSizeFactor = uMinSize + randomSeed * (0.1 - uMinSize);
        } else {
            // Non-edge particles: start from hidden (very small) and grow to original
            minSizeFactor = 0.001;
        }
        
        float size = mix(originalSize * minSizeFactor, originalSize, easedT);
        
        // Lerp from round to original shape
        vec3 origCovA = covA;
        vec3 origCovB = covB;
        gsplatMakeRound(covA, covB, size);
        covA = mix(covA, origCovA, easedT);
        covB = mix(covB, origCovB, easedT);
        return;
    }
    
    // Phase 3: Original shape (no modification)
}

void modifyColor(vec3 center, inout vec4 color) {
    // No color modifications
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uGrowthSpeed: f32;
uniform uGrowthDuration: f32;
uniform uRecoverDuration: f32;
uniform uNoiseIntensity: f32;
uniform uScatterDistance: f32;
uniform uMinSize: f32;
uniform uEndRadius: f32;
uniform uGlobalRecoverStart: f32;
uniform uBottomY: f32;
uniform uTopY: f32;
uniform uEdgeAreaMin: f32;
uniform uEdgeAreaMax: f32;
uniform uEdgeAnisoMin: f32;

// Hash function for per-splat randomization
fn hash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

// Generate random direction from hash
fn randomDir(p: vec3f) -> vec3f {
    let h1 = hash(p);
    let h2 = hash(p + vec3f(1.0, 0.0, 0.0));
    let h3 = hash(p + vec3f(0.0, 1.0, 0.0));
    
    let theta = h1 * 6.28318;
    let phi = acos(2.0 * h2 - 1.0);
    let r = pow(h3, 1.0/3.0);
    
    return vec3f(
        sin(phi) * cos(theta),
        sin(phi) * sin(theta),
        cos(phi)
    );
}

// Shared globals
var<private> g_dist: f32;
var<private> g_yOffset: f32;
var<private> g_wavePhase: f32;
var<private> g_growthProgress: f32;
var<private> g_tRecoverStart: f32;
var<private> g_tRecoverEnd: f32;
var<private> g_recoverProgress: f32;
var<private> g_phase: f32;

fn initShared(center: vec3f) {
    g_dist = length(center - uniform.uCenter);
    
    // Calculate Y offset from bottom (bottom-up growth)
    // Note: Due to Y-axis inversion in coordinate system, larger Y values are visually at the bottom
    // So for bottom-to-top growth, we calculate offset from bottomY
    // Bottom particles (center.y close to bottomY, larger Y value) have small yOffset, start first
    // Use uBottomY - center.y (inverse of integrate effect) to make bottom start first
    g_yOffset = uniform.uBottomY - center.y;
    
    // Growth phase: wave propagation from bottom to top
    // Similar to integrate effect, but from bottom to top
    // Calculate wave phase: time progresses, wave propagates upward
    // Bottom particles (small yOffset) have wavePhase reach threshold first
    let timeScaled = uniform.uTime * uniform.uGrowthSpeed;
    // For bottom-up: bottom has yOffset=0, top has large yOffset
    // Wave phase = time - yOffset * spread, so bottom (yOffset=0) starts first
    let verticalSpread = uniform.uGrowthSpeed / abs(uniform.uTopY - uniform.uBottomY); // Speed per unit height (use abs for safety)
    g_wavePhase = timeScaled - g_yOffset * verticalSpread;
    
    // Growth progress: 0 = not reached, 1 = fully grown
    // Use smoothstep for smooth transition
    g_growthProgress = smoothstep(0.0, uniform.uGrowthDuration, g_wavePhase);
    g_growthProgress = clamp(g_growthProgress, 0.0, 1.0);
    
    // Recover phase: wait for ALL particles to finish growing before starting recovery
    // Recovery also propagates from bottom to top
    // Top particle has largest yOffset = uBottomY - uTopY (since uBottomY > uTopY due to Y-axis inversion)
    let globalGrowthEnd = abs(uniform.uBottomY - uniform.uTopY) * verticalSpread + uniform.uGrowthDuration;
    g_tRecoverStart = globalGrowthEnd;
    
    // Recovery wave phase: similar to growth, but for recovery
    let recoverTimeScaled = max(0.0, uniform.uTime - g_tRecoverStart) * uniform.uGrowthSpeed;
    let recoverWavePhase = recoverTimeScaled - g_yOffset * verticalSpread;
    g_recoverProgress = smoothstep(0.0, uniform.uRecoverDuration, recoverWavePhase);
    g_recoverProgress = clamp(g_recoverProgress, 0.0, 1.0);
    
    g_tRecoverEnd = g_tRecoverStart + uniform.uRecoverDuration;
    
    g_phase = 0.0;
    
    // Determine current phase
    if (g_wavePhase < 0.0) {
        g_phase = 0.0; // Before wave reaches (hidden)
    } else if (g_wavePhase < uniform.uGrowthDuration) {
        g_phase = 1.0; // Growth phase (wave scanning, showing edge particles)
    } else if (uniform.uTime < g_tRecoverEnd && g_recoverProgress < 1.0) {
        g_phase = 2.0; // Recover phase (wave scanning, recovering particles)
    } else {
        g_phase = 3.0; // Complete
    }
}

fn modifyCenter(center: ptr<function, vec3f>) {
    let originalCenter = *center;
    
    initShared(*center);
    
    // Phase 0: Hidden
    if (g_phase == 0.0) {
        // Since Y-axis is inverted, larger Y = visually bottom, so we move DOWN (increase Y) to hide below
        *center = originalCenter + vec3f(0.0, 1000.0, 0.0);
        return;
    }
    
    // Phase 3: Complete
    if (g_phase >= 3.0) {
        return;
    }
    
    // Generate per-splat random values (same as pieces-recover)
    let randomSeed = hash(originalCenter);
    let randomSeed2 = hash(originalCenter + vec3f(10.0, 20.0, 30.0));
    let randomSeed3 = hash(originalCenter + vec3f(50.0, 100.0, 150.0));
    
    let directionSeed = hash(originalCenter + vec3f(999.0, 888.0, 777.0));
    let directionSign = select(-1.0, 1.0, directionSeed > 0.5);
    
    let toSplat = originalCenter - uniform.uCenter;
    let distFromCenter = length(toSplat);
    var radialDir = select(vec3f(0.0, 1.0, 0.0), normalize(toSplat), distFromCenter > 0.001);
    radialDir = radialDir * directionSign;
    
    let noiseScale1 = 1.2;
    let noiseScale2 = 3.5;
    let noiseScale3 = 12.0;
    
    let noisePos1 = (originalCenter - uniform.uCenter) * noiseScale1;
    let noisePos2 = (originalCenter - uniform.uCenter) * noiseScale2;
    let noisePos3 = (originalCenter - uniform.uCenter) * noiseScale3;
    
    let i1 = floor(noisePos1);
    var f1 = fract(noisePos1);
    f1 = f1 * f1 * (3.0 - 2.0 * f1);
    
    let d000 = randomDir(i1);
    let d100 = randomDir(i1 + vec3f(1.0, 0.0, 0.0));
    let d010 = randomDir(i1 + vec3f(0.0, 1.0, 0.0));
    let d110 = randomDir(i1 + vec3f(1.0, 1.0, 0.0));
    let d001 = randomDir(i1 + vec3f(0.0, 0.0, 1.0));
    let d101 = randomDir(i1 + vec3f(1.0, 0.0, 1.0));
    let d011 = randomDir(i1 + vec3f(0.0, 1.0, 1.0));
    let d111 = randomDir(i1 + vec3f(1.0, 1.0, 1.0));
    
    let streamDir1 = normalize(mix(
        mix(mix(d000, d100, f1.x), mix(d010, d110, f1.x), f1.y),
        mix(mix(d001, d101, f1.x), mix(d011, d111, f1.x), f1.y),
        f1.z
    ));
    
    let streamDir2 = randomDir(floor(noisePos2));
    let streamDir3 = randomDir(floor(noisePos3));
    let frac2 = fract(noisePos2);
    let frac3 = fract(noisePos3);
    let smooth2 = smoothstep(0.0, 1.0, frac2.x) * smoothstep(0.0, 1.0, frac2.y) * smoothstep(0.0, 1.0, frac2.z);
    let smooth3 = smoothstep(0.0, 1.0, frac3.x) * smoothstep(0.0, 1.0, frac3.y) * smoothstep(0.0, 1.0, frac3.z);
    
    let streamDir = normalize(
        radialDir * 0.4 +
        streamDir1 * 1.2 +
        streamDir2 * 0.3 * smooth2 +
        streamDir3 * 0.15 * smooth3
    );
    
    let perParticleDir = randomDir(originalCenter);
    let perParticleVariation = perParticleDir * (0.12 + randomSeed * 0.18);
    let scatterDir = normalize(streamDir + perParticleVariation);
    
    let h000 = hash(i1);
    let h100 = hash(i1 + vec3f(1.0, 0.0, 0.0));
    let h010 = hash(i1 + vec3f(0.0, 1.0, 0.0));
    let h110 = hash(i1 + vec3f(1.0, 1.0, 0.0));
    let h001 = hash(i1 + vec3f(0.0, 0.0, 1.0));
    let h101 = hash(i1 + vec3f(1.0, 0.0, 1.0));
    let h011 = hash(i1 + vec3f(0.0, 1.0, 1.0));
    let h111 = hash(i1 + vec3f(1.0, 1.0, 1.0));
    
    let streamDist1 = mix(
        mix(mix(h000, h100, f1.x), mix(h010, h110, f1.x), f1.y),
        mix(mix(h001, h101, f1.x), mix(h011, h111, f1.x), f1.y),
        f1.z
    );
    
    let streamDist2 = hash(floor(noisePos2));
    let streamScatterBase = 0.65 + streamDist1 * 0.5 + streamDist2 * smooth2 * 0.25;
    let perParticleVariationDist = 0.75 + randomSeed * 0.75;
    var scatterFactor = streamScatterBase * perParticleVariationDist;
    scatterFactor = max(0.4, scatterFactor);
    
    if (g_phase == 1.0) {
        // Growth phase: wave scanning from bottom to top, showing edge particles
        // Only show edge particles (far from center)
        let distFromCenter = length(originalCenter - uniform.uCenter);
        let edgeThreshold = uniform.uEndRadius * 0.3;
        
        // Hide particles that are too close to center
        if (distFromCenter < edgeThreshold) {
            *center = originalCenter + vec3f(0.0, 1000.0, 0.0);
            return;
        }
        
        // Use growthProgress (0 to 1) for smooth wave scanning effect
        let easedProgress = g_growthProgress * g_growthProgress * (3.0 - 2.0 * g_growthProgress); // Smoothstep
        
        // 从外部向内聚拢效果（类似pieces-recover的打散，但方向相反）
        // 使用scatterDir定义打散方向，然后反向实现聚拢
        // scatterDir已经在上面计算好了，包含了多频率噪声和平滑的流式方向
        
        // 计算打散距离：粒子从外部的一个较大范围开始
        let scatterAmount = uniform.uScatterDistance * scatterFactor;
        let maxScatterDistance = scatterAmount * 1.5; // 增加外部起始范围
        
        // 从打散位置开始（使用scatterDir的反向，即从外部向内的方向）
        let scatterStartDir = -scatterDir; // 反向scatterDir，实现聚拢
        let startPos = originalCenter + scatterStartDir * maxScatterDistance;
        
        // 内收进度：随着easedProgress增加，粒子从外部向内移动
        // 使用平滑的曲线，让内收过程更明显
        let inwardProgress = easedProgress;
        let inwardEase = inwardProgress * inwardProgress; // 二次方，让内收更平滑明显
        let currentScatterDistance = maxScatterDistance * (1.0 - inwardEase);
        
        // 轻微的螺旋旋转效果（降低强度，更柔和）
        let radialIn = select(vec3f(0.0, 0.0, -1.0), -normalize(toSplat), distFromCenter > 0.001);
        let upAxis = vec3f(0.0, 1.0, 0.0);
        var tangential = normalize(cross(upAxis, radialIn));
        if (length(tangential) < 0.001) {
            tangential = vec3f(1.0, 0.0, 0.0);
        }
        
        // 柔和的螺旋旋转（降低强度）
        let twistSpeed = 1.0; // 降低旋转速度
        let twistAngle = uniform.uTime * twistSpeed + distFromCenter * 0.2 + randomSeed * 6.28318;
        let twistStrength = 0.25; // 大幅降低螺旋强度，使效果更柔和
        
        // 计算螺旋偏移（基于当前内收距离）
        let spiralRadius = currentScatterDistance * 0.3; // 降低螺旋半径
        let spiralOffset = tangential * twistStrength * sin(twistAngle) * spiralRadius;
        let spiralOffset2 = cross(radialIn, tangential) * twistStrength * 0.2 * cos(twistAngle) * spiralRadius;
        
        // 添加轻微的湍流，使运动更自然
        let noisePos1 = (originalCenter - uniform.uCenter) * noiseScale1;
        let i1 = floor(noisePos1);
        var f1 = fract(noisePos1);
        f1 = f1 * f1 * (3.0 - 2.0 * f1);
        
        let t000 = randomDir(i1);
        let t100 = randomDir(i1 + vec3f(1.0, 0.0, 0.0));
        let t010 = randomDir(i1 + vec3f(0.0, 1.0, 0.0));
        let t110 = randomDir(i1 + vec3f(1.0, 1.0, 0.0));
        let t001 = randomDir(i1 + vec3f(0.0, 0.0, 1.0));
        let t101 = randomDir(i1 + vec3f(1.0, 0.0, 1.0));
        let t011 = randomDir(i1 + vec3f(0.0, 1.0, 1.0));
        let t111 = randomDir(i1 + vec3f(1.0, 1.0, 1.0));
        
        let turbDir = normalize(mix(
            mix(mix(t000, t100, f1.x), mix(t010, t110, f1.x), f1.y),
            mix(mix(t001, t101, f1.x), mix(t011, t111, f1.x), f1.y),
            f1.z
        ));
        
        let turbulenceAmount = uniform.uNoiseIntensity * 0.1 * easedProgress * (1.0 - easedProgress);
        let turbulence = turbDir * turbulenceAmount;
        
        // 最终位置：从外部打散位置向内聚拢，伴随柔和的螺旋旋转
        let targetPos = originalCenter + scatterStartDir * currentScatterDistance + spiralOffset + spiralOffset2 + turbulence;
        
        // 平滑插值：从起始外部位置到目标位置
        *center = mix(startPos, targetPos, easedProgress);
        
    } else if (g_phase == 2.0) {
        // Recover phase: wave scanning from bottom to top, recovering all particles
        // Use recoverProgress (0 to 1) for smooth wave scanning effect
        let easedRecover = g_recoverProgress * g_recoverProgress * (3.0 - 2.0 * g_recoverProgress); // Smoothstep
        
        // Recovery: force back to original (no scatter reconstruction)
        *center = originalCenter;
    }
}

fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
    initShared(originalCenter);
    
    let originalSize = gsplatExtractSize(*covA, *covB);
    
    // Phase 0: Hidden
    if (g_phase == 0.0) {
        gsplatMakeRound(covA, covB, originalSize * 0.001);
        return;
    }
    
    // Phase 1: Growth phase - small particles (only edge particles)
    if (g_phase == 1.0) {
        // Check if particle is at edge (far from center)
        let distFromCenter = length(originalCenter - uniform.uCenter);
        let edgeThreshold = uniform.uEndRadius * 0.3; // Only show particles in outer 30% of radius
        
        // Hide particles that are too close to center
        if (distFromCenter < edgeThreshold) {
            gsplatMakeRound(covA, covB, originalSize * 0.001);
            return;
        }
        
        let randomSeed = hash(originalCenter);
        // Make particles much smaller for point cloud effect (5-10% of original)
        let sizeFactor = uniform.uMinSize + randomSeed * (0.1 - uniform.uMinSize);
        let size = originalSize * sizeFactor;

        // Edge filter using approximate screen area & anisotropy (no projected ellipse available here)
        let lenA = length(*covA);
        let lenB = length(*covB);
        let small = 1e-4;
        let aniso = max(lenA, lenB) / max(min(lenA, lenB), small);
        let screenArea = size * size;
        let edgeCandidate = (screenArea < uniform.uEdgeAreaMin) || (aniso > uniform.uEdgeAnisoMin && screenArea < uniform.uEdgeAreaMax);
        if (!edgeCandidate) {
            gsplatMakeRound(covA, covB, originalSize * 0.001); // hide non-edges
            return;
        }

        gsplatMakeRound(covA, covB, size);
        return;
    }
    
    // Phase 2: Recover phase - ALL particles recover, not just edge particles
    if (g_phase == 2.0) {
        let t = clamp((uniform.uTime - g_tRecoverStart) / uniform.uRecoverDuration, 0.0, 1.0);
        let easedT = clamp(1.0 - pow(1.0 - t, 4.0), 0.0, 1.0);
        
        // Check if this particle was an edge particle during growth phase
        let distFromCenter = length(originalCenter - uniform.uCenter);
        let edgeThreshold = uniform.uEndRadius * 0.3;
        let wasEdgeParticle = distFromCenter >= edgeThreshold;
        
        let randomSeed = hash(originalCenter);
        var minSizeFactor: f32;
        
        if (wasEdgeParticle) {
            // Edge particles: recover from small point cloud size
            minSizeFactor = uniform.uMinSize + randomSeed * (0.1 - uniform.uMinSize);
        } else {
            // Non-edge particles: start from hidden (very small) and grow to original
            minSizeFactor = 0.001;
        }
        
        let size = mix(originalSize * minSizeFactor, originalSize, easedT);
        
        let origCovA = *covA;
        let origCovB = *covB;
        gsplatMakeRound(covA, covB, size);
        *covA = mix(*covA, origCovA, easedT);
        *covB = mix(*covB, origCovB, easedT);
        return;
    }
    
    // Phase 3: Original shape
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    // No color modifications
}
`;

/**
 * Growth Wave reveal effect for gaussian splats.
 * Particles grow from bottom to top, first appearing as small point cloud particles with smoke spray effect,
 * then recovering to their original positions and shapes.
 *
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const growthScript = entity.script.create(GsplatRevealGrowthWave);
 * growthScript.center.set(0, 0, 0);
 * growthScript.growthSpeed = 5.0;
 * growthScript.growthDuration = 7.0;
 * growthScript.recoverDuration = 7.0;
 */
class GsplatRevealGrowthWave extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealGrowthWave';

    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];

    /**
     * Focus point (center) for the effect - growth starts from bottom relative to this
     * @attribute
     */
    center = new Vec3(0, 0, 0);

    /**
     * Speed of bottom-to-top growth (units per second)
     * @attribute
     * @range [0.1, 50]
     */
    growthSpeed = 5.0;

    /**
     * Duration of growth phase in seconds (particles appear with smoke spray)
     * @attribute
     * @range [0.5, 20]
     */
    growthDuration = 7.0;

    /**
     * Duration of recover phase in seconds (particles return to original positions)
     * @attribute
     * @range [0.5, 20]
     */
    recoverDuration = 7.0;

    /**
     * Intensity of noise/perturbation during growth and recovery
     * @attribute
     * @range [0, 2]
     */
    noiseIntensity = 0.8;

    /**
     * Maximum distance particles scatter during growth phase
     * @attribute
     * @range [0, 50]
     */
    scatterDistance = 4.0;

    /**
     * Minimum size factor for point cloud particles (relative to original size)
     * @attribute
     * @range [0.01, 1]
     */
    minSize = 0.05;

    /**
     * Maximum Y distance from center to process (for performance)
     * @attribute
     * @range [0, 500]
     */
    endRadius = 50.0;

    /**
     * Bottom Y coordinate where growth starts
     * @attribute
     */
    bottomY = -10.0;

    /**
     * Top Y coordinate where growth ends
     * @attribute
     */
    topY = 10.0;

    /**
     * Edge filter: minimum screen area (px^2) to keep; smaller treated as edges
     * @attribute
     * @range [0, 20]
     */
    edgeAreaMin = 1.5;

    /**
     * Edge filter: maximum screen area (px^2) for anisotropic edges
     * @attribute
     * @range [0, 50]
     */
    edgeAreaMax = 6.0;

    /**
     * Edge filter: anisotropy threshold (r_major / r_minor approx)
     * @attribute
     * @range [1, 20]
     */
    edgeAnisoMin = 5.0;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // Calculate global recover start time: when the topmost particle finishes growing
        // Topmost particle has smallest Y (most negative yOffset = endRadius)
        // Growth start time for topmost = endRadius / growthSpeed
        // Growth end time for topmost = (endRadius / growthSpeed) + growthDuration
        const globalRecoverStart = (this.endRadius / this.growthSpeed) + this.growthDuration;

        // Update all uniforms
        this.setUniform('uTime', effectTime);

        // Update center uniform
        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        this.setUniform('uGrowthSpeed', this.growthSpeed);
        this.setUniform('uGrowthDuration', this.growthDuration);
        this.setUniform('uRecoverDuration', this.recoverDuration);
        this.setUniform('uNoiseIntensity', this.noiseIntensity);
        this.setUniform('uScatterDistance', this.scatterDistance);
        this.setUniform('uMinSize', this.minSize);
        this.setUniform('uEndRadius', this.endRadius);
        this.setUniform('uGlobalRecoverStart', globalRecoverStart);
        this.setUniform('uBottomY', this.bottomY);
        this.setUniform('uTopY', this.topY);
        this.setUniform('uEdgeAreaMin', this.edgeAreaMin);
        this.setUniform('uEdgeAreaMax', this.edgeAreaMax);
        this.setUniform('uEdgeAnisoMin', this.edgeAnisoMin);

        // Check if effect is complete
        if (this.isEffectComplete(globalRecoverStart)) {
            console.log('Growth wave effect completed, disabling');
            this.enabled = false;
            return;
        }
    }

    /**
     * Calculate when the effect is complete.
     * Effect completes when all particles have finished recovering.
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete(globalRecoverStart?: number) {
        // All particles finish growing at globalRecoverStart
        // Then they all recover together
        const recoverStart = globalRecoverStart ?? (this.endRadius / this.growthSpeed) + this.growthDuration;
        const maxCompletionTime = recoverStart + this.recoverDuration;

        return this.effectTime >= maxCompletionTime;
    }
}

export { GsplatRevealGrowthWave };
