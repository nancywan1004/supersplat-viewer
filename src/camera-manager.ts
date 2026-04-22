import {
    BoundingBox,
    BLEND_NORMAL,
    Color,
    Entity,
    Layer,
    Mesh,
    MeshInstance,
    Pose,
    PRIMITIVE_LINES,
    StandardMaterial,
    Vec2,
    Vec3
} from 'playcanvas';

import { createRotateTrack } from './animation/create-rotate-track';
import { AnimController } from './cameras/anim-controller';
import { Camera, type CameraFrame, type CameraController } from './cameras/camera';
import { FlyController } from './cameras/fly-controller';
import { OrbitController } from './cameras/orbit-controller';
import { easeOut, smootherStep } from './core/math';
import { Annotation } from './settings';
import type { AnimTrack } from './settings';
import { CameraMode, Global } from './types';
import { SphereConstraint } from './camera-constraints/sphere-constraint';
import { BoxConstraint } from './camera-constraints/box-constraint';
import { selectNearestLightAtPosition } from './light';
import { getSelectedSceneEntity } from './state-selectors';
import type { InputArbiter } from './input-arbiter';

const tmpCamera = new Camera();
const tmpv = new Vec3();
/** F 键 / inputEvent「frame」分支里，用于承接「选中项世界坐标」的临时 Vec3（避免每帧分配）。 */
const tmpFocus = new Vec3();
/** 非资产对象（如双击拾取点）聚焦时，按当前距离比例收束。 */
const ORBIT_FOCUS_DISTANCE_SCALE = 0.2;
const ORBIT_FOCUS_MIN_DISTANCE = 1.0;
/** 资产 bbox 聚焦时，目标占据视野半角比例（越小留白越多）。 */
const ASSET_FOCUS_HALF_FOV_FILL = 0.72;
/** gaussian / gsplat 资产的取景距离补偿，拉近到更接近 mesh 的主观构图。 */
const GAUSSIAN_ASSET_FOCUS_DISTANCE_SCALE = 0.6;
/** 极小资产时的最小包围球半径，避免距离退化到 0。 */
const MIN_FOCUS_RADIUS = 1e-3;

type FocusTarget = 'asset' | 'annotation' | 'light';

/**
 * 编辑模式下解析「应对准」的世界坐标，供 frame/选中协议聚焦对象。
 * 默认仅当 `editLeftModule` 与选中态一致时生效，避免跨模块误用旧选中；
 * 当传入 `focusTarget` 时，按指定目标优先解析（用于 ASSET_SELECT / LIGHT_SELECT 直达聚焦）。
 *
 * - asset：选中场景实体的世界位置
 * - annotation：`settings.annotations` 中当前选中项的 `position`
 * - environment：当前选中点光/聚光的 `position`（directional 不参与）
 * @returns 已写入 `out` 则为 true，否则 false（调用方回退为框整场景 frameCamera）
 */
function fillEditFocus(global: Global, out: Vec3, focusTarget?: FocusTarget): boolean {
    const { state, settings } = global;
    if (!state.editMode) return false;
    const tryAsset = () => {
        if (!state.selectedSceneEntityId) return false;
        const ent = getSelectedSceneEntity(state);
        if (ent) {
            out.copy(ent.getPosition());
            return true;
        }
        return false;
    };
    const tryAnnotation = () => {
        if (!state.selectedAnnotationId) return false;
        const list = settings.annotations;
        if (Array.isArray(list)) {
            const ann = list.find((a) => a && a.id === state.selectedAnnotationId);
            const p = ann?.position;
            if (
                Array.isArray(p) &&
                p.length >= 3 &&
                Number.isFinite(p[0]) &&
                Number.isFinite(p[1]) &&
                Number.isFinite(p[2])
            ) {
                out.set(p[0], p[1], p[2]);
                return true;
            }
        }
        return false;
    };
    const tryLight = () => {
        if (!state.selectedLightId) return false;
        const lights = settings.lighting?.lights;
        if (Array.isArray(lights)) {
            const L = lights.find((l: any) => l && l.id === state.selectedLightId) as
                | { type?: string; position?: number[] }
                | undefined;
            if (!L || L.type === 'directional') return false;
            const p = L.position;
            if (
                Array.isArray(p) &&
                p.length >= 3 &&
                Number.isFinite(p[0]) &&
                Number.isFinite(p[1]) &&
                Number.isFinite(p[2])
            ) {
                out.set(p[0], p[1], p[2]);
                return true;
            }
        }
        return false;
    };

    if (focusTarget === 'asset') return tryAsset();
    if (focusTarget === 'annotation') return tryAnnotation();
    if (focusTarget === 'light') return tryLight();

    const mod = state.editLeftModule;
    if (mod === 'asset') return tryAsset();
    if (mod === 'annotation') return tryAnnotation();
    if (mod === 'environment') return tryLight();
    return false;
}

