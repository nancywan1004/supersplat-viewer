import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { Global } from '../types';
import {
    EventHandler,
    Vec3,
    Entity,
    RenderTarget,
    Texture,
    PIXELFORMAT_RGBA8,
    Color
} from 'playcanvas';

/** VFX 导出性能分析：记录各阶段耗时并输出汇总（控制台会打印 [VFX Export Profile]） */
const VFX_EXPORT_PROFILE = false; // 设为 false 可关闭 profiling 日志

/** 每帧准备后的固定等待（ms）。设为 0 可显著加速（profile 显示 waitMs 约占 15s/150 帧）；若 VFX 不依赖该延迟建议保持 0。 */
const EXPORT_FRAME_WAIT_MS = 0;

/** 控制台过滤用：所有 VFX 导出/性能相关 log 均带此 tag，可在 DevTools 中按此关键字过滤 */
const VFX_EXPORT_LOG_TAG = '[VFX Export]';

type ProfileEntry = { name: string; ms: number };
type FrameProfile = {
    seekAnim: number;
    setTimelineAndUpdate: number;
    waitMs: number;
    renderFrame: number;
    raf: number;
    readPixels: number;
    flipBuffer: number;
    encode: number;
    total: number;
};

class ExportProfiler {
    private phaseStart = 0;
    private phaseName = '';
    private frameTimes: FrameProfile[] = [];
    private phaseTimes: ProfileEntry[] = [];

    startPhase(name: string): void {
        this.phaseName = name;
        this.phaseStart = performance.now();
    }

    endPhase(): number {
        const ms = performance.now() - this.phaseStart;
        if (VFX_EXPORT_PROFILE && this.phaseName) {
            this.phaseTimes.push({ name: this.phaseName, ms });
        }
        this.phaseName = '';
        return ms;
    }

    recordFrame(entry: Partial<FrameProfile> & { total: number }): void {
        if (VFX_EXPORT_PROFILE) {
            this.frameTimes.push(entry as FrameProfile);
        }
    }

    logSummary(totalFrames: number, totalDurationSec: number): void {
        if (!VFX_EXPORT_PROFILE) return;
        const totalMs = this.phaseTimes.reduce((s, p) => s + p.ms, 0);
        const tag = VFX_EXPORT_LOG_TAG;
        console.group(`${tag} Profile`);
        console.log(tag, '阶段耗时:');
        this.phaseTimes.forEach(p => {
            const pct = totalMs > 0 ? ((p.ms / totalMs) * 100).toFixed(1) : '0';
            console.log(tag, `  ${p.name}: ${p.ms.toFixed(0)} ms (${pct}%)`);
        });
        console.log(tag, `总耗时: ${(totalMs / 1000).toFixed(2)} s, 帧数: ${totalFrames}, 视频时长: ${totalDurationSec.toFixed(1)}s`);
        if (this.frameTimes.length > 0) {
            const avg: FrameProfile = {
                seekAnim: 0, setTimelineAndUpdate: 0, waitMs: 0, renderFrame: 0, raf: 0,
                readPixels: 0, flipBuffer: 0, encode: 0, total: 0
            };
            this.frameTimes.forEach(f => {
                avg.seekAnim += f.seekAnim ?? 0;
                avg.setTimelineAndUpdate += f.setTimelineAndUpdate ?? 0;
                avg.waitMs += f.waitMs ?? 0;
                avg.renderFrame += f.renderFrame ?? 0;
                avg.raf += f.raf ?? 0;
                avg.readPixels += f.readPixels ?? 0;
                avg.flipBuffer += f.flipBuffer ?? 0;
                avg.encode += f.encode ?? 0;
                avg.total += f.total ?? 0;
            });
            const n = this.frameTimes.length;
            Object.keys(avg).forEach(k => (avg as any)[k] /= n);
            console.log(tag, '单帧平均耗时 (ms):');
            console.log(tag, '  seekAnim:', (avg.seekAnim).toFixed(1), '| setTimeline+update:', (avg.setTimelineAndUpdate).toFixed(1), '| waitMs:', (avg.waitMs).toFixed(1));
            console.log(tag, '  renderFrame:', (avg.renderFrame).toFixed(1), '| rAF:', (avg.raf).toFixed(1), '| readPixels:', (avg.readPixels).toFixed(1));
            console.log(tag, '  flipBuffer:', (avg.flipBuffer).toFixed(1), '| encode:', (avg.encode).toFixed(1), '| total:', (avg.total).toFixed(1));
            const readPct = avg.total > 0 ? ((avg.readPixels / avg.total) * 100).toFixed(0) : '0';
            if (avg.readPixels > 200) {
                console.log(tag, `  → readPixels 占主导 (${readPct}%)，降分辨率可明显加快导出`);
            }
        }
        console.groupEnd();
    }
}

type VideoSettings = {
    startFrame: number;
    endFrame: number;
    frameRate: number;
    width: number;
    height: number;
    bitrate: number;
    transparentBg: boolean;
    showDebug: boolean;
    format: 'mp4' | 'webm' | 'mov' | 'mkv';
    codec: 'h264' | 'h265' | 'vp9' | 'av1';
    /** 勾选「Restart AnimTrack」时导出：VFX 时间轴与相机 animTrack 同步录制 */
    syncAnimTrack?: boolean;
    /** 使用 canvas.captureStream + MediaRecorder 快速导出（约实时，输出 WebM），无 readPixels 瓶颈 */
    useFastExport?: boolean;
    /** 导出视频总时长（秒），基于动画时间轴(animTrack)长度，与 VFX 面板的「Timed VFX 时长」无关 */
    totalDuration?: number;
    /** 为 true 时导出过程中驱动 VFX 特效（含 Timed/非 Timed）；为 false 时 VFX 固定为末尾状态，仅导出 animTrack */
    includeVfx?: boolean;
    /** @deprecated 使用 includeVfx：为 true 时等价于 includeVfx=false */
    fixVfxAtEnd?: boolean;
};

/**
 * 视频编码器配置管理器
 * 负责根据用户设置配置输出格式和编码器参数
 */
class VideoExportConfig {
    public outputFormat: Mp4OutputFormat | MovOutputFormat | MkvOutputFormat | WebMOutputFormat;
    public fileExtension: string;
    public codecType: 'avc' | 'hevc' | 'vp9' | 'av1';
    public codec: string;

    constructor(settings: VideoSettings) {
        this.configureOutputFormat(settings.format);
        this.configureCodec(settings.codec, settings.width, settings.height);
    }

