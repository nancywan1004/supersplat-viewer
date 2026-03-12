import {
    CameraFrame,
    ShaderChunks,
    Texture,
    PIXELFORMAT_R8,
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR,
    Vec3
} from 'playcanvas';
import type { PostEffectSettings } from '../settings';
import type { LocalLightRegion, WorldSpaceBloomRegionJSON } from '../schemas/v2';
import type { Global } from '../types';
import { BloomBrushPainter } from './bloom-brush-painter';
import { Picker } from '../picker';
import { WorldSpaceBloomData } from './world-space-bloom-data';
import { BloomBrushFilter, MAX_POINTS } from './bloom-brush-filter';
import { buildCommittedBrightnessVolume, buildCommittedBrightnessVolumeFromRegions, type CommittedPointWithBrightness } from './committed-brightness-volume';

const MASK_SIZE = 512;
/** 与 committed-brightness-volume 一致，用于判断是否为有效 64³ volume 纹理 */
const VOLUME_TEX_WIDTH = 64;
const VOLUME_TEX_HEIGHT = 64 * 64;

/**
 * Bloom mode enumeration
 */
export enum BloomMode {
    ScreenSpace = 'screen',
    WorldSpace = 'world'
}

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
    /** 用于 Night Mode + Bloom Brush 合成时传入 mask 与已提交区域亮度 */
    getNightModeScript: () => {
        setBloomBrushParams(active: boolean, mask: Texture | null, threshold: number, modelViewProj?: Float32Array, localBrightness?: number): void;
        setCommittedBrightnessRegions(points: Array<{ position: Vec3; radius: number }>, brightness: number): void;
        setCommittedBrightnessVolume(volumeTexture: Texture | null, aabbMin: Vec3, aabbMax: Vec3, brightness: number, options?: { volumeEncodedBrightness?: boolean }): void;
        setCommittedTint(tintColor: [number, number, number], tintBlend: number): void;
        setCommittedTintVolume(tintVolumeTexture: Texture | null): void;
    } | null;
}

