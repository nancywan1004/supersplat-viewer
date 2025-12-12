import {
    type BoundingBox,
    Color,
    Entity,
    Pose,
    StandardMaterial,
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
import { getSkyboxRadius } from './loaders/skybox-loader';

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

    constructor(global: Global, bbox: BoundingBox) {
        const { events, settings, state, config, app } = global;

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

        // 计算相机移动范围限制
        // 天空盒半径的0.25倍（可调整比例）
        const skyboxRadiusRatio = 0.25; // 可调整的比例
        
        // 尝试获取天空盒半径
        // 首先尝试使用 config.skyboxUrl（如果存在）
        const skyboxUrl = config.skyboxUrl?.trim();
        let skyboxRadius = 0;
        
        if (skyboxUrl) {
            // 如果有 URL，先尝试用 URL 查找
            skyboxRadius = getSkyboxRadius(app, skyboxUrl);
        }
        
        // 如果没找到，尝试不传 URL 来查找任何已存在的天空盒
        if (skyboxRadius === 0) {
            skyboxRadius = getSkyboxRadius(app);
        }
        
        const skyboxLimit = skyboxRadius > 0 ? skyboxRadius * skyboxRadiusRatio : Infinity;
        console.log('CameraManager: skyboxRadius =', skyboxRadius, 'skyboxUrl =', skyboxUrl, 'skyboxLimit =', skyboxLimit);
        
        // 场景包围盒的0.5倍
        const sceneBboxRadius = bbox.halfExtents.length();
        const sceneBboxLimit = sceneBboxRadius * 0.5;
        console.log('CameraManager: sceneBboxLimit =', sceneBboxLimit);
        
        // 取两者中的较小值作为最大移动半径
        const maxMoveRadius = Math.min(skyboxLimit, sceneBboxLimit);
        const moveLimitCenter = bbox.center; // 限制中心点使用场景包围盒中心

        const controllers = {
            orbit: new OrbitController(),
            fly: new FlyController(),
            anim: animTrack ? new AnimController(animTrack) : null
        };

        // 设置移动范围限制
        if (maxMoveRadius < Infinity) {
            controllers.orbit.setMoveLimit(moveLimitCenter, maxMoveRadius);
            controllers.fly.setMoveLimit(moveLimitCenter, maxMoveRadius);
        }

        // 如果天空盒还没加载，监听天空盒加载完成事件来更新限制
        if (skyboxRadius === 0) {
            events.once('skyboxSelectionSynced', (syncedUrl?: string) => {
                // 天空盒加载完成，重新获取半径并更新限制
                // 优先使用 syncedUrl（如果提供），否则使用原来的 skyboxUrl，最后尝试查找任何天空盒
                let newSkyboxRadius = 0;
                if (syncedUrl) {
                    newSkyboxRadius = getSkyboxRadius(app, syncedUrl.trim());
                }
                if (newSkyboxRadius === 0 && skyboxUrl) {
                    newSkyboxRadius = getSkyboxRadius(app, skyboxUrl);
                }
                if (newSkyboxRadius === 0) {
                    newSkyboxRadius = getSkyboxRadius(app);
                }
                
                if (newSkyboxRadius > 0) {
                    const newSkyboxLimit = newSkyboxRadius * skyboxRadiusRatio;
                    const newMaxMoveRadius = Math.min(newSkyboxLimit, sceneBboxLimit);
                    
                    if (newMaxMoveRadius < Infinity) {
                        controllers.orbit.setMoveLimit(moveLimitCenter, newMaxMoveRadius);
                        controllers.fly.setMoveLimit(moveLimitCenter, newMaxMoveRadius);
                        console.log('CameraManager: Updated limits after skybox loaded, newSkyboxRadius =', newSkyboxRadius, 'newMaxMoveRadius =', newMaxMoveRadius);
                    }
                }
            });
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
}

export { CameraManager };
