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

/**
 * 初始化场景标注面板 UI
 *
 * @returns 清理函数
 */
export function initAnnotationUI(global: Global): () => void {
    const { config, events, state } = global;

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

    annotationUI.onCreateButtonClick(() => annotationManager.createAnnotation());
    annotationUI.onConfirmButtonClick((data) => {
        annotationManager.confirmAnnotation(data);
        annotationUI.hideEditForm();
        originalAnnotationDataForEdit = null;
    });
    annotationUI.onCancelButtonClick(() => {
        if (annotationManager.getPlaceholderAnnotation()) {
            annotationManager.cancelAnnotation();
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
        annotationManager.selectAnnotation(id);
        // 仅选择不显示表单，编辑需点击「编辑」按钮
    });
    annotationUI.onAnnotationEditOrUpdate((id, isUpdate) => {
        if (isUpdate) {
            const data = annotationUI.getFormData();
            annotationManager.updateAnnotation(id, data);
            annotationUI.hideEditForm();
            annotationManager.deselectAnnotation();
            originalAnnotationDataForEdit = null;
        } else {
            const annotation = annotationManager.getAllAnnotations().find((a) => a.id === id);
            if (annotation) {
                annotationManager.selectAnnotation(id);
                const serialized = annotation.serialize();
                originalAnnotationDataForEdit = serialized;
                annotationUI.showEditForm(serialized, true);
            }
        }
        updateList();
    });
    annotationUI.onDeleteButtonClick((id) => annotationManager.deleteAnnotation(id));
    annotationUI.onInputChange((data) => {
        const target = annotationManager.getPlaceholderAnnotation() ?? annotationManager.getSelectedAnnotation();
        if (target) {
            target.updateContent(data);
        }
    });

    const updateList = () => {
        const annotations: AnnotationData[] = annotationManager
            .getAllAnnotations()
            .map((a) => a.serialize());
        annotationUI.updateAnnotationList(annotations, annotationUI.getEditingAnnotationId());
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
    };

    events.on('annotation:created', updateList);
    events.on('annotation:deleted', updateList);
    events.on('annotation:selected', onAnnotationSelected);
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

    /** 切换模块时：进入标注模块默认选中第一个；离开时取消放置/编辑 */
    const onEditLeftModuleChanged = (newModule: string) => {
        if (newModule === 'annotation') {
            const all = annotationManager.getAllAnnotations();
            if (all.length > 0 && !annotationManager.getSelectedAnnotation()) {
                annotationManager.selectAnnotation(all[0].id);
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
                annotationManager.deselectAnnotation();
            }
            originalAnnotationDataForEdit = null;
            annotationUI.hideEditForm();
        }
        updateList();
    };
    events.on('editLeftModule:changed', onEditLeftModuleChanged);

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
        events.off('annotation:deselected', onAnnotationDeselected);
        events.off('annotation:place', onAnnotationPlaceWithHint);
        events.off('annotationPlacement:started', onPlacementStarted);
        events.off('annotationPlacement:ended', onPlacementEnded);
        events.off('annotationEdit:show', onAnnotationEditShow);
        events.off('controlsHidden:changed', onControlsHiddenChanged);
        events.off('editMode:changed', onEditModeChanged);
        events.off('editLeftModule:changed', onEditLeftModuleChanged);
        events.off('annotation.navigate', onAnnotationNavigate);
        annotationUI.destroy();
        annotationManager.destroy();
        delete (global as any).annotationManager;
    };
}
