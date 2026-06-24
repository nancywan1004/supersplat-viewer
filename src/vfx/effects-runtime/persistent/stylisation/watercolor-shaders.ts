/** 全屏四边形顶点着色器（水彩多 pass 共用） */
export const WATERCOLOR_VERTEX_GLSL = `
    attribute vec2 aPosition;
    varying vec2 vUv0;
    void main(void) {
        gl_Position = vec4(aPosition, 0.0, 1.0);
        vUv0 = (aPosition.xy + 1.0) * 0.5;
    }
`;

/** 湿扩散模糊 pass */
export const WATERCOLOR_BLUR_FRAGMENT_GLSL = `
    precision highp float;
    uniform sampler2D uBlurSource;
    uniform vec2 uBlurTexel;
    uniform float uBlurOffset;
    varying vec2 vUv0;

    void main(void) {
        vec2 d = uBlurTexel * uBlurOffset;
        vec3 color = texture2D(uBlurSource, vUv0).rgb * 0.25;
        color += texture2D(uBlurSource, vUv0 + vec2( d.x, 0.0)).rgb * 0.125;
        color += texture2D(uBlurSource, vUv0 + vec2(-d.x, 0.0)).rgb * 0.125;
        color += texture2D(uBlurSource, vUv0 + vec2(0.0,  d.y)).rgb * 0.125;
        color += texture2D(uBlurSource, vUv0 + vec2(0.0, -d.y)).rgb * 0.125;
        color += texture2D(uBlurSource, vUv0 + vec2( d.x,  d.y)).rgb * 0.0625;
        color += texture2D(uBlurSource, vUv0 + vec2(-d.x,  d.y)).rgb * 0.0625;
        color += texture2D(uBlurSource, vUv0 + vec2( d.x, -d.y)).rgb * 0.0625;
        color += texture2D(uBlurSource, vUv0 + vec2(-d.x, -d.y)).rgb * 0.0625;
        gl_FragColor = vec4(color, 1.0);
    }
`;

