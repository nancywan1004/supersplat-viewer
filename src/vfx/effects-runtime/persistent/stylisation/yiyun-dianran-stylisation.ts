import {
    ADDRESS_CLAMP_TO_EDGE,
    Color,
    Entity,
    FILTER_LINEAR,
    Material,
    PostEffect,
    RenderTarget,
    SEMANTIC_POSITION,
    Shader,
    Texture,
    type AppBase,
    type Camera,
    type CameraComponent,
    type CameraFrame,
    type GraphicsDevice,
    type Layer
} from 'playcanvas';

export type YiyunDianranSettings = {
    enabled: boolean;
    /** 相机全屏后处理（纸张/景深/描边）；关闭时仅保留 GSplat 点着色 */
    postEffectEnabled: boolean;
    saturation: number;
    glowIntensity: number;
    glowColor: [number, number, number];
};

export type YiyunDianranApplyOptions = {
    gsplatEntity: Entity;
    getCameraFrame?: () => CameraFrame | null | undefined;
};

export const DEFAULT_YIYUN_DIANRAN_SETTINGS: YiyunDianranSettings = {
    enabled: false,
    postEffectEnabled: true,
    saturation: 1.2,
    glowIntensity: 0.05,
    glowColor: [0.0, 0.184, 0.655]
};

const INTERNAL_PAPER_COLOR: [number, number, number] = [0.98, 0.94, 0.85];

const clamp = (v: number, min: number, max: number): number => Math.min(max, Math.max(min, v));
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
        clamp(finiteOr(v[0], fallback[0]), 0, 1),
        clamp(finiteOr(v[1], fallback[1]), 0, 1),
        clamp(finiteOr(v[2], fallback[2]), 0, 1)
    ];
};

export function normalizeYiyunDianranSettings(raw: unknown): YiyunDianranSettings {
    const obj = (raw && typeof raw === 'object') ? raw as Record<string, unknown> : {};
    return {
        enabled: !!obj.enabled,
        postEffectEnabled: typeof obj.postEffectEnabled === 'boolean'
            ? obj.postEffectEnabled
            : DEFAULT_YIYUN_DIANRAN_SETTINGS.postEffectEnabled,
        saturation: clamp(finiteOr(obj.saturation, DEFAULT_YIYUN_DIANRAN_SETTINGS.saturation), 1, 1.6),
        glowIntensity: clamp(finiteOr(obj.glowIntensity, DEFAULT_YIYUN_DIANRAN_SETTINGS.glowIntensity), 0, 0.1),
        glowColor: normalizeColor(obj.glowColor, DEFAULT_YIYUN_DIANRAN_SETTINGS.glowColor)
    };
}

type GsplatLikeEntity = Entity & {
    gsplat?: {
        material?: Material | null;
        instance?: { material?: Material | null } | null;
        unified?: boolean;
        layers?: number[];
    };
};

class YiyunDianranPostEffect extends PostEffect {
    private readonly shader: Shader;

    readonly uPaperColor = new Float32Array(INTERNAL_PAPER_COLOR);
    readonly uCameraClip = new Float32Array(2);

    uSaturation = DEFAULT_YIYUN_DIANRAN_SETTINGS.saturation;
    uBrightness = 1.6;
    uOpacity = 0.65;
    uEdgeThreshold = 9.0;
    uEdgeThickness = 3.0;
    uBlurAmount = 0.95;
    uColorSteps = 8.0;
    uBlurStart = 1700.0;
    uBlurEnd = 1900.0;
    uDiscardDepth = 80000.0;

