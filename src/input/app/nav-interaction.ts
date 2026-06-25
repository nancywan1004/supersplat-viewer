import { Vec3 } from 'playcanvas';

import type { Collision } from '../../collision';
import { type Picker } from '../../picker/index';
import { isPlacementCursorActive } from '../../placement-cursor';
import { isCameraInteractionBlocked } from '../../state-selectors';
import type { Global } from '../../types';
import { TAP_EPSILON } from '../shared';

const tmpV = new Vec3();

// Mirror gaming-controls speed modifiers: shift = run/boost, ctrl = crawl/slow.
// Multipliers match keyboard-mouse.ts so click-nav and held-key movement feel the same.
const computeClickSpeedMul = (event: MouseEvent | undefined, mode: string): number => {
    if (!event) return 1;
    if (mode === 'walk') {
        if (event.shiftKey) return 2;
        if (event.ctrlKey) return 0.5;
    } else if (mode === 'fly') {
        if (event.shiftKey) return 4;
        if (event.ctrlKey) return 0.25;
    }
    return 1;
};

type PickTarget = {
    position: Vec3;
    normal: Vec3;
};

/**
 * Click-to-walk / click-to-fly / click-to-focus (desktop), tap equivalents
 * on mobile, and double-click-to-pick fallback. Uses collision first and
 * rendered-scene picking when collision is unavailable.
 */
class NavInteraction {
    collision: Collision | null = null;

    private _picker: Picker;

    private _global: Global | null = null;

    private _canvas: HTMLCanvasElement | null = null;

    private _lastPointerOffsetX = 0;

    private _lastPointerOffsetY = 0;

    private _mouseClickTracking = false;

    private _mouseClickDelta = 0;

    private _suppressClick = false;

    private _targetPickRequest = 0;

    private _lastMobileTap = { time: 0, offsetX: 0, offsetY: 0 };

    private _touchTapTracking: {
        pointerId: number;
        startClientX: number;
        startClientY: number;
        startOffsetX: number;
        startOffsetY: number;
        maxDelta: number;
    } | null = null;

    constructor(picker: Picker) {
        this._picker = picker;
    }