/** 水彩主合成 pass（与参考 demo WatercolorShader 一致） */
export const WATERCOLOR_MAIN_FRAGMENT_GLSL = `
    precision highp float;

    uniform sampler2D uColorBuffer;
    uniform sampler2D uWashBuffer;
    uniform sampler2D uBlurBuffer;
    uniform vec2 uResolution;
    uniform float uTime;
    uniform float uBleed;
    uniform float uWash;
    uniform float uBlur;
    uniform float uPaper;
    uniform float uClarity;
    uniform float uSaturation;
    uniform vec3 uPaperColor;
    varying vec2 vUv0;

    float hash(vec2 p) {
        p = fract(p * vec2(123.34, 456.21));
        p += dot(p, p + 45.32);
        return fract(p.x * p.y);
    }

    float valueNoise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
    }

    float fbm(vec2 p) {
        float s = 0.0;
        float a = 0.5;
        for (int i = 0; i < 5; i++) {
            s += a * valueNoise(p);
            p = mat2(1.62, 1.18, -1.18, 1.62) * p;
            a *= 0.52;
        }
        return s;
    }

    vec3 sampleScene(vec2 uv) {
        vec2 sampleUv = clamp(uv, 0.0, 1.0);
        vec3 dryColor = texture2D(uColorBuffer, sampleUv).rgb;
        vec3 wetColor = texture2D(uWashBuffer, sampleUv).rgb;
        vec3 blurredWetColor = texture2D(uBlurBuffer, sampleUv).rgb;
        float blurDifference = length(wetColor - blurredWetColor);
        float wetInterior = 1.0 - smoothstep(0.035, 0.22, blurDifference);
        wetColor = mix(wetColor, blurredWetColor, uBlur * wetInterior);
        float wetMix = uWash * uWash * (3.0 - 2.0 * uWash) * 0.90;
        return mix(dryColor, wetColor, wetMix);
    }

    void main(void) {
        vec2 uv = vUv0;
        vec2 texel = 1.0 / max(uResolution, vec2(1.0));
        vec2 centered = uv - 0.5;
        float centerFocus = 1.0;
        float borderDistance = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
        float paperInterior = smoothstep(0.006, 0.052, borderDistance);
        float borderSpread = 1.0 - smoothstep(0.12, 0.46, borderDistance);
        vec2 paperWarp = vec2(fbm(uv * 4.2), fbm(uv * 4.2 - 13.7)) - 0.5;

        vec3 center = sampleScene(uv);
        vec3 dryCenter = texture2D(uColorBuffer, uv).rgb;
        vec2 structureTexel = texel * 2.5;
        vec3 dryL = texture2D(uColorBuffer, clamp(uv - vec2(structureTexel.x, 0.0), 0.0, 1.0)).rgb;
        vec3 dryR = texture2D(uColorBuffer, clamp(uv + vec2(structureTexel.x, 0.0), 0.0, 1.0)).rgb;
        vec3 dryD = texture2D(uColorBuffer, clamp(uv - vec2(0.0, structureTexel.y), 0.0, 1.0)).rgb;
        vec3 dryU = texture2D(uColorBuffer, clamp(uv + vec2(0.0, structureTexel.y), 0.0, 1.0)).rgb;
        float strongStructure = length(dryR - dryL) + length(dryU - dryD);
        strongStructure = smoothstep(0.22, 0.62, strongStructure);
        center = mix(center, dryCenter, strongStructure * 0.78 * uWash);
        float edgeRadius = mix(2.15, 0.75, centerFocus);
        vec3 cL = sampleScene(uv - vec2(texel.x * edgeRadius, 0.0));
        vec3 cR = sampleScene(uv + vec2(texel.x * edgeRadius, 0.0));
        vec3 cD = sampleScene(uv - vec2(0.0, texel.y * edgeRadius));
        vec3 cU = sampleScene(uv + vec2(0.0, texel.y * edgeRadius));
        float sceneEdge = length(cR - cL) + length(cU - cD);
        sceneEdge = smoothstep(0.045, 0.22, sceneEdge);

        float blurRadius = mix(9.8, 0.72, centerFocus) + borderSpread * (7.5 + 11.0 * uBleed);
        vec2 flowDir = normalize(vec2(
          dot(cR - cL, vec3(0.299, 0.587, 0.114)),
          dot(cU - cD, vec3(0.299, 0.587, 0.114))
        ) + vec2(0.001));
        vec2 wetUv = uv + flowDir * texel * sceneEdge * (2.0 + 9.0 * uBleed) * (1.0 - centerFocus * 0.75);

        vec3 blur = center * 0.22;
        blur += sampleScene(wetUv + texel * vec2( blurRadius, 0.0)) * 0.12;
        blur += sampleScene(wetUv + texel * vec2(-blurRadius, 0.0)) * 0.12;
        blur += sampleScene(wetUv + texel * vec2(0.0,  blurRadius)) * 0.12;
        blur += sampleScene(wetUv + texel * vec2(0.0, -blurRadius)) * 0.12;
        blur += sampleScene(wetUv + texel * vec2( blurRadius * 0.72,  blurRadius * 0.72)) * 0.10;
        blur += sampleScene(wetUv + texel * vec2(-blurRadius * 0.72,  blurRadius * 0.72)) * 0.10;
        blur += sampleScene(wetUv + texel * vec2( blurRadius * 0.72, -blurRadius * 0.72)) * 0.10;
        blur += sampleScene(wetUv + texel * vec2(-blurRadius * 0.72, -blurRadius * 0.72)) * 0.10;

        float luminance = dot(center, vec3(0.299, 0.587, 0.114));
        float pigment = smoothstep(0.05, 0.72, 1.0 - luminance);
        float localVariation = length(center - blur) + sceneEdge * 0.45;
        float paperFiber = fbm(uv * vec2(92.0, 132.0)) * 0.65 + hash(uv * uResolution) * 0.35;

        float detailHold = centerFocus * (0.50 + 0.38 * uClarity);
        float wetArea = (1.0 - centerFocus) * (0.72 + 0.28 * uBleed) + borderSpread * 0.42;
        vec3 wash = mix(center, blur, (0.36 + 0.58 * uBleed * pigment + 0.52 * wetArea) * (1.0 - detailHold));
        float washLum = dot(wash, vec3(0.299, 0.587, 0.114));
        vec3 flatWash = mix(vec3(washLum), wash, 0.52 + 0.22 * centerFocus);
        wash = mix(wash, flatWash, clamp(0.44 + 0.34 * wetArea + 0.18 * uBleed, 0.0, 0.86));
        vec3 lifted = pow(max(wash, 0.0), vec3(0.78 - 0.14 * uClarity));
        wash = mix(wash, lifted, 0.68);
        wash = mix(wash, wash * wash * 1.16, 0.13 * pigment * (1.0 - centerFocus));
        wash = mix(wash, vec3(luminance), 0.12);
        wash *= 1.04 + 0.16 * uClarity;

        float flowA = fbm(uv * vec2(15.0, 8.0) + center.rg * 2.8 + flowDir * 1.7);
        float flowB = fbm(uv * vec2(31.0, 19.0) - center.gb * 2.1);
        float wetFlow = smoothstep(0.24, 0.82, flowA * 0.68 + flowB * 0.32 + pigment * 0.22);
        wash = mix(wash, wash * vec3(0.83, 0.92, 1.03), wetFlow * pigment * (0.22 + 0.26 * uBleed) * (1.0 - centerFocus * 0.65));

        float inkPool = smoothstep(0.16, 0.52, pigment * 0.28 + localVariation * 1.75);
        float wetRim = sceneEdge * smoothstep(0.025, 0.46, pigment + localVariation) * (0.82 + 0.86 * uBleed) * (0.74 + 0.58 * (1.0 - centerFocus));
        wash *= 1.0 - inkPool * (0.035 + 0.065 * uBleed);
        wash *= 1.0 - wetRim * (0.26 + 0.26 * (1.0 - centerFocus));
        wash += vec3(0.018, 0.045, 0.065) * wetRim * 0.24;

        vec3 paper = uPaperColor;
        paper *= 0.965 + paperFiber * 0.07 * uPaper;

        float paintAlpha = smoothstep(0.018, 0.23, pigment);
        paintAlpha *= paperInterior;
        vec3 color = mix(paper, wash, paintAlpha);

        float borderCloud = fbm(uv * vec2(4.1, 2.9) + paperWarp * 3.6);
        float borderCloudMid = fbm(uv * vec2(8.3, 5.7) - paperWarp * 2.4 + borderCloud * 1.8);
        float borderCloudFine = fbm(uv * vec2(19.0, 12.0) + paperWarp * 2.8 - borderCloudMid);

        float outerLimit = clamp(
          0.005 + (borderCloud - 0.5) * 0.020 + (borderCloudFine - 0.5) * 0.010,
          0.001,
          0.020
        );
        float middleLimit = clamp(
          0.018 + (borderCloud - 0.5) * 0.046 + (borderCloudMid - 0.5) * 0.020,
          0.006,
          0.048
        );
        float innerLimit = clamp(
          0.038 + (borderCloud - 0.5) * 0.082 + (borderCloudMid - 0.5) * 0.038,
          0.014,
          0.086
        );
        float outerDeckle = smoothstep(outerLimit, outerLimit + 0.024, borderDistance);
        float middleDeckle = smoothstep(middleLimit, middleLimit + 0.032, borderDistance);
        float innerDeckle = smoothstep(innerLimit, innerLimit + 0.042, borderDistance);

        vec3 paleEdgeWash = mix(paper, wash, 0.17 + borderCloudMid * 0.10);
        vec3 middleEdgeWash = mix(paper, wash, 0.34 + borderCloud * 0.13);
        vec3 originalWatercolor = color;
        color = mix(paper * 1.015, paleEdgeWash, outerDeckle * (0.46 + 0.16 * uBleed));
        color = mix(color, middleEdgeWash, middleDeckle * (0.48 + 0.16 * uBleed));
        color = mix(color, originalWatercolor, innerDeckle);

        float outerRim = max(outerDeckle - middleDeckle, 0.0);
        float middleRim = max(middleDeckle - innerDeckle, 0.0);
        float brokenRim = 0.52 + smoothstep(0.28, 0.78, borderCloudFine) * 0.76;
        float layeredRim = (outerRim * 0.38 + middleRim * 0.62) * brokenRim;
        color *= 1.0 - layeredRim * (0.15 + 0.18 * uBleed);
        color += vec3(0.022, 0.042, 0.056) * layeredRim * 0.18;

        vec2 runDirection = normalize(flowDir + paperWarp * 0.85 + centered * 0.20 + vec2(0.001));
        vec2 runNormal = vec2(-runDirection.y, runDirection.x);
        vec2 runUv = uv + paperWarp * (0.035 + 0.030 * uBleed);
        vec2 runCoord = vec2(dot(runUv, runNormal), dot(runUv, runDirection));
        float longRun = fbm(runCoord * vec2(34.0, 7.0) + vec2(borderCloud * 3.2, uTime * 0.018));
        float tornRun = fbm(runCoord * vec2(15.0, 27.0) - paperWarp * 4.6);
        float fluidTrail = smoothstep(0.68, 0.88, longRun + tornRun * 0.16);
        fluidTrail *= smoothstep(0.52, 0.79, fbm(runCoord * vec2(21.0, 12.0) + longRun * 3.4));
        float edgeRegion = (1.0 - innerDeckle) * outerDeckle;
        float flowingSplatter = fluidTrail * edgeRegion * (0.22 + 0.58 * uBleed);
        vec3 flowingPigment = mix(paleEdgeWash, wash, 0.54 + tornRun * 0.18);
        color = mix(color, flowingPigment * (0.91 + longRun * 0.08), flowingSplatter * 0.52);

        color -= wetRim * vec3(0.07, 0.052, 0.036);
        color += (paperFiber - 0.5) * 0.075 * uPaper * (1.0 - paintAlpha * 0.95);
        color = mix(color, vec3(dot(color, vec3(0.299, 0.587, 0.114))), -0.12 + 0.16 * uClarity);
        float finalLuminance = dot(color, vec3(0.299, 0.587, 0.114));
        float saturationScale = uSaturation <= 1.0
          ? uSaturation
          : 1.0 + (uSaturation - 1.0) * 2.0;
        color = vec3(finalLuminance) + (color - vec3(finalLuminance)) * saturationScale;
        color = clamp(color, 0.0, 1.0);

        gl_FragColor = vec4(color, 1.0);
    }
`;
