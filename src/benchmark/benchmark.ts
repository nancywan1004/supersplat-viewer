import type { EventHandler } from 'playcanvas';

import type { Global } from '../types';
import { BenchmarkMemoryTracker } from './benchmark-refinement';
import {
    runBenchmarkAnimTrackPhase,
    type BenchmarkAnimTrackPhaseResult,
    type BenchmarkAnimTrackReport,
    type BenchmarkAnimKeyframeResult
} from './benchmark-anim-track';

export type SceneProfileBenchmarkCaseResult = {
    label: string;
    budget?: number;
    firstFrameMs: number | null;
    settleStartMs: number | null;
    fpsP50: number | null;
    fpsP95: number | null;
    gsplatsAvgM: number | null;
    jsHeapAtFirstFrameMb: number | null;
    vramTexAtFirstFrameMb: number | null;
    jsHeapPeakMb: number | null;
    vramTexPeakMb: number | null;
    rendererUsed: string;
    interactionWaypoints?: BenchmarkAnimKeyframeResult[];
    animTrackBenchmark?: BenchmarkAnimTrackReport;
    timestamp: string;
};

export type SceneProfileBenchmarkReport = {
    benchmarkAxis: 'profile';
    cases: SceneProfileBenchmarkCaseResult[];
};

declare global {
    interface Window {
        __sceneProfileBenchmark?: SceneProfileBenchmarkReport;
    }
}

export class SceneProfileBenchmarkHarness {
    private readonly global: Global;
    private readonly events: EventHandler;
    private enabled: boolean;
    private label = 'default';
    private startMs = 0;
    private firstFrameMs: number | null = null;
    private settleStartMs: number | null = null;
    private animTrackBenchmark: BenchmarkAnimTrackPhaseResult | null = null;
    private finished = false;
    private unsubs: Array<() => void> = [];
    private memoryTracker: BenchmarkMemoryTracker | null = null;
    private jsHeapAtFirstFrameMb: number | null = null;
    private vramTexAtFirstFrameMb: number | null = null;

    constructor(global: Global) {
        this.global = global;
        this.events = global.events;
        this.enabled = !!global.config.benchmark;
    }

    setCaseLabel(label: string) {
        this.label = label;
    }

    start() {
        if (!this.enabled || this.startMs > 0) {
            return;
        }
        this.startMs = performance.now();
        this.bindEvents();
    }

    private bindEvents() {
        const onFirstFrame = () => {
            if (this.firstFrameMs !== null) {
                return;
            }
            this.firstFrameMs = performance.now() - this.startMs;
            this.memoryTracker = new BenchmarkMemoryTracker(this.global.app);
            this.memoryTracker.sample();
            const atFirst = this.memoryTracker.current();
            this.jsHeapAtFirstFrameMb = atFirst.jsHeapUsedMb;
            this.vramTexAtFirstFrameMb = atFirst.vramTexMb;
            this.events.fire('sceneProfileBenchmark:phase', { phase: 'post-load' });
            void this.beginPostLoadPhase();
        };

        this.events.on('firstFrame', onFirstFrame);
        this.unsubs.push(() => this.events.off('firstFrame', onFirstFrame));
    }

    private shouldRunAnimTrackBenchmark(): boolean {
        const { config, settings } = this.global;
        if (config.benchmarkNoInteraction) {
            return false;
        }
        if (config.benchmarkAnimTrack) {
            return true;
        }
        return settings.startMode === 'animTrack' && (settings.animTracks?.length ?? 0) > 0;
    }

    private async beginPostLoadPhase() {
        if (this.settleStartMs !== null) {
            return;
        }
        this.settleStartMs = performance.now();

        if (this.shouldRunAnimTrackBenchmark()) {
            try {
                this.animTrackBenchmark = await runBenchmarkAnimTrackPhase(
                    this.global,
                    this.memoryTracker ?? undefined
                );
            } catch (err) {
                console.warn('[SceneProfileBenchmark] animTrack phase failed:', err);
                this.animTrackBenchmark = {
                    keyframes: [],
                    fpsP50DuringPlayback: null,
                    fpsP95DuringPlayback: null,
                    fpsMinDuringPlayback: null,
                    totalPlaybackMs: 0,
                    playbackFpsSamples: []
                };
            }
        }

        this.finish();
    }

    private percentile(values: number[], p: number): number | null {
        if (!values.length) {
            return null;
        }
        const sorted = [...values].sort((a, b) => a - b);
        const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
        return sorted[idx];
    }

    private finish() {
        if (this.finished) {
            return;
        }
        this.finished = true;

        const animPlayback = this.animTrackBenchmark;
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

        const animTrackExport: BenchmarkAnimTrackReport | undefined = animPlayback
            ? {
                keyframes: animPlayback.keyframes,
                fpsP50DuringPlayback: animPlayback.fpsP50DuringPlayback,
                fpsP95DuringPlayback: animPlayback.fpsP95DuringPlayback,
                fpsMinDuringPlayback: animPlayback.fpsMinDuringPlayback,
                totalPlaybackMs: animPlayback.totalPlaybackMs
            }
            : undefined;

        const memoryPeaks = this.memoryTracker?.peaks() ?? {
            jsHeapPeakMb: null,
            vramTexPeakMb: null
        };

        const result: SceneProfileBenchmarkCaseResult = {
            label: this.label,
            budget: this.global.config.budget,
            firstFrameMs: this.firstFrameMs,
            settleStartMs: this.settleStartMs ? this.settleStartMs - this.startMs : null,
            fpsP50: this.percentile(fpsValues, 0.5),
            fpsP95: this.percentile(fpsValues, 0.95),
            gsplatsAvgM: gsplatsAvg,
            jsHeapAtFirstFrameMb: this.jsHeapAtFirstFrameMb,
            vramTexAtFirstFrameMb: this.vramTexAtFirstFrameMb,
            jsHeapPeakMb: memoryPeaks.jsHeapPeakMb,
            vramTexPeakMb: memoryPeaks.vramTexPeakMb,
            rendererUsed: String(this.global.config.renderer),
            interactionWaypoints: animPlayback?.keyframes,
            animTrackBenchmark: animTrackExport,
            timestamp: new Date().toISOString()
        };

        window.__sceneProfileBenchmark = {
            benchmarkAxis: 'profile',
            cases: [result]
        };

        console.info('[SceneProfileBenchmark]', result);
        this.events.fire('sceneProfileBenchmark:complete', result);
        this.destroy();
    }

    destroy() {
        for (const off of this.unsubs) {
            off();
        }
        this.unsubs = [];
    }
}

export function createSceneProfileBenchmark(global: Global): SceneProfileBenchmarkHarness | null {
    if (!global.config.benchmark) {
        return null;
    }
    return new SceneProfileBenchmarkHarness(global);
}

export function applyBenchmarkConfigFlags(config: {
    benchmark?: boolean;
    benchmarkAnimTrack?: boolean;
    noui?: boolean;
    nofx?: boolean;
    noreveal?: boolean;
    noanim?: boolean;
}): void {
    if (!config.benchmark) {
        return;
    }
    config.noui = true;
    config.nofx = true;
    config.noreveal = true;
    if (!config.benchmarkAnimTrack) {
        config.noanim = true;
    }
}
