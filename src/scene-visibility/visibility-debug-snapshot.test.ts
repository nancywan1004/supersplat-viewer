/**
 * VisibilityDebugSnapshot 只读自检（无测试框架；`npx tsx` 直接跑）。
 *
 *   npx --yes tsx src/scene-visibility/visibility-debug-snapshot.test.ts
 */
import type { Global } from '../types';
import { createDefaultViewSettings } from '../view-settings';
import { captureVisibilityDebugSnapshot } from './visibility-debug-snapshot';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        throw new Error(msg);
    }
}

function assertEq<T>(actual: T, expected: T, msg: string): void {
    if (actual !== expected) {
        throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

type MockEntity = {
    name: string;
    enabled: boolean;
    children?: MockEntity[];
    light?: { enabled: boolean };
    __lightConfig?: { id: string; enabled?: boolean; type?: string };
};

function makeGlobal(overrides?: {
    editMode?: boolean;
    lightsCategory?: boolean;
    brightness?: boolean;
    collisionUrl?: string;
    torchActive?: boolean;
}): Global {
    const pointA: MockEntity = {
        name: 'pointLight_0',
        enabled: true,
        light: { enabled: true },
        __lightConfig: { id: 'light-1', enabled: true, type: 'point' }
    };
    const pointRoot: MockEntity = {
        name: 'pointLights',
        enabled: true,
        children: [pointA]
    };
    const spotRoot: MockEntity = {
        name: 'spotLights',
        enabled: false,
        children: []
    };
    const vs = createDefaultViewSettings();
    vs.contentVisibility = {
        ...vs.contentVisibility,
        lights: overrides?.lightsCategory !== false
    };
    vs.lightingVisibility = {
        brightness: overrides?.brightness !== false,
        bloom: true,
        shadow: true
    };
    vs.torch = { active: overrides?.torchActive === true };

    return {
        state: { editMode: overrides?.editMode === true },
        settings: {
            lighting: {
                lights: [
                    { id: 'light-1', type: 'point', enabled: true },
                    { id: 'light-2', type: 'spot', enabled: false },
                    { id: 'sun', type: 'directional', enabled: true }
                ]
            }
        },
        viewSettings: vs,
        config: { collisionUrl: overrides?.collisionUrl },
        app: {
            root: {
                findByName: (name: string) => {
                    if (name === 'pointLights') return pointRoot;
                    if (name === 'spotLights') return spotRoot;
                    return null;
                }
            }
        }
    } as unknown as Global;
}

function testViewerIntentsAndConfigured(): void {
    const snap = captureVisibilityDebugSnapshot(makeGlobal(), { reason: 'phase0', revision: 1 });
    assertEq(snap.reason, 'phase0', 'reason');
    assertEq(snap.revision, 1, 'revision');
    assertEq(snap.mode, 'viewer', 'mode');
    assertEq(snap.runtimeGateOpen, true, 'default gate');
    assertEq(snap.intents.lightsCategory, true, 'lights category');
    assertEq(snap.intents.brightness, true, 'brightness intent');
    assertEq(snap.intents.torchActive, false, 'torch independent default');
    assertEq(snap.configuredLightEnabled['light-1'], true, 'configured on');
    assertEq(snap.configuredLightEnabled['light-2'], false, 'configured off');
    assert(!('sun' in snap.configuredLightEnabled), 'directional 不进用户灯表');
    assertEq(snap.sessionLightVisible, null, 'Phase 0 尚无独立实例 overlay');
    assertEq(snap.effective.brightness, true, 'effective brightness');
    assertEq(snap.actual.pointRootEnabled, true, 'point root');
    assertEq(snap.actual.spotRootEnabled, false, 'spot root');
    assertEq(snap.actual.lightComponents['light-1'], true, 'component');
    assertEq(snap.capability.shadowSceneMeshConfigured, false, 'no mesh');
    console.log('ok viewer snapshot fields');
}

function testCategoryOffForcesEffectiveFalse(): void {
    const snap = captureVisibilityDebugSnapshot(makeGlobal({ lightsCategory: false }));
    assertEq(snap.intents.lightsCategory, false, 'category intent');
    assertEq(snap.intents.brightness, true, '子项 intent 仍可为 true');
    assertEq(snap.effective.brightness, false, 'effective 被大类压住');
    assertEq(snap.effective.bloom, false, 'bloom effective');
    assertEq(snap.intents.torchActive, false, 'torch 不随 lights 大类');
    console.log('ok category gate vs torch');
}

function testEditIgnoresSessionOverlay(): void {
    const snap = captureVisibilityDebugSnapshot(makeGlobal({
        editMode: true,
        lightsCategory: false,
        brightness: false
    }));
    assertEq(snap.mode, 'edit', 'edit mode');
    assertEq(snap.effective.brightness, true, '编辑态忽略会话门控');
    console.log('ok edit ignores overlay');
}

function testShadowCapabilityFromGlb(): void {
    const snap = captureVisibilityDebugSnapshot(makeGlobal({
        collisionUrl: 'https://cdn.example/scene.glb'
    }));
    assertEq(snap.capability.shadowSceneMeshConfigured, true, 'glb → shadow capability');
    console.log('ok shadow capability');
}

function testSnapshotDoesNotMutate(): void {
    const global = makeGlobal({ lightsCategory: true });
    const before = JSON.stringify(global.settings);
    const vsBefore = JSON.stringify(global.viewSettings);
    captureVisibilityDebugSnapshot(global, { reason: 'no-write' });
    assertEq(JSON.stringify(global.settings), before, 'settings 不变');
    assertEq(JSON.stringify(global.viewSettings), vsBefore, 'viewSettings 不变');
    console.log('ok snapshot is read-only');
}

function main(): void {
    testViewerIntentsAndConfigured();
    testCategoryOffForcesEffectiveFalse();
    testEditIgnoresSessionOverlay();
    testShadowCapabilityFromGlb();
    testSnapshotDoesNotMutate();
    console.log('all visibility-debug-snapshot tests passed');
}

main();