    constructor(graphicsDevice: GraphicsDevice, precision: string) {
        super(graphicsDevice);

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

            uniform sampler2D uColorBuffer;
            uniform sampler2D uSceneDepthMap;

            uniform vec2 uResolution;
            uniform vec3 uPaperColor;
            uniform vec2 uCameraClip;

            uniform float uSaturation;
            uniform float uBrightness;
            uniform float uOpacity;
            uniform float uEdgeThreshold;
            uniform float uEdgeThickness;
            uniform float uBlurAmount;
            uniform float uColorSteps;
            uniform float uBlurStart;
            uniform float uBlurEnd;
            uniform float uDiscardDepth;

            varying vec2 vUv0;

            vec3 rgb2hsv(vec3 c) {
                vec4 K = vec4(0.0, -1.0 / 3.0, 2.0 / 3.0, -1.0);
                vec4 p = mix(vec4(c.bg, K.wz), vec4(c.gb, K.xy), step(c.b, c.g));
                vec4 q = mix(vec4(p.xyw, c.r), vec4(c.r, p.yzx), step(p.x, c.r));
                float d = q.x - min(q.w, q.y);
                float e = 1.0e-10;
                return vec3(abs(q.z + (q.w - q.y) / (6.0 * d + e)), d / (q.x + e), q.x);
            }

            vec3 hsv2rgb(vec3 c) {
                vec4 K = vec4(1.0, 2.0 / 3.0, 1.0 / 3.0, 3.0);
                vec3 p = abs(fract(c.xxx + K.xyz) * 6.0 - K.www);
                return c.z * mix(K.xxx, clamp(p - K.xxx, 0.0, 1.0), c.y);
            }

            float getLinearDepth(float rawDepth) {
                float n = uCameraClip.x;
                float f = uCameraClip.y;
                float z = rawDepth * 2.0 - 1.0;
                return (2.0 * n * f) / (f + n - z * (f - n));
            }

            void main(void) {
                vec2 texel = 1.0 / uResolution;
                vec2 wobbleUv = vUv0 + vec2(
                    sin(vUv0.y * 50.0) * 0.0015,
                    cos(vUv0.x * 50.0) * 0.0015
                );

                vec3 colCenter = texture2D(uColorBuffer, wobbleUv).rgb;

                vec2 bTex = texel * uBlurAmount;
                vec3 b00 = texture2D(uColorBuffer, wobbleUv + vec2(-bTex.x, -bTex.y)).rgb;
                vec3 b01 = texture2D(uColorBuffer, wobbleUv + vec2(0.0, -bTex.y)).rgb;
                vec3 b02 = texture2D(uColorBuffer, wobbleUv + vec2(bTex.x, -bTex.y)).rgb;
                vec3 b10 = texture2D(uColorBuffer, wobbleUv + vec2(-bTex.x, 0.0)).rgb;
                vec3 b12 = texture2D(uColorBuffer, wobbleUv + vec2(bTex.x, 0.0)).rgb;
                vec3 b20 = texture2D(uColorBuffer, wobbleUv + vec2(-bTex.x, bTex.y)).rgb;
                vec3 b21 = texture2D(uColorBuffer, wobbleUv + vec2(0.0, bTex.y)).rgb;
                vec3 b22 = texture2D(uColorBuffer, wobbleUv + vec2(bTex.x, bTex.y)).rgb;

                vec3 blurColor = (b00 + b01 + b02 + b10 + colCenter + b12 + b20 + b21 + b22) / 9.0;
                vec3 posterizedColor = floor(blurColor * uColorSteps) / uColorSteps;

                vec3 hsv = rgb2hsv(posterizedColor);
                hsv.y = clamp(hsv.y * uSaturation, 0.0, 1.0);
                hsv.z = clamp(hsv.z * uBrightness, 0.0, 1.0);
                vec3 adjustedColor = hsv2rgb(hsv);

                vec2 eTex = texel * uEdgeThickness;
                vec3 e00 = texture2D(uColorBuffer, wobbleUv + vec2(-eTex.x, -eTex.y)).rgb;
                vec3 e01 = texture2D(uColorBuffer, wobbleUv + vec2(0.0, -eTex.y)).rgb;
                vec3 e02 = texture2D(uColorBuffer, wobbleUv + vec2(eTex.x, -eTex.y)).rgb;
                vec3 e10 = texture2D(uColorBuffer, wobbleUv + vec2(-eTex.x, 0.0)).rgb;
                vec3 e12 = texture2D(uColorBuffer, wobbleUv + vec2(eTex.x, 0.0)).rgb;
                vec3 e20 = texture2D(uColorBuffer, wobbleUv + vec2(-eTex.x, eTex.y)).rgb;
                vec3 e21 = texture2D(uColorBuffer, wobbleUv + vec2(0.0, eTex.y)).rgb;
                vec3 e22 = texture2D(uColorBuffer, wobbleUv + vec2(eTex.x, eTex.y)).rgb;

                vec3 sx = e00 + 2.0 * e10 + e20 - (e02 + 2.0 * e12 + e22);
                vec3 sy = e00 + 2.0 * e01 + e02 - (e20 + 2.0 * e21 + e22);
                float edge = length(sx) + length(sy);

                vec2 wideTexel = texel * (uBlurAmount + 3.0);
                vec3 dofBlurColor = (
                    texture2D(uColorBuffer, wobbleUv + vec2(-wideTexel.x, -wideTexel.y)).rgb +
                    texture2D(uColorBuffer, wobbleUv + vec2( wideTexel.x, -wideTexel.y)).rgb +
                    texture2D(uColorBuffer, wobbleUv + vec2(-wideTexel.x,  wideTexel.y)).rgb +
                    texture2D(uColorBuffer, wobbleUv + vec2( wideTexel.x,  wideTexel.y)).rgb +
                    colCenter
                ) / 5.0;

                vec3 hsvDof = rgb2hsv(dofBlurColor);
                hsvDof.y = clamp(hsvDof.y * uSaturation, 0.0, 1.0);
                hsvDof.z = clamp(hsvDof.z * uBrightness, 0.0, 1.0);
                vec3 finalDofColor = hsv2rgb(hsvDof);

                float edgeWeight = smoothstep(uEdgeThreshold, uEdgeThreshold + 0.5, edge);
                vec3 finalColor = mix(adjustedColor, uPaperColor, edgeWeight);
                vec3 dofWithEdgeColor = mix(finalDofColor, uPaperColor, edgeWeight);

                float rawDepth = texture2D(uSceneDepthMap, vUv0).r;
                float linearDepth = getLinearDepth(rawDepth);

                float depthBlurWeight = smoothstep(uBlurStart, uBlurEnd, linearDepth);
                finalColor = mix(finalColor, dofWithEdgeColor, depthBlurWeight);

                float discardWeight = smoothstep(uDiscardDepth - 1.0, uDiscardDepth, linearDepth);
                finalColor = mix(finalColor, uPaperColor, discardWeight);

                finalColor = mix(uPaperColor, finalColor, uOpacity);
                gl_FragColor = vec4(finalColor, 1.0);
            }
        `;

        this.shader = new Shader(graphicsDevice, {
            attributes: {
                aPosition: SEMANTIC_POSITION
            },
            vshader,
            fshader
        });
    }

    setSaturation(saturation: number): void {
        this.uSaturation = saturation;
    }

    render(inputTarget: { colorBuffer: Texture }, outputTarget: RenderTarget | null, rect: unknown): void {
        const device = this.device;
        const scope = device.scope;
        const source = inputTarget.colorBuffer;

        scope.resolve('uColorBuffer').setValue(source);
        scope.resolve('uResolution').setValue([source.width, source.height]);
        scope.resolve('uPaperColor').setValue(this.uPaperColor);
        scope.resolve('uCameraClip').setValue(this.uCameraClip);
        scope.resolve('uSaturation').setValue(this.uSaturation);
        scope.resolve('uBrightness').setValue(this.uBrightness);
        scope.resolve('uOpacity').setValue(this.uOpacity);
        scope.resolve('uEdgeThreshold').setValue(this.uEdgeThreshold);
        scope.resolve('uEdgeThickness').setValue(this.uEdgeThickness);
        scope.resolve('uBlurAmount').setValue(this.uBlurAmount);
        scope.resolve('uColorSteps').setValue(this.uColorSteps);
        scope.resolve('uBlurStart').setValue(this.uBlurStart);
        scope.resolve('uBlurEnd').setValue(this.uBlurEnd);
        scope.resolve('uDiscardDepth').setValue(this.uDiscardDepth);

        const depthMap = scope.resolve('uSceneDepthMap').value as Texture | null | undefined;
        if (depthMap) {
            scope.resolve('uSceneDepthMap').setValue(depthMap);
        }

        this.drawQuad(outputTarget, this.shader, rect as any);
    }
}

class YiyunDianranCameraFrameBridge {
    private readonly effect: YiyunDianranPostEffect;
    private outputTarget: RenderTarget | null = null;
    private hookedRenderPassCamera: unknown = null;
    private originalFrameUpdate: (() => void) | null = null;
    private active = false;

    constructor(effect: YiyunDianranPostEffect) {
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

    setSaturation(saturation: number): void {
        this.effect.setSaturation(saturation);
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
            name: 'yiyun-dianran-scene',
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

const GSPLAT_WAVE_GLSL = /* glsl */`
uniform float uTime;
uniform float uThicknessScale;
uniform float uLengthScale;
uniform float uFloatAmplitude;
uniform float uFloatFrequency;
uniform float uSaturation;
uniform float uGlowIntensity;
uniform vec3 uGlowColor;
uniform float uLuminanceThreshold;
uniform float uReplaceProbability;
uniform float uMidLuminanceMin;
uniform float uMidLuminanceMax;
uniform float uMidReplaceProbability;
uniform float uHighLuminanceThreshold;
uniform float uHighReplaceProbability;

float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

vec3 getPaletteColor(int index) {
    if(index == 0) return vec3(0.910, 0.231, 0.545);
    if(index == 1) return vec3(0.722, 0.000, 0.345);
    if(index == 2) return vec3(0.000, 0.710, 0.886);
    if(index == 3) return vec3(0.086, 0.306, 0.667);
    if(index == 4) return vec3(1.000, 0.831, 0.227);
    if(index == 5) return vec3(1.000, 0.478, 0.133);
    if(index == 6) return vec3(0.541, 0.169, 0.886);
    if(index == 7) return vec3(1.000, 0.620, 0.824);
    if(index == 8) return vec3(0.294, 0.000, 0.510);
    if(index == 9) return vec3(1.000, 0.271, 0.000);
    if(index == 10) return vec3(0.702, 0.620, 0.710);
    if(index == 11) return vec3(0.000, 0.545, 0.545);
    if(index == 12) return vec3(1.000, 0.690, 0.486);
    if(index == 13) return vec3(0.169, 0.000, 0.341);
    if(index == 14) return vec3(0.498, 1.000, 0.831);
    return vec3(0.863, 0.078, 0.235);
}

vec3 getMidPaletteColor(int index) {
    if(index == 0) return vec3(0.280, 0.720, 0.800);
    if(index == 1) return vec3(0.120, 0.580, 0.640);
    if(index == 2) return vec3(0.990, 0.230, 0.130);
    if(index == 3) return vec3(0.990, 0.410, 0.420);
    if(index == 4) return vec3(0.990, 0.760, 0.430);
    if(index == 5) return vec3(0.650, 0.570, 0.820);
    if(index == 6) return vec3(0.420, 0.680, 0.890);
    return vec3(0.020, 0.450, 0.510);
}

vec3 getHighPaletteColor(int index) {
    if(index == 0) return vec3(0.702, 0.831, 1.000);
    if(index == 1) return vec3(0.980, 0.859, 0.663);
    if(index == 2) return vec3(0.820, 0.820, 0.922);
    if(index == 3) return vec3(0.690, 0.886, 0.910);
    if(index == 4) return vec3(0.894, 0.722, 0.706);
    return vec3(1.000, 0.973, 0.863);
}

void modifySplatCenter(inout vec3 center) {
    vec3 originalCenter = center;
    float seed = hash(originalCenter);
    float waveY = sin(uTime * uFloatFrequency + originalCenter.x * 3.5 + originalCenter.z * 3.5 + seed * 6.28);
    float waveX = cos(uTime * uFloatFrequency * 0.6 + originalCenter.y * 4.0 + seed);
    float waveZ = sin(uTime * uFloatFrequency * 0.8 + originalCenter.x * 4.0 - seed);
    vec3 floatOffset = vec3(waveX * 0.3, waveY, waveZ * 0.3) * uFloatAmplitude;
    center += floatOffset;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float originalSize = length(scale);
    float longAxis = originalSize * uLengthScale;
    float shortAxis = originalSize * uThicknessScale;
    float seed = fract(sin(dot(originalCenter, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
    if (seed < 0.33) { scale = vec3(longAxis, shortAxis, shortAxis); }
    else if (seed < 0.66) { scale = vec3(shortAxis, longAxis, shortAxis); }
    else { scale = vec3(shortAxis, shortAxis, longAxis); }
}

void modifySplatColor(vec3 center, inout vec4 color) {
    float luminance = dot(color.rgb, vec3(0.299, 0.587, 0.114));

    if (luminance < uLuminanceThreshold) {
        float seedForReplace = fract(sin(dot(center, vec3(12.9898, 78.233, 45.164))) * 43758.5453);
        if (seedForReplace < uReplaceProbability) {
            float seedForColor = fract(sin(dot(center, vec3(93.989, 67.345, 54.256))) * 23421.631);
            color.rgb = getPaletteColor(int(seedForColor * 16.0));
            return;
        }
    } else if (luminance > uHighLuminanceThreshold) {
        float seedForReplaceHigh = fract(sin(dot(center, vec3(45.164, 12.9898, 78.233))) * 43758.5453);
        if (seedForReplaceHigh < uHighReplaceProbability) {
            float seedForColorHigh = fract(sin(dot(center, vec3(54.256, 93.989, 67.345))) * 23421.631);
            color.rgb = getHighPaletteColor(int(seedForColorHigh * 6.0));
            return;
        }
    } else if (luminance >= uMidLuminanceMin && luminance <= uMidLuminanceMax) {
        float seedForReplaceMid = fract(sin(dot(center, vec3(78.233, 45.164, 12.9898))) * 43758.5453);
        if (seedForReplaceMid < uMidReplaceProbability) {
            float seedForColorMid = fract(sin(dot(center, vec3(67.345, 54.256, 93.989))) * 23421.631);
            color.rgb = getMidPaletteColor(int(seedForColorMid * 8.0));
            return;
        }
    }

    vec3 grayscale = vec3(luminance);
    color.rgb = mix(grayscale, color.rgb, uSaturation);
    color.rgb += uGlowColor * uGlowIntensity;
    color.rgb = clamp(color.rgb, 0.0, 4.0);
}
`;

export class YiyunDianranController {
    private readonly app: AppBase;
    private readonly camera: CameraComponent;
    private readonly effect: YiyunDianranPostEffect;
    private readonly cameraFrameBridge: YiyunDianranCameraFrameBridge;
    private settings: YiyunDianranSettings = DEFAULT_YIYUN_DIANRAN_SETTINGS;
    private legacyMounted = false;
    private targetGsplat: GsplatLikeEntity | null = null;
    private readonly materialsApplied = new Set<Material>();
    private materialCreatedHandler: ((material: Material, camera: Camera, layer: Layer) => void) | null = null;
    private readonly glowColorArray = new Float32Array(3);
    private effectTime = 0;
    private originalClearColor: Color | null = null;

    constructor(app: AppBase, camera: CameraComponent) {
        this.app = app;
        this.camera = camera;
        this.effect = new YiyunDianranPostEffect(app.graphicsDevice, app.graphicsDevice.precision);
        this.cameraFrameBridge = new YiyunDianranCameraFrameBridge(this.effect);
    }

    apply(rawSettings: unknown, options: YiyunDianranApplyOptions): void {
        this.settings = normalizeYiyunDianranSettings(rawSettings);
        this.targetGsplat = options.gsplatEntity as GsplatLikeEntity;
        this.effect.setSaturation(this.settings.saturation);
        this.cameraFrameBridge.setSaturation(this.settings.saturation);

        if (!this.settings.enabled) {
            this.unmountAll();
            return;
        }

        if (this.settings.postEffectEnabled) {
            this.mountPostProcessing(options.getCameraFrame);
        } else {
            this.unmountPostProcessing();
        }

        this.setupGsplatShader();
        this.syncGsplatUniforms();
        this.app.renderNextFrame = true;
    }

    tick(dt: number): void {
        if (!this.settings.enabled) {
            return;
        }
        this.effectTime += dt;
        this.syncGsplatUniforms();
        this.app.renderNextFrame = true;
    }

    setEffectTime(time: number): void {
        this.effectTime = Math.max(0, time);
        this.syncGsplatUniforms();
        this.app.renderNextFrame = true;
    }

    setPostEffectEnabled(enabled: boolean, getCameraFrame?: () => CameraFrame | null | undefined): void {
        this.settings = {
            ...this.settings,
            postEffectEnabled: enabled
        };
        if (enabled) {
            this.mountPostProcessing(getCameraFrame);
        } else {
            this.unmountPostProcessing();
        }
        this.app.renderNextFrame = true;
    }

    private mountPostProcessing(getCameraFrame?: () => CameraFrame | null | undefined): void {
        const cameraFrame = getCameraFrame?.();
        if (cameraFrame?.enabled && this.cameraFrameBridge.mount(cameraFrame)) {
            this.unmountLegacy();
        } else {
            this.cameraFrameBridge.unmount();
            this.mountLegacy();
        }
        this.applyCameraState();
    }

    private unmountPostProcessing(): void {
        this.cameraFrameBridge.unmount();
        this.unmountLegacy();
        this.restoreClearColor();
    }

    private mountLegacy(): void {
        if (!this.camera.postEffects) {
            console.warn('[yiyun-dianran] camera postEffects unavailable');
            return;
        }
        this.camera.requestSceneDepthMap(true);
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
        this.unmountPostProcessing();
        this.removeGsplatShader();
        this.targetGsplat = null;
        this.app.renderNextFrame = true;
    }

    private applyCameraState(): void {
        this.effect.uSaturation = this.settings.saturation;
        this.effect.uPaperColor[0] = INTERNAL_PAPER_COLOR[0];
        this.effect.uPaperColor[1] = INTERNAL_PAPER_COLOR[1];
        this.effect.uPaperColor[2] = INTERNAL_PAPER_COLOR[2];
        this.effect.uCameraClip[0] = this.camera.nearClip;
        this.effect.uCameraClip[1] = this.camera.farClip;

        if (!this.originalClearColor) {
            this.originalClearColor = this.camera.clearColor.clone();
        }
        this.camera.requestSceneDepthMap(true);
        this.camera.clearColorBuffer = true;
        this.camera.clearColor = new Color(
            INTERNAL_PAPER_COLOR[0],
            INTERNAL_PAPER_COLOR[1],
            INTERNAL_PAPER_COLOR[2],
            1
        );
    }

    private restoreClearColor(): void {
        if (!this.originalClearColor) {
            return;
        }
        this.camera.clearColor = this.originalClearColor.clone();
        this.originalClearColor = null;
    }

    private setupGsplatShader(): void {
        const gsplat = this.targetGsplat?.gsplat;
        if (!gsplat) {
            return;
        }

        if (gsplat.unified) {
            this.setupUnifiedMaterialListener();
            this.updateUnifiedMaterials();
            return;
        }

        const material = gsplat.material ?? gsplat.instance?.material ?? null;
        if (!material) {
            return;
        }

        this.applyShaderToMaterial(material);
        this.materialsApplied.add(material);
    }

    private setupUnifiedMaterialListener(): void {
        if (this.materialCreatedHandler) {
            return;
        }
        // @ts-ignore runtime gsplat system
        const gsplatSystem = this.app.systems.gsplat;
        if (!gsplatSystem) {
            return;
        }

        this.materialCreatedHandler = (material: Material, camera: Camera, _layer: Layer) => {
            if (!this.settings.enabled) {
                return;
            }
            if (this.camera.camera !== camera) {
                return;
            }
            if (this.materialsApplied.has(material)) {
                return;
            }
            this.applyShaderToMaterial(material);
            this.materialsApplied.add(material);
            this.syncGsplatUniforms();
        };

        gsplatSystem.on('material:created', this.materialCreatedHandler);
    }

    private updateUnifiedMaterials(): void {
        const gsplat = this.targetGsplat?.gsplat;
        if (!gsplat?.layers?.length) {
            return;
        }

        // @ts-ignore runtime gsplat system
        const gsplatSystem = this.app.systems.gsplat;
        if (!gsplatSystem) {
            return;
        }

        const composition = this.app.scene.layers;
        const targetCameras = this.camera.camera
            ? [this.camera.camera]
            : composition.cameras.map((cameraComponent) => cameraComponent.camera);

        targetCameras.forEach((camera) => {
            gsplat.layers?.forEach((layerId) => {
                if (camera.layers.indexOf(layerId) < 0) {
                    return;
                }
                const layer = composition.getLayerById(layerId);
                if (!layer) {
                    return;
                }
                const material = gsplatSystem.getGSplatMaterial(camera, layer);
                if (!material || this.materialsApplied.has(material)) {
                    return;
                }
                this.applyShaderToMaterial(material);
                this.materialsApplied.add(material);
            });
        });
    }

    private applyShaderToMaterial(material: Material): void {
        material.getShaderChunks('glsl').set('gsplatModifyVS', GSPLAT_WAVE_GLSL);
        material.update();
    }

    private removeGsplatShader(): void {
        this.materialsApplied.forEach((material) => {
            material.getShaderChunks('glsl').delete('gsplatModifyVS');
            material.update();
        });
        this.materialsApplied.clear();

        if (this.materialCreatedHandler) {
            // @ts-ignore runtime gsplat system
            this.app.systems.gsplat?.off('material:created', this.materialCreatedHandler);
            this.materialCreatedHandler = null;
        }
    }

    private syncGsplatUniforms(): void {
        if (this.materialsApplied.size === 0) {
            return;
        }

        this.glowColorArray[0] = this.settings.glowColor[0];
        this.glowColorArray[1] = this.settings.glowColor[1];
        this.glowColorArray[2] = this.settings.glowColor[2];

        this.materialsApplied.forEach((material) => {
            material.setParameter('uTime', this.effectTime);
            material.setParameter('uThicknessScale', 0.35);
            material.setParameter('uLengthScale', 0.75);
            material.setParameter('uFloatAmplitude', 0.0);
            material.setParameter('uFloatFrequency', 1.0);
            material.setParameter('uSaturation', this.settings.saturation);
            material.setParameter('uGlowIntensity', this.settings.glowIntensity);
            material.setParameter('uGlowColor', this.glowColorArray);
            material.setParameter('uLuminanceThreshold', 0.15);
            material.setParameter('uReplaceProbability', 0.03);
            material.setParameter('uMidLuminanceMin', 0.35);
            material.setParameter('uMidLuminanceMax', 0.65);
            material.setParameter('uMidReplaceProbability', 0.1);
            material.setParameter('uHighLuminanceThreshold', 0.85);
            material.setParameter('uHighReplaceProbability', 0.5);
        });
    }
}