    private configureOutputFormat(format: VideoSettings['format']): void {
        switch (format) {
            case 'webm':
                this.outputFormat = new WebMOutputFormat();
                this.fileExtension = 'webm';
                break;
            case 'mov':
                this.outputFormat = new MovOutputFormat({ fastStart: 'in-memory' });
                this.fileExtension = 'mov';
                break;
            case 'mkv':
                this.outputFormat = new MkvOutputFormat();
                this.fileExtension = 'mkv';
                break;
            default: // mp4
                this.outputFormat = new Mp4OutputFormat({ fastStart: 'in-memory' });
                this.fileExtension = 'mp4';
                break;
        }
    }

    private configureCodec(codecChoice: VideoSettings['codec'], width: number, height: number): void {
        // 根据分辨率计算所需的 AVC Level（仅用于 h264）
        // Level 限制基于最大编码区域（像素数）
        // Level 3.0: 414,720 像素 (约 720×576)
        // Level 3.1: 921,600 像素 (约 1280×720)
        // Level 4.0: 2,097,152 像素 (约 1920×1080)
        // Level 4.2: 5,222,400 像素 (约 3840×1360)
        // Level 5.0: 5,898,240 像素 (约 4096×1440)
        // Level 5.1: 9,830,400 像素 (约 4096×2400)
        const codedArea = width * height;
        
        switch (codecChoice) {
            case 'h264':
                this.codecType = 'avc';
                
                // 根据编码区域选择 Level，而不是根据高度
                // Level 编码：3.0=0x1E(30), 3.1=0x1F(31), 4.0=0x28(40), 4.1=0x29(41), 4.2=0x2A(42), 5.0=0x32(50), 5.1=0x33(51)
                if (codedArea <= 414720) {
                    // Level 3.0: 最大约 720×576
                    if (height <= 480) {
                        this.codec = 'avc1.42001E'; // Baseline Profile, Level 3.0 (0x1E=30)
                    } else {
                        this.codec = 'avc1.4D001F'; // Main Profile, Level 3.1 (0x1F=31)
                    }
                } else if (codedArea <= 921600) {
                    // Level 3.1: 最大约 1280×720
                    this.codec = 'avc1.4D001F'; // Main Profile, Level 3.1 (0x1F=31)
                } else if (codedArea <= 2097152) {
                    // Level 4.0: 最大约 1920×1080
                    // 注意：编码器可能会将高度调整为宏块对齐（如 1080 -> 1088）
                    // 所以需要确保即使调整后也在 Level 4.0 限制内
                    // 1920×1088 = 2,088,960 < 2,097,152 (Level 4.0 限制)
                    this.codec = 'avc1.640028'; // High Profile, Level 4.0 (0x28=40)
                    console.log(VFX_EXPORT_LOG_TAG, `Selected codec: ${this.codec} for resolution ${width}x${height} (codedArea: ${codedArea})`);
                } else if (codedArea <= 5222400) {
                    // Level 4.2: 最大约 3840×1360
                    this.codec = 'avc1.64002A'; // High Profile, Level 4.2 (0x2A=42)
                } else if (codedArea <= 5898240) {
                    // Level 5.0: 最大约 4096×1440
                    this.codec = 'avc1.640032'; // High Profile, Level 5.0 (0x32=50)
                } else {
                    // Level 5.1: 最大约 4096×2400
                    this.codec = 'avc1.640033'; // High Profile, Level 5.1 (0x33=51)
                }
                break;
            case 'h265':
                this.codecType = 'hevc';
                this.codec = 'hev1.1.6.L120.B0';
                break;
            case 'vp9':
                this.codecType = 'vp9';
                this.codec = 'vp09.00.10.08';
                break;
            case 'av1':
                this.codecType = 'av1';
                this.codec = 'av01.0.05M.08';
                break;
            default: // 默认h264
                this.codecType = 'avc';
                if (codedArea <= 414720) {
                    if (height <= 480) {
                        this.codec = 'avc1.42001E'; // Level 3.0
                    } else {
                        this.codec = 'avc1.4D001F'; // Level 3.1
                    }
                } else if (codedArea <= 921600) {
                    this.codec = 'avc1.4D001F'; // Level 3.1
                } else if (codedArea <= 2097152) {
                    this.codec = 'avc1.640028'; // Level 4.0
                } else if (codedArea <= 5222400) {
                    this.codec = 'avc1.64002A'; // Level 4.2
                } else if (codedArea <= 5898240) {
                    this.codec = 'avc1.640032'; // Level 5.0
                } else {
                    this.codec = 'avc1.640033'; // Level 5.1
                }
                break;
        }
    }
}

/**
 * SuperSplat 式离屏导出：接管主相机管线，只把「最终输出」从 canvas 改到我们的 RT，
 * 其它 pass（splat、compose 等）照常跑，主 canvas 不再更新（画面定格），导出从 RT 读帧。
 * 优化：双 RT 交替 + 异步 readback（immediate:false）+ 预分配 buffer + 流水线并行。
 * 注：智能跳过 splat 排序（相机未动时）由 PlayCanvas gsplat-manager 的 cameraMovedEnough() 处理。
 */
export class RenderManager {
    private global: Global;
    private exportRTs: [RenderTarget | null, RenderTarget | null] = [null, null];
    private renderTargetIndex = 0;
    private savedComposeTarget: RenderTarget | null | undefined = undefined;
    private savedAfterTarget: RenderTarget | null | undefined = undefined;
    private savedCameraRenderTarget: RenderTarget | null | undefined = undefined;
    private renderPassCamera: any = null;
    private usedCameraFramePath = false;

    constructor(global: Global) {
        this.global = global;
    }

    startOffscreenMode(settings: VideoSettings): void {
        this.endOffscreenMode();

        const { app, camera } = this.global;
        const device = app.graphicsDevice;
        const width = settings.width;
        const height = settings.height;

        for (let i = 0; i < 2; i++) {
            const colorBuffer = new Texture(device, {
                name: `exportColor${i}`,
                width,
                height,
                format: PIXELFORMAT_RGBA8,
                mipmaps: false
            });
            this.exportRTs[i] = new RenderTarget({
                colorBuffer,
                depth: true,
                autoResolve: true
            });
        }
        this.renderTargetIndex = 0;

        const viewer = (app as any).viewer;
        const engineCameraFrame = viewer?.cameraFrame;
        this.renderPassCamera = engineCameraFrame?.renderPassCamera ?? null;
        const currentRT = this.exportRTs[0];

        if (this.renderPassCamera?.composePass != null && this.renderPassCamera?.afterPass != null) {
            this.usedCameraFramePath = true;
            this.savedComposeTarget = this.renderPassCamera.composePass.renderTarget;
            this.savedAfterTarget = this.renderPassCamera.afterPass.renderTarget;
            this.renderPassCamera.composePass.renderTarget = currentRT;
            this.renderPassCamera.afterPass.renderTarget = currentRT;
        } else {
            this.usedCameraFramePath = false;
            const camComp = (camera as Entity & { camera?: { renderTarget?: RenderTarget | null } }).camera;
            this.savedCameraRenderTarget = camComp?.renderTarget ?? undefined;
            if (camComp) camComp.renderTarget = currentRT;
        }
    }

