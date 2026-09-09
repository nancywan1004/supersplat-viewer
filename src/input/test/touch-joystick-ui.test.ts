/**
 * 横屏摇杆判定自检（无测试框架；`npx tsx` 直接跑）。
 *
 *   npx --yes tsx src/input/test/touch-joystick-ui.test.ts
 */

import {
    createViewportSettleScheduler,
    isLandscapeOrientationFromMetrics,
    type ViewportSizeSample
} from '../touch-joystick-ui';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        throw new Error(msg);
    }
}

function run(): void {
    assert(
        isLandscapeOrientationFromMetrics({
            innerWidth: 390,
            innerHeight: 844,
            matchMediaLandscape: false,
            screenOrientationType: 'portrait-primary'
        }) === false,
        'portrait phone stays portrait'
    );
    assert(
        isLandscapeOrientationFromMetrics({
            innerWidth: 844,
            innerHeight: 390,
            matchMediaLandscape: false,
            screenOrientationType: 'portrait-primary'
        }) === true,
        'size landscape wins when matchMedia/orientation lag'
    );
    assert(
        isLandscapeOrientationFromMetrics({
            innerWidth: 390,
            innerHeight: 844,
            matchMediaLandscape: true,
            screenOrientationType: 'portrait-primary'
        }) === true,
        'matchMedia landscape wins when size still portrait'
    );
    assert(
        isLandscapeOrientationFromMetrics({
            innerWidth: 390,
            innerHeight: 844,
            matchMediaLandscape: false,
            screenOrientationType: 'landscape-primary'
        }) === true,
        'screen.orientation landscape wins when size still portrait'
    );

    const makeSize = (width: number, height: number): ViewportSizeSample => ({
        width,
        height,
        visualWidth: width,
        visualHeight: height
    });

    const runScheduler = (sizes: ViewportSizeSample[], maxFrames = 30) => {
        const queue: FrameRequestCallback[] = [];
        let sizeIndex = 0;
        let updates = 0;
        const scheduler = createViewportSettleScheduler({
            onUpdate: () => {
                updates += 1;
            },
            readSize: () => sizes[Math.min(sizeIndex, sizes.length - 1)],
            scheduleFrame: (callback) => {
                queue.push(callback);
                return queue.length;
            },
            cancelFrame: () => {
                queue.length = 0;
            },
            maxFrames
        });
        scheduler.schedule();
        const flush = () => {
            while (queue.length > 0) {
                sizeIndex += 1;
                const callback = queue.shift();
                callback?.(0);
            }
        };
        return { flush, getUpdates: () => updates, getPending: () => queue.length, scheduler };
    };

    {
        const sizes = [makeSize(390, 844), makeSize(844, 390), makeSize(844, 390)];
        const { flush, getUpdates, getPending } = runScheduler(sizes);
        flush();
        assert(getPending() === 0, 'stable size stops the rAF loop');
        assert(getUpdates() >= 2, 'updates on schedule, size change, and settle');
    }

    {
        const sizes = [
            makeSize(390, 844),
            makeSize(600, 700),
            makeSize(700, 600),
            makeSize(800, 500),
            makeSize(844, 390)
        ];
        const { flush, getPending } = runScheduler(sizes, 4);
        flush();
        assert(getPending() === 0, 'maxFrames stops even if size keeps changing');
    }

    {
        const queue: FrameRequestCallback[] = [];
        const scheduler = createViewportSettleScheduler({
            onUpdate: () => {},
            readSize: () => makeSize(844, 390),
            scheduleFrame: (callback) => {
                queue.push(callback);
                return queue.length;
            },
            cancelFrame: () => {
                queue.length = 0;
            }
        });
        scheduler.schedule();
        assert(queue.length === 1, 'first schedule queues one frame');
        scheduler.schedule();
        assert(queue.length === 1, 'reschedule cancels the previous frame');
    }

    console.log('touch-joystick-ui.test.ts: ok');
}

run();
