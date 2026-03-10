import type { Global } from '../../types';
import type { AssetLibraryItem, AssetLibraryType } from '../../types';
import { loadGsplatAsset } from '../../loaders/gsplat-asset-loader';
import { getSceneAssetListHTML, bindSceneAssetList } from './scene-asset-list-ui';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';

const ASSET_TYPE_ACCEPT: Record<AssetLibraryType, string> = {
    image: '.jpg,.jpeg,.png,image/jpeg,image/png',
    mesh: '.glb,model/gltf-binary',
    gaussian: '.sog,.splat,.ply'
};

const TRASH_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

function renderAssetPreviewGrid(
    gridEl: HTMLElement,
    global: Global,
    typeSelect: HTMLSelectElement | null
): void {
    const { state, events, app } = global;
    const editUiTransport = getEditUiTransport(global);
    const currentType = (typeSelect?.value ?? 'mesh') as AssetLibraryType;
    const list = (state.uploadedAssets ?? []).filter((item) => item.type === currentType);
    gridEl.innerHTML = '';

    list.forEach((item) => {
        const slot = document.createElement('div');
        slot.className = 'asset-preview-slot';
        slot.dataset.assetId = item.id;
        const placeholder = document.createElement('div');
        placeholder.className = 'asset-preview-placeholder';
        if (item.thumbnailUrl) {
            const img = document.createElement('img');
            img.src = item.thumbnailUrl;
            img.alt = '';
            img.draggable = false;
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.borderRadius = 'inherit';
            img.style.pointerEvents = 'none';
            placeholder.appendChild(img);
        }
        const nameSpan = document.createElement('span');
        nameSpan.className = 'asset-preview-name';
        nameSpan.textContent = item.name;
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'asset-preview-delete';
        deleteBtn.innerHTML = TRASH_SVG;
        deleteBtn.title = '移除';
        deleteBtn.setAttribute('aria-label', '移除');
        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const arr = state.uploadedAssets!;
            const idx = arr.findIndex((a) => a.id === item.id);
            if (idx >= 0) {
                if (item.type === 'image' && item.url) URL.revokeObjectURL(item.url);
                arr.splice(idx, 1);
                events.fire('assetLibrary:removed', item);
                renderAssetPreviewGrid(gridEl, global, typeSelect);
            }
        });
        slot.appendChild(placeholder);
        slot.appendChild(nameSpan);
        slot.appendChild(deleteBtn);

        // 点击资产格子：直接在相机前方放置（与 ASSET_PLACE 协议一致，不再拖拽到画布）
        slot.addEventListener('dragstart', (e) => e.preventDefault());
        slot.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.asset-preview-delete')) return;
            if (editUiTransport === 'message-bridge') {
                // 通过协议只下发可结构化克隆的最小信息（id）；实际 Asset 对象由 message-bridge 在 state.uploadedAssets 中查找
                sendEditProtocolMessage({ type: 'ASSET_PLACE', value: { id: item.id } });
            } else {
                events.fire('assetPlacement:place', { value: item });
            }
        });

        gridEl.appendChild(slot);
    });
}

/**
 * 资产放置设置组件：资产类型选择、上传按钮、资产预览网格、场景资产列表。
 * 场景资产列表嵌套在 subpanel 内，与资产放置设置一起折叠。
 */
export function getAssetPlacementSettingsHTML(): string {
    return `
<div class="asset-panel-section" data-asset-placement-root>
    <div class="settingsRow submenuHeader asset-placement-header expanded" id="assetPlacementHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="assetPlacementArrow">▶</span>
        <span>资产放置</span>
    </div>
    <div id="assetPlacementSubpanel" class="subpanel">
        <div class="asset-type-row">
            <select id="assetTypeSelect" class="settingsSelect" aria-label="资产类型">
                <option value="image">image (JPG/PNG)</option>
                <option value="mesh" selected>mesh (.glb)</option>
                <option value="gaussian">gaussian (.sog/.splat/.ply)</option>
            </select>
            <button type="button" id="uploadAssetBtn" class="settingsButton">上传资产</button>
        </div>
        <input type="file" id="assetFileInput" class="hidden" accept="" tabindex="-1" aria-hidden="true" />
        <div class="asset-preview-grid" id="assetPreviewGrid">
        </div>
        ${getSceneAssetListHTML()}
    </div>
</div>
`.trim();
}

