/**
 * Streaming 首屏收条策略：参数与完成判定收敛于此。
 *
 * 阶段（UI 进度，状态优先）：
 *   A 0–gate%     文件 watermark / 开门禁
 *   B gate–coarse 粗档上屏
 *   C coarse–refineCap  refinement；收条前不可交互
 *   D 100%        finalize → progressThresholdReached
 *
 * 收条主路径（状态机，非写死时长）：
 *   1) 中央细档上屏 ≥ fineOnScreenRatio 且 behindNoEngine=0
 *   2) 前景 pending===0 且 staleLoaded===0
 *   3) 至少完整走过一轮 post-download settle（pending 归零后 settle 倒数到 0）
 *   4) settle 结束后连续 quietTicks 个「有效 tick」仍 pending/settle/stale 全清
 *   5) 若 quiet 期间 pending 回流：作废已完成的 settle 周期，必须再走完 3)+4)
 *
 * 假完成防护：须先见过真实细化压力（粗档对齐虚高 clear 不算）。
 * BootstrapFast 例外：有效目标（visualTarget）已 100% 追上且无 behind 时，视为压力已满足
 * （否则 pending 常为 0、peakBehindRatio 永不抬升 → UI 卡在 coarseCap=82）。
 * 逃生：仅在 pending/settle/stale 已清但仍无法 fineReady 时，按无进展帧 escape（防 Poland）。
 */
export const STREAMING_BOOTSTRAP = {
    progress: {
        /** A→B：开门禁 */
        gate: 50,
        /** B→C：粗档顶 / unlock refinement */
        coarseCap: 82,
        /** C：finalize 前 UI 上限（避免未解锁就 100%） */
        refineCap: 99
    },
    complete: {
        /** 中央细档已上屏比例；1 = 中央全部追上 engineOptimal */
        fineOnScreenRatio: 1,
        /** 曾见「更粗」behind/target 峰值下限，才承认真实细化 */
        minPeakBehindRatio: 0.2,
        /**
         * settle 结束后还须连续多少个「有效 refinement tick」保持全清。
         * 只在 snap.tickSeq 前进时计数，避免 bootstrap 空转同一快照。
         */
        postSettleQuietTicks: 24,
        /**
         * 有效目标已齐（BootstrapFast 常见：pending=0、无 ctr↓）时的 quiet 门槛。
         * 避免 clear 后还干等满 24 tick；也避免 UI 长时间钉在 refineCap。
         */
        postSettleQuietTicksFastPath: 8,
        /** 须完整完成的 settle 周期数（回流后清零重计） */
        requiredSettleCycles: 1,
        /** 逃生：无进展帧（约 6s@60）——且必须 pending/settle 已清 */
        escapeNoProgressFrames: 360,
        /** 逃生加强（约 12s@60） */
        escapeHardNoProgressFrames: 720
    }
} as const;

export type BootstrapRefinementSnapshot = {
    pendingNodes: number;
    staleLodNodes: number;
    centerEngineBehindNodes: number;
    centerTargetNodes: number;
    centerClearNodes: number;
    centerBehindNoEngine?: number;
    settlingFrames?: number;
    /** 已下未上（sync 前）；>0 时上屏后常触发预算再分配 */
    staleLoadedNodes?: number;
    /** refinement 每拍递增；用于只在新 tick 上累计 quiet */
    tickSeq?: number;
};

export type BootstrapWorkloadState = {
    baselinePending: number;
    peakStale: number;
    peakCenterBehind: number;
    peakCenterTarget: number;
    peakCenterClear: number;
    peakBehindRatio: number;
    noProgressFrames: number;
    lastPending: number;
    lastStale: number;
    lastClearNodes: number;
    lastSettling: number;
    lastTickSeq: number;
    /** 已完整走完的 settle 周期（pending 回流则清零） */
    completedSettleCycles: number;
    /** settle 结束后连续全清的有效 tick 数 */
    postSettleQuietTicks: number;
    /** 上一拍是否 pending===0（检测回流） */
    wasPendingZero: boolean;
};

export type BootstrapCompletionStep = {
    doneRatio: number;
    fineOnScreenReady: boolean;
    mainReady: boolean;
    escapeReady: boolean;
    shouldFinalize: boolean;
    finalizeReason: 'main' | 'escape' | null;
};

