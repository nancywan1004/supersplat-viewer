import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR,
    PostEffect,
    RenderTarget,
    SEMANTIC_POSITION,
    Shader,
    Texture,
    type AppBase,
    type CameraComponent,
    type CameraFrame,
    type GraphicsDevice
} from 'playcanvas';

import { POINTILLISM_DEFAULTS, POINTILLISM_STIPPLE_SIZE_MAX, POINTILLISM_STIPPLE_SIZE_MIN, resolvePointillismComplementaryMix, resolvePointillismEdgeThreshold } from './pointillism-stipple-shaders';

/** stippleSize ↑ → 目标屏幕点半径 ↓（约 1–5 px，由 modify 层 dotRadiusSlope 驱动） */
export const POINTILLISM_STIPPLE_SIZE_STEPS = [32, 48, 64, 72, 96, 128, 160, 192, 224] as const;

type Rgb = [number, number, number];

export type PointillismPostSettings = {
    enabled: boolean;
    postEffectEnabled: boolean;
    stippleSize: number;
    /** 协议保留，不参与后处理着色 */
    paletteIndex: number;
    paletteStrength: number;
    levels: number;
    levelRange: number;
    ditherSpread: number;
    warmCoolSplit: number;
    sourceStructureBlend: number;
    saturation: number;
    complementaryMix: number;
    contrastDotMix: number;
    dotRadiusPx: number;
    gapSpacing: number;
    seed: number;
    skyboxPointillismStrength: number;
    paperStrength: number;
    paperTint: [number, number, number];
    edgeThreshold: number;
    edgeStrength: number;
    denoiseStrength: number;
    gapFill: number;
};

export const POINTILLISM_PALETTE_NAMES: Record<number, string> = {
    0: '暖橙厚涂',
    1: '紫蓝橙光',
    2: '翠绿金黄',
    3: '大地中性'
};

