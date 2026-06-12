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
    brushSize: 0.16,
    brushDensity: 3.4,
    brushAspect: 1.0,
    brushHardness: 0.92,
    colorVibration: 0.0,
    darkPaintBoost: 0.0,
    highlightSkip: 0.0,
    dotScale: 1.0,
    dotSizeFactor: 0.18,
    strokeAspect: 1.0,
    roundness: 1.0,
    density: 3.4,
    strokeSoftness: 0.08,
    strokeLength: 0.74,
    strokeWidth: 0.56,
    shapeJitter: 0.06,
    paintThickness: 1.0,
    saturation: 1.42,
    lumaLevels: 6,
    contrastDotMix: 0.14,
    complementaryMix: 0.20,
    warmCoolSplit: 0.0,
    paletteStrength: 0.0,
    paletteIndex: 0,
    sourceStructureBlend: 0.45,
    highlightSparsity: 0.0,
    darkDensityBoost: 0.0,
    seed: 17,
    minVisibleAlpha: 1 / 255,
    postEffectEnabled: true,
    stippleSize: 72,
    levels: 8,
    levelRange: 1.18,
    ditherSpread: 0.0,
    paperStrength: 0.12,
    paperTint: [1.0, 0.97, 0.91] as [number, number, number],
    edgeThreshold: 0.14,
    edgeStrength: 0.22
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
uniform float uPointillismShapeJitter;

float pointLuma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

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

vec3 pointSaturate(vec3 c, float amount) {
    float l = pointLuma(c);
    return mix(vec3(l), c, amount);
}

vec3 pointComplement(vec3 c) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float l = pointLuma(c);
    return clamp(vec3(mx + mn) - c + vec3(l * 0.12), 0.0, 1.0);
}

vec3 pointHueVibrate(vec3 c, float pick, float amount) {
    vec3 warm = c * vec3(1.14, 1.05, 0.88) + vec3(0.015, 0.008, 0.0);
    vec3 cool = c * vec3(0.88, 0.95, 1.14) + vec3(0.0, 0.006, 0.015);
    vec3 shifted = mix(cool, warm, smoothstep(0.2, 0.8, pick));
    return mix(c, shifted, amount);
}

vec3 pointSoftQuantize(vec3 c, float levels, float rnd) {
    float l = max(pointLuma(c), 0.001);
    float steps = max(2.0, floor(levels + 0.5));
    float qL = floor(clamp(l, 0.0, 1.0) * (steps - 1.0) + rnd * 0.22) / max(1.0, steps - 1.0);
    return c * (qL / l);
}

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    vec3 rnd = pointHash33(originalCenter * 1.37);
    float originalSize = gsplatGetSizeFromScale(scale);
    float brushSize = clamp(uPointillismBrushSize, 0.02, 0.32);
    float density = clamp(uPointillismBrushDensity, 0.15, 4.4);
    float autoDensity = clamp(density * mix(1.2, 0.88, smoothstep(0.08, 0.48, brushSize)), 0.15, 4.8);
    float grainScale = max(0.001, uPointillismDotScale);
    float sizeJitter = mix(0.68, 1.28, rnd.y);
    float shapeJitter = clamp(uPointillismShapeJitter, 0.0, 0.22);
    sizeJitter = mix(1.0, sizeJitter, 0.55 + shapeJitter * 1.8);
    float dotSize = originalSize
        * grainScale
        * brushSize
        * sizeJitter
        * mix(1.0, 1.06, smoothstep(0.8, 4.8, autoDensity));
    gsplatMakeSpherical(scale, min(dotSize, originalSize * 0.36));
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 rnd = pointHash33(center * 1.91);
    vec3 src = clamp(color.rgb, 0.0, 1.0);
    float vibr = clamp(uPointillismColorVibration, 0.0, 1.0);
    vec3 chroma = pointSaturate(src, max(0.0, uPointillismSaturation) + vibr * 0.22);
    float structure = clamp(uPointillismSourceStructureBlend, 0.0, 1.0);
    vec3 styled = clamp(mix(chroma, src, structure * 0.32), 0.0, 1.0);

    float quantMix = mix(0.12, 0.38, vibr) * (1.0 - structure * 0.45);
    styled = mix(styled, pointSoftQuantize(styled, uPointillismLumaLevels, rnd.x), quantMix);

    float dotChance = clamp(uPointillismContrastDotMix + vibr * 0.22, 0.0, 1.0);
    float compMix = clamp(uPointillismComplementaryMix + vibr * 0.16, 0.0, 1.0);
    float contrastGate = step(rnd.z, dotChance);
    styled = mix(styled, pointComplement(styled), contrastGate * compMix);

    float hueGate = step(rnd.y, 0.42 + vibr * 0.28);
    styled = pointHueVibrate(styled, rnd.x, hueGate * (0.08 + vibr * 0.22));

    color.rgb = styled;

    float brushSize = clamp(uPointillismBrushSize, 0.02, 0.32);
    float autoDensity = clamp(uPointillismBrushDensity * mix(1.2, 0.88, smoothstep(0.08, 0.48, brushSize)), 0.15, 4.8);
    color.a = clamp(color.a * mix(1.06, 1.28, smoothstep(0.8, 4.8, autoDensity)), 0.0, 1.0);
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
uniform uPointillismShapeJitter: f32;

