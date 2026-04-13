/**
 * Transform Gizmo 与底部工具栏、选中实体联动。
 * 若 playcanvas 提供 Gizmo 类（如使用 engine 源码构建），则使用官方 Gizmo；
 * 否则无 Gizmo 显示（npm 包未导出 Gizmo）。
 */
import * as pc from 'playcanvas';
import type { AppBase } from 'playcanvas';
import type { Global } from './types';
import type { AssetTransformMode, LightTransformMode } from './types';
import { getSelectedSceneEntity } from './state-selectors';
import { pushEditHistory } from './edit-history';
import { updatePointLightsFromSettings } from './light';

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

type RotateGizmoShape = 'x' | 'y' | 'z' | 'xyz' | 'face';
const ALL_ROTATE_GIZMO_SHAPES: RotateGizmoShape[] = ['x', 'y', 'z', 'xyz', 'face'];
const SPOT_LIGHT_ROTATE_SHAPES: ReadonlySet<RotateGizmoShape> = new Set<RotateGizmoShape>(['x', 'y']);

/**
 * 初始化 Gizmo：监听 assetTransformMode:changed 与 sceneAsset:selected，
 * 在编辑模式下对选中实体显示变换 Gizmo（若可用），否则提供简单拖拽平移。
 */
export function initGizmoHandler(global: Global): () => void {
    const { app, state, events, camera } = global;
    const api = getGizmoAPI();
    let gizmoPointerLocked = false;

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

                    // 资产模式：记录资产变换历史
                    if (state.editMode && state.selectedSceneEntityId && handler && handler._nodes.length > 0 && state.editLeftModule === 'asset') {
                        pushEditHistory(global, 'transform asset');
                    }

                    // 光源模式：将 Gizmo 上的变换回写到 settings.lighting，并刷新光源实体
                    if (state.editMode && state.editLeftModule === 'environment' && handler && handler._nodes.length > 0) {
                        let changed = false;
                        handler._nodes.forEach((node: any) => {
                            const cfg = (node as any).__lightConfig as any | undefined;
                            if (!cfg) return;
                            const pos = node.getPosition?.();
                            if (pos) {
                                cfg.position = [pos.x, pos.y, pos.z];
                            }
                            if ((cfg as any).type === 'spot') {
                                const euler = node.getEulerAngles?.();
                                if (euler) {
                                    const pitch = euler.x ?? 0;
                                    let yaw = euler.y ?? 0;
                                    // yaw 仅做等价归一化，不限制旋转自由度
                                    yaw = ((yaw % 360) + 360) % 360;
                                    (cfg as any).pitch = pitch;
                                    (cfg as any).yaw = yaw;
                                }
                            }
                            changed = true;
                        });
                        if (changed) {
                            updatePointLightsFromSettings(global);
                            events.fire('lighting:changed');
                            pushEditHistory(global, 'transform light');
                        }
                    }
                });
            });

            // 兜底：异常情况下若没有收到 transform:end，松开左键时回收锁
            const onWindowPointerUp = (ev: PointerEvent) => {
                if (ev.button !== 0 || !gizmoPointerLocked) return;
                gizmoPointerLocked = false;
                events.fire('cameraControls:flushInputs');
                state.cameraControlsEnabled = true;
            };
            window.addEventListener('pointerup', onWindowPointerUp, true);
            window.addEventListener('pointercancel', onWindowPointerUp as any, true);
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
                    gizmoPointerLocked = false;
                    window.removeEventListener('pointerup', onWindowPointerUp, true);
                    window.removeEventListener('pointercancel', onWindowPointerUp as any, true);
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

    const findSelectedLightEntity = (): any | null => {
        const id = state.selectedLightId;
        if (!id) return null;
        const pointContainer = app.root.findByName('pointLights') as any;
        if (pointContainer) {
            for (let i = 0; i < pointContainer.children.length; i++) {
                const e = pointContainer.children[i];
                const cfg = (e as any).__lightConfig as any | undefined;
                if (cfg && cfg.id === id) return e;
            }
        }
        const spotContainer = app.root.findByName('spotLights') as any;
        if (spotContainer) {
            for (let i = 0; i < spotContainer.children.length; i++) {
                const e = spotContainer.children[i];
                const cfg = (e as any).__lightConfig as any | undefined;
                if (cfg && cfg.id === id) return e;
            }
        }
        return null;
    };

    const applyRotateGizmoShapePolicy = (enabledShapes: ReadonlySet<RotateGizmoShape>): void => {
        if (!handler) return;
        const rotateGizmo = (handler._gizmos as any)?.rotate;
        if (!rotateGizmo || typeof rotateGizmo.enableShape !== 'function') return;

        for (const shape of ALL_ROTATE_GIZMO_SHAPES) {
            rotateGizmo.enableShape(shape, enabledShapes.has(shape));
        }
    };

    const resolveRotateGizmoEnabledShapes = (context: {
        gizmoType: string | null;
        lightMode: LightTransformMode | undefined;
        lightEntity: any | null;
    }): ReadonlySet<RotateGizmoShape> => {
        const { gizmoType, lightMode, lightEntity } = context;
        if (gizmoType !== 'rotate') return new Set<RotateGizmoShape>(ALL_ROTATE_GIZMO_SHAPES);

        const isSpotLightRotate = lightMode === 'rotate' && (lightEntity as any)?.__lightConfig?.type === 'spot';
        if (isSpotLightRotate) {
            // 聚光灯旋转仅保留 yaw(y) + pitch(x)，不开放 roll(z)/自由旋转。
            return SPOT_LIGHT_ROTATE_SHAPES;
        }

        return new Set<RotateGizmoShape>(ALL_ROTATE_GIZMO_SHAPES);
    };

    const syncGizmoToSelection = () => {
        if (!handler) return;

        let targetNode: any | null = null;
        let gizmoType: string | null = null;
        let selectedLightEntity: any | null = null;

        // 资产模式
        const inAssetModule = state.editLeftModule === 'asset';
        const assetMode = state.assetTransformMode;
        const showAssetGizmo =
            inAssetModule &&
            (assetMode === 'move' || assetMode === 'rotate' || assetMode === 'scale');
        if (showAssetGizmo) {
            const entity = getSelectedSceneEntity(state);
            if (entity) {
                targetNode = entity;
                gizmoType = MODE_TO_GIZMO_TYPE[assetMode!];
            }
        }

        // 光源模式（环境模块）
        const inEnvModule = state.editLeftModule === 'environment';
        const lightMode = state.lightTransformMode as LightTransformMode | undefined;
        if (!targetNode && inEnvModule && (lightMode === 'move' || lightMode === 'rotate') && state.selectedLightId) {
            const lightEntity = findSelectedLightEntity();
            if (lightEntity) {
                selectedLightEntity = lightEntity;
                targetNode = lightEntity;
                gizmoType = lightMode === 'move' ? 'translate' : 'rotate';
            }
        }

        applyRotateGizmoShapePolicy(resolveRotateGizmoEnabledShapes({
            gizmoType,
            lightMode,
            lightEntity: selectedLightEntity
        }));

        if (targetNode && gizmoType) {
            handler.add(targetNode, true);
            handler.switch(gizmoType);
        } else {
            handler.clear();
        }
    };

    const onModeChanged = (_mode: AssetTransformMode | undefined) => {
        if (state.editLeftModule !== 'asset') return;
        // 始终走完整同步：确保先 handler.add(entity) 再 switch(type)，避免初始默认选中后首次点「移动」时 _nodes 为空导致 Gizmo 不显示
        syncGizmoToSelection();
    };

    const onSelectionChanged = () => syncGizmoToSelection();

    const onEditLeftModuleChanged = () => syncGizmoToSelection();

    const onLightModeChanged = (_mode: LightTransformMode | undefined | null) => {
        if (state.editLeftModule !== 'environment') return;
        syncGizmoToSelection();
    };

    const onSceneLightSelected = () => {
        if (state.editLeftModule !== 'environment') return;
        syncGizmoToSelection();
    };

    /** 退出编辑模式时隐藏 Gizmo；进入编辑模式且当前为资产模块时若无选中则默认选首 entity（与切换进资产模块行为一致） */
    const onEditModeChanged = (inEdit: boolean) => {
        if (!handler) return;
        if (!inEdit) {
            handler.clear();
            return;
        }
        // 资产默认选中策略已由 AssetFacade.onEnter 统一管理，Gizmo 仅做显示同步。
        syncGizmoToSelection();
    };

    events.on('assetTransformMode:changed', onModeChanged);
    events.on('sceneAsset:selected', onSelectionChanged);
    events.on('editLeftModule:changed', onEditLeftModuleChanged);
    events.on('editMode:changed', onEditModeChanged);
    events.on('lightTransformMode:changed', onLightModeChanged as any);
    events.on('sceneLight:selected', onSceneLightSelected as any);
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
        events.off('editLeftModule:changed', onEditLeftModuleChanged);
        events.off('editMode:changed', onEditModeChanged);
        events.off('lightTransformMode:changed', onLightModeChanged as any);
        events.off('sceneLight:selected', onSceneLightSelected as any);
        app.off('update', onUpdate);
        handler?.destroy();
    };
}
