/**
 * 初始化场景标注面板 UI
 *
 * 挂载到 #annotationPanelContainer；若无容器则跳过。
 * 显隐由 editLeftModule 控制（选中「场景标注」时 rightPanelAnnotation 显示）。
 */

import { Annotation } from '../../annotation';
import { AnnotationManager } from '../../annotation-toolbar/annotation-manager';
import { applyAnnotationShowHideSet } from '../../annotation-toolbar/annotation-visibility';
import { AnnotationToolbarUI } from './annotation-toolbar-ui';
import type { Global } from '../../types';
import type { AnnotationData } from '../../annotation-toolbar/types';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';
import { pushEditHistory } from '../../edit-history';
import { resolveAnnotationMediaInput } from '../../settings-io/user-files';

/**
 * 初始化场景标注面板 UI
 *
 * @returns 清理函数
 */
export function initAnnotationUI(global: Global): () => void {
    const { config, events, state } = global;
    const editUiTransport = getEditUiTransport(global);

    const container = document.getElementById('annotationPanelContainer');
    if (!container || config.allowEditMode === false) return () => {};

    // 确保 annotations 父容器存在（供 AnnotationEntity 的 hotspot 挂载）
    const uiEl = document.getElementById('ui');
    if (uiEl && !document.getElementById('annotations')) {
        const parentDom = document.createElement('div');
        parentDom.id = 'annotations';
        Annotation.parentDom = parentDom;
        uiEl.appendChild(parentDom);
    }

    const existingManager = (global as any).annotationManager as AnnotationManager | undefined;
    const annotationManager = existingManager ?? new AnnotationManager(global);
    const ownsAnnotationManager = !existingManager;
    const annotationUI = new AnnotationToolbarUI(container);

    let originalAnnotationDataForEdit: AnnotationData | null = null;
    let pendingCreateId: string | null = null;
    let hasPlacedForCreate = false;

    // 新建流程：先填表单，再点击「去放置」进入放置模式，场景点击后按钮变为「确定并放置」
    annotationUI.onCreateButtonClick(() => {
        // 新建前清理当前选中与编辑状态，避免修改到已有标注
        annotationManager.deselectAnnotation();
        originalAnnotationDataForEdit = null;
        pendingCreateId = null;
        hasPlacedForCreate = false;
        if (annotationManager.getPlaceholderAnnotation()) {
            annotationManager.cancelAnnotation();
        }
        annotationUI.showEditForm(undefined, false);
        annotationUI.setPlacementHintVisible(false);
    });

    // 「去放置 / 确定并放置」按钮点击
    annotationUI.onPlaceButtonClick(() => {
        const formData = annotationUI.getFormData();
        if (!formData.title || !formData.text) {
            return;
        }

        if (!pendingCreateId) {
            pendingCreateId = annotationManager.generateNewAnnotationId();
            hasPlacedForCreate = false;
            void (async () => {
                const media = await resolveAnnotationMediaInput(global, formData, pendingCreateId ?? undefined);
                annotationManager.setPendingFormDataForPlacement(pendingCreateId as string, {
                    title: formData.title,
                    text: formData.text,
                    showTitleWhenCollapsed: formData.showTitleWhenCollapsed,
                    ...media
                });
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({ type: 'ANNOTATION_PLACEMENT_START', id: pendingCreateId as string });
                } else {
                    annotationManager.startPlacementWithId(pendingCreateId as string);
                }
                annotationUI.setPlacementHintVisible(true);
            })();
            return;
        }

        if (hasPlacedForCreate) {
            const id = pendingCreateId;
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'ANNOTATION_CONFIRM', id, value: formData });
            } else {
                void (async () => {
                    const media = await resolveAnnotationMediaInput(global, formData, id);
                    annotationManager.confirmAnnotation({
                        title: formData.title,
                        text: formData.text,
                        showTitleWhenCollapsed: formData.showTitleWhenCollapsed,
                        ...media
                    });
                })();
            }
            pendingCreateId = null;
            hasPlacedForCreate = false;
            annotationUI.setPlacementHintVisible(false);
            annotationUI.hideEditForm();
            updateList();
        }
    });
    annotationUI.onCancelButtonClick(() => {
        if (annotationManager.getPlaceholderAnnotation()) {
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'ANNOTATION_PLACEMENT_CANCEL' });
            } else {
                annotationManager.cancelAnnotation();
            }
            pendingCreateId = null;
            hasPlacedForCreate = false;
            annotationUI.setPlacementHintVisible(false);
        } else {
            const editingId = annotationUI.getEditingAnnotationId();
            if (editingId && originalAnnotationDataForEdit) {
                const annotation = annotationManager.getAllAnnotations().find((a) => a.id === editingId);
                if (annotation) {
                    annotation.updateContent({
                        title: originalAnnotationDataForEdit.title,
                        text: originalAnnotationDataForEdit.text,
                        image: originalAnnotationDataForEdit.image,
                        video: originalAnnotationDataForEdit.video,
                        showTitleWhenCollapsed: originalAnnotationDataForEdit.showTitleWhenCollapsed
                    });
                    annotation.setCollapsed(originalAnnotationDataForEdit.collapsed);
                }
                annotationManager.deselectAnnotation();
            }
            originalAnnotationDataForEdit = null;
        }
        annotationUI.hideEditForm();
        updateList();
    });
    annotationUI.onAnnotationSelect((id) => {
        annotationManager.selectAnnotation(id, { showGizmo: false, source: 'host' });
        // 仅选择不显示表单、不显示 Gizmo；Gizmo 需点击底部「移动」后显示
    });
    annotationUI.onAnnotationEditOrUpdate((id, isUpdate) => {
        if (isUpdate) {
            const data = annotationUI.getFormData();
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'ANNOTATION_CONFIRM', id, value: data });
            } else {
                void (async () => {
                    const media = await resolveAnnotationMediaInput(global, data, id);
                    annotationManager.updateAnnotation(id, {
                        title: data.title,
                        text: data.text,
                        showTitleWhenCollapsed: data.showTitleWhenCollapsed,
                        ...media
                    });
                })();
            }
            annotationUI.hideEditForm();
            annotationManager.deselectAnnotation();
            originalAnnotationDataForEdit = null;
        } else {
            const annotation = annotationManager.getAllAnnotations().find((a) => a.id === id);
            if (annotation) {
                annotationManager.selectAnnotation(id, { showGizmo: false, source: 'host' });
                const serialized = annotation.serialize();
                originalAnnotationDataForEdit = serialized;
                annotationUI.showEditForm(serialized, true);
            }
        }
        updateList();
    });
    annotationUI.onDeleteButtonClick((id) => {
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'ANNOTATION_DELETE', id });
        } else {
            annotationManager.deleteAnnotation(id);
        }
    });
    annotationUI.onVisibilityToggle((id, visible) => {
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage({ type: 'ANNOTATION_SHOW_HIDE_SET', id, value: visible });
        } else if (applyAnnotationShowHideSet(global, id, visible)) {
            pushEditHistory(global, 'toggle annotation visibility');
        }
        updateList();
    });
    annotationUI.onInputChange((data) => {
        if (editUiTransport === 'message-bridge') {
            // 父级托管/协议模式：输入时通过协议实时下发，驱动场景内标注预览更新
            const targetId = pendingCreateId ?? annotationUI.getEditingAnnotationId();
            if (targetId) {
                sendEditProtocolMessage({ type: 'ANNOTATION_UPDATE', id: targetId, value: data });
            }
            return;
        }
        const placeholder = annotationManager.getPlaceholderAnnotation();
        if (placeholder) {
            placeholder.updateContent(data);
            return;
        }
        // 仅在编辑已有标注时实时更新场景中的标注内容；新建时不影响已有标注
        const editingId = annotationUI.getEditingAnnotationId();
        if (editingId) {
            const annotation = annotationManager.getAllAnnotations().find((a) => a.id === editingId);
            if (annotation) {
                annotation.updateContent(data);
            }
        }
    });

    const updateList = () => {
        const annotations: AnnotationData[] = annotationManager
            .getAllAnnotations()
            .map((a) => a.serialize());
        const selectedId = annotationManager.getSelectedAnnotation()?.id ?? null;
        annotationUI.updateAnnotationList(annotations, annotationUI.getEditingAnnotationId(), selectedId);
    };

    const onAnnotationSelected = () => {
        updateList();
        // 仅选择时显示 Gizmo，不显示编辑表单；编辑需点击「编辑」按钮
        const selected = annotationManager.getSelectedAnnotation();
        if (!selected) {
            annotationUI.hideEditForm();
        }
    };
    const onAnnotationDeselected = () => {
        updateList();
        annotationUI.hideEditForm();
    };
    const onAnnotationPlace = () => {
        const placeholder = annotationManager.getPlaceholderAnnotation();
        annotationUI.showEditForm(placeholder?.serialize(), false);
        updateList();
    };

    const onPlacementStarted = () => annotationUI.setPlacementHintVisible(true);
    const onPlacementEnded = () => annotationUI.setPlacementHintVisible(false);
    const onAnnotationPlaceWithHint = () => {
        onPlacementEnded();
        onAnnotationPlace();
        // 放置完成：切换按钮为「确定并放置」
        if (pendingCreateId) {
            hasPlacedForCreate = true;
            annotationUI.setPlaceButton('确定并放置', true);
        }
    };

    events.on('annotation:created', updateList);
    events.on('annotation:deleted', updateList);
    events.on('annotationVisibility:changed', updateList);
    events.on('annotation:selected', onAnnotationSelected);
    // annotation:selectFromHotspot 的兜底监听已下沉到 AnnotationManager，
    // 这里不再在 UI 层注册，避免 UI 未挂载时无法触发选中回传。
    events.on('annotation:deselected', onAnnotationDeselected);
    events.on('annotation:place', onAnnotationPlaceWithHint);
    events.on('annotationPlacement:started', onPlacementStarted);
    events.on('annotationPlacement:ended', onPlacementEnded);

    /** 底部栏「编辑」按钮：显示右侧编辑表单 */
    const onAnnotationEditShow = () => {
        const selected = annotationManager.getSelectedAnnotation();
        if (selected) {
            const serialized = selected.serialize();
            originalAnnotationDataForEdit = serialized;
            annotationUI.showEditForm(serialized, true);
        }
    };
    events.on('annotationEdit:show', onAnnotationEditShow);

    const onControlsHiddenChanged = (hidden: boolean) => {
        if (hidden) {
            annotationManager.setAllAnnotationsVisible(false);
        } else {
            annotationManager.applyVisibilityFromSettings();
        }
    };
    events.on('controlsHidden:changed', onControlsHiddenChanged);
    onControlsHiddenChanged(state.controlsHidden ?? false);

    /** 模块生命周期由 annotation facade 统一驱动，UI 仅处理表单/中间态收尾 */
    const onAnnotationFacadeEnter = () => {
        updateList();
    };
    const onAnnotationFacadeExit = () => {
        if (annotationManager.getPlaceholderAnnotation()) {
            annotationManager.cancelAnnotation();
            annotationUI.hideEditForm();
        } else {
            const editingId = annotationUI.getEditingAnnotationId();
            if (editingId && originalAnnotationDataForEdit) {
                const annotation = annotationManager.getAllAnnotations().find((a) => a.id === editingId);
                if (annotation) {
                    annotation.updateContent({
                        title: originalAnnotationDataForEdit.title,
                        text: originalAnnotationDataForEdit.text,
                        image: originalAnnotationDataForEdit.image,
                        video: originalAnnotationDataForEdit.video,
                        showTitleWhenCollapsed: originalAnnotationDataForEdit.showTitleWhenCollapsed
                    });
                    annotation.setCollapsed(originalAnnotationDataForEdit.collapsed);
                }
            }
            originalAnnotationDataForEdit = null;
            annotationUI.hideEditForm();
        }
        // 离开标注模块时始终取消选中并清除标注 Gizmo，避免切换到资产模块后 Gizmo 未清除
        annotationManager.deselectAnnotation();
        updateList();
    };
    events.on('annotationFacade:enter', onAnnotationFacadeEnter);
    events.on('annotationFacade:exit', onAnnotationFacadeExit);
    events.on('annotationFacade:editModeExit', onAnnotationFacadeExit);

    const onAnnotationNavigate = (ann: { id?: string }) => {
        const id = ann?.id;
        if (id) {
            const entity = annotationManager.getAllAnnotations().find((a) => a.id === id);
            if (entity) {
                entity.showTooltip();
            }
        }
    };
    events.on('annotation.navigate', onAnnotationNavigate);

    if (ownsAnnotationManager) {
        (global as any).annotationManager = annotationManager;
    }

    annotationUI.show();
    updateList();

    return () => {
        events.off('annotation:created', updateList);
        events.off('annotation:deleted', updateList);
        events.off('annotationVisibility:changed', updateList);
        events.off('annotation:selected', onAnnotationSelected);
        events.off('annotation:deselected', onAnnotationDeselected);
        events.off('annotation:place', onAnnotationPlaceWithHint);
        events.off('annotationPlacement:started', onPlacementStarted);
        events.off('annotationPlacement:ended', onPlacementEnded);
        events.off('annotationPlacement:update');
        events.off('annotationEdit:show', onAnnotationEditShow);
        events.off('controlsHidden:changed', onControlsHiddenChanged);
        events.off('annotationFacade:enter', onAnnotationFacadeEnter);
        events.off('annotationFacade:exit', onAnnotationFacadeExit);
        events.off('annotationFacade:editModeExit', onAnnotationFacadeExit);
        events.off('annotation.navigate', onAnnotationNavigate);
        annotationUI.destroy();
        if (ownsAnnotationManager) {
            annotationManager.destroy();
            delete (global as any).annotationManager;
        }
    };
}
