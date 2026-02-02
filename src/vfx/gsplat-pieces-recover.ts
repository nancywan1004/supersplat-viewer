import { Vec3, Color } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';

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

void modifyCenter(inout vec3 center) {
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
    
    // Determine if this particle sprays outward or inward (50/50 split)
    float directionSeed = hash(originalCenter + vec3(999.0, 888.0, 777.0));
    float directionSign = (directionSeed > 0.5) ? 1.0 : -1.0; // 1.0 = outward, -1.0 = inward
    
    // Create SMOOTH stream-based direction using multi-frequency noise for natural smoke trails
    // Use smooth noise instead of hard cell boundaries to avoid blocky patterns
    vec3 toSplat = originalCenter - uCenter;
    float distFromCenter = length(toSplat);
    vec3 radialDir = distFromCenter > 0.001 ? normalize(toSplat) : vec3(0.0, 1.0, 0.0);
    
    // Apply direction sign to create bidirectional spray effect (inward and outward)
    radialDir *= directionSign;
    
    // Multi-frequency noise for smooth, elongated smoke trails
    // Use LARGER scales for LONGER, more elongated streams (not blocky)
    float noiseScale1 = 1.2;  // Large-scale stream patterns (larger = longer streams)
    float noiseScale2 = 3.5;  // Medium-scale variations
    float noiseScale3 = 12.0;  // Fine-scale details
    
    vec3 noisePos1 = (originalCenter - uCenter) * noiseScale1;
    vec3 noisePos2 = (originalCenter - uCenter) * noiseScale2;
    vec3 noisePos3 = (originalCenter - uCenter) * noiseScale3;
    
    // Use trilinear interpolation for smooth, continuous stream directions
    // This creates elongated trails instead of blocky patterns
    vec3 i1 = floor(noisePos1);
    vec3 f1 = fract(noisePos1);
    f1 = f1 * f1 * (3.0 - 2.0 * f1); // Smoothstep for smoother interpolation
    
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
    
    // Medium and fine scale variations (simpler interpolation)
    vec3 streamDir2 = randomDir(floor(noisePos2));
    vec3 streamDir3 = randomDir(floor(noisePos3));
    vec3 frac2 = fract(noisePos2);
    vec3 frac3 = fract(noisePos3);
    float smooth2 = smoothstep(0.0, 1.0, frac2.x) * smoothstep(0.0, 1.0, frac2.y) * smoothstep(0.0, 1.0, frac2.z);
    float smooth3 = smoothstep(0.0, 1.0, frac3.x) * smoothstep(0.0, 1.0, frac3.y) * smoothstep(0.0, 1.0, frac3.z);
    
    // Blend directions - balanced for elongated smoke trails
    vec3 streamDir = normalize(
        radialDir * 0.4 +                    // Moderate radial: 20%
        streamDir1 * 1.2 +                   // Main stream: 60% (smooth, elongated)
        streamDir2 * 0.3 * smooth2 +          // Medium variation: 15% (smooth)
        streamDir3 * 0.15 * smooth3            // Fine detail: 7.5% (smooth)
    );
    
    // Moderate per-particle variation - creates natural spread in elongated streams
    vec3 perParticleDir = randomDir(originalCenter);
    vec3 perParticleVariation = perParticleDir * (0.12 + randomSeed * 0.18); // 12-30% variation (natural spread)
    
    // Final scatter direction: smooth elongated stream + natural per-particle spread
    vec3 scatterDir = normalize(streamDir + perParticleVariation);
    
    // Smooth distance variation using trilinear interpolation
    // Use hash interpolation for smooth distance variation
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
    // Smooth distance variation - creates elongated trails
    float streamScatterBase = 0.65 + streamDist1 * 0.5 + streamDist2 * smooth2 * 0.25; // 0.65 to 1.4 (smooth)
    float perParticleVariationDist = 0.75 + randomSeed * 0.75; // Per-particle: 0.75 to 1.25 (natural spread)
    float scatterFactor = streamScatterBase * perParticleVariationDist; // Range: ~0.49 to ~1.75
    scatterFactor = max(0.4, scatterFactor); // Ensure minimum movement
    
    
    if (g_phase == 1.0) {
        // Scattering phase: smooth stream-based dust expansion like natural smoke trails
        float t = (uTime - g_tScatter) / uScatterDuration; // 0 to 1
        t = clamp(t, 0.0, 1.0); // Ensure t is in valid range to prevent flickering
        
        // Slower, more graceful easing - ease-in-out cubic for smooth start and end
        float easedT = t < 0.5 
            ? 4.0 * t * t * t  // Ease-in cubic (slow start)
            : 1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0; // Ease-out cubic (slow end)
        easedT = clamp(easedT, 0.0, 1.0); // Ensure easedT is in valid range
        
        // Smooth speed variation using trilinear interpolation
        float noiseScale1 = 1.2;  // Match the scale from above
        float noiseScale2 = 3.5;
        vec3 noisePos1 = (originalCenter - uCenter) * noiseScale1;
        vec3 noisePos2 = (originalCenter - uCenter) * noiseScale2;
        vec3 i1 = floor(noisePos1);
        vec3 f1 = fract(noisePos1);
        f1 = f1 * f1 * (3.0 - 2.0 * f1); // Smoothstep
        
        // Trilinear interpolation for smooth speed variation
        float s000 = hash(i1);
        float s100 = hash(i1 + vec3(1.0, 0.0, 0.0));
        float s010 = hash(i1 + vec3(0.0, 1.0, 0.0));
        float s110 = hash(i1 + vec3(1.0, 1.0, 0.0));
        float s001 = hash(i1 + vec3(0.0, 0.0, 1.0));
        float s101 = hash(i1 + vec3(1.0, 0.0, 1.0));
        float s011 = hash(i1 + vec3(0.0, 1.0, 1.0));
        float s111 = hash(i1 + vec3(1.0, 1.0, 1.0));
        
        float speedHash1 = mix(
            mix(mix(s000, s100, f1.x), mix(s010, s110, f1.x), f1.y),
            mix(mix(s001, s101, f1.x), mix(s011, s111, f1.x), f1.y),
            f1.z
        );
        
        vec3 frac2 = fract(noisePos2);
        float smooth2 = smoothstep(0.0, 1.0, frac2.x) * smoothstep(0.0, 1.0, frac2.y) * smoothstep(0.0, 1.0, frac2.z);
        float speedHash2 = hash(floor(noisePos2));
        
        // Slower, more uniform speed variation - creates gentle elongated trails
        float speedVariation = 0.95 + speedHash1 * 0.08 + speedHash2 * smooth2 * 0.04; // 0.95 to 1.07 (more uniform, reduced variation)
        float perParticleSpeed = 0.96 + randomSeed * 0.08; // Per-particle: 0.96 to 1.04 (more uniform, reduced variation)
        easedT *= speedVariation * perParticleSpeed;
        easedT = clamp(easedT, 0.0, 1.0); // CRITICAL: Keep within [0,1] to prevent flickering
        
        float scatterAmount = easedT * uScatterDistance * scatterFactor;
        
        // No limit on scatter distance - allow long, thin water mist/dust streams
        // Particles can scatter far from their original position for elongated effect
        
        // Smooth turbulence using trilinear interpolation
        vec3 turbI1 = floor(noisePos1 + vec3(50.0, 0.0, 0.0));
        vec3 turbF1 = fract(noisePos1 + vec3(50.0, 0.0, 0.0));
        turbF1 = turbF1 * turbF1 * (3.0 - 2.0 * turbF1);
        
        vec3 t000 = randomDir(turbI1);
        vec3 t100 = randomDir(turbI1 + vec3(1.0, 0.0, 0.0));
        vec3 t010 = randomDir(turbI1 + vec3(0.0, 1.0, 0.0));
        vec3 t110 = randomDir(turbI1 + vec3(1.0, 1.0, 0.0));
        vec3 t001 = randomDir(turbI1 + vec3(0.0, 0.0, 1.0));
        vec3 t101 = randomDir(turbI1 + vec3(1.0, 0.0, 1.0));
        vec3 t011 = randomDir(turbI1 + vec3(0.0, 1.0, 1.0));
        vec3 t111 = randomDir(turbI1 + vec3(1.0, 1.0, 1.0));
        
        vec3 turbDir1 = normalize(mix(
            mix(mix(t000, t100, turbF1.x), mix(t010, t110, turbF1.x), turbF1.y),
            mix(mix(t001, t101, turbF1.x), mix(t011, t111, turbF1.x), turbF1.y),
            turbF1.z
        ));
        
        vec3 turbDir2 = randomDir(floor(noisePos2 + vec3(100.0, 0.0, 0.0)));
        vec3 streamTurbulence = normalize(turbDir1 * 0.7 + turbDir2 * 0.3 * smooth2) * uNoiseIntensity * easedT * 0.1; // Moderate: 10%
        
        // Natural jitter for organic smoke feel
        vec3 jitter = randomDir(originalCenter + vec3(100.0, 0.0, 0.0)) * uNoiseIntensity * easedT * 0.06; // Moderate: 6%
        
        // Time-based curl for dynamic smoke-like motion - use scatter time for consistency
        float curlHash = speedHash1; // Use smooth interpolated hash
        float scatterTime = g_tScatter + easedT * uScatterDuration; // Current time in scatter phase
        float curlStrength = sin(scatterTime * 0.4 + curlHash * 6.28) * 0.1 * easedT; // Moderate: 10%
        vec3 curlDir = cross(scatterDir, normalize(turbDir1));
        vec3 curl = normalize(curlDir) * curlStrength;
        
        center = originalCenter + scatterDir * scatterAmount + streamTurbulence + jitter + curl;
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
        
        // Calculate base easedT at scatter end using the exact same formula as scatter phase
        float baseEasedT = scatterEndT < 0.5 
            ? 4.0 * scatterEndT * scatterEndT * scatterEndT  // Ease-in cubic (slow start)
            : 1.0 - pow(-2.0 * scatterEndT + 2.0, 3.0) / 2.0; // Ease-out cubic (slow end)
        baseEasedT = clamp(baseEasedT, 0.0, 1.0);
        
        // Reconstruct smooth stream-based scatter direction (same as scatter phase)
        float noiseScale1 = 1.2;  // Match scatter phase
        float noiseScale2 = 3.5;
        float noiseScale3 = 12.0;
        vec3 noisePos1 = (originalCenter - uCenter) * noiseScale1;
        vec3 noisePos2 = (originalCenter - uCenter) * noiseScale2;
        vec3 noisePos3 = (originalCenter - uCenter) * noiseScale3;
        
        // Reconstruct trilinear interpolation
        vec3 i1 = floor(noisePos1);
        vec3 f1 = fract(noisePos1);
        f1 = f1 * f1 * (3.0 - 2.0 * f1);
        
        vec3 d000 = randomDir(i1);
        vec3 d100 = randomDir(i1 + vec3(1.0, 0.0, 0.0));
        vec3 d010 = randomDir(i1 + vec3(0.0, 1.0, 0.0));
        vec3 d110 = randomDir(i1 + vec3(1.0, 1.0, 0.0));
        vec3 d001 = randomDir(i1 + vec3(0.0, 0.0, 1.0));
        vec3 d101 = randomDir(i1 + vec3(1.0, 0.0, 1.0));
        vec3 d011 = randomDir(i1 + vec3(0.0, 1.0, 1.0));
        vec3 d111 = randomDir(i1 + vec3(1.0, 1.0, 1.0));
        
        vec3 streamDir1 = mix(
            mix(mix(d000, d100, f1.x), mix(d010, d110, f1.x), f1.y),
            mix(mix(d001, d101, f1.x), mix(d011, d111, f1.x), f1.y),
            f1.z
        );
        
        vec3 streamDir2 = randomDir(floor(noisePos2));
        vec3 streamDir3 = randomDir(floor(noisePos3));
        vec3 frac2 = fract(noisePos2);
        vec3 frac3 = fract(noisePos3);
        float smooth2 = smoothstep(0.0, 1.0, frac2.x) * smoothstep(0.0, 1.0, frac2.y) * smoothstep(0.0, 1.0, frac2.z);
        float smooth3 = smoothstep(0.0, 1.0, frac3.x) * smoothstep(0.0, 1.0, frac3.y) * smoothstep(0.0, 1.0, frac3.z);
        
        vec3 toSplat = originalCenter - uCenter;
        float distFromCenter = length(toSplat);
        vec3 radialDir = distFromCenter > 0.001 ? normalize(toSplat) : vec3(0.0, 1.0, 0.0);
        // Apply direction sign for bidirectional spray
        float directionSeed = hash(originalCenter + vec3(999.0, 888.0, 777.0));
        float directionSign = (directionSeed > 0.5) ? 1.0 : -1.0;
        radialDir *= directionSign;
        vec3 streamDir = normalize(radialDir * 0.4 + streamDir1 * 1.2 + streamDir2 * 0.3 * smooth2 + streamDir3 * 0.15 * smooth3);
        vec3 perParticleDir = randomDir(originalCenter);
        vec3 perParticleVariation = perParticleDir * (0.12 + randomSeed * 0.18);
        vec3 scatterDir = normalize(streamDir + perParticleVariation);
        
        // Reconstruct scatter phase perturbations (at full strength, easedT = 1.0 equivalent)
        vec3 turbI1 = floor(noisePos1 + vec3(50.0, 0.0, 0.0));
        vec3 turbF1 = fract(noisePos1 + vec3(50.0, 0.0, 0.0));
        turbF1 = turbF1 * turbF1 * (3.0 - 2.0 * turbF1);
        
        vec3 t000 = randomDir(turbI1);
        vec3 t100 = randomDir(turbI1 + vec3(1.0, 0.0, 0.0));
        vec3 t010 = randomDir(turbI1 + vec3(0.0, 1.0, 0.0));
        vec3 t110 = randomDir(turbI1 + vec3(1.0, 1.0, 0.0));
        vec3 t001 = randomDir(turbI1 + vec3(0.0, 0.0, 1.0));
        vec3 t101 = randomDir(turbI1 + vec3(1.0, 0.0, 1.0));
        vec3 t011 = randomDir(turbI1 + vec3(0.0, 1.0, 1.0));
        vec3 t111 = randomDir(turbI1 + vec3(1.0, 1.0, 1.0));
        
        vec3 turbDir1 = normalize(mix(
            mix(mix(t000, t100, turbF1.x), mix(t010, t110, turbF1.x), turbF1.y),
            mix(mix(t001, t101, turbF1.x), mix(t011, t111, turbF1.x), turbF1.y),
            turbF1.z
        ));
        
        vec3 turbDir2 = randomDir(floor(noisePos2 + vec3(100.0, 0.0, 0.0)));
        
        // Reconstruct speed variation to get exact easedT at scatter end
        // Use the SAME noise positions and interpolation as scatter phase
        // CRITICAL: Must use the same i1 and f1 from above (already calculated for scatterDir)
        float s000 = hash(i1);
        float s100 = hash(i1 + vec3(1.0, 0.0, 0.0));
        float s010 = hash(i1 + vec3(0.0, 1.0, 0.0));
        float s110 = hash(i1 + vec3(1.0, 1.0, 0.0));
        float s001 = hash(i1 + vec3(0.0, 0.0, 1.0));
        float s101 = hash(i1 + vec3(1.0, 0.0, 1.0));
        float s011 = hash(i1 + vec3(0.0, 1.0, 1.0));
        float s111 = hash(i1 + vec3(1.0, 1.0, 1.0));
        
        float speedHash1 = mix(
            mix(mix(s000, s100, f1.x), mix(s010, s110, f1.x), f1.y),
            mix(mix(s001, s101, f1.x), mix(s011, s111, f1.x), f1.y),
            f1.z
        );
        
        float speedHash2 = hash(floor(noisePos2));
        float speedVariation = 0.95 + speedHash1 * 0.08 + speedHash2 * smooth2 * 0.04;
        float perParticleSpeed = 0.96 + randomSeed * 0.08;
        float finalEasedT = clamp(baseEasedT * speedVariation * perParticleSpeed, 0.0, 1.0);
        
        // Reconstruct scatter amount with correct finalEasedT
        float scatterAmount = finalEasedT * uScatterDistance * scatterFactor;
        
        // Reconstruct turbulence and jitter with correct finalEasedT
        vec3 streamTurbulence = normalize(turbDir1 * 0.7 + turbDir2 * 0.3 * smooth2) * uNoiseIntensity * finalEasedT * 0.1;
        vec3 jitter = randomDir(originalCenter + vec3(100.0, 0.0, 0.0)) * uNoiseIntensity * finalEasedT * 0.06;
        
        // Reconstruct curl (at scatter phase end time with correct easedT)
        // CRITICAL: Use the same scatterEndTime we calculated above (min(uTime, g_tRecover))
        // This matches scatter phase: scatterTime = g_tScatter + easedT * uScatterDuration
        // But we use scatterEndTime directly to ensure perfect continuity
        float curlHash = speedHash1;
        // Use scatterEndTime (already calculated above) instead of recalculating
        float curlStrength = sin(scatterEndTime * 0.4 + curlHash * 6.28) * 0.1 * finalEasedT;
        vec3 curlDir = cross(scatterDir, normalize(turbDir1));
        vec3 curl = normalize(curlDir) * curlStrength;
        
        // Calculate exact scattered position
        vec3 scatterPos = originalCenter + scatterDir * scatterAmount + streamTurbulence + jitter + curl;
        
        // Direct interpolation from scattered position to original
        center = mix(scatterPos, originalCenter, easedT);
    }
    // Phase 0: before scatter - no modification
    // Phase 3: complete - no modification (already at original)
}