    endOffscreenMode(): void {
        if (this.usedCameraFramePath && this.renderPassCamera) {
            this.renderPassCamera.composePass.renderTarget = this.savedComposeTarget ?? null;
            this.renderPassCamera.afterPass.renderTarget = this.savedAfterTarget ?? null;
        } else if (!this.usedCameraFramePath && this.global.camera) {
            const camComp = (this.global.camera as Entity & { camera?: { renderTarget?: RenderTarget | null } }).camera;
            if (camComp) camComp.renderTarget = this.savedCameraRenderTarget ?? null;
        }
        this.renderPassCamera = null;
        this.savedComposeTarget = this.savedAfterTarget = this.savedCameraRenderTarget = undefined;
        this.usedCameraFramePath = false;

        for (let i = 0; i < 2; i++) {
            if (this.exportRTs[i]) {
                this.exportRTs[i]!.destroy();
                this.exportRTs[i] = null;
            }
        }
    }

    /**
     * 触发主相机管线跑一帧；每帧交替写入两个 RT，返回本帧写入的 RT（便于流水线：上一帧在另一 RT 可异步读）。
     */
    async renderExportFrame(): Promise<RenderTarget | null> {
        const rt = this.exportRTs[this.renderTargetIndex];
        if (!rt) return null;

        const { app } = this.global;
        if (this.renderPassCamera?.composePass != null && this.renderPassCamera?.afterPass != null) {
            this.renderPassCamera.composePass.renderTarget = rt;
            this.renderPassCamera.afterPass.renderTarget = rt;
        } else if (this.global.camera) {
            const camComp = (this.global.camera as Entity & { camera?: { renderTarget?: RenderTarget | null } }).camera;
            if (camComp) camComp.renderTarget = rt;
        }

        app.renderNextFrame = true;

        return new Promise<RenderTarget | null>((resolve) => {
            app.once('frameend', () => {
                this.renderTargetIndex = 1 - this.renderTargetIndex;
                resolve(rt);
            });
        });
    }
}

/**
 * 渲染一帧到主 canvas（不经过离屏 RT）。
 * 用于「快速导出」：设置 VFX 时间 → 脚本 update → 触发一帧渲染到屏幕，由 captureStream 录制。
 */
export async function prepareAndRenderOneFrameToCanvas(global: Global, effectTime: number): Promise<void> {
    global.events.fire('effectTimeline:setForExport', effectTime);
    const gsplatEntity = global.app.root.findByName('gsplat') as Entity | null;
    if (gsplatEntity?.script) {
        const scripts = (gsplatEntity.script as any).scripts as Array<{ update?: (dt: number) => void }> | undefined;
        if (Array.isArray(scripts)) {
            for (const s of scripts) if (s?.update) s.update(0);
        }
    }
    global.app.renderNextFrame = true;
    await new Promise<void>(resolve => global.app.once('frameend', () => resolve()));
}

/**
 * 与「测试捕获单帧」完全一致的一帧流程：设置 VFX 时间 → 等待 → 离屏渲染。
 * 单帧测试和批量导出都复用此函数，保证行为一致。
 * @param runScriptUpdate 导出时传 true，在设置 effectTime 后手动触发脚本 update，避免 isExportingVfxVideo 下引擎不跑脚本导致黑屏
 * @param profile 可选，用于 profiling：写入 setTimelineAndUpdate / waitMs / renderFrame 耗时（ms）
 */
export async function prepareAndRenderOneFrame(
    global: Global,
    renderManager: RenderManager,
    effectTime: number,
    options?: { waitMs?: number; runScriptUpdate?: boolean; profile?: { setTimelineAndUpdate: number; waitMs: number; renderFrame: number } }
): Promise<RenderTarget | null> {
    const t0 = VFX_EXPORT_PROFILE ? performance.now() : 0;
    global.events.fire('effectTimeline:setForExport', effectTime);
    if (options?.runScriptUpdate) {
        const gsplatEntity = global.app.root.findByName('gsplat') as Entity | null;
        if (gsplatEntity?.script) {
            const scripts = (gsplatEntity.script as any).scripts as Array<{ update?: (dt: number) => void }> | undefined;
            if (Array.isArray(scripts)) {
                for (const s of scripts) if (s?.update) s.update(0);
            }
        }
    }
    const t1 = VFX_EXPORT_PROFILE ? performance.now() : 0;
    const waitMs = options?.waitMs ?? 0;
    await new Promise(r => setTimeout(r, waitMs));
    const t2 = VFX_EXPORT_PROFILE ? performance.now() : 0;
    const rt = await renderManager.renderExportFrame();
    const t3 = VFX_EXPORT_PROFILE ? performance.now() : 0;
    if (options?.profile && VFX_EXPORT_PROFILE) {
        options.profile.setTimelineAndUpdate = t1 - t0;
        options.profile.waitMs = t2 - t1;
        options.profile.renderFrame = t3 - t2;
    }
    return rt;
}

/**
 * 帧处理器
 * 负责从离屏 RenderTarget 读像素、翻转、编码。
 * 「准备+渲染」统一用 prepareAndRenderOneFrame，与单帧测试一致。
 */
class FrameProcessor {
    private lastCameraPosition = new Vec3(0, 0, 0);
    private lastCameraForward = new Vec3(1, 0, 0);
    /** 预分配：最终翻转后的帧数据，也作为 read() 的 data 目标以避免每帧分配 */
    private frameBuffer: Uint8Array;
    private lineBuffer: Uint8Array;
    /** 预分配：Float32 纹理读回时转 Uint8 的临时缓冲，减少 GC */
    private floatToUint8Buffer: Uint8Array;
    constructor(private global: Global, width: number, height: number) {
        const size = width * height * 4;
        this.frameBuffer = new Uint8Array(size);
        this.lineBuffer = new Uint8Array(width * 4);
        this.floatToUint8Buffer = new Uint8Array(size);
    }

    /**
     * 清理资源
     */
    destroy(): void {
        // 当前实现中 FrameProcessor 不持有独立的 RenderTarget 资源，
        // 仅依赖 RenderManager 提供的导出 RenderTarget，因此这里无需清理。
    }


