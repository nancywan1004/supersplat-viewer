import type { Global } from './types';
import type { ExperienceSettings } from './schemas/v2';
import { serializeExperienceSettings, applySettingsSnapshot } from './settings-serialize';
import { clearScenePlacedEntities, restoreSceneAssetsFromSettings } from './asset-placement-handler';
import type { AnnotationManager } from './annotation-toolbar/annotation-manager';
import { updatePointLightsFromSettings } from './light';

export type EditSnapshot = ExperienceSettings;

const MAX_HISTORY = 20;

let undoStack: EditSnapshot[] = [];
let redoStack: EditSnapshot[] = [];
let isRestoring = false;
let undoSelectionStack: (string | null)[] = [];
let redoSelectionStack: (string | null)[] = [];
let undoAnnotationSelectionStack: (string | null)[] = [];
let redoAnnotationSelectionStack: (string | null)[] = [];

function cloneSnapshot(snapshot: EditSnapshot): EditSnapshot {
    return JSON.parse(JSON.stringify(snapshot)) as EditSnapshot;
}

function isTrackEditHistoryEnabled(global: Global): boolean {
    return global.config.trackEditHistory === true;
}

function emitHistoryState(global: Global): void {
    global.events.fire('editHistory:stateChanged', {
        canUndo: canUndo(global),
        canRedo: canRedo(global)
    });
}

export function initEditHistory(global: Global, initialSnapshot?: EditSnapshot): void {
    undoStack = [];
    redoStack = [];
    undoSelectionStack = [];
    redoSelectionStack = [];
    undoAnnotationSelectionStack = [];
    redoAnnotationSelectionStack = [];

    if (!isTrackEditHistoryEnabled(global)) return;

    const base = initialSnapshot ? cloneSnapshot(initialSnapshot) : serializeExperienceSettings(global);
    const baseSelection = global.state.selectedSceneEntityId ?? null;
    const baseAnnotationSelection = global.state.selectedAnnotationId ?? null;
    undoStack.push(base);
    undoSelectionStack.push(baseSelection);
    undoAnnotationSelectionStack.push(baseAnnotationSelection);
    emitHistoryState(global);
}

export function canUndo(global?: Global): boolean {
    if (global && !isTrackEditHistoryEnabled(global)) return false;
    return !isRestoring && undoStack.length > 1;
}

export function canRedo(global?: Global): boolean {
    if (global && !isTrackEditHistoryEnabled(global)) return false;
    return !isRestoring && redoStack.length > 0;
}

/**
 * Restore annotations from settings
 * 
 * This function restores annotation entities from the global settings,
 * similar to how scene assets are restored.
 * 
 * @param global - Global reference
 */
export function restoreAnnotationsFromSettings(global: Global): void {
    // Get the annotation manager from the app
    const annotationManager = (global as any).annotationManager as AnnotationManager | undefined;
    
    if (!annotationManager) {
        // Annotation manager not initialized yet, skip restoration
        return;
    }
    
    // Load annotations from settings
    annotationManager.loadFromSettings();
}

/**
 * 根据当前 settings 恢复灯光 / 场景整体亮度的运行时状态：
 * - 点光 / 聚光灯：从 settings.lighting 重新推入运行时；
 * - NightMode：按 nightMode.fade 重置整体亮度与天空盒；
 * - 触发 lighting:changed，驱动相关监听方重新应用配置。
 */
export function restoreLightingFromSettings(global: Global): void {
    const settings = global.settings as ExperienceSettings;

    try {
        updatePointLightsFromSettings(global);
    } catch {
        // ignore
    }

    try {
        const nm = settings.nightMode as { fade?: number } | undefined;
        const rawFade = nm && typeof nm.fade === 'number' && Number.isFinite(nm.fade) ? nm.fade : 0;
        const fade = Math.max(-1, Math.min(1, rawFade));
        // 与 VFX 结束恢复一致：forceReapply 会清 materialsApplied 并跑 updateEffect，避免仅 nightFade:set 时材质状态与主光/天空盒不同步
        (global.app as any).fire?.('nightMode:forceReapply', fade);
    } catch {
        // ignore
    }

    global.events.fire('lighting:changed');
}

/**
 * 通知后处理管线（Bloom / Shadow / Grading 等）根据当前 settings 重新配置：
 * - postEffect:changed：BloomController / Shadow 等按 settings 重建体积 / 阴影；
 * - bloomLocalLightRegion:listChanged：局部亮灯区域列表与体积按 settings 重新同步。
 */
