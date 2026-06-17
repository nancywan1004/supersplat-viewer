export const POINTILLISM_UNIFORM_NAMES = {
    brushSize: 'uPointillismBrushSize',
    brushAspect: 'uPointillismBrushAspect',
    brushHardness: 'uPointillismBrushHardness',
    colorVibration: 'uPointillismColorVibration',
    darkPaintBoost: 'uPointillismDarkPaintBoost',
    highlightSkip: 'uPointillismHighlightSkip',
    dotScale: 'uPointillismDotScale',
    dotSizeFactor: 'uPointillismDotSizeFactor',
    strokeAspect: 'uPointillismStrokeAspect',
    roundness: 'uPointillismRoundness',
    strokeSoftness: 'uPointillismStrokeSoftness',
    strokeLength: 'uPointillismStrokeLength',
    strokeWidth: 'uPointillismStrokeWidth',
    shapeJitter: 'uPointillismShapeJitter',
    paintThickness: 'uPointillismPaintThickness',
    paintOpacity: 'uPointillismPaintOpacity',
    paintGrain: 'uPointillismPaintGrain',
    saturation: 'uPointillismSaturation',
    levelRange: 'uPointillismLevelRange',
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
    typicalDotRadiusSlope: 'uPointillismTypicalDotRadiusSlope',
    maxDotRadiusSlope: 'uPointillismMaxDotRadiusSlope',
    refViewDist: 'uPointillismRefViewDist',
    bucketSlope: 'uPointillismBucketSlope',
    gapSpacing: 'uPointillismGapSpacing',
    denoiseStrength: 'uPointillismDenoiseStrength',
    gapFill: 'uPointillismGapFill'
} as const;

export const POINTILLISM_STIPPLE_SIZE_MIN = 32;
export const POINTILLISM_STIPPLE_SIZE_MAX = 224;
export const POINTILLISM_BRUSH_SIZE_MIN = 0.25;
export const POINTILLISM_BRUSH_SIZE_MAX = 1.5;
export const POINTILLISM_DOT_RADIUS_PX_MIN = 0.25;
export const POINTILLISM_DOT_RADIUS_PX_MAX = 7.5;
/** UI 点径 = 典型投影半径；min floor = typical × 此比例 */
export const POINTILLISM_TYPICAL_TO_MIN_FLOOR = 0.32;
export const POINTILLISM_TYPICAL_TO_MAX_CAP = 1.25;
/** 天空点径相对高斯典型点径的补偿（球面 UV 与 splat 投影语义不同，默认 3.3） */
export const POINTILLISM_SKY_DOT_VISUAL_MATCH_MIN = 1;
export const POINTILLISM_SKY_DOT_VISUAL_MATCH_MAX = 8;
export const POINTILLISM_STROKE_LENGTH_MIN = 0.15;
export const POINTILLISM_STROKE_LENGTH_MAX = 2.5;
export const POINTILLISM_STROKE_WIDTH_MIN = 0.15;
export const POINTILLISM_STROKE_WIDTH_MAX = 1.85;
export const POINTILLISM_PAINT_OPACITY_MIN = 0.08;
export const POINTILLISM_PAINT_OPACITY_MAX = 1.0;
export const POINTILLISM_GAP_SPACING_MIN = 0;
export const POINTILLISM_GAP_SPACING_MAX = 1;
export const POINTILLISM_PAINT_GRAIN_MIN = 0;
export const POINTILLISM_PAINT_GRAIN_MAX = 1;

/** 旧 stippleSize ↑ → 目标点半径 ↓（约 1–5 px）；仅用于读取 legacy 配置 */
export const stippleSizeToTargetDotRadiusPx = (stippleSize: number): number => {
    const t = Math.max(0, Math.min(1, (stippleSize - POINTILLISM_STIPPLE_SIZE_MIN) / (POINTILLISM_STIPPLE_SIZE_MAX - POINTILLISM_STIPPLE_SIZE_MIN)));
    return 5.0 - t * 4.0;
};

