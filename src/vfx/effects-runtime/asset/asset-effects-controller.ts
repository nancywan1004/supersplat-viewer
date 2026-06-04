/**
 * 物体特效执行器：监听 `assetEffect:start` / `assetEffect:stop`，对标 `RevealController`（场景轨）。
 */

import type { AppBase, Entity } from 'playcanvas';

import type { Global } from '../../../types';
import { readAssetInstanceParams, patchAssetRuntimeMirror } from '../../../settings-serialize/effects-sync';
import type { ExperienceSettings } from '../../../schemas/v2';
import {
    GsplatMorphController,
    loadGsplatMorphSequence,
    type GsplatMorphOptions,
    type ProgressivePairFlightEase
} from './gsplat-morph-progressive-v2';
import {
    createGsplatWobbleEffect,
    GsplatWobbleEffect,
    removeGsplatWobbleEffect,
    type GsplatWobbleOptions
} from './gsplat-wobble';
import { ASSET_EFFECT_TYPE_VALUES, type AssetEffectType } from '../effect-types';
import type { AssetEffectStartEntities } from './asset-effect-entity';
import {
    resolveMorphKeyframeEntitiesFromEffectParams,
    resolveMorphKeyframeUrlsFromEffectParams,
    resolveWobbleEntityFromEffectParams
} from './asset-effect-entity';
import { getDefaultWobbleEffectParams, mergeWobbleEffectParams } from './wobble-effect-params';

type ActiveAssetEffect = {
    type: AssetEffectType;
    morph?: GsplatMorphController;
    wobbleEntity?: Entity;
    wobbleScript?: GsplatWobbleEffect;
};

const GSPLAT_MORPH_TYPE = ASSET_EFFECT_TYPE_VALUES[0];
const GSPLAT_WOBBLE_TYPE = ASSET_EFFECT_TYPE_VALUES[1];

export function buildWobbleOptions(ep: Record<string, unknown>): GsplatWobbleOptions {
    const merged = mergeWobbleEffectParams(ep);
    const opts: GsplatWobbleOptions = {};
    if (typeof merged.continuousRender === 'boolean') opts.continuousRender = merged.continuousRender;
    if (typeof merged.amplitude === 'number') {
        opts.amplitude = merged.amplitude;
    } else if (typeof merged.electronicYawAmplitude === 'number') {
        // backward compatible: old 1.0 ~= new amplitude 0.3
        opts.amplitude = Math.max(0, merged.electronicYawAmplitude) * 0.3;
    }
    if (merged.wobbleAxis === 'x' || merged.wobbleAxis === 'z') opts.wobbleAxis = merged.wobbleAxis;
    if (merged.motionMode === 'wobble' || merged.motionMode === 'electronic' || merged.motionMode === 'deepMeditation') {
        opts.motionMode = merged.motionMode;
    }
    if (typeof merged.frequency === 'number') opts.frequency = merged.frequency;
    if (typeof merged.heightScale === 'number') opts.heightScale = merged.heightScale;
    if (typeof merged.bounceAmplitude === 'number') opts.bounceAmplitude = merged.bounceAmplitude;
    if (typeof merged.bounceFrequency === 'number') opts.bounceFrequency = merged.bounceFrequency;
    if (typeof merged.springOscillation === 'number') opts.springOscillation = merged.springOscillation;
    if (typeof merged.springDamping === 'number') opts.springDamping = merged.springDamping;
    if (typeof merged.springBlend === 'number') opts.springBlend = merged.springBlend;
    if (typeof merged.cycleDuration === 'number') opts.cycleDuration = merged.cycleDuration;
    if (typeof merged.bounceDuration === 'number') opts.bounceDuration = merged.bounceDuration;
    if (typeof merged.bounceCount === 'number') opts.bounceCount = merged.bounceCount;
    if (typeof merged.colorMix === 'number') opts.colorMix = merged.colorMix;
    if (typeof merged.colorBandStart === 'number') opts.colorBandStart = merged.colorBandStart;
    if (typeof merged.colorBandEnd === 'number') opts.colorBandEnd = merged.colorBandEnd;
    if (Array.isArray(merged.goldColor) && merged.goldColor.length === 3) {
        opts.goldColor = merged.goldColor as [number, number, number];
    }
    if (typeof merged.haloWidth === 'number') opts.haloWidth = merged.haloWidth;
    if (typeof merged.haloSpeed === 'number') opts.haloSpeed = merged.haloSpeed;
    if (typeof merged.haloOpacity === 'number') opts.haloOpacity = merged.haloOpacity;
    if (typeof merged.bounceStretch === 'number') opts.bounceStretch = merged.bounceStretch;
    if (typeof merged.wobbleAnchorLift === 'number') opts.wobbleAnchorLift = merged.wobbleAnchorLift;
    if (typeof merged.anchorLift === 'number') opts.anchorLift = merged.anchorLift;
    return opts;
}

