import { applyMediaHotspotAutoplay, applyVideoHorizontalCurvature } from '../../asset-placement-handler';
import { getSceneAssetListHTML, bindSceneAssetList } from './scene-asset-list-ui';
import { loadGsplatAsset } from '../../loaders/gsplat-asset-loader';
import { clampVideoHorizontalCurvature, VIDEO_HORIZONTAL_MAX_ARC_DEG } from '../../scene-assets/media/curved-billboard-mesh';
import type { ExperienceSettings, SceneMediaHotspotSettings } from '../../schemas/v2';
import {
    applySceneMediaHotspotBaselineFromView,
    ensureSceneMediaHotspot,
    patchSceneMediaHotspot
} from '../../settings-serialize/settings-serialize-helper';
import { getSelectedSceneAssetType } from '../../state-selectors';
import type { Global, AssetLibraryItem, AssetLibraryType } from '../../types';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';

/** 仅 image / mesh / gaussian 走本地上传；video / audio 仅支持 URL 添加 */
const ASSET_FILE_UPLOAD_ACCEPT: Partial<Record<AssetLibraryType, string>> = {
    image: '.jpg,.jpeg,.png,image/jpeg,image/png',
    mesh: '.glb,model/gltf-binary',
    gaussian: '.sog,.splat,.ply'
};

function isVideoOrAudioAssetType(t: AssetLibraryType): boolean {
    return t === 'video' || t === 'audio';
}

// 危险协议前缀（拆开写避免 no-script-url 误报字面量）
const DANGEROUS_URL_PROTOCOL = `${'java'}${'script'}:`;

/**
 * 解析为可加载的绝对 URL；拒绝 blob、脚本协议等。
 * @param raw - 用户输入的 URL 或相对路径
 * @returns 规范化后的 href，或无法解析/不允许时 `null`
 */
function resolveRemoteMediaUrl(raw: string): string | null {
    const s = raw.trim();
    if (!s) return null;
    let u: URL;
    try {
        u = new URL(s, window.location.href);
    } catch {
        return null;
    }
    const proto = u.protocol.toLowerCase();
    if (proto === 'blob:' || proto === DANGEROUS_URL_PROTOCOL) return null;
    return u.href;
}

/**
 * @param href - 已解析的绝对 URL
 * @returns 用于列表展示的短名称（路径末段或 hostname）
 */
function displayNameFromMediaUrl(href: string): string {
    try {
        const u = new URL(href);
        const parts = u.pathname.split('/').filter(Boolean);
        const last = parts.pop();
        if (last) return decodeURIComponent(last);
        return u.hostname || href;
    } catch {
        return href;
    }
}

const TRASH_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" width="14" height="14"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>';

function renderAssetPreviewGrid(
    gridEl: HTMLElement,
    global: Global,
    typeSelect: HTMLSelectElement | null
): void {
    const { state, events } = global;
    const editUiTransport = getEditUiTransport(global);
    const currentType = (typeSelect?.value ?? 'mesh') as AssetLibraryType;
    const list = (state.uploadedAssets ?? []).filter(item => item.type === currentType);
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
            const idx = arr.findIndex(a => a.id === item.id);
            if (idx >= 0) {
                if ((item.type === 'image' || item.type === 'video' || item.type === 'audio') && item.url?.startsWith('blob:')) {
                    URL.revokeObjectURL(item.url);
                }
                arr.splice(idx, 1);
                events.fire('assetLibrary:removed', item);
                renderAssetPreviewGrid(gridEl, global, typeSelect);
            }
        });
        slot.appendChild(placeholder);
        slot.appendChild(nameSpan);
        slot.appendChild(deleteBtn);

        // 点击资产格子：进入一次性放置态，随后在画布点击一次完成放置
        slot.addEventListener('dragstart', e => e.preventDefault());
        slot.addEventListener('click', (e) => {
            if ((e.target as HTMLElement).closest('.asset-preview-delete')) return;
            if (editUiTransport !== 'message-bridge') {
                events.fire('assetPlacement:start', { value: item });
                return;
            }
            // 通过协议只下发可结构化克隆的最小信息（id）；实际 Asset 对象由 message-bridge 在 state.uploadedAssets 中查找
            sendEditProtocolMessage({ type: 'ASSET_PLACE', value: { id: item.id } });
        });

        gridEl.appendChild(slot);
    });
}

