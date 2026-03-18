import type { Global } from '../../types';
import type { Annotation } from '../../settings';
import { pushEditHistory } from '../../edit-history';

const ANNOTATION_SETTINGS_HTML = `
<div class="asset-panel-section annotation-settings-section" data-annotation-settings-root>
    <div class="settingsRow submenuHeader annotation-settings-header expanded" id="annotationSettingsHeader" role="button" tabindex="0">
        <span class="submenuArrow" id="annotationSettingsArrow">▶</span>
        <span>场景标注设置</span>
    </div>
    <div id="annotationSettingsSubpanel" class="subpanel">
        <button type="button" id="annotationNewBtn" class="settingsButton annotation-new-btn">新建场景标注</button>
        <p class="annotation-placement-hint hidden" id="annotationPlacementHint">请先在场景中选择放置位置</p>
        <div class="annotation-form hidden" id="annotationForm">
            <div class="settingsRow">
                <label for="annotationTitleInput">标题:</label>
                <input type="text" id="annotationTitleInput" class="settingsInput" placeholder="Untitled" maxlength="20" />
            </div>
            <div class="settingsRow">
                <label for="annotationBodyInput">正文:</label>
                <textarea id="annotationBodyInput" class="settingsInput annotation-body-input" placeholder="Description..." maxlength="50" rows="3"></textarea>
            </div>
            <div class="settingsRow">
                <span class="annotation-label">图片:</span>
                <div class="annotation-image-upload" id="annotationImageUpload">
                    <span class="annotation-image-plus">+</span>
                    <input type="file" id="annotationImageInput" accept="image/jpeg,image/png" class="hidden" tabindex="-1" />
                </div>
            </div>
            <div class="settingsRow">
                <span class="annotation-label">收起时显示标题:</span>
                <div class="annotation-radio-group">
                    <label class="annotation-radio"><input type="radio" name="annotationShowTitle" value="yes" checked /> 是</label>
                    <label class="annotation-radio"><input type="radio" name="annotationShowTitle" value="no" /> 否</label>
                </div>
            </div>
            <div class="annotation-form-actions">
                <button type="button" id="annotationConfirmPlaceBtn" class="settingsButton annotation-confirm-btn">确定并放置</button>
                <button type="button" id="annotationCancelPlaceBtn" class="settingsButton annotation-cancel-btn">取消放置</button>
            </div>
        </div>
        <div class="annotation-selected-actions hidden" id="annotationSelectedActions">
            <p class="annotation-selected-hint">已选中标注，可移动或删除</p>
            <div class="annotation-action-buttons">
                <button type="button" id="annotationMoveBtn" class="settingsButton">移动</button>
                <button type="button" id="annotationDeleteBtn" class="settingsButton edit-bottom-toolbar-btn-danger">删除</button>
            </div>
        </div>
    </div>
</div>
`.trim();

export function getAnnotationSettingsHTML(): string {
    return ANNOTATION_SETTINGS_HTML;
}

function getDefaultCamera(): Annotation['camera'] {
    return {
        initial: {
            position: [0, 0, 5],
            target: [0, 0, 0],
            fov: 45
        }
    };
}

/**
 * 绑定场景标注设置面板：折叠、新建流程、表单、移动/删除。
 */
