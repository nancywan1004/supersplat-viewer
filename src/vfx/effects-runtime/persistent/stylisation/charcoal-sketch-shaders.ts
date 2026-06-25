/** 全屏四边形顶点着色器（木炭画单 pass 共用） */
export const CHARCOAL_SKETCH_VERTEX_GLSL = `
    attribute vec2 aPosition;
    varying vec2 vUv0;
    void main(void) {
        vUv0 = (aPosition + 1.0) * 0.5;
        gl_Position = vec4(aPosition, 0.0, 1.0);
    }
`;

/** 木炭画主合成 pass（与参考 demo LegacyPenSketchEffect 一致） */
export const CHARCOAL_SKETCH_MAIN_FRAGMENT_GLSL = `
    precision highp float;
    uniform sampler2D uColorBuffer;
    uniform vec2 uResolution;
    uniform float uOutline;
    uniform float uHatching;
    uniform float uContrast;
    uniform float uStroke;
    uniform float uSmudge;
    uniform float uFocus;
    uniform float uPaper;
    uniform vec3 uPaperColor;
    varying vec2 vUv0;

    float hash12(vec2 p) {
        vec3 p3 = fract(vec3(p.xyx) * 0.1031);
        p3 += dot(p3, p3.yzx + 33.33);
        return fract((p3.x + p3.y) * p3.z);
    }

    float noise(vec2 p) {
        vec2 i = floor(p), f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
            mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
            mix(hash12(i + vec2(0.0, 1.0)), hash12(i + 1.0), f.x),
            f.y
        );
    }

    float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
    vec3 scene(vec2 uv) { return texture2D(uColorBuffer, clamp(uv, 0.0, 1.0)).rgb; }

    float strokeLine(vec2 p, vec2 dir, float spacing, float len, float width, float seed) {
        dir = normalize(dir + vec2(0.0001));
        vec2 n = vec2(-dir.y, dir.x);
        float across = dot(p, n);
        float row = floor(across / spacing);
        float jitter = hash12(vec2(row, seed));
        float line = 1.0 - smoothstep(width, width + 0.9, abs(fract(across / spacing + jitter * 0.31) - 0.5) * spacing);
        float period = len * 1.42;
        float along = mod(dot(p, dir) + jitter * period + seed * 17.0, period);
        float cap = 1.0 - smoothstep(len * 0.82, len, along);
        float rag = 0.70 + 0.30 * noise(p * 0.16 + vec2(seed * 5.7, row * 0.13));
        return line * cap * smoothstep(0.43, 0.66, rag);
    }

    void main(void) {
        vec2 uv = vUv0;
        vec2 texel = 1.0 / max(uResolution, vec2(1.0));
        vec2 pixel = uv * uResolution;
        float aspect = uResolution.x / max(uResolution.y, 1.0);
        vec2 centered = (uv - 0.5) * vec2(aspect, 1.0);
        float radius = length(centered) / length(vec2(0.5 * aspect, 0.5));
        float centerDetail = 1.0 - smoothstep(0.10, 1.03, radius / max(uFocus, 0.18));
        centerDetail = centerDetail * centerDetail * (3.0 - 2.0 * centerDetail);
        float smearRadius = 1.0 + uSmudge * 9.0;
        vec2 smearTexel = texel * smearRadius;

        vec3 raw = scene(uv);
        vec3 blurred = (
            raw * 4.0
            + scene(uv + vec2(smearTexel.x, 0.0)) + scene(uv - vec2(smearTexel.x, 0.0))
            + scene(uv + vec2(0.0, smearTexel.y)) + scene(uv - vec2(0.0, smearTexel.y))
            + scene(uv + smearTexel) + scene(uv - smearTexel)
            + scene(uv + vec2(smearTexel.x, -smearTexel.y)) + scene(uv + vec2(-smearTexel.x, smearTexel.y))
        ) / 12.0;
        vec3 c = mix(raw, blurred, uSmudge);
        vec3 l = scene(uv - vec2(texel.x, 0.0));
        vec3 r = scene(uv + vec2(texel.x, 0.0));
        vec3 d = scene(uv - vec2(0.0, texel.y));
        vec3 u = scene(uv + vec2(0.0, texel.y));
        vec3 ld = scene(uv - texel * 2.6);
        vec3 ru = scene(uv + texel * 2.6);
        vec3 lu = scene(uv + vec2(-texel.x, texel.y) * 2.6);
        vec3 rd = scene(uv + vec2(texel.x, -texel.y) * 2.6);

        float gx = lum(r) - lum(l);
        float gy = lum(u) - lum(d);
        float gxw = lum(ru + rd) - lum(lu + ld);
        float gyw = lum(ru + lu) - lum(rd + ld);
        vec2 gradient = vec2(gx + gxw * 0.34, gy + gyw * 0.34);
        float a = atan(gradient.y, gradient.x) + 1.5707963;
        float stepA = 0.2617994;
        a = floor(a / stepA + 0.5) * stepA;
        vec2 tangent = vec2(cos(a), sin(a));

        float colorEdge = length(r - l) + length(u - d);
        float wideEdge = length(ru - ld) + length(lu - rd);
        float laplace = abs(lum(l + r + u + d) * 0.25 - lum(c));
        float structure = colorEdge * 0.24 + wideEdge * 0.10 + laplace * 0.80;
        float threshold = mix(0.145, 0.052, centerDetail);
        float contour = smoothstep(threshold, threshold * 3.4, structure);
        contour = max(contour, smoothstep(0.25, 0.78, wideEdge) * 0.56);
        contour = pow(contour, mix(1.62, 1.12, clamp(uOutline - 0.4, 0.0, 1.0))) * min(uOutline * 0.76, 1.0);

        float darkness = clamp((0.74 - lum(c)) * uContrast / 0.74, 0.0, 1.0);
        float detail = smoothstep(0.035, 0.24, structure);
        float spacing = mix(9.2, 5.0, detail) * mix(1.42, 0.78, centerDetail) / max(uStroke, 0.2);
        float lengthPx = mix(34.0, 11.0, detail) * mix(1.24, 0.84, centerDetail) * uStroke;
        float width = mix(0.72, 1.02, 1.0 - centerDetail) * uStroke * (1.0 + uSmudge * 0.65);

        float h1 = strokeLine(pixel, tangent, spacing, lengthPx, width, 1.7);
        float ca = 0.574;
        float sa = 0.819;
        vec2 ta = vec2(tangent.x * ca - tangent.y * sa, tangent.x * sa + tangent.y * ca);
        vec2 tb = vec2(tangent.x * ca + tangent.y * sa, -tangent.x * sa + tangent.y * ca);
        float hatch = h1 * smoothstep(0.22, 0.60, darkness);
        hatch += strokeLine(pixel, ta, spacing * 0.92, lengthPx * 0.72, width * 0.86, 8.3) * smoothstep(0.50, 0.82, darkness) * 0.92;
        hatch += strokeLine(pixel, tb, spacing * 0.82, lengthPx * 0.56, width * 0.82, 19.1) * smoothstep(0.74, 0.96, darkness) * 0.88;
        hatch = clamp(hatch * uHatching * pow(centerDetail, 0.62), 0.0, 1.0);

        float ink = clamp(
            contour + hatch * (1.0 - contour * 0.38) + smoothstep(0.91, 1.0, darkness) * (0.04 + 0.10 * centerDetail),
            0.0,
            1.0
        );
        float rubbedTone = smoothstep(0.18, 0.82, darkness) * (0.54 + 0.30 * noise(pixel * vec2(0.025, 0.11)));
        ink = mix(ink, max(ink, rubbedTone), uSmudge * 0.48);
        ink *= 0.92 + (noise(pixel * vec2(0.31, 0.47)) * 0.65 + hash12(pixel) * 0.35) * 0.10;

        float paperMix = pow(uPaper, 1.18);
        vec3 paperDark = uPaperColor * vec3(0.714, 0.557, 0.362);
        vec3 paper = mix(uPaperColor, paperDark, paperMix);
        float fiber = noise(pixel * vec2(0.032, 0.26)) - 0.5;
        float rough = noise(pixel * vec2(0.115, 0.19)) - 0.5;
        float fleck = step(0.91, hash12(floor(pixel * 0.42))) - step(hash12(floor(pixel * 0.42)), 0.055);
        paper += (fiber * 0.075 + rough * 0.045 + fleck * 0.025) * paperMix;

        gl_FragColor = vec4(mix(paper, vec3(0.055, 0.052, 0.046), ink), 1.0);
    }
`;
