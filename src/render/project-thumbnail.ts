/**
 * 项目缩略图：视口截图后的落盘（internal 下载）或云端登记（message-bridge 上传）。
 * 底层截帧见 {@link ./capture-viewport-screenshot}。
 */
import type { Global } from '../types';
import { getProjectThumbnailFilename, uploadProjectThumbnail, type ProjectThumbnailUploadResult } from '../universe/service';
import { captureViewportJpegBlob, VIEWPORT_SCREENSHOT_DEFAULT } from './capture-viewport-screenshot';

export type ProjectThumbnailActionResult =
    | { ok: true; thumbnailUrl?: string }
    | { ok: false; message: string };

/** 触发浏览器下载（与 internal 模式保存 settings.json 相同方式） */
export function downloadBlobAsFile(blob: Blob, filename: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

/**
 * 截取当前视口（默认 1024×576 JPEG）并下载到本地。
 * 用于 internal 编辑 UI（与 settings 保存一致，不走云端）。
 */
export async function captureAndDownloadProjectThumbnail(global: Global): Promise<ProjectThumbnailActionResult> {
    try {
        const jpegBlob = await captureViewportJpegBlob(global.app, VIEWPORT_SCREENSHOT_DEFAULT);
        const projectId = global.config.projectId;
        const filename = projectId != null && projectId !== ''
            ? getProjectThumbnailFilename(projectId)
            : 'project-thumbnail.jpg';
        downloadBlobAsFile(jpegBlob, filename);
        return { ok: true };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ProjectThumbnail] capture/download failed:', error);
        return { ok: false, message };
    }
}

/**
 * 截取当前视口（默认 1024×576 JPEG），上传 OSS 并登记为项目缩略图。
 * 用于 message-bridge / 父级协议（须 projectId + token）。
 */
export async function captureAndUploadProjectThumbnail(global: Global): Promise<ProjectThumbnailUploadResult> {
    const projectId = global.config.projectId;
    const token = global.config.token;
    if (projectId == null || projectId === '') {
        return { ok: false, message: '缺少 projectId' };
    }
    if (!token) {
        return { ok: false, message: '缺少 token' };
    }

    try {
        const jpegBlob = await captureViewportJpegBlob(global.app, VIEWPORT_SCREENSHOT_DEFAULT);
        return await uploadProjectThumbnail(projectId, token, jpegBlob);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ProjectThumbnail] capture/upload failed:', error);
        return { ok: false, message };
    }
}