function computeEntityWorldBoundingBox(entity: Entity): BoundingBox | null {
    const meshInstances: Array<{ aabb?: BoundingBox }> = [];
    const collectMeshInstances = (node: Entity) => {
        const renderComp = (node as Entity & { render?: { meshInstances?: Array<{ aabb?: BoundingBox }> } }).render;
        const instances = renderComp?.meshInstances;
        if (instances && instances.length > 0) {
            for (const mi of instances) meshInstances.push(mi);
        }
        const children = node.children;
        if (children && children.length > 0) {
            for (const child of children) collectMeshInstances(child as Entity);
        }
    };
    collectMeshInstances(entity);

    if (meshInstances.length > 0) {
        const min = new Vec3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
        const max = new Vec3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
        let hasValidAabb = false;
        for (const mi of meshInstances) {
            const aabb = mi.aabb;
            if (!aabb) continue;
            hasValidAabb = true;
            min.min(aabb.getMin());
            max.max(aabb.getMax());
        }
        if (hasValidAabb) {
            const center = min.clone().add(max).mulScalar(0.5);
            const half = max.clone().sub(min).mulScalar(0.5);
            return new BoundingBox(center, half);
        }
    }

    const gsplat = (entity as Entity & { gsplat?: { customAabb?: BoundingBox | null; aabb?: BoundingBox } }).gsplat;
    const gsAabb = gsplat?.customAabb ?? gsplat?.aabb;
    if (gsAabb) {
        const worldAabb = new BoundingBox();
        worldAabb.setFromTransformedAabb(gsAabb, entity.getWorldTransform());
        return worldAabb;
    }
    return null;
}

function computeDistanceForAssetFraming(bbox: BoundingBox, fovDeg: number, aspect: number, viewDir: Vec3): number {
    const verticalHalf = Math.max(1e-4, (fovDeg * Math.PI / 180) * 0.5) * ASSET_FOCUS_HALF_FOV_FILL;
    const horizontalHalf = Math.max(1e-4, Math.atan(Math.tan(verticalHalf / ASSET_FOCUS_HALF_FOV_FILL) * Math.max(aspect, 1e-4))) * ASSET_FOCUS_HALF_FOV_FILL;

    const forward = viewDir.clone();
    if (forward.lengthSq() <= 1e-10) {
        forward.set(0, 0, -1);
    } else {
        forward.normalize();
    }

    const refUp = Math.abs(forward.y) > 0.98 ? new Vec3(0, 0, 1) : new Vec3(0, 1, 0);
    const right = new Vec3().cross(refUp, forward).normalize();
    const up = new Vec3().cross(forward, right).normalize();

    const center = bbox.center;
    const half = bbox.halfExtents;
    let maxHalfWidth = 0;
    let maxHalfHeight = 0;
    let maxHalfDepth = 0;

    for (const sx of [-1, 1]) {
        for (const sy of [-1, 1]) {
            for (const sz of [-1, 1]) {
                const rel = new Vec3(half.x * sx, half.y * sy, half.z * sz);
                maxHalfWidth = Math.max(maxHalfWidth, Math.abs(rel.dot(right)));
                maxHalfHeight = Math.max(maxHalfHeight, Math.abs(rel.dot(up)));
                maxHalfDepth = Math.max(maxHalfDepth, Math.abs(rel.dot(forward)));
            }
        }
    }

    const distanceByWidth = maxHalfWidth / Math.tan(horizontalHalf);
    const distanceByHeight = maxHalfHeight / Math.tan(verticalHalf);
    return Math.max(MIN_FOCUS_RADIUS, Math.max(distanceByWidth, distanceByHeight) + maxHalfDepth);
}

