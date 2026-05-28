/**
 * Transform Gizmo 与底部工具栏、选中实体联动。
 * 若 playcanvas 提供 Gizmo 类（如使用 engine 源码构建），则使用官方 Gizmo；
 * 否则无 Gizmo 显示（npm 包未导出 Gizmo）。
 */
import * as pc from 'playcanvas';
import type { AppBase } from 'playcanvas';
import type { Global } from './types';
import type { AssetTransformMode, LightTransformMode } from './types';
import {
    getSelectedSceneEntity,
    isAssetDebugVisualEnabled,
    isEnvironmentDebugVisualEnabled
} from './state-selectors';
import { setSceneGizmoHitTest } from './gizmo-hit-test';
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
const SPOT_ROTATE_EPSILON = 1e-5;
const SPOT_AXIS_HYSTERESIS = 0.15; // 滞回阈值，防止边界抖动
const SPOT_YAW_JUMP_GUARD_DEG = 60;
const SPOT_YAW_GUARD_HORIZONTAL_EPS = 0.12;

type SpotPitchAxis = 'x' | 'z';

type SpotRotateAxis = 'x' | 'y' | 'z';
type SpotRotateState = {
    node: any;
    axis: SpotRotateAxis;
    startPitch: number;
    startYaw: number;
    currentPitch: number;
    currentYaw: number;
    changed: boolean;
};

const normalizeYawDegrees = (yaw: number): number => ((yaw % 360) + 360) % 360;
const SCALE_EPSILON = 1e-6;
const shortestAngleDeltaDegrees = (fromDeg: number, toDeg: number): number => {
    let delta = normalizeYawDegrees(toDeg) - normalizeYawDegrees(fromDeg);
    if (delta > 180) delta -= 360;
    if (delta < -180) delta += 360;
    return delta;
};

const getSpotDirectionFromNode = (node: any): pc.Vec3 | null => {
    const wt = node?.getWorldTransform?.();
    if (!wt?.getY) return null;
    const yAxis = wt.getY(new pc.Vec3());
    return new pc.Vec3(-yAxis.x, -yAxis.y, -yAxis.z).normalize();
};

const getSpotYawFromWorldXAxis = (node: any, fallbackYaw: number): number => {
    const wt = node?.getWorldTransform?.();
    if (!wt?.getX) return normalizeYawDegrees(fallbackYaw);
    const xAxis = wt.getX(new pc.Vec3());
    const planarLength = Math.hypot(xAxis.x, xAxis.z);
    if (planarLength < SPOT_ROTATE_EPSILON) return normalizeYawDegrees(fallbackYaw);
    return normalizeYawDegrees(Math.atan2(-xAxis.z, xAxis.x) * pc.math.RAD_TO_DEG);
};

/**
 * 从节点的照射方向计算 yaw（通用方法）
 * 照射方向是局部 -Y 的世界方向
 * yaw = atan2(direction.x, direction.z)
 */
/**
 * 从照射方向计算 yaw，保持连续性（避免 180° 跳变）
 */
const getSpotYawFromDirection = (node: any, fallbackYaw: number): number => {
    const direction = getSpotDirectionFromNode(node);
    if (!direction) return normalizeYawDegrees(fallbackYaw);

    const horizontalLen = Math.hypot(direction.x, direction.z);
    if (horizontalLen < SPOT_ROTATE_EPSILON) return normalizeYawDegrees(fallbackYaw);

    // 计算 raw yaw
    const rawYaw = Math.atan2(direction.x, direction.z) * pc.math.RAD_TO_DEG;

    // 归一化到 [0, 360)
    const normalizedRaw = normalizeYawDegrees(rawYaw);
    const normalizedFallback = normalizeYawDegrees(fallbackYaw);

    // 选择最接近 fallback 的等价值（避免 180° 跳变）
    // atan2 返回 [-180, 180]，normalize 后 [0, 360)，但在 0/360 边界会跳变
    let bestYaw = normalizedRaw;
    let minDiff = Math.abs(normalizedRaw - normalizedFallback);

    // 检查 ±360 的等价值
    for (const offset of [-360, 360]) {
        const altYaw = normalizedRaw + offset;
        const diff = Math.abs(altYaw - normalizedFallback);
        if (diff < minDiff) {
            minDiff = diff;
            bestYaw = altYaw;
        }
    }

    return normalizeYawDegrees(bestYaw);
};

