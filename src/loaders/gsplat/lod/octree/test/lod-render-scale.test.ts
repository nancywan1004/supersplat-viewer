/**
 * lod-render-scale 纯函数自检（无测试框架；`npx tsx` 直接跑）。
 *
 *   npx --yes tsx src/loaders/gsplat/lod/octree/test/lod-render-scale.test.ts
 */

import {
    buildLeafRepDiameterTable,
    buildScreenDiameters,
    computeEffectiveRenderScale,
    computeFoveateFactor,
    computePixelFactor,
    computeScreenDiameter,
    computeViewAngleDeg,
    computeVisualUrgency,
    computeFilePriority,
    DEFAULT_LOD_RENDER_SCALE_FOVEATION,
    estimateRepDiameterFromAabb,
    mergeVisualBudgetLod,
    parseRepScaleStats,
    resolveRepresentativeDiameter,
    resolveVerticalFovRad,
    selectRenderScaleLod,
    selectRenderScaleLodFromDiameters
} from '../lod-render-scale';

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

function assertEq(actual: number, expected: number, msg: string): void {
    if (actual !== expected) {
        throw new Error(`${msg}: expected ${expected}, got ${actual}`);
    }
}

/** 文档直觉例：LOD5..0 ≈ 20,10,5,2.5,1.2,0.6 px；threshold=1 → LOD1 */
function testSelectLodDocumentExample(): void {
    const diameters = [0.6, 1.2, 2.5, 5, 10, 20];
    assertEq(selectRenderScaleLod(diameters, 1), 1, 'lodRenderScale=1 → LOD1');
    assertEq(selectRenderScaleLod(diameters, 0.5), 0, 'threshold 0.5 → LOD0');
    assertEq(selectRenderScaleLod(diameters, 1.2), 1, 'threshold 1.2 → LOD1 (equal)');
    assertEq(selectRenderScaleLod(diameters, 1.5), 2, 'threshold 1.5 → LOD2');
    assertEq(selectRenderScaleLod(diameters, 100), 5, 'all sub-threshold → maxLod');
    console.log('ok selectLod document example');
}

function testSelectLodFinestWhenClose(): void {
    // 近距：所有档都远大于阈值 → LOD0
    const diameters = [10, 20, 40, 80];
    assertEq(selectRenderScaleLod(diameters, 1), 0, 'all large → LOD0');
    console.log('ok selectLod finest when close');
}

function testPixelAndScreenDiameter(): void {
    // fov=90° → tan(45°)=1 → pixelFactor = H/2
    const pf = computePixelFactor(1080, Math.PI / 2);
    assertClose(pf, 540, 1e-6, 'pixelFactor 90deg 1080p');

    // rep=0.02m, dist=10m → screen = 0.02*540/10 = 1.08
    assertClose(computeScreenDiameter(0.02, pf, 10), 1.08, 1e-6, 'screenDiameter');
    console.log('ok pixelFactor / screenDiameter');
}

function testSelectFromWorldDiameters(): void {
    // 文档比例：世界直径按 LOD 倍增，调距离使屏上约为 [0.6,1.2,2.5,5,10,20]
    const world = [0.006, 0.012, 0.025, 0.05, 0.1, 0.2];
    const pf = computePixelFactor(1080, Math.PI / 2); // 540
    // screen = world * 540 / dist；要 LOD0≈0.6 → dist = 0.006*540/0.6 = 5.4
    const dist = 5.4;
    const screens = buildScreenDiameters(world, pf, dist);
    assertClose(screens[0], 0.6, 0.05, 'LOD0 screen');
    assertClose(screens[1], 1.2, 0.05, 'LOD1 screen');
    assertEq(selectRenderScaleLodFromDiameters(world, pf, dist, 1), 1, 'from diameters → LOD1');
    console.log('ok selectFromWorldDiameters', screens.map(s => s.toFixed(2)));
}

function testFoveation(): void {
    const p = DEFAULT_LOD_RENDER_SCALE_FOVEATION;
    assertClose(computeFoveateFactor(0, p), 1, 1e-9, 'center');
    assertClose(computeFoveateFactor(20, p), 1, 1e-9, 'coneFov0 edge');
    assertClose(computeFoveateFactor(80, p), 0.5, 1e-6, 'coneFov edge');
    assertClose(computeFoveateFactor(180, p), 0.2, 1e-6, 'behind');
    // 中点 cone0..cone → (1+0.5)/2 = 0.75
    assertClose(computeFoveateFactor(50, p), 0.75, 1e-6, 'mid cone');

    const base = 1.5;
    assertClose(computeEffectiveRenderScale(base, 1), 1.5, 1e-9, 'center effective');
    assertClose(computeEffectiveRenderScale(base, 0.5), 3, 1e-9, 'edge effective');
    assertClose(computeEffectiveRenderScale(base, 0.2), 7.5, 1e-9, 'behind effective');
    console.log('ok foveation');
}