const unionBoundingBoxes = (a: BoundingBox, b: BoundingBox): BoundingBox => {
    const amin = a.getMin();
    const amax = a.getMax();
    const bmin = b.getMin();
    const bmax = b.getMax();

    const min = new Vec3(
        Math.min(amin.x, bmin.x),
        Math.min(amin.y, bmin.y),
        Math.min(amin.z, bmin.z)
    );
    const max = new Vec3(
        Math.max(amax.x, bmax.x),
        Math.max(amax.y, bmax.y),
        Math.max(amax.z, bmax.z)
    );

    const center = min.clone().add(max).mulScalar(0.5);
    const half = max.clone().sub(min).mulScalar(0.5);
    return new BoundingBox(center, half);
};

/**
 * 优先根据 settingsJson(animTracks) 计算一个“核心区域” BoundingBox：
 * - 用所有 animTracks 的 position + target 点集做 AABB
 * - 给 AABB 加一点 padding（避免太贴边导致操作手感变差）
 * - 若没有有效路径点，返回 null，由调用方回退到场景 bbox
 */
const computeAnimTracksBoundingBox = (animTracks: AnimTrack[] | undefined | null): BoundingBox | null => {
    if (!animTracks || animTracks.length === 0) {
        return null;
    }

    let minX = Infinity, minY = Infinity, minZ = Infinity;
    let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;

    const expandWithArray = (arr: number[] | undefined) => {
        if (!arr || arr.length < 3) return;
        for (let i = 0; i + 2 < arr.length; i += 3) {
            const x = arr[i];
            const y = arr[i + 1];
            const z = arr[i + 2];
            if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (z < minZ) minZ = z;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            if (z > maxZ) maxZ = z;
        }
    };

    for (const track of animTracks) {
        const values = track?.keyframes?.values;
        expandWithArray(values?.position);
        expandWithArray(values?.target);
    }

    if (!Number.isFinite(minX) || !Number.isFinite(maxX)) {
        return null;
    }

    const center = new Vec3(
        (minX + maxX) * 0.5,
        (minY + maxY) * 0.5,
        (minZ + maxZ) * 0.5
    );
    const half = new Vec3(
        (maxX - minX) * 0.5,
        (maxY - minY) * 0.5,
        (maxZ - minZ) * 0.5
    );

    // padding：对小盒子给固定最小值，对大盒子按尺寸比例放大
    const maxAxisSize = Math.max(maxX - minX, maxY - minY, maxZ - minZ);
    const pad = Math.max(0.5, maxAxisSize * 0.05);
    half.x += pad;
    half.y += pad;
    half.z += pad;

    return new BoundingBox(center, half);
};

const createCamera = (position: Vec3, target: Vec3, fov: number) => {
    const result = new Camera();
    result.look(position, target);
    result.fov = fov;
    return result;
};

const createFrameCamera = (bbox: BoundingBox, fov: number) => {
    const sceneSize = bbox.halfExtents.length();
    const distance = sceneSize / Math.sin(fov / 180 * Math.PI * 0.5);
    return createCamera(
        new Vec3(2, 1, 2).normalize().mulScalar(distance).add(bbox.center),
        bbox.center,
        fov
    );
};

class CameraManager {
    update: (deltaTime: number, cameraFrame: CameraFrame) => void;

    // holds the camera state
    camera = new Camera();

    /** 动画控制器（用于导出时按时间轴 seek 相机） */
    animController: AnimController | null = null;

    // visual marker for picked point
    private pickMarker: Entity | null = null;

    // 相机约束
    private constraint: SphereConstraint | null = null;
    private targetConstraint: BoxConstraint | null = null;

    /**
     * 获取 target constraint（用于 reveal 效果等）
     */
    getTargetConstraint(): BoxConstraint | null {
        return this.targetConstraint;
    }
    private constraintVisualizer: Entity | null = null;
    private cameraBoundsVisualizer: Entity | null = null;
    private debugBoundsLayerId: number | null = null;
    private cameraEntity: Entity;

