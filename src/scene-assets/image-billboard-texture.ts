import type { GraphicsDevice } from 'playcanvas';
import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR,
    PIXELFORMAT_RGBA8,
    Texture
} from 'playcanvas';

/**
 * 用浏览器 `Image` 解码（支持 SVG / png / webp 等）再栅格化为 RGBA 纹理，保留透明通道。
 * PlayCanvas `loadFromUrl(..., 'texture')` 不支持 SVG；PNG 直载也可能丢失 alpha 表现。
 */
export function loadBillboardTextureFromImageUrl(
    device: GraphicsDevice,
    url: string,
    name: string,
    timeoutMs: number = 10000,
    maxDim: number = 256
): Promise<Texture> {
    const resolved = new URL(url, window.location.href).href;

    return new Promise((resolve, reject) => {
        const img = new Image();
        let settled = false;
        const finish = (fn: () => void) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
            fn();
        };
        const timer = window.setTimeout(() => {
            finish(() => reject(new Error(`[BillboardTexture] load timeout (${timeoutMs}ms): ${resolved}`)));
        }, timeoutMs);

        img.onload = () => {
            let w = Math.max(1, img.naturalWidth || 64);
            let h = Math.max(1, img.naturalHeight || 64);
            if (w > maxDim || h > maxDim) {
                const s = maxDim / Math.max(w, h);
                w = Math.max(1, Math.round(w * s));
                h = Math.max(1, Math.round(h * s));
            }
            const canvas = document.createElement('canvas');
            canvas.width = w;
            canvas.height = h;
            const ctx = canvas.getContext('2d', { alpha: true });
            if (!ctx) {
                finish(() => reject(new Error(`[BillboardTexture] 2d context failed: ${resolved}`)));
                return;
            }
            ctx.clearRect(0, 0, w, h);
            ctx.drawImage(img, 0, 0, w, h);

            const texture = new Texture(device, {
                name,
                width: w,
                height: h,
                format: PIXELFORMAT_RGBA8,
                mipmaps: false,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
            texture.setSource(canvas);
            finish(() => resolve(texture));
        };

        img.onerror = () => {
            finish(() => reject(new Error(`[BillboardTexture] load error: ${resolved}`)));
        };

        img.crossOrigin = 'anonymous';
        img.src = resolved;
    });
}
