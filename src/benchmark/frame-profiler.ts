import type { AppBase } from 'playcanvas';
import { Quat, Vec3 } from 'playcanvas';

import type { OctreeRefinementTickMetrics, RefinementFrameProfile } from '../loaders/gsplat/lod/octree/refinement-controller';
import { readLastDeferredInstUpdateMs, readRefinementFrameProfile } from '../loaders/gsplat/lod/octree/refinement-controller';
import {
    analyzeBufferUploadProfile,
    logBufferUploadProfileTable,
    type BufferUploadProfileReport
} from './buffer-upload-profile-table';
import {
    summarizeBakeAcceptance,
    BAKE_ACCEPTANCE_SYNC_HORIZON_FRAMES,
    type BakeAcceptanceReport
} from './bake-acceptance';
import {
    readGsplatBufferUploadMetrics,
    readGsplatsM,
    readJsHeapUsedMB,
    readRefinementTickMetrics,
    readVramTexMB,
    type GsplatBufferUploadMetrics
} from './benchmark-refinement';
import type { Global } from '../types';

const DEFAULT_MAX_SAMPLES = 7200;
/** 与 bootstrap tryUnlockStreamingOnCameraIdle 一致 */
const LOD_MOVE_TRIGGER_M = 0.03;
const LOD_ROTATE_TRIGGER_DOT = 1 - 0.015;

type PlayCanvasFrameStats = {
    fps: number;
    ms: number;
    dt: number;
    updateTime: number;
    renderTime: number;
    scriptUpdate: number;
    scriptPostUpdate: number;
    animUpdate: number;
    physicsTime: number;
    gsplatSort: number;
    gsplatBufferCopy: number;
    gsplats: number;
    cullTime?: number;
    sortTime?: number;
    forwardTime?: number;
    shadowMapTime?: number;
};

type PlayCanvasDrawCallStats = {
    total: number;
    forward: number;
    shadow: number;
};

type PlayCanvasAppStats = {
    frame: PlayCanvasFrameStats;
    drawCalls: PlayCanvasDrawCallStats;
    gpu?: Map<string, number>;
    vram?: { tex: number; totalUsed?: number };
};

type GpuProfilerLike = {
    enabled: boolean;
};

type GraphicsDeviceLike = {
    gpuProfiler?: GpuProfilerLike;
};

export type FrameProfileCpuSample = {
    updateMs: number;
    renderMs: number;
    scriptUpdateMs: number;
    scriptPostUpdateMs: number;
    animUpdateMs: number;
    physicsMs: number;
    gsplatSortMs: number;
    /** PlayCanvas stats.frame.gsplatBufferCopy：bufferCopyUploaded/bufferCopyTotal×100，非毫秒 */
    gsplatBufferCopyPct: number;
    cullMs?: number;
    sortMs?: number;
    forwardMs?: number;
    shadowMapMs?: number;
};

export type FrameProfileGpuSample = {
    totalMs: number;
    passes: Record<string, number>;
};

export type FrameProfileRefinementSample = {
    tick: OctreeRefinementTickMetrics | null;
    deferredInstUpdateMs: number;
    frame: RefinementFrameProfile;
    /** frameMs 减去已采样 CPU/GPU/refinement 后的缺口（含 GC、未计时的 gsplat buffer copy 等） */
    gapMs: number;
};

export type FrameProfileCameraSample = {
    pos: [number, number, number];
    moveSinceLastM: number;
    rotateSinceLastDeg: number;
    /** 单帧平移超过 bootstrap 3 cm 阈值 */
    moveTriggersLod: boolean;
    /** 单帧转向超过 bootstrap ~10° 阈值 */
    rotateTriggersLod: boolean;
    fov: number;
    distance: number;
};

export type FrameProfileCameraDelta = {
    moveForwardM?: number;
    moveRightM?: number;
    moveUpM?: number;
    yawDeg?: number;
    pitchDeg?: number;
};