    constructor(global: Global, bbox: BoundingBox) {
        const { events, settings, state, config, app, camera: cameraEntity } = global;
        this.cameraEntity = cameraEntity;

        // // Create a visual marker for picked points
        // const markerMaterial = new StandardMaterial();
        // markerMaterial.diffuse = new Color(1, 0, 0); // Red
        // markerMaterial.emissive = new Color(0.5, 0, 0); // Glowing red
        // markerMaterial.update();

        // this.pickMarker = new Entity('pickMarker');
        // this.pickMarker.addComponent('render', {
        //     type: 'sphere',
        //     material: markerMaterial
        // });
        // this.pickMarker.setLocalScale(0.3, 0.3, 0.3);
        // this.pickMarker.enabled = false;
        // app.root.addChild(this.pickMarker);

        const camera0 = settings.cameras[0].initial;
        const frameCamera = createFrameCamera(bbox, camera0.fov);
        const resetCamera = createCamera(new Vec3(camera0.position), new Vec3(camera0.target), camera0.fov);

        const getAnimTrack = (initial: Camera, isObjectExperience: boolean) => {
            const { animTracks } = settings;

            // extract the camera animation track from settings
            if (animTracks?.length > 0 && settings.startMode === 'animTrack') {
                // use the first animTrack
                return animTracks[0];
            } else if (isObjectExperience && !config.noautorotate) {
                // create basic rotation animation if no anim track is specified
                initial.calcFocusPoint(tmpv);
                return createRotateTrack(initial.position, tmpv, initial.fov);
            }
            return null;
        };

        // object experience starts outside the bounding box
        const isObjectExperience = !bbox.containsPoint(resetCamera.position);
        const animTrack = getAnimTrack(settings.hasStartPose ? resetCamera : frameCamera, isObjectExperience);

        const controllers = {
            orbit: new OrbitController(),
            fly: new FlyController(),
            anim: animTrack ? new AnimController(animTrack) : null
        };
        this.animController = controllers.anim;

        // 约束边界（融合策略）：
        // - 若有动画路径：用 anim AABB 与 scene AABB 做 union（避免 anim→orbit / orbit→fly 切换时发生 clamp 跳变）
        // - 若无动画路径：直接使用 scene bbox
        const animCoreBbox = computeAnimTracksBoundingBox(settings.animTracks);
        const usingAnimBbox = !!animCoreBbox;
        // TODO: 暂时不使用fusedBbox，而是直接使用animCoreBbox，后续根据情况来优化
        const fusedBbox = animCoreBbox ? animCoreBbox : bbox;

        // 可视化：相机 BoundingBox（AABB）
        // - 优先显示 animCoreBbox（紫色）
        // - 若无 animCoreBbox，则显示场景 bbox
        // - 独立于 “Show Camera Path”，通过 Settings -> Show Camera BoundingBox 控制
        const bboxForCameraBounds = animCoreBbox ?? bbox;
        this.cameraBoundsVisualizer = this.createBoundingBoxVisualizer(app, bboxForCameraBounds, new Color(1, 0, 1, 1));
        this.cameraBoundsVisualizer.enabled = !!(state as any).showCameraBoundingBox;
        events.on('showCameraBoundingBox:changed', (visible: boolean) => {
            if (this.cameraBoundsVisualizer) {
                this.cameraBoundsVisualizer.enabled = visible;
            }
        });

        // 约束策略：
        // - Orbit：限制 **camera.position** 在收缩后的 bbox 内（与 Fly 保持一致；避免两种模式边界不对齐）
        // - Fly：保持原球形硬边界兜底（防止飞行穿出场景太远）
        const cameraBoundsCfg = settings.cameraBounds;
        // 基础开关：由配置与 settings 决定（不含编辑态临时覆盖）
        const baseBoundsEnabled = !config.disableCameraBounds && cameraBoundsCfg?.enabled !== false; // 默认启用

        // 无动画时维持更"核心"的收缩范围；有动画时使用 animScaleX/animScaleY
        const targetScaleFactor = 1; // 非动画路径的固定缩放系数

        if (baseBoundsEnabled) {
            // 只有在有动画路径时，才使用 animScaleX/animScaleY 来分别设置各轴缩放
            // 对于非动画路径，维持原来的 targetScaleFactor 逻辑
            if (usingAnimBbox) {
                // 使用 animScaleX 和 animScaleY，支持数组格式分别设置左右和上下
                // 如果没有设置则使用默认值 1.5
                const defaultAnimScale = 1.5;
                const animScaleX = cameraBoundsCfg?.animScaleX ?? defaultAnimScale;
                const animScaleY = cameraBoundsCfg?.animScaleY ?? defaultAnimScale;
                this.targetConstraint = BoxConstraint.fromBoundingBoxWithAsymmetricScales(
                    fusedBbox,
                    defaultAnimScale, // Z 轴使用默认值
                    animScaleX,
                    animScaleY
                );
            } else {
                this.targetConstraint = BoxConstraint.fromBoundingBox(fusedBbox, targetScaleFactor);
            }
        } else {
            // 禁用约束
            this.targetConstraint = null;
        }

        this.constraint = SphereConstraint.fromBoundingBox(fusedBbox, targetScaleFactor);
        // 编辑态覆盖：进入编辑模式时临时关约束，退出回到 View 时恢复基础开关
        const applyCameraBoundsEnabled = (enabled: boolean) => {
            const targetConstraint = enabled ? this.targetConstraint : null;
            controllers.orbit.setTargetConstraint(targetConstraint);
            controllers.fly.setTargetConstraint(targetConstraint);
            // 与 target 约束同开关，保证“彻底不限制相机”
            controllers.fly.setConstraint(enabled ? this.constraint : null);
        };
        applyCameraBoundsEnabled(baseBoundsEnabled && !state.editMode);

        // 给 orbit 设置一个合理的最大缩放距离（避免无限 zoom-out 让场景跑出视野）
        // 之前的系数偏小，会导致 orbit 很早到达 maxZoom；切到 fly（通过位置平移）看起来还能继续"退远"。
        // 这里改为基于"可 frame 场景的距离"的倍数，默认更宽松，手感与 fly 更一致。
        const sceneSize = fusedBbox.halfExtents.length();
        const frameDistance = sceneSize / Math.sin(camera0.fov / 180 * Math.PI * 0.5);
        const maxZoomMultiplier = 0.5;
        const maxZoom = frameDistance * maxZoomMultiplier;
        controllers.orbit.controller.zoomRange = new Vec2(0.5, maxZoom);
        // Fly 的 focusDistance 也 clamp 到同一 zoomRange，保证两种模式 target clamp 时的"相机位置外壳范围"一致
        controllers.fly.setFocusDistanceRange(controllers.orbit.controller.zoomRange);

        // 应用俯仰角限制配置
        const pitchRange = settings.cameras[0].pitchRange;
        if (pitchRange && Array.isArray(pitchRange) && pitchRange.length === 2) {
            const pitchVec2 = new Vec2(pitchRange[0], pitchRange[1]);
            controllers.orbit.controller.pitchRange = pitchVec2;
            controllers.fly.pitchRange = pitchVec2;
        }

        const getController = (cameraMode: 'orbit' | 'anim' | 'fly'): CameraController => {
            return controllers[cameraMode];
        };

        // set the global animation flag
        state.hasAnimation = !!controllers.anim;
        state.animationDuration = controllers.anim ? controllers.anim.animState.cursor.duration : 0;

        // initialize camera mode and initial camera position
        // 优先使用配置中的 initialCameraMode，如果没有配置则按原有逻辑
        if (state.hasAnimation) {
            state.cameraMode = 'anim';
        } else {
            // 读取配置中的初始相机模式，默认为 'orbit'
            const initialMode = settings.initialCameraMode;
            if (initialMode === 'fly' || initialMode === 'orbit') {
                state.cameraMode = initialMode;
            } else {
                state.cameraMode = 'orbit'; // 默认值
            }
        }
        this.camera.copy(resetCamera);

        const target = new Camera(this.camera);             // the active controller updates this
        const from = new Camera(this.camera);               // stores the previous camera state during transition
        let fromMode: CameraMode = 'orbit';

        // enter the initial controller
        getController(state.cameraMode).onEnter(this.camera);

        // transition state
        const transitionSpeed = 1.0;
        let transitionTimer = 1;

        // start a new camera transition from the current pose
        const startTransition = () => {
            from.copy(this.camera);
            transitionTimer = 0;
        };

        // application update
        this.update = (deltaTime: number, frame: CameraFrame) => {

            // use dt of 0 if animation is paused
            const dt = state.cameraMode === 'anim' && state.animationPaused ? 0 : deltaTime;

            // update transition timer
            transitionTimer = Math.min(1, transitionTimer + deltaTime * transitionSpeed);

            const controller = getController(state.cameraMode);

            controller.update(dt, frame, target);

            if (transitionTimer < 1) {
                // lerp away from previous camera during transition
                // Use smootherStep for ultra-smooth transitions
                this.camera.lerp(from, target, smootherStep(transitionTimer));
            } else {
                this.camera.copy(target);
            }

            // Auto-switch from orbit to fly when zoomed to minimum distance
            // This allows seamless transition when user wants to get closer
            // Check target.distance (updated by orbit controller) not this.camera.distance
            if (state.cameraMode === 'orbit' && transitionTimer >= 1) {
                const minZoom = controllers.orbit.controller.zoomRange.x;
                const minZoomThreshold = minZoom + 0.05;
                // target 为控制器本帧目标，this.camera 为插值后的当前值；二者取最小可覆盖偶发不同步。
                const effectiveDistance = Math.min(target.distance, this.camera.distance);

                // 到达 orbit 最小缩放壳后自动切 fly，避免滚轮继续缩放时“顶住卡死”。
                if (effectiveDistance <= minZoomThreshold) {
                    console.log('Auto-switching to fly mode:', {
                        effectiveDistance,
                        targetDistance: target.distance,
                        currentDistance: this.camera.distance,
                        minZoomThreshold
                    });
                    // 直接写 state，走 observe 自动派发 cameraMode:changed（统一触发 onExit/onEnter）。
                    state.cameraMode = 'fly';
                }
            }

            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = controllers.anim.animState.cursor.value;
            }
        };

