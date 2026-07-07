import type { AppBase } from 'playcanvas';

import type { OctreeRefinementController, OctreeRefinementTickMetrics } from '../loaders/gsplat/lod/octree/refinement-controller';
import type { NativeStreamingObserver } from '../loaders/gsplat/lod/octree/native-streaming-observer';
import { isNativeLodRuntime } from '../loaders/gsplat/lod/scene-profile';
import type { Global } from '../types';

export const REFINEMENT_CLEAR_RATIO = 0.95;
/** 观测轮询间隔：只读采样，不驱动 refinement / LOD */
export const BENCHMARK_OBSERVE_MS = 200;
/** 连续清晰观测次数（× BENCHMARK_OBSERVE_MS）判定 blur→clear */
export const REFINEMENT_STABLE_OBSERVATIONS = 4;
export const REFINEMENT_TIMEOUT_MS = 45_000;

export type RefinementWaitResult = {
    blurToClearMs: number | null;
    refineTimedOut: boolean;
    pendingNodesAtArrival: number;
    pendingPeakNodes: number;
    refinementRatioAtClear: number | null;
    fpsP50DuringRefine: number | null;
    fpsP95DuringRefine: number | null;
    fpsMinDuringRefine: number | null;
    gsplatsAtClearM: number | null;
    jsHeapAtClearMb: number | null;
    vramTexAtClearMb: number | null;
    jsHeapPeakDuringRefineMb: number | null;
    vramTexPeakDuringRefineMb: number | null;
};

export type RefinementTickPayload = {
    pendingNodes: number;
    pendingPeakNodes: number;
    refinementRatio: number;
    ready: boolean;
    elapsedSincePeakMs: number | null;
    blurToClearMs: number | null;
};

export type RefinementSnapshot = {
    pendingNodes: number;
    refinementRatio: number;
    ready: boolean;
};

type ViewerLike = {
    octreeRefinementController?: OctreeRefinementController | null;
    nativeStreamingObserver?: NativeStreamingObserver | null;
};

function getNativeStreamingObserver(global: Global): NativeStreamingObserver | null {
    const viewer = (global.app as { viewer?: ViewerLike }).viewer;
    return viewer?.nativeStreamingObserver ?? null;
}

export function readGsplatsM(app: AppBase): number | null {
    const frame = (app.stats as { frame?: { gsplats?: number } })?.frame;
    const n = frame?.gsplats;
    return Number.isFinite(n) ? (n as number) / 1_000_000 : null;
}

export function readJsHeapUsedMB(): number | null {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
    const n = mem?.usedJSHeapSize;
    return Number.isFinite(n) ? (n as number) / (1024 * 1024) : null;
}

export function readVramTexMB(app: AppBase): number | null {
    const vram = (app.stats as { vram?: { tex?: number } })?.vram;
    const n = vram?.tex;
    return Number.isFinite(n) ? (n as number) / (1024 * 1024) : null;
}

export class BenchmarkMemoryTracker {
    private jsHeapPeak: number | null = null;
    private vramTexPeak: number | null = null;

    constructor(private readonly app: AppBase) {}

    sample(): void {
        const js = readJsHeapUsedMB();
        const vram = readVramTexMB(this.app);
        if (js !== null) {
            this.jsHeapPeak = this.jsHeapPeak === null ? js : Math.max(this.jsHeapPeak, js);
        }
        if (vram !== null) {
            this.vramTexPeak = this.vramTexPeak === null ? vram : Math.max(this.vramTexPeak, vram);
        }
    }

    current(): { jsHeapUsedMb: number | null; vramTexMb: number | null } {
        return {
            jsHeapUsedMb: readJsHeapUsedMB(),
            vramTexMb: readVramTexMB(this.app)
        };
    }

    peaks(): { jsHeapPeakMb: number | null; vramTexPeakMb: number | null } {
        return {
            jsHeapPeakMb: this.jsHeapPeak,
            vramTexPeakMb: this.vramTexPeak
        };
    }
}

export function percentile(values: number[], p: number): number | null {
    if (!values.length) {
        return null;
    }
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx];
}

export function getRefinementController(global: Global): OctreeRefinementController | null {
    const viewer = (global.app as { viewer?: ViewerLike }).viewer;
    return viewer?.octreeRefinementController ?? null;
}

export function readRefinementTickMetrics(global: Global): OctreeRefinementTickMetrics | null {
    return getRefinementController(global)?.getLastTickMetrics() ?? null;
}

function formatHudMs(value: number): string {
    if (!Number.isFinite(value) || value <= 0) {
        return '0';
    }
    return value < 10 ? value.toFixed(1) : value.toFixed(0);
}