const PROGRESSIVE_PAIR_FLIGHT_EASE_VALUES = new Set<string>([
    'linear',
    'smoothstep',
    'easeIn',
    'easeOut',
    'easeInOut'
]);

function resolveProgressivePairFlightEaseParam(value: unknown): ProgressivePairFlightEase | undefined {
    return typeof value === 'string' && PROGRESSIVE_PAIR_FLIGHT_EASE_VALUES.has(value)
        ? (value as ProgressivePairFlightEase)
        : undefined;
}

export function buildMorphOptions(ep: Record<string, unknown>): GsplatMorphOptions {
    const opts: GsplatMorphOptions = {
        segmentDuration: typeof ep.segmentDuration === 'number' ? ep.segmentDuration : 10,
        segmentHoldDuration: typeof ep.segmentHoldDuration === 'number' ? ep.segmentHoldDuration : undefined,
        loop:
            typeof ep.isLoop === 'boolean' ? ep.isLoop :
                typeof ep.loop === 'boolean' ? ep.loop :
                    undefined,
        autoPlay: typeof ep.autoPlay === 'boolean' ? ep.autoPlay : true,
        // 大 splat 下默认做插值节流，避免每帧全量 CPU 插值/上传导致卡顿
        morphPresentMaxHz: typeof ep.morphPresentMaxHz === 'number' ? ep.morphPresentMaxHz : 24,
        morphAnimateSphericalHarmonics:
            // 默认关闭逐帧高阶 SH 动画，只在段切换时更新，显著减轻主线程压力
            typeof ep.morphAnimateSphericalHarmonics === 'boolean' ? ep.morphAnimateSphericalHarmonics : false,
        // v2 默认走 CPU 路径，避免 GPU morph 在部分场景出现团块/球化过渡
        preferGpuMorph: typeof ep.preferGpuMorph === 'boolean' ? ep.preferGpuMorph : false,
        recenterModels: typeof ep.recenterModels === 'boolean' ? ep.recenterModels : undefined,
        normalizeScales: typeof ep.normalizeScales === 'boolean' ? ep.normalizeScales : undefined,
        targetScale: typeof ep.targetScale === 'number' ? ep.targetScale : undefined,
        // 排序中心更新同样节流，降低额外大数组写回成本
        sortCentersMaxHz: typeof ep.sortCentersMaxHz === 'number' ? ep.sortCentersMaxHz : 6,
        progressivePairFlight: typeof ep.progressivePairFlight === 'boolean' ? ep.progressivePairFlight : true,
        progressivePairFlightWindow:
            typeof ep.progressivePairFlightWindow === 'number' ? ep.progressivePairFlightWindow : 0.12,
        progressivePairFlightStagger:
            typeof ep.progressivePairFlightStagger === 'number' ? ep.progressivePairFlightStagger : 0,
        progressivePairFlightEase: resolveProgressivePairFlightEaseParam(ep.progressivePairFlightEase),
        progressivePairFlightPosEase: resolveProgressivePairFlightEaseParam(ep.progressivePairFlightPosEase),
        correspondenceStrategy:
            ep.correspondenceStrategy === 'resample' || ep.correspondenceStrategy === 'greedy'
                ? ep.correspondenceStrategy
                : 'greedy',
        progressivePairAsymmetricDissolve:
            typeof ep.progressivePairAsymmetricDissolve === 'boolean' ? ep.progressivePairAsymmetricDissolve : true,
        morphHourglassChannel: typeof ep.morphHourglassChannel === 'boolean' ? ep.morphHourglassChannel : true,
        morphHourglassStrength:
            typeof ep.morphHourglassStrength === 'number'
                ? ep.morphHourglassStrength
                : typeof ep.morphPointCloudStrength === 'number'
                    ? ep.morphPointCloudStrength
                    : undefined,
        morphHourglassEndRadiusFrac:
            typeof ep.morphHourglassEndRadiusFrac === 'number' ? ep.morphHourglassEndRadiusFrac : undefined,
        morphHourglassWaistRatio:
            typeof ep.morphHourglassWaistRatio === 'number' ? ep.morphHourglassWaistRatio : undefined,
        morphHourglassConform: typeof ep.morphHourglassConform === 'number' ? ep.morphHourglassConform : undefined,
        morphHourglassPerturbAmp:
            typeof ep.morphHourglassPerturbAmp === 'number' ? ep.morphHourglassPerturbAmp : undefined,
        morphHourglassSparkIntensity:
            typeof ep.morphHourglassSparkIntensity === 'number' ? ep.morphHourglassSparkIntensity : undefined,
        morphHourglassSparkTwist:
            typeof ep.morphHourglassSparkTwist === 'number' ? ep.morphHourglassSparkTwist : undefined,
        morphHourglassSparkDrift:
            typeof ep.morphHourglassSparkDrift === 'number' ? ep.morphHourglassSparkDrift : undefined,
        morphHourglassParticleScaleFrac:
            typeof ep.morphHourglassParticleScaleFrac === 'number'
                ? ep.morphHourglassParticleScaleFrac
                : undefined,
        morphHourglassTintMix:
            typeof ep.morphHourglassTintMix === 'number' ? ep.morphHourglassTintMix : 0,
        morphPointCloudEffect: typeof ep.morphPointCloudEffect === 'boolean' ? ep.morphPointCloudEffect : false,
        fastQuaternionNlerp: typeof ep.fastQuaternionNlerp === 'boolean' ? ep.fastQuaternionNlerp : undefined,
        // 变形播放中不需要 greedy；后台构建会占满主线程导致卡顿。需要语义配对时再显式开启。
        buildGreedyInBackground: typeof ep.buildGreedyInBackground === 'boolean' ? ep.buildGreedyInBackground : false,
        greedySpatialWeight: typeof ep.greedySpatialWeight === 'number' ? ep.greedySpatialWeight : undefined,
        greedyColorWeight: typeof ep.greedyColorWeight === 'number' ? ep.greedyColorWeight : undefined,
        greedyGridCellSize: typeof ep.greedyGridCellSize === 'number' ? ep.greedyGridCellSize : undefined,
        greedySearchRadiusCells: typeof ep.greedySearchRadiusCells === 'number' ? ep.greedySearchRadiusCells : undefined,
        greedyMaxCandidatesPerPoint: typeof ep.greedyMaxCandidatesPerPoint === 'number' ? ep.greedyMaxCandidatesPerPoint : undefined,
        morphPointCloudPointSize: typeof ep.morphPointCloudPointSize === 'number' ? ep.morphPointCloudPointSize : undefined,
        morphPointCloudMinScreenPx: typeof ep.morphPointCloudMinScreenPx === 'number' ? ep.morphPointCloudMinScreenPx : undefined,
        morphPointCloudScreenFloorMaxScale:
            typeof ep.morphPointCloudScreenFloorMaxScale === 'number' ? ep.morphPointCloudScreenFloorMaxScale : undefined,
        morphPointCloudStrength: typeof ep.morphPointCloudStrength === 'number' ? ep.morphPointCloudStrength : undefined,
        morphPointCloudTint: Array.isArray(ep.morphPointCloudTint) &&
            ep.morphPointCloudTint.length === 3 &&
            ep.morphPointCloudTint.every((v) => typeof v === 'number' && Number.isFinite(v))
            ? ep.morphPointCloudTint as [number, number, number]
            : undefined,
        morphPointCloudGlowStrength: typeof ep.morphPointCloudGlowStrength === 'number' ? ep.morphPointCloudGlowStrength : undefined,
        morphPointCloudOpacity: typeof ep.morphPointCloudOpacity === 'number' ? ep.morphPointCloudOpacity : undefined,
        morphPointCloudDensity: typeof ep.morphPointCloudDensity === 'number' ? ep.morphPointCloudDensity : undefined,
        morphPointCloudScatterDistance: typeof ep.morphPointCloudScatterDistance === 'number' ? ep.morphPointCloudScatterDistance : undefined,
        morphPointCloudEdgeDuration: typeof ep.morphPointCloudEdgeDuration === 'number' ? ep.morphPointCloudEdgeDuration : undefined,
        morphPointCloudHoldDuration: typeof ep.morphPointCloudHoldDuration === 'number' ? ep.morphPointCloudHoldDuration : undefined,
        morphPointCloudRevealDuration: typeof ep.morphPointCloudRevealDuration === 'number' ? ep.morphPointCloudRevealDuration : undefined,
        hideSourceEntities: typeof ep.hideSourceEntities === 'boolean' ? ep.hideSourceEntities : undefined,
        entityName: typeof ep.entityName === 'string' ? ep.entityName : undefined
    };
    return opts;
}

