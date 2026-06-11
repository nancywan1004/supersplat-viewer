export const POINTILLISM_UNIFORM_NAMES = {
    brushSize: 'uPointillismBrushSize',
    brushDensity: 'uPointillismBrushDensity',
    brushAspect: 'uPointillismBrushAspect',
    brushHardness: 'uPointillismBrushHardness',
    colorVibration: 'uPointillismColorVibration',
    darkPaintBoost: 'uPointillismDarkPaintBoost',
    highlightSkip: 'uPointillismHighlightSkip',
    dotScale: 'uPointillismDotScale',
    dotSizeFactor: 'uPointillismDotSizeFactor',
    strokeAspect: 'uPointillismStrokeAspect',
    roundness: 'uPointillismRoundness',
    density: 'uPointillismDensity',
    strokeSoftness: 'uPointillismStrokeSoftness',
    strokeLength: 'uPointillismStrokeLength',
    strokeWidth: 'uPointillismStrokeWidth',
    shapeJitter: 'uPointillismShapeJitter',
    paintThickness: 'uPointillismPaintThickness',
    saturation: 'uPointillismSaturation',
    lumaLevels: 'uPointillismLumaLevels',
    contrastDotMix: 'uPointillismContrastDotMix',
    complementaryMix: 'uPointillismComplementaryMix',
    warmCoolSplit: 'uPointillismWarmCoolSplit',
    paletteStrength: 'uPointillismPaletteStrength',
    paletteIndex: 'uPointillismPaletteIndex',
    sourceStructureBlend: 'uPointillismSourceStructureBlend',
    highlightSparsity: 'uPointillismHighlightSparsity',
    darkDensityBoost: 'uPointillismDarkDensityBoost',
    seed: 'uPointillismSeed',
    minVisibleAlpha: 'uPointillismMinVisibleAlpha'
} as const;

export const POINTILLISM_DEFAULTS = {
    brushSize: 0.46,
    brushDensity: 1.18,
    brushAspect: 1.58,
    brushHardness: 0.86,
    colorVibration: 0.62,
    darkPaintBoost: 0.42,
    highlightSkip: 0.24,
    dotScale: 1.0,
    dotSizeFactor: 0.46,
    strokeAspect: 1.58,
    roundness: 0.5,
    density: 1.18,
    strokeSoftness: 0.18,
    strokeLength: 1.04,
    strokeWidth: 0.68,
    shapeJitter: 0.12,
    paintThickness: 1.22,
    saturation: 1.55,
    lumaLevels: 12,
    contrastDotMix: 0.42,
    complementaryMix: 0.24,
    warmCoolSplit: 0.5,
    paletteStrength: 0.28,
    paletteIndex: 2,
    sourceStructureBlend: 0.24,
    highlightSparsity: 0.24,
    darkDensityBoost: 0.42,
    seed: 17,
    minVisibleAlpha: 1 / 255,
    postEffectEnabled: true,
    stippleSize: 96,
    levels: 11,
    levelRange: 0.92,
    ditherSpread: 0.045,
    paperStrength: 0.22,
    paperTint: [0.98, 0.96, 0.88] as [number, number, number],
    edgeThreshold: 0.18,
    edgeStrength: 0.14
} as const;

