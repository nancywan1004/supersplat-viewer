import type { Global } from './types';
import type { ExperienceSettings } from './schemas/v2';
import { serializeExperienceSettings, applySettingsSnapshot } from './settings-serialize';
import { clearScenePlacedEntities, restoreSceneAssetsFromSettings } from './asset-placement-handler';

export type EditSnapshot = ExperienceSettings;

const MAX_HISTORY = 20;

let undoStack: EditSnapshot[] = [];
let redoStack: EditSnapshot[] = [];
let isRestoring = false;
let undoSelectionStack: (string | null)[] = [];
let redoSelectionStack: (string | null)[] = [];

function cloneSnapshot(snapshot: EditSnapshot): EditSnapshot {
    return JSON.parse(JSON.stringify(snapshot)) as EditSnapshot;
}

function emitHistoryState(global: Global): void {
    global.events.fire('editHistory:stateChanged', {
        canUndo: canUndo(),
        canRedo: canRedo()
    });
}

export function initEditHistory(global: Global, initialSnapshot?: EditSnapshot): void {
    undoStack = [];
    redoStack = [];
    undoSelectionStack = [];
    redoSelectionStack = [];

    const base = initialSnapshot ? cloneSnapshot(initialSnapshot) : serializeExperienceSettings(global);
    const baseSelection = global.state.selectedSceneEntityId ?? null;
    undoStack.push(base);
    undoSelectionStack.push(baseSelection);
    emitHistoryState(global);
}

export function canUndo(): boolean {
    return !isRestoring && undoStack.length > 1;
}

export function canRedo(): boolean {
    return !isRestoring && redoStack.length > 0;
}

export async function restoreSnapshot(global: Global, snapshot: EditSnapshot): Promise<void> {
    if (isRestoring) return;

    isRestoring = true;
    global.events.fire('editHistory:restoring', true);
    try {
        applySettingsSnapshot(global, snapshot);
        clearScenePlacedEntities(global);
        await restoreSceneAssetsFromSettings(global);
    } finally {
        isRestoring = false;
        global.events.fire('editHistory:restoring', false);
        emitHistoryState(global);
    }
}

export function pushEditHistory(global: Global, _label?: string): void {
    if (isRestoring) return;

    const snapshot = serializeExperienceSettings(global);
    undoStack.push(snapshot);
    redoStack = [];
    undoSelectionStack.push(global.state.selectedSceneEntityId ?? null);
    redoSelectionStack = [];

    if (undoStack.length > MAX_HISTORY) {
        undoStack.shift();
        undoSelectionStack.shift();
    }

    emitHistoryState(global);
}

function restoreSelectionForSnapshot(global: Global, selectionId: string | null): void {
    const { state, events } = global;
    const list = state.scenePlacedEntities ?? [];

    if (selectionId && list.some((entry) => entry.id === selectionId)) {
        state.selectedSceneEntityId = selectionId;
        events.fire('sceneAsset:selected');
        return;
    }

    if (state.selectedSceneEntityId) {
        state.selectedSceneEntityId = null;
        events.fire('sceneAsset:selected');
    }
}

export async function undo(global: Global): Promise<void> {
    if (!canUndo()) return;

    const current = undoStack.pop();
    const currentSelection = undoSelectionStack.pop();
    if (!current) return;

    redoStack.push(current);
    redoSelectionStack.push(currentSelection ?? null);
    const target = undoStack[undoStack.length - 1];
    const targetSelection = undoSelectionStack[undoStack.length - 1] ?? null;
    await restoreSnapshot(global, target);
    restoreSelectionForSnapshot(global, targetSelection);
}

export async function redo(global: Global): Promise<void> {
    if (!canRedo()) return;

    const snapshot = redoStack.pop();
    const selectionId = redoSelectionStack.pop();
    if (!snapshot) return;

    undoStack.push(snapshot);
    undoSelectionStack.push(selectionId ?? null);
    await restoreSnapshot(global, snapshot);
    restoreSelectionForSnapshot(global, selectionId ?? null);
}