export function createBootstrapWorkloadState(): BootstrapWorkloadState {
    return {
        baselinePending: 0,
        peakStale: 0,
        peakCenterBehind: 0,
        peakCenterTarget: 0,
        peakCenterClear: 0,
        peakBehindRatio: 0,
        noProgressFrames: 0,
        lastPending: -1,
        lastStale: -1,
        lastClearNodes: -1,
        lastSettling: -1,
        lastTickSeq: -1,
        completedSettleCycles: 0,
        postSettleQuietTicks: 0,
        wasPendingZero: false
    };
}

export function resetBootstrapWorkloadState(state: BootstrapWorkloadState): void {
    state.baselinePending = 0;
    state.peakStale = 0;
    state.peakCenterBehind = 0;
    state.peakCenterTarget = 0;
    state.peakCenterClear = 0;
    state.peakBehindRatio = 0;
    state.noProgressFrames = 0;
    state.lastPending = -1;
    state.lastStale = -1;
    state.lastClearNodes = -1;
    state.lastSettling = -1;
    state.lastTickSeq = -1;
    state.completedSettleCycles = 0;
    state.postSettleQuietTicks = 0;
    state.wasPendingZero = false;
}

function hasSeenWorkload(state: BootstrapWorkloadState): boolean {
    return state.baselinePending > 0 || state.peakBehindRatio > 0;
}

export function hasSeenRefinePressure(state: BootstrapWorkloadState): boolean {
    return state.peakBehindRatio >= STREAMING_BOOTSTRAP.complete.minPeakBehindRatio;
}

export function computeFineOnScreenRatio(snap: BootstrapRefinementSnapshot): number {
    const target = snap.centerTargetNodes ?? 0;
    if (target <= 0) {
        return 0;
    }
    return Math.max(0, Math.min(1, (snap.centerClearNodes ?? 0) / target));
}

/** @deprecated 兼容旧名 */
export function computeBootstrapDoneRatio(
    snap: BootstrapRefinementSnapshot,
    _state?: BootstrapWorkloadState,
    _ignored?: number
): number {
    return computeFineOnScreenRatio(snap);
}

function isDownloadSideClear(snap: BootstrapRefinementSnapshot): boolean {
    return (
        (snap.pendingNodes ?? 0) === 0 &&
        (snap.settlingFrames ?? 0) === 0 &&
        (snap.staleLoadedNodes ?? 0) === 0
    );
}

export function isBootstrapVacuumComplete(
    snap: BootstrapRefinementSnapshot,
    state: BootstrapWorkloadState,
    hasValidTick: boolean
): boolean {
    if (!hasValidTick || !hasSeenWorkload(state) || !hasSeenRefinePressure(state)) {
        return false;
    }
    if ((snap.centerTargetNodes ?? 0) <= 0) {
        return false;
    }
    if ((snap.centerBehindNoEngine ?? 0) > 0) {
        return false;
    }
    return (
        computeFineOnScreenRatio(snap) >= 1 &&
        isDownloadSideClear(snap) &&
        state.completedSettleCycles >= STREAMING_BOOTSTRAP.complete.requiredSettleCycles &&
        state.postSettleQuietTicks >= STREAMING_BOOTSTRAP.complete.postSettleQuietTicks
    );
}

/**
 * 每拍：更新峰值 / settle 周期 / quiet tick，并给出是否应收条。
 */
