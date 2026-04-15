import type { AssetLibraryItem, Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';

class AssetFacade implements ModuleFacade {
    readonly module = 'asset' as const;

    private resolveSceneEntityId(
        ctx: ModuleContext,
        id: string | null | undefined
    ): string | null {
        if (typeof id !== 'string' || id.trim().length === 0) return null;
        const list = ctx.state.scenePlacedEntities ?? [];
        const bySceneId = list.find((it) => it?.id === id);
        if (bySceneId) return bySceneId.id;
        return null;
    }

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
        const { state, events } = ctx;
        const src: SelectionSource = command.source ?? 'host';

        switch (command.type) {
        case 'ASSET_SELECT': {
            const id = (command.payload as { id?: string | null } | undefined)?.id ?? null;
            const resolvedId = this.resolveSceneEntityId(ctx, id);
            this.selectById(ctx, resolvedId, src);
            break;
        }
        case 'ASSET_PLACE': {
            const payload = command.payload as { value?: unknown; sceneEntityId?: string } | undefined;
            const raw = payload?.value;
            if (!raw || typeof raw !== 'object') return;
            const incoming = raw as { id?: string; sceneEntityId?: string } & Partial<AssetLibraryItem>;
            let value: AssetLibraryItem | null = null;
            if (incoming.id && Array.isArray(state.uploadedAssets)) {
                value = (state.uploadedAssets as AssetLibraryItem[]).find((it) => it.id === incoming.id) ?? null;
            }
            const finalValue = value ?? (raw as AssetLibraryItem);
            // sceneEntityId 与资产库 item.id 语义不同：
            // - item.id：资产库条目 id（可重复用于多次放置）
            // - sceneEntityId：场景内实例 id（必须唯一，未显式提供时由放置链路生成）
            const sceneEntityId =
                typeof payload?.sceneEntityId === 'string' && payload.sceneEntityId.trim().length > 0
                    ? payload.sceneEntityId
                    : (typeof incoming.sceneEntityId === 'string' && incoming.sceneEntityId.trim().length > 0
                        ? incoming.sceneEntityId
                        : undefined);
            events.fire('assetPlacement:place', { value: finalValue, sceneEntityId });
            break;
        }
        case 'ASSET_SHOW_HIDE_SET': {
            const pl = command.payload as { id?: string; value?: boolean } | undefined;
            if (!Array.isArray(state.scenePlacedEntities) || typeof pl?.id !== 'string' || typeof pl?.value !== 'boolean') {
                return;
            }
            const entry = state.scenePlacedEntities.find((it) => it?.id === pl.id);
            if (!entry?.entity || entry.visible === pl.value) return;
            entry.visible = pl.value;
            entry.entity.enabled = pl.value;
            break;
        }
        case 'ASSETS_SHOW_HIDE_SET': {
            const visible = (command.payload as { value?: boolean } | undefined)?.value;
            if (typeof visible !== 'boolean' || !Array.isArray(state.scenePlacedEntities)) return;
            let anyChanged = false;
            for (const item of state.scenePlacedEntities) {
                if (!item?.entity || item.visible === visible) continue;
                item.visible = visible;
                item.entity.enabled = visible;
                anyChanged = true;
            }
            if (!anyChanged) return;
            break;
        }
        case 'ASSET_COPY': {
            const pl = command.payload as { id?: string; copyId?: string } | undefined;
            if (typeof pl?.id !== 'string' || typeof pl?.copyId !== 'string' || pl.copyId.trim().length === 0) return;
            const resolvedId = this.resolveSceneEntityId(ctx, pl.id);
            if (!resolvedId) return;
            state.selectedSceneEntityId = resolvedId;
            events.fire('sceneAsset:selected', { source: src });
            events.fire('assetEdit:copy', { copyId: pl.copyId });
            break;
        }
        case 'ASSET_DELETE': {
            const id = (command.payload as { id?: string } | undefined)?.id;
            if (typeof id !== 'string') return;
            const resolvedId = this.resolveSceneEntityId(ctx, id);
            if (!resolvedId) return;
            state.selectedSceneEntityId = resolvedId;
            events.fire('sceneAsset:selected', { source: src });
            events.fire('assetEdit:delete');
            break;
        }
        case 'ASSET_TRANSFORM_MODE': {
            const value = (command.payload as { value?: 'move' | 'rotate' | 'scale' } | undefined)?.value;
            if (value === 'move' || value === 'rotate' || value === 'scale') {
                state.assetTransformMode = value;
                events.fire('assetTransformMode:changed', value);
            } else {
                state.assetTransformMode = undefined;
                events.fire('assetTransformMode:changed', undefined as any);
            }
            break;
        }
        default:
            break;
        }
    }

    selectById(ctx: ModuleContext, id: string | null, source: 'host' | 'scene' | 'unknown'): void {
        if (id === null) {
            ctx.state.selectedSceneEntityId = null;
            ctx.events.fire('sceneAsset:selected', { source });
            return;
        }
        const list = ctx.state.scenePlacedEntities ?? [];
        const exists = list.some((it) => it?.id === id);
        if (!exists) return;
        ctx.state.selectedSceneEntityId = id;
        ctx.events.fire('sceneAsset:selected', { source });
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
