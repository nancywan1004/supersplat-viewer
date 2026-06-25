import type { Global } from '../../types';

export type CanvasPickCoords = {
    offsetX: number;
    offsetY: number;
    renderX: number;
    renderY: number;
    pickX: number;
    pickY: number;
    pickW: number;
    pickH: number;
};

/** client 坐标 → canvas 偏移、渲染分辨率坐标、以及可选缩放的 Picker 缓冲坐标。 */
export function clientToPickScreenCoords(
    global: Global,
    clientX: number,
    clientY: number,
    pickerScale = 1
): CanvasPickCoords | null {
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    const rect = canvas.getBoundingClientRect();
    const offsetX = clientX - rect.left;
    const offsetY = clientY - rect.top;
    if (offsetX < 0 || offsetY < 0 || offsetX > rect.width || offsetY > rect.height) {
        return null;
    }

    const renderWidth = global.app.graphicsDevice.width;
    const renderHeight = global.app.graphicsDevice.height;
    const pickW = Math.max(1, Math.floor(renderWidth * pickerScale));
    const pickH = Math.max(1, Math.floor(renderHeight * pickerScale));

    return {
        offsetX,
        offsetY,
        renderX: (offsetX / Math.max(1, rect.width)) * renderWidth,
        renderY: (offsetY / Math.max(1, rect.height)) * renderHeight,
        pickX: Math.floor((offsetX / rect.width) * pickW),
        pickY: Math.floor((offsetY / rect.height) * pickH),
        pickW,
        pickH
    };
}
