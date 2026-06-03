import {
    applyAssetEffectDelete,
    applyAssetEffectParamsPatch,
    applyAssetEffectStart,
    readAssetEffectInstanceForTarget,
    applyAssetEffectStop,
    isAssetEffectProtocolEnvelope,
    normalizeAssetEffectEnvelope
} from './protocol-adapters/asset-effects-protocol-adapter';
import {
    applyGsplatRevealParamsPatch,
    applyGsplatRevealEffectAdd,
    applyGsplatRevealEffectDelete,
    applyGsplatPersistentParamsPatch,
    isPersistentProtocolEffectId,
    applyGsplatPersistentEffectAddForId,
    applyGsplatPersistentEffectDeleteForId,
    isEffectProtocolEnvelope,
    paramsPatchHasRevealKeys,
    paramsPatchHasPersistentKeys,
    SCENE_GSPLAT_REVEAL_EFFECT_ID
} from './protocol-adapters/effects-protocol-adapter';
import {
    ASSET_GSPLAT_EFFECT_ID,
    resolveAssetEffectType
} from '../vfx/effects-runtime/effect-types';
import {
    patchAssetRuntimeMirror,
    patchAssetInstanceFromParams,
    readRevealParams,
    syncEffectsRuntimeStateFromSettings
} from '../settings-serialize/effects-sync';
import { isPersistentVfx } from '../vfx/effects-runtime/reveal/reveal-policy';
import type {
    Global,
    ModuleCommand,
    ModuleContext,
    ModuleFacade,
    ModuleLifecycleReason,
    SelectionSource
} from '../types';

/**
 * 与 `message-bridge` 中 `dispatchEffects` 同路径：经 `CommandRegistry` → `EffectsFacade.handleCommand`。
 * 供 internal 编辑 UI 直接调用，避免与协议路径分叉。
 */
function dispatchEffectsModuleCommand(global: Global, command: ModuleCommand): boolean {
    const registry = (global as any).__commandRegistry as
        | { dispatch: (input: { module: 'effects'; command: ModuleCommand }) => boolean }
        | undefined;
    if (!registry) {
        console.warn('[EffectsFacade] dispatchEffectsModuleCommand: command registry not initialized');
        return false;
    }
    return registry.dispatch({ module: 'effects', command });
}

class EffectsFacade implements ModuleFacade {
    readonly module = 'effects' as const;

    onEnter(ctx: ModuleContext): void {
        ctx.events.fire('effectsFacade:enter');
    }

    onExit(ctx: ModuleContext): void {
        ctx.events.fire('effectsFacade:exit');
    }

    onEditModeExit(ctx: ModuleContext): void {
        // 保持现有产品语义：退出编辑模式不隐式改写 revealEffect.type
        ctx.events.fire('effectsFacade:editModeExit');
    }

    onPreviewModeChanged(_ctx: ModuleContext, _previewMode: boolean): void {
        // effects 模块当前无 preview 可视化策略，预留钩子以便后续扩展。
    }

