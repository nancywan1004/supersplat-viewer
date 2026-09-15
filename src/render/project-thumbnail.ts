/**
 * 项目默认视角与缩略图：将当前相机写入 `settings.cameras[0].initial`，暂存 JPEG；
 * 在 `SETTINGS_SAVE`（云端）或 internal 本地下载时一并落盘/上传。
 */
import { Vec3 } from 'playcanvas';

import type { ExperienceSettings } from '../schemas/v2';
import type { Global } from '../types';
import { serializeExperienceSettings } from '../settings-serialize/settings-serialize';
import {
    getProjectThumbnailFilename,
    uploadProjectData,
    uploadProjectThumbnail,
    type ProjectThumbnailUploadResult
} from '../universe/service';
import { runWithDebugVisualsSuppressed } from '../debug-visual-policy';
import { captureViewportJpegBlob, VIEWPORT_SCREENSHOT_DEFAULT } from './capture-viewport-screenshot';

export type ProjectThumbnailActionResult =
    | { ok: true }
    | { ok: false; message: string };

export type SettingsSavePipelineResult =
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

/** 触发浏览器下载（与 internal 模式保存 settings.json 相同方式） */
export function downloadBlobAsFile(blob: Blob, filename: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

function getViewerCameraManager(global: Global): { camera: { position: Vec3; fov: number; calcFocusPoint: (out: Vec3) => void } } | null {
    const viewer = (global.app as unknown as { viewer?: { cameraManager?: { camera: { position: Vec3; fov: number; calcFocusPoint: (out: Vec3) => void } } } }).viewer;
    if (!viewer) {
        console.warn('[ProjectThumbnail] app.viewer 未挂载：无法读取相机姿态（Viewer 初始化未完成？）');
        return null;
    }
    if (!viewer.cameraManager) {
        console.warn('[ProjectThumbnail] viewer.cameraManager 未创建：场景尚未就绪，无法读取相机姿态');
        return null;
    }
    return viewer.cameraManager;
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
    // 相机由动画驱动时先停下动画（anim → 交互模式，位姿保持不动），再读「当前视角」，
    // 否则动画会在后续帧把刚写入的默认视角覆盖回动画帧。
    if (global.state.cameraMode === 'anim') {
        console.log('[ProjectThumbnail] cameraMode=anim：先停止动画，再以当前视角作为默认视角');
        global.events.fire('inputEvent', 'interrupt');
    }

    const pose = readPrimaryCameraPoseFromManager(global);
    if (!pose) {
        return { ok: false, message: 'camera_unavailable' };
    }

    // 便于排查「默认视角/截图被动画帧覆盖」「截图拿到旧帧」：记录采集时的姿态与渲染就绪态
    console.log('[ProjectThumbnail] capture default view', {
        position: pose.position,
        target: pose.target,
        fov: pose.fov,
        cameraMode: global.state.cameraMode,
        readyToRender: global.state.readyToRender
    });
    if (!global.state.readyToRender) {
        console.warn('[ProjectThumbnail] readyToRender=false：场景首帧尚未就绪，截图可能为黑图/旧帧');
    }

    writePrimaryCameraInitial(global.settings as ExperienceSettings, pose);
    // 锁定进入/重置场景时的首屏视角：之后加载都停在 cameras[0].initial，不被 animTrack 自动接管
    (global.settings as ExperienceSettings).startAtDefaultView = true;
    // exitAnim: 动画正在驱动相机时必须退出动画，否则刚写入的姿态会被动画帧覆盖，截图取的也是动画帧
    global.events.fire('camera:syncPrimaryInitial', { exitAnim: true });

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

async function uploadPendingProjectThumbnailIfAny(global: Global): Promise<ProjectThumbnailUploadResult | null> {
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

/**
 * 序列化 settings 并上传云端：若有暂存缩略图则先登记，再上传 settings.json。
 * settings OSS 路径见 `universe/service.buildSettingsUploadObjectKey`（`<projectId>/<timestamp>/settings.json`）。
 */
export async function persistExperienceSettingsToCloud(global: Global): Promise<SettingsSavePipelineResult> {
    const serialized = serializeExperienceSettings(global);
    const jsonString = JSON.stringify(serialized, null, 2);
    const projectId = global.config.projectId;
    const token = global.config.token;

    if (hasPendingProjectThumbnail()) {
        if (projectId == null || projectId === '' || !token) {
            return { ok: false, message: '缺少 projectId 或 token，无法上传项目缩略图' };
        }
        const thumbResult = await uploadPendingProjectThumbnailIfAny(global);
        if (thumbResult && thumbResult.ok === false) {
            return { ok: false, message: thumbResult.message };
        }
    }

    const uploadResult = await uploadProjectData(projectId ?? '', token ?? '', jsonString);
    if (uploadResult.ok === false) {
        return { ok: false, message: uploadResult.message };
    }
    return { ok: true };
}

/**
 * internal：下载 settings.json；若有暂存缩略图则同时下载 `{projectId}-thumbnail.jpg`。
 */
export function downloadExperienceSettingsLocally(global: Global): void {
    const payload = serializeExperienceSettings(global);
    const jsonString = JSON.stringify(payload, null, 2);
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([jsonString], { type: 'application/json' }));
    a.download = 'settings.json';
    a.click();
    URL.revokeObjectURL(a.href);

    const blob = pendingProjectThumbnailJpeg;
    if (blob && blob.size > 0) {
        const projectId = global.config.projectId;
        const filename = projectId != null && projectId !== ''
            ? getProjectThumbnailFilename(projectId)
            : 'project-thumbnail.jpg';
        downloadBlobAsFile(blob, filename);
        clearPendingProjectThumbnail();
    }

    window.parent.postMessage(
        { type: 'SETTINGS_UPDATED', message: 'settings updated', payload: jsonString },
        '*'
    );
}
