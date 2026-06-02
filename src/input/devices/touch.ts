import { math, MultiTouchSource, Vec3 } from 'playcanvas';

import { MobileFlyInput } from './mobile-fly-input';
import type { Global } from '../../types';
import { shouldUseTouchJoystickMove } from '../touch-joystick-ui';
import {
    DISPLACEMENT_SCALE,
    OrbitToFlyAutoSwitchTracker,
    TAP_EPSILON,
    screenToWorld
} from '../shared';
import type { CameraInputFrame, InputDevice, UpdateContext } from '../shared';

const tmpV = new Vec3();
const orbitMove = new Vec3();
const flyMoveTmp = new Vec3();
const flyTouchPan = new Vec3();
const pinchMoveTmp = new Vec3();
const orbitRotate = new Vec3();
const flyRotate = new Vec3();

/** Matches pre–walk-merge mobile fly roll gain. */
const MOBILE_FLY_ROLL_SENSITIVITY = 3;

/** Matches pre–walk-merge mobile fly look scale. */
const MOBILE_FLY_LOOK_SCALE = 0.8;

type TouchJoystickUiPayload = {
    active: boolean;
};

class TouchDevice implements InputDevice {
    orbitSpeed: number = 18;

    moveSpeed: number = 4;

    pinchSpeed: number = 0.4;

    touchRotateSensitivity: number = 1.5;

    touchPinchMoveSensitivity: number = 1.5;

    pinchVelocitySensitivity: number = 0.006;

    panVelocitySensitivity: number = 0.005;

    private _source = new MultiTouchSource();

    private _orbitToFlyAutoSwitch = new OrbitToFlyAutoSwitchTracker();

    private _global: Global | null = null;

    private _mobileFlyInput: MobileFlyInput | null = null;

    /** Touches currently active (running count from .read() deltas). */
    private _touchCount = 0;

    /** UI joystick value [x, y], -1..1. */
    private _joystick: [number, number] = [0, 0];

    /** Smoothed forward/back velocity from pinch gesture (-1..1), walk + joystick fly. */
    private _pinchVelocity = 0;

    /** Smoothed strafe/vertical velocity from two-finger pan, -1..1 each (walk). */
    private _panVelocity: [number, number] = [0, 0];

    /** Tap-detection state — touch count, max touches, and accumulated movement. */
    private _tapTouches = 0;

    private _tapMaxTouches = 0;

    private _tapDelta = 0;

    /** True for one frame after a tap is detected during gaming controls. */
    private _tapJump = false;

    private _onJoystickInput = (value: { x: number; y: number }) => {
        this._joystick[0] = value.x;
        this._joystick[1] = value.y;
    };

    private _onTouchJoystickUi = (payload: TouchJoystickUiPayload) => {
        const mfi = this._mobileFlyInput;
        if (!mfi) return;
        // The joystick is an auxiliary movement control; scene gestures remain
        // active in both portrait and landscape.
        mfi.setLookEnabled(true);
        if (payload.active) {
            mfi.reset();
        }
    };

    private _onCameraModeChanged = (mode: string) => {
        if (mode !== 'fly') {
            this._mobileFlyInput?.reset();
        }
    };

