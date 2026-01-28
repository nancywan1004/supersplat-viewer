import { BufferTarget, EncodedPacket, EncodedVideoPacketSource, MkvOutputFormat, MovOutputFormat, Mp4OutputFormat, Output, StreamTarget, WebMOutputFormat } from 'mediabunny';
import { Global } from './types';
import { EventHandler, Vec3, RenderTarget, Texture, PIXELFORMAT_RGBA8, Color, RenderPass } from 'playcanvas';

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
                    console.log(`Selected codec: ${this.codec} for resolution ${width}x${height} (codedArea: ${codedArea})`);
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
 * 渲染管理器
 * 负责离屏渲染模式的设置和恢复
 * 简化版本，专注于架构而非具体API实现
 */
class RenderManager {
    private originalSettings: Map<string, any> = new Map();

    constructor(private global: Global) {}

    /**
     * 启动离屏渲染模式
     * 禁用自动渲染，确保完全离线渲染，不在屏幕上显示
     */
    startOffscreenMode(settings: VideoSettings): void {
        const { app } = this.global;
        const { width, height, showDebug, transparentBg } = settings;

        console.log('Starting offscreen mode (completely offline rendering):', { width, height, showDebug, transparentBg });
        
        // 保存原始设置用于恢复
        this.originalSettings.set('autoRender', app.autoRender);
        
        // 禁用自动渲染，确保完全离线渲染
        // 这样渲染过程不会显示在屏幕上，只渲染到 RenderTarget
        app.autoRender = false;
        
        console.log('Offscreen mode enabled: autoRender = false');
    }

    /**
     * 结束离屏渲染模式，恢复原始设置
     */
    endOffscreenMode(): void {
        const { app } = this.global;

        console.log('Ending offscreen mode');
        
        // 恢复原始设置
        app.autoRender = this.originalSettings.get('autoRender') ?? true;
        app.renderNextFrame = true;
        
        this.originalSettings.clear();
    }
}

/**
 * 帧处理器
 * 负责帧的准备、渲染和捕获
 * 使用 RenderTarget 从 PlayCanvas 渲染管道捕获帧
 */
class FrameProcessor {
    private lastCameraPosition = new Vec3(0, 0, 0);
    private lastCameraForward = new Vec3(1, 0, 0);
    private frameBuffer: Uint8Array;
    private lineBuffer: Uint8Array;
    private workTarget: RenderTarget | null = null;
    private workColorBuffer: Texture | null = null;

    constructor(private global: Global, width: number, height: number) {
        this.frameBuffer = new Uint8Array(width * height * 4);
        this.lineBuffer = new Uint8Array(width * 4);
        this.initWorkTarget(width, height);
    }

    /**
     * 初始化工作渲染目标
     */
    private initWorkTarget(width: number, height: number): void {
        const { app } = this.global;
        const device = app.graphicsDevice;

        // 创建用于捕获的工作渲染目标
        this.workColorBuffer = new Texture(device, {
            format: PIXELFORMAT_RGBA8,
            width: width,
            height: height,
            mipmaps: false
        });

        this.workTarget = new RenderTarget({
            colorBuffer: this.workColorBuffer,
            depth: false
        });
    }

    /**
     * 调整工作渲染目标尺寸
     */
    private resizeWorkTarget(width: number, height: number): void {
        if (this.workTarget && this.workColorBuffer) {
            this.workTarget.resize(width, height);
        } else {
            this.initWorkTarget(width, height);
        }
    }

    /**
     * 清理资源
     */
    destroy(): void {
        if (this.workTarget) {
            this.workTarget.destroy();
            this.workTarget = null;
        }
        if (this.workColorBuffer) {
            this.workColorBuffer.destroy();
            this.workColorBuffer = null;
        }
    }