export type FrameProfileSample = {
    index: number;
    timeMs: number;
    frameMs: number;
    fps: number;
    dt: number;
    cpu: FrameProfileCpuSample;
    gpu: FrameProfileGpuSample;
    gsplatsM: number | null;
    drawCalls: number;
    jsHeapMb: number | null;
    vramTexMb: number | null;
    /**
     * Work buffer 上传量（引擎 block 计数 + MB 估算）。
     * `uploadedBlocks`/`totalBlocks` 为真实字段；`uploadMbEst` 按 40B/splat 估算。
     */
    bufferUpload: GsplatBufferUploadMetrics;
    refinement: FrameProfileRefinementSample;
    camera: FrameProfileCameraSample | null;
};

export type FrameProfilerState = {
    recording: boolean;
    sampleCount: number;
    maxSamples: number;
    startedAtMs: number | null;
};

export type FrameProfilerApi = {
    start: () => void;
    stop: () => FrameProfileSample[];
    clear: () => void;
    isRecording: () => boolean;
    getSamples: () => FrameProfileSample[];
    getState: () => FrameProfilerState;
    /** 程序化移动相机，用于 profiling 标定移动量 */
    applyCameraDelta: (delta: FrameProfileCameraDelta) => boolean;
    copyJson: () => Promise<boolean>;
    downloadJson: (filename?: string) => void;
    /** 生成 Work Buffer / 上传量 Markdown 统计表（对象 + markdown 字符串） */
    summarizeBufferUpload: () => BufferUploadProfileReport;
    /** 下载 §buffer-upload-table Markdown */
    downloadBufferUploadTable: (filename?: string) => BufferUploadProfileReport;
    /** Bake / WorldState 验收汇总 */
    summarizeBakeAcceptance: () => BakeAcceptanceReport;
};

function roundMs(value: number): number {
    return Math.round(value * 10) / 10;
}

function round3(value: number): number {
    return Math.round(value * 1000) / 1000;
}

type CameraLike = {
    position: Vec3;
    angles: Vec3;
    fov: number;
    distance: number;
    calcFocusPoint: (result: Vec3) => void;
};

type CameraPrev = {
    px: number;
    py: number;
    pz: number;
    fx: number;
    fy: number;
    fz: number;
};

function readViewerCamera(global: Global): CameraLike | null {
    const viewer = (global.app as { viewer?: { cameraManager?: { camera: CameraLike } } }).viewer;
    return viewer?.cameraManager?.camera ?? null;
}

function readCameraSample(prev: CameraPrev | null, cam: CameraLike): FrameProfileCameraSample {
    const focus = new Vec3();
    cam.calcFocusPoint(focus);
    const px = cam.position.x;
    const py = cam.position.y;
    const pz = cam.position.z;
    const fx = focus.x - px;
    const fy = focus.y - py;
    const fz = focus.z - pz;
    const flen = Math.hypot(fx, fy, fz) || 1;
    const nfx = fx / flen;
    const nfy = fy / flen;
    const nfz = fz / flen;

    let moveSinceLastM = 0;
    let rotateSinceLastDeg = 0;
    if (prev) {
        moveSinceLastM = Math.hypot(px - prev.px, py - prev.py, pz - prev.pz);
        const dot = Math.min(1, Math.max(-1, nfx * prev.fx + nfy * prev.fy + nfz * prev.fz));
        rotateSinceLastDeg = (Math.acos(dot) * 180) / Math.PI;
    }

    return {
        pos: [round3(px), round3(py), round3(pz)],
        moveSinceLastM: round3(moveSinceLastM),
        rotateSinceLastDeg: round3(rotateSinceLastDeg),
        moveTriggersLod: moveSinceLastM > LOD_MOVE_TRIGGER_M,
        rotateTriggersLod: nfx * (prev?.fx ?? nfx) + nfy * (prev?.fy ?? nfy) + nfz * (prev?.fz ?? nfz) < LOD_ROTATE_TRIGGER_DOT,
        fov: round3(cam.fov),
        distance: round3(cam.distance)
    };
}

