/**
 * scene-mesh 加载门控：无 URL 时 canGenerate 不得当成「需要网格」。
 *
 *   npx --yes tsx src/collision/scene-mesh-load-policy.test.ts
 */
import { shouldFetchCollisionFromUniverse, shouldLoadSceneMesh } from './scene-mesh-load-policy';

function assertEq<T>(actual: T, expected: T, msg: string): void {
    if (actual !== expected) {
        throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

function testEffectJsonDoesNotNeedUniverseGenerate(): void {
    assertEq(
        shouldLoadSceneMesh({
            hasUrl: false,
            hasMeshUrl: false,
            wantCollision: false,
            wantShadow: false,
            canGenerate: true
        }),
        false,
        'shadow/collision 均关时不加载'
    );
    assertEq(
        shouldLoadSceneMesh({
            hasUrl: false,
            hasMeshUrl: false,
            wantCollision: false,
            wantShadow: false,
            canGenerate: true,
            intent: { wantShadow: true }
        }),
        true,
        '显式 SHADOW_SET 才走 Universe generate'
    );
    console.log('ok settings-effect 风格：不因 canGenerate 自动 generate');
}

function testShadowOnWithoutUrlDoesNotAutoGenerate(): void {
    assertEq(
        shouldLoadSceneMesh({
            hasUrl: false,
            hasMeshUrl: false,
            wantCollision: false,
            wantShadow: true,
            canGenerate: true
        }),
        false,
        'shadow.enabled 开但无 URL 也不自动 generate'
    );
    assertEq(
        shouldFetchCollisionFromUniverse(true, { wantShadow: true }),
        true,
        '显式 intent 才 generate'
    );
    console.log('ok 无 URL 不因 shadow.enabled 自动 generate');
}

function testConfiguredGlbStillLoads(): void {
    assertEq(
        shouldLoadSceneMesh({
            hasUrl: true,
            hasMeshUrl: true,
            wantCollision: false,
            wantShadow: true,
            canGenerate: false
        }),
        true,
        '已有 GLB 时懒加载'
    );
    console.log('ok 已配置 GLB 仍懒加载');
}

function main(): void {
    testEffectJsonDoesNotNeedUniverseGenerate();
    testShadowOnWithoutUrlDoesNotAutoGenerate();
    testConfiguredGlbStillLoads();
    console.log('all scene-mesh-load-policy tests passed');
}

main();
