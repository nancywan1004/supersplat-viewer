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
    WATERCOLOR_BLUR_FRAGMENT_GLSL,
    WATERCOLOR_MAIN_FRAGMENT_GLSL,
    WATERCOLOR_VERTEX_GLSL
} from './watercolor-shaders';
import { StylisationPaperPostController } from './stylisation-paper-controller';
import { finiteOr, normalizeRgbColor, paperClearColorFromRgb } from './stylisation-paper-utils';

export type WatercolorSettings = {
    enabled: boolean;
    bleed: number;
    wash: number;
    blur: number;
    paper: number;
    paperColor: [number, number, number];
    clarity: number;
    saturation: number;
};

export type WatercolorApplyOptions = {
    getCameraFrame?: () => CameraFrame | null | undefined;
};

/** 与参考 demo 控制面板默认值一致 */
export const DEFAULT_WATERCOLOR_SETTINGS: WatercolorSettings = {
    enabled: false,
    bleed: 0.3,
    wash: 0.7,
    blur: 0.3,
    paper: 0.75,
    paperColor: [0.965, 0.945, 0.875],
    clarity: 0.7,
    saturation: 1
};

const WET_SCALE = 0.5;
const WET_TARGET_COUNT = 3;
const WET_DIFFUSION_PASSES = 5;

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));

export function watercolorPaperClearColor(raw: unknown): Color {
    return paperClearColorFromRgb(normalizeWatercolorSettings(raw).paperColor);
}

export function normalizeWatercolorSettings(raw: unknown): WatercolorSettings {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        enabled: !!obj.enabled,
        bleed: clamp(finiteOr(obj.bleed, DEFAULT_WATERCOLOR_SETTINGS.bleed), 0, 0.5),
        wash: clamp(finiteOr(obj.wash, DEFAULT_WATERCOLOR_SETTINGS.wash), 0, 1),
        blur: clamp(finiteOr(obj.blur, DEFAULT_WATERCOLOR_SETTINGS.blur), 0, 1),
        paper: clamp(finiteOr(obj.paper, DEFAULT_WATERCOLOR_SETTINGS.paper), 0, 1),
        paperColor: normalizeRgbColor(obj.paperColor, DEFAULT_WATERCOLOR_SETTINGS.paperColor),
        clarity: clamp(finiteOr(obj.clarity, DEFAULT_WATERCOLOR_SETTINGS.clarity), 0, 2),
        saturation: clamp(finiteOr(obj.saturation, DEFAULT_WATERCOLOR_SETTINGS.saturation), 0, 2)
    };
}

function createFullscreenShader(device: GraphicsDevice, fshader: string, name: string): Shader {
    return new Shader(device, {
        attributes: { aPosition: SEMANTIC_POSITION },
        vshader: WATERCOLOR_VERTEX_GLSL,
        fshader,
        name
    });
}

class WatercolorPostEffect extends PostEffect {
    private readonly blurShader: Shader;
    private readonly mainShader: Shader;
    private settings: WatercolorSettings = DEFAULT_WATERCOLOR_SETTINGS;
    private time = 0;
    private wetTargets: RenderTarget[] = [];
    private wetWidth = 0;
    private wetHeight = 0;

    constructor(device: GraphicsDevice) {
        super(device);
        this.blurShader = createFullscreenShader(device, WATERCOLOR_BLUR_FRAGMENT_GLSL, 'WetDiffusionShader');
        this.mainShader = createFullscreenShader(device, WATERCOLOR_MAIN_FRAGMENT_GLSL, 'WatercolorShader');
    }

    setSettings(settings: WatercolorSettings): void {
        this.settings = settings;
    }

    setTime(time: number): void {
        this.time = time;
    }

    destroy(): void {
        this.destroyWetTargets();
    }

    private destroyWetTargets(): void {
        for (const target of this.wetTargets) {
            target.destroyTextureBuffers();
            target.destroy();
        }
        this.wetTargets = [];
        this.wetWidth = 0;
        this.wetHeight = 0;
    }

