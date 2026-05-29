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
    type GsplatMorphOptions
} from '../../gsplat-morph-progressive-v2';
import {
    createGsplatWobbleEffect,
    GsplatWobbleEffect,
    removeGsplatWobbleEffect,
    type GsplatWobbleOptions
} from '../../gsplat-wobble';
import { ASSET_EFFECT_TYPE_VALUES, type AssetEffectType } from '../effect-types';
import type { AssetEffectStartEntities } from './asset-effect-entity';
import {
    resolveMorphKeyframeEntitiesFromEffectParams,
    resolveMorphKeyframeUrlsFromEffectParams,
    resolveWobbleEntityFromEffectParams
} from './asset-effect-entity';

type ActiveAssetEffect = {
    type: AssetEffectType;
    morph?: GsplatMorphController;
    wobbleEntity?: Entity;
    wobbleScript?: GsplatWobbleEffect;
};

const GSPLAT_MORPH_TYPE = ASSET_EFFECT_TYPE_VALUES[0];
const GSPLAT_WOBBLE_TYPE = ASSET_EFFECT_TYPE_VALUES[1];

export function buildWobbleOptions(ep: Record<string, unknown>): GsplatWobbleOptions {
    const opts: GsplatWobbleOptions = {};
    if (typeof ep.continuousRender === 'boolean') opts.continuousRender = ep.continuousRender;
    if (typeof ep.amplitude === 'number') {
        opts.amplitude = ep.amplitude;
    } else if (typeof ep.electronicYawAmplitude === 'number') {
        // backward compatible: old 1.0 ~= new amplitude 0.3
        opts.amplitude = Math.max(0, ep.electronicYawAmplitude) * 0.3;
    }
    if (ep.wobbleAxis === 'x' || ep.wobbleAxis === 'z') opts.wobbleAxis = ep.wobbleAxis;
    if (ep.motionMode === 'wobble' || ep.motionMode === 'electronic' || ep.motionMode === 'deepMeditation') {
        opts.motionMode = ep.motionMode;
    }
    if (typeof ep.frequency === 'number') opts.frequency = ep.frequency;
    if (typeof ep.heightScale === 'number') opts.heightScale = ep.heightScale;
    if (typeof ep.bounceAmplitude === 'number') opts.bounceAmplitude = ep.bounceAmplitude;
    if (typeof ep.bounceFrequency === 'number') opts.bounceFrequency = ep.bounceFrequency;
    if (typeof ep.springOscillation === 'number') opts.springOscillation = ep.springOscillation;
    if (typeof ep.springDamping === 'number') opts.springDamping = ep.springDamping;
    if (typeof ep.springBlend === 'number') opts.springBlend = ep.springBlend;
    if (typeof ep.cycleDuration === 'number') opts.cycleDuration = ep.cycleDuration;
    if (typeof ep.bounceDuration === 'number') opts.bounceDuration = ep.bounceDuration;
    if (typeof ep.bounceCount === 'number') opts.bounceCount = ep.bounceCount;
    if (typeof ep.colorMix === 'number') opts.colorMix = ep.colorMix;
    if (typeof ep.colorBandStart === 'number') opts.colorBandStart = ep.colorBandStart;
    if (typeof ep.colorBandEnd === 'number') opts.colorBandEnd = ep.colorBandEnd;
    if (Array.isArray(ep.goldColor) && ep.goldColor.length === 3) {
        opts.goldColor = ep.goldColor as [number, number, number];
    }
    if (typeof ep.haloWidth === 'number') opts.haloWidth = ep.haloWidth;
    if (typeof ep.haloSpeed === 'number') opts.haloSpeed = ep.haloSpeed;
    if (typeof ep.haloOpacity === 'number') opts.haloOpacity = ep.haloOpacity;
    if (typeof ep.bounceStretch === 'number') opts.bounceStretch = ep.bounceStretch;
    if (typeof ep.wobbleAnchorLift === 'number') opts.wobbleAnchorLift = ep.wobbleAnchorLift;
    if (typeof ep.anchorLift === 'number') opts.anchorLift = ep.anchorLift;
    return opts;
}

export function buildMorphOptions(ep: Record<string, unknown>): GsplatMorphOptions {
    const opts: GsplatMorphOptions = {
        segmentDuration: typeof ep.segmentDuration === 'number' ? ep.segmentDuration : undefined,
        segmentHoldDuration: typeof ep.segmentHoldDuration === 'number' ? ep.segmentHoldDuration : undefined,
        loop: typeof ep.loop === 'boolean' ? ep.loop : undefined,
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
            typeof ep.progressivePairFlightWindow === 'number' ? ep.progressivePairFlightWindow : 0.55,
        progressivePairFlightStagger:
            typeof ep.progressivePairFlightStagger === 'number' ? ep.progressivePairFlightStagger : 0.48,
        progressivePairDissolveALeaveScale:
            typeof ep.progressivePairDissolveALeaveScale === 'number' ? ep.progressivePairDissolveALeaveScale : 1.32,
        progressivePairDissolveARate:
            typeof ep.progressivePairDissolveARate === 'number' ? ep.progressivePairDissolveARate : 1.24,
        progressivePairArrivePhaseScale:
            typeof ep.progressivePairArrivePhaseScale === 'number' ? ep.progressivePairArrivePhaseScale : 0.52,
        progressivePairDissolveBArriveScale:
            typeof ep.progressivePairDissolveBArriveScale === 'number' ? ep.progressivePairDissolveBArriveScale : 1.12,
        correspondenceStrategy:
            ep.correspondenceStrategy === 'resample' || ep.correspondenceStrategy === 'axis' || ep.correspondenceStrategy === 'greedy'
                ? ep.correspondenceStrategy
                : 'axis',
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
    }

    dispose() {
        if (this._disposed) {
            return;
        }
        this._disposed = true;
        this._global.events.off('assetEffect:start', this._onStart);
        this._global.events.off('assetEffect:stop', this._onStop);
        this._global.events.off('assetEffect:configChanged', this._onConfigChanged);
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
            }
        };

        try {
            const morph = await loadGsplatMorphSequence(this._app, urls, morphOpts);
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
