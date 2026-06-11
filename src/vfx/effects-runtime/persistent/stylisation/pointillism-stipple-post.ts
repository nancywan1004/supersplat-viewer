import {
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR,
    FILTER_NEAREST,
    PIXELFORMAT_R8_G8_B8_A8,
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

/** 后处理颗粒尺度：值越小，屏幕 dither 块越大（非像素网格采样） */
export const POINTILLISM_STIPPLE_SIZE_STEPS = [32, 48, 64, 72, 96, 128, 160] as const;

type Rgb = [number, number, number];

export type PointillismPostSettings = {
    enabled: boolean;
    postEffectEnabled: boolean;
    stippleSize: number;
    paletteIndex: number;
    paletteStrength: number;
    levels: number;
    levelRange: number;
    ditherSpread: number;
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

const POINTILLISM_PALETTES_HEX: ReadonlyArray<ReadonlyArray<string>> = [
    ['#2E1408', '#D14724', '#3A1A0E', '#E86A2A', '#5C2E18', '#F08C32', '#F5B048', '#8A4E1C', '#F8C85A', '#7A6E38', '#FBE078', '#9A8A3A', '#A8A090', '#E8D068', '#C8C0B0', '#F5E898', '#E8E0D0', '#FAF0C0', '#F8F4E8', '#FFFFFF'],
    ['#17091A', '#5A1E78', '#2A1230', '#8A2E9A', '#3A1848', '#B24088', '#D85848', '#4A2860', '#E87838', '#5A3870', '#F0A030', '#6A4880', '#9090A0', '#F0C848', '#B0B0B8', '#F8E060', '#D8D8E0', '#FAF0A0', '#F4F4F8', '#FFFFFF'],
    ['#081810', '#1A6038', '#0C2818', '#2A8848', '#143820', '#48A858', '#78C838', '#285830', '#98D828', '#486838', '#E8C828', '#687848', '#90A090', '#F0D848', '#B8C0B0', '#F8E858', '#E0E8D8', '#FAF0A0', '#F6FAF0', '#FFFFFF'],
    ['#282420', '#504840', '#383430', '#686058', '#484038', '#807870', '#A89888', '#605850', '#C0B0A0', '#787068', '#E0D0B8', '#908878', '#B0A8A0', '#F0E0C8', '#C8C0B8', '#F8F0E0', '#E8E4DC', '#FAF6EE', '#FCFAF4', '#FFFFFF']
] as const;

export const DEFAULT_POINTILLISM_POST_SETTINGS: PointillismPostSettings = {
    enabled: false,
    postEffectEnabled: POINTILLISM_DEFAULTS.postEffectEnabled,
    stippleSize: POINTILLISM_DEFAULTS.stippleSize,
    paletteIndex: POINTILLISM_DEFAULTS.paletteIndex,
    paletteStrength: POINTILLISM_DEFAULTS.paletteStrength,
    levels: POINTILLISM_DEFAULTS.levels,
    levelRange: POINTILLISM_DEFAULTS.levelRange,
    ditherSpread: POINTILLISM_DEFAULTS.ditherSpread,
    paperStrength: POINTILLISM_DEFAULTS.paperStrength,
    paperTint: [...POINTILLISM_DEFAULTS.paperTint],
    edgeThreshold: POINTILLISM_DEFAULTS.edgeThreshold,
    edgeStrength: POINTILLISM_DEFAULTS.edgeStrength
};

const PALETTE_STEPS = 20;
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
        paperStrength: clamp(finiteOr(obj.paperStrength, DEFAULT_POINTILLISM_POST_SETTINGS.paperStrength), 0, 1),
        paperTint: normalizeColor(obj.paperTint, DEFAULT_POINTILLISM_POST_SETTINGS.paperTint),
        edgeThreshold: clamp(finiteOr(obj.edgeThreshold, DEFAULT_POINTILLISM_POST_SETTINGS.edgeThreshold), 0.02, 1),
        edgeStrength: clamp(finiteOr(obj.edgeStrength, DEFAULT_POINTILLISM_POST_SETTINGS.edgeStrength), 0, 1)
    };
}

const hexToRgb = (hex: string): Rgb => {
    const text = hex.startsWith('#') ? hex.slice(1) : hex;
    return [
        parseInt(text.slice(0, 2), 16) / 255,
        parseInt(text.slice(2, 4), 16) / 255,
        parseInt(text.slice(4, 6), 16) / 255
    ];
};

