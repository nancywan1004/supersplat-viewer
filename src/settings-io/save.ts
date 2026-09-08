// PROJECT_SAVE.destination：
// postMessage 本地保存一律 host：不下载、不上传，把 settings + 资源 File 交回父级。
// universe：不写 content、不上传主场景；只登记 settings.json（用户资产 sidecar 仍 put）。
// local：仅 Viewer 内部 UI 直连调用，下载 project-{projectId}.zip（不走 postMessage 协议）。
// 缩略图仅 universe 登记。
import { isMainSceneModifiedForHostSave, type SettingsSaveDestination } from './host-protocol';
import {
    SETTINGS_JSON_NAME,
    blobFromBytes,
    localProjectZipFilename,
    normalizePackPath,
    zipSettingsArchive
} from './pack';
import {
    packMainSceneContent,
    stripPackedContentField,
    writePackedContentField
} from './project-pack';
import {
    collectSettingsResourceReferences,
    collectUserUploadRelativePaths,
    materializeUserUploadRelativeFiles,
    type SettingsResourceReference
} from './user-files';
import { hasPendingProjectThumbnail, uploadPendingProjectThumbnailIfAny } from '../render/project-thumbnail';
import type { ExperienceSettings } from '../schemas/v2';
import { serializeExperienceSettings } from '../settings-serialize/settings-serialize';
import type { Global } from '../types';
import { uploadProjectData, uploadProjectSidecarFiles } from '../universe/service';

export type { SettingsSaveDestination } from './host-protocol';
export { resolveSettingsSaveDestination } from './host-protocol';

export type HostSaveFile = {
    path: string;
    file: File;
};

export type HostSavePayload = {
    settings: ExperienceSettings;
    files: HostSaveFile[];
    references: SettingsResourceReference[];
    contentChanged: boolean;
};

export type SettingsSavePipelineResult =
    | { ok: true }
    | { ok: true; host: HostSavePayload }
    | { ok: false; message: string };

export function isHostSaveSuccess(
    result: SettingsSavePipelineResult
): result is { ok: true; host: HostSavePayload } {
    return result.ok === true && 'host' in result && result.host != null;
}

export function downloadBlobAsFile(blob: Blob, filename: string): void {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    URL.revokeObjectURL(a.href);
}

function toHostFile(path: string, blob: Blob): File {
    const name = path.split('/').pop() || 'file';
    const type = blob.type || 'application/octet-stream';
    if (blob instanceof File && blob.name) return blob;
    return new File([blob], name, { type });
}

async function downloadLocalProject(
    global: Global,
    settings: ExperienceSettings,
    relativePaths: string[]
): Promise<SettingsSavePipelineResult> {
    const packedScene = await packMainSceneContent(global);
    if (packedScene.ok === false) {
        return packedScene;
    }
    const withContent = writePackedContentField(settings, packedScene.relativePath);
    const packedJson = JSON.stringify(withContent, null, 2);

    const files: Array<[string, Blob]> = [[packedScene.relativePath, packedScene.blob]];
    for (const path of relativePaths) {
        if (path === packedScene.relativePath) continue;
        const blob = global.userUploadFiles?.get(path);
        if (!blob) {
            return { ok: false, message: `无法读取用户上传文件: ${path}` };
        }
        files.push([path, blob]);
    }

    try {
        const zipped = await zipSettingsArchive(packedJson, files);
        downloadBlobAsFile(blobFromBytes(zipped, 'application/zip'), localProjectZipFilename(global.config.projectId));
        return { ok: true };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message: message.startsWith('无法') ? message : `打包 zip 失败: ${message}` };
    }
}

async function buildHostSavePayload(
    global: Global,
    settings: ExperienceSettings,
    relativePaths: string[]
): Promise<SettingsSavePipelineResult> {
    const contentChanged = isMainSceneModifiedForHostSave(global.config);
    const packedScene = await packMainSceneContent(global);
    if (packedScene.ok === false) {
        return packedScene;
    }
    const nextSettings = writePackedContentField(settings, packedScene.relativePath);
    const files: HostSaveFile[] = [
        { path: packedScene.relativePath, file: toHostFile(packedScene.relativePath, packedScene.blob) }
    ];

    for (const path of relativePaths) {
        if (files.some(entry => entry.path === path)) continue;
        const blob = global.userUploadFiles?.get(path);
        if (!blob) {
            return { ok: false, message: `无法读取用户上传文件: ${path}` };
        }
        files.push({ path, file: toHostFile(path, blob) });
    }

    return {
        ok: true,
        host: {
            settings: nextSettings,
            files,
            references: collectSettingsResourceReferences(nextSettings),
            contentChanged
        }
    };
}

export async function saveExperienceProject(
    global: Global,
    destination: SettingsSaveDestination = 'universe'
): Promise<SettingsSavePipelineResult> {
    const serialized = serializeExperienceSettings(global);
    const materialized = await materializeUserUploadRelativeFiles(global, serialized);
    if (!materialized.ok) return materialized;
    const relativePaths = collectUserUploadRelativePaths(materialized.settings);

    if (destination === 'local') {
        return downloadLocalProject(global, materialized.settings, relativePaths);
    }
    if (destination === 'host') {
        return buildHostSavePayload(global, materialized.settings, relativePaths);
    }

    const universeSettings = stripPackedContentField(materialized.settings);
    const universeJson = JSON.stringify(universeSettings, null, 2);

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
            if (!path || path.toLowerCase() === SETTINGS_JSON_NAME || path.toLowerCase().startsWith('content/')) {
                continue;
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
        universeJson,
        uploadTimestamp
    );
    if (uploadResult.ok === false) {
        return { ok: false, message: uploadResult.message };
    }
    return { ok: true };
}
