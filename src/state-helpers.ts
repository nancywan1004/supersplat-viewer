import type { State } from './types';
import type { Entity } from 'playcanvas';

/** 根据 state.selectedSceneEntityId 从 scenePlacedEntities 中取当前选中的实体 */
export function getSelectedSceneEntity(state: State): Entity | null {
    const id = state.selectedSceneEntityId;
    if (!id) return null;
    const list = state.scenePlacedEntities ?? [];
    const entry = list.find((e) => e.id === id);
    return entry?.entity ?? null;
}
