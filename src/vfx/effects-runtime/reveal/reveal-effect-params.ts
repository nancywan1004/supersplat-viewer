import { Color, Vec3 } from 'playcanvas';

/**
 * 一次性 reveal 的 **`settings.effects.reveal` → `effectParams`** 白名单与写入逻辑。
 *
 * - 协议：`EFFECT_PARAMS_PATCH` 的 `params.effectParams`（扁平 `key → value`）。
 * - 仅当 `key` 落在当前 `type` 对应集合内时才写入脚本；其余键静默忽略。
 * - **颜色**（`dotTint` / `waveTint` / `fallTint` / `hitTint`）：`[r, g, b]` 数值数组，写入 `Color`。
 * - **方向**（`scatterDirection`）：`[x, y, z]`，写入 `Vec3`。
 * - **纸张色**（`paperTint`）：`[r, g, b]`，写入脚本上的 `number[]`。
 * - **布尔**：`useCameraDistance`、`pointSizeScaleByScene`。
 * - **数值**：其余键需为有限 `number`，且脚本上须已存在该属性名（含各特效 **`endRadius`** / smooth 的 **`maxRadius`** 等空间尺度专参）。
 *
 * 各字段语义以对应 **`Gsplat*`** 脚本类上的 `@attribute` 与 shader uniform 为准；下列注释为便于宿主联调的摘要（**类默认** / **create 初值** / **`@range`**）。
 *
 * **radial 与 `totalDuration`**：`RevealController.applyRadialRevealTotalDurationConstraint` 在 **`applyRevealEffectParamsToScript` 之后**反算 `speed`（rain / smooth 未接同逻辑）。
 */

// --- radial：`GsplatRevealRadial`；create 初值见 `RevealController.createRadialScript`，`speed` 可被 `applyRadialRevealTotalDurationConstraint` 再改 ---
const RADIAL = new Set([
    'speed', // 类 1，create 5；@range [0,10]；uSpeed
    'acceleration', // 类 5，create 0；@range [0,5]
    'delay', // 类 2，create 0.5；@range [0,10]；抬升波相对点阵延迟（秒）
    'endRadius', // 类 25 + `applyAdaptiveEndRadius`；@range [0,500]
    'oscillationIntensity', // 类 0.1，create 0.2；@range [0,1]
    'dotTint', // Color [r,g,b]；类/ create (0,1,1)
    'waveTint' // Color；类 (5,0,0)，create (1,0.5,0)
]);

// --- rain：`GsplatRevealRain`；create 见 `createRainScript` ---
const RAIN = new Set([
    'distance', // 默认 30（create）；@range [0,50]
    'endRadius', // 类 25 + 自适应；@range [0,500]
    'speed', // 类 2，create 3；@range [0,10]
    'acceleration', // 默认 0；@range [0,5]
    'flightTime', // 默认 2；@range [0.1,5]
    'rainSize', // 默认 0.015；@range [0,0.1]
    'rotation', // 默认 0.9；@range [0,2]（整圈比例语义见脚本）
    'fallTintIntensity', // 默认 0.2；@range [0,1]
    'hitDuration', // 默认 0.5；@range [0,2]
    'fallTint', // Color；(0,1,1) create
    'hitTint' // Color；(2,0,0) create
]);

// --- rain-v2：`GsplatRainV2`；`bottomY`/`rainHeight`/`maxDist2D` 常由 bbox 与 `createRainV2Script` 写入；`timeScale` 由 `totalDuration` 反算 ---
const RAIN_V2 = new Set([
    'intensity', // 默认 1；@range [0,1]
    'hitDuration', // 类 2；@range [0,5]（create 未改）
    'hitTint', // Color；(2,0,0) 类默认
    'bottomY', // 类 -10；create 多来自 bbox
    'rainHeight', // 类 15；create 多来自 bbox
    'maxDist2D', // 类 10；create 多来自 bbox xz
    'timeScale' // 类 1；create 由 totalDuration 与完成时间反算
]);

// --- smooth：`GsplatRevealSmooth`；create 仅 center/enabled，余为类默认 ---
const SMOOTH = new Set([
    'maxRadius', // 默认 50；@range [0,500]
    'fadeWidthRatio', // 默认 0.1；@range [0,1]
    'transitionEffect', // 默认 1；@range [1,4]（曲线/形态枚举）
    'growthSpeed' // 默认 5；@range [0,50]；半径增长（单位/秒）
]);

