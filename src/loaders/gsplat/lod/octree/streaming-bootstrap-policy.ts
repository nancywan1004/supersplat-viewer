/**
 * Streaming 首屏收条策略：参数与完成判定收敛于此。
 *
 * 阶段（UI 进度，状态优先）：
 *   A 0–gate%     文件 watermark / 开门禁
 *   B gate–coarse 粗档上屏
 *   C coarse–refineCap  refinement；收条前不可交互
 *   D 100%        finalize → progressThresholdReached
 *
 * 收条主路径（清晰度语义）：
 *   有效 tick ∧ 见过真实细化压力 ∧ 中央「细档已上屏」比例 ≥ fineOnScreenRatio ∧ 连续 stableFrames
 *   「细档已上屏」= 中央叶 currentLod ≤ engineOptimal（文件已下且已换档显示）
 *
 * 假完成防护（重要）：
 *   unlock 后引擎目标仍可能停在粗档，此时 current≈engineOptimal 会让 clear/target≈100%，
 *   但画面仍糊。必须先见到「细化压力」（中央曾落后于更细的 engineOptimal，或出现过 pending），
 *   再允许用 80% 上屏比例收条。
 *
 * 逃生阀（非清晰度门槛，仅防卡死）：
 *   已见细化压力后上屏比例长期无进展时按无进展帧数 escape
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
        /**
         * 中央细档已上屏比例门槛。
         * clear/target ≥ 此值即可收条（不要求 pending===0 / ctr↓===0 / stale===0）。
         */
        fineOnScreenRatio: 0.8,
        /**
         * 曾见过的「中央更粗落后比例」下限：coarserBehind/target 峰值须达到此值，
         * 才承认发生过真实细化（避免粗档对齐 / 仅 no_engine 时假 100%）。
         * 默认与 1 - fineOnScreenRatio 对齐 → 至少曾有约 20% 中央落后于更细目标。
         */
        minPeakBehindRatio: 0.2,
        /** 主路径条件连续成立帧数 */
        stableFrames: 10,
        /** 条件回落抗抖：连续未就绪帧数后清零 stable */
        pendingSpikeFrames: 3,
        /** 逃生：上屏比例无进展帧（约 6s@60） */
        escapeNoProgressFrames: 360,
        /** 逃生加强（约 12s@60） */
        escapeHardNoProgressFrames: 720
    }
} as const;

export type BootstrapRefinementSnapshot = {
    pendingNodes: number;
    staleLodNodes: number;
    centerEngineBehindNodes: number;
    /** 中央可统计叶（已上屏且有可追的引擎目标） */
    centerTargetNodes: number;
    /** 其中 currentLod ≤ engineOptimal（细档已上屏） */
    centerClearNodes: number;
    /** 中央已上屏但引擎未写 optimal */
    centerBehindNoEngine?: number;
};

/** 跨帧工作量 / 稳定帧状态（由 bootstrap 持有，本模块只读写） */
export type BootstrapWorkloadState = {
    baselinePending: number;
    peakStale: number;
    peakCenterBehind: number;
    peakCenterTarget: number;
    peakCenterClear: number;
    /** 历史最大 behind/target（仅 target>0 时更新） */
    peakBehindRatio: number;
    noProgressFrames: number;
    lastPending: number;
    lastStale: number;
    lastClearNodes: number;
    stableFrames: number;
    spikeFrames: number;
};

export type BootstrapCompletionStep = {
    /** 中央细档上屏比例 [0,1]；无 target 时为 0 */
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
        stableFrames: 0,
        spikeFrames: 0
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
    state.stableFrames = 0;
    state.spikeFrames = 0;
}

/**
 * 见过真实工作量：必须有 pending 峰值，或中央曾比引擎目标更粗（ctr↓ 中的 coarser）。
 * 注意：仅有 centerTarget（粗档对齐）或仅有 no_engine 不算。
 */
function hasSeenWorkload(state: BootstrapWorkloadState): boolean {
    return state.baselinePending > 0 || state.peakBehindRatio > 0;
}

/** 见过真实细化压力：中央曾有足够比例「比引擎目标更粗」（不含 no_engine） */
export function hasSeenRefinePressure(state: BootstrapWorkloadState): boolean {
    return state.peakBehindRatio >= STREAMING_BOOTSTRAP.complete.minPeakBehindRatio;
}

