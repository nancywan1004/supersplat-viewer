import {
    CameraFrame,
    ShaderChunks,
    Texture,
    PIXELFORMAT_R8,
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR,
    Vec3
} from 'playcanvas';
import type { PostEffectSettings } from '../settings';
import type { Global } from '../types';
import { BloomBrushPainter } from './bloom-brush-painter';
import { Picker } from '../picker';
import { WorldSpaceBloomData } from './world-space-bloom-data';
import { BloomBrushFilter, MAX_POINTS } from './bloom-brush-filter';

const MASK_SIZE = 512;

/**
 * Bloom mode enumeration
 */
export enum BloomMode {
    ScreenSpace = 'screen',
    WorldSpace = 'world'
}

const composeBloomPSGlsl = `
#ifdef BLOOM
uniform sampler2D bloomTexture;
uniform float bloomIntensity;
uniform sampler2D bloomMaskTexture;
uniform float bloomThreshold;
vec3 dBloom;
vec3 applyBloom(vec3 color, vec2 uv) {
    dBloom = texture2DLod(bloomTexture, uv, 0.0).rgb;
    float mask = texture2DLod(bloomMaskTexture, uv, 0.0).r;
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float brightPass = step(bloomThreshold, lum);
    return color + dBloom * bloomIntensity * mask * brightPass;
}
#endif
`;

const composeBloomPSWgsl = `
#ifdef BLOOM
var bloomTexture: texture_2d<f32>;
var bloomTextureSampler: sampler;
var bloomMaskTexture: texture_2d<f32>;
var bloomMaskTextureSampler: sampler;
uniform bloomIntensity: f32;
uniform bloomThreshold: f32;
var<private> dBloom: vec3f;
fn applyBloom(color: vec3f, uv: vec2f) -> vec3f {
    dBloom = textureSampleLevel(bloomTexture, bloomTextureSampler, uv, 0.0).rgb;
    let mask = textureSampleLevel(bloomMaskTexture, bloomMaskTextureSampler, uv, 0.0).r;
    let lum = dot(color, vec3f(0.2126, 0.7152, 0.0722));
    let brightPass = select(0.0, 1.0, lum >= uniform.bloomThreshold);
    return color + dBloom * uniform.bloomIntensity * mask * brightPass;
}
#endif
`;

export interface BloomControllerOptions {
    /** 用于每帧把 bloom mask 写入 scope；在 viewer 有 cameraFrame 时由 controller 调用 */
    getCameraFrame: () => CameraFrame | null;
    /** 用于 BloomBrushPainter 与坐标映射 */
    getAppCanvas: () => HTMLCanvasElement | null;
    /** 用于 Night Mode + Bloom Brush 合成时传入 mask */
    getNightModeScript: () => { setBloomBrushParams(active: boolean, mask: Texture | null, threshold: number, modelViewProj?: Float32Array): void } | null;
}

/**
 * 统一管理所有 Bloom 相关逻辑，避免在 gsplat 实体上挂载 BloomDebugFilter/BloomBrushFilter，
 * 防止覆盖 reveal 的 gsplatCustomizeVS 导致进入 viewer 时 reveal 动画消失。
 * - Bloom 强度/模糊/Threshold：通过 CameraFrame 与 compose 阶段 scope 控制。
 * - Bloom Brush：仅使用 mask 纹理在 compose 阶段乘 bloom，不修改 gsplat shader。
 * - Bloom Debug（仅亮部参与绘制）：不在此处实现，避免与 reveal 争用同一材质 chunk。
 */
