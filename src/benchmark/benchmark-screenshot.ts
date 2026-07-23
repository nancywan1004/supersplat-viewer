import type { Global } from '../types';
import { captureViewportJpegBlob } from '../render/capture-viewport-screenshot';

export const BENCHMARK_SCREENSHOT_SIZE = { width: 480, height: 270 } as const;

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            if (typeof dataUrl !== 'string') {
                reject(new Error('FileReader did not return data URL'));
                return;
            }
            const comma = dataUrl.indexOf(',');
            resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
        };
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
        reader.readAsDataURL(blob);
    });
}

export async function captureBenchmarkClearScreenshot(global: Global): Promise<string | null> {
    try {
        const blob = await captureViewportJpegBlob(global.app, BENCHMARK_SCREENSHOT_SIZE);
        return await blobToBase64(blob);
    } catch (err) {
        console.warn('[SceneProfileBenchmark] screenshot failed', err);
        return null;
    }
}