/** 合并 legacy stippleSize × brushSize，或直接读取 dotRadiusPx（典型点径） */
export const resolvePointillismTypicalDotRadiusPx = (
    dotRadiusPx: number,
    stippleSize: number,
    brushSize: number
): number => resolvePointillismDotRadiusPx(dotRadiusPx, stippleSize, brushSize);

export const resolvePointillismDotRadiusSlopes = (
    typicalPx: number,
    canvasHeight: number,
    fovRad: number
): { typical: number; min: number; max: number } => {
    const pxToSlope = (px: number) => (px * 2 * Math.tan(fovRad * 0.5)) / Math.max(canvasHeight, 1);
    const typical = Math.max(
        POINTILLISM_DOT_RADIUS_PX_MIN,
        Math.min(POINTILLISM_DOT_RADIUS_PX_MAX, typicalPx)
    );
    return {
        typical: pxToSlope(typical),
        min: pxToSlope(typical * POINTILLISM_TYPICAL_TO_MIN_FLOOR),
        max: pxToSlope(Math.min(POINTILLISM_DOT_RADIUS_PX_MAX, typical * POINTILLISM_TYPICAL_TO_MAX_CAP))
    };
};

/** @deprecated 使用 resolvePointillismTypicalDotRadiusPx */
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
    brushAspect: 0.62,
    brushHardness: 0.88,
    colorVibration: 0.0,
    darkPaintBoost: 0.0,
    highlightSkip: 0.0,
    dotScale: 1.0,
    dotSizeFactor: 0.18,
    strokeAspect: 1.0,
    roundness: 1.0,
    strokeSoftness: 0.08,
    strokeLength: 0.62,
    strokeWidth: 0.46,
    shapeJitter: 0.0,
    paintThickness: 1.0,
    paintOpacity: 1.0,
    paintGrain: 1.0,
    saturation: 1.32,
    lumaLevels: 8,
    contrastDotMix: 0.22,
    warmCoolSplit: 0.58,
    paletteStrength: 0.0,
    paletteIndex: 0,
    sourceStructureBlend: 0.92,
    highlightSparsity: 0.0,
    darkDensityBoost: 0.0,
    seed: 17,
    minVisibleAlpha: 0.08,
    dotRadiusPx: 0.9,
    gapSpacing: 0.4,
    denoiseStrength: 0.52,
    gapFill: 0,
    postEffectEnabled: true,
    stippleSize: 96,
    levels: 8,
    levelRange: 1.0,
    ditherSpread: 0.0,
    skyboxPointillismStrength: 1.0,
    skyDotVisualMatch: 3.3,
    paperStrength: 0.18,
    paperTint: [1.0, 0.97, 0.91] as [number, number, number],
    edgeStrength: 0.72
} as const;

/** @deprecated modify 层已不再使用；保留供 post 配置归一化 */
export const resolvePointillismComplementaryMix = (contrastDotMix: number): number =>
    Math.min(0.5, Math.max(0, contrastDotMix) * 1.35);

/** UI 0–0.55 → 对比色振动强度（满档约 70% 原色 / 20% 邻域 / 10% 强对比） */
export const POINTILLISM_CONTRAST_DOT_MIX_MAX = 0.55;

/** 边缘检测阈值：↑保真 → ↑阈值，只保留强结构轮廓（避免把点颗粒误判为边） */
export const resolvePointillismEdgeThreshold = (edgeStrength: number): number => {
    const t = Math.max(0, Math.min(1, edgeStrength));
    return 0.035 + t * 0.12;
};

/** denoiseStrength 推导 modify 层最小可见 alpha（避免与 UI 双旋钮冲突） */
export const resolvePointillismMinVisibleAlpha = (denoiseStrength: number): number => {
    const t = Math.max(0, Math.min(1, denoiseStrength));
    return 0.05 + t * 0.08;
};

