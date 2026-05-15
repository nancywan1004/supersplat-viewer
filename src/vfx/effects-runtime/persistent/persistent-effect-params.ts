import { Vec3 } from 'playcanvas';

/**
 * 可持续 **persistent** 轨的 **`settings.effects.persistent` → `effectParams`** 白名单与写入逻辑。
 *
 * - 协议：`EFFECT_PARAMS_PATCH`（`effectId === scene.gsplat-persistent`）的 `params.effectParams`；存盘包为 **`type` / `autoStart` / `effectParams`**，**无** `totalDuration`（与 reveal 轨区分）。
 * - 仅当 `key` 落在当前 `type` 对应集合内时才写入脚本；其余键静默忽略。
 * - **数值**：有限 `number`，且脚本上须已存在该属性名。
 * - **`center`**：`[x, y, z]` 写入 `Vec3`。
 *
 * 新增 persistent 类型：扩展 **`BY_TYPE`** 与下方 `Set`，并在 **`mountPersistentGsplatByEffectType`** 创建脚本后调用 **`applyPersistentEffectParamsToScript`**。
 */

// --- perlin-wave：`GsplatRevealPerlinWave`（`gsplat-perlin-wave.ts`）+ `createPerlinWaveRevealScript` 初值 ---

const PERLIN_WAVE = new Set([
    'intensity', // 默认 0.8（create），类 0.5；@range [0,1]
    'waveAmplitude', // 默认 0.2（create），类 0.1；@range [0,2]
    'waveFrequency', // 默认 1.0（类，create 未改）；@range [0,10]；wavelength≤0 时参与 uWaveFrequency
    'wavelength', // 默认 2.5（create），类 0；@range [0,100]；>0 时优先于 waveFrequency
    'waveSpeed', // 默认 0.5（create），类 1.0；@range [0,5]
    'scaleBlend', // 默认 0.75（create），类 0；@range [0,1]
    'center' // Vec3，类 (0,0,0)；常由 updateScriptCenter 覆盖；JSON [x,y,z]
]);

const BY_TYPE: Record<string, ReadonlySet<string>> = {
    'perlin-wave': PERLIN_WAVE
};

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

function trySetNumber(script: any, key: string, v: unknown): boolean {
    if (typeof v !== 'number' || !Number.isFinite(v)) return false;
    if (!(key in script)) return false;
    script[key] = v;
    return true;
}

/**
 * 将 `effectParams` 中属于当前 persistent `effectType` 白名单的项写入已挂载脚本（在 **`create*Script` 默认值与 `updateScriptCenter` 之后**调用）。
 */
export function applyPersistentEffectParamsToScript(
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
        if (rawKey === 'center') {
            trySetVec3(script, rawKey, rawVal);
            continue;
        }
        trySetNumber(script, rawKey, rawVal);
    }
}
