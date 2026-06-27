import type { Global } from '../types';
import type { AnimTrack } from '../settings';
import {
    percentile,
    waitForRefinementClear,
    type BenchmarkMemoryTracker
} from './benchmark-refinement';
import { captureBenchmarkClearScreenshot } from './benchmark-screenshot';

export type BenchmarkAnimKeyframeResult = {
    label: string;
    keyframeIndex: number;
    animTimeSec: number;
    moveMs: number;
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
    screenshotPath?: string;
    screenshotJpegBase64?: string;
};

export type BenchmarkAnimTrackReport = {
    keyframes: BenchmarkAnimKeyframeResult[];
    fpsP50DuringPlayback: number | null;
    fpsP95DuringPlayback: number | null;
    fpsMinDuringPlayback: number | null;
    totalPlaybackMs: number;
};

export type BenchmarkAnimTrackPhaseResult = BenchmarkAnimTrackReport & {
    playbackFpsSamples: number[];
};

const ANIM_TIME_EPSILON_SEC = 0.05;

function getAnimTrack(global: Global): AnimTrack | null {
    const { settings } = global;
    if (settings.startMode !== 'animTrack') {
        return null;
    }
    return settings.animTracks?.[0] ?? null;
}

function keyframeTimesSec(track: AnimTrack): number[] {
    const { times } = track.keyframes;
    const frameRate = track.frameRate || 30;
    return times.map((frame) => frame / frameRate);
}

async function scrubToAnimTime(global: Global, timeSec: number): Promise<void> {
    const { state, events, app } = global;
    state.animationPaused = true;
    state.cameraMode = 'anim';
    await new Promise<void>((resolve) => {
        events.fire('scrubAnim', timeSec);
        app.renderNextFrame = true;
        app.once('frameend', () => resolve());
    });
}

async function playUntilAnimTime(
    global: Global,
    targetSec: number,
    fpsSamples: number[],
    caseMemoryTracker?: BenchmarkMemoryTracker
): Promise<number> {
    const { state, app } = global;
    const startMs = performance.now();
    state.animationPaused = false;
    state.cameraMode = 'anim';
    app.renderNextFrame = true;

    return new Promise((resolve) => {
        const onUpdate = () => {
            const fps = app.stats.frame.fps;
            if (Number.isFinite(fps) && fps > 0) {
                fpsSamples.push(fps);
            }
            caseMemoryTracker?.sample();

            if (state.animationTime >= targetSec - ANIM_TIME_EPSILON_SEC) {
                state.animationPaused = true;
                app.off('update', onUpdate);
                resolve(performance.now() - startMs);
            }
        };
        app.on('update', onUpdate);
    });
}

export async function runBenchmarkAnimTrackPhase(
    global: Global,
    caseMemoryTracker?: BenchmarkMemoryTracker
): Promise<BenchmarkAnimTrackPhaseResult> {
    const track = getAnimTrack(global);
    if (!track) {
        return {
            keyframes: [],
            fpsP50DuringPlayback: null,
            fpsP95DuringPlayback: null,
            fpsMinDuringPlayback: null,
            totalPlaybackMs: 0,
            playbackFpsSamples: []
        };
    }

    const keyframeTimes = keyframeTimesSec(track);
    const playbackFpsSamples: number[] = [];
    const keyframeResults: BenchmarkAnimKeyframeResult[] = [];
    let totalPlaybackMs = 0;

    await scrubToAnimTime(global, 0);

    for (let i = 0; i < keyframeTimes.length; i++) {
        global.events.fire('sceneProfileBenchmark:phase', { phase: 'anim', keyframe: `kf-${i}` });
        const animTimeSec = keyframeTimes[i];
        let moveMs = 0;

        if (i > 0) {
            const prevTime = keyframeTimes[i - 1];
            await scrubToAnimTime(global, prevTime);
            moveMs = await playUntilAnimTime(global, animTimeSec, playbackFpsSamples, caseMemoryTracker);
            totalPlaybackMs += moveMs;
        } else {
            await scrubToAnimTime(global, animTimeSec);
        }

        global.state.animationPaused = true;
        global.app.renderNextFrame = true;

        const refine = await waitForRefinementClear(global, caseMemoryTracker);
        const screenshotJpegBase64 = await captureBenchmarkClearScreenshot(global);
        keyframeResults.push({
            label: `kf-${i}`,
            keyframeIndex: i,
            animTimeSec,
            moveMs,
            blurToClearMs: refine.blurToClearMs,
            refineTimedOut: refine.refineTimedOut,
            pendingNodesAtArrival: refine.pendingNodesAtArrival,
            pendingPeakNodes: refine.pendingPeakNodes,
            refinementRatioAtClear: refine.refinementRatioAtClear,
            fpsP50DuringRefine: refine.fpsP50DuringRefine,
            fpsP95DuringRefine: refine.fpsP95DuringRefine,
            fpsMinDuringRefine: refine.fpsMinDuringRefine,
            gsplatsAtClearM: refine.gsplatsAtClearM,
            jsHeapAtClearMb: refine.jsHeapAtClearMb,
            vramTexAtClearMb: refine.vramTexAtClearMb,
            jsHeapPeakDuringRefineMb: refine.jsHeapPeakDuringRefineMb,
            vramTexPeakDuringRefineMb: refine.vramTexPeakDuringRefineMb,
            ...(screenshotJpegBase64 ? { screenshotJpegBase64 } : {})
        });
        global.events.fire('sceneProfileBenchmark:keyframeRefine', {
            keyframe: `kf-${i}`,
            blurToClearMs: refine.blurToClearMs,
            pendingPeakNodes: refine.pendingPeakNodes,
            pendingNodesAtArrival: refine.pendingNodesAtArrival,
            refineTimedOut: refine.refineTimedOut
        });
    }

    global.state.animationPaused = true;

    return {
        keyframes: keyframeResults,
        fpsP50DuringPlayback: percentile(playbackFpsSamples, 0.5),
        fpsP95DuringPlayback: percentile(playbackFpsSamples, 0.95),
        fpsMinDuringPlayback: playbackFpsSamples.length ? Math.min(...playbackFpsSamples) : null,
        totalPlaybackMs,
        playbackFpsSamples
    };
}