fn pointLuma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.299, 0.587, 0.114));
}

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

fn pointSaturate(c: vec3f, amount: f32) -> vec3f {
    let l = pointLuma(c);
    return mix(vec3f(l), c, amount);
}

fn pointComplement(c: vec3f) -> vec3f {
    let mx = max(max(c.r, c.g), c.b);
    let mn = min(min(c.r, c.g), c.b);
    let l = pointLuma(c);
    return clamp(vec3f(mx + mn) - c + vec3f(l * 0.12), vec3f(0.0), vec3f(1.0));
}

fn pointHueVibrate(c: vec3f, pick: f32, amount: f32) -> vec3f {
    let warm = c * vec3f(1.14, 1.05, 0.88) + vec3f(0.015, 0.008, 0.0);
    let cool = c * vec3f(0.88, 0.95, 1.14) + vec3f(0.0, 0.006, 0.015);
    let shifted = mix(cool, warm, smoothstep(0.2, 0.8, pick));
    return mix(c, shifted, amount);
}

fn pointSoftQuantize(c: vec3f, levels: f32, rnd: f32) -> vec3f {
    let l = max(pointLuma(c), 0.001);
    let steps = max(2.0, floor(levels + 0.5));
    let qL = floor(clamp(l, 0.0, 1.0) * (steps - 1.0) + rnd * 0.22) / max(1.0, steps - 1.0);
    return c * (qL / l);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let rnd = pointHash33(originalCenter * 1.37);
    let originalSize = gsplatGetSizeFromScale(*scale);
    let brushSize = clamp(uniform.uPointillismBrushSize, 0.02, 0.32);
    let density = clamp(uniform.uPointillismBrushDensity, 0.15, 4.4);
    let autoDensity = clamp(density * mix(1.2, 0.88, smoothstep(0.08, 0.48, brushSize)), 0.15, 4.8);
    let grainScale = max(0.001, uniform.uPointillismDotScale);
    var sizeJitter = mix(0.68, 1.28, rnd.y);
    let shapeJitter = clamp(uniform.uPointillismShapeJitter, 0.0, 0.22);
    sizeJitter = mix(1.0, sizeJitter, 0.55 + shapeJitter * 1.8);
    let dotSize = originalSize
        * grainScale
        * brushSize
        * sizeJitter
        * mix(1.0, 1.06, smoothstep(0.8, 4.8, autoDensity));
    gsplatMakeSpherical(scale, min(dotSize, originalSize * 0.36));
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let rnd = pointHash33(center * 1.91);
    let src = clamp((*color).rgb, vec3f(0.0), vec3f(1.0));
    let vibr = clamp(uniform.uPointillismColorVibration, 0.0, 1.0);
    let chroma = pointSaturate(src, max(0.0, uniform.uPointillismSaturation) + vibr * 0.22);
    let structure = clamp(uniform.uPointillismSourceStructureBlend, 0.0, 1.0);
    var styled = clamp(mix(chroma, src, structure * 0.32), vec3f(0.0), vec3f(1.0));

    let quantMix = mix(0.12, 0.38, vibr) * (1.0 - structure * 0.45);
    styled = mix(styled, pointSoftQuantize(styled, uniform.uPointillismLumaLevels, rnd.x), quantMix);

    let dotChance = clamp(uniform.uPointillismContrastDotMix + vibr * 0.22, 0.0, 1.0);
    let compMix = clamp(uniform.uPointillismComplementaryMix + vibr * 0.16, 0.0, 1.0);
    let contrastGate = step(rnd.z, dotChance);
    styled = mix(styled, pointComplement(styled), contrastGate * compMix);

    let hueGate = step(rnd.y, 0.42 + vibr * 0.28);
    styled = pointHueVibrate(styled, rnd.x, hueGate * (0.08 + vibr * 0.22));

    (*color).rgb = styled;

    let brushSize = clamp(uniform.uPointillismBrushSize, 0.02, 0.32);
    let autoDensity = clamp(uniform.uPointillismBrushDensity * mix(1.2, 0.88, smoothstep(0.08, 0.48, brushSize)), 0.15, 4.8);
    (*color).a = clamp((*color).a * mix(1.06, 1.28, smoothstep(0.8, 4.8, autoDensity)), 0.0, 1.0);
}
`;
