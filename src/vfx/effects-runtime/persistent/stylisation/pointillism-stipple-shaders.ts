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
    paintOpacity: 'uPointillismPaintOpacity',
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

export const POINTILLISM_STIPPLE_SIZE_MIN = 32;
export const POINTILLISM_STIPPLE_SIZE_MAX = 224;
export const POINTILLISM_BRUSH_SIZE_MIN = 0.25;
export const POINTILLISM_BRUSH_SIZE_MAX = 1.5;
export const POINTILLISM_DOT_RADIUS_PX_MIN = 0.25;
export const POINTILLISM_DOT_RADIUS_PX_MAX = 7.5;
export const POINTILLISM_STROKE_LENGTH_MIN = 0.15;
export const POINTILLISM_STROKE_LENGTH_MAX = 2.5;
export const POINTILLISM_STROKE_WIDTH_MIN = 0.15;
export const POINTILLISM_STROKE_WIDTH_MAX = 1.85;
export const POINTILLISM_PAINT_OPACITY_MIN = 0.08;
export const POINTILLISM_PAINT_OPACITY_MAX = 1.0;

/** 旧 stippleSize ↑ → 目标点半径 ↓（约 1–5 px）；仅用于读取 legacy 配置 */
export const stippleSizeToTargetDotRadiusPx = (stippleSize: number): number => {
    const t = Math.max(0, Math.min(1, (stippleSize - POINTILLISM_STIPPLE_SIZE_MIN) / (POINTILLISM_STIPPLE_SIZE_MAX - POINTILLISM_STIPPLE_SIZE_MIN)));
    return 5.0 - t * 4.0;
};

