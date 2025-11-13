import {
    math,
    DualGestureSource,
    GamepadSource,
    InputFrame,
    KeyboardMouseSource,
    MultiTouchSource,
    PROJECTION_PERSPECTIVE,
    Vec3
} from 'playcanvas';
import type { CameraComponent } from 'playcanvas';

import { MobileFlyInput } from './cameras/mobile-fly-input';
import { Picker } from './picker';
import type { Global } from './types';

const tmpV1 = new Vec3();
const tmpV2 = new Vec3();

/**
 * Converts screen space mouse deltas to world space pan vector.
 *
 * @param camera - The camera component.
 * @param dx - The mouse delta x value.
 * @param dy - The mouse delta y value.
 * @param dz - The world space zoom delta value.
 * @param out - The output vector to store the pan result.
 * @returns - The pan vector in world space.
 * @private
 */
const screenToWorld = (camera: CameraComponent, dx: number, dy: number, dz: number, out: Vec3 = new Vec3()) => {
    const { system, fov, aspectRatio, horizontalFov, projection, orthoHeight } = camera;
    const { width, height } = system.app.graphicsDevice.clientRect;

    // normalize deltas to device coord space
    out.set(
        -(dx / width) * 2,
        (dy / height) * 2,
        0
    );

    // calculate half size of the view frustum at the current distance
    const halfSize = tmpV2.set(0, 0, 0);
    if (projection === PROJECTION_PERSPECTIVE) {
        const halfSlice = dz * Math.tan(0.5 * fov * math.DEG_TO_RAD);
        if (horizontalFov) {
            halfSize.set(
                halfSlice,
                halfSlice / aspectRatio,
                0
            );
        } else {
            halfSize.set(
                halfSlice * aspectRatio,
                halfSlice,
                0
            );
        }
    } else {
        halfSize.set(
            orthoHeight * aspectRatio,
            orthoHeight,
            0
        );
    }

    // scale by device coord space
    out.mul(halfSize);

    return out;
};

class InputController {
    private _state = {
        axis: new Vec3(),
        mouse: [0, 0, 0],
        shift: 0,
        ctrl: 0,
        touches: 0,
        lastTouchCount: 0,
        twoFingerTapTimer: 0,
        currentTouchCount: 0
    };

    private _desktopInput: KeyboardMouseSource = new KeyboardMouseSource();

    private _orbitInput = new MultiTouchSource();

    private _flyInput = new DualGestureSource();

    private _mobileFlyInput: MobileFlyInput | null = null;

    private _gamepadInput = new GamepadSource();

    global: Global;

    frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });

    joystick: {
        base: [number, number] | null,
        stick: [number, number] | null
    } = { base: null, stick: null };

    // this gets overridden by the viewer based on scene size
    moveSpeed: number = 10;

    orbitSpeed: number = 18;

    pinchSpeed: number = 0.4;

    wheelSpeed: number = 0.06;

    constructor(global: Global) {
        const { app, camera, events, state } = global;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        this._desktopInput.attach(canvas);
        this._orbitInput.attach(canvas);
        this._flyInput.attach(canvas);
        
        // Initialize custom mobile fly input
        this._mobileFlyInput = new MobileFlyInput(canvas);
        
        // Try to find and attach joystick element immediately
        const joystickElement = document.getElementById('joystickBase');
        if (joystickElement) {
            if (joystickElement.classList.contains('hidden')) {
                // Joystick is hidden, disable joystick but keep look enabled
                console.log('InputController: Joystick is hidden, disabling joystick functionality');
                this._mobileFlyInput.setJoystickEnabled(false);
            } else {
                console.log('InputController: Found joystick element immediately', joystickElement);
                this._mobileFlyInput.attachJoystickElement(joystickElement);
            }
        } else {
            console.log('InputController: Joystick element not found, waiting for event');
        }
        
        // Also listen for the event in case it comes later
        events.on('joystickElementReady', (element: HTMLElement) => {
            console.log('InputController: Received joystickElementReady event', element);
            if (this._mobileFlyInput) {
                this._mobileFlyInput.attachJoystickElement(element);
            } else {
                console.error('InputController: _mobileFlyInput is null!');
            }
        });
        
        // Listen for joystick disabled event
        events.on('joystickDisabled', () => {
            console.log('InputController: Joystick disabled');
            if (this._mobileFlyInput) {
                this._mobileFlyInput.setJoystickEnabled(false);
            }
        });
        
        // Reset mobile fly input when switching away from fly mode
        events.on('cameraModeChanged', (newMode, _prevMode) => {
            if (newMode !== 'fly' && this._mobileFlyInput) {
                this._mobileFlyInput.reset();
            }
        });

        // convert events to joystick state - always show in bottom left
        this._flyInput.on('joystick:position:left', ([bx, by, sx, sy]) => {
            if (bx < 0 || by < 0 || sx < 0 || sy < 0) {
                this.joystick.base = null;
                this.joystick.stick = null;
                return;
            }
            this.joystick.base = [bx, by];
            this.joystick.stick = [sx - bx, sy - by];
        });

        // Track touch count changes for two-finger detection
        let lastTouchCount = 0;
        let twoFingerStartTime = 0;
        
        canvas.addEventListener('touchstart', (event) => {
            const currentTouchCount = event.touches.length;
            
            // Detect two-finger tap
            if (currentTouchCount === 2 && lastTouchCount < 2) {
                twoFingerStartTime = Date.now();
            }
            
            lastTouchCount = currentTouchCount;
        });

        canvas.addEventListener('touchend', (event) => {
            const currentTouchCount = event.touches.length;
            
            // Two-finger tap completed (quick tap < 200ms)
            if (lastTouchCount === 2 && currentTouchCount < 2) {
                const tapDuration = Date.now() - twoFingerStartTime;
                if (tapDuration < 200) {
                    events.fire('twoFingerTap');
                }
            }
            
            lastTouchCount = currentTouchCount;
        });

        this.global = global;

        // Generate input events
        ['wheel', 'pointerdown', 'contextmenu', 'keydown'].forEach((eventName) => {
            canvas.addEventListener(eventName, (event) => {
                events.fire('inputEvent', 'interrupt', event);
            });
        });

        canvas.addEventListener('pointermove', (event) => {
            events.fire('inputEvent', 'interact', event);
        });

        // Detect double taps manually because iOS doesn't send dblclick events
        // Single finger double tap will switch to orbit mode and pick target
        const lastTap = { time: 0, x: 0, y: 0, pointerType: '' };
        canvas.addEventListener('pointerdown', (event) => {
            // Only process single touch/mouse events for double tap
            if (event.isPrimary) {
                const now = Date.now();
                const delay = Math.max(0, now - lastTap.time);
                
                // More lenient timing and position for mobile
                const isMobile = event.pointerType === 'touch';
                const maxDelay = isMobile ? 400 : 300; // Longer window for touch
                const maxDistance = isMobile ? 20 : 8; // Larger tolerance for touch
                
                if (delay < maxDelay &&
                    delay > 50 && // Minimum delay to avoid accidental triggers
                    Math.abs(event.clientX - lastTap.x) < maxDistance &&
                    Math.abs(event.clientY - lastTap.y) < maxDistance &&
                    event.pointerType === lastTap.pointerType) {
                    
                    // Check if tap is not in joystick area (for mobile)
                    let isInJoystickArea = false;
                    if (this._mobileFlyInput && state.inputMode === 'touch') {
                        isInJoystickArea = this._mobileFlyInput.isPointInJoystickArea(event.clientX, event.clientY);
                    }
                    
                    // Only fire dblclick if not in joystick area
                    // This will trigger pick event and switch to orbit mode
                    if (!isInJoystickArea) {
                        console.log('Double tap detected:', { delay, distance: Math.abs(event.clientX - lastTap.x) });
                        events.fire('inputEvent', 'dblclick', event);
                    }
                    lastTap.time = 0;
                } else {
                    lastTap.time = now;
                    lastTap.x = event.clientX;
                    lastTap.y = event.clientY;
                    lastTap.pointerType = event.pointerType;
                }
            }
        });

        // Calculate pick location on double click
        let picker: Picker | null = null;
        events.on('inputEvent', async (eventName, event) => {
            switch (eventName) {
                case 'dblclick': {
                    if (!picker) {
                        picker = new Picker(app, camera);
                    }
                    const result = await picker.pick(event.offsetX, event.offsetY);
                    if (result) {
                        events.fire('pick', result);
                    }
                    break;
                }
            }
        });

        // update input mode based on pointer event
        ['pointerdown', 'pointermove'].forEach((eventName) => {
            window.addEventListener(eventName, (event: PointerEvent) => {
                state.inputMode = event.pointerType === 'touch' ? 'touch' : 'desktop';
            });
        });

        // handle keyboard events
        window.addEventListener('keydown', (event: KeyboardEvent) => {
            if (event.key === 'Escape') {
                events.fire('inputEvent', 'cancel', event);
            } else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
                switch (event.key) {
                    case 'f':
                        events.fire('inputEvent', 'frame', event);
                        break;
                    case 'r':
                        events.fire('inputEvent', 'reset', event);
                        break;
                    case ' ':
                        events.fire('inputEvent', 'playPause', event);
                        break;
                }
            }
        });
    }

    /**
     * @param dt - delta time in seconds
     * @param state - the current state of the app
     * @param state.cameraMode - the current camera mode
     * @param distance - the distance to the camera target
     */
    update(dt: number, distance: number) {
        const { keyCode } = KeyboardMouseSource;

        const { key, button, mouse, wheel } = this._desktopInput.read();
        const { touch, pinch, count } = this._orbitInput.read();
        const { leftInput, rightInput } = this._flyInput.read();
        const { leftStick, rightStick } = this._gamepadInput.read();

        const { events, state } = this.global;
        const { camera } = this.global.camera;

        // update state
        this._state.axis.add(tmpV1.set(
            (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]),
            (key[keyCode.E] - key[keyCode.Q]),
            (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])
        ));
        
        const currentTouchCount = count[0];
        this._state.touches += currentTouchCount;
        this._state.currentTouchCount = currentTouchCount;
        
        // No longer auto-switch to orbit on two-finger gesture
        // Two-finger gestures now work in both orbit and fly modes
        
        this._state.lastTouchCount = currentTouchCount;
        
        for (let i = 0; i < button.length; i++) {
            this._state.mouse[i] += button[i];
        }
        this._state.shift += key[keyCode.SHIFT];
        this._state.ctrl += key[keyCode.CTRL];

        if (state.cameraMode !== 'fly' && this._state.axis.length() > 0) {
            state.cameraMode = 'fly';
        }

        const orbit = +(state.cameraMode === 'orbit');
        const fly = +(state.cameraMode === 'fly');
        const double = +(this._state.touches > 1);
        const pan = this._state.mouse[2] || +(button[2] === -1) || double;

        const orbitFactor = fly ? camera.fov / 120 : 1;

        const { deltas } = this.frame;

        // desktop move
        const v = tmpV1.set(0, 0, 0);
        const keyMove = this._state.axis.clone().normalize();
        v.add(keyMove.mulScalar(fly * this.moveSpeed * (this._state.shift ? 4 : this._state.ctrl ? 0.25 : 1) * dt));
        const panMove = screenToWorld(camera, mouse[0], mouse[1], distance);
        v.add(panMove.mulScalar(pan));
        const wheelMove = new Vec3(0, 0, -wheel[0]);
        v.add(wheelMove.mulScalar(this.wheelSpeed * dt));
        // FIXME: need to flip z axis for orbit camera
        deltas.move.append([v.x, v.y, orbit ? -v.z : v.z]);

        // desktop rotate
        v.set(0, 0, 0);
        const mouseRotate = new Vec3(mouse[0], mouse[1], 0);
        v.add(mouseRotate.mulScalar((1 - pan) * this.orbitSpeed * orbitFactor * dt));
        deltas.rotate.append([v.x, v.y, v.z]);

        // mobile move
        v.set(0, 0, 0);
        
        // Two-finger pan: works in both orbit and fly modes
        const twoFingerPanMove = screenToWorld(camera, touch[0], touch[1], distance);
        v.add(twoFingerPanMove.mulScalar(pan));
        
        // Fly mode: use custom mobile fly input for separated joystick and look
        // Also works on desktop for debugging
        if (this._mobileFlyInput) {
            const { moveInput } = this._mobileFlyInput;
            const flyMove = new Vec3(moveInput.x, 0, -moveInput.y);
            v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
        } else {
            // Fallback to DualGestureSource only if MobileFlyInput is not available
            const flyMove = new Vec3(leftInput[0], 0, -leftInput[1]);
            v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
        }
        
        // Two-finger pinch zoom: works in both orbit and fly modes
        // In orbit mode: zoom in/out around target
        // In fly mode: move forward/backward
        const pinchMove = new Vec3(0, 0, pinch[0]);
        v.add(pinchMove.mulScalar(double * this.pinchSpeed * dt));
        
        // Need to flip z axis for orbit camera (same as desktop move)
        deltas.move.append([v.x, v.y, orbit ? v.z : -v.z]);

        // mobile rotate
        v.set(0, 0, 0);
        const orbitRotate = new Vec3(touch[0], touch[1], 0);
        v.add(orbitRotate.mulScalar(orbit * (1 - pan) * this.orbitSpeed * dt));
        
        // Fly mode: use custom mobile fly input for look around
        // Also works on desktop for debugging
        if (this._mobileFlyInput) {
            const { lookInput } = this._mobileFlyInput;
            const flyRotate = new Vec3(lookInput.x, lookInput.y, 0);
            v.add(flyRotate.mulScalar(fly * this.orbitSpeed * orbitFactor * dt * 0.8)); // Increased for more responsive control
        } else {
            // Fallback to DualGestureSource only if MobileFlyInput is not available
            const flyRotate = new Vec3(rightInput[0], rightInput[1], 0);
            v.add(flyRotate.mulScalar(fly * this.orbitSpeed * orbitFactor * dt));
        }
        deltas.rotate.append([v.x, v.y, v.z]);

        // gamepad move
        v.set(0, 0, 0);
        const stickMove = new Vec3(leftStick[0], 0, -leftStick[1]);
        v.add(stickMove.mulScalar(this.moveSpeed * dt));
        deltas.move.append([v.x, v.y, v.z]);

        // gamepad rotate
        v.set(0, 0, 0);
        const stickRotate = new Vec3(rightStick[0], rightStick[1], 0);
        v.add(stickRotate.mulScalar(this.orbitSpeed * orbitFactor * dt));
        deltas.rotate.append([v.x, v.y, v.z]);

        // update touch joystick UI - always show when using joystick
        // Auto-switch to fly mode when joystick is used
        // Works on both touch and desktop (for debugging)
        if (this._mobileFlyInput) {
            const { moveInput } = this._mobileFlyInput;
            const isUsingJoystick = moveInput.x !== 0 || moveInput.y !== 0;
            
            if (isUsingJoystick && state.cameraMode !== 'fly') {
                state.cameraMode = 'fly';
            }
            
            // Update joystick visual position
            const joystickPos = this._mobileFlyInput.getJoystickVisualPosition();
            if (joystickPos) {
                events.fire('touchJoystickUpdate', 
                    [joystickPos.baseX, joystickPos.baseY], 
                    [joystickPos.stickX, joystickPos.stickY]
                );
            } else {
                events.fire('touchJoystickUpdate', null, null);
            }
        }
    }
}

export { InputController };
