import {
    ADDRESS_CLAMP_TO_EDGE,
    Color,
    FILTER_LINEAR,
    PIXELFORMAT_RGBA8,
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
    PEN_SKETCH_ANALYSIS_FRAGMENT_GLSL,
    PEN_SKETCH_MAIN_FRAGMENT_GLSL,
    PEN_SKETCH_ORIENTATION_BLUR_FRAGMENT_GLSL,
    PEN_SKETCH_ORIENTATION_FRAGMENT_GLSL,
    PEN_SKETCH_VERTEX_GLSL
} from './pen-sketch-shaders';

export type PenSketchSettings = {
    enabled: boolean;
    outlineWidth: number;
    edgeStrength: number;
    hatching: number;
    contrast: number;
    toneStrength: number;
    stroke: number;
    focus: number;
    inkHue: number;
    paperColor: [number, number, number];
};

export type PenSketchApplyOptions = {
    getCameraFrame?: () => CameraFrame | null | undefined;
};

/** 与参考 demo 控制面板默认值一致 */
export const DEFAULT_PEN_SKETCH_SETTINGS: PenSketchSettings = {
    enabled: false,
    outlineWidth: 0.6,
    edgeStrength: 0.8,
    hatching: 1.0,
    contrast: 0.9,
    toneStrength: 3.82,
    stroke: 1.55,
    focus: 1.1,
    inkHue: 0,
    paperColor: [0.972, 0.961, 0.925]
};

const ANALYSIS_SCALE = 0.25;
const ANALYSIS_TARGET_COUNT = 5;

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

export function penPaperClearColor(raw: unknown): Color {
    const [r, g, b] = normalizePenSketchSettings(raw).paperColor;
    return new Color(r, g, b, 1);
}

export function normalizePenSketchSettings(raw: unknown): PenSketchSettings {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        enabled: !!obj.enabled,
        outlineWidth: clamp(finiteOr(obj.outlineWidth, DEFAULT_PEN_SKETCH_SETTINGS.outlineWidth), 0, 2.5),
        edgeStrength: clamp(finiteOr(obj.edgeStrength, DEFAULT_PEN_SKETCH_SETTINGS.edgeStrength), 0.05, 1.8),
        hatching: clamp(finiteOr(obj.hatching, DEFAULT_PEN_SKETCH_SETTINGS.hatching), 0, 1.5),
        contrast: clamp(finiteOr(obj.contrast, DEFAULT_PEN_SKETCH_SETTINGS.contrast), 0.5, 1.8),
        toneStrength: clamp(finiteOr(obj.toneStrength, DEFAULT_PEN_SKETCH_SETTINGS.toneStrength), 2, 8),
        stroke: clamp(finiteOr(obj.stroke, DEFAULT_PEN_SKETCH_SETTINGS.stroke), 0.5, 1.8),
        focus: clamp(finiteOr(obj.focus, DEFAULT_PEN_SKETCH_SETTINGS.focus), 0.3, 1.5),
        inkHue: clamp(finiteOr(obj.inkHue, DEFAULT_PEN_SKETCH_SETTINGS.inkHue), -1, 1),
        paperColor: normalizeColor(obj.paperColor, DEFAULT_PEN_SKETCH_SETTINGS.paperColor)
    };
}

function createFullscreenShader(device: GraphicsDevice, fshader: string, name: string): Shader {
    return new Shader(device, {
        attributes: { aPosition: SEMANTIC_POSITION },
        vshader: PEN_SKETCH_VERTEX_GLSL,
        fshader,
        name
    });
}

class PenSketchPostEffect extends PostEffect {
    private readonly analysisShader: Shader;
    private readonly orientationShader: Shader;
    private readonly orientationBlurShader: Shader;
    private readonly mainShader: Shader;
    private settings: PenSketchSettings = DEFAULT_PEN_SKETCH_SETTINGS;
    private viewScale = 1;
    private analysisTargets: RenderTarget[] = [];
    private analysisWidth = 0;
    private analysisHeight = 0;

    constructor(device: GraphicsDevice) {
        super(device);
        this.analysisShader = createFullscreenShader(device, PEN_SKETCH_ANALYSIS_FRAGMENT_GLSL, 'PenStructureAnalysisShader');
        this.orientationShader = createFullscreenShader(device, PEN_SKETCH_ORIENTATION_FRAGMENT_GLSL, 'PenImageOrientationShader');
        this.orientationBlurShader = createFullscreenShader(device, PEN_SKETCH_ORIENTATION_BLUR_FRAGMENT_GLSL, 'PenOrientationFieldBlurShader');
        this.mainShader = createFullscreenShader(device, PEN_SKETCH_MAIN_FRAGMENT_GLSL, 'PenSketchShader');
    }