void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
    // Now initialize shared variables using originalCenter for consistent phase calculation
    initShared(originalCenter);
    
    float originalSize = gsplatExtractSize(covA, covB);
    
    // Phase 0.0: Before scatter - 点云 outline 模式（与散射阶段一致）
    if (g_phase == 0.0) {
        gsplatMakeRound(covA, covB, uPointSize);
        return;
    }
    
    // Scattering phase: 点云 outline 模式（与 gsplat-growth-wave 聚拢生长一致）
    if (g_phase == 1.0) {
        gsplatMakeRound(covA, covB, uPointSize);
        return;
    }
    
    // Phase 2.0: Recovering: 从点云 uPointSize 过渡回原始协方差
    if (g_phase == 2.0) {
        float t = (uTime - g_tRecover) / uRecoverDuration;
        t = clamp(t, 0.0, 1.0);
        float easedT = clamp(1.0 - pow(1.0 - t, 4.0), 0.0, 1.0);
        float size = mix(uPointSize, originalSize, easedT);
        vec3 origCovA = covA;
        vec3 origCovB = covB;
        gsplatMakeRound(covA, covB, size);
        covA = mix(covA, origCovA, easedT);
        covB = mix(covB, origCovB, easedT);
        return;
    }
    // Phase 3: original shape (no modification)
}