        /**
         * 将 Orbit 相机对准某一世界坐标点（目标落在画面中心附近）。
         * - 未指定 distance 时按当前相机与目标距离比例收束（用于 pick 等点目标）
         * - 指定 distance 时可用于 bbox framing（例如资产 focus）
         */
        const orbitFocus = (position: Vec3, distance?: number) => {
            if (state.cameraMode !== 'orbit') {
                state.cameraMode = 'orbit';
            }
            tmpCamera.copy(this.camera);
            // 从相机指向目标的方向，在目标附近取新机位，再 lookAt 目标
            tmpv.copy(position).sub(this.camera.position).normalize();
            const currentDistance = position.distance(this.camera.position);
            const zoomRange = controllers.orbit.controller.zoomRange;
            const fallbackDistance = Math.max(ORBIT_FOCUS_MIN_DISTANCE, currentDistance * ORBIT_FOCUS_DISTANCE_SCALE);
            const targetDistance = Math.max(
                zoomRange.x,
                Math.min(zoomRange.y, distance ?? fallbackDistance)
            );
            tmpv.mulScalar(-targetDistance).add(position);
            tmpCamera.position.copy(tmpv);
            tmpCamera.look(tmpv, position);
            controllers.orbit.goto(tmpCamera);
            startTransition();
        };

