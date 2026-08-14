/**
 * Lighting Visibility Resolver 自检（无测试框架；`npx tsx` 直接跑）。
 *
 *   npx --yes tsx src/scene-visibility/lighting-visibility-resolver.test.ts
 */
import type { Global } from '../types';
import {
    createDefaultViewSettings,
    ensureViewSettings,
    interpretLightingContentVisibility,
    writeSessionLightVisible
} from '../view-settings';
import {
    collectLightingVisibilityResolveInput,
    resolveLightingVisibility,
    resolveLightingVisibilityFromGlobal,
    type LightingVisibilityResolveInput
} from './lighting-visibility-resolver';

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

function baseInput(overrides?: Partial<LightingVisibilityResolveInput>): LightingVisibilityResolveInput {
    return {
        editMode: false,
        runtimeGateOpen: true,
        lightsVisible: true,
        brightness: true,
        bloom: true,
        shadow: true,
        shadowCapabilityAvailable: true,
        configuredLightEnabled: { a: true, b: false },
        sessionLightVisible: {},
        ...overrides
    };
}

function testViewerCategoryOff(): void {
    const proj = resolveLightingVisibility(baseInput({ lightsVisible: false }));
    assertEq(proj.lightsEffective, false, 'category');
    assertEq(proj.lightRootEffective, false, 'root');
    assertEq(proj.brightnessEffective, false, 'brightness');
    assertEq(proj.bloomEffective, false, 'bloom');
    assertEq(proj.shadowEffective, false, 'shadow');
    assertEq(proj.lights.a, false, 'light a');
    assertEq(proj.lights.b, false, 'light b');
    console.log('ok viewer category off');
}

function testConfiguredAndSessionOverlay(): void {
    const proj = resolveLightingVisibility(baseInput({
        sessionLightVisible: { a: false }
    }));
    assertEq(proj.lights.a, false, 'session overlay 关灯');
    assertEq(proj.lights.b, false, 'configured 关');
    const on = resolveLightingVisibility(baseInput());
    assertEq(on.lights.a, true, 'configured 开且无 overlay');
    assertEq(on.lights.b, false, 'configured 关仍关');
    console.log('ok configured × session overlay');
}

function testSessionToggleDoesNotNeedConfiguredChange(): void {
    const configured = { a: true };
    const proj = resolveLightingVisibility(baseInput({
        configuredLightEnabled: configured,
        sessionLightVisible: { a: false }
    }));
    assertEq(proj.lights.a, false, 'overlay 关');
    assertEq(configured.a, true, 'configuredEnabled 未被 Resolver 改写');
    console.log('ok session overlay 不改 configuredEnabled');
}

function testEditIgnoresViewerIntent(): void {
    const proj = resolveLightingVisibility(baseInput({
        editMode: true,
        lightsVisible: false,
        brightness: false,
        bloom: false,
        shadow: false,
        runtimeGateOpen: true,
        sessionLightVisible: { a: false },
        shadowCapabilityAvailable: true
    }));
    assertEq(proj.lightsEffective, true, 'edit category');
    assertEq(proj.lightRootEffective, true, 'edit root');
    assertEq(proj.brightnessEffective, true, 'edit brightness');
    assertEq(proj.bloomEffective, true, 'edit bloom');
    assertEq(proj.shadowEffective, true, 'edit shadow with capability');
    assertEq(proj.lights.a, true, 'edit 忽略 session overlay');
    assertEq(proj.lights.b, false, 'edit 仍服从 configuredEnabled');
    console.log('ok edit ignores viewer overlay');
}

function testShadowCapability(): void {
    const noMesh = resolveLightingVisibility(baseInput({
        shadow: true,
        shadowCapabilityAvailable: false
    }));
    assertEq(noMesh.brightnessEffective, true, 'brightness 不受 capability');
    assertEq(noMesh.shadowEffective, false, '无 mesh → shadowEffective false');
    const gated = resolveLightingVisibility(baseInput({
        runtimeGateOpen: false
    }));
    assertEq(gated.lightRootEffective, false, 'gate 关根节点');
    assertEq(gated.lights.a, false, 'gate 关单灯');
    assertEq(gated.brightnessEffective, true, 'gate 不压 brightness');
    console.log('ok shadow capability and runtime gate');
}

