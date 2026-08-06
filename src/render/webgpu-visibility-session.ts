/**
 * WebGPU 页签会话：后台暂停 update/render，恢复后再强制 GSplat GPU 重建。
 *
 * 根因：hidden 期间仍可能节流 tick → WorkBuffer bake，或 device lost/restore
 * 后 UB/storage 尚未重新分配就 createBindGroup（buffer === null）。
 *
 * 做法（不 hook createBindGroup、不 skip 单次 draw）：
 * 1) document.hidden → 复用引擎 tick 的 contextLost 早退，跳过 update/render
 * 2) 长 hidden 归来 / devicerestored → 先空心跳 settle，再 scene.gsplat.dirty
 *    + world.invalidate({ worldState, workBuffer })，走正常全量重建路径
 *
 * 关闭：`?webgpuVisPause=0`
 */
import type { AppBase, GraphicsDevice } from 'playcanvas';

const LOG = '[webgpu-visibility-session]';

const HIDDEN_MS_FOR_SETTLE = 200;
const HIDDEN_MS_LONG = 30_000;
const SETTLE_FRAMES_DEFAULT = 2;
const SETTLE_FRAMES_LONG = 5;
const SETTLE_FRAMES_DEVICE_RESTORE = 3;

type GsplatWorldLike = {
    invalidate?: (opts?: { worldState?: boolean; workBuffer?: boolean }) => void;
};

type GsplatDirectorLike = {
    camerasMap: Map<
        unknown,
        {
            layersMap: Map<
                unknown,
                {
                    gsplatManager?: { world?: GsplatWorldLike } | null;
                    gsplatManagerShadow?: { world?: GsplatWorldLike } | null;
                }
            >;
        }
    >;
};

type AppTick = (timestamp?: number, frame?: XRFrame) => void;

const readQsFlag = (key: string): boolean | null => {
    if (typeof location === 'undefined') return null;
    try {
        const v = new URLSearchParams(location.search).get(key);
        if (v === '1' || v === 'true') return true;
        if (v === '0' || v === 'false') return false;
        return null;
    } catch {
        return null;
    }
};

const settleFramesForHiddenMs = (hiddenMs: number): number => {
    if (hiddenMs >= HIDDEN_MS_LONG) return SETTLE_FRAMES_LONG;
    if (hiddenMs >= HIDDEN_MS_FOR_SETTLE) return SETTLE_FRAMES_DEFAULT;
    return 0;
};

const forceGsplatGpuRebuild = (app: AppBase): number => {
    const sceneGsplat = (app.scene as { gsplat?: { dirty?: boolean } } | undefined)?.gsplat;
    if (sceneGsplat) {
        sceneGsplat.dirty = true;
    }

    let worldCount = 0;
    const director = (app.renderer as { gsplatDirector?: GsplatDirectorLike } | undefined)?.gsplatDirector;
    if (director?.camerasMap) {
        for (const cameraData of director.camerasMap.values()) {
            for (const layerData of cameraData.layersMap.values()) {
                const worlds = [layerData.gsplatManager?.world, layerData.gsplatManagerShadow?.world];
                for (const world of worlds) {
                    if (!world?.invalidate) continue;
                    world.invalidate({ worldState: true, workBuffer: true });
                    worldCount += 1;
                }
            }
        }
    }

    (app as AppBase & { renderNextFrame?: boolean }).renderNextFrame = true;
    return worldCount;
};

/**
 * 在 App.start() 之后安装：包装 tick，后台与恢复 settle 期间不进入 update/bake。
 */
export const installWebgpuVisibilitySession = (app: AppBase): void => {
    if (readQsFlag('webgpuVisPause') === false) {
        // eslint-disable-next-line no-console
        console.info(LOG, 'disabled via ?webgpuVisPause=0');
        return;
    }

    const device = app.graphicsDevice as GraphicsDevice & {
        deviceType?: string;
        contextLost?: boolean;
        on?: (name: string, fn: (...args: unknown[]) => void) => void;
    };
    if (device.deviceType !== 'webgpu') return;

    let hiddenStartedAt: number | null =
        typeof document !== 'undefined' && document.hidden ? performance.now() : null;
    let lastHiddenDurationMs = 0;
    let settleFrames = 0;
    let needForceRebuild = false;

    const armSettle = (frames: number, reason: string) => {
        if (frames <= 0) return;
        settleFrames = Math.max(settleFrames, frames);
        needForceRebuild = false;
        (app as AppBase & { renderNextFrame?: boolean }).renderNextFrame = true;
        // eslint-disable-next-line no-console
        console.info(LOG, 'arm settle', { frames: settleFrames, reason, lastHiddenDurationMs });
    };

    const onVisibility = () => {
        if (typeof document === 'undefined') return;
        if (document.hidden) {
            hiddenStartedAt = performance.now();
            return;
        }
        if (hiddenStartedAt != null) {
            lastHiddenDurationMs = performance.now() - hiddenStartedAt;
        }
        hiddenStartedAt = null;
        armSettle(settleFramesForHiddenMs(lastHiddenDurationMs), 'visibilitychange');
    };

    document.addEventListener('visibilitychange', onVisibility);
    if (typeof document !== 'undefined' && document.hidden) {
        // 启动时已在后台：归来时再 settle
    }

    device.on?.('devicelost', () => {
        // eslint-disable-next-line no-console
        console.warn(LOG, 'devicelost');
    });
    device.on?.('devicerestored', () => {
        armSettle(SETTLE_FRAMES_DEVICE_RESTORE, 'devicerestored');
    });

    const origTick = app.tick.bind(app) as AppTick;
    app.tick = ((timestamp?: number, frame?: XRFrame) => {
        const hidden = typeof document !== 'undefined' && document.hidden;
        const gate = hidden || settleFrames > 0;

        // settle 结束后、本帧进入 update 前：强制脏标记，走引擎正常 rebuild
        if (!hidden && settleFrames === 0 && needForceRebuild) {
            const worlds = forceGsplatGpuRebuild(app);
            needForceRebuild = false;
            // eslint-disable-next-line no-console
            console.info(LOG, 'force gsplat gpu rebuild', { worlds, lastHiddenDurationMs });
        }

        const wasLost = !!device.contextLost;
        // 复用引擎「contextLost → 只续 rAF、不 update/render」门闩，避免半截 bake
        if (gate && !wasLost) {
            device.contextLost = true;
        }
        try {
            origTick(timestamp, frame);
        } finally {
            if (gate && !wasLost) {
                device.contextLost = false;
            }
        }

        if (!hidden && settleFrames > 0) {
            settleFrames -= 1;
            if (settleFrames === 0) {
                needForceRebuild = true;
            }
            (app as AppBase & { renderNextFrame?: boolean }).renderNextFrame = true;
        }
    }) as AppBase['tick'];

    // eslint-disable-next-line no-console
    console.info(LOG, 'installed');
};
