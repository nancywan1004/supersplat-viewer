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
import type { InputArbiter } from './input-arbiter';
import { pickWorldFromClientXY } from './picker';
import type { Global } from './types';

/* Vec initialisation to avoid recurrent memory allocation */
const tmpV1 = new Vec3();
const tmpV2 = new Vec3();
const mouseRotate = new Vec3();
const flyMove = new Vec3();
const pinchMove = new Vec3();
const orbitRotate = new Vec3();
const flyRotate = new Vec3();
const stickMove = new Vec3();
const stickRotate = new Vec3();
const isFiniteVec3 = (v: Vec3): boolean => Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);

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
    const rect = system.app.graphicsDevice.clientRect;
    const width = Math.max(1, rect.width);
    const height = Math.max(1, rect.height);
    const safeDz = Number.isFinite(dz) && dz > 0 ? dz : 1;

    // normalize deltas to device coord space
    out.set(
        -(dx / width) * 2,
        (dy / height) * 2,
        0
    );

    // calculate half size of the view frustum at the current distance
    const halfSize = tmpV2.set(0, 0, 0);
    if (projection === PROJECTION_PERSPECTIVE) {
        const halfSlice = safeDz * Math.tan(0.5 * fov * math.DEG_TO_RAD);
        // if (horizontalFov) {
        //     halfSize.set(
        //         halfSlice,
        //         halfSlice / aspectRatio,
        //         0
        //     );
        // } else {
            halfSize.set(
                halfSlice * aspectRatio,
                halfSlice,
                0
            );
        // }
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

// patch keydown and keyup to ignore events with meta key otherwise
// keys can get stuck on macOS.
const patchKeyboardMeta = (desktopInput: any) => {
    const origOnKeyDown = desktopInput._onKeyDown;
    desktopInput._onKeyDown = (event: KeyboardEvent) => {
        if (event.key === 'Meta') {
            desktopInput._keyNow.fill(0);
        } else if (!event.metaKey) {
            origOnKeyDown(event);
        }
    };

    const origOnKeyUp = desktopInput._onKeyUp;
    desktopInput._onKeyUp = (event: KeyboardEvent) => {
        if (event.key === 'Meta') {
            desktopInput._keyNow.fill(0);
        } else if (!event.metaKey) {
            origOnKeyUp(event);
        }
    };
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
        currentTouchCount: 0,
        // Persistent key states for roll control
        keyQPressed: false,
        keyEPressed: false
    };

    // Flag to track if annotation input fields have focus
    private _annotationInputFocused: boolean = false;

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

    // Touch joystick input values (-1 to 1), from UI when joystick is enabled
    private _touchJoystickX: number = 0; // negative = left, positive = right
    private _touchJoystickY: number = 0; // negative = forward, positive = backward

    // When false (e.g. UI disables joystick), use two-finger fly; when true, use joystick for fly move/look
    private _joystickEnabled: boolean = false;

    // this gets overridden by the viewer based on scene size
    moveSpeed: number = 10;

    orbitSpeed: number = 18;

    pinchSpeed: number = 0.4;

    wheelSpeed: number = 0.06;

    // Minimum effective distance for pan calculations to prevent slow panning when zoomed in
    private _minPanDistance: number = 1;

    /**
     * Set move speed based on scene size.
     * Larger scenes need faster movement speed for comfortable navigation.
     * 
     * @param sceneSize - The size of the scene (typically bounding box diagonal length)
     */
    setMoveSpeedFromSceneSize(sceneSize: number) {
        // Scale move speed proportionally to scene size
        // Base speed of 10 for a scene size of ~10 units
        // Reduced coefficient from 0.5 to 0.2 for slower, more controlled fly movement
        this.moveSpeed = Math.max(1, sceneSize * 0.05);
        
        // Set minimum pan distance to ensure smooth panning even when zoomed in
        // Use 10% of scene size as minimum, with a floor of 1
        this._minPanDistance = Math.max(1, sceneSize * 0.1);
    }

    constructor(global: Global) {
        const { app, camera, events, state } = global;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        // 让 canvas 可聚焦：父级 UI 点击后 iframe 可能丢失键盘事件；回到场景时显式 focus，恢复 WASD/快捷键。
        if (typeof canvas.tabIndex !== 'number' || canvas.tabIndex < 0) {
            canvas.tabIndex = 0;
        }

        patchKeyboardMeta(this._desktopInput);

        this._desktopInput.attach(canvas);
        this._orbitInput.attach(canvas);
        this._flyInput.attach(canvas);

        // Initialize custom mobile fly input (two-finger move/look as default; joystick disabled in UI)
        this._mobileFlyInput = new MobileFlyInput(canvas);

        // Joystick element: when UI enables joystick we can attach; when hidden we disable
        const joystickElement = document.getElementById('joystickBase');
        if (joystickElement) {
            if (joystickElement.classList.contains('hidden')) {
                this._mobileFlyInput.setJoystickEnabled(false);
            } else {
                this._mobileFlyInput.attachJoystickElement(joystickElement);
            }
        }
        events.on('joystickElementReady', (element: HTMLElement) => {
            this._joystickEnabled = true;
            if (this._mobileFlyInput) {
                this._mobileFlyInput.attachJoystickElement(element);
            }
        });
        events.on('joystickDisabled', () => {
            this._joystickEnabled = false;
            this._touchJoystickX = 0;
            this._touchJoystickY = 0;
            if (this._mobileFlyInput) {
                this._mobileFlyInput.setJoystickEnabled(false);
            }
        });
        // Incoming (main) joystick logic: UI fires this when user drags the joystick; only used when _joystickEnabled
        events.on('joystickInput', (value: { x: number; y: number }) => {
            this._touchJoystickX = value.x;
            this._touchJoystickY = value.y;
        });
        events.on('cameraModeChanged', (newMode, _prevMode) => {
            if (newMode !== 'fly' && this._mobileFlyInput) {
                this._mobileFlyInput.reset();
            }
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
            // 任何一次点击回场景，都尝试把键盘焦点拉回 iframe 内（使 window.keydown 生效）
            try {
                if (event.isPrimary && typeof canvas.focus === 'function') {
                    (canvas.focus as any)({ preventScroll: true });
                }
            } catch {
                // ignore: 某些浏览器不支持 focus({preventScroll})
                try {
                    if (event.isPrimary) canvas.focus();
                } catch {
                    // ignore
                }
            }

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

        // Calculate pick location on double click / single click
        events.on('inputEvent', async (eventName, event) => {
            switch (eventName) {
                case 'dblclick': {
                    const result = await pickWorldFromClientXY(this.global, event.clientX, event.clientY);
                    if (result) {
                        events.fire('pick', result);
                    }
                    break;
                }
            }
        });

        // 单击拾取：用于场景中单击世界坐标（不改变相机）
        canvas.addEventListener('pointerup', async (event: PointerEvent) => {
            if (!event.isPrimary || event.button !== 0) return;
            // 仅在画布区域内的左键点击才进行拾取
            const rect = canvas.getBoundingClientRect();
            if (event.clientX < rect.left || event.clientX > rect.right
                || event.clientY < rect.top || event.clientY > rect.bottom) {
                return;
            }
            const cameraControlsEnabled = state.cameraControlsEnabled !== false;
            const result = await pickWorldFromClientXY(this.global, event.clientX, event.clientY);
            const inputArbiter = (this.global as any).__inputArbiter as InputArbiter | undefined;
            const dispatchResult = inputArbiter?.dispatchPointerClick({
                global: this.global,
                pointerEvent: event,
                clientX: event.clientX,
                clientY: event.clientY,
                worldPosition: result ?? null
            });
            if (dispatchResult?.claimed) return;
            if (!cameraControlsEnabled) return;
            if (result) {
                // 语义化：场景中一次 pointerup 对应的世界坐标点击
                events.fire('scenePointerWorldClick', {
                    position: result,
                    clientX: event.clientX,
                    clientY: event.clientY
                });
            }
        });

        // 当外部（如 Gizmo）请求清空相机输入增量时，刷新各输入源，避免重新开启控制后出现「一次性吃掉拖拽期间的累积输入」
        events.on('cameraControls:flushInputs', () => {
            // 读一遍输入，把内部缓存清零
            this._desktopInput.read();
            this._orbitInput.read();
            this._flyInput.read();
            this._gamepadInput.read();

            // 清空内部状态与输出帧
            this._state.axis.set(0, 0, 0);
            this._state.mouse = [0, 0, 0];
            this._state.touches = 0;
            this._state.currentTouchCount = 0;

            this.frame = new InputFrame({
                move: [0, 0, 0],
                rotate: [0, 0, 0]
            });
        });

        // update input mode based on pointer event
        ['pointerdown', 'pointermove'].forEach((eventName) => {
            window.addEventListener(eventName, (event: PointerEvent) => {
                state.inputMode = event.pointerType === 'touch' ? 'touch' : 'desktop';
            });
        });

        // handle keyboard events
        window.addEventListener('keydown', (event: KeyboardEvent) => {
            // Skip keyboard event handling if annotation input has focus
            if (this._annotationInputFocused) {
                return;
            }
            
            if (event.key === 'Escape') {
                events.fire('inputEvent', 'cancel', event);
            } else if (!event.ctrlKey && !event.altKey && !event.metaKey) {
                switch (event.key) {
                    case 'r':
                        events.fire('inputEvent', 'reset', event);
                        break;
                    case 'c':
                        // Toggle between orbit and fly camera modes
                        if (state.cameraMode === 'orbit') {
                            state.cameraMode = 'fly';
                        } else if (state.cameraMode === 'fly') {
                            state.cameraMode = 'orbit';
                        }
                        // Note: anim mode is not toggled, only orbit <-> fly
                        break;
                    case ' ':
                        events.fire('inputEvent', 'playPause', event);
                        break;
                }
            }
        });

        // Set up focus/blur listeners for annotation input fields
        this.setupAnnotationInputListeners();
    }

    /**
     * Set up focus and blur event listeners for annotation input fields.
     * This prevents keyboard events from interfering with camera controls when editing annotations.
     */
    private setupAnnotationInputListeners(): void {
        // Use event delegation on document to catch focus/blur events from annotation inputs
        // This works even if the annotation toolbar is created after InputController initialization
        document.addEventListener('focusin', (event: FocusEvent) => {
            const target = event.target as HTMLElement;
            
            // Check if the focused element is an annotation input field
            if (this.isAnnotationInput(target)) {
                this._annotationInputFocused = true;
            }
        });

        document.addEventListener('focusout', (event: FocusEvent) => {
            const target = event.target as HTMLElement;
            
            // Check if the blurred element is an annotation input field
            if (this.isAnnotationInput(target)) {
                this._annotationInputFocused = false;
            }
        });
    }

    /**
     * Check if an element is an annotation input field.
     * This includes title input, text textarea, and other form inputs in the annotation toolbar.
     * 
     * @param element - The element to check
     * @returns True if the element is an annotation input field
     */
    private isAnnotationInput(element: HTMLElement): boolean {
        // Check if element is an input or textarea
        if (element.tagName !== 'INPUT' && element.tagName !== 'TEXTAREA') {
            return false;
        }

        // Check if element is within the annotation toolbar
        const annotationToolbar = element.closest('#annotationToolbar');
        if (annotationToolbar) {
            return true;
        }

        // Also check for specific annotation input classes as a fallback
        const annotationInputClasses = [
            'annotation-form-input',
            'annotation-form-textarea'
        ];
        
        return annotationInputClasses.some(className => element.classList.contains(className));
    }

    /**
     * Manually set the annotation input focus state.
     * This can be used by external components if needed.
     * 
     * @param focused - Whether annotation inputs are focused
     */
    setAnnotationInputFocused(focused: boolean): void {
        this._annotationInputFocused = focused;
    }

    /**
     * Check if annotation input fields currently have focus.
     * 
     * @returns True if annotation inputs are focused
     */
    isAnnotationInputFocused(): boolean {
        return this._annotationInputFocused;
    }

    /**
     * @param dt - delta time in seconds
     * @param state - the current state of the app
     * @param state.cameraMode - the current camera mode
     * @param distance - the distance to the camera target
     */
    update(dt: number, distance: number) {
        // 当相机控制关闭时，持续消费输入源缓存，
        // 防止恢复后一次性吃掉拖拽期间累积的 mouse delta。
        if (this.global.state.cameraControlsEnabled === false) {
            this._desktopInput.read();
            this._orbitInput.read();
            this._flyInput.read();
            this._gamepadInput.read();

            this._state.axis.set(0, 0, 0);
            this._state.mouse = [0, 0, 0];
            this._state.touches = 0;
            this._state.currentTouchCount = 0;

            this.frame = new InputFrame({
                move: [0, 0, 0],
                rotate: [0, 0, 0]
            });
            return;
        }

        const { keyCode } = KeyboardMouseSource;

        const { key, button, mouse, wheel } = this._desktopInput.read();

        const { events, state } = this.global;
        const { camera } = this.global.camera;
        
        const { touch, pinch, count } = this._orbitInput.read();
        const { leftStick, rightStick } = this._gamepadInput.read();
        const { leftInput, rightInput } = this._flyInput.read();

        // update state
        // Skip keyboard input if annotation input fields have focus
        if (!this._annotationInputFocused) {
            this._state.axis.add(tmpV1.set(
                (key[keyCode.D] - key[keyCode.A]) + (key[keyCode.RIGHT] - key[keyCode.LEFT]),
                0, // Y axis movement removed (was Q/E keys)
                (key[keyCode.W] - key[keyCode.S]) + (key[keyCode.UP] - key[keyCode.DOWN])
            ));
        }
        
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

        // 兜底：orbit 已贴近最小缩放距离时，继续滚轮（任意方向）直接切 fly，
        // 避免偶发未触发 camera-manager 自动切换而出现“滚轮卡死”。
        const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : this._minPanDistance;
        if (state.cameraMode === 'orbit' && Math.abs(wheel[0]) > 0 && safeDistance <= 0.56) {
            state.cameraMode = 'fly';
        }

        // Switch to fly mode when using WASD or Q/E keys
        const hasMovementInput = this._state.axis.length() > 0;
        const hasRollInput = key[keyCode.Q] !== 0 || key[keyCode.E] !== 0;
        if (state.cameraMode !== 'fly' && (hasMovementInput || hasRollInput)) {
            state.cameraMode = 'fly';
        }

        const orbit = +(state.cameraMode === 'orbit');
        const fly = +(state.cameraMode === 'fly');
        const double = +(this._state.touches > 1);
        const pan = this._state.mouse[2] || +(button[2] === -1) || double;

        const orbitFactorRaw = fly ? camera.fov / 120 : 1;
        const orbitFactor = Number.isFinite(orbitFactorRaw) ? orbitFactorRaw : 1;

        const { deltas } = this.frame;

        // Use max of actual distance and minimum pan distance to prevent slow panning when zoomed in
        const effectivePanDistance = Math.max(safeDistance, this._minPanDistance);

        // desktop move
        const v = tmpV1.set(0, 0, 0);
        const keyMove = this._state.axis.clone().normalize();
        v.add(keyMove.mulScalar(fly * this.moveSpeed * (this._state.shift ? 4 : this._state.ctrl ? 0.25 : 1) * dt));
        const panMove = screenToWorld(camera, mouse[0], mouse[1], effectivePanDistance);
        if (!isFiniteVec3(panMove)) panMove.set(0, 0, 0);
        v.add(panMove.mulScalar(pan));
        const wheelMove = new Vec3(0, 0, -wheel[0]);
        v.add(wheelMove.mulScalar(this.wheelSpeed * dt));
        if (!isFiniteVec3(v)) v.set(0, 0, 0);
        // FIXME: need to flip z axis for orbit camera
        deltas.move.append([v.x, v.y, orbit ? -v.z : v.z]);

        // desktop rotate
        v.set(0, 0, 0);
        mouseRotate.set(mouse[0], mouse[1], 0);
        v.add(mouseRotate.mulScalar((1 - pan) * this.orbitSpeed * orbitFactor * dt));
        
        // Update persistent key states for Q/E (only if annotation inputs don't have focus)
        if (!this._annotationInputFocused) {
            // key[] contains deltas: 1 = pressed this frame, -1 = released this frame, 0 = no change
            if (key[keyCode.Q] === 1) this._state.keyQPressed = true;
            if (key[keyCode.Q] === -1) this._state.keyQPressed = false;
            if (key[keyCode.E] === 1) this._state.keyEPressed = true;
            if (key[keyCode.E] === -1) this._state.keyEPressed = false;
        }
        
        // Add roll control with Q/E keys (only in fly mode)
        // Use persistent state, not deltas
        const keyQState = this._state.keyQPressed ? 1 : 0;
        const keyEState = this._state.keyEPressed ? 1 : 0;
        const keyDiff = keyEState - keyQState;
        const rollSpeedMultiplier = 3.0; // Increase roll speed (adjust as needed)
        const rollInput = keyDiff * fly * this.orbitSpeed * orbitFactor * dt * rollSpeedMultiplier;
        
        v.z += rollInput;
        deltas.rotate.append([v.x, v.y, v.z]);

        // mobile move
        v.set(0, 0, 0);

        if (this._joystickEnabled) {
            // Incoming (main) joystick logic: orbit pan + touch joystick for fly move
            const orbitMove = screenToWorld(camera, touch[0], touch[1], effectivePanDistance);
            v.add(orbitMove.mulScalar(orbit * pan));
            flyMove.set(this._touchJoystickX, 0, -this._touchJoystickY);
            v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
        } else {
            // Two-finger pan + MobileFlyInput move (default when UI disables joystick)
            const twoFingerPanMove = screenToWorld(camera, touch[0], touch[1], effectivePanDistance);
            v.add(twoFingerPanMove.mulScalar(pan));
            if (this._mobileFlyInput) {
                const { moveInput } = this._mobileFlyInput;
                flyMove.set(moveInput.x, 0, -moveInput.y);
                v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
            } else {
                flyMove.set(leftInput[0], 0, -leftInput[1]);
                v.add(flyMove.mulScalar(fly * this.moveSpeed * dt));
            }
        }

        // Two-finger pinch zoom: works in both orbit and fly modes
        pinchMove.set(0, 0, pinch[0]);
        v.add(pinchMove.mulScalar(double * this.pinchSpeed * dt));

        // Need to flip z axis for orbit camera (same as desktop move)
        deltas.move.append([v.x, v.y, orbit ? v.z : -v.z]);

        // mobile rotate
        v.set(0, 0, 0);

        if (this._joystickEnabled) {
            // Incoming (main) joystick logic: orbit rotate + single-finger look in fly (joystick has its own touches)
            orbitRotate.set(touch[0], touch[1], 0);
            v.add(orbitRotate.mulScalar(orbit * (1 - pan) * this.orbitSpeed * dt));
            flyRotate.set(touch[0], touch[1], 0);
            v.add(flyRotate.mulScalar(fly * (1 - double) * this.orbitSpeed * orbitFactor * 1.25 * dt));
            deltas.rotate.append([v.x, v.y, v.z]);
        } else {
            // Two-finger rotate + MobileFlyInput look/roll (default when UI disables joystick)
            const isTwoFingerRotate = this._mobileFlyInput && this._mobileFlyInput.getTwoFingerGestureMode() === 'rotate';
            if (isTwoFingerRotate && state.cameraMode === 'orbit') {
                state.cameraMode = 'fly';
            }
            if (!isTwoFingerRotate) {
                orbitRotate.set(touch[0], touch[1], 0);
                v.add(orbitRotate.mulScalar(orbit * (1 - pan) * this.orbitSpeed * dt));
            }
            if (this._mobileFlyInput) {
                const { lookInput, rollInput } = this._mobileFlyInput;
                flyRotate.set(lookInput.x, lookInput.y, 0);
                v.add(flyRotate.mulScalar(fly * this.orbitSpeed * orbitFactor * dt * 0.8));
                const rollSensitivity = 3;
                v.z += rollInput * fly * rollSensitivity;
            } else {
                flyRotate.set(rightInput[0], rightInput[1], 0);
                v.add(flyRotate.mulScalar(fly * this.orbitSpeed * orbitFactor * dt));
            }
            if (v.x !== 0 || v.y !== 0 || v.z !== 0) {
                deltas.rotate.append([v.x, v.y, v.z]);
            }
        }

        // gamepad move
        v.set(0, 0, 0);
        stickMove.set(leftStick[0], 0, -leftStick[1]);
        v.add(stickMove.mulScalar(this.moveSpeed * dt));
        deltas.move.append([v.x, v.y, v.z]);

        // gamepad rotate
        v.set(0, 0, 0);
        stickRotate.set(rightStick[0], rightStick[1], 0);
        v.add(stickRotate.mulScalar(this.orbitSpeed * orbitFactor * dt));
        if (v.x !== 0 || v.y !== 0) {
            deltas.rotate.append([v.x, v.y, 0]);
        }
    }
}

export { InputController };
