/** 天空盒点彩：在 skyboxPS 内按方向/UV 做点彩，不经过全屏 post。 */

export const SKYBOX_POINTILLISM_UNIFORM_NAMES = {
    strength: 'uSkyboxPointillismStrength',
    angularSpacing: 'uSkyboxAngularSpacing',
    rxCellScale: 'uSkyboxRxCellScale',
    dotRadiusSlope: 'uPointillismDotRadiusSlope',
    dotRadiusPx: 'uPointillismDotRadiusPx',
    dotScale: 'uPointillismDotScale',
    gapSpacing: 'uPointillismGapSpacing',
    saturation: 'uPointillismSaturation',
    levelRange: 'uPointillismLevelRange',
    warmCoolSplit: 'uPointillismWarmCoolSplit',
    colorVibration: 'uPointillismColorVibration',
    contrastDotMix: 'uPointillismContrastDotMix',
    seed: 'uPointillismSeed',
    strokeLength: 'uPointillismStrokeLength',
    strokeWidth: 'uPointillismStrokeWidth',
    brushAspect: 'uPointillismBrushAspect',
    brushHardness: 'uPointillismBrushHardness',
    paintGrain: 'uPointillismPaintGrain',
    paperStrength: 'uPointillismPaperStrength'
} as const;

const patchChunk = (source: string, search: string, replacement: string, name: string): string => {
    if (!source.includes(search)) {
        console.warn(`patchChunk: substring not found in '${name}', shader chunk patch may be out of sync with the engine.`);
    }
    return source.replace(search, replacement);
};

const SKY_STROKE_LEN_MIN = 0.15;
const SKY_STROKE_LEN_MAX = 2.5;
const SKY_STROKE_WID_MIN = 0.15;
const SKY_STROKE_WID_MAX = 1.85;

/** 预计算天空笔触间距与 cell 占比；grid 密度与 overlap 对齐高斯 modifySplatRotationScale（≈1.36） */
export const computeSkyboxPointillismMetrics = (
    typicalDotRadiusSlope: number,
    gapSpacing: number,
    dotScale: number,
    skyDotVisualMatch: number
): { angularSpacing: number; rxCellScale: number } => {
    const gap = Math.max(0, Math.min(1, gapSpacing));
    const densityT = 1 - gap;
    const densityBoost = 0.94 + 0.14 * densityT;
    const overlap = (1.44 - 0.62 * gap) * densityBoost;
    const scale = Math.max(0.85, Math.min(1.15, dotScale));
    const visualMatch = Math.max(1, skyDotVisualMatch);
    const brushAngular = Math.max(typicalDotRadiusSlope, 1e-6) * overlap * scale * visualMatch;
    const spacingRatio = 1.22 + 0.48 * gap;
    const angularSpacing = brushAngular * spacingRatio;
    const rxCellScale = Math.max(0.54, Math.min(0.80, 1.42 / spacingRatio));
    return { angularSpacing, rxCellScale };
};