    /**
     * 从 RenderTarget 捕获帧：异步 GPU readback（immediate: false）+ 预分配 buffer，不阻塞 GPU。
     * @param profile 可选，用于 profiling：写入 flipBuffer 耗时（ms）
     */
    private async captureFromRenderTarget(
        sourceTarget: RenderTarget,
        width: number,
        height: number,
        profile?: Partial<Pick<FrameProfile, 'flipBuffer'>>
    ): Promise<boolean> {
        if (!sourceTarget.colorBuffer) {
            console.error(VFX_EXPORT_LOG_TAG, 'Export RenderTarget has no colorBuffer');
            return false;
        }
        try {
            const tex = sourceTarget.colorBuffer;
            const opts: { renderTarget: RenderTarget; immediate?: boolean; data?: Uint8Array } = {
                renderTarget: sourceTarget,
                immediate: false,
                data: this.frameBuffer
            };
            const flipStart = VFX_EXPORT_PROFILE && profile ? performance.now() : 0;
            const data = await tex.read(0, 0, width, height, opts);
            if (data instanceof Uint8Array) {
                if (data === this.frameBuffer) {
                    this.flipBufferVertically(width, height);
                } else {
                    this.flipBufferVerticallyFromSource(data, width, height);
                }
                if (VFX_EXPORT_PROFILE && profile) (profile as { flipBuffer: number }).flipBuffer = performance.now() - flipStart;
                return true;
            }
            if (data instanceof Float32Array) {
                const buf = this.floatToUint8Buffer;
                for (let i = 0; i < data.length; i++) {
                    buf[i] = Math.max(0, Math.min(255, Math.floor(data[i] * 255)));
                }
                this.flipBufferVerticallyFromSource(buf, width, height);
                if (VFX_EXPORT_PROFILE && profile) (profile as { flipBuffer: number }).flipBuffer = performance.now() - flipStart;
                return true;
            }
            console.warn(VFX_EXPORT_LOG_TAG, `Unsupported color buffer format: ${data.constructor.name}`);
            return false;
        } catch (error) {
            console.error(VFX_EXPORT_LOG_TAG, 'Failed to read pixels from RenderTarget:', error);
            return false;
        }
    }

    /**
     * 异步 readback：不阻塞，返回 Promise；resolve 后 frameBuffer 已就绪可编码。
     * 用于流水线并行：在等待上一帧 readback 时下一帧可已开始渲染。
     */
    startAsyncRead(
        sourceTarget: RenderTarget | null,
        width: number,
        height: number,
        profile?: Partial<Pick<FrameProfile, 'readPixels' | 'flipBuffer'>>
    ): Promise<boolean> {
        if (!sourceTarget?.colorBuffer) return Promise.resolve(false);
        const readStart = VFX_EXPORT_PROFILE && profile ? performance.now() : 0;
        const opts: { renderTarget: RenderTarget; immediate?: boolean; data?: Uint8Array } = {
            renderTarget: sourceTarget,
            immediate: false,
            data: this.frameBuffer
        };
        return sourceTarget.colorBuffer
            .read(0, 0, width, height, opts)
            .then((data) => {
                if (VFX_EXPORT_PROFILE && profile) profile.readPixels = performance.now() - readStart;
                const flipStart = VFX_EXPORT_PROFILE && profile ? performance.now() : 0;
                if (data instanceof Uint8Array) {
                    if (data === this.frameBuffer) {
                        this.flipBufferVertically(width, height);
                    } else {
                        this.flipBufferVerticallyFromSource(data, width, height);
                    }
                    if (VFX_EXPORT_PROFILE && profile) (profile as { flipBuffer: number }).flipBuffer = performance.now() - flipStart;
                    return true;
                }
                if (data instanceof Float32Array) {
                    const buf = this.floatToUint8Buffer;
                    for (let i = 0; i < data.length; i++) {
                        buf[i] = Math.max(0, Math.min(255, Math.floor(data[i] * 255)));
                    }
                    this.flipBufferVerticallyFromSource(buf, width, height);
                    if (VFX_EXPORT_PROFILE && profile) (profile as { flipBuffer: number }).flipBuffer = performance.now() - flipStart;
                    return true;
                }
                return false;
            })
            .catch((err) => {
                console.error(VFX_EXPORT_LOG_TAG, 'Async read failed:', err);
                return false;
            });
    }

    /**
     * 仅编码当前 frameBuffer 中的一帧（用于流水线：readback 已完成后再编码）。
     */
    encodeCurrentFrame(
        frameTime: number,
        frameRate: number,
        encoder: VideoEncoder | null,
        width: number,
        height: number,
        frameProfile?: Partial<FrameProfile>
    ): boolean {
        if (!encoder || (encoder as any)._errorOccurred || encoder.state === 'closed') return false;
        const evenWidth = width % 2 === 0 ? width : width - 1;
        const evenHeight = height % 2 === 0 ? height : height - 1;
        const timestampMicroseconds = Math.floor(frameTime * 1e6);
        const durationMicroseconds = Math.floor(1e6 / frameRate);
        const encodeStart = VFX_EXPORT_PROFILE && frameProfile ? performance.now() : 0;
        let videoFrame: VideoFrame | null = null;
        try {
            videoFrame = new VideoFrame(this.frameBuffer, {
                format: 'RGBA',
                codedWidth: evenWidth,
                codedHeight: evenHeight,
                timestamp: timestampMicroseconds,
                duration: durationMicroseconds,
                displayWidth: evenWidth,
                displayHeight: evenHeight
            });
            encoder.encode(videoFrame);
            if (VFX_EXPORT_PROFILE && frameProfile) frameProfile.encode = performance.now() - encodeStart;
            return true;
        } catch (e) {
            if (videoFrame) videoFrame.close();
            return false;
        } finally {
            if (videoFrame) videoFrame.close();
        }
    }

