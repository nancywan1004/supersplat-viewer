import type { AppBase, Asset } from 'playcanvas';
import type { AssetLibraryItem, AssetLibraryType, Global } from '../types';
import { loadGsplatAsset } from './gsplat-asset-loader';

export const DEFAULT_ASSET_LOAD_TIMEOUT_MS = 15000;
// 导出链路等待“资产全就绪”时的默认超时，避免无穷等待。
const DEFAULT_WAIT_ALL_READY_TIMEOUT_MS = 30000;
type AssetReadyTaskSource = 'mainScene' | 'sceneAssets' | 'placement';

type SceneAssetRecord = {
    type?: AssetLibraryType;
    name?: string;
    thumbnailUrl?: string;
    source?: {
        assetId?: string;
        url?: string;
        filename?: string;
    };
};

type AssetReadyState = {
    pendingCount: number;
    readyCount: number;
    doneCount: number;
    failedCount: number;
    allReady: boolean;
    sourcePending: Record<AssetReadyTaskSource, number>;
    // 最近一次 ready 计数变更时间（Date.now 毫秒），用于状态观测与调试。
    lastChangeAtMs: number;
};

type AssetLoaderApi = {
    // 将任意加载 Promise 纳入统一 ready 统计，并自动触发 ready 事件。
    trackPromise<T>(source: AssetReadyTaskSource, label: string, promise: Promise<T>): Promise<T>;
    // 等待当前 pending 任务归零；超时时返回 timedOut=true 并抛出 assets:waitTimeout 事件。
    waitAllReady(timeoutMs?: number): Promise<{ timedOut: boolean; waitMs: number }>;
    getReadyState(): AssetReadyState;
};

type AssetLoaderGlobal = Global & { __assetLoader?: AssetLoaderApi };

const initialReadyState = (): AssetReadyState => ({
    pendingCount: 0,
    readyCount: 0,
    doneCount: 0,
    failedCount: 0,
    allReady: true,
    sourcePending: {
        mainScene: 0,
        sceneAssets: 0,
        placement: 0
    },
    lastChangeAtMs: Date.now()
});

const cloneReadyState = (state: AssetReadyState): AssetReadyState => ({
    pendingCount: state.pendingCount,
    readyCount: state.readyCount,
    doneCount: state.doneCount,
    failedCount: state.failedCount,
    allReady: state.allReady,
    sourcePending: { ...state.sourcePending },
    lastChangeAtMs: state.lastChangeAtMs
});

export function getAssetLoader(global: Global): AssetLoaderApi {
    const scopedGlobal = global as AssetLoaderGlobal;
    if (scopedGlobal.__assetLoader) {
        return scopedGlobal.__assetLoader;
    }

    const state = initialReadyState();
    const { events } = global;

    const emitReadyStateChanged = () => {
        state.lastChangeAtMs = Date.now();
        state.allReady = state.pendingCount === 0;
        // 每次计数变化都发快照，便于 UI/导出链路观察状态。
        events.fire('assets:readyStateChanged', cloneReadyState(state));
        if (state.allReady) {
            // allReady 是 readyStateChanged 的“边沿事件”，用于 waitAllReady 快速收敛。
            events.fire('assets:allReady', cloneReadyState(state));
        }
    };

    const api: AssetLoaderApi = {
        async trackPromise<T>(source: AssetReadyTaskSource, _label: string, promise: Promise<T>): Promise<T> {
            state.pendingCount += 1;
            state.sourcePending[source] += 1;
            emitReadyStateChanged();
            try {
                const value = await promise;
                state.readyCount += 1;
                return value;
            } catch (error) {
                state.failedCount += 1;
                throw error;
            } finally {
                // 无论成功/失败都必须回收 pending，确保聚合计数不会泄漏。
                state.pendingCount = Math.max(0, state.pendingCount - 1);
                state.doneCount += 1;
                state.sourcePending[source] = Math.max(0, state.sourcePending[source] - 1);
                emitReadyStateChanged();
            }
        },
        async waitAllReady(timeoutMs: number = DEFAULT_WAIT_ALL_READY_TIMEOUT_MS): Promise<{ timedOut: boolean; waitMs: number }> {
            if (state.pendingCount === 0) {
                return { timedOut: false, waitMs: 0 };
            }
            const waitStartMs = Date.now();
            return new Promise((resolve) => {
                let settled = false;
                const cleanup = () => {
                    events.off('assets:allReady', handleAllReady);
                    window.clearTimeout(timer);
                };
                const finish = (timedOut: boolean) => {
                    if (settled) return;
                    settled = true;
                    cleanup();
                    const waitMs = Date.now() - waitStartMs;
                    if (timedOut) {
                        events.fire('assets:waitTimeout', {
                            timeoutMs,
                            waitMs,
                            readyState: cloneReadyState(state)
                        });
                    }
                    resolve({ timedOut, waitMs });
                };
                const handleAllReady = () => finish(false);
                const timer = window.setTimeout(() => finish(true), timeoutMs);
                events.on('assets:allReady', handleAllReady);
            });
        },
        getReadyState(): AssetReadyState {
            return cloneReadyState(state);
        }
    };

    scopedGlobal.__assetLoader = api;
    return api;
}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`[AssetLoader] ${label} timeout (${timeoutMs}ms)`));
        }, timeoutMs);
        promise.then((value) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            resolve(value);
        }).catch((error) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            reject(error);
        });
    });
}

