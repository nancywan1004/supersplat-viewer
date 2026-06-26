/** 由 unlock 时 foreground 总量与当前 pending 计算 refinement 阶段进度 [0,1] */
export function computeStreamingRefinementProgressRatio(
    pendingForeground: number,
    baselinePending: number
): number {
    const baseline = Math.max(baselinePending, pendingForeground, 1);
    if (pendingForeground <= 0) {
        return 1;
    }
    return Math.max(0, Math.min(1, (baseline - pendingForeground) / baseline));
}
