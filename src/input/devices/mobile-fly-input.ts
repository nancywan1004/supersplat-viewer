import { Vec2 } from 'playcanvas';

type TwoFingerGestureMode = 'none' | 'rotate' | 'pan' | 'pinch';

type TouchState = {
    startX: number;
    startY: number;
    currentX: number;
    currentY: number;
};

/**
 * Portrait fly gesture source.
 *
 * This intentionally does not own joystick movement. Landscape gaming controls
 * use the DOM joystick from ui.ts; this class only keeps the old portrait fly
 * behaviors that are not provided by MultiTouchSource: delayed one-finger look
 * and two-finger twist-to-roll detection.
 */
class MobileFlyInput {
    private readonly canvas: HTMLCanvasElement;

    private readonly touches = new Map<number, TouchState>();

    private lookTouchId: number | null = null;

    private lookTouchStartTime = 0;

    private totalTouchCount = 0;

    private lookEnabled = true;

    private twoFingerTouchIds: number[] = [];

    private twoFingerStartAngle = 0;

    private twoFingerStartDistance = 0;

    private twoFingerStartCenter = { x: 0, y: 0 };

    private twoFingerGestureMode: TwoFingerGestureMode = 'none';

    private twoFingerGestureLocked = false;

    private twoFingerAccumulatedRotation = 0;

    private twoFingerAccumulatedPinch = 0;

    private twoFingerAccumulatedPan = 0;

    private readonly ROTATION_THRESHOLD = 0.05;

    private readonly PINCH_THRESHOLD = 30;

    private readonly PAN_THRESHOLD = 25;

    private readonly ROTATION_CONTINUE_THRESHOLD = 0.02;

    private debugMode = false;

    public lookInput = new Vec2(0, 0);