function testLocalLightsMasterGate(): void {
    const proj = resolveLightingVisibility(baseInput({ localLightsEnabled: false }));
    assertEq(proj.lightsEffective, true, '大类仍开');
    assertEq(proj.brightnessEffective, false, 'TOGGLE_ALL 压亮度');
    assertEq(proj.bloomEffective, false, 'TOGGLE_ALL 压辉光');
    assertEq(proj.shadowEffective, true, '不压阴影');
    const edit = resolveLightingVisibility(baseInput({
        editMode: true,
        localLightsEnabled: false
    }));
    assertEq(edit.brightnessEffective, true, 'Edit 忽略总闸');
    console.log('ok localLightsEnabled master gate');
}

function testInterpretLightsShape(): void {
    const fromBool = interpretLightingContentVisibility(false);
    assertEq(fromBool.visible, false, 'boolean lights → visible');
    assertEq(fromBool.brightness, true, 'boolean 不带齐子项时用缺省');
    const incomplete = interpretLightingContentVisibility({ visible: true, brightness: false });
    assertEq(incomplete.brightness, false, '保留已有子项');
    assertEq(incomplete.bloom, true, '缺省补齐 bloom');
    console.log('ok interpret lights shape');
}

function testEnsureNormalizesIncompleteLights(): void {
    const global = {
        viewSettings: {
            bloom: { localLightsEnabled: true },
            contentVisibility: { lights: false }
        }
    } as unknown as Global;
    const vs = ensureViewSettings(global);
    assertEq(vs.contentVisibility?.lights && typeof vs.contentVisibility.lights === 'object', true, 'lights 为节点');
    assertEq(vs.contentVisibility?.lights?.visible, false, 'boolean → visible');
    assertEq(vs.contentVisibility?.lights?.brightness, true, '缺省 brightness');
    console.log('ok ensureViewSettings 规范化 lights 节点');
}

function testFromGlobalNoWrite(): void {
    const vs = createDefaultViewSettings();
    vs.contentVisibility!.lights!.visible = false;
    vs.contentVisibility!.lights!.instances = { a: false };
    const global = {
        state: { editMode: false },
        settings: {
            lighting: {
                lights: [
                    { id: 'a', type: 'point', enabled: true },
                    { id: 'sun', type: 'directional', enabled: true }
                ]
            }
        },
        viewSettings: vs,
        config: {}
    } as unknown as Global;
    const settingsBefore = JSON.stringify(global.settings);
    const vsBefore = JSON.stringify(global.viewSettings);
    const proj = resolveLightingVisibilityFromGlobal(global);
    assertEq(proj.lightsEffective, false, 'fromGlobal category');
    assertEq(proj.lights.a, false, 'fromGlobal overlay');
    assert(!('sun' in proj.lights), 'directional 不进投影');
    assertEq(JSON.stringify(global.settings), settingsBefore, 'settings 不变');
    assertEq(JSON.stringify(global.viewSettings), vsBefore, 'viewSettings 不变');
    const input = collectLightingVisibilityResolveInput(global);
    assertEq(input.sessionLightVisible.a, false, 'collect overlay');
    console.log('ok fromGlobal 无副作用');
}

function testWriteSessionOverlayHelpers(): void {
    const global = { viewSettings: createDefaultViewSettings() } as unknown as Global;
    assertEq(writeSessionLightVisible(global, 'a', false), true, 'write false');
    assertEq(global.viewSettings?.contentVisibility?.lights?.instances?.a, false, 'stored false');
    assertEq(writeSessionLightVisible(global, 'a', true), true, 'write true');
    assertEq(global.viewSettings?.contentVisibility?.lights?.instances, undefined, '缺省删除键');
    console.log('ok session overlay helpers');
}

function main(): void {
    testViewerCategoryOff();
    testConfiguredAndSessionOverlay();
    testSessionToggleDoesNotNeedConfiguredChange();
    testEditIgnoresViewerIntent();
    testShadowCapability();
    testLocalLightsMasterGate();
    testInterpretLightsShape();
    testEnsureNormalizesIncompleteLights();
    testFromGlobalNoWrite();
    testWriteSessionOverlayHelpers();
    console.log('all lighting-visibility-resolver tests passed');
}

main();
