import {
    ADDRESS_CLAMP_TO_EDGE,
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

import { POINTILLISM_DEFAULTS } from './pointillism-stipple-shaders';

/** 后处理颗粒尺度：值越大，屏幕网格越密 */
export const POINTILLISM_STIPPLE_SIZE_STEPS = [32, 48, 64, 72, 96, 128, 160] as const;

type Rgb = [number, number, number];

export type PointillismPostSettings = {
    enabled: boolean;
    postEffectEnabled: boolean;
    stippleSize: number;
    /** 协议保留，不参与后处理着色 */
    paletteIndex: number;
    paletteStrength: number;
    levels: number;
    levelRange: number;
    ditherSpread: number;
    warmCoolSplit: number;
    sourceStructureBlend: number;
    saturation: number;
    complementaryMix: number;
    contrastDotMix: number;
    seed: number;
    paperStrength: number;
    paperTint: [number, number, number];
    edgeThreshold: number;
    edgeStrength: number;
};

export const POINTILLISM_PALETTE_NAMES: Record<number, string> = {
    0: '暖橙厚涂',
    1: '紫蓝橙光',
    2: '翠绿金黄',
    3: '大地中性'
};

export const DEFAULT_POINTILLISM_POST_SETTINGS: PointillismPostSettings = {
    enabled: false,
    postEffectEnabled: POINTILLISM_DEFAULTS.postEffectEnabled,
    stippleSize: POINTILLISM_DEFAULTS.stippleSize,
    paletteIndex: POINTILLISM_DEFAULTS.paletteIndex,
    paletteStrength: POINTILLISM_DEFAULTS.paletteStrength,
    levels: POINTILLISM_DEFAULTS.levels,
    levelRange: POINTILLISM_DEFAULTS.levelRange,
    ditherSpread: POINTILLISM_DEFAULTS.ditherSpread,
    warmCoolSplit: POINTILLISM_DEFAULTS.warmCoolSplit,
    sourceStructureBlend: POINTILLISM_DEFAULTS.sourceStructureBlend,
    saturation: POINTILLISM_DEFAULTS.saturation,
    complementaryMix: POINTILLISM_DEFAULTS.complementaryMix,
    contrastDotMix: POINTILLISM_DEFAULTS.contrastDotMix,
    seed: POINTILLISM_DEFAULTS.seed,
    paperStrength: POINTILLISM_DEFAULTS.paperStrength,
    paperTint: [...POINTILLISM_DEFAULTS.paperTint],
    edgeThreshold: POINTILLISM_DEFAULTS.edgeThreshold,
    edgeStrength: POINTILLISM_DEFAULTS.edgeStrength
};

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));
const finiteOr = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

export const coercePointillismBool = (v: unknown, fallback: boolean): boolean => {
    if (typeof v === 'boolean') return v;
    if (v === 1 || v === '1' || v === 'true') return true;
    if (v === 0 || v === '0' || v === 'false') return false;
    return fallback;
};

const snapStippleSize = (v: number): number => {
    const steps = POINTILLISM_STIPPLE_SIZE_STEPS;
    let best: number = steps[0];
    let bestDist = Math.abs(v - best);
    for (let i = 1; i < steps.length; i++) {
        const dist = Math.abs(v - steps[i]);
        if (dist < bestDist) {
            best = steps[i];
            bestDist = dist;
        }
    }
    return best;
};

const normalizeColor = (v: unknown, fallback: Rgb): Rgb => {
    if (!Array.isArray(v) || v.length < 3) return [...fallback];
    return [
        clamp(finiteOr(v[0], fallback[0]), 0, 1),
        clamp(finiteOr(v[1], fallback[1]), 0, 1),
        clamp(finiteOr(v[2], fallback[2]), 0, 1)
    ];
};

