import { Color, Vec3 } from 'playcanvas';

/**
 * 一次性 reveal 的 **`settings.effects.reveal` → `effectParams`** 白名单与写入逻辑。
 *
 * - 协议：`EFFECT_PARAMS_PATCH` 的 `params.effectParams`（扁平 `key → value`）。
 * - 仅当 `key` 落在当前 `type` 对应集合内时才写入脚本；其余键静默忽略。
 * - **颜色**（`dotTint` / `waveTint` / `fallTint` / `hitTint` / **`phase1CloudTint` / `phase2HaloTint`**（growth-wave））：`[r, g, b]` 数值数组，写入 `Color`。
 * - **方向**（`scatterDirection`）：`[x, y, z]`，写入 `Vec3`。
 * - **纸张色**（`paperTint`）：`[r, g, b]`，写入脚本上的 `number[]`。
 * - **布尔**：`useCameraDistance`、`pointSizeScaleByScene`。
 * - **数值**：其余键需为有限 `number`，且脚本上须已存在该属性名（含各特效 **`endRadius`** / smooth 的 **`maxRadius`** 等空间尺度专参）。
 *
 * 各字段语义以对应 **`Gsplat*`** 脚本类上的 `@attribute` 与 shader uniform 为准；下列注释为便于宿主联调的摘要。
 */

// --- radial：`GsplatRevealRadial` -------------------------------------------------
// `totalDuration` 约束抬升波抵达 `endRadius`：`RevealController.applyRadialRevealTotalDurationConstraint` 在 **`applyRevealEffectParamsToScript` 之后**反算 speed（rain/smooth 未接此逻辑）。

/** 径向点阵 reveal：中心外扩波 + 抬升波；初始 `endRadius` 由 create 内 `applyAdaptiveEndRadius` 决定，可用 **`effectParams.endRadius`** 覆盖。 */
const RADIAL = new Set([
    'speed', // 外圈点阵波沿径向推进的速度系数（与 shader 中 uSpeed 一致）
    'acceleration', // 点阵波加速度（uAcceleration）
    'delay', // 抬升波相对点阵波延迟启动时间（秒，uDelay）
    'endRadius', // 抬升波外沿（世界单位，uEndRadius）；在自适应半径之后写入，可覆盖默认值
    'oscillationIntensity', // 抬升阶段振荡强度（0–1 量级，uOscillationIntensity）
    'dotTint', // 点阵阶段 tint，Color，JSON 为 [r,g,b]
    'waveTint' // 抬升/波前 tint，Color，JSON 为 [r,g,b]
]);

// --- rain（经典雨）：`GsplatRevealRain` -------------------------------------------

/** 自上而下「雨滴」落点 + 触地高亮；初始 `endRadius` 由 create 内自适应半径决定，可用 **`effectParams.endRadius`** 覆盖。 */
const RAIN = new Set([
    'distance', // 雨滴生成平面与中心的大致距离尺度
    'endRadius', // 雨区 xz 外沿（世界单位，uEndRadius）
    'speed', // 下落速度
    'acceleration', // 竖直下落加速度
    'flightTime', // 单滴飞行时间（秒），影响触地节奏
    'rainSize', // 雨点大小（屏幕/世界尺度相关）
    'rotation', // 下落过程旋转量（0–1 为「整圈」比例类语义，见脚本）
    'fallTintIntensity', // 下落段 tint 强度
    'hitDuration', // 触地高亮持续时间（秒）
    'fallTint', // 下落 tint，Color → [r,g,b]
    'hitTint' // 触地闪色，Color → [r,g,b]
]);

// --- rain-v2：`GsplatRainV2` ------------------------------------------------------

/**
 * 简化雨：自 `bottomY` 向上「长」回 splat 原位；完成条件与 `timeScale`、`maxDist2D` 强相关。
 * 若改 `bottomY`/`rainHeight`/`maxDist2D`，需理解其与 `RevealController` 内 bbox 初始化可能叠加。
 */
