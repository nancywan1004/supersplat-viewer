/**
 * Lighting Visibility Reconciler / Facade 自检。
 *
 *   npx --yes tsx src/scene-visibility/test/lighting-visibility-reconciler.test.ts
 */
import type { Global } from '../../types';
import { createDefaultViewSettings, readViewBloomLocalLightsEnabled, writeSessionLightVisible } from '../../view-settings';
import { applyViewerLightToggle, revertCascadedLightToggleOverlays } from '../lighting-visibility-facade';
import { requestLightingVisibilityReconcile } from '../lighting-visibility-coordinator';
import { reconcileLightingVisibility } from '../lighting-visibility-reconciler';

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

function makeGlobal(): { global: Global; pointRoot: MockEntity; lightA: MockEntity } {
    const lightA: MockEntity = {
        name: 'pointLight_0',
        enabled: true,
        light: { enabled: true },
        __lightConfig: { id: 'a', enabled: true, type: 'point' }
    };
    const pointRoot: MockEntity = {
        name: 'pointLights',
        enabled: true,
        children: [lightA]
    };
    const spotRoot: MockEntity = {
        name: 'spotLights',
        enabled: true,
        children: []
    };
    const vs = createDefaultViewSettings();
    const fires: string[] = [];
    const global = {
        state: { editMode: false },
        settings: {
            lighting: {
                lights: [{ id: 'a', type: 'point', enabled: true }]
            },
            nightMode: { fade: 0.4 }
        },
        viewSettings: vs,
        config: {},
        events: { fire: (name: string) => fires.push(name) },
        app: {
            fire: (name: string) => fires.push(name),
            root: {
                findByName: (name: string) => {
                    if (name === 'pointLights') return pointRoot;
                    if (name === 'spotLights') return spotRoot;
                    return null;
                }
            }
        },
        __fires: fires
    } as unknown as Global & { __fires: string[] };
    return { global, pointRoot, lightA };
}

function testReconcileHidesRootsWithoutWritingSettings(): void {
    const { global, pointRoot, lightA } = makeGlobal();
    global.viewSettings!.contentVisibility!.lights!.visible = false;
    const before = JSON.stringify(global.settings);
    reconcileLightingVisibility(global, { force: true });
    assertEq(pointRoot.enabled, false, 'root off');
    assertEq(lightA.enabled, false, 'entity off');
    assertEq(JSON.stringify(global.settings), before, 'settings 不变');
    console.log('ok reconcile hide 不写 settings');
}

function testSessionOverlayKeepsConfiguredEnabled(): void {
    const { global, pointRoot, lightA } = makeGlobal();
    writeSessionLightVisible(global, 'a', false);
    const before = JSON.stringify(global.settings);
    reconcileLightingVisibility(global, { force: true });
    assertEq(pointRoot.enabled, true, 'root on');
    assertEq(lightA.enabled, false, 'session 关灯');
    assertEq(lightA.light?.enabled, false, 'component off');
    assertEq(
        (global.settings as { lighting: { lights: Array<{ enabled?: boolean }> } }).lighting.lights[0].enabled,
        true,
        'configured 仍为开'
    );
    assertEq(JSON.stringify(global.settings), before, 'settings JSON 不变');
    console.log('ok session overlay 不改 configured');
}

function testIdempotentSkip(): void {
    const { global } = makeGlobal();
    const fires = (global as unknown as { __fires: string[] }).__fires;
    reconcileLightingVisibility(global, { force: true });
    const n = fires.length;
    reconcileLightingVisibility(global);
    assertEq(fires.length, n, '相同 projection 不重复 fire');
    console.log('ok reconcile idempotent');
}

function testDispatchToggleDoesNotWriteSettings(): void {
    const { global } = makeGlobal();
    const before = JSON.stringify(global.settings);
    applyViewerLightToggle(global, 'a', false);
    assertEq(JSON.stringify(global.settings), before, 'Viewer TOGGLE 不写 settings');
    assertEq(global.viewSettings?.contentVisibility?.lights?.instances?.a, false, '写 overlay');
    console.log('ok dispatchLightToggle 会话 overlay');
}

function testCascadeRevert(): void {
    const { global } = makeGlobal();
    applyViewerLightToggle(global, 'a', false);
    assertEq(global.viewSettings?.contentVisibility?.lights?.instances?.a, false, '先写下 overlay');
    const changed = revertCascadedLightToggleOverlays(global);
    assert(changed, '短窗内撤回');
    assertEq(global.viewSettings?.contentVisibility?.lights?.instances?.a, undefined, '级联不留 overlay');
    console.log('ok cascade revert');
}

function testToggleOnWhileCategoryHidden(): void {
    const { global, pointRoot, lightA } = makeGlobal();
    global.viewSettings!.contentVisibility!.lights!.visible = false;
    reconcileLightingVisibility(global, { force: true });
    assertEq(pointRoot.enabled, false, '先全关');
    applyViewerLightToggle(global, 'a', true);
    assertEq(global.viewSettings?.contentVisibility?.lights?.instances?.a, true, '记强制开');
    assertEq(pointRoot.enabled, true, '根节点打开');
    assertEq(lightA.enabled, true, '该灯显示');
    assertEq(lightA.light?.enabled, true, 'component on');
    assertEq(global.viewSettings!.contentVisibility!.lights!.visible, false, '不改大类 intent');
    console.log('ok category hide 后再 TOGGLE 一盏');
}

