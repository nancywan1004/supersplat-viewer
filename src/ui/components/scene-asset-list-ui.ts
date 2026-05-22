import { applyMediaHotspotAutoplay } from '../../asset-placement-handler';
import type { Global, ScenePlacedItem } from '../../types';
import { pushEditHistory } from '../../edit-history';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';

function isMediaSceneAsset(entry: ScenePlacedItem): boolean {
    return entry.assetType === 'video' || entry.assetType === 'audio';
}

function readSceneAssetHotspotAutoplay(global: Global, entry: ScenePlacedItem): boolean {
    if (entry.hotspotAutoplay === false) return false;
    const sa = global.settings.sceneAssets?.find((a) => a.id === entry.id);
    return sa?.hotspotAutoplay !== false;
}

const EYE_SVG =
    '<svg class="icon-eye" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zM12 17c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5zm0-8c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z"/></svg>';
const EYE_OFF_SVG =
    '<svg class="icon-eye-off" viewBox="0 0 24 24" fill="currentColor" width="18" height="18"><path d="M12 7c2.76 0 5 2.24 5 5 0 .65-.13 1.26-.36 1.83l2.92 2.92c1.51-1.26 2.7-2.89 3.43-4.75-1.73-4.39-6-7.5-11-7.5-1.4 0-2.74.25-3.98.7l2.16 2.16C10.74 7.13 11.35 7 12 7zM2 4.27l2.28 2.28.46.46C3.08 8.3 1.78 10.02 1 12c1.73 4.39 6 7.5 11 7.5 1.55 0 3.03-.3 4.38-.84l.42.42L19.73 22 21 20.73 3.27 3 2 4.27zM7.53 9.8l1.55 1.55c-.05.21-.08.43-.08.65 0 1.66 1.34 3 3 3 .22 0 .44-.03.65-.08l1.55 1.55c-.67.33-1.41.53-2.2.53-2.76 0-5-2.24-5-5 0-.79.2-1.53.53-2.2zm4.31-.78l3.15 3.15.02-.16c0-1.66-1.34-3-3-3l-.17.01z"/></svg>';
const TRASH_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

const SCENE_ASSET_LIST_HTML = `
<div class="asset-panel-section scene-asset-list-section" data-scene-asset-list-root>
    <div class="scene-asset-list-header">场景资产列表</div>
    <ul class="scene-asset-list" id="sceneAssetList"></ul>
</div>
`.trim();

export function getSceneAssetListHTML(): string {
    return SCENE_ASSET_LIST_HTML;
}

