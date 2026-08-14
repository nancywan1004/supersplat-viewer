import type { AnnotationManager } from './annotation-manager';
import type { ExperienceSettings } from '../schemas/v2';
import type { Global } from '../types';
import { writeSessionAnnotationVisible } from '../view-settings';

/** 单条标注 settings 显隐，缺省 true */
export function readAnnotationVisibleFromSettings(
    settings: ExperienceSettings,
    id: string
): boolean {
    const ann = settings.annotations?.find((a) => a.id === id);
    return ann?.visible !== false;
}

/**
 * `ANNOTATION_SHOW_HIDE_SET`：Edit 写 settings；Viewer 只写会话 overlay。
 * @returns 是否发生变更
 */
export function applyAnnotationShowHideSet(
    global: Global,
    id: string,
    visible: boolean
): boolean {
    const next = !!visible;
    if (global.state?.editMode === true) {
        const es = global.settings as ExperienceSettings;
        const ann = es.annotations?.find((a) => a.id === id);
        if (!ann) return false;
        const prev = ann.visible !== false;
        if (prev === next) return false;
        ann.visible = next;
        getAnnotationManager(global)?.setAnnotationVisible(id, next);
        global.events.fire('annotationVisibility:changed', { id, visible: next });
        return true;
    }
    const changed = writeSessionAnnotationVisible(global, id, next);
    getAnnotationManager(global)?.applyVisibilityFromSettings();
    if (changed) {
        global.events.fire('annotationVisibility:changed', { id, visible: next });
    }
    return changed;
}

/** 按 settings 中各条 `visible` + 会话 overlay 恢复运行态（编辑态由 AnnotationManager 忽略 overlay） */
export function applyAllAnnotationsVisibilityFromSettings(global: Global): void {
    getAnnotationManager(global)?.applyVisibilityFromSettings();
}

function getAnnotationManager(global: Global): AnnotationManager | undefined {
    return (global as { annotationManager?: AnnotationManager }).annotationManager;
}