export const pointillismModifyGlsl = /* glsl */`
uniform float uPointillismBrushSize;
uniform float uPointillismBrushDensity;
uniform float uPointillismBrushAspect;
uniform float uPointillismBrushHardness;
uniform float uPointillismColorVibration;
uniform float uPointillismDarkPaintBoost;
uniform float uPointillismHighlightSkip;
uniform float uPointillismDotScale;
uniform float uPointillismDotSizeFactor;
uniform float uPointillismStrokeAspect;
uniform float uPointillismRoundness;
uniform float uPointillismDensity;
uniform float uPointillismSaturation;
uniform float uPointillismLumaLevels;
uniform float uPointillismContrastDotMix;
uniform float uPointillismComplementaryMix;
uniform float uPointillismWarmCoolSplit;
uniform float uPointillismPaletteStrength;
uniform float uPointillismPaletteIndex;
uniform float uPointillismSourceStructureBlend;
uniform float uPointillismHighlightSparsity;
uniform float uPointillismDarkDensityBoost;
uniform float uPointillismPaintThickness;
uniform float uPointillismSeed;

float pointHash13(vec3 p) {
    p = fract(p * 0.1031 + vec3(uPointillismSeed * 0.017, uPointillismSeed * 0.031, uPointillismSeed * 0.047));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

vec3 pointHash33(vec3 p) {
    return vec3(
        pointHash13(p + vec3(0.0, 17.0, 31.0)),
        pointHash13(p + vec3(13.0, 7.0, 19.0)),
        pointHash13(p + vec3(23.0, 29.0, 11.0))
    );
}

float pointLuma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

vec3 pointSaturate(vec3 c, float amount) {
    float l = pointLuma(c);
    return mix(vec3(l), c, amount);
}

vec3 pointHueNudge(vec3 c, float warmCool, float pick) {
    vec3 warm = c * vec3(1.18, 1.06, 0.86) + vec3(0.04, 0.015, 0.0);
    vec3 cool = c * vec3(0.84, 0.94, 1.18) + vec3(0.0, 0.01, 0.04);
    float t = smoothstep(0.28, 0.72, pick);
    return mix(c, mix(cool, warm, t), warmCool);
}

vec3 pointComplement(vec3 c) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float l = pointLuma(c);
    return clamp(vec3(mx + mn) - c + vec3(l * 0.12), 0.0, 1.0);
}

vec3 pointPalette(float luma, float idx) {
    float row = floor(idx + 0.5);
    vec3 darkCol;
    vec3 midCol;
    vec3 lightCol;

    if (row < 0.5) {
        darkCol = vec3(0.18, 0.08, 0.06);
        midCol = vec3(0.82, 0.28, 0.14);
        lightCol = vec3(1.00, 0.78, 0.32);
    } else if (row < 1.5) {
        darkCol = vec3(0.09, 0.07, 0.22);
        midCol = vec3(0.70, 0.24, 0.78);
        lightCol = vec3(1.00, 0.66, 0.32);
    } else if (row < 2.5) {
        darkCol = vec3(0.03, 0.16, 0.10);
        midCol = vec3(0.10, 0.60, 0.24);
        lightCol = vec3(0.98, 0.86, 0.22);
    } else {
        darkCol = vec3(0.16, 0.14, 0.12);
        midCol = vec3(0.56, 0.50, 0.42);
        lightCol = vec3(0.96, 0.89, 0.70);
    }

    return luma < 0.5
        ? mix(darkCol, midCol, smoothstep(0.0, 0.5, luma))
        : mix(midCol, lightCol, smoothstep(0.5, 1.0, luma));
}

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    vec3 rnd = pointHash33(originalCenter * 1.37);
    float originalSize = gsplatGetSizeFromScale(scale);
    float lumaProxy = clamp(rnd.z * 0.35 + rnd.x * 0.65, 0.0, 1.0);
    float darkMass = smoothstep(0.78, 0.18, lumaProxy) * clamp(uPointillismDarkPaintBoost, 0.0, 1.0);
    float lightSkip = smoothstep(0.48, 0.92, lumaProxy) * clamp(uPointillismHighlightSkip, 0.0, 1.0);
    float density = clamp(uPointillismBrushDensity, 0.15, 2.4);
    float sizeJitter = mix(0.78, 1.18, rnd.y);
    float lightShrink = mix(1.0, 0.64, lightSkip);
    float dotSize = originalSize
        * max(0.001, uPointillismDotScale)
        * clamp(uPointillismBrushSize, 0.04, 0.72)
        * mix(0.82, 1.16, density * 0.42)
        * mix(1.0, 1.24, darkMass)
        * lightShrink
        * sizeJitter;
    gsplatMakeSpherical(scale, min(dotSize, originalSize * 0.58));
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 rnd = pointHash33(center * 1.91);
    vec3 src = clamp(color.rgb, 0.0, 1.0);
    float l = max(pointLuma(src), 0.001);
    float levels = max(2.0, floor(uPointillismLumaLevels + 0.5));
    float liftedL = clamp(l * 0.86 + 0.10, 0.0, 1.0);
    float qL = floor(liftedL * (levels - 1.0) + rnd.x * 0.18) / max(1.0, levels - 1.0);
    qL = max(qL, mix(0.12, 0.02, clamp(uPointillismDarkDensityBoost, 0.0, 1.0)));

    // 源色驱动：量化亮度、保留色相
    float colorVibration = clamp(uPointillismColorVibration, 0.0, 1.0);
    vec3 chroma = pointSaturate(src, max(0.0, uPointillismSaturation) + colorVibration * 0.35);
    vec3 quantized = chroma * (qL / l);

    float warmPick = smoothstep(0.38, 0.68, l);
    quantized = pointHueNudge(quantized, clamp(uPointillismWarmCoolSplit, 0.0, 1.0) * (0.55 + colorVibration * 0.55), warmPick);

    vec3 pal = pointPalette(qL, uPointillismPaletteIndex);
    vec3 styled = mix(quantized, mix(pal, quantized, 0.45), clamp(uPointillismPaletteStrength + colorVibration * 0.22, 0.0, 1.0));

    float contrastGate = step(rnd.z, clamp(uPointillismContrastDotMix + colorVibration * 0.28, 0.0, 1.0));
    styled = mix(styled, pointComplement(styled), contrastGate * clamp(uPointillismComplementaryMix + colorVibration * 0.22, 0.0, 1.0));

    float structure = clamp(uPointillismSourceStructureBlend, 0.0, 1.0);
    styled = mix(styled, vec3(1.0), 0.035 + qL * 0.055);
    color.rgb = clamp(mix(styled, chroma, structure), 0.0, 1.0);
    float darkMass = smoothstep(0.72, 0.12, l) * clamp(uPointillismDarkPaintBoost, 0.0, 1.0);
    float lightSkip = smoothstep(0.52, 0.92, l) * clamp(uPointillismHighlightSkip, 0.0, 1.0);
    color.a = clamp(color.a * (1.0 + darkMass * 0.85) * mix(1.0, 0.42, step(rnd.y, lightSkip)), 0.0, 1.0);
}
`;

