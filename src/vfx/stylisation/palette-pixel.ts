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

type Rgb = [number, number, number];

export const PALETTE_PIXEL_PALETTE_NAMES = {
    1: '碧空跃金',
    2: '墨雅灰绿',
    3: '鲜活绿动',
    4: '暖暮霞光',
    5: '活力撞色',
    6: '火山灰岩',
    7: '夜色霓虹'
} as const;

const PALETTES_HEX: ReadonlyArray<ReadonlyArray<string>> = [
    ['#1A1512', '#2B82AD', '#3A2314', '#1F57A3', '#5C3A21', '#2570C6', '#348CEB', '#8A5C1F', '#3CA5D6', '#7C7841', '#53C9E8', '#A6962A', '#9A9A9A', '#D9B626', '#C2C2C2', '#EBD560', '#E1E1E1', '#F0F0F0', '#FAFAFA', '#FFFFFF'],
    ['#2F3638', '#424D52', '#4F5952', '#5A6773', '#68756C', '#788691', '#8A9C8D', '#94A4AD', '#A3B5B1', '#AEBFC4', '#B3BCA2', '#C3CFC7', '#D0D9D8', '#D9DECB', '#E1E6E8', '#E8EBDB', '#EEF0E6', '#F2F4ED', '#F7F8F2', '#FCFDF9'],
    ['#1B3651', '#215061', '#30636D', '#2D796F', '#3B8798', '#489CA5', '#169CC4', '#22B4D6', '#2CD8DF', '#687C80', '#728E84', '#908C86', '#89A675', '#B3AB9D', '#D2BD9F', '#6BB454', '#A6D257', '#E5DDB9', '#EEE7CB', '#FDFDFD'],
    ['#262338', '#382E44', '#463750', '#5B465A', '#684F5C', '#825D63', '#9D6968', '#B9786A', '#C38366', '#D09168', '#D8A16E', '#DBA971', '#E4B578', '#E9C17E', '#F0CD86', '#F3D694', '#F6DB9B', '#F9E1A3', '#FBE6AE', '#FDECC1'],
    ['#101E27', '#143544', '#164A5E', '#1F685D', '#234D7D', '#346D91', '#158A6D', '#1B9D7C', '#E34540', '#DB6840', '#EC7C45', '#30AB90', '#E79A4F', '#3CB99D', '#E2B561', '#DDBF88', '#B0CEBE', '#D7DFC8', '#F0E3B6', '#FDFDFD'],
    ['#323558', '#464C72', '#545E84', '#667291', '#71809E', '#7C8BA8', '#DE413E', '#8A99B5', '#91AD9B', '#90A8BD', '#9DB6C5', '#A8C7A8', '#A9CBDC', '#BBD2DE', '#C2DAE3', '#CDE0E7', '#D8EAE4', '#E4EBE5', '#EFF0EA', '#FBFBF9'],
    ['#111124', '#151633', '#181A40', '#1F2149', '#24285B', '#28306A', '#2F3D84', '#34479A', '#3C53AF', '#4360C4', '#546ECA', '#657BD2', '#914453', '#AC5160', '#C46669', '#D78078', '#E89781', '#F3BA91', '#F9DEA0', '#FEFEFE']
] as const;

export type PalettePixelSettings = {
    enabled: boolean;
    pixelSize: number;
    paletteIndex: number;
    levels: number;
    ditherSpread: number;
};

export const DEFAULT_PALETTE_PIXEL_SETTINGS: PalettePixelSettings = {
    enabled: false,
    pixelSize: 300,
    paletteIndex: 5,
    levels: 12,
    ditherSpread: 0.05
};

/** 马赛克大小可选档位（与产品配置表一致） */
export const PALETTE_PIXEL_SIZE_STEPS = [300, 400, 500, 600, 700, 800, 900] as const;

export type PalettePixelApplyOptions = {
    getCameraFrame?: () => CameraFrame | null | undefined;
};

const finiteOr = (v: unknown, fallback: number): number =>
    (typeof v === 'number' && Number.isFinite(v)) ? v : fallback;

const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v));

