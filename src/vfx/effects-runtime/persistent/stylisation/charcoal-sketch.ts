import {
    ADDRESS_CLAMP_TO_EDGE,
    Color,
    FILTER_LINEAR,
    PostEffect,
    RenderTarget,
    SEMANTIC_POSITION,
    Shader,
    Texture,
    type AppBase,
    type CameraComponent,
    type CameraFrame,
    type GraphicsDevice
} from 'playcanvas';

import {
    CHARCOAL_SKETCH_MAIN_FRAGMENT_GLSL,
    CHARCOAL_SKETCH_VERTEX_GLSL
} from './charcoal-sketch-shaders';

/** 设为 true 可输出挂载/清屏/reveal 生命周期日志（默认关闭）。 */
const CHARCOAL_SKETCH_DEBUG = false;

const debugLog = (...args: unknown[]): void => {
    if (CHARCOAL_SKETCH_DEBUG) {
        console.log('[charcoal-sketch]', ...args);
    }
};

export type CharcoalSketchSettings = {
    enabled: boolean;
    outline: number;
    hatching: number;
    contrast: number;
    stroke: number;
    smudge: number;
    focus: number;
    paper: number;
    paperColor: [number, number, number];
};

export type CharcoalSketchApplyOptions = {
    getCameraFrame?: () => CameraFrame | null | undefined;
};

/** 与参考 demo 控制面板默认值一致 */
export const DEFAULT_CHARCOAL_SKETCH_SETTINGS: CharcoalSketchSettings = {
    enabled: false,
    outline: 1.25,
    hatching: 0.7,
    contrast: 1.5,
    stroke: 1.2,
    smudge: 0.4,
    focus: 1.0,
    paper: 0.5,
    paperColor: [0.965, 0.955, 0.925]
};

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const finiteOr = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;
const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

const colorsRoughlyEqual = (a: Color, b: Color): boolean =>
    Math.abs(a.r - b.r) < 1e-4 &&
    Math.abs(a.g - b.g) < 1e-4 &&
    Math.abs(a.b - b.b) < 1e-4 &&
    Math.abs(a.a - b.a) < 1e-4;

const normalizeColor = (
    v: unknown,
    fallback: [number, number, number]
): [number, number, number] => {
    if (!Array.isArray(v) || v.length < 3) {
        return [...fallback];
    }
    return [
        clamp01(finiteOr(v[0], fallback[0])),
        clamp01(finiteOr(v[1], fallback[1])),
        clamp01(finiteOr(v[2], fallback[2]))
    ];
};

export function charcoalPaperClearColor(raw: unknown): Color {
    const [r, g, b] = normalizeCharcoalSketchSettings(raw).paperColor;
    return new Color(r, g, b, 1);
}

export function normalizeCharcoalSketchSettings(raw: unknown): CharcoalSketchSettings {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        enabled: !!obj.enabled,
        outline: clamp(finiteOr(obj.outline, DEFAULT_CHARCOAL_SKETCH_SETTINGS.outline), 0.4, 2.0),
        hatching: clamp(finiteOr(obj.hatching, DEFAULT_CHARCOAL_SKETCH_SETTINGS.hatching), 0, 1.5),
        contrast: clamp(finiteOr(obj.contrast, DEFAULT_CHARCOAL_SKETCH_SETTINGS.contrast), 0.5, 1.8),
        stroke: clamp(finiteOr(obj.stroke, DEFAULT_CHARCOAL_SKETCH_SETTINGS.stroke), 0.5, 1.8),
        smudge: clamp(finiteOr(obj.smudge, DEFAULT_CHARCOAL_SKETCH_SETTINGS.smudge), 0, 1),
        focus: clamp(finiteOr(obj.focus, DEFAULT_CHARCOAL_SKETCH_SETTINGS.focus), 0.3, 1.5),
        paper: clamp(finiteOr(obj.paper, DEFAULT_CHARCOAL_SKETCH_SETTINGS.paper), 0, 1),
        paperColor: normalizeColor(obj.paperColor, DEFAULT_CHARCOAL_SKETCH_SETTINGS.paperColor)
    };
}

function createFullscreenShader(device: GraphicsDevice, fshader: string, name: string): Shader {
    return new Shader(device, {
        attributes: { aPosition: SEMANTIC_POSITION },
        vshader: CHARCOAL_SKETCH_VERTEX_GLSL,
        fshader,
        name
    });
}

type RenderPassCameraHook = {
    frameUpdate?: () => void;
    composePass?: { sceneTexture?: Texture | null };
};

class CharcoalSketchPostEffect extends PostEffect {
    private readonly mainShader: Shader;
    private settings: CharcoalSketchSettings = DEFAULT_CHARCOAL_SKETCH_SETTINGS;

    constructor(device: GraphicsDevice) {
        super(device);
        this.mainShader = createFullscreenShader(device, CHARCOAL_SKETCH_MAIN_FRAGMENT_GLSL, 'CharcoalSketchShader');
    }

    setSettings(settings: CharcoalSketchSettings): void {
        this.settings = settings;
    }