function renderSceneAssetList(listEl: HTMLElement, global: Global): void {
    const { state, events } = global;
    const editUiTransport = getEditUiTransport(global);
    const list = state.scenePlacedEntities ?? [];
    const selectedId = state.selectedSceneEntityId ?? null;
    listEl.innerHTML = '';

    list.forEach((entry: ScenePlacedItem) => {
        const isSelected = selectedId !== null && entry.id === selectedId;
        const li = document.createElement('li');
        li.className = 'scene-asset-item' + (isSelected ? ' selected' : '');
        li.dataset.entityId = entry.id;
        const nameSpan = document.createElement('span');
        nameSpan.className = 'scene-asset-name';
        nameSpan.textContent = entry.name;
        const eyeBtn = document.createElement('button');
        eyeBtn.type = 'button';
        eyeBtn.className = 'scene-asset-visibility' + (entry.visible ? '' : ' hidden');
        eyeBtn.innerHTML = EYE_SVG;
        eyeBtn.setAttribute('aria-label', '切换可见性');
        eyeBtn.title = entry.visible ? '隐藏' : '显示';
        const eyeOffBtn = document.createElement('button');
        eyeOffBtn.type = 'button';
        eyeOffBtn.className = 'scene-asset-visibility' + (entry.visible ? ' hidden' : '');
        eyeOffBtn.innerHTML = EYE_OFF_SVG;
        eyeOffBtn.setAttribute('aria-label', '切换可见性');
        eyeOffBtn.title = entry.visible ? '显示' : '隐藏';
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'scene-asset-delete';
        deleteBtn.innerHTML = TRASH_SVG;
        deleteBtn.title = '移除';
        deleteBtn.setAttribute('aria-label', '移除');

        let hotspotAutoplayWrap: HTMLLabelElement | null = null;
        if (isMediaSceneAsset(entry)) {
            hotspotAutoplayWrap = document.createElement('label');
            hotspotAutoplayWrap.className = 'scene-asset-hotspot-autoplay';
            hotspotAutoplayWrap.title = '热区自动播放';
            const hotspotAutoplayCheck = document.createElement('input');
            hotspotAutoplayCheck.type = 'checkbox';
            hotspotAutoplayCheck.checked = readSceneAssetHotspotAutoplay(global, entry);
            hotspotAutoplayCheck.setAttribute('aria-label', '热区自动播放');
            const hotspotAutoplayText = document.createElement('span');
            hotspotAutoplayText.className = 'scene-asset-hotspot-autoplay-label';
            hotspotAutoplayText.textContent = '热区';
            hotspotAutoplayWrap.appendChild(hotspotAutoplayCheck);
            hotspotAutoplayWrap.appendChild(hotspotAutoplayText);
            hotspotAutoplayCheck.addEventListener('click', (e) => e.stopPropagation());
            hotspotAutoplayCheck.addEventListener('change', (e) => {
                e.stopPropagation();
                const value = hotspotAutoplayCheck.checked;
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({
                        type: 'ASSET_MEDIA_HOTSPOT_AUTOPLAY_SET',
                        id: entry.id,
                        value
                    });
                    return;
                }
                if (applyMediaHotspotAutoplay(global, entry.id, value)) {
                    pushEditHistory(global, 'toggle media hotspot autoplay');
                }
            });
        }

        const toggleVisibility = (e: Event) => {
            e.stopPropagation();
            const nextVisible = !entry.visible;
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'ASSET_SHOW_HIDE_SET', id: entry.id, value: nextVisible });
                return;
            }
            entry.visible = nextVisible;
            entry.entity.enabled = nextVisible;
            eyeBtn.classList.toggle('hidden', !entry.visible);
            eyeOffBtn.classList.toggle('hidden', entry.visible);
            eyeBtn.title = entry.visible ? '隐藏' : '显示';
            eyeOffBtn.title = entry.visible ? '显示' : '隐藏';
            pushEditHistory(global, 'toggle asset visibility');
        };

        eyeBtn.addEventListener('click', toggleVisibility);
        eyeOffBtn.addEventListener('click', toggleVisibility);
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'ASSET_DELETE', id: entry.id });
                return;
            }
            entry.entity.destroy();
            const arr = state.scenePlacedEntities!;
            const idx = arr.findIndex((s) => s.id === entry.id);
            if (idx >= 0) {
                arr.splice(idx, 1);
                if (state.selectedSceneEntityId === entry.id) {
                    state.selectedSceneEntityId = null;
                    events.fire('sceneAsset:selected', { source: 'host' });
                }
                events.fire('sceneAssets:removed', entry);
                renderSceneAssetList(listEl, global);
                pushEditHistory(global, 'delete asset');
            }
        });
        li.addEventListener('click', (e) => {
            if (
                (e.target as HTMLElement).closest('.scene-asset-delete')
                || (e.target as HTMLElement).closest('.scene-asset-visibility')
                || (e.target as HTMLElement).closest('.scene-asset-hotspot-autoplay')
            ) {
                return;
            }
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'ASSET_SELECT', id: entry.id });
                return;
            }
            state.selectedSceneEntityId = entry.id;
            events.fire('sceneAsset:selected', { source: 'host' });
            // internal 模式下场景列表点击也应与协议 ASSET_SELECT 对齐，统一触发资产聚焦。
            events.fire('inputEvent', 'frame', { focusTarget: 'asset' as const });
            renderSceneAssetList(listEl, global);
        });

        li.appendChild(nameSpan);
        if (hotspotAutoplayWrap) {
            li.appendChild(hotspotAutoplayWrap);
        }
        li.appendChild(eyeBtn);
        li.appendChild(eyeOffBtn);
        li.appendChild(deleteBtn);
        listEl.appendChild(li);
    });
}

/**
 * 绑定场景资产列表：数据驱动渲染、可见性、删除、选中。
 * @param root 组件根元素（含 data-scene-asset-list-root 的容器）
 * @param global 全局对象
 * @returns 清理函数
 */
export function bindSceneAssetList(root: HTMLElement | null, global: Global): () => void {
    if (!root) return () => {};

    const { state, events } = global;
    const listEl = root.querySelector<HTMLElement>('.scene-asset-list');
    if (!listEl) return () => {};

    if (!state.scenePlacedEntities) state.scenePlacedEntities = [];

    renderSceneAssetList(listEl, global);
    const onSceneListChange = () => renderSceneAssetList(listEl, global);
    events.on('sceneAssets:added', onSceneListChange);
    events.on('sceneAssets:removed', onSceneListChange);
    events.on('sceneAssets:cleared', onSceneListChange);
    events.on('sceneAsset:selected', onSceneListChange);
    events.on('sceneAsset:hotspotAutoplayChanged', onSceneListChange);
    events.on('editLeftModule:changed', onSceneListChange);

    return () => {
        events.off('sceneAssets:added', onSceneListChange);
        events.off('sceneAssets:removed', onSceneListChange);
        events.off('sceneAssets:cleared', onSceneListChange);
        events.off('sceneAsset:selected', onSceneListChange);
        events.off('sceneAsset:hotspotAutoplayChanged', onSceneListChange);
        events.off('editLeftModule:changed', onSceneListChange);
    };
}
