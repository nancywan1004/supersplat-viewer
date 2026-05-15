import { Color, Vec3 } from 'playcanvas';
import { GsplatShaderEffect } from '../gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform vec3 uCenter;
uniform float uGrowthSpeed;
uniform float uGrowthDuration;
uniform float uRecoverDuration;
uniform float uNoiseIntensity;
uniform float uScatterDistance;
uniform float uMinSize;
uniform float uPointSize;   // 点云阶段固定点大小（参考 splat-overlay-shader 的 splatSize）
uniform float uPointSizeAdaptiveScale; // 点大小自适应缩放倍数（0-10），远处点自动放大
uniform vec3 uViewPos; // 当前相机世界坐标（用于屏幕可见性地板）
uniform float uMinSizeByViewDistSlope; // 最小可见像素换算的世界尺寸斜率 size ~= dist * slope
uniform float uScreenFloorMaxScale; // 视距地板对 uPointSize 的最大放大倍数（防近景过糊）
uniform float uSceneDensityNorm; // 场景密度归一化（0=稀疏，1=密集）
uniform float uSceneDensityInfluence; // 密度补偿影响强度
uniform float uEndRadius;
uniform float uGlobalRecoverStart;
uniform float uBottomY;
uniform float uTopY;
uniform float uEdgeAreaMin;
uniform float uEdgeAreaMax;
uniform float uEdgeAnisoMin;
uniform float uVerticalSpread;
uniform vec3 uPhase1CloudTint; // Phase1 点云/蓝辉 additive 色
uniform vec3 uPhase2HaloTint;  // Phase2 金环 additive 色

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

// Smooth interpolation function (smoothstep)
float smoothInterp(float t) {
    return t * t * (3.0 - 2.0 * t);
}

// Gradient noise (Perlin-like) for smooth, continuous noise field
vec3 gradientNoise(vec3 p) {
    vec3 i = floor(p);
    vec3 f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // smoothstep
    
    // Sample 8 corners
    vec3 d000 = randomDir(i);
    vec3 d100 = randomDir(i + vec3(1.0, 0.0, 0.0));
    vec3 d010 = randomDir(i + vec3(0.0, 1.0, 0.0));
    vec3 d110 = randomDir(i + vec3(1.0, 1.0, 0.0));
    vec3 d001 = randomDir(i + vec3(0.0, 0.0, 1.0));
    vec3 d101 = randomDir(i + vec3(1.0, 0.0, 1.0));
    vec3 d011 = randomDir(i + vec3(0.0, 1.0, 1.0));
    vec3 d111 = randomDir(i + vec3(1.0, 1.0, 1.0));
    
    // Trilinear interpolation
    vec3 result = mix(
        mix(mix(d000, d100, f.x), mix(d010, d110, f.x), f.y),
        mix(mix(d001, d101, f.x), mix(d011, d111, f.x), f.y),
        f.z
    );
    
    return normalize(result);
}

// Fractal Brownian Motion (fBM) - multi-frequency noise
vec3 fbmNoise(vec3 p, float time) {
    // Combine multiple frequencies for smooth, flowing noise
    float scale1 = 0.8;
    float scale2 = 2.5;
    float scale3 = 6.0;
    
    // Add time-based flow
    vec3 p1 = p * scale1 + vec3(0.0, 0.0, time * 0.3);
    vec3 p2 = p * scale2 + vec3(0.0, 0.0, time * 0.5);
    vec3 p3 = p * scale3 + vec3(0.0, 0.0, time * 0.8);
    
    vec3 n1 = gradientNoise(p1);
    vec3 n2 = gradientNoise(p2);
    vec3 n3 = gradientNoise(p3);
    
    // Combine with decreasing weights (lower frequencies have more influence)
    vec3 result = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
    return normalize(result);
}

// Shared globals
float g_dist;
float g_yOffset;
float g_wavePhase;
float g_growthProgress;
float g_tRecoverStart;
float g_tRecoverEnd;
float g_recoverProgress;
float g_recoverRadius;       // Phase 2 复原带中心半径
float g_recoverWaveFront;    // Phase 2 复原波前半径（外缘，复原波刚扫到此处），金环对齐此处与几何同步
float g_phase;

void initShared(vec3 center) {
    g_dist = length(center - uCenter);
    
    // Calculate Y offset from bottom (bottom-up growth)
    // Note: Due to Y-axis inversion in coordinate system, larger Y values are visually at the bottom
    // So for bottom-to-top growth, we calculate offset from bottomY
    // Bottom particles (center.y close to bottomY, larger Y value) have small yOffset, start first
    // Use uBottomY - center.y (inverse of integrate effect) to make bottom start first
    g_yOffset = center.y - uBottomY;
    
    // Growth phase: wave propagation from bottom to top
    // Similar to integrate effect, but from bottom to top
    // Calculate wave phase: time progresses, wave propagates upward
    // Bottom particles (small yOffset) have wavePhase reach threshold first
    float timeScaled = uTime * uGrowthSpeed;
    // For bottom-up: bottom has yOffset=0, top has large yOffset
    // Wave phase = time - yOffset * spread, so bottom (yOffset=0) starts first
    // Use uVerticalSpread uniform instead of calculating it, so it can be controlled by totalDuration
    g_wavePhase = timeScaled - g_yOffset * uVerticalSpread;
    
    // Growth progress: 0 = not reached, 1 = fully grown
    // Use smoothstep for smooth transition
    g_growthProgress = smoothstep(0.0, uGrowthDuration, g_wavePhase);
    g_growthProgress = clamp(g_growthProgress, 0.0, 1.0);
    
    // Recover phase: wait for ALL particles to finish growing before starting recovery
    // Recovery also propagates from bottom to top
    // Top particle has largest yOffset = abs(uBottomY - uTopY) (since uBottomY > uTopY due to Y-axis inversion)
    // For the top particle: g_wavePhase = timeScaled - maxYOffset * uVerticalSpread
    // When g_wavePhase >= uGrowthDuration, the top particle finishes growing
    // So: timeScaled - maxYOffset * uVerticalSpread >= uGrowthDuration
    //     uTime * uGrowthSpeed >= uGrowthDuration + maxYOffset * uVerticalSpread
    //     uTime >= (uGrowthDuration + maxYOffset * uVerticalSpread) / uGrowthSpeed
    // But we want to start recovery as soon as the last particle finishes, so:
    float maxYOffset = abs(uBottomY - uTopY);
    float topParticleGrowthEnd = (uGrowthDuration + maxYOffset * uVerticalSpread) / uGrowthSpeed;
    g_tRecoverStart = topParticleGrowthEnd;
    
    g_tRecoverEnd = g_tRecoverStart + uRecoverDuration;
    
    g_phase = 0.0;
    
    // Determine current phase (Phase 2 仅按时间判定)
    if (g_wavePhase < 0.0) {
        g_phase = 0.0; // Hidden
    } else if (uTime < g_tRecoverStart) {
        g_phase = 1.0; // Phase 1: 聚拢生长
    } else if (uTime < g_tRecoverEnd) {
        g_phase = 2.0; // Phase 2: 从中心向外光圈过渡复原
    } else {
        g_phase = 3.0; // Complete
    }
    
    // Phase 2: 从视点 target 中心向外光圈过渡复原，g_recoverProgress = 光圈内已复原
    if (g_phase == 2.0) {
        float recoverRadius = ((uTime - g_tRecoverStart) / uRecoverDuration) * uEndRadius;
        float recoverBand = uEndRadius * 0.05;
        g_recoverRadius = recoverRadius;
        g_recoverWaveFront = recoverRadius + recoverBand;   // 波前在外缘，金环对齐波前才不滞后
        g_recoverProgress = 1.0 - smoothstep(recoverRadius - recoverBand, recoverRadius + recoverBand, g_dist);
        g_recoverProgress = clamp(g_recoverProgress, 0.0, 1.0);
    } else {
        g_recoverProgress = 0.0;
        g_recoverRadius = 0.0;
        g_recoverWaveFront = 0.0;
    }
}