const getSpotPitchFromDirectionAndYaw = (direction: pc.Vec3, yaw: number): number => {
    const yawRad = normalizeYawDegrees(yaw) * pc.math.DEG_TO_RAD;
    const pitchForward = new pc.Vec3(-Math.sin(yawRad), 0, -Math.cos(yawRad));
    const signedSinPitch = direction.dot(pitchForward);
    return Math.atan2(signedSinPitch, -direction.y) * pc.math.RAD_TO_DEG;
};

const projectSpotRotationForAxis = (
    node: any,
    axis: SpotRotateAxis,
    startPitch: number,
    startYaw: number,
    prevYaw?: number
): { pitch: number; yaw: number } | null => {
    if (axis === 'y') {
        return {
            pitch: startPitch,
            yaw: getSpotYawFromWorldXAxis(node, startYaw)
        };
    }

    // x / z 都作为 pitch 的备选手柄
    // 使用照射方向计算 yaw（不依赖于旋转轴）
    const direction = getSpotDirectionFromNode(node);
    if (!direction) return null;

    const yawSeed = Number.isFinite(prevYaw as number) ? (prevYaw as number) : startYaw;
    let currentYaw = getSpotYawFromDirection(node, yawSeed);
    // x/z 轴为 pitch 主操作时，对接近竖直姿态下的 yaw 反解做跳变抑制，
    // 避免偶发切到另一组等价解（常见为 ±90°突跳），同时不强制锁死 yaw 以避免松手回弹。
    if (axis === 'x' || axis === 'z') {
        const horizontalLen = Math.hypot(direction.x, direction.z);
        const deltaYaw = Math.abs(shortestAngleDeltaDegrees(yawSeed, currentYaw));
        if (horizontalLen < SPOT_YAW_GUARD_HORIZONTAL_EPS && deltaYaw > SPOT_YAW_JUMP_GUARD_DEG) {
            currentYaw = normalizeYawDegrees(yawSeed);
        }
    }

    // 使用新的 yaw 计算 pitch
    const currentPitch = getSpotPitchFromDirectionAndYaw(direction, currentYaw);

    return {
        pitch: currentPitch,
        yaw: normalizeYawDegrees(currentYaw)
    };
};

/**
 * 基于线框底部平面方向判定启用哪两个轴，禁用 roll 轴。
 * 当 coordSpace = 'local' 时，Gizmo 的轴就是局部坐标系轴 (X/Y/Z)。
 * roll 轴 = 局部 Y 轴（锥体照射方向的反方向，也是底部平面的法向量）。
 * 启用另外两个局部轴（X 和 Z）作为 pitch 候选。
 */
const resolveSpotEnabledAxesByPlane = (
    _node: any,
    previous: { pitch: SpotPitchAxis; enabled: Set<RotateGizmoShape> }
): { pitch: SpotPitchAxis; enabled: Set<RotateGizmoShape> } => {
    // 在 local coordSpace 下，Gizmo 的轴就是局部坐标系的 X/Y/Z 轴
    // roll 轴始终是局部 Y 轴（锥体照射方向是 local -Y，所以 local Y 是"上"方向）
    const rollAxis: 'x' | 'y' | 'z' = 'y';

    // 启用的轴：局部 X 和局部 Z
    const enabled = new Set<RotateGizmoShape>(['x', 'z']);

    // pitch 轴：优先使用局部 X
    let pitch: SpotPitchAxis = 'x';

    // 滞回处理
    const prevRollAxis: 'x' | 'y' | 'z' =
        !previous.enabled.has('x') ? 'x' :
        !previous.enabled.has('y') ? 'y' :
        !previous.enabled.has('z') ? 'z' : 'x';

    if (rollAxis === prevRollAxis) {
        return previous;
    }

    return { pitch, enabled };
};