    private _updateCursor = () => {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas) return;
        if (isPlacementCursorActive()) return;
        const { state } = global;
        if (isCameraInteractionBlocked(state)) {
            canvas.style.cursor = '';
            return;
        }
        const canClickTarget = state.inputMode === 'desktop' &&
            state.cameraMode === 'walk' &&
            !state.gamingControls;
        if (canClickTarget) {
            canvas.style.cursor = this._mouseClickTracking ? 'default' : 'pointer';
        } else {
            canvas.style.cursor = '';
        }
    };

    private _onCameraModeChanged = () => {
        this._targetPickRequest++;
        this._lastMobileTap.time = 0;
        this._updateCursor();
    };

    private _pickCollision(offsetX: number, offsetY: number): PickTarget | null {
        if (!this.collision || !this._global) return null;

        const camera = this._global.camera;
        const cameraPos = camera.getPosition();

        camera.camera!.screenToWorld(offsetX, offsetY, 1.0, tmpV);
        tmpV.sub(cameraPos).normalize();

        const hit = this.collision.queryRay(
            cameraPos.x, cameraPos.y, cameraPos.z,
            tmpV.x, tmpV.y, tmpV.z,
            camera.camera!.farClip
        );

        if (!hit) return null;

        const sn = this.collision.querySurfaceNormal(hit.x, hit.y, hit.z, tmpV.x, tmpV.y, tmpV.z);
        return {
            position: new Vec3(hit.x, hit.y, hit.z),
            normal: new Vec3(sn.nx, sn.ny, sn.nz)
        };
    }

    private async _pickSceneTarget(offsetX: number, offsetY: number): Promise<PickTarget | null> {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas) return null;

        const collisionTarget = this._pickCollision(offsetX, offsetY);
        if (collisionTarget) {
            return collisionTarget;
        }

        const result = await this._picker.pickSurface(
            offsetX / canvas.clientWidth,
            offsetY / canvas.clientHeight
        );
        if (result) {
            return result;
        }

        return null;
    }

    private async _pickFocusPosition(
        offsetX: number,
        offsetY: number
    ): Promise<Vec3 | null> {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas) return null;

        const collisionTarget = this._pickCollision(offsetX, offsetY);
        if (collisionTarget) {
            return collisionTarget.position;
        }

        const target = await this._pickSceneTarget(offsetX, offsetY);
        if (target) {
            return target.position;
        }

        const depthPick = await this._picker.pick(
            offsetX / canvas.clientWidth,
            offsetY / canvas.clientHeight
        );
        return depthPick;
    }

    private async _handleDoubleTapAt(offsetX: number, offsetY: number) {
        const global = this._global;
        if (!global) return;
        if (isCameraInteractionBlocked(global.state)) return;
        const { events } = global;

        // dblclick focuses orbit at the picked target from any navigation mode.
        // CameraManager owns the actual orbit transition via the `pick` event.
        const request = ++this._targetPickRequest;
        const pickResult = await this._pickFocusPosition(offsetX, offsetY);
        if (!pickResult || request !== this._targetPickRequest) return;

        events.fire('pick', pickResult);
    }

    private _onPointerDown = (event: PointerEvent) => {
        const global = this._global;
        if (!global) return;
        if (isCameraInteractionBlocked(global.state)) {
            this._mouseClickTracking = false;
            this._touchTapTracking = null;
            this._lastMobileTap.time = 0;
            this._updateCursor();
            return;
        }

        // record offsets for click/tap target picking
        this._lastPointerOffsetX = event.offsetX;
        this._lastPointerOffsetY = event.offsetY;

        // start desktop click target tracking
        if (event.pointerType !== 'touch' && event.button === 0) {
            this._mouseClickTracking = true;
            this._mouseClickDelta = 0;
            this._updateCursor();
        }

        if (event.pointerType === 'touch' && event.isPrimary) {
            this._touchTapTracking = {
                pointerId: event.pointerId,
                startClientX: event.clientX,
                startClientY: event.clientY,
                startOffsetX: event.offsetX,
                startOffsetY: event.offsetY,
                maxDelta: 0
            };
        }
    };

    private _onPointerMove = (event: PointerEvent) => {
        const global = this._global;
        if (!global) return;
        if (isCameraInteractionBlocked(global.state)) return;
        const { state, events } = global;

        if (this._mouseClickTracking && event.pointerType !== 'touch') {
            const prev = this._mouseClickDelta;
            this._mouseClickDelta += Math.abs(event.movementX) + Math.abs(event.movementY);
            if (prev < TAP_EPSILON && this._mouseClickDelta >= TAP_EPSILON) {
                if (state.cameraMode === 'walk' && !state.gamingControls) {
                    events.fire('navigateCancel');
                }
            }
        } else if (event.pointerType === 'touch' &&
            this._touchTapTracking &&
            event.pointerId === this._touchTapTracking.pointerId) {
            const dx = event.clientX - this._touchTapTracking.startClientX;
            const dy = event.clientY - this._touchTapTracking.startClientY;
            this._touchTapTracking.maxDelta = Math.max(
                this._touchTapTracking.maxDelta,
                Math.abs(dx) + Math.abs(dy)
            );
        }
    };

    private _onPointerUp = (event: PointerEvent) => {
        const global = this._global;
        if (!global) return;
        if (isCameraInteractionBlocked(global.state)) {
            this._mouseClickTracking = false;
            this._touchTapTracking = null;
            return;
        }
        const { state, events } = global;

        if (this._mouseClickTracking && event.pointerType !== 'touch' && event.button === 0) {
            this._mouseClickTracking = false;
            this._updateCursor();
            if (this._suppressClick) {
                this._suppressClick = false;
                return;
            }
            if (this._mouseClickDelta < TAP_EPSILON) {
                if (state.cameraMode === 'walk' && !state.gamingControls) {
                    const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);
                    if (result) {
                        const speedMul = computeClickSpeedMul(event, state.cameraMode);
                        events.fire('navigateTo', result.position, result.normal, speedMul);
                    }
                }
            }
        } else if (event.pointerType === 'touch' &&
            this._touchTapTracking &&
            event.pointerId === this._touchTapTracking.pointerId) {
            const tracking = this._touchTapTracking;
            this._touchTapTracking = null;

            const endDelta = Math.abs(event.clientX - tracking.startClientX) +
                Math.abs(event.clientY - tracking.startClientY);
            const tapDelta = Math.max(tracking.maxDelta, endDelta);
            if (tapDelta >= 28) {
                this._lastMobileTap.time = 0;
                return;
            }

            const now = Date.now();
            const delay = Math.max(0, now - this._lastMobileTap.time);
            const offsetX = event.offsetX || tracking.startOffsetX;
            const offsetY = event.offsetY || tracking.startOffsetY;
            if (delay < 420 &&
                Math.abs(offsetX - this._lastMobileTap.offsetX) < 36 &&
                Math.abs(offsetY - this._lastMobileTap.offsetY) < 36) {
                this._lastMobileTap.time = 0;
                this._suppressClick = true;
                events.fire('inputEvent', 'dblclick', event);
                event.preventDefault();
                return;
            }

            this._lastMobileTap.time = now;
            this._lastMobileTap.offsetX = offsetX;
            this._lastMobileTap.offsetY = offsetY;
        }
    };

    private _onPointerCancel = (event: PointerEvent) => {
        if (this._touchTapTracking?.pointerId === event.pointerId) {
            this._touchTapTracking = null;
            this._lastMobileTap.time = 0;
        }
    };

    private _onInputEvent = async (eventName: string, event: Event) => {
        const global = this._global;
        const canvas = this._canvas;
        if (!global || !canvas) return;
        if (eventName !== 'dblclick') return;
        if (!(event instanceof MouseEvent)) return;
        if (isCameraInteractionBlocked(global.state)) return;
        this._suppressClick = true;
        await this._handleDoubleTapAt(event.offsetX, event.offsetY);
    };

    private _onMobileTap = () => {
        const global = this._global;
        if (!global) return;
        if (isCameraInteractionBlocked(global.state)) return;
        const { state, events } = global;
        if (this._suppressClick) {
            this._suppressClick = false;
            return;
        }

        if (state.cameraMode === 'walk' && !state.gamingControls) {
            const result = this._pickCollision(this._lastPointerOffsetX, this._lastPointerOffsetY);
            if (result) {
                events.fire('navigateTo', result.position, result.normal);
            }
        }
    };

    attach(canvas: HTMLCanvasElement, global: Global): void {
        this._canvas = canvas;
        this._global = global;
        const { events } = global;

        canvas.addEventListener('pointerdown', this._onPointerDown);
        canvas.addEventListener('pointermove', this._onPointerMove);
        canvas.addEventListener('pointerup', this._onPointerUp);
        canvas.addEventListener('pointercancel', this._onPointerCancel);

        // double-click/tap fallback -> fly target or orbit focus (skipped in walk mode)
        events.on('inputEvent', this._onInputEvent);

        // mobile tap (no movement) → walk/fly target or orbit focus
        events.on('mobileTap', this._onMobileTap);

        // refresh cursor on mode / gaming-controls change
        events.on('cameraMode:changed', this._onCameraModeChanged);
        events.on('inputMode:changed', this._updateCursor);
        events.on('gamingControls:changed', this._updateCursor);
    }

    detach(): void {
        if (this._canvas) {
            this._canvas.removeEventListener('pointerdown', this._onPointerDown);
            this._canvas.removeEventListener('pointermove', this._onPointerMove);
            this._canvas.removeEventListener('pointerup', this._onPointerUp);
            this._canvas.removeEventListener('pointercancel', this._onPointerCancel);
        }
        if (this._global) {
            const { events } = this._global;
            events.off('inputEvent', this._onInputEvent);
            events.off('mobileTap', this._onMobileTap);
            events.off('cameraMode:changed', this._onCameraModeChanged);
            events.off('inputMode:changed', this._updateCursor);
            events.off('gamingControls:changed', this._updateCursor);
        }
        this._canvas = null;
        this._global = null;
    }
}

export { NavInteraction };
