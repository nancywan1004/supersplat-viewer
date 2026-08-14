/**
 * 父级光照显隐回包契约（无测试框架；`npx tsx` 直接跑）。
 *
 *   npx --yes tsx src/scene-visibility/lighting-visibility-parent-contract.test.ts
 *
 * 冻结的是父级可观察出站序列。Viewer TOGGLE 写 settings 等内部行为不在此锁定。
 */
import {
    EXPECTED_OUTBOUND_FOR_LIGHT_TOGGLE,
    expectedOutboundForAllSet,
    expectedOutboundForCategorySet,
    expectedOutboundForLightingAspectSet,
    LIGHTING_SHOW_HIDE_CHANGED_BY_KEY
} from './lighting-visibility-parent-contract';
import {
    SCENE_CONTENT_ALL_SET_HIDE_ORDER,
    SCENE_CONTENT_ALL_SET_SHOW_ORDER,
    SCENE_CONTENT_CATEGORY_IDS
} from './types';

function assert(cond: boolean, msg: string): void {
    if (!cond) {
        throw new Error(msg);
    }
}

function assertJsonEq(actual: unknown, expected: unknown, msg: string): void {
    const a = JSON.stringify(actual);
    const b = JSON.stringify(expected);
    if (a !== b) {
        throw new Error(`${msg}:\n  expected ${b}\n  actual   ${a}`);
    }
}

function testLightingChangedTypeNames(): void {
    assert(
        LIGHTING_SHOW_HIDE_CHANGED_BY_KEY.brightness === 'LIGHTING_BRIGHTNESS_SHOW_HIDE_CHANGED',
        'brightness CHANGED name'
    );
    assert(
        LIGHTING_SHOW_HIDE_CHANGED_BY_KEY.bloom === 'LIGHTING_BLOOM_SHOW_HIDE_CHANGED',
        'bloom CHANGED name'
    );
    assert(
        LIGHTING_SHOW_HIDE_CHANGED_BY_KEY.shadow === 'LIGHTING_SHADOW_SHOW_HIDE_CHANGED',
        'shadow CHANGED name'
    );
    console.log('ok lighting changed type names');
}

function testCategorySetLightsWithShadow(): void {
    assertJsonEq(
        expectedOutboundForCategorySet({
            category: 'lights',
            value: false,
            intentChanged: true,
            shadowCapability: true
        }),
        [
            { type: 'SCENE_CONTENT_CATEGORY_CHANGED', category: 'lights', value: false },
            { type: 'LIGHTING_BRIGHTNESS_SHOW_HIDE_CHANGED', value: false },
            { type: 'LIGHTING_BLOOM_SHOW_HIDE_CHANGED', value: false },
            { type: 'LIGHTING_SHADOW_SHOW_HIDE_CHANGED', value: false }
        ],
        'CATEGORY_SET lights false + sceneMesh'
    );
    assertJsonEq(
        expectedOutboundForCategorySet({
            category: 'lights',
            value: true,
            intentChanged: true,
            shadowCapability: true
        }),
        [
            { type: 'SCENE_CONTENT_CATEGORY_CHANGED', category: 'lights', value: true },
            { type: 'LIGHTING_BRIGHTNESS_SHOW_HIDE_CHANGED', value: true },
            { type: 'LIGHTING_BLOOM_SHOW_HIDE_CHANGED', value: true },
            { type: 'LIGHTING_SHADOW_SHOW_HIDE_CHANGED', value: true }
        ],
        'CATEGORY_SET lights true + sceneMesh'
    );
    console.log('ok category set lights with shadow');
}

function testCategorySetLightsWithoutShadow(): void {
    assertJsonEq(
        expectedOutboundForCategorySet({
            category: 'lights',
            value: false,
            intentChanged: true,
            shadowCapability: false
        }),
        [
            { type: 'SCENE_CONTENT_CATEGORY_CHANGED', category: 'lights', value: false },
            { type: 'LIGHTING_BRIGHTNESS_SHOW_HIDE_CHANGED', value: false },
            { type: 'LIGHTING_BLOOM_SHOW_HIDE_CHANGED', value: false }
        ],
        'CATEGORY_SET lights false, no sceneMesh: 无 shadow CHANGED'
    );
    console.log('ok category set lights without shadow');
}

function testCategorySetUnchangedAndNonLights(): void {
    assertJsonEq(
        expectedOutboundForCategorySet({
            category: 'lights',
            value: false,
            intentChanged: false,
            shadowCapability: true
        }),
        [],
        'CATEGORY_SET intent 未变不出站'
    );
    assertJsonEq(
        expectedOutboundForCategorySet({
            category: 'assets',
            value: false,
            intentChanged: true,
            shadowCapability: true
        }),
        [{ type: 'SCENE_CONTENT_CATEGORY_CHANGED', category: 'assets', value: false }],
        '非 lights 大类不级联 LIGHTING_*_CHANGED'
    );
    console.log('ok category set unchanged / non-lights');
}

