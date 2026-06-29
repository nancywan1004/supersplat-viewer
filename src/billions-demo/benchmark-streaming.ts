import { GSplatComponentSystem, type AppBase } from 'playcanvas';

import {
    BENCHMARK_OBSERVE_MS,
    BenchmarkMemoryTracker,
    percentile,
    readGsplatsM,
    readJsHeapUsedMB,
    readVramTexMB,
    REFINEMENT_STABLE_OBSERVATIONS,
    REFINEMENT_TIMEOUT_MS,
    type RefinementWaitResult
} from '../benchmark/benchmark-refinement';
import { emitBenchmarkRefineTick } from './benchmark-events';

export type StreamingSnapshot = {
    pendingNodes: number;
    refinementRatio: number;
    ready: boolean;
};

export class BillionsStreamingObserver {
    private loadingCount = 0;
    private ready = false;

    attach(gsplatSystem: GSplatComponentSystem) {
        gsplatSystem.on(
            GSplatComponentSystem.EVENT_FRAMEREADY,
            (_cam: unknown, _layer: unknown, ready: boolean, loadingCount: number) => {
                this.ready = ready;
                this.loadingCount = loadingCount;
            }
        );
    }

    snapshot(): StreamingSnapshot {
        const clear = this.ready && this.loadingCount === 0;
        return {
            pendingNodes: this.loadingCount,
            refinementRatio: clear ? 1 : 0,
            ready: this.ready
        };
    }
}

export async function waitForStreamingClear(
    app: AppBase,
    observer: BillionsStreamingObserver,
    caseMemoryTracker?: BenchmarkMemoryTracker
): Promise<RefinementWaitResult> {
    const arrivalSnapshot = observer.snapshot();
    const fpsSamples: number[] = [];
    let stableObservations = 0;
    let blurToClearMs: number | null = null;
    let ratioAtClear: number | null = null;
    let gsplatsAtClearM: number | null = null;
    let jsHeapAtClearMb: number | null = null;
    let vramTexAtClearMb: number | null = null;
    const loopStartMs = performance.now();
    const refineMemory = new BenchmarkMemoryTracker(app);

    let peakPending = arrivalSnapshot.pendingNodes;
    let peakPendingAtMs = loopStartMs;

    const emitTick = (snapshot: StreamingSnapshot, blurMs: number | null) => {
        const elapsedSincePeak =
            blurMs !== null
                ? blurMs
                : peakPending > 0
                    ? performance.now() - peakPendingAtMs
                    : null;
        emitBenchmarkRefineTick({
            pendingNodes: snapshot.pendingNodes,
            pendingPeakNodes: peakPending,
            refinementRatio: snapshot.refinementRatio,
            ready: snapshot.ready,
            elapsedSincePeakMs: elapsedSincePeak,
            blurToClearMs: blurMs
        });
    };

    return new Promise((resolve) => {
        const onObserve = () => {
            const now = performance.now();
            const fps = app.stats.frame.fps;
            if (Number.isFinite(fps) && fps > 0) {
                fpsSamples.push(fps);
            }

            refineMemory.sample();
            caseMemoryTracker?.sample();

            const snapshot = observer.snapshot();

            if (snapshot.pendingNodes > peakPending) {
                peakPending = snapshot.pendingNodes;
                peakPendingAtMs = now;
            }

            const isClear =
                snapshot.pendingNodes === 0 &&
                snapshot.refinementRatio >= 0.95 &&
                snapshot.ready;

            if (isClear) {
                stableObservations++;
            } else {
                stableObservations = 0;
            }

            if (stableObservations >= REFINEMENT_STABLE_OBSERVATIONS && blurToClearMs === null) {
                blurToClearMs = peakPending > 0 ? now - peakPendingAtMs : 0;
                ratioAtClear = snapshot.refinementRatio;
                gsplatsAtClearM = readGsplatsM(app);
                jsHeapAtClearMb = readJsHeapUsedMB();
                vramTexAtClearMb = readVramTexMB(app);
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
