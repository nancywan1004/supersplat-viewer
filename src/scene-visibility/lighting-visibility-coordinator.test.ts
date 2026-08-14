/**
 * Lighting Visibility Coordinator 自检。
 *
 *   npx --yes tsx src/scene-visibility/lighting-visibility-coordinator.test.ts
 */
import type { Global } from '../types';
import { createDefaultViewSettings } from '../view-settings';
import {
    ensureLightingVisibilityCoordinator,
    invalidateLightingVisibility
} from './lighting-visibility-coordinator';
import { reconcileLightingVisibility } from './lighting-visibility-reconciler';

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

function makeGlobal(withPrerender = false): {
    global: Global;
    pointRoot: MockEntity;
    lightA: MockEntity;
    prerender: Array<() => void>;
} {
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
    const prerender: Array<() => void> = [];
    const app: Record<string, unknown> = {
        fire: (name: string) => fires.push(name),
        root: {
            findByName: (name: string) => {
                if (name === 'pointLights') return pointRoot;
                if (name === 'spotLights') return spotRoot;
                return null;
            }
        }
    };
    if (withPrerender) {
        app.once = (event: string, cb: () => void) => {
            if (event === 'prerender') {
                prerender.push(cb);
            }
        };
    }
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
        app,
        __fires: fires
    } as unknown as Global & { __fires: string[] };
    return { global, pointRoot, lightA, prerender };
}

function testInvalidateWithoutOnceFlushesNow(): void {
    const { global, pointRoot } = makeGlobal(false);
    ensureLightingVisibilityCoordinator(global);
    global.viewSettings!.contentVisibility!.lights!.visible = false;
    invalidateLightingVisibility(global, 'rebuild');
    assertEq(pointRoot.enabled, false, '无 prerender 时立即套用');
    console.log('ok invalidate 无 once 立即 flush');
}

function testInvalidateCoalescesOnPrerender(): void {
    const { global, pointRoot, prerender } = makeGlobal(true);
    const coord = ensureLightingVisibilityCoordinator(global);
    global.viewSettings!.contentVisibility!.lights!.visible = false;
    invalidateLightingVisibility(global, 'a');
    invalidateLightingVisibility(global, 'b');
    assertEq(prerender.length, 1, '只挂一次 prerender');
    assertEq(pointRoot.enabled, true, 'prerender 前不改实体');
    assertEq(coord.getGeneration(), 2, '两次 invalidate 累加 generation');
    prerender[0]();
    assertEq(pointRoot.enabled, false, 'prerender 后套用');
    console.log('ok invalidate prerender 合并');
}

function testStalePrerenderSkipsIfAlreadyApplied(): void {
    const { global, pointRoot, prerender } = makeGlobal(true);
    const fires = (global as unknown as { __fires: string[] }).__fires;
    ensureLightingVisibilityCoordinator(global);
    reconcileLightingVisibility(global, { force: true });
    invalidateLightingVisibility(global, 'rebuild');
    assertEq(prerender.length, 1, '挂了 prerender');
    prerender[0]();
    assertEq(
        fires.filter((f) => f === 'postEffect:changed').length,
        1,
        'bloom 未变时 force invalidate 不再 fire postEffect'
    );
    const afterFirst = fires.length;
    prerender[0]();
    assertEq(fires.length, afterFirst, '过期 prerender 不再套用');
    assertEq(pointRoot.enabled, true, '默认 visible 仍开');
    console.log('ok 过期 prerender 跳过');
}

function testNestedInvalidateDuringFlushDoesNotLoop(): void {
    const { global, pointRoot } = makeGlobal(false);
    const fires = (global as unknown as { __fires: string[] }).__fires;
    ensureLightingVisibilityCoordinator(global);
    global.viewSettings!.contentVisibility!.lights!.visible = false;
    const events = global.events as { fire: (name: string) => void };
    const origFire = events.fire.bind(events);
    let nested = 0;
    events.fire = (name: string) => {
        origFire(name);
        if (name === 'postEffect:changed' && nested < 3) {
            nested += 1;
            lightAReset(global);
            invalidateLightingVisibility(global, 'nestedRebuild');
        }
    };
    invalidateLightingVisibility(global, 'first');
    assertEq(pointRoot.enabled, false, '嵌套重建后仍保持 overlay');
    assert(nested >= 1, 'postEffect 触发了嵌套 invalidate');
    assert(nested <= 3, 'while + skipPostEffect 截断循环');
    assert(fires.filter((f) => f === 'postEffect:changed').length === 1, '后续 pass 不再 fire postEffect');
    console.log('ok 嵌套 invalidate 不死循环');
}

function lightAReset(global: Global): void {
    const root = global.app.root.findByName('pointLights') as {
        enabled: boolean;
        children: Array<{ enabled: boolean; light?: { enabled: boolean } }>;
    };
    root.enabled = true;
    for (const child of root.children) {
        child.enabled = true;
        if (child.light) {
            child.light.enabled = true;
        }
    }
}

function main(): void {
    testInvalidateWithoutOnceFlushesNow();
    testInvalidateCoalescesOnPrerender();
    testStalePrerenderSkipsIfAlreadyApplied();
    testNestedInvalidateDuringFlushDoesNotLoop();
    console.log('all lighting-visibility-coordinator tests passed');
}

main();