function testFoveationChangesLod(): void {
    const diameters = [0.6, 1.2, 2.5, 5, 10, 20];
    const base = 1.5;
    // 中央 effective=1.5 → LOD2 (2.5>=1.5, 1.2<1.5)
    const centerLod = selectRenderScaleLod(diameters, computeEffectiveRenderScale(base, 1));
    assertEq(centerLod, 2, 'center → LOD2');
    // 边缘 effective=3 → LOD3
    const edgeLod = selectRenderScaleLod(diameters, computeEffectiveRenderScale(base, 0.5));
    assertEq(edgeLod, 3, 'edge → LOD3');
    // 身后 effective=7.5 → LOD4 (10>=7.5, 5<7.5)
    const behindLod = selectRenderScaleLod(diameters, computeEffectiveRenderScale(base, 0.2));
    assertEq(behindLod, 4, 'behind → LOD4');
    console.log('ok foveation changes lod', { centerLod, edgeLod, behindLod });
}

function testMergeVisualBudget(): void {
    // 视觉 LOD1、预算追 LOD0 → 停在 1
    assertEq(mergeVisualBudgetLod(1, 0), 1, 'budget ample stop at visual');
    // 视觉 LOD1、预算只能 LOD3 → 3
    assertEq(mergeVisualBudgetLod(1, 3), 3, 'budget tight coarsen');
    // 相等
    assertEq(mergeVisualBudgetLod(2, 2), 2, 'equal');
    console.log('ok mergeVisualBudget');
}

function testRepScaleParseAndFallback(): void {
    assert(parseRepScaleStats(null) === null, 'null');
    assert(parseRepScaleStats({ p50: 1, p75: 2 }) === null, 'missing p90');
    const s = parseRepScaleStats({ p50: 0.01, p75: 0.02, p90: 0.03 });
    assert(s != null && s.p75 === 0.02, 'parse ok');
    assertClose(resolveRepresentativeDiameter(s, 9), 0.02, 1e-12, 'prefer p75');
    assertClose(resolveRepresentativeDiameter(null, 0.5), 0.5, 1e-12, 'fallback');

    // diag=8, count=8 → 8/cbrt(8)=4
    assertClose(estimateRepDiameterFromAabb(8, 8, 1), 4, 1e-9, 'aabb fallback');
    console.log('ok parse / fallback');
}

function testLeafRepTableMetaAndFallback(): void {
    const leafCount = 2;
    const lodLevels = 3;
    const bounds = new Float32Array([
        0, 0, 0, 3, 4, 0, // diag=5
        0, 0, 0, 6, 8, 0 // diag=10
    ]);
    const meta = {
        leafRepScale: [
            [0.1, 0.2, 0.4],
            [0.0, 0.5, 1.0] // lod0 invalid → fallback that leaf mixed
        ]
    };
    // second row lod0 invalid → parseLeafRepScaleTable rejects incomplete rows
    // use valid second row
    const metaOk = {
        leafRepScale: [
            [0.1, 0.2, 0.4],
            [0.2, 0.5, 1.0]
        ]
    };
    const tableMeta = buildLeafRepDiameterTable({
        leafCount,
        lodLevels,
        nodeBoundsMinMax: bounds,
        getSplatCount: () => 8,
        metaData: metaOk
    });
    assert(tableMeta.source === 'meta', `source=${tableMeta.source}`);
    assertClose(tableMeta.diameters[0], 0.1, 1e-6, 'meta leaf0 lod0');

    const tableFb = buildLeafRepDiameterTable({
        leafCount,
        lodLevels,
        nodeBoundsMinMax: bounds,
        getSplatCount: () => 8,
        metaData: null
    });
    assert(tableFb.source === 'aabb-fallback', 'aabb source');
    // leaf0 diag=5, count=8 → 5/2 = 2.5
    assertClose(tableFb.diameters[0], 2.5, 1e-9, 'aabb leaf0');
    void meta;
    console.log('ok leafRepTable');
}

function testViewAngleAndVerticalFov(): void {
    assertClose(computeViewAngleDeg(0, 0, -1, 0, 0, 0, 0, 0, -1), 0, 1e-6, 'look at');
    assertClose(computeViewAngleDeg(0, 0, 1, 0, 0, 0, 0, 0, -1), 180, 1e-6, 'behind');
    // horizontal 90°, aspect 2 → vertical smaller
    const vfov = resolveVerticalFovRad(90, 2, true);
    assertClose(vfov, 2 * Math.atan(Math.tan(Math.PI / 4) / 2), 1e-9, 'hfov→vfov');
    console.log('ok viewAngle / verticalFov');
}

function testVisualUrgency(): void {
    // 当前 4px、目标 1px、area=1、foveate=1 → log2(4)=2
    assertClose(computeVisualUrgency(4, 1, 1, 1), 2, 1e-9, 'log2 ratio');
    // 已够细 → 0
    assertClose(computeVisualUrgency(0.5, 1, 10, 1), 0, 1e-9, 'sub-target');
    // 边缘 foveate 减半
    assertClose(computeVisualUrgency(4, 1, 1, 0.5), 1, 1e-9, 'foveate weight');
    assertClose(computeFilePriority(10, 5), 2, 1e-9, 'file priority');
    assertClose(computeFilePriority(10, 0), 10, 1e-9, 'cost floor');
    console.log('ok visualUrgency');
}

function main(): void {
    testSelectLodDocumentExample();
    testSelectLodFinestWhenClose();
    testPixelAndScreenDiameter();
    testSelectFromWorldDiameters();
    testFoveation();
    testFoveationChangesLod();
    testMergeVisualBudget();
    testRepScaleParseAndFallback();
    testLeafRepTableMetaAndFallback();
    testViewAngleAndVerticalFov();
    testVisualUrgency();
    console.log('all lod-render-scale tests passed');
}

main();
