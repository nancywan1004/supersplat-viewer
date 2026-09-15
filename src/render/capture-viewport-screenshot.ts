import type { AppBase } from 'playcanvas';

/** 默认项目缩略图输出尺寸（16:9，1024×576） */
export const VIEWPORT_SCREENSHOT_DEFAULT = { width: 1024, height: 576 } as const;

export type ViewportScreenshotSize = {
    width: number;
    height: number;
};

const JPEG_MIME = 'image/jpeg';
const JPEG_QUALITY = 0.92;

/** 等待出帧的超时：renderer 停止出帧时不能静默挂起（调用方须能拿到失败原因） */
const CAPTURE_FRAME_TIMEOUT_MS = 8000;

/** Viewer 上的“强制出帧”开关（预热帧同款），截图期间置位以免请求被渲染门控吞掉 */
type ForceRenderHost = {
    viewer?: { forceRenderNextFrame?: boolean };
};

const evenDim = (n: number) => (n % 2 === 0 ? n : Math.max(2, n - 1));

/**
 * 等待一次 `frameend`（带超时）。
 *
 * 注意：Viewer 的 `framerender` 在 `!readyToRender` 且未强制出帧时会清掉 `renderNextFrame`
 * （见 viewer.ts），此时 `frameend` 仍会来但画布没有重绘。调用方需自行保证强制出帧。
 * @param app - 主 App（PlayCanvas AppBase）
 * @param timeoutMs - 等待出帧的超时毫秒数
 * @returns 出帧后 resolve；超时 reject（避免 renderer 停止出帧时静默挂起）
 */
function waitNextFrameEnd(app: AppBase, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (): boolean => {
            if (settled) return false;
            settled = true;
            return true;
        };
        const timer = setTimeout(() => {
            if (!settle()) return;
            app.off('frameend', onFrameEnd);
            reject(new Error(`capture timeout: frameend not fired in ${timeoutMs}ms`));
        }, timeoutMs);
        function onFrameEnd() {
            if (!settle()) return;
            clearTimeout(timer);
            resolve();
        }
        app.on('frameend', onFrameEnd);
    });
}

/** 计算居中 cover 裁切区域，使源图裁切后宽高比与目标一致 */
function centerCoverCrop(
    srcW: number,
    srcH: number,
    targetW: number,
    targetH: number
): { x: number; y: number; w: number; h: number } {
    const targetAspect = targetW / targetH;
    const srcAspect = srcW / srcH;

    let cropW = srcW;
    let cropH = srcH;
    if (srcAspect > targetAspect) {
        cropW = srcH * targetAspect;
    } else if (srcAspect < targetAspect) {
        cropH = srcW / targetAspect;
    }

    cropW = Math.max(1, Math.floor(cropW));
    cropH = Math.max(1, Math.floor(cropH));
    const x = Math.floor((srcW - cropW) / 2);
    const y = Math.floor((srcH - cropH) / 2);
    return { x, y, w: cropW, h: cropH };
}

/**
 * 等待下一帧渲染完成后，从主 WebGL canvas 轻量截图为 JPEG（居中裁切 cover 至目标尺寸，无黑边）。
 */
export async function captureViewportJpegBlob(
    app: AppBase,
    size: ViewportScreenshotSize = VIEWPORT_SCREENSHOT_DEFAULT
): Promise<Blob> {
    const targetWidth = evenDim(Math.max(2, Math.floor(size.width)));
    const targetHeight = evenDim(Math.max(2, Math.floor(size.height)));

    // 截图期间强制出帧：否则 Viewer 在 !readyToRender 时会清掉 renderNextFrame，
    // 这里等到的可能是上一帧（黑图 / 旧帧），表现为「截图失败」但无任何报错。
    const forceRenderHost = (app as unknown as ForceRenderHost).viewer;
    const prevForceRender = forceRenderHost?.forceRenderNextFrame;
    if (forceRenderHost) {
        forceRenderHost.forceRenderNextFrame = true;
    }

    try {
        app.renderNextFrame = true;
        await waitNextFrameEnd(app, CAPTURE_FRAME_TIMEOUT_MS);
    } finally {
        if (forceRenderHost) {
            forceRenderHost.forceRenderNextFrame = prevForceRender === true;
        }
    }

    const canvas = app.graphicsDevice.canvas as HTMLCanvasElement | undefined;
    if (!canvas) {
        throw new Error('graphicsDevice.canvas unavailable');
    }

    const srcW = canvas.width;
    const srcH = canvas.height;
    if (srcW <= 0 || srcH <= 0) {
        throw new Error('canvas has zero size');
    }

    const offscreen = document.createElement('canvas');
    offscreen.width = targetWidth;
    offscreen.height = targetHeight;
    const ctx = offscreen.getContext('2d');
    if (!ctx) {
        throw new Error('2d context unavailable');
    }

    const crop = centerCoverCrop(srcW, srcH, targetWidth, targetHeight);
    const drawCover = (source: CanvasImageSource) => {
        ctx.drawImage(source, crop.x, crop.y, crop.w, crop.h, 0, 0, targetWidth, targetHeight);
    };

    try {
        drawCover(canvas);
    } catch (drawError) {
        const dataUrl = canvas.toDataURL(JPEG_MIME, JPEG_QUALITY);
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(drawError);
            img.src = dataUrl;
        });
        drawCover(img);
    }

    const blob = await new Promise<Blob | null>((resolve) => {
        offscreen.toBlob(resolve, JPEG_MIME, JPEG_QUALITY);
    });
    if (!blob) {
        throw new Error('JPEG encode failed (toBlob returned null)');
    }
    return blob;
}
