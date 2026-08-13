/**
 * renderScale 运行时：状态、逐叶钳制、挂到 OOF apply 链（hold 之后）。
 * 纯函数见 lod-render-scale.ts；选档开关见 scene-profile.resolveLodSelectMode（默认 distance）。
 */
import type { Global } from '../../../../types';
import {
    resolveLodRenderScale,
    resolveLodRenderScaleFoveation,
    resolveLodSelectMode
} from '../scene-profile';
import type { OctreeInstanceLike } from './octree-instance-access';
import { setLodApplyStabilizerHooks } from './out-of-frustum-downgrade';
import {
    buildLeafRepDiameterTable,
    computeEffectiveRenderScale,
    computeFoveateFactor,
    computeViewAngleDeg,
    mergeVisualBudgetLod,
    selectRenderScaleLodFromDiameters,
    type LeafRepDiameterTable,
    type LodRenderScaleFoveationParams
} from './lod-render-scale';

export type RenderScaleLodSample = {
    renderScaleLod: number;
    engineOptimalLod: number;
    targetLod: number;
    effective: number;
    distance: number;
};

export type RenderScaleTickStats = {
    n: number;
    mergedChanged: number;
    visualCoarser: number;
    engineCoarser: number;
    equal: number;
    histRenderScaleLod: number[];
    histEngineOptimalLod: number[];
    histTargetLod: number[];
    meanRenderScaleLod: number;
    meanEngineOptimalLod: number;
    meanTargetLod: number;
    meanDeltaTargetMinusEngine: number;
};

export type RenderScaleEvalState = {
    enabled: boolean;
    baseRenderScale: number;
    foveation: LodRenderScaleFoveationParams;
    table: LeafRepDiameterTable;
    scratchDiameters: Float32Array;
    lastClampedNodes: number;
    /** hold 前快照的引擎/balance 档；-1=尚未采到 */
    lastEngineOptimalByLeaf: Int16Array;
    samplingEnabled: boolean;
    lastTickSamples: RenderScaleLodSample[];
    lastTickStats: RenderScaleTickStats | null;
    cameraLocal: {
        px: number;
        py: number;
        pz: number;
        fwx: number;
        fwy: number;
        fwz: number;
    } | null;
    pixelFactor: number;
};

export type RenderScaleClampResult = {
    targetLod: number;
    renderScaleLod: number;
    engineOptimalLod: number;
    effective: number;
};

export function fillScratchRepDiameters(
    table: LeafRepDiameterTable,
    nodeIndex: number,
    scratch: Float32Array
): void {
    const { lodLevels, diameters } = table;
    const base = nodeIndex * lodLevels;
    for (let lod = 0; lod < lodLevels; lod++) {
        scratch[lod] = diameters[base + lod];
    }
}

export function emptyRenderScaleTickStats(lodLevels: number): RenderScaleTickStats {
    const hist = () => new Array(Math.max(1, lodLevels)).fill(0);
    return {
        n: 0,
        mergedChanged: 0,
        visualCoarser: 0,
        engineCoarser: 0,
        equal: 0,
        histRenderScaleLod: hist(),
        histEngineOptimalLod: hist(),
        histTargetLod: hist(),
        meanRenderScaleLod: 0,
        meanEngineOptimalLod: 0,
        meanTargetLod: 0,
        meanDeltaTargetMinusEngine: 0
    };
}

export function summarizeRenderScaleSamples(
    samples: RenderScaleLodSample[],
    lodLevels: number
): RenderScaleTickStats {
    const stats = emptyRenderScaleTickStats(lodLevels);
    if (samples.length === 0) {
        return stats;
    }
    let sumRs = 0;
    let sumEng = 0;
    let sumTgt = 0;
    let sumDelta = 0;
    const bump = (hist: number[], lod: number) => {
        const i = Math.max(0, Math.min(hist.length - 1, lod | 0));
        hist[i]++;
    };
    for (const s of samples) {
        stats.n++;
        sumRs += s.renderScaleLod;
        sumEng += s.engineOptimalLod;
        sumTgt += s.targetLod;
        sumDelta += s.targetLod - s.engineOptimalLod;
        if (s.targetLod !== s.engineOptimalLod) {
            stats.mergedChanged++;
        }
        if (s.renderScaleLod > s.engineOptimalLod) {
            stats.visualCoarser++;
        } else if (s.engineOptimalLod > s.renderScaleLod) {
            stats.engineCoarser++;
        } else {
            stats.equal++;
        }
        bump(stats.histRenderScaleLod, s.renderScaleLod);
        bump(stats.histEngineOptimalLod, s.engineOptimalLod);
        bump(stats.histTargetLod, s.targetLod);
    }
    const n = stats.n;
    stats.meanRenderScaleLod = sumRs / n;
    stats.meanEngineOptimalLod = sumEng / n;
    stats.meanTargetLod = sumTgt / n;
    stats.meanDeltaTargetMinusEngine = sumDelta / n;
    return stats;
}