function applyCameraDelta(global: Global, delta: FrameProfileCameraDelta): boolean {
    const cam = readViewerCamera(global);
    if (!cam) {
        return false;
    }

    const rot = new Quat().setFromEulerAngles(cam.angles.x, cam.angles.y, cam.angles.z);
    const offset = new Vec3();
    if (delta.moveForwardM) {
        const forward = new Vec3();
        rot.transformVector(Vec3.FORWARD, forward);
        offset.add(forward.mulScalar(delta.moveForwardM));
    }
    if (delta.moveRightM) {
        const right = new Vec3();
        rot.transformVector(Vec3.RIGHT, right);
        offset.add(right.mulScalar(delta.moveRightM));
    }
    if (delta.moveUpM) {
        offset.y += delta.moveUpM;
    }
    cam.position.add(offset);

    if (delta.yawDeg) {
        cam.angles.y += delta.yawDeg;
    }
    if (delta.pitchDeg) {
        cam.angles.x += delta.pitchDeg;
    }

    global.app.renderNextFrame = true;
    return true;
}

function readPlayCanvasStats(app: AppBase): PlayCanvasAppStats {
    return app.stats as unknown as PlayCanvasAppStats;
}

function readGpuSample(stats: PlayCanvasAppStats): FrameProfileGpuSample {
    const passes: Record<string, number> = {};
    let totalMs = 0;
    const gpu = stats.gpu;
    if (gpu && typeof gpu.forEach === 'function') {
        gpu.forEach((value, key) => {
            if (!Number.isFinite(value) || value <= 0) {
                return;
            }
            const ms = roundMs(value);
            passes[key] = ms;
            totalMs += ms;
        });
    }
    return {
        totalMs: roundMs(totalMs),
        passes
    };
}

/** 生产版 PlayCanvas 未设置 renderStart/updateStart，stats.frame.renderTime/updateTime 不可信 */
function isPlausibleDurationMs(value: number, frameMs: number): boolean {
    return Number.isFinite(value) && value >= 0 && value <= Math.max(frameMs * 2, 500);
}

type FrameStatsSnapshot = {
    frame: PlayCanvasFrameStats;
    drawCalls: PlayCanvasDrawCallStats;
    gpu: FrameProfileGpuSample;
};

type FrameWallClockCapture = {
    frameupdateAt: number;
    framerenderAt: number;
    postrenderAt: number;
    frameendAt: number;
    rendered: boolean;
};

function snapshotPlayCanvasStats(app: AppBase): FrameStatsSnapshot {
    const stats = readPlayCanvasStats(app);
    return {
        frame: { ...stats.frame },
        drawCalls: { ...stats.drawCalls },
        gpu: readGpuSample(stats)
    };
}

function buildCpuSample(
    frame: PlayCanvasFrameStats,
    frameMs: number,
    wallClock: FrameWallClockCapture
): FrameProfileCpuSample {
    const measuredUpdateMs =
        wallClock.framerenderAt > wallClock.frameupdateAt
            ? wallClock.framerenderAt - wallClock.frameupdateAt
            : 0;
    const measuredRenderMs =
        wallClock.rendered && wallClock.postrenderAt > wallClock.framerenderAt
            ? wallClock.postrenderAt - wallClock.framerenderAt
            : 0;

    const updateMs = isPlausibleDurationMs(frame.updateTime, frameMs)
        ? frame.updateTime
        : measuredUpdateMs;
    const renderMs = isPlausibleDurationMs(frame.renderTime, frameMs)
        ? frame.renderTime
        : measuredRenderMs;

    return {
        updateMs: roundMs(updateMs),
        renderMs: roundMs(renderMs),
        scriptUpdateMs: roundMs(frame.scriptUpdate),
        scriptPostUpdateMs: roundMs(frame.scriptPostUpdate),
        animUpdateMs: roundMs(frame.animUpdate),
        physicsMs: roundMs(frame.physicsTime),
        gsplatSortMs: roundMs(frame.gsplatSort),
        gsplatBufferCopyPct: roundMs(frame.gsplatBufferCopy),
        cullMs: frame.cullTime !== undefined ? roundMs(frame.cullTime) : undefined,
        sortMs: frame.sortTime !== undefined ? roundMs(frame.sortTime) : undefined,
        forwardMs: frame.forwardTime !== undefined ? roundMs(frame.forwardTime) : undefined,
        shadowMapMs: frame.shadowMapTime !== undefined ? roundMs(frame.shadowMapTime) : undefined
    };
}