/** 合并 legacy stippleSize × brushSize，或直接读取 dotRadiusPx */
export const resolvePointillismDotRadiusPx = (
    dotRadiusPx: number,
    stippleSize: number,
    brushSize: number
): number => {
    if (Number.isFinite(dotRadiusPx)) {
        return Math.max(POINTILLISM_DOT_RADIUS_PX_MIN, Math.min(POINTILLISM_DOT_RADIUS_PX_MAX, dotRadiusPx));
    }
    const legacyBrush = Number.isFinite(brushSize) ? brushSize : 1.0;
    const legacyPx = stippleSizeToTargetDotRadiusPx(stippleSize) * legacyBrush;
    return Math.max(POINTILLISM_DOT_RADIUS_PX_MIN, Math.min(POINTILLISM_DOT_RADIUS_PX_MAX, legacyPx));
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
    paintOpacity: 1.0,
    saturation: 1.32,
    lumaLevels: 8,
    contrastDotMix: 0.14,
    complementaryMix: 0.20,
    warmCoolSplit: 0.58,
    paletteStrength: 0.0,
    paletteIndex: 0,
    sourceStructureBlend: 0.92,
    highlightSparsity: 0.0,
    darkDensityBoost: 0.0,
    seed: 17,
    minVisibleAlpha: 0.08,
    dotRadiusPx: 1.0,
    postEffectEnabled: true,
    stippleSize: 96,
    levels: 8,
    levelRange: 1.14,
    ditherSpread: 0.0,
    paperStrength: 0.08,
    paperTint: [1.0, 0.97, 0.91] as [number, number, number],
    edgeThreshold: 0.04,
    edgeStrength: 0.72
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
uniform float uPointillismMinVisibleAlpha;

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

float pointOrderedGate(vec3 center, float chance) {
    vec3 cell = floor(center * 20.0);
    float h = pointHash13(cell + vec3(uPointillismSeed * 0.11));
    return step(h, chance);
}

vec3 pointSaturate(vec3 c, float amount) {
    float l = pointLuma(c);
    return mix(vec3(l), c, amount);
}

vec3 pointHueNudge(vec3 c, float warmCool, float pick) {
    vec3 warm = c * vec3(1.24, 1.08, 0.76) + vec3(0.07, 0.025, 0.0);
    vec3 cool = c * vec3(0.76, 0.86, 1.24) + vec3(0.01, 0.025, 0.07);
    float t = smoothstep(0.22, 0.78, pick);
    return mix(c, mix(cool, warm, t), warmCool);
}

vec3 pointComplement(vec3 c) {
    float mx = max(max(c.r, c.g), c.b);
    float mn = min(min(c.r, c.g), c.b);
    float l = pointLuma(c);
    return clamp(vec3(mx + mn) - c + vec3(l * 0.12), 0.0, 1.0);
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
    float densityT = clamp((density - 0.15) / 4.25, 0.0, 1.0);

    float viewDist = max(length(originalCenter - uPointillismViewPos), 0.001);
    float minWorld = viewDist * uPointillismDotRadiusSlope;
    float maxWorld = viewDist * uPointillismMaxDotRadiusSlope;
    float dotSize = clamp(minWorld, minWorld, maxWorld);

    float cellScale = mix(14.0, 36.0, densityT);
    vec3 sizeCell = floor(originalCenter * cellScale);
    float sizePick = mix(0.94, 1.06, pointHash13(sizeCell + vec3(uPointillismSeed * 0.05)));
    dotSize *= sizePick * max(0.001, uPointillismDotScale);
    dotSize *= mix(0.94, 1.08, densityT);

    float hardCap = viewDist * uPointillismMaxDotRadiusSlope * 1.02;
    dotSize = min(dotSize, hardCap);

    // 与 dotSize 比（屏幕投影比 = originalSize/dotSize，与视距无关）；勿用 hardCap，拉近时 hardCap 变小会误杀
    float sizeRatio = originalSize / max(dotSize, 0.000001);
    if (sizeRatio > 1.12) {
        dotSize = min(dotSize, dotSize * 0.72);
    }
    if (sizeRatio > 3.5) {
        gsplatMakeSpherical(scale, dotSize);
        return;
    }

    // 屏幕像素点径：worldSize = viewDist × slope → 缩放/FOV 下保持约恒定 px
    float targetSize = min(dotSize, hardCap);
    gsplatMakeSpherical(scale, targetSize);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    float srcAlpha = color.a;
    float minAlpha = clamp(uPointillismMinVisibleAlpha, 0.0, 0.25);
    vec3 src = clamp(color.rgb, 0.0, 1.0);
    float l = pointLuma(src);

    if (srcAlpha < minAlpha) {
        color.a = 0.0;
        return;
    }
    if (l < 0.018) {
        color.a = 0.0;
        return;
    }
    // 弱贡献高亮/暗漂浮点（天空与 outlier 常见）
    if (srcAlpha < 0.14 && l > 0.80) {
        color.a = 0.0;
        return;
    }
    if (srcAlpha < 0.11 && l < 0.055) {
        color.a = 0.0;
        return;
    }

    vec3 rnd = pointHash33(center * 1.91);
    float colorVib = clamp(uPointillismColorVibration, 0.0, 1.0);
    l = max(l, 0.001);

    vec3 chroma = pointSaturate(src, max(0.0, uPointillismSaturation) + colorVib * 0.35);
    float warmPick = smoothstep(0.38, 0.68, l);
    chroma = pointHueNudge(
        chroma,
        clamp(uPointillismWarmCoolSplit + colorVib * 0.12, 0.0, 1.0),
        warmPick
    );

    vec3 styled = chroma;
    float contrastChance = clamp(uPointillismContrastDotMix + colorVib * 0.28, 0.0, 1.0);
    float contrastMix = clamp(uPointillismComplementaryMix + colorVib * 0.22, 0.0, 1.0);
    float contrastGate = step(rnd.z, contrastChance);
    styled = mix(styled, pointComplement(styled), contrastGate * contrastMix);

    float structure = clamp(uPointillismSourceStructureBlend, 0.0, 1.0);
    styled = clamp(mix(styled, src, structure * 0.35), 0.0, 1.0);
    color.rgb = pointClampPigment(styled);
    // 可见性已由 srcAlpha 过滤；绘制强度只由 gsplatPS 的 paintOpacity 控制
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
uniform uPointillismMinVisibleAlpha: f32;

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

fn pointOrderedGate(center: vec3f, chance: f32) -> f32 {
    let cell = floor(center * 20.0);
    let h = pointHash13(cell + vec3f(uniform.uPointillismSeed * 0.11));
    return step(h, chance);
}

fn pointSaturate(c: vec3f, amount: f32) -> vec3f {
    let l = pointLuma(c);
    return mix(vec3f(l), c, amount);
}

fn pointHueNudge(c: vec3f, warmCool: f32, pick: f32) -> vec3f {
    let warm = c * vec3f(1.24, 1.08, 0.76) + vec3f(0.07, 0.025, 0.0);
    let cool = c * vec3f(0.76, 0.86, 1.24) + vec3f(0.01, 0.025, 0.07);
    let t = smoothstep(0.22, 0.78, pick);
    return mix(c, mix(cool, warm, t), warmCool);
}

fn pointComplement(c: vec3f) -> vec3f {
    let mx = max(max(c.r, c.g), c.b);
    let mn = min(min(c.r, c.g), c.b);
    let l = pointLuma(c);
    return clamp(vec3f(mx + mn) - c + vec3f(l * 0.12), vec3f(0.0), vec3f(1.0));
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
    let densityT = clamp((density - 0.15) / 4.25, 0.0, 1.0);

    let viewDist = max(length(originalCenter - uniform.uPointillismViewPos), 0.001);
    let minWorld = viewDist * uniform.uPointillismDotRadiusSlope;
    let maxWorld = viewDist * uniform.uPointillismMaxDotRadiusSlope;
    var dotSize = clamp(minWorld, minWorld, maxWorld);

    let cellScale = mix(14.0, 36.0, densityT);
    let sizeCell = floor(originalCenter * cellScale);
    let sizePick = mix(0.94, 1.06, pointHash13(sizeCell + vec3f(uniform.uPointillismSeed * 0.05)));
    dotSize *= sizePick * max(0.001, uniform.uPointillismDotScale);
    dotSize *= mix(0.94, 1.08, densityT);

    let hardCap = viewDist * uniform.uPointillismMaxDotRadiusSlope * 1.02;
    dotSize = min(dotSize, hardCap);

    let sizeRatio = originalSize / max(dotSize, 0.000001);
    if (sizeRatio > 1.12) {
        dotSize = min(dotSize, dotSize * 0.72);
    }
    if (sizeRatio > 3.5) {
        gsplatMakeSpherical(scale, dotSize);
        return;
    }

    let targetSize = min(dotSize, hardCap);
    gsplatMakeSpherical(scale, targetSize);
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let srcAlpha = (*color).a;
    let minAlpha = clamp(uniform.uPointillismMinVisibleAlpha, 0.0, 0.25);
    let src = clamp((*color).rgb, vec3f(0.0), vec3f(1.0));
    var l = pointLuma(src);

    if (srcAlpha < minAlpha) {
        (*color).a = 0.0;
        return;
    }
    if (l < 0.018) {
        (*color).a = 0.0;
        return;
    }
    if (srcAlpha < 0.14 && l > 0.80) {
        (*color).a = 0.0;
        return;
    }
    if (srcAlpha < 0.11 && l < 0.055) {
        (*color).a = 0.0;
        return;
    }

    let rnd = pointHash33(center * 1.91);
    let colorVib = clamp(uniform.uPointillismColorVibration, 0.0, 1.0);
    l = max(l, 0.001);

    var chroma = pointSaturate(src, max(0.0, uniform.uPointillismSaturation) + colorVib * 0.35);
    let warmPick = smoothstep(0.38, 0.68, l);
    chroma = pointHueNudge(
        chroma,
        clamp(uniform.uPointillismWarmCoolSplit + colorVib * 0.12, 0.0, 1.0),
        warmPick
    );

    var styled = chroma;
    let contrastChance = clamp(uniform.uPointillismContrastDotMix + colorVib * 0.28, 0.0, 1.0);
    let contrastMix = clamp(uniform.uPointillismComplementaryMix + colorVib * 0.22, 0.0, 1.0);
    let contrastGate = step(rnd.z, contrastChance);
    styled = mix(styled, pointComplement(styled), contrastGate * contrastMix);

    let structure = clamp(uniform.uPointillismSourceStructureBlend, 0.0, 1.0);
    styled = clamp(mix(styled, src, structure * 0.35), vec3f(0.0), vec3f(1.0));
    (*color).rgb = pointClampPigment(styled);
    (*color).a = 1.0;
}
`;
