import type { Global } from '../../types';
import { DEFAULT_VFX_TOTAL_DURATION } from '../../schemas/v2-custom';

const RESOLUTION_PRESETS: Record<string, { width: number; height: number }> = {
    '720p': { width: 1280, height: 720 },
    '1080p': { width: 1920, height: 1080 },
    '1440p': { width: 2560, height: 1440 },
    '2160p': { width: 3840, height: 2160 }
};

/** 导出进度覆盖层 HTML 模板（挂到 body） */
const VFX_EXPORT_OVERLAY_HTML = `
<div id="vfxExportOverlay" class="hidden" style="position: fixed; inset: 0; display: flex; align-items: center; justify-content: center; background: rgba(0,0,0,0.5); z-index: 1000;">
  <div style="min-width: 320px; max-width: 480px; padding: 24px 32px; border-radius: 12px; background: rgba(20,20,20,0.95); box-shadow: 0 12px 32px rgba(0,0,0,0.4);">
    <div style="font-size: 16px; font-weight: 600; color: #fff; margin-bottom: 12px; text-align: center;">正在离线导出 VFX 视频…</div>
    <div style="width: 100%; height: 6px; border-radius: 999px; background: rgba(255,255,255,0.12); overflow: hidden;">
      <div id="vfxExportProgressBar" style="height: 100%; width: 0%; border-radius: 999px; background: linear-gradient(90deg, #4facfe, #00f2fe); transition: width 0.15s ease-out;"></div>
    </div>
    <div id="vfxExportProgressText" style="margin-top: 10px; font-size: 12px; color: rgba(255,255,255,0.75); text-align: center;">准备中…</div>
  </div>
</div>
`.trim();

/** 导出配置：导出时长（秒），与 VFX 面板的「Timed VFX 时长」无关，仅决定视频长度 */
const DEFAULT_EXPORT_DURATION = 20;

/** VFX 导出行 HTML 模板（挂到 #renderPanelContainer） */
const VFX_VIDEO_EXPORT_ROW_HTML = `
<div id="vfxVideoExportRow" class="settingsRow">
  <div class="vfxExportInner">
    <div class="vfxExportRow">
      <label for="exportDurationInput">导出时长 (s):</label>
      <input type="number" id="exportDurationInput" class="settingsInput" min="0.5" max="600" step="0.5" value="${DEFAULT_EXPORT_DURATION}" title="基于动画时间轴(animTrack)的导出长度，与 VFX 特效时长无关">
    </div>
    <div class="vfxExportRow">
      <label for="videoResolution">分辨率:</label>
      <select id="videoResolution" class="settingsSelect">
        <option value="720p">720p (1280×720)</option>
        <option value="1080p" selected>1080p (1920×1080)</option>
        <option value="1440p">1440p (2560×1440)</option>
        <option value="2160p">4K (3840×2160)</option>
        <option value="custom">自定义</option>
      </select>
    </div>
    <div id="customResolutionRow" class="hidden vfxExportRow">
      <label for="customWidth">宽度:</label>
      <input type="number" id="customWidth" class="settingsInput" min="320" max="7680" step="2" value="1920">
      <label for="customHeight">高度:</label>
      <input type="number" id="customHeight" class="settingsInput" min="240" max="4320" step="2" value="1080">
    </div>
    <div class="vfxExportRow">
      <label class="settingsCheckLabel">
        <input type="checkbox" id="includeVfxCheck" class="settingsCheck" checked> 导出时包含 VFX 特效（不勾选则仅导出 animTrack，VFX 固定为末尾状态）
      </label>
    </div>
    <button id="vfxVideoExportButton" class="settingsButton" type="button">导出视频 (MP4)</button>
    <button id="vfxVideoExportFastButton" class="settingsButton" type="button">快速导出 (WebM，约实时)</button>
    <button id="testCaptureFrameButton" class="settingsButton" type="button">测试捕获单帧</button>
  </div>
</div>
`.trim();

/**
 * 初始化 VFX 视频导出相关 UI。
 * 组件自行创建 DOM：进度覆盖层挂到 body，导出行挂到 #renderPanelContainer（由 index.html 中 Render 一级菜单提供）。
 * @returns 清理函数，调用后解除事件并移除创建的 DOM。
 */
