import {
    type BoundingBox,
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
            // switch to orbit camera on pick
            state.cameraMode = 'orbit';

            // construct camera - move directly to target position
            tmpCamera.copy(this.camera);
            
            // Calculate direction from camera to picked point
            const direction = tmpv.copy(position).sub(this.camera.position).normalize();
            
            // Move camera directly to the picked position for "look around" effect
            // Keep the same viewing direction but position at target
            tmpCamera.position.copy(position);
            
            // Maintain a minimum distance for orbit controller to preserve pan functionality
            // This creates the "look around" feel instead of "orbit around a point"
            const minDistance = 0; // Minimum focal distance for smooth orbit behavior and pan
            tmpCamera.distance = minDistance;
            
            // Keep the current viewing angles for natural transition
            // This makes it feel like you're standing at the target looking in the same direction

            controllers.orbit.goto(tmpCamera);
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

        // Handle two-finger tap to switch to orbit
        events.on('twoFingerTap', () => {
            if (state.cameraMode !== 'orbit') {
                state.cameraMode = 'orbit';
            }
        });

        // Handle two-finger pan to switch to orbit
        events.on('switchToOrbit', (_reason: string) => {
            if (state.cameraMode !== 'orbit') {
                state.cameraMode = 'orbit';
            }
        });
    }
}

export { CameraManager };
