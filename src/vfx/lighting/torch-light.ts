import { Color, Entity, Ray, Vec3 } from 'playcanvas';

import { ensureTorchLight } from '../../settings-serialize/settings-serialize-helper';
import { applyViewTorchActive, ensureViewSettings, readViewTorchActive } from '../../view-settings';
import { setTorchCursorActive } from '../../placement-cursor';
import type { EditLeftModule, Global } from '../../types';
import type { ExperienceSettings } from '../../schemas/v2';
import type { TorchLightSettings } from '../../schemas/v2-custom';

/**
 * 手电筒（全局单例）：gsplat 走 night-mode 相机锥光 Fill+Hotspot；mesh 走 PlayCanvas PointLight。
 *
 * - Fill：`beamEnd = farClip × TORCH_BEAM_FAR_RATIO`，沿光标视线照亮前后景
 * - Hotspot：mesh AABB 同步命中或 `picker.pick` 单点深度，聚光尺度 = `settings.lighting.torch.range`
 * - 不使用 `pickSurface`；相机变化时清空热点深度，避免旧深度套到新视角
 */
const TORCH_ENTITY_NAME = 'torchLight';
const TORCH_PICK_THROTTLE_MS = 33;
const TORCH_PICK_IN_FLIGHT_TIMEOUT_MS = 400;
const CAMERA_CHANGE_EPSILON = 1e-5;
const TORCH_BEAM_FAR_RATIO = 0.85;
const TORCH_BEAM_MIN_M = 8;
const TORCH_HOTSPOT_SMOOTH_MS = 50;
const TORCH_HOTSPOT_FALLBACK_BEAM_RATIO = 0.35;
const TORCH_FILL_WEIGHT = 0.45;
const TORCH_HOTSPOT_WEIGHT = 1.0;
const TORCH_MESH_HOTSPOT_SHADER_BLEND = 0.85;
const TORCH_GSPLAT_POINTLIGHT_INTENSITY_SCALE = 0.4;

const TORCH_SURFACE_BIAS_M = 0.12;
const TORCH_MESH_SURFACE_BIAS_M = 0.18;
/** 拾取略放宽，减少薄壳/斜视角下偶发 AABB miss */
const TORCH_MESH_AABB_SHRINK = 0.85;
const TORCH_MESH_AABB_DEPTH_ALONG = 0.2;
const TORCH_MESH_OVERLAP_DEPTH_M = 0.22;
const TORCH_MESH_SOFT_BOOST_MAX_M = 2.5;
const TORCH_MESH_SOFT_BOOST_START_EXTENT_M = 3.0;
const TORCH_MESH_SOFT_BOOST_FULL_EXTENT_M = 12.0;
const TORCH_MESH_INTENSITY_MATCH = 0.62;
const TORCH_MESH_INTENSITY_BOOST_COMPENSATE = 0.12;
const TORCH_MESH_GSPLAT_HYSTERESIS_M = 0.2;
const TORCH_POINTER_STALE_MS = 1200;

