import { Vec2 } from 'playcanvas';

/**
 * Custom mobile input handler for fly camera with fixed joystick position
 * - Joystick fixed in bottom-right corner for movement
 * - Single finger anywhere else for look around
 * - Separated from orbit gestures
 */
class MobileFlyInput {
    // Joystick configuration
    private joystickRadius = 96;
    private joystickDeadZone = 8;
    private joystickPosition = { x: 0, y: 0 }; // Will be set based on screen size
    
    // Touch tracking
    private touches = new Map<number, { startX: number, startY: number, currentX: number, currentY: number, startTime: number }>();
    private joystickTouchId: number | null = null;
    private lookTouchId: number | null = null;
    private lookTouchStartTime: number = 0;
    private totalTouchCount: number = 0;
    
    // Output values
    public moveInput = new Vec2(0, 0);
    public lookInput = new Vec2(0, 0);
    public isJoystickActive = false;
    
    // Enable/disable flags
    private joystickEnabled = false; // Joystick movement control
    private lookEnabled = true; // Single finger look around (always enabled)
    
    // Canvas reference
    private canvas: HTMLCanvasElement;
    
    // Mouse support for PC debugging
    private mouseDown = false;
    private mouseId = -1;
    
    // Joystick DOM element for direct interaction
    private joystickElement: HTMLElement | null = null;
    
    constructor(canvas: HTMLCanvasElement) {
        this.canvas = canvas;
        this.updateJoystickPosition();
        
        // Update joystick position on resize
        window.addEventListener('resize', () => this.updateJoystickPosition());
        
        // Touch event listeners on canvas
        canvas.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
        canvas.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
        canvas.addEventListener('touchend', (e) => this.onTouchEnd(e), { passive: false });
        canvas.addEventListener('touchcancel', (e) => this.onTouchEnd(e), { passive: false });
        
        // Mouse event listeners for PC debugging on canvas
        canvas.addEventListener('mousedown', (e) => this.onMouseDown(e));
        canvas.addEventListener('mousemove', (e) => this.onMouseMove(e));
        canvas.addEventListener('mouseup', (e) => this.onMouseUp(e));
        canvas.addEventListener('mouseleave', (e) => this.onMouseUp(e));
    }
    
    /**
     * Attach joystick DOM element for direct interaction
     * This is needed because the joystick HTML element is above the canvas
     */
    public attachJoystickElement(element: HTMLElement) {
        console.log('MobileFlyInput: Attaching joystick element', element);
        this.joystickElement = element;
        
        // Enable joystick when element is attached
        this.joystickEnabled = true;
        
        // Make sure element can receive pointer events
        element.style.touchAction = 'none';
        element.style.pointerEvents = 'auto';
        
        // Add event listeners to joystick element
        element.addEventListener('pointerdown', (e) => {
            console.log('MobileFlyInput: pointerdown', e);
            this.onJoystickPointerDown(e);
        });
        element.addEventListener('pointermove', (e) => {
            this.onJoystickPointerMove(e);
        });
        element.addEventListener('pointerup', (e) => {
            console.log('MobileFlyInput: pointerup', e);
            this.onJoystickPointerUp(e);
        });
        element.addEventListener('pointercancel', (e) => {
            this.onJoystickPointerUp(e);
        });
        element.addEventListener('pointerleave', (e) => {
            this.onJoystickPointerUp(e);
        });
        
        console.log('MobileFlyInput: Event listeners attached');
    }
    
    private updateJoystickPosition() {
        const rect = this.canvas.getBoundingClientRect();
        // Position in bottom-left corner with safe margins
        const marginLeft = Math.max(24, 24); // Safe area inset
        const marginBottom = Math.max(80, 80); // Above controls
        
        this.joystickPosition.x = marginLeft + this.joystickRadius / 2;
        this.joystickPosition.y = rect.height - marginBottom - this.joystickRadius / 2;
    }
    
    private isInJoystickArea(x: number, y: number): boolean {
        const dx = x - this.joystickPosition.x;
        const dy = y - this.joystickPosition.y;
        const distance = Math.sqrt(dx * dx + dy * dy);
        return distance <= this.joystickRadius;
    }
    
    /**
     * Public method to check if a point is in the joystick area
     * Useful for filtering out double-tap events in the joystick region
     */
    public isPointInJoystickArea(clientX: number, clientY: number): boolean {
        const rect = this.canvas.getBoundingClientRect();
        const x = clientX - rect.left;
        const y = clientY - rect.top;
        return this.isInJoystickArea(x, y);
    }
    
