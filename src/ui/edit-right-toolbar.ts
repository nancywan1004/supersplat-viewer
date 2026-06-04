import type { Global } from '../types';
import type { EditLeftModule } from '../types';
import { getAssetPlacementSettingsHTML, bindAssetPlacementSettings } from './components/asset-placement-settings-ui';
import { getSceneAssetListHTML, bindSceneAssetList } from './components/scene-asset-list-ui';
import { getCameraSettingsHTML, bindCameraSettings } from './components/camera-settings-ui';
import { getSkyboxSettingsHTML, bindSkyboxSettings } from './components/skybox-settings-ui';

const RIGHT_PANEL_IDS: EditLeftModule[] = [
    'gs',
    'asset',
    'annotation',
    'environment',
    'skybox',
    'camera',
    'effects',
    'assetEffects'
];

/** 右侧栏多面板 HTML：按左侧模块分面板；场景特效 / 物体特效为独立左栏项，各对应独立右侧面板 */
const EDIT_RIGHT_TOOLBAR_HTML = `
<div id="rightPanelGs" class="edit-right-panel hidden" data-module="gs">
    <div class="edit-right-panel-placeholder">敬请期待</div>
</div>
<div id="rightPanelAsset" class="edit-right-panel hidden" data-module="asset">
    ${getAssetPlacementSettingsHTML()}
</div>
<div id="rightPanelAnnotation" class="edit-right-panel hidden" data-module="annotation">
    <div class="annotation-panel-section" data-annotation-settings-root>
        <div class="settingsRow submenuHeader annotation-settings-header expanded" id="annotationSettingsHeader" role="button" tabindex="0">
            <span class="submenuArrow" id="annotationSettingsArrow">▶</span>
            <span>场景标注设置</span>
        </div>
        <div id="annotationSettingsSubpanel" class="subpanel">
            <div id="annotationPanelContainer"></div>
        </div>
    </div>
</div>
<div id="rightPanelEnvironment" class="edit-right-panel hidden" data-module="environment">
    <div class="settingsRow submenuHeader" id="lightingSubmenuHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="lightingSubmenuArrow">▶</span>
        <span>Lighting</span>
    </div>
    <div id="lightingSubpanel" class="subpanel hidden">
        <div id="lightingPanelContainer"></div>
    </div>
    <div class="settingsRow submenuHeader" id="postEffectSubmenuHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="postEffectSubmenuArrow">▶</span>
        <span>postEffect</span>
    </div>
    <div id="postEffectSubpanel" class="subpanel hidden">
        <div id="postEffectPanelContainer"></div>
    </div>
</div>
<div id="rightPanelSkybox" class="edit-right-panel hidden" data-module="skybox">
    ${getSkyboxSettingsHTML()}
</div>
<div id="rightPanelCamera" class="edit-right-panel hidden" data-module="camera">
    ${getCameraSettingsHTML()}
</div>
<div id="rightPanelEffects" class="edit-right-panel hidden" data-module="effects">
    <div class="settingsRow submenuHeader" id="sceneVfxSubmenuHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="sceneVfxSubmenuArrow">▶</span>
        <span>VFX</span>
    </div>
    <div id="sceneVfxSubpanel" class="subpanel hidden">
        <div id="revealPanelContainer"></div>
    </div>
    <div class="settingsRow submenuHeader" id="renderSubmenuHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="renderSubmenuArrow">▶</span>
        <span>Render</span>
    </div>
    <div id="renderSubpanel" class="subpanel hidden">
        <div id="renderPanelContainer"></div>
    </div>
</div>
<div id="rightPanelAssetEffects" class="edit-right-panel hidden" data-module="assetEffects">
    ${getSceneAssetListHTML()}
    <div id="assetEffectsPanelContainer"></div>
</div>
`.trim();

const PANEL_ID_BY_MODULE: Record<EditLeftModule, string> = {
    gs: 'rightPanelGs',
    asset: 'rightPanelAsset',
    annotation: 'rightPanelAnnotation',
    environment: 'rightPanelEnvironment',
    skybox: 'rightPanelSkybox',
    camera: 'rightPanelCamera',
    effects: 'rightPanelEffects',
    assetEffects: 'rightPanelAssetEffects'
};

/** 各模块的 subpanel 对 (headerId, panelId)，切换模块时展开 */
const SUBPANEL_PAIRS_BY_MODULE: Partial<Record<EditLeftModule, [string, string][]>> = {
    environment: [
        ['lightingSubmenuHeader', 'lightingSubpanel'],
        ['postEffectSubmenuHeader', 'postEffectSubpanel']
    ],
    effects: [
        ['sceneVfxSubmenuHeader', 'sceneVfxSubpanel'],
        ['renderSubmenuHeader', 'renderSubpanel']
    ],
    asset: [['assetPlacementHeader', 'assetPlacementSubpanel']],
    annotation: [['annotationSettingsHeader', 'annotationSettingsSubpanel']],
    camera: [['cameraSettingsHeader', 'cameraSettingsSubpanel']],
    skybox: [['skyboxSettingsHeader', 'skyboxSettingsSubpanel']]
};

/**
 * 初始化右侧编辑工具栏 UI（保存按钮 + 多模块面板）。
 * 根据 state.editLeftModule 只显示对应面板；场景特效与物体特效为独立模块，各对应独立右侧面板。
 * 挂载到 #rightToolBarInner，清空后注入多面板结构，保证 #lightingPanelContainer 等 id 存在供子组件挂载。
 * @returns 清理函数
 */
