import type { AppBase } from 'playcanvas';

/** 默认项目缩略图输出尺寸（16:9，1024×576） */
export const VIEWPORT_SCREENSHOT_DEFAULT = { width: 1024, height: 576 } as const;

export type ViewportScreenshotSize = {
    width: number;
    height: number;
};

const JPEG_MIME = 'image/jpeg';
const JPEG_QUALITY = 0.92;

const evenDim = (n: number) => (n % 2 === 0 ? n : Math.max(2, n - 1));

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

    app.renderNextFrame = true;
    await new Promise<void>((resolve) => app.once('frameend', () => resolve()));

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