export const DEFAULT_POINTILLISM_POST_SETTINGS: PointillismPostSettings = {
    enabled: false,
    postEffectEnabled: POINTILLISM_DEFAULTS.postEffectEnabled,
    stippleSize: POINTILLISM_DEFAULTS.stippleSize,
    paletteIndex: POINTILLISM_DEFAULTS.paletteIndex,
    paletteStrength: POINTILLISM_DEFAULTS.paletteStrength,
    levels: POINTILLISM_DEFAULTS.levels,
    levelRange: POINTILLISM_DEFAULTS.levelRange,
    ditherSpread: POINTILLISM_DEFAULTS.ditherSpread,
    warmCoolSplit: POINTILLISM_DEFAULTS.warmCoolSplit,
    sourceStructureBlend: POINTILLISM_DEFAULTS.sourceStructureBlend,
    saturation: POINTILLISM_DEFAULTS.saturation,
    complementaryMix: resolvePointillismComplementaryMix(POINTILLISM_DEFAULTS.contrastDotMix),
    contrastDotMix: POINTILLISM_DEFAULTS.contrastDotMix,
    dotRadiusPx: POINTILLISM_DEFAULTS.dotRadiusPx,
    gapSpacing: POINTILLISM_DEFAULTS.gapSpacing,
    seed: POINTILLISM_DEFAULTS.seed,
    skyboxPointillismStrength: POINTILLISM_DEFAULTS.skyboxPointillismStrength,
    paperStrength: POINTILLISM_DEFAULTS.paperStrength,
    paperTint: [...POINTILLISM_DEFAULTS.paperTint],
    edgeThreshold: resolvePointillismEdgeThreshold(POINTILLISM_DEFAULTS.edgeStrength),
    edgeStrength: POINTILLISM_DEFAULTS.edgeStrength,
    denoiseStrength: POINTILLISM_DEFAULTS.denoiseStrength,
    gapFill: POINTILLISM_DEFAULTS.gapFill
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const finiteOr = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

export const coercePointillismBool = (v: unknown, fallback: boolean): boolean => {
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1' || v === 'true') return true;
    if (v === 0 || v === '0' || v === 'false') return false;
    return fallback;
};

const snapStippleSize = (v: number): number => {
    const steps = POINTILLISM_STIPPLE_SIZE_STEPS;
    let best: number = steps[0];
    let bestDist = Math.abs(v - best);
    for (let i = 1; i < steps.length; i++) {
        const dist = Math.abs(v - steps[i]);
        if (dist < bestDist) {
            best = steps[i];
            bestDist = dist;
        }
    }
    return best;
};

const normalizeColor = (v: unknown, fallback: Rgb): Rgb => {
    if (!Array.isArray(v) || v.length < 3) return [...fallback];
    return [
        clamp(finiteOr(v[0], fallback[0]), 0, 1),
        clamp(finiteOr(v[1], fallback[1]), 0, 1),
        clamp(finiteOr(v[2], fallback[2]), 0, 1)
    ];
};

export function normalizePointillismPostSettings(raw: unknown): PointillismPostSettings {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        enabled: coercePointillismBool(obj.enabled, false),
        postEffectEnabled: coercePointillismBool(
            obj.postEffectEnabled,
            DEFAULT_POINTILLISM_POST_SETTINGS.postEffectEnabled
        ),
        stippleSize: snapStippleSize(clamp(
            finiteOr(obj.stippleSize, DEFAULT_POINTILLISM_POST_SETTINGS.stippleSize),
            POINTILLISM_STIPPLE_SIZE_MIN,
            POINTILLISM_STIPPLE_SIZE_MAX
        )),
        paletteIndex: clamp(Math.floor(finiteOr(obj.paletteIndex, DEFAULT_POINTILLISM_POST_SETTINGS.paletteIndex)), 0, 3),
        paletteStrength: clamp(finiteOr(obj.paletteStrength, DEFAULT_POINTILLISM_POST_SETTINGS.paletteStrength), 0, 1),
        levels: clamp(Math.floor(finiteOr(obj.levels, DEFAULT_POINTILLISM_POST_SETTINGS.levels)), 2, 20),
        levelRange: clamp(finiteOr(obj.levelRange, DEFAULT_POINTILLISM_POST_SETTINGS.levelRange), 0.5, 2),
        ditherSpread: clamp(finiteOr(obj.ditherSpread, DEFAULT_POINTILLISM_POST_SETTINGS.ditherSpread), 0, 0.2),
        warmCoolSplit: clamp(finiteOr(obj.warmCoolSplit, DEFAULT_POINTILLISM_POST_SETTINGS.warmCoolSplit), 0, 1),
        sourceStructureBlend: clamp(
            finiteOr(obj.sourceStructureBlend, DEFAULT_POINTILLISM_POST_SETTINGS.sourceStructureBlend),
            0,
            1
        ),
        saturation: clamp(finiteOr(obj.saturation, DEFAULT_POINTILLISM_POST_SETTINGS.saturation), 0, 3),
        contrastDotMix: clamp(finiteOr(obj.contrastDotMix, DEFAULT_POINTILLISM_POST_SETTINGS.contrastDotMix), 0, 1),
        dotRadiusPx: clamp(finiteOr(obj.dotRadiusPx, DEFAULT_POINTILLISM_POST_SETTINGS.dotRadiusPx), 0.25, 7.5),
        gapSpacing: clamp(finiteOr(obj.gapSpacing, DEFAULT_POINTILLISM_POST_SETTINGS.gapSpacing), 0, 1),
        complementaryMix: clamp(
            finiteOr(obj.complementaryMix, resolvePointillismComplementaryMix(
                finiteOr(obj.contrastDotMix, DEFAULT_POINTILLISM_POST_SETTINGS.contrastDotMix)
            )),
            0,
            1
        ),
        seed: clamp(finiteOr(obj.seed, DEFAULT_POINTILLISM_POST_SETTINGS.seed), 0, 997),
        skyboxPointillismStrength: clamp(
            finiteOr(obj.skyboxPointillismStrength, DEFAULT_POINTILLISM_POST_SETTINGS.skyboxPointillismStrength),
            0,
            1
        ),
        paperStrength: clamp(finiteOr(obj.paperStrength, DEFAULT_POINTILLISM_POST_SETTINGS.paperStrength), 0, 1),
        paperTint: normalizeColor(obj.paperTint, DEFAULT_POINTILLISM_POST_SETTINGS.paperTint),
        edgeStrength: clamp(finiteOr(obj.edgeStrength, DEFAULT_POINTILLISM_POST_SETTINGS.edgeStrength), 0, 1),
        edgeThreshold: clamp(
            finiteOr(obj.edgeThreshold, resolvePointillismEdgeThreshold(
                finiteOr(obj.edgeStrength, DEFAULT_POINTILLISM_POST_SETTINGS.edgeStrength)
            )),
            0.02,
            1
        ),
        denoiseStrength: clamp(
            finiteOr(obj.denoiseStrength, DEFAULT_POINTILLISM_POST_SETTINGS.denoiseStrength),
            0,
            1
        ),
        gapFill: clamp(finiteOr(obj.gapFill, DEFAULT_POINTILLISM_POST_SETTINGS.gapFill), 0, 1)
    };
}

class PointillismPostEffect extends PostEffect {
    private readonly shader: Shader;
    private settings: PointillismPostSettings = DEFAULT_POINTILLISM_POST_SETTINGS;

    readonly uPaperTint = new Float32Array(3);
    readonly uResolution = new Float32Array(2);