/** benchmarkHud 调度指标区块 HTML */
export function renderRefinementTickMetricsHtml(metrics: OctreeRefinementTickMetrics): string {
    const row = (label: string, value: string) =>
        `<div class="benchmark-hud-row"><span class="benchmark-hud-label">${label}</span><span class="benchmark-hud-value">${value}</span></div>`;
    const { timingsMs } = metrics;
    const lines: string[] = [
        '<div class="benchmark-hud-section-title">Scheduler tick (≠ frame)</div>',
        row('Scan mode', metrics.scanMode),
        row(
            'Tick ms',
            `${formatHudMs(timingsMs.total)} (scan ${formatHudMs(timingsMs.scan)} · q ${formatHudMs(timingsMs.queue)} · sync ${formatHudMs(timingsMs.sync)})`
        ),
        row('Leaves', `${metrics.leavesEvaluated} · vis ${metrics.visibleLeaves} · scored ${metrics.scoredLeaves}`),
        row('Cand refs', `${metrics.candidateFileRefs} · uniq ${metrics.candidateUniqueFiles}`),
        row('Stale LOD', `${metrics.staleLodNodes} · loaded ${metrics.staleLoadedNodes} · mismatch ${metrics.lodDisplayMismatch}`),
        row('Burst', `${metrics.cameraBurstFrames} fr${metrics.boostActive ? ' · boost' : ''}`),
        row('Downloads', `${metrics.inFlight} fly · q${metrics.queueLen}${metrics.staleInFlight > 0 ? ` · stale ${metrics.staleInFlight}` : ''}`),
        row('LOD est', `cur ${metrics.visibleSplatsCurrentM.toFixed(2)}M · tgt ${metrics.visibleSplatsTargetM.toFixed(2)}M`)
    ];
    return lines.join('');
}

/** 只读观测：不触发 refinement 调度 */
export function readRefinementSnapshot(global: Global): RefinementSnapshot {
    if (isNativeLodRuntime(global)) {
        const observer = getNativeStreamingObserver(global);
        if (observer) {
            return observer.snapshot();
        }
        return { pendingNodes: 0, refinementRatio: 0, ready: false };
    }

    const controller = getRefinementController(global);
    if (!controller) {
        return { pendingNodes: 0, refinementRatio: 1, ready: true };
    }
    const status = controller.getStreamingRefinementStatus();
    return {
        pendingNodes: status.pendingNodes,
        refinementRatio: status.refinementRatio,
        ready: status.ready
    };
}

export async function waitForRefinementClear(
    global: Global,
    caseMemoryTracker?: BenchmarkMemoryTracker
): Promise<RefinementWaitResult> {
    const arrivalSnapshot = readRefinementSnapshot(global);
    const fpsSamples: number[] = [];
    let stableObservations = 0;
    let blurToClearMs: number | null = null;
    let ratioAtClear: number | null = null;
    let gsplatsAtClearM: number | null = null;
    let jsHeapAtClearMb: number | null = null;
    let vramTexAtClearMb: number | null = null;
    const loopStartMs = performance.now();
    const refineMemory = new BenchmarkMemoryTracker(global.app);

    let peakPending = arrivalSnapshot.pendingNodes;
    let peakPendingAtMs = loopStartMs;

    const emitTick = (snapshot: RefinementSnapshot, blurMs: number | null) => {
        const elapsedSincePeak =
            blurMs !== null
                ? blurMs
                : peakPending > 0
                    ? performance.now() - peakPendingAtMs
                    : null;
        global.events.fire('sceneProfileBenchmark:refineTick', {
            pendingNodes: snapshot.pendingNodes,
            pendingPeakNodes: peakPending,
            refinementRatio: snapshot.refinementRatio,
            ready: snapshot.ready,
            elapsedSincePeakMs: elapsedSincePeak,
            blurToClearMs: blurMs
        } satisfies RefinementTickPayload);
    };

    return new Promise((resolve) => {
        const onObserve = () => {
            const now = performance.now();
            const fps = global.app.stats.frame.fps;
            if (Number.isFinite(fps) && fps > 0) {
                fpsSamples.push(fps);
            }

            refineMemory.sample();
            caseMemoryTracker?.sample();

            const snapshot = readRefinementSnapshot(global);

            if (snapshot.pendingNodes > peakPending) {
                peakPending = snapshot.pendingNodes;
                peakPendingAtMs = now;
            }

            const isClear =
                snapshot.pendingNodes === 0 &&
                snapshot.refinementRatio >= REFINEMENT_CLEAR_RATIO &&
                snapshot.ready;

            if (isClear) {
                stableObservations++;
            } else {
                stableObservations = 0;
            }

            if (stableObservations >= REFINEMENT_STABLE_OBSERVATIONS && blurToClearMs === null) {
                blurToClearMs = peakPending > 0 ? now - peakPendingAtMs : 0;
                ratioAtClear = snapshot.refinementRatio;
                gsplatsAtClearM = readGsplatsM(global.app);
                jsHeapAtClearMb = readJsHeapUsedMB();
                vramTexAtClearMb = readVramTexMB(global.app);
                emitTick(snapshot, blurToClearMs);
            } else if (blurToClearMs === null) {
                emitTick(snapshot, null);
            }

            if (blurToClearMs !== null || now - loopStartMs >= REFINEMENT_TIMEOUT_MS) {
                window.clearInterval(observeTimer);
                const refinePeaks = refineMemory.peaks();
                resolve({
                    blurToClearMs,
                    refineTimedOut: blurToClearMs === null,
                    pendingNodesAtArrival: arrivalSnapshot.pendingNodes,
                    pendingPeakNodes: peakPending,
                    refinementRatioAtClear: ratioAtClear,
                    fpsP50DuringRefine: percentile(fpsSamples, 0.5),
                    fpsP95DuringRefine: percentile(fpsSamples, 0.95),
                    fpsMinDuringRefine: fpsSamples.length ? Math.min(...fpsSamples) : null,
                    gsplatsAtClearM,
                    jsHeapAtClearMb,
                    vramTexAtClearMb,
                    jsHeapPeakDuringRefineMb: refinePeaks.jsHeapPeakMb,
                    vramTexPeakDuringRefineMb: refinePeaks.vramTexPeakMb
                });
            }
        };

        const observeTimer = window.setInterval(onObserve, BENCHMARK_OBSERVE_MS);
        onObserve();
    });
}
