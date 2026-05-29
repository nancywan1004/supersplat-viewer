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

export type NostalgicComicSettings = {
    enabled: boolean;
    levelCount: number;
    edgeThreshold: number;
    paperColor: [number, number, number];
    lightColor: [number, number, number];
    strokeColor: [number, number, number];
};

export type NostalgicComicApplyOptions = {
    getCameraFrame?: () => CameraFrame | null | undefined;
};

export const DEFAULT_NOSTALGIC_COMIC_SETTINGS: NostalgicComicSettings = {
    enabled: false,
    levelCount: 6,
    edgeThreshold: 0.8,
    paperColor: [0.96, 0.94, 0.89],
    lightColor: [0.85, 0.85, 0.85],
    strokeColor: [0.15, 0.15, 0.15]
};

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));
const finiteOr = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

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

export function normalizeNostalgicComicSettings(raw: unknown): NostalgicComicSettings {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        enabled: !!obj.enabled,
        levelCount: Math.max(3, Math.min(16, Math.round(finiteOr(obj.levelCount, DEFAULT_NOSTALGIC_COMIC_SETTINGS.levelCount)))),
        edgeThreshold: Math.max(0.05, Math.min(8, finiteOr(obj.edgeThreshold, DEFAULT_NOSTALGIC_COMIC_SETTINGS.edgeThreshold))),
        paperColor: normalizeColor(obj.paperColor, DEFAULT_NOSTALGIC_COMIC_SETTINGS.paperColor),
        lightColor: normalizeColor(obj.lightColor, DEFAULT_NOSTALGIC_COMIC_SETTINGS.lightColor),
        strokeColor: normalizeColor(obj.strokeColor, DEFAULT_NOSTALGIC_COMIC_SETTINGS.strokeColor)
    };
}

class NostalgicComicPostEffect extends PostEffect {
    private readonly shader: Shader;
    private settings: NostalgicComicSettings = DEFAULT_NOSTALGIC_COMIC_SETTINGS;

    constructor(device: GraphicsDevice) {
        super(device);

        const vshader = `
            attribute vec2 aPosition;
            varying vec2 vUv0;
            void main(void) {
                gl_Position = vec4(aPosition, 0.0, 1.0);
                vUv0 = (aPosition.xy + 1.0) * 0.5;
            }
        `;

        const fshader = `
            precision highp float;

            uniform sampler2D uColorBuffer;
            uniform vec2 uResolution;
            uniform float uLevelCount;
            uniform float uEdgeThreshold;
            uniform vec3 uPaperColor;
            uniform vec3 uLightColor;
            uniform vec3 uStrokeColor;

            varying vec2 vUv0;

            float getLuminance(vec3 color) {
                return dot(color, vec3(0.299, 0.587, 0.114));
            }

            void main() {
                vec4 texColor = texture2D(uColorBuffer, vUv0);
                float luminance = getLuminance(texColor.rgb);
                float alpha = texColor.a;

                float steps = uLevelCount - 1.0;
                float scaledLuma = luminance * steps;
                float base = floor(scaledLuma);
                float fraction = fract(scaledLuma);
                float edgeSoft = 0.02 * steps;
                float smoothed = smoothstep(0.5 - edgeSoft, 0.5 + edgeSoft, fraction);
                float lumaFactor = clamp((base + smoothed) / steps, 0.0, 1.0);

                vec2 texelSize = 1.0 / uResolution;
                float s11 = getLuminance(texture2D(uColorBuffer, vUv0 + vec2(-texelSize.x, -texelSize.y)).rgb);
                float s12 = getLuminance(texture2D(uColorBuffer, vUv0 + vec2(0.0, -texelSize.y)).rgb);
                float s13 = getLuminance(texture2D(uColorBuffer, vUv0 + vec2(texelSize.x, -texelSize.y)).rgb);
                float s21 = getLuminance(texture2D(uColorBuffer, vUv0 + vec2(-texelSize.x, 0.0)).rgb);
                float s23 = getLuminance(texture2D(uColorBuffer, vUv0 + vec2(texelSize.x, 0.0)).rgb);
                float s31 = getLuminance(texture2D(uColorBuffer, vUv0 + vec2(-texelSize.x, texelSize.y)).rgb);
                float s32 = getLuminance(texture2D(uColorBuffer, vUv0 + vec2(0.0, texelSize.y)).rgb);
                float s33 = getLuminance(texture2D(uColorBuffer, vUv0 + vec2(texelSize.x, texelSize.y)).rgb);

                float edgeX = s11 + 2.0 * s21 + s31 - (s13 + 2.0 * s23 + s33);
                float edgeY = s11 + 2.0 * s12 + s13 - (s31 + 2.0 * s32 + s33);
                float edgeValue = length(vec2(edgeX, edgeY));
                float isEdge = step(uEdgeThreshold, edgeValue);

                vec3 finalColor = mix(uStrokeColor, uLightColor, lumaFactor);
                finalColor = mix(finalColor, uStrokeColor, isEdge);

                float isBackground = 1.0 - step(0.1, alpha);
                finalColor = mix(finalColor, uPaperColor, isBackground);

                gl_FragColor = vec4(finalColor, 1.0);
            }
        `;

        this.shader = new Shader(device, {
            attributes: { aPosition: SEMANTIC_POSITION },
            vshader,
            fshader
        });
    }