export const pointillismModifyGlsl = /* glsl */`
uniform float uPointillismBrushSize;
uniform float uPointillismBrushAspect;
uniform float uPointillismBrushHardness;
uniform float uPointillismColorVibration;
uniform float uPointillismDarkPaintBoost;
uniform float uPointillismHighlightSkip;
uniform float uPointillismDotScale;
uniform float uPointillismDotSizeFactor;
uniform float uPointillismStrokeAspect;
uniform float uPointillismRoundness;
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
uniform float uPointillismTypicalDotRadiusSlope;
uniform float uPointillismMaxDotRadiusSlope;
uniform float uPointillismRefViewDist;
uniform float uPointillismBucketSlope;
uniform float uPointillismGapSpacing;
uniform float uPointillismDenoiseStrength;
uniform float uPointillismGapFill;
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

vec3 pointRgb2Hsv(vec3 c) {
    float mx = max(c.r, max(c.g, c.b));
    float mn = min(c.r, min(c.g, c.b));
    float d = mx - mn;
    float h = 0.0;
    if (d > 1e-5) {
        if (mx == c.r) {
            h = mod((c.g - c.b) / d, 6.0);
        } else if (mx == c.g) {
            h = (c.b - c.r) / d + 2.0;
        } else {
            h = (c.r - c.g) / d + 4.0;
        }
        h /= 6.0;
    }
    float s = mx <= 1e-5 ? 0.0 : d / mx;
    return vec3(h, s, mx);
}

vec3 pointHsv2Rgb(vec3 hsv) {
    float h = fract(hsv.x) * 6.0;
    float s = clamp(hsv.y, 0.0, 1.0);
    float v = clamp(hsv.z, 0.0, 1.0);
    float i = floor(h);
    float f = h - i;
    float p = v * (1.0 - s);
    float q = v * (1.0 - s * f);
    float t = v * (1.0 - s * (1.0 - f));
    if (i < 1.0) return vec3(v, t, p);
    if (i < 2.0) return vec3(q, v, p);
    if (i < 3.0) return vec3(p, v, t);
    if (i < 4.0) return vec3(p, q, v);
    if (i < 5.0) return vec3(t, p, v);
    return vec3(v, p, q);
}

// 对比色邻域振动：H≈+180°±δ，S/V 微扰，再 lerp 回 base（非色环硬对位）
vec3 pointBaseFamilyDot(vec3 base, vec3 rnd) {
    vec3 hsv = pointRgb2Hsv(clamp(base, 0.0, 1.0));
    hsv.x = fract(hsv.x + (rnd.x - 0.5) * 0.06);
    hsv.y = clamp(hsv.y * mix(0.90, 1.10, rnd.y), 0.0, 1.0);
    hsv.z = clamp(hsv.z * mix(0.92, 1.08, rnd.z), 0.12, 0.98);
    return pointHsv2Rgb(hsv);
}

vec3 pointContrastFamilyDot(vec3 base, vec3 rnd, float strongFlag) {
    vec3 hsv = pointRgb2Hsv(clamp(base, 0.0, 1.0));
    float hueDelta = mix(0.055, 0.028, strongFlag);
    hsv.x = fract(hsv.x + 0.5 + (rnd.x - 0.5) * 2.0 * hueDelta);
    hsv.y = clamp(hsv.y * mix(0.80, 1.0, rnd.y), 0.35, 1.0);
    hsv.z = clamp(hsv.z * mix(0.80, 1.0, rnd.z), 0.12, 0.96);
    vec3 contrast = pointHsv2Rgb(hsv);
    float mixLo = mix(0.20, 0.10, strongFlag);
    float mixHi = mix(0.50, 0.25, strongFlag);
    float t = mix(mixLo, mixHi, rnd.y);
    return mix(contrast, base, t);
}

vec3 pointClampComplementDot(vec3 c) {
    float l = pointLuma(c);
    return clamp(c, vec3(max(0.05, l * 0.52)), vec3(0.99, 0.98, 0.94));
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
    float gap = clamp(uPointillismGapSpacing, 0.0, 1.0);
    float flatDesire = 1.0 - clamp(uPointillismSourceStructureBlend, 0.0, 1.0);
    float fillT = clamp(uPointillismGapFill, 0.0, 1.0);

    float viewDist = max(length(originalCenter - uPointillismViewPos), 0.001);
    float screenMin = viewDist * uPointillismDotRadiusSlope;
    float screenTypical = viewDist * uPointillismTypicalDotRadiusSlope;
    float screenCap = viewDist * uPointillismMaxDotRadiusSlope;

    float prelimDensityT = 1.0 - gap;
    float prelimOverlap = mix(1.36, 0.62, gap) * mix(0.92, 1.08, prelimDensityT);
    float prelimDotSize = originalSize * prelimOverlap * max(0.001, uPointillismDotScale);
    prelimDotSize = min(prelimDotSize, screenCap);
    prelimDotSize = max(prelimDotSize, screenMin * mix(0.46, 0.14, gap));
    float sizeRatio = originalSize / max(prelimDotSize, 0.000001);
    float interiorAnchor = smoothstep(1.0, 2.5, sizeRatio);

    // 平坦区 anchor splat：随 (1 - 原结构保留) 与 gapFill 提高覆盖
    float coverBoost = max(fillT, flatDesire * interiorAnchor * 0.75);
    float coverageGap = gap * (1.0 - coverBoost);
    float densityT = 1.0 - coverageGap;
    float densityBoost = mix(0.92, 1.08, densityT);
    float overlap = mix(1.36, 0.62, coverageGap) * densityBoost;

    // 间距驱动：gapSpacing ↑ → overlap ↓ → 点间缝隙更大（视距自适应）
    float dotSize = originalSize * overlap * max(0.001, uPointillismDotScale);
    float typicalTarget = screenTypical * overlap * max(0.001, uPointillismDotScale);
    float sizeRel = originalSize / max(screenTypical, 0.001);
    float blendTypical = (1.0 - smoothstep(0.42, 1.65, sizeRel)) * 0.88;
    dotSize = mix(dotSize, typicalTarget, blendTypical);
    dotSize = min(dotSize, screenCap);
    dotSize = max(dotSize, screenMin * mix(0.46, 0.14, coverageGap));

    float cellScale = mix(14.0, 36.0, densityT);
    vec3 sizeCell = floor(originalCenter * cellScale);
    float sizePick = mix(0.96, 1.04, pointHash13(sizeCell + vec3(uPointillismSeed * 0.05)));
    dotSize *= sizePick;
    dotSize *= mix(0.96, 1.06, densityT);

    sizeRatio = originalSize / max(dotSize, 0.000001);
    if (sizeRatio > 3.5) {
        gsplatMakeSpherical(scale, dotSize);
        return;
    }

    gsplatMakeSpherical(scale, dotSize);
}

void modifySplatColor(vec3 center, inout vec4 color) {
    float viewDist = max(length(center - uPointillismViewPos), 0.001);
    float distRatio = viewDist / max(uPointillismRefViewDist, 0.01);

    float bucketWorld = max(viewDist * uPointillismBucketSlope, 0.00001);
    vec3 bucketId = floor(center / bucketWorld);
    float bucketHash = pointHash13(bucketId + vec3(uPointillismSeed * 0.07));
    float fillT = clamp(uPointillismGapFill, 0.0, 1.0);
    float flatDesire = 1.0 - clamp(uPointillismSourceStructureBlend, 0.0, 1.0);
    float keepMin = mix(0.28, 0.92, fillT);
    float thinExp = mix(-0.82, -0.38, fillT);
    float overdraw = max(distRatio * distRatio * 0.55, 0.12);
    float keepChance = clamp(
        pow(overdraw, thinExp),
        keepMin,
        1.0
    );
    float interiorKeep = max(fillT, flatDesire * smoothstep(0.10, 0.30, color.a) * 0.72);
    keepChance = mix(keepChance, 1.0, interiorKeep);
    if (bucketHash > keepChance) {
        color.a = 0.0;
        return;
    }

    float denoiseT = clamp(uPointillismDenoiseStrength, 0.0, 1.0);
    float srcAlpha = color.a;
    float minAlpha = clamp(uPointillismMinVisibleAlpha, 0.0, 0.25);
    vec3 src = clamp(color.rgb, 0.0, 1.0);
    float l = pointLuma(src);

    if (srcAlpha < minAlpha) {
        color.a = 0.0;
        return;
    }
    if (l < mix(0.022, 0.012, denoiseT)) {
        color.a = 0.0;
        return;
    }
    // 弱贡献高亮/暗漂浮点（天空与 outlier 常见）
    if (srcAlpha < mix(0.12, 0.17, denoiseT) && l > mix(0.82, 0.76, denoiseT)) {
        color.a = 0.0;
        return;
    }
    if (srcAlpha < mix(0.09, 0.14, denoiseT) && l < mix(0.048, 0.065, denoiseT)) {
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

    float dotMix = clamp(uPointillismContrastDotMix, 0.0, 0.55);
    float vib = clamp(dotMix / 0.55, 0.0, 1.0);
    float strongRate = vib * 0.10;
    float softRate = vib * 0.20;
    float tierR = rnd.z;

    float structure = clamp(uPointillismSourceStructureBlend, 0.0, 1.0);
    vec3 baseDot = clamp(mix(chroma, src, structure * 0.35), 0.0, 1.0);
    vec3 styled;
    if (tierR < strongRate) {
        styled = pointClampComplementDot(pointContrastFamilyDot(baseDot, rnd, 1.0));
    } else if (tierR < strongRate + softRate) {
        styled = pointClampComplementDot(pointContrastFamilyDot(baseDot, rnd, 0.0));
    } else {
        styled = pointClampPigment(pointBaseFamilyDot(baseDot, rnd));
    }
    color.rgb = styled;
    // 可见性已由 srcAlpha 过滤；绘制强度只由 gsplatPS 的 paintOpacity 控制
    color.a = 1.0;
}
`;