    public rollInput = 0;

    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
        canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
        canvas.addEventListener('touchend', this.onTouchEnd, { passive: false });
        canvas.addEventListener('touchcancel', this.onTouchEnd, { passive: false });
    }

    destroy(): void {
        this.canvas.removeEventListener('touchstart', this.onTouchStart);
        this.canvas.removeEventListener('touchmove', this.onTouchMove);
        this.canvas.removeEventListener('touchend', this.onTouchEnd);
        this.canvas.removeEventListener('touchcancel', this.onTouchEnd);
        this.reset();
    }

    reset(): void {
        this.lookInput.set(0, 0);
        this.rollInput = 0;
        this.lookTouchId = null;
        this.touches.clear();
        this.totalTouchCount = 0;
        this.resetTwoFingerGesture();
    }

    setLookEnabled(enabled: boolean): void {
        this.lookEnabled = enabled;
        if (!enabled) {
            this.reset();
        }
    }

    isLookEnabled(): boolean {
        return this.lookEnabled;
    }

    getTwoFingerGestureMode(): TwoFingerGestureMode {
        return this.twoFingerGestureMode;
    }

    getTotalTouchCount(): number {
        return this.totalTouchCount;
    }

    setDebugMode(enabled: boolean): void {
        this.debugMode = enabled;
    }

    getDebugInfo() {
        return {
            totalTouchCount: this.totalTouchCount,
            gestureMode: this.twoFingerGestureMode,
            gestureLocked: this.twoFingerGestureLocked,
            accumulatedRotation: this.twoFingerAccumulatedRotation,
            accumulatedPinch: this.twoFingerAccumulatedPinch,
            accumulatedPan: this.twoFingerAccumulatedPan,
            rollInput: this.rollInput,
            twoFingerTouchIds: this.twoFingerTouchIds.length
        };
    }

    private onTouchStart = (event: TouchEvent) => {
        if (!this.lookEnabled) {
            this.totalTouchCount = 0;
            return;
        }

        this.totalTouchCount = event.touches.length;

        if (this.totalTouchCount === 2) {
            this.initTwoFingerGesture(event.touches);
        }

        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const { x, y } = this.getCanvasPoint(touch);

            if (this.lookEnabled && this.lookTouchId === null && this.totalTouchCount === 1) {
                this.lookTouchId = touch.identifier;
                this.lookTouchStartTime = Date.now();
                this.touches.set(touch.identifier, {
                    startX: x,
                    startY: y,
                    currentX: x,
                    currentY: y
                });
            }
        }

        if (this.totalTouchCount >= 2 && this.lookTouchId !== null) {
            this.lookTouchId = null;
            this.lookInput.set(0, 0);
        }
    };

    private onTouchMove = (event: TouchEvent) => {
        if (!this.lookEnabled) {
            return;
        }

        event.preventDefault();

        if (this.totalTouchCount === 2 && this.twoFingerTouchIds.length === 2) {
            this.updateTwoFingerGesture(event.touches);
        }

        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const touchData = this.touches.get(touch.identifier);
            if (touchData) {
                const { x, y } = this.getCanvasPoint(touch);
                touchData.currentX = x;
                touchData.currentY = y;
            }
        }

        this.updateLookInput();
    };

    private onTouchEnd = (event: TouchEvent) => {
        this.totalTouchCount = event.touches.length;

        if (this.totalTouchCount < 2) {
            this.resetTwoFingerGesture();
        }

        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];

            if (touch.identifier === this.lookTouchId) {
                this.lookTouchId = null;
                this.lookInput.set(0, 0);
            }

            this.touches.delete(touch.identifier);
        }
    };

    private updateLookInput(): void {
        if (!this.lookEnabled || this.lookTouchId === null || this.totalTouchCount > 1) {
            this.lookInput.set(0, 0);
            return;
        }

        const touchData = this.touches.get(this.lookTouchId);
        if (!touchData) return;

        // Keep the old delay so a single tap/double tap does not immediately rotate.
        if (Date.now() - this.lookTouchStartTime <= 120) {
            this.lookInput.set(0, 0);
            return;
        }

        this.lookInput.x = touchData.currentX - touchData.startX;
        this.lookInput.y = touchData.currentY - touchData.startY;
        touchData.startX = touchData.currentX;
        touchData.startY = touchData.currentY;
    }

    private initTwoFingerGesture(touches: TouchList): void {
        if (touches.length !== 2) return;

        const p0 = this.getCanvasPoint(touches[0]);
        const p1 = this.getCanvasPoint(touches[1]);

        this.twoFingerTouchIds = [touches[0].identifier, touches[1].identifier];
        this.twoFingerStartAngle = Math.atan2(p1.y - p0.y, p1.x - p0.x);

        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        this.twoFingerStartDistance = Math.sqrt(dx * dx + dy * dy);
        this.twoFingerStartCenter = {
            x: (p0.x + p1.x) / 2,
            y: (p0.y + p1.y) / 2
        };

        this.twoFingerGestureMode = 'none';
        this.twoFingerGestureLocked = false;
        this.twoFingerAccumulatedRotation = 0;
        this.twoFingerAccumulatedPinch = 0;
        this.twoFingerAccumulatedPan = 0;

        if (this.debugMode) {
            console.log('Two-finger gesture initialized', {
                angle: this.twoFingerStartAngle,
                distance: this.twoFingerStartDistance,
                center: this.twoFingerStartCenter
            });
        }
    }

    private updateTwoFingerGesture(touches: TouchList): void {
        if (touches.length !== 2 || this.twoFingerTouchIds.length !== 2) return;

        const touch0 = this.findTouchById(touches, this.twoFingerTouchIds[0]);
        const touch1 = this.findTouchById(touches, this.twoFingerTouchIds[1]);
        if (!touch0 || !touch1) return;

        const p0 = this.getCanvasPoint(touch0);
        const p1 = this.getCanvasPoint(touch1);

        const currentAngle = Math.atan2(p1.y - p0.y, p1.x - p0.x);
        let angleDelta = currentAngle - this.twoFingerStartAngle;
        while (angleDelta > Math.PI) angleDelta -= 2 * Math.PI;
        while (angleDelta < -Math.PI) angleDelta += 2 * Math.PI;

        const dx = p1.x - p0.x;
        const dy = p1.y - p0.y;
        const currentDistance = Math.sqrt(dx * dx + dy * dy);
        const distanceDelta = Math.abs(currentDistance - this.twoFingerStartDistance);

        const currentCenter = {
            x: (p0.x + p1.x) / 2,
            y: (p0.y + p1.y) / 2
        };
        const centerDx = currentCenter.x - this.twoFingerStartCenter.x;
        const centerDy = currentCenter.y - this.twoFingerStartCenter.y;
        const centerMovement = Math.sqrt(centerDx * centerDx + centerDy * centerDy);

        this.twoFingerAccumulatedRotation += Math.abs(angleDelta);
        this.twoFingerAccumulatedPinch += distanceDelta;
        this.twoFingerAccumulatedPan += centerMovement;

        if (!this.twoFingerGestureLocked) {
            if (this.twoFingerAccumulatedPinch > this.PINCH_THRESHOLD) {
                this.twoFingerGestureMode = 'pinch';
                this.twoFingerGestureLocked = true;
            } else if (this.twoFingerAccumulatedPan > this.PAN_THRESHOLD) {
                this.twoFingerGestureMode = 'pan';
                this.twoFingerGestureLocked = true;
            } else if (this.twoFingerAccumulatedRotation > this.ROTATION_THRESHOLD) {
                this.twoFingerGestureMode = 'rotate';
                this.twoFingerGestureLocked = true;
            }
        }

        if (this.twoFingerGestureMode === 'rotate') {
            if (Math.abs(angleDelta) > this.ROTATION_CONTINUE_THRESHOLD) {
                this.rollInput = angleDelta;
                this.twoFingerStartAngle = currentAngle;
            } else {
                this.rollInput *= 0.8;
            }
        } else {
            this.rollInput = 0;
        }

        this.twoFingerStartDistance = currentDistance;
        this.twoFingerStartCenter = currentCenter;
    }

    private resetTwoFingerGesture(): void {
        this.twoFingerTouchIds = [];
        this.twoFingerGestureMode = 'none';
        this.twoFingerGestureLocked = false;
        this.twoFingerAccumulatedRotation = 0;
        this.twoFingerAccumulatedPinch = 0;
        this.twoFingerAccumulatedPan = 0;
        this.rollInput = 0;
    }

    private getCanvasPoint(touch: Touch): { x: number; y: number } {
        const rect = this.canvas.getBoundingClientRect();
        return {
            x: touch.clientX - rect.left,
            y: touch.clientY - rect.top
        };
    }

    private findTouchById(touches: TouchList, id: number): Touch | null {
        for (let i = 0; i < touches.length; i++) {
            if (touches[i].identifier === id) {
                return touches[i];
            }
        }
        return null;
    }
}

export { MobileFlyInput };
export type { TwoFingerGestureMode };