export class AssetEffectsController {
    private readonly _global: Global;
    private readonly _app: AppBase;
    private readonly _active = new Map<string, ActiveAssetEffect>();
    private _disposed = false;

    constructor(global: Global) {
        this._global = global;
        this._app = global.app;

        global.events.on('assetEffect:start', this._onStart);
        global.events.on('assetEffect:stop', this._onStop);
        global.events.on('assetEffect:configChanged', this._onConfigChanged);
        global.events.on('vfxExit', this._onVfxExit);
    }

    dispose() {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._global.events.off('assetEffect:start', this._onStart);
        this._global.events.off('assetEffect:stop', this._onStop);
        this._global.events.off('assetEffect:configChanged', this._onConfigChanged);
        this._global.events.off('vfxExit', this._onVfxExit);
        for (const targetId of [...this._active.keys()]) {
            this._teardownTarget(targetId);
        }
    }

    private readonly _onStart = (payload: {
        targetId: string;
        type: string;
        /** @deprecated 兼容旧事件字段 */
        effectId?: string;
        params?: { effectParams?: Record<string, unknown> };
        /** 同进程 host 可选注入（message-bridge JSON 不传 Entity） */
        entities?: AssetEffectStartEntities;
    }) => {
        if (this._disposed || !payload?.targetId) {
            return;
        }
        const type = (payload.type ?? payload.effectId) as string;
        void this._handleStart(
            payload.targetId,
            type,
            payload.params?.effectParams,
            payload.entities
        );
    };