        const orbitFocusSelectedAssetWithFraming = () => {
            const selected = state.selectedSceneEntityId ? getSelectedSceneEntity(state) : null;
            if (!selected) return false;
            const bbox = computeEntityWorldBoundingBox(selected);
            if (!bbox) return false;
            const aspect = cameraEntity.camera?.aspectRatio ?? (app.graphicsDevice.width / Math.max(1, app.graphicsDevice.height));
            const fitDistance = computeDistanceForAssetFraming(
                bbox,
                this.camera.fov,
                aspect,
                bbox.center.clone().sub(this.camera.position)
            );
            const isGaussianAsset = !!((selected as Entity & { gsplat?: unknown }).gsplat);
            const focusDistance = fitDistance * (isGaussianAsset ? GAUSSIAN_ASSET_FOCUS_DISTANCE_SCALE : 1);
            orbitFocus(bbox.center, focusDistance);
            return true;
        };

        // handle input events
        events.on('inputEvent', (eventName, event) => {
            switch (eventName) {
                case 'frame':
                    // F 键 / UI「Frame」：优先聚焦当前编辑模块下的选中项，否则整场景 framing
                    {
                        const focusTarget = (event as { focusTarget?: FocusTarget } | undefined)?.focusTarget;
                        const shouldUseAssetFraming =
                            focusTarget === 'asset' ||
                            (!focusTarget && state.editMode && state.editLeftModule === 'asset');
                        if (shouldUseAssetFraming && orbitFocusSelectedAssetWithFraming()) {
                            (event as KeyboardEvent | undefined)?.preventDefault?.();
                            break;
                        }
                    }
                    if (fillEditFocus(global, tmpFocus, (event as { focusTarget?: FocusTarget } | undefined)?.focusTarget)) {
                        (event as KeyboardEvent | undefined)?.preventDefault?.();
                        orbitFocus(tmpFocus);
                        break;
                    }
                    state.cameraMode = 'orbit';
                    controllers.orbit.goto(frameCamera);
                    startTransition();
                    break;
                case 'reset':
                    state.cameraMode = 'orbit';
                    controllers.orbit.goto(resetCamera);
                    startTransition();
                    break;
                case 'playPause':
                    if (state.hasAnimation) {
                        if (state.cameraMode === 'anim') {
                            state.animationPaused = !state.animationPaused;
                        } else {
                            state.cameraMode = 'anim';
                            state.animationPaused = false;
                        }
                    }
                    break;
                case 'resetAnim':
                    if (state.hasAnimation && controllers.anim) {
                        state.cameraMode = 'anim';
                        state.animationPaused = false;
                        // 重置动画光标到初始位置（时间0）
                        controllers.anim.animState.cursor.value = 0;
                        controllers.anim.animState.cursor.timer = 0;
                        // 更新动画状态以应用初始相机位置
                        controllers.anim.animState.update(0);
                        // 确保相机使用动画的初始位置
                        controllers.anim.onEnter(this.camera);
                    }
                    break;
                case 'cancel':
                case 'interrupt':
                    if (state.cameraMode === 'anim') {
                        state.cameraMode = fromMode;
                    }
                    break;
            }
        });