    destroy(): void {
        // 单 pass，无额外 RT
    }

    render(inputTarget: { colorBuffer: Texture }, outputTarget: RenderTarget | null, rect: unknown): void {
        const device = this.device;
        const scope = device.scope;
        const s = this.settings;

        scope.resolve('uColorBuffer').setValue(inputTarget.colorBuffer);
        scope.resolve('uResolution').setValue([device.width, device.height]);
        scope.resolve('uOutline').setValue(s.outline);
        scope.resolve('uHatching').setValue(s.hatching);
        scope.resolve('uContrast').setValue(s.contrast);
        scope.resolve('uStroke').setValue(s.stroke);
        scope.resolve('uSmudge').setValue(s.smudge);
        scope.resolve('uFocus').setValue(s.focus);
        scope.resolve('uPaper').setValue(s.paper);
        scope.resolve('uPaperColor').setValue(s.paperColor);

        this.drawQuad(outputTarget, this.mainShader, rect as any);
    }
}

class CharcoalSketchCameraFrameBridge {
    private readonly effect: CharcoalSketchPostEffect;
    private outputTarget: RenderTarget | null = null;
    private hookedRenderPassCamera: RenderPassCameraHook | null = null;
    private originalFrameUpdate: (() => void) | null = null;
    private active = false;

    constructor(effect: CharcoalSketchPostEffect) {
        this.effect = effect;
    }

    mount(cameraFrame: CameraFrame): boolean {
        const renderPassCamera = (cameraFrame as unknown as { renderPassCamera?: RenderPassCameraHook })
            .renderPassCamera;

        if (!renderPassCamera?.composePass) {
            return false;
        }

        if (this.hookedRenderPassCamera !== renderPassCamera) {
            this.unhook();
            this.hookedRenderPassCamera = renderPassCamera;
            this.originalFrameUpdate = renderPassCamera.frameUpdate?.bind(renderPassCamera) ?? null;

            const bridge = this;
            renderPassCamera.frameUpdate = function frameUpdate(this: RenderPassCameraHook) {
                bridge.originalFrameUpdate?.call(this);
                if (!bridge.active || !this.composePass?.sceneTexture) {
                    return;
                }
                this.composePass.sceneTexture = bridge.process(this.composePass.sceneTexture);
            };
        }

        this.active = true;
        debugLog('CameraFrame bridge mounted');
        return true;
    }

    setSettings(settings: CharcoalSketchSettings): void {
        this.effect.setSettings(settings);
    }

    unmount(): void {
        this.active = false;
        this.unhook();
        this.destroyOutputTarget();
        debugLog('CameraFrame bridge unmounted');
    }

    isMounted(): boolean {
        return this.active;
    }

    private unhook(): void {
        if (this.hookedRenderPassCamera && this.originalFrameUpdate) {
            this.hookedRenderPassCamera.frameUpdate = this.originalFrameUpdate;
        }
        this.hookedRenderPassCamera = null;
        this.originalFrameUpdate = null;
    }

    private process(sourceTexture: Texture): Texture {
        const outputTarget = this.ensureOutputTarget(sourceTexture);
        this.effect.render({ colorBuffer: sourceTexture }, outputTarget, null);
        return outputTarget.colorBuffer;
    }

    private ensureOutputTarget(sourceTexture: Texture): RenderTarget {
        const device = this.effect.device;
        const { width, height, format } = sourceTexture;
        const current = this.outputTarget;

        if (
            current &&
            current.width === width &&
            current.height === height &&
            current.colorBuffer?.format === format
        ) {
            return current;
        }

        this.destroyOutputTarget();

        const colorBuffer = new Texture(device, {
            name: 'charcoal-sketch-scene',
            width,
            height,
            format,
            mipmaps: false,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });

        this.outputTarget = new RenderTarget({ colorBuffer, depth: false });
        return this.outputTarget;
    }

    private destroyOutputTarget(): void {
        if (!this.outputTarget) {
            return;
        }
        this.outputTarget.destroyTextureBuffers();
        this.outputTarget.destroy();
        this.outputTarget = null;
    }
}

/**
 * 木炭画后处理控制器。
 *
 * 生命周期要点：
 * - `apply`：挂载 CameraFrame bridge 或 legacy postEffects，并设置纸色清屏；
 * - `suspendForReveal`：阻塞型 reveal 期间卸后处理，清屏交给 viewer；
 * - `unmountAll`：禁用/销毁时卸后处理并尽量恢复清屏色；
 * - `scheduleDeferredSync`：处理 CameraFrame 与 configureCamera 的首帧竞态。
 */
export class CharcoalSketchController {
    private readonly app: AppBase;
    private readonly camera: CameraComponent;
    private readonly effect: CharcoalSketchPostEffect;
    private readonly cameraFrameBridge: CharcoalSketchCameraFrameBridge;
    private legacyMounted = false;
    private originalClearColor: Color | null = null;
    private revealSuspended = false;
    private deferredSyncGeneration = 0;
    private lastApplySettings: unknown = null;
    private lastApplyOptions: CharcoalSketchApplyOptions | undefined;