const snapPixelSize = (v: number): number => {
    const steps = PALETTE_PIXEL_SIZE_STEPS;
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

export function normalizePalettePixelSettings(raw: unknown): PalettePixelSettings {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        enabled: !!obj.enabled,
        pixelSize: snapPixelSize(clamp(finiteOr(obj.pixelSize, DEFAULT_PALETTE_PIXEL_SETTINGS.pixelSize), 300, 900)),
        // 业务定义：有效编号仅 1~7，明确去掉 0 号位
        paletteIndex: clamp(Math.floor(finiteOr(obj.paletteIndex, DEFAULT_PALETTE_PIXEL_SETTINGS.paletteIndex)), 1, 7),
        levels: clamp(Math.floor(finiteOr(obj.levels, DEFAULT_PALETTE_PIXEL_SETTINGS.levels)), 2, 20),
        ditherSpread: clamp(finiteOr(obj.ditherSpread, DEFAULT_PALETTE_PIXEL_SETTINGS.ditherSpread), 0, 0.08)
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
    const width = 20;
    const height = 7;
    const paletteData = new Uint8Array(width * height * 4);

    for (let row = 0; row < height; row++) {
        for (let col = 0; col < width; col++) {
            const [r, g, b] = hexToRgb(PALETTES_HEX[row][col]);
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

class PalettePixelPostEffect extends PostEffect {
    private readonly shader: Shader;
    private readonly paletteTex: Texture;
    private settings: PalettePixelSettings = DEFAULT_PALETTE_PIXEL_SETTINGS;

    constructor(device: GraphicsDevice) {
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
            precision highp float;

            varying vec2 vUv0;
            uniform sampler2D uColorBuffer;
            uniform sampler2D uPaletteTex;
            uniform float uPixelSize;
            uniform float uPaletteRow;
            uniform float uDitherSpread;
            uniform float uLevels;

            float getLuminance(vec3 color) {
                return dot(color, vec3(0.299, 0.587, 0.114));
            }

            float randomNoise(vec2 co) {
                return fract(sin(dot(co.xy, vec2(12.9898, 78.233))) * 43758.5453);
            }

            void main() {
                vec2 gridUv = floor(vUv0 * uPixelSize) / uPixelSize;
                vec3 originalColor = texture2D(uColorBuffer, gridUv).rgb;

                float luma = getLuminance(originalColor);
                float noise = randomNoise(gridUv) - 0.5;
                float ditheredLuma = clamp(luma + noise * uDitherSpread, 0.0, 1.0);

                float steps = max(1.0, uLevels - 1.0);
                float quantizedLuma = floor(ditheredLuma * steps + 0.5) / steps;

                vec3 bestColor = vec3(0.0);
                float minLumaDiff = 999.0;
                float vTex = (uPaletteRow + 0.5) / 7.0;

                for (int i = 0; i < 20; i++) {
                    float uTex = (float(i) + 0.5) / 20.0;
                    vec3 palColor = texture2D(uPaletteTex, vec2(uTex, vTex)).rgb;
                    float palLuma = getLuminance(palColor);
                    float lumaDiff = abs(palLuma - quantizedLuma);
                    if (lumaDiff < minLumaDiff) {
                        minLumaDiff = lumaDiff;
                        bestColor = palColor;
                    }
                }

                gl_FragColor = vec4(bestColor, 1.0);
            }
        `;

        this.shader = new Shader(device, {
            attributes: { aPosition: SEMANTIC_POSITION },
            vshader,
            fshader
        });
    }

    setSettings(raw: unknown): void {
        this.settings = normalizePalettePixelSettings(raw);
    }

    destroy(): void {
        this.paletteTex.destroy();
    }

    render(inputTarget: any, outputTarget: any, rect: any): void {
        const scope = this.device.scope;
        const s = this.settings;
        const paletteRow = s.paletteIndex - 1;

        scope.resolve('uColorBuffer').setValue(inputTarget.colorBuffer);
        scope.resolve('uPaletteTex').setValue(this.paletteTex);
        scope.resolve('uPixelSize').setValue(s.pixelSize);
        scope.resolve('uPaletteRow').setValue(paletteRow);
        scope.resolve('uDitherSpread').setValue(s.ditherSpread);
        scope.resolve('uLevels').setValue(s.levels);

        this.drawQuad(outputTarget, this.shader, rect);
    }
}

/**
 * CameraFrame 开启时 legacy `camera.postEffects` 会被引擎忽略；在 compose 前处理 scene texture。
 */
class PalettePixelCameraFrameBridge {
    private readonly effect: PalettePixelPostEffect;
    private outputTarget: RenderTarget | null = null;
    private hookedRenderPassCamera: unknown = null;
    private originalFrameUpdate: (() => void) | null = null;
    private active = false;

    constructor(effect: PalettePixelPostEffect) {
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

    setSettings(settings: PalettePixelSettings): void {
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
            name: 'palette-pixel-scene',
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

export class PalettePixelController {
    private readonly app: AppBase;
    private readonly camera: CameraComponent;
    private readonly effect: PalettePixelPostEffect;
    private readonly cameraFrameBridge: PalettePixelCameraFrameBridge;
    private legacyMounted = false;

    constructor(app: AppBase, camera: CameraComponent) {
        this.app = app;
        this.camera = camera;
        this.effect = new PalettePixelPostEffect(app.graphicsDevice);
        this.cameraFrameBridge = new PalettePixelCameraFrameBridge(this.effect);
    }

    apply(rawSettings: unknown, options?: PalettePixelApplyOptions): void {
        const settings = normalizePalettePixelSettings(rawSettings);
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

        this.app.renderNextFrame = true;
    }

    destroy(): void {
        this.unmountAll();
        this.effect.destroy();
    }

    private mountLegacy(): void {
        if (!this.camera.postEffects) {
            console.warn('[palette-pixel] camera postEffects unavailable — enable CameraFrame / post-processing');
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
        this.app.renderNextFrame = true;
    }
}
