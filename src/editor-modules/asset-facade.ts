import type { AssetLibraryItem, Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';
import { setPlacementCursorActive } from '../placement-cursor';
import { loadGsplatAsset } from '../loaders/gsplat-asset-loader';

class AssetFacade implements ModuleFacade {
    readonly module = 'asset' as const;
    private detachSceneAssetPlacedListener: (() => void) | null = null;
    // 当前下载的取消控制器（用于模块退出时中断下载）
    private currentDownloadAbort: (() => void) | null = null;

    setSceneAssetPlacedListenerCleanup(cleanup: () => void): void {
        this.detachSceneAssetPlacedListener = cleanup;
    }

    // 下载并预加载资产，返回带 asset 的完整 item
    private async hydrateAssetForPlacement(
        global: Global,
        item: AssetLibraryItem
    ): Promise<AssetLibraryItem | null> {
        // image 不需要预下载（在 place 时异步加载）
        if (item.type === 'image') return item;

        // 已有 asset 直接返回
        if (item.asset) return item;

        const url = item.url || item.filename;
        if (!url) {
            console.warn('[AssetFacade] protocol place missing url for', item.type);
            return null;
        }

        const app = global.app;

        try {
            if (item.type === 'gaussian') {
                const asset = await loadGsplatAsset(app, {
                    url,
                    filename: item.filename ?? url
                } as any);
                return { ...item, asset, filename: item.filename ?? url, url };
            }

            if (item.type === 'mesh') {
                const asset = await new Promise<any>((resolve, reject) => {
                    const onLoad = (err: Error | null, loadedAsset: any) => {
                        if (err || !loadedAsset) {
                            reject(err ?? new Error('container asset missing'));
                            return;
                        }
                        resolve(loadedAsset);
                    };

                    // 注册取消回调，用于中断下载
                    this.currentDownloadAbort = () => {
                        reject(new Error('download cancelled'));
                    };

                    (app.assets as any).loadFromUrl(url, 'container', onLoad);
                });
                return { ...item, asset, filename: item.filename ?? url, url };
            }
        } catch (err) {
            console.warn('[AssetFacade] asset hydrate failed:', item.type, url, err);
            return null;
        }

        return item;
    }

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
        // 进入 asset 模块默认不选中任何资产（保持 null）
        if (state.selectedSceneEntityId) {
            state.selectedSceneEntityId = null;
            events.fire('sceneAsset:selected');
        }
        state.assetTransformMode = 'move';
        events.fire('assetTransformMode:changed', 'move');
        events.fire('assetFacade:enter');
    }

    onExit(ctx: ModuleContext): void {
        const { state, events } = ctx;

        // 退出模块时取消正在进行的下载
        if (this.currentDownloadAbort) {
            this.currentDownloadAbort();
            this.currentDownloadAbort = null;
        }

        setPlacementCursorActive(ctx.global, false);
        if (state.selectedSceneEntityId) {
            state.selectedSceneEntityId = null;
            events.fire('sceneAsset:selected');
        }
        state.assetTransformMode = 'move';
        events.fire('assetTransformMode:changed', 'move');
        events.fire('assetFacade:exit');
    }

    onEditModeExit(ctx: ModuleContext): void {
        this.onExit(ctx);
        ctx.events.fire('assetFacade:editModeExit');
    }

    onPreviewModeChanged(_ctx: ModuleContext): void {}

    dispose(): void {
        this.detachSceneAssetPlacedListener?.();
        this.detachSceneAssetPlacedListener = null;
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
            void this.handleAssetPlace(ctx, command);
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
            // TODO: 临时方案 - ASSETS_SHOW_HIDE_SET 同时控制所有标注显隐（仅在 View 模式生效）
            // 通过事件驱动方式通知 annotation 模块，后续可能根据设计重构解耦
            ctx.events.fire('assets:allVisibilityChanged', { visible });
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

    // 处理 ASSET_PLACE 命令：先下载资产，完成后再激活放置
    private async handleAssetPlace(ctx: ModuleContext, command: ModuleCommand): Promise<void> {
        const { state, events } = ctx;
        const payload = command.payload as { value?: unknown } | undefined;
        const raw = payload?.value;
        if (!raw || typeof raw !== 'object') return;

        const incoming = raw as { id?: string } & Partial<AssetLibraryItem>;
        let value: AssetLibraryItem | null = null;
        if (incoming.id && Array.isArray(state.uploadedAssets)) {
            value = (state.uploadedAssets as AssetLibraryItem[]).find((it) => it.id === incoming.id) ?? null;
        }
        const finalValue = value ?? (raw as AssetLibraryItem);

        // 立即显示 loading 光标，进入 downloading 状态（禁用放置点击）
        setPlacementCursorActive(ctx.global, true, { loading: true });

        // 下载资产
        const hydrated = await this.hydrateAssetForPlacement(ctx.global, finalValue);

        // 下载完成或失败，清理取消回调
        this.currentDownloadAbort = null;

        if (!hydrated) {
            // 下载失败，恢复光标并终止流程
            setPlacementCursorActive(ctx.global, false);
            console.warn('[AssetFacade] asset download failed, abort placement');
            return;
        }

        // 下载成功，切换到 awaitingPlacement 状态（正常放置光标，允许点击）
        setPlacementCursorActive(ctx.global, true, { loading: false });

        // 发送放置开始事件，携带已下载的资产
        events.fire('assetPlacement:start', { value: hydrated });
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
    const onSceneAssetPlaced = () => {
        setPlacementCursorActive(global, false);
    };
    global.events.on('sceneAsset:placed', onSceneAssetPlaced);
    facade.setSceneAssetPlacedListenerCleanup(() => {
        global.events.off('sceneAsset:placed', onSceneAssetPlaced);
    });
    const orchestrator = (global as any).__moduleOrchestrator as { registerFacade: (f: ModuleFacade) => void } | undefined;
    orchestrator?.registerFacade(facade);
    (global as any).__assetFacade = facade;
    (global as any).__commandRegistry?.register?.('asset', facade);
    return facade;
};

export { AssetFacade, initAssetFacade };
