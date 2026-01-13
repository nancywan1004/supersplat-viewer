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
float g_dist;
float g_tScatter;
float g_tRecover;
float g_phase;

void initShared(vec3 center) {
    g_dist = length(center - uCenter);
    
    // All points start scattering at the same time (no wave propagation)
    g_tScatter = 0.0;
    
    // NO HOLDING PHASE - direct transition from scatter to recover
    g_tRecover = g_tScatter + uScatterDuration;
    g_phase = 0.0;
    
    // Determine current phase (only 3 phases now: before, scatter, recover)
    if (uTime < g_tScatter) {
        g_phase = 0.0; // Before scatter
    } else if (uTime < g_tRecover) {
        g_phase = 1.0; // Scattering
    } else if (uTime < g_tRecover + uRecoverDuration) {
        g_phase = 2.0; // Recovering (was phase 3)
    } else {
        g_phase = 3.0; // Complete (was phase 4)
    }
}

void modifyCenter(inout vec3 center) {
    vec3 originalCenter = center;
    initShared(center);
    
    // All particles participate in the effect, regardless of distance
    // Only skip if effect is complete
    if (g_phase >= 3.0) {
        return;
    }
    
    // Generate per-splat random values for stream-based dust effect
    float randomSeed = hash(originalCenter);
    float randomSeed2 = hash(originalCenter + vec3(10.0, 20.0, 30.0));
    float randomSeed3 = hash(originalCenter + vec3(50.0, 100.0, 150.0));
    
    // Create SMOOTH stream-based direction using multi-frequency noise for natural smoke trails
    // Use smooth noise instead of hard cell boundaries to avoid blocky patterns
    vec3 toSplat = originalCenter - uCenter;
    float distFromCenter = length(toSplat);
    vec3 radialDir = distFromCenter > 0.001 ? normalize(toSplat) : vec3(0.0, 1.0, 0.0);
    
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
    float perParticleVariationDist = 0.75 + randomSeed * 0.5; // Per-particle: 0.75 to 1.25 (natural spread)
    float scatterFactor = streamScatterBase * perParticleVariationDist; // Range: ~0.49 to ~1.75
    scatterFactor = max(0.4, scatterFactor); // Ensure minimum movement
    
    if (g_phase == 1.0) {
        // Scattering phase: smooth stream-based dust expansion like natural smoke trails
        float t = (uTime - g_tScatter) / uScatterDuration; // 0 to 1
        
        // Smooth easing for natural acceleration
        float easedT = t * t * (3.0 - 2.0 * t); // Smoothstep: slow start, slow end
        
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
        
        // Smooth speed variation - creates elongated trails
        float speedVariation = 0.85 + speedHash1 * 0.3 + speedHash2 * smooth2 * 0.15; // 0.85 to 1.3 (smooth)
        float perParticleSpeed = 0.88 + randomSeed * 0.24; // Per-particle: 0.88 to 1.12 (natural spread)
        easedT *= speedVariation * perParticleSpeed;
        easedT = clamp(easedT, 0.0, 1.4);
        
        float scatterAmount = easedT * uScatterDistance * scatterFactor;
        
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
        
        // Time-based curl for dynamic smoke-like motion
        float curlHash = speedHash1; // Use smooth interpolated hash
        float curlStrength = sin(uTime * 0.4 + curlHash * 6.28) * 0.1 * easedT; // Moderate: 10%
        vec3 curlDir = cross(scatterDir, normalize(turbDir1));
        vec3 curl = normalize(curlDir) * curlStrength;
        
        center = originalCenter + scatterDir * scatterAmount + streamTurbulence + jitter + curl;
    } else if (g_phase == 2.0) {
        // Recovering phase: CLEAN and DIRECT return to original position
        float t = (uTime - g_tRecover) / uRecoverDuration; // 0 to 1
        
        // Use smooth ease-out curve for natural deceleration
        float easedT = 1.0 - pow(1.0 - t, 3.0);
        
        // Reconstruct scatter phase end position (must match scatter phase calculation)
        float scatterAmount = uScatterDistance * scatterFactor;
        
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
        vec3 streamTurbulence = normalize(turbDir1 * 0.7 + turbDir2 * 0.3 * smooth2) * uNoiseIntensity * 0.1;
        vec3 jitter = randomDir(originalCenter + vec3(100.0, 0.0, 0.0)) * uNoiseIntensity * 0.06;
        
        // Reconstruct curl (at scatter phase end time)
        float h000 = hash(i1);
        float h100 = hash(i1 + vec3(1.0, 0.0, 0.0));
        float h010 = hash(i1 + vec3(0.0, 1.0, 0.0));
        float h110 = hash(i1 + vec3(1.0, 1.0, 0.0));
        float h001 = hash(i1 + vec3(0.0, 0.0, 1.0));
        float h101 = hash(i1 + vec3(1.0, 0.0, 1.0));
        float h011 = hash(i1 + vec3(0.0, 1.0, 1.0));
        float h111 = hash(i1 + vec3(1.0, 1.0, 1.0));
        
        float curlHash = mix(
            mix(mix(h000, h100, f1.x), mix(h010, h110, f1.x), f1.y),
            mix(mix(h001, h101, f1.x), mix(h011, h111, f1.x), f1.y),
            f1.z
        );
        
        float curlStrength = sin((g_tScatter + uScatterDuration) * 0.4 + curlHash * 6.28) * 0.1;
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
    // Use originalCenter to calculate distance - particles should be judged by original position
    float distFromOriginal = length(originalCenter - uCenter);
    bool isWithinRange = distFromOriginal <= uEndRadius;
    
    // Now initialize shared variables using modifiedCenter for phase calculation
    initShared(modifiedCenter);
    
    // Before scatter: only hide particles within range
    // Distant particles remain visible and will participate in the effect
    if (g_phase < 1.0) {
        if (isWithinRange) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
        // Distant particles: remain visible before scatter starts
        return; // Keep original shape
    }
    
    // All particles participate in the effect (both within and outside range)
    
    // During all phases, show the splats (much smaller during scatter for "explosion" effect)
    float originalSize = gsplatExtractSize(covA, covB);
    
    if (g_phase == 1.0) {
        // Scattering: make particles VERY small (10-25% of original) for dust/powder effect
        // Use per-splat variation for more chaotic effect
        float randomSeed = hash(originalCenter);
        float sizeFactor = 0.10 + randomSeed * 0.15; // 0.10 to 0.25 (10% to 25% of original)
        float size = originalSize * sizeFactor;
        // Make them round for dust particle appearance
        gsplatMakeRound(covA, covB, size);
    } else if (g_phase == 2.0) {
        // Recovering: gradually restore original size and shape
        float t = (uTime - g_tRecover) / uRecoverDuration;
        float randomSeed = hash(originalCenter);
        float minSizeFactor = 0.10 + randomSeed * 0.15; // Same as scatter phase
        float size = mix(originalSize * minSizeFactor, originalSize, t);
        
        // Lerp from round to original shape
        vec3 origCovA = covA;
        vec3 origCovB = covB;
        gsplatMakeRound(covA, covB, size);
        covA = mix(covA, origCovA, t);
        covB = mix(covB, origCovB, t);
    }
    // Phase 3: original shape (no modification)
}

void modifyColor(vec3 center, inout vec4 color) {
    // All particles participate in the effect, regardless of distance
    // Initialize shared variables for phase calculation
    initShared(center);
    
    // Adjust alpha (transparency) for powder-like effect
    if (g_phase == 1.0) {
        // Scattering phase: gradually increase transparency (become more powdery)
        float t = (uTime - g_tScatter) / uScatterDuration;
        // Reduce alpha to 40-60% for powder effect, with variation per splat
        float randomSeed = hash(center);
        float minAlpha = 0.4 + randomSeed * 0.2; // 0.4 to 0.6
        color.a *= mix(1.0, minAlpha, t * t); // Ease-in to transparency
    } else if (g_phase == 2.0) {
        // Recovering phase: gradually restore original opacity
        float t = (uTime - g_tRecover) / uRecoverDuration;
        float randomSeed = hash(center);
        float minAlpha = 0.4 + randomSeed * 0.2; // 0.4 to 0.6
        color.a *= mix(minAlpha, 1.0, t); // Fade back to full opacity
    }
    // Phase 0 and 3: original opacity (no modification)
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
var<private> g_dist: f32;
var<private> g_tScatter: f32;
var<private> g_tRecover: f32;
var<private> g_phase: f32;

fn initShared(center: vec3f) {
    g_dist = length(center - uniform.uCenter);
    
    // All points start scattering at the same time (no wave propagation)
    g_tScatter = 0.0;
    
    // NO HOLDING PHASE - direct transition from scatter to recover
    g_tRecover = g_tScatter + uniform.uScatterDuration;
    g_phase = 0.0;
    
    // Determine current phase (only 3 phases now: before, scatter, recover)
    if (uniform.uTime < g_tScatter) {
        g_phase = 0.0; // Before scatter
    } else if (uniform.uTime < g_tRecover) {
        g_phase = 1.0; // Scattering
    } else if (uniform.uTime < g_tRecover + uniform.uRecoverDuration) {
        g_phase = 2.0; // Recovering (was phase 3)
    } else {
        g_phase = 3.0; // Complete (was phase 4)
    }
}

fn modifyCenter(center: ptr<function, vec3f>) {
    let originalCenter = *center;
    initShared(*center);
    
    // All particles participate in the effect, regardless of distance
    // Only skip if effect is complete
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
    let radialDir = select(vec3f(0.0, 1.0, 0.0), normalize(toSplat), distFromCenter > 0.001);
    
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
        let t = (uniform.uTime - g_tScatter) / uniform.uScatterDuration; // 0 to 1
        
        // Smooth easing for natural acceleration
        var easedT = t * t * (3.0 - 2.0 * t); // Smoothstep: slow start, slow end
        
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
        
        // Smooth speed variation - creates elongated trails
        let speedVariation = 0.85 + speedHash1 * 0.3 + speedHash2 * smooth2 * 0.15; // 0.85 to 1.3 (smooth)
        let perParticleSpeed = 0.88 + randomSeed * 0.24; // Per-particle: 0.88 to 1.12 (natural spread)
        easedT *= speedVariation * perParticleSpeed;
        easedT = clamp(easedT, 0.0, 1.4);
        
        let scatterAmount = easedT * uniform.uScatterDistance * scatterFactor;
        
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
        
        // Time-based curl for dynamic smoke-like motion
        let curlHash = speedHash1; // Use smooth interpolated hash
        let curlStrength = sin(uniform.uTime * 0.4 + curlHash * 6.28) * 0.1 * easedT; // Moderate: 10%
        let curlDir = cross(scatterDir, normalize(turbDir1));
        let curl = normalize(curlDir) * curlStrength;
        
        *center = originalCenter + scatterDir * scatterAmount + streamTurbulence + jitter + curl;
    } else if (g_phase == 2.0) {
        // Recovering phase: CLEAN and DIRECT return to original position
        let t = (uniform.uTime - g_tRecover) / uniform.uRecoverDuration; // 0 to 1
        
        // Use smooth ease-out curve for natural deceleration
        let easedT = 1.0 - pow(1.0 - t, 3.0);
        
        // Reconstruct scatter phase end position (must match scatter phase calculation)
        let scatterAmount = uniform.uScatterDistance * scatterFactor;
        
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
        let radialDir = select(vec3f(0.0, 1.0, 0.0), normalize(toSplat), distFromCenter > 0.001);
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
        let streamTurbulence = normalize(turbDir1 * 0.7 + turbDir2 * 0.3 * smooth2) * uniform.uNoiseIntensity * 0.1;
        let jitter = randomDir(originalCenter + vec3f(100.0, 0.0, 0.0)) * uniform.uNoiseIntensity * 0.06;
        
        // Reconstruct curl (at scatter phase end time)
        let h000 = hash(i1);
        let h100 = hash(i1 + vec3f(1.0, 0.0, 0.0));
        let h010 = hash(i1 + vec3f(0.0, 1.0, 0.0));
        let h110 = hash(i1 + vec3f(1.0, 1.0, 0.0));
        let h001 = hash(i1 + vec3f(0.0, 0.0, 1.0));
        let h101 = hash(i1 + vec3f(1.0, 0.0, 1.0));
        let h011 = hash(i1 + vec3f(0.0, 1.0, 1.0));
        let h111 = hash(i1 + vec3f(1.0, 1.0, 1.0));
        
        let curlHash = mix(
            mix(mix(h000, h100, f1.x), mix(h010, h110, f1.x), f1.y),
            mix(mix(h001, h101, f1.x), mix(h011, h111, f1.x), f1.y),
            f1.z
        );
        
        let curlStrength = sin((g_tScatter + uniform.uScatterDuration) * 0.4 + curlHash * 6.28) * 0.1;
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
    // Use originalCenter to calculate distance - particles should be judged by original position
    let distFromOriginal = length(originalCenter - uniform.uCenter);
    let isWithinRange = distFromOriginal <= uniform.uEndRadius;
    
    // Now initialize shared variables using modifiedCenter for phase calculation
    initShared(modifiedCenter);
    
    // Before scatter: only hide particles within range
    // Distant particles remain visible and will participate in the effect
    if (g_phase < 1.0) {
        if (isWithinRange) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
        // Distant particles: remain visible before scatter starts
        return; // Keep original shape
    }
    
    // All particles participate in the effect (both within and outside range)
    
    // During all phases, show the splats (much smaller during scatter for "explosion" effect)
    let originalSize = gsplatExtractSize(*covA, *covB);
    
    if (g_phase == 1.0) {
        // Scattering: make particles VERY small (10-25% of original) for dust/powder effect
        // Use per-splat variation for more chaotic effect
        let randomSeed = hash(originalCenter);
        let sizeFactor = 0.10 + randomSeed * 0.15; // 0.10 to 0.25 (10% to 25% of original)
        let size = originalSize * sizeFactor;
        // Make them round for dust particle appearance
        gsplatMakeRound(covA, covB, size);
    } else if (g_phase == 2.0) {
        // Recovering: gradually restore original size and shape
        let t = (uniform.uTime - g_tRecover) / uniform.uRecoverDuration;
        let randomSeed = hash(originalCenter);
        let minSizeFactor = 0.10 + randomSeed * 0.15; // Same as scatter phase
        let size = mix(originalSize * minSizeFactor, originalSize, t);
        
        // Lerp from round to original shape
        let origCovA = *covA;
        let origCovB = *covB;
        gsplatMakeRound(covA, covB, size);
        *covA = mix(*covA, origCovA, t);
        *covB = mix(*covB, origCovB, t);
    }
    // Phase 3: original shape (no modification)
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    // All particles participate in the effect, regardless of distance
    // Initialize shared variables for phase calculation
    initShared(center);
    
    // Adjust alpha (transparency) for powder-like effect
    if (g_phase == 1.0) {
        // Scattering phase: gradually increase transparency (become more powdery)
        let t = (uniform.uTime - g_tScatter) / uniform.uScatterDuration;
        // Reduce alpha to 40-60% for powder effect, with variation per splat
        let randomSeed = hash(center);
        let minAlpha = 0.4 + randomSeed * 0.2; // 0.4 to 0.6
        (*color).a *= mix(1.0, minAlpha, t * t); // Ease-in to transparency
    } else if (g_phase == 2.0) {
        // Recovering phase: gradually restore original opacity
        let t = (uniform.uTime - g_tRecover) / uniform.uRecoverDuration;
        let randomSeed = hash(center);
        let minAlpha = 0.4 + randomSeed * 0.2; // 0.4 to 0.6
        (*color).a *= mix(minAlpha, 1.0, t); // Fade back to full opacity
    }
    // Phase 0 and 3: original opacity (no modification)
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

    /**
     * Origin point for the effect
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
     * @range [0, 20]
     */
    scatterDistance = 5.0;

    /**
     * Duration of scatter phase in seconds
     * @attribute
     * @range [0.1, 5]
     */
    scatterDuration = 2.0; // Increased from 1.0 to 2.0 for more visible expansion

    /**
     * Duration of hold phase in seconds (splats stay at scattered position)
     * @attribute
     * @range [0.2, 2]
     */
    holdDuration = 0;

    /**
     * Duration of recover phase in seconds (splats return to original)
     * @attribute
     * @range [0.5, 5]
     */
    recoverDuration = 2.0; // Increased from 1.5 to 2.0 for smoother recovery

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

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // Update all uniforms
        this.setUniform('uTime', effectTime);

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
        // All points start at the same time, so completion time is:
        // scatter + recover (NO holding phase)
        const maxCompletionTime = this.scatterDuration + this.recoverDuration;

        return this.effectTime >= maxCompletionTime;
    }
}

export { GsplatRevealPiecesRecover };

