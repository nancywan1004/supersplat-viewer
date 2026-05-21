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
} from '../../gsplat-morph';
import {
    createGsplatWobbleEffect,
    GsplatWobbleEffect,
    removeGsplatWobbleEffect,
    type GsplatWobbleOptions
} from '../../gsplat-wobble';
import { ASSET_EFFECT_TYPE_VALUES, type AssetEffectType } from '../effect-types';
import type { AssetEffectStartEntities } from './asset-effect-entity';
import {
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
    if (typeof ep.amplitude === 'number') opts.amplitude = ep.amplitude;
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
    if (typeof ep.bounceStretch === 'number') opts.bounceStretch = ep.bounceStretch;
    if (typeof ep.wobbleAnchorLift === 'number') opts.wobbleAnchorLift = ep.wobbleAnchorLift;
    if (typeof ep.anchorLift === 'number') opts.anchorLift = ep.anchorLift;
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
        if (!entry || entry.type !== GSPLAT_WOBBLE_TYPE) {
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
        if (!urls) {
            const msg =
                'gsplat-morph requires effectParams.keyframeEntityIds (≥2) or keyframeUrls (≥2)';
            console.warn('[AssetEffectsController]', msg, { targetId });
            this._setError('MORPH_KEYFRAMES_REQUIRED', msg, GSPLAT_MORPH_TYPE, targetId);
            patchAssetRuntimeMirror(this._global.state, targetId, { status: 'inactive' });
            return;
        }

        const morphOpts: GsplatMorphOptions = {
            segmentDuration: typeof ep.segmentDuration === 'number' ? ep.segmentDuration : undefined,
            loop: typeof ep.loop === 'boolean' ? ep.loop : undefined,
            autoPlay: typeof ep.autoPlay === 'boolean' ? ep.autoPlay : true,
            morphPresentMaxHz: typeof ep.morphPresentMaxHz === 'number' ? ep.morphPresentMaxHz : undefined,
            morphAnimateSphericalHarmonics:
                typeof ep.morphAnimateSphericalHarmonics === 'boolean' ? ep.morphAnimateSphericalHarmonics : undefined,
            preferGpuMorph: typeof ep.preferGpuMorph === 'boolean' ? ep.preferGpuMorph : undefined,
            recenterModels: typeof ep.recenterModels === 'boolean' ? ep.recenterModels : undefined,
            normalizeScales: typeof ep.normalizeScales === 'boolean' ? ep.normalizeScales : undefined,
            targetScale: typeof ep.targetScale === 'number' ? ep.targetScale : undefined,
            sortCentersMaxHz: typeof ep.sortCentersMaxHz === 'number' ? ep.sortCentersMaxHz : undefined,
            fastQuaternionNlerp: typeof ep.fastQuaternionNlerp === 'boolean' ? ep.fastQuaternionNlerp : undefined,
            correspondenceStrategy:
                ep.correspondenceStrategy === 'greedy' || ep.correspondenceStrategy === 'resample'
                    ? ep.correspondenceStrategy
                    : undefined,
            greedySpatialWeight: typeof ep.greedySpatialWeight === 'number' ? ep.greedySpatialWeight : undefined,
            greedyColorWeight: typeof ep.greedyColorWeight === 'number' ? ep.greedyColorWeight : undefined,
            greedyGridCellSize: typeof ep.greedyGridCellSize === 'number' ? ep.greedyGridCellSize : undefined,
            greedySearchRadiusCells: typeof ep.greedySearchRadiusCells === 'number' ? ep.greedySearchRadiusCells : undefined,
            greedyMaxCandidatesPerPoint: typeof ep.greedyMaxCandidatesPerPoint === 'number' ? ep.greedyMaxCandidatesPerPoint : undefined,
            entityName: typeof ep.entityName === 'string' ? ep.entityName : `morph-${targetId}`
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
