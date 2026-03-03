/**
 * Transform Gizmo 与底部工具栏、选中实体联动。
 * 若 playcanvas 提供 Gizmo 类（如使用 engine 源码构建），则使用官方 Gizmo；
 * 否则无 Gizmo 显示（npm 包未导出 Gizmo）。
 */
import * as pc from 'playcanvas';
import type { AppBase } from 'playcanvas';
import type { Global } from './types';
import type { AssetTransformMode } from './types';
import { getSelectedSceneEntity } from './state-helpers';
import { pushEditHistory } from './edit-history';

function getGizmoAPI(): {
    Gizmo: { createLayer: (app: AppBase) => any };
    TranslateGizmo: new (camera: any, layer: any) => any;
    RotateGizmo: new (camera: any, layer: any) => any;
    ScaleGizmo: new (camera: any, layer: any) => any;
} | null {
    const p = pc as any;
    if (
        p.Gizmo?.createLayer &&
        p.TranslateGizmo &&
        p.RotateGizmo &&
        p.ScaleGizmo
    ) {
        return {
            Gizmo: p.Gizmo,
            TranslateGizmo: p.TranslateGizmo,
            RotateGizmo: p.RotateGizmo,
            ScaleGizmo: p.ScaleGizmo
        };
    }
    return null;
}

const MODE_TO_GIZMO_TYPE: Record<AssetTransformMode, string> = {
    move: 'translate',
    rotate: 'rotate',
    scale: 'scale'
};

/**
 * 初始化 Gizmo：监听 assetTransformMode:changed 与 sceneAsset:selected，
 * 在编辑模式下对选中实体显示变换 Gizmo（若可用），否则提供简单拖拽平移。
 */
export function initGizmoHandler(global: Global): () => void {
    const { app, state, events, camera } = global;
    const api = getGizmoAPI();

    let handler: {
        _gizmos: Record<string, any>;
        _nodes: any[];
        _type: string;
        gizmo: any;
        add: (node: any, clear?: boolean) => void;
        clear: () => void;
        switch: (type: string) => void;
        destroy: () => void;
    } | null = null;

    if (api) {
        try {
            const layer = api.Gizmo.createLayer(app);
            const cameraComp = camera.camera;
            const _gizmos: { [key: string]: any } = {
                translate: new api.TranslateGizmo(cameraComp, layer),
                rotate: new api.RotateGizmo(cameraComp, layer),
                scale: new api.ScaleGizmo(cameraComp, layer)
            };

            // 绑定 pointer 事件：当 Gizmo 被拖拽时临时关闭相机控制，避免两边同时处理同一批输入事件
            Object.values(_gizmos).forEach((gizmo: any) => {
                gizmo.on('pointer:down', (_x: number, _y: number, meshInstance: any) => {
                    if (meshInstance) {
                        // 命中 Gizmo 句柄，关闭相机输入
                        state.cameraControlsEnabled = false;
                    }
                });
                gizmo.on('pointer:up', () => {
                    // 结束拖拽后，先清空一次相机输入增量，再重新开启相机控制，避免「松手瞬间相机跳一下」
                    events.fire('cameraControls:flushInputs');
                    state.cameraControlsEnabled = true;
                    if (state.editMode && state.selectedSceneEntityId && handler && handler._nodes.length > 0) {
                        pushEditHistory(global, 'transform asset');
                    }
                });
            });
            let _type = 'translate';
            const _nodes: any[] = [];
            handler = {
                _gizmos,
                _nodes,
                get _type() {
                    return _type;
                },
                get gizmo() {
                    return _gizmos[_type] ?? _gizmos.translate;
                },
                add(node: any, clear = false) {
                    if (clear) _nodes.length = 0;
                    if (_nodes.indexOf(node) === -1) _nodes.push(node);
                    (handler!.gizmo as any).attach(_nodes);
                },
                clear() {
                    _nodes.length = 0;
                    (handler!.gizmo as any).detach();
                },
                switch(type: string) {
                    (handler!.gizmo as any).detach();
                    const coordSpace = (handler!.gizmo as any).coordSpace;
                    _type = type ?? 'translate';
                    const g = _gizmos[_type] ?? _gizmos.translate;
                    g.attach(_nodes);
                    g.coordSpace = coordSpace;
                },
                destroy() {
                    for (const k of Object.keys(_gizmos)) {
                        _gizmos[k].destroy();
                    }
                }
            };
        } catch (e) {
            console.warn('[Gizmo] Failed to create PlayCanvas Gizmo, using fallback:', e);
            handler = null;
        }
    }

    const syncGizmoToSelection = () => {
        const entity = getSelectedSceneEntity(state);
        if (handler) {
            if (entity) {
                handler.add(entity, true);
                const type = MODE_TO_GIZMO_TYPE[state.assetTransformMode ?? 'move'];
                handler.switch(type);
            } else {
                handler.clear();
            }
        }
    };

    const onModeChanged = (_mode: AssetTransformMode) => {
        if (handler && getSelectedSceneEntity(state)) {
            const type = MODE_TO_GIZMO_TYPE[state.assetTransformMode ?? 'move'];
            handler.switch(type);
        }
    };

    const onSelectionChanged = () => syncGizmoToSelection();

    /** 退出编辑模式时隐藏 Gizmo；进入编辑模式时若无选中则默认选场景列表第一项并同步 Gizmo */
    const onEditModeChanged = (inEdit: boolean) => {
        if (!handler) return;
        if (!inEdit) {
            handler.clear();
            return;
        }
        const entity = getSelectedSceneEntity(state);
        const list = state.scenePlacedEntities ?? [];
        if (!entity && list.length > 0) {
            state.selectedSceneEntityId = list[0].id;
            events.fire('sceneAsset:selected');
        }
        syncGizmoToSelection();
    };

    events.on('assetTransformMode:changed', onModeChanged);
    events.on('sceneAsset:selected', onSelectionChanged);
    events.on('editMode:changed', onEditModeChanged);
    if (state.editMode) {
        onEditModeChanged(true);
    } else if (handler) {
        handler.clear();
    }

    // 每帧更新 Gizmo（官方 Gizmo 需要 update）
    const onUpdate = () => {
        if (!state.editMode) return;
        if (handler && handler._nodes.length > 0 && handler.gizmo?.update) {
            handler.gizmo.update();
        }
    };
    app.on('update', onUpdate);

    return () => {
        events.off('assetTransformMode:changed', onModeChanged);
        events.off('sceneAsset:selected', onSelectionChanged);
        events.off('editMode:changed', onEditModeChanged);
        app.off('update', onUpdate);
        handler?.destroy();
    };
}