    private readonly _onConfigChanged = (payload: {
        targetId: string;
        type: string;
        params?: { effectParams?: Record<string, unknown> };
    }) => {
        if (this._disposed || !payload?.targetId) {
            return;
        }
        const entry = this._active.get(payload.targetId);
        if (!entry) {
            return;
        }
        const inst = readAssetInstanceParams(
            this._global.settings as ExperienceSettings,
            payload.targetId
        );
        const ep = {
            ...(inst?.effectParams ?? {}),
            ...(payload.params?.effectParams ?? {})
        };
        if (entry.type === GSPLAT_MORPH_TYPE) {
            entry.morph?.setOptions(buildMorphOptions(ep));
            return;
        }
        if (entry.type !== GSPLAT_WOBBLE_TYPE) {
            return;
        }
        let script = entry.wobbleScript;
        if (!script && entry.wobbleEntity?.script) {
            script = entry.wobbleEntity.script.get(GsplatWobbleEffect.scriptName) as unknown as GsplatWobbleEffect | null;
            if (script) {
                entry.wobbleScript = script;
            }
        }
        script?.setOptions(buildWobbleOptions(ep));
    };

    private readonly _onStop = (payload: {
        targetId: string;
        type?: string;
        effectId?: string;
    }) => {
        if (this._disposed || !payload?.targetId) {
            return;
        }
        const type = (payload.type ?? payload.effectId ?? GSPLAT_MORPH_TYPE) as AssetEffectType;
        this._teardownTarget(payload.targetId);
        patchAssetRuntimeMirror(this._global.state, payload.targetId, { status: 'inactive' });
        this._global.events.fire('assetEffect:stopped', {
            targetId: payload.targetId,
            type
        });
    };

