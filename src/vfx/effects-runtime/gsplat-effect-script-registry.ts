import type { Entity } from 'playcanvas';
import { PERSISTENT_EFFECT_TYPE_VALUES, REVEAL_EFFECT_TYPE_VALUES } from './effect-types';
import { GsplatPersistentFallingPetals, GsplatPersistentFallingWeather } from './persistent/falling-weather-persistent';
import { GsplatPersistentNostalgicComic } from './persistent/nostalgic-comic-persistent';
import { GsplatPersistentPalettePixel } from './persistent/palette-pixel-persistent';
import { GsplatPersistentYiyunDianran } from './persistent/yiyun-dianran-persistent';
import { GsplatRevealPerlinWave } from './persistent/gsplat-perlin-wave';
import { GsplatPersistentOverallWave } from './persistent/gsplat-overall-wave';
import { GsplatPersistentButterflyParticle } from './persistent/gsplat-butterfly-particle';
import { GsplatPersistentSparkleTwinkle } from './persistent/gsplat-sparkle-twinkle';

type RevealEffectId = (typeof REVEAL_EFFECT_TYPE_VALUES)[number];
type PersistentEffectId = (typeof PERSISTENT_EFFECT_TYPE_VALUES)[number];

/**
 * `settings.effects.reveal.type`（一次性开场）→ gsplat 实体上 PlayCanvas `scriptName`。
 * 与 `RevealController.createEffect` 分派一致；扩展 {@link REVEAL_EFFECT_TYPE_VALUES} 时须在此补键。
 */
export const GSPLAT_REVEAL_SCRIPT_NAME_BY_TYPE = {
    radial: 'gsplatRevealRadial',
    rain: 'gsplatRevealRain',
    'rain-v2': 'gsplatRainV2',
    smooth: 'gsplatRevealSmooth',
    'pieces-recover': 'gsplatRevealPiecesRecover',
    integrate: 'gsplatIntegrate',
    'growth-wave': 'gsplatRevealGrowthWave',
    sketch: 'gsplatSketch'
} as const satisfies Record<RevealEffectId, string>;

export const ALL_GSPLAT_REVEAL_SCRIPT_NAMES = new Set<string>(Object.values(GSPLAT_REVEAL_SCRIPT_NAME_BY_TYPE));

export function gsplatScriptNameForRevealEffectType(effectType: string): string | undefined {
    return (GSPLAT_REVEAL_SCRIPT_NAME_BY_TYPE as Record<string, string | undefined>)[effectType];
}

/**
 * `settings.effects.persistent.type` → gsplat 实体上脚本 `scriptName`。
 * 扩展 {@link PERSISTENT_EFFECT_TYPE_VALUES} 时须在此增加一项，并与 `mountPersistentGsplatByEffectType` 同步。
 */
export const GSPLAT_PERSISTENT_SCRIPT_NAME_BY_TYPE = {
    'perlin-wave': GsplatRevealPerlinWave.scriptName,
    'falling-petals': GsplatPersistentFallingPetals.scriptName,
    'falling-rain': GsplatPersistentFallingWeather.scriptName,
    'falling-snow': GsplatPersistentFallingWeather.scriptName,
    'nostalgic-comic': GsplatPersistentNostalgicComic.scriptName,
    'yiyun-dianran': GsplatPersistentYiyunDianran.scriptName,
    'palette-pixel': GsplatPersistentPalettePixel.scriptName,
    'sparkle-twinkle': GsplatPersistentSparkleTwinkle.scriptName,
    'overall-wave': GsplatPersistentOverallWave.scriptName,
    'butterfly-particle': GsplatPersistentButterflyParticle.scriptName
} as const satisfies Record<PersistentEffectId, string>;

export const ALL_GSPLAT_PERSISTENT_SCRIPT_NAMES: ReadonlySet<string> = new Set(Object.values(GSPLAT_PERSISTENT_SCRIPT_NAME_BY_TYPE));

export function gsplatScriptNameForPersistentEffectType(effectType: string): string | undefined {
    return (GSPLAT_PERSISTENT_SCRIPT_NAME_BY_TYPE as Record<string, string | undefined>)[effectType];
}

/** 仅销毁一次性 reveal 在实体上注册的脚本（不碰 persistent）。 */
export function destroyAllRevealGsplatScriptsOnEntity(entity: Entity | null | undefined): void {
    if (!entity?.script) {
        return;
    }
    for (const name of ALL_GSPLAT_REVEAL_SCRIPT_NAMES) {
        try {
            entity.script.destroy(name);
        } catch (e) {
            console.warn('[gsplat-effect-script-registry] destroy reveal script failed:', name, e);
        }
    }
}

/** 仅销毁指定 persistent 类型的脚本（不碰其它 persistent / reveal）。 */
export function destroyPersistentGsplatScriptOnEntity(
    entity: Entity | null | undefined,
    effectType: string
): void {
    if (!entity?.script) {
        return;
    }
    const name = gsplatScriptNameForPersistentEffectType(effectType);
    if (!name) {
        return;
    }
    try {
        entity.script.destroy(name);
    } catch (e) {
        console.warn('[gsplat-effect-script-registry] destroy persistent script failed:', name, e);
    }
}

/** 仅销毁 persistent 在实体上注册的脚本（不碰 reveal）。 */
export function destroyAllPersistentGsplatScriptsOnEntity(entity: Entity | null | undefined): void {
    if (!entity?.script) {
        return;
    }
    for (const name of ALL_GSPLAT_PERSISTENT_SCRIPT_NAMES) {
        try {
            entity.script.destroy(name);
        } catch (e) {
            console.warn('[gsplat-effect-script-registry] destroy persistent script failed:', name, e);
        }
    }
}

/** 按配置的 persistent `type` 取实体上已挂载的脚本实例（无则 null） */
export function getMountedPersistentGsplatScript(
    entity: Entity | null | undefined,
    effectType: string | undefined
): unknown | null {
    if (!entity?.script || !effectType) {
        return null;
    }
    const sn = gsplatScriptNameForPersistentEffectType(effectType);
    if (!sn) {
        return null;
    }
    return entity.script.get(sn) ?? null;
}

/** 遍历已挂载的 persistent 脚本（`types` 缺省时扫描全部已知 scriptName） */
export function forEachMountedPersistentGsplatScript(
    entity: Entity | null | undefined,
    types: Iterable<string> | undefined,
    fn: (effectType: string, script: unknown) => void
): void {
    if (!entity?.script) {
        return;
    }
    const iter = types ?? PERSISTENT_EFFECT_TYPE_VALUES;
    for (const effectType of iter) {
        const script = getMountedPersistentGsplatScript(entity, effectType);
        if (script) {
            fn(effectType, script);
        }
    }
}