export function normalizePointillismPostSettings(raw: unknown): PointillismPostSettings {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        enabled: coercePointillismBool(obj.enabled, false),
        postEffectEnabled: coercePointillismBool(
            obj.postEffectEnabled,
            DEFAULT_POINTILLISM_POST_SETTINGS.postEffectEnabled
        ),
        stippleSize: snapStippleSize(clamp(
            finiteOr(obj.stippleSize, DEFAULT_POINTILLISM_POST_SETTINGS.stippleSize),
            32,
            160
        )),
        paletteIndex: clamp(Math.floor(finiteOr(obj.paletteIndex, DEFAULT_POINTILLISM_POST_SETTINGS.paletteIndex)), 0, 3),
        paletteStrength: clamp(finiteOr(obj.paletteStrength, DEFAULT_POINTILLISM_POST_SETTINGS.paletteStrength), 0, 1),
        levels: clamp(Math.floor(finiteOr(obj.levels, DEFAULT_POINTILLISM_POST_SETTINGS.levels)), 2, 20),
        levelRange: clamp(finiteOr(obj.levelRange, DEFAULT_POINTILLISM_POST_SETTINGS.levelRange), 0.5, 2),
        ditherSpread: clamp(finiteOr(obj.ditherSpread, DEFAULT_POINTILLISM_POST_SETTINGS.ditherSpread), 0, 0.2),
        warmCoolSplit: clamp(finiteOr(obj.warmCoolSplit, DEFAULT_POINTILLISM_POST_SETTINGS.warmCoolSplit), 0, 1),
        sourceStructureBlend: clamp(
            finiteOr(obj.sourceStructureBlend, DEFAULT_POINTILLISM_POST_SETTINGS.sourceStructureBlend),
            0,
            1
        ),
        saturation: clamp(finiteOr(obj.saturation, DEFAULT_POINTILLISM_POST_SETTINGS.saturation), 0, 3),
        complementaryMix: clamp(finiteOr(obj.complementaryMix, DEFAULT_POINTILLISM_POST_SETTINGS.complementaryMix), 0, 1),
        contrastDotMix: clamp(finiteOr(obj.contrastDotMix, DEFAULT_POINTILLISM_POST_SETTINGS.contrastDotMix), 0, 1),
        seed: clamp(finiteOr(obj.seed, DEFAULT_POINTILLISM_POST_SETTINGS.seed), 0, 997),
        paperStrength: clamp(finiteOr(obj.paperStrength, DEFAULT_POINTILLISM_POST_SETTINGS.paperStrength), 0, 1),
        paperTint: normalizeColor(obj.paperTint, DEFAULT_POINTILLISM_POST_SETTINGS.paperTint),
        edgeThreshold: clamp(finiteOr(obj.edgeThreshold, DEFAULT_POINTILLISM_POST_SETTINGS.edgeThreshold), 0.02, 1),
        edgeStrength: clamp(finiteOr(obj.edgeStrength, DEFAULT_POINTILLISM_POST_SETTINGS.edgeStrength), 0, 1)
    };
}

class PointillismPostEffect extends PostEffect {
    private readonly shader: Shader;
    private settings: PointillismPostSettings = DEFAULT_POINTILLISM_POST_SETTINGS;

    readonly uPaperTint = new Float32Array(3);
    readonly uResolution = new Float32Array(2);

