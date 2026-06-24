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

export type CharcoalSketchSettings = {
    enabled: boolean;
    outline: number;
    hatching: number;
    contrast: number;
    stroke: number;
    smudge: number;
    focus: number;
    paper: number;
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
    paper: 0.5
};

/** 与参考 demo 相机清屏色一致 */
export const DEFAULT_CHARCOAL_PAPER_CLEAR: [number, number, number] = [0.965, 0.955, 0.925];

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
const finiteOr = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

export function charcoalPaperClearColor(): Color {
    const [r, g, b] = DEFAULT_CHARCOAL_PAPER_CLEAR;
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
        paper: clamp(finiteOr(obj.paper, DEFAULT_CHARCOAL_SKETCH_SETTINGS.paper), 0, 1)
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
        // no RT allocations
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

        this.drawQuad(outputTarget, this.mainShader, rect as any);
    }
}

class CharcoalSketchCameraFrameBridge {
    private readonly effect: CharcoalSketchPostEffect;
    private outputTarget: RenderTarget | null = null;
    private hookedRenderPassCamera: unknown = null;
    private originalFrameUpdate: (() => void) | null = null;
    private active = false;

    constructor(effect: CharcoalSketchPostEffect) {
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

    setSettings(settings: CharcoalSketchSettings): void {
        this.effect.setSettings(settings);
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

export class CharcoalSketchController {
    private readonly app: AppBase;
    private readonly camera: CameraComponent;
    private readonly effect: CharcoalSketchPostEffect;
    private readonly cameraFrameBridge: CharcoalSketchCameraFrameBridge;
    private legacyMounted = false;
    private originalClearColor: Color | null = null;

    constructor(app: AppBase, camera: CameraComponent) {
        this.app = app;
        this.camera = camera;
        this.effect = new CharcoalSketchPostEffect(app.graphicsDevice);
        this.cameraFrameBridge = new CharcoalSketchCameraFrameBridge(this.effect);
    }

    apply(rawSettings: unknown, options?: CharcoalSketchApplyOptions): void {
        const settings = normalizeCharcoalSketchSettings(rawSettings);
        this.effect.setSettings(settings);
        this.cameraFrameBridge.setSettings(settings);

        if (!settings.enabled) {
            this.unmountAll();
            return;
        }

        const cameraFrame = options?.getCameraFrame?.();
        if (cameraFrame?.enabled && this.cameraFrameBridge.mount(cameraFrame)) {
            this.unmountLegacy();
        } else {
            this.cameraFrameBridge.unmount();
            this.mountLegacy();
        }

        this.applyPaperClearColor();
        this.app.renderNextFrame = true;
    }

    private mountLegacy(): void {
        if (!this.camera.postEffects) {
            console.warn('[charcoal-sketch] camera postEffects unavailable');
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
        this.cameraFrameBridge.unmount();
        this.unmountLegacy();
        this.restoreClearColor();
        this.app.renderNextFrame = true;
    }

    private applyPaperClearColor(): void {
        if (!this.originalClearColor) {
            this.originalClearColor = this.camera.clearColor.clone();
        }
        this.camera.clearColorBuffer = true;
        this.camera.clearColor = charcoalPaperClearColor();
    }

    private restoreClearColor(): void {
        if (!this.originalClearColor) {
            return;
        }
        this.camera.clearColor = this.originalClearColor.clone();
        this.originalClearColor = null;
    }

    destroy(): void {
        this.unmountAll();
        this.effect.destroy();
    }
}
