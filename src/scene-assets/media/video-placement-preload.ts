import {
    mountPlacedVideoToDom,
    unmountPlacedVideoFromDom,
    awaitPlacedVideoFirstFrame,
    PLACED_VIDEO_PLACEMENT_TIMEOUT_MS
} from './video-texture';

export type VideoPlacementPreloadHandle = {
    url: string;
    ready: Promise<HTMLVideoElement>;
    cancel: () => void;
};

let activePreload: VideoPlacementPreloadHandle | null = null;

/** 进入视频放置模式时提前拉流，减少点击后等待 */
export function startVideoPlacementPreload(url: string): VideoPlacementPreloadHandle {
    cancelVideoPlacementPreload();

    const video = document.createElement('video');
    let cancelled = false;

    const ready = awaitPlacedVideoFirstFrame(video, url, PLACED_VIDEO_PLACEMENT_TIMEOUT_MS)
        .then(() => {
            if (cancelled) {
                throw new Error('[VideoPlacementPreload] cancelled');
            }
            return video;
        })
        .catch((err) => {
            if (!cancelled) {
                console.warn('[VideoPlacementPreload] failed:', url, err);
                if (activePreload === handle) {
                    activePreload = null;
                }
            }
            throw err;
        });

    const handle: VideoPlacementPreloadHandle = {
        url,
        ready,
        cancel: () => {
            if (cancelled) return;
            cancelled = true;
            activePreload = null;
            unmountPlacedVideoFromDom(video);
        }
    };

    activePreload = handle;
    return handle;
}

export function cancelVideoPlacementPreload(): void {
    activePreload?.cancel();
    activePreload = null;
}

/**
 * 优先复用放置预热的 video；无预热则现场加载。
 * 成功后从 preload 槽位移除，避免 cancel 误销毁已放置实体上的元素。
 */
export async function acquirePlacedVideoForPlacement(
    url: string,
    timeoutMs: number = PLACED_VIDEO_PLACEMENT_TIMEOUT_MS
): Promise<HTMLVideoElement> {
    if (activePreload?.url === url) {
        const handle = activePreload;
        activePreload = null;
        try {
            return await handle.ready;
        } catch (err) {
            handle.cancel();
            throw err;
        }
    }

    const video = document.createElement('video');
    await awaitPlacedVideoFirstFrame(video, url, timeoutMs);
    return video;
}

export function isVideoPlacementPreloading(url?: string): boolean {
    if (!activePreload) return false;
    if (url && activePreload.url !== url) return false;
    return true;
}