    handleCommand(ctx: ModuleContext, command: ModuleCommand): void {
        const { global, events } = ctx;
        switch (command.type) {
        case 'EFFECT_ADD': {
            const raw = command.payload;
            if (!raw || typeof raw !== 'object') break;
            const effectId = (raw as { effectId?: unknown }).effectId;
            const effectType = (raw as { effectType?: unknown }).effectType;
            const paramsRaw = (raw as { params?: unknown }).params;
            const params =
                paramsRaw && typeof paramsRaw === 'object' && !Array.isArray(paramsRaw) ?
                    (paramsRaw as Record<string, unknown>) :
                    {};
            if (typeof effectId !== 'string' || typeof effectType !== 'string') break;
            if (effectId === ASSET_GSPLAT_EFFECT_ID) {
                const targetId = (raw as { targetId?: unknown }).targetId;
                if (typeof targetId !== 'string') break;
                if (effectType === '') {
                    const current = readAssetEffectInstanceForTarget(global, targetId);
                    const runtimeType = global.state.effectsRuntimeState?.asset?.instances?.[targetId]?.activeType;
                    const stopType =
                        current?.type ??
                        (typeof runtimeType === 'string' ? runtimeType : null);
                    if (current) {
                        patchAssetInstanceFromParams(global.settings, targetId, { enabled: false });
                    }
                    syncEffectsRuntimeStateFromSettings(global.state, global.settings);
                    patchAssetRuntimeMirror(global.state, targetId, { status: 'inactive' });
                    if (stopType) {
                        applyAssetEffectStop(global, normalizeAssetEffectEnvelope({
                            effectId: ASSET_GSPLAT_EFFECT_ID,
                            targetId,
                            params: { type: stopType }
                        }));
                    }
                    break;
                }
                const current = readAssetEffectInstanceForTarget(global, targetId);
                const runtimeType = global.state.effectsRuntimeState?.asset?.instances?.[targetId]?.activeType;
                const stopType =
                    current?.type ??
                    (typeof runtimeType === 'string' ? runtimeType : null);
                if (stopType) {
                    applyAssetEffectStop(global, normalizeAssetEffectEnvelope({
                        effectId: ASSET_GSPLAT_EFFECT_ID,
                        targetId,
                        params: { type: stopType }
                    }));
                }
                applyAssetEffectStart(global, normalizeAssetEffectEnvelope({
                    effectId,
                    targetId,
                    params: { ...params, type: effectType, enabled: true, autoStart: true }
                }));
                break;
            }
            if (effectId === SCENE_GSPLAT_REVEAL_EFFECT_ID) {
                applyGsplatRevealEffectAdd(global, effectType);
                break;
            }
            if (!isPersistentProtocolEffectId(effectId)) break;
            applyGsplatPersistentEffectAddForId(global, effectId, effectType === '' ? 'none' : effectType);
            break;
        }
        case 'EFFECT_DELETE': {
            const raw = command.payload;
            if (!raw || typeof raw !== 'object') break;
            const effectId = (raw as { effectId?: unknown }).effectId;
            if (typeof effectId !== 'string') break;
            if (effectId === ASSET_GSPLAT_EFFECT_ID) {
                const targetId = (raw as { targetId?: unknown }).targetId;
                if (typeof targetId !== 'string' || targetId.length === 0) break;
                applyAssetEffectDelete(global, {
                    effectId,
                    targetId
                });
                break;
            }
            if (effectId === SCENE_GSPLAT_REVEAL_EFFECT_ID) {
                applyGsplatRevealEffectDelete(global);
                break;
            }
            if (isPersistentProtocolEffectId(effectId)) {
                const effectType = (raw as { effectType?: unknown }).effectType;
                applyGsplatPersistentEffectDeleteForId(global, effectId, typeof effectType === 'string' ? effectType : 'none');
            }
            break;
        }
        case 'EFFECT_PARAMS_PATCH': {
            const raw = command.payload;
            if (isAssetEffectProtocolEnvelope(raw)) {
                if (!resolveAssetEffectType(raw.effectId, raw.params)) break;
                applyAssetEffectParamsPatch(global, normalizeAssetEffectEnvelope(raw));
                break;
            }
            if (!isEffectProtocolEnvelope(raw)) break;
            const params = (raw as { params?: unknown }).params;
            if (typeof params !== 'object' || params === null) break;
            const pr = params as Record<string, unknown>;
            if (raw.effectId === SCENE_GSPLAT_REVEAL_EFFECT_ID) {
                if (!paramsPatchHasRevealKeys(pr)) break;
                applyGsplatRevealParamsPatch(global, pr);
            } else if (isPersistentProtocolEffectId(raw.effectId)) {
                if (!paramsPatchHasPersistentKeys(pr)) break;
                applyGsplatPersistentParamsPatch(global, pr, raw.effectId);
            } else {
                break;
            }
            break;
        }
        case 'EFFECT_START': {
            const raw = command.payload;
            if (!isAssetEffectProtocolEnvelope(raw)) break;
            if (!resolveAssetEffectType(raw.effectId, raw.params)) break;
            applyAssetEffectStart(global, normalizeAssetEffectEnvelope(raw));
            break;
        }
        case 'EFFECT_STOP': {
            const raw = command.payload;
            if (!isAssetEffectProtocolEnvelope(raw)) break;
            if (!resolveAssetEffectType(raw.effectId, raw.params)) break;
            applyAssetEffectStop(global, normalizeAssetEffectEnvelope(raw));
            break;
        }
        case 'EFFECT_TOGGLE': {
            const raw = command.payload;
            if (!isEffectProtocolEnvelope(raw)) break;
            if (!isPersistentProtocolEffectId(raw.effectId)) break;
            const params = (raw as { params?: unknown }).params;
            if (typeof params !== 'object' || params === null) break;
            const pr = params as Record<string, unknown>;
            if (!paramsPatchHasPersistentKeys(pr)) break;
            applyGsplatPersistentParamsPatch(global, pr, raw.effectId);
            break;
        }
        case 'EFFECT_REPLAY': {
            const raw = command.payload;
            if (!isEffectProtocolEnvelope(raw)) break;
            if (raw.effectId !== SCENE_GSPLAT_REVEAL_EFFECT_ID) break;
            const revealType = (readRevealParams(global.settings)?.type ?? 'none') as string;
            // EFFECT_REPLAY 仅对一次性 reveal 生效；persistent-only 场景应忽略。
            if (revealType === 'none' || isPersistentVfx(revealType)) break;
            const restartAnim = (raw as { restartAnim?: boolean }).restartAnim !== false;
            events.fire('revealRestart', restartAnim);
            break;
        }
        default:
            break;
        }
    }