        // handle camera mode switching
        events.on('cameraMode:changed', (value, prev) => {
            // snapshot the current pose before any controller mutation
            startTransition();

            target.copy(this.camera);
            fromMode = prev;

            // exit the old controller
            const prevController = getController(prev);
            prevController.onExit(this.camera);

            // Adjust distance when switching from fly to orbit
            // Fly mode uses very small distance, but orbit needs a reasonable distance
            // to define the focus point. We keep the camera position unchanged and just
            // adjust the distance to set where the orbit focus point will be.
            if (prev === 'fly' && value === 'orbit') {
                // Use a distance that's above the minimum zoom range (0.5) to avoid
                // the orbit controller trying to adjust the camera position
                const minOrbitDistance = 3.0;
                if (this.camera.distance < minOrbitDistance) {
                    // Only adjust distance, camera position stays the same
                    // The focus point will be calculated as: position + direction * distance
                    this.camera.distance = minOrbitDistance;
                }
            }

            // enter new controller
            const newController = getController(value);
            newController.onEnter(this.camera);
            
            // notify input controller about mode change
            events.fire('cameraModeChanged', value, prev);
        });

        events.on('editMode:changed', (inEdit: boolean) => {
            applyCameraBoundsEnabled(baseBoundsEnabled && !inEdit);
        });

        // handle user scrubbing the animation timeline
        events.on('scrubAnim', (time) => {
            // switch to animation camera if we're not already there
            state.cameraMode = 'anim';

            // set time
            controllers.anim.animState.cursor.value = time;
        });

        // handle user picking in the scene（双击/双指点）
        events.on('pick', (position: Vec3) => {
            // Show visual marker at picked position
            // if (this.pickMarker) {
            //     this.pickMarker.setPosition(position);
            //     this.pickMarker.enabled = true;

            //     // Hide marker after 3 seconds
            //     setTimeout(() => {
            //         if (this.pickMarker) {
            //             this.pickMarker.enabled = false;
            //         }
            //     }, 3000);
            // }

            // 双击拾取点：与 F 键选中聚焦同一条 orbit 对准逻辑
            orbitFocus(position);

            // Fly mode version (commented out for now, as requested)
            // if (currentMode === 'fly') {
            //     const targetPose = new Pose();
            //     targetPose.position.copy(tmpCamera.position);
            //     targetPose.angles.copy(tmpCamera.angles);
            //     targetPose.distance = tmpCamera.distance;
            //     controllers.fly.goto(targetPose);
            // }
        });

        const inputArbiter = (global as any).__inputArbiter as InputArbiter | undefined;
        inputArbiter?.registerPointerClickHandler({
            id: 'camera.light-selection',
            priority: 10,
            handle: ({ worldPosition, clientX, clientY }) => {
                if (!worldPosition) return false;
                selectNearestLightAtPosition(global, worldPosition, clientX, clientY);
                return true;
            }
        });

