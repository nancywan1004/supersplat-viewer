export type AnimLoopMode = 'none' | 'repeat' | 'pingpong';

type ResolveExportTimelineInput = {
    includeVfx: boolean;
    syncAnimTrack: boolean;
    vfxDurationSec: number;
    requestedTotalDurationSec?: number;
    animDurationSec?: number;
    animLoopMode?: AnimLoopMode;
};

export type ExportTimelinePlan = {
    totalDurationSec: number;
    vfxDurationSec: number;
    animDurationSec: number | null;
    animLoopMode: AnimLoopMode;
    animSeekTimeSecAt: (exportTimeSec: number) => number;
};

const DEFAULT_MIN_DURATION_SEC = 0.5;

const isFinitePositive = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0;

const clamp = (v: number, min: number, max: number): number =>
    Math.max(min, Math.min(v, max));

const mod = (v: number, n: number): number => {
    if (!Number.isFinite(v) || !Number.isFinite(n) || n <= 0) return 0;
    return ((v % n) + n) % n;
};

function mapAnimTimeByLoopMode(timeSec: number, durationSec: number, loopMode: AnimLoopMode): number {
    if (!isFinitePositive(durationSec)) {
        return 0;
    }
    switch (loopMode) {
        case 'repeat':
            return mod(timeSec, durationSec);
        case 'pingpong': {
            const cycle = durationSec * 2;
            const inCycle = mod(timeSec, cycle);
            return inCycle <= durationSec ? inCycle : (cycle - inCycle);
        }
        case 'none':
        default:
            return clamp(timeSec, 0, durationSec);
    }
}

/**
 * 统一导出时间轴决策：
 * - includeVfx + syncAnimTrack + anim存在：若 anim 短于 VFX，则按 loop 重播，
 *   并将总时长对齐到“刚好覆盖 VFX 的最小 loop 终点”。
 * - 其他场景回退到请求时长（或 VFX 时长）。
 */
export function resolveExportTimelinePlan(input: ResolveExportTimelineInput): ExportTimelinePlan {
    const vfxDurationSec = isFinitePositive(input.vfxDurationSec)
        ? input.vfxDurationSec
        : DEFAULT_MIN_DURATION_SEC;
    const requestedDurationSec = isFinitePositive(input.requestedTotalDurationSec)
        ? input.requestedTotalDurationSec
        : vfxDurationSec;
    const animDurationSec = isFinitePositive(input.animDurationSec)
        ? input.animDurationSec
        : null;
    const animLoopMode: AnimLoopMode = input.animLoopMode ?? 'repeat';

    let totalDurationSec = requestedDurationSec;
    if (input.includeVfx && input.syncAnimTrack && animDurationSec) {
        if (animDurationSec < vfxDurationSec) {
            const loopsNeeded = Math.max(1, Math.ceil(vfxDurationSec / animDurationSec));
            totalDurationSec = loopsNeeded * animDurationSec;
        } else {
            totalDurationSec = animDurationSec;
        }
    }
    totalDurationSec = Math.max(DEFAULT_MIN_DURATION_SEC, totalDurationSec);

    return {
        totalDurationSec,
        vfxDurationSec,
        animDurationSec,
        animLoopMode,
        animSeekTimeSecAt: (exportTimeSec: number) => {
            if (!animDurationSec) {
                return Math.max(0, exportTimeSec);
            }
            return mapAnimTimeByLoopMode(Math.max(0, exportTimeSec), animDurationSec, animLoopMode);
        }
    };
}
