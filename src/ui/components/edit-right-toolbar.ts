import type { Global } from '../../types';
import type { EditLeftModule } from '../../types';
import { getAssetPlacementSettingsHTML, bindAssetPlacementSettings } from './asset-placement-settings-ui';
import { getSceneAssetListHTML, bindSceneAssetList } from './scene-asset-list-ui';

const RIGHT_PANEL_IDS: EditLeftModule[] = ['gs', 'asset', 'annotation', 'environment', 'camera', 'effects'];

/** 右侧栏多面板 HTML：按左侧模块分面板，环境设置含 Lighting/PostEffect，场景特效含 VFX/Render（保存按钮在顶栏） */
const EDIT_RIGHT_TOOLBAR_HTML = `
<div id="rightPanelGs" class="edit-right-panel hidden" data-module="gs">
    <div class="edit-right-panel-placeholder">敬请期待</div>
</div>
<div id="rightPanelAsset" class="edit-right-panel hidden" data-module="asset">
    ${getAssetPlacementSettingsHTML()}
    ${getSceneAssetListHTML()}
</div>
<div id="rightPanelAnnotation" class="edit-right-panel hidden" data-module="annotation">
    <div class="edit-right-panel-placeholder">敬请期待</div>
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
<div id="rightPanelCamera" class="edit-right-panel hidden" data-module="camera">
    <div class="edit-right-panel-placeholder">敬请期待</div>
</div>
<div id="rightPanelEffects" class="edit-right-panel hidden" data-module="effects">
    <div class="settingsRow submenuHeader" id="vfxSubmenuHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="vfxSubmenuArrow">▶</span>
        <span>VFX</span>
    </div>
    <div id="vfxSubpanel" class="subpanel hidden">
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
`.trim();

const PANEL_ID_BY_MODULE: Record<EditLeftModule, string> = {
    gs: 'rightPanelGs',
    asset: 'rightPanelAsset',
    annotation: 'rightPanelAnnotation',
    environment: 'rightPanelEnvironment',
    camera: 'rightPanelCamera',
    effects: 'rightPanelEffects'
};

/**
 * 初始化右侧编辑工具栏 UI（保存按钮 + 多模块面板）。
 * 根据 state.editLeftModule 只显示对应面板；环境设置含 Lighting+PostEffect，场景特效含 VFX+Render。
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

    const showPanel = (moduleId: EditLeftModule | null) => {
        RIGHT_PANEL_IDS.forEach((id) => {
            const panel = document.getElementById(PANEL_ID_BY_MODULE[id]);
            if (panel) {
                if (moduleId == null) {
                    panel.classList.add('hidden');
                } else {
                    panel.classList.toggle('hidden', id !== moduleId);
                }
            }
        });
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
        bindSubpanel('vfxSubmenuHeader', 'vfxSubpanel', 'vfxSubmenuArrow'),
        bindSubpanel('renderSubmenuHeader', 'renderSubpanel', 'renderSubmenuArrow')
    ];

    // 资产放置模块：独立组件的 bind（折叠 + 场景列表可见性）
    const assetPanel = document.getElementById('rightPanelAsset');
    if (assetPanel) {
        const placementRoot = assetPanel.querySelector<HTMLElement>('[data-asset-placement-root]');
        const listRoot = assetPanel.querySelector<HTMLElement>('[data-scene-asset-list-root]');
        unbindSubpanels.push(bindAssetPlacementSettings(placementRoot, global));
        unbindSubpanels.push(bindSceneAssetList(listRoot, global));
    }

    return () => {
        events.off('editLeftModule:changed', onEditLeftModuleChanged);
        unbindSubpanels.forEach((fn) => fn());
        container!.innerHTML = '';
    };
}