    private readonly _onVfxExit = () => {
        for (const [targetId, entry] of [...this._active.entries()]) {
            this._teardownTarget(targetId);
            patchAssetRuntimeMirror(this._global.state, targetId, { status: 'inactive' });
            this._global.events.fire('assetEffect:stopped', {
                targetId,
                type: entry.type
            });
        }
    };

    private async _handleStart(
        targetId: string,
        type: string,
        effectParams?: Record<string, unknown>,
        entities?: AssetEffectStartEntities
    ) {
        this._teardownTarget(targetId);

        if (type === GSPLAT_MORPH_TYPE) {
            await this._startMorph(targetId, effectParams, entities);
            return;
        }
        if (type === GSPLAT_WOBBLE_TYPE) {
            this._startWobble(targetId, effectParams, entities);
            return;
        }

        console.warn('[AssetEffectsController] unsupported effect type:', type);
        this._setError('UNSUPPORTED_EFFECT', `Unsupported asset effect: ${type}`, type, targetId);
    }

    private async _startMorph(
        targetId: string,
        effectParams?: Record<string, unknown>,
        entities?: AssetEffectStartEntities
    ) {
        const inst =
            readAssetInstanceParams(this._global.settings as ExperienceSettings, targetId) ??
            { type: GSPLAT_MORPH_TYPE, effectParams };
        const ep = { ...(inst.effectParams ?? {}), ...(effectParams ?? {}) };
        const urls = resolveMorphKeyframeUrlsFromEffectParams(
            this._global,
            ep,
            entities?.keyframeEntities
        );
        const sourceEntities = resolveMorphKeyframeEntitiesFromEffectParams(
            this._global,
            ep,
            entities?.keyframeEntities
        );
        if (!urls) {
            const msg =
                'gsplat-morph requires effectParams.keyframeEntityIds (≥2) or keyframeUrls (≥2)';
            console.warn('[AssetEffectsController]', msg, { targetId });
            this._setError('MORPH_KEYFRAMES_REQUIRED', msg, GSPLAT_MORPH_TYPE, targetId);
            patchAssetRuntimeMirror(this._global.state, targetId, { status: 'inactive' });
            return;
        }

        let morph: GsplatMorphController | null = null;
        const morphOpts: GsplatMorphOptions = {
            ...buildMorphOptions(ep),
            sourceEntities: sourceEntities ?? undefined,
            entityName: typeof ep.entityName === 'string' ? ep.entityName : `morph-${targetId}`,
            onCorrespondenceStatus: status => {
                this._global.events.fire('assetEffect:morphCorrespondenceStatus', {
                    targetId,
                    type: GSPLAT_MORPH_TYPE,
                    ...status
                });
            },
            onPlaybackComplete: () => {
                if (!morph) {
                    return;
                }
                this._onMorphPlaybackComplete(targetId, morph, sourceEntities?.[0]);
            }
        };

        try {
            morph = await loadGsplatMorphSequence(this._app, urls, morphOpts);
            if (this._disposed) {
                morph.destroy();
                return;
            }
            morph.play();
            this._active.set(targetId, { type: GSPLAT_MORPH_TYPE, morph });
            patchAssetRuntimeMirror(this._global.state, targetId, {
                activeType: GSPLAT_MORPH_TYPE,
                status: 'playing'
            });
            this._global.events.fire('assetEffect:started', { targetId, type: GSPLAT_MORPH_TYPE });
            console.log('[AssetEffectsController] started gsplat-morph', targetId);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[AssetEffectsController] start failed', targetId, err);
            this._setError('MORPH_START_FAILED', message, GSPLAT_MORPH_TYPE, targetId);
            patchAssetRuntimeMirror(this._global.state, targetId, { status: 'inactive' });
        }
    }

