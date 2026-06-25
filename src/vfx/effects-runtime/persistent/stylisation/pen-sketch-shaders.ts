/** 全屏四边形顶点着色器（钢笔速写多 pass 共用） */
export const PEN_SKETCH_VERTEX_GLSL = `
    attribute vec2 aPosition;
    varying vec2 vUv0;
    void main(void) {
        gl_Position = vec4(aPosition, 0.0, 1.0);
        vUv0 = (aPosition.xy + 1.0) * 0.5;
    }
`;

/** 高斯模糊（结构分析 pass 1/2） */
export const PEN_SKETCH_ANALYSIS_FRAGMENT_GLSL = `
    precision highp float;
    uniform sampler2D uAnalysisSource;
    uniform vec2 uAnalysisTexel;
    uniform vec2 uAnalysisDirection;
    varying vec2 vUv0;
    void main(void) {
        vec2 d = uAnalysisTexel * uAnalysisDirection;
        vec3 c = texture2D(uAnalysisSource, vUv0).rgb * 0.227027;
        c += texture2D(uAnalysisSource, vUv0 + d * 1.384615).rgb * 0.316216;
        c += texture2D(uAnalysisSource, vUv0 - d * 1.384615).rgb * 0.316216;
        c += texture2D(uAnalysisSource, vUv0 + d * 3.230769).rgb * 0.070270;
        c += texture2D(uAnalysisSource, vUv0 - d * 3.230769).rgb * 0.070270;
        gl_FragColor = vec4(c, 1.0);
    }
`;

/** 图像空间结构张量 → 无向笔触轴 */
export const PEN_SKETCH_ORIENTATION_FRAGMENT_GLSL = `
    precision highp float;
    uniform sampler2D uOrientationSource;
    uniform vec2 uOrientationTexel;
    varying vec2 vUv0;
    float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    vec2 gradientAt(vec2 uv) {
        vec2 d = uOrientationTexel * 1.55;
        float l = lum(texture2D(uOrientationSource, uv - vec2(d.x, 0.0)).rgb);
        float r = lum(texture2D(uOrientationSource, uv + vec2(d.x, 0.0)).rgb);
        float b = lum(texture2D(uOrientationSource, uv - vec2(0.0, d.y)).rgb);
        float t = lum(texture2D(uOrientationSource, uv + vec2(0.0, d.y)).rgb);
        return vec2(r - l, t - b);
    }
    void accumulateTensor(inout vec3 tensor, vec2 uv, float weight) {
        vec2 g = gradientAt(uv);
        tensor += vec3(g.x * g.x, g.y * g.y, g.x * g.y) * weight;
    }
    void main(void) {
        vec2 d = uOrientationTexel * 3.2;
        vec3 j = vec3(0.0);
        accumulateTensor(j, vUv0, 0.28);
        accumulateTensor(j, vUv0 + vec2(d.x, 0.0), 0.12);
        accumulateTensor(j, vUv0 - vec2(d.x, 0.0), 0.12);
        accumulateTensor(j, vUv0 + vec2(0.0, d.y), 0.12);
        accumulateTensor(j, vUv0 - vec2(0.0, d.y), 0.12);
        accumulateTensor(j, vUv0 + d, 0.06);
        accumulateTensor(j, vUv0 - d, 0.06);
        accumulateTensor(j, vUv0 + vec2(d.x, -d.y), 0.06);
        accumulateTensor(j, vUv0 + vec2(-d.x, d.y), 0.06);
        vec2 doubled = vec2(j.x - j.y, 2.0 * j.z);
        float anisotropy = length(doubled);
        float energy = j.x + j.y;
        vec2 axis = anisotropy > 0.000001 ? doubled / anisotropy : vec2(1.0, 0.0);
        float coherence = anisotropy / max(energy, 0.000001);
        float confidence = smoothstep(0.00010, 0.010, energy) * smoothstep(0.10, 0.72, coherence);
        gl_FragColor = vec4(axis * 0.5 + 0.5, 0.0, confidence);
    }
`;

