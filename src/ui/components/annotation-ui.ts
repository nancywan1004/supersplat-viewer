/**
 * 初始化场景标注面板 UI
 *
 * 挂载到 #annotationPanelContainer；若无容器则跳过。
 * 显隐由 editLeftModule 控制（选中「场景标注」时 rightPanelAnnotation 显示）。
 */

import { Annotation } from '../../annotation';
import { AnnotationManager } from '../../annotation-toolbar/annotation-manager';
import { AnnotationToolbarUI } from './annotation-toolbar-ui';
import type { Global } from '../../types';
import type { AnnotationData } from '../../annotation-toolbar/types';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';

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

    const annotationManager = new AnnotationManager(global);
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
            // 理论上 UI 已禁用按钮，这里仅防御
            return;
        }

        // 阶段 1：去放置 → 下发等价于 ANNOTATION_PLACEMENT_START，进入放置模式
        if (!pendingCreateId) {
            pendingCreateId = annotationManager.generateNewAnnotationId();
            hasPlacedForCreate = false;
            annotationManager.setPendingFormDataForPlacement(pendingCreateId, formData);
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'ANNOTATION_PLACEMENT_START', id: pendingCreateId });
            } else {
                annotationManager.startPlacementWithId(pendingCreateId);
            }
            // 提示在场景中点击放置位置
            annotationUI.setPlacementHintVisible(true);
            return;
        }

        // 阶段 2：已完成放置（收到 ANNOTATION_PLACEMENT_UPDATE 等价事件），点击「确定并放置」-> ANNOTATION_CONFIRM
        if (hasPlacedForCreate) {
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'ANNOTATION_CONFIRM', id: pendingCreateId, value: formData });
            } else {
                annotationManager.confirmAnnotation(formData);
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
                        imageUrl: originalAnnotationDataForEdit.imageUrl,
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
                annotationManager.updateAnnotation(id, data);
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
    events.on('annotation:selected', onAnnotationSelected);
    const onAnnotationSelectFromHotspot = (data: { id: string }) => {
        const placeholder = annotationManager.getPlaceholderAnnotation();
        // 放置流程中的占位标注不参与「选中」逻辑，避免找不到 id 的 warning
        if (placeholder && placeholder.id === data.id) {
            return;
        }
        annotationManager.selectAnnotation(data.id, { source: 'scene' });
    };
    events.on('annotation:selectFromHotspot', onAnnotationSelectFromHotspot);
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
        annotationManager.setAllAnnotationsVisible(!hidden);
    };
    events.on('controlsHidden:changed', onControlsHiddenChanged);
    onControlsHiddenChanged(state.controlsHidden ?? false);

    const onEditModeChanged = () => {
        if (!state.editMode) {
            annotationManager.deselectAnnotation();
        }
    };
    events.on('editMode:changed', onEditModeChanged);

    /** 切换模块时：进入标注模块默认选中列表中第一项（不自动显示 Gizmo）；离开时取消选中与 Gizmo、取消放置/编辑 */
    const onEditLeftModuleChanged = (newModule: string | null) => {
        if (newModule === 'annotation') {
            const all = annotationManager.getAllAnnotations();
            if (all.length > 0 && !annotationManager.getSelectedAnnotation()) {
                annotationManager.selectAnnotation(all[0].id, { source: 'host' });
            }
            updateList();
            return;
        }
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
                        imageUrl: originalAnnotationDataForEdit.imageUrl,
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
    events.on('editLeftModule:changed', onEditLeftModuleChanged as any);

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

    (global as any).annotationManager = annotationManager;

    annotationUI.show();
    updateList();

    return () => {
        events.off('annotation:created', updateList);
        events.off('annotation:deleted', updateList);
        events.off('annotation:selected', onAnnotationSelected);
        events.off('annotation:selectFromHotspot', onAnnotationSelectFromHotspot);
        events.off('annotation:deselected', onAnnotationDeselected);
        events.off('annotation:place', onAnnotationPlaceWithHint);
        events.off('annotationPlacement:started', onPlacementStarted);
        events.off('annotationPlacement:ended', onPlacementEnded);
        events.off('annotationPlacement:update');
        events.off('annotationEdit:show', onAnnotationEditShow);
        events.off('controlsHidden:changed', onControlsHiddenChanged);
        events.off('editMode:changed', onEditModeChanged);
        events.off('editLeftModule:changed', onEditLeftModuleChanged as any);
        events.off('annotation.navigate', onAnnotationNavigate);
        annotationUI.destroy();
        annotationManager.destroy();
        delete (global as any).annotationManager;
    };
}
