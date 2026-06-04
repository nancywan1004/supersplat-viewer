import {
    applySceneAssetTriggerDistanceM,
    applyVideoHorizontalCurvature
} from '../../scene-assets/asset-placement-handler';
import { readEntryTriggerDistanceM } from '../../scene-assets/media/media-hotspot-params';
import { pushEditHistory } from '../../edit-history';
import { getSceneAssetListHTML, bindSceneAssetList } from './scene-asset-list-ui';
import { clampVideoHorizontalCurvature, VIDEO_HORIZONTAL_MAX_ARC_DEG } from '../../scene-assets/media/curved-billboard-mesh';
import type { ExperienceSettings, SceneMediaHotspotPatch } from '../../schemas/v2';
import {
    applySceneMediaHotspotBaselineFromView,
    ensureSceneMediaHotspot,
    patchSceneMediaHotspot,
    readGlobalAudioHotspotAutoplayEnabled,
    readGlobalShowAudioCalloutInViewer,
    readGlobalVideoHotspotAutoplayEnabled
} from '../../settings-serialize/settings-serialize-helper';
import { getSelectedSceneAssetType, getSelectedScenePlacedItem } from '../../state-selectors';
import type { Global, AssetLibraryItem, AssetLibraryType } from '../../types';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';

// 危险协议前缀（拆开写避免 no-script-url 误报字面量）
const DANGEROUS_URL_PROTOCOL = `${'java'}${'script'}:`;

/**
 * 解析为可加载的绝对 URL；拒绝 blob、脚本协议等。
 * @param raw - 用户输入的 URL 或相对路径
 * @returns 规范化后的 href，或无法解析/不允许时 `null`
 */
