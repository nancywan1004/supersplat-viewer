import {
    CameraFrame,
    ShaderChunks,
    Texture,
    PIXELFORMAT_R8,
    ADDRESS_CLAMP_TO_EDGE,
    FILTER_LINEAR,
    Vec3
} from 'playcanvas';

import { BloomBrushFilter, MAX_POINTS } from './bloom-brush-filter';
import { BloomBrushFlowController } from './bloom-brush-flow';
import { BloomBrushPainter } from './bloom-brush-painter';
import { computeBrushView, type BrushView } from './brush-view';
import { buildCommittedBrightnessVolume, buildCommittedBrightnessVolumeFromRegions, type CommittedPointWithBrightness } from './committed-brightness-volume';
import { WorldSpaceBloomData } from './world-space-bloom-data';
import { hasRevealEffectFromSettings } from '../reveal-policy';
import type { LocalLightRegion, WorldSpaceBloomRegionJSON, ExperienceSettings } from '../schemas/v2';
import type { PostEffectSettings } from '../settings';
import { ensureBloomEditorSession } from '../settings-serialize/settings-serialize-helper';
import type { Global } from '../types';

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
uniform float bloomThresholdKnee;
vec3 dBloom;
vec3 applyBloom(vec3 color, vec2 uv) {
    dBloom = texture2DLod(bloomTexture, uv, 0.0).rgb;
    float mask = texture2DLod(bloomMaskTexture, uv, 0.0).r;
    float lum = dot(color, vec3(0.2126, 0.7152, 0.0722));
    float knee = max(1e-4, bloomThresholdKnee);
    float brightPass = smoothstep(bloomThreshold - knee, bloomThreshold + knee, lum);
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
uniform bloomThresholdKnee: f32;
var<private> dBloom: vec3f;
fn applyBloom(color: vec3f, uv: vec2f) -> vec3f {
    dBloom = textureSampleLevel(bloomTexture, bloomTextureSampler, uv, 0.0).rgb;
    let mask = textureSampleLevel(bloomMaskTexture, bloomMaskTextureSampler, uv, 0.0).r;
    let lum = dot(color, vec3f(0.2126, 0.7152, 0.0722));
    let knee = max(1e-4, uniform.bloomThresholdKnee);
    let brightPass = smoothstep(uniform.bloomThreshold - knee, uniform.bloomThreshold + knee, lum);
    return color + dBloom * uniform.bloomIntensity * mask * brightPass;
}
#endif
`;

const BLOOM_THRESHOLD_KNEE_MIN = 0.05;
const BLOOM_THRESHOLD_KNEE_MAX = 0.35;
/** 首次激活 compose bloom 时预热帧数，避免初帧采样未稳定输入导致蓝闪 */
const BLOOM_ACTIVATION_WARMUP_FRAMES = 1;

const getBloomThresholdKnee = (threshold: number): number =>
    Math.max(
        BLOOM_THRESHOLD_KNEE_MIN,
        Math.min(BLOOM_THRESHOLD_KNEE_MAX, threshold * 0.12 + 0.04)
    );

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
 *    - multi-region 模式下，已提交体积与 2D mask 通常来自 settings.localLightRegions 的叠加；
 *      当 Bloom 笔刷会话且 active 仍为 draft-*（未完成）时，体积与 mask 仅反映当前草稿 worldSpaceData，直至完成转正。
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

/**
 * 仍从 `bloom` settings 里读的「编辑 / 观看」相关快照；只影响 Viewer 的闸以后**只加字段**，规则集中在
 * {@link BloomController.applyViewerLocalLightPolicy}（或并列的单一出口方法）。
 */
type BloomPlayMode = {
    /**
     * 是否处于编辑模式（`global.state.editMode`）。
     * **当前策略**：为 true 时本策略**不**因 `localLightsUserDisabled` 清空局部亮灯视觉（编辑以 regions / scope 等为真源）。
     * **若日后产品要**「编辑态也吃总闸」：只改 {@link BloomController.applyViewerLocalLightPolicy} 内对 `editing` 的分支即可，无需改调用方。
     */
    editing: boolean;
    /** 整灯总闸为关（`LIGHT_TOGGLE_ALL` / Viewer 运行时）时，观看态可清空局部亮灯视觉 */
    localLightsUserDisabled: boolean;
};

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
    private worldSpaceData: WorldSpaceBloomData = new WorldSpaceBloomData();
    /** Always World Space (Screen Space removed per product decision) */
    private mode: BloomMode = BloomMode.WorldSpace;
    // ===== Brush Flow 状态总览（入口 -> 状态 -> 副作用）=====
    // 入口 A（协议）：messageBridge:lightBrush
    //   - LIGHT_BRUSH_START / LIGHT_ERASER_START：切工具态（isErasing + eraseMode）
    //   - LIGHT_BRUSH_CLEAR：清空当前草稿工作区
    //   - LIGHT_BRUSH_FINISH：提交 committed + 同步 localLightRegions + 触发重建
    // 入口 B（交互）：pointerdown/move/up（仅 bloomBrush=true 且有 active region）
    //   - pointerdown/move：写入或擦除 worldSpaceData 点集
    //   - pointerup：统一触发一次 3D 重建（postEffect:changed）
    // 关键状态：
    //   - isDrawing：是否处于一次 pointer 绘制会话中
    //   - isErasing：当前工具是否为橡皮擦（影响 addPoint / eraseAt）
    //   - _lastMultiRegionHash / _lastMaskSignature：体积与 2D mask 缓存签名，置空即强制下一帧重算
    private isDrawing: boolean = false;
    private boundPointerDown: ((e: PointerEvent) => void) | null = null;
    private boundPointerMove: ((e: PointerEvent) => void) | null = null;
    private boundPointerUp: ((e: PointerEvent) => void) | null = null;
    private brushFlow: BloomBrushFlowController | null = null;
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
    /** 世界空间 mask 的临时缓冲，用于低成本平滑 */
    private worldSpaceMaskTempCanvas: HTMLCanvasElement | null = null;
    private worldSpaceMaskTempCtx: CanvasRenderingContext2D | null = null;
    /** Whether the world space mask has valid content */
    private hasWorldSpaceMask = false;
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
    /** 上一帧是否请求启用 compose bloom（用于检测 false->true 的激活沿） */
    private _lastComposeBloomRequested = false;
    /** bloom 激活预热剩余帧数：期间强制 intensity=0，仅让管线和输入稳定 */
    private _pendingComposeBloomWarmupFrames = 0;
    /**
     * 与「开场 reveal」共用节奏：为 false 时关闭相机 compose bloom 与局部亮灯（体积+mask），避免与 VFX 叠加；
     * 与 bloomBrush 会话无关，reveal 未结束前不放行笔刷/局部亮灯预览。
     * 无 reveal 或 revealComplete 后为 true；revealRestart 且仍有 reveal 时再次为 false。
     */
    private _bloomStackUnlocked = true;

    constructor(global: Global, options: BloomControllerOptions) {
        this.global = global;
        this.options = options;

        // Viewer 构造早于 RevealController：state.hasRevealEffect 仍为 false，须按 settings 推断，
        // 否则开场 reveal 前整段会误走「全开 Bloom + 局部亮灯」，firstFrame 创建 VFX 时产生整屏一闪。
        const revealScheduled = global.state.hasRevealEffect ||
            hasRevealEffectFromSettings((global.settings as { revealEffect?: { type?: string } }).revealEffect);
        this._bloomStackUnlocked = !revealScheduled;
        const onHasRevealChanged = (v: boolean) => {
            if (v) {
                this._bloomStackUnlocked = false;
            } else {
                this._bloomStackUnlocked = true;
            }
        };
        const onRevealComplete = () => {
            this._bloomStackUnlocked = true;
        };
        const onRevealRestart = () => {
            if (global.state.hasRevealEffect) {
                this._bloomStackUnlocked = false;
            }
        };
        global.events.on('hasRevealEffect:changed', onHasRevealChanged);
        global.events.on('revealComplete', onRevealComplete);
        global.events.on('revealRestart', onRevealRestart);
        this._unregisterEvents.push(() => {
            global.events.off('hasRevealEffect:changed', onHasRevealChanged);
            global.events.off('revealComplete', onRevealComplete);
            global.events.off('revealRestart', onRevealRestart);
        });

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
            const bloom = global.settings.postEffectSettings.bloom as { threshold?: number };
            this.updateShaderUniforms();
            // World space mask is set in onFrameRender (after camera update)
        };
        const onFrameRender = () => {
            const bloom = global.settings.postEffectSettings?.bloom as { enabled?: boolean; threshold?: number } | undefined;
            if (!bloom?.enabled) return;
            // After update(dt), camera is current; project 3D points to screen and set mask for this frame.
            this.renderWorldSpaceMask();
            const brushOn = !!ensureBloomEditorSession(global.settings as ExperienceSettings).bloomBrush;
            const maskTex = this.getEffectiveMaskTexture(brushOn);
            try {
                if (maskTex) graphicsDevice.scope.resolve('bloomMaskTexture').setValue(maskTex);
                const th = Math.max(0, Math.min(5, Number(bloom.threshold ?? 0)));
                graphicsDevice.scope.resolve('bloomThreshold').setValue(th);
                graphicsDevice.scope.resolve('bloomThresholdKnee').setValue(getBloomThresholdKnee(th));
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
            this.fireWorldSpaceChanged();
            (this.global.app as any).renderNextFrame = true;
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:clear'));

        events.on('bloomBrush:reset', () => {
            this.worldSpaceData.reset();
            this._lastMultiRegionHash = '';
            this._lastActiveRegionId = null;
            this._lastActiveRegionCommittedLength = -1;
            this.committedTintTexture = null;
            // 强制下一帧重建 2D mask，避免旧 signature 缓存导致 mask 不更新
            this._lastMaskSignature = '';

            const bloomSettings = (this.global.settings as any).postEffectSettings?.bloom as any;
            const hasExistingRegions = Array.isArray(bloomSettings?.localLightRegions) &&
                bloomSettings.localLightRegions.some((r: any) => r?.worldSpace?.committed?.length > 0);

            if (hasExistingRegions) {
                // 有已提交区域时不清 mask / volume：worldSpaceData 仅代表当前草稿工作区，
                // 已有区域的 committed 数据在 localLightRegions 中，下一帧 applyToCameraFrame 会从中重建。
            } else {
                if (this.worldSpaceMaskCtx && this.worldSpaceMaskCanvas && this.worldSpaceMaskTexture) {
                    this.worldSpaceMaskCtx.fillStyle = '#000000';
                    this.worldSpaceMaskCtx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
                    this.worldSpaceMaskTexture.setSource(this.worldSpaceMaskCanvas);
                    this.worldSpaceMaskTexture.upload();
                }
                this.saveWorldSpaceConfig();
                this.syncCommittedToNightMode();
            }
            this.fireWorldSpaceChanged();
            (this.global.app as any).renderNextFrame = true;
        });
        this._unregisterEvents.push(() => events.off('bloomBrush:reset'));

        // 当局部亮灯区域列表发生变化且被清空时，清理遗留的 worldSpaceData 与体积，避免已删除区域继续参与合成。
        const onRegionListChanged = () => {
            const bloomSettings = (this.global.settings as any).postEffectSettings?.bloom as any;
            const regions = bloomSettings?.localLightRegions as any[] | undefined;
            if (Array.isArray(regions) && regions.length === 0) {
                // 清空工作区与缓存体积
                this.worldSpaceData.reset();
                this._lastMultiRegionHash = '';
                this._lastActiveRegionId = null;
                this._lastActiveRegionCommittedLength = -1;
                this.committedTintTexture = null;
                // 使用空 committedPoints 重建体积，使 NightMode 中不再有旧区域残留
                this.syncCommittedToNightMode();
                (this.global.app as any).renderNextFrame = true;
            }
        };
        events.on('bloomLocalLightRegion:listChanged', onRegionListChanged);
        this._unregisterEvents.push(() => events.off('bloomLocalLightRegion:listChanged', onRegionListChanged));

        events.on('bloomLocalLightRegion:requestExport', () => {
            const { worldSpaceJSON, committedBrightness } = this.exportRegion();
            (this.global.events as any).fire('bloomLocalLightRegion:exported', { worldSpaceJSON, committedBrightness });
        });
        this._unregisterEvents.push(() => events.off('bloomLocalLightRegion:requestExport'));

        this.brushFlow = new BloomBrushFlowController({
            global: this.global,
            worldSpaceData: this.worldSpaceData,
            getIsDrawing: () => this.isDrawing,
            setIsDrawing: (v) => { this.isDrawing = v; },
            getIsErasing: () => this.isErasing,
            setIsErasing: (v) => { this.isErasing = v; },
            hasActiveLocalLightRegion: () => this.hasActiveLocalLightRegion(),
            fireWorldSpaceChanged: () => this.fireWorldSpaceChanged(),
            invalidateBrushCaches: () => this.invalidateBrushCaches(),
            saveWorldSpaceConfig: () => this.saveWorldSpaceConfig(),
            syncCommittedToNightMode: () => this.syncCommittedToNightMode(),
            exportRegion: () => this.exportRegion(),
            getCurrentRegionCenter: () => this.getCurrentRegionCenter()
        });
        events.on('messageBridge:lightBrush', this.brushFlow.handleMessageBridgeLightBrush);
        this._unregisterEvents.push(() => {
            if (this.brushFlow) events.off('messageBridge:lightBrush', this.brushFlow.handleMessageBridgeLightBrush);
        });

        // ===== Brush Flow 入口 B：pointer 交互入口（会话态）=====
        // 仅负责“写点/擦点 + 通知渲染”；真正的体积重建集中在 pointerup 或 FINISH。
        this.boundPointerDown = this.brushFlow.handlePointerDown;
        this.boundPointerMove = this.brushFlow.handlePointerMove;
        this.boundPointerUp = this.brushFlow.handlePointerUp;

        // Load saved world space config from settings (backward compatible: defaults to 'screen')
        this.loadWorldSpaceConfig();

        // If loaded mode is world space, register pointer event listeners
        const captureOpts: AddEventListenerOptions = { capture: true };
        if (this.boundPointerDown) document.addEventListener('pointerdown', this.boundPointerDown, captureOpts);
        if (this.boundPointerMove) document.addEventListener('pointermove', this.boundPointerMove, captureOpts);
        if (this.boundPointerUp) document.addEventListener('pointerup', this.boundPointerUp, captureOpts);
    }

    private invalidateBrushCaches(): void {
        this._lastMultiRegionHash = '';
        this._lastMaskSignature = '';
    }

    /** 与 applyToCameraFrame / getPointsForMask 共用，避免散落推导。 */
    private getBrushView(): BrushView {
        const editor = ensureBloomEditorSession(this.global.settings as ExperienceSettings);
        const bloom = this.global.settings?.postEffectSettings?.bloom as { localLightRegions?: unknown[] } | undefined;
        const nRegions = Array.isArray(bloom?.localLightRegions) ? bloom.localLightRegions.length : 0;
        return computeBrushView({
            brush: !!editor.bloomBrush,
            activeId: editor.activeLocalLightRegionId ?? null,
            nRegions,
            drawing: this.isDrawing,
            erasing: this.isErasing
        });
    }

    /**
     * @param viewBloomLocalLightsEnabled - 即 `global.viewSettings?.bloom?.localLightsEnabled`；
     *   `undefined` 表示未注入 `viewSettings`（不按「整闸关」处理局部亮灯支路）。
     */
    private readBloomPlayMode(viewBloomLocalLightsEnabled: boolean | undefined | null): BloomPlayMode {
        return {
            editing: !!this.global.state.editMode,
            localLightsUserDisabled: viewBloomLocalLightsEnabled === false,
        };
    }

    /** 读观看态 `viewSettings` 中与历史同名的 `localLightsEnabled`；无 `viewSettings` 时 `undefined`。 */
    private readViewBloomLocalLightsEnabled(): boolean | undefined {
        return this.global.viewSettings?.bloom?.localLightsEnabled;
    }

    /**
     * 根据 {@link BloomPlayMode} 与当前笔刷会话，判断是否应**清空**局部亮灯体积 / mask（观看 + 用户关总闸且无笔刷预览理由）。
     *
     * @returns `true` 表示调用方应按策略清空局部亮灯视觉；本方法**只读**、不写 settings。
     */
    private applyViewerLocalLightPolicy(play: BloomPlayMode, brushSession: boolean, worldPointCount: number): boolean {
        if (play.editing) return false;
        if (!play.localLightsUserDisabled) return false;
        if (brushSession && worldPointCount > 0) return false;
        return true;
    }

    /**
     * ── applyToCameraFrame：编辑 / 观看 读数约定（与仓库 Bloom 计划「编辑参与 vs Viewer 不参与」表一致；改逻辑先改本节）──
     *
     * **编辑态**（`global.state.editMode`）：以 settings 为真源——`bloomScope`、`localLightRegions`、绑灯 `lighting.lights[*]`、
     * `bloomEditorSession`（`activeLocalLightRegionId`、`bloomBrush`）、`nightMode` 等。
     * 不因存盘字段整段关掉局部亮灯体积；`localLightsEnabled` 仅在 **观看态** 由 `readBloomPlayMode` + `applyViewerLocalLightPolicy` 参与决策（读 `global.viewSettings?.bloom?.localLightsEnabled`；无 `viewSettings` 时不视为整闸关）。
     *
     * **观看态**：整灯总闸关（`LIGHT_TOGGLE_ALL` / 运行时）且无笔刷工作区预览时，清空局部亮灯视觉。
     *
     * **二者都不当区域语义根因**：reveal（`_bloomStackUnlocked`）、指针 `isDrawing`/`isErasing`（经 `getBrushView`）、Viewer 专用 `nightFade:set` 等。
     */

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
            bloomBrushSize?: number;
            threshold?: number;
            bloomBrushBrightness?: number;
            localLightRegions?: Array<{ id: string; name: string; worldSpace: { points?: Array<{ position: [number, number, number]; radius: number }>; committed: Array<{ position: [number, number, number]; radius: number }> }; localBrightness: number }>;
        };
        const editor = ensureBloomEditorSession(this.global.settings as ExperienceSettings);
        const bloomDebug = !!bloomSettings.bloomDebug;
        // Bloom 阈值（HDR 提取阈值）：
        // 仅亮度高于该值的像素会被提取到 bloom 管线。
        // - 低阈值：更多中亮区域参与，画面更“糊光”；
        // - 高阈值：仅保留最亮高光，发光范围更克制。
        const th = Math.max(0, Math.min(5, Number(bloomSettings.threshold ?? 0)));
        const bloomBrushBrightness = typeof bloomSettings.bloomBrushBrightness === 'number'
            ? Math.max(-1, Math.min(1, bloomSettings.bloomBrushBrightness))
            : 0;
        const regions = bloomSettings.localLightRegions ?? [];
        const activeId = editor.activeLocalLightRegionId ?? null;
        const viewBloomLocalLightsEnabled = this.readViewBloomLocalLightsEnabled();
        const bloomScope = (bloomSettings as { bloomScope?: 'global' | 'local' }).bloomScope === 'global' ? 'global' : 'local';

        const blurLevel = bloomSettings.blurLevel ?? 10;
        // local 模式下，只有“确有局部贡献”时才开启 compose bloom，避免 0->非0 时整场亮度/对比突变。
        const hasLocalBloomContribution = editor.bloomBrush === true || this.getPointsForMask().length > 0;
        const shouldEnableComposeBloom =
            !!bloomSettings.enabled &&
            blurLevel > 0 &&
            (bloomScope === 'global' || hasLocalBloomContribution);
        const requestedIntensity = Number(bloomSettings.intensity);
        const resolvedIntensity = Number.isFinite(requestedIntensity) ? requestedIntensity : 0;
        const composeBloomRequested = shouldEnableComposeBloom && resolvedIntensity > 0;

        if (composeBloomRequested && !this._lastComposeBloomRequested) {
            this._pendingComposeBloomWarmupFrames = BLOOM_ACTIVATION_WARMUP_FRAMES;
        }

        if (shouldEnableComposeBloom) {
            if (this._pendingComposeBloomWarmupFrames > 0) {
                bloom.intensity = 0;
                this._pendingComposeBloomWarmupFrames--;
            } else {
                bloom.intensity = resolvedIntensity;
            }
            bloom.blurLevel = Math.max(1, Math.min(5, blurLevel));
            cameraFrame.debug = bloomDebug ? 'bloom' : null;
        } else {
            bloom.intensity = 0;
            this._pendingComposeBloomWarmupFrames = 0;
            cameraFrame.debug = null;
        }
        this._lastComposeBloomRequested = composeBloomRequested;

        // reveal 未完成：关闭 compose Bloom、清空局部亮灯体积与 2D mask，不做笔刷预览（不再因 bloomBrush 放行）。
        if (!this._bloomStackUnlocked) {
            bloom.intensity = 0;
            this._lastComposeBloomRequested = false;
            this._pendingComposeBloomWarmupFrames = 0;
            cameraFrame.debug = null;
            this.clearWorldSpaceMaskToBlack();
            const nightModeScriptReveal = this.options.getNightModeScript();
            if (this.bloomBrushPainter) {
                this.bloomBrushPainter.setEnabled(false);
                this.bloomBrushPainter.setBrushSize(Math.max(0.1, Math.min(200, Number(bloomSettings.bloomBrushSize ?? 10))));
            }
            if (nightModeScriptReveal) {
                const maskReveal = this.getEffectiveMaskTexture(false);
                nightModeScriptReveal.setBloomBrushParams(false, maskReveal, th, undefined, bloomBrushBrightness);
                this.clearLocalLightVolumeForNightMode(nightModeScriptReveal);
            }
            this.injectBloomMaskBeforeUpdate(cameraFrame);
            return;
        }

        const bv = this.getBrushView();

        const nightModeScript = this.options.getNightModeScript();
        // 只要开启 Bloom Brush 就传 active=true，让 NightMode 用带笔刷分支的 shader，笔刷区域内应用局部亮度
        const effectiveMask = this.getEffectiveMaskTexture(bv.brush);
        if (this.bloomBrushPainter) {
            this.bloomBrushPainter.setEnabled(false); // Screen space removed, always World Space
            this.bloomBrushPainter.setBrushSize(Math.max(0.1, Math.min(200, Number(bloomSettings.bloomBrushSize ?? 10))));
        }
        if (nightModeScript) {
            // BloomBrush shader 分支仅在「正在拖动画笔」时激活，提供实时 2D mask 预览。
            // 松手后（!isDrawing）关闭该分支，渲染完全由 3D 体积决定——和已提交态走同一管线，
            // 从根本上保证草稿态（非拖动时）与 SET 后的视觉效果一致。
            // 擦除模式下禁用 2D 预览，避免与擦除语义冲突；其余绘制态都保持实时可见。
            const brushShaderActive = bv.brush && bv.tool === 'paint';
            nightModeScript.setBloomBrushParams(brushShaderActive, effectiveMask, th, undefined, bloomBrushBrightness);

            const activeRegion = (activeId && bv.kind === 'saved')
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
            // 多区域叠加：所有 localLightRegions 同时参与体积/亮度合成；
            // 若有当前正在编辑的（含草稿），也把 worldSpaceData 纳入体积。
            // 若某区域绑定的光源当前处于关闭状态（lighting.lights[*].enabled === false），
            // 则视为该区域整体不可见：其局部亮度与 Bloom mask 均不参与体积/亮度合成。
            const wsPointCount = this.worldSpaceData.getAllPoints().length;
            const play = this.readBloomPlayMode(viewBloomLocalLightsEnabled);
            if (this.applyViewerLocalLightPolicy(play, bv.brush, wsPointCount)) {
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
                return;
            }
            if (regions.length > 0) {
                const pointsWithBrightness: CommittedPointWithBrightness[] = [];
                const isDraftActive = bv.kind === 'draft';
                const wsPoints = this.worldSpaceData.getAllPoints();
                if (!bv.draftOnly) {
                    for (const r of regions) {
                        if (!this.isLocalLightRegionVisible(r)) continue;
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
                }
                if (isDraftActive) {
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
                    const visibilitySig = regions.map((r: any) => `${r.id}:${this.isLocalLightRegionVisible(r) ? 1 : 0}`).join('|');
                    const wsPointsLen = wsPoints.length;
                    const multiHash = regions.map((r: any) =>
                        `${r.id}:${(r.worldSpace?.committed ?? []).length}:${r.localBrightness ?? 0}:${(r.tintColor ?? []).join(',')}:${r.tintBlend ?? 0}`
                    ).join('|') + (isDraftActive
                        // 草稿绘制中也要把工作区点数纳入 hash，确保每次笔刷变更都触发 3D volume 重建。
                        // 否则在“已有区域 + 新建第二个区域”场景里，绘制期间 hash 不变会导致体积预览停住或不显示。
                        ? (`|active=${activeId ?? ''}|ws=${wsPointsLen}|drawing=${this.isDrawing ? 1 : 0}`)
                        : '') + `|vis=${visibilitySig}|soloDraftVol=${bv.draftOnly ? 1 : 0}`;
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
                // 无 regions：仅当会话已是 draft-*（见 bloom-brush-flow pointer 与 LIGHT_BRUSH_START 同步）走草稿体积
                const isDraftOnly = bv.draftOnly;
                if (isDraftOnly) {
                    // 首个亮灯区域草稿：仅 worldSpaceData 有笔刷点，按草稿点建体积并设亮度，实现实时 mask/体积预览
                    const wsPoints = this.worldSpaceData.getAllPoints();
                    const draftBrightness = typeof bloomSettings.bloomBrushBrightness === 'number'
                        ? Math.max(-1, Math.min(1, bloomSettings.bloomBrushBrightness))
                        : 0;
                    const pointsWithBrightness: CommittedPointWithBrightness[] = wsPoints.map(p => ({
                        position: p.position.clone(),
                        radius: p.radius,
                        brightness: draftBrightness
                    }));
                    const draftHash = `draft|ws=${wsPoints.length}|b=${draftBrightness}|drawing=${this.isDrawing ? 1 : 0}`;
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
                } else if (this._lastMultiRegionHash) {
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
                    // 旧逻辑：无 localLightRegions 且非草稿，使用单区域 worldSpaceData / activeRegion
                    const activeRegion = activeId && bv.kind === 'saved'
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

        this.injectBloomMaskBeforeUpdate(cameraFrame);
    }

    private setBloomMaskInScope(): void {
        const graphicsDevice = this.global.app.graphicsDevice;
        const bloom = this.global.settings?.postEffectSettings?.bloom as { threshold?: number } | undefined;
        const brushOn = !!ensureBloomEditorSession(this.global.settings as ExperienceSettings).bloomBrush;
        const maskTex = this.getEffectiveMaskTexture(brushOn);
        try {
            if (maskTex) graphicsDevice.scope.resolve('bloomMaskTexture').setValue(maskTex);
            const th = Math.max(0, Math.min(5, Number(bloom?.threshold ?? 0)));
            graphicsDevice.scope.resolve('bloomThreshold').setValue(th);
            graphicsDevice.scope.resolve('bloomThresholdKnee').setValue(getBloomThresholdKnee(th));
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
        this._lastComposeBloomRequested = false;
        this._pendingComposeBloomWarmupFrames = 0;
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
        const brushSize = Math.max(0.1, Number(bloom?.bloomBrushSize ?? 10));
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

        (this.global.app as any).renderNextFrame = true;
    }

    /**
     * 是否存在当前正在编辑的 LocalLightRegion（含草稿 draft-*）。
     * LIGHT_BRUSH_* / 笔刷 pointer 仅在 bloomBrush 开启且本方法为 true 时生效。
     * @private
     */
    private hasActiveLocalLightRegion(): boolean {
        const id = ensureBloomEditorSession(this.global.settings as ExperienceSettings).activeLocalLightRegionId;
        return id != null && String(id).length > 0;
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
        const bloom = this.global.settings?.postEffectSettings?.bloom as Record<string, unknown> | undefined;
        if (!bloom) return;
        bloom.bloomMode = 'world';
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
        // worldSpacePoints 兼容输入已移除：
        // 运行时只从 localLightRegions / activeLocalLightRegionId 驱动当前工作区。
    }

    /**
     * 将单个 LocalLightRegion 加载到内部 WorldSpaceBloomData，用于编辑该区域或新建完成后写入。
     * 会设置 committedBrightness / localBrightness，并标记当前 active 区域 ID。
     */
    loadRegion(region: LocalLightRegion): void {
        this.worldSpaceData.fromJSON(region.worldSpace);
        const colorBrightness = typeof region.localBrightness === 'number'
            ? Math.max(-1, Math.min(1, region.localBrightness))
            : 1;
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

    /**
     * 计算当前 worldSpaceData 对应区域的世界空间中心（简单几何中心）：
     * - 若存在 committed 点集，则以 committed 为准；
     * - 否则退化为使用当前所有点（points）；
     * - 无点时返回 null。
     * 用于在 LocalLightRegion 绘制完成后为 Lighting 模块提供一个推荐的光源放置位置。
     */
    getCurrentRegionCenter(): Vec3 | null {
        const all = this.worldSpaceData.getAllPoints();
        if (!all.length) return null;
        const center = new Vec3(0, 0, 0);
        for (const p of all) {
            center.add(p.position);
        }
        center.mulScalar(1 / all.length);
        return center;
    }

    /** 清空 NightMode 侧局部亮灯体积（与观看态整灯总闸关闭时的清空路径一致） */
    private clearLocalLightVolumeForNightMode(nightModeScript: NonNullable<ReturnType<BloomControllerOptions['getNightModeScript']>>): void {
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
        nightModeScript.setCommittedTint([1, 1, 1], 0);
        nightModeScript.setCommittedBrightnessVolume(
            texture,
            aabbMin,
            aabbMax,
            1,
            { volumeEncodedBrightness: true }
        );
        nightModeScript.setCommittedTintVolume(null);
    }

    /** reveal 或未就绪时把世界空间 mask 清成全黑，避免沿用上帧笔刷/局部亮灯纹理。 */
    private clearWorldSpaceMaskToBlack(): void {
        const ctx = this.worldSpaceMaskCtx;
        const canvas = this.worldSpaceMaskCanvas;
        const tex = this.worldSpaceMaskTexture;
        if (!ctx || !canvas || !tex) {
            this.hasWorldSpaceMask = false;
            return;
        }
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, MASK_SIZE, MASK_SIZE);
        tex.setSource(canvas);
        tex.upload();
        this._lastMaskSignature = '';
        this.hasWorldSpaceMask = true;
    }

    /** 仅在 Set / 加载配置 / applyToCameraFrame 时同步 committed 到 NightMode；使用 3D 体积纹理，无点数上限 */
    private syncCommittedToNightMode(): void {
        const nightModeScript = this.options.getNightModeScript();
        if (!nightModeScript) return;
        if (!this._bloomStackUnlocked) {
            this.clearLocalLightVolumeForNightMode(nightModeScript);
            return;
        }
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
     * 判断局部亮灯区域是否可见：若区域绑定了光源，则仅当该光源 enabled !== false 时可见；
     * 无绑定或找不到灯则视为可见。供 applyToCameraFrame 与 getPointsForMask 复用。
     */
    private isLocalLightRegionVisible(region: any): boolean {
        const lighting = (this.global.settings as ExperienceSettings).lighting as { lights?: Array<{ id?: string; enabled?: boolean }> } | undefined;
        const lights = Array.isArray(lighting?.lights) ? lighting.lights : undefined;
        const linkedId = region?.linkedLightId;
        if (!linkedId || !lights || lights.length === 0) return true;
        const light = lights.find((l) => l && l.id === linkedId);
        if (!light) return true;
        return light.enabled !== false;
    }

    /**
     * 获取用于 2D mask 投影的点列表：
     * - 绘制中（非擦除）：仅当前 worldSpaceData 笔迹；
     * - 多区域且 `BrushView.draftOnly`：仅草稿工作区点，与其它已提交区域隔离，与体积独奏语义一致；
     * - 否则：各区域 committed 叠加，草稿由 worldSpaceData 代表，避免与 draft region 的 committed 重复；
     * - 无 localLightRegions：回退 worldSpaceData。
     * @private
     */
    private getPointsForMask(): Array<{ position: Vec3; radius: number }> {
        if (!this._bloomStackUnlocked) {
            return [];
        }
        const bloom = this.global.settings?.postEffectSettings?.bloom as {
            localLightRegions?: Array<{ id: string; linkedLightId?: string | null; worldSpace?: { committed?: Array<{ position: [number, number, number]; radius?: number }> } }>;
        } | undefined;
        const regions = bloom?.localLightRegions ?? [];
        const wsPoints = this.worldSpaceData.getAllPoints();
        const bv = this.getBrushView();
        const activeId = ensureBloomEditorSession(this.global.settings as ExperienceSettings).activeLocalLightRegionId ?? null;

        const play = this.readBloomPlayMode(this.readViewBloomLocalLightsEnabled());
        if (this.applyViewerLocalLightPolicy(play, bv.brush, wsPoints.length)) {
            return [];
        }

        // 所有绑定光源均关闭：无笔刷会话则无任何 mask；有会话则交后续逻辑用 worldSpaceData / 草稿点
        if (regions.length > 0 && !regions.some((r) => this.isLocalLightRegionVisible(r)) && !bv.brush) {
            return [];
        }

        // 笔刷绘制中（非擦除）：只返回当前 worldSpaceData 的点做实时预览
        // 擦除模式需要 fall through 到多区域路径，否则其他区域的 2D mask 会消失
        if (bv.tool === 'paint') {
            return wsPoints.map(p => ({ position: p.position, radius: p.radius }));
        }

        const out: Array<{ position: Vec3; radius: number }> = [];

        // 多区域：仅当 active 为草稿时用 worldSpaceData 代表该草稿；否则全部用 localLightRegions（且仅包含绑定灯处于开启状态的区域），
        // 避免展开已有区域时误用空 worldSpaceData 导致区域消失
        if (regions.length > 0) {
            const isDraftActive = bv.kind === 'draft';
            // 与 BrushView.draftOnly：完成前 mask 也只反映当前草稿，不叠其它区域
            if (bv.brush && isDraftActive) {
                return wsPoints.map(p => ({ position: p.position.clone(), radius: p.radius }));
            }
            for (const r of regions) {
                if (!this.isLocalLightRegionVisible(r)) continue;
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
        if (!Number.isFinite(sizeX) || !Number.isFinite(sizeY) || !Number.isFinite(sizeZ)) {
            return false;
        }
        const camPos = camera.getPosition();
        const center = new Vec3(
            (aabbMin.x + aabbMax.x) * 0.5,
            (aabbMin.y + aabbMax.y) * 0.5,
            (aabbMin.z + aabbMax.z) * 0.5
        );
        const distRaw = center.distance(camPos);
        // Math.max(1e-3, NaN) 仍为 NaN，会污染 pixelsPerUnit → maskRadius；相机过渡偶发异常位姿时需兜底。
        const centerDistance = Number.isFinite(distRaw) ? Math.max(1e-3, distRaw) : 1e-3;
        const fovDeg = (sceneCam as { fov?: number }).fov ?? 60;
        const tanHalfFov = Math.tan((fovDeg * Math.PI / 180) * 0.5);
        const pixelsPerUnit = Math.abs(tanHalfFov) > 1e-6
            ? (canvasHeight * 0.5) / (centerDistance * tanHalfFov)
            : 0;
        const voxelWorldSize = Math.max(sizeX, sizeY, sizeZ) / VOLUME_TEX_WIDTH;
        const voxelScreenPx = Math.max(0, voxelWorldSize * pixelsPerUnit);
        // 近景提升采样密度（stride=1），远景维持 stride=2，平衡质量与成本。
        const stride = voxelScreenPx > 1.15 ? 1 : 2;
        // 根据体素屏幕尺寸动态扩大投影圆，减少近景点阵感。
        const maskScaleX = MASK_SIZE / canvasWidth;
        const maskScaleY = MASK_SIZE / canvasHeight;
        const voxelMaskPx = voxelScreenPx * Math.max(maskScaleX, maskScaleY);
        const maskRadius = Math.max(8, Math.min(24, 8 + voxelMaskPx * 2.4));
        // 轻量平滑强度：近景略强，远景较弱。
        const blurPx = Math.max(0.5, Math.min(2.2, 0.5 + voxelMaskPx * 0.3));
        // 相机位姿/FOV 未就绪或数值异常时，避免 createRadialGradient 收到 NaN/Infinity（点路径已有同类校验）。
        if (!Number.isFinite(maskRadius) || !Number.isFinite(blurPx) || maskRadius <= 0) {
            return false;
        }

        let pixels: Uint8Array | undefined;
        try {
            pixels = this.committedVolumeTexture!.lock() as Uint8Array;
        } catch {
            return false;
        }
        const screenPos = new Vec3();
        const worldPos = new Vec3();
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
                    if (!Number.isFinite(screenPos.x) || !Number.isFinite(screenPos.y) || !Number.isFinite(screenPos.z)) {
                        continue;
                    }
                    const maskX = (screenPos.x / canvasWidth) * MASK_SIZE;
                    const maskY = (1 - screenPos.y / canvasHeight) * MASK_SIZE;
                    if (!Number.isFinite(maskX) || !Number.isFinite(maskY)) {
                        continue;
                    }
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
        this.applyMaskSmoothing(blurPx);
        tex.setSource(canvas);
        tex.upload();
        this.hasWorldSpaceMask = true;
        return true;
    }

    /**
     * 对世界空间 mask 做一次低成本平滑，弱化体素投影的点阵观感。
     */
    private applyMaskSmoothing(blurPx: number): void {
        const ctx = this.worldSpaceMaskCtx;
        const canvas = this.worldSpaceMaskCanvas;
        if (!ctx || !canvas || !Number.isFinite(blurPx) || blurPx <= 0) return;

        if (!this.worldSpaceMaskTempCanvas) {
            this.worldSpaceMaskTempCanvas = document.createElement('canvas');
            this.worldSpaceMaskTempCanvas.width = MASK_SIZE;
            this.worldSpaceMaskTempCanvas.height = MASK_SIZE;
            this.worldSpaceMaskTempCtx = this.worldSpaceMaskTempCanvas.getContext('2d');
        }
        const tmpCanvas = this.worldSpaceMaskTempCanvas;
        const tmpCtx = this.worldSpaceMaskTempCtx;
        if (!tmpCtx) return;

        tmpCtx.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
        tmpCtx.drawImage(canvas, 0, 0);
        ctx.clearRect(0, 0, MASK_SIZE, MASK_SIZE);
        ctx.save();
        ctx.filter = `blur(${blurPx.toFixed(2)}px)`;
        ctx.drawImage(tmpCanvas, 0, 0);
        ctx.restore();
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

        if (!this._bloomStackUnlocked) {
            this.clearWorldSpaceMaskToBlack();
            return;
        }

        const camera = this.global.camera;
        const camPos = camera?.getPosition();
        const camFwd = camera?.forward;
        // 签名过于敏感会在相机微抖时频繁重建，形成闪动；过粗又会出现“跟屏滑动”。
        // 使用 3 位小数作为折中：保持空间锚定，同时降低抖动重建频率。
        const posStr = camPos ? `${camPos.x.toFixed(3)},${camPos.y.toFixed(3)},${camPos.z.toFixed(3)}` : '';
        const fwdStr = camFwd ? `${camFwd.x.toFixed(3)},${camFwd.y.toFixed(3)},${camFwd.z.toFixed(3)}` : '';

        // 绘制中不走 volume-based 路径：volume 不含正在绘制的新点，
        // 必须 fall through 到 point-based 投影才能实时预览新笔触。
        if (!this.isDrawing && this.hasValidCommittedVolumeForMask()) {
            const mn = this.committedVolumeAabbMin;
            const mx = this.committedVolumeAabbMax;
            const volStr = `${mn.x.toFixed(3)},${mn.y.toFixed(3)},${mn.z.toFixed(3)},${mx.x.toFixed(3)},${mx.y.toFixed(3)},${mx.z.toFixed(3)}`;
            const signature = `vol:${volStr}:${this._lastMultiRegionHash}:${posStr}:${fwdStr}`;
            if (signature === this._lastMaskSignature) return;
            this._lastMaskSignature = signature;
            if (this.renderWorldSpaceMaskFromVolume()) return;
        }

        const allPoints = this.getPointsForMask();
        const lastPt = allPoints.length > 0 ? allPoints[allPoints.length - 1] : null;
        const pointSig = allPoints.length + (lastPt?.position
            ? `,${lastPt.position.x.toFixed(2)},${lastPt.position.y.toFixed(2)},${lastPt.position.z.toFixed(2)}`
            : '');
        // 绘制中加入 isDrawing 标记使每次新增点都能重建 mask
        const drawTag = this.isDrawing ? `:draw:${allPoints.length}` : '';
        const signature = `${allPoints.length}:${pointSig}:${posStr}:${fwdStr}${drawTag}`;
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
            if (!Number.isFinite(screenPos.x) || !Number.isFinite(screenPos.y) || !Number.isFinite(screenPos.z)) continue;

            const maskX = (screenPos.x / canvasWidth) * MASK_SIZE;
            const maskY = (1 - screenPos.y / canvasHeight) * MASK_SIZE;

            const cameraPos = camera.getPosition();
            const distance = point.position.distance(cameraPos);
            if (!Number.isFinite(distance) || distance < 0.001) continue;

            const fovRad = ((sceneCam as { fov?: number }).fov ?? 60) * (Math.PI / 180);
            const tanHalfFov = Math.tan(fovRad / 2);
            if (!Number.isFinite(tanHalfFov) || Math.abs(tanHalfFov) < 1e-6) continue;
            const pixelsPerUnit = (canvasHeight / 2) / (distance * tanHalfFov);
            const pointRadius = Number.isFinite(point.radius) ? Math.max(0.01, point.radius) : 0.01;
            const screenRadius = Math.max(2, pointRadius * pixelsPerUnit);
            const maskRadius = (screenRadius / canvasWidth) * MASK_SIZE;
            if (!Number.isFinite(maskX) || !Number.isFinite(maskY) || !Number.isFinite(maskRadius) || maskRadius <= 0) continue;

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
     * - bloomScope === 'global'：始终使用全屏白纹理，走全局 Bloom 管线。
     * - bloomScope === 'local'：有世界空间点则用投影 mask；无任何亮灯区域时用世界空间 mask（空=全黑），场景无 bloom。
     * @private
     */
    private getEffectiveMaskTexture(bloomBrushOn: boolean): Texture | null {
        const bloom = this.global.settings?.postEffectSettings?.bloom as { bloomScope?: 'global' | 'local' } | undefined;
        const scope = bloom?.bloomScope === 'global' ? 'global' : 'local';
        if (scope === 'global') {
            return this.bloomBrushWhiteTexture;
        }
        const hasWorldPoints = this.getPointsForMask().length > 0;
        if (hasWorldPoints && this.hasWorldSpaceMask && this.worldSpaceMaskTexture) {
            return this.worldSpaceMaskTexture;
        }
        // 局部模式且无亮灯区域：使用世界空间 mask（空时为黑），使整个场景无 bloom
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

        // 过滤控制器微小抖动，减少无意义的重绘请求。
        const EPSILON = 5e-4;
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
        this.worldSpaceMaskTempCanvas = null;
        this.worldSpaceMaskTempCtx = null;
    }
}
