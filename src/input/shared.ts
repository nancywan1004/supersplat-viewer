import { math, PROJECTION_PERSPECTIVE, Vec3 } from 'playcanvas';
import type { CameraComponent, InputFrame } from 'playcanvas';

import type { CameraMode, Global } from '../types';

type CameraMove = [number, number, number];
type CameraRotate = [number, number, number];

/** The shape of every device's input frame: world-space move + euler rotate deltas. */
type CameraInputFrame = InputFrame<{ move: CameraMove; rotate: CameraRotate }>;

/**
 * Displacement-based inputs (mouse, touch, wheel, pinch) return accumulated
 * pixel offsets that already scale with frame time. This factor converts
 * rate-based speed constants (tuned for degrees-per-second) to work with
 * per-frame displacements, making them frame-rate-independent.
 */
const DISPLACEMENT_SCALE = 1 / 60;

/** Maximum accumulated touch movement (px) to still count as a tap. */
const TAP_EPSILON = 15;

const tmpHalfSize = new Vec3();

/**
 * Converts screen-space pixel deltas to a world-space pan vector at the
 * given depth.
 *
 * @param camera - The camera component.
 * @param dx - Horizontal pixel delta.
 * @param dy - Vertical pixel delta.
 * @param dz - Depth (world-space) at which to project the delta.
 * @param out - Optional output vector.
 * @returns The pan vector in world space.
 */
const screenToWorld = (
    camera: CameraComponent,
    dx: number,
    dy: number,
    dz: number,
    out: Vec3 = new Vec3()
) => {
    const { system, fov, aspectRatio, horizontalFov, projection, orthoHeight } = camera;
    const { width, height } = system.app.graphicsDevice.clientRect;

    out.set(-(dx / width) * 2, (dy / height) * 2, 0);

    const halfSize = tmpHalfSize.set(0, 0, 0);
    if (projection === PROJECTION_PERSPECTIVE) {
        const halfSlice = dz * Math.tan(0.5 * fov * math.DEG_TO_RAD);
        if (horizontalFov) {
            halfSize.set(halfSlice, halfSlice / aspectRatio, 0);
        } else {
            halfSize.set(halfSlice * aspectRatio, halfSlice, 0);
        }
    } else {
        halfSize.set(orthoHeight * aspectRatio, orthoHeight, 0);
    }

    out.mul(halfSize);
    return out;
};

/**
 * The orbit camera and the fly camera disagree on the sign of the z-axis
 * for forward motion. Apply this when emitting a forward/back z-component
 * so the same wheel-style delta drives both cameras correctly.
 *
 * @param mode - The current camera mode.
 * @param z - The raw forward/back z-component.
 * @returns The z-component flipped for orbit mode, unchanged otherwise.
 */
const flipZForOrbit = (mode: CameraMode, z: number) => (mode === 'orbit' ? -z : z);

/**
 * The per-frame view of the world that every device's `update()` reads
 * from. Built once by InputController and passed to each device in turn.
 */
type UpdateContext = {
    dt: number;
    /** 真实相机 orbit/focus 距离，供滚轮贴地切 fly 等判断。 */
    distance: number;
    /** 屏幕空间 pan 投影深度，已含 moveSpeedScale。 */
    panDistance: number;
    cameraComponent: CameraComponent;
    mode: CameraMode;
    isOrbit: boolean;
    isFly: boolean;
    isWalk: boolean;
    isFirstPerson: boolean;
    gamingControls: boolean;
    /** Number of touches currently active (read by mouse pan flag). */
    touchCount: number;
};

type OrbitToFlyAutoSwitchOptions = {
    minDistanceDelta?: number;
    stuckFramesThreshold?: number;
};

/**
 * Tracks orbit-zoom progress and detects when zoom-in intent is still active
 * but the orbit distance stops decreasing (typically clamped at min zoom),
 * which should trigger an auto-switch to fly mode.
 */
class OrbitToFlyAutoSwitchTracker {
    private _lastOrbitDistance: number | null = null;

    private _orbitZoomStuckFrames = 0;

    private _minDistanceDelta: number;

    private _stuckFramesThreshold: number;

    constructor(options: OrbitToFlyAutoSwitchOptions = {}) {
        this._minDistanceDelta = options.minDistanceDelta ?? 1e-3;
        this._stuckFramesThreshold = options.stuckFramesThreshold ?? 2;
    }

    update(mode: CameraMode, distance: number, zoomingIn: boolean): boolean {
        if (mode !== 'orbit') {
            this.reset();
            return false;
        }

        if (!zoomingIn) {
            this._orbitZoomStuckFrames = 0;
            this._lastOrbitDistance = distance;
            return false;
        }

        let shouldSwitch = false;
        if (this._lastOrbitDistance !== null) {
            const distanceDelta = this._lastOrbitDistance - distance;
            if (distanceDelta < this._minDistanceDelta) {
                this._orbitZoomStuckFrames++;
            } else {
                this._orbitZoomStuckFrames = 0;
            }
            if (this._orbitZoomStuckFrames >= this._stuckFramesThreshold) {
                shouldSwitch = true;
                this._orbitZoomStuckFrames = 0;
            }
        }

        this._lastOrbitDistance = distance;
        return shouldSwitch;
    }

    reset(): void {
        this._lastOrbitDistance = null;
        this._orbitZoomStuckFrames = 0;
    }
}

/** Common shape every input device implements. */
interface InputDevice {
    attach(canvas: HTMLCanvasElement, global: Global): void;
    detach(): void;
    update(ctx: UpdateContext, frame: CameraInputFrame): void;
}

export {
    DISPLACEMENT_SCALE,
    TAP_EPSILON,
    screenToWorld,
    flipZForOrbit,
    OrbitToFlyAutoSwitchTracker,
    CameraInputFrame,
    UpdateContext,
    InputDevice
};