/**
 * 初始化 Gizmo：监听 assetTransformMode:changed 与 sceneAsset:selected，
 * 在编辑模式下对选中实体显示变换 Gizmo（若可用），否则提供简单拖拽平移。
 */
export function initGizmoHandler(global: Global): () => void {
    const { app, state, events, camera } = global;
    const api = getGizmoAPI();
    let gizmoPointerLocked = false;
    let spotRotateState: SpotRotateState | null = null;
    let currentSpotAxes: { pitch: SpotPitchAxis; enabled: Set<RotateGizmoShape> } = { pitch: 'x', enabled: new Set(['x', 'z']) };
    let shiftPressed = false;
    let shiftUniformScaleActive = false;
    const shiftUniformScaleStart = new Map<any, pc.Vec3>();

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
            const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;
            const _gizmos: { [key: string]: any } = {
                translate: new api.TranslateGizmo(cameraComp, layer),
                rotate: new api.RotateGizmo(cameraComp, layer),
                scale: new api.ScaleGizmo(cameraComp, layer)
            };
            const rotateGizmo = _gizmos.rotate;
            const scaleGizmo = _gizmos.scale;
            const hitGizmoAtCanvas = (x: number, y: number): boolean => {
                if (!handler || handler._nodes.length === 0) return false;
                const g: any = handler.gizmo;
                if (!g || typeof g._getSelection !== 'function') return false;
                const hit = g._getSelection(x, y);
                return Array.isArray(hit) && hit.length > 0;
            };
            setSceneGizmoHitTest(hitGizmoAtCanvas);

            const onCanvasPointerDownCapture = (ev: PointerEvent) => {
                if (!ev.isPrimary || ev.button !== 0 || !state.editMode) return;
                const rect = canvas.getBoundingClientRect();
                const x = ev.clientX - rect.left;
                const y = ev.clientY - rect.top;
                if (x < 0 || y < 0 || x > rect.width || y > rect.height) return;
                if (!hitGizmoAtCanvas(x, y)) return;
                gizmoPointerLocked = true;
                state.gizmoPointerActive = true;
                state.cameraControlsEnabled = false;
                events.fire('cameraControls:flushInputs');
            };
            canvas.addEventListener('pointerdown', onCanvasPointerDownCapture, true);

            rotateGizmo.on('transform:start', () => {
                if (state.editMode !== true || state.editLeftModule !== 'environment' || state.lightTransformMode !== 'rotate') {
                    spotRotateState = null;
                    return;
                }
                const node = handler?._nodes?.[0];
                const cfg = (node as any)?.__lightConfig as any | undefined;
                const axis = rotateGizmo._selectedAxis as string | undefined;
                if (!node || cfg?.type !== 'spot' || (axis !== 'x' && axis !== 'y' && axis !== 'z')) {
                    spotRotateState = null;
                    return;
                }
                const startPitch = typeof cfg.pitch === 'number' ? cfg.pitch : 0;
                const startYaw = typeof cfg.yaw === 'number' ? cfg.yaw : 0;
                spotRotateState = {
                    node,
                    axis,
                    startPitch,
                    startYaw,
                    currentPitch: startPitch,
                    currentYaw: startYaw,
                    changed: false
                };
            });

            rotateGizmo.on('transform:move', () => {
                if (!spotRotateState) return;
                const projected = projectSpotRotationForAxis(
                    spotRotateState.node,
                    spotRotateState.axis,
                    spotRotateState.startPitch,
                    spotRotateState.startYaw,
                    spotRotateState.currentYaw
                );
                if (!projected) {
                    return;
                }
                spotRotateState.currentPitch = projected.pitch;
                spotRotateState.currentYaw = projected.yaw;
                spotRotateState.changed =
                    spotRotateState.changed
                    || Math.abs(projected.pitch - spotRotateState.startPitch) > SPOT_ROTATE_EPSILON
                    || Math.abs(projected.yaw - spotRotateState.startYaw) > SPOT_ROTATE_EPSILON;
                // 拖拽中不强制覆写 node 旋转，避免与 Gizmo 内部解算"互相拉扯"导致
                // 在某些视角下 x/z 轴表现为卡死。仅在 transform:end 时统一投影回 pitch/yaw。
                app.renderNextFrame = true;
            });

            rotateGizmo.on('transform:end', () => {
                if (!spotRotateState) {
                    return;
                }
                const projected = projectSpotRotationForAxis(
                    spotRotateState.node,
                    spotRotateState.axis,
                    spotRotateState.startPitch,
                    spotRotateState.startYaw,
                    spotRotateState.currentYaw
                );
                if (!projected) return;
                // 更新最终值，但不应用旋转（让 Gizmo 自己的更新保持）
                // 也不清空 spotRotateState，让 pointer:up 来处理写入和清空
                spotRotateState.currentPitch = projected.pitch;
                spotRotateState.currentYaw = projected.yaw;
                spotRotateState.changed = true;
            });

            const resolveUniformScaleFactor = (axis: string | undefined, start: pc.Vec3, current: pc.Vec3): number => {
                const rx = Math.abs(start.x) > SCALE_EPSILON ? current.x / start.x : 1;
                const ry = Math.abs(start.y) > SCALE_EPSILON ? current.y / start.y : 1;
                const rz = Math.abs(start.z) > SCALE_EPSILON ? current.z / start.z : 1;
                if (axis === 'x') return rx;
                if (axis === 'y') return ry;
                if (axis === 'z') return rz;
                if (axis === 'xy') return (rx + ry) * 0.5;
                if (axis === 'xz') return (rx + rz) * 0.5;
                if (axis === 'yz') return (ry + rz) * 0.5;
                return (rx + ry + rz) / 3;
            };

            scaleGizmo.on('transform:start', () => {
                shiftUniformScaleActive =
                    shiftPressed
                    && state.editMode === true
                    && state.editLeftModule === 'asset'
                    && state.assetTransformMode === 'scale';
                shiftUniformScaleStart.clear();
                if (!shiftUniformScaleActive || !handler) return;
                handler._nodes.forEach((node: any) => {
                    const s = node.getLocalScale?.();
                    if (!s) return;
                    shiftUniformScaleStart.set(node, new pc.Vec3(s.x, s.y, s.z));
                });
            });

            scaleGizmo.on('transform:move', () => {
                if (!shiftUniformScaleActive || !handler) return;
                const axis = (scaleGizmo as any)._selectedAxis as string | undefined;
                handler._nodes.forEach((node: any) => {
                    const start = shiftUniformScaleStart.get(node);
                    if (!start) return;
                    const current = node.getLocalScale?.();
                    if (!current) return;
                    const factor = resolveUniformScaleFactor(axis, start, current);
                    node.setLocalScale(
                        start.x * factor,
                        start.y * factor,
                        start.z * factor
                    );
                });
                app.renderNextFrame = true;
            });

            scaleGizmo.on('transform:end', () => {
                shiftUniformScaleActive = false;
                shiftUniformScaleStart.clear();
            });

            // 绑定 pointer 事件：当 Gizmo 被拖拽时临时关闭相机控制，避免两边同时处理同一批输入事件
            Object.values(_gizmos).forEach((gizmo: any) => {
                gizmo.on('pointer:down', (_x: number, _y: number, meshInstance: any) => {
                    if (meshInstance) {
                        gizmoPointerLocked = true;
                        state.gizmoPointerActive = true;
                        state.cameraControlsEnabled = false;
                    }
                });
                gizmo.on('pointer:up', () => {
                    gizmoPointerLocked = false;
                    state.gizmoPointerActive = false;
                    // 先清空一次相机输入增量，再重新开启相机控制，避免「松手瞬间相机跳一下」
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
                                // 仅在 rotate 模式且本次确有旋转投影结果时，才回写 pitch/yaw。
                                // 避免 rotate -> move 或纯平移时用 Euler 回读覆盖配置，触发上下翻转。
                                const isLightRotateMode = state.lightTransformMode === 'rotate';
                                if (
                                    isLightRotateMode
                                    && spotRotateState
                                    && spotRotateState.node === node
                                    && spotRotateState.changed
                                ) {
                                    (cfg as any).pitch = spotRotateState.currentPitch;
                                    (cfg as any).yaw = normalizeYawDegrees(spotRotateState.currentYaw);
                                    changed = true;
                                }
                                // 处理完成后清空 spotRotateState
                                if (spotRotateState && spotRotateState.node === node) {
                                    spotRotateState = null;
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
                state.gizmoPointerActive = false;
                state.suppressAssetPointerClick = true;
                shiftUniformScaleActive = false;
                shiftUniformScaleStart.clear();
                events.fire('cameraControls:flushInputs');
                state.cameraControlsEnabled = true;
                // 不清空 spotRotateState，让 transform:end 来处理
                // 如果 transform:end 没有触发（异常情况），pointer:up 事件会处理写入和清空
            };
            const onWindowKeyDown = (ev: KeyboardEvent) => {
                if (ev.key === 'Shift') shiftPressed = true;
            };
            const onWindowKeyUp = (ev: KeyboardEvent) => {
                if (ev.key === 'Shift') shiftPressed = false;
            };
            window.addEventListener('keydown', onWindowKeyDown, true);
            window.addEventListener('keyup', onWindowKeyUp, true);
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
                    _type = type ?? 'translate';
                    const g = _gizmos[_type] ?? _gizmos.translate;
                    g.attach(_nodes);
                    const currentNode = _nodes[0];
                    const lightCfg = currentNode ? (currentNode as any).__lightConfig as { type?: string } | undefined : undefined;
                    const isSceneAsset = !lightCfg;
                    const isSpotLight = lightCfg?.type === 'spot';
                    // 坐标空间：
                    // - 场景资产（mesh/gaussian/image/video）：一律 local，与实体朝向一致，且与存盘 local rotation 一致
                    // - 环境光源：translate world；spot rotate local；其余 rotate world
                    if (_type === 'scale') {
                        g.coordSpace = 'local';
                    } else if (_type === 'rotate') {
                        g.coordSpace = isSceneAsset || isSpotLight ? 'local' : 'world';
                    } else {
                        g.coordSpace = isSceneAsset ? 'local' : 'world';
                    }
                },
                destroy() {
                    gizmoPointerLocked = false;
                    state.gizmoPointerActive = false;
                    shiftUniformScaleActive = false;
                    shiftUniformScaleStart.clear();
                    window.removeEventListener('keydown', onWindowKeyDown, true);
                    window.removeEventListener('keyup', onWindowKeyUp, true);
                    canvas.removeEventListener('pointerdown', onCanvasPointerDownCapture, true);
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
            const isEnabled = enabledShapes.has(shape);
            rotateGizmo.enableShape(shape, isEnabled);
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
            // 基于底部平面方向动态判定启用哪两个轴，禁用与平面最平行的 roll 轴
            // 绿色轴（Y 轴）也遵循同样的逻辑
            currentSpotAxes = resolveSpotEnabledAxesByPlane(lightEntity, currentSpotAxes);
            return currentSpotAxes.enabled;
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
            isAssetDebugVisualEnabled(state) &&
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
        if (!targetNode
            && inEnvModule
            && isEnvironmentDebugVisualEnabled(state)
            && (lightMode === 'move' || lightMode === 'rotate')
            && state.selectedLightId) {
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

        const isSpotRotateSelection =
            gizmoType === 'rotate'
            && (selectedLightEntity as any)?.__lightConfig?.type === 'spot';
        if (!isSpotRotateSelection) {
            spotRotateState = null;
            currentSpotAxes = { pitch: 'x', enabled: new Set(['x', 'z']) };
        }

        if (targetNode && gizmoType) {
            handler.add(targetNode, true);
            handler.switch(gizmoType);
            // coordSpace 已由 switch 方法根据选中节点类型自动设置
        } else {
            spotRotateState = null;
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
    const onPreviewModeChanged = () => syncGizmoToSelection();

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
    events.on('previewMode:changed', onPreviewModeChanged as any);
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
        events.off('previewMode:changed', onPreviewModeChanged as any);
        app.off('update', onUpdate);
        handler?.destroy();
        setSceneGizmoHitTest(null);
        state.gizmoPointerActive = false;
        state.suppressAssetPointerClick = false;
    };
}
