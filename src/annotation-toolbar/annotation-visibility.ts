import type { AnnotationManager } from './annotation-manager';
import type { ExperienceSettings } from '../schemas/v2';
import type { Global } from '../types';

/** 单条标注 settings 显隐，缺省 true */
export function readAnnotationVisibleFromSettings(
    settings: ExperienceSettings,
    id: string
): boolean {
    const ann = settings.annotations?.find((a) => a.id === id);
    return ann?.visible !== false;
}

/**
 * `ANNOTATION_SHOW_HIDE_SET`：写入 settings 并同步运行态。
 * @returns 是否发生变更
 */
export function applyAnnotationShowHideSet(
    global: Global,
    id: string,
    visible: boolean
): boolean {
    const es = global.settings as ExperienceSettings;
    const ann = es.annotations?.find((a) => a.id === id);
    if (!ann) return false;

    const next = !!visible;
    const prev = ann.visible !== false;
    if (prev === next) return false;

    ann.visible = next;
    getAnnotationManager(global)?.setAnnotationVisible(id, next);
    global.events.fire('annotationVisibility:changed', { id, visible: next });
    return true;
}

/** 按 settings 中各条 `visible` 恢复运行态（编辑模式跳过） */
export function applyAllAnnotationsVisibilityFromSettings(global: Global): void {
    if (global.state.editMode) return;
    getAnnotationManager(global)?.applyVisibilityFromSettings();
}

function getAnnotationManager(global: Global): AnnotationManager | undefined {
    return (global as { annotationManager?: AnnotationManager }).annotationManager;
}
