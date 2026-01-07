import {
    type BoundingBox,
    Color,
    Entity,
    Pose,
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
import { CameraMode, Global } from './types';
import { SphereConstraint } from './camera-constraints/sphere-constraint';
import { BoxConstraint } from './camera-constraints/box-constraint';

const tmpCamera = new Camera();
const tmpv = new Vec3();

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

    constructor(global: Global, bbox: BoundingBox) {
        const { events, settings, state, config, app } = global;

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

        // 约束策略：
        // - Orbit：限制 target/focus point 在收缩后的 bbox 内（避免贴球面滑动、pan 越界）
        // - Fly：保持原球形硬边界兜底（防止飞行穿出场景太远）
        this.targetConstraint = BoxConstraint.fromBoundingBox(bbox, 0.5);
        controllers.orbit.setTargetConstraint(this.targetConstraint);
        controllers.fly.setTargetConstraint(this.targetConstraint);

        this.constraint = SphereConstraint.fromBoundingBox(bbox, 0.5);
        // fly 仍保留一个球形硬边界兜底（仅在没有 box 约束时才会用到），不影响两种模式的主约束一致性
        controllers.fly.setConstraint(this.constraint);

        // 给 orbit 设置一个合理的最大缩放距离（避免无限 zoom-out 让场景跑出视野）
        const sceneSize = bbox.halfExtents.length();
        const maxZoom = (sceneSize / Math.tan(camera0.fov / 180 * Math.PI * 0.5)) * 0.25;
        controllers.orbit.controller.zoomRange = new Vec2(0.5, maxZoom);

        // 创建约束可视化
        //this.createConstraintVisualizer(app, this.constraint);

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

    /**
     * 创建约束可视化（显示bounding sphere）
     */
    private createConstraintVisualizer(app: any, constraint: SphereConstraint): void {
        if (!constraint) return;

        const sphereEntity = new Entity('constraintSphere');
        
        // 创建材质（半透明绿色）
        const material = new StandardMaterial();
        material.diffuse = new Color(0, 1, 0); // 绿色
        material.emissive = new Color(0, 0.3, 0);
        material.update();

        // 创建sphere渲染组件
        sphereEntity.addComponent('render', {
            type: 'sphere',
            material: material
        });

        // 设置位置和大小
        sphereEntity.setPosition(constraint.sphere.center);
        const scale = constraint.sphere.radius * 2;
        sphereEntity.setLocalScale(scale, scale, scale);

        // 设置为半透明（通过render组件的castShadows和receiveShadows控制）
        const renderComponent = sphereEntity.render;
        if (renderComponent) {
            renderComponent.castShadows = false;
            renderComponent.receiveShadows = false;
        }

        app.root.addChild(sphereEntity);
        this.constraintVisualizer = sphereEntity;

        // 默认可见
        sphereEntity.enabled = true;
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