    // effects 模块无实体 id 选中语义，保留空实现满足统一接口
    selectById(_ctx: ModuleContext, _id: string | null, _source: SelectionSource): void {}
}

/** 左侧「物体特效」模块门面：命令与场景特效共用 EffectsFacade，生命周期独立注册便于编排器切换。 */
class AssetEffectsFacade implements ModuleFacade {
    readonly module = 'assetEffects' as const;

    constructor(private readonly _sceneEffects: EffectsFacade) {}

    onEnter(ctx: ModuleContext): void {
        this._sceneEffects.onEnter(ctx);
        ctx.events.fire('assetEffectsFacade:enter');
    }

    onExit(ctx: ModuleContext, _reason?: ModuleLifecycleReason): void {
        this._sceneEffects.onExit(ctx);
        ctx.events.fire('assetEffectsFacade:exit');
    }

    onEditModeExit(ctx: ModuleContext): void {
        this._sceneEffects.onEditModeExit(ctx);
    }

    onPreviewModeChanged(ctx: ModuleContext, previewMode: boolean): void {
        this._sceneEffects.onPreviewModeChanged?.(ctx, previewMode);
    }

    handleCommand(ctx: ModuleContext, command: ModuleCommand): void {
        this._sceneEffects.handleCommand(ctx, command);
    }

    selectById(ctx: ModuleContext, id: string | null, source: SelectionSource): void {
        this._sceneEffects.selectById(ctx, id, source);
    }
}

const initEffectsFacade = (global: Global): ModuleFacade => {
    const facade = new EffectsFacade();
    const assetEffectsFacade = new AssetEffectsFacade(facade);
    const orchestrator = (global as any).__moduleOrchestrator as { registerFacade: (f: ModuleFacade) => void } | undefined;
    orchestrator?.registerFacade(facade);
    orchestrator?.registerFacade(assetEffectsFacade);
    (global as any).__effectsFacade = facade;
    (global as any).__assetEffectsFacade = assetEffectsFacade;
    (global as any).__commandRegistry?.register?.('effects', facade);
    return facade;
};

export { EffectsFacade, AssetEffectsFacade, initEffectsFacade, dispatchEffectsModuleCommand };