    setSettings(settings: PenSketchSettings): void {
        this.settings = settings;
    }

    setViewScale(viewScale: number): void {
        this.viewScale = clamp(viewScale, 0.12, 4);
    }

    destroy(): void {
        this.destroyAnalysisTargets();
    }

    private destroyAnalysisTargets(): void {
        for (const target of this.analysisTargets) {
            target.destroyTextureBuffers();
            target.destroy();
        }
        this.analysisTargets = [];
        this.analysisWidth = 0;
        this.analysisHeight = 0;
    }

    private ensureAnalysisTargets(deviceWidth: number, deviceHeight: number): void {
        const w = Math.max(1, Math.floor(deviceWidth * ANALYSIS_SCALE));
        const h = Math.max(1, Math.floor(deviceHeight * ANALYSIS_SCALE));
        if (w === this.analysisWidth && h === this.analysisHeight && this.analysisTargets.length === ANALYSIS_TARGET_COUNT) {
            return;
        }

        this.destroyAnalysisTargets();
        this.analysisWidth = w;
        this.analysisHeight = h;

        for (let i = 0; i < ANALYSIS_TARGET_COUNT; i++) {
            const colorBuffer = new Texture(this.device, {
                name: `Pen structure analysis ${i}`,
                width: w,
                height: h,
                format: PIXELFORMAT_RGBA8,
                mipmaps: false,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
            this.analysisTargets.push(new RenderTarget({
                colorBuffer,
                depth: false
            }));
        }
    }

    render(inputTarget: { colorBuffer: Texture }, outputTarget: RenderTarget | null, rect: unknown): void {
        const device = this.device;
        const scope = device.scope;
        const source = inputTarget.colorBuffer;

        this.ensureAnalysisTargets(device.width, device.height);

        const [t0, t1, t2, t3, t4] = this.analysisTargets;

        scope.resolve('uAnalysisSource').setValue(source);
        scope.resolve('uAnalysisTexel').setValue([1 / source.width, 1 / source.height]);
        scope.resolve('uAnalysisDirection').setValue([1, 0]);
        this.drawQuad(t0, this.analysisShader, null);

        scope.resolve('uAnalysisSource').setValue(t0.colorBuffer);
        scope.resolve('uAnalysisTexel').setValue([1 / this.analysisWidth, 1 / this.analysisHeight]);
        scope.resolve('uAnalysisDirection').setValue([0, 1]);
        this.drawQuad(t1, this.analysisShader, null);

        scope.resolve('uOrientationSource').setValue(t1.colorBuffer);
        scope.resolve('uOrientationTexel').setValue([1 / this.analysisWidth, 1 / this.analysisHeight]);
        this.drawQuad(t2, this.orientationShader, null);

        scope.resolve('uOrientationField').setValue(t2.colorBuffer);
        scope.resolve('uOrientationTexel').setValue([1 / this.analysisWidth, 1 / this.analysisHeight]);
        scope.resolve('uOrientationDirection').setValue([1, 0]);
        this.drawQuad(t3, this.orientationBlurShader, null);

        scope.resolve('uOrientationField').setValue(t3.colorBuffer);
        scope.resolve('uOrientationDirection').setValue([0, 1]);
        this.drawQuad(t4, this.orientationBlurShader, null);

        scope.resolve('uColorBuffer').setValue(source);
        scope.resolve('uSmoothBuffer').setValue(t1.colorBuffer);
        scope.resolve('uOrientationBuffer').setValue(t4.colorBuffer);
        scope.resolve('uResolution').setValue([device.width, device.height]);
        scope.resolve('uSmoothTexel').setValue([1 / this.analysisWidth, 1 / this.analysisHeight]);
        scope.resolve('uOutlineWidth').setValue(this.settings.outlineWidth);
        scope.resolve('uEdgeStrength').setValue(this.settings.edgeStrength);
        scope.resolve('uHatching').setValue(this.settings.hatching);
        scope.resolve('uContrast').setValue(this.settings.contrast);
        scope.resolve('uToneStrength').setValue(this.settings.toneStrength);
        scope.resolve('uStroke').setValue(this.settings.stroke);
        scope.resolve('uFocus').setValue(this.settings.focus);
        scope.resolve('uInkHue').setValue(this.settings.inkHue);
        scope.resolve('uViewScale').setValue(this.viewScale);
        scope.resolve('uPaperColor').setValue(this.settings.paperColor);

        this.drawQuad(outputTarget, this.mainShader, rect as any);
    }
}

class PenSketchCameraFrameBridge {
    private readonly effect: PenSketchPostEffect;
    private outputTarget: RenderTarget | null = null;
    private hookedRenderPassCamera: unknown = null;
    private originalFrameUpdate: (() => void) | null = null;
    private active = false;

    constructor(effect: PenSketchPostEffect) {
        this.effect = effect;
    }

    mount(cameraFrame: CameraFrame): boolean {
        const renderPassCamera = (cameraFrame as unknown as { renderPassCamera?: unknown }).renderPassCamera as {
            frameUpdate?: () => void;
            composePass?: { sceneTexture?: Texture | null };
        } | undefined;

        if (!renderPassCamera?.composePass) {
            return false;
        }

        if (this.hookedRenderPassCamera !== renderPassCamera) {
            this.unhook();
            this.hookedRenderPassCamera = renderPassCamera;
            this.originalFrameUpdate = renderPassCamera.frameUpdate?.bind(renderPassCamera) ?? null;

            const bridge = this;
            renderPassCamera.frameUpdate = function frameUpdate(this: typeof renderPassCamera) {
                bridge.originalFrameUpdate?.call(this);
                if (!bridge.active || !this.composePass?.sceneTexture) {
                    return;
                }
                this.composePass.sceneTexture = bridge.process(this.composePass.sceneTexture);
            };
        }

        this.active = true;
        return true;
    }

    setSettings(settings: PenSketchSettings): void {
        this.effect.setSettings(settings);
    }

    setViewScale(viewScale: number): void {
        this.effect.setViewScale(viewScale);
    }

    unmount(): void {
        this.active = false;
        this.unhook();
        this.destroyOutputTarget();
    }

    private unhook(): void {
        const renderPassCamera = this.hookedRenderPassCamera as { frameUpdate?: () => void } | null;
        if (renderPassCamera && this.originalFrameUpdate) {
            renderPassCamera.frameUpdate = this.originalFrameUpdate;
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
            name: 'pen-sketch-scene',
            width,
            height,
            format,
            mipmaps: false,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE
        });

        this.outputTarget = new RenderTarget({
            colorBuffer,
            depth: false
        });
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

export class PenSketchController {
    private readonly app: AppBase;
    private readonly camera: CameraComponent;
    private readonly effect: PenSketchPostEffect;
    private readonly cameraFrameBridge: PenSketchCameraFrameBridge;
    private legacyMounted = false;
    private originalClearColor: Color | null = null;
    private revealSuspended = false;
    private deferredSyncGeneration = 0;
    private lastApplySettings: unknown = null;
    private lastApplyOptions: PenSketchApplyOptions | undefined;

    constructor(app: AppBase, camera: CameraComponent) {
        this.app = app;
        this.camera = camera;
        this.effect = new PenSketchPostEffect(app.graphicsDevice);
        this.cameraFrameBridge = new PenSketchCameraFrameBridge(this.effect);
    }

    apply(rawSettings: unknown, options?: PenSketchApplyOptions): void {
        const settings = normalizePenSketchSettings(rawSettings);
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
    }

    resumeFromReveal(): void {
        this.revealSuspended = false;
    }

    setViewScale(viewScale: number): void {
        this.effect.setViewScale(viewScale);
        this.cameraFrameBridge.setViewScale(viewScale);
    }

    destroy(): void {
        this.unmountAll();
        this.effect.destroy();
    }

    private mountActivePostEffect(options?: PenSketchApplyOptions): void {
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
            console.warn('[pen-sketch] camera postEffects unavailable');
            return;
        }
        if (!this.legacyMounted) {
            this.camera.postEffects.addEffect(this.effect);
            this.legacyMounted = true;
        }
    }

    private unmountLegacy(): void {
        if (!this.camera.postEffects || !this.legacyMounted) {
            return;
        }
        this.camera.postEffects.removeEffect(this.effect);
        this.legacyMounted = false;
    }

    private unmountAll(): void {
        this.cancelDeferredSync();
        this.cameraFrameBridge.unmount();
        this.unmountLegacy();
        this.restoreClearColor();
        this.app.renderNextFrame = true;
    }

    private cancelDeferredSync(): void {
        this.deferredSyncGeneration++;
    }

    private applyPaperClearColor(settings?: PenSketchSettings): void {
        if (this.revealSuspended) {
            return;
        }
        const resolved = settings ?? normalizePenSketchSettings(this.lastApplySettings);
        if (!resolved.enabled) {
            return;
        }
        const paper = penPaperClearColor(resolved);
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
            const settings = normalizePenSketchSettings(this.lastApplySettings);
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