function buildSample(
    app: AppBase,
    global: Global,
    index: number,
    statsSnapshot: FrameStatsSnapshot,
    wallClock: FrameWallClockCapture,
    camera: FrameProfileCameraSample | null,
    latch: { dirtySeen: boolean; workBufferRebuildSeen: boolean; includeCurrentLodSum: boolean }
): FrameProfileSample {
    const frame = statsSnapshot.frame;
    const tick = readRefinementTickMetrics(global);
    const frameMs = roundMs(frame.ms);
    const cpu = buildCpuSample(frame, frameMs, wallClock);
    const deferredInstUpdateMs = roundMs(readLastDeferredInstUpdateMs(app));
    const frameProfile = readRefinementFrameProfile(app);
    const accountedMs =
        cpu.updateMs + cpu.renderMs + statsSnapshot.gpu.totalMs + (tick?.timingsMs.total ?? 0) + deferredInstUpdateMs;
    const gapMs = roundMs(Math.max(0, frameMs - accountedMs));
    const bufferUpload = readGsplatBufferUploadMetrics(app, {
        dirtySeen: latch.dirtySeen,
        workBufferRebuildSeen: latch.workBufferRebuildSeen,
        includeCurrentLodSum: latch.includeCurrentLodSum
    });

    return {
        index,
        timeMs: Math.round(wallClock.frameendAt),
        frameMs,
        fps: roundMs(frame.fps),
        dt: roundMs(frame.dt * 1000) / 1000,
        cpu,
        gpu: statsSnapshot.gpu,
        gsplatsM: readGsplatsM(app),
        drawCalls: statsSnapshot.drawCalls?.total ?? 0,
        jsHeapMb: readJsHeapUsedMB(),
        vramTexMb: readVramTexMB(app),
        bufferUpload,
        refinement: {
            tick,
            deferredInstUpdateMs,
            frame: frameProfile,
            gapMs
        },
        camera
    };
}

function enableGpuProfiler(app: AppBase): void {
    const device = app.graphicsDevice as unknown as GraphicsDeviceLike;
    if (device.gpuProfiler) {
        device.gpuProfiler.enabled = true;
    }
}

