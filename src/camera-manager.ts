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

const tmpCamera = new Camera();
const tmpv = new Vec3();

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

    // visual marker for picked point
    private pickMarker: Entity | null = null;

    // 相机约束
    private constraint: SphereConstraint | null = null;
    private targetConstraint: BoxConstraint | null = null;
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
        // 注意：animScale 允许 >1（放大），用于给"融合后 bbox"留出余量，减少贴边与切换抖动。
        const cameraBoundsCfg = (settings as any).cameraBounds as undefined | {
            animScale?: number;
            enabled?: boolean;
        };
        const animScale = Math.max(0.01, cameraBoundsCfg?.animScale ?? 1.5);
        const boundsEnabled = cameraBoundsCfg?.enabled !== false; // 默认启用

        // 无动画时维持更"核心"的收缩范围；有动画时以融合 bbox 为主，缩放更保守，优先避免跳变
        const targetScaleFactor = usingAnimBbox ? animScale : 0.5;

        if (boundsEnabled) {
            this.targetConstraint = BoxConstraint.fromBoundingBox(fusedBbox, targetScaleFactor);
            controllers.orbit.setTargetConstraint(this.targetConstraint);
            controllers.fly.setTargetConstraint(this.targetConstraint);
        } else {
            // 禁用约束
            this.targetConstraint = null;
            controllers.orbit.setTargetConstraint(null);
            controllers.fly.setTargetConstraint(null);
        }

        this.constraint = SphereConstraint.fromBoundingBox(fusedBbox, targetScaleFactor);
        // fly 仍保留一个球形硬边界兜底（仅在没有 box 约束时才会用到），不影响两种模式的主约束一致性
        controllers.fly.setConstraint(this.constraint);

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
        state.cameraMode = state.hasAnimation ? 'anim' : 'orbit';
        this.camera.copy(resetCamera);

        const target = new Camera(this.camera);             // the active controller updates this
        const from = new Camera(this.camera);               // stores the previous camera state during transition
        let fromMode: CameraMode = 'orbit';

        // enter the initial controller
        getController(state.cameraMode).onEnter(this.camera);

        // transition time between cameras
        const transitionSpeed = 2.0;
        let transitionTimer = 1;

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
                const minZoomThreshold = 0.55; // Just above the minimum zoom range (0.5)
                
                // Switch to fly mode when at minimum zoom distance
                // This allows user to continue moving closer
                if (target.distance <= minZoomThreshold) {
                    console.log('Auto-switching to fly mode: target.distance =', target.distance);
                    state.cameraMode = 'fly';
                }
            }

            // update animation timeline
            if (state.cameraMode === 'anim') {
                state.animationTime = controllers.anim.animState.cursor.value;
            }
        };

        // handle input events
        events.on('inputEvent', (eventName, event) => {
            switch (eventName) {
                case 'frame':
                    state.cameraMode = 'orbit';
                    controllers.orbit.goto(frameCamera);
                    break;
                case 'reset':
                    state.cameraMode = 'orbit';
                    controllers.orbit.goto(resetCamera);
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
            // store previous camera mode and pose
            target.copy(this.camera);
            from.copy(this.camera);
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

            // reset camera transition timer
            transitionTimer = 0;
            
            // notify input controller about mode change
            events.fire('cameraModeChanged', value, prev);
        });

        // handle user scrubbing the animation timeline
        events.on('scrubAnim', (time) => {
            // switch to animation camera if we're not already there
            state.cameraMode = 'anim';

            // set time
            controllers.anim.animState.cursor.value = time;
        });

        // handle user picking in the scene
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

            // Switch to orbit mode on double-tap (only if not already in orbit mode)
            if (state.cameraMode !== 'orbit') {
                state.cameraMode = 'orbit';
            }

            // construct camera - look at the picked target from current position
            tmpCamera.copy(this.camera);
            
            // Calculate direction from camera to picked point
            const direction = tmpv.copy(position).sub(this.camera.position).normalize();
            
            // Calculate a good viewing distance (move much closer to target)
            const currentDistance = position.distance(this.camera.position);
            // Use a smaller multiplier (0.2) and lower minimum (1.0) to get closer
            const targetDistance = Math.max(1.0, currentDistance * 0.2);
            
            // Position camera at the target distance, looking at the picked point
            const newPosition = tmpv.copy(direction).mulScalar(-targetDistance).add(position);
            tmpCamera.position.copy(newPosition);
            
            // Make camera look at the picked point (this centers the target)
            // The look() method automatically sets the correct distance
            tmpCamera.look(newPosition, position);

            controllers.orbit.goto(tmpCamera);
            
            // Fly mode version (commented out for now, as requested)
            // if (currentMode === 'fly') {
            //     const targetPose = new Pose();
            //     targetPose.position.copy(tmpCamera.position);
            //     targetPose.angles.copy(tmpCamera.angles);
            //     targetPose.distance = tmpCamera.distance;
            //     controllers.fly.goto(targetPose);
            // }
        });

        events.on('annotation.activate', (annotation: Annotation) => {
            // switch to orbit camera on pick (only if not already in orbit mode)
            if (state.cameraMode !== 'orbit') {
                state.cameraMode = 'orbit';
            }

            const { initial } = annotation.camera;

            // construct camera
            tmpCamera.fov = initial.fov;
            tmpCamera.look(
                new Vec3(initial.position),
                new Vec3(initial.target)
            );

            controllers.orbit.goto(tmpCamera);
        });
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