export function initEditRightToolbarUI(global: Global): () => void {
    const { state, events } = global;

    const outer = document.getElementById('rightToolBar');
    let container = document.getElementById('rightToolBarInner');
    if (!container && outer) {
        container = document.createElement('div');
        container.id = 'rightToolBarInner';
        container.className = 'right-tool-bar-inner';
        outer.appendChild(container);
    }
    if (!container) return () => {};

    container.innerHTML = EDIT_RIGHT_TOOLBAR_HTML;

    const current = (): EditLeftModule | null => (state.editLeftModule ?? null);

    const expandSubpanelsForModule = (moduleId: EditLeftModule) => {
        const pairs = SUBPANEL_PAIRS_BY_MODULE[moduleId];
        if (!pairs) return;
        pairs.forEach(([headerId, panelId]) => {
            const header = document.getElementById(headerId);
            const panel = document.getElementById(panelId);
            if (header && panel) {
                panel.classList.remove('hidden');
                header.classList.add('expanded');
            }
        });
    };

    const showPanel = (moduleId: EditLeftModule | null) => {
        RIGHT_PANEL_IDS.forEach((id) => {
            const panel = document.getElementById(PANEL_ID_BY_MODULE[id]);
            if (!panel) return;
            if (moduleId == null) {
                panel.classList.add('hidden');
                return;
            }
            panel.classList.toggle('hidden', id !== moduleId);
        });
        if (moduleId != null) {
            expandSubpanelsForModule(moduleId);
        }
    };

    showPanel(current());

    const onEditLeftModuleChanged = (_id: EditLeftModule | null) => {
        showPanel(current());
    };
    events.on('editLeftModule:changed', onEditLeftModuleChanged);

    // 保存配置按钮已移至顶栏（ui.ts 绑定）

    // 子面板折叠
    const toggleSubpanel = (headerId: string, panelId: string, arrowId: string) => {
        const header = document.getElementById(headerId);
        const panel = document.getElementById(panelId);
        const arrow = document.getElementById(arrowId);
        if (!header || !panel || !arrow) return;
        const isHidden = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !isHidden);
        header.classList.toggle('expanded', isHidden);
    };

    const bindSubpanel = (headerId: string, panelId: string, arrowId: string) => {
        const header = document.getElementById(headerId);
        if (!header) return;
        const handler = () => toggleSubpanel(headerId, panelId, arrowId);
        const keyHandler = (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                toggleSubpanel(headerId, panelId, arrowId);
            }
        };
        header.addEventListener('click', handler);
        header.addEventListener('keydown', keyHandler);
        return () => {
            header.removeEventListener('click', handler);
            header.removeEventListener('keydown', keyHandler);
        };
    };

    const unbindSubpanels = [
        bindSubpanel('lightingSubmenuHeader', 'lightingSubpanel', 'lightingSubmenuArrow'),
        bindSubpanel('postEffectSubmenuHeader', 'postEffectSubpanel', 'postEffectSubmenuArrow'),
        bindSubpanel('sceneVfxSubmenuHeader', 'sceneVfxSubpanel', 'sceneVfxSubmenuArrow'),
        bindSubpanel('renderSubmenuHeader', 'renderSubpanel', 'renderSubmenuArrow'),
        bindSubpanel('annotationSettingsHeader', 'annotationSettingsSubpanel', 'annotationSettingsArrow'),
        bindSubpanel('assetPlacementHeader', 'assetPlacementSubpanel', 'assetPlacementArrow'),
        bindSubpanel('cameraSettingsHeader', 'cameraSettingsSubpanel', 'cameraSettingsArrow'),
        bindSubpanel('skyboxSettingsHeader', 'skyboxSettingsSubpanel', 'skyboxSettingsArrow')
    ];

    // 资产放置模块：HTML 与 bind 均由 asset-placement-settings-ui 内部管理（含场景资产列表）
    const assetPanel = document.getElementById('rightPanelAsset');
    if (assetPanel) {
        const placementRoot = assetPanel.querySelector<HTMLElement>('[data-asset-placement-root]');
        unbindSubpanels.push(bindAssetPlacementSettings(placementRoot, global));
    }

    // 物体特效模块：场景资产列表（选 targetId）+ 物体 VFX 面板
    const assetEffectsPanel = document.getElementById('rightPanelAssetEffects');
    if (assetEffectsPanel) {
        const listRoot = assetEffectsPanel.querySelector<HTMLElement>('[data-scene-asset-list-root]');
        unbindSubpanels.push(bindSceneAssetList(listRoot, global));
    }

    const cameraPanel = document.getElementById('rightPanelCamera');
    if (cameraPanel) {
        const cameraRoot = cameraPanel.querySelector<HTMLElement>('[data-camera-settings-root]');
        unbindSubpanels.push(bindCameraSettings(cameraRoot, global));
    }

    const skyboxPanel = document.getElementById('rightPanelSkybox');
    if (skyboxPanel) {
        const skyboxRoot = skyboxPanel.querySelector<HTMLElement>('[data-skybox-settings-root]');
        unbindSubpanels.push(bindSkyboxSettings(skyboxRoot, global));
    }

    return () => {
        events.off('editLeftModule:changed', onEditLeftModuleChanged);
        unbindSubpanels.forEach((fn) => fn());
        container!.innerHTML = '';
    };
}