/**
 * 统一管理所有 Bloom 相关逻辑，避免在 gsplat 实体上挂载 BloomDebugFilter/BloomBrushFilter，
 * 防止覆盖 reveal 的 gsplatCustomizeVS 导致进入 viewer 时 reveal 动画消失。
 *
 * ── 局部亮灯（LocalLightRegion）多区域架构约定 ──
 *
 * 1）每个 LocalLightRegion 独立持有自己的 worldSpace 数据：
 *    - settings.postEffectSettings.bloom.localLightRegions[i].worldSpace/ localBrightness 是「唯一真实源」；
 *    - 本类内部的 worldSpaceData 只作为「当前正在编辑的区域（含草稿 draft-*）的工作区」，不会混入其他区域的数据。
 *
 * 2）worldSpaceData 的职责仅限当前区域：
 *    - loadRegion() 会把某个 LocalLightRegion 的 worldSpace 加载到 worldSpaceData；
 *    - exportRegion() 只导出当前 worldSpaceData，对应「完成」后写回 single LocalLightRegion；
 *    - multi-region 模式下，已提交体积与 2D mask 的来源是 settings.localLightRegions（必要时再叠加当前草稿），
 *      而不是 worldSpaceData 内部残留的历史点。
 *
 * 3）3D 体积在渲染阶段按区域叠加：
 *    - 当存在多个 localLightRegions 时，applyToCameraFrame() 会收集所有区域的 committed 点，
 *      调用 buildCommittedBrightnessVolumeFromRegions() 在 CPU 侧合并为单张 64³ 体积纹理；
 *    - shader 只做一次采样，由体积已编码的有效亮度（-1～1）直接决定每个 splat 的乘数，
 *      保证「区域越多也仍然是单纹理/单采样」。
 *
 * 4）擦除只影响当前区域：
 *    - 上层 UI/协议在进入绘制模式前，必须先选定 activeLocalLightRegionId（或创建 draft-* 草稿）；
 *    - messageBridge:lightBrush 与 pointer 事件仅在 hasActiveLocalLightRegion() 为 true 时生效，
 *      WorldSpaceBloomData.eraseAt() 仅作用于当前 worldSpaceData（即当前正在编辑的区域），
 *      不会直接改写其他 LocalLightRegion 的 worldSpace。
 *
 * 5）删除最后一个区域时体积必须被清空：
 *    - 当 localLightRegions 从 N>0 变为 0 时，applyToCameraFrame() 会通过 buildCommittedBrightnessVolumeFromRegions(..., [])
 *      生成一张「全黑体积纹理」，并把亮度乘数设置为 0，显式清空已提交亮度效果；
 *    - 旧版仅单区域/无 localLightRegions 的配置继续走 syncCommittedToNightMode() 的单区域逻辑，保证向后兼容。
 *
 * 以上约束仅影响内部实现，不改变对外 API（BloomControllerOptions、applyToCameraFrame、loadRegion/exportRegion 等签名保持稳定），
 * 后续改动多区域逻辑时应继续遵守这些原则。
 *
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
    private picker: Picker | null = null;
    private worldSpaceData: WorldSpaceBloomData = new WorldSpaceBloomData();
    /** Always World Space (Screen Space removed per product decision) */
    private mode: BloomMode = BloomMode.WorldSpace;
    private isDrawing: boolean = false;
    private boundPointerDown: ((e: PointerEvent) => void) | null = null;
    private boundPointerMove: ((e: PointerEvent) => void) | null = null;
    private boundPointerUp: ((e: PointerEvent) => void) | null = null;
    private bloomBrushFilter: BloomBrushFilter | null = null;
    /** Last known camera position for detecting camera movement */
    private lastCameraPosition: Vec3 = new Vec3();
    /** Last known camera forward direction for detecting camera rotation */
    private lastCameraForward: Vec3 = new Vec3();
    /** Whether camera tracking has been initialized */
    private cameraTrackingInitialized = false;
    /** Canvas for rendering world space bloom points projected to screen space */
    private worldSpaceMaskCanvas: HTMLCanvasElement | null = null;
    private worldSpaceMaskCtx: CanvasRenderingContext2D | null = null;
    /** GPU texture for world space projected mask */
    private worldSpaceMaskTexture: Texture | null = null;
    /** Whether the world space mask has valid content */
    private hasWorldSpaceMask = false;
    /** Whether the world space mask was manually painted during active drawing */
    private worldSpaceMaskDirtyFromDrawing = false;
    /** 3D 亮度场烘焙成的 2D 图集纹理，无 64 点上限 */
    private committedVolumeTexture: Texture | null = null;
    /** 3D 颜色调制场（per-voxel tint），多区域时每区域只影响自己体素 */
    private committedTintTexture: Texture | null = null;
    private committedVolumeAabbMin: Vec3 = new Vec3(0, 0, 0);
    private committedVolumeAabbMax: Vec3 = new Vec3(1, 1, 1);
    /** 当前是否处于橡皮擦模式，由 LIGHT_ERASER_START / LIGHT_BRUSH_START 驱动 */
    private isErasing: boolean = false;
    /** 用于 active LocalLightRegion 体积缓存：仅当 regionId 或 committed 长度变化时重建 */
    private _lastActiveRegionId: string | null = null;
    private _lastActiveRegionCommittedLength: number = -1;
    /** 多区域叠加体积缓存：仅当各区域 committed 内容变化时重建 */
    private _lastMultiRegionHash: string = '';
    /** 当前通过 loadRegion 加载的局部亮灯区域 ID，用于区分「正在编辑的区域」 */
    private _activeLocalLightRegionId: string | null = null;
    /** 2D mask 缓存：仅当点集或相机变化时重绘，避免每帧清空导致闪动 */
    private _lastMaskSignature: string = '';

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

        // World space mask: a 2D canvas + texture for projecting 3D bloom points to screen
        this.worldSpaceMaskCanvas = document.createElement('canvas');
        this.worldSpaceMaskCanvas.width = MASK_SIZE;
        this.worldSpaceMaskCanvas.height = MASK_SIZE;
        this.worldSpaceMaskCtx = this.worldSpaceMaskCanvas.getContext('2d');
        this.worldSpaceMaskTexture = new Texture(graphicsDevice, {
            name: 'worldSpaceBloomMask',
            width: MASK_SIZE,
            height: MASK_SIZE,
            format: PIXELFORMAT_R8,
            addressU: ADDRESS_CLAMP_TO_EDGE,
            addressV: ADDRESS_CLAMP_TO_EDGE,
            minFilter: FILTER_LINEAR,
            magFilter: FILTER_LINEAR,
            mipmaps: false
        });

        // PlayCanvas fires 'frameupdate' (lowercase) before update(dt); camera is updated inside update(dt).
        // So we must regenerate world-space mask in 'framerender' (after camera update), not in frameupdate.
        const onFrameUpdate = () => {
            const cameraFrame = options.getCameraFrame();
            if (!cameraFrame || !global.settings.postEffectSettings?.bloom?.enabled) return;
            const bloom = global.settings.postEffectSettings.bloom as { bloomBrush?: boolean; threshold?: number };
            this.updateShaderUniforms();
            // World space mask is set in onFrameRender (after camera update)
        };
        const onFrameRender = () => {
            const bloom = global.settings.postEffectSettings?.bloom as { enabled?: boolean; bloomBrush?: boolean; threshold?: number } | undefined;
            if (!bloom?.enabled) return;
            // After update(dt), camera is current; project 3D points to screen and set mask for this frame.
            this.renderWorldSpaceMask();
            const maskTex = this.getEffectiveMaskTexture(!!bloom.bloomBrush);
            try {
                if (maskTex) graphicsDevice.scope.resolve('bloomMaskTexture').setValue(maskTex);
                const th = Math.max(0, Math.min(5, Number(bloom.threshold ?? 0.2)));
                graphicsDevice.scope.resolve('bloomThreshold').setValue(th);
            } catch (_) {}
        };
        app.on('frameupdate', onFrameUpdate);
        app.on('framerender', onFrameRender);
        this._unregisterFrameUpdate = () => {
            app.off('frameupdate', onFrameUpdate);
            app.off('framerender', onFrameRender);
        };

        const { events } = global;
        events.on('bloomBrush:clear', () => {
            this.worldSpaceData.clear();
            if (this.isDrawing) this.worldSpaceMaskDirtyFromDrawing = false;
            this.fireWorldSpaceChanged();
            (this.global.app as any).renderNextFrame = true;
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:clear'));

        events.on('bloomBrush:reset', () => {
            this.worldSpaceData.reset();
            if (this.worldSpaceMaskCtx && this.worldSpaceMaskCanvas && this.worldSpaceMaskTexture) {
                this.worldSpaceMaskCtx.fillStyle = '#000000';
                this.worldSpaceMaskCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
                this.worldSpaceMaskTexture.setSource(this.worldSpaceMaskCanvas);
                this.worldSpaceMaskTexture.upload();
            }
            this.worldSpaceMaskDirtyFromDrawing = false;
            this.saveWorldSpaceConfig();
            this.fireWorldSpaceChanged();
            (this.global.app as any).renderNextFrame = true;
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:reset'));

        events.on('bloomBrush:set', () => {
            this.worldSpaceData.commit();
            const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrushBrightness?: number } | undefined;
            const brightness = bloom && typeof bloom.bloomBrushBrightness === 'number'
                ? Math.max(-1, Math.min(1, bloom.bloomBrushBrightness))
                : 0;
            this.worldSpaceData.setCommittedBrightness(brightness);
            if (bloom) (bloom as any).bloomBrushCommittedBrightness = brightness;
            this.saveWorldSpaceConfig();
            this.syncCommittedToNightMode();
            this.fireWorldSpaceChanged();
            (this.global.app as any).renderNextFrame = true;
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:set'));

        events.on('bloomLocalLightRegion:requestExport', () => {
            const { worldSpaceJSON, committedBrightness } = this.exportRegion();
            (this.global.events as any).fire('bloomLocalLightRegion:exported', { worldSpaceJSON, committedBrightness });
        });
        this._unregisterEvents.push(() => events.off('bloomLocalLightRegion:requestExport'));

        // 父级托管模式下的 LIGHT_BRUSH_* 协议适配：
        // - LIGHT_BRUSH_START: 进入画笔模式（加亮/调暗）
        // - LIGHT_ERASER_START: 进入橡皮擦模式
        // - LIGHT_BRUSH_CLEAR: 清空当前绘制区域（不影响已提交体积）
        // - LIGHT_BRUSH_FINISH: 结束一次笔刷操作，相当于 "Set"：提交当前点并重建体积
        // - LIGHT_BRUSH_BLOOM_UPDATE: 更新局部亮度系数（bloomBrushBrightness）
        // 仅当存在当前 active LocalLightRegion（含草稿）时处理，否则不接管 pointer，与 UI 笔刷/擦除/完成行为一致。
        events.on('messageBridge:lightBrush', (data: { type: string; payload?: any }) => {
            const t = data?.type;
            const payload = (data?.payload ?? {}) as { value?: number };
            const bloomSettings = (this.global.settings as any).postEffectSettings?.bloom as any;

            if (!this.hasActiveLocalLightRegion()) {
                return;
            }

            const ensureBloomSettings = () => {
                if (!(this.global.settings as any).postEffectSettings) {
                    (this.global.settings as any).postEffectSettings = {};
                }
                if (!(this.global.settings as any).postEffectSettings.bloom) {
                    (this.global.settings as any).postEffectSettings.bloom = {
                        enabled: false,
                        intensity: 1,
                        blurLevel: 2,
                        threshold: 0.2,
                        bloomDebug: false,
                        bloomBrush: false,
                        bloomBrushSize: 30,
                        bloomBrushBrightness: 0
                    };
                }
                return (this.global.settings as any).postEffectSettings.bloom as any;
            };

            switch (t) {
            case 'LIGHT_BRUSH_START': {
                const bloom = ensureBloomSettings();
                bloom.bloomBrush = true;
                this.isErasing = false;
                this.worldSpaceData.setEraseMode(false);
                (this.global.app as any).renderNextFrame = true;
                break;
            }
            case 'LIGHT_ERASER_START': {
                const bloom = ensureBloomSettings();
                bloom.bloomBrush = true;
                this.isErasing = true;
                this.worldSpaceData.setEraseMode(true);
                (this.global.app as any).renderNextFrame = true;
                break;
            }
            case 'LIGHT_BRUSH_CLEAR': {
                // 清除当前绘制区域：等价 bloomBrush:clear
                this.worldSpaceData.clear();
                this.worldSpaceMaskDirtyFromDrawing = false;
                (this.global.app as any).renderNextFrame = true;
                break;
            }
            case 'LIGHT_BRUSH_FINISH': {
                // 完成一次笔刷操作：提交并重建体积，同时退出笔刷模式（不再依赖 toggle）
                this.worldSpaceData.commit();
                const bloom = ensureBloomSettings();
                const brightness = typeof bloom.bloomBrushBrightness === 'number'
                    ? Math.max(-1, Math.min(1, bloom.bloomBrushBrightness))
                    : 0;
                this.worldSpaceData.setCommittedBrightness(brightness);
                bloom.bloomBrushCommittedBrightness = brightness;
                bloom.bloomBrush = false;
                this.isErasing = false;
                this.worldSpaceData.setEraseMode(false);
                this.saveWorldSpaceConfig();
                this.syncCommittedToNightMode();
                this.worldSpaceMaskDirtyFromDrawing = false;
                (this.global.app as any).renderNextFrame = true;
                break;
            }
            case 'LIGHT_BRUSH_BLOOM_UPDATE': {
                // 更新局部亮度调制系数（-1～1），仅影响笔刷区域颜色；是否参与 Bloom 仍由全局 bloom 强度决定
                const bloom = ensureBloomSettings();
                if (typeof payload.value === 'number') {
                    const v = Math.max(-1, Math.min(1, payload.value));
                    bloom.bloomBrushBrightness = v;
                    (this.global.events as any).fire('postEffect:changed');
                    (this.global.app as any).renderNextFrame = true;
                }
                break;
            }
            default:
                break;
            }
        });
        this._unregisterEvents.push(() => events.off('messageBridge:lightBrush'));

        // Setup pointer event handlers for world space bloom
        this.boundPointerDown = this.handlePointerDown.bind(this);
        this.boundPointerMove = this.handlePointerMove.bind(this);
        this.boundPointerUp = this.handlePointerUp.bind(this);

        // Load saved world space config from settings (backward compatible: defaults to 'screen')
        this.loadWorldSpaceConfig();

        // If loaded mode is world space, register pointer event listeners
        const captureOpts: AddEventListenerOptions = { capture: true };
        if (this.boundPointerDown) document.addEventListener('pointerdown', this.boundPointerDown, captureOpts);
        if (this.boundPointerMove) document.addEventListener('pointermove', this.boundPointerMove, captureOpts);
        if (this.boundPointerUp) document.addEventListener('pointerup', this.boundPointerUp, captureOpts);
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
            bloomBrushBrightness?: number;
            bloomBrushCommittedBrightness?: number;
            localLightRegions?: Array<{ id: string; name: string; worldSpace: { points?: Array<{ position: [number, number, number]; radius: number }>; committed: Array<{ position: [number, number, number]; radius: number }> }; localBrightness: number }>;
            activeLocalLightRegionId?: string | null;
        };
        const bloomDebug = !!bloomSettings.bloomDebug;
        const bloomBrush = !!bloomSettings.bloomBrush;
        const th = Math.max(0, Math.min(5, Number(bloomSettings.threshold ?? 0.2)));
        const bloomBrushBrightness = typeof bloomSettings.bloomBrushBrightness === 'number'
            ? Math.max(-1, Math.min(1, bloomSettings.bloomBrushBrightness))
            : 0;

        if (bloomSettings.enabled) {
            bloom.intensity = Math.max(0, Math.min(0.2, Number(bloomSettings.intensity)));
            bloom.blurLevel = bloomSettings.blurLevel ?? 2;
            cameraFrame.debug = bloomDebug ? 'bloom' : null;
        } else {
            bloom.intensity = 0;
            cameraFrame.debug = null;
        }

        const nightModeScript = this.options.getNightModeScript();
        // 只要开启 Bloom Brush 就传 active=true，让 NightMode 用带笔刷分支的 shader，笔刷区域内应用局部亮度
        const effectiveMask = this.getEffectiveMaskTexture(bloomBrush);
        if (this.bloomBrushPainter) {
            this.bloomBrushPainter.setEnabled(false); // Screen space removed, always World Space
            this.bloomBrushPainter.setBrushSize(Math.max(1, Math.min(200, Number(bloomSettings.bloomBrushSize ?? 30))));
        }
        if (nightModeScript) {
            nightModeScript.setBloomBrushParams(bloomBrush, effectiveMask, th, undefined, bloomBrushBrightness);
            const regions = bloomSettings.localLightRegions ?? [];
            const activeId = bloomSettings.activeLocalLightRegionId ?? null;
            const activeRegion = (activeId && !String(activeId).startsWith('draft-'))
                ? regions.find((r: { id: string }) => r.id === activeId)
                : null;
            const tintColor: [number, number, number] = (activeRegion as any)?.tintColor != null
                ? [(activeRegion as any).tintColor[0], (activeRegion as any).tintColor[1], (activeRegion as any).tintColor[2]]
                : [1, 1, 1];
            const tintBlend = typeof (activeRegion as any)?.tintBlend === 'number'
                ? Math.max(0, Math.min(1, (activeRegion as any).tintBlend))
                : 0;
            // 多区域路径会传 per-voxel tint 纹理，此处 uniform 仅用于单区域/无 tint 纹理时的回退
            nightModeScript.setCommittedTint(tintColor, tintBlend);
            // 多区域叠加：所有 localLightRegions 同时参与体积/亮度合成；若有当前正在编辑的（含草稿），也把 worldSpaceData 纳入体积
            if (regions.length > 0) {
                const pointsWithBrightness: CommittedPointWithBrightness[] = [];
                const isDraftActive = activeId != null && String(activeId).startsWith('draft-');
                for (const r of regions) {
                    if (isDraftActive && r.id === activeId) continue;
                    const committed = r.worldSpace?.committed;
                    if (!committed?.length) continue;
                    const colorBrightness = typeof r.localBrightness === 'number'
                        ? Math.max(-1, Math.min(1, r.localBrightness))
                        : 0;
                    const brightness = Math.max(-1, Math.min(1, colorBrightness));
                    const tc = (r as any).tintColor;
                    const tblend = typeof (r as any).tintBlend === 'number' ? Math.max(0, Math.min(1, (r as any).tintBlend)) : 0;
                    const tintColor: [number, number, number] = Array.isArray(tc) && tc.length >= 3
                        ? [tc[0], tc[1], tc[2]]
                        : [1, 1, 1];
                    for (const p of committed) {
                        if (!p.position || !Array.isArray(p.position) || p.position.length < 3) continue;
                        pointsWithBrightness.push({
                            position: new Vec3(p.position[0], p.position[1], p.position[2]),
                            radius: p.radius ?? 1,
                            brightness,
                            tintColor,
                            tintBlend: tblend
                        });
                    }
                }
                if (isDraftActive) {
                    const wsPoints = this.worldSpaceData.getAllPoints();
                    // 草稿区域使用当前 bloomBrushBrightness 作为局部亮度来源，
                    // 保证「擦除/重涂 + 调整 slider」始终与实时体积预览一致。
                    const draftBrightness = typeof bloomSettings.bloomBrushBrightness === 'number'
                        ? Math.max(-1, Math.min(1, bloomSettings.bloomBrushBrightness))
                        : this.worldSpaceData.getCommittedBrightness();
                    for (const p of wsPoints) {
                        pointsWithBrightness.push({
                            position: p.position.clone(),
                            radius: p.radius,
                            brightness: draftBrightness
                        });
                    }
                }
                if (pointsWithBrightness.length > 0) {
                    const multiHash = regions.map((r: any) =>
                        `${r.id}:${(r.worldSpace?.committed ?? []).length}:${r.localBrightness ?? 0}:${(r.tintColor ?? []).join(',')}:${r.tintBlend ?? 0}`
                    ).join('|') + (isDraftActive ? '|active=' + (activeId ?? '') + '|ws=' + this.worldSpaceData.getAllPoints().length : '');
                    if (this._lastMultiRegionHash !== multiHash) {
                        const { texture, tintTexture, aabbMin, aabbMax } = buildCommittedBrightnessVolumeFromRegions(
                            this.global.app.graphicsDevice,
                            pointsWithBrightness,
                            this.committedVolumeTexture,
                            this.committedTintTexture
                        );
                        this.committedVolumeTexture = texture;
                        this.committedTintTexture = tintTexture;
                        this.committedVolumeAabbMin.copy(aabbMin);
                        this.committedVolumeAabbMax.copy(aabbMax);
                        this._lastMultiRegionHash = multiHash;
                    }
                    this._lastActiveRegionId = null;
                    this._lastActiveRegionCommittedLength = -1;
                    nightModeScript.setCommittedBrightnessVolume(
                        this.committedVolumeTexture!,
                        this.committedVolumeAabbMin,
                        this.committedVolumeAabbMax,
                        1,
                        { volumeEncodedBrightness: true }
                    );
                    nightModeScript.setCommittedTintVolume(this.committedTintTexture);
                } else {
                    this._lastMultiRegionHash = '';
                    this._lastActiveRegionId = null;
                    this._lastActiveRegionCommittedLength = -1;
                    this.committedTintTexture = null;
                    const { texture, tintTexture, aabbMin, aabbMax } = buildCommittedBrightnessVolumeFromRegions(
                        this.global.app.graphicsDevice,
                        [],
                        this.committedVolumeTexture,
                        this.committedTintTexture
                    );
                    this.committedVolumeTexture = texture;
                    this.committedTintTexture = tintTexture;
                    this.committedVolumeAabbMin.copy(aabbMin);
                    this.committedVolumeAabbMax.copy(aabbMax);
                    nightModeScript.setCommittedBrightnessVolume(
                        texture,
                        aabbMin,
                        aabbMax,
                        1,
                        { volumeEncodedBrightness: true }
                    );
                    nightModeScript.setCommittedTintVolume(null);
                }
            } else {
                // 无 localLightRegions（或仅有草稿）：
                // - 若之前走过多区域体积，先清空；
                // - 若当前为「首个亮灯区域」草稿（bloomBrush + draft id），用 worldSpaceData 草稿点实时建体积与 mask；
                // - 否则沿用单区域/旧逻辑（active 或 worldSpaceData）。
                if (this._lastMultiRegionHash) {
                    this._lastMultiRegionHash = '';
                    this._lastActiveRegionId = null;
                    this._lastActiveRegionCommittedLength = -1;
                    this.committedTintTexture = null;
                    const { texture, tintTexture, aabbMin, aabbMax } = buildCommittedBrightnessVolumeFromRegions(
                        this.global.app.graphicsDevice,
                        [],
                        this.committedVolumeTexture,
                        this.committedTintTexture
                    );
                    this.committedVolumeTexture = texture;
                    this.committedTintTexture = tintTexture;
                    this.committedVolumeAabbMin.copy(aabbMin);
                    this.committedVolumeAabbMax.copy(aabbMax);
                    nightModeScript.setCommittedBrightnessVolume(
                        texture,
                        aabbMin,
                        aabbMax,
                        0,
                        { volumeEncodedBrightness: true }
                    );
                    nightModeScript.setCommittedTintVolume(null);
                } else {
                    const activeId = bloomSettings.activeLocalLightRegionId ?? null;
                    const isDraftOnly = bloomBrush && activeId != null && String(activeId).startsWith('draft-');
                    if (isDraftOnly) {
                        // 首个亮灯区域草稿：仅 worldSpaceData 有笔刷点，按草稿点建体积并设亮度，实现实时 mask/体积预览
                        const wsPoints = this.worldSpaceData.getAllPoints();
                        const draftBrightness = typeof bloomSettings.bloomBrushBrightness === 'number'
                            ? Math.max(-1, Math.min(1, bloomSettings.bloomBrushBrightness))
                            : 1;
                        const pointsWithBrightness: CommittedPointWithBrightness[] = wsPoints.map(p => ({
                            position: p.position.clone(),
                            radius: p.radius,
                            brightness: draftBrightness
                        }));
                        const draftHash = `draft|ws=${wsPoints.length}|b=${draftBrightness}`;
                        if (this._lastMultiRegionHash !== draftHash) {
                            this._lastMultiRegionHash = draftHash;
                            const { texture, tintTexture, aabbMin, aabbMax } = buildCommittedBrightnessVolumeFromRegions(
                                this.global.app.graphicsDevice,
                                pointsWithBrightness,
                                this.committedVolumeTexture,
                                this.committedTintTexture
                            );
                            this.committedVolumeTexture = texture;
                            this.committedTintTexture = tintTexture;
                            this.committedVolumeAabbMin.copy(aabbMin);
                            this.committedVolumeAabbMax.copy(aabbMax);
                        }
                        this._lastActiveRegionId = null;
                        this._lastActiveRegionCommittedLength = -1;
                        nightModeScript.setCommittedBrightnessVolume(
                            this.committedVolumeTexture!,
                            this.committedVolumeAabbMin,
                            this.committedVolumeAabbMax,
                            1,
                            { volumeEncodedBrightness: true }
                        );
                        nightModeScript.setCommittedTintVolume(this.committedTintTexture);
                    } else {
                        // 旧逻辑：无 localLightRegions 且非草稿，使用单区域 worldSpaceData / activeRegion
                        const activeRegion = activeId && !String(activeId).startsWith('draft-')
                            ? (bloomSettings.localLightRegions ?? []).find((r: { id: string }) => r.id === activeId)
                            : null;
                        if (activeRegion?.worldSpace?.committed) {
                        const committed = activeRegion.worldSpace.committed;
                        const colorBrightness = typeof (activeRegion as any).localBrightness === 'number'
                            ? Math.max(-1, Math.min(1, (activeRegion as any).localBrightness))
                            : 0;
                        const regionBloomIntensity = typeof (activeRegion as any).bloomIntensity === 'number'
                            ? Math.max(0, Math.min(2, (activeRegion as any).bloomIntensity))
                            : 1;
                        const brightness = Math.max(-1, Math.min(1, colorBrightness * regionBloomIntensity));
                        const cacheHit = this._lastActiveRegionId === activeRegion.id && this._lastActiveRegionCommittedLength === committed.length;
                        if (!cacheHit) {
                            const points = committed.map((p: { position: [number, number, number]; radius: number }) => ({
                                position: new Vec3(p.position[0], p.position[1], p.position[2]),
                                radius: p.radius ?? 1
                            }));
                            const { texture, aabbMin, aabbMax } = buildCommittedBrightnessVolume(
                                this.global.app.graphicsDevice,
                                points,
                                this.committedVolumeTexture
                            );
                            this.committedVolumeTexture = texture;
                            this.committedVolumeAabbMin.copy(aabbMin);
                            this.committedVolumeAabbMax.copy(aabbMax);
                            this._lastActiveRegionId = activeRegion.id;
                            this._lastActiveRegionCommittedLength = committed.length;
                        }
                        nightModeScript.setCommittedBrightnessVolume(
                            this.committedVolumeTexture!,
                            this.committedVolumeAabbMin,
                            this.committedVolumeAabbMax,
                            brightness
                        );
                    } else {
                        this._lastActiveRegionId = null;
                        this._lastActiveRegionCommittedLength = -1;
                        if (!this.committedVolumeTexture) {
                            this.syncCommittedToNightMode();
                        } else {
                            nightModeScript.setCommittedBrightnessVolume(
                                this.committedVolumeTexture,
                                this.committedVolumeAabbMin,
                                this.committedVolumeAabbMax,
                                this.worldSpaceData.getCommittedBrightness()
                            );
                        }
                    }
                }
                }
            }
        }

        this.injectBloomMaskBeforeUpdate(cameraFrame);
    }

    private setBloomMaskInScope(): void {
        const graphicsDevice = this.global.app.graphicsDevice;
        const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrush?: boolean; threshold?: number } | undefined;
        const maskTex = this.getEffectiveMaskTexture(!!bloom?.bloomBrush);
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

    /**
     * Initialize picker for world-space coordinate conversion
     * @private
     */
    private initPicker(): void {
        if (!this.picker) {
            this.picker = new Picker(this.global.app, this.global.camera);
        }
    }

    /**
     * Convert screen coordinates to world coordinates using ray casting.
     * Uses the same coordinate system as the depth buffer: normalize by getBoundingClientRect()
     * so that [0,1] maps to Picker's (clientWidth x clientHeight) buffer, ensuring world positions
     * stay correct after camera move (no perspective/scale mismatch).
     * @param screenX Screen X in same units as rect (e.clientX - rect.left)
     * @param screenY Screen Y in same units as rect (e.clientY - rect.top)
     * @returns World position Vec3 or null if invalid depth
     * @private
     */
    private async screenToWorld(screenX: number, screenY: number): Promise<Vec3 | null> {
        if (!this.picker) {
            this.initPicker();
        }

        const canvas = this.global.app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = canvas.getBoundingClientRect();
        const rw = rect.width;
        const rh = rect.height;
        if (rw <= 0 || rh <= 0) return null;

        // Normalize to [0,1] in display space so Picker maps to buffer (clientWidth x clientHeight) correctly
        const normalizedX = screenX / rw;
        const normalizedY = screenY / rh;

        try {
            const worldPos = await this.picker!.pick(normalizedX, normalizedY);
            return worldPos;
        } catch (error) {
            console.warn('Picker failed:', error);
            return null;
        }
    }

    /**
     * Check if event target is an interactive UI element
     * @private
     */
    private isInteractiveTarget(target: EventTarget | null): boolean {
        if (!target || !(target instanceof Node)) return false;
        const el = target as HTMLElement;
        const tag = el.tagName?.toLowerCase();
        if (tag === 'input' || tag === 'button' || tag === 'select' || tag === 'textarea' || tag === 'a') return true;
        if (el.closest?.('input, button, select, textarea, a[href], [role="slider"], [contenteditable="true"]')) return true;
        if (el.closest?.('.postEffectSliderWrap, .postEffectOption')) return true;
        return false;
    }

    /**
     * Paint directly on the world space mask canvas using screen coordinates.
     * Uses the same buffer-space mapping as renderWorldSpaceMask (worldToScreen with clientWidth/clientHeight)
     * so that brush strokes and 3D-projected regions align and stay fixed in world space after camera move.
     * @private
     */
    private paintOnWorldSpaceMask(clientX: number, clientY: number): void {
        const ctx = this.worldSpaceMaskCtx;
        const tex = this.worldSpaceMaskTexture;
        if (!ctx || !tex) return;

        const appCanvas = this.global.app.graphicsDevice.canvas as HTMLCanvasElement;
        const rect = appCanvas.getBoundingClientRect();
        const cw = appCanvas.clientWidth || appCanvas.width;
        const ch = appCanvas.clientHeight || appCanvas.height;
        if (rect.width <= 0 || rect.height <= 0 || cw <= 0 || ch <= 0) return;

        // Map display coords to buffer coords (same as worldToScreen / Picker buffer)
        const bufferX = ((clientX - rect.left) / rect.width) * cw;
        const bufferY = ((clientY - rect.top) / rect.height) * ch;

        // Convert to mask canvas coords with Y flip (matching renderWorldSpaceMask)
        const mx = (bufferX / cw) * MASK_SIZE;
        const my = (1 - bufferY / ch) * MASK_SIZE;

        // Get brush size from settings and scale to mask pixels
        const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrushSize?: number } | undefined;
        const brushSize = bloom?.bloomBrushSize ?? 30;
        const scale = MASK_SIZE / rect.width;
        const radius = brushSize * scale;

        // 根据当前模式绘制：画笔=白，橡皮擦=黑
        ctx.fillStyle = this.isErasing ? '#000000' : '#ffffff';
        ctx.beginPath();
        ctx.arc(mx, my, radius, 0, Math.PI * 2);
        ctx.fill();

        // Upload immediately
        tex.setSource(this.worldSpaceMaskCanvas!);
        tex.upload();
        this.hasWorldSpaceMask = true;
        this.worldSpaceMaskDirtyFromDrawing = true;

        (this.global.app as any).renderNextFrame = true;
    }

    /**
     * Check if pointer coordinates are inside the app canvas bounds
     * @private
     */
    private isInsideCanvas(clientX: number, clientY: number): boolean {
        const canvas = this.global.app.graphicsDevice.canvas;
        const rect = canvas.getBoundingClientRect();
        return clientX >= rect.left && clientX <= rect.right && clientY >= rect.top && clientY <= rect.bottom;
    }

    /**
     * 是否存在当前正在编辑的 LocalLightRegion（含草稿 draft-*）。
     * LIGHT_BRUSH_* / 笔刷 pointer 仅在 bloomBrush 开启且本方法为 true 时生效。
     * @private
     */
    private hasActiveLocalLightRegion(): boolean {
        const bloom = this.global.settings?.postEffectSettings?.bloom as { activeLocalLightRegionId?: string | null } | undefined;
        const id = bloom?.activeLocalLightRegionId;
        return id != null && String(id).length > 0;
    }

    /**
     * Check if bloom brush is currently enabled in settings and there is an active LocalLightRegion.
     * World space pointer handlers only intercept events when this returns true.
     * When bloomBrush is OFF or no active region, events pass through to camera orbit controller.
     * @private
     */
    private isBloomBrushEnabled(): boolean {
        const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrush?: boolean } | undefined;
        return !!bloom?.bloomBrush && this.hasActiveLocalLightRegion();
    }

    /**
     * Handle pointer down event
     * Routes to appropriate handler based on current mode
     * @private
     */
    private handlePointerDown(e: PointerEvent): void {
        if (!this.isBloomBrushEnabled()) return;

        // Skip if clicking on interactive UI elements
        if (this.isInteractiveTarget(e.target)) return;
        if (e.button !== 0) return; // Only handle left click
        if (!this.isInsideCanvas(e.clientX, e.clientY)) return;

        this.isDrawing = true;
        e.preventDefault();
        e.stopPropagation();

        // 不再手画 2D 白圈：手画中心/半径是屏幕坐标，与 pointer up 后从 3D 投影的 mask 几何不一致，导致完成前后差异大。
        // 改为每帧只用 3D 点投影画 2D mask（体积仍仅 pointer up 重建），完成前后一致。
        const canvas = this.global.app.graphicsDevice.canvas;
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        this.screenToWorld(screenX, screenY).then(worldPos => {
            if (worldPos) {
                const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrushSize?: number } | undefined;
                const brushSize = bloom?.bloomBrushSize ?? 30;
                const cameraPos = this.global.camera.getPosition();
                const distance = worldPos.distance(cameraPos);
                const sceneCam = (this.global.camera as { camera?: { camera?: { fov?: number } } }).camera?.camera;
                const fovDeg = sceneCam?.fov ?? 60;
                const fovRad = (fovDeg * Math.PI) / 180;
                const canvasHeight = canvas.clientHeight || canvas.height;
                if (canvasHeight > 0 && distance > 0.001) {
                    const worldRadius = (brushSize * 2 * distance * Math.tan(fovRad / 2)) / canvasHeight;
                    if (this.isErasing) {
                        this.worldSpaceData.eraseAt(worldPos, worldRadius);
                    } else {
                        this.worldSpaceData.addPoint(worldPos, worldRadius, 1.0);
                    }
                    this.fireWorldSpaceChanged();
                    (this.global.app as any).renderNextFrame = true;
                    // 不在每点回调里触发 postEffect:changed，避免每加一个点就重建 volume 导致频闪；仅在 pointer up 时触发一次 3D 重算
                }
            }
        });
    }

    /**
     * Handle pointer move event
     * Only processes movement when actively drawing (isDrawing=true, set by handlePointerDown)
     * @private
     */
    private handlePointerMove(e: PointerEvent): void {
        if (!this.isDrawing) return;

        // Skip if moving over interactive UI elements
        if (this.isInteractiveTarget(e.target)) {
            this.isDrawing = false;
            return;
        }

        e.preventDefault();
        e.stopPropagation();

        const canvas = this.global.app.graphicsDevice.canvas;
        const rect = canvas.getBoundingClientRect();
        const screenX = e.clientX - rect.left;
        const screenY = e.clientY - rect.top;

        this.screenToWorld(screenX, screenY).then(worldPos => {
            if (worldPos) {
                const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomBrushSize?: number } | undefined;
                const brushSize = bloom?.bloomBrushSize ?? 30;
                const cameraPos = this.global.camera.getPosition();
                const distance = worldPos.distance(cameraPos);
                const sceneCam = (this.global.camera as { camera?: { camera?: { fov?: number } } }).camera?.camera;
                const fovDeg = sceneCam?.fov ?? 60;
                const fovRad = (fovDeg * Math.PI) / 180;
                const canvasHeight = canvas.clientHeight || canvas.height;
                if (canvasHeight > 0 && distance > 0.001) {
                    const worldRadius = (brushSize * 2 * distance * Math.tan(fovRad / 2)) / canvasHeight;
                    if (this.isErasing) {
                        this.worldSpaceData.eraseAt(worldPos, worldRadius);
                    } else {
                        this.worldSpaceData.addPoint(worldPos, worldRadius, 1.0);
                    }
                    this.fireWorldSpaceChanged();
                    (this.global.app as any).renderNextFrame = true;
                }
            }
        });
    }

    /**
     * Handle pointer up event
     * Only processes when actively drawing (isDrawing=true)
     * @private
     */
    private handlePointerUp(e: PointerEvent): void {
        if (e.button !== 0) return;
        if (!this.isDrawing) return;

        this.isDrawing = false;
        e.preventDefault();
        e.stopPropagation();
        this.worldSpaceMaskDirtyFromDrawing = false;
        this._lastMultiRegionHash = '';
        this._lastMaskSignature = '';
        this.fireWorldSpaceChanged();
        (this.global.app as any).renderNextFrame = true;
        // 仅在 pointer up 时触发一次 3D 投影/体积重算，松手即可看到 3D mask，无需点「完成」
        this.global.events.fire('postEffect:changed');
    }

    /** No-op: Screen Space removed, always World Space. Kept for API compat. */
    setMode(_newMode: BloomMode): void {}

    /**
     * Get current bloom mode
     * @returns Current bloom mode
     */
    getMode(): BloomMode {
        return this.mode;
    }

    /**
     * Save world space bloom data to settings for persistence
     * @private
     */
    private saveWorldSpaceConfig(): void {
        const bloom = this.global.settings?.postEffectSettings?.bloom as {
            worldSpacePoints?: unknown;
            localLightRegions?: unknown[];
            activeLocalLightRegionId?: string | null;
        } | undefined;
        if (!bloom) return;
        // DEPRECATED: worldSpacePoints 仅作为旧配置输入源（参考 settings.ts 中 ensureBloomLocalLightRegions）。
        // 多区域模型下（存在 localLightRegions 或 activeLocalLightRegionId 时），
        // worldSpaceData 仅作为当前区域/草稿的工作区，不再写回旧版 worldSpacePoints，
        // 以避免多个区域共享同一份 worldSpaceData 持久化结果。
        if ((bloom.localLightRegions && bloom.localLightRegions.length > 0) || bloom.activeLocalLightRegionId != null) {
            return;
        }
        (bloom as any).bloomMode = 'world';
        (bloom as any).worldSpacePoints = this.worldSpaceData.toJSON();
    }

    /** 通知 UI 当前 worldSpace 是否有任意点（用于绘制模式下 擦除/放弃 按钮可用性） */
    private fireWorldSpaceChanged(): void {
        const hasPoints = this.worldSpaceData.getAllPoints().length > 0;
        this.global.events.fire('bloomLocalLightRegion:worldSpaceChanged', { hasPoints });
    }

    /**
     * Load world space bloom data from settings
     * @private
     */
    private loadWorldSpaceConfig(): void {
        const bloom = this.global.settings?.postEffectSettings?.bloom as {
            worldSpacePoints?: any;
            bloomBrushCommittedBrightness?: number;
            localLightRegions?: unknown[];
        } | undefined;
        if (!bloom?.worldSpacePoints) return;
        // DEPRECATED: worldSpacePoints 仅在 importSettings 阶段用于迁移到 localLightRegions。
        // 若已经存在 LocalLightRegion，则视为已迁移到多区域模型：
        // 此时 worldSpaceData 由 loadRegion/exportRegion 与当前 active 区域驱动，
        // 不再从旧的 worldSpacePoints 中加载，避免与多区域持久化状态产生混淆。
        if (bloom.localLightRegions && bloom.localLightRegions.length > 0) {
            return;
        }
        this.worldSpaceData.fromJSON(bloom.worldSpacePoints);
        // 兼容：committedBrightness 可能在 worldSpacePoints 内（toJSON），也可能在 bloom 顶层（bloomBrushCommittedBrightness）
        if (bloom && typeof (bloom as any).bloomBrushCommittedBrightness === 'number') {
            this.worldSpaceData.setCommittedBrightness((bloom as any).bloomBrushCommittedBrightness);
        }
        if (bloom && typeof this.worldSpaceData.getCommittedBrightness() === 'number') {
            (bloom as any).bloomBrushCommittedBrightness = this.worldSpaceData.getCommittedBrightness();
        }
        this.syncCommittedToNightMode();
    }

    /**
     * 将单个 LocalLightRegion 加载到内部 WorldSpaceBloomData，用于编辑该区域或新建完成后写入。
     * 会设置 committedBrightness / localBrightness，并标记当前 active 区域 ID。
     */
    loadRegion(region: LocalLightRegion): void {
        this.worldSpaceData.fromJSON(region.worldSpace);
        const colorBrightness = typeof region.localBrightness === 'number'
            ? Math.max(-1, Math.min(1, region.localBrightness))
            : 0;
        const effectiveBrightness = Math.max(-1, Math.min(1, colorBrightness));
        this.worldSpaceData.setCommittedBrightness(effectiveBrightness);
        this._activeLocalLightRegionId = region.id;
        this._lastActiveRegionId = null;
        this._lastActiveRegionCommittedLength = -1;
        this.syncCommittedToNightMode();
        this.fireWorldSpaceChanged();
        (this.global.app as any).renderNextFrame = true;
    }

    /**
     * 导出当前 WorldSpaceBloomData 为单个区域的 worldSpaceJSON 与 committedBrightness，供 UI「完成」时写回 LocalLightRegion。
     */
    exportRegion(): { worldSpaceJSON: WorldSpaceBloomRegionJSON; committedBrightness: number } {
        const worldSpaceJSON = this.worldSpaceData.toJSON() as WorldSpaceBloomRegionJSON;
        const committedBrightness = this.worldSpaceData.getCommittedBrightness();
        return { worldSpaceJSON, committedBrightness };
    }

    /** 仅在 Set / 加载配置 / applyToCameraFrame 时同步 committed 到 NightMode；使用 3D 体积纹理，无点数上限 */
    private syncCommittedToNightMode(): void {
        const nightModeScript = this.options.getNightModeScript();
        if (!nightModeScript) return;
        const committed = this.worldSpaceData.getCommittedPoints();
        const brightness = this.worldSpaceData.getCommittedBrightness();
        const { texture, aabbMin, aabbMax } = buildCommittedBrightnessVolume(
            this.global.app.graphicsDevice,
            committed.map(p => ({ position: p.position, radius: p.radius })),
            this.committedVolumeTexture
        );
        this.committedVolumeTexture = texture;
        this.committedVolumeAabbMin.copy(aabbMin);
        this.committedVolumeAabbMax.copy(aabbMax);
        nightModeScript.setCommittedBrightnessVolume(texture, aabbMin, aabbMax, brightness);
    }

    /**
     * 获取用于 2D mask 投影的点列表：
     * - 绘制中：使用当前正在编辑区域的 worldSpaceData（points + committed）；
     * - 非绘制且存在 localLightRegions：所有区域的 committed 叠加，当前 active 区域（含草稿）由 worldSpaceData 代表，避免重复；
     * - 否则：回退到单区域 worldSpaceData。
     * @private
     */
    private getPointsForMask(): Array<{ position: Vec3; radius: number }> {
        const bloom = this.global.settings?.postEffectSettings?.bloom as {
            localLightRegions?: Array<{ id: string; worldSpace?: { committed?: Array<{ position: [number, number, number]; radius?: number }> } }>;
            activeLocalLightRegionId?: string | null;
        } | undefined;
        const regions = bloom?.localLightRegions ?? [];
        const activeId = bloom?.activeLocalLightRegionId ?? null;

        // 笔刷绘制中（非擦除）：只返回当前 worldSpaceData 的点做实时预览
        // 擦除模式需要 fall through 到多区域路径，否则其他区域的 2D mask 会消失
        if (this.isDrawing && !this.isErasing) {
            return this.worldSpaceData.getAllPoints().map(p => ({ position: p.position, radius: p.radius }));
        }

        const out: Array<{ position: Vec3; radius: number }> = [];

        // 多区域：仅当 active 为草稿时用 worldSpaceData 代表该草稿；否则全部用 localLightRegions，避免展开已有区域时误用空 worldSpaceData 导致区域消失
        if (regions.length > 0) {
            const isDraftActive = activeId != null && String(activeId).startsWith('draft-');
            for (const r of regions) {
                if (isDraftActive && r.id === activeId) continue;
                const committed = r.worldSpace?.committed;
                if (!committed?.length) continue;
                for (const p of committed) {
                    if (!p.position || !Array.isArray(p.position) || p.position.length < 3) continue;
                    out.push({
                        position: new Vec3(p.position[0], p.position[1], p.position[2]),
                        radius: p.radius ?? 1
                    });
                }
            }
            if (isDraftActive) {
                const wsPoints = this.worldSpaceData.getAllPoints();
                for (const p of wsPoints) {
                    out.push({ position: p.position.clone(), radius: p.radius });
                }
            }
            if (out.length > 0) {
                return out;
            }
        }

        // 无 localLightRegions 或全部被清空时，回退到 worldSpaceData
        return this.worldSpaceData.getAllPoints().map(p => ({ position: p.position, radius: p.radius }));
    }

    /**
     * 判断当前是否有可用于「按 volume 光栅化 2D mask」的 64³ 体积纹理（与局部亮度同源）。
     */
    private hasValidCommittedVolumeForMask(): boolean {
        const t = this.committedVolumeTexture;
        if (!t) return false;
        const w = (t as { width?: number }).width ?? 0;
        const h = (t as { height?: number }).height ?? 0;
        if (w !== VOLUME_TEX_WIDTH || h !== VOLUME_TEX_HEIGHT) return false;
        const sx = this.committedVolumeAabbMax.x - this.committedVolumeAabbMin.x;
        const sy = this.committedVolumeAabbMax.y - this.committedVolumeAabbMin.y;
        const sz = this.committedVolumeAabbMax.z - this.committedVolumeAabbMin.z;
        return sx > 1e-6 && sy > 1e-6 && sz > 1e-6;
    }

    /**
     * 使用局部亮度已计算好的 3D Volume 光栅化到 2D mask，与 NightMode 采样完全同源，compose 阶段用此 mask 与局部亮度一致。
     * 体素按 stride 采样投影到屏幕画圆（lighten），无 depth 需求、不改 compose 管线。
     * @private
     */
    private renderWorldSpaceMaskFromVolume(): boolean {
        const ctx = this.worldSpaceMaskCtx;
        const canvas = this.worldSpaceMaskCanvas;
        const tex = this.worldSpaceMaskTexture;
        const camera = this.global.camera;
        if (!ctx || !canvas || !tex || !camera?.camera || !this.hasValidCommittedVolumeForMask()) return false;

        const sceneCam = (camera as { camera?: { camera?: { worldToScreen(w: Vec3, cw: number, ch: number, out?: Vec3): Vec3; fov?: number } } }).camera?.camera;
        if (!sceneCam?.worldToScreen) return false;

        const appCanvas = this.global.app.graphicsDevice.canvas;
        const canvasWidth = appCanvas.clientWidth || appCanvas.width;
        const canvasHeight = appCanvas.clientHeight || appCanvas.height;
        if (canvasWidth <= 0 || canvasHeight <= 0) return false;

        const aabbMin = this.committedVolumeAabbMin;
        const aabbMax = this.committedVolumeAabbMax;
        const sizeX = aabbMax.x - aabbMin.x;
        const sizeY = aabbMax.y - aabbMin.y;
        const sizeZ = aabbMax.z - aabbMin.z;

        let pixels: Uint8Array | undefined;
        try {
            pixels = this.committedVolumeTexture!.lock() as Uint8Array;
        } catch {
            return false;
        }
        const screenPos = new Vec3();
        const worldPos = new Vec3();
        const stride = 2;
        // 半径足够大、且用径向渐变，使体素圆重叠后融合成连续光晕，避免出现网格状小圆点
        const maskRadius = 12;
        const threshold = Math.round(0.002 * 255);

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
        ctx.globalCompositeOperation = 'lighten';

        for (let iz = 0; iz < VOLUME_TEX_WIDTH; iz += stride) {
            for (let iy = 0; iy < VOLUME_TEX_WIDTH; iy += stride) {
                for (let ix = 0; ix < VOLUME_TEX_WIDTH; ix += stride) {
                    const idx = ix + iy * VOLUME_TEX_WIDTH + iz * VOLUME_TEX_WIDTH * VOLUME_TEX_WIDTH;
                    const val = pixels[idx];
                    if (val <= threshold) continue;
                    worldPos.x = aabbMin.x + (ix + 0.5) / VOLUME_TEX_WIDTH * sizeX;
                    worldPos.y = aabbMin.y + (iy + 0.5) / VOLUME_TEX_WIDTH * sizeY;
                    worldPos.z = aabbMin.z + (iz + 0.5) / VOLUME_TEX_WIDTH * sizeZ;
                    sceneCam.worldToScreen(worldPos, canvasWidth, canvasHeight, screenPos);
                    if (screenPos.z < 0) continue;
                    const maskX = (screenPos.x / canvasWidth) * MASK_SIZE;
                    const maskY = (1 - screenPos.y / canvasHeight) * MASK_SIZE;
                    const g = Math.min(1, val / 255);
                    const gray = Math.round(g * 255);
                    const h = gray.toString(16).padStart(2, '0');
                    const color = '#' + h + h + h;
                    const gradient = ctx.createRadialGradient(maskX, maskY, 0, maskX, maskY, maskRadius);
                    gradient.addColorStop(0, color);
                    gradient.addColorStop(0.4, color);
                    gradient.addColorStop(1, '#000000');
                    ctx.fillStyle = gradient;
                    ctx.beginPath();
                    ctx.arc(maskX, maskY, maskRadius, 0, Math.PI * 2);
                    ctx.fill();
                }
            }
        }

        this.committedVolumeTexture!.unlock();
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000000';
        tex.setSource(canvas);
        tex.upload();
        this.hasWorldSpaceMask = true;
        return true;
    }

    /**
     * Render world space bloom points projected to screen space into a 2D mask texture.
     * When a committed 3D volume exists, rasterizes that volume to the 2D mask (same source as local brightness) so compose matches exactly.
     * Otherwise projects point list with 0.85-radius gradient as before.
     * @private
     */
    private renderWorldSpaceMask(): void {
        const ctx = this.worldSpaceMaskCtx;
        const canvas = this.worldSpaceMaskCanvas;
        const tex = this.worldSpaceMaskTexture;
        if (!ctx || !canvas || !tex) {
            this.hasWorldSpaceMask = false;
            return;
        }

        const camera = this.global.camera;
        const camPos = camera?.getPosition();
        const camFwd = camera?.forward;
        const posStr = camPos ? `${camPos.x.toFixed(2)},${camPos.y.toFixed(2)},${camPos.z.toFixed(2)}` : '';
        const fwdStr = camFwd ? `${camFwd.x.toFixed(2)},${camFwd.y.toFixed(2)},${camFwd.z.toFixed(2)}` : '';

        if (this.hasValidCommittedVolumeForMask()) {
            const volStr = `${this.committedVolumeAabbMin.x.toFixed(3)},${this.committedVolumeAabbMax.x.toFixed(3)}`;
            const signature = `vol:${volStr}:${posStr}:${fwdStr}`;
            if (signature === this._lastMaskSignature) return;
            this._lastMaskSignature = signature;
            if (this.renderWorldSpaceMaskFromVolume()) return;
        }

        const allPoints = this.getPointsForMask();
        const pointSig = allPoints.length + (allPoints.length > 0 && allPoints[0]?.position
            ? `,${allPoints[0].position.x.toFixed(2)},${allPoints[0].position.y.toFixed(2)},${allPoints[0].position.z.toFixed(2)}`
            : '');
        const signature = `${allPoints.length}:${pointSig}:${posStr}:${fwdStr}`;
        if (signature === this._lastMaskSignature) return;
        this._lastMaskSignature = signature;

        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);

        if (allPoints.length === 0) {
            tex.setSource(canvas);
            tex.upload();
            this.hasWorldSpaceMask = true;
            return;
        }

        if (!camera?.camera) {
            tex.setSource(canvas);
            tex.upload();
            this.hasWorldSpaceMask = true;
            return;
        }

        const appCanvas = this.global.app.graphicsDevice.canvas;
        const canvasWidth = appCanvas.clientWidth || appCanvas.width;
        const canvasHeight = appCanvas.clientHeight || appCanvas.height;
        if (canvasWidth === 0 || canvasHeight === 0) {
            tex.setSource(canvas);
            tex.upload();
            this.hasWorldSpaceMask = true;
            return;
        }

        const screenPos = new Vec3();
        const sceneCam = (camera as { camera?: { camera?: { worldToScreen(w: Vec3, cw: number, ch: number, out?: Vec3): Vec3 } } }).camera?.camera;
        if (!sceneCam?.worldToScreen) {
            tex.setSource(canvas);
            tex.upload();
            this.hasWorldSpaceMask = true;
            return;
        }

        const innerFrac = 0.85;
        ctx.globalCompositeOperation = 'lighten';

        for (const point of allPoints) {
            sceneCam.worldToScreen(point.position, canvasWidth, canvasHeight, screenPos);

            if (screenPos.z < 0) continue;

            const maskX = (screenPos.x / canvasWidth) * MASK_SIZE;
            const maskY = (1 - screenPos.y / canvasHeight) * MASK_SIZE;

            const cameraPos = camera.getPosition();
            const distance = point.position.distance(cameraPos);
            if (distance < 0.001) continue;

            const fovRad = ((sceneCam as { fov?: number }).fov ?? 60) * (Math.PI / 180);
            const pixelsPerUnit = (canvasHeight / 2) / (distance * Math.tan(fovRad / 2));
            const screenRadius = Math.max(2, point.radius * pixelsPerUnit);
            const maskRadius = (screenRadius / canvasWidth) * MASK_SIZE;

            const gradient = ctx.createRadialGradient(
                maskX, maskY, 0,
                maskX, maskY, maskRadius
            );
            gradient.addColorStop(0, '#ffffff');
            gradient.addColorStop(innerFrac, '#ffffff');
            gradient.addColorStop(1, '#000000');
            ctx.fillStyle = gradient;
            ctx.beginPath();
            ctx.arc(maskX, maskY, maskRadius, 0, Math.PI * 2);
            ctx.fill();
        }

        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000000';

        tex.setSource(canvas);
        tex.upload();
        this.hasWorldSpaceMask = true;
    }

    /**
     * Get the effective mask texture for compose stage.
     * - If there are world space points (committed or current): use projected mask so Set bloom regions stay visible even after exiting brush.
     * - Else if Bloom Brush OFF: white = full-screen (global) bloom.
     * - Else: world space mask (black until drawn).
     * @private
     */
    private getEffectiveMaskTexture(bloomBrushOn: boolean): Texture | null {
        const hasWorldPoints = this.getPointsForMask().length > 0;
        if (hasWorldPoints && this.hasWorldSpaceMask && this.worldSpaceMaskTexture) {
            return this.worldSpaceMaskTexture;
        }
        if (!bloomBrushOn) {
            return this.bloomBrushWhiteTexture;
        }
        return this.worldSpaceMaskTexture;
    }

    /**
     * Check if the camera has moved or rotated since last frame.
     * If so, trigger a re-render so that world space bloom points
     * are displayed correctly from the new viewpoint.
     * @private
     */
    private checkCameraMovement(): void {

        // Only trigger re-render if there are world space bloom points (single or multi-region)
        const allPoints = this.getPointsForMask();
        if (allPoints.length === 0) return;

        const camera = this.global.camera;
        if (!camera) return;

        const currentPos = camera.getPosition();
        const currentFwd = camera.forward;

        if (!this.cameraTrackingInitialized) {
            this.lastCameraPosition.copy(currentPos);
            this.lastCameraForward.copy(currentFwd);
            this.cameraTrackingInitialized = true;
            return;
        }

        const EPSILON = 1e-4;
        const posDiff = currentPos.distance(this.lastCameraPosition);
        const fwdDiffX = Math.abs(currentFwd.x - this.lastCameraForward.x);
        const fwdDiffY = Math.abs(currentFwd.y - this.lastCameraForward.y);
        const fwdDiffZ = Math.abs(currentFwd.z - this.lastCameraForward.z);

        if (posDiff > EPSILON || fwdDiffX > EPSILON || fwdDiffY > EPSILON || fwdDiffZ > EPSILON) {
            // Camera has moved or rotated — trigger re-render
            (this.global.app as any).renderNextFrame = true;

            this.lastCameraPosition.copy(currentPos);
            this.lastCameraForward.copy(currentFwd);
        }
    }

    /**
     * Update shader uniforms for world space bloom mode
     * This should be called every frame when in world space mode
     * @private
     */
    private updateShaderUniforms(): void {
        // Check for camera movement and trigger re-render if needed
        this.checkCameraMovement();

        // World space: set mode to 1 and upload bloom points
        if (!this.bloomBrushFilter) {
            // Try to find or create BloomBrushFilter
            const gsplatEntity = this.global.app.root.findByName('gsplat') as any;
            if (gsplatEntity && gsplatEntity.script) {
                this.bloomBrushFilter = gsplatEntity.script.get('bloomBrushFilter') as BloomBrushFilter | null;
                if (!this.bloomBrushFilter) {
                    // Filter not found, we'll try again next frame
                    return;
                }
            } else {
                return;
            }
        }

        // Set bloom mode to world space
        // Note: The shader evaluates bloom purely by world-space distance.
        // Occluded bloom points still affect splats within their radius (Requirement 7.3).
        // This is intentional — bloom regions are fixed in 3D space.
        this.bloomBrushFilter.bloomMode = 1;

        // Get all bloom points
        const allPoints = this.worldSpaceData.getAllPoints();
        
        // Warn and truncate if exceeding MAX_POINTS limit
        if (allPoints.length > MAX_POINTS) {
            console.warn(`Bloom point count (${allPoints.length}) exceeds MAX_POINTS (${MAX_POINTS}). Truncating.`);
        }
        const pointCount = Math.min(allPoints.length, MAX_POINTS);

        // Convert bloom points to Float32Array
        // Format: vec4 per point (xyz=position, w=radius)
        for (let i = 0; i < pointCount; i++) {
            const point = allPoints[i];
            const offset = i * 4;
            this.bloomBrushFilter.bloomPoints[offset + 0] = point.position.x;
            this.bloomBrushFilter.bloomPoints[offset + 1] = point.position.y;
            this.bloomBrushFilter.bloomPoints[offset + 2] = point.position.z;
            this.bloomBrushFilter.bloomPoints[offset + 3] = point.radius;
        }

        // Set point count
        this.bloomBrushFilter.bloomPointCount = pointCount;

        const bloomSettings = this.global.settings?.postEffectSettings?.bloom as { bloomBrushBrightness?: number } | undefined;
        const brightness = typeof bloomSettings?.bloomBrushBrightness === 'number'
            ? Math.max(-1, Math.min(1, bloomSettings.bloomBrushBrightness))
            : 0;
        this.bloomBrushFilter.bloomBrushLocalBrightness = brightness;
    }

    destroy(): void {
        const captureOpts: AddEventListenerOptions = { capture: true };
        if (this.boundPointerDown) document.removeEventListener('pointerdown', this.boundPointerDown, captureOpts);
        if (this.boundPointerMove) document.removeEventListener('pointermove', this.boundPointerMove, captureOpts);
        if (this.boundPointerUp) document.removeEventListener('pointerup', this.boundPointerUp, captureOpts);
        
        this._unregisterFrameUpdate?.();
        this._unregisterFrameUpdate = null;
        this._unregisterEvents.forEach((fn) => fn());
        this._unregisterEvents = [];
        this.bloomBrushPainter = null;
        this.bloomBrushWhiteTexture = null;
        this.bloomCommittedMaskTexture = null;
        if (this.worldSpaceMaskTexture) {
            this.worldSpaceMaskTexture.destroy();
            this.worldSpaceMaskTexture = null;
        }
        this.worldSpaceMaskCanvas = null;
        this.worldSpaceMaskCtx = null;
        if (this.picker) {
            this.picker.release();
            this.picker = null;
        }
    }
}
