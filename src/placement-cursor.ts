import type { Global } from './types';

const PLACEMENT_CURSOR = "url('/assets/icons/placement.svg') 16 16, crosshair";

const getCanvasElement = (global: Global): HTMLCanvasElement | null => {
    return (global.app.graphicsDevice.canvas as HTMLCanvasElement) ?? null;
};

const setPlacementCursorActive = (global: Global, active: boolean): void => {
    const canvas = getCanvasElement(global);
    if (!canvas) return;
    canvas.style.cursor = active ? PLACEMENT_CURSOR : '';
};

export { setPlacementCursorActive };