void modifyColor(vec3 center, inout vec4 color) {
    // Temporarily disabled: all alpha/transparency modifications removed
    // No color modifications are applied
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

fn modifyCenter(center: ptr<function, vec3f>) {
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
    
    // Create SMOOTH stream-based direction using multi-frequency noise for natural smoke trails
    // Use smooth noise instead of hard cell boundaries to avoid blocky patterns
    let toSplat = originalCenter - uniform.uCenter;
    let distFromCenter = length(toSplat);
    var radialDir = select(vec3f(0.0, 1.0, 0.0), normalize(toSplat), distFromCenter > 0.001);
    
    // Determine if this particle sprays outward or inward (50/50 split)
    let directionSeed = hash(originalCenter + vec3f(999.0, 888.0, 777.0));
    let directionSign = select(-1.0, 1.0, directionSeed > 0.5); // 1.0 = outward, -1.0 = inward
    
    // Apply direction sign to create bidirectional spray effect (inward and outward)
    radialDir = radialDir * directionSign;
    
    // Multi-frequency noise for smooth, elongated smoke trails
    // Use LARGER scales for LONGER, more elongated streams (not blocky)
    let noiseScale1 = 1.2;  // Large-scale stream patterns (larger = longer streams)
    let noiseScale2 = 3.5;  // Medium-scale variations
    let noiseScale3 = 12.0;  // Fine-scale details
    
    let noisePos1 = (originalCenter - uniform.uCenter) * noiseScale1;
    let noisePos2 = (originalCenter - uniform.uCenter) * noiseScale2;
    let noisePos3 = (originalCenter - uniform.uCenter) * noiseScale3;
    
    // Use trilinear interpolation for smooth, continuous stream directions
    // This creates elongated trails instead of blocky patterns
    let i1 = floor(noisePos1);
    var f1 = fract(noisePos1);
    f1 = f1 * f1 * (3.0 - 2.0 * f1); // Smoothstep for smoother interpolation
    
    // Sample 8 corners for trilinear interpolation
    let d000 = randomDir(i1);
    let d100 = randomDir(i1 + vec3f(1.0, 0.0, 0.0));
    let d010 = randomDir(i1 + vec3f(0.0, 1.0, 0.0));
    let d110 = randomDir(i1 + vec3f(1.0, 1.0, 0.0));
    let d001 = randomDir(i1 + vec3f(0.0, 0.0, 1.0));
    let d101 = randomDir(i1 + vec3f(1.0, 0.0, 1.0));
    let d011 = randomDir(i1 + vec3f(0.0, 1.0, 1.0));
    let d111 = randomDir(i1 + vec3f(1.0, 1.0, 1.0));
    
    // Trilinear interpolation for smooth stream direction
    let streamDir1 = normalize(mix(
        mix(mix(d000, d100, f1.x), mix(d010, d110, f1.x), f1.y),
        mix(mix(d001, d101, f1.x), mix(d011, d111, f1.x), f1.y),
        f1.z
    ));
    
    // Medium and fine scale variations (simpler interpolation)
    let streamDir2 = randomDir(floor(noisePos2));
    let streamDir3 = randomDir(floor(noisePos3));
    let frac2 = fract(noisePos2);
    let frac3 = fract(noisePos3);
    let smooth2 = smoothstep(0.0, 1.0, frac2.x) * smoothstep(0.0, 1.0, frac2.y) * smoothstep(0.0, 1.0, frac2.z);
    let smooth3 = smoothstep(0.0, 1.0, frac3.x) * smoothstep(0.0, 1.0, frac3.y) * smoothstep(0.0, 1.0, frac3.z);
    
    // Blend directions - balanced for elongated smoke trails
    let streamDir = normalize(
        radialDir * 0.4 +                    // Moderate radial: 20%
        streamDir1 * 1.2 +                   // Main stream: 60% (smooth, elongated)
        streamDir2 * 0.3 * smooth2 +          // Medium variation: 15% (smooth)
        streamDir3 * 0.15 * smooth3            // Fine detail: 7.5% (smooth)
    );
    
    // Moderate per-particle variation - creates natural spread in elongated streams
    let perParticleDir = randomDir(originalCenter);
    let perParticleVariation = perParticleDir * (0.12 + randomSeed * 0.18); // 12-30% variation (natural spread)
    
    // Final scatter direction: smooth elongated stream + natural per-particle spread
    let scatterDir = normalize(streamDir + perParticleVariation);
    
    // Smooth distance variation using trilinear interpolation
    // Use hash interpolation for smooth distance variation
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
    // Smooth distance variation - creates elongated trails
    let streamScatterBase = 0.65 + streamDist1 * 0.5 + streamDist2 * smooth2 * 0.25; // 0.65 to 1.4 (smooth)
    let perParticleVariationDist = 0.75 + randomSeed * 0.5; // Per-particle: 0.75 to 1.25 (natural spread)
    var scatterFactor = streamScatterBase * perParticleVariationDist; // Range: ~0.49 to ~1.75
    scatterFactor = max(0.4, scatterFactor); // Ensure minimum movement
    
    if (g_phase == 1.0) {
        // Scattering phase: smooth stream-based dust expansion like natural smoke trails
        let t = clamp((uniform.uTime - g_tScatter) / uniform.uScatterDuration, 0.0, 1.0); // 0 to 1
        
        // Slower, more graceful easing - ease-in-out cubic for smooth start and end
        var easedT = select(
            1.0 - pow(-2.0 * t + 2.0, 3.0) / 2.0,  // Ease-out cubic (slow end)
            4.0 * t * t * t,                        // Ease-in cubic (slow start)
            t < 0.5
        );
        easedT = clamp(easedT, 0.0, 1.0); // Ensure easedT is in valid range
        
        // Smooth speed variation using trilinear interpolation
        let noiseScale1 = 1.2;  // Match the scale from above
        let noiseScale2 = 3.5;
        let noisePos1 = (originalCenter - uniform.uCenter) * noiseScale1;
        let noisePos2 = (originalCenter - uniform.uCenter) * noiseScale2;
        let i1 = floor(noisePos1);
        var f1 = fract(noisePos1);
        f1 = f1 * f1 * (3.0 - 2.0 * f1); // Smoothstep
        
        // Trilinear interpolation for smooth speed variation
        let s000 = hash(i1);
        let s100 = hash(i1 + vec3f(1.0, 0.0, 0.0));
        let s010 = hash(i1 + vec3f(0.0, 1.0, 0.0));
        let s110 = hash(i1 + vec3f(1.0, 1.0, 0.0));
        let s001 = hash(i1 + vec3f(0.0, 0.0, 1.0));
        let s101 = hash(i1 + vec3f(1.0, 0.0, 1.0));
        let s011 = hash(i1 + vec3f(0.0, 1.0, 1.0));
        let s111 = hash(i1 + vec3f(1.0, 1.0, 1.0));
        
        let speedHash1 = mix(
            mix(mix(s000, s100, f1.x), mix(s010, s110, f1.x), f1.y),
            mix(mix(s001, s101, f1.x), mix(s011, s111, f1.x), f1.y),
            f1.z
        );
        
        let frac2 = fract(noisePos2);
        let smooth2 = smoothstep(0.0, 1.0, frac2.x) * smoothstep(0.0, 1.0, frac2.y) * smoothstep(0.0, 1.0, frac2.z);
        let speedHash2 = hash(floor(noisePos2));
        
        // Slower, more uniform speed variation - creates gentle elongated trails
        let speedVariation = 0.95 + speedHash1 * 0.08 + speedHash2 * smooth2 * 0.04; // 0.95 to 1.07 (more uniform, reduced variation)
        let perParticleSpeed = 0.96 + randomSeed * 0.08; // Per-particle: 0.96 to 1.04 (more uniform, reduced variation)
        easedT *= speedVariation * perParticleSpeed;
        easedT = clamp(easedT, 0.0, 1.0); // CRITICAL: Keep within [0,1] to prevent flickering
        
        let scatterAmount = easedT * uniform.uScatterDistance * scatterFactor;
        
        // No limit on scatter distance - allow long, thin water mist/dust streams
        // Particles can scatter far from their original position for elongated effect
        
        // Smooth turbulence using trilinear interpolation
        let turbI1 = floor(noisePos1 + vec3f(50.0, 0.0, 0.0));
        var turbF1 = fract(noisePos1 + vec3f(50.0, 0.0, 0.0));
        turbF1 = turbF1 * turbF1 * (3.0 - 2.0 * turbF1);
        
        let t000 = randomDir(turbI1);
        let t100 = randomDir(turbI1 + vec3f(1.0, 0.0, 0.0));
        let t010 = randomDir(turbI1 + vec3f(0.0, 1.0, 0.0));
        let t110 = randomDir(turbI1 + vec3f(1.0, 1.0, 0.0));
        let t001 = randomDir(turbI1 + vec3f(0.0, 0.0, 1.0));
        let t101 = randomDir(turbI1 + vec3f(1.0, 0.0, 1.0));
        let t011 = randomDir(turbI1 + vec3f(0.0, 1.0, 1.0));
        let t111 = randomDir(turbI1 + vec3f(1.0, 1.0, 1.0));
        
        let turbDir1 = normalize(mix(
            mix(mix(t000, t100, turbF1.x), mix(t010, t110, turbF1.x), turbF1.y),
            mix(mix(t001, t101, turbF1.x), mix(t011, t111, turbF1.x), turbF1.y),
            turbF1.z
        ));
        
        let turbDir2 = randomDir(floor(noisePos2 + vec3f(100.0, 0.0, 0.0)));
        let streamTurbulence = normalize(turbDir1 * 0.7 + turbDir2 * 0.3 * smooth2) * uniform.uNoiseIntensity * easedT * 0.1; // Moderate: 10%
        
        // Natural jitter for organic smoke feel
        let jitter = randomDir(originalCenter + vec3f(100.0, 0.0, 0.0)) * uniform.uNoiseIntensity * easedT * 0.06; // Moderate: 6%
        
        // Time-based curl for dynamic smoke-like motion - use scatter time for consistency
        let curlHash = speedHash1; // Use smooth interpolated hash
        let scatterTime = g_tScatter + easedT * uniform.uScatterDuration; // Current time in scatter phase
        let curlStrength = sin(scatterTime * 0.4 + curlHash * 6.28) * 0.1 * easedT; // Moderate: 10%
        let curlDir = cross(scatterDir, normalize(turbDir1));
        let curl = normalize(curlDir) * curlStrength;
        
        *center = originalCenter + scatterDir * scatterAmount + streamTurbulence + jitter + curl;
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
        let baseEasedT = select(
            1.0 - pow(-2.0 * scatterEndT + 2.0, 3.0) / 2.0,  // Ease-out cubic (slow end)
            4.0 * scatterEndT * scatterEndT * scatterEndT,    // Ease-in cubic (slow start)
            scatterEndT < 0.5
        );
        baseEasedT = clamp(baseEasedT, 0.0, 1.0);
        
        // Reconstruct smooth stream-based scatter direction (same as scatter phase)
        let noiseScale1 = 1.2;  // Match scatter phase
        let noiseScale2 = 3.5;
        let noiseScale3 = 12.0;
        let noisePos1 = (originalCenter - uniform.uCenter) * noiseScale1;
        let noisePos2 = (originalCenter - uniform.uCenter) * noiseScale2;
        let noisePos3 = (originalCenter - uniform.uCenter) * noiseScale3;
        
        // Reconstruct trilinear interpolation
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
        
        let toSplat = originalCenter - uniform.uCenter;
        let distFromCenter = length(toSplat);
        var radialDir = select(vec3f(0.0, 1.0, 0.0), normalize(toSplat), distFromCenter > 0.001);
        // Apply direction sign for bidirectional spray
        let directionSeed = hash(originalCenter + vec3f(999.0, 888.0, 777.0));
        let directionSign = select(-1.0, 1.0, directionSeed > 0.5);
        radialDir = radialDir * directionSign;
        let streamDir = normalize(radialDir * 0.4 + streamDir1 * 1.2 + streamDir2 * 0.3 * smooth2 + streamDir3 * 0.15 * smooth3);
        let perParticleDir = randomDir(originalCenter);
        let perParticleVariation = perParticleDir * (0.12 + randomSeed * 0.18);
        let scatterDir = normalize(streamDir + perParticleVariation);
        
        // Reconstruct scatter phase perturbations (at full strength, easedT = 1.0 equivalent)
        let turbI1 = floor(noisePos1 + vec3f(50.0, 0.0, 0.0));
        var turbF1 = fract(noisePos1 + vec3f(50.0, 0.0, 0.0));
        turbF1 = turbF1 * turbF1 * (3.0 - 2.0 * turbF1);
        
        let t000 = randomDir(turbI1);
        let t100 = randomDir(turbI1 + vec3f(1.0, 0.0, 0.0));
        let t010 = randomDir(turbI1 + vec3f(0.0, 1.0, 0.0));
        let t110 = randomDir(turbI1 + vec3f(1.0, 1.0, 0.0));
        let t001 = randomDir(turbI1 + vec3f(0.0, 0.0, 1.0));
        let t101 = randomDir(turbI1 + vec3f(1.0, 0.0, 1.0));
        let t011 = randomDir(turbI1 + vec3f(0.0, 1.0, 1.0));
        let t111 = randomDir(turbI1 + vec3f(1.0, 1.0, 1.0));
        
        let turbDir1 = normalize(mix(
            mix(mix(t000, t100, turbF1.x), mix(t010, t110, turbF1.x), turbF1.y),
            mix(mix(t001, t101, turbF1.x), mix(t011, t111, turbF1.x), turbF1.y),
            turbF1.z
        ));
        
        let turbDir2 = randomDir(floor(noisePos2 + vec3f(100.0, 0.0, 0.0)));
        
        // Reconstruct speed variation to get exact easedT at scatter end
        let s000 = hash(i1);
        let s100 = hash(i1 + vec3f(1.0, 0.0, 0.0));
        let s010 = hash(i1 + vec3f(0.0, 1.0, 0.0));
        let s110 = hash(i1 + vec3f(1.0, 1.0, 0.0));
        let s001 = hash(i1 + vec3f(0.0, 0.0, 1.0));
        let s101 = hash(i1 + vec3f(1.0, 0.0, 1.0));
        let s011 = hash(i1 + vec3f(0.0, 1.0, 1.0));
        let s111 = hash(i1 + vec3f(1.0, 1.0, 1.0));
        
        let speedHash1 = mix(
            mix(mix(s000, s100, f1.x), mix(s010, s110, f1.x), f1.y),
            mix(mix(s001, s101, f1.x), mix(s011, s111, f1.x), f1.y),
            f1.z
        );
        
        let speedHash2 = hash(floor(noisePos2));
        let speedVariation = 0.95 + speedHash1 * 0.08 + speedHash2 * smooth2 * 0.04;
        let perParticleSpeed = 0.96 + randomSeed * 0.08;
        let finalEasedT = clamp(baseEasedT * speedVariation * perParticleSpeed, 0.0, 1.0);
        
        // Reconstruct scatter amount with correct finalEasedT
        let scatterAmount = finalEasedT * uniform.uScatterDistance * scatterFactor;
        
        // Reconstruct turbulence and jitter with correct finalEasedT
        let streamTurbulence = normalize(turbDir1 * 0.7 + turbDir2 * 0.3 * smooth2) * uniform.uNoiseIntensity * finalEasedT * 0.1;
        let jitter = randomDir(originalCenter + vec3f(100.0, 0.0, 0.0)) * uniform.uNoiseIntensity * finalEasedT * 0.06;
        
        // Reconstruct curl (at scatter phase end time with correct easedT)
        // CRITICAL: Use the same scatterEndTime we calculated above (min(uTime, g_tRecover))
        // This matches scatter phase: scatterTime = g_tScatter + easedT * uScatterDuration
        // But we use scatterEndTime directly to ensure perfect continuity
        let curlHash = speedHash1;
        // Use scatterEndTime (already calculated above) instead of recalculating
        let curlStrength = sin(scatterEndTime * 0.4 + curlHash * 6.28) * 0.1 * finalEasedT;
        let curlDir = cross(scatterDir, normalize(turbDir1));
        let curl = normalize(curlDir) * curlStrength;
        
        // Calculate exact scattered position
        let scatterPos = originalCenter + scatterDir * scatterAmount + streamTurbulence + jitter + curl;
        
        // Direct interpolation from scattered position to original
        *center = mix(scatterPos, originalCenter, easedT);
    }
    // Phase 0: before scatter - no modification
    // Phase 3: complete - no modification (already at original)
}

fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
    // Now initialize shared variables using originalCenter for consistent phase calculation
    initShared(originalCenter);
    
    let originalSize = gsplatExtractSize(*covA, *covB);
    
    // Phase 0.0: Before scatter - 点云 outline 模式（与散射阶段一致）
    if (g_phase == 0.0) {
        gsplatMakeRound(covA, covB, uniform.uPointSize);
        return;
    }
    
    // Scattering phase: 点云 outline 模式（与 gsplat-growth-wave 聚拢生长一致）
    if (g_phase == 1.0) {
        gsplatMakeRound(covA, covB, uniform.uPointSize);
        return;
    }
    
    // Phase 2.0: Recovering: 从点云 uPointSize 过渡回原始协方差
    if (g_phase == 2.0) {
        let t = clamp((uniform.uTime - g_tRecover) / uniform.uRecoverDuration, 0.0, 1.0);
        let easedT = clamp(1.0 - pow(1.0 - t, 4.0), 0.0, 1.0);
        let size = mix(uniform.uPointSize, originalSize, easedT);
        let origCovA = *covA;
        let origCovB = *covB;
        gsplatMakeRound(covA, covB, size);
        *covA = mix(*covA, origCovA, easedT);
        *covB = mix(*covB, origCovB, easedT);
        return;
    }
    // Phase 3: original shape (no modification)
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    // Temporarily disabled: all alpha/transparency modifications removed
    // No color modifications are applied
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
     * Maximum distance splats scatter from their original positions
     * @attribute
     * @range [0, 50]
     */
    scatterDistance = 10.0; // Increased for longer, thin water mist/dust streams

    /**
     * Duration of scatter phase in seconds
     * @attribute
     * @range [0.1, 10]
     */
    scatterDuration = 7.0; // Slow scatter for dust/liquid stream effect (total 10-15s)

    /**
     * Duration of hold phase in seconds (splats stay at scattered position)
     * @attribute
     * @range [0, 5]
     */
    holdDuration = 0.0; // No hold phase - direct transition

    /**
     * Duration of recover phase in seconds (splats return to original)
     * @attribute
     * @range [0.5, 10]
     */
    recoverDuration = 7.0; // Slow recovery for gradual convergence (total 10-15s)

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
     * Maximum radius particles can scatter to (small radius for dust/liquid stream effect)
     * @attribute
     * @range [0, 50]
     */
    maxScatterRadius = 2.0;

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
        const refRadius = 25;
        const effectivePointSize = this.pointSizeScaleByScene
            ? this.pointSize * Math.max(0.5, Math.min(2, this.endRadius / refRadius))
            : this.pointSize;
        this.setUniform('uPointSize', effectivePointSize);

        // Check if effect is complete
        if (this.isEffectComplete()) {
            console.log('Pieces recover effect completed, disabling');
            this.enabled = false;
            return;
        }
    }

    /**
     * Calculate when the effect is complete.
     * Effect completes when all splats have finished recovering.
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete() {
        // Points start at different times due to wave propagation from center
        // The farthest point will start last, so we need to account for that
        // Use endRadius as reference; when waveSpeedDistScale > 0, 远处有效波速更大，最晚开始时间缩短
        const effectiveSpeedAtEnd = this.waveSpeed * Math.max(1, 1 + this.waveSpeedDistScale * this.endRadius);
        const maxScatterStartTime = this.endRadius / effectiveSpeedAtEnd;
        const maxCompletionTime = maxScatterStartTime + this.scatterDuration + this.recoverDuration;

        return this.effectTime >= maxCompletionTime;
    }
}

export { GsplatRevealPiecesRecover };