// --- pieces-recover：`GsplatRevealPiecesRecover`；create 按 `totalDuration` 缩放多段时长，见 `createPiecesRecoverScript` ---
const PIECES_RECOVER = new Set([
    'scatterDistance', // 类 6，create 常 4；@range [0,50]
    'endRadius', // 类 25 + 自适应；@range [0,500]
    'scatterDuration', // 类 6，create scaled；@range [0.1,20]
    'holdDuration', // 类 0；@range [0,5]
    'recoverDuration', // 类 10，create scaled；@range [0.5,20]
    'noiseIntensity', // 类 0.8，create 0.3；@range [0,2]
    'scatterDirection', // Vec3 [x,y,z]；create (1,1,1)
    'maxScatterRadius', // 类 5，create 4；@range [0,50]
    'waveSpeed', // 类 6，create scaled；@range [0.1,100]
    'springStiffness', // 默认 5；@range [0,10]
    'waveSpeedDistScale', // 默认 0.02；@range [0,0.2]
    'pointSize', // 默认 0.01；@range [0.001,0.5]
    'pointSizeScaleByScene', // boolean；类 true
    'scatterIntensity', // 类默认 1.8（超出脚本标注 @range [0,1] 的上限，以运行类为准）；create 未改
    'tangentTwist', // 默认 0.2；@range [0,1]
    'radialExpand', // 默认 0；@range [0,1]
    'smokeDrift' // 默认 0.5；@range [0,1]
]);

// --- integrate：`GsplatIntegrate`；`verticalSpread` 常由 totalDuration 与高度在 create 中反算 ---
const INTEGRATE = new Set([
    'intensity', // 默认 0.5；@range [0,1]
    'speed', // 默认 0.8；@range [0,1]（脚本注释：传播速度）
    'waveSpeed', // 默认 1；@range [0,5]
    'waveFrequency' // 默认 3；@range [0,10]
]);

// --- growth-wave：`GsplatRevealGrowthWave`；create 覆写 growthSpeed/growthDuration/noiseIntensity 等，见 `createGrowthWaveScript` ---
const GROWTH_WAVE = new Set([
    'growthSpeed', // 类 5；create 乘 scale 使 Phase1 约 7s，见 `createGrowthWaveScript`；@range [0.1,50]
    'growthDuration', // 类 7，create 缩放；@range [0.5,20]
    'recoverDuration', // 类 5，create 固定 7；@range [0.5,20]
    'noiseIntensity', // 类 0.8，create 2.8；@range [0,2]
    'scatterDistance', // 类 4；@range [0,50]
    'minSize', // 已弃用，类 0.05；create 0.15；@range [0.01,1]
    'pointSize', // 类 0.006；@range [0.001,0.5]
    'pointSizeAdaptiveScale', // 类 5；@range [0,10]
    'minScreenPointPx', // 类 1.25；@range [0.5,4]
    'screenFloorMaxScale', // 类 1.9；@range [1,4]
    'densityAnchorMin', // 类 35；@range [10,5000]
    'densityAnchorMax', // 类 18000；@range [1000,1000000]
    'densityInfluence', // 类 2.4；@range [0.5,4]
    'endRadius', // 类 50 + 自适应；@range [0,500]
    'bottomY', // 类 -10；create 多来自 bbox
    'topY', // 类 10；create 多来自 bbox
    'edgeAreaMin', // 已弃用；@range [0,20]
    'edgeAreaMax', // 已弃用；@range [0,50]
    'edgeAnisoMin', // 已弃用；@range [1,20]
    'verticalSpread' // 可选；未设时 create 用 growthSpeed 与高度反算；@range [0.01,100]
]);