    private onTouchStart(event: TouchEvent) {
        // Update total touch count
        this.totalTouchCount = event.touches.length;
        
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const rect = this.canvas.getBoundingClientRect();
            const x = touch.clientX - rect.left;
            const y = touch.clientY - rect.top;
            
            // Check if touch is in joystick area (only if joystick is enabled)
            if (this.joystickEnabled && this.joystickTouchId === null && this.isInJoystickArea(x, y)) {
                this.joystickTouchId = touch.identifier;
                this.isJoystickActive = true;
                this.touches.set(touch.identifier, {
                    startX: x,
                    startY: y,
                    currentX: x,
                    currentY: y,
                    startTime: Date.now()
                });
            } else if (this.lookEnabled && this.lookTouchId === null && this.totalTouchCount === 1) {
                // Only register look touch if this is a single finger touch
                // This prevents conflict with two-finger gestures
                this.lookTouchId = touch.identifier;
                this.lookTouchStartTime = Date.now();
                this.touches.set(touch.identifier, {
                    startX: x,
                    startY: y,
                    currentX: x,
                    currentY: y,
                    startTime: Date.now()
                });
            }
        }
        
        // If a second finger is added, clear the look touch to avoid conflicts
        if (this.totalTouchCount >= 2 && this.lookTouchId !== null) {
            this.lookTouchId = null;
            this.lookInput.set(0, 0);
        }
    }
    
    private onTouchMove(event: TouchEvent) {
        event.preventDefault();
        
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            const touchData = this.touches.get(touch.identifier);
            
            if (touchData) {
                const rect = this.canvas.getBoundingClientRect();
                touchData.currentX = touch.clientX - rect.left;
                touchData.currentY = touch.clientY - rect.top;
            }
        }
        
        this.updateInputs();
    }
    
    private onTouchEnd(event: TouchEvent) {
        // Update total touch count
        this.totalTouchCount = event.touches.length;
        
        for (let i = 0; i < event.changedTouches.length; i++) {
            const touch = event.changedTouches[i];
            
            if (touch.identifier === this.joystickTouchId) {
                this.joystickTouchId = null;
                this.isJoystickActive = false;
                this.moveInput.set(0, 0);
            }
            
            if (touch.identifier === this.lookTouchId) {
                this.lookTouchId = null;
                this.lookInput.set(0, 0);
            }
            
            this.touches.delete(touch.identifier);
        }
    }
    
    private updateInputs() {
        // Update joystick input (only if enabled)
        if (this.joystickEnabled && this.joystickTouchId !== null) {
            const touchData = this.touches.get(this.joystickTouchId);
            if (touchData) {
                // Calculate offset from joystick center (stored in startX/startY)
                const dx = touchData.currentX - touchData.startX;
                const dy = touchData.currentY - touchData.startY;
                const distance = Math.sqrt(dx * dx + dy * dy);
                
                console.log('Joystick input:', { dx, dy, distance, startX: touchData.startX, startY: touchData.startY, currentX: touchData.currentX, currentY: touchData.currentY });
                
                if (distance > this.joystickDeadZone) {
                    const maxDistance = this.joystickRadius / 2;
                    const normalizedDistance = Math.min(distance, maxDistance) / maxDistance;
                    const angle = Math.atan2(dy, dx);
                    
                    this.moveInput.x = Math.cos(angle) * normalizedDistance;
                    this.moveInput.y = Math.sin(angle) * normalizedDistance;
                } else {
                    this.moveInput.set(0, 0);
                }
            }
        }
        
        // Update look input (delta-based)
        // Only process look input if enabled and there's a single touch (not two-finger gesture)
        if (this.lookEnabled && this.lookTouchId !== null && this.totalTouchCount <= 1) {
            const touchData = this.touches.get(this.lookTouchId);
            if (touchData) {
                // Ignore look input for the first 120ms to prevent interference with double-tap
                // This gives enough time for double-tap detection (max 400ms between taps)
                const touchDuration = Date.now() - this.lookTouchStartTime;
                if (touchDuration > 120) {
                    const dx = touchData.currentX - touchData.startX;
                    const dy = touchData.currentY - touchData.startY;
                    
                    this.lookInput.x = dx;
                    this.lookInput.y = dy;
                    
                    // Reset start position for continuous movement
                    touchData.startX = touchData.currentX;
                    touchData.startY = touchData.currentY;
                } else {
                    // During the delay period, keep look input at zero
                    this.lookInput.set(0, 0);
                }
            }
        } else if (this.totalTouchCount >= 2) {
            // Clear look input during two-finger gestures
            this.lookInput.set(0, 0);
        }
    }
    
    public getJoystickVisualPosition(): { baseX: number, baseY: number, stickX: number, stickY: number } | null {
        if (!this.isJoystickActive) {
            return null;
        }
        
        const touchData = this.joystickTouchId !== null ? this.touches.get(this.joystickTouchId) : null;
        if (!touchData) {
            return null;
        }
        
        // Return position relative to joystick center (startX/startY)
        return {
            baseX: touchData.startX,
            baseY: touchData.startY,
            stickX: touchData.currentX - touchData.startX,
            stickY: touchData.currentY - touchData.startY
        };
    }
    
    // Joystick DOM element event handlers
    private onJoystickPointerDown(event: PointerEvent) {
        event.preventDefault();
        event.stopPropagation();
        
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        this.joystickTouchId = event.pointerId;
        this.isJoystickActive = true;
        this.touches.set(event.pointerId, {
            startX: this.joystickPosition.x,
            startY: this.joystickPosition.y,
            currentX: x,
            currentY: y,
            startTime: Date.now()
        });
        
        // Capture pointer to receive events even outside element
        if (this.joystickElement) {
            this.joystickElement.setPointerCapture(event.pointerId);
        }
    }
    
    private onJoystickPointerMove(event: PointerEvent) {
        if (event.pointerId === this.joystickTouchId) {
            event.preventDefault();
            event.stopPropagation();
            
            const rect = this.canvas.getBoundingClientRect();
            const touchData = this.touches.get(event.pointerId);
            if (touchData) {
                touchData.currentX = event.clientX - rect.left;
                touchData.currentY = event.clientY - rect.top;
                this.updateInputs();
            }
        }
    }
    
    private onJoystickPointerUp(event: PointerEvent) {
        if (event.pointerId === this.joystickTouchId) {
            event.preventDefault();
            event.stopPropagation();
            
            this.joystickTouchId = null;
            this.isJoystickActive = false;
            this.moveInput.set(0, 0);
            this.touches.delete(event.pointerId);
            
            // Release pointer capture
            if (this.joystickElement) {
                this.joystickElement.releasePointerCapture(event.pointerId);
            }
        }
    }
    
    // Mouse event handlers for PC debugging (fallback)
    private onMouseDown(event: MouseEvent) {
        const rect = this.canvas.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const y = event.clientY - rect.top;
        
        // Check if mouse is in joystick area
        if (this.isInJoystickArea(x, y)) {
            this.mouseDown = true;
            this.mouseId = -1; // Use -1 as mouse identifier
            this.joystickTouchId = this.mouseId;
            this.isJoystickActive = true;
            this.touches.set(this.mouseId, {
                startX: x,
                startY: y,
                currentX: x,
                currentY: y,
                startTime: Date.now()
            });
        }
    }
    
    private onMouseMove(event: MouseEvent) {
        if (this.mouseDown && this.mouseId === this.joystickTouchId) {
            const rect = this.canvas.getBoundingClientRect();
            const touchData = this.touches.get(this.mouseId);
            if (touchData) {
                touchData.currentX = event.clientX - rect.left;
                touchData.currentY = event.clientY - rect.top;
                this.updateInputs();
            }
        }
    }
    
    private onMouseUp(_event: MouseEvent) {
        if (this.mouseDown && this.mouseId === this.joystickTouchId) {
            this.mouseDown = false;
            this.joystickTouchId = null;
            this.isJoystickActive = false;
            this.moveInput.set(0, 0);
            this.touches.delete(this.mouseId);
        }
    }
    
    public reset() {
        this.moveInput.set(0, 0);
        this.lookInput.set(0, 0);
        this.isJoystickActive = false;
        this.joystickTouchId = null;
        this.lookTouchId = null;
        this.touches.clear();
        this.mouseDown = false;
        this.totalTouchCount = 0;
    }
    
    public setJoystickEnabled(enabled: boolean) {
        this.joystickEnabled = enabled;
        if (!enabled) {
            // Reset joystick input when disabled
            this.moveInput.set(0, 0);
            this.isJoystickActive = false;
            this.joystickTouchId = null;
        }
    }
    
    public setLookEnabled(enabled: boolean) {
        this.lookEnabled = enabled;
        if (!enabled) {
            // Reset look input when disabled
            this.lookInput.set(0, 0);
            this.lookTouchId = null;
        }
    }
    
    public isJoystickEnabled(): boolean {
        return this.joystickEnabled;
    }
    
    public isLookEnabled(): boolean {
        return this.lookEnabled;
    }
}

export { MobileFlyInput };