    constructor(device: GraphicsDevice, precision: string) {
        super(device);

        const vshader = `
            attribute vec2 aPosition;
            varying vec2 vUv0;
            void main(void) {
                gl_Position = vec4(aPosition, 0.0, 1.0);
                vUv0 = (aPosition.xy + 1.0) * 0.5;
            }
        `;

        const fshader = `
            precision ${precision} float;

            varying vec2 vUv0;
            uniform sampler2D uColorBuffer;
            uniform vec2 uResolution;
            uniform float uSaturation;
            uniform float uLevelRange;
            uniform float uWarmCoolSplit;
            uniform float uContrastDotMix;
            uniform float uDotRadiusPx;
            uniform float uGapSpacing;
            uniform float uSourceStructureBlend;
            uniform float uSkyboxPointillismStrength;
            uniform float uPaperStrength;
            uniform vec3 uPaperTint;
            uniform float uEdgeThreshold;
            uniform float uEdgeStrength;
            uniform float uDenoiseStrength;
            uniform float uGapFill;

            float getLuminance(vec3 color) {
                return dot(color, vec3(0.299, 0.587, 0.114));
            }

            vec3 saturateColor(vec3 color, float amount) {
                float luma = getLuminance(color);
                return mix(vec3(luma), color, max(0.0, amount));
            }

            vec3 applyContrast(vec3 color, float levelRange) {
                float t = clamp((levelRange - 0.5) / 1.5, 0.0, 1.0);
                float contrast = mix(0.38, 2.45, t);
                float luma = getLuminance(color);
                return clamp(mix(vec3(luma), color, contrast), 0.0, 1.0);
            }

            float lumaAt(vec2 uv) {
                return getLuminance(texture2D(uColorBuffer, uv).rgb);
            }

            float lumaBlur3(vec2 uv) {
                vec2 px = 1.0 / uResolution;
                return (
                    lumaAt(uv) * 0.25 +
                    lumaAt(uv + vec2(px.x, 0.0)) * 0.1875 +
                    lumaAt(uv + vec2(-px.x, 0.0)) * 0.1875 +
                    lumaAt(uv + vec2(0.0, px.y)) * 0.1875 +
                    lumaAt(uv + vec2(0.0, -px.y)) * 0.1875
                );
            }

            float sobelGradRaw(vec2 uv) {
                vec2 px = 1.0 / uResolution;
                float tl = lumaAt(uv + vec2(-px.x, px.y));
                float t  = lumaAt(uv + vec2(0.0, px.y));
                float tr = lumaAt(uv + vec2(px.x, px.y));
                float l  = lumaAt(uv + vec2(-px.x, 0.0));
                float r  = lumaAt(uv + vec2(px.x, 0.0));
                float bl = lumaAt(uv + vec2(-px.x, -px.y));
                float b  = lumaAt(uv + vec2(0.0, -px.y));
                float br = lumaAt(uv + vec2(px.x, -px.y));
                float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
                float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
                return length(vec2(gx, gy));
            }

            float sobelGradBlur(vec2 uv) {
                vec2 px = 1.0 / uResolution;
                float tl = lumaBlur3(uv + vec2(-px.x, px.y));
                float t  = lumaBlur3(uv + vec2(0.0, px.y));
                float tr = lumaBlur3(uv + vec2(px.x, px.y));
                float l  = lumaBlur3(uv + vec2(-px.x, 0.0));
                float r  = lumaBlur3(uv + vec2(px.x, 0.0));
                float bl = lumaBlur3(uv + vec2(-px.x, -px.y));
                float b  = lumaBlur3(uv + vec2(0.0, -px.y));
                float br = lumaBlur3(uv + vec2(px.x, -px.y));
                float gx = -tl - 2.0 * l - bl + tr + 2.0 * r + br;
                float gy = -tl - 2.0 * t - tr + bl + 2.0 * b + br;
                return length(vec2(gx, gy));
            }

            float edgeFactor(vec2 uv) {
                float gradBlur = sobelGradBlur(uv);
                float gradRaw = sobelGradRaw(uv);
                float edgeW = clamp(uEdgeStrength, 0.0, 1.0);
                float grad = mix(gradBlur, max(gradBlur, gradRaw * 0.55), edgeW);
                float thresh = mix(0.008, 0.22, clamp(uEdgeThreshold, 0.02, 1.0));
                return smoothstep(thresh, thresh * 2.4, grad);
            }

            vec3 boxBlur5(vec2 uv) {
                vec2 px = 1.0 / uResolution;
                return (
                    texture2D(uColorBuffer, uv).rgb * 0.36 +
                    texture2D(uColorBuffer, uv + vec2(px.x, 0.0)).rgb * 0.16 +
                    texture2D(uColorBuffer, uv + vec2(-px.x, 0.0)).rgb * 0.16 +
                    texture2D(uColorBuffer, uv + vec2(0.0, px.y)).rgb * 0.16 +
                    texture2D(uColorBuffer, uv + vec2(0.0, -px.y)).rgb * 0.16
                );
            }

            vec3 flatOpticalMix(vec2 uv, vec3 centerColor, float flatMix) {
                vec2 px = 1.0 / uResolution;
                float radius = mix(0.9, 3.0, flatMix);
                float centerL = getLuminance(centerColor);
                vec3 acc = vec3(0.0);
                float wsum = 0.0;
                for (int dy = -2; dy <= 2; dy++) {
                    for (int dx = -2; dx <= 2; dx++) {
                        float adx = abs(float(dx));
                        float ady = abs(float(dy));
                        if (adx + ady > 2.0) continue;
                        vec2 off = vec2(float(dx), float(dy)) * px * radius;
                        vec3 s = texture2D(uColorBuffer, uv + off).rgb;
                        float lSim = 1.0 - clamp(abs(getLuminance(s) - centerL) * 2.5, 0.0, 1.0);
                        float rgbSim = 1.0 - clamp(length(s - centerColor) * 1.8, 0.0, 1.0);
                        float sim = lSim * rgbSim;
                        acc += s * sim;
                        wsum += sim;
                    }
                }
                vec3 mixed = acc / max(wsum, 0.001);
                float mixAmt = min(mix(0.04, 0.38, flatMix), 0.35);
                return mix(centerColor, mixed, mixAmt);
            }

            // 结构边缘（blur sobel，阈值偏高，避免点颗粒误判）
            float structureEdgeMask(vec2 uv) {
                float grad = sobelGradBlur(uv);
                return smoothstep(0.014, 0.048, grad);
            }

            vec3 quantizeInteriorLuma(vec3 color, float amount) {
                float t = clamp(amount, 0.0, 1.0);
                if (t < 0.001) {
                    return color;
                }
                float l = getLuminance(color);
                float steps = mix(18.0, 7.0, t);
                float q = floor(l * steps + 0.5) / steps;
                return clamp(color * (q / max(l, 0.001)), 0.0, 1.0);
            }

            vec3 suppressSpeckles(vec2 uv, vec3 center) {
                vec3 blur = boxBlur5(uv);
                float d = clamp(uDenoiseStrength, 0.0, 1.0);
                float lLo = mix(0.07, 0.045, d);
                float lHi = mix(0.24, 0.16, d);
                float rgbLo = mix(0.10, 0.06, d);
                float rgbHi = mix(0.32, 0.22, d);
                float maxMix = mix(0.68, 0.90, d);
                float lDiff = abs(getLuminance(center) - getLuminance(blur));
                float rgbDiff = length(center - blur);
                float spike = smoothstep(lLo, lHi, lDiff) * smoothstep(rgbLo, rgbHi, rgbDiff);
                return mix(center, blur, spike * maxMix);
            }

            vec3 boxBlurWide(vec2 uv, float radiusPx) {
                vec2 px = 1.0 / uResolution * radiusPx;
                vec3 acc = vec3(0.0);
                acc += texture2D(uColorBuffer, uv).rgb * 0.22;
                acc += texture2D(uColorBuffer, uv + vec2(px.x, 0.0)).rgb * 0.11;
                acc += texture2D(uColorBuffer, uv + vec2(-px.x, 0.0)).rgb * 0.11;
                acc += texture2D(uColorBuffer, uv + vec2(0.0, px.y)).rgb * 0.11;
                acc += texture2D(uColorBuffer, uv + vec2(0.0, -px.y)).rgb * 0.11;
                acc += texture2D(uColorBuffer, uv + vec2(px.x, px.y)).rgb * 0.085;
                acc += texture2D(uColorBuffer, uv + vec2(-px.x, px.y)).rgb * 0.085;
                acc += texture2D(uColorBuffer, uv + vec2(px.x, -px.y)).rgb * 0.085;
                acc += texture2D(uColorBuffer, uv + vec2(-px.x, -px.y)).rgb * 0.085;
                return acc;
            }

            float bgHash21(vec2 p) {
                p = fract(p * vec2(123.34, 456.21));
                p += dot(p, p + 45.32);
                return fract(p.x * p.y);
            }

            vec2 bgHash22(vec2 p) {
                return vec2(bgHash21(p), bgHash21(p + vec2(37.13, 17.71)));
            }

            float skyboxBackgroundMask(vec2 uv, vec3 rawColor, vec3 localBlur, float structEdge) {
                float luma = getLuminance(rawColor);
                float chroma = length(rawColor - vec3(luma));
                float detail = sobelGradBlur(uv) * 1.25 + length(rawColor - localBlur) * 0.92;
                float smoothArea = 1.0 - smoothstep(0.026, 0.18, detail);

                float blueBias = smoothstep(0.02, 0.24, rawColor.b - max(rawColor.r * 0.94, rawColor.g * 0.78));
                float cyanBias = smoothstep(0.02, 0.22, rawColor.g - rawColor.r * 0.78)
                    * smoothstep(-0.02, 0.16, rawColor.b - rawColor.r * 0.82);
                float cloudBias = smoothstep(0.58, 0.93, luma)
                    * (1.0 - smoothstep(0.20, 0.42, chroma))
                    * smoothstep(-0.05, 0.12, rawColor.b - rawColor.r);
                float upperWeight = smoothstep(0.08, 0.55, uv.y);
                float skyLike = max(max(blueBias, cyanBias * 0.82), cloudBias * upperWeight);

                return clamp(smoothArea * skyLike * mix(0.38, 1.0, upperWeight) * (1.0 - structEdge * 0.72), 0.0, 1.0);
            }

            float skyDaubMask(vec2 fragPx, float spacing, float radiusPx, vec2 salt, float aspectScale) {
                vec2 warped = fragPx + vec2(
                    bgHash21(floor(fragPx / 96.0) + salt) - 0.5,
                    bgHash21(floor(fragPx / 96.0) + salt + 17.0) - 0.5
                ) * radiusPx * 0.72;
                vec2 cell = floor((warped + salt) / spacing);
                vec2 local = fract((warped + salt) / spacing) * spacing - spacing * 0.5;
                vec2 jitter = (bgHash22(cell + salt * 0.07) - 0.5) * min(spacing * 0.22, radiusPx * 0.68);
                float angle = bgHash21(cell + salt * 0.13) * 6.2831853;
                float c = cos(angle);
                float s = sin(angle);
                vec2 p = local - jitter;
                vec2 q = vec2(c * p.x - s * p.y, s * p.x + c * p.y);
                float rx = radiusPx * mix(1.02, 1.28, bgHash21(cell + 5.7)) * aspectScale;
                float ry = radiusPx * mix(0.76, 0.98, bgHash21(cell + 9.1)) / max(aspectScale, 0.001);
                float d = pow(abs(q.x) / max(rx, 0.001), 2.8) + pow(abs(q.y) / max(ry, 0.001), 2.8);
                float broken = mix(0.86, 1.08, bgHash21(cell + 23.4));
                return 1.0 - smoothstep(0.82 * broken, 1.08 * broken, d);
            }

            vec3 skyboxStyledColor(vec3 base, vec2 cell, float luma, float t) {
                float rnd = bgHash21(cell + vec2(3.1, 8.7));
                vec3 color = applyContrast(saturateColor(base, uSaturation), uLevelRange);

                vec3 warm = vec3(1.0, 0.67, 0.22);
                vec3 cool = vec3(0.12, 0.46, 1.0);
                float splitT = clamp(uWarmCoolSplit, 0.0, 1.0);
                float lightSide = smoothstep(0.38, 0.90, luma);
                vec3 split = mix(cool, warm, lightSide);
                color = mix(color, split, splitT * mix(0.08, 0.30, rnd) * t);

                float contrastMix = clamp(uContrastDotMix, 0.0, 0.55);
                vec3 accent = (rnd < 0.5) ? vec3(0.98, 0.46, 0.12) : vec3(0.08, 0.35, 1.0);
                color = mix(color, accent, contrastMix * mix(0.16, 0.52, bgHash21(cell + 41.0)) * t);
                color *= mix(0.66, 1.34, bgHash21(cell + 13.0));
                return clamp(color, 0.0, 1.0);
            }

            vec3 skyboxCellColor(vec2 cell, float spacing, vec2 salt) {
                vec2 jitter = (bgHash22(cell + salt * 0.07) - 0.5) * min(spacing * 0.18, spacing * 0.22);
                vec2 centerPx = (cell + 0.5) * spacing - salt + jitter;
                vec2 centerUv = clamp(centerPx / uResolution, vec2(0.001), vec2(0.999));
                return mix(texture2D(uColorBuffer, centerUv).rgb, boxBlurWide(centerUv, 2.4), 0.08);
            }

            vec3 skyboxPointillize(vec2 uv, vec3 rawColor) {
                float t = clamp(uSkyboxPointillismStrength, 0.0, 1.0);
                vec2 fragPx = gl_FragCoord.xy;
                float radiusPx = clamp(2.4 + uDotRadiusPx * 8.6, 4.0, 42.0);
                float spacing = radiusPx * mix(2.36, 2.04, t) + mix(3.2, 11.5, clamp(uGapSpacing, 0.0, 1.0));

                vec2 cell1 = floor(fragPx / spacing);
                vec2 cell2 = floor((fragPx + vec2(0.43, 0.37) * spacing) / (spacing * 0.92));
                vec2 cell3 = floor((fragPx + vec2(0.22, 0.71) * spacing) / (spacing * 1.28));
                vec2 salt1 = vec2(0.0, 0.0);
                vec2 salt2 = vec2(19.0, 31.0);
                vec2 salt3 = vec2(47.0, 11.0);
                float m1 = skyDaubMask(fragPx, spacing, radiusPx, salt1, 1.04);
                float m2 = skyDaubMask(fragPx, spacing * 0.96, radiusPx * 0.64, salt2, 0.92);
                float m3 = skyDaubMask(fragPx, spacing * 1.34, radiusPx * 0.46, salt3, 1.12);
                float layer = clamp(max(max(m1, m2 * mix(0.12, 0.34, t)), m3 * 0.18), 0.0, 1.0);

                vec3 base1 = skyboxCellColor(cell1, spacing, salt1);
                vec3 base2 = skyboxCellColor(cell2, spacing * 0.92, salt2);
                vec3 base3 = skyboxCellColor(cell3, spacing * 1.28, salt3);
                vec3 color1 = skyboxStyledColor(base1, cell1, getLuminance(base1), t);
                vec3 color2 = skyboxStyledColor(base2, cell2 + vec2(23.0, 7.0), getLuminance(base2), t);
                vec3 color3 = skyboxStyledColor(base3, cell3 + vec2(5.0, 29.0), getLuminance(base3), t);
                vec3 daubColor = mix(color1, color2, smoothstep(0.12, 0.72, m2));
                daubColor = mix(daubColor, color3, smoothstep(0.18, 0.78, m3) * 0.55);

                vec3 softBase = mix(boxBlurWide(uv, 12.0), boxBlurWide(uv, 28.0), 0.46);
                vec3 gapColor = mix(softBase, applyContrast(saturateColor(softBase, uSaturation * 0.62), uLevelRange), 0.12);
                gapColor = mix(gapColor, vec3(0.98, 0.96, 0.90), mix(0.24, 0.52, t));
                gapColor *= mix(0.92, 1.06, bgHash21(floor(fragPx / 72.0) + 3.7));
                return clamp(mix(gapColor, daubColor, layer), 0.0, 1.0);
            }

            float paintWeight(vec3 s, float refL) {
                float sL = getLuminance(s);
                return smoothstep(0.025, 0.14, sL - refL + 0.05)
                    + smoothstep(0.015, 0.08, length(s - vec3(sL))) * 0.35;
            }

            vec3 fillSparseHoles(vec2 uv, vec3 rawCenter, vec3 center) {
                float fillT = clamp(uGapFill, 0.0, 1.0);
                if (fillT < 0.001) {
                    return center;
                }

                vec2 px = 1.0 / uResolution;
                float centerL = getLuminance(rawCenter);
                float wideR = mix(2.8, 8.5, fillT);
                vec3 widePaint = boxBlurWide(uv, wideR);
                float wideL = getLuminance(widePaint);

                float voidByLuma = smoothstep(0.012, 0.10, wideL - centerL);
                float voidByRgb = smoothstep(0.035, 0.20, length(widePaint - rawCenter));
                float hole = max(voidByLuma, voidByRgb * 0.88);

                float radius = mix(2.0, 7.0, fillT);
                vec3 acc = vec3(0.0);
                float psum = 0.0;
                for (int dy = -3; dy <= 3; dy++) {
                    for (int dx = -3; dx <= 3; dx++) {
                        if (dx == 0 && dy == 0) {
                            continue;
                        }
                        float adx = abs(float(dx));
                        float ady = abs(float(dy));
                        if (adx + ady > 3.0) {
                            continue;
                        }
                        vec2 off = vec2(float(dx), float(dy)) * px * radius;
                        vec3 s = texture2D(uColorBuffer, uv + off).rgb;
                        float w = paintWeight(s, centerL);
                        acc += s * w;
                        psum += w;
                    }
                }
                vec3 fillColor = (psum > 0.002) ? (acc / psum) : widePaint;
                float mixAmt = hole * fillT * mix(0.75, 0.96, fillT);
                return mix(center, fillColor, mixAmt);
            }

            void main() {
                vec2 uv = vUv0;
                vec3 rawScene = texture2D(uColorBuffer, uv).rgb;
                vec3 sceneColor = rawScene;
                vec3 blur = boxBlur5(uv);

                sceneColor = suppressSpeckles(uv, sceneColor);
                sceneColor = fillSparseHoles(uv, rawScene, sceneColor);

                float structure = clamp(uSourceStructureBlend, 0.0, 1.0);
                float flatDesire = 1.0 - structure;
                float structEdge = structureEdgeMask(uv);
                float interiorMask = (1.0 - structEdge) * (1.0 - structEdge);

                float grain = clamp(length(sceneColor - blur) * 4.2, 0.0, 1.0);
                float dotMask = smoothstep(0.20, 0.52, grain);
                float flattenMask = interiorMask * (1.0 - dotMask * structure * 0.62);

                float flatMix = mix(0.06, 0.58, flatDesire) * flattenMask;
                vec3 flattened = flatOpticalMix(uv, sceneColor, flatMix);
                float quantAmt = flatDesire * flattenMask * 0.52;
                flattened = mix(flattened, quantizeInteriorLuma(flattened, quantAmt), quantAmt);

                float keepStructure = max(structEdge, structure * mix(0.28, 1.0, dotMask));
                vec3 color = mix(flattened, sceneColor, keepStructure);

                float postSat = 1.0 + max(0.0, uSaturation - 1.0) * 0.28;
                color = saturateColor(color, postSat);
                color = applyContrast(color, uLevelRange);
                color = mix(color, color * uPaperTint, uPaperStrength * 0.42);

                float edgeW = clamp(uEdgeStrength, 0.0, 1.0);
                float edge = edgeFactor(uv);
                float edgeAmt = clamp(edge * mix(0.0, 1.45, edgeW), 0.0, 1.0) * structEdge;
                vec3 highPass = sceneColor - blur;
                vec3 sharpen = clamp(sceneColor + highPass * mix(1.2, 3.8, edgeW), 0.0, 1.0);
                color = mix(color, sharpen, edgeAmt * 0.85);

                vec3 edgePop = saturateColor(color, 1.0 + edgeW * 0.18);
                color = mix(color, edgePop, edgeAmt * 0.38);

                float skyboxStrength = clamp(uSkyboxPointillismStrength, 0.0, 1.0);
                if (skyboxStrength > 0.001) {
                    float bgMask = skyboxBackgroundMask(uv, rawScene, blur, structEdge);
                    vec3 bgPoint = skyboxPointillize(uv, rawScene);
                    color = mix(color, bgPoint, bgMask * mix(0.25, 1.0, skyboxStrength));
                }

                gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
            }
        `;

        this.shader = new Shader(device, {
            attributes: { aPosition: SEMANTIC_POSITION },
            vshader,
            fshader
        });
    }