    /**
     * 捕获当前视频帧
     * @param frameProfile 可选，用于 profiling：写入 raf / readPixels / flipBuffer / encode 耗时（ms）
     */
    async captureFrame(
        frameTime: number,
        frameRate: number,
        encoder: VideoEncoder | null,
        width: number,
        height: number,
        exportTarget: RenderTarget | null,
        frameProfile?: Partial<FrameProfile>
    ): Promise<boolean> {
        // 检查编码器是否有效
        if (!encoder || (encoder as any)._errorOccurred) {
            console.warn(VFX_EXPORT_LOG_TAG, 'Encoder is closed or has error, skipping frame');
            return false;
        }
        
        // 检查编码器状态
        if (encoder.state === 'closed') {
            console.warn(VFX_EXPORT_LOG_TAG, 'Encoder is closed, skipping frame');
            return false;
        }
        
        // H264 要求偶数尺寸，确保使用偶数尺寸
        const evenWidth = width % 2 === 0 ? width : width - 1;
        const evenHeight = height % 2 === 0 ? height : height - 1;
        
        // 从导出相机的 RenderTarget 捕获（与单帧测试同一套离屏管线）
        let captured = false;
        if (exportTarget) {
            // RenderPassForward.render() 是同步的，但 GPU 可能需要时间完成渲染
            // 使用 requestAnimationFrame 确保 GPU 完成渲染后再读取像素
            const rafStart = VFX_EXPORT_PROFILE && frameProfile ? performance.now() : 0;
            await new Promise(resolve => requestAnimationFrame(resolve));
            if (VFX_EXPORT_PROFILE && frameProfile) {
                frameProfile.raf = performance.now() - rafStart;
            }
            const readStart = VFX_EXPORT_PROFILE && frameProfile ? performance.now() : 0;
            captured = await this.captureFromRenderTarget(exportTarget, evenWidth, evenHeight, frameProfile);
            if (VFX_EXPORT_PROFILE && frameProfile) {
                frameProfile.readPixels = performance.now() - readStart; // 含 GPU read + 垂直翻转（flip 单独记录在 flipBuffer）
            }
        }
        
        // 如果 RenderTarget 方法失败，回退到 canvas 方法
        if (!captured) {
            const { app } = this.global;
            const device = app.graphicsDevice;
            const canvas = device.canvas as HTMLCanvasElement;
            
            if (!canvas) {
                console.error(VFX_EXPORT_LOG_TAG, 'Canvas not found');
                return false;
            }
            
            // 从 PlayCanvas canvas 读取像素数据（备用方法）
            try {
                // 获取实际的 canvas 尺寸
                const sourceWidth = canvas.width || canvas.clientWidth || device.width;
                const sourceHeight = canvas.height || canvas.clientHeight || device.height;
                
                if (sourceWidth === 0 || sourceHeight === 0) {
                    console.error(VFX_EXPORT_LOG_TAG, `Invalid canvas size: ${sourceWidth}x${sourceHeight}`);
                    return false;
                }
                
                // 创建一个离屏 canvas 用于读取像素
                const offscreenCanvas = document.createElement('canvas');
                offscreenCanvas.width = evenWidth;
                offscreenCanvas.height = evenHeight;
                const ctx = offscreenCanvas.getContext('2d', { willReadFrequently: true });
                
                if (!ctx) {
                    throw new Error('Failed to get 2d context');
                }
                
                // 将当前 canvas 内容绘制到离屏 canvas（支持缩放）
                try {
                    ctx.drawImage(canvas, 0, 0, sourceWidth, sourceHeight, 0, 0, evenWidth, evenHeight);
                } catch (drawError) {
                    console.warn(VFX_EXPORT_LOG_TAG, 'Direct drawImage failed, trying toDataURL method:', drawError);
                    // 如果直接绘制失败，尝试使用 toDataURL
                    const dataUrl = canvas.toDataURL('image/png');
                    const img = new Image();
                    await new Promise((resolve, reject) => {
                        img.onload = resolve;
                        img.onerror = reject;
                        img.src = dataUrl;
                    });
                    ctx.drawImage(img, 0, 0, evenWidth, evenHeight);
                }
                
                // 从离屏 canvas 读取像素数据（RGBA格式）
                const imageData = ctx.getImageData(0, 0, evenWidth, evenHeight);
                
                // 检查是否有内容（调试用）
                let hasContent = false;
                let maxR = 0, maxG = 0, maxB = 0;
                for (let i = 0; i < Math.min(imageData.data.length, 10000); i += 4) {
                    const r = imageData.data[i];
                    const g = imageData.data[i + 1];
                    const b = imageData.data[i + 2];
                    maxR = Math.max(maxR, r);
                    maxG = Math.max(maxG, g);
                    maxB = Math.max(maxB, b);
                    if (r > 10 || g > 10 || b > 10) {
                        hasContent = true;
                    }
                }
                // 复制到 frameBuffer（需要垂直翻转，因为 canvas 坐标系与视频帧不同）
                this.flipBufferVerticallyFromSource(imageData.data, evenWidth, evenHeight);
                captured = true;
            } catch (error) {
                console.error(VFX_EXPORT_LOG_TAG, 'Canvas capture also failed:', error);
                return false;
            }
        }
        
        if (!captured) {
            return false;
        }

        // 构造视频帧
        // 时间戳以微秒为单位，确保递增且与帧率匹配
        // frameTime 是秒数，转换为微秒
        const timestampMicroseconds = Math.floor(frameTime * 1e6);
        // duration 是每帧的持续时间（微秒）
        const durationMicroseconds = Math.floor(1e6 / frameRate);
        
        let videoFrame: VideoFrame | null = null;
        const encodeStart = VFX_EXPORT_PROFILE && frameProfile ? performance.now() : 0;
        try {
            videoFrame = new VideoFrame(this.frameBuffer, {
                format: 'RGBA',
                codedWidth: evenWidth,
                codedHeight: evenHeight,
                timestamp: timestampMicroseconds,
                duration: durationMicroseconds,
                // 添加显示尺寸，确保与编码尺寸一致
                displayWidth: evenWidth,
                displayHeight: evenHeight
            });

            // 尝试编码帧
            encoder.encode(videoFrame);
            if (VFX_EXPORT_PROFILE && frameProfile) {
                frameProfile.encode = performance.now() - encodeStart;
            }
            return true;
        } catch (error) {
            console.warn(VFX_EXPORT_LOG_TAG, 'Failed to create or encode video frame:', error);
            return false;
        } finally {
            // 确保 VideoFrame 总是被关闭
            if (videoFrame) {
                videoFrame.close();
            }
        }
    }
    
    /**
     * 从源缓冲区垂直翻转数据到 frameBuffer
     */
    private flipBufferVerticallyFromSource(source: Uint8Array | Uint8ClampedArray, width: number, height: number): void {
        const data = this.frameBuffer;

        for (let y = 0; y < height; y++) {
            const srcY = height - 1 - y;
            const srcOffset = srcY * width * 4;
            const dstOffset = y * width * 4;
            
            // 复制一行数据（RGBA，4字节）
            for (let x = 0; x < width * 4; x++) {
                data[dstOffset + x] = source[srcOffset + x];
            }
        }
    }

    /**
     * 填充模拟帧数据（仅用于演示架构）
     */
    private fillMockFrameData(width: number, height: number): void {
        // 创建简单的渐变效果作为演示
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const index = (y * width + x) * 4;
                this.frameBuffer[index] = (x / width) * 255;     // R
                this.frameBuffer[index + 1] = (y / height) * 255; // G
                this.frameBuffer[index + 2] = 128;                // B
                this.frameBuffer[index + 3] = 255;                // A
            }
        }
    }

    /**
     * 垂直翻转帧缓冲区
     */
    private flipBufferVertically(width: number, height: number): void {
        const data = this.frameBuffer;
        const line = this.lineBuffer;

        for (let y = 0; y < height / 2; y++) {
            const top = y * width * 4;
            const bottom = (height - y - 1) * width * 4;
            
            line.set(data.subarray(top, top + width * 4));
            data.copyWithin(top, bottom, bottom + width * 4);
            data.set(line, bottom);
        }
    }
}