function resolveRemoteAssetUrl(raw: string): string | null {
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
                if ((item.type === 'image' || item.type === 'video' || item.type === 'audio' || item.type === 'gaussian') && item.url?.startsWith('blob:')) {
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
 * 资产放置设置组件：资产类型选择、URL 添加、预览网格、场景资产列表。
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
        </div>
        <div id="assetMediaUrlRow" class="asset-media-url-row">
            <input type="text" id="assetMediaUrl" class="settingsSelect asset-media-url-input" placeholder="https://… 或 /path/to/asset" autocomplete="off" aria-label="资产 URL" />
            <button type="button" id="addMediaUrlBtn" class="settingsButton">添加</button>
        </div>
        <div class="asset-preview-grid" id="assetPreviewGrid">
        </div>
        <div class="media-hotspot-panel" id="mediaHotspotPanel">
            <div class="settingsRow submenuHeader expanded" style="margin-top:6px;">音视频热区</div>
            <div class="settingsRow">
                <label for="mhGlobalAutoplay">视频热区自动播放</label>
                <input type="checkbox" id="mhGlobalAutoplay" checked />
            </div>
            <div class="settingsRow">
                <label for="mhGlobalAudioAutoplay">音频热区自动播放</label>
                <input type="checkbox" id="mhGlobalAudioAutoplay" checked />
            </div>
            <div class="settingsRow">
                <label for="mhGlobalAudioCalloutInViewer">浏览模式显示音频图标</label>
                <input type="checkbox" id="mhGlobalAudioCalloutInViewer" checked />
            </div>
        </div>
        <div class="media-trigger-distance-panel hidden" id="mediaTriggerDistancePanel">
            <div class="settingsRow submenuHeader" style="margin-top:6px;">触发距离</div>
            <div class="settingsRow">
                <label for="mhAssetDist">距离 (m)</label>
                <input type="range" id="mhAssetDist" min="1" max="80" step="0.5" />
                <span id="mhAssetDistVal" class="settingsValueLabel"></span>
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
        <div class="asset-morph-pick-panel settingsRow" style="flex-direction:column;align-items:stretch;gap:6px;margin-top:8px">
            <div class="settingsRow submenuHeader" style="margin:0;">变形关键帧拾取</div>
            <p class="effectsTrackHint" id="assetMorphAddPickHint" style="font-size:10px;opacity:0.65;margin:0;line-height:1.35">
                协议 <code>MORPH_ASSET_ADD_START</code> / <code>FINISH</code>；拾取中仅可选 Gaussian，上报 <code>SCENE_ASSET_SELECTED</code>
            </p>
            <div class="settingsRow" style="gap:6px;flex-wrap:wrap;margin:0">
                <button type="button" id="assetMorphAddStart" class="settingsButton" style="font-size:11px">开始场景拾取</button>
                <button type="button" id="assetMorphAddFinish" class="settingsButton" style="font-size:11px">结束场景拾取</button>
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
 * 绑定资产放置设置面板的类型选择、URL 添加、网格渲染、场景资产列表等交互。
 * 折叠/展开由 edit-right-toolbar 的 bindSubpanel 统一处理。
 * @param {HTMLElement | null} root - 组件根元素（含 data-asset-placement-root 的容器，内含 data-scene-asset-list-root）
 * @param {Global} global - 全局对象（用于 app、state、events）
 * @returns 清理函数
 */
export function bindAssetPlacementSettings(root: HTMLElement | null, global: Global): () => void {
    if (!root) return () => {};

    const listRoot = root.querySelector<HTMLElement>('[data-scene-asset-list-root]');
    const unbindList = bindSceneAssetList(listRoot, global);

    const { state, events } = global;
    const typeSelect = root.querySelector<HTMLSelectElement>('#assetTypeSelect');
    const mediaUrlRow = root.querySelector<HTMLElement>('#assetMediaUrlRow');
    const mediaUrlInput = root.querySelector<HTMLInputElement>('#assetMediaUrl');
    const addMediaUrlBtn = root.querySelector<HTMLButtonElement>('#addMediaUrlBtn');
    if (!typeSelect || !mediaUrlRow || !mediaUrlInput || !addMediaUrlBtn) return () => {};

    if (!state.uploadedAssets) state.uploadedAssets = [];

    const gridEl = root.querySelector<HTMLElement>('#assetPreviewGrid');
    let onLibraryChange: (() => void) | null = null;
    if (gridEl) {
        renderAssetPreviewGrid(gridEl, global, typeSelect);
        onLibraryChange = () => renderAssetPreviewGrid(gridEl, global, typeSelect);
        events.on('assetLibrary:added', onLibraryChange);
        events.on('assetLibrary:removed', onLibraryChange);
        // Demo assets are optional; only load the local sample when explicitly requested.
        if (state.uploadedAssets.length === 0 && new URLSearchParams(window.location.search).get('loadDemoAsset') === '1') {
            const gaussianDemoItem: AssetLibraryItem = {
                id: nextAssetId(),
                type: 'gaussian',
                name: 'biker (demo)',
                filename: 'biker.sog',
                url: '/assets/gsplat/biker.sog'
            };
            state.uploadedAssets!.push(gaussianDemoItem);
            events.fire('assetLibrary:added', [gaussianDemoItem]);
        }
    }

    const syncAssetTypeControls = () => {
        const type = (typeSelect.value || 'mesh') as AssetLibraryType;
        const hint =
            type === 'image'
                ? 'https://.../xx.png 或 /assets/xx.png'
                : type === 'mesh'
                    ? 'https://.../xx.glb 或 /assets/xx.glb'
                    : type === 'gaussian'
                        ? 'https://.../xx.sog 或 /assets/xx.sog'
                        : type === 'video'
                            ? 'https://.../xx.mp4 或 /assets/xx.mp4'
                            : 'https://.../xx.mp3 或 /assets/xx.mp3';
        mediaUrlInput.placeholder = hint;
        mediaUrlRow.classList.remove('hidden');
    };
    syncAssetTypeControls();

    const typeSelectHandler = () => {
        syncAssetTypeControls();
        if (gridEl) renderAssetPreviewGrid(gridEl, global, typeSelect);
    };
    typeSelect.addEventListener('change', typeSelectHandler);

    const addMediaFromUrl = () => {
        const type = (typeSelect.value || 'mesh') as AssetLibraryType;
        const url = resolveRemoteAssetUrl(mediaUrlInput.value);
        if (!url) {
            console.warn('[AssetPlacement] 无效的资产 URL（需为 http(s)、相对路径等，不支持 blob）');
            return;
        }
        const id = nextAssetId();
        const name = displayNameFromMediaUrl(url);
        const item: AssetLibraryItem = {
            id,
            type,
            name,
            filename: name,
            url,
            thumbnailUrl: type === 'image' ? url : undefined
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

    const mhGlobalAutoplay = root.querySelector<HTMLInputElement>('#mhGlobalAutoplay');
    const mhGlobalAudioAutoplay = root.querySelector<HTMLInputElement>('#mhGlobalAudioAutoplay');
    const mhGlobalAudioCalloutInViewer = root.querySelector<HTMLInputElement>('#mhGlobalAudioCalloutInViewer');
    const mediaTriggerDistancePanel = root.querySelector<HTMLElement>('#mediaTriggerDistancePanel');
    const mhAssetDist = root.querySelector<HTMLInputElement>('#mhAssetDist');
    const mhBaselineBtn = root.querySelector<HTMLButtonElement>('#mhBaselineBtn');
    const mhAssetDistVal = root.querySelector<HTMLSpanElement>('#mhAssetDistVal');

    const editUiTransport = getEditUiTransport(global);

    const syncGlobalHotspotUi = () => {
        const settings = global.settings as ExperienceSettings;
        if (mhGlobalAutoplay) {
            mhGlobalAutoplay.checked = readGlobalVideoHotspotAutoplayEnabled(settings);
        }
        if (mhGlobalAudioAutoplay) {
            mhGlobalAudioAutoplay.checked = readGlobalAudioHotspotAutoplayEnabled(settings);
        }
        if (mhGlobalAudioCalloutInViewer) {
            mhGlobalAudioCalloutInViewer.checked = readGlobalShowAudioCalloutInViewer(settings);
        }
    };

    const sendOrApplyHotspotPatch = (patch: SceneMediaHotspotPatch) => {
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'MEDIA_HOTSPOT_SET', value: patch });
            return;
        }
        patchSceneMediaHotspot(global.settings as ExperienceSettings, patch);
        syncGlobalHotspotUi();
        events.fire('sceneMediaHotspot:changed');
    };

    const onGlobalAutoplayChange = () => {
        if (!mhGlobalAutoplay) return;
        sendOrApplyHotspotPatch({ video: { hotspotAutoplayEnabled: mhGlobalAutoplay.checked } });
    };

    const onGlobalAudioAutoplayChange = () => {
        if (!mhGlobalAudioAutoplay) return;
        sendOrApplyHotspotPatch({ audio: { hotspotAutoplayEnabled: mhGlobalAudioAutoplay.checked } });
    };

    const onGlobalAudioCalloutInViewerChange = () => {
        if (!mhGlobalAudioCalloutInViewer) return;
        sendOrApplyHotspotPatch({ audio: { showCalloutInViewer: mhGlobalAudioCalloutInViewer.checked } });
    };

    syncGlobalHotspotUi();
    mhGlobalAutoplay?.addEventListener('change', onGlobalAutoplayChange);
    mhGlobalAudioAutoplay?.addEventListener('change', onGlobalAudioAutoplayChange);
    mhGlobalAudioCalloutInViewer?.addEventListener('change', onGlobalAudioCalloutInViewerChange);

    const onHotspotExternal = () => syncGlobalHotspotUi();
    events.on('sceneMediaHotspot:changed', onHotspotExternal);

    const syncPerAssetDistanceUi = () => {
        const entry = getSelectedScenePlacedItem(state);
        const t =
            entry?.assetType === 'video' || entry?.assetType === 'audio'
                ? entry.assetType
                : state.selectedSceneEntityId
                    ? getSelectedSceneAssetType(state, global.settings.sceneAssets)
                    : null;
        const isMedia = t === 'video' || t === 'audio';
        if (mediaTriggerDistancePanel) {
            mediaTriggerDistancePanel.classList.toggle('hidden', !isMedia);
        }
        if (!isMedia || !mhAssetDist || !entry) return;
        const dist = readEntryTriggerDistanceM(entry, t, global.settings as ExperienceSettings);
        mhAssetDist.value = String(dist);
        if (mhAssetDistVal) mhAssetDistVal.textContent = `${dist.toFixed(1)} m`;
    };

    const onAssetDistInput = () => {
        const id = state.selectedSceneEntityId;
        if (!id || !mhAssetDist) return;
        const entry = getSelectedScenePlacedItem(state);
        const t =
            entry?.assetType === 'video' || entry?.assetType === 'audio'
                ? entry.assetType
                : getSelectedSceneAssetType(state, global.settings.sceneAssets);
        if (t !== 'video' && t !== 'audio') return;
        const value = Number(mhAssetDist.value);
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'ASSET_MEDIA_HOTSPOT_RANGE_SET', id, value });
            return;
        }
        if (applySceneAssetTriggerDistanceM(global, id, value)) {
            pushEditHistory(global, 'set media trigger distance');
        }
        syncPerAssetDistanceUi();
    };

    syncPerAssetDistanceUi();
    mhAssetDist?.addEventListener('input', onAssetDistInput);

    const onBaselineClick = () => {
        const id = state.selectedSceneEntityId;
        const target = getSelectedSceneAssetType(state, global.settings.sceneAssets);
        if (!id || (target !== 'video' && target !== 'audio')) {
            console.warn('[MediaHotspot] 请先选中场景中的 video 或 audio 资产');
            return;
        }
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'ASSET_MEDIA_HOTSPOT_BASELINE_SET', id });
            return;
        }
        const result = applySceneMediaHotspotBaselineFromView(global, { sceneEntityId: id });
        if (result.ok === false) {
            console.warn('[MediaHotspot] 设基准距离失败', result.reason);
            return;
        }
        syncPerAssetDistanceUi();
        events.fire('sceneAsset:triggerDistanceChanged', {
            id: result.id,
            triggerDistanceM: result.triggerDistanceM
        });
    };
    mhBaselineBtn?.addEventListener('click', onBaselineClick);

    const onSceneAssetSelectedForDistance = () => syncPerAssetDistanceUi();
    events.on('sceneAsset:selected', onSceneAssetSelectedForDistance);
    events.on('sceneAssets:added', onSceneAssetSelectedForDistance);
    events.on('sceneAssets:removed', onSceneAssetSelectedForDistance);
    events.on('sceneAsset:triggerDistanceChanged', onSceneAssetSelectedForDistance);

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

    const morphAddPickHint = root.querySelector<HTMLElement>('#assetMorphAddPickHint');
    const btnMorphAddStart = root.querySelector<HTMLButtonElement>('#assetMorphAddStart');
    const btnMorphAddFinish = root.querySelector<HTMLButtonElement>('#assetMorphAddFinish');

    const syncMorphAddPickHint = () => {
        if (!morphAddPickHint) return;
        const active = state.morphAssetAddActive === true;
        morphAddPickHint.style.opacity = active ? '0.95' : '0.65';
        morphAddPickHint.textContent = active
            ? '拾取中：点击场景 Gaussian → SCENE_ASSET_SELECTED（module: asset）'
            : '协议 MORPH_ASSET_ADD_START / FINISH；拾取中仅可选 Gaussian，上报 SCENE_ASSET_SELECTED';
    };

    const routeMorphAssetAddCommand = (cmd: 'MORPH_ASSET_ADD_START' | 'MORPH_ASSET_ADD_FINISH') => {
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: cmd });
        } else {
            const registry = (global as { __commandRegistry?: { dispatch: (input: {
                module: 'asset';
                command: { type: string; source: 'host' };
            }) => boolean } }).__commandRegistry;
            registry?.dispatch({ module: 'asset', command: { type: cmd, source: 'host' } });
        }
        syncMorphAddPickHint();
    };

    const onMorphAddStart = () => routeMorphAssetAddCommand('MORPH_ASSET_ADD_START');
    const onMorphAddFinish = () => routeMorphAssetAddCommand('MORPH_ASSET_ADD_FINISH');

    btnMorphAddStart?.addEventListener('click', onMorphAddStart);
    btnMorphAddFinish?.addEventListener('click', onMorphAddFinish);
    events.on('morphAssetAddActive:changed', syncMorphAddPickHint);
    events.on('assetFacade:exit', syncMorphAddPickHint);
    syncMorphAddPickHint();

    return () => {
        unbindList();
        if (gridEl && onLibraryChange) {
            events.off('assetLibrary:added', onLibraryChange);
            events.off('assetLibrary:removed', onLibraryChange);
        }
        typeSelect.removeEventListener('change', typeSelectHandler);
        addMediaUrlBtn.removeEventListener('click', addMediaFromUrl);
        mediaUrlInput.removeEventListener('keydown', onMediaUrlKeydown);
        mhGlobalAutoplay?.removeEventListener('change', onGlobalAutoplayChange);
        mhGlobalAudioAutoplay?.removeEventListener('change', onGlobalAudioAutoplayChange);
        mhGlobalAudioCalloutInViewer?.removeEventListener('change', onGlobalAudioCalloutInViewerChange);
        mhAssetDist?.removeEventListener('input', onAssetDistInput);
        mhBaselineBtn?.removeEventListener('click', onBaselineClick);
        events.off('sceneMediaHotspot:changed', onHotspotExternal);
        events.off('sceneAsset:selected', onSceneAssetSelectedForDistance);
        events.off('sceneAssets:added', onSceneAssetSelectedForDistance);
        events.off('sceneAssets:removed', onSceneAssetSelectedForDistance);
        events.off('sceneAsset:triggerDistanceChanged', onSceneAssetSelectedForDistance);
        videoCurvatureInput?.removeEventListener('input', onVideoCurvatureInput);
        events.off('sceneAsset:selected', onSceneAssetSelectedForCurvature);
        events.off('sceneAssets:added', onSceneAssetSelectedForCurvature);
        events.off('sceneAssets:removed', onSceneAssetSelectedForCurvature);
        btnMorphAddStart?.removeEventListener('click', onMorphAddStart);
        btnMorphAddFinish?.removeEventListener('click', onMorphAddFinish);
        events.off('morphAssetAddActive:changed', syncMorphAddPickHint);
        events.off('assetFacade:exit', syncMorphAddPickHint);
    };
}