    setSettings(raw: unknown): void {
        this.settings = normalizePointillismPostSettings(raw);
        this.uPaperTint[0] = this.settings.paperTint[0];
        this.uPaperTint[1] = this.settings.paperTint[1];
        this.uPaperTint[2] = this.settings.paperTint[2];
    }

    render(inputTarget: { colorBuffer?: Texture }, outputTarget: RenderTarget, rect: unknown): void {
        const colorBuffer = inputTarget?.colorBuffer;
        if (!colorBuffer) return;

        const scope = this.device.scope;
        const s = this.settings;

        this.uResolution[0] = colorBuffer.width;
        this.uResolution[1] = colorBuffer.height;

        scope.resolve('uColorBuffer').setValue(colorBuffer);
        scope.resolve('uResolution').setValue(this.uResolution);
        scope.resolve('uSaturation').setValue(s.saturation);
        scope.resolve('uLevelRange').setValue(s.levelRange);
        scope.resolve('uWarmCoolSplit').setValue(s.warmCoolSplit);
        scope.resolve('uContrastDotMix').setValue(s.contrastDotMix);
        scope.resolve('uDotRadiusPx').setValue(s.dotRadiusPx);
        scope.resolve('uGapSpacing').setValue(s.gapSpacing);
        scope.resolve('uSourceStructureBlend').setValue(s.sourceStructureBlend);
        scope.resolve('uSkyboxPointillismStrength').setValue(s.skyboxPointillismStrength);
        scope.resolve('uPaperStrength').setValue(s.paperStrength);
        scope.resolve('uPaperTint').setValue(this.uPaperTint);
        scope.resolve('uEdgeThreshold').setValue(s.edgeThreshold);
        scope.resolve('uEdgeStrength').setValue(s.edgeStrength);
        scope.resolve('uDenoiseStrength').setValue(s.denoiseStrength);
        scope.resolve('uGapFill').setValue(s.gapFill);

        this.drawQuad(outputTarget, this.shader, rect as any);
    }
}