/**
 * 用屏幕尺寸目标钳制 optimalLod（只允许变粗）。
 *
 * merge 基准必须是**当前** nodeInfo.optimalLod（apply 路径上已是 hold+OOF 之后）：
 * 若改用 hold 前快照，会把 OOF 刚钳到 bootstrap 的视锥外叶写回细档 → opt 虚高。
 *
 * `engineOptimalOverride`：仅用于统计/采样里的「纯引擎档」，不参与 merge。
 */
export function applyRenderScaleClampToNode(
    nodeInfo: { optimalLod: number },
    args: {
        nodeIndex: number;
        maxLod: number;
        actualDistance: number;
        leafCenterX: number;
        leafCenterY: number;
        leafCenterZ: number;
        cameraPosX: number;
        cameraPosY: number;
        cameraPosZ: number;
        cameraFwdX: number;
        cameraFwdY: number;
        cameraFwdZ: number;
        pixelFactor: number;
        state: RenderScaleEvalState;
        /** 仅统计用：hold 前 balance 档 */
        engineOptimalOverride?: number;
        /** false：只算 target 不写回（scan 下载目标）；默认 true */
        writeBack?: boolean;
    }
): RenderScaleClampResult {
    const budgetOptimalLod = Math.max(0, Math.min(args.maxLod, nodeInfo.optimalLod));
    const reportedEngine =
        args.engineOptimalOverride !== undefined && args.engineOptimalOverride >= 0
            ? Math.max(0, Math.min(args.maxLod, args.engineOptimalOverride))
            : budgetOptimalLod;
    const { state } = args;
    fillScratchRepDiameters(state.table, args.nodeIndex, state.scratchDiameters);
    const viewAngleDeg = computeViewAngleDeg(
        args.leafCenterX,
        args.leafCenterY,
        args.leafCenterZ,
        args.cameraPosX,
        args.cameraPosY,
        args.cameraPosZ,
        args.cameraFwdX,
        args.cameraFwdY,
        args.cameraFwdZ
    );
    const foveate = computeFoveateFactor(viewAngleDeg, state.foveation);
    const effective = computeEffectiveRenderScale(state.baseRenderScale, foveate);
    const renderScaleLod = selectRenderScaleLodFromDiameters(
        state.scratchDiameters.subarray(0, state.table.lodLevels),
        args.pixelFactor,
        args.actualDistance,
        effective
    );
    const visualBudgetLod = mergeVisualBudgetLod(renderScaleLod, budgetOptimalLod);
    if (visualBudgetLod !== budgetOptimalLod) {
        state.lastClampedNodes++;
    }
    if (args.writeBack !== false) {
        nodeInfo.optimalLod = visualBudgetLod;
    }
    return {
        targetLod: visualBudgetLod,
        renderScaleLod,
        engineOptimalLod: reportedEngine,
        effective
    };
}

export type CreateRenderScaleEvalStateArgs = {
    global: Global;
    leafCount: number;
    lodLevels: number;
    nodeBoundsMinMax: Float32Array;
    getSplatCount: (leaf: number, lod: number) => number;
    metaData?: unknown;
};

/** 默认 distance → null；仅 lodSelectMode=renderScale 时建状态 */
export function createRenderScaleEvalState(
    args: CreateRenderScaleEvalStateArgs
): RenderScaleEvalState | null {
    if (resolveLodSelectMode(args.global) !== 'renderScale') {
        return null;
    }
    const table = buildLeafRepDiameterTable({
        leafCount: args.leafCount,
        lodLevels: args.lodLevels,
        nodeBoundsMinMax: args.nodeBoundsMinMax,
        getSplatCount: args.getSplatCount,
        metaData: args.metaData
    });
    return {
        enabled: true,
        baseRenderScale: resolveLodRenderScale(args.global),
        foveation: resolveLodRenderScaleFoveation(args.global),
        table,
        scratchDiameters: new Float32Array(Math.max(1, args.lodLevels)),
        lastClampedNodes: 0,
        lastEngineOptimalByLeaf: new Int16Array(args.leafCount).fill(-1),
        samplingEnabled: false,
        lastTickSamples: [],
        lastTickStats: null,
        cameraLocal: null,
        pixelFactor: 0
    };
}