    private _onMorphPlaybackComplete(targetId: string, morph: GsplatMorphController, primary?: Entity): void {
        queueMicrotask(() => {
            if (this._disposed) {
                return;
            }
            const entry = this._active.get(targetId);
            if (!entry || entry.type !== GSPLAT_MORPH_TYPE || entry.morph !== morph) {
                return;
            }

            this._teardownTarget(targetId);
            patchAssetRuntimeMirror(this._global.state, targetId, { status: 'inactive' });
            this._global.events.fire('assetEffect:stopped', {
                targetId,
                type: GSPLAT_MORPH_TYPE
            });

            const effectParams = getDefaultWobbleEffectParams('deepMeditation');
            this._global.events.fire('assetEffect:start', {
                targetId,
                type: GSPLAT_WOBBLE_TYPE,
                params: { effectParams },
                ...(primary ? { entities: { primary } } : {})
            });
            patchAssetRuntimeMirror(this._global.state, targetId, {
                activeType: GSPLAT_WOBBLE_TYPE,
                status: 'playing'
            });
        });
    }

    private _startWobble(
        targetId: string,
        effectParams?: Record<string, unknown>,
        entities?: AssetEffectStartEntities
    ) {
        const inst =
            readAssetInstanceParams(this._global.settings as ExperienceSettings, targetId) ??
            { type: GSPLAT_WOBBLE_TYPE, effectParams };
        const ep = { ...(inst.effectParams ?? {}), ...(effectParams ?? {}) };
        const entity = resolveWobbleEntityFromEffectParams(
            this._global,
            ep,
            targetId,
            entities?.primary
        );
        if (!entity) {
            const msg =
                'gsplat-wobble requires effectParams.entityId (or targetId) on a placed Gaussian with gsplat';
            console.warn('[AssetEffectsController]', msg, { targetId });
            this._setError('WOBBLE_TARGET_REQUIRED', msg, GSPLAT_WOBBLE_TYPE, targetId);
            patchAssetRuntimeMirror(this._global.state, targetId, { status: 'inactive' });
            return;
        }

        try {
            const script = createGsplatWobbleEffect(entity, buildWobbleOptions(ep)) as GsplatWobbleEffect;
            if (this._disposed) {
                removeGsplatWobbleEffect(entity);
                return;
            }
            this._active.set(targetId, {
                type: GSPLAT_WOBBLE_TYPE,
                wobbleEntity: entity,
                wobbleScript: script
            });
            patchAssetRuntimeMirror(this._global.state, targetId, {
                activeType: GSPLAT_WOBBLE_TYPE,
                status: 'playing'
            });
            this._global.events.fire('assetEffect:started', { targetId, type: GSPLAT_WOBBLE_TYPE });
            console.log('[AssetEffectsController] started gsplat-wobble', targetId, script.enabled);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error('[AssetEffectsController] wobble start failed', targetId, err);
            this._setError('WOBBLE_START_FAILED', message, GSPLAT_WOBBLE_TYPE, targetId);
            patchAssetRuntimeMirror(this._global.state, targetId, { status: 'inactive' });
        }
    }

    private _teardownTarget(targetId: string) {
        const entry = this._active.get(targetId);
        if (!entry) {
            return;
        }
        entry.morph?.destroy();
        if (entry.wobbleEntity) {
            removeGsplatWobbleEffect(entry.wobbleEntity);
        }
        this._active.delete(targetId);
    }

    private _setError(code: string, message: string, type: string, targetId: string) {
        if (!this._global.state.effectsRuntimeState) {
            return;
        }
        this._global.state.effectsRuntimeState.lastError = {
            code,
            message,
            effectId: type,
            command: 'EFFECT_START'
        };
        this._global.events.fire('assetEffect:error', { targetId, type, code, message });
    }
}

export function createAssetEffectsController(global: Global): AssetEffectsController {
    return new AssetEffectsController(global);
}
