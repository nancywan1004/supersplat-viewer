/**
 * Touch joystick is shown in landscape touch mode. It only contributes movement
 * in first-person camera modes; scene gestures remain active.
 *
 * 横屏判定不能只信 `(orientation: landscape)`：iOS/WebView 旋转时 matchMedia
 * 与 innerWidth 可能不同步，导致摇杆偶发不出现。
 */

export type LandscapeMetrics = {
    innerWidth: number;
    innerHeight: number;
    matchMediaLandscape: boolean;
    screenOrientationType?: string | null;
};

export function isLandscapeOrientationFromMetrics(metrics: LandscapeMetrics): boolean {
    if (metrics.matchMediaLandscape) {
        return true;
    }
    const type = metrics.screenOrientationType ?? '';
    if (type.startsWith('landscape')) {
        return true;
    }
    return metrics.innerWidth > metrics.innerHeight;
}

export function readLandscapeMetrics(
    win: Pick<Window, 'innerWidth' | 'innerHeight' | 'matchMedia' | 'screen'> = window
): LandscapeMetrics {
    return {
        innerWidth: win.innerWidth,
        innerHeight: win.innerHeight,
        matchMediaLandscape: win.matchMedia('(orientation: landscape)').matches,
        screenOrientationType: win.screen?.orientation?.type ?? null
    };
}

const isLandscapeOrientation = (): boolean =>
    isLandscapeOrientationFromMetrics(readLandscapeMetrics());

const shouldUseTouchJoystickMove = (state: {
    inputMode: string;
}): boolean => (
    state.inputMode === 'touch' &&
    isLandscapeOrientation()
);

export type ViewportSizeSample = {
    width: number;
    height: number;
    visualWidth: number;
    visualHeight: number;
};

export function readViewportSizeSample(
    win: Pick<Window, 'innerWidth' | 'innerHeight' | 'visualViewport'> = window
): ViewportSizeSample {
    const visualViewport = win.visualViewport;
    return {
        width: win.innerWidth,
        height: win.innerHeight,
        visualWidth: visualViewport?.width ?? win.innerWidth,
        visualHeight: visualViewport?.height ?? win.innerHeight
    };
}

function isSameViewportSize(a: ViewportSizeSample, b: ViewportSizeSample): boolean {
    return a.width === b.width &&
        a.height === b.height &&
        a.visualWidth === b.visualWidth &&
        a.visualHeight === b.visualHeight;
}

export type ViewportSettleScheduler = {
    schedule: () => void;
    cancel: () => void;
};

/**
 * 旋转/resize 后等到视口尺寸连续稳定再回调，而不是写死延迟。
 * 尺寸变化中途也会回调，便于摇杆位置跟上；连续相同帧数达标或达到上限后停止。
 */
export function createViewportSettleScheduler(options: {
    onUpdate: () => void;
    readSize?: () => ViewportSizeSample;
    scheduleFrame?: (callback: FrameRequestCallback) => number;
    cancelFrame?: (id: number) => void;
    /** 连续相同尺寸的采样次数，默认 2（即两帧宽高不变）。 */
    stableFrames?: number;
    /** 防止工具栏持续抖动导致循环不结束，默认 30 帧。 */
    maxFrames?: number;
}): ViewportSettleScheduler {
    const readSize = options.readSize ?? readViewportSizeSample;
    const scheduleFrame = options.scheduleFrame ?? ((callback) => requestAnimationFrame(callback));
    const cancelFrame = options.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    const stableFrames = options.stableFrames ?? 2;
    const maxFrames = options.maxFrames ?? 30;

    let frameId = 0;
    let running = false;
    let lastSize: ViewportSizeSample | null = null;
    let streak = 0;
    let frames = 0;

    const stop = () => {
        running = false;
        if (frameId !== 0) {
            cancelFrame(frameId);
            frameId = 0;
        }
    };

    const finish = () => {
        options.onUpdate();
        stop();
    };

    const tick = () => {
        frameId = 0;
        if (!running) {
            return;
        }
        frames += 1;
        const size = readSize();
        if (lastSize && isSameViewportSize(lastSize, size)) {
            streak += 1;
        } else {
            streak = 1;
            lastSize = size;
            options.onUpdate();
        }
        if (streak >= stableFrames || frames >= maxFrames) {
            finish();
            return;
        }
        frameId = scheduleFrame(tick);
    };

    return {
        schedule: () => {
            options.onUpdate();
            lastSize = null;
            streak = 0;
            frames = 0;
            stop();
            running = true;
            frameId = scheduleFrame(tick);
        },
        cancel: stop
    };
}

export { isLandscapeOrientation, shouldUseTouchJoystickMove };
