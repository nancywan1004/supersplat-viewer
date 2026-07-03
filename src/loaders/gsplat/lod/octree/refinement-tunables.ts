import { platform } from 'playcanvas';

import type { ExperienceSettings } from '../../../../settings';
import type { Global } from '../../../../types';

/** refinement 调度激进程度；与 lodRuntime / lodMode 正交 */
export type RefinementPolicy = 'conservative' | 'aggressive';

export type RefinementTunables = {
    loader: {
        defaultConcurrent: number;
        boostConcurrent: number;
        burstConcurrent: number;
        emergencyConcurrent: number;
        extremeConcurrent: number;
        foregroundLimit: number;
        criticalLimit: number;
        pinLimit: number;
        trackedMissFrames: number;
        trackedLimit: number;
    };
    settle: {
        postDownloadFrames: number;
        perFileFrames: number;
    };
    lod: {
        splatBudget: number;
        underfillLimit: number;
        boostUpdateDistance: number;
        burstUpdateDistance: number;
    };
    viewport: {
        edgeNdcInner: number;
        edgeNdcOuter: number;
        edgeRelaxOptimal: number;
        centerScorePower: number;
        /** nearJumpLadder 生效所需的最小 edgeFactor（视口中心权重） */
        nearJumpEdgeMin: number;
    };
    burst: {
        moveFrames: number;
        zoomFrames: number;
        unlockFrames: number;
        syncCooldown: number;
        staleSyncCooldown: number;
        staleSyncIdleFrames: number;
    };
    ladder: {
        coarsestStepBoost: number;
        stepBoost: number;
    };
    scan: {
        incrementalInterval: number;
        prefetchBudget: boolean;
        /** 单次全量遍历最多评估的叶子数；0 表示不限制 */
        maxLeafEvaluationsCap: number;
        /** 相对 octree.nodes.length 的比例上限 */
        maxLeafEvaluationsRatio: number;
    };
    nearJumpLadder: boolean;
};

type SceneProfileObject = {
    lodMode?: unknown;
    refinementPolicy?: unknown;
};

function readSceneProfile(settings: ExperienceSettings): SceneProfileObject | undefined {
    const raw = (settings as { sceneProfile?: unknown }).sceneProfile;
    if (typeof raw === 'string') {
        if (raw === 'performance' || raw === 'quality') {
            return { lodMode: raw };
        }
        return undefined;
    }
    if (!raw || typeof raw !== 'object') {
        return undefined;
    }
    return raw as SceneProfileObject;
}

function readLodMode(settings: ExperienceSettings): 'performance' | 'quality' | undefined {
    const profile = readSceneProfile(settings);
    const mode = profile?.lodMode;
    if (mode === 'performance' || mode === 'quality') {
        return mode;
    }
    if (mode === 'performanceFirst') {
        return 'performance';
    }
    if (mode === 'qualityFirst') {
        return 'quality';
    }
    return undefined;
}

function readExplicitPolicy(value: unknown): RefinementPolicy | undefined {
    if (value === 'conservative' || value === 'aggressive') {
        return value;
    }
    return undefined;
}

function readNearJumpLadderFlag(value: unknown): boolean | undefined {
    if (value === true || value === '1' || value === 1) {
        return true;
    }
    if (value === false || value === '0' || value === 0) {
        return false;
    }
    return undefined;
}

/** URL / config > settings.sceneProfile.refinementPolicy > lodMode 映射 > aggressive（与改前默认行为一致） */
export function resolveRefinementPolicy(global: Global): RefinementPolicy {
    const config = global.config as { refinementPolicy?: unknown };
    const fromConfig = readExplicitPolicy(config.refinementPolicy);
    if (fromConfig) {
        return fromConfig;
    }

    const fromSettings = readExplicitPolicy(readSceneProfile(global.settings)?.refinementPolicy);
    if (fromSettings) {
        return fromSettings;
    }

    const lodMode = readLodMode(global.settings);
    if (lodMode === 'performance') {
        return 'conservative';
    }
    return 'aggressive';
}

/** 解析 nearJumpLadder：URL / config 显式覆盖 > settings > lodMode=quality > 关 */
export function resolveNearJumpLadder(global: Global, _policy: RefinementPolicy): boolean {
    const config = global.config as { nearJumpLadder?: unknown };
    const fromConfig = readNearJumpLadderFlag(config.nearJumpLadder);
    if (fromConfig !== undefined) {
        return fromConfig;
    }

    const profile = readSceneProfile(global.settings) as { nearJumpLadder?: unknown } | undefined;
    const fromSettings = readNearJumpLadderFlag(profile?.nearJumpLadder);
    if (fromSettings !== undefined) {
        return fromSettings;
    }

    return readLodMode(global.settings) === 'quality';
}