    /**
     * 准备渲染帧
     * @param effectTime VFX 时间轴的时间（秒）
     */
    async prepareFrame(effectTime: number): Promise<void> {
        const { events } = this.global;

        console.log(`Preparing frame at VFX time: ${effectTime.toFixed(2)}s`);
        
        // 设置 VFX 时间轴时间（使用 effectTimeline:set 事件）
        events.fire('effectTimeline:set', effectTime);
        // 同时触发 effectTime:changed 事件，确保 UI 和特效同步
        events.fire('effectTime:changed', effectTime);
        
        // 等待排序完成
        await this.waitForSorting();
    }

    /**
     * 等待所有可见的splat排序完成和 VFX 特效更新
     */
    private async waitForSorting(): Promise<void> {
        const { app } = this.global;
        // 等待渲染完成，确保 VFX 特效有时间更新
        return new Promise<void>((resolve) => {
            // 等待一帧渲染完成
            app.once('frameend', () => {
                // 再等待一小段时间，确保 VFX 特效完全更新
                setTimeout(resolve, 50);
            });
            app.renderNextFrame = true;
        });
    }

    /**
     * 等待渲染完成
     */
    private async waitForRenderComplete(): Promise<void> {
        const { app } = this.global;
        return new Promise<void>((resolve) => {
            // 监听 frameend 事件，确保渲染完成
            app.once('frameend', () => {
                // 再等待一小段时间，确保所有后处理完成
                setTimeout(resolve, 50);
            });
            // 触发渲染
            app.renderNextFrame = true;
        });
    }

    /**
     * 从 RenderTarget 捕获帧（完全离线渲染）
     * 直接渲染场景到我们的 RenderTarget，不显示在屏幕上
     */
    private async captureFromRenderTarget(width: number, height: number): Promise<boolean> {
        const { app, camera } = this.global;
        const device = app.graphicsDevice;
        
        // 调整工作渲染目标尺寸
        this.resizeWorkTarget(width, height);
        
        if (!this.workTarget || !this.workColorBuffer) {
            console.error('Work target not initialized');
            return false;
        }
        
        try {
            // 完全离线渲染：直接渲染到 RenderTarget，不显示在屏幕上
            // 保存原始 renderTarget
            const originalRenderTarget = device.getRenderTarget();
            const originalCameraRenderTarget = (camera.camera as any).renderTarget;
            
            try {
                // 设置设备渲染目标为我们的 workTarget（离屏渲染）
                device.setRenderTarget(this.workTarget);
                
                // 设置相机渲染目标（如果支持）
                if (originalCameraRenderTarget !== undefined) {
                    (camera.camera as any).renderTarget = this.workTarget;
                }
                
                // 由于 autoRender = false，需要手动触发渲染
                // 这会渲染到我们的 RenderTarget，不会显示在屏幕上
                app.renderNextFrame = true;
                
                // 等待渲染完成（完全离线，不显示在屏幕上）
                await new Promise<void>((resolve) => {
                    app.once('frameend', () => {
                        resolve();
                    });
                });
                
                // 从渲染目标读取像素数据（完全离线，不影响屏幕显示）
                const data = await this.workColorBuffer.read(0, 0, width, height, { renderTarget: this.workTarget });
                
                // 恢复原始渲染目标
                device.setRenderTarget(originalRenderTarget);
                if (originalCameraRenderTarget !== undefined) {
                    (camera.camera as any).renderTarget = originalCameraRenderTarget;
                }
                
                // 检查数据格式并转换
                if (data instanceof Uint8Array) {
                    // 已经是 RGBA8 格式，直接使用
                    this.flipBufferVerticallyFromSource(data, width, height);
                    console.log('Successfully captured from RenderTarget (direct render)');
                    return true;
                } else if (data instanceof Float32Array) {
                    // 如果是 Float32Array（例如 RGBA16F 或 RGBA32F），需要转换
                    console.log('Converting Float32Array to Uint8Array');
                    const uint8Data = new Uint8Array(data.length);
                    for (let i = 0; i < data.length; i++) {
                        // 假设数据范围是 0-1，转换为 0-255
                        uint8Data[i] = Math.max(0, Math.min(255, Math.floor(data[i] * 255)));
                    }
                    this.flipBufferVerticallyFromSource(uint8Data, width, height);
                    console.log('Successfully captured from RenderTarget (Float32Array converted)');
                    return true;
                } else {
                    console.warn(`Unsupported color buffer format: ${data.constructor.name}`);
                    return false;
                }
            } catch (renderError) {
                // 确保恢复原始渲染目标
                device.setRenderTarget(originalRenderTarget);
                if (originalCameraRenderTarget !== undefined) {
                    (camera.camera as any).renderTarget = originalCameraRenderTarget;
                }
                throw renderError;
            }
        } catch (error) {
            console.warn('Failed to capture from RenderTarget (direct render):', error);
            
            // 方法2: 尝试从现有的渲染目标读取（如果存在）
            try {
                const viewer = (app as any).viewer;
                let mainTarget: RenderTarget | null = null;
                
                if (viewer?.cameraFrame) {
                    const cameraFrame = viewer.cameraFrame as any;
                    mainTarget = cameraFrame.mainTarget || 
                                cameraFrame.rendering?.mainTarget || 
                                cameraFrame.renderTarget ||
                                null;
                }
                
                if (!mainTarget) {
                    const cameraComponent = camera.camera as any;
                    mainTarget = cameraComponent.renderTarget || 
                                cameraComponent.mainTarget ||
                                null;
                }
                
                if (mainTarget && mainTarget.colorBuffer) {
                    console.log('Found existing mainTarget, reading from it');
                    const data = await mainTarget.colorBuffer.read(0, 0, width, height, { renderTarget: mainTarget });
                    
                    if (data instanceof Uint8Array) {
                        this.flipBufferVerticallyFromSource(data, width, height);
                        return true;
                    } else if (data instanceof Float32Array) {
                        const uint8Data = new Uint8Array(data.length);
                        for (let i = 0; i < data.length; i++) {
                            uint8Data[i] = Math.max(0, Math.min(255, Math.floor(data[i] * 255)));
                        }
                        this.flipBufferVerticallyFromSource(uint8Data, width, height);
                        return true;
                    }
                }
            } catch (readError) {
                console.warn('Failed to read from existing RenderTarget:', readError);
            }
            
            return false;
        }
    }

