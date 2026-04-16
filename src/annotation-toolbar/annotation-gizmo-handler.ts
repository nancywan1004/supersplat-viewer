/**
 * Annotation Gizmo Handler
 * 
 * 处理标注实体的 Transform Gizmo 集成：
 * - 监听 gizmo:attach 和 gizmo:detach 事件
 * - 激活/禁用 Transform Gizmo
 * - 管理相机控制的启用/禁用
 * - 处理标注移动事件
 */

import * as pc from 'playcanvas';
import type { AppBase, Vec3 } from 'playcanvas';
import type { Global } from '../types';
import { isAnnotationDebugVisualEnabled } from '../state-selectors';

/**
 * 获取 PlayCanvas Gizmo API
 * 
 * @returns Gizmo API 对象，如果不可用则返回 null
 */
function getGizmoAPI(): {
    Gizmo: { createLayer: (app: AppBase) => any };
    TranslateGizmo: new (camera: any, layer: any) => any;
} | null {
    const p = pc as any;
    if (p.Gizmo?.createLayer && p.TranslateGizmo) {
        return {
            Gizmo: p.Gizmo,
            TranslateGizmo: p.TranslateGizmo
        };
    }
    return null;
}

/**
 * Gizmo 处理器接口
 */
interface GizmoHandler {
    attach: (entity: any, onMove?: (position: Vec3) => void) => void;
    detach: () => void;
    destroy: () => void;
}

/**
 * 初始化标注 Gizmo 处理器
 * 
 * @param global - Global 引用
 * @returns 清理函数
 */
export function initAnnotationGizmoHandler(global: Global): () => void {
    const { app, events, camera, state } = global;
    const api = getGizmoAPI();

    let handler: GizmoHandler | null = null;
    let currentOnMove: ((position: Vec3) => void) | null = null;
    let attachedEntity: any = null;

    // 尝试创建 Gizmo 处理器
    if (api) {
        try {
            const layer = api.Gizmo.createLayer(app);
            const cameraComp = camera.camera;
            const translateGizmo = new api.TranslateGizmo(cameraComp, layer);

            // 绑定 pointer 事件：拖拽时禁用相机控制
            translateGizmo.on('pointer:down', (_x: number, _y: number, meshInstance: any) => {
                if (meshInstance) {
                    // 关闭相机输入
                    state.cameraControlsEnabled = false;
                }
            });

            translateGizmo.on('pointer:up', () => {
                // 清空相机输入增量，再重新开启相机控制
                events.fire('cameraControls:flushInputs');
                state.cameraControlsEnabled = true;

                // 触发标注移动完成事件
                if (attachedEntity && currentOnMove) {
                    const position = attachedEntity.getPosition();
                    events.fire('annotation:moveComplete', {
                        entity: attachedEntity,
                        position
                    });
                }
            });

            handler = {
                attach(entity: any, onMove?: (position: Vec3) => void) {
                    attachedEntity = entity;
                    currentOnMove = onMove || null;
                    translateGizmo.attach([entity]);

                    // 禁用相机控制（在 Gizmo 激活期间）
                    // 注意：这里不立即禁用，只在拖拽时禁用（见 pointer:down）
                },
                detach() {
                    translateGizmo.detach();
                    attachedEntity = null;
                    currentOnMove = null;

                    // 确保相机控制被重新启用
                    state.cameraControlsEnabled = true;
                },
                destroy() {
                    translateGizmo.destroy();
                }
            };

            // 每帧更新 Gizmo
            const onUpdate = () => {
                if (attachedEntity && translateGizmo.update) {
                    translateGizmo.update();

                    // 如果有 onMove 回调，实时更新位置
                    if (currentOnMove) {
                        const position = attachedEntity.getPosition();
                        currentOnMove(position);
                    }
                }
            };
            app.on('update', onUpdate);

            // 清理函数
            const cleanup = () => {
                app.off('update', onUpdate);
                handler?.destroy();
            };

            // 返回清理函数（稍后会被覆盖）
            handler.destroy = cleanup;
        } catch (e) {
            console.warn('[AnnotationGizmo] Failed to create PlayCanvas Gizmo:', e);
            handler = null;
        }
    }

    // 监听 gizmo:attach 事件
    const onGizmoAttach = (data: { entity: any; onMove?: (position: Vec3) => void }) => {
        if (!handler) {
            console.warn('[AnnotationGizmo] Gizmo API not available');
            return;
        }
        if (!isAnnotationDebugVisualEnabled(state)) {
            return;
        }

        handler.attach(data.entity, data.onMove);
    };

    // 监听 gizmo:detach 事件
    const onGizmoDetach = () => {
        if (!handler) {
            return;
        }

        handler.detach();
    };

    const onPreviewContextChanged = () => {
        if (!handler) return;
        if (!isAnnotationDebugVisualEnabled(state)) {
            handler.detach();
        }
    };

    events.on('gizmo:attach', onGizmoAttach);
    events.on('gizmo:detach', onGizmoDetach);
    events.on('previewMode:changed', onPreviewContextChanged);
    events.on('editLeftModule:changed', onPreviewContextChanged);
    events.on('editMode:changed', onPreviewContextChanged);

    // 返回清理函数
    return () => {
        events.off('gizmo:attach', onGizmoAttach);
        events.off('gizmo:detach', onGizmoDetach);
        events.off('previewMode:changed', onPreviewContextChanged);
        events.off('editLeftModule:changed', onPreviewContextChanged);
        events.off('editMode:changed', onPreviewContextChanged);
        handler?.destroy();
    };
}
