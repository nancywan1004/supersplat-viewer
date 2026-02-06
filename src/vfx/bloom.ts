import {
    CameraFrame,
    ShaderChunks,
    Texture,
    PIXELFORMAT_R8,
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR
} from 'playcanvas';
import type { PostEffectSettings } from '../settings';
import type { Global } from '../types';
import { BloomBrushPainter } from './bloom-brush-painter';

const MASK_SIZE = 512;

const composeBloomPSGlsl = `
#ifdef BLOOM
uniform sampler2D bloomTexture;
uniform float bloomIntensity;
uniform sampler2D bloomMaskTexture;
uniform float bloomThreshold;
vec3 dBloom;
vec3 applyBloom(vec3 color, vec2 uv) {
    dBloom = texture2DLod(bloomTexture, uv, 0.0).rgb;
    float mask = texture2DLod(bloomMaskTexture, uv, 0.0).r;
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float brightPass = step(bloomThreshold, lum);
    return color + dBloom * bloomIntensity * mask * brightPass;
}
#endif
`;

const composeBloomPSWgsl = `
#ifdef BLOOM
var bloomTexture: texture_2d<f32>;
var bloomTextureSampler: sampler;
var bloomMaskTexture: texture_2d<f32>;
var bloomMaskTextureSampler: sampler;
uniform bloomIntensity: f32;
uniform bloomThreshold: f32;
var<private> dBloom: vec3f;
fn applyBloom(color: vec3f, uv: vec2f) -> vec3f {
    dBloom = textureSampleLevel(bloomTexture, bloomTextureSampler, uv, 0.0).rgb;
    let mask = textureSampleLevel(bloomMaskTexture, bloomMaskTextureSampler, uv, 0.0).r;
    let lum = dot(color, vec3f(0.2126, 0.7152, 0.0722));
    let brightPass = select(0.0, 1.0, lum >= uniform.bloomThreshold);
    return color + dBloom * uniform.bloomIntensity * mask * brightPass;
}
#endif
`;

export interface BloomControllerOptions {
    /** 用于每帧把 bloom mask 写入 scope；在 viewer 有 cameraFrame 时由 controller 调用 */
    getCameraFrame: () => CameraFrame | null;
    /** 用于 BloomBrushPainter 与坐标映射 */
    getAppCanvas: () => HTMLCanvasElement | null;
    /** 用于 Night Mode + Bloom Brush 合成时传入 mask */
    getNightModeScript: () => { setBloomBrushParams(active: boolean, mask: Texture | null, threshold: number, modelViewProj?: Float32Array): void } | null;
}

/**
 * 统一管理所有 Bloom 相关逻辑，避免在 gsplat 实体上挂载 BloomDebugFilter/BloomBrushFilter，
 * 防止覆盖 reveal 的 gsplatCustomizeVS 导致进入 viewer 时 reveal 动画消失。
 * - Bloom 强度/模糊/Threshold：通过 CameraFrame 与 compose 阶段 scope 控制。
 * - Bloom Brush：仅使用 mask 纹理在 compose 阶段乘 bloom，不修改 gsplat shader。
 * - Bloom Debug（仅亮部参与绘制）：不在此处实现，避免与 reveal 争用同一材质 chunk。
 */
export class BloomController {
    private global: Global;
    private options: BloomControllerOptions;
    private bloomBrushWhiteTexture: Texture | null = null;
    private bloomCommittedMaskTexture: Texture | null = null;
    private hasCommittedBloomMask = false;
    private bloomBrushPainter: BloomBrushPainter | null = null;
    private _cameraFrameUpdateWrapped = false;
    private _unregisterFrameUpdate: (() => void) | null = null;
    private _unregisterEvents: (() => void)[] = [];