export const skyboxPointillismGlsl = /* glsl */`
uniform float uSkyboxPointillismStrength;
uniform float uSkyboxAngularSpacing;
uniform float uSkyboxRxCellScale;
uniform float uPointillismDotRadiusSlope;
uniform float uPointillismDotRadiusPx;
uniform float uPointillismDotScale;
uniform float uPointillismGapSpacing;
uniform float uPointillismSaturation;
uniform float uPointillismLevelRange;
uniform float uPointillismWarmCoolSplit;
uniform float uPointillismColorVibration;
uniform float uPointillismContrastDotMix;
uniform float uPointillismSeed;
uniform float uPointillismStrokeLength;
uniform float uPointillismStrokeWidth;
uniform float uPointillismBrushAspect;
uniform float uPointillismBrushHardness;
uniform float uPointillismPaintGrain;
uniform float uPointillismPaperStrength;
uniform vec3 uPointillismPaperTint;

float skyPointHash(vec2 p) {
    return fract(sin(dot(p, vec2(127.1, 311.7)) + uPointillismSeed * 0.071) * 43758.5453123);
}

vec2 skyPointHash2(vec2 p) {
    return fract(sin(vec2(dot(p, vec2(269.5, 183.3)), dot(p, vec2(419.2, 371.9))) + uPointillismSeed * 0.053) * 43758.5453);
}

float skyPointLuma(vec3 c) {
    return dot(c, vec3(0.2126, 0.7152, 0.0722));
}

vec3 skyPointSaturate(vec3 c, float s) {
    float l = skyPointLuma(c);
    return mix(vec3(l), c, s);
}

vec3 skyPointNormalize(vec3 c) {
    float l = max(skyPointLuma(c), 0.0001);
    return c / l;
}

vec3 skyPointGain(vec3 c, float amount) {
    float gain = mix(0.78, 1.38, clamp((amount - 0.5) / 1.5, 0.0, 1.0));
    return c * gain;
}

float skyPointStrokeT(float v, float lo, float hi) {
    return clamp((v - lo) / (hi - lo), 0.0, 1.0);
}

vec2 skyPointSphericalUv(vec3 dir) {
    const float PI = 3.141592653589793;
    vec3 n = normalize(dir);
    vec2 sp = vec2(n.xz == vec2(0.0) ? 0.0 : atan(n.x, n.z), asin(clamp(n.y, -1.0, 1.0)));
    vec2 uv = sp / vec2(PI * 2.0, PI) + 0.5;
    return vec2(uv.x, 1.0 - uv.y);
}

vec3 skyPointSample(vec3 dir) {
    vec3 d = normalize(dir);
    #ifdef SKY_CUBEMAP
        return {SKYBOX_DECODE_FNC}(textureCube(texture_cubeMap, d));
    #else
        // equirect 在 v≈0/1 极点处 UV 退化，微偏移避免采到错误 texel
        if (abs(d.y) > 0.998) {
            d = normalize(vec3(d.x + 1e-4, sign(d.y), d.z + 1e-4));
        }
        return {SKYBOX_DECODE_FNC}(texture2D(texture_envAtlas, skyPointSphericalUv(d)));
    #endif
}

vec3 skyDirFromSphericalUv(vec2 uv) {
    const float PI = 3.141592653589793;
    vec2 sp = (vec2(uv.x, 1.0 - uv.y) - 0.5) * vec2(PI * 2.0, PI);
    float cosLat = cos(sp.y);
    return normalize(vec3(sin(sp.x) * cosLat, sin(sp.y), cos(sp.x) * cosLat));
}

// 八面体球面参数化：天顶连续，无方位角极点/纬向 band
vec2 skyPointOctEncode(vec3 dir) {
    vec3 n = normalize(dir);
    n /= max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6);
    vec2 p = n.xz;
    if (n.y < 0.0) {
        p = (1.0 - abs(p.yx)) * sign(p);
    }
    return p;
}

vec2 skyPointGridPosFromDir(vec3 dir, float angularSpacing) {
    vec2 p = skyPointOctEncode(dir);
    const float SKY_GRID_HORIZ = 1.42;
    const float SKY_GRID_VERT = 0.78;
    return vec2(p.x * SKY_GRID_HORIZ, p.y * SKY_GRID_VERT) / angularSpacing;
}

// oct 网格索引保留；cell 中心反解为 3D 方向，mask 用球面角距离（方案 C）
vec2 skyGridToOct(vec2 gridPos, float angularSpacing) {
    const float SKY_GRID_HORIZ = 1.42;
    const float SKY_GRID_VERT = 0.78;
    return vec2(
        gridPos.x * angularSpacing / SKY_GRID_HORIZ,
        gridPos.y * angularSpacing / SKY_GRID_VERT
    );
}

vec3 skyOctDecode(vec2 p) {
    float sumAbs = abs(p.x) + abs(p.y);
    vec3 n;
    if (sumAbs <= 1.0) {
        n = vec3(p.x, 1.0 - sumAbs, p.y);
    } else {
        vec2 s = sign(p + vec2(1e-6));
        n.x = s.x * (1.0 - abs(p.y));
        n.z = s.y * (1.0 - abs(p.x));
        n.y = -(1.0 - abs(n.x) - abs(n.z));
    }
    return normalize(n);
}

vec3 skyCellDirFromGrid(vec2 centerGrid, float angularSpacing) {
    return skyOctDecode(skyGridToOct(centerGrid, angularSpacing));
}

float skyCellAngularRadius(float cellRx, float angularSpacing) {
    const float SKY_GRID_HORIZ = 1.42;
    const float SKY_GRID_VERT = 0.78;
    const float SKY_DOT_ANGULAR_SCALE = 1.16;
    float angPerGrid = angularSpacing * 0.5 * (1.0 / SKY_GRID_HORIZ + 1.0 / SKY_GRID_VERT);
    return cellRx * angPerGrid * SKY_DOT_ANGULAR_SCALE;
}

vec3 skyCellTangentBasis(vec3 cellDir) {
    vec3 up = abs(cellDir.y) < 0.9 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
    return normalize(cross(up, cellDir));
}

void skyCellTangentCoords(vec3 d, vec3 cellDir, out float u, out float v, out float cosA) {
    cosA = dot(d, cellDir);
    vec3 delta = d - cellDir * cosA;
    vec3 tangent = skyCellTangentBasis(cellDir);
    vec3 bitangent = cross(cellDir, tangent);
    u = dot(delta, tangent);
    v = dot(delta, bitangent);
}

// 中心亮、边缘渐隐的圆形笔触；coreEnd 与高斯一致，aa 下限保证天空远景也有可见软边
float skyAngularRadialMask(float cosA, float angularR) {
    float angR = max(angularR, 1e-6);
    float ang = acos(clamp(cosA, -1.0, 1.0));
    float A = (ang / angR) * (ang / angR);
    float hard = clamp(uPointillismBrushHardness, 0.0, 1.0);
    float coreEnd = mix(0.52, 0.82, hard);
    float aa = max(fwidth(A) * 1.72, 0.014);
    return 1.0 - smoothstep(coreEnd - aa, 1.0 + aa * 0.5, A);
}

float skyPointIrregularity() {
    return mix(0.68, 1.0, clamp(uPointillismGapSpacing, 0.0, 1.0));
}

vec2 skyPointSmoothMacroWarp(vec2 gridPos, vec2 salt, float irregularity) {
    const float macroScale = 0.17;
    vec2 g = gridPos * macroScale;
    vec2 i = floor(g);
    vec2 f = fract(g);
    f = f * f * (3.0 - 2.0 * f);
    vec2 w00 = skyPointHash2(i + salt * 0.31 + vec2(13.0, 7.0)) - 0.5;
    vec2 w10 = skyPointHash2(i + vec2(1.0, 0.0) + salt * 0.31 + vec2(13.0, 7.0)) - 0.5;
    vec2 w01 = skyPointHash2(i + vec2(0.0, 1.0) + salt * 0.31 + vec2(13.0, 7.0)) - 0.5;
    vec2 w11 = skyPointHash2(i + vec2(1.0, 1.0) + salt * 0.31 + vec2(13.0, 7.0)) - 0.5;
    vec2 warp = mix(mix(w00, w10, f.x), mix(w01, w11, f.x), f.y);
    return gridPos + warp * mix(0.22, 0.48, irregularity) + salt * 0.00001;
}

vec2 skyStaggeredCellCenter(vec2 cell) {
    float brickX = step(1.0, mod(cell.y, 2.0)) * 0.5;
    return cell + vec2(0.5 + brickX, 0.5);
}

vec2 skyCellCenterJitter(vec2 hashCell, vec2 salt, float irr) {
    vec2 rnd2 = skyPointHash2(hashCell + salt * 0.07 + vec2(41.0, 73.0));
    return (rnd2 - 0.5) * mix(0.32, 0.50, irr);
}

vec2 skyPointBaseCell(vec2 gridPos) {
    return floor(gridPos);
}

// 与高斯同轴；天空侧强圆化（无屏幕导数，仅压扁笔触轴）
vec2 skyPointillismShapeUVSky(vec2 q, float cellRx) {
    float invR = 1.0 / max(cellRx, 0.001);
    vec2 uv = q * invR;
    float lenT = skyPointStrokeT(uPointillismStrokeLength, ${SKY_STROKE_LEN_MIN}, ${SKY_STROKE_LEN_MAX}) * 0.08;
    float widT = skyPointStrokeT(uPointillismStrokeWidth, ${SKY_STROKE_WID_MIN}, ${SKY_STROKE_WID_MAX});
    float lenAxis = 1.0 + mix(0.02, 0.82, lenT);
    float widAxis = mix(1.16, 0.52, widT);
    widAxis *= mix(0.90, 1.10, clamp(uPointillismBrushAspect, 0.5, 1.2));
    lenAxis = mix(lenAxis, 1.0, 0.94);
    widAxis = mix(widAxis, 1.0, 0.94);
    const float SKY_STROKE_ASPECT_CAP = 1.04;
    lenAxis = max(lenAxis, widAxis / SKY_STROKE_ASPECT_CAP);
    widAxis = max(widAxis, lenAxis / SKY_STROKE_ASPECT_CAP);
    return vec2(uv.x / lenAxis, uv.y * widAxis);
}

float skyPointValueNoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    float a = skyPointHash(i);
    float b = skyPointHash(i + vec2(1.0, 0.0));
    float c = skyPointHash(i + vec2(0.0, 1.0));
    float d = skyPointHash(i + vec2(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

float skyPointFbm3(vec2 p) {
    float v = 0.0;
    v += 0.5 * skyPointValueNoise(p);
    v += 0.25 * skyPointValueNoise(p * 2.1 + vec2(1.7, 9.2));
    v += 0.125 * skyPointValueNoise(p * 4.2 + vec2(8.3, 2.8));
    return v / 0.875;
}

vec4 skyPointPigmentDaub(vec2 shapeUV, float A, vec2 hashCell) {
    const float SKY_PAINT_GRAIN_SCALE = 0.38;
    float grain = clamp(uPointillismPaintGrain, 0.0, 1.0) * SKY_PAINT_GRAIN_SCALE;
    if (grain < 0.001) {
        return vec4(1.0);
    }
    vec2 strokeSeed = hashCell * 13.7 + vec2(skyPointHash(hashCell + 19.0), skyPointHash(hashCell + 37.0)) * 9.3 + uPointillismSeed * 0.07;
    vec2 p = shapeUV * mix(3.2, 8.0, grain) + strokeSeed;
    float coarse = skyPointFbm3(p);
    float fine = skyPointValueNoise(p * 11.0 + vec2(strokeSeed.y, strokeSeed.x));
    float streak = skyPointValueNoise(shapeUV * 2.0 + vec2(strokeSeed.x, strokeSeed.y));
    float pigment = coarse * 0.50 + fine * 0.38 + streak * 0.06;
    float edgeFade = 1.0 - smoothstep(mix(0.48, 0.80, grain), 0.96, A);
    float g = (pigment - 0.5) * grain * edgeFade * 1.18;
    float luma = 1.0 + g * 0.54;
    float alpha = 1.0 + g * 0.66;
    float warm = g * 0.11;
    return vec4(luma + warm, luma, luma - warm * 0.58, alpha);
}

vec2 skyPointStrokeShapeAt(vec3 d, vec2 gridPos, vec2 cell, vec2 salt, float rxCellScale, float irr, float angularSpacing, out float AOut) {
    vec2 center = skyStaggeredCellCenter(cell) + skyCellCenterJitter(cell, salt, irr);
    vec3 cellDir = skyCellDirFromGrid(center, angularSpacing);
    float sizeVar = mix(0.82, 1.18, skyPointHash(cell + 51.0));
    float cellRx = rxCellScale * sizeVar;
    float angularR = skyCellAngularRadius(cellRx, angularSpacing);

    float cosA;
    float tu;
    float tv;
    skyCellTangentCoords(d, cellDir, tu, tv, cosA);

    float angle = skyPointHash(cell + 103.0) * 6.2831853 + uPointillismSeed * 0.13;
    angle += (skyPointHash(cell + 127.0) - 0.5) * mix(0.14, 0.24, irr);
    float c = cos(angle);
    float s = sin(angle);
    vec2 q = vec2(c * tu - s * tv, s * tu + c * tv) / angularR * cellRx;
    vec2 shapeUV = skyPointillismShapeUVSky(q, cellRx);

    float ang = acos(clamp(cosA, -1.0, 1.0));
    AOut = (ang / angularR) * (ang / angularR);
    return shapeUV;
}

float skyPointillismRadialMask(vec2 shapeUV) {
    float A = dot(shapeUV, shapeUV);
    float hard = clamp(uPointillismBrushHardness, 0.0, 1.0);
    float coreEnd = mix(0.52, 0.82, hard);
    float aa = max(fwidth(A) * 1.72, 0.0045);
    return 1.0 - smoothstep(coreEnd - aa, 1.0 + aa * 0.5, A);
}

float skyPointillismLayerClean(float layer) {
    layer = clamp(layer, 0.0, 1.0);
    return mix(layer, 1.0 - pow(1.0 - layer, 2.4), 0.92);
}

float skyDaubMaskAtCell(vec3 d, vec2 gridPos, vec2 cell, vec2 hashCell, vec2 salt, float rxCellScale, float irr, float angularSpacing) {
    vec2 center = skyStaggeredCellCenter(cell) + skyCellCenterJitter(hashCell, salt, irr);
    vec3 cellDir = skyCellDirFromGrid(center, angularSpacing);
    float sizeVar = mix(0.82, 1.18, skyPointHash(hashCell + 51.0));
    float cellRx = rxCellScale * sizeVar;
    float angularR = skyCellAngularRadius(cellRx, angularSpacing);

    float cosA;
    float tu;
    float tv;
    skyCellTangentCoords(d, cellDir, tu, tv, cosA);
    return skyAngularRadialMask(cosA, angularR);
}

float skyEvaluatePointillismLayer(vec3 d, vec2 gridPosIn, vec2 salt, float rxCellScale, float angularSpacing, out vec2 dominantCell) {
    float irr = skyPointIrregularity();
    vec2 gridPos = skyPointSmoothMacroWarp(gridPosIn, salt, irr);
    vec2 baseCell = skyPointBaseCell(gridPos);

    float hardMax = 0.0;
    float softAcc = 0.0;
    dominantCell = baseCell;
    for (int oy = -2; oy <= 2; oy++) {
        for (int ox = -2; ox <= 2; ox++) {
            vec2 cell = baseCell + vec2(float(ox), float(oy));
            float m = skyDaubMaskAtCell(d, gridPos, cell, cell, salt, rxCellScale, irr, angularSpacing);
            softAcc += m * m;
            if (m > hardMax) {
                hardMax = m;
                dominantCell = cell;
            }
        }
    }
    float softLayer = 1.0 - exp(-softAcc * 1.02);
    return mix(softLayer, hardMax, 0.04);
}

float skySphereDaubMaskCore(vec3 d, vec2 gridPosIn, vec2 salt, float rxCellScale, float angularSpacing) {
    vec2 dominantCell;
    return skyEvaluatePointillismLayer(d, gridPosIn, salt, rxCellScale, angularSpacing, dominantCell);
}

vec3 skyPointHueNudge(vec3 c, float warmCool, float pick) {
    vec3 warm = c * vec3(1.24, 1.08, 0.76) + vec3(0.07, 0.025, 0.0);
    vec3 cool = c * vec3(0.76, 0.86, 1.24) + vec3(0.01, 0.025, 0.07);
    float t = smoothstep(0.22, 0.78, pick);
    return mix(c, mix(cool, warm, t), warmCool);
}

vec3 skyPointRgb2Hsv(vec3 c) {
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

vec3 skyPointHsv2Rgb(vec3 hsv) {
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

vec3 skyPointBaseFamilyDot(vec3 base, vec3 rnd) {
    vec3 hsv = skyPointRgb2Hsv(clamp(base, 0.0, 1.0));
    hsv.x = fract(hsv.x + (rnd.x - 0.5) * 0.06);
    hsv.y = clamp(hsv.y * mix(0.90, 1.10, rnd.y), 0.0, 1.0);
    hsv.z = clamp(hsv.z * mix(0.92, 1.08, rnd.z), 0.12, 0.98);
    return skyPointHsv2Rgb(hsv);
}

vec3 skyPointContrastFamilyDot(vec3 base, vec3 rnd, float strongFlag) {
    vec3 hsv = skyPointRgb2Hsv(clamp(base, 0.0, 1.0));
    float hueDelta = mix(0.055, 0.028, strongFlag);
    hsv.x = fract(hsv.x + 0.5 + (rnd.x - 0.5) * 2.0 * hueDelta);
    hsv.y = clamp(hsv.y * mix(0.80, 1.0, rnd.y), 0.35, 1.0);
    hsv.z = clamp(hsv.z * mix(0.80, 1.0, rnd.z), 0.12, 0.96);
    vec3 contrast = skyPointHsv2Rgb(hsv);
    float mixLo = mix(0.20, 0.10, strongFlag);
    float mixHi = mix(0.50, 0.25, strongFlag);
    float mixT = mix(mixLo, mixHi, rnd.y);
    return mix(contrast, base, mixT);
}

vec3 skyPointClampComplementDot(vec3 c) {
    float l = skyPointLuma(c);
    return clamp(c, vec3(max(0.05, l * 0.52)), vec3(0.99, 0.98, 0.94));
}

vec3 skyPointClampPigment(vec3 c) {
    float l = skyPointLuma(c);
    vec3 softFloor = vec3(max(0.04, l * 0.72));
    return clamp(c, softFloor, vec3(0.97, 0.97, 0.94));
}

vec3 skyPointHash3(vec2 cell) {
    return vec3(
        skyPointHash(cell + 0.0),
        skyPointHash(cell + 17.0),
        skyPointHash(cell + 31.0)
    );
}

vec3 skyPointApplyContrast(vec3 color, float levelRange) {
    float t = clamp((levelRange - 0.5) / 1.5, 0.0, 1.0);
    float contrast = mix(0.38, 2.45, t);
    float l = skyPointLuma(color);
    return clamp(mix(vec3(l), color, contrast), 0.0, 1.0);
}

vec3 skyPointApplyWarmCool(vec3 color, float luma, vec3 rnd) {
    float splitT = clamp(uPointillismWarmCoolSplit, 0.0, 1.0);
    if (splitT < 0.001) {
        return color;
    }
    vec3 warm = vec3(1.0, 0.67, 0.22);
    vec3 cool = vec3(0.12, 0.46, 1.0);
    float lightSide = smoothstep(0.35, 0.88, luma);
    vec3 split = mix(cool, warm, lightSide);
    return mix(color, split, splitT * mix(0.14, 0.48, rnd.x));
}

vec3 skyPointStyleNorm(vec3 base, vec2 cell, float luma) {
    vec3 rnd = skyPointHash3(cell + 6.4);
    float colorVib = clamp(uPointillismColorVibration, 0.0, 1.0);
    luma = max(luma, 0.001);

    vec3 chroma = skyPointSaturate(base, max(0.0, uPointillismSaturation) + colorVib * 0.35);
    chroma = skyPointApplyContrast(chroma, clamp(uPointillismLevelRange, 0.5, 2.0));
    float warmPick = smoothstep(0.38, 0.68, luma);
    chroma = skyPointHueNudge(
        chroma,
        clamp(uPointillismWarmCoolSplit + colorVib * 0.12, 0.0, 1.0),
        warmPick
    );

    float dotMix = clamp(uPointillismContrastDotMix, 0.0, 0.55);
    float vib = clamp(dotMix / 0.55, 0.0, 1.0);
    float strongRate = vib * 0.10;
    float softRate = vib * 0.20;
    float tierR = rnd.z;

    vec3 styled;
    if (tierR < strongRate) {
        styled = skyPointClampComplementDot(skyPointContrastFamilyDot(chroma, rnd, 1.0));
    } else if (tierR < strongRate + softRate) {
        styled = skyPointClampComplementDot(skyPointContrastFamilyDot(chroma, rnd, 0.0));
    } else {
        styled = skyPointClampPigment(skyPointBaseFamilyDot(chroma, rnd));
    }
    return skyPointApplyWarmCool(styled, luma, rnd);
}

vec3 applySkyboxPointillism(vec3 linear, vec3 dir) {
    float strength = clamp(uSkyboxPointillismStrength, 0.0, 1.0);
    if (strength < 0.001) {
        return linear;
    }

    vec3 d = normalize(dir);
    float t = strength;
    float angularSpacing = max(uSkyboxAngularSpacing, 1e-6);
    float rxCellScale = clamp(uSkyboxRxCellScale, 0.50, 0.80);

    vec2 salt1 = vec2(0.0, 0.0);
    vec2 gridPos = skyPointGridPosFromDir(d, angularSpacing);
    vec2 dominantCell;
    float layer = skyEvaluatePointillismLayer(d, gridPos, salt1, rxCellScale, angularSpacing, dominantCell);

    vec3 base1 = skyPointSample(d);
    vec3 daubColor = skyPointStyleNorm(base1, dominantCell, skyPointLuma(base1));

    float irr = skyPointIrregularity();
    vec2 gridPosW = skyPointSmoothMacroWarp(gridPos, salt1, irr);
    float shapeA;
    vec2 shapeUV = skyPointStrokeShapeAt(d, gridPosW, dominantCell, salt1, rxCellScale, irr, angularSpacing, shapeA);
    vec4 pigment = skyPointPigmentDaub(shapeUV, shapeA, dominantCell);
    daubColor *= pigment.rgb;
    float grainT = clamp(uPointillismPaintGrain, 0.0, 1.0) * 0.38;
    layer *= mix(1.0, pigment.a, grainT);
    layer = skyPointillismLayerClean(layer);

    float gapL = skyPointLuma(linear);
    vec3 paperBase = mix(
        vec3(gapL) * vec3(0.93, 0.96, 1.0),
        vec3(0.98, 0.96, 0.90),
        mix(0.24, 0.52, t)
    ) * uPointillismPaperTint;
    const float SKY_GAP_STYLE = 0.44;
    const float SKY_GAP_PAPER = 0.20;
    float gapThin = 1.0 - layer;
    vec3 gapSky = mix(linear, daubColor, SKY_GAP_STYLE * (0.55 + 0.45 * gapThin));
    float gapPaper = clamp(uPointillismPaperStrength, 0.0, 1.0) * gapThin * SKY_GAP_PAPER;
    vec3 gapColor = mix(gapSky, paperBase, gapPaper);

    float cover = max(layer, 0.07);
    vec3 result = clamp(mix(gapColor, daubColor, cover), 0.0, 1.0);
    return mix(linear, result, strength);
}
`;

