import type { RefinementTickPayload } from '../benchmark/benchmark-refinement';

function fire<T>(name: string, detail: T) {
    window.dispatchEvent(new CustomEvent(name, { detail }));
}

export function emitBenchmarkPhase(detail: { phase: string; keyframe?: string }) {
    fire('sceneProfileBenchmark:phase', detail);
}

export function emitBenchmarkRefineTick(detail: RefinementTickPayload) {
    fire('sceneProfileBenchmark:refineTick', detail);
}

export function emitBenchmarkKeyframeRefine(detail: {
    keyframe?: string;
    blurToClearMs?: number | null;
    pendingPeakNodes?: number;
    pendingNodesAtArrival?: number;
    refineTimedOut?: boolean;
}) {
    fire('sceneProfileBenchmark:keyframeRefine', detail);
}

export function emitBenchmarkComplete() {
    fire('sceneProfileBenchmark:complete', {});
}