    get touchCount(): number {
        return this._touchCount;
    }

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._global = global;
        this._source.attach(canvas);
        this._mobileFlyInput = new MobileFlyInput(canvas);
        this._mobileFlyInput.setLookEnabled(true);
        global.events.on('joystickInput', this._onJoystickInput);
        global.events.on('touchJoystickUi', this._onTouchJoystickUi);
        global.events.on('cameraMode:changed', this._onCameraModeChanged);
    }

    detach(): void {
        if (this._global) {
            this._global.events.off('joystickInput', this._onJoystickInput);
            this._global.events.off('touchJoystickUi', this._onTouchJoystickUi);
            this._global.events.off('cameraMode:changed', this._onCameraModeChanged);
            this._global = null;
        }
        this._mobileFlyInput?.destroy();
        this._mobileFlyInput = null;
    }

    /**
     * Same rationale as {@link KeyboardMouseDevice#drainBufferedInput}: consume
     * {@link MultiTouchSource#read} while camera is suppressed so touch/pinch
     * deltas do not stack across disabled frames.
     */
    drainBufferedInput(): void {
        const { count } = this._source.read();
        this._touchCount += count[0];
        this._orbitToFlyAutoSwitch.reset();
    }

    update(ctx: UpdateContext, frame: CameraInputFrame): void {
        const { touch, pinch, count } = this._source.read();
        const { isFly, isWalk, isFirstPerson, isOrbit, gamingControls, dt, distance, cameraComponent } = ctx;
        const global = this._global!;
        const useJoystickMove = shouldUseTouchJoystickMove(global.state);
        const useMobileFlyGestures = isFly;

        // running touch count
        this._touchCount += count[0];

        if (isFly && useJoystickMove && (this._joystick[0] !== 0 || this._joystick[1] !== 0)) {
            global.events.fire('navigateCancel');
        }

        // tap detection for click/tap target and focus modes
        if (isWalk || isFly || isOrbit) {
            const prevTaps = this._tapTouches;
            this._tapTouches = Math.max(0, this._tapTouches + count[0]);

            if (prevTaps === 0 && this._tapTouches > 0) {
                this._tapDelta = 0;
            }
            if (this._tapTouches > 0) {
                this._tapMaxTouches = Math.max(this._tapMaxTouches, this._tapTouches);
            }

            if (this._tapTouches > 0) {
                const prevDelta = this._tapDelta;
                this._tapDelta += Math.abs(touch[0]) + Math.abs(touch[1]) + Math.abs(pinch[0]);
                if (prevDelta < TAP_EPSILON && this._tapDelta >= TAP_EPSILON) {
                    if ((isWalk && !gamingControls) || (isFly && useJoystickMove)) {
                        global.events.fire('navigateCancel');
                    }
                }
            }

            if (prevTaps > 0 && this._tapTouches === 0) {
                if (this._tapDelta < TAP_EPSILON && this._tapMaxTouches === 1) {
                    if (isWalk && !gamingControls) {
                        global.events.fire('mobileTap');
                    } else if (isWalk) {
                        this._tapJump = true;
                    } else if (isFly) {
                        global.events.fire('mobileTap');
                    } else if (isOrbit) {
                        global.events.fire('mobileTap');
                    }
                }
                this._tapMaxTouches = 0;
            }
        } else {
            this._tapTouches = 0;
            this._tapMaxTouches = 0;
        }

        // Walk (and landscape fly + joystick): smoothed two-finger velocities via MultiTouchSource
        if (isWalk && this._touchCount > 1) {
            this._pinchVelocity -= pinch[0] * this.pinchVelocitySensitivity;
            this._pinchVelocity = math.clamp(this._pinchVelocity, -1.0, 1.0);
            this._panVelocity[0] += touch[0] * this.panVelocitySensitivity;
            this._panVelocity[0] = math.clamp(this._panVelocity[0], -1.0, 1.0);
            this._panVelocity[1] += touch[1] * this.panVelocitySensitivity;
            this._panVelocity[1] = math.clamp(this._panVelocity[1], -1.0, 1.0);
        } else if (isWalk && this._touchCount <= 1) {
            this._pinchVelocity = 0;
            this._panVelocity[0] = 0;
            this._panVelocity[1] = 0;
        }

        const orbit = isOrbit ? 1 : 0;
        const fly = isFirstPerson ? 1 : 0;
        const double = this._touchCount > 1 ? 1 : 0;
        const orbitPinchIn = -pinch[0];
        const orbitFactor = isFirstPerson ? cameraComponent.fov / 120 : 1;
        const dragInvert = isFirstPerson ? -1 : 1;

        const { deltas } = frame;

        // move
        const v = tmpV.set(0, 0, 0);
        screenToWorld(cameraComponent, touch[0], touch[1], distance, orbitMove);
        if (double && isOrbit) {
            v.add(flyTouchPan.copy(orbitMove));
        }

        if (useMobileFlyGestures && this._mobileFlyInput) {
            // Pre–walk-merge fly gestures: two-finger pan/zoom without the old joystick.
            if (double) {
                v.add(flyTouchPan.copy(orbitMove));
            }
            pinchMoveTmp.set(0, 0, pinch[0]);
            v.add(pinchMoveTmp.mulScalar(double * this.pinchSpeed * DISPLACEMENT_SCALE));
            if (useJoystickMove) {
                flyMoveTmp.set(this._joystick[0], 0, this._joystick[1]);
                v.add(flyMoveTmp.mulScalar(fly * this.moveSpeed * dt));
            }
        } else {
            if (useJoystickMove) {
                flyMoveTmp.set(this._joystick[0], 0, this._joystick[1]);
                v.add(flyMoveTmp.mulScalar(fly * this.moveSpeed * dt));
            }
            if (isWalk) {
                flyTouchPan.set(this._panVelocity[0], 0, 0);
                v.add(flyTouchPan.mulScalar(fly * this.touchPinchMoveSensitivity * this.moveSpeed * dt));
                flyMoveTmp.set(0, 0, this._pinchVelocity);
                v.add(flyMoveTmp.mulScalar(fly * this.touchPinchMoveSensitivity * this.moveSpeed * dt));
            }
        }

        pinchMoveTmp.set(0, 0, orbitPinchIn);
        v.add(pinchMoveTmp.mulScalar(orbit * double * this.pinchSpeed * DISPLACEMENT_SCALE));

        if (isOrbit && double) {
            if (this._orbitToFlyAutoSwitch.update('orbit', distance, orbitPinchIn < 0)) {
                global.events.fire('inputEvent', 'requestFirstPerson');
            }
        } else if (!isOrbit) {
            this._orbitToFlyAutoSwitch.reset();
        }

        if (isWalk && this._tapJump) {
            v.y = 1;
            this._tapJump = false;
        }

        // Orbit keeps +z; fly/walk use -z (pre–walk-merge convention)
        deltas.move.append([v.x, v.y, orbit ? v.z : -v.z]);

        // rotate
        v.set(0, 0, 0);
        orbitRotate.set(touch[0], touch[1], 0);
        v.add(orbitRotate.mulScalar(orbit * (1 - double) * this.orbitSpeed * this.touchRotateSensitivity * DISPLACEMENT_SCALE));

        if (useMobileFlyGestures && this._mobileFlyInput) {
            const mfi = this._mobileFlyInput;
            const twoFingerRotate = mfi.getTwoFingerGestureMode() === 'rotate';
            if (!twoFingerRotate) {
                flyRotate.set(mfi.lookInput.x, mfi.lookInput.y, 0);
                v.add(flyRotate.mulScalar(
                    fly * this.orbitSpeed * orbitFactor * dt * MOBILE_FLY_LOOK_SCALE
                ));
            }
            v.z += mfi.rollInput * fly * MOBILE_FLY_ROLL_SENSITIVITY;
        } else {
            flyRotate.set(touch[0] * dragInvert, touch[1] * dragInvert, 0);
            v.add(flyRotate.mulScalar(
                fly * (1 - double) * this.orbitSpeed * orbitFactor * this.touchRotateSensitivity * DISPLACEMENT_SCALE
            ));
        }

        deltas.rotate.append([v.x, v.y, v.z]);
    }
}

export { TouchDevice };
export type { TouchJoystickUiPayload };