class PointillismCameraFrameBridge {
    private readonly effect: PointillismPostEffect;
    private outputTarget: RenderTarget | null = null;
    private hookedRenderPassCamera: unknown = null;
    private originalFrameUpdate: (() => void) | null = null;
    private active = false;

    constructor(effect: PointillismPostEffect) {
        this.effect = effect;
    }

    mount(cameraFrame: CameraFrame): boolean {
        const renderPassCamera = (cameraFrame as unknown as { renderPassCamera?: unknown }).renderPassCamera as {
            frameUpdate?: () => void;
            composePass?: { sceneTexture?: Texture | null };
        } | undefined;

        if (!renderPassCamera?.composePass) {
            return false;
        }

        if (this.hookedRenderPassCamera !== renderPassCamera) {
            this.unhook();
            this.hookedRenderPassCamera = renderPassCamera;
            this.originalFrameUpdate = renderPassCamera.frameUpdate?.bind(renderPassCamera) ?? null;

            const bridge = this;
            renderPassCamera.frameUpdate = function frameUpdate(this: typeof renderPassCamera) {
                bridge.originalFrameUpdate?.call(this);
                if (!bridge.active || !this.composePass?.sceneTexture) {
                    return;
                }
                this.composePass.sceneTexture = bridge.process(this.composePass.sceneTexture);
            };
        }

        this.active = true;
        return true;
    }