export function initVideoExportUI(global: Global): () => void {
    const { events } = global;

    const overlayWrap = document.createElement('div');
    overlayWrap.innerHTML = VFX_EXPORT_OVERLAY_HTML;
    const overlayRoot = overlayWrap.firstElementChild as HTMLElement;
    document.body.appendChild(overlayRoot);

    const vfxExportOverlay = overlayRoot;
    const vfxExportProgressBar = overlayRoot.querySelector('#vfxExportProgressBar') as HTMLElement | null;
    const vfxExportProgressText = overlayRoot.querySelector('#vfxExportProgressText') as HTMLElement | null;

    const container = document.getElementById('renderPanelContainer');
    if (!container) {
        overlayRoot.remove();
        return () => {};
    }

    container.innerHTML = VFX_VIDEO_EXPORT_ROW_HTML;
    const vfxVideoExportRow = container.querySelector('#vfxVideoExportRow') as HTMLElement;
    const vfxVideoExportButton = container.querySelector('#vfxVideoExportButton') as HTMLButtonElement | null;
    const vfxVideoExportFastButton = container.querySelector('#vfxVideoExportFastButton') as HTMLButtonElement | null;
    const testCaptureFrameButton = container.querySelector('#testCaptureFrameButton') as HTMLButtonElement | null;
    const videoResolution = container.querySelector('#videoResolution') as HTMLSelectElement | null;
    const customResolutionRow = container.querySelector('#customResolutionRow');
    const customWidth = container.querySelector('#customWidth') as HTMLInputElement | null;
    const customHeight = container.querySelector('#customHeight') as HTMLInputElement | null;

    const onProgressStart = (message: string) => {
        vfxExportOverlay.classList.remove('hidden');
        if (vfxExportProgressBar) vfxExportProgressBar.style.width = '0%';
        if (vfxExportProgressText) {
            vfxExportProgressText.textContent =
                typeof message === 'string' && message.length > 0 ? message : '正在离线导出 VFX 视频…';
        }
    };

    const onProgressUpdate = (payload: { text: string; progress: number }) => {
        if (vfxExportProgressBar) {
            const clamped = Math.max(0, Math.min(100, payload.progress));
            vfxExportProgressBar.style.width = `${clamped}%`;
        }
        if (vfxExportProgressText) {
            const text = payload.text ?? '';
            vfxExportProgressText.textContent = text.length > 0 ? text : `已完成 ${Math.round(payload.progress)}%`;
        }
    };

    const onProgressEnd = () => {
        vfxExportOverlay.classList.add('hidden');
    };

    const updateCustomResolutionVisibility = () => {
        if (videoResolution && customResolutionRow) {
            const isCustom = videoResolution.value === 'custom';
            customResolutionRow.classList[isCustom ? 'remove' : 'add']('hidden');
        }
    };

    const getVideoResolution = (): { width: number; height: number } => {
        const selected = videoResolution?.value || '1080p';
        if (selected === 'custom') {
            const width = parseInt(customWidth?.value || '1920', 10);
            const height = parseInt(customHeight?.value || '1080', 10);
            return { width, height };
        }
        return RESOLUTION_PRESETS[selected] || RESOLUTION_PRESETS['1080p'];
    };

    const startExport = async (useFastExport: boolean) => {
        try {
            const resolution = getVideoResolution();
            const width = resolution.width % 2 === 0 ? resolution.width : resolution.width - 1;
            const height = resolution.height % 2 === 0 ? resolution.height : resolution.height - 1;
            if (width !== resolution.width || height !== resolution.height) {
                console.log(`Video dimensions adjusted from ${resolution.width}x${resolution.height} to ${width}x${height} for H264 compatibility`);
            }
            const frameRate = 30;
            const restartCheckEl = document.getElementById('restartAnimTrackCheck');
            const syncAnimTrack = restartCheckEl?.classList.contains('active') ?? false;
            const exportDurationEl = document.getElementById('exportDurationInput') as HTMLInputElement | null;
            const totalDuration = Math.max(0.5, Math.min(600, parseFloat(exportDurationEl?.value || '') || DEFAULT_EXPORT_DURATION));
            const includeVfxEl = document.getElementById('includeVfxCheck') as HTMLInputElement | null;
            const includeVfx = includeVfxEl?.checked !== false;
            const videoSettings = {
                startFrame: 0,
                endFrame: 0,
                frameRate,
                width,
                height,
                bitrate: 8_000_000,
                transparentBg: false,
                showDebug: false,
                format: (useFastExport ? 'webm' : 'mp4') as 'mp4' | 'webm',
                codec: 'h264' as const,
                syncAnimTrack,
                useFastExport,
                totalDuration,
                includeVfx
            };
            let fileStream: FileSystemWritableFileStream | undefined;
            if ('showSaveFilePicker' in window) {
                const opts = useFastExport
                    ? { types: [{ description: 'WebM Video', accept: { 'video/webm': ['.webm'] } }], suggestedName: 'vfx-timeline.webm' }
                    : { types: [{ description: 'Video File', accept: { 'video/mp4': ['.mp4'] } }], suggestedName: 'vfx-timeline.mp4' };
                const handle = await (window as any).showSaveFilePicker(opts);
                fileStream = await handle.createWritable();
            }
            events.fire('render.video', videoSettings, fileStream as any);
        } catch (err) {
            console.error('Failed to start VFX video export:', err);
        }
    };

    const onExportClick = () => startExport(false);
    const onExportFastClick = () => startExport(true);

    const onTestCaptureClick = async () => {
        try {
            const resolution = getVideoResolution();
            const width = resolution.width % 2 === 0 ? resolution.width : resolution.width - 1;
            const height = resolution.height % 2 === 0 ? resolution.height : resolution.height - 1;
            console.log(`Testing frame capture using ExportRenderContext at ${width}x${height}`);
            const { RenderManager, prepareAndRenderOneFrame } = await import('../../render/video-export');
            const tempSettings = {
                startFrame: 0, endFrame: 0, frameRate: 30, width, height,
                bitrate: 8_000_000, transparentBg: false, showDebug: false,
                format: 'mp4' as const, codec: 'h264' as const
            };
            const renderManager = new RenderManager(global);
            renderManager.startOffscreenMode(tempSettings);
            const totalDuration = global.settings?.revealEffect?.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
            let currentEffectTime = (global.state as any).effectTime || 0;
            if (currentEffectTime === 0) currentEffectTime = totalDuration * 0.5;
            try {
                const exportTarget = await prepareAndRenderOneFrame(global, renderManager, currentEffectTime, { waitMs: 100 });
                if (!exportTarget) throw new Error('Failed to get export RenderTarget');
                await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
                let capturedData: Uint8Array | null = null;
                const captureMethod = 'ExportRenderContext (Offscreen RenderTarget)';
                try {
                    if (!exportTarget.colorBuffer) throw new Error('Export RenderTarget has no colorBuffer');
                    const data = await exportTarget.colorBuffer.read(0, 0, width, height, { renderTarget: exportTarget });
                    if (data instanceof Uint8Array) capturedData = data;
                    else if (data instanceof Float32Array) {
                        capturedData = new Uint8Array(data.length);
                        for (let i = 0; i < data.length; i++) {
                            capturedData[i] = Math.max(0, Math.min(255, Math.floor(data[i] * 255)));
                        }
                    } else throw new Error(`Unsupported color buffer format: ${data.constructor.name}`);
                } catch (readError) {
                    console.error('Failed to read pixels from RenderTarget:', readError);
                    throw readError;
                }
                const flippedData = new Uint8Array(capturedData.length);
                for (let y = 0; y < height; y++) {
                    const srcY = height - 1 - y;
                    const srcOffset = srcY * width * 4;
                    const dstOffset = y * width * 4;
                    flippedData.set(capturedData.subarray(srcOffset, srcOffset + width * 4), dstOffset);
                }
                let hasContent = false;
                let maxR = 0, maxG = 0, maxB = 0;
                let sampleCount = 0;
                for (let i = 0; i < flippedData.length; i += 4) {
                    const r = flippedData[i], g = flippedData[i + 1], b = flippedData[i + 2];
                    maxR = Math.max(maxR, r); maxG = Math.max(maxG, g); maxB = Math.max(maxB, b);
                    if (r > 10 || g > 10 || b > 10) hasContent = true;
                    sampleCount++;
                    if (sampleCount > 10000) break;
                }
                console.log(`Frame capture test: ${hasContent ? 'SUCCESS - Content detected' : 'FAILED - Black screen detected'}`);
                const offscreenCanvas = document.createElement('canvas');
                offscreenCanvas.width = width;
                offscreenCanvas.height = height;
                const ctx = offscreenCanvas.getContext('2d');
                if (ctx) {
                    const imageData = ctx.createImageData(width, height);
                    imageData.data.set(flippedData);
                    ctx.putImageData(imageData, 0, 0);
                }
                const dataUrl = offscreenCanvas.toDataURL('image/png');
                const newWindow = window.open();
                if (newWindow) {
                    newWindow.document.write(`
                        <html><head><title>Captured Frame Test</title></head>
                        <body style="margin:0;padding:20px;background:#333;color:white;">
                            <h2>捕获的帧测试 (${width}×${height})</h2>
                            <p>状态: <strong style="color:${hasContent ? 'green' : 'red'}">${hasContent ? '成功' : '失败 - 黑屏'}</strong></p>
                            <p>最大 RGB: R=${maxR}, G=${maxG}, B=${maxB}</p>
                            <img src="${dataUrl}" style="max-width:100%;border:2px solid ${hasContent ? 'green' : 'red'};" />
                        </body></html>
                    `);
                } else {
                    alert(`捕获测试完成！\n状态: ${hasContent ? '成功' : '失败'}\n尺寸: ${width}×${height}`);
                }
            } finally {
                renderManager.endOffscreenMode();
            }
        } catch (err) {
            console.error('Failed to test frame capture:', err);
            alert(`捕获测试失败: ${err}`);
        }
    };

    events.on('progressStart', onProgressStart);
    events.on('progressUpdate', onProgressUpdate);
    events.on('progressEnd', onProgressEnd);

    videoResolution?.addEventListener('change', updateCustomResolutionVisibility);
    vfxVideoExportButton?.addEventListener('click', onExportClick);
    vfxVideoExportFastButton?.addEventListener('click', onExportFastClick);
    testCaptureFrameButton?.addEventListener('click', onTestCaptureClick);

    updateCustomResolutionVisibility();

    return function cleanupVideoExportUI() {
        events.off('progressStart', onProgressStart);
        events.off('progressUpdate', onProgressUpdate);
        events.off('progressEnd', onProgressEnd);
        videoResolution?.removeEventListener('change', updateCustomResolutionVisibility);
        vfxVideoExportButton?.removeEventListener('click', onExportClick);
        vfxVideoExportFastButton?.removeEventListener('click', onExportFastClick);
        testCaptureFrameButton?.removeEventListener('click', onTestCaptureClick);

        container.replaceChildren();
        overlayRoot.remove();
    };
}
