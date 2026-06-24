import type { Entity } from 'playcanvas';
import { PERSISTENT_EFFECT_TYPE_VALUES, REVEAL_EFFECT_TYPE_VALUES } from './effect-types';
import { GsplatPersistentFallingPetals, GsplatPersistentFallingWeather } from './persistent/camera/falling-weather-persistent';
import { GsplatPersistentNostalgicComic } from './persistent/stylisation/nostalgic-comic-persistent';
import { GsplatPersistentPalettePixel } from './persistent/stylisation/palette-pixel-persistent';
import { GsplatPersistentWatercolor } from './persistent/stylisation/watercolor-persistent';
import { GsplatPersistentPenSketch } from './persistent/stylisation/pen-sketch-persistent';
import { GsplatPersistentPointillismStipple } from './persistent/stylisation/pointillism-stipple-persistent';
import { GsplatPersistentYiyunDianran } from './persistent/stylisation/yiyun-dianran-persistent';
import { GsplatRevealPerlinWave } from './persistent/scene/gsplat-perlin-wave';
import { GsplatPersistentOverallWave } from './persistent/scene/gsplat-overall-wave';
import { GsplatPersistentButterflyParticle } from './persistent/scene/gsplat-butterfly-particle';
import { GsplatPersistentSparkleTwinkle } from './persistent/scene/gsplat-sparkle-twinkle';

type RevealEffectId = (typeof REVEAL_EFFECT_TYPE_VALUES)[number];
type PersistentEffectId = (typeof PERSISTENT_EFFECT_TYPE_VALUES)[number];

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

export const GSPLAT_PERSISTENT_SCRIPT_NAME_BY_TYPE = {
    'perlin-wave': GsplatRevealPerlinWave.scriptName,
    'falling-petals': GsplatPersistentFallingPetals.scriptName,
    'falling-rain': GsplatPersistentFallingWeather.scriptName,
    'falling-snow': GsplatPersistentFallingWeather.scriptName,
    'nostalgic-comic': GsplatPersistentNostalgicComic.scriptName,
    'yiyun-dianran': GsplatPersistentYiyunDianran.scriptName,
    'palette-pixel': GsplatPersistentPalettePixel.scriptName,
    'pointillism-stipple': GsplatPersistentPointillismStipple.scriptName,
    'pen-sketch': GsplatPersistentPenSketch.scriptName,
    'watercolor': GsplatPersistentWatercolor.scriptName,
    'sparkle-twinkle': GsplatPersistentSparkleTwinkle.scriptName,
    'overall-wave': GsplatPersistentOverallWave.scriptName,
    'butterfly-particle': GsplatPersistentButterflyParticle.scriptName
} as const satisfies Record<PersistentEffectId, string>;

export const ALL_GSPLAT_PERSISTENT_SCRIPT_NAMES: ReadonlySet<string> = new Set(
    Object.values(GSPLAT_PERSISTENT_SCRIPT_NAME_BY_TYPE)
);

export function gsplatScriptNameForPersistentEffectType(effectType: string): string | undefined {
    return (GSPLAT_PERSISTENT_SCRIPT_NAME_BY_TYPE as Record<string, string | undefined>)[effectType];
}

export function destroyAllRevealGsplatScriptsOnEntity(entity: Entity | null | undefined): void {
    if (!entity?.script) return;
    for (const name of ALL_GSPLAT_REVEAL_SCRIPT_NAMES) {
        try {
            entity.script.destroy(name);
        } catch (e) {
            console.warn('[gsplat-effect-script-registry] destroy reveal script failed:', name, e);
        }
    }
}

export function destroyPersistentGsplatScriptOnEntity(
    entity: Entity | null | undefined,
    effectType: string
): void {
    if (!entity?.script) return;
    const name = gsplatScriptNameForPersistentEffectType(effectType);
    if (!name) return;
    try {
        entity.script.destroy(name);
    } catch (e) {
        console.warn('[gsplat-effect-script-registry] destroy persistent script failed:', name, e);
    }
}

export function destroyAllPersistentGsplatScriptsOnEntity(entity: Entity | null | undefined): void {
    if (!entity?.script) return;
    for (const name of ALL_GSPLAT_PERSISTENT_SCRIPT_NAMES) {
        try {
            entity.script.destroy(name);
        } catch (e) {
            console.warn('[gsplat-effect-script-registry] destroy persistent script failed:', name, e);
        }
    }
}

export function getMountedPersistentGsplatScript(
    entity: Entity | null | undefined,
    effectType: string | undefined
): unknown | null {
    if (!entity?.script || !effectType) return null;
    const sn = gsplatScriptNameForPersistentEffectType(effectType);
    if (!sn) return null;
    return entity.script.get(sn) ?? null;
}

export function forEachMountedPersistentGsplatScript(
    entity: Entity | null | undefined,
    types: Iterable<string> | undefined,
    fn: (effectType: string, script: unknown) => void
): void {
    if (!entity?.script) return;
    const iter = types ?? PERSISTENT_EFFECT_TYPE_VALUES;
    for (const effectType of iter) {
        const script = getMountedPersistentGsplatScript(entity, effectType);
        if (script) fn(effectType, script);
    }
}
