import {
    applyGsplatRevealParamsPatch,
    applyGsplatRevealEffectAdd,
    applyGsplatRevealEffectDelete,
    applyGsplatPersistentParamsPatch,
    applyGsplatPersistentEffectAdd,
    applyGsplatPersistentEffectDelete,
    isEffectProtocolEnvelope,
    paramsPatchHasRevealKeys,
    paramsPatchHasPersistentKeys,
    SCENE_GSPLAT_REVEAL_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_EFFECT_ID
} from './protocol-adapters/effects-protocol-adapter';
import { readRevealParams } from '../settings-serialize/effects-sync';
import { isPersistentVfx } from '../vfx/effects-runtime/reveal/reveal-policy';
import type { Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';

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
        case 'EFFECT_PARAMS_PATCH': {
            const raw = command.payload;
            if (!isEffectProtocolEnvelope(raw)) break;
            const params = (raw as { params?: unknown }).params;
            if (typeof params !== 'object' || params === null) break;
            const pr = params as Record<string, unknown>;
            if (raw.effectId === SCENE_GSPLAT_REVEAL_EFFECT_ID) {
                if (!paramsPatchHasRevealKeys(pr)) break;
                applyGsplatRevealParamsPatch(global, pr);
            } else if (raw.effectId === SCENE_GSPLAT_PERSISTENT_EFFECT_ID) {
                if (!paramsPatchHasPersistentKeys(pr)) break;
                applyGsplatPersistentParamsPatch(global, pr);
            } else {
                break;
            }
            break;
        }
        case 'EFFECT_TOGGLE': {
            const raw = command.payload;
            if (!isEffectProtocolEnvelope(raw)) break;
            if (raw.effectId !== SCENE_GSPLAT_PERSISTENT_EFFECT_ID) break;
            const params = (raw as { params?: unknown }).params;
            if (typeof params !== 'object' || params === null) break;
            const pr = params as Record<string, unknown>;
            if (!paramsPatchHasPersistentKeys(pr)) break;
            applyGsplatPersistentParamsPatch(global, pr);
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
        case 'EFFECT_ADD': {
            const raw = command.payload;
            if (!isEffectProtocolEnvelope(raw)) break;
            const effectType = (raw as { effectType?: unknown }).effectType;
            if (typeof effectType !== 'string') break;
            if (raw.effectId === SCENE_GSPLAT_REVEAL_EFFECT_ID) {
                applyGsplatRevealEffectAdd(global, effectType);
            } else if (raw.effectId === SCENE_GSPLAT_PERSISTENT_EFFECT_ID) {
                applyGsplatPersistentEffectAdd(global, effectType);
            }
            break;
        }
        case 'EFFECT_DELETE': {
            const raw = command.payload;
            if (!isEffectProtocolEnvelope(raw)) break;
            if (raw.effectId === SCENE_GSPLAT_REVEAL_EFFECT_ID) {
                applyGsplatRevealEffectDelete(global);
            } else if (raw.effectId === SCENE_GSPLAT_PERSISTENT_EFFECT_ID) {
                const effectType = (raw as { effectType?: unknown }).effectType;
                if (typeof effectType !== 'string') break;
                applyGsplatPersistentEffectDelete(global, effectType);
            }
            break;
        }
        default:
            break;
        }
    }

    // effects 模块无实体 id 选中语义，保留空实现满足统一接口
    selectById(_ctx: ModuleContext, _id: string | null, _source: SelectionSource): void {}
}

const initEffectsFacade = (global: Global): ModuleFacade => {
    const facade = new EffectsFacade();
    const orchestrator = (global as any).__moduleOrchestrator as { registerFacade: (f: ModuleFacade) => void } | undefined;
    orchestrator?.registerFacade(facade);
    (global as any).__effectsFacade = facade;
    (global as any).__commandRegistry?.register?.('effects', facade);
    return facade;
};

export { EffectsFacade, initEffectsFacade, dispatchEffectsModuleCommand };
