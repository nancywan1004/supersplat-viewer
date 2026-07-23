import { statSummary, type StatSummary } from './buffer-upload-profile-table';

/** sync 后观察 currentLod / WorldState version 是否推进的默认窗口 */
export const BAKE_ACCEPTANCE_SYNC_HORIZON_FRAMES = 5;

/** 与 FrameProfileSample 结构兼容的最小字段（避免与 frame-profiler 循环依赖） */
export type BakeAcceptanceSample = {
    bufferUpload?: {
        copyPct?: number;
        uploadedBlocks?: number;
        totalBlocks?: number;
        uploadMbEst?: number;
        bakePassesEst?: number;
        worldStateFullRebuild?: boolean;
        dirtyForcedWorkBufferRebuild?: boolean;
        worldStateVersion?: number | null;
        currentLodSum?: number | null;
    };
    refinement?: {
        frame?: { syncedInstances?: number; syncTriggers?: unknown[] };
        tick?: { staleLoadedNodes?: number } | null;
    };
};

export type BakeAcceptanceReport = {
    sampleCount: number;
    /** copyPct ≥ 95% 的帧数 / 占比 */
    copyPctGe95: {
        frames: number;
        ratio: number;
    };
    /** uploadedBlocks/totalBlocks（仅 totalBlocks>0 且有上传的帧） */
    uploadedOverTotal: StatSummary;
    uploadMbEst: StatSummary;
    bakePassesEst: StatSummary;
    /** 引擎 worldState.fullRebuild === true 的帧 */
    worldStateFullRebuild: {
        frames: number;
        ratio: number;
    };
    /** scene.gsplat.dirty 触发的 workBuffer 全量 rebuild 帧（B.1 回归监测） */
    dirtyForcedWorkBufferRebuild: {
        frames: number;
        ratio: number;
    };
    /** sync 后 N 帧内 currentLod / WorldState version 是否推进 */
    syncAdvance: {
        horizonFrames: number;
        syncFrames: number;
        advancedWithinHorizon: number;
        advanceRatio: number;
        worldVersionAdvanced: number;
        currentLodAdvanced: number;
    };
    /** staleLoadedNodes > 0 最长连续帧数 */
    staleLoadedNodes: {
        framesWithStale: number;
        maxConsecutiveFrames: number;
    };
};

function ratio(n: number, d: number): number {
    return d > 0 ? Math.round((n / d) * 1000) / 1000 : 0;
}

function isSyncSample(s: BakeAcceptanceSample): boolean {
    const synced = s.refinement?.frame?.syncedInstances ?? 0;
    const triggers = s.refinement?.frame?.syncTriggers;
    return synced > 0 || (Array.isArray(triggers) && triggers.length > 0);
}

/**
 * 从 frame-profiler 样本汇总 Bake / WorldState 验收指标（供 Scene Profile + Playwright summary）。
 */