export function stepBootstrapCompletion(
    state: BootstrapWorkloadState,
    snap: BootstrapRefinementSnapshot,
    options: { hasValidTick: boolean }
): BootstrapCompletionStep {
    const { complete } = STREAMING_BOOTSTRAP;
    const { hasValidTick } = options;

    if (snap.staleLodNodes > state.peakStale) {
        state.peakStale = snap.staleLodNodes;
    }
    const centerBehind = snap.centerEngineBehindNodes ?? 0;
    const behindNoEngine = snap.centerBehindNoEngine ?? 0;
    const coarserBehind = Math.max(0, centerBehind - behindNoEngine);
    if (centerBehind > state.peakCenterBehind) {
        state.peakCenterBehind = centerBehind;
    }
    if ((snap.centerTargetNodes ?? 0) > state.peakCenterTarget) {
        state.peakCenterTarget = snap.centerTargetNodes;
    }
    if ((snap.centerClearNodes ?? 0) > state.peakCenterClear) {
        state.peakCenterClear = snap.centerClearNodes;
    }
    const target = snap.centerTargetNodes ?? 0;
    if (target > 0) {
        const behindRatio = Math.max(0, Math.min(1, coarserBehind / target));
        if (behindRatio > state.peakBehindRatio) {
            state.peakBehindRatio = behindRatio;
        }
    }

    const pending = snap.pendingNodes ?? 0;
    const settling = snap.settlingFrames ?? 0;
    const staleLoaded = snap.staleLoadedNodes ?? 0;
    const doneRatioEarly = computeFineOnScreenRatio(snap);
    // BootstrapFast：visualTarget 已齐且无 behind → 从未出现 ctr↓，peakBehindRatio 会永远 < 0.2。
    // 已追齐有效目标视为细化压力已满足，否则进度卡在 82%、pending=0 无法收条。
    const atEffectiveClearTarget =
        target > 0 &&
        doneRatioEarly >= complete.fineOnScreenRatio &&
        coarserBehind === 0 &&
        behindNoEngine === 0;
    if (atEffectiveClearTarget) {
        state.peakBehindRatio = Math.max(
            state.peakBehindRatio,
            complete.minPeakBehindRatio
        );
    }

    const tickSeq = snap.tickSeq ?? -1;
    const isNewTick =
        hasValidTick && tickSeq >= 0 && tickSeq !== state.lastTickSeq;

    // pending 回流：作废 settle 周期与 quiet（必须再走完一轮）
    if (pending > 0) {
        if (state.wasPendingZero) {
            state.completedSettleCycles = 0;
            state.postSettleQuietTicks = 0;
        }
        state.wasPendingZero = false;
    } else {
        state.wasPendingZero = true;
    }

    // 检测 settle 完整结束：上一拍还在 settle，本拍 settling=0 且 pending=0
    if (
        isNewTick &&
        pending === 0 &&
        state.lastSettling > 0 &&
        settling === 0
    ) {
        state.completedSettleCycles++;
        state.postSettleQuietTicks = 0;
    }

    const doneRatio = doneRatioEarly;
    const refinePressure = hasSeenRefinePressure(state);
    const downloadClear = isDownloadSideClear(snap);
    const fineOnScreenReady =
        hasValidTick &&
        hasSeenWorkload(state) &&
        refinePressure &&
        target > 0 &&
        doneRatio >= complete.fineOnScreenRatio &&
        behindNoEngine === 0;

    const quietNeed = atEffectiveClearTarget
        ? complete.postSettleQuietTicksFastPath
        : complete.postSettleQuietTicks;
    const settleCyclesReady =
        state.completedSettleCycles >= complete.requiredSettleCycles;
    const quietReady = state.postSettleQuietTicks >= quietNeed;
    const mainReady =
        fineOnScreenReady && downloadClear && settleCyclesReady && quietReady;

    // 无进展：用于逃生（仅下载侧已清时才累计，避免抖动期误 escape）
    const clearImproved =
        state.lastClearNodes >= 0 && (snap.centerClearNodes ?? 0) > state.lastClearNodes;
    if (clearImproved || (state.lastPending >= 0 && pending < state.lastPending)) {
        state.noProgressFrames = 0;
    } else if (hasSeenWorkload(state) && refinePressure && target > 0 && downloadClear) {
        state.noProgressFrames++;
    } else if (!downloadClear) {
        state.noProgressFrames = 0;
    }

    if (isNewTick) {
        state.lastTickSeq = tickSeq;
        if (fineOnScreenReady && downloadClear && settleCyclesReady) {
            state.postSettleQuietTicks++;
        } else if (
            pending === 0 &&
            settling === 0 &&
            staleLoaded === 0 &&
            state.completedSettleCycles === 0 &&
            (state.baselinePending > 0 || atEffectiveClearTarget)
        ) {
            // 从未进入 settle 倒数：持续全清足够久 → 合成 1 个周期后再积 quiet
            // atEffectiveClearTarget：BootstrapFast 下 pending 可能从未 >0，仍须能收条
            state.postSettleQuietTicks++;
            if (state.postSettleQuietTicks >= quietNeed) {
                state.completedSettleCycles = 1;
                state.postSettleQuietTicks = 0;
            }
        } else if (!downloadClear || !fineOnScreenReady) {
            if (!settleCyclesReady) {
                state.postSettleQuietTicks = 0;
            }
        }
    }

    state.lastPending = pending;
    state.lastStale = snap.staleLodNodes;
    state.lastClearNodes = snap.centerClearNodes ?? 0;
    state.lastSettling = settling;

    // 逃生：下载侧已稳，但细档条件长期达不到（Poland）；禁止在 pending 抖动时 escape
    let escapeReady = false;
    if (
        hasValidTick &&
        hasSeenWorkload(state) &&
        refinePressure &&
        target > 0 &&
        downloadClear &&
        settleCyclesReady &&
        doneRatio >= complete.fineOnScreenRatio * 0.5 &&
        !mainReady
    ) {
        const everCleared = state.peakCenterClear > 0;
        escapeReady = everCleared
            ? state.noProgressFrames >= complete.escapeNoProgressFrames
            : state.noProgressFrames >= complete.escapeHardNoProgressFrames;
    }

    let shouldFinalize = false;
    let finalizeReason: 'main' | 'escape' | null = null;
    if (escapeReady && !mainReady) {
        shouldFinalize = true;
        finalizeReason = 'escape';
    } else if (mainReady) {
        shouldFinalize = true;
        finalizeReason = 'main';
    }

    return {
        doneRatio,
        fineOnScreenReady,
        mainReady,
        escapeReady,
        shouldFinalize,
        finalizeReason
    };
}

