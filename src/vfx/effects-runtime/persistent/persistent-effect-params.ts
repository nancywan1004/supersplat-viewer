import { Color, Vec3 } from 'playcanvas';

/**
 * 可持续 **persistent** 轨的 **`settings.effects.persistent` → `effectParams`** 白名单与写入逻辑。
 *
 * - 协议：`EFFECT_PARAMS_PATCH`（`effectId === scene.gsplat-persistent`）的 `params.effectParams`（与 reveal 轨同形）。
 * - 仅当 `key` 落在当前 `type` 对应集合内时才写入脚本；其余键静默忽略。
 * - **数值**：有限 `number`，且脚本上须已存在该属性名。
 * - **`center`**：`[x, y, z]` 写入 `Vec3`。
 *
 * 新增 persistent 类型：扩展 **`BY_TYPE`** 与下方 `Set`，并在 **`mountPersistentGsplatByEffectType`** 创建脚本后调用 **`applyPersistentEffectParamsToScript`**。
 */

// --- perlin-wave：`GsplatRevealPerlinWave` ---------------------------------------

const PERLIN_WAVE = new Set([
    'intensity', // 色彩调制强度 0–1
    'waveAmplitude', // Perlin 位移振幅
    'waveFrequency', // 当 wavelength ≤ 0 时用于推导空间频率
    'wavelength', // 波长（世界单位）；>0 时优先于 waveFrequency
    'waveSpeed', // 动画时间速度
    'scaleBlend', // 尺度混合 0–1
    'center' // 效果原点 [x,y,z] → Vec3
]);

const SPARKLE_TWINKLE = new Set([
    'pointSize',
    'sparkleDensity',
    'twinkleSpeed',
    'twinkleMin',
    'twinkleSharpness',
    'brightness',
    'lightTint1',
    'lightTint2',
    'lightTint3',
    'colorBlendMode',
    'center'
]);

const OVERALL_WAVE = new Set([
    'noiseType',
    'waveAmplitude',
    'waveSpeed',
    'wavelength',
    'intensity',
    'crestTint',
    'troughTint',
    'waveDirection',
    'center'
]);

const BUTTERFLY_PARTICLE = new Set([
    'pointSize',
    'twinkleSpeed',
    'twinkleMin',
    'twinkleSharpness',
    'brightness',
    'baseColor',
    'cycleColor1',
    'cycleColor2',
    'colorCycleEnabled',
    'colorCycleSpeed',
    'sparkleTrailStrength',
    'gsLightEnabled',
    'gsLightIntensity',
    'gsLightRange',
    'gsLightColor',
    'center'
]);

const BY_TYPE: Record<string, ReadonlySet<string>> = {
    'perlin-wave': PERLIN_WAVE,
    'sparkle-twinkle': SPARKLE_TWINKLE,
    'overall-wave': OVERALL_WAVE,
    'butterfly-particle': BUTTERFLY_PARTICLE
};

export type PersistentParamFieldKind = 'number' | 'vec3' | 'color' | 'boolean' | 'enum';

/** 当前 persistent `type` 在 param 白名单中的全部键（Set 插入顺序） */
export function getPersistentEffectParamKeys(effectType: string): readonly string[] {
    const set = BY_TYPE[effectType];
    return set ? Array.from(set) : [];
}

const SPARKLE_COLOR_KEYS = new Set(['lightTint1', 'lightTint2', 'lightTint3']);
const BUTTERFLY_COLOR_KEYS = new Set(['baseColor', 'cycleColor1', 'cycleColor2', 'gsLightColor']);

export function getPersistentParamFieldKind(key: string): PersistentParamFieldKind {
    if (key === 'noiseType') return 'enum';
    if (
        key === 'crestTint' ||
        key === 'troughTint' ||
        SPARKLE_COLOR_KEYS.has(key) ||
        BUTTERFLY_COLOR_KEYS.has(key)
    ) {
        return 'color';
    }
    if (key === 'colorBlendMode' || key === 'colorCycleEnabled' || key === 'gsLightEnabled') return 'boolean';
    if (key === 'center' || key === 'waveDirection') return 'vec3';
    return 'number';
}

function isVec3Triple(v: unknown): v is [number, number, number] {
    return Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

function trySetVec3(script: any, key: string, v: unknown): boolean {
    if (!isVec3Triple(v)) return false;
    const cur = script[key];
    if (cur instanceof Vec3) {
        cur.set(v[0], v[1], v[2]);
        return true;
    }
    return false;
}

function isColorTriple(v: unknown): v is [number, number, number] {
    return Array.isArray(v) && v.length >= 3 && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

function trySetColor(script: any, key: string, v: unknown): boolean {
    if (!isColorTriple(v)) return false;
    const cur = script[key];
    if (cur instanceof Color) {
        cur.set(v[0], v[1], v[2]);
        return true;
    }
    return false;
}

function trySetNumber(script: any, key: string, v: unknown): boolean {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    if (!(key in script)) return false;
    script[key] = v;
    return true;
}

function trySetBoolean(script: any, key: string, v: unknown): boolean {
    if (typeof v !== 'boolean') return false;
    if (!(key in script)) return false;
    script[key] = v;
    return true;
}

/** 将 `effectParams` 白名单项写入已挂载脚本（在 create*Script 默认值与 updateScriptCenter 之后调用）。 */
export function applyPersistentEffectParamsToScript(
    script: any,
    effectType: string,
    effectParams: Record<string, unknown> | undefined | null
): void {
    if (!script || !effectParams || typeof effectParams !== 'object') return;
    const allowed = BY_TYPE[effectType];
    if (!allowed) return;

    for (const [rawKey, rawVal] of Object.entries(effectParams)) {
        if (rawVal === undefined) continue;
        if (!allowed.has(rawKey)) continue;
        if (rawKey === 'center' || rawKey === 'waveDirection') {
            trySetVec3(script, rawKey, rawVal);
            continue;
        }
        if (rawKey === 'crestTint' || rawKey === 'troughTint' || BUTTERFLY_COLOR_KEYS.has(rawKey)) {
            trySetColor(script, rawKey, rawVal);
            continue;
        }
        if (SPARKLE_COLOR_KEYS.has(rawKey)) {
            trySetColor(script, rawKey, rawVal);
            continue;
        }
        if (getPersistentParamFieldKind(rawKey) === 'boolean') {
            trySetBoolean(script, rawKey, rawVal);
            continue;
        }
        trySetNumber(script, rawKey, rawVal);
    }
}