export function summarizeBakeAcceptance(
    samples: BakeAcceptanceSample[],
    options?: { syncHorizonFrames?: number }
): BakeAcceptanceReport {
    const horizon = options?.syncHorizonFrames ?? BAKE_ACCEPTANCE_SYNC_HORIZON_FRAMES;
    const n = samples.length;

    let copyPctGe95Frames = 0;
    const uploadRatios: number[] = [];
    const uploadMbs: number[] = [];
    const bakePasses: number[] = [];
    let worldStateFullRebuildFrames = 0;
    let dirtyForcedFrames = 0;

    for (let i = 0; i < n; i++) {
        const bu = samples[i].bufferUpload;
        if (!bu) {
            continue;
        }
        if (bu.copyPct >= 95) {
            copyPctGe95Frames++;
        }
        if (bu.totalBlocks > 0 && bu.uploadedBlocks > 0) {
            uploadRatios.push(bu.uploadedBlocks / bu.totalBlocks);
        }
        if (bu.uploadMbEst > 0 || bu.uploadedBlocks > 0) {
            uploadMbs.push(bu.uploadMbEst);
            bakePasses.push(bu.bakePassesEst);
        }
        if (bu.worldStateFullRebuild) {
            worldStateFullRebuildFrames++;
        }
        if (bu.dirtyForcedWorkBufferRebuild) {
            dirtyForcedFrames++;
        }
    }

    let syncFrames = 0;
    let advancedWithinHorizon = 0;
    let worldVersionAdvanced = 0;
    let currentLodAdvanced = 0;
    for (let i = 0; i < n; i++) {
        if (!isSyncSample(samples[i])) {
            continue;
        }
        syncFrames++;
        const base = samples[i].bufferUpload;
        const baseVer = base?.worldStateVersion ?? null;
        const baseLod = base?.currentLodSum ?? null;
        let verAdv = false;
        let lodAdv = false;
        const end = Math.min(n - 1, i + horizon);
        for (let j = i + 1; j <= end; j++) {
            const bu = samples[j].bufferUpload;
            if (!bu) {
                continue;
            }
            if (baseVer !== null && bu.worldStateVersion !== null && bu.worldStateVersion > baseVer) {
                verAdv = true;
            }
            if (baseLod !== null && bu.currentLodSum !== null && bu.currentLodSum !== baseLod) {
                lodAdv = true;
            }
            if (verAdv && lodAdv) {
                break;
            }
        }
        if (verAdv) {
            worldVersionAdvanced++;
        }
        if (lodAdv) {
            currentLodAdvanced++;
        }
        if (verAdv || lodAdv) {
            advancedWithinHorizon++;
        }
    }

    let framesWithStale = 0;
    let maxConsecutive = 0;
    let run = 0;
    for (let i = 0; i < n; i++) {
        const stale = samples[i].refinement?.tick?.staleLoadedNodes ?? 0;
        if (stale > 0) {
            framesWithStale++;
            run++;
            maxConsecutive = Math.max(maxConsecutive, run);
        } else {
            run = 0;
        }
    }

    return {
        sampleCount: n,
        copyPctGe95: {
            frames: copyPctGe95Frames,
            ratio: ratio(copyPctGe95Frames, n)
        },
        uploadedOverTotal: statSummary(uploadRatios),
        uploadMbEst: statSummary(uploadMbs),
        bakePassesEst: statSummary(bakePasses),
        worldStateFullRebuild: {
            frames: worldStateFullRebuildFrames,
            ratio: ratio(worldStateFullRebuildFrames, n)
        },
        dirtyForcedWorkBufferRebuild: {
            frames: dirtyForcedFrames,
            ratio: ratio(dirtyForcedFrames, n)
        },
        syncAdvance: {
            horizonFrames: horizon,
            syncFrames,
            advancedWithinHorizon,
            advanceRatio: ratio(advancedWithinHorizon, syncFrames),
            worldVersionAdvanced,
            currentLodAdvanced
        },
        staleLoadedNodes: {
            framesWithStale,
            maxConsecutiveFrames: maxConsecutive
        }
    };
}

/** markdown 表格行（多 case 可复用） */
export function formatBakeAcceptanceMarkdown(label: string, a: BakeAcceptanceReport | null | undefined): string[] {
    if (!a || a.sampleCount <= 0) {
        return [`### ${label}`, '', '- （无 bake 验收样本：需开启 frameProfile / benchmark 自动采样）', ''];
    }
    const pct = (r: number) => `${(r * 100).toFixed(1)}%`;
    const fmtStat = (s: StatSummary, digits = 2) =>
        s.n > 0
            ? `P50=${s.p50.toFixed(digits)} · P90=${s.p90.toFixed(digits)} · max=${s.max.toFixed(digits)} (n=${s.n})`
            : '—';
    return [
        `### ${label}`,
        '',
        `| 指标 | 值 |`,
        `|------|----|`,
        `| 采样帧数 | ${a.sampleCount} |`,
        `| copyPct ≥ 95% 帧占比 | ${a.copyPctGe95.frames} / ${a.sampleCount} (${pct(a.copyPctGe95.ratio)}) |`,
        `| uploaded/total P50 / P90 | ${a.uploadedOverTotal.n ? `${a.uploadedOverTotal.p50.toFixed(3)} / ${a.uploadedOverTotal.p90.toFixed(3)}` : '—'} |`,
        `| uploadMbEst | ${fmtStat(a.uploadMbEst, 1)} |`,
        `| bakePassesEst | ${fmtStat(a.bakePassesEst, 0)} |`,
        `| worldState.fullRebuild 帧占比 | ${a.worldStateFullRebuild.frames} (${pct(a.worldStateFullRebuild.ratio)}) |`,
        `| dirtyForcedWorkBufferRebuild 帧占比 | ${a.dirtyForcedWorkBufferRebuild.frames} (${pct(a.dirtyForcedWorkBufferRebuild.ratio)}) |`,
        `| sync 后 ${a.syncAdvance.horizonFrames} 帧内推进 | ${a.syncAdvance.advancedWithinHorizon}/${a.syncAdvance.syncFrames} (${pct(a.syncAdvance.advanceRatio)})；ver=${a.syncAdvance.worldVersionAdvanced} lod=${a.syncAdvance.currentLodAdvanced} |`,
        `| staleLoadedNodes 最长连续帧 | ${a.staleLoadedNodes.maxConsecutiveFrames}（有 stale 帧 ${a.staleLoadedNodes.framesWithStale}） |`,
        ''
    ];
}
