import type { AppBase, Entity, GraphicsDevice, StandardMaterial } from 'playcanvas';
import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR,
    PIXELFORMAT_RGBA8,
    StandardMaterial as StandardMaterialClass,
    Texture
} from 'playcanvas';

import type { PlacedVideoRuntime } from './media-runtime';

/** 与 PlayCanvas video-texture 示例一致：挂到 DOM 且不可见，否则部分浏览器（尤其移动端）不加载 */
const HIDDEN_VIDEO_STYLE =
    'display: block; width: 1px; height: 1px; position: absolute; opacity: 0; z-index: -1000; top: 0px; pointer-events: none';

/** 场景恢复 / 已预热失败后的兜底等待上限 */
export const PLACED_VIDEO_INITIAL_LOAD_TIMEOUT_MS = 45000;

/** 编辑放置模式：首帧预热与点击放置（远程大文件通常仍受网络限制） */
export const PLACED_VIDEO_PLACEMENT_TIMEOUT_MS = 20000;

const pendingTextureUploads = new Set<PlacedVideoRuntime>();
let textureUploadFlushRegistered = false;

function configurePlacedVideoElement(video: HTMLVideoElement): void {
    video.crossOrigin = 'anonymous';
    video.muted = true;
    video.loop = true;
    video.playsInline = true;
    video.setAttribute('playsinline', '');
    video.setAttribute('webkit-playsinline', '');
    video.preload = 'auto';
}

/**
 * 将 `<video>` 挂到 `document.body`（示例要求，便于解码与 autoplay 策略）。
 */
export function mountPlacedVideoToDom(video: HTMLVideoElement): void {
    video.setAttribute('style', HIDDEN_VIDEO_STYLE);
    if (!video.isConnected) {
        document.body.append(video);
    }
}

export function unmountPlacedVideoFromDom(video: HTMLVideoElement): void {
    try {
        video.pause();
        video.removeAttribute('src');
        video.load();
    } catch {
        // ignore
    }
    video.remove();
}

function createVideoTexture(device: GraphicsDevice, name: string): Texture {
    return new Texture(device, {
        name,
        width: 4,
        height: 4,
        format: PIXELFORMAT_RGBA8,
        mipmaps: false,
        minFilter: FILTER_LINEAR,
        magFilter: FILTER_LINEAR,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE
    });
}

export function resizeVideoTextureFromMetadata(texture: Texture, video: HTMLVideoElement): void {
    const w = Math.max(2, video.videoWidth || 4);
    const h = Math.max(2, video.videoHeight || 4);
    texture.resize(w, h);
}

function resizeVideoTextureFromCanvas(texture: Texture, canvas: HTMLCanvasElement): void {
    const w = Math.max(2, canvas.width || 4);
    const h = Math.max(2, canvas.height || 4);
    texture.resize(w, h);
}

function textureHasUploadableSource(texture: Texture): boolean {
    try {
        const src = texture.getSource(0) as unknown;
        if (!src) return false;
        if (src instanceof HTMLVideoElement) {
            return src.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA;
        }
        if (src instanceof HTMLCanvasElement) {
            return src.width >= 2 && src.height >= 2;
        }
        return true;
    } catch {
        return false;
    }
}

/**
 * 安全 upload：避免无源/零尺寸时在 render 阶段触发 `impl` 未定义。
 */
export function safeUploadPlacedVideoTexture(m: PlacedVideoRuntime): void {
    const tex = m.texture;
    if (!tex?.device || tex.width < 2 || tex.height < 2) return;
    if (!textureHasUploadableSource(tex)) return;
    try {
        tex.upload();
    } catch {
        // ignore
    }
}

/** 在 prerender（draw 之前）统一 flush，避免 update 与 render 同帧争用纹理 impl */
export function requestPlacedVideoTextureUpload(m: PlacedVideoRuntime): void {
    pendingTextureUploads.add(m);
}

export function initPlacedVideoTextureUploadFlush(app: AppBase): () => void {
    if (textureUploadFlushRegistered) {
        return () => {};
    }
    textureUploadFlushRegistered = true;
    const onPrerender = () => {
        for (const m of pendingTextureUploads) {
            safeUploadPlacedVideoTexture(m);
        }
        pendingTextureUploads.clear();
    };
    app.on('prerender', onPrerender);
    return () => {
        textureUploadFlushRegistered = false;
        app.off('prerender', onPrerender);
    };
}

/**
 * 按当前 `controlsOverlayActive` 绑定 video 或 composite canvas；仅在源类型变化时 setSource/resize。
 */
export function syncPlacedVideoTextureBinding(m: PlacedVideoRuntime): void {
    const tex = m.texture;
    const want: 'video' | 'composite' = m.controlsOverlayActive ? 'composite' : 'video';

    if (want === 'composite') {
        const canvas = m.compositeCanvas;
        if (!canvas || canvas.width < 2 || canvas.height < 2) return;
        const sizeChanged = tex.width !== canvas.width || tex.height !== canvas.height;
        if (m.textureSourceKind !== 'composite' || sizeChanged) {
            resizeVideoTextureFromCanvas(tex, canvas);
            tex.setSource(canvas);
            m.textureSourceKind = 'composite';
        }
        return;
    }

    if (m.textureSourceKind !== 'video') {
        resizeVideoTextureFromMetadata(tex, m.videoEl);
        tex.setSource(m.videoEl);
        m.textureSourceKind = 'video';
    }
}