/** 中央细档已上屏比例 */
export function computeFineOnScreenRatio(snap: BootstrapRefinementSnapshot): number {
    const target = snap.centerTargetNodes ?? 0;
    if (target <= 0) {
        return 0;
    }
    return Math.max(0, Math.min(1, (snap.centerClearNodes ?? 0) / target));
}

/** @deprecated 兼容旧名：进度条用细档上屏比例 */
export function computeBootstrapDoneRatio(
    snap: BootstrapRefinementSnapshot,
    _state?: BootstrapWorkloadState,
    _ignored?: number
): number {
    return computeFineOnScreenRatio(snap);
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
    return computeFineOnScreenRatio(snap) >= 1;
}

/**
 * 每拍：更新峰值 / 无进展计数，并给出是否应收条。
 * `baselinePending` 仍可由调用方抬升（作「见过下载」证据）。
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
    // 仅「比引擎目标更粗」计入细化压力；no_engine 不能当作已见过细化
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

    const doneRatio = computeFineOnScreenRatio(snap);
    const refinePressure = hasSeenRefinePressure(state);
    const fineOnScreenReady =
        hasValidTick &&
        hasSeenWorkload(state) &&
        refinePressure &&
        target > 0 &&
        doneRatio >= complete.fineOnScreenRatio &&
        behindNoEngine === 0;

    const clearImproved =
        state.lastClearNodes >= 0 && (snap.centerClearNodes ?? 0) > state.lastClearNodes;
    const pendingImproved =
        (state.lastPending >= 0 && snap.pendingNodes < state.lastPending) ||
        (state.lastStale >= 0 && snap.staleLodNodes < state.lastStale);
    if (clearImproved || pendingImproved) {
        state.noProgressFrames = 0;
    } else if (hasSeenWorkload(state) && refinePressure && target > 0) {
        state.noProgressFrames++;
    } else {
        state.noProgressFrames = 0;
    }
    state.lastPending = snap.pendingNodes;
    state.lastStale = snap.staleLodNodes;
    state.lastClearNodes = snap.centerClearNodes ?? 0;

    const mainReady = fineOnScreenReady;

    // 逃生：已见细化压力且有一定上屏，但长期无进展
    let escapeReady = false;
    if (
        hasValidTick &&
        hasSeenWorkload(state) &&
        refinePressure &&
        target > 0 &&
        doneRatio >= complete.fineOnScreenRatio * 0.5 &&
        !fineOnScreenReady
    ) {
        const everCleared = state.peakCenterClear > 0;
        escapeReady = everCleared
            ? state.noProgressFrames >= complete.escapeNoProgressFrames
            : state.noProgressFrames >= complete.escapeHardNoProgressFrames;
    }

    let shouldFinalize = false;
    let finalizeReason: 'main' | 'escape' | null = null;

    if (!mainReady && !escapeReady) {
        state.spikeFrames++;
        if (state.spikeFrames >= complete.pendingSpikeFrames) {
            state.stableFrames = 0;
        }
    } else {
        state.spikeFrames = 0;
        state.stableFrames++;
        if (escapeReady && !mainReady) {
            shouldFinalize = true;
            finalizeReason = 'escape';
        } else if (mainReady && state.stableFrames >= complete.stableFrames) {
            shouldFinalize = true;
            finalizeReason = 'main';
        }
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

/** 粗档上屏阶段进度（viewport placement → gate..coarseCap） */
export function mapCoarsePlacementProgress(placementRatio: number): number {
    const { gate, coarseCap } = STREAMING_BOOTSTRAP.progress;
    return Math.min(
        coarseCap,
        gate + Math.round(Math.max(0, Math.min(1, placementRatio)) * (coarseCap - gate))
    );
}

/** refinement 阶段进度（细档上屏比例 → coarseCap..refineCap） */
export function mapRefinementUiProgress(doneRatio: number): number {
    const { coarseCap, refineCap } = STREAMING_BOOTSTRAP.progress;
    const { fineOnScreenRatio } = STREAMING_BOOTSTRAP.complete;
    const displayRatio = Math.min(1, doneRatio / fineOnScreenRatio);
    return coarseCap + Math.round(displayRatio * (refineCap - coarseCap));
}
