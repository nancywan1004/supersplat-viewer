import { applyVfxExit, applyVfxTypeSet } from './protocol-adapters/effects-protocol-adapter';
import type { Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';

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

    handleCommand(ctx: ModuleContext, command: ModuleCommand): void {
        const { global, events } = ctx;
        switch (command.type) {
        case 'VFX_TYPE_SET':
            if (typeof command.payload === 'string') {
                applyVfxTypeSet(global, command.payload);
            }
            break;
        case 'VFX_EXIT':
            applyVfxExit(global);
            break;
        case 'VFX_RESTART': {
            const restartAnim = (command.payload as { restartAnim?: boolean } | undefined)?.restartAnim !== false;
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

const initEffectsFacade = (global: Global): ModuleFacade => {
    const facade = new EffectsFacade();
    const orchestrator = (global as any).__moduleOrchestrator as { registerFacade: (f: ModuleFacade) => void } | undefined;
    orchestrator?.registerFacade(facade);
    (global as any).__effectsFacade = facade;
    (global as any).__commandRegistry?.register?.('effects', facade);
    return facade;
};

export { EffectsFacade, initEffectsFacade };