const RAIN_V2 = new Set([
    'intensity', // 整体强度 0–1（uIntensity）
    'hitDuration', // 落位后红色淡出时长（秒）
    'hitTint', // 落位闪色 [r,g,b]
    'bottomY', // 雨层起始世界 Y（通常低于场景）
    'rainHeight', // 雨层厚度（世界单位）
    'maxDist2D', // xz 平面最远影响距离；与 `totalDuration` 推导的 timeScale 共同决定节奏
    'timeScale' // effectTime 缩放；若不设则由 `totalDuration` 与几何在 create 时反算
]);

// --- smooth：`GsplatRevealSmooth` -------------------------------------------------

/** 平滑球形 reveal；默认 `maxRadius` 见类定义，可用 **`effectParams.maxRadius`** 覆盖（脚本字段名非 endRadius）。 */
const SMOOTH = new Set([
    'maxRadius', // 球形渐显外半径（世界单位）
    'fadeWidthRatio', // 过渡带宽度占半径比例
    'transitionEffect', // 过渡曲线/形态枚举（脚本内语义）
    'growthSpeed' // 可见性向内/向外增长速度
]);

// --- pieces-recover：`GsplatRevealPiecesRecover` ---------------------------------

/** 碎片飞散再收回；时间与 `totalDuration` 在 create 时按比例缩放；**`effectParams.endRadius`** 可覆盖波前外沿（uEndRadius）。 */
const PIECES_RECOVER = new Set([
    'scatterDistance', // 单点飞散位移幅度（世界单位）
    'endRadius', // 收回波前最大半径（世界单位，uEndRadius）
    'scatterDuration', // 飞散段时长（秒）
    'holdDuration', // 飞散后保持/悬停（秒）
    'recoverDuration', // 收回段时长（秒）
    'noiseIntensity', // 飞散噪声强度
    'scatterDirection', // 主飞散方向 Vec3，JSON [x,y,z]
    'maxScatterRadius', // 飞散位移上限半径
    'waveSpeed', // 波前推进速度（与距离场相关）
    'springStiffness', // 收回弹性（越大越快回弹）
    'waveSpeedDistScale', // 波速随距离修正系数
    'pointSize', // 飞散点渲染尺度
    'pointSizeScaleByScene', // 是否按场景尺度自动放大点（boolean）
    'scatterIntensity', // 飞散阶段视觉强度
    'tangentTwist', // 切向扭转量
    'radialExpand', // 径向膨胀附加量
    'smokeDrift' // 烟状漂移量
]);

// --- integrate：`GsplatIntegrate` -----------------------------------------------

/** 竖向波前「融合」显现；`verticalSpread` 常由 `totalDuration` 与 bbox 高度在 create 时反算，也可直接覆盖。 */
const INTEGRATE = new Set([
    'intensity', // 整体亮度/对比权重
    'speed', // 竖向推进主速度（与 wave 相位相关）
    'waveSpeed', // 波前调制速度
    'waveFrequency' // 波前空间频率
]);

// --- growth-wave：`GsplatRevealGrowthWave` ---------------------------------------

/**
 * 两阶段：自下而上生长（点云）+ 光圈向外复原。
 * `endRadius` 由 create 时默认与 `applyAdaptiveEndRadius`（bbox 下限）决定；**Phase2 `recoverDuration` 与 `totalDuration` 对齐**（见 `RevealController.createGrowthWaveScript`）；`verticalSpread` 与 Phase1 目标时长相关。
 */
