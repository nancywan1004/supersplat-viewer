/**
 * lod-scale-align 纯函数自检（无测试框架；`npx tsx` 直接跑）。
 *
 *   npx --yes tsx src/loaders/gsplat/lod/octree/lod-scale-align.test.ts
 */

import {
    computeAdaptiveLodBaseDistance,
    computeLeafCenterDistanceP95,
    computeSceneExtentMetrics,
    resolveTargetFarLod,
    LOD_SCALE_DEFAULT_QUALITY_FACTOR,
    LOD_SCALE_MIN_D0_M
} from './lod-scale-align';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        throw new Error(msg);
    }
}

function assertClose(actual: number, expected: number, eps: number, msg: string): void {
    if (!Number.isFinite(actual) || Math.abs(actual - expected) > eps) {
        throw new Error(`${msg}: expected ${expected} ± ${eps}, got ${actual}`);
    }
}

/** 合成叶 bounds：主体在半径 ~50，外加少量离群把 AABB 拉到 half≈100 */
function buildOutlierBounds(): { bounds: Float32Array; nodeCount: number } {
    const centers: Array<[number, number, number]> = [];
    for (let i = 0; i < 95; i++) {
        const t = (i / 95) * Math.PI * 2;
        centers.push([50 * Math.cos(t), 0, 50 * Math.sin(t)]);
    }
    // 5% 离群：拉长 AABB
    for (let i = 0; i < 5; i++) {
        centers.push([200 + i, 0, 0]);
    }
    const nodeCount = centers.length;
    const bounds = new Float32Array(nodeCount * 6);
    const half = 1;
    for (let i = 0; i < nodeCount; i++) {
        const [x, y, z] = centers[i];
        const b = i * 6;
        bounds[b] = x - half;
        bounds[b + 1] = y - half;
        bounds[b + 2] = z - half;
        bounds[b + 3] = x + half;
        bounds[b + 4] = y + half;
        bounds[b + 5] = z + half;
    }
    return { bounds, nodeCount };
}

function testR95ResistsOutliers(): void {
    const { bounds, nodeCount } = buildOutlierBounds();
    const extents = computeSceneExtentMetrics(bounds, nodeCount);
    const r95 = computeLeafCenterDistanceP95(bounds, nodeCount);
    assert(extents != null && r95 != null, 'extents/r95 should exist');
    assert(extents!.halfExtent > 90, `halfExtent should be inflated, got ${extents!.halfExtent}`);
    assert(r95! < extents!.halfExtent * 0.7, `R95 ${r95} should be much smaller than half ${extents!.halfExtent}`);
    console.log('ok R95 resists outliers', { half: extents!.halfExtent.toFixed(1), r95: r95!.toFixed(1) });
}

function testWuhanNumeric(): void {
    const r = computeAdaptiveLodBaseDistance({
        robustRadiusR95: 64.472,
        maxLod: 9,
        pointCountsByLod: null,
        configuredD0: 5,
        lodMultiplier: 3,
        qualityFactor: LOD_SCALE_DEFAULT_QUALITY_FACTOR
    });
    assert(r != null, 'adaptive should compute');
    // 无点数时用层数 2/3 → target=6；64.472/3^5*1.4 ≈ 0.371
    assert(r!.targetFarLod === 6, `targetFarLod=${r!.targetFarLod}`);
    assertClose(r!.effectiveD0, 0.371, 0.01, 'Wuhan effectiveD0');
    assert(r!.scale > 12, `scale ${r!.scale} must exceed old MAX_SCALE=12`);
    console.log('ok Wuhan numeric', { d0: r!.effectiveD0.toFixed(4), scale: r!.scale.toFixed(2) });
}

function testFlorenzPointRatioSlack(): void {
    // 理想 ×0.5，L6 略高于严格 1/64
    const l0 = 32_000_000;
    const counts = [l0];
    for (let i = 1; i <= 10; i++) {
        counts.push(Math.floor(l0 / (2 ** i)) + (i === 6 ? 10 : 0));
    }
    // L6/L0 略 > 1/64
    counts[6] = Math.floor(l0 / 64) + 8;
    assert(counts[6] / l0 > 1 / 64, 'precondition: L6 slightly above 1/64');
    assert(counts[6] / l0 <= (1 / 64) * 1.05, 'precondition: within 5% slack');

    const resolved = resolveTargetFarLod(10, counts);
    assert(resolved.targetByLayers === 7, `layers=${resolved.targetByLayers}`);
    assert(resolved.targetByPoints === 6, `points=${resolved.targetByPoints}`);
    assert(resolved.targetFarLod === 6, 'points must win over layers=7');

    const r = computeAdaptiveLodBaseDistance({
        robustRadiusR95: 66.367,
        maxLod: 10,
        pointCountsByLod: counts,
        configuredD0: 5,
        lodMultiplier: 3,
        qualityFactor: 1.4
    });
    assert(r != null, 'florenz adaptive');
    assert(r!.targetFarLod === 6, `florenz target=${r!.targetFarLod}`);
    assert(r!.effectiveD0 > LOD_SCALE_MIN_D0_M + 1e-6, 'must not hit 0.15 floor');
    assertClose(r!.effectiveD0, 0.382, 0.02, 'Florenz effectiveD0');
    console.log('ok Florenz slack→LOD6', { d0: r!.effectiveD0.toFixed(4), target: r!.targetFarLod });
}

function testWuhanPointCountsSelectLod6(): void {
    // 近似 Wuhan：L6 ≈ L0/64
    const l0 = 18_509_429;
    const counts = Array.from({ length: 10 }, (_, i) => Math.max(1, Math.round(l0 / (2 ** i))));
    const resolved = resolveTargetFarLod(9, counts);
    assert(resolved.targetFarLod === 6, `Wuhan points target=${resolved.targetFarLod}`);
    console.log('ok Wuhan point counts → LOD6', resolved);
}

function main(): void {
    testR95ResistsOutliers();
    testWuhanNumeric();
    testWuhanPointCountsSelectLod6();
    testFlorenzPointRatioSlack();
    console.log('all lod-scale-align tests passed');
}

main();
