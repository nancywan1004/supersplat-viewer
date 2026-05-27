import { Color, Entity, Ray, Vec3 } from 'playcanvas';

import { ensureTorchLight } from '../../settings-serialize/settings-serialize-helper';
import { applyViewTorchActive, ensureViewSettings, readViewTorchActive } from '../../view-settings';
import { setTorchCursorActive } from '../../placement-cursor';
import type { EditLeftModule, Global } from '../../types';
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
 * - 启停由 `viewSettings.torch.active` 控制（不入库）；编辑模式下切换左侧模块时自动关闭
 * - **位置（跟手关键）**：
 *   - 鼠标移动或相机矩阵变化后，最多约 30Hz 同步做一次 mesh AABB 射线求交（CPU），
 *     并触发一次 `Picker.pickSurface`（异步，优先 `nearestPosition` 邻域最近深度）；
 *     mesh 用缩小 AABB；mesh/gsplat 同时命中取更近一侧；大 mesh 动态加大 range
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
/**
 * 沿视线向相机回拉光源，避免落在 mesh AABB 内/薄壳内部导致 PlayCanvas 点光打不到表面。
 * gsplat 走 night-mode 的 uTorchWorldPos，mesh 走引擎 PointLight，此处主要修复后者。
 */
const TORCH_SURFACE_BIAS_M = 0.12;
/** mesh AABB 命中时略加大回拉（AABB 比真实三角面更“鼓”） */
const TORCH_MESH_SURFACE_BIAS_M = 0.22;
/** 拾取用 AABB 相对渲染 AABB 的缩放（<1 收紧，减少「还没碰到模型就亮」） */
const TORCH_MESH_AABB_SHRINK = 0.78;
/** 命中缩小盒后，深度取 entry→exit 的该比例（避免贴在最外层鼓包面上） */
const TORCH_MESH_AABB_DEPTH_ALONG = 0.2;
/** 同一像素下多个 mesh 命中深度差在此内视为叠层，仍取最近深度（不向远推，避免打到后面） */
const TORCH_MESH_OVERLAP_DEPTH_M = 0.22;
/** 命中 mesh 的 AABB 最大边长超过该值时，按尺寸额外放大点光 range（大 mesh 局部更易照亮） */
const TORCH_MESH_RANGE_BOOST_MIN_EXTENT_M = 2.5;
const TORCH_MESH_RANGE_BOOST_FACTOR = 0.4;
const TORCH_MESH_RANGE_BOOST_MAX_M = 12;
/** 深度跳变锁定窗口：第一次跳变立即接受，随后短时间忽略反向大跳，避免深度边界来回闪烁 */
const TORCH_DEPTH_JUMP_LOCK_MS = 75;
/** 深度相对变化超过该比例视为“大跳变”（例如近/远表面切换），小变化仍立即跟随 */
const TORCH_DEPTH_JUMP_RATIO = 1.35;
/** 深度绝对变化小于该值（世界单位）时不视为大跳变，避免近距离小误差触发锁定 */
const TORCH_DEPTH_JUMP_MIN_DELTA = 0.35;
/** 大幅变远需要二次确认的最长等待时间；避免单帧漏到背景远深度造成闪烁 */
const TORCH_FAR_DEPTH_CONFIRM_MS = 90;
/** 二次确认时，两次远深度差异小于该比例才视为同一远表面 */
const TORCH_FAR_DEPTH_CONFIRM_TOLERANCE = 0.15;
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
const _tmpAabbMin = new Vec3();
const _tmpAabbMax = new Vec3();
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
    /** 上次最终写入实体的世界位置（用作 shader uniform 缓存与回退） */
    worldPos: Vec3;
    /** 是否拥有有效拾取距离（首次拾取成功后为 true） */
    hasWorldPos: boolean;
    /**
     * **方向用当前光标、深度用上次拾取** 模型的核心：
     * 上次成功拾取（mesh AABB 或 gsplat picker）得到的「沿相机视线的世界欧氏距离」。
     * 每帧 onUpdate 用「当前光标视线方向 × lastDistance」实时合成 worldPos，
     * 这样 picker 异步 stale（结果对应旧光标像素）不会把光源拉去旧位置，
     * 而是被解读为「同一深度，跟当前光标视线滑动」—— 跨越深度边界时一次到位。
     */
    lastDistance: number;
    /** 深度跳变锁定截止时间（ms）；只限制深度反复切换，不影响每帧光标方向 */
    depthJumpLockUntil: number;
    /** 待确认的远深度候选；用于过滤单帧漏到背景的 picker 远点 */
    pendingFarDistance: number;
    pendingFarUntil: number;
    pickDirty: boolean;
    pickInFlight: boolean;
    lastPickTime: number;
    pickGeneration: number;
    cameraSnapshotValid: boolean;
    cameraWorldSnapshot: Float32Array;
    cameraProjSnapshot: Float32Array;
    destroyed: boolean;
    /** 最近一次有效深度是否来自 mesh AABB（用于加大表面回拉） */
    lastPickFromMesh: boolean;
    /** 大 mesh / 叠层拾取时附加到 cfg.range 的额外世界单位（同步 mesh 实体与 gsplat uniform） */
    meshRangeBoost: number;
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
        lastDistance: 0,
        depthJumpLockUntil: Number.NEGATIVE_INFINITY,
        pendingFarDistance: 0,
        pendingFarUntil: Number.NEGATIVE_INFINITY,
        pickDirty: true,
        pickInFlight: false,
        lastPickTime: Number.NEGATIVE_INFINITY,
        pickGeneration: 0,
        cameraSnapshotValid: false,
        cameraWorldSnapshot: new Float32Array(16),
        cameraProjSnapshot: new Float32Array(16),
        destroyed: false,
        lastPickFromMesh: false,
        meshRangeBoost: 0
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

    const meshAabbMaxExtentM = (aabb: { halfExtents: { x: number; y: number; z: number } }): number => {
        const h = aabb.halfExtents;
        return 2 * Math.max(h.x, h.y, h.z);
    };

    const meshRangeBoostFromExtent = (extentM: number): number => {
        if (!Number.isFinite(extentM) || extentM <= TORCH_MESH_RANGE_BOOST_MIN_EXTENT_M) return 0;
        return Math.min(
            TORCH_MESH_RANGE_BOOST_MAX_M,
            (extentM - TORCH_MESH_RANGE_BOOST_MIN_EXTENT_M) * TORCH_MESH_RANGE_BOOST_FACTOR
        );
    };

    /**
     * 对缩小后的 world AABB 做 slab 求交，返回沿单位射线的深度 t（entry→exit 内插）。
     */
    const rayShrunkAabbDistance = (
        origin: Vec3,
        dir: Vec3,
        center: { x: number; y: number; z: number },
        halfExtents: { x: number; y: number; z: number }
    ): number | null => {
        const hx = halfExtents.x * TORCH_MESH_AABB_SHRINK;
        const hy = halfExtents.y * TORCH_MESH_AABB_SHRINK;
        const hz = halfExtents.z * TORCH_MESH_AABB_SHRINK;
        _tmpAabbMin.set(center.x - hx, center.y - hy, center.z - hz);
        _tmpAabbMax.set(center.x + hx, center.y + hy, center.z + hz);

        let tMin = -Infinity;
        let tMax = Infinity;
        const axes: Array<[number, number, number, number]> = [
            [dir.x, origin.x, _tmpAabbMin.x, _tmpAabbMax.x],
            [dir.y, origin.y, _tmpAabbMin.y, _tmpAabbMax.y],
            [dir.z, origin.z, _tmpAabbMin.z, _tmpAabbMax.z]
        ];
        for (let a = 0; a < 3; a++) {
            const d = axes[a][0];
            const o = axes[a][1];
            const bMin = axes[a][2];
            const bMax = axes[a][3];
            if (Math.abs(d) < 1e-8) {
                if (o < bMin || o > bMax) return null;
                continue;
            }
            const inv = 1 / d;
            let t0 = (bMin - o) * inv;
            let t1 = (bMax - o) * inv;
            if (t0 > t1) {
                const tmp = t0;
                t0 = t1;
                t1 = tmp;
            }
            if (t0 > tMin) tMin = t0;
            if (t1 < tMax) tMax = t1;
        }
        if (tMax < 0 || tMin > tMax) return null;
        const tEnter = Math.max(0, tMin);
        if (tEnter > tMax) return null;
        return tEnter + (tMax - tEnter) * TORCH_MESH_AABB_DEPTH_ALONG;
    };

    /** mesh 与 gsplat 同时命中时取离相机更近的一侧 */
    const resolveTorchPickDepth = (
        meshDist: number | null,
        meshRangeBoost: number,
        gsplatDist: number | null
    ): { distance: number; fromMesh: boolean; rangeBoost: number } | null => {
        if (meshDist === null && gsplatDist === null) return null;
        if (meshDist === null) {
            return { distance: gsplatDist!, fromMesh: false, rangeBoost: 0 };
        }
        if (gsplatDist === null) {
            return { distance: meshDist, fromMesh: true, rangeBoost: meshRangeBoost };
        }
        if (gsplatDist <= meshDist) {
            return { distance: gsplatDist, fromMesh: false, rangeBoost: 0 };
        }
        return { distance: meshDist, fromMesh: true, rangeBoost: meshRangeBoost };
    };

    /**
     * 在当前光标视线方向上对场景所有 mesh 的 world-space AABB 求交。
     * - 使用缩小盒 + entry→exit 内插深度
     * - 叠层在「最近」基础上略向远推，而非直接取最远
     */
    const computeMeshPickResult = (clientX: number, clientY: number): { distance: number; rangeBoost: number } | null => {
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
            meshInstances: Array<{
                visible: boolean;
                aabb: {
                    center: { x: number; y: number; z: number };
                    halfExtents: { x: number; y: number; z: number };
                };
            }>;
        }>;

        const hits: { dist: number; extent: number }[] = [];
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
                const dist = rayShrunkAabbDistance(origin, _tmpRayDir, mi.aabb.center, mi.aabb.halfExtents);
                if (dist === null || !Number.isFinite(dist) || dist <= 0) continue;
                hits.push({ dist, extent: meshAabbMaxExtentM(mi.aabb) });
            }
        }
        if (hits.length === 0) return null;
        hits.sort((a, b) => a.dist - b.dist);

        const nearest = hits[0].dist;
        let maxExtent = hits[0].extent;
        for (let k = 1; k < hits.length; k++) {
            if (hits[k].dist - nearest > TORCH_MESH_OVERLAP_DEPTH_M) break;
            maxExtent = Math.max(maxExtent, hits[k].extent);
        }
        return {
            distance: nearest,
            rangeBoost: meshRangeBoostFromExtent(maxExtent)
        };
    };

    /**
     * 只对“深度”做跳变锁，不平滑也不延迟光标方向：
     * - 首次 / 小变化：立即接受
     * - 大跳变：第一次立即接受，并打开短锁
     * - 锁定期间再次出现大跳变：忽略，避免深度边界处在近/远表面之间来回闪
     */
    /** 将世界落点沿视线略向相机回拉，使 PointLight 位于表面前方而非 AABB/壳体内 */
    const applySurfaceBiasTowardCamera = (worldPos: Vec3, fromMesh: boolean, rayDistance: number) => {
        const origin = global.camera.getPosition();
        _tmpRayDir.set(worldPos.x - origin.x, worldPos.y - origin.y, worldPos.z - origin.z);
        const len = _tmpRayDir.length();
        const fixed = fromMesh ? TORCH_MESH_SURFACE_BIAS_M : TORCH_SURFACE_BIAS_M;
        const proportional = rayDistance * (fromMesh ? 0.02 : 0.008);
        const bias = Math.min(fixed + proportional, len * 0.08);
        if (len <= bias + 1e-4) return;
        const scale = bias / len;
        worldPos.set(
            worldPos.x - _tmpRayDir.x * scale,
            worldPos.y - _tmpRayDir.y * scale,
            worldPos.z - _tmpRayDir.z * scale
        );
    };

    const applyPickedDistance = (distance: number, now: number, fromMesh: boolean): boolean => {
        if (!Number.isFinite(distance) || distance <= 0) return false;
        if (!runtime.hasWorldPos || runtime.lastDistance <= 0) {
            runtime.lastDistance = distance;
            runtime.hasWorldPos = true;
            runtime.lastPickFromMesh = fromMesh;
            runtime.pendingFarDistance = 0;
            runtime.pendingFarUntil = Number.NEGATIVE_INFINITY;
            return true;
        }

        const prev = runtime.lastDistance;
        const delta = Math.abs(distance - prev);
        const minDist = Math.max(1e-6, Math.min(distance, prev));
        const isLargeJump = delta >= TORCH_DEPTH_JUMP_MIN_DELTA &&
            (Math.max(distance, prev) / minDist) >= TORCH_DEPTH_JUMP_RATIO;

        // 单帧远深度最容易造成“闪到背景一下”。远跳先挂起，下一次仍然命中相近远深度再接受；
        // 跳近不等待，避免光标移到前景物体时出现明显深度延迟。
        if (isLargeJump && distance > prev) {
            if (runtime.pendingFarDistance <= 0) {
                runtime.pendingFarDistance = distance;
                runtime.pendingFarUntil = now + TORCH_FAR_DEPTH_CONFIRM_MS;
                return false;
            }

            const farDelta = Math.abs(distance - runtime.pendingFarDistance);
            const farTolerance = Math.max(
                TORCH_DEPTH_JUMP_MIN_DELTA,
                runtime.pendingFarDistance * TORCH_FAR_DEPTH_CONFIRM_TOLERANCE
            );
            if (farDelta > farTolerance && now < runtime.pendingFarUntil) {
                runtime.pendingFarDistance = distance;
                return false;
            }
            runtime.pendingFarDistance = 0;
            runtime.pendingFarUntil = Number.NEGATIVE_INFINITY;
        } else {
            runtime.pendingFarDistance = 0;
            runtime.pendingFarUntil = Number.NEGATIVE_INFINITY;
        }

        if (isLargeJump && now < runtime.depthJumpLockUntil) {
            return false;
        }

        runtime.lastDistance = distance;
        runtime.hasWorldPos = true;
        runtime.lastPickFromMesh = fromMesh;
        if (isLargeJump) {
            runtime.depthJumpLockUntil = now + TORCH_DEPTH_JUMP_LOCK_MS;
        }
        return true;
    };

    const scheduleWorldPick = () => {
        if (!runtime.pickDirty || runtime.pickInFlight) return;

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (now - runtime.lastPickTime < TORCH_PICK_THROTTLE_MS) return;

        const point = updateScreenUv(runtime.lastClientX, runtime.lastClientY);
        if (!point) return;

        const picker = (app as unknown as {
            __picker?: {
                pickSurface?: (x: number, y: number) => Promise<{ position: Vec3; nearestPosition?: Vec3 } | null>;
            };
        }).__picker;

        // 同步：mesh AABB 射线求交。命中即写入「沿视线的欧氏距离」缓存；
        // 注意此处不再保存 mesh 命中的世界点本身（位置每帧由 onUpdate 用当前光标视线 × lastDistance 重算）
        const cx = runtime.lastClientX;
        const cy = runtime.lastClientY;
        const meshPick = (cx !== null && cy !== null) ? computeMeshPickResult(cx, cy) : null;
        const meshDistSnapshot = meshPick?.distance ?? null;
        const meshBoostSnapshot = meshPick?.rangeBoost ?? 0;

        const applyResolvedPick = (resolved: { distance: number; fromMesh: boolean; rangeBoost: number }, at: number) => {
            runtime.meshRangeBoost = resolved.rangeBoost;
            applyPickedDistance(resolved.distance, at, resolved.fromMesh);
        };

        if (!picker?.pickSurface) {
            if (meshDistSnapshot !== null) {
                applyResolvedPick({
                    distance: meshDistSnapshot,
                    fromMesh: true,
                    rangeBoost: meshBoostSnapshot
                }, now);
            } else {
                runtime.meshRangeBoost = 0;
            }
            if (meshPick) {
                runtime.pickDirty = false;
                runtime.lastPickTime = now;
            }
            return;
        }

        if (meshDistSnapshot !== null) {
            const meshOnly = resolveTorchPickDepth(meshDistSnapshot, meshBoostSnapshot, null);
            if (meshOnly) applyResolvedPick(meshOnly, now);
        }

        const generation = ++runtime.pickGeneration;
        runtime.pickDirty = false;
        runtime.pickInFlight = true;
        runtime.lastPickTime = now;

        // 异步回调里不能复用模块级 _tmpCamPos（会被 onUpdate 改写），单独 snapshot 一份相机位置
        const camPosSnapshot = new Vec3().copy(global.camera.getPosition());

        picker.pickSurface(point.x, point.y).then((surface) => {
            if (runtime.destroyed || generation !== runtime.pickGeneration) return;
            const callbackNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
            const pos = surface?.nearestPosition ?? surface?.position;
            const gsplatValid = pos && Number.isFinite(pos.x) && Number.isFinite(pos.y) && Number.isFinite(pos.z);
            if (gsplatValid) {
                const dx = pos!.x - camPosSnapshot.x;
                const dy = pos!.y - camPosSnapshot.y;
                const dz = pos!.z - camPosSnapshot.z;
                const pickerDist = Math.sqrt(dx * dx + dy * dy + dz * dz);
                const resolved = resolveTorchPickDepth(meshDistSnapshot, meshBoostSnapshot, pickerDist);
                if (resolved) {
                    applyResolvedPick(resolved, callbackNow);
                    runtime.hasWorldPos = true;
                }
            } else if (!meshPick && !runtime.hasWorldPos) {
                runtime.hasWorldPos = false;
            }
        }).catch(() => {
            if (!runtime.destroyed && generation === runtime.pickGeneration && !meshPick && !runtime.hasWorldPos) {
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
        const rangeBoost = runtime.lastPickFromMesh ? runtime.meshRangeBoost : 0;
        (entity.light as unknown as { range: number }).range = userRange + rangeBoost;

        let pos: Vec3 | null = null;
        if (runtime.hasWorldPos &&
            runtime.lastDistance > 0 &&
            runtime.lastClientX !== null &&
            runtime.lastClientY !== null) {
            // 关键：方向用当前光标实时视线，深度用上次拾取得到的视线长度
            // —— picker 异步 stale / mesh 异步覆盖时，光源仍贴当前光标方向，避免「闪回鼠标路径上的旧位置」
            const cv = app.graphicsDevice.canvas as HTMLCanvasElement;
            const rect = cv.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
                const sx = runtime.lastClientX - rect.left;
                const sy = runtime.lastClientY - rect.top;
                const camComp = (global.camera as unknown as { camera?: { screenToWorld?: (x: number, y: number, z: number, out: Vec3) => Vec3; farClip: number } }).camera;
                if (camComp?.screenToWorld) {
                    const farPoint = camComp.screenToWorld(sx, sy, camComp.farClip ?? 1000, _tmpWorld);
                    const origin = global.camera.getPosition();
                    _tmpRayDir.set(farPoint.x - origin.x, farPoint.y - origin.y, farPoint.z - origin.z);
                    const rayLen = _tmpRayDir.length();
                    if (rayLen > 1e-6) {
                        const k = runtime.lastDistance / rayLen;
                        runtime.worldPos.set(
                            origin.x + _tmpRayDir.x * k,
                            origin.y + _tmpRayDir.y * k,
                            origin.z + _tmpRayDir.z * k
                        );
                        pos = runtime.worldPos;
                    }
                }
            }
        }
        if (!pos && runtime.lastClientX !== null && runtime.lastClientY !== null) {
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

        runtime.worldPos.copy(pos);
        const rayDist = runtime.lastDistance > 0 ? runtime.lastDistance : runtime.worldPos.distance(global.camera.getPosition());
        applySurfaceBiasTowardCamera(runtime.worldPos, runtime.lastPickFromMesh, rayDist);
        entity.setPosition(runtime.worldPos.x, runtime.worldPos.y, runtime.worldPos.z);
        entity.light.enabled = true;
    };
    app.on('update', onUpdate);

    /** 参数变更（settings.lighting.torch 被改时）即时刷新到实体 */
    const onTorchParamsChanged = () => {
        applyParamsToEntity();
    };
    events.on('torchParams:changed', onTorchParamsChanged);

    /** 编辑模式下切换左侧模块（含取消选中 → null）时关闭手电筒，避免与模块内拾取/笔刷冲突 */
    let lastEditLeftModule: EditLeftModule | null = global.state.editLeftModule ?? null;
    const onEditLeftModuleChanged = (next: EditLeftModule | null) => {
        const normalized: EditLeftModule | null = next ?? null;
        if (!global.state.editMode) {
            lastEditLeftModule = normalized;
            return;
        }
        if (normalized === lastEditLeftModule) return;
        lastEditLeftModule = normalized;
        if (readViewTorchActive(global)) {
            applyViewTorchActive(global, false);
            onUpdate();
        }
    };
    events.on('editLeftModule:changed', onEditLeftModuleChanged);

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
            events.off('editLeftModule:changed', onEditLeftModuleChanged);
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

/** 读取手电筒当前有效照射半径（settings.range + 大 mesh 动态加成）。 */
export function getTorchLightEffectiveRange(global: Global): number {
    const cfg = ensureTorchLight(global.settings as ExperienceSettings) as TorchLightSettings;
    const base = Math.max(0, cfg.range ?? 12);
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    const runtime = handle ? (handle as unknown as { __runtime?: TorchRuntimeState }).__runtime : undefined;
    const boost = runtime?.lastPickFromMesh ? runtime.meshRangeBoost : 0;
    return base + boost;
}