function testAllSetSequences(): void {
    const hideNoShadow = expectedOutboundForAllSet({ value: false, shadowCapability: false });
    assert(hideNoShadow[0].type === 'SCENE_CONTENT_ALL_CHANGED', 'ALL_SET 先 ALL_CHANGED');
    assertJsonEq(hideNoShadow[0].categories, SCENE_CONTENT_ALL_SET_HIDE_ORDER, 'hide categories 顺序');
    assert(hideNoShadow[0].value === false, 'ALL_CHANGED value false');
    assert(hideNoShadow.length === 1 + SCENE_CONTENT_ALL_SET_HIDE_ORDER.length + 2, 'hide 无 shadow 条数');
    for (let i = 0; i < SCENE_CONTENT_ALL_SET_HIDE_ORDER.length; i++) {
        assertJsonEq(
            hideNoShadow[1 + i],
            {
                type: 'SCENE_CONTENT_CATEGORY_CHANGED',
                category: SCENE_CONTENT_ALL_SET_HIDE_ORDER[i],
                value: false
            },
            `hide CATEGORY_CHANGED[${i}]`
        );
    }
    assertJsonEq(
        hideNoShadow.slice(-2),
        [
            { type: 'LIGHTING_BRIGHTNESS_SHOW_HIDE_CHANGED', value: false },
            { type: 'LIGHTING_BLOOM_SHOW_HIDE_CHANGED', value: false }
        ],
        'hide 末尾 lighting 子项（无 shadow）'
    );

    const showWithShadow = expectedOutboundForAllSet({ value: true, shadowCapability: true });
    assertJsonEq(showWithShadow[0].categories, SCENE_CONTENT_ALL_SET_SHOW_ORDER, 'show categories 顺序');
    assert(
        showWithShadow[showWithShadow.length - 1].type === 'LIGHTING_SHADOW_SHOW_HIDE_CHANGED',
        'show + sceneMesh 最后一条是 shadow CHANGED'
    );
    assert(SCENE_CONTENT_ALL_SET_HIDE_ORDER[SCENE_CONTENT_ALL_SET_HIDE_ORDER.length - 1] === 'lights', 'hide 末位 lights');
    assert(SCENE_CONTENT_ALL_SET_SHOW_ORDER[SCENE_CONTENT_ALL_SET_SHOW_ORDER.length - 1] === 'lights', 'show 末位 lights');
    for (const id of SCENE_CONTENT_CATEGORY_IDS) {
        assert(SCENE_CONTENT_ALL_SET_HIDE_ORDER.includes(id), `hide order 含 ${id}`);
        assert(SCENE_CONTENT_ALL_SET_SHOW_ORDER.includes(id), `show order 含 ${id}`);
    }
    console.log('ok all-set sequences');
}

function testLightingAspectSet(): void {
    assertJsonEq(
        expectedOutboundForLightingAspectSet({
            key: 'brightness',
            value: false,
            intentChanged: true,
            shadowCapability: false
        }),
        [{ type: 'LIGHTING_BRIGHTNESS_SHOW_HIDE_CHANGED', value: false }],
        'brightness SET'
    );
    assertJsonEq(
        expectedOutboundForLightingAspectSet({
            key: 'shadow',
            value: false,
            intentChanged: true,
            shadowCapability: false
        }),
        [],
        '无 sceneMesh 时 shadow SET no-op'
    );
    assertJsonEq(
        expectedOutboundForLightingAspectSet({
            key: 'shadow',
            value: false,
            intentChanged: true,
            shadowCapability: true
        }),
        [{ type: 'LIGHTING_SHADOW_SHOW_HIDE_CHANGED', value: false }],
        '有 sceneMesh 时 shadow SET 出站'
    );
    assertJsonEq(
        expectedOutboundForLightingAspectSet({
            key: 'bloom',
            value: true,
            intentChanged: false,
            shadowCapability: true
        }),
        [],
        'intent 未变不出站'
    );
    console.log('ok lighting aspect set');
}

function testLightToggleEmitsNoParentChanged(): void {
    assertJsonEq(EXPECTED_OUTBOUND_FOR_LIGHT_TOGGLE, [], 'LIGHT_TOGGLE 无 Scene Content / Lighting CHANGED');
    console.log('ok light toggle emits no parent changed');
}

function main(): void {
    testLightingChangedTypeNames();
    testCategorySetLightsWithShadow();
    testCategorySetLightsWithoutShadow();
    testCategorySetUnchangedAndNonLights();
    testAllSetSequences();
    testLightingAspectSet();
    testLightToggleEmitsNoParentChanged();
    console.log('all lighting-visibility-parent-contract tests passed');
}

main();