export function beginRenderScaleScanFrame(state: RenderScaleEvalState): void {
    state.lastClampedNodes = 0;
    state.lastTickSamples.length = 0;
    state.lastTickStats = null;
    state.samplingEnabled = true;
}

export function endRenderScaleScanFrame(state: RenderScaleEvalState): void {
    state.samplingEnabled = false;
    state.lastTickStats = summarizeRenderScaleSamples(
        state.lastTickSamples,
        state.table.lodLevels
    );
}

function clampInstanceLeaves(
    inst: OctreeInstanceLike,
    maxLod: number,
    state: RenderScaleEvalState,
    boundsFlat: Float32Array
): void {
    const infos = inst.nodeInfos;
    const cam = state.cameraLocal;
    const pf = state.pixelFactor;
    if (!state.enabled || !cam || !(pf > 0) || !infos?.length) {
        return;
    }
    state.lastClampedNodes = 0;
    for (let i = 0; i < infos.length; i++) {
        const info = infos[i];
        if (!info || info.optimalLod < 0) {
            continue;
        }
        // 快照仅统计；merge 用当前 opt（已含 OOF），避免写回细档抬高 opt
        const engSnapshot =
            i < state.lastEngineOptimalByLeaf.length ? state.lastEngineOptimalByLeaf[i] : -1;
        const b = i * 6;
        const minX = boundsFlat[b];
        const maxX = boundsFlat[b + 3];
        const minY = boundsFlat[b + 1];
        const maxY = boundsFlat[b + 4];
        const minZ = boundsFlat[b + 2];
        const maxZ = boundsFlat[b + 5];
        let qx = cam.px;
        if (qx < minX) qx = minX;
        else if (qx > maxX) qx = maxX;
        let qy = cam.py;
        if (qy < minY) qy = minY;
        else if (qy > maxY) qy = maxY;
        let qz = cam.pz;
        if (qz < minZ) qz = minZ;
        else if (qz > maxZ) qz = maxZ;
        const dx = qx - cam.px;
        const dy = qy - cam.py;
        const dz = qz - cam.pz;
        applyRenderScaleClampToNode(info, {
            nodeIndex: i,
            maxLod,
            actualDistance: Math.sqrt(dx * dx + dy * dy + dz * dz),
            leafCenterX: (minX + maxX) * 0.5,
            leafCenterY: (minY + maxY) * 0.5,
            leafCenterZ: (minZ + maxZ) * 0.5,
            cameraPosX: cam.px,
            cameraPosY: cam.py,
            cameraPosZ: cam.pz,
            cameraFwdX: cam.fwx,
            cameraFwdY: cam.fwy,
            cameraFwdZ: cam.fwz,
            pixelFactor: pf,
            state,
            engineOptimalOverride: engSnapshot
        });
    }
}

/**
 * 挂到 OOF apply 链：hold 前快照（统计），hold/OOF 后再钳制。
 * merge 以 OOF 后的 opt 为准，禁止用快照细档覆盖视锥外 bootstrap。
 */
export function bindRenderScaleApplyHooks(
    getState: () => RenderScaleEvalState | null,
    boundsFlat: Float32Array
): void {
    const state = getState();
    if (!state?.enabled) {
        setLodApplyStabilizerHooks({
            beforeHoldSnapshot: null,
            afterHoldPreApply: null
        });
        return;
    }
    setLodApplyStabilizerHooks({
        beforeHoldSnapshot: (inst, _maxLod) => {
            const s = getState();
            const infos = inst.nodeInfos;
            if (!s?.enabled || !infos?.length) {
                return;
            }
            const n = Math.min(infos.length, s.lastEngineOptimalByLeaf.length);
            for (let i = 0; i < n; i++) {
                const lod = infos[i]?.optimalLod ?? -1;
                s.lastEngineOptimalByLeaf[i] = lod >= 0 ? lod : -1;
            }
        },
        afterHoldPreApply: (inst, maxLod) => {
            const s = getState();
            if (!s?.enabled) {
                return;
            }
            clampInstanceLeaves(inst, maxLod, s, boundsFlat);
        }
    });
}

export function clearRenderScaleApplyHooks(): void {
    setLodApplyStabilizerHooks({
        beforeHoldSnapshot: null,
        afterHoldPreApply: null
    });
}
