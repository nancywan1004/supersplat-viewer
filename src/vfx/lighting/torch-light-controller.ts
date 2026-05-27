import { Color, Entity, Ray, Vec3 } from 'playcanvas';

import { ensureTorchLight } from '../../settings-serialize/settings-serialize-helper';
import { ensureViewSettings } from '../../view-settings';
import { setTorchCursorActive } from '../../placement-cursor';
import type { Global } from '../../types';
import type { ExperienceSettings } from '../../schemas/v2';
import type { TorchLightSettings } from '../../schemas/v2-custom';

/**
 * 手电筒（全局单例，运行时类型为 PlayCanvas **point light**）。
 *
 * **缓存拾取版**：鼠标/相机变化时节流拾取一次世界落点，shader 直接消费缓存坐标。
 *
 * - 实体名固定为 `torchLight`，挂在 `app.root` 下独立容器（不进 `pointLights`，
 *   规避 `updatePointLightsFromSettings` 的 destroy 误删）
 * - 参数（颜色 / 强度 / range）来自 `settings.lighting.torch`（持久化）
 * - 启停由 `viewSettings.torch.active` 控制（不入库）
 * - **位置（跟手关键）**：
 *   - 鼠标移动或相机矩阵变化后，最多约 30Hz 同步做一次 mesh AABB 射线求交（CPU），
 *     并触发一次 `Picker.pickSurface`（异步，gsplat 表面）；两者取离相机更近的命中点
 *   - 这样 mesh 在 picker 的深度纹理里不可见的问题被 mesh 求交补齐，光标停在 mesh 上时光源贴在 mesh 表面
 *   - shader 每个 splat 只做世界距离衰减，不再重复采 depthMap / 反投影
 * - **拾取兜底**：拾取未命中或还未首次返回时，光源回退到相机前方
 *   `TORCH_FALLBACK_DISTANCE` 米处；PointLight 的 `range` 直接使用 `cfg.range`。
 */
const TORCH_ENTITY_NAME = 'torchLight';
const TORCH_PICK_THROTTLE_MS = 33;
const CAMERA_CHANGE_EPSILON = 1e-5;
/** 拾取兜底距离（世界单位）：未命中时光源沿相机 forward 放在此距离处 */
const TORCH_FALLBACK_DISTANCE = 5;
/** 求 mesh AABB 命中时跳过的辅助 entity tag（光源 gizmo、拾取手柄、手电筒自身 visual 等） */
const TORCH_MESH_HELPER_TAGS = new Set<string>([
    'torchLight',
    'pointLight',
    'spotLight',
    'light',
    'lightVisual',
    'lightHandle',
    'pickHandle'
]);
/** 同名 helper entity 名（自上而下遍历到此名时即视为 helper） */
const TORCH_MESH_HELPER_NAMES = new Set<string>([
    'torchLight',
    'pointLights',
    'spotLights',
    'lightVisual',
    'lightHandle',
    'pickHandle'
]);

const _tmpForward = new Vec3();
const _tmpCamPos = new Vec3();
const _tmpFallbackPos = new Vec3();
const _tmpWorld = new Vec3();
const _tmpRayDir = new Vec3();
const _tmpAabbHit = new Vec3();
const _torchRay = new Ray();

type TorchControllerHandle = {
    setActive(active: boolean): void;
    refreshParamsFromSettings(): void;
    destroy(): void;
    readonly entity: Entity;
};

type TorchRuntimeState = {
    lastClientX: number | null;
    lastClientY: number | null;
    screenU: number | null;
    screenV: number | null;
    worldPos: Vec3;
    hasWorldPos: boolean;
    pickDirty: boolean;
    pickInFlight: boolean;
    lastPickTime: number;
    pickGeneration: number;
    cameraSnapshotValid: boolean;
    cameraWorldSnapshot: Float32Array;
    cameraProjSnapshot: Float32Array;
    destroyed: boolean;
};

/**
 * 初始化全局手电筒；同一 Global 重复调用返回已存在的 handle。
 */
