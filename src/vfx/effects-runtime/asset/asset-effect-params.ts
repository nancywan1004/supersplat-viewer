/**
 * 物体特效 `effectParams` 白名单（`settings.effects.asset.instancesByTargetId`）。
 * 协议：`EFFECT_PARAMS_PATCH` / `EFFECT_START.params.effectParams`。
 */

import { ASSET_EFFECT_TYPE_VALUES } from '../effect-types';

const GSPLAT_MORPH = new Set([
    'segmentDuration',
    'segmentHoldDuration',
    'loop',
    'autoPlay',
    'continuousAppRender',
    'morphPresentMaxHz',
    'morphAnimateSphericalHarmonics',
    'preferGpuMorph',
    'recenterModels',
    'normalizeScales',
    'targetScale',
    'sortCentersMaxHz',
    'fastQuaternionNlerp',
    'buildGreedyInBackground',
    'correspondenceStrategy',
    'greedySpatialWeight',
    'greedyColorWeight',
    'greedyGridCellSize',
    'greedySearchRadiusCells',
    'greedyMaxCandidatesPerPoint',
    'progressivePairFlightWindow',
    'progressivePairAsymmetricDissolve',
    'morphHourglassChannel',
    'morphHourglassStrength',
    'morphHourglassEndRadiusFrac',
    'morphHourglassWaistRatio',
    'morphHourglassParticleScaleFrac',
    'morphHourglassSparkIntensity',
    'morphHourglassSparkTwist',
    'morphHourglassSparkDrift',
    'morphHourglassConform',
    'morphHourglassTintMix',
    'morphPointCloudEffect',
    'morphPointCloudPointSize',
    'morphPointCloudMinScreenPx',
    'morphPointCloudScreenFloorMaxScale',
    'morphPointCloudStrength',
    'morphPointCloudTint',
    'morphPointCloudGlowStrength',
    'morphPointCloudOpacity',
    'morphPointCloudDensity',
    'morphPointCloudScatterDistance',
    'morphPointCloudEdgeDuration',
    'morphPointCloudHoldDuration',
    'morphPointCloudRevealDuration',
    'hideSourceEntities',
    'keyframeUrls',
    /** @deprecated 使用 keyframeEntityIds；保留兼容 bridge / 旧配置 */
    'keyframeTargetIds',
    'keyframeEntityIds',
    /** 静物活化 / 配置绑定的场景 Entity id（bridge 必传；internal 由列表选择写入） */
    'entityId',
    'entityName'
]);

/** 与 `GsplatWobbleOptions` 对齐（`gsplat-wobble.ts`） */
const GSPLAT_WOBBLE = new Set([
    'enabled',
    'continuousRender',
    'amplitude',
    'wobbleAxis',
    'motionMode',
    'frequency',
    'heightScale',
    'bounceAmplitude',
    'bounceFrequency',
    'springOscillation',
    'springDamping',
    'springBlend',
    'cycleDuration',
    'bounceDuration',
    'bounceCount',
    'colorMix',
    'colorBandStart',
    'colorBandEnd',
    'goldColor',
    'haloWidth',
    'haloSpeed',
    'haloOpacity',
    'bounceStretch',
    'wobbleAnchorLift',
    'anchorLift',
    'entityName'
]);

const BY_TYPE: Record<string, ReadonlySet<string>> = {
    [ASSET_EFFECT_TYPE_VALUES[0]]: GSPLAT_MORPH,
    [ASSET_EFFECT_TYPE_VALUES[1]]: GSPLAT_WOBBLE
};

export function assetEffectParamsWhitelistForType(effectType: string): ReadonlySet<string> | null {
    return BY_TYPE[effectType] ?? null;
}

export function filterAssetEffectParams(
    effectType: string,
    incoming: Record<string, unknown> | null | undefined
): Record<string, unknown> {
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
        return {};
    }
    const allow = assetEffectParamsWhitelistForType(effectType);
    if (!allow) {
        return {};
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(incoming)) {
        if (!allow.has(k)) {
            continue;
        }
        if (k === 'keyframeUrls' || k === 'keyframeTargetIds' || k === 'keyframeEntityIds') {
            if (Array.isArray(v) && v.every((u) => typeof u === 'string' && u.length > 0)) {
                out[k] = v;
            }
            continue;
        }
        if (k === 'entityId') {
            if (typeof v === 'string' && v.length > 0) {
                out[k] = v;
            }
            continue;
        }
        if (k === 'goldColor' || k === 'morphPointCloudTint') {
            if (
                Array.isArray(v) &&
                v.length === 3 &&
                v.every((n) => typeof n === 'number' && Number.isFinite(n))
            ) {
                out[k] = v;
            }
            continue;
        }
        if (typeof v === 'number' && Number.isFinite(v)) {
            out[k] = v;
        } else if (typeof v === 'boolean') {
            out[k] = v;
        } else if (typeof v === 'string') {
            out[k] = v;
        }
    }
    return out;
}

export function paramsPatchHasAssetKeys(params: Record<string, unknown>): boolean {
    if (typeof params.enabled === 'boolean') {
        return true;
    }
    if (typeof params.autoStart === 'boolean') {
        return true;
    }
    if (params.effectParams !== undefined) {
        return true;
    }
    if (typeof params.type === 'string') {
        return true;
    }
    if (typeof params.effectId === 'string') {
        return true;
    }
    return false;
}
