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

/**
 * 等待下一帧渲染完成后，从主 WebGL canvas 轻量截图为 JPEG（缩放至目标尺寸，黑边 letterbox）。
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

    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, targetWidth, targetHeight);

    const scale = Math.min(targetWidth / srcW, targetHeight / srcH);
    const drawW = Math.max(1, Math.floor(srcW * scale));
    const drawH = Math.max(1, Math.floor(srcH * scale));
    const dx = Math.floor((targetWidth - drawW) / 2);
    const dy = Math.floor((targetHeight - drawH) / 2);

    try {
        ctx.drawImage(canvas, 0, 0, srcW, srcH, dx, dy, drawW, drawH);
    } catch (drawError) {
        const dataUrl = canvas.toDataURL(JPEG_MIME, JPEG_QUALITY);
        const img = new Image();
        await new Promise<void>((resolve, reject) => {
            img.onload = () => resolve();
            img.onerror = () => reject(drawError);
            img.src = dataUrl;
        });
        ctx.drawImage(img, dx, dy, drawW, drawH);
    }

    const blob = await new Promise<Blob | null>((resolve) => {
        offscreen.toBlob(resolve, JPEG_MIME, JPEG_QUALITY);
    });
    if (!blob) {
        throw new Error('JPEG encode failed (toBlob returned null)');
    }
    return blob;
}