export const pointillismModifyWgsl = /* wgsl */`
uniform uPointillismBrushSize: f32;
uniform uPointillismBrushDensity: f32;
uniform uPointillismBrushAspect: f32;
uniform uPointillismBrushHardness: f32;
uniform uPointillismColorVibration: f32;
uniform uPointillismDarkPaintBoost: f32;
uniform uPointillismHighlightSkip: f32;
uniform uPointillismDotScale: f32;
uniform uPointillismDotSizeFactor: f32;
uniform uPointillismStrokeAspect: f32;
uniform uPointillismRoundness: f32;
uniform uPointillismDensity: f32;
uniform uPointillismSaturation: f32;
uniform uPointillismLumaLevels: f32;
uniform uPointillismContrastDotMix: f32;
uniform uPointillismComplementaryMix: f32;
uniform uPointillismWarmCoolSplit: f32;
uniform uPointillismPaletteStrength: f32;
uniform uPointillismPaletteIndex: f32;
uniform uPointillismSourceStructureBlend: f32;
uniform uPointillismHighlightSparsity: f32;
uniform uPointillismDarkDensityBoost: f32;
uniform uPointillismPaintThickness: f32;
uniform uPointillismSeed: f32;

fn pointHash13(pIn: vec3f) -> f32 {
    var p = fract(pIn * 0.1031 + vec3f(uniform.uPointillismSeed * 0.017, uniform.uPointillismSeed * 0.031, uniform.uPointillismSeed * 0.047));
    p += dot(p, p.yzx + vec3f(33.33));
    return fract((p.x + p.y) * p.z);
}

fn pointHash33(p: vec3f) -> vec3f {
    return vec3f(
        pointHash13(p + vec3f(0.0, 17.0, 31.0)),
        pointHash13(p + vec3f(13.0, 7.0, 19.0)),
        pointHash13(p + vec3f(23.0, 29.0, 11.0))
    );
}

fn pointLuma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.299, 0.587, 0.114));
}

fn pointSaturate(c: vec3f, amount: f32) -> vec3f {
    let l = pointLuma(c);
    return mix(vec3f(l), c, amount);
}

fn pointHueNudge(c: vec3f, warmCool: f32, pick: f32) -> vec3f {
    let warm = c * vec3f(1.18, 1.06, 0.86) + vec3f(0.04, 0.015, 0.0);
    let cool = c * vec3f(0.84, 0.94, 1.18) + vec3f(0.0, 0.01, 0.04);
    let t = smoothstep(0.28, 0.72, pick);
    return mix(c, mix(cool, warm, t), warmCool);
}

fn pointComplement(c: vec3f) -> vec3f {
    let mx = max(max(c.r, c.g), c.b);
    let mn = min(min(c.r, c.g), c.b);
    let l = pointLuma(c);
    return clamp(vec3f(mx + mn) - c + vec3f(l * 0.12), vec3f(0.0), vec3f(1.0));
}

fn pointPalette(luma: f32, idx: f32) -> vec3f {
    let row = floor(idx + 0.5);
    var darkCol: vec3f;
    var midCol: vec3f;
    var lightCol: vec3f;

    if (row < 0.5) {
        darkCol = vec3f(0.18, 0.08, 0.06);
        midCol = vec3f(0.82, 0.28, 0.14);
        lightCol = vec3f(1.00, 0.78, 0.32);
    } else if (row < 1.5) {
        darkCol = vec3f(0.09, 0.07, 0.22);
        midCol = vec3f(0.70, 0.24, 0.78);
        lightCol = vec3f(1.00, 0.66, 0.32);
    } else if (row < 2.5) {
        darkCol = vec3f(0.03, 0.16, 0.10);
        midCol = vec3f(0.10, 0.60, 0.24);
        lightCol = vec3f(0.98, 0.86, 0.22);
    } else {
        darkCol = vec3f(0.16, 0.14, 0.12);
        midCol = vec3f(0.56, 0.50, 0.42);
        lightCol = vec3f(0.96, 0.89, 0.70);
    }

    if (luma < 0.5) {
        return mix(darkCol, midCol, smoothstep(0.0, 0.5, luma));
    }
    return mix(midCol, lightCol, smoothstep(0.5, 1.0, luma));
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let rnd = pointHash33(originalCenter * 1.37);
    let originalSize = gsplatGetSizeFromScale(*scale);
    let lumaProxy = clamp(rnd.z * 0.35 + rnd.x * 0.65, 0.0, 1.0);
    let darkMass = smoothstep(0.78, 0.18, lumaProxy) * clamp(uniform.uPointillismDarkPaintBoost, 0.0, 1.0);
    let lightSkip = smoothstep(0.48, 0.92, lumaProxy) * clamp(uniform.uPointillismHighlightSkip, 0.0, 1.0);
    let density = clamp(uniform.uPointillismBrushDensity, 0.15, 2.4);
    let sizeJitter = mix(0.78, 1.18, rnd.y);
    let lightShrink = mix(1.0, 0.64, lightSkip);
    let dotSize = originalSize
        * max(0.001, uniform.uPointillismDotScale)
        * clamp(uniform.uPointillismBrushSize, 0.04, 0.72)
        * mix(0.82, 1.16, density * 0.42)
        * mix(1.0, 1.24, darkMass)
        * lightShrink
        * sizeJitter;
    gsplatMakeSpherical(scale, min(dotSize, originalSize * 0.58));
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let rnd = pointHash33(center * 1.91);
    let src = clamp((*color).rgb, vec3f(0.0), vec3f(1.0));
    let l = max(pointLuma(src), 0.001);
    let levels = max(2.0, floor(uniform.uPointillismLumaLevels + 0.5));
    let liftedL = clamp(l * 0.86 + 0.10, 0.0, 1.0);
    var qL = floor(liftedL * (levels - 1.0) + rnd.x * 0.18) / max(1.0, levels - 1.0);
    qL = max(qL, mix(0.12, 0.02, clamp(uniform.uPointillismDarkDensityBoost, 0.0, 1.0)));

    let colorVibration = clamp(uniform.uPointillismColorVibration, 0.0, 1.0);
    var chroma = pointSaturate(src, max(0.0, uniform.uPointillismSaturation) + colorVibration * 0.35);
    var quantized = chroma * (qL / l);

    let warmPick = smoothstep(0.38, 0.68, l);
    quantized = pointHueNudge(quantized, clamp(uniform.uPointillismWarmCoolSplit, 0.0, 1.0) * (0.55 + colorVibration * 0.55), warmPick);

    let pal = pointPalette(qL, uniform.uPointillismPaletteIndex);
    var styled = mix(quantized, mix(pal, quantized, 0.45), clamp(uniform.uPointillismPaletteStrength + colorVibration * 0.22, 0.0, 1.0));

    let contrastGate = step(rnd.z, clamp(uniform.uPointillismContrastDotMix + colorVibration * 0.28, 0.0, 1.0));
    styled = mix(styled, pointComplement(styled), contrastGate * clamp(uniform.uPointillismComplementaryMix + colorVibration * 0.22, 0.0, 1.0));

    let structure = clamp(uniform.uPointillismSourceStructureBlend, 0.0, 1.0);
    styled = mix(styled, vec3f(1.0), 0.035 + qL * 0.055);
    (*color).rgb = clamp(mix(styled, chroma, structure), vec3f(0.0), vec3f(1.0));
    let darkMass = smoothstep(0.72, 0.12, l) * clamp(uniform.uPointillismDarkPaintBoost, 0.0, 1.0);
    let lightSkip = smoothstep(0.52, 0.92, l) * clamp(uniform.uPointillismHighlightSkip, 0.0, 1.0);
    (*color).a = clamp((*color).a * (1.0 + darkMass * 0.85) * mix(1.0, 0.42, step(rnd.y, lightSkip)), 0.0, 1.0);
}
`;
