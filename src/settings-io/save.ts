// SETTINGS_SAVE.destination 只决定 settings.json 去向。
// local：无相对路径文件下 settings.json，有则 zip（settings.json + assets/）。
// universe：不打 zip；有相对路径文件则先 OSS put 到 settings 同 timestamp 目录，再登记 settings.json。
// 缩略图仅 universe 登记，不进版本目录。
import { hasPendingProjectThumbnail, uploadPendingProjectThumbnailIfAny } from '../render/project-thumbnail';
import { serializeExperienceSettings } from '../settings-serialize/settings-serialize';
import type { Global } from '../types';
import { uploadProjectData, uploadProjectSidecarFiles } from '../universe/service';
import {
    PROJECT_ZIP_NAME,
    SETTINGS_JSON_NAME,
    blobFromBytes,
    normalizePackPath,
    zipSettingsArchive
} from './pack';
import {
    collectUserUploadRelativePaths,
    materializeUserUploadRelativeFiles
} from './user-files';

export type SettingsSaveDestination = 'local' | 'universe';

export type SettingsSavePipelineResult =
    | { ok: true }
    | { ok: false; message: string };

export function downloadBlobAsFile(blob: Blob, filename: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

// 缺省或非法值视为 universe（与现有 SaaS 父页 SETTINGS_SAVE 行为一致）。
export function resolveSettingsSaveDestination(value: unknown): SettingsSaveDestination {
    return value === 'local' ? 'local' : 'universe';
}

async function downloadLocalProject(
    global: Global,
    jsonString: string,
    relativePaths: string[]
): Promise<SettingsSavePipelineResult> {
    if (relativePaths.length === 0) {
        downloadBlobAsFile(new Blob([jsonString], { type: 'application/json' }), SETTINGS_JSON_NAME);
        return { ok: true };
    }

    const files: Array<[string, Blob]> = [];
    for (const path of relativePaths) {
        const blob = global.userUploadFiles?.get(path);
        if (!blob) {
            return { ok: false, message: `无法读取用户上传文件: ${path}` };
        }
        files.push([path, blob]);
    }

    try {
        const zipped = await zipSettingsArchive(jsonString, files);
        downloadBlobAsFile(blobFromBytes(zipped, 'application/zip'), PROJECT_ZIP_NAME);
        return { ok: true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message: message.startsWith('无法') ? message : `打包 zip 失败: ${message}` };
    }
}

export async function saveExperienceProject(
    global: Global,
    destination: SettingsSaveDestination = 'universe'
): Promise<SettingsSavePipelineResult> {
    const serialized = serializeExperienceSettings(global);
    const materialized = await materializeUserUploadRelativeFiles(global, serialized);
    if (!materialized.ok) return materialized;
    const jsonString = JSON.stringify(materialized.settings, null, 2);
    const relativePaths = collectUserUploadRelativePaths(materialized.settings);

    if (destination === 'local') {
        return downloadLocalProject(global, jsonString, relativePaths);
    }

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

    const uploadTimestamp = Date.now();
    if (relativePaths.length > 0) {
        const sidecarFiles: Array<{ relativePath: string; blob: Blob }> = [];
        for (const raw of relativePaths) {
            const path = normalizePackPath(raw) ?? raw;
            if (!path || path.toLowerCase() === SETTINGS_JSON_NAME) {
                return { ok: false, message: `无法上传用户文件: ${raw}` };
            }
            const blob = global.userUploadFiles?.get(raw) ?? global.userUploadFiles?.get(path);
            if (!blob) {
                return { ok: false, message: `无法读取用户上传文件: ${path}` };
            }
            sidecarFiles.push({ relativePath: path, blob });
        }
        const sidecarResult = await uploadProjectSidecarFiles(
            projectId ?? '',
            token ?? '',
            sidecarFiles,
            uploadTimestamp
        );
        if (sidecarResult.ok === false) {
            return sidecarResult;
        }
    }

    const uploadResult = await uploadProjectData(
        projectId ?? '',
        token ?? '',
        jsonString,
        uploadTimestamp
    );
    if (uploadResult.ok === false) {
        return { ok: false, message: uploadResult.message };
    }
    return { ok: true };
}
