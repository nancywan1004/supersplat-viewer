import { applySceneAssetTriggerDistanceM } from '../scene-assets/asset-placement-handler';
import { pauseAllSceneMedia, pauseSceneMediaEntry } from '../scene-assets/media/scene-media-playback';
import { applyViewerAssetShowHide } from '../scene-visibility/assets-visibility-facade';
import type { AssetLibraryItem, EditLeftModule, Global, ModuleCommand, ModuleContext, ModuleFacade, SelectionSource } from '../types';
import { setPlacementCursorActive } from '../placement-cursor';
import { loadGsplatAsset } from '../loaders/gsplat/sog/splat-loader';
import { getAssetLoader } from '../loaders/asset-loader';
import { loadContainerAsset } from '../loaders/gltf/container-loader';
import { asUserFile, assetLibraryHref, prepareAssetLibraryItemForPlacement, upsertUploadedAsset } from '../loaders/asset-file';
import { ingestAssetLibraryItemFile, resolveUserUploadResourceUrl } from '../settings-io/user-files';

class AssetFacade implements ModuleFacade {
    readonly module = 'asset' as const;
    private detachSceneAssetPlacedListener: (() => void) | null = null;
    private detachEditModuleListener: (() => void) | null = null;
    // 当前下载的取消控制器（用于模块退出时中断下载）
    private currentDownloadAbort: (() => void) | null = null;
    // 资产放置请求版本号（last request wins）
    private placeRequestVersion = 0;

    setSceneAssetPlacedListenerCleanup(cleanup: () => void): void {
        this.detachSceneAssetPlacedListener = cleanup;
    }

