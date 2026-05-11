import { InputFrame } from 'playcanvas';

import type { Collision } from './collision';
import type { InputArbiter } from './input-arbiter';
import { InputModeTracker } from './input/app/input-mode-tracker';
import { ModeShortcuts } from './input/app/mode-shortcuts';
import { NavInteraction } from './input/app/nav-interaction';
import { PointerLockManager } from './input/app/pointer-lock';
import { GamepadDevice } from './input/devices/gamepad';
import { KeyboardMouseDevice } from './input/devices/keyboard-mouse';
import { TouchDevice } from './input/devices/touch';
import { TrackpadDevice } from './input/devices/trackpad';
import { pickWorldFromClientXY } from './picker';
import type { UpdateContext } from './input/shared';
import type { Picker } from './picker';
import type { Global } from './types';

/**
 * Coordinator that wires together input devices (keyboard-mouse, touch,
 * trackpad, gamepad) and app-level UX helpers (mode shortcuts, nav
 * interaction, pointer lock, input-mode tracker), and exposes the
 * resulting per-frame `InputFrame` for the camera manager to consume.
 */
class InputController {
    frame = new InputFrame({
        move: [0, 0, 0],
        rotate: [0, 0, 0]
    });

    private _global: Global;
    private _trackpad = new TrackpadDevice();
    private _keyboardMouse = new KeyboardMouseDevice();
    private _touch = new TouchDevice();
    private _gamepad = new GamepadDevice();
    private _navInteraction: NavInteraction;
    private _pointerLock = new PointerLockManager();
    private _modeShortcuts = new ModeShortcuts();
    private _inputModeTracker = new InputModeTracker();

    private _annotationInputFocused = false;
    private _minPanDistance = 1;

    private _onFocusIn = (event: FocusEvent) => {
        const target = event.target as HTMLElement | null;
        if (target && this.isAnnotationInput(target)) {
            this._annotationInputFocused = true;
        }
    };

    private _onFocusOut = (event: FocusEvent) => {
        const target = event.target as HTMLElement | null;
        if (target && this.isAnnotationInput(target)) {
            this._annotationInputFocused = false;
        }
    };

    private _onWindowKeyDownCapture = (event: KeyboardEvent) => {
        if (this._annotationInputFocused) {
            event.stopImmediatePropagation();
        }
    };

    private _onPointerDownRefocus = (event: PointerEvent) => {
        const canvas = this._global.app.graphicsDevice.canvas as HTMLCanvasElement;
        if (!event.isPrimary || typeof canvas.focus !== 'function') return;
        try {
            canvas.focus({ preventScroll: true });
        } catch {
            canvas.focus();
        }
    };

    private _onPointerUpSceneClick = async (event: PointerEvent) => {
        if (!event.isPrimary || event.button !== 0) return;

        const canvas = this._global.app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = canvas.getBoundingClientRect();
        if (event.clientX < rect.left || event.clientX > rect.right ||
            event.clientY < rect.top || event.clientY > rect.bottom) {
            return;
        }

        const { events, state } = this._global;
        const cameraControlsEnabled = state.cameraControlsEnabled !== false;
        const result = await pickWorldFromClientXY(this._global, event.clientX, event.clientY);

        const inputArbiter = (this._global as Global & { __inputArbiter?: InputArbiter }).__inputArbiter;
        const dispatchResult = inputArbiter?.dispatchPointerClick({
            global: this._global,
            pointerEvent: event,
            clientX: event.clientX,
            clientY: event.clientY,
            worldPosition: result ?? null
        });
        if (dispatchResult?.claimed) return;
        if (!cameraControlsEnabled) return;

        if (result) {
            events.fire('scenePointerWorldClick', {
                position: result,
                clientX: event.clientX,
                clientY: event.clientY
            });
        }
    };

    set collision(value: Collision | null) {
        this._navInteraction.collision = value;
    }

    get collision(): Collision | null {
        return this._navInteraction.collision;
    }

