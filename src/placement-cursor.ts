import type { Global } from './types';

const PLACEMENT_CURSOR = "url('/assets/icons/placement.svg') 16 16, crosshair";
const LOADING_CURSOR = 'wait'; // 系统等待光标
/** 手电筒光标：SVG 25x27，热点（hotspot）≈ 手电筒光束起点 */
const TORCH_CURSOR = "url('/assets/icons/touchLight.svg') 12 12, crosshair";

let placementCursorActive = false;
let placementCursorLoading = false;
let torchCursorActive = false;

/**
 * 当前是否由某种「画布私有 cursor 模式」占用：
 * - 放置（资产 / 标注）
 * - 手电筒（跟随鼠标的全局光源）
 *
 * `nav-interaction.ts` 用此判断，避免在悬停 / 拖拽时把 canvas.cursor 清掉。
 */
const isPlacementCursorActive = (): boolean => placementCursorActive || torchCursorActive;

const getCanvasElement = (global: Global): HTMLCanvasElement | null => {
    return (global.app.graphicsDevice.canvas as HTMLCanvasElement) ?? null;
};

/**
 * 优先级：torch > placement > 默认（''）。
 * placement.loading 时强制 wait 光标（其优先级仍低于 torch — 手电筒探索期间不应被 loading 覆盖）。
 */
const refreshCanvasCursor = (canvas: HTMLCanvasElement): void => {
    if (torchCursorActive) {
        canvas.style.cursor = TORCH_CURSOR;
        return;
    }
    if (placementCursorActive) {
        canvas.style.cursor = placementCursorLoading ? LOADING_CURSOR : PLACEMENT_CURSOR;
        return;
    }
    canvas.style.cursor = '';
};

/**
 * 设置放置光标状态
 * @param global Global 对象
 * @param active 是否激活放置模式
 * @param opts.loading 是否处于下载中状态（显示 loading 光标，禁用放置）
 */
const setPlacementCursorActive = (global: Global, active: boolean, opts?: { loading?: boolean }): void => {
    const canvas = getCanvasElement(global);
    if (!canvas) return;
    placementCursorActive = active;
    placementCursorLoading = !!(active && opts?.loading);
    refreshCanvasCursor(canvas);
};

/**
 * 设置手电筒光标状态；
 * `TorchLightController` 在 enabled 切换时调用。
 */
const setTorchCursorActive = (global: Global, active: boolean): void => {
    const canvas = getCanvasElement(global);
    if (!canvas) return;
    torchCursorActive = !!active;
    refreshCanvasCursor(canvas);
};

const isTorchCursorActive = (): boolean => torchCursorActive;

export { isPlacementCursorActive, setPlacementCursorActive, setTorchCursorActive, isTorchCursorActive };
