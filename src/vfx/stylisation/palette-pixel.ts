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
    ["#000649", "#62adb4", "#245e7c", "#2c4fa8", "#814bba", "#62daff", "#faa762", "#ffc5e9", "#cdfab1", "#90A8BD", "#9DB6C5", "#ba931f", "#a0f8d3", "#a5d8f3", "#b789f7", "#86cce6", "#a9f4db", "#f8baff", "#8cff7f", "#ffff9d"]
] as const;

export type PalettePixelSettings = {
    enabled: boolean;
    pixelSize: number;
    paletteIndex: number;
    levels: number;
    /**
     * 色阶映射域（色盘一行 {@link PALETTE_LUMA_STEP_COUNT} 色）：1 不变。
     * [0,1)：先把场景明度域映射到色盘占用索引段（如 5~11），再绕占用段中心向内压缩。
     * (1,2]：同样绕占用段中心向外扩张（乘系数），不仅扩大可搜索范围，也会同步放大原始命中索引位移。
     */
    levelRange: number;
    ditherSpread: number;
};

export const DEFAULT_PALETTE_PIXEL_SETTINGS: PalettePixelSettings = {
    enabled: false,
    pixelSize: 300,
    paletteIndex: 5,
    levels: 12,
    levelRange: 1,
    ditherSpread: 0.05
};

/** 马赛克大小可选档位（与产品配置表一致） */
export const PALETTE_PIXEL_SIZE_STEPS = [300, 400, 500, 600, 700, 800, 900] as const;

/** 色盘每行按明度排列的颜色数（与 shader `PALETTE_STEPS` 一致） */
export const PALETTE_LUMA_STEP_COUNT = 20;

const LUMA_DOMAIN_ANALYSIS_SIZE = 48;

const LUMA_DOMAIN_ANALYSIS_INTERVAL_FRAMES = 24;

const lumaFromRgb = (r: number, g: number, b: number): number =>
    0.299 * r + 0.587 * g + 0.114 * b;

const finalizeSceneLumaDomain = (min: number, max: number): { min: number; max: number } => {
    let lo = Math.min(min, max);
    let hi = Math.max(min, max);
    if (hi - lo < 0.02) {
        const c = (lo + hi) * 0.5;
        lo = c - 0.01;
        hi = c + 0.01;
    }
    return {
        min: Math.max(0, Math.min(1, lo)),
        max: Math.max(0, Math.min(1, hi))
    };
};

/** 估计当前画面在色盘上占用的明度域（用于 levelRange≠1 的压缩/拉伸）。 */
export async function estimateSceneLumaDomain(
    device: GraphicsDevice,
    texture: Texture
): Promise<{ min: number; max: number }> {
    const w = Math.min(LUMA_DOMAIN_ANALYSIS_SIZE, texture.width);
    const h = Math.min(LUMA_DOMAIN_ANALYSIS_SIZE, texture.height);
    if (w < 1 || h < 1) {
        return { min: 0, max: 1 };
    }

    const readTextureAsync = (device as GraphicsDevice & {
        readTextureAsync?: (
            tex: Texture,
            x: number,
            y: number,
            width: number,
            height: number,
            options?: { immediate?: boolean }
        ) => Promise<Uint8Array>;
    }).readTextureAsync;

    if (!readTextureAsync) {
        return { min: 0, max: 1 };
    }

    try {
        const data = await readTextureAsync(texture, 0, 0, w, h, { immediate: true });
        let min = 1;
        let max = 0;
        for (let i = 0, n = w * h; i < n; i++) {
            const o = i * 4;
            const l = lumaFromRgb(data[o] / 255, data[o + 1] / 255, data[o + 2] / 255);
            if (l < min) min = l;
            if (l > max) max = l;
        }
        const pad = Math.max(0.01, (max - min) * 0.04);
        return finalizeSceneLumaDomain(min - pad, max + pad);
    } catch {
        return { min: 0, max: 1 };
    }
}

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

/**
 * 兼容两种 levelRange 输入协议：
 * - 旧协议：直接传 [0,2]；
 * - 新协议：UI 在 >1 分段映射到 [0,20]（表示有效色数）。
 *   这里将 [0,20] 映射回 shader 使用的 [1,2]。
 */
