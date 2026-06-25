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
import { StylisationPaperPostController } from './stylisation-paper-controller';
import { finiteOr, normalizeRgbColor, paperClearColorFromRgb } from './stylisation-paper-utils';

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

export function penPaperClearColor(raw: unknown): Color {
    return paperClearColorFromRgb(normalizePenSketchSettings(raw).paperColor);
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
        paperColor: normalizeRgbColor(obj.paperColor, DEFAULT_PEN_SKETCH_SETTINGS.paperColor)
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

    isMounted(): boolean {
        return this.active;
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
    private readonly effect: PenSketchPostEffect;
    private readonly bridge: PenSketchCameraFrameBridge;
    private readonly core: StylisationPaperPostController<PenSketchSettings>;

    constructor(app: AppBase, camera: CameraComponent) {
        this.effect = new PenSketchPostEffect(app.graphicsDevice);
        this.bridge = new PenSketchCameraFrameBridge(this.effect);
        this.core = new StylisationPaperPostController({
            app,
            camera,
            logTag: 'pen-sketch',
            bridge: this.bridge,
            postEffect: this.effect,
            normalizeSettings: normalizePenSketchSettings,
            paperClearColor: penPaperClearColor,
            applyEffectSettings: (settings) => {
                this.effect.setSettings(settings);
                this.bridge.setSettings(settings);
            }
        });
    }

    apply(rawSettings: unknown, options?: PenSketchApplyOptions): void {
        this.core.apply(rawSettings, options);
    }

    suspendForReveal(): void {
        this.core.suspendForReveal();
    }

    resumeFromReveal(): void {
        this.core.resumeFromReveal();
    }

    setViewScale(viewScale: number): void {
        this.effect.setViewScale(viewScale);
        this.bridge.setViewScale(viewScale);
    }

    destroy(): void {
        this.core.destroy();
        this.effect.destroy();
    }
}