    constructor(device: GraphicsDevice, precision: string) {
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
            precision ${precision} float;

            varying vec2 vUv0;
            uniform sampler2D uColorBuffer;
            uniform vec2 uResolution;
            uniform float uSaturation;
            uniform float uLevelRange;
            uniform float uPaperStrength;
            uniform vec3 uPaperTint;
            uniform float uEdgeThreshold;
            uniform float uEdgeStrength;

            float getLuminance(vec3 color) {
                return dot(color, vec3(0.299, 0.587, 0.114));
            }

            vec3 saturateColor(vec3 color, float amount) {
                float luma = getLuminance(color);
                return mix(vec3(luma), color, max(0.0, amount));
            }

            vec3 applyContrast(vec3 color, float levelRange) {
                float luma = getLuminance(color);
                if (levelRange < 1.0) {
                    return mix(vec3(0.5), color, levelRange);
                }
                return mix(vec3(luma), color, levelRange);
            }

            float edgeFactor(vec2 uv) {
                vec2 px = 1.0 / uResolution;
                vec3 c = texture2D(uColorBuffer, uv).rgb;
                vec3 r = texture2D(uColorBuffer, uv + vec2(px.x, 0.0)).rgb;
                vec3 u = texture2D(uColorBuffer, uv + vec2(0.0, px.y)).rgb;
                float edge = length(c - r) + length(c - u);
                return smoothstep(uEdgeThreshold, uEdgeThreshold * 2.5, edge);
            }

            void main() {
                vec2 uv = vUv0;
                vec3 sceneColor = texture2D(uColorBuffer, uv).rgb;

                float postSat = 1.0 + max(0.0, uSaturation - 1.0) * 0.28;
                vec3 color = saturateColor(sceneColor, postSat);
                color = applyContrast(color, uLevelRange);

                color = mix(color, color * uPaperTint, uPaperStrength * 0.16);

                float edge = edgeFactor(uv);
                vec3 edgeColor = color * vec3(0.72, 0.76, 0.84);
                color = mix(color, edgeColor, edge * uEdgeStrength * 0.34);

                gl_FragColor = vec4(clamp(color, 0.0, 1.0), 1.0);
            }
        `;

        this.shader = new Shader(device, {
            attributes: { aPosition: SEMANTIC_POSITION },
            vshader,
            fshader
        });
    }

    setSettings(raw: unknown): void {
        this.settings = normalizePointillismPostSettings(raw);
        this.uPaperTint[0] = this.settings.paperTint[0];
        this.uPaperTint[1] = this.settings.paperTint[1];
        this.uPaperTint[2] = this.settings.paperTint[2];
    }

    render(inputTarget: { colorBuffer?: Texture }, outputTarget: RenderTarget, rect: unknown): void {
        const colorBuffer = inputTarget?.colorBuffer;
        if (!colorBuffer) return;

        const scope = this.device.scope;
        const s = this.settings;

        this.uResolution[0] = colorBuffer.width;
        this.uResolution[1] = colorBuffer.height;

        scope.resolve('uColorBuffer').setValue(colorBuffer);
        scope.resolve('uResolution').setValue(this.uResolution);
        scope.resolve('uSaturation').setValue(s.saturation);
        scope.resolve('uLevelRange').setValue(s.levelRange);
        scope.resolve('uPaperStrength').setValue(s.paperStrength);
        scope.resolve('uPaperTint').setValue(this.uPaperTint);
        scope.resolve('uEdgeThreshold').setValue(s.edgeThreshold);
        scope.resolve('uEdgeStrength').setValue(s.edgeStrength);

        this.drawQuad(outputTarget, this.shader, rect as any);
    }
}

class PointillismCameraFrameBridge {
    private readonly effect: PointillismPostEffect;
    private outputTarget: RenderTarget | null = null;
    private hookedRenderPassCamera: unknown = null;
    private originalFrameUpdate: (() => void) | null = null;
    private active = false;

    constructor(effect: PointillismPostEffect) {
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

    setSettings(settings: PointillismPostSettings): void {
        this.effect.setSettings({ ...settings, enabled: true });
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
            name: 'pointillism-stipple-scene',
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
        if (!this.outputTarget) return;
        this.outputTarget.destroyTextureBuffers();
        this.outputTarget.destroy();
        this.outputTarget = null;
    }
}

export type PointillismPostApplyOptions = {
    getCameraFrame?: () => CameraFrame | null | undefined;
};

export class PointillismPostController {
    private readonly app: AppBase;
    private readonly camera: CameraComponent;
    private readonly effect: PointillismPostEffect;
    private readonly cameraFrameBridge: PointillismCameraFrameBridge;
    private settings: PointillismPostSettings = DEFAULT_POINTILLISM_POST_SETTINGS;
    private legacyMounted = false;

    constructor(app: AppBase, camera: CameraComponent) {
        this.app = app;
        this.camera = camera;
        this.effect = new PointillismPostEffect(app.graphicsDevice, app.graphicsDevice.precision);
        this.cameraFrameBridge = new PointillismCameraFrameBridge(this.effect);
    }

    apply(rawSettings: unknown, options?: PointillismPostApplyOptions): void {
        this.settings = normalizePointillismPostSettings(rawSettings);
        this.effect.setSettings(this.settings);
        this.cameraFrameBridge.setSettings(this.settings);

        if (!this.settings.enabled || !this.settings.postEffectEnabled) {
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

        this.app.renderNextFrame = true;
    }

    private mountLegacy(): void {
        if (!this.camera.postEffects) {
            console.warn('[pointillism-stipple] camera postEffects unavailable');
            return;
        }
        if (!this.legacyMounted) {
            this.camera.postEffects.addEffect(this.effect);
            this.legacyMounted = true;
        }
    }

    private unmountLegacy(): void {
        if (!this.camera.postEffects || !this.legacyMounted) return;
        this.camera.postEffects.removeEffect(this.effect);
        this.legacyMounted = false;
    }

    private unmountAll(): void {
        this.cameraFrameBridge.unmount();
        this.unmountLegacy();
        this.app.renderNextFrame = true;
    }

    destroy(): void {
        this.apply({ ...DEFAULT_POINTILLISM_POST_SETTINGS, enabled: false });
    }
}
