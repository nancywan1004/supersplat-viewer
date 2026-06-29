import type { AppBase, Entity, GSplatComponentSystem } from 'playcanvas';

import type { SceneProfileBenchmarkCaseResult, SceneProfileBenchmarkReport } from '../benchmark/benchmark';
import type { BenchmarkAnimTrackReport } from '../benchmark/benchmark-anim-track';
import { BenchmarkMemoryTracker, percentile } from '../benchmark/benchmark-refinement';
import type { ExperienceSettings } from '../settings';
import type { BillionsTileBounds } from './benchmark-anim-camera';
import type { BillionsBenchmarkConfig } from './benchmark-config';
import { emitBenchmarkComplete, emitBenchmarkPhase } from './benchmark-events';
import { runBillionsAnimTrackPhase } from './benchmark-anim-track';
import { BillionsStreamingObserver } from './benchmark-streaming';

declare global {
    interface Window {
        __sceneProfileBenchmark?: SceneProfileBenchmarkReport;
    }
}

export type BillionsBenchmarkContext = {
    app: AppBase;
    camera: Entity;
    instanceEntities: Entity[];
    tileBounds: BillionsTileBounds;
    gsplatSystem: GSplatComponentSystem;
    config: BillionsBenchmarkConfig;
    instances: number;
};

async function loadSettings(settingsPath: string): Promise<ExperienceSettings> {
    const res = await fetch(settingsPath);
    if (!res.ok) {
        throw new Error(`Failed to load settings: ${settingsPath} (${res.status})`);
    }
    return res.json() as Promise<ExperienceSettings>;
}

export class BillionsBenchmarkHarness {
    private readonly ctx: BillionsBenchmarkContext;
    private readonly observer = new BillionsStreamingObserver();
    private readonly startMs = performance.now();
    private firstFrameMs: number | null = null;
    private memoryTracker: BenchmarkMemoryTracker | null = null;
    private jsHeapAtFirstFrameMb: number | null = null;
    private vramTexAtFirstFrameMb: number | null = null;
    private finished = false;

    constructor(ctx: BillionsBenchmarkContext) {
        this.ctx = ctx;
        this.observer.attach(ctx.gsplatSystem);
    }

    async onInitialStreamingReady(): Promise<void> {
        if (this.firstFrameMs !== null || this.finished) {
            return;
        }

        this.firstFrameMs = performance.now() - this.startMs;
        this.memoryTracker = new BenchmarkMemoryTracker(this.ctx.app);
        this.memoryTracker.sample();
        const atFirst = this.memoryTracker.current();
        this.jsHeapAtFirstFrameMb = atFirst.jsHeapUsedMb;
        this.vramTexAtFirstFrameMb = atFirst.vramTexMb;
        emitBenchmarkPhase({ phase: 'post-load' });

        let animTrackBenchmark: BenchmarkAnimTrackReport | undefined;
        let animPlayback = null as Awaited<ReturnType<typeof runBillionsAnimTrackPhase>> | null;

        if (this.ctx.config.benchmarkAnimTrack && this.ctx.config.settings) {
            try {
                const settings = await loadSettings(this.ctx.config.settings);
                animPlayback = await runBillionsAnimTrackPhase(
                    this.ctx.app,
                    this.ctx.camera,
                    this.ctx.instanceEntities,
                    this.ctx.tileBounds,
                    settings,
                    this.observer,
                    this.memoryTracker
                );
                animTrackBenchmark = {
                    keyframes: animPlayback.keyframes,
                    fpsP50DuringPlayback: animPlayback.fpsP50DuringPlayback,
                    fpsP95DuringPlayback: animPlayback.fpsP95DuringPlayback,
                    fpsMinDuringPlayback: animPlayback.fpsMinDuringPlayback,
                    totalPlaybackMs: animPlayback.totalPlaybackMs
                };
            } catch (err) {
                console.warn('[BillionsBenchmark] animTrack phase failed:', err);
                animTrackBenchmark = {
                    keyframes: [],
                    fpsP50DuringPlayback: null,
                    fpsP95DuringPlayback: null,
                    fpsMinDuringPlayback: null,
                    totalPlaybackMs: 0
                };
            }
        }

        this.finish(animPlayback, animTrackBenchmark);
    }

    private finish(
        animPlayback: Awaited<ReturnType<typeof runBillionsAnimTrackPhase>> | null,
        animTrackExport?: BenchmarkAnimTrackReport
    ) {
        if (this.finished) {
            return;
        }
        this.finished = true;

        const fpsValues = animPlayback?.playbackFpsSamples?.length
            ? animPlayback.playbackFpsSamples.filter((v) => Number.isFinite(v) && v > 0)
            : [];
        const gsplatValues = animPlayback
            ? animPlayback.keyframes
                .map((k) => k.gsplatsAtClearM)
                .filter((v): v is number => v !== null && Number.isFinite(v))
            : [];
        const gsplatsAvg = gsplatValues.length
            ? gsplatValues.reduce((a, b) => a + b, 0) / gsplatValues.length
            : null;

        const memoryPeaks = this.memoryTracker?.peaks() ?? {
            jsHeapPeakMb: null,
            vramTexPeakMb: null
        };

        const result: SceneProfileBenchmarkCaseResult & {
            instances?: number;
            lodRuntime?: string;
        } = {
            label: this.ctx.config.benchmarkLabel,
            firstFrameMs: this.firstFrameMs,
            settleStartMs: this.firstFrameMs,
            fpsP50: percentile(fpsValues, 0.5),
            fpsP95: percentile(fpsValues, 0.95),
            gsplatsAvgM: gsplatsAvg,
            jsHeapAtFirstFrameMb: this.jsHeapAtFirstFrameMb,
            vramTexAtFirstFrameMb: this.vramTexAtFirstFrameMb,
            jsHeapPeakMb: memoryPeaks.jsHeapPeakMb,
            vramTexPeakMb: memoryPeaks.vramTexPeakMb,
            rendererUsed: this.ctx.app.graphicsDevice.isWebGPU ? 'webgpu' : 'webgl',
            interactionWaypoints: animPlayback?.keyframes,
            animTrackBenchmark: animTrackExport,
            timestamp: new Date().toISOString(),
            instances: this.ctx.instances,
            lodRuntime: 'native'
        };

        window.__sceneProfileBenchmark = {
            benchmarkAxis: 'profile',
            cases: [result]
        };

        console.info('[BillionsBenchmark]', result);
        emitBenchmarkComplete();
    }
}

export function createBillionsBenchmarkHarness(ctx: BillionsBenchmarkContext): BillionsBenchmarkHarness | null {
    if (!ctx.config.benchmark) {
        return null;
    }
    return new BillionsBenchmarkHarness(ctx);
}