    setSettings(settings: PointillismPostSettings): void {
        this.effect.setSettings({ ...settings, enabled: true });
    }

    unmount(): void {
        this.active = false;
        this.unhook();
        this.destroyOutputTarget();
    }

    private unhook(): void {
        const renderPassCamera = this.hookedRenderPassCamera as { frameUpdate?: () => void } | null;
        if (renderPassCamera && this.originalFrameUpdate) {
            renderPassCamera.frameUpdate = this.originalFrameUpdate;
        }
        this.hookedRenderPassCamera = null;
        this.originalFrameUpdate = null;
    }

    private process(sourceTexture: Texture): Texture {
        const outputTarget = this.ensureOutputTarget(sourceTexture);
        this.effect.render({ colorBuffer: sourceTexture }, outputTarget, null);
        return outputTarget.colorBuffer;
    }

    private ensureOutputTarget(sourceTexture: Texture): RenderTarget {
        const device = this.effect.device;
        const { width, height, format } = sourceTexture;
        const current = this.outputTarget;

        if (
            current &&
            current.width === width &&
            current.height === height &&
            current.colorBuffer?.format === format
        ) {
            return current;
        }

        this.destroyOutputTarget();

        const colorBuffer = new Texture(device, {
            name: 'pointillism-stipple-scene',
            width,
            height,
            format,
            mipmaps: false,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });

        this.outputTarget = new RenderTarget({
            colorBuffer,
            depth: false
        });
        return this.outputTarget;
    }