export const skyboxPointillismWgsl = /* wgsl */`
uniform uSkyboxPointillismStrength: f32;
uniform uSkyboxAngularSpacing: f32;
uniform uSkyboxRxCellScale: f32;
uniform uPointillismDotRadiusSlope: f32;
uniform uPointillismDotRadiusPx: f32;
uniform uPointillismDotScale: f32;
uniform uPointillismGapSpacing: f32;
uniform uPointillismSaturation: f32;
uniform uPointillismLevelRange: f32;
uniform uPointillismWarmCoolSplit: f32;
uniform uPointillismColorVibration: f32;
uniform uPointillismContrastDotMix: f32;
uniform uPointillismSeed: f32;
uniform uPointillismStrokeLength: f32;
uniform uPointillismStrokeWidth: f32;
uniform uPointillismBrushAspect: f32;
uniform uPointillismBrushHardness: f32;
uniform uPointillismPaintGrain: f32;
uniform uPointillismPaperStrength: f32;
uniform uPointillismPaperTint: vec3f;

const SKY_STROKE_LEN_MIN: f32 = 0.15;
const SKY_STROKE_LEN_MAX: f32 = 2.5;
const SKY_STROKE_WID_MIN: f32 = 0.15;
const SKY_STROKE_WID_MAX: f32 = 1.85;

fn skyPointHash(p: vec2f) -> f32 {
    return fract(sin(dot(p, vec2f(127.1, 311.7)) + uniform.uPointillismSeed * 0.071) * 43758.5453123);
}

fn skyPointHash2(p: vec2f) -> vec2f {
    return fract(sin(vec2f(dot(p, vec2f(269.5, 183.3)), dot(p, vec2f(419.2, 371.9))) + uniform.uPointillismSeed * 0.053) * 43758.5453);
}

fn skyPointLuma(c: vec3f) -> f32 {
    return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn skyPointSaturate(c: vec3f, s: f32) -> vec3f {
    let l = skyPointLuma(c);
    return mix(vec3f(l), c, s);
}

fn skyPointNormalize(c: vec3f) -> vec3f {
    let l = max(skyPointLuma(c), 0.0001);
    return c / l;
}

fn skyPointGain(c: vec3f, amount: f32) -> vec3f {
    let gain = mix(0.78, 1.38, clamp((amount - 0.5) / 1.5, 0.0, 1.0));
    return c * gain;
}

fn skyPointStrokeT(v: f32, lo: f32, hi: f32) -> f32 {
    return clamp((v - lo) / (hi - lo), 0.0, 1.0);
}

fn skyPointSphericalUv(dir: vec3f) -> vec2f {
    let PI: f32 = 3.141592653589793;
    let n = normalize(dir);
    let sp = vec2f(
        select(0.0, atan2(n.x, n.z), any(n.xz != vec2f(0.0))),
        asin(clamp(n.y, -1.0, 1.0))
    );
    let uv = sp / vec2f(PI * 2.0, PI) + vec2f(0.5);
    return vec2f(uv.x, 1.0 - uv.y);
}

fn skyPointSample(dir: vec3f) -> vec3f {
    var d = normalize(dir);
    #ifdef SKY_CUBEMAP
        return {SKYBOX_DECODE_FNC}(textureSample(texture_cubeMap, texture_cubeMap_sampler, d));
    #else
        if (abs(d.y) > 0.998) {
            d = normalize(vec3f(d.x + 1e-4, sign(d.y), d.z + 1e-4));
        }
        return {SKYBOX_DECODE_FNC}(textureSample(texture_envAtlas, texture_envAtlas_sampler, skyPointSphericalUv(d)));
    #endif
}

fn skyDirFromSphericalUv(uv: vec2f) -> vec3f {
    let PI: f32 = 3.141592653589793;
    let sp = (vec2f(uv.x, 1.0 - uv.y) - vec2f(0.5)) * vec2f(PI * 2.0, PI);
    let cosLat = cos(sp.y);
    return normalize(vec3f(sin(sp.x) * cosLat, sin(sp.y), cos(sp.x) * cosLat));
}

fn skyPointOctEncode(dir: vec3f) -> vec2f {
    var n = normalize(dir);
    n /= max(abs(n.x) + abs(n.y) + abs(n.z), 1e-6);
    var p = n.xz;
    if (n.y < 0.0) {
        p = (1.0 - abs(p.yx)) * sign(p);
    }
    return p;
}

fn skyPointGridPosFromDir(dir: vec3f, angularSpacing: f32) -> vec2f {
    let p = skyPointOctEncode(dir);
    let SKY_GRID_HORIZ: f32 = 1.42;
    let SKY_GRID_VERT: f32 = 0.78;
    return vec2f(p.x * SKY_GRID_HORIZ, p.y * SKY_GRID_VERT) / angularSpacing;
}

fn skyGridToOct(gridPos: vec2f, angularSpacing: f32) -> vec2f {
    let SKY_GRID_HORIZ: f32 = 1.42;
    let SKY_GRID_VERT: f32 = 0.78;
    return vec2f(
        gridPos.x * angularSpacing / SKY_GRID_HORIZ,
        gridPos.y * angularSpacing / SKY_GRID_VERT
    );
}

fn skyOctDecode(p: vec2f) -> vec3f {
    let sumAbs = abs(p.x) + abs(p.y);
    var n: vec3f;
    if (sumAbs <= 1.0) {
        n = vec3f(p.x, 1.0 - sumAbs, p.y);
    } else {
        let s = sign(p + vec2f(1e-6));
        n.x = s.x * (1.0 - abs(p.y));
        n.z = s.y * (1.0 - abs(p.x));
        n.y = -(1.0 - abs(n.x) - abs(n.z));
    }
    return normalize(n);
}

fn skyCellDirFromGrid(centerGrid: vec2f, angularSpacing: f32) -> vec3f {
    return skyOctDecode(skyGridToOct(centerGrid, angularSpacing));
}

fn skyCellAngularRadius(cellRx: f32, angularSpacing: f32) -> f32 {
    let SKY_GRID_HORIZ: f32 = 1.42;
    let SKY_GRID_VERT: f32 = 0.78;
    let SKY_DOT_ANGULAR_SCALE: f32 = 1.16;
    let angPerGrid = angularSpacing * 0.5 * (1.0 / SKY_GRID_HORIZ + 1.0 / SKY_GRID_VERT);
    return cellRx * angPerGrid * SKY_DOT_ANGULAR_SCALE;
}

fn skyCellTangentBasis(cellDir: vec3f) -> vec3f {
    let up = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), abs(cellDir.y) < 0.9);
    return normalize(cross(up, cellDir));
}

fn skyCellTangentCoords(d: vec3f, cellDir: vec3f) -> vec4f {
    let cosA = dot(d, cellDir);
    let delta = d - cellDir * cosA;
    let tangent = skyCellTangentBasis(cellDir);
    let bitangent = cross(cellDir, tangent);
    return vec4f(dot(delta, tangent), dot(delta, bitangent), cosA, 0.0);
}

fn skyAngularRadialMask(cosA: f32, angularR: f32) -> f32 {
    let angR = max(angularR, 1e-6);
    let ang = acos(clamp(cosA, -1.0, 1.0));
    let A = (ang / angR) * (ang / angR);
    let hard = clamp(uniform.uPointillismBrushHardness, 0.0, 1.0);
    let coreEnd = mix(0.52, 0.82, hard);
    let aa = max(fwidth(A) * 1.72, 0.014);
    return 1.0 - smoothstep(coreEnd - aa, 1.0 + aa * 0.5, A);
}

fn skyPointIrregularity() -> f32 {
    return mix(0.68, 1.0, clamp(uniform.uPointillismGapSpacing, 0.0, 1.0));
}

fn skyPointSmoothMacroWarp(gridPosIn: vec2f, salt: vec2f, irregularity: f32) -> vec2f {
    let macroScale = 0.17;
    let g = gridPosIn * macroScale;
    let i = floor(g);
    var f = fract(g);
    f = f * f * (3.0 - 2.0 * f);
    let w00 = skyPointHash2(i + salt * 0.31 + vec2f(13.0, 7.0)) - vec2f(0.5);
    let w10 = skyPointHash2(i + vec2f(1.0, 0.0) + salt * 0.31 + vec2f(13.0, 7.0)) - vec2f(0.5);
    let w01 = skyPointHash2(i + vec2f(0.0, 1.0) + salt * 0.31 + vec2f(13.0, 7.0)) - vec2f(0.5);
    let w11 = skyPointHash2(i + vec2f(1.0, 1.0) + salt * 0.31 + vec2f(13.0, 7.0)) - vec2f(0.5);
    let warp = mix(mix(w00, w10, f.x), mix(w01, w11, f.x), f.y);
    return gridPosIn + warp * mix(0.22, 0.48, irregularity) + salt * 0.00001;
}

fn skyStaggeredCellCenter(cell: vec2f) -> vec2f {
    let brickX = step(1.0, fract(cell.y * 0.5) * 2.0) * 0.5;
    return cell + vec2f(0.5 + brickX, 0.5);
}

fn skyCellCenterJitter(hashCell: vec2f, salt: vec2f, irr: f32) -> vec2f {
    let rnd2 = skyPointHash2(hashCell + salt * 0.07 + vec2f(41.0, 73.0));
    return (rnd2 - vec2f(0.5)) * mix(0.32, 0.50, irr);
}

fn skyPointBaseCell(gridPos: vec2f) -> vec2f {
    return floor(gridPos);
}

fn skyPointillismShapeUVSky(q: vec2f, cellRx: f32) -> vec2f {
    let invR = 1.0 / max(cellRx, 0.001);
    let uv = q * invR;
    var lenT = skyPointStrokeT(uniform.uPointillismStrokeLength, SKY_STROKE_LEN_MIN, SKY_STROKE_LEN_MAX) * 0.08;
    var widT = skyPointStrokeT(uniform.uPointillismStrokeWidth, SKY_STROKE_WID_MIN, SKY_STROKE_WID_MAX);
    var lenAxis = 1.0 + mix(0.02, 0.82, lenT);
    var widAxis = mix(1.16, 0.52, widT);
    widAxis *= mix(0.90, 1.10, clamp(uniform.uPointillismBrushAspect, 0.5, 1.2));
    lenAxis = mix(lenAxis, 1.0, 0.94);
    widAxis = mix(widAxis, 1.0, 0.94);
    let SKY_STROKE_ASPECT_CAP = 1.04;
    lenAxis = max(lenAxis, widAxis / SKY_STROKE_ASPECT_CAP);
    widAxis = max(widAxis, lenAxis / SKY_STROKE_ASPECT_CAP);
    return vec2f(uv.x / lenAxis, uv.y * widAxis);
}

fn skyPointValueNoise(p: vec2f) -> f32 {
    let i = floor(p);
    var f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    let a = skyPointHash(i);
    let b = skyPointHash(i + vec2f(1.0, 0.0));
    let c = skyPointHash(i + vec2f(0.0, 1.0));
    let d = skyPointHash(i + vec2f(1.0, 1.0));
    return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

fn skyPointFbm3(p: vec2f) -> f32 {
    var v = 0.0;
    v += 0.5 * skyPointValueNoise(p);
    v += 0.25 * skyPointValueNoise(p * 2.1 + vec2f(1.7, 9.2));
    v += 0.125 * skyPointValueNoise(p * 4.2 + vec2f(8.3, 2.8));
    return v / 0.875;
}

fn skyPointPigmentDaub(shapeUV: vec2f, A: f32, hashCell: vec2f) -> vec4f {
    let SKY_PAINT_GRAIN_SCALE = 0.38;
    let grain = clamp(uniform.uPointillismPaintGrain, 0.0, 1.0) * SKY_PAINT_GRAIN_SCALE;
    if (grain < 0.001) {
        return vec4f(1.0);
    }
    let strokeSeed = hashCell * 13.7 + vec2f(skyPointHash(hashCell + 19.0), skyPointHash(hashCell + 37.0)) * 9.3 + uniform.uPointillismSeed * 0.07;
    let p = shapeUV * mix(3.2, 8.0, grain) + strokeSeed;
    let coarse = skyPointFbm3(p);
    let fine = skyPointValueNoise(p * 11.0 + vec2f(strokeSeed.y, strokeSeed.x));
    let streak = skyPointValueNoise(shapeUV * 2.0 + vec2f(strokeSeed.x, strokeSeed.y));
    let pigment = coarse * 0.50 + fine * 0.38 + streak * 0.06;
    let edgeFade = 1.0 - smoothstep(mix(0.48, 0.80, grain), 0.96, A);
    let g = (pigment - 0.5) * grain * edgeFade * 1.18;
    let luma = 1.0 + g * 0.54;
    let alpha = 1.0 + g * 0.66;
    let warm = g * 0.11;
    return vec4f(luma + warm, luma, luma - warm * 0.58, alpha);
}

fn skyPointStrokeShapeAt(d: vec3f, gridPos: vec2f, cell: vec2f, salt: vec2f, rxCellScale: f32, irr: f32, angularSpacing: f32) -> vec3f {
    let center = skyStaggeredCellCenter(cell) + skyCellCenterJitter(cell, salt, irr);
    let cellDir = skyCellDirFromGrid(center, angularSpacing);
    let sizeVar = mix(0.82, 1.18, skyPointHash(cell + 51.0));
    let cellRx = rxCellScale * sizeVar;
    let angularR = skyCellAngularRadius(cellRx, angularSpacing);

    let tc = skyCellTangentCoords(d, cellDir);
    let tu = tc.x;
    let tv = tc.y;
    let cosA = tc.z;

    var angle = skyPointHash(cell + 103.0) * 6.2831853 + uniform.uPointillismSeed * 0.13;
    angle += (skyPointHash(cell + 127.0) - 0.5) * mix(0.14, 0.24, irr);
    let c = cos(angle);
    let s = sin(angle);
    let q = vec2f(c * tu - s * tv, s * tu + c * tv) / angularR * cellRx;
    let shapeUV = skyPointillismShapeUVSky(q, cellRx);

    let ang = acos(clamp(cosA, -1.0, 1.0));
    let A = (ang / angularR) * (ang / angularR);
    return vec3f(shapeUV.x, shapeUV.y, A);
}

fn skyPointillismRadialMask(shapeUV: vec2f) -> f32 {
    let A = dot(shapeUV, shapeUV);
    let hard = clamp(uniform.uPointillismBrushHardness, 0.0, 1.0);
    let coreEnd = mix(0.52, 0.82, hard);
    let aa = max(fwidth(A) * 1.72, 0.0045);
    return 1.0 - smoothstep(coreEnd - aa, 1.0 + aa * 0.5, A);
}

fn skyPointillismLayerClean(layer: f32) -> f32 {
    let l = clamp(layer, 0.0, 1.0);
    return mix(l, 1.0 - pow(1.0 - l, 2.4), 0.92);
}

fn skyDaubMaskAtCell(d: vec3f, gridPos: vec2f, cell: vec2f, hashCell: vec2f, salt: vec2f, rxCellScale: f32, irr: f32, angularSpacing: f32) -> f32 {
    let center = skyStaggeredCellCenter(cell) + skyCellCenterJitter(hashCell, salt, irr);
    let cellDir = skyCellDirFromGrid(center, angularSpacing);
    let sizeVar = mix(0.82, 1.18, skyPointHash(hashCell + 51.0));
    let cellRx = rxCellScale * sizeVar;
    let angularR = skyCellAngularRadius(cellRx, angularSpacing);

    let tc = skyCellTangentCoords(d, cellDir);
    return skyAngularRadialMask(tc.z, angularR);
}

fn skyEvaluatePointillismLayer(d: vec3f, gridPosIn: vec2f, salt: vec2f, rxCellScale: f32, angularSpacing: f32) -> vec3f {
    let irr = skyPointIrregularity();
    let gridPos = skyPointSmoothMacroWarp(gridPosIn, salt, irr);
    let baseCell = skyPointBaseCell(gridPos);

    var hardMax = 0.0;
    var softAcc = 0.0;
    var dominantCell = baseCell;
    for (var oy = -2; oy <= 2; oy++) {
        for (var ox = -2; ox <= 2; ox++) {
            let cell = baseCell + vec2f(f32(ox), f32(oy));
            let m = skyDaubMaskAtCell(d, gridPos, cell, cell, salt, rxCellScale, irr, angularSpacing);
            softAcc += m * m;
            if (m > hardMax) {
                hardMax = m;
                dominantCell = cell;
            }
        }
    }
    let softLayer = 1.0 - exp(-softAcc * 1.02);
    return vec3f(mix(softLayer, hardMax, 0.04), dominantCell.x, dominantCell.y);
}

fn skyPointApplyContrast(color: vec3f, levelRange: f32) -> vec3f {
    let t = clamp((levelRange - 0.5) / 1.5, 0.0, 1.0);
    let contrast = mix(0.38, 2.45, t);
    let l = skyPointLuma(color);
    return clamp(mix(vec3f(l), color, contrast), vec3f(0.0), vec3f(1.0));
}

fn skyPointHueNudge(c: vec3f, warmCool: f32, pick: f32) -> vec3f {
    let warm = c * vec3f(1.24, 1.08, 0.76) + vec3f(0.07, 0.025, 0.0);
    let cool = c * vec3f(0.76, 0.86, 1.24) + vec3f(0.01, 0.025, 0.07);
    let t = smoothstep(0.22, 0.78, pick);
    return mix(c, mix(cool, warm, t), warmCool);
}

fn skyPointRgb2Hsv(c: vec3f) -> vec3f {
    let mx = max(c.r, max(c.g, c.b));
    let mn = min(c.r, min(c.g, c.b));
    let d = mx - mn;
    var h: f32 = 0.0;
    if (d > 1e-5) {
        if (mx == c.r) {
            h = fract((c.g - c.b) / d / 6.0);
        } else if (mx == c.g) {
            h = ((c.b - c.r) / d + 2.0) / 6.0;
        } else {
            h = ((c.r - c.g) / d + 4.0) / 6.0;
        }
    }
    let s = select(0.0, d / mx, mx > 1e-5);
    return vec3f(h, s, mx);
}

fn skyPointHsv2Rgb(hsv: vec3f) -> vec3f {
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

fn skyPointBaseFamilyDot(base: vec3f, rnd: vec3f) -> vec3f {
    var hsv = skyPointRgb2Hsv(clamp(base, vec3f(0.0), vec3f(1.0)));
    hsv.x = fract(hsv.x + (rnd.x - 0.5) * 0.06);
    hsv.y = clamp(hsv.y * mix(0.90, 1.10, rnd.y), 0.0, 1.0);
    hsv.z = clamp(hsv.z * mix(0.92, 1.08, rnd.z), 0.12, 0.98);
    return skyPointHsv2Rgb(hsv);
}

fn skyPointContrastFamilyDot(base: vec3f, rnd: vec3f, strongFlag: f32) -> vec3f {
    var hsv = skyPointRgb2Hsv(clamp(base, vec3f(0.0), vec3f(1.0)));
    let hueDelta = mix(0.055, 0.028, strongFlag);
    hsv.x = fract(hsv.x + 0.5 + (rnd.x - 0.5) * 2.0 * hueDelta);
    hsv.y = clamp(hsv.y * mix(0.80, 1.0, rnd.y), 0.35, 1.0);
    hsv.z = clamp(hsv.z * mix(0.80, 1.0, rnd.z), 0.12, 0.96);
    let contrast = skyPointHsv2Rgb(hsv);
    let mixLo = mix(0.20, 0.10, strongFlag);
    let mixHi = mix(0.50, 0.25, strongFlag);
    let mixT = mix(mixLo, mixHi, rnd.y);
    return mix(contrast, base, mixT);
}

fn skyPointClampComplementDot(c: vec3f) -> vec3f {
    let l = skyPointLuma(c);
    return clamp(c, vec3f(max(0.05, l * 0.52)), vec3f(0.99, 0.98, 0.94));
}

fn skyPointClampPigment(c: vec3f) -> vec3f {
    let l = skyPointLuma(c);
    let softFloor = vec3f(max(0.04, l * 0.72));
    return clamp(c, softFloor, vec3f(0.97, 0.97, 0.94));
}

fn skyPointHash3(cell: vec2f) -> vec3f {
    return vec3f(
        skyPointHash(cell + vec2f(0.0)),
        skyPointHash(cell + vec2f(17.0)),
        skyPointHash(cell + vec2f(31.0))
    );
}

fn skyPointApplyWarmCool(color: vec3f, luma: f32, rnd: vec3f) -> vec3f {
    let splitT = clamp(uniform.uPointillismWarmCoolSplit, 0.0, 1.0);
    if (splitT < 0.001) {
        return color;
    }
    let warm = vec3f(1.0, 0.67, 0.22);
    let cool = vec3f(0.12, 0.46, 1.0);
    let lightSide = smoothstep(0.35, 0.88, luma);
    let split = mix(cool, warm, lightSide);
    return mix(color, split, splitT * mix(0.14, 0.48, rnd.x));
}

fn skyPointStyleNorm(base: vec3f, cell: vec2f, lumaIn: f32) -> vec3f {
    let rnd = skyPointHash3(cell + vec2f(6.4));
    let colorVib = clamp(uniform.uPointillismColorVibration, 0.0, 1.0);
    var luma = max(lumaIn, 0.001);

    var chroma = skyPointSaturate(base, max(0.0, uniform.uPointillismSaturation) + colorVib * 0.35);
    chroma = skyPointApplyContrast(chroma, clamp(uniform.uPointillismLevelRange, 0.5, 2.0));
    let warmPick = smoothstep(0.38, 0.68, luma);
    chroma = skyPointHueNudge(
        chroma,
        clamp(uniform.uPointillismWarmCoolSplit + colorVib * 0.12, 0.0, 1.0),
        warmPick
    );

    let dotMix = clamp(uniform.uPointillismContrastDotMix, 0.0, 0.55);
    let vib = clamp(dotMix / 0.55, 0.0, 1.0);
    let strongRate = vib * 0.10;
    let softRate = vib * 0.20;
    let tierR = rnd.z;

    var styled: vec3f;
    if (tierR < strongRate) {
        styled = skyPointClampComplementDot(skyPointContrastFamilyDot(chroma, rnd, 1.0));
    } else if (tierR < strongRate + softRate) {
        styled = skyPointClampComplementDot(skyPointContrastFamilyDot(chroma, rnd, 0.0));
    } else {
        styled = skyPointClampPigment(skyPointBaseFamilyDot(chroma, rnd));
    }
    return skyPointApplyWarmCool(styled, luma, rnd);
}

fn applySkyboxPointillism(linear: vec3f, dir: vec3f) -> vec3f {
    let strength = clamp(uniform.uSkyboxPointillismStrength, 0.0, 1.0);
    if (strength < 0.001) {
        return linear;
    }

    let d = normalize(dir);
    let t = strength;
    let angularSpacing = max(uniform.uSkyboxAngularSpacing, 1e-6);
    let rxCellScale = clamp(uniform.uSkyboxRxCellScale, 0.50, 0.80);

    let salt1 = vec2f(0.0, 0.0);
    let gridPos = skyPointGridPosFromDir(d, angularSpacing);

    var evalPrimary = skyEvaluatePointillismLayer(d, gridPos, salt1, rxCellScale, angularSpacing);
    var layer = evalPrimary.x;
    let dominantCell = evalPrimary.yz;

    let base1 = skyPointSample(d);
    var daubColor = skyPointStyleNorm(base1, dominantCell, skyPointLuma(base1));

    let irr = skyPointIrregularity();
    let gridPosW = skyPointSmoothMacroWarp(gridPos, salt1, irr);
    let strokeShape = skyPointStrokeShapeAt(d, gridPosW, dominantCell, salt1, rxCellScale, irr, angularSpacing);
    let pigment = skyPointPigmentDaub(strokeShape.xy, strokeShape.z, dominantCell);
    daubColor *= pigment.rgb;
    let grainT = clamp(uniform.uPointillismPaintGrain, 0.0, 1.0) * 0.38;
    layer *= mix(1.0, pigment.a, grainT);
    layer = skyPointillismLayerClean(layer);

    let gapL = skyPointLuma(linear);
    let paperBase = mix(
        vec3f(gapL) * vec3f(0.93, 0.96, 1.0),
        vec3f(0.98, 0.96, 0.90),
        mix(0.24, 0.52, t)
    ) * uniform.uPointillismPaperTint;
    let SKY_GAP_STYLE = 0.44;
    let SKY_GAP_PAPER = 0.20;
    let gapThin = 1.0 - layer;
    let gapSky = mix(linear, daubColor, SKY_GAP_STYLE * (0.55 + 0.45 * gapThin));
    let gapPaper = clamp(uniform.uPointillismPaperStrength, 0.0, 1.0) * gapThin * SKY_GAP_PAPER;
    let gapColor = mix(gapSky, paperBase, gapPaper);

    let cover = max(layer, 0.07);
    let result = clamp(mix(gapColor, daubColor, cover), vec3f(0.0), vec3f(1.0));
    return mix(linear, result, strength);
}
`;