export function bindVideoTextureFirstFrame(texture: Texture, video: HTMLVideoElement): void {
    texture.setSource(video);
    try {
        video.pause();
        if (Number.isFinite(video.duration) && video.duration > 0) {
            video.currentTime = 0;
        }
    } catch {
        // ignore
    }
    try {
        texture.upload();
    } catch {
        // ignore
    }
}

function tryCommitFirstFrame(
    video: HTMLVideoElement,
    reason: 'loadeddata' | 'progress' | 'timeout-partial'
): boolean {
    if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        return false;
    }
    if (reason === 'timeout-partial') {
        console.warn('[PlacedVideo] slow load, using first buffered frame');
    }
    return true;
}

/**
 * 等待首帧可采样（`HAVE_CURRENT_DATA`）。`progress` 可在 `loadeddata` 前提前结束等待。
 */
export function awaitPlacedVideoFirstFrame(
    video: HTMLVideoElement,
    url: string,
    timeoutMs: number
): Promise<void> {
    mountPlacedVideoToDom(video);
    configurePlacedVideoElement(video);

    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            video.removeEventListener('progress', onProgress);
            fn();
        };

        const commit = (reason: 'loadeddata' | 'progress' | 'timeout-partial') => {
            if (!tryCommitFirstFrame(video, reason)) {
                return false;
            }
            finish(resolve);
            return true;
        };

        const timer = window.setTimeout(() => {
            if (commit('timeout-partial')) {
                return;
            }
            finish(() => reject(new Error(`[PlacedVideo] load timeout (${timeoutMs}ms): ${url}`)));
        }, timeoutMs);

        const onProgress = () => {
            commit('progress');
        };

        video.addEventListener('loadedmetadata', () => {
            // 仅用于尽早获知尺寸；首帧仍以 HAVE_CURRENT_DATA 为准
        }, { once: true });

        video.addEventListener('loadeddata', () => {
            commit('loadeddata');
        }, { once: true });

        video.addEventListener('progress', onProgress);
        video.addEventListener('error', () => {
            finish(() => reject(new Error(`[PlacedVideo] load error: ${url}`)));
        }, { once: true });

        video.src = url;
        video.load();
    });
}

/**
 * 按 PlayCanvas video-texture 流程：先等首帧，再 `setSource` + `upload()`。
 */
export async function initPlacedVideoTexture(
    app: AppBase,
    video: HTMLVideoElement,
    url: string,
    textureName: string,
    timeoutMs: number = PLACED_VIDEO_INITIAL_LOAD_TIMEOUT_MS
): Promise<Texture> {
    await awaitPlacedVideoFirstFrame(video, url, timeoutMs);
    const texture = createVideoTexture(app.graphicsDevice, textureName);
    resizeVideoTextureFromMetadata(texture, video);
    bindVideoTextureFirstFrame(texture, video);
    return texture;
}

/** 由已预热/已加载的 video 创建纹理（放置点击路径） */
export function createPlacedVideoTextureFromVideo(
    app: AppBase,
    video: HTMLVideoElement,
    textureName: string
): Texture {
    const texture = createVideoTexture(app.graphicsDevice, textureName);
    resizeVideoTextureFromMetadata(texture, video);
    bindVideoTextureFirstFrame(texture, video);
    return texture;
}

export function pausePlacedVideoTexture(m: PlacedVideoRuntime): void {
    m.isLive = false;
    try {
        m.videoEl.pause();
    } catch {
        // ignore
    }
    m.videoEl.muted = true;
    if (!m.controlsOverlayActive) {
        requestPlacedVideoTextureUpload(m);
    }
}

function getVideoPlaneMaterial(entity: Entity): StandardMaterial | null {
    const render = (entity as unknown as { render?: { meshInstances?: Array<{ material?: unknown }> } }).render;
    const mat = render?.meshInstances?.[0]?.material;
    return mat instanceof StandardMaterialClass ? mat : null;
}

export function playPlacedVideoTexture(entity: Entity, m: PlacedVideoRuntime): void {
    const mat = getVideoPlaneMaterial(entity);
    if (mat) {
        mat.emissiveMap = m.texture;
        mat.opacityMap = m.texture;
        mat.update();
    }
    m.isLive = true;
    m.videoEl.play().catch(() => {
        // ignore autoplay / decode errors
    });
}

export function tickPlacedVideoTextureUploads(videos: PlacedVideoRuntime[], uploadThisFrame: boolean): void {
    if (!uploadThisFrame) return;
    for (const m of videos) {
        if (!m.isLive || m.controlsOverlayActive) continue;
        requestPlacedVideoTextureUpload(m);
    }
}