        events.on('annotation.activate', (annotation: Annotation) => {
            // switch to orbit camera on pick (only if not already in orbit mode)
            if (state.cameraMode !== 'orbit') {
                state.cameraMode = 'orbit';
            }

            // AnnotationEntity 的 camera 在 data 中；普通 Annotation 可能在 annotation.camera
            const ann = annotation as { camera?: { initial?: any }; data?: { camera?: { initial?: any } } };
            const camera = ann.camera ?? ann.data?.camera;
            if (!camera?.initial) return;

            const { initial } = camera;
            // 占位标注的 camera.initial 为 [0,0,0]，跳过相机过渡避免 zoom 到原点
            const pos = initial.position;
            const tgt = initial.target;
            if (Array.isArray(pos) && pos[0] === 0 && pos[1] === 0 && pos[2] === 0 &&
                Array.isArray(tgt) && tgt[0] === 0 && tgt[1] === 0 && tgt[2] === 0) {
                return;
            }

            // construct camera
            tmpCamera.fov = initial.fov;
            tmpCamera.look(
                new Vec3(initial.position),
                new Vec3(initial.target)
            );

            controllers.orbit.goto(tmpCamera);
            target.fov = tmpCamera.fov;
            startTransition();
        });
    }

    /**
     * 将 animTrack 定位到指定时间并更新相机姿态（用于导出时与 VFX 时间轴同步录制相机动画）
     */
    seekAnimToTime(time: number): void {
        const anim = this.animController;
        if (!anim) return;
        const { cursor, position, target } = anim.animState;
        const duration = cursor.duration;
        const t = Math.max(0, Math.min(time, duration));
        (cursor as { cursor: number }).cursor = t;
        cursor.timer = 0;
        anim.animState.update(0);
        this.camera.look(position, target);
    }

    private ensureDebugBoundsLayer(app: any): number {
        if (this.debugBoundsLayerId !== null) {
            return this.debugBoundsLayerId;
        }

        const layers = app.scene.layers;
        let layer = layers.getLayerByName('DebugBounds');
        if (!layer) {
            layer = new Layer({ name: 'DebugBounds' });
            // 放到最后渲染，确保不被 gsplat/场景覆盖
            layers.push(layer);
        }

        this.debugBoundsLayerId = layer.id;

        // 确保主相机渲染该 layer
        const cam = this.cameraEntity?.camera;
        if (cam && cam.layers.indexOf(layer.id) < 0) {
            cam.layers = [...cam.layers, layer.id];
        }

        return layer.id;
    }

    /**
     * 创建 BoundingBox 可视化（线框盒子）
     * - 用于调试动画路径计算出的 AABB 边界
     */
    private createBoundingBoxVisualizer(app: any, bbox: BoundingBox, color: Color): Entity {
        const lineEntity = new Entity('animBoundsAABB');

        // 8 corners
        const min = bbox.getMin();
        const max = bbox.getMax();
        const p: number[] = [
            // 0..7 positions
            min.x, min.y, min.z, // 0
            max.x, min.y, min.z, // 1
            max.x, min.y, max.z, // 2
            min.x, min.y, max.z, // 3
            min.x, max.y, min.z, // 4
            max.x, max.y, min.z, // 5
            max.x, max.y, max.z, // 6
            min.x, max.y, max.z  // 7
        ];

        // 12 edges as line segments (pairs of indices)
        const indices: number[] = [
            0, 1, 1, 2, 2, 3, 3, 0, // bottom
            4, 5, 5, 6, 6, 7, 7, 4, // top
            0, 4, 1, 5, 2, 6, 3, 7  // verticals
        ];

        const mesh = new Mesh(app.graphicsDevice);
        mesh.setPositions(p);
        mesh.setIndices(indices);
        // 关键：以线段方式渲染（否则会被当成三角形索引绘制）
        mesh.update(PRIMITIVE_LINES);

        const material = new StandardMaterial();
        material.diffuse = color;
        material.emissive = color;
        material.emissiveIntensity = 0.75;
        material.opacity = 0.95;
        material.blendType = BLEND_NORMAL;
        // 调试线框：总是可见，但不会像填充面一样“染背景”
        material.depthWrite = false;
        material.depthTest = false;
        material.update();

        const layerId = this.ensureDebugBoundsLayer(app);

        lineEntity.addComponent('render', {
            type: 'asset',
            layers: [layerId],
            meshInstances: [new MeshInstance(mesh, material)]
        });

        // 避免影响光照/阴影
        const renderComponent = lineEntity.render;
        if (renderComponent) {
            renderComponent.castShadows = false;
            renderComponent.receiveShadows = false;
        }

        app.root.addChild(lineEntity);
        return lineEntity;
    }

    /**
     * 设置约束可视化可见性
     */
    setConstraintVisualizerVisible(visible: boolean): void {
        if (this.constraintVisualizer) {
            this.constraintVisualizer.enabled = visible;
        }
    }
}

export { CameraManager };
