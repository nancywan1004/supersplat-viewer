export type AnimLoopMode = 'none' | 'repeat' | 'pingpong';

/** 导出时间轴解析入参（时间单位均为秒，相对「导出起点」） */
type ResolveExportTimelineInput = {
    /** 为 true 时按 VFX 时长参与约束，并在分支里使用 `vfxDuration` 作为 VFX 结束锚点 */
    includeVfx: boolean;
    /** 为 true 且存在 `animDuration` 时：用相机 animTrack 与导出时间对齐，并应用「VFX 铺满 + VFX 后再播 anim」等规则 */
    syncAnimTrack: boolean;
    /** VFX / reveal 时间轴总时长（秒）；无配置时由调用方用默认值（如 12） */
    vfxDuration: number;
    /** UI 或协议传入的期望总时长（秒）；仅作为下限参与 `max`，不会单独缩短已算出的策略下限 */
    requestedTotalDuration?: number;
    /** 相机 animTrack 单圈时长（秒）；未传或非正数时视为无 animTrack，走无动画尾长分支 */
    animDuration?: number;
    /** animTrack 超出单圈后的循环方式；用于 `animSeekAt` 映射 */
    animLoopMode?: AnimLoopMode;
    /** 全部资产加载完成时刻（秒）：导出流程里 `waitAllReady` 结束相对导出起点的偏移；未传按 0 */
    allAssetsReadyAt?: number;
    /** 在 `max(vfxDuration, allAssetsReadyAt)`（无 VFX 时为 `allAssetsReadyAt`）之后，至少再播几整圈 anim；默认 1 */
    extraAnimLoopsAfterAssetsReady?: number;
    /** 无 animTrack（或不同步 anim）时，在 `max(vfx结束, 资产就绪)` 之后追加的固定时长（秒）；默认 2 */
    noAnimTrackExtraDuration?: number;
};

export type ExportTimelinePlan = {
    totalDuration: number;
    vfxDuration: number;
    animDuration: number | null;
    animLoopMode: AnimLoopMode;
    animSeekAt: (exportTime: number) => number;
};

const DEFAULT_MIN_DURATION_SEC = 0.5;
const DEFAULT_EXTRA_ANIM_LOOPS_AFTER_ASSETS_READY = 1;
const DEFAULT_NO_ANIM_EXTRA_DURATION = 2;

const isFinitePositive = (v: unknown): v is number =>
    typeof v === 'number' && Number.isFinite(v) && v > 0;

const clamp = (v: number, min: number, max: number): number =>
    Math.max(min, Math.min(v, max));

const mod = (v: number, n: number): number => {
    if (!Number.isFinite(v) || !Number.isFinite(n) || n <= 0) return 0;
    return ((v % n) + n) % n;
};

function mapAnimTimeByLoopMode(time: number, duration: number, loopMode: AnimLoopMode): number {
    if (!isFinitePositive(duration)) {
        return 0;
    }
    switch (loopMode) {
        case 'repeat':
            return mod(time, duration);
        case 'pingpong': {
            const cycle = duration * 2;
            const inCycle = mod(time, cycle);
            return inCycle <= duration ? inCycle : (cycle - inCycle);
        }
        case 'none':
        default:
            return clamp(time, 0, duration);
    }
}

/**
 * 统一导出时间轴决策（单位：秒）：
 * - 有 animTrack 且 sync：先保证 anim 按 loop 铺满 VFX 时长；再保证在 max(VFX 结束, 资产就绪) 之后至少再播一整圈 anim。
 * - 无 animTrack：在 max(VFX 结束, 资产就绪) 后追加固定尾长 `noAnimTrackExtraDuration`。
 */
export function resolveExportTimelinePlan(input: ResolveExportTimelineInput): ExportTimelinePlan {
    const vfxDuration = isFinitePositive(input.vfxDuration)
        ? input.vfxDuration
        : DEFAULT_MIN_DURATION_SEC;
    const requestedDuration = isFinitePositive(input.requestedTotalDuration)
        ? input.requestedTotalDuration
        : vfxDuration;
    const animDuration = isFinitePositive(input.animDuration)
        ? input.animDuration
        : null;
    const animLoopMode: AnimLoopMode = input.animLoopMode ?? 'repeat';
    const allAssetsReadyAt = (typeof input.allAssetsReadyAt === 'number' && Number.isFinite(input.allAssetsReadyAt))
        ? Math.max(0, input.allAssetsReadyAt)
        : 0;
    const extraAnimLoopsAfterAssetsReady = isFinitePositive(input.extraAnimLoopsAfterAssetsReady)
        ? input.extraAnimLoopsAfterAssetsReady
        : DEFAULT_EXTRA_ANIM_LOOPS_AFTER_ASSETS_READY;
    const noAnimTrackExtraDuration = isFinitePositive(input.noAnimTrackExtraDuration)
        ? input.noAnimTrackExtraDuration
        : DEFAULT_NO_ANIM_EXTRA_DURATION;

    let totalDuration = requestedDuration;
    if (input.syncAnimTrack && animDuration) {
        // 用 anim 循环铺满 VFX 时长（与历史行为一致）
        let minForVfxCoverage = 0;
        if (input.includeVfx) {
            if (animDuration < vfxDuration) {
                const loopsNeeded = Math.max(1, Math.ceil(vfxDuration / animDuration));
                minForVfxCoverage = loopsNeeded * animDuration;
            } else {
                minForVfxCoverage = animDuration;
            }
        }
        // 在「VFX 结束时刻」与「资产就绪时刻」二者靠后点之后，再追加至少一整圈 anim（避免 anim 时长刚好等于 VFX 时 total 卡在 12s 无法多播一圈）
        const postTailAnchor = input.includeVfx
            ? Math.max(vfxDuration, allAssetsReadyAt)
            : Math.max(0, allAssetsReadyAt);
        const minPostTail = postTailAnchor + extraAnimLoopsAfterAssetsReady * animDuration;
        totalDuration = Math.max(totalDuration, minForVfxCoverage, minPostTail);
    } else {
        const vfxDoneAt = input.includeVfx ? vfxDuration : 0;
        const minNoAnimDuration = Math.max(vfxDoneAt, allAssetsReadyAt) + noAnimTrackExtraDuration;
        totalDuration = Math.max(totalDuration, minNoAnimDuration);
    }
    totalDuration = Math.max(DEFAULT_MIN_DURATION_SEC, totalDuration);

    return {
        totalDuration,
        vfxDuration,
        animDuration,
        animLoopMode,
        animSeekAt: (exportTime: number) => {
            if (!animDuration) {
                return Math.max(0, exportTime);
            }
            return mapAnimTimeByLoopMode(Math.max(0, exportTime), animDuration, animLoopMode);
        }
    };
}