/**
 * 初始化视频导出功能
 * 监听 'render.video' 事件并执行视频导出
 * 
 * @param global - 全局对象，包含 app、events 等
 */
export const initVideoExport = (global: Global): void => {
    const renderManager = new RenderManager(global);
    const { events } = global;

    // 跟踪当前 UI 所在的 VFX 时间（用于导出结束后恢复）
    let lastUiEffectTime = 0;
    events.on('effectTime:changed', (time: number) => {
        lastUiEffectTime = time;
    });

    /**
     * 本地化文本（占位符实现）
     */
    const localize = (key: string, params?: any): string => {
        // 这里应该实现真正的本地化逻辑
        return key;
    };

    /**
     * 创建视频编码器
     */
    const createVideoEncoder = (videoSource: EncodedVideoPacketSource, codec: string, settings: VideoSettings): VideoEncoder | null => {
        // H264 编码器要求宽度和高度都是偶数
        const evenWidth = settings.width % 2 === 0 ? settings.width : settings.width - 1;
        const evenHeight = settings.height % 2 === 0 ? settings.height : settings.height - 1;
        
        if (evenWidth !== settings.width || evenHeight !== settings.height) {
            console.warn(VFX_EXPORT_LOG_TAG, `Video dimensions adjusted from ${settings.width}x${settings.height} to ${evenWidth}x${evenHeight} for H264 compatibility`);
        }
        
        const encoder = new VideoEncoder({
            output: async (chunk, meta) => {
                const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                await videoSource.add(encodedPacket, meta);
            },
            error: (error) => {
                console.error(VFX_EXPORT_LOG_TAG, 'Video encoding error:', error);
                // 编码器错误时，标记为已关闭，防止继续编码
                (encoder as any)._errorOccurred = true;
            }
        });
        
        try {
            // 配置编码器，添加 QuickTime Player 兼容性所需的参数
            // 注意：framerate 是必需的，确保时间戳正确
            console.log(VFX_EXPORT_LOG_TAG, `Configuring encoder with codec: ${codec}, resolution: ${evenWidth}x${evenHeight}`);
            encoder.configure({
                codec,
                width: evenWidth,
                height: evenHeight,
                bitrate: settings.bitrate,
                framerate: settings.frameRate
                // 注意：keyFrameInterval 和 hardwareAcceleration 在某些浏览器中可能不支持
                // 如果浏览器支持，会自动使用合适的默认值
            });
            
            console.log(VFX_EXPORT_LOG_TAG, `Encoder configured successfully with codec: ${codec}`);
            return encoder;
        } catch (error) {
            console.error(VFX_EXPORT_LOG_TAG, 'Failed to configure video encoder:', error);
            encoder.close();
            return null;
        }
    };

    // SuperSplat 风格中有一个 postRender() 来等待一次离屏渲染完成，
    // 这里我们直接复用 FrameProcessor.waitForRenderComplete()，不再单独暴露 waitForRender。

    /**
     * 更新进度
     */
    const updateProgress = (frameTime: number, duration: number): void => {
        global.events.fire('progressUpdate', {
            text: localize('panel.render.rendering', { ellipsis: true }),
            progress: 100 * frameTime / duration
        });
    };

    /**
     * 将 animTrack 定位到 effectTime 并应用到主相机（勾选 Restart AnimTrack 时与 VFX 时间轴同步录制相机）
     */
    const seekAnimToTimeAndApply = (g: Global, effectTime: number): void => {
        const viewer = (g.app as any).viewer as { cameraManager?: { seekAnimToTime: (t: number) => void; camera: unknown }; applyCameraFromManager?: () => void } | undefined;
        if (!viewer?.cameraManager?.seekAnimToTime || !viewer.applyCameraFromManager) return;
        viewer.cameraManager.seekAnimToTime(effectTime);
        viewer.applyCameraFromManager();
    };

    /**
     * 渲染所有帧：与单帧截获完全相同的流程，循环执行。
     * 每帧（若 syncAnimTrack）：先 seek anim 并应用相机 → prepareAndRenderOneFrame → requestAnimationFrame → captureFrame
     * @param profiler 可选，用于 VFX 导出性能分析
     */
    const renderAllFrames = async (
        frameProcessor: FrameProcessor,
        encoder: VideoEncoder | null,
        settings: VideoSettings,
        renderManager: RenderManager,
        profiler?: ExportProfiler
    ): Promise<void> => {
        if (!encoder) throw new Error('Encoder is not available');
        const { frameRate, width, height, syncAnimTrack } = settings;
        const evenWidth = width % 2 === 0 ? width : width - 1;
        const evenHeight = height % 2 === 0 ? height : height - 1;
        const totalDuration = settings.totalDuration ?? global.settings?.revealEffect?.totalDuration ?? 20.0;
        const includeVfx = settings.includeVfx !== false;
        // 不包含 VFX 时固定为「VFX 自身总时长」的最后一帧，这样整段视频都能看到完整效果状态（Timed/非 Timed 一致）
        const vfxTotalDuration = global.settings?.revealEffect?.totalDuration ?? 20.0;
        const totalFrames = Math.ceil(totalDuration * frameRate);
        const frameInterval = 1.0 / frameRate;

        let prevReadPromise: Promise<boolean> | null = null;
        let prevFrameTime = 0;
        let prevFrameProfile: FrameProfile | undefined;

        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            if (encoder.state === 'closed' || (encoder as any)._errorOccurred) break;
            const frameTime = Math.min(frameIndex * frameInterval, totalDuration);
            const effectTime = includeVfx ? frameTime : vfxTotalDuration;

            const frameProfile: FrameProfile = {
                seekAnim: 0, setTimelineAndUpdate: 0, waitMs: 0, renderFrame: 0, raf: 0,
                readPixels: 0, flipBuffer: 0, encode: 0, total: 0
            };
            const tFrameStart = VFX_EXPORT_PROFILE ? performance.now() : 0;

            // 不包含 VFX 时也必须每帧驱动 anim，否则导出的视频里相机不动；包含 VFX 时按 syncAnimTrack 决定是否同步
            if (syncAnimTrack || !includeVfx) {
                const t0 = VFX_EXPORT_PROFILE ? performance.now() : 0;
                seekAnimToTimeAndApply(global, frameTime);
                if (VFX_EXPORT_PROFILE) frameProfile.seekAnim = performance.now() - t0;
            }

            const prepareProfile = VFX_EXPORT_PROFILE ? { setTimelineAndUpdate: 0, waitMs: 0, renderFrame: 0 } : undefined;
            const exportTarget = await prepareAndRenderOneFrame(global, renderManager, effectTime, {
                waitMs: EXPORT_FRAME_WAIT_MS,
                runScriptUpdate: true,
                profile: prepareProfile
            });
            if (VFX_EXPORT_PROFILE && prepareProfile) {
                frameProfile.setTimelineAndUpdate = prepareProfile.setTimelineAndUpdate;
                frameProfile.waitMs = prepareProfile.waitMs;
                frameProfile.renderFrame = prepareProfile.renderFrame;
            }
            await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
            if (VFX_EXPORT_PROFILE) frameProfile.raf = 0;

            // 流水线：先发起本帧异步 readback（不 await），再处理上一帧的 readback + 编码
            const readPromise = frameProcessor.startAsyncRead(
                exportTarget ?? null,
                evenWidth,
                evenHeight,
                VFX_EXPORT_PROFILE ? frameProfile : undefined
            );

            if (prevReadPromise) {
                const prevOk = await prevReadPromise;
                if (prevOk) {
                    frameProcessor.encodeCurrentFrame(
                        prevFrameTime,
                        frameRate,
                        encoder,
                        evenWidth,
                        evenHeight,
                        VFX_EXPORT_PROFILE ? prevFrameProfile : undefined
                    );
                } else {
                    console.warn(VFX_EXPORT_LOG_TAG, `Failed to capture frame at VFX time ${prevFrameTime.toFixed(2)}s`);
                }
            }

            prevReadPromise = readPromise;
            prevFrameTime = frameTime;
            prevFrameProfile = frameProfile;
            if (VFX_EXPORT_PROFILE) {
                frameProfile.total = performance.now() - tFrameStart;
                profiler?.recordFrame(frameProfile);
            }
            updateProgress(frameTime, totalDuration);
        }

        if (prevReadPromise) {
            const lastOk = await prevReadPromise;
            if (lastOk) {
                frameProcessor.encodeCurrentFrame(
                    prevFrameTime,
                    frameRate,
                    encoder,
                    evenWidth,
                    evenHeight,
                    VFX_EXPORT_PROFILE ? prevFrameProfile : undefined
                );
            } else {
                console.warn(VFX_EXPORT_LOG_TAG, `Failed to capture last frame at VFX time ${prevFrameTime.toFixed(2)}s`);
            }
        }
    };

    /**
     * 处理下载
     */
    const handleDownload = async (output: Output, target: any, fileStream: FileSystemWritableFileStream | undefined, fileExtension: string): Promise<void> => {
        if (!fileStream) {
            const filename = `supersplat-video.${fileExtension}`;
            
            // 这里应该有downloadFile函数，但不在当前作用域中
            // downloadFile((output.target as BufferTarget).buffer, filename);
            console.log(VFX_EXPORT_LOG_TAG, `Video export complete: ${filename}`);
        }
    };

    /**
     * 处理导出错误
     */
    const handleExportError = async (error: any): Promise<void> => {
        // 简化错误处理，直接输出到控制台
        console.error(VFX_EXPORT_LOG_TAG, 'Video export error:', error);
        // 如果有错误处理的事件，可以这样触发:
        // global.events.fire('showPopup', {
        //     type: 'error',
        //     header: localize('render.failed'),
        //     message: `'${error.message ?? error}'`
        // });
    };

    /**
     * 清理资源
     */
    const cleanup = (): void => {
        renderManager.endOffscreenMode();
        global.events.fire('progressEnd');
    };

    /**
     * 快速导出：渲染到主 canvas，用 captureStream + MediaRecorder 录制，无 readPixels，约实时（类似 SuperSplat）。
     * 输出 WebM（VP9 或 AVC1），导出期间画面会实时播放在屏幕上。
     */
    const performVideoExportFast = async (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream | undefined): Promise<boolean> => {
        const { frameRate, width, height, bitrate, syncAnimTrack } = videoSettings;
        const evenWidth = width % 2 === 0 ? width : width - 1;
        const evenHeight = height % 2 === 0 ? height : height - 1;
        const totalDuration = videoSettings.totalDuration ?? global.settings?.revealEffect?.totalDuration ?? 20.0;
        const includeVfx = videoSettings.includeVfx !== false && !videoSettings.fixVfxAtEnd;
        // 不包含 VFX 时固定为「VFX 自身总时长」的最后一帧，整段视频显示完整效果状态
        const vfxTotalDuration = global.settings?.revealEffect?.totalDuration ?? 20.0;
        const totalFrames = Math.ceil(totalDuration * frameRate);
        const frameInterval = 1.0 / frameRate;
        const frameTimeMs = 1000 / frameRate;

        const app = global.app;
        const device = app.graphicsDevice;
        const canvas = device.canvas as HTMLCanvasElement;
        if (!canvas || !canvas.captureStream) {
            console.error(VFX_EXPORT_LOG_TAG, 'Fast export requires canvas.captureStream (not supported in this context)');
            return false;
        }

        const prevWidth = canvas.width;
        const prevHeight = canvas.height;
        canvas.width = evenWidth;
        canvas.height = evenHeight;
        if (typeof (device as any).setResolution === 'function') {
            (device as any).setResolution(evenWidth, evenHeight);
        }
        (device as any).fire?.('resizecanvas');

        console.log(VFX_EXPORT_LOG_TAG, 'Fast export: rendering to canvas + captureStream (no readPixels), ~real-time');
        const tStart = performance.now();

        const stream = canvas.captureStream(frameRate);
        const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
            ? 'video/webm;codecs=vp9'
            : MediaRecorder.isTypeSupported('video/webm;codecs=avc1')
                ? 'video/webm;codecs=avc1'
                : 'video/webm';
        console.log(VFX_EXPORT_LOG_TAG, `Fast export: using mimeType=${mimeType}`);
        const chunks: Blob[] = [];
        const recorder = new MediaRecorder(stream, {
            mimeType,
            videoBitsPerSecond: bitrate,
            audioBitsPerSecond: 0
        });
        recorder.ondataavailable = (e) => {
            if (e.data && e.data.size > 0) chunks.push(e.data);
        };

        const blobPromise = new Promise<Blob>((resolve, reject) => {
            recorder.onstop = () => {
                resolve(new Blob(chunks, { type: mimeType }));
            };
            recorder.onerror = () => {
                reject(new Error('MediaRecorder error'));
            };
        });

        recorder.start(100);

        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            const frameStart = performance.now();
            const frameTime = Math.min(frameIndex * frameInterval, totalDuration);
            const effectTime = includeVfx ? frameTime : vfxTotalDuration;
            // 不包含 VFX 时也必须每帧驱动 anim，否则导出的视频里相机不动
            if (syncAnimTrack || !includeVfx) seekAnimToTimeAndApply(global, frameTime);
            await prepareAndRenderOneFrameToCanvas(global, effectTime);
            updateProgress(frameTime, totalDuration);
            const elapsed = performance.now() - frameStart;
            const wait = Math.max(0, frameTimeMs - elapsed);
            if (wait > 0) await new Promise(r => setTimeout(r, wait));
        }

        recorder.stop();
        const blob = await blobPromise;

        canvas.width = prevWidth;
        canvas.height = prevHeight;
        if (typeof (device as any).setResolution === 'function') {
            (device as any).setResolution(prevWidth, prevHeight);
        }
        (device as any).fire?.('resizecanvas');

        const tTotal = ((performance.now() - tStart) / 1000).toFixed(1);
        console.log(VFX_EXPORT_LOG_TAG, `Fast export done in ${tTotal} s for ${totalDuration.toFixed(1)}s video (${(blob.size / 1024).toFixed(0)} KB)`);

        if (fileStream) {
            await fileStream.write(blob);
            const streamLike = fileStream as unknown as { locked?: boolean; close?: () => Promise<void> };
            if (streamLike.locked !== true) await streamLike.close?.();
        }
        return true;
    };

    /**
     * 执行视频导出的核心逻辑（完全离线渲染）
     */
    const performVideoExport = async (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream | undefined): Promise<boolean> => {
        const { startFrame, endFrame, frameRate, width, height, bitrate } = videoSettings;
        const profiler = new ExportProfiler();
        const totalDuration = videoSettings.totalDuration ?? global.settings?.revealEffect?.totalDuration ?? 20.0;
        const totalFrames = Math.ceil(totalDuration * frameRate);

        console.log(VFX_EXPORT_LOG_TAG, 'Starting video export (offline rendering mode)');
        console.log(VFX_EXPORT_LOG_TAG, 'This will render frames offline without displaying on screen');
        
        // 启动离屏渲染模式（创建导出专用相机和 RenderTarget）
        profiler.startPhase('init (offscreen + encoder)');
        renderManager.startOffscreenMode(videoSettings);
        
        try {
            // 配置编码器
            const encoderConfig = new VideoExportConfig(videoSettings);
            console.log(VFX_EXPORT_LOG_TAG, `VideoExportConfig created: codec=${encoderConfig.codec}, codecType=${encoderConfig.codecType}, resolution=${width}x${height}`);
            
            // 设置输出目标
            const target = fileStream ? new StreamTarget(fileStream) : new BufferTarget();
            const output = new Output({
                format: encoderConfig.outputFormat,
                target
            });

            // 配置视频源
            const videoSource = new EncodedVideoPacketSource(encoderConfig.codecType);
            output.addVideoTrack(videoSource, {
                rotation: 0,
                frameRate
            });

            await output.start();

            // 创建编码器
            const encoder = createVideoEncoder(videoSource, encoderConfig.codec, videoSettings);
            
            if (!encoder) {
                throw new Error('Failed to create video encoder');
            }

            // H264 要求偶数尺寸
            const evenWidth = width % 2 === 0 ? width : width - 1;
            const evenHeight = height % 2 === 0 ? height : height - 1;
            
            // 创建帧处理器（使用偶数尺寸）
            const frameProcessor = new FrameProcessor(global, evenWidth, evenHeight);
            profiler.endPhase();

            try {
                // 渲染所有帧（完全离线渲染，不影响主 viewer）
                profiler.startPhase('renderAllFrames');
                await renderAllFrames(frameProcessor, encoder, videoSettings, renderManager, profiler);
                profiler.endPhase();

                // 完成输出
                if (encoder.state !== 'closed' && !(encoder as any)._errorOccurred) {
                    profiler.startPhase('encoder.flush');
                    await encoder.flush();
                    profiler.endPhase();
                }
            } catch (error) {
                console.error(VFX_EXPORT_LOG_TAG, 'Error during frame rendering:', error);
                throw error;
            } finally {
                // 确保编码器被关闭
                if (encoder.state !== 'closed') {
                    encoder.close();
                }
            }
            
            // 完成输出（这会确保所有数据都写入流）
            profiler.startPhase('output.finalize');
            await output.finalize();
            profiler.endPhase();

            profiler.logSummary(totalFrames, totalDuration);

            // 如果使用文件流：仅当流未被锁定时才主动 close，避免 "Cannot close a locked stream"
            // StreamTarget 可能在 finalize 后仍持有 writer，此时流处于 locked 状态，不应再 close
            if (fileStream) {
                const streamLike = fileStream as unknown as { locked?: boolean; close?: () => Promise<void> };
                if (streamLike.locked !== true) {
                    try {
                        await streamLike.close?.();
                        console.log(VFX_EXPORT_LOG_TAG, 'File stream closed successfully');
                    } catch (error) {
                        console.warn(VFX_EXPORT_LOG_TAG, 'Error closing file stream (may already be closed):', error);
                    }
                }
            }

            // 处理下载（如果没有文件流）
            await handleDownload(output, target, fileStream, encoderConfig.fileExtension);

            return true;
        } finally {
            // 确保恢复离屏渲染模式（恢复自动渲染）
            cleanup();
        }
    };

    /**
     * 导出视频的主要方法
     */
    const exportVideo = async (videoSettings: VideoSettings, fileStream?: FileSystemWritableFileStream): Promise<boolean> => {
        events.fire('progressStart', videoSettings.useFastExport ? '快速导出 (WebM)…' : localize('panel.render.render-video'));

        const stateAny = global.state as any;
        const prevExporting = stateAny.isExportingVfxVideo ?? false;
        const prevEffectTime = lastUiEffectTime;
        const prevEffectPaused = stateAny.effectPaused ?? false;
        const prevAnimationPaused = stateAny.animationPaused ?? false;
        const includeVfx = videoSettings.includeVfx !== false;

        // 导出时包含 VFX：在开始前重启特效，从 0 开始录制（Timed 与非 Timed 均适用）
        if (includeVfx) {
            events.fire('revealRestart', false);
        }

        // 锁住 viewer 实时更新
        stateAny.isExportingVfxVideo = true;

        try {
            if (videoSettings.useFastExport) {
                return await performVideoExportFast(videoSettings, fileStream);
            }
            return await performVideoExport(videoSettings, fileStream);
        } catch (error) {
            await handleExportError(error);
            return false;
        } finally {
            cleanup();

            // 恢复锁
            stateAny.isExportingVfxVideo = prevExporting;

            // 延后到下一帧再恢复；用 restoreAfterExport 区分 Timed/非 Timed，避免非 Timed 黑屏；恢复动画播放状态
            requestAnimationFrame(() => {
                seekAnimToTimeAndApply(global, prevEffectTime);
                global.events.fire('effectTimeline:restoreAfterExport', prevEffectTime);
                global.events.fire('effectPlayPause:set', prevEffectPaused);
                stateAny.animationPaused = prevAnimationPaused;
            });
        }
    };

    // 监听视频导出事件
    events.on('render.video', exportVideo);
};