export function bindAnnotationSettings(root: HTMLElement | null, global: Global): () => void {
    if (!root) return () => {};

    const { state, events } = global;
    const header = root.querySelector<HTMLElement>('#annotationSettingsHeader');
    const panel = root.querySelector<HTMLElement>('#annotationSettingsSubpanel');
    const arrow = root.querySelector<HTMLElement>('#annotationSettingsArrow');
    const newBtn = root.querySelector<HTMLButtonElement>('#annotationNewBtn');
    const placementHint = root.querySelector<HTMLElement>('#annotationPlacementHint');
    const form = root.querySelector<HTMLElement>('#annotationForm');
    const titleInput = root.querySelector<HTMLInputElement>('#annotationTitleInput');
    const bodyInput = root.querySelector<HTMLTextAreaElement>('#annotationBodyInput');
    const imageUpload = root.querySelector<HTMLElement>('#annotationImageUpload');
    const imageInput = root.querySelector<HTMLInputElement>('#annotationImageInput');
    const confirmBtn = root.querySelector<HTMLButtonElement>('#annotationConfirmPlaceBtn');
    const cancelPlaceBtn = root.querySelector<HTMLButtonElement>('#annotationCancelPlaceBtn');
    const selectedActions = root.querySelector<HTMLElement>('#annotationSelectedActions');
    const moveBtn = root.querySelector<HTMLButtonElement>('#annotationMoveBtn');
    const deleteBtn = root.querySelector<HTMLButtonElement>('#annotationDeleteBtn');

    if (!header || !panel || !arrow || !newBtn || !placementHint || !form || !titleInput || !bodyInput || !imageUpload || !imageInput || !confirmBtn || !cancelPlaceBtn || !selectedActions || !moveBtn || !deleteBtn) return () => {};

    let annotationPlacementActive = false;
    let pendingPlacementPosition: [number, number, number] | null = null;
    let pendingImageDataUrl: string | null = null;

    const toggle = () => {
        const isHidden = panel.classList.contains('hidden');
        panel.classList.toggle('hidden', !isHidden);
        header.classList.toggle('expanded', isHidden);
    };
    const onHeaderKey = (e: KeyboardEvent) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            toggle();
        }
    };
    header.addEventListener('click', toggle);
    header.addEventListener('keydown', onHeaderKey);

    const updateUI = () => {
        const selectedId = state.selectedAnnotationId;
        const annotations = global.settings.annotations ?? [];
        const hasSelection = !!selectedId && annotations.some((a) => a.id === selectedId);

        if (annotationPlacementActive) {
            placementHint.classList.remove('hidden');
            selectedActions.classList.add('hidden');
            const hasPos = pendingPlacementPosition !== null;
            form.classList.toggle('hidden', !hasPos);
            form.classList.toggle('annotation-form-ready', hasPos);
            if (confirmBtn) confirmBtn.disabled = !hasPos;
        } else {
            placementHint.classList.add('hidden');
            form.classList.add('hidden');
            selectedActions.classList.toggle('hidden', !hasSelection);
            if (hasSelection) {
                placementHint.classList.add('hidden');
            }
        }
    };

    newBtn.addEventListener('click', () => {
        annotationPlacementActive = true;
        pendingPlacementPosition = null;
        pendingImageDataUrl = null;
        if (titleInput) titleInput.value = '';
        if (bodyInput) bodyInput.value = '';
        if (imageInput) imageInput.value = '';
        const yesRadio = root.querySelector<HTMLInputElement>('input[name="annotationShowTitle"][value="yes"]');
        if (yesRadio) yesRadio.checked = true;
        state.selectedAnnotationId = null;
        state.editLeftModule = 'annotation';
        // 进入标注放置模式时关闭相机控制，避免鼠标/键盘继续驱动相机
        state.cameraControlsEnabled = false;
        events.fire('cameraControls:flushInputs');
        events.fire('annotation:placementMode', { active: true });
        updateUI();
    });

    const onPlacementPosition = (payload: { position: [number, number, number] }) => {
        if (!annotationPlacementActive) return;
        pendingPlacementPosition = payload.position;
        updateUI();
    };
    events.on('annotation:placementPosition', onPlacementPosition);

    imageUpload.addEventListener('click', () => imageInput.click());
    imageInput.addEventListener('change', (e) => {
        const file = (e.target as HTMLInputElement).files?.[0];
        if (!file) return;
        const reader = new FileReader();
        reader.onload = () => {
            pendingImageDataUrl = typeof reader.result === 'string' ? reader.result : null;
            const existing = imageUpload.querySelector<HTMLImageElement>('.annotation-image-preview');
            const img = existing ?? document.createElement('img');
            img.className = 'annotation-image-preview';
            if (pendingImageDataUrl) {
                img.src = pendingImageDataUrl;
                if (!existing) {
                    imageUpload.appendChild(img);
                }
            }
        };
        reader.readAsDataURL(file);
    });

    confirmBtn.addEventListener('click', () => {
        if (!pendingPlacementPosition) return;
        const title = (titleInput?.value ?? '').trim() || 'Untitled';

        const body = (bodyInput?.value ?? '').trim();
        const showTitleWhenCollapsed = root.querySelector<HTMLInputElement>('input[name="annotationShowTitle"]:checked')?.value !== 'no';

        const ann: Annotation = {
            id: `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            position: pendingPlacementPosition,
            title,
            text: body,
            imageUrl: pendingImageDataUrl ?? undefined,
            showTitleWhenCollapsed,
            collapsed: true,
            extras: {},
            camera: getDefaultCamera()
        };

        // 先退出放置模式（销毁预览），再添加真实标注
        annotationPlacementActive = false;
        pendingPlacementPosition = null;
        pendingImageDataUrl = null;
        events.fire('annotation:placementMode', { active: false });

        global.settings.annotations = global.settings.annotations ?? [];
        global.settings.annotations.push(ann);

        const viewer = (global.app as any).viewer;
        if (viewer?.annotations) {
            viewer.annotations.addAnnotation(ann);
        }

        pushEditHistory(global, 'add annotation');
        events.fire('annotations:changed');

        state.cameraControlsEnabled = true;
        events.fire('cameraControls:flushInputs');
        updateUI();
    });

    cancelPlaceBtn.addEventListener('click', () => {
        annotationPlacementActive = false;
        pendingPlacementPosition = null;
        pendingImageDataUrl = null;
        events.fire('annotation:placementMode', { active: false });
        state.cameraControlsEnabled = true;
        events.fire('cameraControls:flushInputs');
        updateUI();
    });

    const onAnnotationSelected = (payload: { id: string }) => {
        state.selectedAnnotationId = payload.id;
        updateUI();
    };
    events.on('annotation:selected', onAnnotationSelected);

    moveBtn.addEventListener('click', () => {
        const selectedId = state.selectedAnnotationId;
        if (!selectedId) return;
        events.fire('annotation:requestMove', { id: selectedId });
    });

    deleteBtn.addEventListener('click', () => {
        const selectedId = state.selectedAnnotationId;
        if (!selectedId) return;
        if (!confirm('确定删除该标注？')) return;

        const annotations = global.settings.annotations ?? [];
        const index = annotations.findIndex((a) => a.id === selectedId);
        if (index < 0) return;

        const viewer = (global.app as any).viewer;
        if (viewer?.annotations) {
            viewer.annotations.removeAnnotation(index);
        }
        // 从 settings 中移除对应标注
        annotations.splice(index, 1);
        global.settings.annotations = annotations;

        state.selectedAnnotationId = null;
        pushEditHistory(global, 'delete annotation');
        events.fire('annotation:selected', { id: '' });
        updateUI();
    });

    const onAnnotationsChanged = () => updateUI();
    events.on('annotations:changed', onAnnotationsChanged);
    const onEditLeftModuleChanged = (moduleId: string | null) => {
        if (annotationPlacementActive && moduleId !== 'annotation') {
            annotationPlacementActive = false;
            pendingPlacementPosition = null;
            pendingImageDataUrl = null;
            events.fire('annotation:placementMode', { active: false });
            state.cameraControlsEnabled = true;
        }
        updateUI();
    };
    events.on('editLeftModule:changed', onEditLeftModuleChanged as any);

    updateUI();

    return () => {
        events.off('annotation:placementPosition', onPlacementPosition);
        events.off('annotation:selected', onAnnotationSelected);
        events.off('annotations:changed', onAnnotationsChanged);
        events.off('editLeftModule:changed', onEditLeftModuleChanged as any);
        header.removeEventListener('click', toggle);
        header.removeEventListener('keydown', onHeaderKey);
    };
}