    setSettings(settings: NostalgicComicSettings): void {
        this.settings = settings;
    }

    render(inputTarget: { colorBuffer: Texture }, outputTarget: RenderTarget | null, rect: unknown): void {
        const device = this.device;
        const scope = device.scope;
        const source = inputTarget.colorBuffer;

        scope.resolve('uColorBuffer').setValue(source);
        scope.resolve('uResolution').setValue([source.width, source.height]);
        scope.resolve('uLevelCount').setValue(this.settings.levelCount);
        scope.resolve('uEdgeThreshold').setValue(this.settings.edgeThreshold);
        scope.resolve('uPaperColor').setValue(this.settings.paperColor);
        scope.resolve('uLightColor').setValue(this.settings.lightColor);
        scope.resolve('uStrokeColor').setValue(this.settings.strokeColor);

        this.drawQuad(outputTarget, this.shader, rect as any);
    }
}

/**
 * CameraFrame 开启时 legacy `camera.postEffects` 会被引擎忽略；在 compose 前处理 scene texture。
 */
class NostalgicComicCameraFrameBridge {
    private readonly effect: NostalgicComicPostEffect;
    private outputTarget: RenderTarget | null = null;
    private hookedRenderPassCamera: unknown = null;
    private originalFrameUpdate: (() => void) | null = null;
    private active = false;

    constructor(effect: NostalgicComicPostEffect) {
        this.effect = effect;
    }

    mount(cameraFrame: CameraFrame): boolean {
        const renderPassCamera = (cameraFrame as unknown as { renderPassCamera?: unknown }).renderPassCamera as {
            frameUpdate?: () => void;
            layersDirty?: boolean;
            cameraFrame?: { update?: () => void };
            taaPass?: { update?: () => Texture | null };
            rt?: { colorBuffer: Texture };
            composePass?: { sceneTexture?: Texture | null };
            scenePassHalf?: { setSourceTexture?: (texture: Texture) => void };
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

    setSettings(settings: NostalgicComicSettings): void {
        this.effect.setSettings(settings);
    }

    unmount(): void {
        this.active = false;
        this.unhook();
        this.destroyOutputTarget();
    }

    private unhook(): void {
        const renderPassCamera = this.hookedRenderPassCamera as {
            frameUpdate?: () => void;
        } | null;

        if (renderPassCamera && this.originalFrameUpdate) {
            renderPassCamera.frameUpdate = this.originalFrameUpdate;
        }

        this.hookedRenderPassCamera = null;
        this.originalFrameUpdate = null;
    }

    private process(sourceTexture: Texture): Texture {
        const device = this.effect.device;
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
            name: 'nostalgic-comic-scene',
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

export class NostalgicComicController {
    private readonly app: AppBase;
    private readonly camera: CameraComponent;
    private readonly effect: NostalgicComicPostEffect;
    private readonly cameraFrameBridge: NostalgicComicCameraFrameBridge;
    private legacyMounted = false;
    private originalClearColor: Color | null = null;

    constructor(app: AppBase, camera: CameraComponent) {
        this.app = app;
        this.camera = camera;
        this.effect = new NostalgicComicPostEffect(app.graphicsDevice);
        this.cameraFrameBridge = new NostalgicComicCameraFrameBridge(this.effect);
    }

    apply(rawSettings: unknown, options?: NostalgicComicApplyOptions): void {
        const settings = normalizeNostalgicComicSettings(rawSettings);
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

        this.applyTransparentClearColor();
        this.app.renderNextFrame = true;
    }

    private mountLegacy(): void {
        if (!this.camera.postEffects) {
            console.warn('[nostalgic-comic] camera postEffects unavailable');
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

    private applyTransparentClearColor(): void {
        if (!this.originalClearColor) {
            this.originalClearColor = this.camera.clearColor.clone();
        }
        this.camera.clearColorBuffer = true;
        this.camera.clearColor = new Color(1, 1, 1, 0);
    }

    private restoreClearColor(): void {
        if (!this.originalClearColor) {
            return;
        }
        this.camera.clearColor = this.originalClearColor.clone();
        this.originalClearColor = null;
    }
}