export const pointillismModifyWgsl = /* wgsl */`
uniform uPointillismBrushSize: f32;
uniform uPointillismBrushAspect: f32;
uniform uPointillismBrushHardness: f32;
uniform uPointillismColorVibration: f32;
uniform uPointillismDarkPaintBoost: f32;
uniform uPointillismHighlightSkip: f32;
uniform uPointillismDotScale: f32;
uniform uPointillismDotSizeFactor: f32;
uniform uPointillismStrokeAspect: f32;
uniform uPointillismRoundness: f32;
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
uniform uPointillismTypicalDotRadiusSlope: f32;
uniform uPointillismMaxDotRadiusSlope: f32;
uniform uPointillismRefViewDist: f32;
uniform uPointillismBucketSlope: f32;
uniform uPointillismGapSpacing: f32;
uniform uPointillismDenoiseStrength: f32;
uniform uPointillismGapFill: f32;
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

fn pointRgb2Hsv(c: vec3f) -> vec3f {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let d = mx - mn;
    var h = 0.0;
    if (d > 1e-5) {
        if (mx == c.r) {
            h = (c.g - c.b) / d;
            h = h - floor(h / 6.0) * 6.0;
        } else if (mx == c.g) {
            h = (c.b - c.r) / d + 2.0;
        } else {
            h = (c.r - c.g) / d + 4.0;
        }
        h = h / 6.0;
    }
    let s = select(0.0, d / mx, mx > 1e-5);
    return vec3f(h, s, mx);
}

fn pointHsv2Rgb(hsv: vec3f) -> vec3f {
    let h = fract(hsv.x) * 6.0;
    let s = clamp(hsv.y, 0.0, 1.0);
    let v = clamp(hsv.z, 0.0, 1.0);
    let i = floor(h);
    let f = h - i;
    let p = v * (1.0 - s);
    let q = v * (1.0 - s * f);
    let t = v * (1.0 - s * (1.0 - f));
    if (i < 1.0) { return vec3f(v, t, p); }
    if (i < 2.0) { return vec3f(q, v, p); }
    if (i < 3.0) { return vec3f(p, v, t); }
    if (i < 4.0) { return vec3f(p, q, v); }
    if (i < 5.0) { return vec3f(t, p, v); }
    return vec3f(v, p, q);
}

fn pointBaseFamilyDot(base: vec3f, rnd: vec3f) -> vec3f {
    var hsv = pointRgb2Hsv(clamp(base, vec3f(0.0), vec3f(1.0)));
    hsv.x = fract(hsv.x + (rnd.x - 0.5) * 0.06);
    hsv.y = clamp(hsv.y * mix(0.90, 1.10, rnd.y), 0.0, 1.0);
    hsv.z = clamp(hsv.z * mix(0.92, 1.08, rnd.z), 0.12, 0.98);
    return pointHsv2Rgb(hsv);
}

fn pointContrastFamilyDot(base: vec3f, rnd: vec3f, strongFlag: f32) -> vec3f {
    var hsv = pointRgb2Hsv(clamp(base, vec3f(0.0), vec3f(1.0)));
    let hueDelta = mix(0.055, 0.028, strongFlag);
    hsv.x = fract(hsv.x + 0.5 + (rnd.x - 0.5) * 2.0 * hueDelta);
    hsv.y = clamp(hsv.y * mix(0.80, 1.0, rnd.y), 0.35, 1.0);
    hsv.z = clamp(hsv.z * mix(0.80, 1.0, rnd.z), 0.12, 0.96);
    let contrast = pointHsv2Rgb(hsv);
    let mixLo = mix(0.20, 0.10, strongFlag);
    let mixHi = mix(0.50, 0.25, strongFlag);
    let t = mix(mixLo, mixHi, rnd.y);
    return mix(contrast, base, t);
}

fn pointClampComplementDot(c: vec3f) -> vec3f {
    let l = pointLuma(c);
    return clamp(c, vec3f(max(0.05, l * 0.52)), vec3f(0.99, 0.98, 0.94));
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
    let gap = clamp(uniform.uPointillismGapSpacing, 0.0, 1.0);
    let flatDesire = 1.0 - clamp(uniform.uPointillismSourceStructureBlend, 0.0, 1.0);
    let fillT = clamp(uniform.uPointillismGapFill, 0.0, 1.0);

    let viewDist = max(length(originalCenter - uniform.uPointillismViewPos), 0.001);
    let screenMin = viewDist * uniform.uPointillismDotRadiusSlope;
    let screenTypical = viewDist * uniform.uPointillismTypicalDotRadiusSlope;
    let screenCap = viewDist * uniform.uPointillismMaxDotRadiusSlope;

    let prelimDensityT = 1.0 - gap;
    let prelimOverlap = mix(1.36, 0.62, gap) * mix(0.92, 1.08, prelimDensityT);
    var prelimDotSize = originalSize * prelimOverlap * max(0.001, uniform.uPointillismDotScale);
    prelimDotSize = min(prelimDotSize, screenCap);
    prelimDotSize = max(prelimDotSize, screenMin * mix(0.46, 0.14, gap));
    var sizeRatio = originalSize / max(prelimDotSize, 0.000001);
    let interiorAnchor = smoothstep(1.0, 2.5, sizeRatio);

    let coverBoost = max(fillT, flatDesire * interiorAnchor * 0.75);
    let coverageGap = gap * (1.0 - coverBoost);
    let densityT = 1.0 - coverageGap;
    let densityBoost = mix(0.92, 1.08, densityT);
    let overlap = mix(1.36, 0.62, coverageGap) * densityBoost;

    var dotSize = originalSize * overlap * max(0.001, uniform.uPointillismDotScale);
    let typicalTarget = screenTypical * overlap * max(0.001, uniform.uPointillismDotScale);
    let sizeRel = originalSize / max(screenTypical, 0.001);
    let blendTypical = (1.0 - smoothstep(0.42, 1.65, sizeRel)) * 0.88;
    dotSize = mix(dotSize, typicalTarget, blendTypical);
    dotSize = min(dotSize, screenCap);
    dotSize = max(dotSize, screenMin * mix(0.46, 0.14, coverageGap));

    let cellScale = mix(14.0, 36.0, densityT);
    let sizeCell = floor(originalCenter * cellScale);
    let sizePick = mix(0.96, 1.04, pointHash13(sizeCell + vec3f(uniform.uPointillismSeed * 0.05)));
    dotSize *= sizePick;
    dotSize *= mix(0.96, 1.06, densityT);

    sizeRatio = originalSize / max(dotSize, 0.000001);
    if (sizeRatio > 3.5) {
        gsplatMakeSpherical(scale, dotSize);
        return;
    }

    gsplatMakeSpherical(scale, dotSize);
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let viewDist = max(length(center - uniform.uPointillismViewPos), 0.001);
    let distRatio = viewDist / max(uniform.uPointillismRefViewDist, 0.01);

    let bucketWorld = max(viewDist * uniform.uPointillismBucketSlope, 0.00001);
    let bucketId = floor(center / bucketWorld);
    let bucketHash = pointHash13(bucketId + vec3f(uniform.uPointillismSeed * 0.07));
    let fillT = clamp(uniform.uPointillismGapFill, 0.0, 1.0);
    let flatDesire = 1.0 - clamp(uniform.uPointillismSourceStructureBlend, 0.0, 1.0);
    let keepMin = mix(0.28, 0.92, fillT);
    let thinExp = mix(-0.82, -0.38, fillT);
    let overdraw = max(distRatio * distRatio * 0.55, 0.12);
    var keepChance = clamp(
        pow(overdraw, thinExp),
        keepMin,
        1.0
    );
    let interiorKeep = max(fillT, flatDesire * smoothstep(0.10, 0.30, (*color).a) * 0.72);
    keepChance = mix(keepChance, 1.0, interiorKeep);
    if (bucketHash > keepChance) {
        (*color).a = 0.0;
        return;
    }

    let denoiseT = clamp(uniform.uPointillismDenoiseStrength, 0.0, 1.0);
    let srcAlpha = (*color).a;
    let minAlpha = clamp(uniform.uPointillismMinVisibleAlpha, 0.0, 0.25);
    let src = clamp((*color).rgb, vec3f(0.0), vec3f(1.0));
    var l = pointLuma(src);

    if (srcAlpha < minAlpha) {
        (*color).a = 0.0;
        return;
    }
    if (l < mix(0.022, 0.012, denoiseT)) {
        (*color).a = 0.0;
        return;
    }
    if (srcAlpha < mix(0.12, 0.17, denoiseT) && l > mix(0.82, 0.76, denoiseT)) {
        (*color).a = 0.0;
        return;
    }
    if (srcAlpha < mix(0.09, 0.14, denoiseT) && l < mix(0.048, 0.065, denoiseT)) {
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

    let dotMix = clamp(uniform.uPointillismContrastDotMix, 0.0, 0.55);
    let vib = clamp(dotMix / 0.55, 0.0, 1.0);
    let strongRate = vib * 0.10;
    let softRate = vib * 0.20;
    let tierR = rnd.z;

    let structure = clamp(uniform.uPointillismSourceStructureBlend, 0.0, 1.0);
    let baseDot = clamp(mix(chroma, src, structure * 0.35), vec3f(0.0), vec3f(1.0));
    var styled: vec3f;
    if (tierR < strongRate) {
        styled = pointClampComplementDot(pointContrastFamilyDot(baseDot, rnd, 1.0));
    } else if (tierR < strongRate + softRate) {
        styled = pointClampComplementDot(pointContrastFamilyDot(baseDot, rnd, 0.0));
    } else {
        styled = pointClampPigment(pointBaseFamilyDot(baseDot, rnd));
    }
    (*color).rgb = styled;
    (*color).a = 1.0;
}
`;
