import {
    type BoundingBox,
    Pose,
    Vec3
} from 'playcanvas';

import { createRotateTrack } from './animation/create-rotate-track';
import { AnimController } from './cameras/anim-controller';
import { Camera, type CameraFrame, type CameraController } from './cameras/camera';
import { FlyController } from './cameras/fly-controller';
import { OrbitController } from './cameras/orbit-controller';
import { easeOut } from './core/math';
import { Annotation } from './settings';
import { CameraMode, Global } from './types';

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
        const { events, settings, state } = global;

        const camera0 = settings.cameras[0].initial;
        const frameCamera = createFrameCamera(bbox, camera0.fov);
        const resetCamera = createCamera(new Vec3(camera0.position), new Vec3(camera0.target), camera0.fov);

        const getAnimTrack = (initial: Camera, isObjectExperience: boolean) => {
            const { animTracks } = settings;

            // extract the camera animation track from settings
            if (animTracks?.length > 0 && settings.startMode === 'animTrack') {
                // use the first animTrack
                return animTracks[0];
            } else if (isObjectExperience) {
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

        const getController = (cameraMode: 'orbit' | 'anim' | 'fly'): CameraController => {
            return controllers[cameraMode];
        };

        // set the global animation flag
        state.hasAnimation = !!controllers.anim;
        state.animationDuration = controllers.anim ? controllers.anim.animState.cursor.duration : 0;

        // initialize camera mode and initial camera position
        state.cameraMode = state.hasAnimation ? 'anim' : (isObjectExperience ? 'orbit' : 'fly');
        this.camera.copy(resetCamera);

        const target = new Camera(this.camera);             // the active controller updates this
        const from = new Camera(this.camera);               // stores the previous camera state during transition
        let fromMode: CameraMode = isObjectExperience ? 'orbit' : 'fly';

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
                this.camera.lerp(from, target, easeOut(transitionTimer));
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
            // Always switch to orbit mode on double-tap
            state.cameraMode = 'orbit';

            // construct camera - look at the picked target from current position
            tmpCamera.copy(this.camera);
            
            // Calculate direction from camera to picked point
            const direction = tmpv.copy(position).sub(this.camera.position).normalize();
            
            // Calculate a good viewing distance (move closer to target)
            const currentDistance = position.distance(this.camera.position);
            const targetDistance = Math.max(3.0, currentDistance * 0.5); // Move to 50% distance, minimum 3.0
            
            // Position camera at the target distance, looking at the picked point
            const newPosition = tmpv.copy(direction).mulScalar(-targetDistance).add(position);
            tmpCamera.position.copy(newPosition);
            
            // Make camera look at the picked point (this centers the target)
            tmpCamera.look(newPosition, position);
            
            // Set distance for orbit controller
            tmpCamera.distance = 3.0;

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
            // switch to orbit camera on pick
            state.cameraMode = 'orbit';

            const { initial } = annotation.camera;

            // construct camera
            tmpCamera.fov = initial.fov;
            tmpCamera.look(
                new Vec3(initial.position),
                new Vec3(initial.target)
            );

            controllers.orbit.goto(tmpCamera);
        });

        // Two-finger gestures no longer auto-switch modes
        // Users can manually switch between orbit and fly modes as needed
    }
}

export { CameraManager };
