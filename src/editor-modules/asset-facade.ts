import type { Global, ModuleCommand, ModuleContext, ModuleFacade } from '../types';

class AssetFacade implements ModuleFacade {
    readonly module = 'asset' as const;

    onEnter(ctx: ModuleContext): void {
        const { state, events } = ctx;
        const list = state.scenePlacedEntities ?? [];
        // 保持现有行为：进入 asset 时若未选中则默认选中第一个
        if (list.length > 0 && !state.selectedSceneEntityId) {
            state.selectedSceneEntityId = list[0].id;
            events.fire('sceneAsset:selected');
        }
        state.assetTransformMode = undefined;
        events.fire('assetTransformMode:changed', undefined as any);
        events.fire('assetFacade:enter');
    }

    onExit(ctx: ModuleContext): void {
        const { state, events } = ctx;
        if (state.selectedSceneEntityId) {
            state.selectedSceneEntityId = null;
            events.fire('sceneAsset:selected');
        }
        state.assetTransformMode = undefined;
        events.fire('assetTransformMode:changed', undefined as any);
        events.fire('assetFacade:exit');
    }

    onEditModeExit(ctx: ModuleContext): void {
        this.onExit(ctx);
        ctx.events.fire('assetFacade:editModeExit');
    }

    handleCommand(ctx: ModuleContext, command: ModuleCommand): void {
        if (command.type === 'ASSET_SELECT') {
            const id = (command.payload as any)?.id ?? null;
            this.selectById(ctx, id, command.source ?? 'unknown');
        }
    }

    selectById(ctx: ModuleContext, id: string | null, _source: 'host' | 'scene' | 'unknown'): void {
        ctx.state.selectedSceneEntityId = id;
        ctx.events.fire('sceneAsset:selected');
    }
}

const initAssetFacade = (global: Global): ModuleFacade => {
    const facade = new AssetFacade();
    const orchestrator = (global as any).__moduleOrchestrator as { registerFacade: (f: ModuleFacade) => void } | undefined;
    orchestrator?.registerFacade(facade);
    (global as any).__assetFacade = facade;
    (global as any).__commandRegistry?.register?.('asset', facade);
    return facade;
};

export { AssetFacade, initAssetFacade };