/** 笔触方向场模糊 */
export const PEN_SKETCH_ORIENTATION_BLUR_FRAGMENT_GLSL = `
    precision highp float;
    uniform sampler2D uOrientationField;
    uniform vec2 uOrientationTexel;
    uniform vec2 uOrientationDirection;
    varying vec2 vUv0;
    void addField(inout vec2 sum, inout float weight, vec2 uv, float kernel) {
        vec4 s = texture2D(uOrientationField, uv);
        float w = s.a * kernel;
        sum += (s.rg * 2.0 - 1.0) * w;
        weight += w;
    }
    void main(void) {
        vec2 d = uOrientationTexel * uOrientationDirection;
        vec2 sum = vec2(0.0);
        float weight = 0.0;
        addField(sum, weight, vUv0, 0.227027);
        addField(sum, weight, vUv0 + d * 1.384615, 0.316216);
        addField(sum, weight, vUv0 - d * 1.384615, 0.316216);
        addField(sum, weight, vUv0 + d * 3.230769, 0.070270);
        addField(sum, weight, vUv0 - d * 3.230769, 0.070270);
        vec2 axis = weight > 0.0001 ? normalize(sum) : vec2(1.0, 0.0);
        gl_FragColor = vec4(axis * 0.5 + 0.5, 0.0, clamp(weight, 0.0, 1.0));
    }
`;