export function initFrameProfiler(global: Global, options?: { maxSamples?: number; autoStart?: boolean }): () => void {
    const { app } = global;
    const maxSamples = options?.maxSamples ?? DEFAULT_MAX_SAMPLES;
    const samples: FrameProfileSample[] = [];
    let recording = false;
    let startedAtMs: number | null = null;
    let sampleIndex = 0;
    let gpuProfilerEnabled = false;
    let prevCamera: CameraPrev | null = null;

    const ensureGpuProfiler = () => {
        if (!gpuProfilerEnabled) {
            enableGpuProfiler(app);
            gpuProfilerEnabled = true;
        }
    };

    let wallClock: Partial<FrameWallClockCapture> = {};
    let dirtySeenThisFrame = false;
    let workBufferRebuildSeenThisFrame = false;
    /** sync 后继续采 currentLodSum 的剩余帧数（含本帧） */
    let lodSumHorizonRemaining = 0;

    const latchFrameSignals = () => {
        const gsplat = app.scene?.gsplat as { dirty?: boolean } | undefined;
        if (gsplat?.dirty) {
            dirtySeenThisFrame = true;
        }
        const director = (app.renderer as { gsplatDirector?: {
            camerasMap: Map<unknown, {
                layersMap: Map<unknown, {
                    gsplatManager?: { world?: { _workBufferRebuildRequired?: boolean } } | null;
                    gsplatManagerShadow?: { world?: { _workBufferRebuildRequired?: boolean } } | null;
                }>;
            }>;
        } }).gsplatDirector;
        if (!director) {
            return;
        }
        for (const cameraData of director.camerasMap.values()) {
            for (const layerData of cameraData.layersMap.values()) {
                for (const manager of [layerData.gsplatManager, layerData.gsplatManagerShadow]) {
                    if (manager?.world?._workBufferRebuildRequired) {
                        workBufferRebuildSeenThisFrame = true;
                        return;
                    }
                }
            }
        }
    };

    const onFrameUpdate = () => {
        wallClock = { frameupdateAt: performance.now() };
        dirtySeenThisFrame = false;
        workBufferRebuildSeenThisFrame = false;
        latchFrameSignals();
    };

    const onFrameRender = () => {
        wallClock.framerenderAt = performance.now();
        latchFrameSignals();
    };

    const onPostRender = () => {
        wallClock.postrenderAt = performance.now();
        wallClock.rendered = true;
        latchFrameSignals();
    };

    const onFrameEnd = () => {
        if (!recording) {
            return;
        }
        latchFrameSignals();
        const frameendAt = performance.now();
        const statsSnapshot = snapshotPlayCanvasStats(app);
        const frameSyncProfile = readRefinementFrameProfile(app);
        const syncThisFrame =
            (frameSyncProfile.syncedInstances ?? 0) > 0 ||
            (frameSyncProfile.syncTriggers?.length ?? 0) > 0;
        if (syncThisFrame) {
            lodSumHorizonRemaining = BAKE_ACCEPTANCE_SYNC_HORIZON_FRAMES + 1;
        }
        const includeCurrentLodSum = lodSumHorizonRemaining > 0;
        if (lodSumHorizonRemaining > 0) {
            lodSumHorizonRemaining--;
        }
        const capture: FrameWallClockCapture = {
            frameupdateAt: wallClock.frameupdateAt ?? frameendAt,
            framerenderAt: wallClock.framerenderAt ?? frameendAt,
            postrenderAt: wallClock.postrenderAt ?? 0,
            frameendAt,
            rendered: wallClock.rendered === true
        };
        const latch = {
            dirtySeen: dirtySeenThisFrame,
            workBufferRebuildSeen: workBufferRebuildSeenThisFrame,
            includeCurrentLodSum
        };
        wallClock = {};
        dirtySeenThisFrame = false;
        workBufferRebuildSeenThisFrame = false;

        let cameraSample: FrameProfileCameraSample | null = null;
        const cam = readViewerCamera(global);
        if (cam) {
            cameraSample = readCameraSample(prevCamera, cam);
            const focus = new Vec3();
            cam.calcFocusPoint(focus);
            const fx = focus.x - cam.position.x;
            const fy = focus.y - cam.position.y;
            const fz = focus.z - cam.position.z;
            const flen = Math.hypot(fx, fy, fz) || 1;
            prevCamera = {
                px: cam.position.x,
                py: cam.position.y,
                pz: cam.position.z,
                fx: fx / flen,
                fy: fy / flen,
                fz: fz / flen
            };
        }

        // 延后到 microtask，确保 refinement deferred inst.update 等 frameend 钩子先跑完
        queueMicrotask(() => {
            if (!recording) {
                return;
            }
            samples.push(buildSample(app, global, sampleIndex++, statsSnapshot, capture, cameraSample, latch));
            if (samples.length > maxSamples) {
                samples.splice(0, samples.length - maxSamples);
            }
        });
    };

    app.on('frameupdate', onFrameUpdate);
    app.on('framerender', onFrameRender);
    app.on('postrender', onPostRender);
    app.on('frameend', onFrameEnd);

    const api: FrameProfilerApi = {
        start() {
            if (recording) {
                console.info('[frame-profiler] already recording');
                return;
            }
            ensureGpuProfiler();
            recording = true;
            startedAtMs = performance.now();
            console.info('[frame-profiler] recording started (max %d samples)', maxSamples);
        },
        stop() {
            if (!recording) {
                console.info('[frame-profiler] not recording');
                return samples.slice();
            }
            recording = false;
            const elapsed = startedAtMs !== null ? performance.now() - startedAtMs : 0;
            startedAtMs = null;
            console.info('[frame-profiler] stopped · %d samples · %.0f ms captured', samples.length, elapsed);
            if (samples.length > 0) {
                logBufferUploadProfileTable(
                    analyzeBufferUploadProfile(samples, {
                        sampleCount: samples.length,
                        hasBufferUpload: samples.some((s) => s.bufferUpload),
                        exportedAt: new Date().toISOString()
                    })
                );
            }
            return samples.slice();
        },
        clear() {
            samples.length = 0;
            sampleIndex = 0;
            prevCamera = null;
            console.info('[frame-profiler] cleared');
        },
        isRecording() {
            return recording;
        },
        getSamples() {
            return samples.slice();
        },
        getState(): FrameProfilerState {
            return {
                recording,
                sampleCount: samples.length,
                maxSamples,
                startedAtMs
            };
        },
        applyCameraDelta(delta: FrameProfileCameraDelta) {
            return applyCameraDelta(global, delta);
        },
        async copyJson() {
            try {
                const payload = {
                    meta: {
                        exportedAt: new Date().toISOString(),
                        sampleCount: samples.length,
                        recording,
                        maxSamples
                    },
                    samples
                };
                await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
                return true;
            } catch (err) {
                console.warn('[frame-profiler] copy failed', err);
                return false;
            }
        },
        downloadJson(filename = `frame-profile-${Date.now()}.json`) {
            const payload = {
                meta: {
                    exportedAt: new Date().toISOString(),
                    sampleCount: samples.length,
                    recording,
                    maxSamples
                },
                samples
            };
            const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = filename;
            anchor.click();
            URL.revokeObjectURL(url);
        },
        summarizeBufferUpload() {
            return analyzeBufferUploadProfile(samples, {
                sampleCount: samples.length,
                hasBufferUpload: samples.some((s) => s.bufferUpload),
                exportedAt: new Date().toISOString()
            });
        },
        downloadBufferUploadTable(filename?: string) {
            const report = analyzeBufferUploadProfile(samples, {
                sampleCount: samples.length,
                hasBufferUpload: samples.some((s) => s.bufferUpload),
                exportedAt: new Date().toISOString(),
                scene: typeof location !== 'undefined' ? location.href : undefined
            });
            const name = filename ?? `buffer-upload-table-${Date.now()}.md`;
            const blob = new Blob([report.markdown], { type: 'text/markdown' });
            const url = URL.createObjectURL(blob);
            const anchor = document.createElement('a');
            anchor.href = url;
            anchor.download = name;
            anchor.click();
            URL.revokeObjectURL(url);
            return report;
        },
        summarizeBakeAcceptance() {
            return summarizeBakeAcceptance(samples);
        }
    };

    const target = globalThis as typeof globalThis & { __frameProfiler?: FrameProfilerApi };
    target.__frameProfiler = api;

    console.info(
        '[frame-profiler] ready · start/stop · applyCameraDelta · copyJson · downloadBufferUploadTable()'
    );

    if (options?.autoStart) {
        api.start();
    }

    return () => {
        app.off('frameupdate', onFrameUpdate);
        app.off('framerender', onFrameRender);
        app.off('postrender', onPostRender);
        app.off('frameend', onFrameEnd);
        if (target.__frameProfiler === api) {
            delete target.__frameProfiler;
        }
    };
}

export function shouldInitFrameProfiler(config: {
    frameProfile?: boolean | 'auto';
    benchmark?: boolean;
}): boolean {
    return config.frameProfile === true || config.frameProfile === 'auto' || !!config.benchmark;
}

export function shouldAutoStartFrameProfiler(config: {
    frameProfile?: boolean | 'auto';
    benchmark?: boolean;
}): boolean {
    // Scene Profile benchmark 自行 start/clear，避免加载阶段样本污染验收窗
    if (config.benchmark) {
        return config.frameProfile === true;
    }
    return config.frameProfile === true || config.frameProfile === 'auto';
}