export class BloomController {
    private global: Global;
    private options: BloomControllerOptions;
    private bloomBrushWhiteTexture: Texture | null = null;
    private bloomCommittedMaskTexture: Texture | null = null;
    private hasCommittedBloomMask = false;
    private bloomBrushPainter: BloomBrushPainter | null = null;
    private _cameraFrameUpdateWrapped = false;
    private _unregisterFrameUpdate: (() => void) | null = null;
    private _unregisterEvents: (() => void)[] = [];
    private picker: Picker | null = null;
    private worldSpaceData: WorldSpaceBloomData = new WorldSpaceBloomData();
    /** Always World Space (Screen Space removed per product decision) */
    private mode: BloomMode = BloomMode.WorldSpace;
    private isDrawing: boolean = false;
    private boundPointerDown: ((e: PointerEvent) => void) | null = null;
    private boundPointerMove: ((e: PointerEvent) => void) | null = null;
    private boundPointerUp: ((e: PointerEvent) => void) | null = null;
    private bloomBrushFilter: BloomBrushFilter | null = null;
    /** Last known camera position for detecting camera movement */
    private lastCameraPosition: Vec3 = new Vec3();
    /** Last known camera forward direction for detecting camera rotation */
    private lastCameraForward: Vec3 = new Vec3();
    /** Whether camera tracking has been initialized */
    private cameraTrackingInitialized = false;
    /** Canvas for rendering world space bloom points projected to screen space */
    private worldSpaceMaskCanvas: HTMLCanvasElement | null = null;
    private worldSpaceMaskCtx: CanvasRenderingContext2D | null = null;
    /** GPU texture for world space projected mask */
    private worldSpaceMaskTexture: Texture | null = null;
    /** Whether the world space mask has valid content */
    private hasWorldSpaceMask = false;
    /** Whether the world space mask was manually painted during active drawing */
    private worldSpaceMaskDirtyFromDrawing = false;

