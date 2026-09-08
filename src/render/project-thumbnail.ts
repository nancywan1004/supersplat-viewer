/**
 * 项目默认视角与缩略图：将当前相机写入 `settings.cameras[0].initial`，暂存 JPEG。
 * 仅 `PROJECT_SAVE` destination=universe 时由 `saveExperienceProject` 上传登记；
 * local 不下载、不打进 zip。
 */
import { Vec3 } from 'playcanvas';

import type { ExperienceSettings } from '../schemas/v2';
import type { Global } from '../types';
import { uploadProjectThumbnail, type ProjectThumbnailUploadResult } from '../universe/service';
import { runWithDebugVisualsSuppressed } from '../debug-visual-policy';
import { captureViewportJpegBlob, VIEWPORT_SCREENSHOT_DEFAULT } from './capture-viewport-screenshot';

export type ProjectThumbnailActionResult =
    | { ok: true }
    | { ok: false; message: string };

type CameraPoseTuple = {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
};

let pendingProjectThumbnailJpeg: Blob | null = null;

export function hasPendingProjectThumbnail(): boolean {
    return pendingProjectThumbnailJpeg != null && pendingProjectThumbnailJpeg.size > 0;
}

export function clearPendingProjectThumbnail(): void {
    pendingProjectThumbnailJpeg = null;
}

function getViewerCameraManager(global: Global): { camera: { position: Vec3; fov: number; calcFocusPoint: (out: Vec3) => void } } | null {
    const viewer = (global.app as unknown as { viewer?: { cameraManager?: { camera: { position: Vec3; fov: number; calcFocusPoint: (out: Vec3) => void } } } }).viewer;
    return viewer?.cameraManager ?? null;
}

function ensurePrimaryCameraSlot(settings: ExperienceSettings): void {
    const root = settings as Record<string, unknown>;
    if (!Array.isArray(root.cameras)) {
        root.cameras = [];
    }
    const cameras = root.cameras as Record<string, unknown>[];
    if (!cameras[0] || typeof cameras[0] !== 'object') {
        cameras[0] = { initial: { position: [0, 0, 0], target: [0, 0, 0], fov: 75 } };
    }
    const cam0 = cameras[0] as Record<string, unknown>;
    if (!cam0.initial || typeof cam0.initial !== 'object') {
        cam0.initial = { position: [0, 0, 0], target: [0, 0, 0], fov: 75 };
    }
}

function readPrimaryCameraPoseFromManager(global: Global): CameraPoseTuple | null {
    const mgr = getViewerCameraManager(global);
    if (!mgr) return null;
    const focus = new Vec3();
    mgr.camera.calcFocusPoint(focus);
    const pos = mgr.camera.position;
    return {
        position: [pos.x, pos.y, pos.z],
        target: [focus.x, focus.y, focus.z],
        fov: mgr.camera.fov
    };
}

function writePrimaryCameraInitial(settings: ExperienceSettings, pose: CameraPoseTuple): void {
    ensurePrimaryCameraSlot(settings);
    const cameras = (settings as Record<string, unknown>).cameras as Record<string, unknown>[];
    cameras[0].initial = {
        position: [...pose.position],
        target: [...pose.target],
        fov: pose.fov
    };
}

/**
 * 将当前相机姿态写入 `settings.cameras[0].initial`，同步运行时 reset 姿态，并暂存缩略图 JPEG。
 */
export async function captureDefaultViewAndStageThumbnail(global: Global): Promise<ProjectThumbnailActionResult> {
    const pose = readPrimaryCameraPoseFromManager(global);
    if (!pose) {
        return { ok: false, message: 'camera_unavailable' };
    }

    writePrimaryCameraInitial(global.settings as ExperienceSettings, pose);
    global.events.fire('camera:syncPrimaryInitial');

    try {
        pendingProjectThumbnailJpeg = await runWithDebugVisualsSuppressed(global, () =>
            captureViewportJpegBlob(global.app, VIEWPORT_SCREENSHOT_DEFAULT)
        );
        return { ok: true };
    } catch (error) {
        pendingProjectThumbnailJpeg = null;
        const message = error instanceof Error ? error.message : String(error);
        console.error('[ProjectThumbnail] capture failed:', error);
        return { ok: false, message };
    }
}

export async function uploadPendingProjectThumbnailIfAny(global: Global): Promise<ProjectThumbnailUploadResult | null> {
    const blob = pendingProjectThumbnailJpeg;
    if (!blob || blob.size <= 0) {
        return null;
    }

    const projectId = global.config.projectId;
    const token = global.config.token;
    if (projectId == null || projectId === '' || !token) {
        clearPendingProjectThumbnail();
        return { ok: false, message: '缺少 projectId 或 token，无法上传缩略图' };
    }

    const result = await uploadProjectThumbnail(projectId, token, blob);
    if (result.ok) {
        clearPendingProjectThumbnail();
    }
    return result;
}
