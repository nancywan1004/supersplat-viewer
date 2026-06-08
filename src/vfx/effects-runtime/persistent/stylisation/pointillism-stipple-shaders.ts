export const POINTILLISM_COMPOSER_ID = 'pointillism-stipple';

export const POINTILLISM_UNIFORM_NAMES = {
    dotScale: 'uPointillismDotScale',
    strokeAspect: 'uPointillismStrokeAspect',
    roundness: 'uPointillismRoundness',
    density: 'uPointillismDensity',
    strokeSoftness: 'uPointillismStrokeSoftness',
    paintThickness: 'uPointillismPaintThickness',
    saturation: 'uPointillismSaturation',
    lumaLevels: 'uPointillismLumaLevels',
    contrastDotMix: 'uPointillismContrastDotMix',
    complementaryMix: 'uPointillismComplementaryMix',
    warmCoolSplit: 'uPointillismWarmCoolSplit',
    paletteStrength: 'uPointillismPaletteStrength',
    paletteIndex: 'uPointillismPaletteIndex',
    sourceStructureBlend: 'uPointillismSourceStructureBlend',
    seed: 'uPointillismSeed',
    minVisibleAlpha: 'uPointillismMinVisibleAlpha'
} as const;

export const POINTILLISM_DEFAULTS = {
    dotScale: 1.08,
    strokeAspect: 1.25,
    roundness: 0.72,
    density: 1.0,
    strokeSoftness: 0.18,
    paintThickness: 1.28,
    saturation: 1.7,
    lumaLevels: 8,
    contrastDotMix: 0.22,
    complementaryMix: 0.12,
    warmCoolSplit: 0.38,
    paletteStrength: 0.35,
    paletteIndex: 0,
    sourceStructureBlend: 0.18,
    seed: 17,
    minVisibleAlpha: 1 / 255
} as const;

export const pointillismModifyGlsl = /* glsl */`
uniform float uPointillismDotScale;
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
    vec3 warm = c * vec3(1.16, 1.04, 0.88) + vec3(0.035, 0.012, 0.0);
    vec3 cool = c * vec3(0.86, 0.98, 1.20) + vec3(0.0, 0.008, 0.035);
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
        darkCol = vec3(0.05, 0.09, 0.18);
        midCol = vec3(0.08, 0.42, 0.95);
        lightCol = vec3(1.00, 0.84, 0.34);
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
    float meanScale = max((scale.x + scale.y + scale.z) * 0.333333, 1e-5);
    vec3 rounded = mix(scale, vec3(meanScale), clamp(uPointillismRoundness, 0.0, 1.0));
    float aspect = clamp(uPointillismStrokeAspect, 1.0, 2.2);
    float axisPick = rnd.x < 0.5 ? -1.0 : 1.0;
    rounded.x *= axisPick < 0.0 ? aspect : 1.0 / sqrt(aspect);
    rounded.y *= axisPick < 0.0 ? 1.0 / sqrt(aspect) : aspect;
    float sizeJitter = mix(0.86, 1.18, rnd.y);
    float densityScale = mix(0.86, 1.22, clamp(uPointillismDensity, 0.0, 2.0) * 0.5);
    scale = rounded * max(0.02, uPointillismDotScale) * sizeJitter * densityScale;
}

void modifySplatColor(vec3 center, inout vec4 color) {
    vec3 rnd = pointHash33(center * 1.91);
    vec3 src = clamp(color.rgb, 0.0, 1.0);
    float l = pointLuma(src);
    float levels = max(2.0, floor(uPointillismLumaLevels + 0.5));
    float q = floor(l * (levels - 1.0) + rnd.x * 0.48) / max(1.0, levels - 1.0);
    vec3 chroma = pointSaturate(src, max(0.0, uPointillismSaturation));
    chroma = pointHueNudge(chroma, clamp(uPointillismWarmCoolSplit, 0.0, 1.0), rnd.y);
    vec3 pal = pointPalette(q, uPointillismPaletteIndex);
    vec3 styled = mix(chroma, pointSaturate(pal, uPointillismSaturation * 0.72), clamp(uPointillismPaletteStrength, 0.0, 1.0));

    float contrastGate = step(rnd.z, clamp(uPointillismContrastDotMix, 0.0, 1.0));
    vec3 comp = pointComplement(styled);
    styled = mix(styled, comp, contrastGate * clamp(uPointillismComplementaryMix, 0.0, 1.0));

    float structure = clamp(uPointillismSourceStructureBlend, 0.0, 1.0);
    vec3 structureColor = pointSaturate(mix(vec3(q), src, 0.65), max(1.0, uPointillismSaturation * 0.55));
    color.rgb = clamp(mix(styled, structureColor, structure), 0.0, 1.0);

    float darkBoost = mix(1.24, 0.76, smoothstep(0.10, 0.92, l));
    float density = clamp(uPointillismDensity, 0.0, 2.0);
    color.a *= mix(0.58, 1.42, density * 0.5) * darkBoost;
}
`;

