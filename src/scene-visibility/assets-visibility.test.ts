/**
 * 资产大类扫描 vs 单条 ASSET_SHOW_HIDE overlay 自检。
 *
 *   npx --yes tsx src/scene-visibility/assets-visibility.test.ts
 */
import type { Global } from '../types';
import { createDefaultViewSettings, writeContentCategoryVisible } from '../view-settings';
import { applyAssetsVisibility, applyViewerAssetShowHide } from './assets-visibility-facade';

function assertEq<T>(actual: T, expected: T, msg: string): void {
    if (actual !== expected) {
        throw new Error(`${msg}: expected ${String(expected)}, got ${String(actual)}`);
    }
}

type MockEntity = { name: string; enabled: boolean };

function makeGlobal(): { global: Global; root: MockEntity; assetA: MockEntity; assetB: MockEntity } {
    const assetA: MockEntity = { name: 'asset_a', enabled: true };
    const assetB: MockEntity = { name: 'asset_b', enabled: true };
    const root: MockEntity = { name: 'placedAssets', enabled: true };
    const vs = createDefaultViewSettings();
    const global = {
        state: {
            editMode: false,
            scenePlacedEntities: [
                { id: 'a', name: 'a', visible: true, entity: assetA, assetType: 'model' },
                { id: 'b', name: 'b', visible: true, entity: assetB, assetType: 'model' }
            ]
        },
        settings: {
            sceneAssets: [
                { id: 'a', visible: true },
                { id: 'b', visible: true }
            ]
        },
        viewSettings: vs,
        events: { fire: () => undefined },
        app: {
            root: {
                findByName: (name: string) => (name === 'placedAssets' ? root : null)
            }
        }
    } as unknown as Global;
    return { global, root, assetA, assetB };
}

function testCategoryHideDoesNotWriteEntryVisible(): void {
    const { global, root, assetA, assetB } = makeGlobal();
    writeContentCategoryVisible(global, 'assets', false);
    applyAssetsVisibility(global, true);
    assertEq(root.enabled, false, '大类 hide 关根节点');
    assertEq(assetA.enabled, false, '扫描关 a');
    assertEq(assetB.enabled, false, '扫描关 b');
    const items = global.state.scenePlacedEntities as Array<{ visible: boolean }>;
    assertEq(items[0].visible, true, '不写 entry.visible');
    assertEq(items[1].visible, true, '不写 entry.visible b');
    console.log('ok category hide 扫描不写 entry.visible');
}

function testShowOneWhileCategoryHidden(): void {
    const { global, root, assetA, assetB } = makeGlobal();
    writeContentCategoryVisible(global, 'assets', false);
    applyAssetsVisibility(global, true);
    applyViewerAssetShowHide(global, 'a', true);
    assertEq(global.viewSettings?.assetInstances?.a, true, '记强制开');
    assertEq(root.enabled, true, '根节点打开');
    assertEq(assetA.enabled, true, '该资产显示');
    assertEq(assetB.enabled, false, '其它仍关');
    assertEq(
        (global.state.scenePlacedEntities as Array<{ visible: boolean }>)[0].visible,
        true,
        'Viewer 不改 entry.visible'
    );
    assertEq(global.viewSettings?.contentVisibility?.assets, false, '不改大类勾选');
    console.log('ok 大类关后再 SHOW_HIDE 一盏');
}

function testReapplyKeepsForceOn(): void {
    const { global, root, assetA, assetB } = makeGlobal();
    writeContentCategoryVisible(global, 'assets', false);
    applyAssetsVisibility(global, true);
    applyViewerAssetShowHide(global, 'a', true);
    applyAssetsVisibility(global, true);
    assertEq(root.enabled, true, 'reapply 根节点仍开');
    assertEq(assetA.enabled, true, 'reapply 仍显示强制开');
    assertEq(assetB.enabled, false, 'reapply 其它仍关');
    console.log('ok reapply 保留强制开');
}

function main(): void {
    testCategoryHideDoesNotWriteEntryVisible();
    testShowOneWhileCategoryHidden();
    testReapplyKeepsForceOn();
    console.log('all assets-visibility tests passed');
}

main();