const normalizeLevelRange = (raw: unknown): number => {
    const v = finiteOr(raw, DEFAULT_PALETTE_PIXEL_SETTINGS.levelRange);
    if (v > 2) {
        const effectiveCount = clamp(v, 0, PALETTE_LUMA_STEP_COUNT);
        return clamp(1 + (effectiveCount / PALETTE_LUMA_STEP_COUNT), 1, 2);
    }
    return clamp(v, 0, 2);
};

export function normalizePalettePixelSettings(raw: unknown): PalettePixelSettings {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        enabled: !!obj.enabled,
        pixelSize: snapPixelSize(clamp(finiteOr(obj.pixelSize, DEFAULT_PALETTE_PIXEL_SETTINGS.pixelSize), 300, 900)),
        // 业务定义：有效编号仅 1~7，明确去掉 0 号位
        paletteIndex: clamp(Math.floor(finiteOr(obj.paletteIndex, DEFAULT_PALETTE_PIXEL_SETTINGS.paletteIndex)), 1, 7),
        levels: clamp(Math.floor(finiteOr(obj.levels, DEFAULT_PALETTE_PIXEL_SETTINGS.levels)), 2, 20),
        levelRange: normalizeLevelRange(obj.levelRange),
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

/** 在当前色盘行上，找与给定明度最接近的色块索引（0~19）。 */
const nearestPaletteIndexForLuma = (paletteRow: number, luma: number): number => {
    const row = PALETTES_HEX[Math.max(0, Math.min(6, paletteRow))];
    let bestIdx = 0;
    let bestDiff = Infinity;
    for (let i = 0; i < PALETTE_LUMA_STEP_COUNT; i++) {
        const [r, g, b] = hexToRgb(row[i]);
        const diff = Math.abs(lumaFromRgb(r, g, b) - luma);
        if (diff < bestDiff) {
            bestDiff = diff;
            bestIdx = i;
        }
    }
    return bestIdx;
};

/** 场景明度域在色盘行上占用的索引区间 [min, max]（如 luma 域 → 5~11）。 */
export const scenePaletteIndexRange = (
    paletteRow: number,
    lumaMin: number,
    lumaMax: number
): { min: number; max: number } => {
    let min = nearestPaletteIndexForLuma(paletteRow, lumaMin);
    let max = nearestPaletteIndexForLuma(paletteRow, lumaMax);
    if (min > max) {
        const t = min;
        min = max;
        max = t;
    }
    return { min, max };
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

    lumaDomainMin = 0;

    lumaDomainMax = 1;

    /** 场景明度域映射到当前色盘行的占用索引（压缩时绕 (min+max)/2 收拢）。 */
    scenePaletteIdxMin = 0;

    scenePaletteIdxMax = PALETTE_LUMA_STEP_COUNT - 1;

    private lumaAnalysisInFlight = false;

    private framesUntilLumaAnalysis = 0;

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
            uniform float uLevelRange;
            uniform float uLumaDomainMin;
            uniform float uLumaDomainMax;
            uniform float uScenePaletteIdxMin;
            uniform float uScenePaletteIdxMax;

            const float PALETTE_STEPS = 20.0;

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
                float domainSpan = max(uLumaDomainMax - uLumaDomainMin, 0.001);
                float paletteIdxMax = PALETTE_STEPS - 1.0;
                float sceneT = clamp((ditheredLuma - uLumaDomainMin) / domainSpan, 0.0, 1.0);
                float sceneIdxMin = uScenePaletteIdxMin;
                float sceneIdxMax = uScenePaletteIdxMax;
                float centerIdx = (sceneIdxMin + sceneIdxMax) * 0.5;

                float targetIdx;
                float searchMin = 0.0;
                float searchMax = paletteIdxMax;

                if (uLevelRange < 1.0) {
                    // [0,1)：绕占用段中心向内压缩（如 5~11 绕 8）
                    float ratio = uLevelRange;
                    float fullIdx = mix(sceneIdxMin, sceneIdxMax, sceneT);
                    float baseHalfSpan = max((sceneIdxMax - sceneIdxMin) * 0.5, 0.5);
                    float mappedHalfSpan = max(baseHalfSpan * ratio, 0.5);
                    targetIdx = centerIdx + (fullIdx - centerIdx) * ratio;
                    searchMin = max(0.0, centerIdx - mappedHalfSpan);
                    searchMax = min(paletteIdxMax, centerIdx + mappedHalfSpan);
                } else if (uLevelRange > 1.0) {
                    // (1,2]：绕占用段中心向外扩张（乘系数），原命中索引位移也同步放大
                    float ratio = uLevelRange;
                    float fullIdx = mix(sceneIdxMin, sceneIdxMax, sceneT);
                    float baseHalfSpan = max((sceneIdxMax - sceneIdxMin) * 0.5, 0.5);
                    float mappedHalfSpan = min(baseHalfSpan * ratio, PALETTE_STEPS * 0.5);
                    targetIdx = centerIdx + (fullIdx - centerIdx) * ratio;
                    searchMin = max(0.0, centerIdx - mappedHalfSpan);
                    searchMax = min(paletteIdxMax, centerIdx + mappedHalfSpan);
                } else {
                    targetIdx = mix(sceneIdxMin, sceneIdxMax, sceneT);
                    searchMin = sceneIdxMin;
                    searchMax = sceneIdxMax;
                }

                targetIdx = clamp(targetIdx, searchMin, searchMax);

                float idxSpan = max(searchMax - searchMin, 0.001);
                float steps = max(1.0, uLevels - 1.0);
                float idxT = (targetIdx - searchMin) / idxSpan;
                float quantizedT = floor(idxT * steps + 0.5) / steps;
                float finalIdx = clamp(searchMin + quantizedT * idxSpan, 0.0, paletteIdxMax);

                float vTex = (uPaletteRow + 0.5) / 7.0;
                float uTex = (floor(finalIdx + 0.5) + 0.5) / PALETTE_STEPS;
                vec3 bestColor = texture2D(uPaletteTex, vec2(uTex, vTex)).rgb;

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
        if (this.settings.levelRange !== 1) {
            this.framesUntilLumaAnalysis = 0;
        }
        this.updateScenePaletteOccupancy();
    }

    resetLumaDomain(): void {
        this.lumaDomainMin = 0;
        this.lumaDomainMax = 1;
        this.updateScenePaletteOccupancy();
    }

    private updateScenePaletteOccupancy(): void {
        const row = this.settings.paletteIndex - 1;
        const { min, max } = scenePaletteIndexRange(row, this.lumaDomainMin, this.lumaDomainMax);
        this.scenePaletteIdxMin = min;
        this.scenePaletteIdxMax = max;
    }

    requestLumaDomainAnalysis(sourceTexture: Texture | null | undefined): void {
        if (!sourceTexture || this.settings.levelRange === 1) {
            return;
        }
        if (this.lumaAnalysisInFlight) {
            return;
        }
        if (this.framesUntilLumaAnalysis > 0) {
            this.framesUntilLumaAnalysis--;
            return;
        }
        this.framesUntilLumaAnalysis = LUMA_DOMAIN_ANALYSIS_INTERVAL_FRAMES;
        this.lumaAnalysisInFlight = true;
        estimateSceneLumaDomain(this.device, sourceTexture)
            .then(({ min, max }) => {
                this.lumaDomainMin = min;
                this.lumaDomainMax = max;
                this.updateScenePaletteOccupancy();
            })
            .catch(() => { /* keep previous domain */ })
            .finally(() => {
                this.lumaAnalysisInFlight = false;
            });
    }

    destroy(): void {
        this.paletteTex.destroy();
    }

    render(inputTarget: any, outputTarget: any, rect: any): void {
        const colorBuffer = inputTarget?.colorBuffer as Texture | undefined;
        this.requestLumaDomainAnalysis(colorBuffer);

        const scope = this.device.scope;
        const s = this.settings;
        const paletteRow = s.paletteIndex - 1;
        if (s.levelRange !== 1) {
            this.updateScenePaletteOccupancy();
        }

        scope.resolve('uColorBuffer').setValue(colorBuffer);
        scope.resolve('uPaletteTex').setValue(this.paletteTex);
        scope.resolve('uPixelSize').setValue(s.pixelSize);
        scope.resolve('uPaletteRow').setValue(paletteRow);
        scope.resolve('uDitherSpread').setValue(s.ditherSpread);
        scope.resolve('uLevels').setValue(s.levels);
        scope.resolve('uLevelRange').setValue(s.levelRange);
        scope.resolve('uLumaDomainMin').setValue(this.lumaDomainMin);
        scope.resolve('uLumaDomainMax').setValue(this.lumaDomainMax);
        scope.resolve('uScenePaletteIdxMin').setValue(this.scenePaletteIdxMin);
        scope.resolve('uScenePaletteIdxMax').setValue(this.scenePaletteIdxMax);

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
            this.effect.resetLumaDomain();
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
