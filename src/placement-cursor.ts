import type { Global } from './types';

const PLACEMENT_CURSOR = "url('/assets/icons/placement.svg') 16 16, crosshair";
const LOADING_CURSOR = 'wait'; // 系统等待光标

let placementCursorActive = false;

/** 资产/标注等放置模式激活中（避免 nav-interaction 把 canvas.cursor 清掉） */
const isPlacementCursorActive = (): boolean => placementCursorActive;

const getCanvasElement = (global: Global): HTMLCanvasElement | null => {
    return (global.app.graphicsDevice.canvas as HTMLCanvasElement) ?? null;
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

    if (!active) {
        canvas.style.cursor = '';
        return;
    }

    // loading 状态下显示等待光标，否则显示放置光标
    canvas.style.cursor = opts?.loading ? LOADING_CURSOR : PLACEMENT_CURSOR;
};

export { isPlacementCursorActive, setPlacementCursorActive };