async function loadMeshAsset(app: AppBase, url: string, timeoutMs: number): Promise<Asset> {
    const meshAssetLoad = new Promise<Asset>((resolve, reject) => {
        let settled = false;
        const timer = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`[AssetLoader] mesh load timeout (${timeoutMs}ms): ${url}`));
        }, timeoutMs);

        (app.assets as any).loadFromUrl(url, 'container', (err: Error | null, loadedAsset: Asset | null) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            if (err || !loadedAsset) {
                reject(err ?? new Error('container asset missing'));
                return;
            }
            resolve(loadedAsset);
        });
    });

    // 外层再包一层保险超时，防止底层回调漏回导致悬挂。
    return withTimeout(meshAssetLoad, timeoutMs + 1000, 'mesh hydrate');
}

async function loadTypedAsset(app: AppBase, type: AssetLibraryType, url: string, filename: string, timeoutMs: number): Promise<Asset | undefined> {
    if (type === 'gaussian') {
        return loadGsplatAsset(app, { url, filename } as any);
    }
    if (type === 'mesh') {
        return loadMeshAsset(app, url, timeoutMs);
    }
    if (type === 'video' || type === 'audio') {
        return undefined;
    }
    return undefined;
}

export async function hydrateAssetLibraryItem(
    global: Global,
    item: AssetLibraryItem,
    timeoutMs: number = DEFAULT_ASSET_LOAD_TIMEOUT_MS
): Promise<AssetLibraryItem | null> {
    // image / video / audio 在放置时即时加载，不进入预加载/ready 聚合。
    if (item.type === 'image' || item.type === 'video' || item.type === 'audio') return item;
    if (item.asset) return item;

    const url = item.url || item.filename;
    if (!url) return null;

    try {
        const { app } = global;
        const filename = item.filename ?? url;
        const assetLoader = getAssetLoader(global);
        const asset = await assetLoader.trackPromise(
            'placement',
            `hydrate:${item.type}`,
            loadTypedAsset(app, item.type, url, filename, timeoutMs)
        );
        if (!asset) return item;
        return { ...item, asset, filename, url };
    } catch {
        return null;
    }
}

export async function loadSceneAssetLibraryItem(
    global: Global,
    sceneAsset: SceneAssetRecord,
    nextSceneEntityId: () => string,
    timeoutMs: number = DEFAULT_ASSET_LOAD_TIMEOUT_MS
): Promise<AssetLibraryItem | null> {
    const { app } = global;
    const type = sceneAsset.type;
    if (!type) return null;

    const src = sceneAsset.source ?? {};
    const url = src.url ?? src.filename;
    if (!url) return null;

    const filename = src.filename ?? url;
    const base: AssetLibraryItem = {
        id: src.assetId ?? nextSceneEntityId(),
        type,
        name: sceneAsset.name ?? src.filename ?? type,
        filename,
        url,
        thumbnailUrl: sceneAsset.thumbnailUrl
    };

    // image / video / audio 恢复不做预下载，仅构造 item 交给放置阶段处理。
    if (type === 'image' || type === 'video' || type === 'audio') {
        return base;
    }

    const asset = await getAssetLoader(global).trackPromise(
        'sceneAssets',
        `sceneAssets:${type}`,
        loadTypedAsset(app, type, url, filename, timeoutMs)
    );
    if (!asset) return null;
    return { ...base, asset };
}