const GROWTH_WAVE = new Set([
    'growthSpeed', // Phase1 竖向生长速度
    'growthDuration', // 单点生长动画时长（秒）
    'recoverDuration', // Phase2：`createGrowthWaveScript` 内为 max(0.5, totalDuration − Phase1 结束)；Phase1 超预算时提高 growthSpeed 压缩；`effectParams` 仍可覆盖；类默认 5；@range [0.5,20]
    'noiseIntensity', // 生长/复原噪声
    'scatterDistance', // 生长阶段最大散射位移
    'minSize', // 兼容字段，点云阶段主要见 `pointSize`
    'pointSize', // 点云 splat 尺寸（世界单位）
    'pointSizeAdaptiveScale', // 远处点放大倍数（0–10）
    'minScreenPointPx', // 屏幕可见像素地板
    'screenFloorMaxScale', // 视距地板对 pointSize 的最大放大
    'densityAnchorMin', // 场景密度归一化低端锚点
    'densityAnchorMax', // 场景密度归一化高端锚点
    'densityInfluence', // 密度补偿强度
    'endRadius', // Phase2 光圈最大半径（世界单位，uEndRadius）；可与 create 默认 + 自适应叠加理解，写入在后者之后
    'bottomY', // 生长起始世界 Y（与 integrate 约定：大 Y 为视觉「底」）
    'topY', // 生长上界世界 Y
    'edgeAreaMin', // 已弃用边缘过滤，保留兼容
    'edgeAreaMax',
    'edgeAnisoMin',
    'verticalSpread', // 竖向波前 spread；不设则由内建公式与 totalDuration 推导
    'phase1CloudTint', // Phase1 点云/蓝辉 additive，Color → [r,g,b]；默认 (0.18,0.45,1)
    'phase2HaloTint' // Phase2 金环 additive，Color → [r,g,b]；默认 (1,0.82,0.52)
]);

// --- sketch：`GsplatSketch` --------------------------------------------------------

/**
 * 素描 → 上色 reveal；`waveSpeed`/`sketchDuration`/`colorizeDuration` 常与 `totalDuration`、默认 `endRadius` 在 create 中联立反算；可用 **`effectParams.endRadius`** 等单独覆盖。
 * `useCameraDistance`：传播距离是否用 xz 到 `uCenter`（与 rain-v2 对齐）而非相机 eye。
 */
const SKETCH = new Set([
    'waveSpeed', // 素描波前径向扩展速度
    'endRadius', // 素描+上色波前外沿（世界单位，uEndRadius）
    'sketchDuration', // 素描阶段时长（秒）
    'colorizeDuration', // 上色阶段时长（秒）
    'fadeWidthRatio', // 波前过渡带宽度 / 半径比
    'sketchIntensity', // 素描线浓度
    'sketchContrast', // 素描对比度
    'draftFeel', // 草图感 / 未完成感混合
    'shadeLevels', // 量化明暗层数
    'hatchDensity', // 排线密度
    'hatchStrength', // 排线强度
    'paperTintAmount', // 画纸底色混合量
    'paperTint', // 画纸色 [r,g,b] → 脚本 `number[3]`
    'grainFreq', // 颗粒噪声频率
    'grainAmp', // 颗粒振幅
    'colorizeSharpness', // 上色边缘锐度
    'colorizeSpread', // 上色扩散
    'colorizeDensity', // 上色密度
    'colorizeAlphaGrain', // 上色 Alpha 颗粒
    'useCameraDistance' // boolean：是否用相机距离模式（见类注释）
]);

/** `settings.effects.reveal.type` 字符串 → 允许出现在 `effectParams` 内的键集合 */
const BY_TYPE: Record<string, ReadonlySet<string>> = {
    'radial': RADIAL,
    'rain': RAIN,
    'rain-v2': RAIN_V2,
    'smooth': SMOOTH,
    'pieces-recover': PIECES_RECOVER,
    'integrate': INTEGRATE,
    'growth-wave': GROWTH_WAVE,
    'sketch': SKETCH
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

        if (
            rawKey === 'dotTint' ||
            rawKey === 'waveTint' ||
            rawKey === 'fallTint' ||
            rawKey === 'hitTint' ||
            rawKey === 'phase1CloudTint' ||
            rawKey === 'phase2HaloTint'
        ) {
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