    private ensureWetTargets(deviceWidth: number, deviceHeight: number): void {
        const w = Math.max(1, Math.floor(deviceWidth * WET_SCALE));
        const h = Math.max(1, Math.floor(deviceHeight * WET_SCALE));
        if (w === this.wetWidth && h === this.wetHeight && this.wetTargets.length === WET_TARGET_COUNT) {
            return;
        }

        this.destroyWetTargets();
        this.wetWidth = w;
        this.wetHeight = h;

        for (let i = 0; i < WET_TARGET_COUNT; i++) {
            const colorBuffer = new Texture(this.device, {
                name: `Wet diffusion ${i}`,
                width: w,
                height: h,
                format: PIXELFORMAT_RGBA8,
                mipmaps: false,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE
            });
            this.wetTargets.push(new RenderTarget({
                colorBuffer,
                depth: false
            }));
        }
    }

    render(inputTarget: { colorBuffer: Texture }, outputTarget: RenderTarget | null, rect: unknown): void {
        const device = this.device;
        const scope = device.scope;
        const source = inputTarget.colorBuffer;

        this.ensureWetTargets(device.width, device.height);

        let wetSource = source;
        let wetMergeSource = wetSource;

        for (let pass = 0; pass < WET_DIFFUSION_PASSES; pass++) {
            const wetTarget = pass < 3
                ? this.wetTargets[pass % 2]
                : this.wetTargets[pass === 3 ? 1 : 2];

            scope.resolve('uBlurSource').setValue(wetSource);
            scope.resolve('uBlurTexel').setValue([1 / wetSource.width, 1 / wetSource.height]);
            const offset = pass < 3
                ? 0.50 + this.settings.wash * (0.15 + pass * 0.04)
                : 0.55 + this.settings.blur * (1.60 + (pass - 3) * 0.38);
            scope.resolve('uBlurOffset').setValue(offset);
            this.drawQuad(wetTarget, this.blurShader, null);
            wetSource = wetTarget.colorBuffer;
            if (pass === 2) {
                wetMergeSource = wetSource;
            }
        }

        scope.resolve('uColorBuffer').setValue(source);
        scope.resolve('uWashBuffer').setValue(wetMergeSource);
        scope.resolve('uBlurBuffer').setValue(wetSource);
        scope.resolve('uResolution').setValue([device.width, device.height]);
        scope.resolve('uTime').setValue(this.time);
        scope.resolve('uBleed').setValue(this.settings.bleed);
        scope.resolve('uWash').setValue(this.settings.wash);
        scope.resolve('uBlur').setValue(this.settings.blur);
        scope.resolve('uPaper').setValue(this.settings.paper);
        scope.resolve('uPaperColor').setValue(this.settings.paperColor);
        scope.resolve('uClarity').setValue(this.settings.clarity);
        scope.resolve('uSaturation').setValue(this.settings.saturation);

        this.drawQuad(outputTarget, this.mainShader, rect as any);
    }
}

class WatercolorCameraFrameBridge {
    private readonly effect: WatercolorPostEffect;
    private outputTarget: RenderTarget | null = null;
    private hookedRenderPassCamera: unknown = null;
    private originalFrameUpdate: (() => void) | null = null;
    private active = false;

    constructor(effect: WatercolorPostEffect) {
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

    setSettings(settings: WatercolorSettings): void {
        this.effect.setSettings(settings);
    }

    setTime(time: number): void {
        this.effect.setTime(time);
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
            name: 'watercolor-scene',
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

export class WatercolorController {
    private readonly effect: WatercolorPostEffect;
    private readonly bridge: WatercolorCameraFrameBridge;
    private readonly core: StylisationPaperPostController<WatercolorSettings>;

    constructor(app: AppBase, camera: CameraComponent) {
        this.effect = new WatercolorPostEffect(app.graphicsDevice);
        this.bridge = new WatercolorCameraFrameBridge(this.effect);
        this.core = new StylisationPaperPostController({
            app,
            camera,
            logTag: 'watercolor',
            bridge: this.bridge,
            postEffect: this.effect,
            normalizeSettings: normalizeWatercolorSettings,
            paperClearColor: watercolorPaperClearColor,
            applyEffectSettings: (settings) => {
                this.effect.setSettings(settings);
                this.bridge.setSettings(settings);
            }
        });
    }

    apply(rawSettings: unknown, options?: WatercolorApplyOptions): void {
        this.core.apply(rawSettings, options);
    }

    suspendForReveal(): void {
        this.core.suspendForReveal();
    }

    resumeFromReveal(): void {
        this.core.resumeFromReveal();
    }

    setTime(time: number): void {
        this.effect.setTime(time);
        this.bridge.setTime(time);
    }

    destroy(): void {
        this.core.destroy();
        this.effect.destroy();
    }
}