    constructor(global: Global, options: BloomControllerOptions) {
        this.global = global;
        this.options = options;
        const { app } = global;
        const graphicsDevice = app.graphicsDevice;
        if (!graphicsDevice) return;

        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        glsl.set('composeBloomPS', composeBloomPSGlsl);
        wgsl.set('composeBloomPS', composeBloomPSWgsl);

        const whiteCanvas = document.createElement('canvas');
        whiteCanvas.width = 1;
        whiteCanvas.height = 1;
        const whiteCtx = whiteCanvas.getContext('2d')!;
        whiteCtx.fillStyle = '#ffffff';
        whiteCtx.fillRect(0, 0, 1, 1);
        this.bloomBrushWhiteTexture = new Texture(graphicsDevice, {
            name: 'bloomBrushWhite',
            width: 1,
            height: 1,
            format: PIXELFORMAT_R8,
            mipmaps: false
        });
        this.bloomBrushWhiteTexture.setSource(whiteCanvas);
        this.bloomBrushWhiteTexture.upload();

        const appCanvas = options.getAppCanvas();
        if (appCanvas) {
            this.bloomBrushPainter = new BloomBrushPainter({
                device: graphicsDevice,
                appCanvas
            });
            this.bloomCommittedMaskTexture = new Texture(graphicsDevice, {
                name: 'bloomCommittedMask',
                width: MASK_SIZE,
                height: MASK_SIZE,
                format: PIXELFORMAT_R8,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                mipmaps: false
            });
            const blackCanvas = document.createElement('canvas');
            blackCanvas.width = MASK_SIZE;
            blackCanvas.height = MASK_SIZE;
            const blackCtx = blackCanvas.getContext('2d')!;
            blackCtx.fillStyle = '#000000';
            blackCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
            this.bloomCommittedMaskTexture.setSource(blackCanvas);
            this.bloomCommittedMaskTexture.upload();
        }

        // World space mask: a 2D canvas + texture for projecting 3D bloom points to screen
        this.worldSpaceMaskCanvas = document.createElement('canvas');
        this.worldSpaceMaskCanvas.width = MASK_SIZE;
        this.worldSpaceMaskCanvas.height = MASK_SIZE;
        this.worldSpaceMaskCtx = this.worldSpaceMaskCanvas.getContext('2d');
        this.worldSpaceMaskTexture = new Texture(graphicsDevice, {
            name: 'worldSpaceBloomMask',
            width: MASK_SIZE,
            height: MASK_SIZE,
            format: PIXELFORMAT_R8,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            mipmaps: false
        });

        // PlayCanvas fires 'frameupdate' (lowercase) before update(dt); camera is updated inside update(dt).
        // So we must regenerate world-space mask in 'framerender' (after camera update), not in frameupdate.
        const onFrameUpdate = () => {
            const cameraFrame = options.getCameraFrame();
            if (!cameraFrame || !global.settings.postEffectSettings?.bloom?.enabled) return;
            const bloom = global.settings.postEffectSettings.bloom as { bloomBrush?: boolean; threshold?: number };
            this.updateShaderUniforms();
            // World space mask is set in onFrameRender (after camera update)
        };
        const onFrameRender = () => {
            const bloom = global.settings.postEffectSettings?.bloom as { enabled?: boolean; bloomBrush?: boolean; threshold?: number } | undefined;
            if (!bloom?.enabled) return;
            // After update(dt), camera is current; project 3D points to screen and set mask for this frame.
            this.renderWorldSpaceMask();
            const maskTex = this.getEffectiveMaskTexture(!!bloom.bloomBrush);
            try {
                if (maskTex) graphicsDevice.scope.resolve('bloomMaskTexture').setValue(maskTex);
                const th = Math.max(0, Math.min(5, Number(bloom.threshold ?? 0.2)));
                graphicsDevice.scope.resolve('bloomThreshold').setValue(th);
            } catch (_) {}
        };
        app.on('frameupdate', onFrameUpdate);
        app.on('framerender', onFrameRender);
        this._unregisterFrameUpdate = () => {
            app.off('frameupdate', onFrameUpdate);
            app.off('framerender', onFrameRender);
        };

        const { events } = global;
        events.on('bloomBrush:clear', () => {
            this.worldSpaceData.clear();
            if (this.isDrawing) this.worldSpaceMaskDirtyFromDrawing = false;
            (this.global.app as any).renderNextFrame = true;
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:clear'));

        events.on('bloomBrush:reset', () => {
            this.worldSpaceData.reset();
            if (this.worldSpaceMaskCtx && this.worldSpaceMaskCanvas && this.worldSpaceMaskTexture) {
                this.worldSpaceMaskCtx.fillStyle = '#000000';
                this.worldSpaceMaskCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
                this.worldSpaceMaskTexture.setSource(this.worldSpaceMaskCanvas);
                this.worldSpaceMaskTexture.upload();
            }
            this.worldSpaceMaskDirtyFromDrawing = false;
            this.saveWorldSpaceConfig();
            (this.global.app as any).renderNextFrame = true;
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:reset'));

        events.on('bloomBrush:set', () => {
            this.worldSpaceData.commit();
            this.saveWorldSpaceConfig();
            (this.global.app as any).renderNextFrame = true;
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:set'));

        // Setup pointer event handlers for world space bloom
        this.boundPointerDown = this.handlePointerDown.bind(this);
        this.boundPointerMove = this.handlePointerMove.bind(this);
        this.boundPointerUp = this.handlePointerUp.bind(this);

        // Load saved world space config from settings (backward compatible: defaults to 'screen')
        this.loadWorldSpaceConfig();

        // If loaded mode is world space, register pointer event listeners
        const captureOpts: AddEventListenerOptions = { capture: true };
        if (this.boundPointerDown) document.addEventListener('pointerdown', this.boundPointerDown, captureOpts);
        if (this.boundPointerMove) document.addEventListener('pointermove', this.boundPointerMove, captureOpts);
        if (this.boundPointerUp) document.addEventListener('pointerup', this.boundPointerUp, captureOpts);
    }

    /**
     * 对 CameraFrame 应用 bloom 参数（intensity、blurLevel、debug），并注入 update 前设置 mask。
     */
    applyToCameraFrame(cameraFrame: CameraFrame, settings: PostEffectSettings): void {
        const { bloom } = cameraFrame;
        const bloomSettings = settings.bloom as {
            enabled?: boolean;
            intensity?: number;
            blurLevel?: number;
            bloomDebug?: boolean;
            bloomBrush?: boolean;
            bloomBrushSize?: number;
            threshold?: number;
        };
        const bloomDebug = !!bloomSettings.bloomDebug;
        const bloomBrush = !!bloomSettings.bloomBrush;
        const th = Math.max(0, Math.min(5, Number(bloomSettings.threshold ?? 0.2)));

        if (bloomSettings.enabled) {
            bloom.intensity = Math.max(0, Math.min(0.2, Number(bloomSettings.intensity)));
            bloom.blurLevel = bloomSettings.blurLevel ?? 2;
            cameraFrame.debug = bloomDebug ? 'bloom' : null;
        } else {
            bloom.intensity = 0;
            cameraFrame.debug = null;
        }

        const nightModeScript = this.options.getNightModeScript();
        const nightModeOn = (nightModeScript as any)?.isNightModeEnabled ?? false;
        // Night mode + Bloom：需要跳过 night 的区域 = 有 bloom mask 的区域
        // mask 来源与 compose 阶段一致：世界空间用投影 mask；屏幕空间用 painter/committed mask
        const effectiveMask = this.getEffectiveMaskTexture(bloomBrush);
        const hasEffectiveMask = effectiveMask !== null && effectiveMask !== this.bloomBrushWhiteTexture;
        const bloomMaskActiveForNight = nightModeOn && hasEffectiveMask;
        if (this.bloomBrushPainter) {
            this.bloomBrushPainter.setEnabled(false); // Screen space removed, always World Space
            this.bloomBrushPainter.setBrushSize(Math.max(1, Math.min(200, Number(bloomSettings.bloomBrushSize ?? 30))));
        }
        if (nightModeScript) {
            nightModeScript.setBloomBrushParams(bloomMaskActiveForNight, effectiveMask, th, undefined);
        }

        this.injectBloomMaskBeforeUpdate(cameraFrame);
    }

    private setBloomMaskInScope(): void {
        const graphicsDevice = this.global.app.graphicsDevice;
        const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrush?: boolean; threshold?: number } | undefined;
        const maskTex = this.getEffectiveMaskTexture(!!bloom?.bloomBrush);
        try {
            if (maskTex) graphicsDevice.scope.resolve('bloomMaskTexture').setValue(maskTex);
            const th = Math.max(0, Math.min(5, Number(bloom?.threshold ?? 0.2)));
            graphicsDevice.scope.resolve('bloomThreshold').setValue(th);
        } catch (_) {}
    }

    private injectBloomMaskBeforeUpdate(cameraFrame: CameraFrame): void {
        const setBloomMask = () => this.setBloomMaskInScope();
        if (!this._cameraFrameUpdateWrapped) {
            this._cameraFrameUpdateWrapped = true;
            const orig = cameraFrame.update.bind(cameraFrame);
            cameraFrame.update = () => {
                setBloomMask();
                orig();
            };
        } else {
            setBloomMask();
        }
    }

    /** 当 CameraFrame 被销毁时调用，重置包装状态 */
    onCameraFrameDestroyed(): void {
        this._cameraFrameUpdateWrapped = false;
    }

    /**
     * Initialize picker for world-space coordinate conversion
     * @private
     */
    private initPicker(): void {
        if (!this.picker) {
            this.picker = new Picker(this.global.app, this.global.camera);
        }
    }

    /**
     * Convert screen coordinates to world coordinates using ray casting
     * @param screenX Screen X coordinate in pixels
     * @param screenY Screen Y coordinate in pixels
     * @returns World position Vec3 or null if invalid depth
     * @private
     */
    private async screenToWorld(screenX: number, screenY: number): Promise<Vec3 | null> {
        if (!this.picker) {
            this.initPicker();
        }

        // Normalize pixel coordinates to [0, 1]
        const canvas = this.global.app.graphicsDevice.canvas;
        const normalizedX = screenX / canvas.offsetWidth;
        const normalizedY = screenY / canvas.offsetHeight;

        try {
            const worldPos = await this.picker!.pick(normalizedX, normalizedY);
            return worldPos;
        } catch (error) {
            console.warn('Picker failed:', error);
            return null;
        }
    }

    /**
     * Check if event target is an interactive UI element
     * @private
     */
    private isInteractiveTarget(target: EventTarget | null): boolean {
        if (!target || !(target instanceof Node)) return false;
        const el = target as HTMLElement;
        const tag = el.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'a') return true;
        if (el.closest?.('input, button, select, textarea, a[href], [role="slider"], [contenteditable="true"]')) return true;
        if (el.closest?.('.postEffectSliderWrap, .postEffectOption')) return true;
        return false;
    }

    /**
     * Paint directly on the world space mask canvas using screen coordinates.
     * Provides immediate visual feedback during drawing, matching screen space behavior.
     * @private
     */
    private paintOnWorldSpaceMask(clientX: number, clientY: number): void {
        const ctx = this.worldSpaceMaskCtx;
        const tex = this.worldSpaceMaskTexture;
        if (!ctx || !tex) return;

        const appCanvas = this.global.app.graphicsDevice.canvas;
        const rect = appCanvas.getBoundingClientRect();

        // Convert client coords to normalized [0,1]
        const px = (clientX - rect.left) / rect.width;
        const py = (clientY - rect.top) / rect.height;

        // Convert to mask canvas coords with Y flip (matching BloomBrushPainter convention)
        const mx = px * MASK_SIZE;
        const my = (1 - py) * MASK_SIZE;

        // Get brush size from settings and scale to mask pixels
        const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrushSize?: number } | undefined;
        const brushSize = bloom?.bloomBrushSize ?? 30;
        const scale = MASK_SIZE / rect.width;
        const radius = brushSize * scale;

        // Draw white circle
        ctx.fillStyle = '#ffffff';
        ctx.beginPath();
        ctx.arc(mx, my, radius, 0, Math.PI * 2);
        ctx.fill();

        // Upload immediately
        tex.setSource(this.worldSpaceMaskCanvas!);
        tex.upload();
        this.hasWorldSpaceMask = true;
        this.worldSpaceMaskDirtyFromDrawing = true;

        (this.global.app as any).renderNextFrame = true;
    }

    /**
     * Check if pointer coordinates are inside the app canvas bounds
     * @private
     */
    private isInsideCanvas(clientX: number, clientY: number): boolean {
        const canvas = this.global.app.graphicsDevice.canvas;
        const rect = canvas.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    /**
     * Check if bloom brush is currently enabled in settings.
     * World space pointer handlers only intercept events when this returns true.
     * When bloomBrush is OFF, events pass through to camera orbit controller.
     * @private
     */
    private isBloomBrushEnabled(): boolean {
        const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrush?: boolean } | undefined;
        return !!bloom?.bloomBrush;
    }

    /**
     * Handle pointer down event
     * Routes to appropriate handler based on current mode
     * @private
     */
    private handlePointerDown(e: PointerEvent): void {
        if (!this.isBloomBrushEnabled()) return;

        // Skip if clicking on interactive UI elements
        if (this.isInteractiveTarget(e.target)) return;
        if (e.button !== 0) return; // Only handle left click
        if (!this.isInsideCanvas(e.clientX, e.clientY)) return;

        // World space mode: immediate visual feedback + async 3D capture
        this.isDrawing = true;
        e.preventDefault();
        e.stopPropagation();

        // 1) Immediate visual feedback: paint directly on mask canvas
        this.paintOnWorldSpaceMask(e.clientX, e.clientY);

        // 2) Async: get 3D world position for persistence
        const canvas = this.global.app.graphicsDevice.canvas;
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        this.screenToWorld(screenX, screenY).then(worldPos => {
            if (worldPos) {
                const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrushSize?: number } | undefined;
                const brushSize = bloom?.bloomBrushSize ?? 30;
                const cameraPos = this.global.camera.getPosition();
                const distance = worldPos.distance(cameraPos);
                const sceneCam = (this.global.camera as { camera?: { camera?: { fov?: number } } }).camera?.camera;
                const fovDeg = sceneCam?.fov ?? 60;
                const fovRad = (fovDeg * Math.PI) / 180;
                const canvasHeight = canvas.clientHeight || canvas.height;
                if (canvasHeight > 0 && distance > 0.001) {
                    const worldRadius = (brushSize * 2 * distance * Math.tan(fovRad / 2)) / canvasHeight;
                    this.worldSpaceData.addPoint(worldPos, worldRadius, 1.0);
                }
            }
        });
    }

    /**
     * Handle pointer move event
     * Only processes movement when actively drawing (isDrawing=true, set by handlePointerDown)
     * @private
     */
    private handlePointerMove(e: PointerEvent): void {
        if (!this.isDrawing) return;

        // Skip if moving over interactive UI elements
        if (this.isInteractiveTarget(e.target)) {
            this.isDrawing = false;
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        // Immediate visual feedback: paint directly on mask canvas
        this.paintOnWorldSpaceMask(e.clientX, e.clientY);

        // Async: get 3D world position for persistence
        const canvas = this.global.app.graphicsDevice.canvas;
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        this.screenToWorld(screenX, screenY).then(worldPos => {
            if (worldPos) {
                const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrushSize?: number } | undefined;
                const brushSize = bloom?.bloomBrushSize ?? 30;
                const cameraPos = this.global.camera.getPosition();
                const distance = worldPos.distance(cameraPos);
                const sceneCam = (this.global.camera as { camera?: { camera?: { fov?: number } } }).camera?.camera;
                const fovDeg = sceneCam?.fov ?? 60;
                const fovRad = (fovDeg * Math.PI) / 180;
                const canvasHeight = canvas.clientHeight || canvas.height;
                if (canvasHeight > 0 && distance > 0.001) {
                    const worldRadius = (brushSize * 2 * distance * Math.tan(fovRad / 2)) / canvasHeight;
                    this.worldSpaceData.addPoint(worldPos, worldRadius, 1.0);
                }
            }
        });
    }

    /**
     * Handle pointer up event
     * Only processes when actively drawing (isDrawing=true)
     * @private
     */
    private handlePointerUp(e: PointerEvent): void {
        if (e.button !== 0) return;
        if (!this.isDrawing) return;

        this.isDrawing = false;
        e.preventDefault();
        e.stopPropagation();
        // Reset flag so renderWorldSpaceMask() can regenerate from 3D data
        // on the next frame (merging async Picker results with drawn strokes)
        this.worldSpaceMaskDirtyFromDrawing = false;
        (this.global.app as any).renderNextFrame = true;
    }

    /** No-op: Screen Space removed, always World Space. Kept for API compat. */
    setMode(_newMode: BloomMode): void {}

    /**
     * Get current bloom mode
     * @returns Current bloom mode
     */
    getMode(): BloomMode {
        return this.mode;
    }

    /**
     * Save world space bloom data to settings for persistence
     * @private
     */
    private saveWorldSpaceConfig(): void {
        const bloom = this.global.settings?.postEffectSettings?.bloom;
        if (!bloom) return;
        (bloom as any).bloomMode = 'world';
        (bloom as any).worldSpacePoints = this.worldSpaceData.toJSON();
    }

    /**
     * Load world space bloom data from settings
     * @private
     */
    private loadWorldSpaceConfig(): void {
        const bloom = this.global.settings?.postEffectSettings?.bloom as { worldSpacePoints?: any } | undefined;
        if (!bloom?.worldSpacePoints) return;
        this.worldSpaceData.fromJSON(bloom.worldSpacePoints);
    }

    /**
     * Render world space bloom points projected to screen space into a 2D mask texture.
     * This mask is used by the compose shader to limit bloom to world space regions.
     * Called every frame when in world space mode with active bloom points.
     * @private
     */
    private renderWorldSpaceMask(): void {
        const ctx = this.worldSpaceMaskCtx;
        const canvas = this.worldSpaceMaskCanvas;
        const tex = this.worldSpaceMaskTexture;
        if (!ctx || !canvas || !tex) {
            this.hasWorldSpaceMask = false;
            return;
        }

        // While user is actively drawing, the mask canvas has real-time brush strokes
        // from paintOnWorldSpaceMask(). Don't overwrite them — just skip regeneration.
        if (this.isDrawing && this.worldSpaceMaskDirtyFromDrawing) {
            return;
        }

        // Clear to black (no bloom) — matches screen space behavior where
        // bloom brush starts with an empty (black) mask
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);

        const allPoints = this.worldSpaceData.getAllPoints();
        if (allPoints.length === 0) {
            // No bloom points → upload black mask (no bloom anywhere)
            tex.setSource(canvas);
            tex.upload();
            this.hasWorldSpaceMask = true;
            return;
        }

        const camera = this.global.camera;
        if (!camera?.camera) {
            tex.setSource(canvas);
            tex.upload();
            this.hasWorldSpaceMask = true;
            return;
        }

        const appCanvas = this.global.app.graphicsDevice.canvas;
        const canvasWidth = appCanvas.clientWidth || appCanvas.width;
        const canvasHeight = appCanvas.clientHeight || appCanvas.height;
        if (canvasWidth === 0 || canvasHeight === 0) {
            tex.setSource(canvas);
            tex.upload();
            this.hasWorldSpaceMask = true;
            return;
        }

        const screenPos = new Vec3();
        // Scene Camera.worldToScreen(worldCoord, cw, ch, screenCoord) - cw/ch required for correct pixel coords.
        // CameraComponent.worldToScreen uses device.clientRect; we use canvasWidth/Height for mask UV consistency.
        const sceneCam = (camera as { camera?: { camera?: { worldToScreen(w: Vec3, cw: number, ch: number, out?: Vec3): Vec3 } } }).camera?.camera;
        if (!sceneCam?.worldToScreen) {
            tex.setSource(canvas);
            tex.upload();
            this.hasWorldSpaceMask = true;
            return;
        }

        ctx.fillStyle = '#ffffff';

        for (const point of allPoints) {
            sceneCam.worldToScreen(point.position, canvasWidth, canvasHeight, screenPos);

            // Skip if behind camera (z < 0)
            if (screenPos.z < 0) continue;

            // screenPos.x/y are in pixel coordinates
            // Convert to mask UV [0, MASK_SIZE] with Y flip
            const maskX = (screenPos.x / canvasWidth) * MASK_SIZE;
            const maskY = (1 - screenPos.y / canvasHeight) * MASK_SIZE;

            // Estimate screen-space radius from world radius
            // Use perspective projection: screenRadius = worldRadius * (focalLength / distance)
            const cameraPos = camera.getPosition();
            const distance = point.position.distance(cameraPos);
            if (distance < 0.001) continue;

            const fovRad = ((sceneCam as { fov?: number }).fov ?? 60) * (Math.PI / 180);
            const pixelsPerUnit = (canvasHeight / 2) / (distance * Math.tan(fovRad / 2));
            const screenRadius = Math.max(2, point.radius * pixelsPerUnit);

            // Convert screen pixel radius to mask texture pixels
            const maskRadius = (screenRadius / canvasWidth) * MASK_SIZE;

            // Draw filled circle
            ctx.beginPath();
            ctx.arc(maskX, maskY, maskRadius, 0, Math.PI * 2);
            ctx.fill();
        }

        // Upload to GPU
        tex.setSource(canvas);
        tex.upload();
        this.hasWorldSpaceMask = true;
    }

    /**
     * Get the effective mask texture for compose stage.
     * - If there are world space points (committed or current): use projected mask so Set bloom regions stay visible even after exiting brush.
     * - Else if Bloom Brush OFF: white = full-screen (global) bloom.
     * - Else: world space mask (black until drawn).
     * @private
     */
    private getEffectiveMaskTexture(bloomBrushOn: boolean): Texture | null {
        const hasWorldPoints = this.worldSpaceData.getAllPoints().length > 0;
        if (hasWorldPoints && this.hasWorldSpaceMask && this.worldSpaceMaskTexture) {
            return this.worldSpaceMaskTexture;
        }
        if (!bloomBrushOn) {
            return this.bloomBrushWhiteTexture;
        }
        return this.worldSpaceMaskTexture;
    }

    /**
     * Check if the camera has moved or rotated since last frame.
     * If so, trigger a re-render so that world space bloom points
     * are displayed correctly from the new viewpoint.
     * @private
     */
    private checkCameraMovement(): void {

        // Only trigger re-render if there are world space bloom points
        const allPoints = this.worldSpaceData.getAllPoints();
        if (allPoints.length === 0) return;

        const camera = this.global.camera;
        if (!camera) return;

        const currentPos = camera.getPosition();
        const currentFwd = camera.forward;

        if (!this.cameraTrackingInitialized) {
            this.lastCameraPosition.copy(currentPos);
            this.lastCameraForward.copy(currentFwd);
            this.cameraTrackingInitialized = true;
            return;
        }

        const EPSILON = 1e-4;
        const posDiff = currentPos.distance(this.lastCameraPosition);
        const fwdDiffX = Math.abs(currentFwd.x - this.lastCameraForward.x);
        const fwdDiffY = Math.abs(currentFwd.y - this.lastCameraForward.y);
        const fwdDiffZ = Math.abs(currentFwd.z - this.lastCameraForward.z);

        if (posDiff > EPSILON || fwdDiffX > EPSILON || fwdDiffY > EPSILON || fwdDiffZ > EPSILON) {
            // Camera has moved or rotated — trigger re-render
            (this.global.app as any).renderNextFrame = true;

            this.lastCameraPosition.copy(currentPos);
            this.lastCameraForward.copy(currentFwd);
        }
    }

    /**
     * Update shader uniforms for world space bloom mode
     * This should be called every frame when in world space mode
     * @private
     */
    private updateShaderUniforms(): void {
        // Check for camera movement and trigger re-render if needed
        this.checkCameraMovement();

        // World space: set mode to 1 and upload bloom points
        if (!this.bloomBrushFilter) {
            // Try to find or create BloomBrushFilter
            const gsplatEntity = this.global.app.root.findByName('gsplat') as any;
            if (gsplatEntity && gsplatEntity.script) {
                this.bloomBrushFilter = gsplatEntity.script.get('bloomBrushFilter') as BloomBrushFilter | null;
                if (!this.bloomBrushFilter) {
                    // Filter not found, we'll try again next frame
                    return;
                }
            } else {
                return;
            }
        }

        // Set bloom mode to world space
        // Note: The shader evaluates bloom purely by world-space distance.
        // Occluded bloom points still affect splats within their radius (Requirement 7.3).
        // This is intentional — bloom regions are fixed in 3D space.
        this.bloomBrushFilter.bloomMode = 1;

        // Get all bloom points
        const allPoints = this.worldSpaceData.getAllPoints();
        
        // Warn and truncate if exceeding MAX_POINTS limit
        if (allPoints.length > MAX_POINTS) {
            console.warn(`Bloom point count (${allPoints.length}) exceeds MAX_POINTS (${MAX_POINTS}). Truncating.`);
        }
        const pointCount = Math.min(allPoints.length, MAX_POINTS);

        // Convert bloom points to Float32Array
        // Format: vec4 per point (xyz=position, w=radius)
        for (let i = 0; i < pointCount; i++) {
            const point = allPoints[i];
            const offset = i * 4;
            this.bloomBrushFilter.bloomPoints[offset + 0] = point.position.x;
            this.bloomBrushFilter.bloomPoints[offset + 1] = point.position.y;
            this.bloomBrushFilter.bloomPoints[offset + 2] = point.position.z;
            this.bloomBrushFilter.bloomPoints[offset + 3] = point.radius;
        }

        // Set point count
        this.bloomBrushFilter.bloomPointCount = pointCount;
    }

    destroy(): void {
        const captureOpts: AddEventListenerOptions = { capture: true };
        if (this.boundPointerDown) document.removeEventListener('pointerdown', this.boundPointerDown, captureOpts);
        if (this.boundPointerMove) document.removeEventListener('pointermove', this.boundPointerMove, captureOpts);
        if (this.boundPointerUp) document.removeEventListener('pointerup', this.boundPointerUp, captureOpts);
        
        this._unregisterFrameUpdate?.();
        this._unregisterFrameUpdate = null;
        this._unregisterEvents.forEach((fn) => fn());
        this._unregisterEvents = [];
        this.bloomBrushPainter = null;
        this.bloomBrushWhiteTexture = null;
        this.bloomCommittedMaskTexture = null;
        if (this.worldSpaceMaskTexture) {
            this.worldSpaceMaskTexture.destroy();
            this.worldSpaceMaskTexture = null;
        }
        this.worldSpaceMaskCanvas = null;
        this.worldSpaceMaskCtx = null;
        if (this.picker) {
            this.picker.release();
            this.picker = null;
        }
    }
}