// --- sketch：`GsplatSketch`；create 覆写时长/波速/多项视觉参数，见 `createSketchScript` ---
const SKETCH = new Set([
    'waveSpeed', // 类 10，create 由 endRadius 与剩余时间反算；@range [0.1,100]
    'endRadius', // 类 200 + 自适应；@range [0,1000]
    'sketchDuration', // 类 1.5，create ×scale；@range [0.5,30]
    'colorizeDuration', // 类 5，create ×scale；@range [0.5,30]
    'fadeWidthRatio', // 类 0.1，create 0.18；@range [0,1]
    'sketchIntensity', // 默认 1；@range [0,1]
    'sketchContrast', // 默认 1.2；@range [0.5,3]
    'draftFeel', // 类 1，create 0.65；@range [0,1]
    'shadeLevels', // 默认 5；@range [2,8]
    'hatchDensity', // 类 25，create 8；@range [1,25]
    'hatchStrength', // 类 1，create 0.65；@range [0,1]
    'paperTintAmount', // 类 0.8，create 0.4；@range [0,1]
    'paperTint', // number[3]；create [0.97,0.95,0.90]
    'grainFreq', // 默认 25；@range [5,50]
    'grainAmp', // 默认 0.06；@range [0,0.15]
    'colorizeSharpness', // 类 0.35，create 0.3；@range [0,1]
    'colorizeSpread', // 类 0.2，create 0.08；@range [0,0.2]
    'colorizeDensity', // 类 0.5，create 0.25；@range [0,0.5]
    'colorizeAlphaGrain', // 类 1，create 0.5；@range [0,1]
    'useCameraDistance' // boolean；create true
]);

/** `settings.effects.reveal.type` 字符串 → 允许出现在 `effectParams` 内的键集合 */
const BY_TYPE: Record<string, ReadonlySet<string>> = {
    radial: RADIAL,
    rain: RAIN,
    'rain-v2': RAIN_V2,
    smooth: SMOOTH,
    'pieces-recover': PIECES_RECOVER,
    integrate: INTEGRATE,
    'growth-wave': GROWTH_WAVE,
    sketch: SKETCH
};

/** JSON 数组是否为长度≥3 的有限数字三元组（用于 Color / Vec3 / paperTint） */
function isColorTriple(v: unknown): v is [number, number, number] {
    return Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** 将 `[r,g,b]` 写入脚本上的 `Color` 属性 */
function trySetColor(script: any, key: string, v: unknown): boolean {
    if (!isColorTriple(v)) return false;
    const cur = script[key];
    if (cur instanceof Color) {
        cur.set(v[0], v[1], v[2]);
        return true;
    }
    return false;
}

/** 将 `[x,y,z]` 写入脚本上的 `Vec3` 属性 */
function trySetVec3(script: any, key: string, v: unknown): boolean {
    if (!isColorTriple(v)) return false;
    const cur = script[key];
    if (cur instanceof Vec3) {
        cur.set(v[0], v[1], v[2]);
        return true;
    }
    return false;
}

/** 有限数字写入已存在的数值型脚本字段 */
function trySetNumber(script: any, key: string, v: unknown): boolean {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    if (!(key in script)) return false;
    script[key] = v;
    return true;
}

/** 布尔写入已存在的脚本字段 */
function trySetBoolean(script: any, key: string, v: unknown): boolean {
    if (typeof v !== 'boolean') return false;
    if (!(key in script)) return false;
    script[key] = v;
    return true;
}

/**
 * 将 `effectParams` 中属于当前 `effectType` 白名单的项写入已创建的 reveal 脚本（在 `RevealController` 各 `create*Script` 默认值之后调用）。
 */
export function applyRevealEffectParamsToScript(
    script: any,
    effectType: string,
    effectParams: Record<string, unknown> | undefined | null
): void {
    if (!script || !effectParams || typeof effectParams !== 'object') return;
    const allowed = BY_TYPE[effectType];
    if (!allowed) return;

    for (const [rawKey, rawVal] of Object.entries(effectParams)) {
        if (!allowed.has(rawKey)) continue;
        if (rawVal === undefined) continue;

        if (rawKey === 'dotTint' || rawKey === 'waveTint' || rawKey === 'fallTint' || rawKey === 'hitTint') {
            trySetColor(script, rawKey, rawVal);
            continue;
        }
        if (rawKey === 'scatterDirection') {
            trySetVec3(script, rawKey, rawVal);
            continue;
        }
        if (rawKey === 'paperTint') {
            if (isColorTriple(rawVal) && Array.isArray(script.paperTint)) {
                script.paperTint[0] = rawVal[0];
                script.paperTint[1] = rawVal[1];
                script.paperTint[2] = rawVal[2];
            }
            continue;
        }
        if (rawKey === 'useCameraDistance' || rawKey === 'pointSizeScaleByScene') {
            if (trySetBoolean(script, rawKey, rawVal)) continue;
        }
        trySetNumber(script, rawKey, rawVal);
    }
}
