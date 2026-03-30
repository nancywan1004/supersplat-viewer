import { Annotation } from '../annotation';
import { AnnotationManager } from './annotation-manager';
import type { Global } from '../types';

/**
 * 初始化“可交互标注系统”（AnnotationManager + AnnotationEntity），但不依赖编辑 UI 面板。
 * - showEditUI=false 时也能正常渲染热点/tooltip/收起标题等交互
 * - 仅负责逻辑与实体初始化；编辑面板 UI 仍由 src/ui/components/annotation-ui.ts 管理
 */
export function initAnnotationSystem(global: Global): () => void {
    // 若已存在（例如 showEditUI=true 时 annotation-ui 已创建），直接复用
    const g: any = global as any;
    if (g.annotationManager) return () => {};

    // 确保 annotations 父容器存在（供 AnnotationEntity 的 hotspot/tooltip DOM 挂载）
    const uiEl = document.getElementById('ui');
    if (uiEl && !document.getElementById('annotations')) {
        const parentDom = document.createElement('div');
        parentDom.id = 'annotations';
        Annotation.parentDom = parentDom;
        uiEl.appendChild(parentDom);
    }

    // 创建并挂到 global，供 edit-history / message-bridge / 其他模块复用
    const manager = new AnnotationManager(global);
    g.annotationManager = manager;

    // 兜底：Annotation 系统自身不依赖 annotation-ui 的挂载时序。
    // 避免父级通过 EDIT_MODULE_SET 从 annotation 切到其他模式时：
    // - selectedAnnotationId 未清理
    // - annotation 的 transform gizmo 残留
    const onEditModeChanged = (inEdit: boolean) => {
        if (!inEdit) {
            // 即使 selection state 已经丢失，也强制解绑 gizmo
            global.events.fire('gizmo:detach');
            manager.deselectAnnotation();
        }
    };

    const onEditLeftModuleChanged = (newModule: string | null) => {
        if (newModule !== 'annotation') {
            global.events.fire('gizmo:detach');
            manager.deselectAnnotation();
        }
    };

    global.events.on('editMode:changed', onEditModeChanged as any);
    global.events.on('editLeftModule:changed', onEditLeftModuleChanged as any);

    return () => {
        global.events.off('editMode:changed', onEditModeChanged as any);
        global.events.off('editLeftModule:changed', onEditLeftModuleChanged as any);
    };
}