export function mapCoarsePlacementProgress(placementRatio: number): number {
    const { gate, coarseCap } = STREAMING_BOOTSTRAP.progress;
    return Math.min(
        coarseCap,
        gate + Math.round(Math.max(0, Math.min(1, placementRatio)) * (coarseCap - gate))
    );
}

export type RefinementUiSettleHint = {
    completedSettleCycles: number;
    postSettleQuietTicks: number;
    /** 有效目标已齐（BootstrapFast 快路径） */
    atEffectiveClearTarget?: boolean;
};

/**
 * Phase C UI：clear 进度只爬到约 91%；剩余靠 settle/quiet 爬到 99，避免「瞬间 99 干等」。
 */
export function mapRefinementUiProgress(
    doneRatio: number,
    settle?: RefinementUiSettleHint
): number {
    const { coarseCap, refineCap } = STREAMING_BOOTSTRAP.progress;
    const {
        fineOnScreenRatio,
        requiredSettleCycles,
        postSettleQuietTicks,
        postSettleQuietTicksFastPath
    } = STREAMING_BOOTSTRAP.complete;
    const span = refineCap - coarseCap;
    const displayRatio = Math.min(1, doneRatio / Math.max(1e-6, fineOnScreenRatio));
    /** clear 单独贡献的上限（相对 span） */
    const clearWeight = 0.55;
    const clearProgress = coarseCap + Math.round(displayRatio * span * clearWeight);

    if (!settle || displayRatio < 1) {
        return Math.min(refineCap, clearProgress);
    }

    const quietNeed = settle.atEffectiveClearTarget
        ? postSettleQuietTicksFastPath
        : postSettleQuietTicks;
    // 合成 settle：cycles=0 时 quiet 0→quietNeed 映射整段剩余进度；正式周期后再跟 quiet
    if (settle.completedSettleCycles < requiredSettleCycles) {
        const synth =
            settle.completedSettleCycles === 0
                ? Math.min(1, settle.postSettleQuietTicks / Math.max(1, quietNeed))
                : settle.completedSettleCycles / Math.max(1, requiredSettleCycles);
        const readiness = clearWeight + (1 - clearWeight) * synth * 0.5;
        return coarseCap + Math.round(Math.min(1, readiness) * span);
    }
    const quietFrac = Math.min(1, settle.postSettleQuietTicks / Math.max(1, quietNeed));
    const readiness = clearWeight + (1 - clearWeight) * (0.5 + 0.5 * quietFrac);
    return coarseCap + Math.round(Math.min(1, readiness) * span);
}

/** 供 UI：当前是否「有效目标已齐」（与 step 内判定一致） */
export function isAtEffectiveClearTarget(snap: BootstrapRefinementSnapshot): boolean {
    const target = snap.centerTargetNodes ?? 0;
    if (target <= 0) {
        return false;
    }
    const behindNoEngine = snap.centerBehindNoEngine ?? 0;
    const centerBehind = snap.centerEngineBehindNodes ?? 0;
    const coarserBehind = Math.max(0, centerBehind - behindNoEngine);
    return (
        computeFineOnScreenRatio(snap) >= STREAMING_BOOTSTRAP.complete.fineOnScreenRatio &&
        coarserBehind === 0 &&
        behindNoEngine === 0
    );
}