export function restorePostEffectsFromSettings(global: Global): void {
    global.events.fire('postEffect:changed');
    global.events.fire('bloomLocalLightRegion:listChanged');
}

export async function restoreSnapshot(global: Global, snapshot: EditSnapshot): Promise<void> {
    if (isRestoring) return;

    isRestoring = true;
    global.events.fire('editHistory:restoring', true);
    try {
        applySettingsSnapshot(global, snapshot);
        clearScenePlacedEntities(global);
        await restoreSceneAssetsFromSettings(global);
        // Restore annotations from the snapshot
        restoreAnnotationsFromSettings(global);
        // Restore lighting / night mode / post effects from the snapshot
        restoreLightingFromSettings(global);
        restorePostEffectsFromSettings(global);
    } finally {
        isRestoring = false;
        global.events.fire('editHistory:restoring', false);
        emitHistoryState(global);
    }
}

export function pushEditHistory(global: Global, _label?: string): void {
    if (isRestoring) return;
    if (!isTrackEditHistoryEnabled(global)) return;

    const snapshot = serializeExperienceSettings(global);
    undoStack.push(snapshot);
    redoStack = [];
    undoSelectionStack.push(global.state.selectedSceneEntityId ?? null);
    undoAnnotationSelectionStack.push(global.state.selectedAnnotationId ?? null);
    redoSelectionStack = [];
    redoAnnotationSelectionStack = [];

    if (undoStack.length > MAX_HISTORY) {
        undoStack.shift();
        undoSelectionStack.shift();
        undoAnnotationSelectionStack.shift();
    }

    emitHistoryState(global);
}

function restoreSelectionForSnapshot(global: Global, selectionId: string | null, annotationSelectionId: string | null): void {
    const { state, events } = global;
    const list = state.scenePlacedEntities ?? [];

    // Restore scene entity selection
    if (selectionId && list.some((entry) => entry.id === selectionId)) {
        state.selectedSceneEntityId = selectionId;
        events.fire('sceneAsset:selected');
    } else if (state.selectedSceneEntityId) {
        state.selectedSceneEntityId = null;
        events.fire('sceneAsset:selected');
    }

    // Restore annotation selection
    const annotations = global.settings?.annotations ?? [];
    if (annotationSelectionId && annotations.some((ann) => ann.id === annotationSelectionId)) {
        state.selectedAnnotationId = annotationSelectionId;
        
        // Get the annotation manager and select the annotation
        const annotationManager = (global as any).annotationManager as AnnotationManager | undefined;
        if (annotationManager) {
            annotationManager.selectAnnotation(annotationSelectionId);
        }
    } else if (state.selectedAnnotationId) {
        state.selectedAnnotationId = null;
        
        // Deselect annotation
        const annotationManager = (global as any).annotationManager as AnnotationManager | undefined;
        if (annotationManager) {
            annotationManager.deselectAnnotation();
        }
    }
}

export async function undo(global: Global): Promise<void> {
    if (!isTrackEditHistoryEnabled(global)) return;
    if (!canUndo(global)) return;

    const current = undoStack.pop();
    const currentSelection = undoSelectionStack.pop();
    const currentAnnotationSelection = undoAnnotationSelectionStack.pop();
    if (!current) return;

    redoStack.push(current);
    redoSelectionStack.push(currentSelection ?? null);
    redoAnnotationSelectionStack.push(currentAnnotationSelection ?? null);
    
    const target = undoStack[undoStack.length - 1];
    const targetSelection = undoSelectionStack[undoStack.length - 1] ?? null;
    const targetAnnotationSelection = undoAnnotationSelectionStack[undoStack.length - 1] ?? null;
    
    await restoreSnapshot(global, target);
    restoreSelectionForSnapshot(global, targetSelection, targetAnnotationSelection);
}

export async function redo(global: Global): Promise<void> {
    if (!isTrackEditHistoryEnabled(global)) return;
    if (!canRedo(global)) return;

    const snapshot = redoStack.pop();
    const selectionId = redoSelectionStack.pop();
    const annotationSelectionId = redoAnnotationSelectionStack.pop();
    if (!snapshot) return;

    undoStack.push(snapshot);
    undoSelectionStack.push(selectionId ?? null);
    undoAnnotationSelectionStack.push(annotationSelectionId ?? null);
    
    await restoreSnapshot(global, snapshot);
    restoreSelectionForSnapshot(global, selectionId ?? null, annotationSelectionId ?? null);
}