    setMoveSpeedFromSceneSize(sceneSize: number) {
        const speed = Math.max(1, sceneSize * 0.05);
        this._keyboardMouse.moveSpeed = speed;
        this._touch.moveSpeed = speed;
        this._gamepad.moveSpeed = speed;
        this._minPanDistance = Math.max(1, sceneSize * 0.1);
    }

    setAnnotationInputFocused(focused: boolean): void {
        this._annotationInputFocused = focused;
    }

    isAnnotationInputFocused(): boolean {
        return this._annotationInputFocused;
    }
    constructor(global: Global, picker: Picker) {
        this._global = global;
        this._navInteraction = new NavInteraction(picker);

        const { app, events } = global;
        const canvas = app.graphicsDevice.canvas as HTMLCanvasElement;

        if (typeof canvas.tabIndex !== 'number' || canvas.tabIndex < 0) {
            canvas.tabIndex = 0;
        }

        this._trackpad.attach(canvas, global);
        this._keyboardMouse.attach(canvas, global);
        this._touch.attach(canvas, global);
        this._gamepad.attach(canvas, global);

        this._navInteraction.attach(canvas, global);
        this._pointerLock.attach(canvas, global, this._keyboardMouse);
        this._modeShortcuts.attach(global, this._pointerLock);
        this._inputModeTracker.attach(global);

        ['wheel', 'pointerdown', 'contextmenu', 'keydown'].forEach((eventName) => {
            canvas.addEventListener(eventName, (event) => {
                events.fire('inputEvent', 'interrupt', event);
            });
        });
        canvas.addEventListener('pointermove', (event) => {
            events.fire('inputEvent', 'interact', event);
        });

        canvas.addEventListener('pointerdown', this._onPointerDownRefocus);
        canvas.addEventListener('pointerup', this._onPointerUpSceneClick);

        events.on('cameraControls:flushInputs', () => {
            this.frame = new InputFrame({
                move: [0, 0, 0],
                rotate: [0, 0, 0]
            });
        });

        document.addEventListener('focusin', this._onFocusIn);
        document.addEventListener('focusout', this._onFocusOut);
        window.addEventListener('keydown', this._onWindowKeyDownCapture, true);
    }

    private isAnnotationInput(element: HTMLElement): boolean {
        if (element.tagName !== 'INPUT' && element.tagName !== 'TEXTAREA') {
            return false;
        }
        if (element.closest('#annotationToolbar')) {
            return true;
        }
        return element.classList.contains('annotation-form-input') ||
            element.classList.contains('annotation-form-textarea');
    }

    update(dt: number, distance: number) {
        const { state } = this._global;

        if (state.cameraControlsEnabled === false) {
            this.frame = new InputFrame({
                move: [0, 0, 0],
                rotate: [0, 0, 0]
            });
            return;
        }

        const cameraComponent = this._global.camera.camera!;
        const safeDistance = Number.isFinite(distance) && distance > 0 ? distance : this._minPanDistance;
        const effectiveDistance = Math.max(safeDistance, this._minPanDistance);

        const isOrbit = state.cameraMode === 'orbit';
        const isFly = state.cameraMode === 'fly';
        const isWalk = state.cameraMode === 'walk';
        const isFirstPerson = isFly || isWalk;

        const ctx: UpdateContext = {
            dt,
            distance: effectiveDistance,
            cameraComponent,
            mode: state.cameraMode,
            isOrbit,
            isFly,
            isWalk,
            isFirstPerson,
            gamingControls: state.gamingControls,
            touchCount: this._touch.touchCount
        };

        this.frame = new InputFrame({
            move: [0, 0, 0],
            rotate: [0, 0, 0]
        });

        this._touch.update(ctx, this.frame);
        ctx.touchCount = this._touch.touchCount;
        this._keyboardMouse.update(ctx, this.frame);
        this._trackpad.update(ctx, this.frame);
        this._gamepad.update(ctx, this.frame);
    }
}

export { InputController };