    constructor(app: AppBase, camera: CameraComponent) {
        this.app = app;
        this.camera = camera;
        this.effect = new CharcoalSketchPostEffect(app.graphicsDevice);
        this.cameraFrameBridge = new CharcoalSketchCameraFrameBridge(this.effect);
    }

    apply(rawSettings: unknown, options?: CharcoalSketchApplyOptions): void {
        const settings = normalizeCharcoalSketchSettings(rawSettings);
        this.lastApplySettings = rawSettings;
        this.lastApplyOptions = options;
        this.effect.setSettings(settings);
        this.cameraFrameBridge.setSettings(settings);

        if (!settings.enabled) {
            this.revealSuspended = false;
            this.unmountAll();
            return;
        }

        if (this.revealSuspended) {
            debugLog('apply skipped: reveal suspended');
            return;
        }

        this.mountActivePostEffect(options);
        this.applyPaperClearColor(settings);
        this.app.renderNextFrame = true;
        this.scheduleDeferredSync();
    }

    /** 阻塞型 reveal 播放期间暂停后处理；清屏由 viewer.configureCamera(deferred) 恢复。 */
    suspendForReveal(): void {
        if (this.revealSuspended) {
            return;
        }
        this.revealSuspended = true;
        this.cancelDeferredSync();
        this.cameraFrameBridge.unmount();
        this.unmountLegacy();
        this.discardClearColorOverride();
        this.app.renderNextFrame = true;
        debugLog('suspended for reveal');
    }

    resumeFromReveal(): void {
        this.revealSuspended = false;
        debugLog('resumed after reveal');
    }

    destroy(): void {
        this.unmountAll();
        this.effect.destroy();
    }

    // --- 后处理挂载 ---

    private mountActivePostEffect(options?: CharcoalSketchApplyOptions): void {
        const cameraFrame = options?.getCameraFrame?.();
        if (cameraFrame?.enabled && this.cameraFrameBridge.mount(cameraFrame)) {
            this.unmountLegacy();
            return;
        }
        this.cameraFrameBridge.unmount();
        this.mountLegacy();
    }

    private mountLegacy(): void {
        if (!this.camera.postEffects) {
            console.warn('[charcoal-sketch] camera postEffects unavailable');
            return;
        }
        if (!this.legacyMounted) {
            this.camera.postEffects.addEffect(this.effect);
            this.legacyMounted = true;
            debugLog('legacy postEffects mounted');
        }
    }

    private unmountLegacy(): void {
        if (!this.camera.postEffects || !this.legacyMounted) {
            return;
        }
        this.camera.postEffects.removeEffect(this.effect);
        this.legacyMounted = false;
        debugLog('legacy postEffects unmounted');
    }

    private unmountAll(): void {
        this.cancelDeferredSync();
        this.cameraFrameBridge.unmount();
        this.unmountLegacy();
        this.restoreClearColor();
        this.app.renderNextFrame = true;
    }

    // --- 纸色清屏（与 viewer.configureCamera 协同） ---

    private applyPaperClearColor(settings?: CharcoalSketchSettings): void {
        if (this.revealSuspended) {
            return;
        }
        const resolved = settings ?? normalizeCharcoalSketchSettings(this.lastApplySettings);
        if (!resolved.enabled) {
            return;
        }
        const paper = charcoalPaperClearColor(resolved);
        // configureCamera 可能已先写入纸色，避免把纸色误存为「原始清屏色」。
        if (!this.originalClearColor && !colorsRoughlyEqual(this.camera.clearColor, paper)) {
            this.originalClearColor = this.camera.clearColor.clone();
        }
        this.camera.clearColorBuffer = true;
        this.camera.clearColor = paper;
    }

    private discardClearColorOverride(): void {
        this.originalClearColor = null;
    }

    private restoreClearColor(): void {
        if (!this.originalClearColor) {
            return;
        }
        this.camera.clearColor = this.originalClearColor.clone();
        this.originalClearColor = null;
    }

    // --- CameraFrame 首帧竞态 ---

    private cancelDeferredSync(): void {
        this.deferredSyncGeneration++;
    }

    /** CameraFrame 就绪与 configureCamera 清屏竞态：首帧 frameend 重挂 bridge 并恢复纸色。 */
    private scheduleDeferredSync(): void {
        if (this.revealSuspended) {
            return;
        }
        const generation = ++this.deferredSyncGeneration;
        this.app.once('frameend', () => {
            if (generation !== this.deferredSyncGeneration) {
                return;
            }
            const settings = normalizeCharcoalSketchSettings(this.lastApplySettings);
            if (!settings.enabled || this.revealSuspended) {
                return;
            }
            const cameraFrame = this.lastApplyOptions?.getCameraFrame?.();
            if (cameraFrame?.enabled && !this.cameraFrameBridge.isMounted()) {
                if (this.cameraFrameBridge.mount(cameraFrame)) {
                    this.unmountLegacy();
                }
            }
            this.applyPaperClearColor(settings);
            this.app.renderNextFrame = true;
        });
    }
}
