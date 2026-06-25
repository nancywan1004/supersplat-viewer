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
import { StylisationPaperPostController } from './stylisation-paper-controller';
import { finiteOr, normalizeRgbColor, paperClearColorFromRgb } from './stylisation-paper-utils';

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

export function charcoalPaperClearColor(raw: unknown): Color {
    return paperClearColorFromRgb(normalizeCharcoalSketchSettings(raw).paperColor);
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
        paperColor: normalizeRgbColor(obj.paperColor, DEFAULT_CHARCOAL_SKETCH_SETTINGS.paperColor)
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

export class CharcoalSketchController {
    private readonly effect: CharcoalSketchPostEffect;
    private readonly core: StylisationPaperPostController<CharcoalSketchSettings>;

    constructor(app: AppBase, camera: CameraComponent) {
        this.effect = new CharcoalSketchPostEffect(app.graphicsDevice);
        const bridge = new CharcoalSketchCameraFrameBridge(this.effect);
        this.core = new StylisationPaperPostController({
            app,
            camera,
            logTag: 'charcoal-sketch',
            bridge,
            postEffect: this.effect,
            normalizeSettings: normalizeCharcoalSketchSettings,
            paperClearColor: charcoalPaperClearColor,
            applyEffectSettings: (settings) => {
                this.effect.setSettings(settings);
                bridge.setSettings(settings);
            }
        });
    }

    apply(rawSettings: unknown, options?: CharcoalSketchApplyOptions): void {
        this.core.apply(rawSettings, options);
    }

    suspendForReveal(): void {
        this.core.suspendForReveal();
    }

    resumeFromReveal(): void {
        this.core.resumeFromReveal();
    }

    destroy(): void {
        this.core.destroy();
        this.effect.destroy();
    }
}
