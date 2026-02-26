import type { Global } from '../../types';
import type { AssetLibraryItem, AssetLibraryType } from '../../types';
import { loadGsplatAsset } from '../../loaders/gsplat-asset-loader';

const ASSET_TYPE_ACCEPT: Record<AssetLibraryType, string> = {
    image: '.jpg,.jpeg,.png,image/jpeg,image/png',
    mesh: '.glb,model/gltf-binary',
    gaussian: '.sog,.splat,.ply'
};

const TRASH_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

function renderAssetPreviewGrid(gridEl: HTMLElement, global: Global): void {
    const { state, events, app } = global;
    const list = state.uploadedAssets ?? [];
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
            img.style.width = '100%';
            img.style.height = '100%';
            img.style.objectFit = 'cover';
            img.style.borderRadius = 'inherit';
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
                renderAssetPreviewGrid(gridEl, global);
            }
        });
        slot.appendChild(placeholder);
        slot.appendChild(nameSpan);
        slot.appendChild(deleteBtn);

        // 点击资产格子（不拖拽）暂时不做「待放置」状态，仅用于未来扩展（如弹出属性面板）
        let dragging = false;
        let dragStartX = 0;
        let dragStartY = 0;

        slot.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.asset-preview-delete')) return;
            // 若本次 pointer 序列发生过拖拽，则不当作点击选择
            if (dragging) return;
        });

        // 从资产列表拖拽到画布：pointerdown 开始记录，pointermove 判定为拖拽，pointerup 上报 drop
        slot.addEventListener('pointerdown', (e: PointerEvent) => {
            if (e.button !== 0) return;
            dragging = false;
            dragStartX = e.clientX;
            dragStartY = e.clientY;
            try {
                (e.target as HTMLElement).setPointerCapture(e.pointerId);
            } catch {
                // ignore
            }
        });

        slot.addEventListener('pointermove', (e: PointerEvent) => {
            if (e.buttons === 0) return;
            if (dragStartX === 0 && dragStartY === 0) return;
            const dx = e.clientX - dragStartX;
            const dy = e.clientY - dragStartY;
            if (!dragging && Math.hypot(dx, dy) > 4) {
                dragging = true;
                events.fire('assetDrag:start', item);
            }
        });

        const endDrag = (e: PointerEvent) => {
            try {
                (e.target as HTMLElement).releasePointerCapture(e.pointerId);
            } catch {
                // ignore
            }
            if (dragging) {
                const canvas = app.graphicsDevice?.canvas as HTMLCanvasElement | undefined;
                if (canvas) {
                    const target = document.elementFromPoint(e.clientX, e.clientY);
                    if (target && (target === canvas || canvas.contains(target))) {
                        events.fire('assetPlacement:dropOnCanvas', {
                            item,
                            clientX: e.clientX,
                            clientY: e.clientY
                        });
                    }
                }
                events.fire('assetDrag:end', item);
                e.preventDefault();
                e.stopPropagation();
            }
            dragging = false;
            dragStartX = 0;
            dragStartY = 0;
        };

        slot.addEventListener('pointerup', endDrag);
        slot.addEventListener('pointercancel', endDrag);

        gridEl.appendChild(slot);
    });
}

/**
 * 资产放置设置组件：资产类型选择、上传按钮、资产预览网格。
 * 导出 HTML 模板与 bind 函数，由右侧栏挂载并绑定折叠等交互。
 */
const ASSET_PLACEMENT_SETTINGS_HTML = `
<div class="asset-panel-section" data-asset-placement-root>
    <div class="settingsRow submenuHeader asset-placement-header expanded" id="assetPlacementHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="assetPlacementArrow">▶</span>
        <span>资产放置设置</span>
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
    </div>
</div>
`.trim();

export function getAssetPlacementSettingsHTML(): string {
    return ASSET_PLACEMENT_SETTINGS_HTML;
}

function nextAssetId(): string {
    return `asset-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * 绑定资产放置设置面板的折叠/展开、类型选择、上传等交互。
 * @param root 组件根元素（含 data-asset-placement-root 的容器）
 * @param global 全局对象（用于 app、state、events）
 * @returns 清理函数
 */
export function bindAssetPlacementSettings(root: HTMLElement | null, global: Global): () => void {
    if (!root) return () => {};

    const { app, state, events } = global;
    const header = root.querySelector<HTMLElement>('#assetPlacementHeader');
    const panel = root.querySelector<HTMLElement>('#assetPlacementSubpanel');
    const arrow = root.querySelector<HTMLElement>('#assetPlacementArrow');
    const typeSelect = root.querySelector<HTMLSelectElement>('#assetTypeSelect');
    const uploadBtn = root.querySelector<HTMLButtonElement>('#uploadAssetBtn');
    const fileInput = root.querySelector<HTMLInputElement>('#assetFileInput');
    if (!header || !panel || !arrow || !typeSelect || !uploadBtn || !fileInput) return () => {};

    if (!state.uploadedAssets) state.uploadedAssets = [];

    const gridEl = root.querySelector<HTMLElement>('#assetPreviewGrid');
    let onLibraryChange: (() => void) | null = null;
    if (gridEl) {
        renderAssetPreviewGrid(gridEl, global);
        onLibraryChange = () => renderAssetPreviewGrid(gridEl, global);
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
                    const demoItem: AssetLibraryItem = {
                        id: nextAssetId(),
                        type: 'gaussian',
                        name: 'biker (demo)',
                        filename: 'biker.sog',
                        url: '/assets/gsplat/biker.sog',
                        asset
                    };
                    state.uploadedAssets!.push(demoItem);
                    events.fire('assetLibrary:added', demoItem);
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
    typeSelect.addEventListener('change', updateFileAccept);

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
                events.fire('assetLibrary:added', item);
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
                        events.fire('assetLibrary:added', item);
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
                events.fire('assetLibrary:added', item);
            }
        } catch (err) {
            console.warn('[AssetPlacement] 上传失败:', err);
            events.fire('assetLibrary:error', { id, error: err });
        }
    };

    fileInput.addEventListener('change', handleFileSelect);
    uploadBtn.addEventListener('click', () => fileInput.click());

    const toggle = () => {
        const isHidden = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !isHidden);
        header.classList.toggle('expanded', isHidden);
    };

    const onKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
        }
    };

    header.addEventListener('click', toggle);
    header.addEventListener('keydown', onKey);

    return () => {
        if (gridEl && onLibraryChange) {
            events.off('assetLibrary:added', onLibraryChange);
            events.off('assetLibrary:removed', onLibraryChange);
        }
        typeSelect.removeEventListener('change', updateFileAccept);
        fileInput.removeEventListener('change', handleFileSelect);
        header.removeEventListener('click', toggle);
        header.removeEventListener('keydown', onKey);
    };
}
