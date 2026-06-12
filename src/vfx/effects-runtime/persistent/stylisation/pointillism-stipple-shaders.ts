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
    minVisibleAlpha: 'uPointillismMinVisibleAlpha',
    viewPos: 'uPointillismViewPos',
    dotRadiusSlope: 'uPointillismDotRadiusSlope',
    maxDotRadiusSlope: 'uPointillismMaxDotRadiusSlope'
} as const;

/** stippleSize ↑ → 目标点半径 ↓（约 2–5 px） */
export const stippleSizeToTargetDotRadiusPx = (stippleSize: number): number => {
    const t = Math.max(0, Math.min(1, (stippleSize - 32) / (160 - 32)));
    return 5.0 - t * 3.0;
};

export const POINTILLISM_DEFAULTS = {
    brushSize: 1.0,
    brushDensity: 3.6,
    brushAspect: 0.62,
    brushHardness: 0.88,
    colorVibration: 0.0,
    darkPaintBoost: 0.0,
    highlightSkip: 0.0,
    dotScale: 1.0,
    dotSizeFactor: 0.18,
    strokeAspect: 1.0,
    roundness: 1.0,
    density: 3.6,
    strokeSoftness: 0.08,
    strokeLength: 0.62,
    strokeWidth: 0.46,
    shapeJitter: 0.0,
    paintThickness: 1.0,
    saturation: 1.32,
    lumaLevels: 8,
    contrastDotMix: 0.0,
    complementaryMix: 0.0,
    warmCoolSplit: 0.0,
    paletteStrength: 0.0,
    paletteIndex: 0,
    sourceStructureBlend: 0.78,
    highlightSparsity: 0.0,
    darkDensityBoost: 0.0,
    seed: 17,
    minVisibleAlpha: 0.06,
    postEffectEnabled: true,
    stippleSize: 96,
    levels: 8,
    levelRange: 1.06,
    ditherSpread: 0.0,
    paperStrength: 0.08,
    paperTint: [1.0, 0.97, 0.91] as [number, number, number],
    edgeThreshold: 0.10,
    edgeStrength: 0.28
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
uniform vec3 uPointillismViewPos;
uniform float uPointillismDotRadiusSlope;
uniform float uPointillismMaxDotRadiusSlope;

float pointLuma(vec3 c) {
    return dot(c, vec3(0.299, 0.587, 0.114));
}

float pointHash13(vec3 p) {
    p = fract(p * 0.1031 + vec3(uPointillismSeed * 0.017, uPointillismSeed * 0.031, uPointillismSeed * 0.047));
    p += dot(p, p.yzx + 33.33);
    return fract((p.x + p.y) * p.z);
}

float pointOrderedGate(vec3 center, float chance) {
    vec3 cell = floor(center * 20.0);
    float h = pointHash13(cell + vec3(uPointillismSeed * 0.11));
    return step(h, chance);
}

vec3 pointSaturate(vec3 c, float amount) {
    float l = pointLuma(c);
    return mix(vec3(l), c, amount);
}

vec3 pointLocalChromaLift(vec3 c) {
    float l = pointLuma(c);
    float floorL = 0.08;
    if (l >= floorL * 1.8) {
        return c;
    }
    // 保留 splat 自身色相差，只抬最低明度（非统一阴影颜料）
    vec3 chroma = c - vec3(l);
    float targetL = mix(floorL, l, smoothstep(0.0, floorL * 1.8, l));
    float chromaScale = targetL / max(l, 0.015);
    return max(vec3(targetL) + chroma * min(chromaScale, 2.5), vec3(0.0));
}

vec3 pointClampPigment(vec3 c) {
    c = pointLocalChromaLift(c);
    float l = pointLuma(c);
    vec3 softFloor = vec3(max(0.04, l * 0.72));
    return clamp(c, softFloor, vec3(0.97, 0.97, 0.94));
}

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float originalSize = gsplatGetSizeFromScale(scale);
    float density = clamp(uPointillismBrushDensity, 0.15, 4.4);

    float viewDist = max(length(originalCenter - uPointillismViewPos), 0.001);
    float brushMul = clamp(uPointillismBrushSize, 0.5, 1.5);
    float minWorld = viewDist * uPointillismDotRadiusSlope * brushMul;
    float maxWorld = viewDist * uPointillismMaxDotRadiusSlope * brushMul;
    float dotSize = clamp(minWorld, minWorld, maxWorld);

    vec3 sizeCell = floor(originalCenter * mix(18.0, 26.0, (density - 0.15) / 4.25));
    float sizePick = mix(0.97, 1.03, pointHash13(sizeCell + vec3(uPointillismSeed * 0.05)));
    dotSize *= sizePick * max(0.001, uPointillismDotScale);

    float hardCap = viewDist * uPointillismMaxDotRadiusSlope * 1.05;
    dotSize = min(dotSize, hardCap);
    if (originalSize > hardCap * 1.4) {
        dotSize = min(dotSize, hardCap * 0.82);
    }

    gsplatMakeSpherical(scale, min(dotSize, originalSize * 0.22));
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 src = clamp(color.rgb, 0.0, 1.0);
    if (pointLuma(src) < 0.018) {
        color.a = 0.0;
        return;
    }
    float structure = clamp(uPointillismSourceStructureBlend, 0.0, 1.0);
    vec3 chroma = pointSaturate(src, max(0.0, uPointillismSaturation));
    vec3 styled = clamp(mix(chroma, src, structure * 0.55), 0.0, 1.0);
    color.rgb = pointClampPigment(styled);
    color.a = 1.0;
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
uniform uPointillismViewPos: vec3f;
uniform uPointillismDotRadiusSlope: f32;
uniform uPointillismMaxDotRadiusSlope: f32;

fn pointLuma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.299, 0.587, 0.114));
}

