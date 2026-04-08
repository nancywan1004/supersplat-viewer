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
        // phase-c 先收口生命周期，命令逻辑仍由既有 adapter/bridge 承担，避免重复派发
        if (command.type && ctx.editMode !== undefined) return;
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