const buildPaletteTexture = (device: GraphicsDevice): Texture => {
    const width = PALETTE_STEPS;
    const height = 4;
    const paletteData = new Uint8Array(width * height * 4);

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const [r, g, b] = hexToRgb(POINTILLISM_PALETTES_HEX[row][col]);
            const idx = (row * width + col) * 4;
            paletteData[idx + 0] = Math.round(r * 255);
            paletteData[idx + 1] = Math.round(g * 255);
            paletteData[idx + 2] = Math.round(b * 255);
            paletteData[idx + 3] = 255;
        }
    }

    const tex = new Texture(device, {
        width,
        height,
        format: PIXELFORMAT_R8_G8_B8_A8,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE
    });
    const pixels = tex.lock();
    pixels.set(paletteData);
    tex.unlock();
    return tex;
};

class PointillismPostEffect extends PostEffect {
    private readonly shader: Shader;
    private readonly paletteTex: Texture;
    private settings: PointillismPostSettings = DEFAULT_POINTILLISM_POST_SETTINGS;

    readonly uPaperTint = new Float32Array(3);
    readonly uResolution = new Float32Array(2);

    constructor(device: GraphicsDevice, precision: string) {
        super(device);
        this.paletteTex = buildPaletteTexture(device);

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
            uniform sampler2D uPaletteTex;
            uniform vec2 uResolution;
            uniform float uStippleSize;
            uniform float uPaletteRow;
            uniform float uPaletteStrength;
            uniform float uDitherSpread;
            uniform float uLevels;
            uniform float uLevelRange;
            uniform float uPaperStrength;
            uniform vec3 uPaperTint;
            uniform float uEdgeThreshold;
            uniform float uEdgeStrength;

            const float PALETTE_STEPS = ${PALETTE_STEPS}.0;

            float getLuminance(vec3 color) {
                return dot(color, vec3(0.299, 0.587, 0.114));
            }

            vec3 sampleFinish(vec2 uv) {
                vec3 originalColor = texture2D(uColorBuffer, uv).rgb;
                float luma = max(getLuminance(originalColor), 0.001);
                float qL = clamp(luma * 0.96 + 0.025, 0.0, 1.0);
                if (uLevelRange < 1.0) {
                    qL = mix(0.5, qL, uLevelRange);
                } else if (uLevelRange > 1.0) {
                    qL = clamp((qL - 0.5) * uLevelRange + 0.5, 0.0, 1.0);
                }

                vec3 chroma = originalColor / luma;
                vec3 quantized = clamp(chroma * qL, 0.0, 1.0);

                float finalIdx = clamp(qL * (PALETTE_STEPS - 1.0), 0.0, PALETTE_STEPS - 1.0);
                float vTex = (uPaletteRow + 0.5) / 4.0;
                float uTex = (floor(finalIdx + 0.5) + 0.5) / PALETTE_STEPS;
                vec3 paletteColor = texture2D(uPaletteTex, vec2(uTex, vTex)).rgb;
                vec3 styled = mix(quantized, mix(paletteColor, quantized, 0.35), clamp(uPaletteStrength, 0.0, 1.0));

                styled = mix(styled, vec3(1.0), 0.02 + qL * 0.04);
                return mix(originalColor, styled, 0.18);
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
                vec3 color = sampleFinish(uv);
                color = mix(color, color * uPaperTint, uPaperStrength * 0.35);

                float edge = edgeFactor(uv);
                vec3 edgeColor = color * vec3(0.82, 0.86, 0.94);
                color = mix(color, edgeColor, edge * uEdgeStrength);

                gl_FragColor = vec4(color, 1.0);
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

    destroy(): void {
        this.paletteTex.destroy();
    }

    render(inputTarget: { colorBuffer?: Texture }, outputTarget: RenderTarget, rect: unknown): void {
        const colorBuffer = inputTarget?.colorBuffer;
        if (!colorBuffer) return;

        const scope = this.device.scope;
        const s = this.settings;

        this.uResolution[0] = colorBuffer.width;
        this.uResolution[1] = colorBuffer.height;

        scope.resolve('uColorBuffer').setValue(colorBuffer);
        scope.resolve('uPaletteTex').setValue(this.paletteTex);
        scope.resolve('uResolution').setValue(this.uResolution);
        scope.resolve('uStippleSize').setValue(s.stippleSize);
        scope.resolve('uPaletteRow').setValue(s.paletteIndex);
        scope.resolve('uPaletteStrength').setValue(s.paletteStrength);
        scope.resolve('uDitherSpread').setValue(s.ditherSpread);
        scope.resolve('uLevels').setValue(s.levels);
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
        this.effect.destroy();
    }
}
