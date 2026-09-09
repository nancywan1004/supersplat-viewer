/**
 * 标注大类扫描 vs 单条 ANNOTATION_SHOW_HIDE overlay 自检。
 *
 *   npx --yes tsx src/scene-visibility/test/annotations-visibility.test.ts
 */
import type { Global } from '../../types';
import {
    createDefaultViewSettings,
    readSessionAnnotationVisible,
    writeContentCategoryVisible,
    writeSessionAnnotationVisible
} from '../../view-settings';

function assertEq<T>(actual: T, expected: T, msg: string): void {
    if (actual !== expected) {
        throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

function makeGlobal(): Global {
    return {
        state: { editMode: false },
        viewSettings: createDefaultViewSettings()
    } as unknown as Global;
}

function testCategoryOnStoresOnlyOff(): void {
    const global = makeGlobal();
    assertEq(readSessionAnnotationVisible(global, 'a'), true, '大类开缺省显示');
    assertEq(writeSessionAnnotationVisible(global, 'a', false), true, '写关');
    assertEq(global.viewSettings?.annotationInstances?.a, false, '只记关');
    assertEq(writeSessionAnnotationVisible(global, 'a', true), true, '写回缺省');
    assertEq(global.viewSettings?.annotationInstances, undefined, '缺省删键');
    console.log('ok 大类开只记关');
}

function testCategoryOffForceOn(): void {
    const global = makeGlobal();
    writeContentCategoryVisible(global, 'annotations', false);
    assertEq(readSessionAnnotationVisible(global, 'a'), false, '大类关缺省隐藏');
    assertEq(writeSessionAnnotationVisible(global, 'a', true), true, '强制开');
    assertEq(global.viewSettings?.annotationInstances?.a, true, '只记开');
    assertEq(readSessionAnnotationVisible(global, 'a'), true, '该条显示');
    assertEq(readSessionAnnotationVisible(global, 'b'), false, '其它仍关');
    assertEq(global.viewSettings?.contentVisibility?.annotations, false, '不改大类勾选');
    console.log('ok 大类关可单独开');
}

function testShowCategoryPrunesForceOn(): void {
    const global = makeGlobal();
    writeContentCategoryVisible(global, 'annotations', false);
    writeSessionAnnotationVisible(global, 'a', true);
    writeContentCategoryVisible(global, 'annotations', true);
    assertEq(global.viewSettings?.annotationInstances?.a, undefined, '再开大类清掉强制开');
    assertEq(readSessionAnnotationVisible(global, 'a'), true, '大类开缺省显示');
    console.log('ok 再开大类 prune 强制开');
}

function main(): void {
    testCategoryOnStoresOnlyOff();
    testCategoryOffForceOn();
    testShowCategoryPrunesForceOn();
    console.log('all annotations-visibility tests passed');
}

main();