export function initTorchLight(global: Global): TorchControllerHandle {
    const anyGlobal = global as unknown as { __torchLight?: TorchControllerHandle };
    if (anyGlobal.__torchLight) return anyGlobal.__torchLight;

    const { app, events } = global;
    const settings = global.settings as ExperienceSettings;
    ensureTorchLight(settings);
    ensureViewSettings(global);

    // 单例容器 + 子实体
    let container = app.root.findByName(TORCH_ENTITY_NAME) as Entity | null;
    if (!container) {
        container = new Entity(TORCH_ENTITY_NAME);
        app.root.addChild(container);
    }
    let entity = container.findByName('torchLight_light') as Entity | null;
    if (!entity) {
        entity = new Entity('torchLight_light');
        entity.addComponent('light', {
            type: 'point',
            color: new Color(1, 1, 1),
            intensity: 0,
            range: 1,
            castShadows: false
        });
        entity.tags.add('torchLight');
        container.addChild(entity);
    }

    const runtime: TorchRuntimeState = {
        lastClientX: null,
        lastClientY: null,
        screenU: null,
        screenV: null,
        worldPos: new Vec3(),
        hasWorldPos: false,
        pickDirty: true,
        pickInFlight: false,
        lastPickTime: Number.NEGATIVE_INFINITY,
        pickGeneration: 0,
        cameraSnapshotValid: false,
        cameraWorldSnapshot: new Float32Array(16),
        cameraProjSnapshot: new Float32Array(16),
        destroyed: false
    };

    /**
     * 把 settings.lighting.torch 的「颜色 / 强度」写到光组件上。
     * `range` 由 `onUpdate` 每帧直接写入 `cfg.range`。
     */
    const applyParamsToEntity = () => {
        const cfg = ensureTorchLight(settings) as TorchLightSettings;
        if (!entity?.light) return;
        const [r, g, b] = cfg.color;
        entity.light.color.set(r, g, b);
        const lowLevel = (entity.light as unknown as { light?: { setColor?: (r: number, g: number, b: number) => void } }).light;
        lowLevel?.setColor?.(r, g, b);
        entity.light.intensity = Math.max(0, Number.isFinite(cfg.intensity) ? cfg.intensity : 0);
    };

    /** 由 viewSettings.torch.active + 导出锁决定实体是否启用 */
    const shouldBeEnabled = (): boolean => {
        const stateAny = global.state as unknown as { isExportingVfxVideo?: boolean };
        if (stateAny.isExportingVfxVideo) return false;
        return ensureViewSettings(global).torch?.active === true;
    };

    /**
     * 把 client(x,y) + 距离投影到世界空间（仅用于拾取兜底）。
     * - 使用 `CameraComponent.screenToWorld`，默认采用 `canvas.clientWidth/Height`（CSS 像素）
     * - `cameraz` 是沿相机 forward 的 view-space Z（不是欧氏距离）
     */
    const computeWorldOnRay = (clientX: number, clientY: number, distance: number): Vec3 | null => {
        const cv = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = cv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const sx = clientX - rect.left;
        const sy = clientY - rect.top;
        runtime.screenU = Math.max(0, Math.min(1, sx / rect.width));
        // Picker depth sampling follows GPU screen UV convention (origin at bottom-left).
        runtime.screenV = Math.max(0, Math.min(1, 1 - sy / rect.height));
        const camComp = (global.camera as unknown as { camera?: { screenToWorld?: (x: number, y: number, z: number, out: Vec3) => Vec3 } }).camera;
        if (!camComp?.screenToWorld) return null;
        camComp.screenToWorld(sx, sy, distance, _tmpWorld);
        if (!Number.isFinite(_tmpWorld.x) || !Number.isFinite(_tmpWorld.y) || !Number.isFinite(_tmpWorld.z)) return null;
        return _tmpWorld;
    };

    const updateScreenUv = (clientX: number | null, clientY: number | null): { x: number; y: number } | null => {
        const cv = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = cv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;

        const sx = clientX === null ? rect.width * 0.5 : clientX - rect.left;
        const sy = clientY === null ? rect.height * 0.5 : clientY - rect.top;
        const x = Math.max(0, Math.min(1, sx / rect.width));
        const y = Math.max(0, Math.min(1, sy / rect.height));
        runtime.screenU = x;
        runtime.screenV = 1 - y;
        return { x, y };
    };

    const matrixChanged = (current: Float32Array | number[], snapshot: Float32Array): boolean => {
        for (let i = 0; i < 16; i++) {
            if (Math.abs((current[i] ?? 0) - snapshot[i]) > CAMERA_CHANGE_EPSILON) return true;
        }
        return false;
    };

    const copyMatrix = (current: Float32Array | number[], snapshot: Float32Array) => {
        for (let i = 0; i < 16; i++) {
            snapshot[i] = current[i] ?? 0;
        }
    };

    const markPickDirtyIfCameraChanged = () => {
        const world = global.camera.getWorldTransform().data;
        const proj = global.camera.camera?.projectionMatrix?.data;
        if (!proj) return;

        const changed = !runtime.cameraSnapshotValid ||
            matrixChanged(world, runtime.cameraWorldSnapshot) ||
            matrixChanged(proj, runtime.cameraProjSnapshot);
        if (!changed) return;

        copyMatrix(world, runtime.cameraWorldSnapshot);
        copyMatrix(proj, runtime.cameraProjSnapshot);
        runtime.cameraSnapshotValid = true;
        runtime.pickDirty = true;
    };

    /**
     * 判断某 entity 及其祖先链是否属于辅助 helper（光源 gizmo / 拾取手柄 / 手电筒自身 visual 等），
     * 是则在 mesh 射线求交中跳过，避免光源跳到 helper 小球上。
     */
    const isTorchHelperEntity = (e: Entity): boolean => {
        let cur: Entity | null = e;
        while (cur) {
            if (TORCH_MESH_HELPER_NAMES.has(cur.name)) return true;
            const tagList = (cur.tags as unknown as { _list?: string[] })?._list;
            if (tagList) {
                for (let i = 0; i < tagList.length; i++) {
                    if (TORCH_MESH_HELPER_TAGS.has(tagList[i])) return true;
                }
            }
            cur = cur.parent as Entity | null;
        }
        return false;
    };

    /**
     * 在当前光标视线方向上对场景所有 mesh 的 world-space AABB 做最近命中求交。
     * gsplat 不在此遍历中（无 RenderComponent），光源 / 拾取 helper 通过 tag/name 跳过。
     */
    const computeMeshHit = (clientX: number, clientY: number): { pos: Vec3; distSq: number } | null => {
        const cv = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = cv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const sx = clientX - rect.left;
        const sy = clientY - rect.top;
        const camComp = (global.camera as unknown as { camera?: { screenToWorld?: (x: number, y: number, z: number, out: Vec3) => Vec3; farClip: number } }).camera;
        if (!camComp?.screenToWorld) return null;

        const farPoint = camComp.screenToWorld(sx, sy, camComp.farClip ?? 1000, _tmpWorld);
        if (!farPoint || !Number.isFinite(farPoint.x) || !Number.isFinite(farPoint.y) || !Number.isFinite(farPoint.z)) {
            return null;
        }

        const origin = global.camera.getPosition();
        _tmpRayDir.set(farPoint.x - origin.x, farPoint.y - origin.y, farPoint.z - origin.z);
        const len = _tmpRayDir.length();
        if (len < 1e-6) return null;
        _tmpRayDir.mulScalar(1 / len);
        _torchRay.origin.copy(origin);
        _torchRay.direction.copy(_tmpRayDir);

        const renders = app.root.findComponents('render') as unknown as Array<{
            entity: Entity;
            enabled: boolean;
            meshInstances: Array<{ visible: boolean; aabb: { intersectsRay(ray: Ray, out?: Vec3): boolean } }>;
        }>;

        let bestDistSq = Infinity;
        let bestHit: Vec3 | null = null;
        for (let i = 0; i < renders.length; i++) {
            const rc = renders[i];
            if (!rc.enabled) continue;
            const e = rc.entity;
            if (!e || !e.enabled || isTorchHelperEntity(e)) continue;
            const meshInstances = rc.meshInstances;
            if (!meshInstances) continue;
            for (let j = 0; j < meshInstances.length; j++) {
                const mi = meshInstances[j];
                if (!mi.visible || !mi.aabb) continue;
                if (!mi.aabb.intersectsRay(_torchRay, _tmpAabbHit)) continue;
                const dx = _tmpAabbHit.x - origin.x;
                const dy = _tmpAabbHit.y - origin.y;
                const dz = _tmpAabbHit.z - origin.z;
                const distSq = dx * dx + dy * dy + dz * dz;
                if (distSq < bestDistSq) {
                    bestDistSq = distSq;
                    bestHit = bestHit ?? new Vec3();
                    bestHit.copy(_tmpAabbHit);
                }
            }
        }
        return bestHit ? { pos: bestHit, distSq: bestDistSq } : null;
    };

    const scheduleWorldPick = () => {
        if (!runtime.pickDirty || runtime.pickInFlight) return;

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - runtime.lastPickTime < TORCH_PICK_THROTTLE_MS) return;

        const point = updateScreenUv(runtime.lastClientX, runtime.lastClientY);
        if (!point) return;

        const picker = (app as unknown as {
            __picker?: { pickSurface?: (x: number, y: number) => Promise<{ position: Vec3 } | null> };
        }).__picker;

        // 同步：mesh AABB 射线求交（先于 picker 异步结果生效，光标停在 mesh 上立即贴合）
        const cx = runtime.lastClientX;
        const cy = runtime.lastClientY;
        const meshHit = (cx !== null && cy !== null) ? computeMeshHit(cx, cy) : null;
        if (meshHit) {
            runtime.worldPos.copy(meshHit.pos);
            runtime.hasWorldPos = true;
        }

        if (!picker?.pickSurface) {
            // 无 picker：mesh hit 已经是最终结果，可以直接消费 dirty
            if (meshHit) {
                runtime.pickDirty = false;
                runtime.lastPickTime = now;
            }
            return;
        }

        const generation = ++runtime.pickGeneration;
        runtime.pickDirty = false;
        runtime.pickInFlight = true;
        runtime.lastPickTime = now;

        // 异步回调里不能复用模块级 _tmpCamPos（会被 onUpdate 改写），单独 snapshot 一份相机位置
        const camPosSnapshot = new Vec3().copy(global.camera.getPosition());
        const meshDistSqSnapshot = meshHit ? meshHit.distSq : Infinity;

        picker.pickSurface(point.x, point.y).then((surface) => {
            if (runtime.destroyed || generation !== runtime.pickGeneration) return;
            const pos = surface?.position;
            const gsplatValid = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);
            if (gsplatValid) {
                const dx = pos!.x - camPosSnapshot.x;
                const dy = pos!.y - camPosSnapshot.y;
                const dz = pos!.z - camPosSnapshot.z;
                const gsplatDistSq = dx * dx + dy * dy + dz * dz;
                if (gsplatDistSq < meshDistSqSnapshot) {
                    runtime.worldPos.copy(pos!);
                }
                runtime.hasWorldPos = true;
            } else if (!meshHit) {
                runtime.hasWorldPos = false;
            }
        }).catch(() => {
            if (!runtime.destroyed && generation === runtime.pickGeneration && !meshHit) {
                runtime.hasWorldPos = false;
            }
        }).finally(() => {
            if (!runtime.destroyed && generation === runtime.pickGeneration) {
                runtime.pickInFlight = false;
            }
        });
    };

    const onPointerMove = (event: PointerEvent) => {
        runtime.lastClientX = event.clientX;
        runtime.lastClientY = event.clientY;
        updateScreenUv(event.clientX, event.clientY);
        runtime.pickDirty = true;
    };

    const canvas = (app.graphicsDevice.canvas as HTMLCanvasElement);
    canvas.addEventListener('pointermove', onPointerMove);

    /**
     * 每帧：
     *  1. 计算 enabled，切换 cursor 与 light.enabled
     *  2. light.range 直接使用 cfg.range
     *  3. 优先使用拾取得到的世界落点；未命中则回退到相机前方 TORCH_FALLBACK_DISTANCE 处
     */
    let lastEnabledState = false;
    const onUpdate = () => {
        if (!entity?.light) return;
        const enabled = shouldBeEnabled();

        if (enabled !== lastEnabledState) {
            setTorchCursorActive(global, enabled);
            lastEnabledState = enabled;
        }

        if (!enabled) {
            entity.light.enabled = false;
            return;
        }

        markPickDirtyIfCameraChanged();
        scheduleWorldPick();

        const cfg = ensureTorchLight(settings) as TorchLightSettings;
        const userRange = Math.max(0, cfg.range ?? 12);
        (entity.light as unknown as { range: number }).range = userRange;

        let pos: Vec3 | null = null;
        if (runtime.hasWorldPos) {
            pos = runtime.worldPos;
        } else if (runtime.lastClientX !== null && runtime.lastClientY !== null) {
            pos = computeWorldOnRay(runtime.lastClientX, runtime.lastClientY, TORCH_FALLBACK_DISTANCE);
        }

        // 兜底：未发生过 pointermove → 沿相机 forward 放置
        if (!pos) {
            const cam = global.camera;
            const camPos = _tmpCamPos.copy(cam.getPosition());
            const fwd = (cam as unknown as { forward: Vec3 }).forward;
            _tmpForward.set(fwd.x, fwd.y, fwd.z);
            const fl = _tmpForward.length();
            if (fl > 1e-6) {
                _tmpForward.mulScalar(1 / fl);
                _tmpFallbackPos.set(
                    camPos.x + _tmpForward.x * TORCH_FALLBACK_DISTANCE,
                    camPos.y + _tmpForward.y * TORCH_FALLBACK_DISTANCE,
                    camPos.z + _tmpForward.z * TORCH_FALLBACK_DISTANCE
                );
                pos = _tmpFallbackPos;
                runtime.screenU = 0.5;
                runtime.screenV = 0.5;
            }
        }
        if (!pos) {
            entity.light.enabled = false;
            return;
        }

        entity.setPosition(pos.x, pos.y, pos.z);
        entity.light.enabled = true;
    };
    app.on('update', onUpdate);

    /** 参数变更（settings.lighting.torch 被改时）即时刷新到实体 */
    const onTorchParamsChanged = () => {
        applyParamsToEntity();
    };
    events.on('torchParams:changed', onTorchParamsChanged);

    const handle: TorchControllerHandle = {
        get entity() {
            return entity as Entity;
        },
        setActive(active: boolean) {
            const vs = ensureViewSettings(global);
            if (!vs.torch) vs.torch = { active: false };
            vs.torch.active = !!active;
            if (active) runtime.pickDirty = true;
            onUpdate();
        },
        refreshParamsFromSettings() {
            applyParamsToEntity();
        },
        destroy() {
            runtime.destroyed = true;
            runtime.pickGeneration++;
            try {
                canvas.removeEventListener('pointermove', onPointerMove);
            } catch { /* ignore */ }
            app.off('update', onUpdate);
            events.off('torchParams:changed', onTorchParamsChanged);
            setTorchCursorActive(global, false);
            try {
                if (container) (container as Entity).destroy();
            } catch { /* ignore */ }
            delete (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
        }
    };

    (handle as unknown as { __runtime?: TorchRuntimeState }).__runtime = runtime;
    (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight = handle;
    applyParamsToEntity();
    onUpdate();
    return handle;
}

/** 读取（懒）当前手电筒实体；未初始化时返回 null */
export function getTorchLightEntity(global: Global): Entity | null {
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    return handle?.entity ?? null;
}

/** 读取手电筒是否正在 enable */
export function isTorchEntityEnabled(global: Global): boolean {
    const e = getTorchLightEntity(global);
    return !!(e && e.light && e.light.enabled);
}

/** 读取手电筒当前鼠标屏幕 UV（v 为 bottom-left 原点）。 */
export function getTorchLightScreenUv(global: Global): { u: number; v: number } | null {
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    const runtime = handle ? (handle as unknown as { __runtime?: TorchRuntimeState }).__runtime : undefined;
    if (!runtime || runtime.screenU === null || runtime.screenV === null) return null;
    return { u: runtime.screenU, v: runtime.screenV };
}

/** 读取手电筒当前缓存的深度拾取世界坐标；未命中时返回 null。 */
export function getTorchLightWorldPosition(global: Global): Vec3 | null {
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    const runtime = handle ? (handle as unknown as { __runtime?: TorchRuntimeState }).__runtime : undefined;
    if (!runtime?.hasWorldPos) return null;
    return runtime.worldPos;
}