fn pointHash13(pIn: vec3f) -> f32 {
    var p = fract(pIn * 0.1031 + vec3f(uniform.uPointillismSeed * 0.017, uniform.uPointillismSeed * 0.031, uniform.uPointillismSeed * 0.047));
    p += dot(p, p.yzx + vec3f(33.33));
    return fract((p.x + p.y) * p.z);
}

fn pointOrderedGate(center: vec3f, chance: f32) -> f32 {
    let cell = floor(center * 20.0);
    let h = pointHash13(cell + vec3f(uniform.uPointillismSeed * 0.11));
    return step(h, chance);
}

fn pointSaturate(c: vec3f, amount: f32) -> vec3f {
    let l = pointLuma(c);
    return mix(vec3f(l), c, amount);
}

fn pointLocalChromaLift(c: vec3f) -> vec3f {
    let l = pointLuma(c);
    let floorL = 0.08;
    if (l >= floorL * 1.8) {
        return c;
    }
    let chroma = c - vec3f(l);
    let targetL = mix(floorL, l, smoothstep(0.0, floorL * 1.8, l));
    let chromaScale = targetL / max(l, 0.015);
    return max(vec3f(targetL) + chroma * min(chromaScale, 2.5), vec3f(0.0));
}

fn pointClampPigment(c: vec3f) -> vec3f {
    let lifted = pointLocalChromaLift(c);
    let l = pointLuma(lifted);
    let softFloor = vec3f(max(0.04, l * 0.72));
    return clamp(lifted, softFloor, vec3f(0.97, 0.97, 0.94));
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let originalSize = gsplatGetSizeFromScale(*scale);
    let density = clamp(uniform.uPointillismBrushDensity, 0.15, 4.4);

    let viewDist = max(length(originalCenter - uniform.uPointillismViewPos), 0.001);
    let brushMul = clamp(uniform.uPointillismBrushSize, 0.5, 1.5);
    let minWorld = viewDist * uniform.uPointillismDotRadiusSlope * brushMul;
    let maxWorld = viewDist * uniform.uPointillismMaxDotRadiusSlope * brushMul;
    var dotSize = clamp(minWorld, minWorld, maxWorld);

    let sizeCell = floor(originalCenter * mix(18.0, 26.0, (density - 0.15) / 4.25));
    let sizePick = mix(0.97, 1.03, pointHash13(sizeCell + vec3f(uniform.uPointillismSeed * 0.05)));
    dotSize *= sizePick * max(0.001, uniform.uPointillismDotScale);

    let hardCap = viewDist * uniform.uPointillismMaxDotRadiusSlope * 1.05;
    dotSize = min(dotSize, hardCap);
    if (originalSize > hardCap * 1.4) {
        dotSize = min(dotSize, hardCap * 0.82);
    }

    gsplatMakeSpherical(scale, min(dotSize, originalSize * 0.22));
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let src = clamp((*color).rgb, vec3f(0.0), vec3f(1.0));
    if (pointLuma(src) < 0.018) {
        (*color).a = 0.0;
        return;
    }
    let structure = clamp(uniform.uPointillismSourceStructureBlend, 0.0, 1.0);
    let chroma = pointSaturate(src, max(0.0, uniform.uPointillismSaturation));
    let styled = clamp(mix(chroma, src, structure * 0.55), vec3f(0.0), vec3f(1.0));
    (*color).rgb = pointClampPigment(styled);
    (*color).a = 1.0;
}
`;