function nextAssetId(): string {
    return `asset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 绑定资产放置设置面板的类型选择、上传、网格渲染、场景资产列表等交互。
 * 折叠/展开由 edit-right-toolbar 的 bindSubpanel 统一处理。
 * @param root 组件根元素（含 data-asset-placement-root 的容器，内含 data-scene-asset-list-root）
 * @param global 全局对象（用于 app、state、events）
 * @returns 清理函数
 */
export function bindAssetPlacementSettings(root: HTMLElement | null, global: Global): () => void {
    if (!root) return () => {};

    const listRoot = root.querySelector<HTMLElement>('[data-scene-asset-list-root]');
    const unbindList = bindSceneAssetList(listRoot, global);

    const { app, state, events } = global;
    const typeSelect = root.querySelector<HTMLSelectElement>('#assetTypeSelect');
    const uploadBtn = root.querySelector<HTMLButtonElement>('#uploadAssetBtn');
    const fileInput = root.querySelector<HTMLInputElement>('#assetFileInput');
    if (!typeSelect || !uploadBtn || !fileInput) return () => {};

    if (!state.uploadedAssets) state.uploadedAssets = [];

    const gridEl = root.querySelector<HTMLElement>('#assetPreviewGrid');
    let onLibraryChange: (() => void) | null = null;
    if (gridEl) {
        renderAssetPreviewGrid(gridEl, global, typeSelect);
        onLibraryChange = () => renderAssetPreviewGrid(gridEl, global, typeSelect);
        events.on('assetLibrary:added', onLibraryChange);
        events.on('assetLibrary:removed', onLibraryChange);

        // 如果当前还没有任何上传资产，初始化一个本地示例资产（/assets/gsplat/biker.sog）
        if (state.uploadedAssets.length === 0) {
            (async () => {
                try {
                    const asset = await loadGsplatAsset(app, {
                        url: '/assets/gsplat/biker.sog',
                        filename: 'biker.sog'
                    } as any);
                    const gaussianDemoItem: AssetLibraryItem = {
                        id: nextAssetId(),
                        type: 'gaussian',
                        name: 'biker (demo)',
                        filename: 'biker.sog',
                        url: '/assets/gsplat/biker.sog',
                        asset
                    };
                    state.uploadedAssets!.push(gaussianDemoItem);
                    events.fire('assetLibrary:added', [gaussianDemoItem]);
                } catch (err) {
                    console.warn('[AssetPlacement] 初始化示例资产失败:', err);
                }
            })();
        }
    }

    const updateFileAccept = () => {
        const type = (typeSelect.value || 'mesh') as AssetLibraryType;
        fileInput.accept = ASSET_TYPE_ACCEPT[type] ?? ASSET_TYPE_ACCEPT.mesh;
    };
    updateFileAccept();
    const typeSelectHandler = () => {
        updateFileAccept();
        if (gridEl) renderAssetPreviewGrid(gridEl, global, typeSelect);
    };
    typeSelect.addEventListener('change', typeSelectHandler);

    const handleFileSelect = async (e: Event) => {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        const type = (typeSelect.value || 'mesh') as AssetLibraryType;
        const name = file.name || '未命名';
        const id = nextAssetId();

        try {
            if (type === 'image') {
                const url = URL.createObjectURL(file);
                const item: AssetLibraryItem = {
                    id,
                    type: 'image',
                    name,
                    filename: file.name,
                    url,
                    file,
                    thumbnailUrl: url
                };
                state.uploadedAssets!.push(item);
                events.fire('assetLibrary:added', [item]);
                return;
            }
            if (type === 'mesh') {
                const url = URL.createObjectURL(file);
                await new Promise<void>((resolve, reject) => {
                    (app.assets as any).loadFromUrl(url, 'container', (err: Error | null, asset: any) => {
                        URL.revokeObjectURL(url);
                        if (err) {
                            reject(err);
                            return;
                        }
                        if (!asset?.resource?.instantiateRenderEntity) {
                            reject(new Error('container has no instantiateRenderEntity'));
                            return;
                        }
                        const item: AssetLibraryItem = {
                            id,
                            type: 'mesh',
                            name,
                            filename: file.name,
                            url,
                            asset
                        };
                        state.uploadedAssets!.push(item);
                        events.fire('assetLibrary:added', [item]);
                        resolve();
                    });
                });
                return;
            }
            if (type === 'gaussian') {
                const assetSource = { filename: file.name, contents: file };
                const asset = await loadGsplatAsset(app, assetSource);
                const item: AssetLibraryItem = {
                    id,
                    type: 'gaussian',
                    name,
                    filename: file.name,
                    asset
                };
                state.uploadedAssets!.push(item);
                events.fire('assetLibrary:added', [item]);
            }
        } catch (err) {
            console.warn('[AssetPlacement] 上传失败:', err);
            events.fire('assetLibrary:error', { id, error: err });
        }
    };

    fileInput.addEventListener('change', handleFileSelect);
    uploadBtn.addEventListener('click', () => fileInput.click());

    return () => {
        unbindList();
        if (gridEl && onLibraryChange) {
            events.off('assetLibrary:added', onLibraryChange);
            events.off('assetLibrary:removed', onLibraryChange);
        }
        typeSelect.removeEventListener('change', typeSelectHandler);
        fileInput.removeEventListener('change', handleFileSelect);
    };
}