/** 钢笔速写主合成 pass */
export const PEN_SKETCH_MAIN_FRAGMENT_GLSL = `
    precision highp float;
    uniform sampler2D uColorBuffer;
    uniform sampler2D uSmoothBuffer;
    uniform sampler2D uOrientationBuffer;
    uniform vec2 uResolution;
    uniform vec2 uSmoothTexel;
    uniform float uOutlineWidth;
    uniform float uEdgeStrength;
    uniform float uHatching;
    uniform float uContrast;
    uniform float uToneStrength;
    uniform float uStroke;
    uniform float uFocus;
    uniform float uInkHue;
    uniform float uViewScale;
    uniform vec3 uPaperColor;
    varying vec2 vUv0;

    float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }

    float luminance(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    vec3 rawScene(vec2 uv) { return texture2D(uColorBuffer, clamp(uv, 0.0, 1.0)).rgb; }
    vec3 smoothScene(vec2 uv) { return texture2D(uSmoothBuffer, clamp(uv, 0.0, 1.0)).rgb; }

    float wetEdgeAt(vec2 uv, vec2 texel, float sensitivity) {
        const float radius = 0.75;
        vec3 cL = rawScene(uv - vec2(texel.x * radius, 0.0));
        vec3 cR = rawScene(uv + vec2(texel.x * radius, 0.0));
        vec3 cD = rawScene(uv - vec2(0.0, texel.y * radius));
        vec3 cU = rawScene(uv + vec2(0.0, texel.y * radius));
        float edge = length(cR - cL) + length(cU - cD);
        float edgeLow = 0.045 / max(sensitivity, 0.05);
        float edgeHigh = 0.22 / pow(max(sensitivity, 0.05), 0.72);
        return pow(smoothstep(edgeLow, edgeHigh, edge), 1.08);
    }

    float firmStroke(vec2 p, vec2 dir, float spacing, float lengthPx, float widthPx, float seed) {
        dir = normalize(dir + vec2(0.0001));
        vec2 normal = vec2(-dir.y, dir.x);
        float across = dot(p, normal);
        float row = floor(across / spacing);
        float jitter = hash12(vec2(row, seed));
        float shiftedAcross = across + (jitter - 0.5) * spacing * 0.10;
        float distanceToLine = abs(fract(shiftedAcross / spacing) - 0.5) * spacing;
        float period = lengthPx * 1.02;
        float alongUnwrapped = dot(p, dir) + jitter * period + seed * 19.37;
        float segment = floor(alongUnwrapped / period);
        float along = mod(alongUnwrapped, period);
        float strokeVariation = hash12(vec2(row + segment * 0.173, seed + 11.7));
        float localLength = lengthPx * mix(0.92, 1.015, strokeVariation);
        float endDistance = min(along, localLength - along);
        float body = smoothstep(0.0, 0.90, endDistance) * (1.0 - step(localLength, along));
        float taperLength = clamp(localLength * 0.28, 11.0, 42.0);
        float taper = smoothstep(0.0, taperLength, max(endDistance, 0.0));
        float pressure = mix(0.76, 1.0, strokeVariation);
        float penWidth = widthPx * pressure * mix(0.015, 0.78, taper);
        float feather = mix(0.15, 0.34, taper);
        float line = 1.0 - smoothstep(penWidth, penWidth + feather, distanceToLine);
        return line * body * mix(0.42, 1.0, taper);
    }

    void main(void) {
        vec2 uv = vUv0;
        vec2 pixel = uv * uResolution;
        float aspect = uResolution.x / max(uResolution.y, 1.0);
        vec2 centered = (uv - 0.5) * vec2(aspect, 1.0);
        float radius = length(centered) / length(vec2(0.5 * aspect, 0.5));
        float centerDetail = 1.0 - smoothstep(0.10, 1.03, radius / max(uFocus, 0.18));
        centerDetail = centerDetail * centerDetail * (3.0 - 2.0 * centerDetail);
        float hatchPresence = pow(centerDetail, 0.70);
        float abstraction = 1.0 - smoothstep(0.42, 1.0, uViewScale);

        vec3 raw = rawScene(uv);
        vec3 smoothColor = smoothScene(uv);
        float lum = luminance(smoothColor);
        float highFrequency = clamp(length(raw - smoothColor), 0.0, 1.0);
        vec2 rawTexel = 1.0 / max(uResolution, vec2(1.0));
        float coreContour = wetEdgeAt(uv, rawTexel, uEdgeStrength);
        float widthAmount = clamp(uOutlineWidth / 2.50, 0.0, 1.0);
        float widthThreshold = mix(0.96, 0.055, widthAmount);
        float contour = smoothstep(widthThreshold, min(widthThreshold + 0.10, 1.0), coreContour);
        contour *= smoothstep(0.0, 0.14, uOutlineWidth);

        vec2 coarseStep = uSmoothTexel * mix(6.5, 10.0, abstraction);
        float coarseL = luminance(smoothScene(uv - vec2(coarseStep.x, 0.0)));
        float coarseR = luminance(smoothScene(uv + vec2(coarseStep.x, 0.0)));
        float coarseB = luminance(smoothScene(uv - vec2(0.0, coarseStep.y)));
        float coarseT = luminance(smoothScene(uv + vec2(0.0, coarseStep.y)));
        vec2 coarseGradient = vec2(coarseR - coarseL, coarseT - coarseB);
        float coarseMagnitude = length(coarseGradient);
        vec4 orientationSample = texture2D(uOrientationBuffer, uv);
        vec2 doubledAxis = orientationSample.rg * 2.0 - 1.0;
        vec2 fieldStep = uSmoothTexel * 7.0;
        vec2 fieldCenter = normalize(doubledAxis + vec2(0.0001));
        vec2 fieldL = normalize(texture2D(uOrientationBuffer, uv - vec2(fieldStep.x, 0.0)).rg * 2.0 - 1.0 + vec2(0.0001));
        vec2 fieldR = normalize(texture2D(uOrientationBuffer, uv + vec2(fieldStep.x, 0.0)).rg * 2.0 - 1.0 + vec2(0.0001));
        vec2 fieldB = normalize(texture2D(uOrientationBuffer, uv - vec2(0.0, fieldStep.y)).rg * 2.0 - 1.0 + vec2(0.0001));
        vec2 fieldT = normalize(texture2D(uOrientationBuffer, uv + vec2(0.0, fieldStep.y)).rg * 2.0 - 1.0 + vec2(0.0001));
        float regionalCoherence = length(fieldCenter + fieldL + fieldR + fieldB + fieldT) * 0.20;
        float tangentAngle = 0.5 * atan(doubledAxis.y, doubledAxis.x) + 1.5707963;
        float angleStep = 0.5235988;
        tangentAngle = floor(tangentAngle / angleStep + 0.5) * angleStep;
        vec2 tangent = vec2(cos(tangentAngle), sin(tangentAngle));
        if (tangent.x < 0.0) tangent = -tangent;
        float orientationConfidence = smoothstep(0.08, 0.48, orientationSample.a);
        tangent = normalize(mix(vec2(0.9848, 0.1736), tangent, orientationConfidence));
        float stableAngle = atan(tangent.y, tangent.x);
        stableAngle = floor(stableAngle / angleStep + 0.5) * angleStep;
        tangent = vec2(cos(stableAngle), sin(stableAngle));

        float curvature = abs(coarseL + coarseR + coarseB + coarseT - 4.0 * lum);
        float fineStructure = smoothstep(0.022, 0.18, highFrequency * 0.42 + curvature * 1.65 + coarseMagnitude * 0.28);
        fineStructure *= mix(1.0, 0.35, abstraction);
        float localNear = smoothstep(0.012, 0.082, coarseMagnitude + curvature * 0.45);
        localNear *= smoothstep(0.48, 1.05, uViewScale) * pow(centerDetail, 0.38);
        float projectedNear = clamp(localNear * 0.72 + centerDetail * 0.28, 0.0, 1.0);
        float spacing = mix(16.0, 6.4, fineStructure * projectedNear);
        spacing *= mix(1.34, 0.90, centerDetail) * mix(1.0, 1.72, abstraction) / max(uStroke, 0.25);
        spacing = max(2.0, floor(spacing * 0.5 + 0.5) * 2.0);
        float strokeLength = mix(164.0, 64.0, fineStructure * projectedNear);
        strokeLength *= mix(1.18, 0.94, centerDetail) * mix(1.0, 1.22, abstraction) * uStroke;
        strokeLength = max(32.0, floor(strokeLength / 16.0 + 0.5) * 16.0);
        float width = mix(0.34, 0.48, fineStructure * projectedNear) * mix(1.04, 0.96, centerDetail) * uStroke;

        float hatchA = firmStroke(pixel, tangent, spacing, strokeLength, width, 1.7);
        float ca = 0.9848078, sa = 0.1736482;
        vec2 crossA = vec2(tangent.x * ca - tangent.y * sa, tangent.x * sa + tangent.y * ca);
        vec2 crossB = vec2(tangent.x * ca + tangent.y * sa, -tangent.x * sa + tangent.y * ca);
        float hatchB = firmStroke(pixel, crossA, spacing * 0.96, strokeLength * 0.97, width * 0.98, 8.3);
        float hatchC = firmStroke(pixel, crossB, spacing * 0.92, strokeLength * 0.94, width * 0.96, 19.1);
        float darkCa = 0.9961947, darkSa = 0.0871557;
        vec2 darkDirection = vec2(tangent.x * darkCa - tangent.y * darkSa, tangent.x * darkSa + tangent.y * darkCa);
        float hatchDenseA = firmStroke(pixel, darkDirection, spacing * 0.78, strokeLength * 1.08, width * 0.96, 31.7);

        float darkness = clamp((0.82 - lum) / 0.82, 0.0, 1.0);
        float darkEmphasis = smoothstep(0.42, 0.90, darkness);
        contour = 1.0 - pow(1.0 - contour, mix(1.0, 1.85, darkEmphasis));
        float toneLevels = clamp(uToneStrength, 2.0, 8.0);
        float toneIntervals = toneLevels - 1.0;
        float scaledDarkness = darkness * toneIntervals;
        float steppedDarkness = (floor(scaledDarkness) + smoothstep(0.32, 0.68, fract(scaledDarkness))) / toneIntervals;
        float toneA = smoothstep(0.02, 0.18, steppedDarkness);
        toneA *= mix(0.36, 1.0, steppedDarkness);
        float secondaryAvailability = smoothstep(3.0, 5.0, toneLevels);
        float tertiaryAvailability = smoothstep(5.0, 7.0, toneLevels);
        float toneB = smoothstep(0.43, 0.74, steppedDarkness) * secondaryAvailability;
        toneB *= (1.0 - abstraction * 0.45);
        float toneC = smoothstep(0.72, 0.96, steppedDarkness) * tertiaryAvailability;
        toneC *= (1.0 - abstraction * 0.72);
        float hatching = max(hatchA * toneA, max(hatchB * toneB, hatchC * toneC));
        float denseA = hatchDenseA * smoothstep(0.48, 0.78, steppedDarkness);
        hatching = max(hatching, denseA);
        float clutterSuppression = 1.0 - smoothstep(0.22, 0.72, highFrequency) * 0.58;
        float fieldValidity = smoothstep(0.78, 0.94, regionalCoherence);
        fieldValidity *= mix(0.45, 1.0, smoothstep(0.10, 0.42, orientationSample.a));
        float luminanceSupport = smoothstep(0.18, 0.72, darkness);
        float darkFallback = luminanceSupport * mix(0.56, 0.82, orientationConfidence);
        fieldValidity = max(fieldValidity, darkFallback);
        hatching *= uHatching * hatchPresence * clutterSuppression * mix(1.0, 0.52, abstraction) * fieldValidity;
        hatching = 1.0 - pow(1.0 - clamp(hatching, 0.0, 1.0), mix(1.0, 1.55, darkEmphasis));
        float ink = clamp(max(contour, hatching), 0.0, 1.0);

        vec3 paper = uPaperColor;
        float inkLuminance = clamp(0.038 - (uContrast - 1.15) * 0.52, 0.008, 0.55);
        vec3 blackInk = vec3(inkLuminance, inkLuminance * 0.94, inkLuminance * 0.84);
        vec3 blueInk = vec3(inkLuminance * 0.72, min(inkLuminance * 1.65, 0.74), min(inkLuminance * 2.85, 0.82));
        vec3 redInk = vec3(min(inkLuminance * 2.75, 0.80), inkLuminance, inkLuminance * 0.88);
        vec3 inkColor = uInkHue < 0.0 ? mix(blackInk, blueInk, -uInkHue) : mix(blackInk, redInk, uInkHue);
        vec3 result = mix(paper, inkColor, ink);
        gl_FragColor = vec4(clamp(result, 0.0, 1.0), 1.0);
    }
`;