const TORCH_MESH_HELPER_TAGS = new Set<string>([
    'torchLight',
    'pointLight',
    'spotLight',
    'light',
    'lightVisual',
    'lightHandle',
    'pickHandle'
]);
const TORCH_MESH_HELPER_NAMES = new Set<string>([
    'torchLight',
    'pointLights',
    'spotLights',
    'shadowCatcher',
    'ShadowCatcherGeometry',
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

export type TorchBeamParams = {
    beamEnd: number;
    hotspotDepth: number;
    hasHotspot: boolean;
    hotspotFromMesh: boolean;
    spotRadius: number;
    fillWeight: number;
    hotspotWeight: number;
    meshHotspotBlend: number;
};

type TorchControllerHandle = {
    setActive(active: boolean): void;
    refreshParamsFromSettings(): void;
    destroy(): void;
    readonly entity: Entity;
};

type TorchRuntimeState = {
    lastClientX: number | null;
    lastClientY: number | null;
    lastPointerTime: number;
    screenU: number | null;
    screenV: number | null;
    worldPos: Vec3;
    beamEnd: number;
    hotspotDepth: number;
    hasHotspotDepth: boolean;
    hotspotFromMesh: boolean;
    meshExtentM: number;
    meshRangeBoost: number;
    meshIntensityScale: number;
    lastSmoothTime: number;
    pickDirty: boolean;
    pickInFlight: boolean;
    lastPickTime: number;
    pickGeneration: number;
    cameraSnapshotValid: boolean;
    cameraWorldSnapshot: Float32Array;
    cameraProjSnapshot: Float32Array;
    destroyed: boolean;
};

const smoothstep01 = (edge0: number, edge1: number, x: number): number => {
    if (edge1 <= edge0) return x >= edge1 ? 1 : 0;
    const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
    return t * t * (3 - 2 * t);
};

const lerpToward = (current: number, target: number, now: number, lastTime: number, smoothMs: number): number => {
    if (!Number.isFinite(target)) return current;
    if (lastTime <= 0 || smoothMs <= 0) return target;
    const dt = Math.max(0, now - lastTime);
    const alpha = Math.min(1, dt / smoothMs);
    return current + (target - current) * alpha;
};

const meshSoftRangeBoostFromExtent = (extentM: number): number => {
    if (!Number.isFinite(extentM) || extentM <= 0) return 0;
    const t = smoothstep01(
        TORCH_MESH_SOFT_BOOST_START_EXTENT_M,
        TORCH_MESH_SOFT_BOOST_FULL_EXTENT_M,
        extentM
    );
    return t * TORCH_MESH_SOFT_BOOST_MAX_M;
};

const meshIntensityScaleFromBoost = (fromMesh: boolean, rangeBoost: number): number => {
    if (!fromMesh) return 1;
    let scale = TORCH_MESH_INTENSITY_MATCH;
    scale /= 1 + TORCH_MESH_INTENSITY_BOOST_COMPENSATE * Math.max(0, rangeBoost);
    return scale;
};

export function initTorchLight(global: Global): TorchControllerHandle {
    const anyGlobal = global as unknown as { __torchLight?: TorchControllerHandle };
    if (anyGlobal.__torchLight) return anyGlobal.__torchLight;

    const { app, events } = global;
    const settings = global.settings as ExperienceSettings;
    ensureTorchLight(settings);
    ensureViewSettings(global);

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
        lastPointerTime: Number.NEGATIVE_INFINITY,
        screenU: null,
        screenV: null,
        worldPos: new Vec3(),
        beamEnd: TORCH_BEAM_MIN_M,
        hotspotDepth: 0,
        hasHotspotDepth: false,
        hotspotFromMesh: false,
        meshExtentM: 0,
        meshRangeBoost: 0,
        meshIntensityScale: 1,
        lastSmoothTime: 0,
        pickDirty: true,
        pickInFlight: false,
        lastPickTime: Number.NEGATIVE_INFINITY,
        pickGeneration: 0,
        cameraSnapshotValid: false,
        cameraWorldSnapshot: new Float32Array(16),
        cameraProjSnapshot: new Float32Array(16),
        destroyed: false
    };

    const applyParamsToEntity = () => {
        const cfg = ensureTorchLight(settings) as TorchLightSettings;
        if (!entity?.light) return;
        const [r, g, b] = cfg.color;
        entity.light.color.set(r, g, b);
        const lowLevel = (entity.light as unknown as { light?: { setColor?: (r: number, g: number, b: number) => void } }).light;
        lowLevel?.setColor?.(r, g, b);
    };

    const shouldBeEnabled = (): boolean => {
        const stateAny = global.state as unknown as { isExportingVfxVideo?: boolean };
        if (stateAny.isExportingVfxVideo) return false;
        return ensureViewSettings(global).torch?.active === true;
    };

    const refreshBeamEnd = () => {
        const far = global.camera?.camera?.farClip ?? 1000;
        runtime.beamEnd = Math.max(TORCH_BEAM_MIN_M, far * TORCH_BEAM_FAR_RATIO);
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
        runtime.hasHotspotDepth = false;
        runtime.hotspotDepth = 0;
    };

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

    const distanceFromCamera = (pos: Vec3, camPos: Vec3): number | null => {
        const dx = pos.x - camPos.x;
        const dy = pos.y - camPos.y;
        const dz = pos.z - camPos.z;
        const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);
        return Number.isFinite(dist) && dist > 0 ? dist : null;
    };

    const computeMeshPickResult = (clientX: number, clientY: number): { distance: number; extentM: number } | null => {
        const cv = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = cv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        const sx = clientX - rect.left;
        const sy = clientY - rect.top;
        const camComp = (global.camera as unknown as { camera?: { screenToWorld?: (x: number, y: number, z: number, out: Vec3) => Vec3; farClip: number } }).camera;
        if (!camComp?.screenToWorld) return null;

        const farPoint = camComp.screenToWorld(sx, sy, camComp.farClip ?? 1000, _tmpWorld);
        if (!farPoint || !Number.isFinite(farPoint.x)) return null;

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
        return { distance: nearest, extentM: maxExtent };
    };

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

    const cancelInflightGsplatPick = () => {
        runtime.pickGeneration++;
        runtime.pickInFlight = false;
    };

    const commitHotspotTarget = (
        distance: number,
        fromMesh: boolean,
        extentM: number,
        now: number
    ) => {
        if (!Number.isFinite(distance) || distance <= 0) return;

        // mesh 命中始终采纳；仅防止 gsplat 在叠层深度处抢答 mesh
        if (!fromMesh && runtime.hotspotFromMesh && runtime.hasHotspotDepth &&
            Math.abs(distance - runtime.hotspotDepth) < TORCH_MESH_GSPLAT_HYSTERESIS_M) {
            return;
        }

        const targetBoost = fromMesh ? meshSoftRangeBoostFromExtent(extentM) : 0;
        const targetIntensity = meshIntensityScaleFromBoost(fromMesh, targetBoost);

        const prevSmooth = runtime.lastSmoothTime > 0 ? runtime.lastSmoothTime : now;
        runtime.hotspotDepth = lerpToward(runtime.hotspotDepth, distance, now, prevSmooth, TORCH_HOTSPOT_SMOOTH_MS);
        runtime.meshRangeBoost = lerpToward(runtime.meshRangeBoost, targetBoost, now, prevSmooth, TORCH_HOTSPOT_SMOOTH_MS);
        runtime.meshIntensityScale = lerpToward(runtime.meshIntensityScale, targetIntensity, now, prevSmooth, TORCH_HOTSPOT_SMOOTH_MS);
        runtime.lastSmoothTime = now;
        runtime.hasHotspotDepth = true;
        runtime.hotspotFromMesh = fromMesh;
        runtime.meshExtentM = fromMesh ? extentM : 0;
    };

    const clearHotspot = () => {
        runtime.hasHotspotDepth = false;
        runtime.hotspotDepth = 0;
        runtime.hotspotFromMesh = false;
        runtime.meshExtentM = 0;
        runtime.meshRangeBoost = 0;
        runtime.meshIntensityScale = 1;
    };

    const resetPickRuntime = () => {
        clearHotspot();
        runtime.pickInFlight = false;
        runtime.pickGeneration++;
        runtime.pickDirty = true;
        runtime.lastPickTime = Number.NEGATIVE_INFINITY;
        runtime.lastSmoothTime = 0;
    };

    const resolvePickClientXY = (): { clientX: number; clientY: number } | null => {
        const cv = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = cv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return null;
        if (runtime.lastClientX !== null && runtime.lastClientY !== null) {
            const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (now - runtime.lastPointerTime <= TORCH_POINTER_STALE_MS) {
                return { clientX: runtime.lastClientX, clientY: runtime.lastClientY };
            }
        }
        return {
            clientX: rect.left + rect.width * 0.5,
            clientY: rect.top + rect.height * 0.5
        };
    };

    let forceImmediatePick = false;

    /** 每帧同步 mesh AABB；命中则取消在途 gsplat pick，避免异步结果清空 mesh 热点。 */
    const applySyncMeshHotspot = (clientX: number, clientY: number, now: number): boolean => {
        const meshPick = computeMeshPickResult(clientX, clientY);
        if (meshPick === null) return false;
        cancelInflightGsplatPick();
        commitHotspotTarget(meshPick.distance, true, meshPick.extentM, now);
        runtime.pickDirty = false;
        runtime.lastPickTime = now;
        return true;
    };

    const tryClearHotspotIfNoMesh = (clientX: number, clientY: number) => {
        if (computeMeshPickResult(clientX, clientY) !== null) return;
        clearHotspot();
    };

    const scheduleGsplatDepthSample = () => {
        if (!global.state.readyToRender) return;
        if (!runtime.pickDirty || runtime.pickInFlight) return;

        const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
        if (!forceImmediatePick && now - runtime.lastPickTime < TORCH_PICK_THROTTLE_MS) return;
        forceImmediatePick = false;

        const pickClient = resolvePickClientXY();
        if (!pickClient) return;
        const point = updateScreenUv(pickClient.clientX, pickClient.clientY);
        if (!point) return;

        const picker = global.picker;
        if (!picker?.pick) {
            tryClearHotspotIfNoMesh(pickClient.clientX, pickClient.clientY);
            runtime.pickDirty = false;
            runtime.lastPickTime = now;
            return;
        }

        const generation = ++runtime.pickGeneration;
        runtime.pickDirty = false;
        runtime.pickInFlight = true;
        runtime.lastPickTime = now;
        const camPosSnapshot = new Vec3().copy(global.camera.getPosition());
        const clientX = pickClient.clientX;
        const clientY = pickClient.clientY;

        picker.pick(point.x, point.y).then((worldPoint) => {
            if (runtime.destroyed || generation !== runtime.pickGeneration) return;
            const callbackNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
            if (applySyncMeshHotspot(clientX, clientY, callbackNow)) {
                return;
            }
            if (worldPoint) {
                const dist = distanceFromCamera(worldPoint, camPosSnapshot);
                if (dist !== null) {
                    commitHotspotTarget(dist, false, 0, callbackNow);
                    return;
                }
            }
            tryClearHotspotIfNoMesh(clientX, clientY);
            runtime.pickDirty = true;
        }).catch(() => {
            if (runtime.destroyed || generation !== runtime.pickGeneration) return;
            tryClearHotspotIfNoMesh(clientX, clientY);
            runtime.pickDirty = true;
        }).finally(() => {
            if (runtime.destroyed) return;
            if (generation === runtime.pickGeneration) {
                runtime.pickInFlight = false;
            }
        });
    };

    const recoverStuckPickInFlight = (now: number) => {
        if (!runtime.pickInFlight) return;
        if (now - runtime.lastPickTime <= TORCH_PICK_IN_FLIGHT_TIMEOUT_MS) return;
        runtime.pickInFlight = false;
        runtime.pickGeneration++;
        runtime.pickDirty = true;
    };

    const worldPosAlongRay = (rayDistance: number, fromMesh: boolean): boolean => {
        const pickClient = resolvePickClientXY();
        if (!pickClient) return false;
        const cv = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = cv.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const sx = pickClient.clientX - rect.left;
        const sy = pickClient.clientY - rect.top;
        const camComp = (global.camera as unknown as { camera?: { screenToWorld?: (x: number, y: number, z: number, out: Vec3) => Vec3; farClip: number } }).camera;
        if (!camComp?.screenToWorld) return false;

        const farPoint = camComp.screenToWorld(sx, sy, camComp.farClip ?? 1000, _tmpWorld);
        const origin = global.camera.getPosition();
        _tmpRayDir.set(farPoint.x - origin.x, farPoint.y - origin.y, farPoint.z - origin.z);
        const rayLen = _tmpRayDir.length();
        if (rayLen < 1e-6) return false;
        const k = rayDistance / rayLen;
        runtime.worldPos.set(
            origin.x + _tmpRayDir.x * k,
            origin.y + _tmpRayDir.y * k,
            origin.z + _tmpRayDir.z * k
        );
        applySurfaceBiasTowardCamera(runtime.worldPos, fromMesh, rayDistance);
        return true;
    };

    const onPointerMove = (event: PointerEvent) => {
        runtime.lastClientX = event.clientX;
        runtime.lastClientY = event.clientY;
        runtime.lastPointerTime = typeof performance !== 'undefined' ? performance.now() : Date.now();
        updateScreenUv(event.clientX, event.clientY);
        runtime.pickDirty = true;
    };

    const clearPointerTarget = () => {
        runtime.lastClientX = null;
        runtime.lastClientY = null;
        runtime.lastPointerTime = Number.NEGATIVE_INFINITY;
    };

    const shouldTrackWindowPointer = (event: PointerEvent): boolean => {
        const cv = app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = cv.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) {
            return false;
        }
        const target = event.target as HTMLElement | null;
        if (target?.closest?.('button, select, input, textarea, [data-torch-ignore-pointer]')) {
            return false;
        }
        return true;
    };

    const onWindowPointerMove = (event: PointerEvent) => {
        if (!shouldTrackWindowPointer(event)) return;
        onPointerMove(event);
    };

    const onWindowPointerDown = (event: PointerEvent) => {
        if (shouldTrackWindowPointer(event)) {
            onPointerMove(event);
            return;
        }
        clearPointerTarget();
    };

    const canvas = (app.graphicsDevice.canvas as HTMLCanvasElement);
    canvas.addEventListener('pointermove', onPointerMove);
    window.addEventListener('pointermove', onWindowPointerMove, { passive: true });
    window.addEventListener('pointerdown', onWindowPointerDown, { passive: true, capture: true });

    let lastEnabledState = false;
    const onUpdate = () => {
        if (!entity?.light) return;
        const enabled = shouldBeEnabled();

        if (enabled !== lastEnabledState) {
            setTorchCursorActive(global, enabled);
            if (enabled) {
                forceImmediatePick = true;
                resetPickRuntime();
            }
            lastEnabledState = enabled;
        }

        if (!enabled) {
            entity.light.enabled = false;
            return;
        }

        refreshBeamEnd();
        markPickDirtyIfCameraChanged();
        const pickNow = typeof performance !== 'undefined' ? performance.now() : Date.now();
        recoverStuckPickInFlight(pickNow);

        const pickClient = resolvePickClientXY();
        const meshHeld = pickClient
            ? applySyncMeshHotspot(pickClient.clientX, pickClient.clientY, pickNow)
            : false;
        if (!meshHeld) {
            scheduleGsplatDepthSample();
        }

        const cfg = ensureTorchLight(settings) as TorchLightSettings;
        const spotRadius = Math.max(0, cfg.range ?? 12);
        const baseIntensity = Math.max(0, Number.isFinite(cfg.intensity) ? cfg.intensity : 0);

        if (runtime.hotspotFromMesh) {
            (entity.light as unknown as { range: number }).range = spotRadius + runtime.meshRangeBoost;
            entity.light.intensity = baseIntensity * runtime.meshIntensityScale;
        } else {
            (entity.light as unknown as { range: number }).range = spotRadius;
            entity.light.intensity = baseIntensity * TORCH_GSPLAT_POINTLIGHT_INTENSITY_SCALE;
        }

        const anchorDepth = runtime.hasHotspotDepth ?
            runtime.hotspotDepth :
            runtime.beamEnd * TORCH_HOTSPOT_FALLBACK_BEAM_RATIO;

        if (!worldPosAlongRay(anchorDepth, runtime.hotspotFromMesh)) {
            const cam = global.camera;
            const camPos = _tmpCamPos.copy(cam.getPosition());
            const fwd = (cam as unknown as { forward: Vec3 }).forward;
            _tmpForward.set(fwd.x, fwd.y, fwd.z);
            const fl = _tmpForward.length();
            if (fl > 1e-6) {
                _tmpForward.mulScalar(1 / fl);
                _tmpFallbackPos.set(
                    camPos.x + _tmpForward.x * anchorDepth,
                    camPos.y + _tmpForward.y * anchorDepth,
                    camPos.z + _tmpForward.z * anchorDepth
                );
                runtime.worldPos.copy(_tmpFallbackPos);
                runtime.screenU = 0.5;
                runtime.screenV = 0.5;
            } else {
                entity.light.enabled = false;
                return;
            }
        }

        entity.setPosition(runtime.worldPos.x, runtime.worldPos.y, runtime.worldPos.z);
        entity.light.enabled = true;
    };
    app.on('update', onUpdate);

    const onTorchParamsChanged = () => {
        applyParamsToEntity();
    };
    events.on('torchParams:changed', onTorchParamsChanged);

    const onTorchActiveChanged = () => {
        if (!readViewTorchActive(global)) return;
        forceImmediatePick = true;
        runtime.pickDirty = true;
        runtime.lastPickTime = Number.NEGATIVE_INFINITY;
        onUpdate();
    };
    events.on('torchActive:changed', onTorchActiveChanged);

    let lastEditLeftModule: EditLeftModule | null = global.state.editLeftModule ?? null;
    const onEditLeftModuleChanged = (next: EditLeftModule | null) => {
        const normalized: EditLeftModule | null = next ?? null;
        const leftEnvironment = lastEditLeftModule === 'environment' && normalized !== 'environment';
        lastEditLeftModule = normalized;
        if (!global.state.editMode) {
            return;
        }
        if (leftEnvironment && readViewTorchActive(global)) {
            applyViewTorchActive(global, false);
            onUpdate();
        }
    };
    events.on('editLeftModule:changed', onEditLeftModuleChanged);

    const onEditModeChanged = (editMode: boolean) => {
        if (editMode) return;
        if (readViewTorchActive(global)) {
            applyViewTorchActive(global, false);
            onUpdate();
        }
    };
    events.on('editMode:changed', onEditModeChanged);

    const handle: TorchControllerHandle = {
        get entity() {
            return entity as Entity;
        },
        setActive(active: boolean) {
            const vs = ensureViewSettings(global);
            if (!vs.torch) vs.torch = { active: false };
            vs.torch.active = !!active;
            if (active) resetPickRuntime();
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
                window.removeEventListener('pointermove', onWindowPointerMove);
                window.removeEventListener('pointerdown', onWindowPointerDown, { capture: true });
            } catch { /* ignore */ }
            app.off('update', onUpdate);
            events.off('torchParams:changed', onTorchParamsChanged);
            events.off('torchActive:changed', onTorchActiveChanged);
            events.off('editLeftModule:changed', onEditLeftModuleChanged);
            events.off('editMode:changed', onEditModeChanged);
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

export function getTorchLightEntity(global: Global): Entity | null {
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    return handle?.entity ?? null;
}

export function isTorchEntityEnabled(global: Global): boolean {
    const e = getTorchLightEntity(global);
    return !!(e && e.light && e.light.enabled);
}

export function getTorchLightScreenUv(global: Global): { u: number; v: number } | null {
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    const runtime = handle ? (handle as unknown as { __runtime?: TorchRuntimeState }).__runtime : undefined;
    if (!runtime || runtime.screenU === null || runtime.screenV === null) return null;
    return { u: runtime.screenU, v: runtime.screenV };
}

export function getTorchLightRay(global: Global): { origin: Vec3; direction: Vec3 } | null {
    if (!readViewTorchActive(global) && !isTorchEntityEnabled(global)) return null;
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    const runtime = handle ? (handle as unknown as { __runtime?: TorchRuntimeState }).__runtime : undefined;
    const camEntity = global.camera as Entity | undefined;
    const camComp = (camEntity as unknown as { camera?: { screenToWorld?: (x: number, y: number, z: number, out: Vec3) => Vec3; farClip?: number } })?.camera;
    if (!runtime || !camEntity || !camComp?.screenToWorld) return null;

    const cv = global.app.graphicsDevice.canvas as HTMLCanvasElement;
    const rect = cv.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;

    const u = runtime.screenU === null ? 0.5 : runtime.screenU;
    const v = runtime.screenV === null ? 0.5 : runtime.screenV;
    const sx = Math.max(0, Math.min(1, u)) * rect.width;
    const sy = (1 - Math.max(0, Math.min(1, v))) * rect.height;
    const origin = camEntity.getPosition().clone();
    const farPoint = camComp.screenToWorld(sx, sy, camComp.farClip ?? 1000, new Vec3());
    if (!farPoint || !Number.isFinite(farPoint.x)) return null;
    const direction = new Vec3(farPoint.x - origin.x, farPoint.y - origin.y, farPoint.z - origin.z);
    const len = direction.length();
    if (len < 1e-6) return null;
    direction.mulScalar(1 / len);
    return { origin, direction };
}

export function getTorchLightWorldPosition(global: Global): Vec3 | null {
    if (!readViewTorchActive(global) && !isTorchEntityEnabled(global)) return null;
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    const runtime = handle ? (handle as unknown as { __runtime?: TorchRuntimeState }).__runtime : undefined;
    if (!runtime) return null;
    return runtime.worldPos;
}

/** @deprecated Gsplat 使用 beamEnd；此函数返回聚光半径 spotRadius（cfg.range）。 */
export function getTorchLightEffectiveRange(global: Global): number {
    const cfg = ensureTorchLight(global.settings as ExperienceSettings) as TorchLightSettings;
    return Math.max(0, cfg.range ?? 12);
}

export function getTorchBeamParams(global: Global): TorchBeamParams | null {
    if (!readViewTorchActive(global) && !isTorchEntityEnabled(global)) return null;
    const handle = (global as unknown as { __torchLight?: TorchControllerHandle }).__torchLight;
    const runtime = handle ? (handle as unknown as { __runtime?: TorchRuntimeState }).__runtime : undefined;
    if (!runtime) return null;

    const cfg = ensureTorchLight(global.settings as ExperienceSettings) as TorchLightSettings;
    const spotRadius = Math.max(0, cfg.range ?? 12);
    const far = global.camera?.camera?.farClip ?? 1000;
    const beamEnd = Math.max(TORCH_BEAM_MIN_M, far * TORCH_BEAM_FAR_RATIO);

    return {
        beamEnd: runtime.beamEnd > 0 ? runtime.beamEnd : beamEnd,
        hotspotDepth: runtime.hasHotspotDepth ? runtime.hotspotDepth : 0,
        hasHotspot: runtime.hasHotspotDepth,
        hotspotFromMesh: runtime.hotspotFromMesh,
        spotRadius,
        fillWeight: TORCH_FILL_WEIGHT,
        hotspotWeight: TORCH_HOTSPOT_WEIGHT,
        meshHotspotBlend: runtime.hotspotFromMesh ? TORCH_MESH_HOTSPOT_SHADER_BLEND : 1
    };
}