function testCascadeRevertAfterCategoryOffDoesNotForceOn(): void {
    const { global, pointRoot, lightA } = makeGlobal();
    global.viewSettings!.contentVisibility!.lights!.visible = false;
    applyViewerLightToggle(global, 'a', false);
    const changed = revertCascadedLightToggleOverlays(global);
    assertEq(changed, false, '大类关时 false 是缺省，无键可撤');
    assertEq(global.viewSettings?.contentVisibility?.lights?.instances?.a, undefined, '不写成强制开');
    reconcileLightingVisibility(global, { force: true });
    assertEq(pointRoot.enabled, false, '根节点仍关');
    assertEq(lightA.enabled, false, '灯仍关');
    console.log('ok cascade revert 大类已关不强制开');
}

function testAspectOnWhileCategoryHidden(): void {
    const { global } = makeGlobal();
    const fires = (global as unknown as { __fires: string[] }).__fires;
    global.viewSettings!.contentVisibility!.lights!.visible = false;
    global.viewSettings!.contentVisibility!.lights!.brightness = true;
    global.viewSettings!.contentVisibility!.lights!.bloom = true;
    reconcileLightingVisibility(global, { force: true });
    assertEq(global.viewSettings!.contentVisibility!.lights!.visible, false, '不改大类勾选');
    assert(
        fires.includes('nightMode:forceReapply'),
        '大类关后亮度仍可单独套用'
    );
    assertEq(
        fires.filter((f) => f === 'postEffect:changed').length,
        1,
        '辉光仍可单独套用'
    );
    console.log('ok 大类关后亮度/辉光可单独开');
}

function testCategoryHideDoesNotWriteSettingsOrLocalLights(): void {
    const { global, pointRoot } = makeGlobal();
    const before = JSON.stringify(global.settings);
    assert(readViewBloomLocalLightsEnabled(global), '默认局部亮灯闸开');
    const lights = global.viewSettings!.contentVisibility!.lights!;
    lights.visible = false;
    lights.brightness = false;
    lights.bloom = false;
    lights.shadow = false;
    requestLightingVisibilityReconcile(global, 'lightsIntent:false');
    assertEq(pointRoot.enabled, false, '大类 hide 关根节点');
    assertEq(JSON.stringify(global.settings), before, '不写 settings');
    assert(readViewBloomLocalLightsEnabled(global), '不改 localLightsEnabled');
    lights.visible = true;
    lights.brightness = true;
    lights.bloom = true;
    lights.shadow = true;
    requestLightingVisibilityReconcile(global, 'lightsIntent:true');
    assertEq(JSON.stringify(global.settings), before, 'show 仍不写 settings');
    assert(readViewBloomLocalLightsEnabled(global), 'show 不重置 localLightsEnabled');
    console.log('ok category hide/show 不写 settings / localLights');
}

function testForceDoesNotRefirePostEffectWhenBloomUnchanged(): void {
    const { global } = makeGlobal();
    const fires = (global as unknown as { __fires: string[] }).__fires;
    reconcileLightingVisibility(global, { force: true });
    const first = fires.filter((f) => f === 'postEffect:changed').length;
    assertEq(first, 1, '首次套用 fire postEffect');
    (global as Global & { __lightingVisibilityProjectionKey?: string }).__lightingVisibilityProjectionKey = '';
    reconcileLightingVisibility(global, { force: true });
    assertEq(
        fires.filter((f) => f === 'postEffect:changed').length,
        1,
        'bloom 未变的 force remount 不再 fire postEffect'
    );
    global.viewSettings!.contentVisibility!.lights!.bloom = false;
    reconcileLightingVisibility(global, { force: true });
    assertEq(
        fires.filter((f) => f === 'postEffect:changed').length,
        2,
        'bloom 显隐变化才再 fire postEffect'
    );
    console.log('ok bloom 未变不刷 postEffect');
}

function testSkipBrightnessForceReapplyDuringOneShotReveal(): void {
    const { global, pointRoot } = makeGlobal();
    (global.state as { effectsRuntimeState?: unknown }).effectsRuntimeState = {
        reveal: { status: 'playing', activeType: 'growth-wave' }
    };
    global.viewSettings!.contentVisibility!.lights!.visible = false;
    reconcileLightingVisibility(global, { force: true });
    assertEq(pointRoot.enabled, false, '灯根节点仍套 overlay');
    const fires = (global as unknown as { __fires: string[] }).__fires;
    assert(
        !fires.includes('nightMode:forceReapply'),
        '开场 reveal 播放中不 forceReapply NightMode'
    );
    console.log('ok one-shot reveal 期间跳过 brightness forceReapply');
}

function main(): void {
    testReconcileHidesRootsWithoutWritingSettings();
    testSessionOverlayKeepsConfiguredEnabled();
    testIdempotentSkip();
    testDispatchToggleDoesNotWriteSettings();
    testCascadeRevert();
    testToggleOnWhileCategoryHidden();
    testCascadeRevertAfterCategoryOffDoesNotForceOn();
    testAspectOnWhileCategoryHidden();
    testCategoryHideDoesNotWriteSettingsOrLocalLights();
    testForceDoesNotRefirePostEffectWhenBloomUnchanged();
    testSkipBrightnessForceReapplyDuringOneShotReveal();
    console.log('all lighting-visibility-reconciler tests passed');
}

main();