export function buildRefinementTunables(policy: RefinementPolicy): RefinementTunables {
    const mobile = platform.mobile;

    if (policy === 'conservative') {
        return {
            loader: {
                defaultConcurrent: 2,
                boostConcurrent: mobile ? 3 : 6,
                burstConcurrent: mobile ? 6 : 10,
                emergencyConcurrent: mobile ? 12 : 24,
                extremeConcurrent: mobile ? 24 : 48,
                foregroundLimit: mobile ? 24 : 48,
                criticalLimit: mobile ? 3 : 6,
                pinLimit: mobile ? 4 : 8,
                trackedMissFrames: mobile ? 10 : 14,
                trackedLimit: mobile ? 64 : 128
            },
            settle: {
                postDownloadFrames: 36,
                perFileFrames: 14
            },
            lod: {
                splatBudget: mobile ? 1_500_000 : 3_000_000,
                underfillLimit: mobile ? 2 : 3,
                boostUpdateDistance: mobile ? 0.10 : 0.15,
                burstUpdateDistance: 0
            },
            viewport: {
                edgeNdcInner: 0.44,
                edgeNdcOuter: 0.72,
                edgeRelaxOptimal: 0.50,
                centerScorePower: 4.5,
                nearJumpEdgeMin: 0.80
            },
            burst: {
                moveFrames: 14,
                zoomFrames: 28,
                unlockFrames: 56,
                syncCooldown: 4,
                staleSyncCooldown: 8,
                staleSyncIdleFrames: 16
            },
            ladder: {
                coarsestStepBoost: 2.25,
                stepBoost: 1.35
            },
            scan: {
                incrementalInterval: 60,
                prefetchBudget: false,
                maxLeafEvaluationsCap: mobile ? 512 : 768,
                maxLeafEvaluationsRatio: 0.08
            },
            nearJumpLadder: false
        };
    }

    // aggressive：与 refinementPolicy 引入前 controller 硬编码 T + P1 扫描策略一致
    return {
        loader: {
            defaultConcurrent: 2,
            boostConcurrent: mobile ? 4 : 8,
            burstConcurrent: mobile ? 8 : 12,
            emergencyConcurrent: mobile ? 16 : 32,
            extremeConcurrent: mobile ? 32 : 64,
            foregroundLimit: mobile ? 32 : 64,
            criticalLimit: mobile ? 4 : 8,
            pinLimit: mobile ? 6 : 12,
            trackedMissFrames: mobile ? 8 : 12,
            trackedLimit: mobile ? 96 : 192
        },
        settle: {
            postDownloadFrames: 30,
            perFileFrames: 12
        },
        lod: {
            splatBudget: mobile ? 2_000_000 : 4_000_000,
            underfillLimit: mobile ? 2 : 3,
            boostUpdateDistance: mobile ? 0.12 : 0.18,
            burstUpdateDistance: 0
        },
        viewport: {
            edgeNdcInner: 0.44,
            edgeNdcOuter: 0.72,
            edgeRelaxOptimal: 0.45,
            centerScorePower: 5.0,
            nearJumpEdgeMin: 0.65
        },
        burst: {
            moveFrames: 18,
            zoomFrames: 36,
            unlockFrames: 48,
            syncCooldown: 3,
            staleSyncCooldown: 6,
            staleSyncIdleFrames: 12
        },
        ladder: {
            coarsestStepBoost: 2.75,
            stepBoost: 1.6
        },
        scan: {
            incrementalInterval: 45,
            prefetchBudget: true,
            maxLeafEvaluationsCap: mobile ? 1536 : 2048,
            maxLeafEvaluationsRatio: 0.15
        },
        nearJumpLadder: false
    };
}

/** 按叶子数与档位解析单次全量遍历评估上限；0 表示不限制 */
export function resolveMaxLeafEvaluations(tunables: RefinementTunables, leafCount: number): number {
    const cap = tunables.scan.maxLeafEvaluationsCap;
    if (cap <= 0 || leafCount <= 0) {
        return 0;
    }
    const ratioLimit = Math.floor(leafCount * tunables.scan.maxLeafEvaluationsRatio);
    return Math.min(cap, Math.max(1, ratioLimit));
}

export function resolveRefinementTunables(global: Global): RefinementTunables {
    const policy = resolveRefinementPolicy(global);
    const tunables = buildRefinementTunables(policy);
    tunables.nearJumpLadder = resolveNearJumpLadder(global, policy);
    return tunables;
}