    /**
     * 捕获当前视频帧
     */
    async captureFrame(frameTime: number, frameRate: number, encoder: VideoEncoder | null, width: number, height: number): Promise<boolean> {
        // 检查编码器是否有效
        if (!encoder || (encoder as any)._errorOccurred) {
            console.warn('Encoder is closed or has error, skipping frame');
            return false;
        }
        
        // 检查编码器状态
        if (encoder.state === 'closed') {
            console.warn('Encoder is closed, skipping frame');
            return false;
        }
        
        console.log(`Capturing frame at time: ${frameTime}`);
        
        // H264 要求偶数尺寸，确保使用偶数尺寸
        const evenWidth = width % 2 === 0 ? width : width - 1;
        const evenHeight = height % 2 === 0 ? height : height - 1;
        
        // 等待渲染完成（多次等待确保渲染完成）
        for (let i = 0; i < 2; i++) {
            await this.waitForRenderComplete();
        }
        
        // 尝试从 RenderTarget 捕获（优先方法）
        let captured = await this.captureFromRenderTarget(evenWidth, evenHeight);
        
        // 如果 RenderTarget 方法失败，回退到 canvas 方法
        if (!captured) {
            const { app } = this.global;
            const device = app.graphicsDevice;
            const canvas = device.canvas as HTMLCanvasElement;
            
            if (!canvas) {
                console.error('Canvas not found');
                return false;
            }
            
            // 从 PlayCanvas canvas 读取像素数据（备用方法）
            try {
                // 获取实际的 canvas 尺寸
                const sourceWidth = canvas.width || canvas.clientWidth || device.width;
                const sourceHeight = canvas.height || canvas.clientHeight || device.height;
                
                if (sourceWidth === 0 || sourceHeight === 0) {
                    console.error(`Invalid canvas size: ${sourceWidth}x${sourceHeight}`);
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
                    console.warn('Direct drawImage failed, trying toDataURL method:', drawError);
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
                console.log(`Frame capture (canvas fallback): ${hasContent ? 'Content detected' : 'WARNING: Black screen detected'} (max RGB: ${maxR}, ${maxG}, ${maxB})`);
                
                // 复制到 frameBuffer（需要垂直翻转，因为 canvas 坐标系与视频帧不同）
                this.flipBufferVerticallyFromSource(imageData.data, evenWidth, evenHeight);
                captured = true;
            } catch (error) {
                console.error('Canvas capture also failed:', error);
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
            return true;
        } catch (error) {
            console.warn('Failed to create or encode video frame:', error);
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
            console.warn(`Video dimensions adjusted from ${settings.width}x${settings.height} to ${evenWidth}x${evenHeight} for H264 compatibility`);
        }
        
        const encoder = new VideoEncoder({
            output: async (chunk, meta) => {
                const encodedPacket = EncodedPacket.fromEncodedChunk(chunk);
                await videoSource.add(encodedPacket, meta);
            },
            error: (error) => {
                console.error('Video encoding error:', error);
                // 编码器错误时，标记为已关闭，防止继续编码
                (encoder as any)._errorOccurred = true;
            }
        });
        
        try {
            // 配置编码器，添加 QuickTime Player 兼容性所需的参数
            // 注意：framerate 是必需的，确保时间戳正确
            console.log(`Configuring encoder with codec: ${codec}, resolution: ${evenWidth}x${evenHeight}`);
            encoder.configure({
                codec,
                width: evenWidth,
                height: evenHeight,
                bitrate: settings.bitrate,
                framerate: settings.frameRate
                // 注意：keyFrameInterval 和 hardwareAcceleration 在某些浏览器中可能不支持
                // 如果浏览器支持，会自动使用合适的默认值
            });
            
            console.log(`Encoder configured successfully with codec: ${codec}`);
            return encoder;
        } catch (error) {
            console.error('Failed to configure video encoder:', error);
            encoder.close();
            return null;
        }
    };

    /**
     * 等待渲染完成
     */
    const waitForRender = async (): Promise<void> => {
        return new Promise<void>((resolve) => {
            // 等待 frameend 事件，确保渲染完成
            global.app.once('frameend', () => {
                // 再等待一小段时间，确保所有后处理完成
                setTimeout(resolve, 50);
            });
            global.app.renderNextFrame = true;
        });
    };

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
     * 渲染所有帧（基于 VFX 时间轴）
     */
    const renderAllFrames = async (frameProcessor: FrameProcessor, encoder: VideoEncoder | null, settings: VideoSettings): Promise<void> => {
        if (!encoder) {
            throw new Error('Encoder is not available');
        }
        
        const { frameRate, width, height } = settings;
        const { app, settings: appSettings } = global;

        // H264 要求偶数尺寸
        const evenWidth = width % 2 === 0 ? width : width - 1;
        const evenHeight = height % 2 === 0 ? height : height - 1;

        // 获取 VFX 时间轴的总时长（从 revealEffect 配置中获取）
        const totalDuration = appSettings?.revealEffect?.totalDuration ?? 20.0;
        
        // 计算需要导出的帧数（基于 VFX 时间轴的总时长）
        const totalFrames = Math.ceil(totalDuration * frameRate);
        const frameInterval = 1.0 / frameRate; // 每帧之间的时间间隔（秒）

        console.log(`Rendering ${totalFrames} frames for VFX timeline (duration: ${totalDuration}s, frameRate: ${frameRate}fps) at ${evenWidth}x${evenHeight}`);

        // 从 0 开始，到 totalDuration 结束，按帧率间隔遍历每一帧
        for (let frameIndex = 0; frameIndex < totalFrames; frameIndex++) {
            // 检查编码器状态
            if (encoder.state === 'closed' || (encoder as any)._errorOccurred) {
                console.error('Encoder closed or error occurred, stopping frame rendering');
                break;
            }
            
            // 计算当前帧对应的 VFX 时间轴时间（秒）
            const effectTime = Math.min(frameIndex * frameInterval, totalDuration);
            
            // 准备帧（设置 VFX 时间轴到对应时间，不播放动画）
            // 这是离线渲染：直接设置时间点，不播放动画
            await frameProcessor.prepareFrame(effectTime);

            // 等待 VFX 特效更新（离线渲染，不显示在屏幕上）
            // 由于 autoRender = false，渲染会直接到 RenderTarget，不会显示
            app.renderNextFrame = true;
            await waitForRender();
            
            // 再等待一次，确保 VFX 特效完全更新
            app.renderNextFrame = true;
            await waitForRender();

            // 捕获帧（完全离线渲染，使用 effectTime 作为时间戳）
            const success = await frameProcessor.captureFrame(effectTime, frameRate, encoder, evenWidth, evenHeight);
            
            if (!success) {
                console.warn(`Failed to capture frame at VFX time ${effectTime.toFixed(2)}s, continuing...`);
            }

            // 更新进度（基于 VFX 时间轴）
            updateProgress(effectTime, totalDuration);
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
            console.log(`Video export complete: ${filename}`);
        }
    };

    /**
     * 处理导出错误
     */
    const handleExportError = async (error: any): Promise<void> => {
        // 简化错误处理，直接输出到控制台
        console.error('Video export error:', error);
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
     * 执行视频导出的核心逻辑（完全离线渲染）
     */
    const performVideoExport = async (videoSettings: VideoSettings, fileStream: FileSystemWritableFileStream | undefined): Promise<boolean> => {
        const { startFrame, endFrame, frameRate, width, height, bitrate } = videoSettings;
        
        console.log('Starting video export (offline rendering mode)');
        console.log('This will render frames offline without displaying on screen');
        
        // 启动离屏渲染模式（禁用自动渲染，完全离线）
        renderManager.startOffscreenMode(videoSettings);
        
        try {
            // 配置编码器
            const encoderConfig = new VideoExportConfig(videoSettings);
            console.log(`VideoExportConfig created: codec=${encoderConfig.codec}, codecType=${encoderConfig.codecType}, resolution=${width}x${height}`);
            
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

            try {
                // 渲染所有帧（完全离线渲染，不显示在屏幕上）
                await renderAllFrames(frameProcessor, encoder, videoSettings);

                // 完成输出
                if (encoder.state !== 'closed' && !(encoder as any)._errorOccurred) {
                    await encoder.flush();
                }
            } catch (error) {
                console.error('Error during frame rendering:', error);
                throw error;
            } finally {
                // 确保编码器被关闭
                if (encoder.state !== 'closed') {
                    encoder.close();
                }
            }
            
            // 完成输出（这会确保所有数据都写入流）
            await output.finalize();

            // 如果使用文件流，需要显式关闭以确保数据写入
            // 注意：必须在 finalize() 之后关闭，因为 StreamTarget 可能在 finalize 时还在使用流
            if (fileStream) {
                try {
                    // 等待一小段时间，确保 StreamTarget 完成所有写入操作
                    await new Promise(resolve => setTimeout(resolve, 100));
                    await fileStream.close();
                    console.log('File stream closed successfully');
                } catch (error) {
                    console.warn('Error closing file stream (may already be closed):', error);
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
        events.fire('progressStart', localize('panel.render.render-video'));

        try {
            return await performVideoExport(videoSettings, fileStream);
        } catch (error) {
            await handleExportError(error);
            return false;
        } finally {
            cleanup();
        }
    };

    // 监听视频导出事件
    events.on('render.video', exportVideo);
};