    private destroyOutputTarget(): void {
        if (!this.outputTarget) return;
        this.outputTarget.destroyTextureBuffers();
        this.outputTarget.destroy();
        this.outputTarget = null;
    }
}

export type PointillismPostApplyOptions = {
    getCameraFrame?: () => CameraFrame | null | undefined;
};

export class PointillismPostController {
    private readonly app: AppBase;
    private readonly camera: CameraComponent;
    private readonly effect: PointillismPostEffect;
    private readonly cameraFrameBridge: PointillismCameraFrameBridge;
    private settings: PointillismPostSettings = DEFAULT_POINTILLISM_POST_SETTINGS;
    private legacyMounted = false;

    constructor(app: AppBase, camera: CameraComponent) {
        this.app = app;
        this.camera = camera;
        this.effect = new PointillismPostEffect(app.graphicsDevice, app.graphicsDevice.precision);
        this.cameraFrameBridge = new PointillismCameraFrameBridge(this.effect);
    }

    apply(rawSettings: unknown, options?: PointillismPostApplyOptions): void {
        this.settings = normalizePointillismPostSettings(rawSettings);
        this.effect.setSettings(this.settings);
        this.cameraFrameBridge.setSettings(this.settings);

        if (!this.settings.enabled || !this.settings.postEffectEnabled) {
            this.unmountAll();
            return;
        }

        const cameraFrame = options?.getCameraFrame?.();
        if (cameraFrame?.enabled && this.cameraFrameBridge.mount(cameraFrame)) {
            this.unmountLegacy();
        } else {
            this.cameraFrameBridge.unmount();
            this.mountLegacy();
        }

        this.app.renderNextFrame = true;
    }

    private mountLegacy(): void {
        if (!this.camera.postEffects) {
            console.warn('[pointillism-stipple] camera postEffects unavailable');
            return;
        }
        if (!this.legacyMounted) {
            this.camera.postEffects.addEffect(this.effect);
            this.legacyMounted = true;
        }
    }

    private unmountLegacy(): void {
        if (!this.camera.postEffects || !this.legacyMounted) return;
        this.camera.postEffects.removeEffect(this.effect);
        this.legacyMounted = false;
    }

    private unmountAll(): void {
        this.cameraFrameBridge.unmount();
        this.unmountLegacy();
        this.app.renderNextFrame = true;
    }

    destroy(): void {
        this.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
    }
}
