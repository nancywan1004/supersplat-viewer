import type { AppBase, Entity } from 'playcanvas';

import type { BenchmarkAnimKeyframeResult, BenchmarkAnimTrackPhaseResult } from '../benchmark/benchmark-anim-track';
import { percentile, BenchmarkMemoryTracker } from '../benchmark/benchmark-refinement';
import { BENCHMARK_SCREENSHOT_SIZE } from '../benchmark/benchmark-screenshot';
import { captureViewportJpegBlob } from '../render/capture-viewport-screenshot';
import type { AnimTrack, ExperienceSettings } from '../settings';
import {
    BillionsAnimCameraController,
    buildMultiTileAnimTrack,
    keyframeTimesSec,
    type BillionsTileBounds
} from './benchmark-anim-camera';
import { emitBenchmarkKeyframeRefine, emitBenchmarkPhase } from './benchmark-events';
import { BillionsStreamingObserver, waitForStreamingClear } from './benchmark-streaming';

function blobToBase64(blob: Blob): Promise<string> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const dataUrl = reader.result;
            if (typeof dataUrl !== 'string') {
                reject(new Error('FileReader did not return data URL'));
                return;
            }
            const comma = dataUrl.indexOf(',');
            resolve(comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl);
        };
        reader.onerror = () => reject(reader.error ?? new Error('FileReader failed'));
        reader.readAsDataURL(blob);
    });
}

async function captureScreenshot(app: AppBase): Promise<string | null> {
    try {
        const blob = await captureViewportJpegBlob(app, BENCHMARK_SCREENSHOT_SIZE);
        return await blobToBase64(blob);
    } catch (err) {
        console.warn('[BillionsBenchmark] screenshot failed', err);
        return null;
    }
}

function pickAnimTrack(settings: ExperienceSettings): AnimTrack | null {
    if (settings.startMode !== 'animTrack') {
        return null;
    }
    return settings.animTracks?.[0] ?? null;
}

export async function runBillionsAnimTrackPhase(
    app: AppBase,
    camera: Entity,
    instanceEntities: Entity[],
    tileBounds: BillionsTileBounds,
    settings: ExperienceSettings,
    observer: BillionsStreamingObserver,
    caseMemoryTracker?: BenchmarkMemoryTracker
): Promise<BenchmarkAnimTrackPhaseResult> {
    const sourceTrack = pickAnimTrack(settings);
    if (!sourceTrack) {
        return {
            keyframes: [],
            fpsP50DuringPlayback: null,
            fpsP95DuringPlayback: null,
            fpsMinDuringPlayback: null,
            totalPlaybackMs: 0,
            playbackFpsSamples: []
        };
    }

    const settingsExt = settings as {
        billionsAnimTrackWorldSpace?: boolean;
        billionsAnimTrackMultiTile?: boolean;
    };
    const useWorldSpace = !!settingsExt.billionsAnimTrackWorldSpace;
    const multiTile = settingsExt.billionsAnimTrackMultiTile !== false;
    const worldTrack = buildMultiTileAnimTrack(sourceTrack, instanceEntities, {
        useWorldSpace,
        instanceRoot: instanceEntities[0],
        multiTile,
        tileBounds
    });
    const animCamera = new BillionsAnimCameraController(worldTrack, camera, app);
    const keyframeTimes = keyframeTimesSec(sourceTrack);
    const playbackFpsSamples: number[] = [];
    const keyframeResults: BenchmarkAnimKeyframeResult[] = [];
    let totalPlaybackMs = 0;

    await animCamera.scrubToAnimTime(0);

    for (let i = 0; i < keyframeTimes.length; i++) {
        emitBenchmarkPhase({ phase: 'anim', keyframe: `kf-${i}` });
        const animTimeSec = keyframeTimes[i];
        let moveMs = 0;

        if (i > 0) {
            const prevTime = keyframeTimes[i - 1];
            moveMs = await animCamera.playUntilAnimTime(prevTime, animTimeSec, playbackFpsSamples);
            totalPlaybackMs += moveMs;
        } else {
            await animCamera.scrubToAnimTime(animTimeSec);
        }

        app.renderNextFrame = true;
        const refine = await waitForStreamingClear(app, observer, caseMemoryTracker);
        const screenshotJpegBase64 = await captureScreenshot(app);
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
        emitBenchmarkKeyframeRefine({
            keyframe: `kf-${i}`,
            blurToClearMs: refine.blurToClearMs,
            pendingPeakNodes: refine.pendingPeakNodes,
            pendingNodesAtArrival: refine.pendingNodesAtArrival,
            refineTimedOut: refine.refineTimedOut
        });
    }

    return {
        keyframes: keyframeResults,
        fpsP50DuringPlayback: percentile(playbackFpsSamples, 0.5),
        fpsP95DuringPlayback: percentile(playbackFpsSamples, 0.95),
        fpsMinDuringPlayback: playbackFpsSamples.length ? Math.min(...playbackFpsSamples) : null,
        totalPlaybackMs,
        playbackFpsSamples
    };
}