export const pointillismModifyWgsl = /* wgsl */`
uniform uPointillismDotScale: f32;
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
    let warm = c * vec3f(1.16, 1.04, 0.88) + vec3f(0.035, 0.012, 0.0);
    let cool = c * vec3f(0.86, 0.98, 1.20) + vec3f(0.0, 0.008, 0.035);
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
        darkCol = vec3f(0.05, 0.09, 0.18);
        midCol = vec3f(0.08, 0.42, 0.95);
        lightCol = vec3f(1.00, 0.84, 0.34);
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
    let s = *scale;
    let meanScale = max((s.x + s.y + s.z) * 0.333333, 1e-5);
    var rounded = mix(s, vec3f(meanScale), clamp(uniform.uPointillismRoundness, 0.0, 1.0));
    let aspect = clamp(uniform.uPointillismStrokeAspect, 1.0, 2.2);
    if (rnd.x < 0.5) {
        rounded.x *= aspect;
        rounded.y *= 1.0 / sqrt(aspect);
    } else {
        rounded.x *= 1.0 / sqrt(aspect);
        rounded.y *= aspect;
    }
    let sizeJitter = mix(0.86, 1.18, rnd.y);
    let densityScale = mix(0.86, 1.22, clamp(uniform.uPointillismDensity, 0.0, 2.0) * 0.5);
    *scale = rounded * max(0.02, uniform.uPointillismDotScale) * sizeJitter * densityScale;
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let rnd = pointHash33(center * 1.91);
    let src = clamp((*color).rgb, vec3f(0.0), vec3f(1.0));
    let l = pointLuma(src);
    let levels = max(2.0, floor(uniform.uPointillismLumaLevels + 0.5));
    let q = floor(l * (levels - 1.0) + rnd.x * 0.48) / max(1.0, levels - 1.0);
    var chroma = pointSaturate(src, max(0.0, uniform.uPointillismSaturation));
    chroma = pointHueNudge(chroma, clamp(uniform.uPointillismWarmCoolSplit, 0.0, 1.0), rnd.y);
    let pal = pointPalette(q, uniform.uPointillismPaletteIndex);
    var styled = mix(chroma, pointSaturate(pal, uniform.uPointillismSaturation * 0.72), clamp(uniform.uPointillismPaletteStrength, 0.0, 1.0));

    let contrastGate = step(rnd.z, clamp(uniform.uPointillismContrastDotMix, 0.0, 1.0));
    let comp = pointComplement(styled);
    styled = mix(styled, comp, contrastGate * clamp(uniform.uPointillismComplementaryMix, 0.0, 1.0));

    let structure = clamp(uniform.uPointillismSourceStructureBlend, 0.0, 1.0);
    let structureColor = pointSaturate(mix(vec3f(q), src, 0.65), max(1.0, uniform.uPointillismSaturation * 0.55));
    (*color).rgb = clamp(mix(styled, structureColor, structure), vec3f(0.0), vec3f(1.0));

    let darkBoost = mix(1.24, 0.76, smoothstep(0.10, 0.92, l));
    let density = clamp(uniform.uPointillismDensity, 0.0, 2.0);
    (*color).a *= mix(0.58, 1.42, density * 0.5) * darkBoost;
}
`;