    // 下载并预加载资产，返回带 asset 的完整 item
    private async hydrateAssetForPlacement(
        global: Global,
        item: AssetLibraryItem
    ): Promise<AssetLibraryItem | null> {
        const prepared = await prepareAssetLibraryItemForPlacement(item);
        if (!prepared) return null;
        const ingested = ingestAssetLibraryItemFile(global, prepared);

        // image / video / audio 不需要预下载 PlayCanvas Asset
        if (ingested.type === 'image' || ingested.type === 'video' || ingested.type === 'audio') return ingested;

        // 已有 asset 直接返回
        if (ingested.asset) return ingested;

        const url = assetLibraryHref(ingested);
        if (!url) {
            console.warn('[AssetFacade] protocol place missing url for', ingested.type);
            return null;
        }
        const loadUrl = resolveUserUploadResourceUrl(global, url);
        if (!loadUrl) {
            console.warn('[AssetFacade] protocol place missing resolved url for', ingested.type, url);
            return null;
        }

        const app = global.app;
        const assetLoader = getAssetLoader(global);

        try {
            if (ingested.type === 'gaussian') {
                const asset = await assetLoader.trackPromise('placement', 'facade:gaussian', loadGsplatAsset(app, {
                    url: loadUrl,
                    filename: ingested.filename ?? url
                } as any));
                return { ...ingested, asset, filename: ingested.filename ?? url, src: ingested.src ?? url };
            }

            if (ingested.type === 'mesh') {
                const meshLoadPromise = loadContainerAsset(app, loadUrl, ingested.filename);
                const asset = await assetLoader.trackPromise('placement', 'facade:mesh', meshLoadPromise);
                return { ...ingested, asset, filename: ingested.filename ?? url, src: ingested.src ?? url };
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (message.includes('download cancelled')) {
                // 新放置请求或模块退出主动取消，不视为错误。
                return null;
            }
            console.warn('[AssetFacade] asset hydrate failed:', ingested.type, loadUrl, err);
            return null;
        }

        return ingested;
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

    private clearMorphAssetAdd(ctx: ModuleContext): void {
        ctx.state.morphAssetAddActive = false;
        setPlacementCursorActive(ctx.global, false);
    }

    /** 取消进行中的放置下载 / morph 拾取，并关闭放置光标（不触发完整 onExit 副作用）。 */
    private cancelActivePlacementWork(global: Global): void {
        this.placeRequestVersion++;
        if (this.currentDownloadAbort) {
            this.currentDownloadAbort();
            this.currentDownloadAbort = null;
        }
        global.state.morphAssetAddActive = false;
        setPlacementCursorActive(global, false);
    }

    bindEditModuleListener(global: Global): void {
        const onEditLeftModuleChanged = (mod: EditLeftModule | null) => {
            if (mod === 'asset') return;
            this.cancelActivePlacementWork(global);
        };
        global.events.on('editLeftModule:changed', onEditLeftModuleChanged);
        this.detachEditModuleListener = () => {
            global.events.off('editLeftModule:changed', onEditLeftModuleChanged);
        };
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
        this.cancelActivePlacementWork(ctx.global);
        pauseAllSceneMedia(ctx.global);
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
        this.detachEditModuleListener?.();
        this.detachEditModuleListener = null;
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
        case 'MORPH_ASSET_ADD_START':
            this.placeRequestVersion++;
            if (this.currentDownloadAbort) {
                this.currentDownloadAbort();
                this.currentDownloadAbort = null;
            }
            ctx.state.morphAssetAddActive = true;
            setPlacementCursorActive(ctx.global, true, { loading: false });
            break;
        case 'MORPH_ASSET_ADD_FINISH':
            this.clearMorphAssetAdd(ctx);
            break;
        case 'ASSET_SHOW_HIDE_SET': {
            const pl = command.payload as { id?: string; value?: boolean } | undefined;
            if (!Array.isArray(state.scenePlacedEntities) || typeof pl?.id !== 'string' || typeof pl?.value !== 'boolean') {
                return;
            }
            const entry = state.scenePlacedEntities.find((it) => it?.id === pl.id);
            if (!entry?.entity) return;
            if (ctx.global.state?.editMode === true) {
                if (entry.visible === pl.value) return;
                entry.visible = pl.value;
                entry.entity.enabled = pl.value;
                if (!pl.value) {
                    pauseSceneMediaEntry(ctx.global, entry);
                }
                return;
            }
            applyViewerAssetShowHide(ctx.global, pl.id, pl.value);
            if (!pl.value) {
                pauseSceneMediaEntry(ctx.global, entry);
            }
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
        case 'ASSET_VIDEO_CURVATURE_SET': {
            const pl = command.payload as { id?: string; value?: number } | undefined;
            if (typeof pl?.id !== 'string' || typeof pl?.value !== 'number') return;
            events.fire('assetEdit:videoCurvature', { id: pl.id, value: pl.value });
            break;
        }
        case 'ASSET_MEDIA_HOTSPOT_RANGE_SET': {
            const pl = command.payload as { id?: string; value?: number } | undefined;
            if (typeof pl?.id !== 'string' || typeof pl?.value !== 'number') return;
            applySceneAssetTriggerDistanceM(ctx.global, pl.id, pl.value);
            break;
        }
        default:
            break;
        }
    }

    // 处理 ASSET_PLACE 命令：先下载资产，完成后再激活放置
    private async handleAssetPlace(ctx: ModuleContext, command: ModuleCommand): Promise<void> {
        const { state, events } = ctx;
        // 新请求进来，先让旧请求失效（last request wins）
        const requestVersion = ++this.placeRequestVersion;
        const payload = command.payload as { value?: unknown } | undefined;
        const raw = payload?.value;
        if (!raw || typeof raw !== 'object') return;

        const incoming = raw as { id?: string } & Partial<AssetLibraryItem>;
        let libraryItem: AssetLibraryItem | null = null;
        if (incoming.id && Array.isArray(state.uploadedAssets)) {
            libraryItem = (state.uploadedAssets as AssetLibraryItem[]).find(it => it.id === incoming.id) ?? null;
        }
        let finalValue: AssetLibraryItem;
        if (libraryItem) {
            finalValue = {
                ...libraryItem,
                ...incoming,
                id: incoming.id || libraryItem.id,
                src: asUserFile(incoming.src) ?? incoming.src ?? libraryItem.src,
                asset: libraryItem.asset ?? incoming.asset
            };
        } else {
            finalValue = raw as AssetLibraryItem;
        }
        if (!finalValue.id || String(finalValue.id).trim().length === 0) {
            finalValue = {
                ...finalValue,
                id: `asset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`
            };
        }

        // 新请求到来时，主动取消上一个可取消下载（mesh）
        if (this.currentDownloadAbort) {
            this.currentDownloadAbort();
            this.currentDownloadAbort = null;
        }

        // 立即显示 loading 光标，进入 downloading 状态（禁用放置点击）
        setPlacementCursorActive(ctx.global, true, { loading: true });

        // 下载资产
        const hydrated = await this.hydrateAssetForPlacement(ctx.global, finalValue);

        // 若期间已有更新的请求，当前结果作废，避免“旧请求晚返回覆盖新请求”
        if (requestVersion !== this.placeRequestVersion) {
            return;
        }

        // 下载完成或失败，清理取消回调
        this.currentDownloadAbort = null;

        if (!hydrated) {
            // 下载失败，恢复光标并终止流程
            setPlacementCursorActive(ctx.global, false);
            console.warn('[AssetFacade] asset download failed, abort placement');
            return;
        }

        upsertUploadedAsset(ctx.global, hydrated);

        // 视频首帧由 placement-handler 预热并接管光标；其余类型此处切回可点击十字
        if (hydrated.type !== 'video') {
            setPlacementCursorActive(ctx.global, true, { loading: false });
        }

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
    facade.bindEditModuleListener(global);
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