/**
 * 资产放置设置组件：资产类型选择、本地上传（图/mesh/gsplat）或 URL 添加（音视频）、预览网格、场景资产列表。
 * 场景资产列表嵌套在 subpanel 内，与资产放置设置一起折叠。
 * @returns 组件根 HTML 字符串
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
                <option value="video">video (URL)</option>
                <option value="audio">audio (URL)</option>
            </select>
            <button type="button" id="uploadAssetBtn" class="settingsButton">上传资产</button>
        </div>
        <div id="assetMediaUrlRow" class="asset-media-url-row hidden">
            <input type="text" id="assetMediaUrl" class="settingsSelect asset-media-url-input" placeholder="https://… 或 /path/to/file.mp4" autocomplete="off" aria-label="音视频媒体 URL" />
            <button type="button" id="addMediaUrlBtn" class="settingsButton">添加</button>
        </div>
        <input type="file" id="assetFileInput" class="hidden" accept="" tabindex="-1" aria-hidden="true" />
        <div class="asset-preview-grid" id="assetPreviewGrid">
        </div>
        <div class="media-hotspot-panel" id="mediaHotspotPanel">
            <div class="settingsRow submenuHeader expanded" style="margin-top:6px;">音视频热区</div>
            <div class="settingsRow">
                <label for="mhVideoDist">视频触发距离 (m)</label>
                <input type="range" id="mhVideoDist" min="1" max="80" step="0.5" />
                <span id="mhVideoDistVal" class="settingsValueLabel"></span>
            </div>
            <div class="settingsRow">
                <label for="mhAudioDist">音频触发距离 (m)</label>
                <input type="range" id="mhAudioDist" min="1" max="80" step="0.5" />
                <span id="mhAudioDistVal" class="settingsValueLabel"></span>
            </div>
            <div class="settingsRow">
                <label for="mhCone" title="半角；总张角约为 2× 该值（如 60°≈120° 视锥）">视锥半角 (°)</label>
                <input type="range" id="mhCone" min="15" max="85" step="1" />
                <span id="mhConeVal" class="settingsValueLabel"></span>
            </div>
            <div class="settingsRow">
                <button type="button" id="mhBaselineBtn" class="settingsButton">从当前视角设基准距离</button>
            </div>
        </div>
        <div class="video-curvature-panel hidden" id="videoCurvaturePanel">
            <div class="settingsRow submenuHeader" style="margin-top:6px;">视频曲度</div>
            <div class="settingsRow">
                <label for="videoCurvature">横向曲度</label>
                <input type="range" id="videoCurvature" min="0" max="100" step="1" />
                <span id="videoCurvatureVal" class="settingsValueLabel"></span>
            </div>
        </div>
        <div class="media-autoplay-panel hidden" id="mediaAutoplayPanel">
            <div class="settingsRow submenuHeader" style="margin-top:6px;">媒体播控</div>
            <div class="settingsRow">
                <label for="mediaHotspotAutoplayCheck">热区自动播放</label>
                <input type="checkbox" id="mediaHotspotAutoplayCheck" />
            </div>
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
 * 绑定资产放置设置面板的类型选择、本地上传或 URL 添加、网格渲染、场景资产列表等交互。
 * 折叠/展开由 edit-right-toolbar 的 bindSubpanel 统一处理。
 * @param {HTMLElement | null} root - 组件根元素（含 data-asset-placement-root 的容器，内含 data-scene-asset-list-root）
 * @param {Global} global - 全局对象（用于 app、state、events）
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
    const mediaUrlRow = root.querySelector<HTMLElement>('#assetMediaUrlRow');
    const mediaUrlInput = root.querySelector<HTMLInputElement>('#assetMediaUrl');
    const addMediaUrlBtn = root.querySelector<HTMLButtonElement>('#addMediaUrlBtn');
    if (!typeSelect || !uploadBtn || !fileInput || !mediaUrlRow || !mediaUrlInput || !addMediaUrlBtn) return () => {};

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
        fileInput.accept = ASSET_FILE_UPLOAD_ACCEPT[type] ?? ASSET_FILE_UPLOAD_ACCEPT.mesh ?? '';
    };

    const syncAssetTypeControls = () => {
        updateFileAccept();
        const type = (typeSelect.value || 'mesh') as AssetLibraryType;
        const media = isVideoOrAudioAssetType(type);
        uploadBtn.classList.toggle('hidden', media);
        mediaUrlRow.classList.toggle('hidden', !media);
    };
    syncAssetTypeControls();

    const typeSelectHandler = () => {
        syncAssetTypeControls();
        if (gridEl) renderAssetPreviewGrid(gridEl, global, typeSelect);
    };
    typeSelect.addEventListener('change', typeSelectHandler);

    const handleFileSelect = async (e: Event) => {
        const input = e.target as HTMLInputElement;
        const file = input.files?.[0];
        input.value = '';
        if (!file) return;
        const type = (typeSelect.value || 'mesh') as AssetLibraryType;
        if (isVideoOrAudioAssetType(type)) return;
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
    uploadBtn.addEventListener('click', () => {
        const t = (typeSelect.value || 'mesh') as AssetLibraryType;
        if (isVideoOrAudioAssetType(t)) return;
        fileInput.click();
    });

    const addMediaFromUrl = () => {
        const type = (typeSelect.value || 'mesh') as AssetLibraryType;
        if (!isVideoOrAudioAssetType(type)) return;
        const url = resolveRemoteMediaUrl(mediaUrlInput.value);
        if (!url) {
            console.warn('[AssetPlacement] 无效的媒体 URL（需为 http(s)、相对路径等，不支持 blob）');
            return;
        }
        const id = nextAssetId();
        const name = displayNameFromMediaUrl(url);
        const item: AssetLibraryItem = {
            id,
            type,
            name,
            filename: name,
            url
        };
        state.uploadedAssets!.push(item);
        events.fire('assetLibrary:added', [item]);
        mediaUrlInput.value = '';
    };
    addMediaUrlBtn.addEventListener('click', addMediaFromUrl);
    const onMediaUrlKeydown = (e: KeyboardEvent) => {
        if (e.key === 'Enter') {
            e.preventDefault();
            addMediaFromUrl();
        }
    };
    mediaUrlInput.addEventListener('keydown', onMediaUrlKeydown);

    const mhVideoDist = root.querySelector<HTMLInputElement>('#mhVideoDist');
    const mhAudioDist = root.querySelector<HTMLInputElement>('#mhAudioDist');
    const mhCone = root.querySelector<HTMLInputElement>('#mhCone');
    const mhBaselineBtn = root.querySelector<HTMLButtonElement>('#mhBaselineBtn');
    const mhVideoDistVal = root.querySelector<HTMLSpanElement>('#mhVideoDistVal');
    const mhAudioDistVal = root.querySelector<HTMLSpanElement>('#mhAudioDistVal');
    const mhConeVal = root.querySelector<HTMLSpanElement>('#mhConeVal');

    const editUiTransport = getEditUiTransport(global);

    const syncHotspotUi = () => {
        const sm = ensureSceneMediaHotspot(global.settings as ExperienceSettings);
        if (mhVideoDist) mhVideoDist.value = String(sm.videoTriggerDistanceM);
        if (mhAudioDist) mhAudioDist.value = String(sm.audioTriggerDistanceM);
        if (mhCone) mhCone.value = String(sm.coneHalfDeg);
        if (mhVideoDistVal) mhVideoDistVal.textContent = `${sm.videoTriggerDistanceM.toFixed(1)} m`;
        if (mhAudioDistVal) mhAudioDistVal.textContent = `${sm.audioTriggerDistanceM.toFixed(1)} m`;
        if (mhConeVal) mhConeVal.textContent = `${sm.coneHalfDeg}°`;
    };

    const buildHotspotPatch = (): Partial<SceneMediaHotspotSettings> => ({
        videoTriggerDistanceM: mhVideoDist ? Number(mhVideoDist.value) : undefined,
        audioTriggerDistanceM: mhAudioDist ? Number(mhAudioDist.value) : undefined,
        coneHalfDeg: mhCone ? Number(mhCone.value) : undefined
    });

    const onHotspotField = () => {
        const patch = buildHotspotPatch();
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'MEDIA_HOTSPOT_SET', value: patch });
            return;
        }
        patchSceneMediaHotspot(global.settings as ExperienceSettings, patch);
        syncHotspotUi();
        events.fire('sceneMediaHotspot:changed');
    };

    syncHotspotUi();
    mhVideoDist?.addEventListener('input', onHotspotField);
    mhAudioDist?.addEventListener('input', onHotspotField);
    mhCone?.addEventListener('input', onHotspotField);

    const onHotspotExternal = () => syncHotspotUi();
    events.on('sceneMediaHotspot:changed', onHotspotExternal);

    const onBaselineClick = () => {
        const id = state.selectedSceneEntityId;
        const target = getSelectedSceneAssetType(state, global.settings.sceneAssets);
        if (!id || (target !== 'video' && target !== 'audio')) {
            console.warn('[MediaHotspot] 请先选中场景中的 video 或 audio 资产');
            return;
        }
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'MEDIA_HOTSPOT_SET_BASELINE', id, target });
            return;
        }
        const result = applySceneMediaHotspotBaselineFromView(global, { sceneEntityId: id, target });
        if (result.ok === false) {
            console.warn('[MediaHotspot] 设基准距离失败', result.reason);
            return;
        }
        syncHotspotUi();
        events.fire('sceneMediaHotspot:changed');
    };
    mhBaselineBtn?.addEventListener('click', onBaselineClick);

    const videoCurvaturePanel = root.querySelector<HTMLElement>('#videoCurvaturePanel');
    const videoCurvatureInput = root.querySelector<HTMLInputElement>('#videoCurvature');
    const videoCurvatureVal = root.querySelector<HTMLSpanElement>('#videoCurvatureVal');

    const readSelectedVideoCurvature = (): number => {
        const id = state.selectedSceneEntityId;
        if (!id) return 0;
        const entry = state.scenePlacedEntities?.find((it) => it?.id === id);
        return clampVideoHorizontalCurvature(entry?.horizontalCurvature ?? 0);
    };

    const syncVideoCurvatureUi = () => {
        const isVideo =
            !!state.selectedSceneEntityId && getSelectedSceneAssetType(state, global.settings.sceneAssets) === 'video';
        if (videoCurvaturePanel) {
            videoCurvaturePanel.classList.toggle('hidden', !isVideo);
        }
        if (!isVideo || !videoCurvatureInput) return;
        const c = readSelectedVideoCurvature();
        const pct = Math.round(c * 100);
        const arcDeg = (c * VIDEO_HORIZONTAL_MAX_ARC_DEG).toFixed(0);
        videoCurvatureInput.value = String(pct);
        if (videoCurvatureVal) videoCurvatureVal.textContent = `${pct}% (${arcDeg}°)`;
    };

    const onVideoCurvatureInput = () => {
        const id = state.selectedSceneEntityId;
        if (!id || getSelectedSceneAssetType(state, global.settings.sceneAssets) !== 'video') return;
        const curvature = clampVideoHorizontalCurvature(Number(videoCurvatureInput?.value ?? 0) / 100);
        applyVideoHorizontalCurvature(global, id, curvature);
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'ASSET_VIDEO_CURVATURE_SET', id, value: curvature });
        }
        syncVideoCurvatureUi();
    };

    syncVideoCurvatureUi();
    videoCurvatureInput?.addEventListener('input', onVideoCurvatureInput);
    const onSceneAssetSelectedForCurvature = () => syncVideoCurvatureUi();
    events.on('sceneAsset:selected', onSceneAssetSelectedForCurvature);
    events.on('sceneAssets:added', onSceneAssetSelectedForCurvature);
    events.on('sceneAssets:removed', onSceneAssetSelectedForCurvature);

    const mediaAutoplayPanel = root.querySelector<HTMLElement>('#mediaAutoplayPanel');
    const mediaHotspotAutoplayCheck = root.querySelector<HTMLInputElement>('#mediaHotspotAutoplayCheck');

    const readSelectedMediaAutoplay = (): boolean => {
        const id = state.selectedSceneEntityId;
        if (!id) return true;
        const entry = state.scenePlacedEntities?.find((it) => it?.id === id);
        if (entry && entry.hotspotAutoplay === false) return false;
        const sa = (global.settings as ExperienceSettings).sceneAssets?.find((a) => a.id === id);
        return sa?.hotspotAutoplay !== false;
    };

    const syncMediaAutoplayUi = () => {
        const t = state.selectedSceneEntityId
            ? getSelectedSceneAssetType(state, global.settings.sceneAssets)
            : null;
        const isMedia = t === 'video' || t === 'audio';
        if (mediaAutoplayPanel) {
            mediaAutoplayPanel.classList.toggle('hidden', !isMedia);
        }
        if (!isMedia || !mediaHotspotAutoplayCheck) return;
        mediaHotspotAutoplayCheck.checked = readSelectedMediaAutoplay();
    };

    const onMediaAutoplayChange = () => {
        const id = state.selectedSceneEntityId;
        if (!id || !mediaHotspotAutoplayCheck) return;
        const t = getSelectedSceneAssetType(state, global.settings.sceneAssets);
        if (t !== 'video' && t !== 'audio') return;
        const value = mediaHotspotAutoplayCheck.checked;
        applyMediaHotspotAutoplay(global, id, value);
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'ASSET_MEDIA_HOTSPOT_AUTOPLAY_SET', id, value });
        }
    };

    syncMediaAutoplayUi();
    mediaHotspotAutoplayCheck?.addEventListener('change', onMediaAutoplayChange);
    const onSceneAssetSelectedForAutoplay = () => syncMediaAutoplayUi();
    events.on('sceneAsset:selected', onSceneAssetSelectedForAutoplay);
    events.on('sceneAssets:added', onSceneAssetSelectedForAutoplay);
    events.on('sceneAssets:removed', onSceneAssetSelectedForAutoplay);
    events.on('sceneAsset:hotspotAutoplayChanged', onSceneAssetSelectedForAutoplay);

    return () => {
        unbindList();
        if (gridEl && onLibraryChange) {
            events.off('assetLibrary:added', onLibraryChange);
            events.off('assetLibrary:removed', onLibraryChange);
        }
        typeSelect.removeEventListener('change', typeSelectHandler);
        fileInput.removeEventListener('change', handleFileSelect);
        addMediaUrlBtn.removeEventListener('click', addMediaFromUrl);
        mediaUrlInput.removeEventListener('keydown', onMediaUrlKeydown);
        mhVideoDist?.removeEventListener('input', onHotspotField);
        mhAudioDist?.removeEventListener('input', onHotspotField);
        mhCone?.removeEventListener('input', onHotspotField);
        mhBaselineBtn?.removeEventListener('click', onBaselineClick);
        events.off('sceneMediaHotspot:changed', onHotspotExternal);
        videoCurvatureInput?.removeEventListener('input', onVideoCurvatureInput);
        events.off('sceneAsset:selected', onSceneAssetSelectedForCurvature);
        events.off('sceneAssets:added', onSceneAssetSelectedForCurvature);
        events.off('sceneAssets:removed', onSceneAssetSelectedForCurvature);
        mediaHotspotAutoplayCheck?.removeEventListener('change', onMediaAutoplayChange);
        events.off('sceneAsset:selected', onSceneAssetSelectedForAutoplay);
        events.off('sceneAssets:added', onSceneAssetSelectedForAutoplay);
        events.off('sceneAssets:removed', onSceneAssetSelectedForAutoplay);
        events.off('sceneAsset:hotspotAutoplayChanged', onSceneAssetSelectedForAutoplay);
    };
}