export const patchSkyboxPointillismGlsl = (source: string): string => {
    if (source.includes('SKY_GAP_STYLE = 0.44') && source.includes('max(layer, 0.07)')) {
        return source;
    }
    const withInsert = patchChunk(
        source,
        'void main(void) {',
        `${skyboxPointillismGlsl}\n\tvoid main(void) {`,
        'glsl skyboxPS pointillism insert'
    );
    return patchChunk(
        withInsert,
        'if (any(greaterThanEqual(linear, vec3(64.0)))) {',
        'linear = applySkyboxPointillism(linear, dir);\n\t\t\tif (any(greaterThanEqual(linear, vec3(64.0)))) {',
        'glsl skyboxPS pointillism apply'
    );
};

export const patchSkyboxPointillismWgsl = (source: string): string => {
    if (source.includes('SKY_GAP_STYLE = 0.44') && source.includes('max(layer, 0.07)')) {
        return source;
    }
    const withInsert = patchChunk(
        source,
        '@fragment',
        `${skyboxPointillismWgsl}\n\t@fragment`,
        'wgsl skyboxPS pointillism insert'
    );
    return patchChunk(
        withInsert,
        'if (any(linear >= vec3f(64.0))) {',
        'linear = applySkyboxPointillism(linear, dir);\n\t\t\tif (any(linear >= vec3f(64.0))) {',
        'wgsl skyboxPS pointillism apply'
    );
};

export type SkyboxPsBuildOptions = {
    gammaOverride: boolean;
    pointillism: boolean;
};

export const buildSkyboxPsChunk = (
    base: string,
    lang: 'glsl' | 'wgsl',
    options: SkyboxPsBuildOptions
): string => {
    let chunk = base;
    if (options.pointillism) {
        chunk = lang === 'glsl' ? patchSkyboxPointillismGlsl(chunk) : patchSkyboxPointillismWgsl(chunk);
    }
    if (options.gammaOverride) {
        chunk = patchChunk(
            chunk,
            'gammaCorrectOutput(toneMap(processEnvironment(linear)))',
            lang === 'glsl'
                ? 'pow(toneMap(processEnvironment(linear)) + 0.0000001, vec3(1.0 / 2.2))'
                : 'pow(toneMap(processEnvironment(linear)) + 0.0000001, vec3f(1.0 / 2.2))',
            `${lang} skyboxPS gamma override`
        );
    }
    return chunk;
};