    constructor(global: Global, options: BloomControllerOptions) {
        this.global = global;
        this.options = options;
        const { app } = global;
        const graphicsDevice = app.graphicsDevice;
        if (!graphicsDevice) return;

        const glsl = ShaderChunks.get(graphicsDevice, 'glsl');
        const wgsl = ShaderChunks.get(graphicsDevice, 'wgsl');
        glsl.set('composeBloomPS', composeBloomPSGlsl);
        wgsl.set('composeBloomPS', composeBloomPSWgsl);

        const whiteCanvas = document.createElement('canvas');
        whiteCanvas.width = 1;
        whiteCanvas.height = 1;
        const whiteCtx = whiteCanvas.getContext('2d')!;
        whiteCtx.fillStyle = '#ffffff';
        whiteCtx.fillRect(0, 0, 1, 1);
        this.bloomBrushWhiteTexture = new Texture(graphicsDevice, {
            name: 'bloomBrushWhite',
            width: 1,
            height: 1,
            format: PIXELFORMAT_R8,
            mipmaps: false
        });
        this.bloomBrushWhiteTexture.setSource(whiteCanvas);
        this.bloomBrushWhiteTexture.upload();

        const appCanvas = options.getAppCanvas();
        if (appCanvas) {
            this.bloomBrushPainter = new BloomBrushPainter({
                device: graphicsDevice,
                appCanvas
            });
            this.bloomCommittedMaskTexture = new Texture(graphicsDevice, {
                name: 'bloomCommittedMask',
                width: MASK_SIZE,
                height: MASK_SIZE,
                format: PIXELFORMAT_R8,
                addressU: ADDRESS_CLAMP_TO_EDGE,
                addressV: ADDRESS_CLAMP_TO_EDGE,
                minFilter: FILTER_LINEAR,
                magFilter: FILTER_LINEAR,
                mipmaps: false
            });
            const blackCanvas = document.createElement('canvas');
            blackCanvas.width = MASK_SIZE;
            blackCanvas.height = MASK_SIZE;
            const blackCtx = blackCanvas.getContext('2d')!;
            blackCtx.fillStyle = '#000000';
            blackCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
            this.bloomCommittedMaskTexture.setSource(blackCanvas);
            this.bloomCommittedMaskTexture.upload();
        }

        const onFrameUpdate = () => {
            const cameraFrame = options.getCameraFrame();
            if (!cameraFrame || !global.settings.postEffectSettings?.bloom?.enabled) return;
            const bloom = global.settings.postEffectSettings.bloom as { bloomBrush?: boolean; threshold?: number };
            if (bloom.bloomBrush && this.bloomBrushPainter) this.bloomBrushPainter.flushUpload();
            const maskTex = bloom.bloomBrush && this.bloomBrushPainter
                ? this.bloomBrushPainter.getTexture()
                : (this.hasCommittedBloomMask && this.bloomCommittedMaskTexture)
                    ? this.bloomCommittedMaskTexture
                    : this.bloomBrushWhiteTexture;
            try {
                if (maskTex) graphicsDevice.scope.resolve('bloomMaskTexture').setValue(maskTex);
                const th = Math.max(0, Math.min(5, Number(bloom.threshold ?? 0.2)));
                graphicsDevice.scope.resolve('bloomThreshold').setValue(th);
            } catch (_) {}
        };
        app.on('frameUpdate', onFrameUpdate);
        this._unregisterFrameUpdate = () => app.off('frameUpdate', onFrameUpdate);

        const { events } = global;
        events.on('bloomBrush:clear', () => {
            this.bloomBrushPainter?.clear();
            (this.global.app as any).renderNextFrame = true;
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:clear'));

        events.on('bloomBrush:set', () => {
            if (this.bloomBrushPainter && this.bloomCommittedMaskTexture) {
                this.bloomBrushPainter.copyMaskTo(this.bloomCommittedMaskTexture);
                this.hasCommittedBloomMask = true;
                (this.global.app as any).renderNextFrame = true;
            }
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:set'));
    }

    /**
     * 对 CameraFrame 应用 bloom 参数（intensity、blurLevel、debug），并注入 update 前设置 mask。
     */
    applyToCameraFrame(cameraFrame: CameraFrame, settings: PostEffectSettings): void {
        const { bloom } = cameraFrame;
        const bloomSettings = settings.bloom as {
            enabled?: boolean;
            intensity?: number;
            blurLevel?: number;
            bloomDebug?: boolean;
            bloomBrush?: boolean;
            bloomBrushSize?: number;
            threshold?: number;
        };
        const bloomDebug = !!bloomSettings.bloomDebug;
        const bloomBrush = !!bloomSettings.bloomBrush;
        const th = Math.max(0, Math.min(5, Number(bloomSettings.threshold ?? 0.2)));

        if (bloomSettings.enabled) {
            bloom.intensity = Math.max(0, Math.min(0.2, Number(bloomSettings.intensity)));
            bloom.blurLevel = bloomSettings.blurLevel ?? 2;
            cameraFrame.debug = bloomDebug ? 'bloom' : null;
        } else {
            bloom.intensity = 0;
            cameraFrame.debug = null;
        }

        const nightModeScript = this.options.getNightModeScript();
        const nightModeOn = (nightModeScript as any)?.isNightModeEnabled ?? false;
        const bloomBrushWithNight = bloomBrush && nightModeOn;
        if (this.bloomBrushPainter) {
            this.bloomBrushPainter.setEnabled(bloomBrush);
            this.bloomBrushPainter.setBrushSize(Math.max(1, Math.min(200, Number(bloomSettings.bloomBrushSize ?? 30))));
        }
        if (nightModeScript) {
            const mask = bloomBrushWithNight ? this.bloomBrushPainter?.getTexture() ?? null : null;
            nightModeScript.setBloomBrushParams(bloomBrushWithNight, mask, th, undefined);
        }

        this.injectBloomMaskBeforeUpdate(cameraFrame);
    }

    private setBloomMaskInScope(): void {
        const graphicsDevice = this.global.app.graphicsDevice;
        const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrush?: boolean; threshold?: number } | undefined;
        const maskTex = (bloom?.bloomBrush && this.bloomBrushPainter)
            ? this.bloomBrushPainter.getTexture()
            : (this.hasCommittedBloomMask && this.bloomCommittedMaskTexture)
                ? this.bloomCommittedMaskTexture
                : this.bloomBrushWhiteTexture;
        try {
            if (maskTex) graphicsDevice.scope.resolve('bloomMaskTexture').setValue(maskTex);
            const th = Math.max(0, Math.min(5, Number(bloom?.threshold ?? 0.2)));
            graphicsDevice.scope.resolve('bloomThreshold').setValue(th);
        } catch (_) {}
    }

    private injectBloomMaskBeforeUpdate(cameraFrame: CameraFrame): void {
        const setBloomMask = () => this.setBloomMaskInScope();
        if (!this._cameraFrameUpdateWrapped) {
            this._cameraFrameUpdateWrapped = true;
            const orig = cameraFrame.update.bind(cameraFrame);
            cameraFrame.update = () => {
                setBloomMask();
                orig();
            };
        } else {
            setBloomMask();
        }
    }

    /** 当 CameraFrame 被销毁时调用，重置包装状态 */
    onCameraFrameDestroyed(): void {
        this._cameraFrameUpdateWrapped = false;
    }

    destroy(): void {
        this._unregisterFrameUpdate?.();
        this._unregisterFrameUpdate = null;
        this._unregisterEvents.forEach((fn) => fn());
        this._unregisterEvents = [];
        this.bloomBrushPainter = null;
        this.bloomBrushWhiteTexture = null;
        this.bloomCommittedMaskTexture = null;
    }
}