void modifySplatCenter(inout vec3 center) {
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
        // Growth phase: 聚拢生长粒子特效
        // 核心原则：聚拢是主趋势，噪声扰动路径，最终严格到达目标位置
        
        // 当这个粒子的生长阶段真正完成时（g_growthProgress >= 1.0），
        // 直接设置为原始位置并返回，不再执行任何噪声计算
        // 这样可以确保 Phase 1 结束后粒子稳定停留在原始位置，不会乱飘
        if (g_growthProgress >= 1.0) {
            center = originalCenter;
            return;
        }
        
        // 计算径向距离和方向
        vec3 toSplat = originalCenter - uCenter;
        float distFromCenter = length(toSplat);
        vec3 radialOut = distFromCenter > 0.001 ? normalize(toSplat) : vec3(1.0, 0.0, 0.0);
        
        // 聚拢进度：使用慢启动缓动曲线
        float easedProgress = pow(g_growthProgress, 0.4);
        
        // 计算聚拢距离
        float baseScatterDistance = uScatterDistance * 15.0;
        float distanceBasedMultiplier = 1.0 + distFromCenter * 0.2;
        float maxScatterDistance = baseScatterDistance * distanceBasedMultiplier;
        
        // 主收敛路径：从外部到目标位置的径向路径
        vec3 startPos = originalCenter + radialOut * maxScatterDistance;
        vec3 targetPos = originalCenter; // 最终必须严格到达这里
        
        // 主收敛路径上的当前位置（无扰动）
        float currentScatterDistance = maxScatterDistance * (1.0 - easedProgress);
        vec3 mainConvergePos = originalCenter + radialOut * currentScatterDistance;
        
        // 噪声场扰动：使用fBM噪声来扰动路径
        // 增强烟雾扰动效果：增大扰动强度和轮廓
        // 噪声强度随聚拢过程逐渐减弱（初期烟雾感强，末期稳定）
        float noiseIntensity = (1.0 - easedProgress) * (1.0 - easedProgress); // 二次衰减，初期强，末期弱
        noiseIntensity *= 10.0; // 增加50%的基础强度
        
        // 计算噪声采样位置（空间+时间）
        // 使用更大的空间尺度，产生更大的烟雾轮廓
        vec3 noisePos = (originalCenter - uCenter) * 0.3; // 降低空间频率，增大轮廓
        float noiseTime = uTime * 0.6; // 增加时间流动速度，增强飘动感
        
        // 获取噪声方向（低频、连续、随时间流动）
        // 使用多层噪声增强烟雾的复杂性和飘动感
        vec3 noiseDir = fbmNoise(noisePos, noiseTime);
        
        // 添加额外的低频噪声层，增强大范围飘动
        vec3 noisePos2 = (originalCenter - uCenter) * 0.15 + vec3(0.0, 0.0, noiseTime * 0.2);
        vec3 noiseDir2 = fbmNoise(noisePos2, noiseTime * 0.5);
        noiseDir = normalize(noiseDir * 0.7 + noiseDir2 * 0.3); // 混合两层噪声
        
        // 构建切向和法向空间（用于侧向扰动）
        vec3 upAxis = vec3(0.0, 1.0, 0.0);
        vec3 tangential = normalize(cross(upAxis, radialOut));
        if (length(tangential) < 0.001) {
            tangential = vec3(0.0, 0.0, 1.0);
        }
        vec3 normal = cross(radialOut, tangential);
        
        // 将噪声方向投影到切向和法向空间（侧向扰动，不影响径向收敛）
        float tangentialNoise = dot(noiseDir, tangential);
        float normalNoise = dot(noiseDir, normal);
        
        // 计算扰动偏移（作用在路径上，不是最终结果）
        // 增大扰动距离：增强烟雾扰动的轮廓
        float perturbationDistance = currentScatterDistance * noiseIntensity * 10.0; // 从0.8增加到1.5
        vec3 perturbation = tangential * tangentialNoise * perturbationDistance + 
                           normal * normalNoise * perturbationDistance;
        
        // 添加更强的径向相位扰动（距离延迟），增强飘动感
        float phaseNoise = dot(noiseDir, radialOut) * 1.5; // 从0.3增加到0.5
        float phaseOffset = phaseNoise * noiseIntensity * currentScatterDistance * 1.2; // 从0.2增加到0.4
        vec3 phasePerturbation = radialOut * phaseOffset;
        
        // 添加额外的垂直扰动，增强烟雾的上升飘动感
        float verticalNoise = dot(noiseDir, upAxis);
        vec3 verticalPerturbation = upAxis * verticalNoise * noiseIntensity * currentScatterDistance * 0.3;
        perturbation += verticalPerturbation;
        
        // 最终位置 = 主收敛路径 + 噪声偏移（随时间衰减）
        vec3 finalPos = mainConvergePos + perturbation + phasePerturbation;
        
        // 确保最终位置在聚拢完成时严格到达目标位置
        // 当easedProgress接近1时，噪声强度接近0，位置接近targetPos
        center = mix(startPos, finalPos, easedProgress);
        
    } else if (g_phase == 2.0) {
        // Phase 2: 从视点 target 中心向外光圈过渡复原，无位置动画，保持原始位置
        center = originalCenter;
    }
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    initShared(originalCenter);
    
    vec3 originalScale = scale;
    float originalSize = gsplatGetSizeFromScale(scale);
    
    if (g_phase == 0.0) {
        gsplatMakeSpherical(scale, originalSize * 0.001);
        return;
    }
    if (g_phase == 1.0) {
        if (g_growthProgress <= 0.0) {
            gsplatMakeSpherical(scale, originalSize * 0.001);
            return;
        }
        // Phase 1 自适应点大小：远处点自动放大，近处点保持小尺寸
        // normalizedDistance: 0 = 中心附近(近), 1 = 最远处
        float normalizedDistance = clamp(g_dist / max(uEndRadius, 1.0), 0.0, 1.0);
        // adaptiveSize = pointSize * (1.0 + normalizedDistance * adaptiveScale)
        // 近处: ~uPointSize, 远处: uPointSize * (1.0 + adaptiveScale)
        float adaptiveSize = uPointSize * (1.0 + normalizedDistance * uPointSizeAdaptiveScale);
        // 场景密度补偿（强作用版）：稀疏场景放大，密集场景收缩
        float densityT = clamp((uSceneDensityNorm - 0.5) * uSceneDensityInfluence + 0.5, 0.0, 1.0);
        float densitySizeMul = mix(1.42, 0.62, densityT);
        adaptiveSize *= densitySizeMul;
        // 屏幕可见性地板：避免远处点掉到亚像素导致“相机拉近才看见”
        float camDist = length(originalCenter - uViewPos);
        float minVisibleSize = clamp(camDist * uMinSizeByViewDistSlope, uPointSize * 0.85, uPointSize * uScreenFloorMaxScale);
        adaptiveSize = max(adaptiveSize, minVisibleSize);
        gsplatMakeSpherical(scale, adaptiveSize);
        return;
    }
    if (g_phase == 2.0) {
        if (g_recoverProgress <= 0.0) {
            gsplatMakeSpherical(scale, uPointSize);
            return;
        }
        float easedT = clamp(1.0 - pow(1.0 - g_recoverProgress, 4.0), 0.0, 1.0);
        // 直接对 scale 向量插值：从点大小过渡回原始各向异性，避免整段用球形导致的模糊感
        vec3 pointScale = vec3(uPointSize);
        scale = mix(pointScale, originalScale, easedT);
        return;
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {
    initShared(center);
    
    if ((g_phase == 1.0 && g_growthProgress > 0.0) || (g_phase == 2.0 && g_recoverProgress < 1.0)) {
        float glowIntensity = 1.0;
        float progressGlow = 1.0;
        
        if (g_phase == 1.0) {
            if (g_growthProgress > 0.9) {
                progressGlow = 1.0 - (g_growthProgress - 0.9) * 2.0;
            }
            progressGlow = max(progressGlow, 0.8);
        } else if (g_phase == 2.0) {
            progressGlow = 1.0 - g_recoverProgress;
            progressGlow = max(progressGlow, 0.0);
        }
        
        vec3 toSplat = center - uCenter;
        float distFromCenter = length(toSplat);
        float normalizedDist = distFromCenter / max(uEndRadius, 1.0);
        // 光晕更大：离中心较远的区域也保留较多辉光（软衰减范围加大）
        float distanceGlow = 1.0 + (1.0 - smoothstep(0.0, 0.85, normalizedDist)) * 0.7;
        float densityT = clamp((uSceneDensityNorm - 0.5) * uSceneDensityInfluence + 0.5, 0.0, 1.0);
        float sceneGlowFactor = mix(1.22, 0.42, densityT);
        
        glowIntensity = progressGlow * distanceGlow * sceneGlowFactor;
        glowIntensity = clamp(glowIntensity, 0.0, 1.6);
        
        vec3 blueGlow = uPhase1CloudTint;
        // 仅 Phase 1 加蓝辉光；Phase 2 不加，避免未复原区整片发蓝导致光圈显得很宽
        if (g_phase == 1.0) {
            color.rgb += blueGlow * glowIntensity * 0.58;
        }
        
        // Phase 1 聚拢：光圈从下扫到上。主带偏白 (0.95,1,1)，扫描辉光偏蓝 blueGlow，整体白蓝色。收窄宽度 + 收紧柔光 = 更明显光环
        if (g_phase == 1.0 && g_growthProgress > 0.0 && g_growthProgress < 1.0) {
            float phase1Progress = clamp(uTime / g_tRecoverStart, 0.0, 1.0);
            float ringY = mix(uBottomY, uTopY, phase1Progress);
            float sceneHeight = abs(uBottomY - uTopY);
            float ringWidth = max(2.0, sceneHeight * 0.06);   // 收窄：0.18 -> 0.06，光环更细
            float distToRing = abs(center.y - ringY);
            float ringBand = 1.0 - smoothstep(0.0, ringWidth, distToRing);
            float ringCore = 1.0 - smoothstep(0.0, ringWidth * 0.35, distToRing);  // 亮芯更细
            float ringSoft = 1.0 - smoothstep(ringWidth, ringWidth * 1.25, distToRing);  // 柔光范围收紧：2.2 -> 1.25
            vec3 ringColor = vec3(0.95, 1.0, 1.0);  // 光圈主色：偏白
            color.rgb += ringColor * ringBand * distanceGlow * 3.2;
            color.rgb += ringColor * ringCore * 2.0;
            color.rgb += ringColor * ringSoft * 0.9;
            color.rgb *= (1.0 + ringBand * 1.4);
            float scannedGlow = smoothstep(ringY - ringWidth, ringY, center.y);
            color.rgb += blueGlow * scannedGlow * 0.6;  // 蓝辉光
            color.rgb *= (1.0 + scannedGlow * 0.45);
        }
        
        // Phase 2 光圈复原：金环对齐复原波前（外缘），与高斯复原同步，不滞后
        if (g_phase == 2.0 && g_recoverProgress < 1.0 && g_recoverWaveFront > 0.0) {
            float haloWidth = uEndRadius * 0.016;   // 极窄环
            float distToHalo = abs(g_dist - g_recoverWaveFront);   // 用波前（外缘）半径
            float haloBand = 1.0 - smoothstep(0.0, haloWidth, distToHalo);
            float haloCore = 1.0 - smoothstep(0.0, haloWidth * 0.5, distToHalo);
            // 不再用 haloSoft，避免环变宽；只保留最外缘窄带
            float haloEdge = smoothstep(haloWidth * 0.6, haloWidth, distToHalo) * (1.0 - smoothstep(haloWidth, haloWidth * 1.08, distToHalo));
            vec3 haloColor = uPhase2HaloTint;
            // 金粉闪烁：对比拉大（暗时接近灭、亮时明显闪），三频叠加 + 加快速度
            float h1 = hash(center);
            float h2 = hash(center + vec3(10.0, 20.0, 30.0));
            float h3 = hash(center + vec3(50.0, 100.0, 150.0));
            float t1 = uTime * 14.0 + h1 * 6.28318;
            float t2 = uTime * 22.0 + h2 * 6.28318;
            float t3 = uTime * 31.0 + h3 * 6.28318;
            float sparkle = 0.15 + 0.55 * sin(t1) + 0.45 * sin(t2) + 0.35 * sin(t3);   // 约 0.15~1.5 再拉大
            sparkle = clamp(sparkle, 0.05, 2.2);   // 暗时几乎灭，亮时明显闪
            color.rgb += haloColor * haloBand * distanceGlow * 4.0 * sparkle;
            color.rgb += haloColor * haloCore * 3.0 * sparkle;
            color.rgb += haloColor * haloEdge * distanceGlow * 8.0 * sparkle;
            color.rgb *= (1.0 + haloBand * 0.4);
        }
        
        // Phase 2 未复原区不再整体提亮，只保留环上的金粉，光圈不会显得宽
        float glowMul = (g_phase == 2.0) ? 0.08 : 0.28;
        color.rgb *= (1.0 + glowIntensity * glowMul);
        color.rgb = clamp(color.rgb, 0.0, 4.5);
    }
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
uniform uPointSize: f32;   // 点云阶段固定点大小（参考 splat-overlay-shader 的 splatSize）
uniform uPointSizeAdaptiveScale: f32; // 点大小自适应缩放倍数（0-10），远处点自动放大
uniform uViewPos: vec3f; // 当前相机世界坐标（用于屏幕可见性地板）
uniform uMinSizeByViewDistSlope: f32; // 最小可见像素换算的世界尺寸斜率 size ~= dist * slope
uniform uScreenFloorMaxScale: f32; // 视距地板对 uPointSize 的最大放大倍数（防近景过糊）
uniform uSceneDensityNorm: f32; // 场景密度归一化（0=稀疏，1=密集）
uniform uSceneDensityInfluence: f32; // 密度补偿影响强度
uniform uEndRadius: f32;
uniform uGlobalRecoverStart: f32;
uniform uBottomY: f32;
uniform uTopY: f32;
uniform uEdgeAreaMin: f32;
uniform uEdgeAreaMax: f32;
uniform uEdgeAnisoMin: f32;
uniform uVerticalSpread: f32;
uniform uPhase1CloudTint: vec3f;
uniform uPhase2HaloTint: vec3f;

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

// Smooth interpolation function (smoothstep)
fn smoothInterp(t: f32) -> f32 {
    return t * t * (3.0 - 2.0 * t);
}

// Gradient noise (Perlin-like) for smooth, continuous noise field
fn gradientNoise(p: vec3f) -> vec3f {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f); // smoothstep
    
    // Sample 8 corners
    let d000 = randomDir(i);
    let d100 = randomDir(i + vec3f(1.0, 0.0, 0.0));
    let d010 = randomDir(i + vec3f(0.0, 1.0, 0.0));
    let d110 = randomDir(i + vec3f(1.0, 1.0, 0.0));
    let d001 = randomDir(i + vec3f(0.0, 0.0, 1.0));
    let d101 = randomDir(i + vec3f(1.0, 0.0, 1.0));
    let d011 = randomDir(i + vec3f(0.0, 1.0, 1.0));
    let d111 = randomDir(i + vec3f(1.0, 1.0, 1.0));
    
    // Trilinear interpolation
    let result = normalize(mix(
        mix(mix(d000, d100, f.x), mix(d010, d110, f.x), f.y),
        mix(mix(d001, d101, f.x), mix(d011, d111, f.x), f.y),
        f.z
    ));
    
    return result;
}

// Fractal Brownian Motion (fBM) - multi-frequency noise
fn fbmNoise(p: vec3f, time: f32) -> vec3f {
    // Combine multiple frequencies for smooth, flowing noise
    let scale1 = 0.8;
    let scale2 = 2.5;
    let scale3 = 6.0;
    
    // Add time-based flow
    let p1 = p * scale1 + vec3f(0.0, 0.0, time * 0.3);
    let p2 = p * scale2 + vec3f(0.0, 0.0, time * 0.5);
    let p3 = p * scale3 + vec3f(0.0, 0.0, time * 0.8);
    
    let n1 = gradientNoise(p1);
    let n2 = gradientNoise(p2);
    let n3 = gradientNoise(p3);
    
    // Combine with decreasing weights (lower frequencies have more influence)
    let result = n1 * 0.5 + n2 * 0.3 + n3 * 0.2;
    return normalize(result);
}

// Shared globals
var<private> g_dist: f32;
var<private> g_yOffset: f32;
var<private> g_wavePhase: f32;
var<private> g_growthProgress: f32;
var<private> g_tRecoverStart: f32;
var<private> g_tRecoverEnd: f32;
var<private> g_recoverProgress: f32;
var<private> g_recoverRadius: f32;       // Phase 2 复原带中心半径
var<private> g_recoverWaveFront: f32;    // Phase 2 复原波前半径（外缘），金环对齐此处与几何同步
var<private> g_phase: f32;

fn initShared(center: vec3f) {
    g_dist = length(center - uniform.uCenter);
    
    // Calculate Y offset from bottom (bottom-up growth)
    // Note: Due to Y-axis inversion in coordinate system, larger Y values are visually at the bottom
    // So for bottom-to-top growth, we calculate offset from bottomY
    // Bottom particles (center.y close to bottomY, larger Y value) have small yOffset, start first
    // Use uBottomY - center.y (inverse of integrate effect) to make bottom start first
    g_yOffset = center.y - uniform.uBottomY;
    
    // Growth phase: wave propagation from bottom to top
    // Similar to integrate effect, but from bottom to top
    // Calculate wave phase: time progresses, wave propagates upward
    // Bottom particles (small yOffset) have wavePhase reach threshold first
    let timeScaled = uniform.uTime * uniform.uGrowthSpeed;
    // For bottom-up: bottom has yOffset=0, top has large yOffset
    // Wave phase = time - yOffset * spread, so bottom (yOffset=0) starts first
    // Use uVerticalSpread uniform instead of calculating it, so it can be controlled by totalDuration
    g_wavePhase = timeScaled - g_yOffset * uniform.uVerticalSpread;
    
    // Growth progress: 0 = not reached, 1 = fully grown
    // Use smoothstep for smooth transition
    g_growthProgress = smoothstep(0.0, uniform.uGrowthDuration, g_wavePhase);
    g_growthProgress = clamp(g_growthProgress, 0.0, 1.0);
    
    // Recover phase: wait for ALL particles to finish growing before starting recovery
    // Recovery also propagates from bottom to top
    // Top particle has largest yOffset = abs(uBottomY - uTopY) (since uBottomY > uTopY due to Y-axis inversion)
    // For the top particle: g_wavePhase = timeScaled - maxYOffset * uVerticalSpread
    // When g_wavePhase >= uGrowthDuration, the top particle finishes growing
    // So: timeScaled - maxYOffset * uVerticalSpread >= uGrowthDuration
    //     uTime * uGrowthSpeed >= uGrowthDuration + maxYOffset * uVerticalSpread
    //     uTime >= (uGrowthDuration + maxYOffset * uVerticalSpread) / uGrowthSpeed
    // But we want to start recovery as soon as the last particle finishes, so:
    let maxYOffset = abs(uniform.uBottomY - uniform.uTopY);
    let topParticleGrowthEnd = (uniform.uGrowthDuration + maxYOffset * uniform.uVerticalSpread) / uniform.uGrowthSpeed;
    g_tRecoverStart = topParticleGrowthEnd;
    
    g_tRecoverEnd = g_tRecoverStart + uniform.uRecoverDuration;
    
    g_phase = 0.0;
    
    // Determine current phase (Phase 2 仅按时间判定)
    if (g_wavePhase < 0.0) {
        g_phase = 0.0; // Hidden
    } else if (uniform.uTime < g_tRecoverStart) {
        g_phase = 1.0; // Phase 1: 聚拢生长
    } else if (uniform.uTime < g_tRecoverEnd) {
        g_phase = 2.0; // Phase 2: 从中心向外光圈过渡复原
    } else {
        g_phase = 3.0; // Complete
    }
    
    // Phase 2: 从视点 target 中心向外光圈过渡复原
    if (g_phase == 2.0) {
        let recoverRadius = ((uniform.uTime - g_tRecoverStart) / uniform.uRecoverDuration) * uniform.uEndRadius;
        let recoverBand = uniform.uEndRadius * 0.05;
        g_recoverRadius = recoverRadius;
        g_recoverWaveFront = recoverRadius + recoverBand;   // 波前在外缘，金环对齐波前才不滞后
        g_recoverProgress = 1.0 - smoothstep(recoverRadius - recoverBand, recoverRadius + recoverBand, g_dist);
        g_recoverProgress = clamp(g_recoverProgress, 0.0, 1.0);
    } else {
        g_recoverProgress = 0.0;
        g_recoverRadius = 0.0;
        g_recoverWaveFront = 0.0;
    }
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
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
        // Growth phase: 聚拢生长粒子特效
        // 核心原则：聚拢是主趋势，噪声扰动路径，最终严格到达目标位置
        
        // 当这个粒子的生长阶段真正完成时（g_growthProgress >= 1.0），
        // 直接设置为原始位置并返回，不再执行任何噪声计算
        // 这样可以确保 Phase 1 结束后粒子稳定停留在原始位置，不会乱飘
        if (g_growthProgress >= 1.0) {
            *center = originalCenter;
            return;
        }
        
        // 计算径向距离和方向
        let toSplat = originalCenter - uniform.uCenter;
        let distFromCenter = length(toSplat);
        let radialOut = select(vec3f(1.0, 0.0, 0.0), normalize(toSplat), distFromCenter > 0.001);
        
        // 聚拢进度：使用慢启动缓动曲线
        let easedProgress = pow(g_growthProgress, 0.4);
        
        // 计算聚拢距离
        let baseScatterDistance = uniform.uScatterDistance * 15.0;
        let distanceBasedMultiplier = 1.0 + distFromCenter * 0.2;
        let maxScatterDistance = baseScatterDistance * distanceBasedMultiplier;
        
        // 主收敛路径：从外部到目标位置的径向路径
        let startPos = originalCenter + radialOut * maxScatterDistance;
        let targetPos = originalCenter; // 最终必须严格到达这里
        
        // 主收敛路径上的当前位置（无扰动）
        let currentScatterDistance = maxScatterDistance * (1.0 - easedProgress);
        var mainConvergePos = originalCenter + radialOut * currentScatterDistance;
        
        // 噪声场扰动：使用fBM噪声来扰动路径
        // 增强烟雾扰动效果：增大扰动强度和轮廓
        // 噪声强度随聚拢过程逐渐减弱（初期烟雾感强，末期稳定）
        var noiseIntensity = (1.0 - easedProgress) * (1.0 - easedProgress); // 二次衰减，初期强，末期弱
        noiseIntensity = noiseIntensity * 1.5; // 增加50%的基础强度
        
        // 计算噪声采样位置（空间+时间）
        // 使用更大的空间尺度，产生更大的烟雾轮廓
        let noisePos = (originalCenter - uniform.uCenter) * 0.3; // 降低空间频率，增大轮廓
        let noiseTime = uniform.uTime * 0.6; // 增加时间流动速度，增强飘动感
        
        // 获取噪声方向（低频、连续、随时间流动）
        // 使用多层噪声增强烟雾的复杂性和飘动感
        var noiseDir = fbmNoise(noisePos, noiseTime);
        
        // 添加额外的低频噪声层，增强大范围飘动
        let noisePos2 = (originalCenter - uniform.uCenter) * 0.15 + vec3f(0.0, 0.0, noiseTime * 0.2);
        let noiseDir2 = fbmNoise(noisePos2, noiseTime * 0.5);
        noiseDir = normalize(noiseDir * 0.7 + noiseDir2 * 0.3); // 混合两层噪声
        
        // 构建切向和法向空间（用于侧向扰动）
        let upAxis = vec3f(0.0, 1.0, 0.0);
        var tangential = normalize(cross(upAxis, radialOut));
        if (length(tangential) < 0.001) {
            tangential = vec3f(0.0, 0.0, 1.0);
        }
        let normal = cross(radialOut, tangential);
        
        // 将噪声方向投影到切向和法向空间（侧向扰动，不影响径向收敛）
        let tangentialNoise = dot(noiseDir, tangential);
        let normalNoise = dot(noiseDir, normal);
        
        // 计算扰动偏移（作用在路径上，不是最终结果）
        // 增大扰动距离：增强烟雾扰动的轮廓
        let perturbationDistance = currentScatterDistance * noiseIntensity * 1.5; // 从0.8增加到1.5
        var perturbation = tangential * tangentialNoise * perturbationDistance;
        perturbation = perturbation + normal * normalNoise * perturbationDistance;
        
        // 添加更强的径向相位扰动（距离延迟），增强飘动感
        let phaseNoise = dot(noiseDir, radialOut) * 0.5; // 从0.3增加到0.5
        let phaseOffset = phaseNoise * noiseIntensity * currentScatterDistance * 0.4; // 从0.2增加到0.4
        let phasePerturbation = radialOut * phaseOffset;
        
        // 添加额外的垂直扰动，增强烟雾的上升飘动感
        let verticalNoise = dot(noiseDir, upAxis);
        let verticalPerturbation = upAxis * verticalNoise * noiseIntensity * currentScatterDistance * 0.3;
        perturbation = perturbation + verticalPerturbation;
        
        // 最终位置 = 主收敛路径 + 噪声偏移（随时间衰减）
        var finalPos = mainConvergePos + perturbation + phasePerturbation;
        
        // 确保最终位置在聚拢完成时严格到达目标位置
        // 当easedProgress接近1时，噪声强度接近0，位置接近targetPos
        *center = mix(startPos, finalPos, easedProgress);
        
    } else if (g_phase == 2.0) {
        // Phase 2: 从视点 target 中心向外光圈过渡复原，无位置动画，保持原始位置
        *center = originalCenter;
    }
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    initShared(originalCenter);
    
    let originalScale = *scale;
    let originalSize = gsplatGetSizeFromScale(*scale);
    
    if (g_phase == 0.0) {
        gsplatMakeSpherical(scale, originalSize * 0.001);
        return;
    }
    if (g_phase == 1.0) {
        if (g_growthProgress <= 0.0) {
            gsplatMakeSpherical(scale, originalSize * 0.001);
            return;
        }
        // Phase 1 自适应点大小：远处点自动放大，近处点保持小尺寸
        // normalizedDistance: 0 = 中心附近(近), 1 = 最远处
        let normalizedDistance = clamp(g_dist / max(uniform.uEndRadius, 1.0), 0.0, 1.0);
        // adaptiveSize = pointSize * (1.0 + normalizedDistance * adaptiveScale)
        // 近处: ~uPointSize, 远处: uPointSize * (1.0 + adaptiveScale)
        var adaptiveSize = uniform.uPointSize * (1.0 + normalizedDistance * uniform.uPointSizeAdaptiveScale);
        // 场景密度补偿（强作用版）：稀疏场景放大，密集场景收缩
        let densityT = clamp((uniform.uSceneDensityNorm - 0.5) * uniform.uSceneDensityInfluence + 0.5, 0.0, 1.0);
        let densitySizeMul = mix(1.42, 0.62, densityT);
        adaptiveSize = adaptiveSize * densitySizeMul;
        // 屏幕可见性地板：避免远处点掉到亚像素导致“相机拉近才看见”
        let camDist = length(originalCenter - uniform.uViewPos);
        let minVisibleSize = clamp(camDist * uniform.uMinSizeByViewDistSlope, uniform.uPointSize * 0.85, uniform.uPointSize * uniform.uScreenFloorMaxScale);
        adaptiveSize = max(adaptiveSize, minVisibleSize);
        gsplatMakeSpherical(scale, adaptiveSize);
        return;
    }
    if (g_phase == 2.0) {
        if (g_recoverProgress <= 0.0) {
            gsplatMakeSpherical(scale, uniform.uPointSize);
            return;
        }
        let easedT = clamp(1.0 - pow(1.0 - g_recoverProgress, 4.0), 0.0, 1.0);
        let pointScale = vec3f(uniform.uPointSize);
        *scale = mix(pointScale, originalScale, easedT);
        return;
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    initShared(center);
    
    if ((g_phase == 1.0 && g_growthProgress > 0.0) || (g_phase == 2.0 && g_recoverProgress < 1.0)) {
        var glowIntensity: f32 = 1.0;
        var progressGlow: f32 = 1.0;
        
        if (g_phase == 1.0) {
            if (g_growthProgress > 0.9) {
                progressGlow = 1.0 - (g_growthProgress - 0.9) * 2.0;
            }
            progressGlow = max(progressGlow, 0.8);
        } else if (g_phase == 2.0) {
            progressGlow = 1.0 - g_recoverProgress;
            progressGlow = max(progressGlow, 0.0);
        }
        
        let toSplat = center - uniform.uCenter;
        let distFromCenter = length(toSplat);
        let normalizedDist = distFromCenter / max(uniform.uEndRadius, 1.0);
        let distanceGlow = 1.0 + (1.0 - smoothstep(0.0, 0.85, normalizedDist)) * 0.7;
        let densityT = clamp((uniform.uSceneDensityNorm - 0.5) * uniform.uSceneDensityInfluence + 0.5, 0.0, 1.0);
        let sceneGlowFactor = mix(1.22, 0.42, densityT);
        
        glowIntensity = progressGlow * distanceGlow * sceneGlowFactor;
        glowIntensity = clamp(glowIntensity, 0.0, 1.6);
        
        let blueGlow = uniform.uPhase1CloudTint;
        // 仅 Phase 1 加蓝辉光；Phase 2 不加，避免未复原区整片发蓝导致光圈显得很宽
        if (g_phase == 1.0) {
            (*color).rgb = (*color).rgb + blueGlow * glowIntensity * 0.58;
        }
        
        // Phase 1 聚拢：光圈收窄 + 柔光收紧，更明显光环；主带偏白，蓝辉光
        if (g_phase == 1.0 && g_growthProgress > 0.0 && g_growthProgress < 1.0) {
            let phase1Progress = clamp(uniform.uTime / g_tRecoverStart, 0.0, 1.0);
            let ringY = mix(uniform.uBottomY, uniform.uTopY, phase1Progress);
            let sceneHeight = abs(uniform.uBottomY - uniform.uTopY);
            let ringWidth = max(2.0, sceneHeight * 0.06);
            let distToRing = abs(center.y - ringY);
            let ringBand = 1.0 - smoothstep(0.0, ringWidth, distToRing);
            let ringCore = 1.0 - smoothstep(0.0, ringWidth * 0.35, distToRing);
            let ringSoft = 1.0 - smoothstep(ringWidth, ringWidth * 1.25, distToRing);
            let ringColor = vec3f(0.95, 1.0, 1.0);
            (*color).rgb = (*color).rgb + ringColor * ringBand * distanceGlow * 3.2;
            (*color).rgb = (*color).rgb + ringColor * ringCore * 2.0;
            (*color).rgb = (*color).rgb + ringColor * ringSoft * 0.9;
            (*color).rgb = (*color).rgb * (1.0 + ringBand * 1.4);
            let scannedGlow = smoothstep(ringY - ringWidth, ringY, center.y);
            (*color).rgb = (*color).rgb + blueGlow * scannedGlow * 0.6;
            (*color).rgb = (*color).rgb * (1.0 + scannedGlow * 0.45);
        }
        
        // Phase 2 光圈复原：金环对齐复原波前（外缘），与高斯复原同步，不滞后
        if (g_phase == 2.0 && g_recoverProgress < 1.0 && g_recoverWaveFront > 0.0) {
            let haloWidth = uniform.uEndRadius * 0.016;   // 极窄环
            let distToHalo = abs(g_dist - g_recoverWaveFront);   // 用波前（外缘）半径
            let haloBand = 1.0 - smoothstep(0.0, haloWidth, distToHalo);
            let haloCore = 1.0 - smoothstep(0.0, haloWidth * 0.5, distToHalo);
            let haloEdge = smoothstep(haloWidth * 0.6, haloWidth, distToHalo) * (1.0 - smoothstep(haloWidth, haloWidth * 1.08, distToHalo));
            let haloColor = uniform.uPhase2HaloTint;
            let h1 = hash(center);
            let h2 = hash(center + vec3f(10.0, 20.0, 30.0));
            let h3 = hash(center + vec3f(50.0, 100.0, 150.0));
            let t1 = uniform.uTime * 14.0 + h1 * 6.28318;
            let t2 = uniform.uTime * 22.0 + h2 * 6.28318;
            let t3 = uniform.uTime * 31.0 + h3 * 6.28318;
            let sparkle = 0.15 + 0.55 * sin(t1) + 0.45 * sin(t2) + 0.35 * sin(t3);
            let sparkleClamped = clamp(sparkle, 0.05, 2.2);   // 暗时几乎灭，亮时明显闪
            (*color).rgb = (*color).rgb + haloColor * haloBand * distanceGlow * 4.0 * sparkleClamped;
            (*color).rgb = (*color).rgb + haloColor * haloCore * 3.0 * sparkleClamped;
            (*color).rgb = (*color).rgb + haloColor * haloEdge * distanceGlow * 8.0 * sparkleClamped;
            (*color).rgb = (*color).rgb * (1.0 + haloBand * 0.4);
        }
        
        let glowMul = select(0.28, 0.08, g_phase == 2.0);   // Phase 2 未复原区少提亮，光圈不显宽
        (*color).rgb = (*color).rgb * (1.0 + glowIntensity * glowMul);
        (*color).rgb = clamp((*color).rgb, vec3f(0.0), vec3f(4.5));
    }
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
 * growthScript.recoverDuration = 3.0;
 */
class GsplatRevealGrowthWave extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealGrowthWave';

    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];
    _viewPosArray = [0, 0, 0];
    _phase1CloudTintArray = [0, 0, 0];
    _phase2HaloTintArray = [0, 0, 0];
    _sceneDensityNorm = 0.5;
    _sceneDensityInited = false;

    /** 进入 Phase 2 时调用一次，可由 reveal 挂接为「用当前相机 target 更新 center」 */
    onPhase2Start?: () => void;
    private _phase2CenterUpdated = false;

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
     * Phase 2 光圈复原时长（秒）。光圈从中心向外扩散到 endRadius 所用的时间。
     * 光圈扫描速度（世界单位/秒）= endRadius / recoverDuration。
     * 想加快光圈扩散：减小 recoverDuration；想放慢：增大 recoverDuration。
     * @attribute
     * @range [0.5, 20]
     */
    recoverDuration = 5.0;

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
     * @deprecated 当前 growth-wave 点云阶段统一使用 pointSize，此参数保留仅兼容旧配置。
     * @attribute
     * @range [0.01, 1]
     */
    minSize = 0.05;

    /**
     * 点云阶段固定大小（世界单位，与协方差尺度一致）：全场景统一，不按 bbox 缩放。
     * @attribute
     * @range [0.001, 0.5]
     */
    pointSize = 0.006;

    /**
     * Phase 1 点大小自适应缩放倍数（0-10）。
     * 远处点自动放大以确保可见，近处点保持小尺寸避免过曝。
     * 公式：adaptiveSize = pointSize * (1.0 + normalizedDistance * adaptiveScale)
     * 例如：adaptiveScale=3.0 时，远处点大小 = 0.008 * 4 = 0.032
     * @attribute
     * @range [0, 10]
     */
    pointSizeAdaptiveScale = 5.0;

    /**
     * 最小屏幕可见像素（用于计算视距尺寸地板），减少远处亚像素丢失。
     * @attribute
     * @range [0.5, 4]
     */
    minScreenPointPx = 1.25;

    /**
     * 屏幕可见性地板上限（相对 pointSize 倍数），防止近景被地板推得过大。
     * @attribute
     * @range [1, 4]
     */
    screenFloorMaxScale = 1.9;

    /**
     * 场景密度归一化的最小锚点（点数/体积）。越大则更容易被判定为“稀疏”。
     * @attribute
     * @range [10, 5000]
     */
    densityAnchorMin = 35;

    /**
     * 场景密度归一化的最大锚点（点数/体积）。越小则更容易被判定为“密集”。
     * @attribute
     * @range [1000, 1000000]
     */
    densityAnchorMax = 18000;

    /**
     * 场景密度补偿影响强度。值越大，稀疏/密集两端差异越明显。
     * @attribute
     * @range [0.5, 4]
     */
    densityInfluence = 2.4;

    /**
     * Phase 2 光圈外沿（世界单位，uEndRadius）。由 `setRadius` / `commitEffectiveEndRadius` 写入，勿经 effectParams 直改。
     * @attribute
     * @range [0, 500]
     */
    endRadius = 50.0;

    /**
     * 参与半径上界（世界单位）。有效半径 = min(bbox 自适应, maxEndRadius)。
     * @attribute
     */
    maxEndRadius = 50;

    /**
     * 刷新有效 `endRadius`，并按 `totalDuration` 对齐 Phase1/Phase2（`recoverDuration` 与波前速度）。
     */
    syncSpeedToTotalDuration(totalDuration: number): void {
        this.commitEffectiveEndRadius();
        if (!Number.isFinite(totalDuration) || totalDuration <= 0) {
            return;
        }

        const minRecoverDuration = 0.5;
        const heightRange = Math.abs(this.topY - this.bottomY);
        const defaultGrowthPhaseTime = 7.0;

        const computePhase1End = () =>
            this.growthSpeed > 1e-6
                ? (this.growthDuration + heightRange * (this.verticalSpread ?? 0)) / this.growthSpeed
                : defaultGrowthPhaseTime;

        let phase1End = computePhase1End();
        const phase1Budget = Math.max(0.01, totalDuration - minRecoverDuration);
        if (phase1End > phase1Budget + 1e-4) {
            const mult = phase1End / phase1Budget;
            this.growthSpeed *= mult;
            phase1End = computePhase1End();
        }
        this.recoverDuration = Math.max(minRecoverDuration, totalDuration - phase1End);

        if (this.materialsApplied.size > 0) {
            this.setUniform('uEndRadius', this.endRadius);
        }
    }

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
     * @deprecated 聚拢阶段已改为点云模式，所有粒子均参与，此参数保留仅为兼容
     * Edge filter: minimum screen area (px^2) to keep; smaller treated as edges
     * @attribute
     * @range [0, 20]
     */
    edgeAreaMin = 1.5;

    /**
     * @deprecated 聚拢阶段已改为点云模式，此参数保留仅为兼容
     * Edge filter: maximum screen area (px^2) for anisotropic edges
     * @attribute
     * @range [0, 50]
     */
    edgeAreaMax = 6.0;

    /**
     * @deprecated 聚拢阶段已改为点云模式，此参数保留仅为兼容
     * Edge filter: anisotropy threshold (r_major / r_minor approx)
     * @attribute
     * @range [1, 20]
     */
    edgeAnisoMin = 5.0;

    /**
     * Vertical spread speed (units per unit height) - controls wave propagation speed
     * If not set, will be calculated from growthSpeed and height range
     * @attribute
     * @range [0.01, 100]
     */
    verticalSpread?: number;

    /**
     * Phase 1：点云/蓝辉 additive 色调（`modifySplatColor` 中替代原硬编码蓝）
     * @attribute
     */
    phase1CloudTint = new Color(0.18, 0.45, 1.0);

    /**
     * Phase 2：金环 halo additive 色调
     * @attribute
     */
    phase2HaloTint = new Color(1.0, 0.82, 0.52);

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // Calculate verticalSpread: use provided value or calculate from growthSpeed and height range
        const heightRange = Math.abs(this.topY - this.bottomY);
        const verticalSpread = this.verticalSpread ?? (this.growthSpeed / Math.max(heightRange, 0.001));
        
        // Calculate global recover start time based on topY and bottomY limits
        // This matches the shader calculation exactly:
        // Shader: topParticleGrowthEnd = (growthDuration + maxYOffset * verticalSpread) / growthSpeed
        const maxYOffset = heightRange;
        const globalRecoverStart = (this.growthDuration + maxYOffset * verticalSpread) / this.growthSpeed;

        // 使用当前相机参数，把最小屏幕像素换算成世界尺寸斜率：size ~= dist * slope
        const layerCameras = (this.app.scene as any)?.layers?.cameras as any[] | undefined;
        const cameraComp: any = (this.camera as any)?.camera ?? (layerCameras && layerCameras.length > 0 ? layerCameras[0] : null);
        const cameraEntity = cameraComp?.entity;
        const camPos = cameraEntity?.getPosition?.() ?? this.center;
        this._viewPosArray[0] = camPos.x;
        this._viewPosArray[1] = camPos.y;
        this._viewPosArray[2] = camPos.z;
        const fovDeg = Number(cameraComp?.fov ?? 60);
        const fovRad = (fovDeg * Math.PI) / 180;
        const viewportHeight = Math.max(1, this.app.graphicsDevice.height);
        const minSizeByViewDistSlope = (2 * Math.tan(fovRad * 0.5) * this.minScreenPointPx) / viewportHeight;

        // 每帧重算，避免场景替换或 bounds 变更后补偿仍停留在旧值
        this._sceneDensityNorm = this.computeSceneDensityNorm();
        this._sceneDensityInited = true;

        // 进入 Phase 2 时更新一次 center（例如由 reveal 挂接为当前相机 target）
        if (effectTime < globalRecoverStart) {
            this._phase2CenterUpdated = false;
        } else if (!this._phase2CenterUpdated) {
            this._phase2CenterUpdated = true;
            this.onPhase2Start?.();
        }

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
        this.setUniform('uPointSize', this.pointSize);
        this.setUniform('uPointSizeAdaptiveScale', this.pointSizeAdaptiveScale);
        this.setUniform('uViewPos', this._viewPosArray);
        this.setUniform('uMinSizeByViewDistSlope', minSizeByViewDistSlope);
        this.setUniform('uScreenFloorMaxScale', this.screenFloorMaxScale);
        this.setUniform('uSceneDensityNorm', this._sceneDensityNorm);
        this.setUniform('uSceneDensityInfluence', this.densityInfluence);
        this.setUniform('uEndRadius', this.endRadius);
        this.setUniform('uGlobalRecoverStart', globalRecoverStart);
        this.setUniform('uBottomY', this.bottomY);
        this.setUniform('uTopY', this.topY);
        this.setUniform('uEdgeAreaMin', this.edgeAreaMin);
        this.setUniform('uEdgeAreaMax', this.edgeAreaMax);
        this.setUniform('uEdgeAnisoMin', this.edgeAnisoMin);
        this.setUniform('uVerticalSpread', verticalSpread);

        this._phase1CloudTintArray[0] = this.phase1CloudTint.r;
        this._phase1CloudTintArray[1] = this.phase1CloudTint.g;
        this._phase1CloudTintArray[2] = this.phase1CloudTint.b;
        this.setUniform('uPhase1CloudTint', this._phase1CloudTintArray);
        this._phase2HaloTintArray[0] = this.phase2HaloTint.r;
        this._phase2HaloTintArray[1] = this.phase2HaloTint.g;
        this._phase2HaloTintArray[2] = this.phase2HaloTint.b;
        this.setUniform('uPhase2HaloTint', this._phase2HaloTintArray);

        // Check if effect is complete
        if (this.isEffectComplete(globalRecoverStart)) {
            console.log('Growth wave effect completed, disabling');
            this.notifyRevealComplete();
            return;
        }
    }

    /**
     * 与 `isEffectComplete` / shader 中 `globalRecoverStart + recoverDuration` 一致。
     * `globalRecoverStart` 若传入须与当帧 `updateEffect` 内计算值相同；省略时按当前属性重算。
     */
    getCompletionTime(globalRecoverStart?: number): number {
        const heightRange = Math.abs(this.topY - this.bottomY);
        const verticalSpread = this.verticalSpread ?? (this.growthSpeed / Math.max(heightRange, 0.001));
        const maxYOffset = heightRange;
        const waveCompletesAtTopY = (this.growthDuration + maxYOffset * verticalSpread) / Math.max(this.growthSpeed, 0.001);
        const recoverStart = globalRecoverStart ?? waveCompletesAtTopY;
        return recoverStart + this.recoverDuration;
    }

    /**
     * Calculate when the effect is complete.
     * Effect completes when all particles have finished recovering.
     * Uses topY and bottomY limits to calculate completion time (matching shader logic).
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete(globalRecoverStart?: number) {
        return this.effectTime >= this.getCompletionTime(globalRecoverStart);
    }

    private computeSceneDensityNorm(): number {
        const gsplatComp: any = this.entity?.gsplat;
        const resource = gsplatComp?.resource ?? gsplatComp?.instance?.resource;
        const numSplats = Number(resource?.numSplats ?? 0);
        const aabb = gsplatComp?.customAabb ?? resource?.aabb;
        const half = aabb?.halfExtents;

        if (!half || !Number.isFinite(numSplats) || numSplats <= 0) {
            return 0.5;
        }

        const sx = Math.max(half.x * 2, 1e-3);
        const sy = Math.max(half.y * 2, 1e-3);
        const sz = Math.max(half.z * 2, 1e-3);
        const volume = Math.max(sx * sy * sz, 1e-3);
        const density = numSplats / volume;

        const minA = Math.max(1e-3, this.densityAnchorMin);
        const maxA = Math.max(minA + 1e-3, this.densityAnchorMax);
        const t = (Math.log(density + 1) - Math.log(minA + 1)) / (Math.log(maxA + 1) - Math.log(minA + 1));
        return Math.min(1, Math.max(0, t));
    }

    /**
     * 给相机裁剪面的运行时提示（供 RevealController / Viewer 通用消费）。
     * growth-wave 在 Phase1 会把粒子外推，需放宽 far 并限制 near 上限避免前景被裁。
     */
    getCameraClipHint(): { clipPadding?: number; nearMax?: number } | null {
        if (!this.enabled) return null;
        const scatter = Math.max(0, Number(this.scatterDistance ?? 0));
        // scatter 越大，波前可能越“超出静态包围体”，故按 scatter 线性放大 far padding，并做上下限约束。
        const clipPadding = Math.min(60, Math.max(12, scatter * 12));
        return {
            clipPadding,
            // 用 near 上限抑制“far 被抬高后 near 也升高”导致的近景裁切。
            nearMax: 0.05
        };
    }
}

export { GsplatRevealGrowthWave };
