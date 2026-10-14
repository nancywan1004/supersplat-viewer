// PROJECT_SAVE.destination：
// postMessage 本地保存一律 host：不下载、不上传，把 settings + 资源 File 交回父级。
// universe：不写 content、不上传主场景；只登记 settings.json（用户资产 sidecar 仍 put）。
// local：仅 Viewer 内部 UI 直连调用，下载 project-{projectId}.zip（不走 postMessage 协议）。
// local-settings：仅 Viewer 内部 UI 直连调用，只下载 settings.json（不拉主场景、不打 zip、不上传）。
// 缩略图仅 universe 登记。
import { isMainSceneModifiedForHostSave, type SettingsSaveDestination } from './host-protocol';
import {
    SETTINGS_JSON_NAME,
    localProjectZipFilename,
    normalizePackPath,
    zipSettingsArchive
} from './pack';
import {
    SAVE_CANCELLED_MESSAGE,
    formatByteSize,
    packMainSceneContent,
    resolvePackedContentRelativePath,
    stripPackedContentField,
    writePackedContentField,
    type ProjectSaveProgress,
    type ProjectSaveProgressReporter
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
export type {
    ProjectSavePhase,
    ProjectSaveProgress,
    ProjectSaveProgressReporter
} from './project-pack';
/** 保存进度事件名：`global.events` 上派发，UI / message-bridge 订阅 */
export const PROJECT_SAVE_PROGRESS_EVENT = 'projectSave:progress';
/**
 * 保存结束事件名（**仅同窗口内部 UI** 用）：message-bridge 处理完 `PROJECT_SAVE` 后派发。
 * 对父级的结束回调仍是 `PROJECT_SAVE_RESULT` / `PROJECT_SAVE_SUCCEEDED` / `PROJECT_SAVE_FAILED`。
 */
export const PROJECT_SAVE_RESULT_EVENT = 'projectSave:result';

/**
 * 进度上报：节流打日志 + 派发 `projectSave:progress`（事件不节流，UI 进度条逐项跟）。
 * @param global - Viewer 全局态
 * @returns 上报函数
 */
function createSaveProgressReporter(global: Global): ProjectSaveProgressReporter {
    let lastLogPhase = '';
    let lastLogBucket = -1;
    return (progress: ProjectSaveProgress) => {
        const total = progress.total ?? 0;
        const done = progress.done ?? 0;
        // 有分母的（分块下载 / 打包）按 10% 节流；无分母的（单文件、上传）每条都打
        const bucket = total > 0 ? Math.floor((done / total) * 10) : -1;
        const shouldLog = total <= 0 ||
            progress.phase !== lastLogPhase ||
            bucket !== lastLogBucket ||
            done >= total;
        lastLogPhase = progress.phase;
        lastLogBucket = bucket;
        if (shouldLog) {
            console.log(`[SuperSplat][projectSave] ${progress.message}`);
        }
        global.events.fire(PROJECT_SAVE_PROGRESS_EVENT, progress);
    };
}

/**
 * 让浏览器先画一帧再继续：打包 zip 是同步阻塞的，否则进度提示来不及显示。
 * @returns 下一帧（隐藏标签页由定时器兜底）
 */
function nextFrame(): Promise<void> {
    return new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 50);
        if (typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(() => {
                window.clearTimeout(timer);
                resolve();
            });
        }
    });
}

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
    | { ok: false; message: string; cancelled?: boolean };

export type SettingsSaveOptions = {
    /**
     * 中途取消（分块下载 / 主场景下载 / 打包 zip / 上传都会尽快停），
     * 结果返回 `{ ok: false, cancelled: true, message: '已取消保存' }`。
     */
    signal?: AbortSignal;
};

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
    relativePaths: string[],
    report: ProjectSaveProgressReporter,
    signal?: AbortSignal
): Promise<SettingsSavePipelineResult> {
    const packedScene = await packMainSceneContent(global, report, signal);
    if (packedScene.ok === false) {
        return packedScene;
    }
    const withContent = writePackedContentField(settings, packedScene.relativePath);
    const packedJson = JSON.stringify(withContent, null, 2);

    const files: Array<[string, Blob]> = [[packedScene.relativePath, packedScene.blob]];
    for (const extra of packedScene.extraFiles) {
        files.push([extra.path, extra.blob]);
    }
    for (const path of relativePaths) {
        if (files.some(([packedPath]) => packedPath === path)) continue;
        const blob = global.userUploadFiles?.get(path);
        if (!blob) {
            return { ok: false, message: `无法读取用户上传文件: ${path}` };
        }
        files.push([path, blob]);
    }

    const zipName = localProjectZipFilename(global.config.projectId);
    const totalBytes = files.reduce((sum, [, blob]) => sum + blob.size, 0);
    report({
        phase: 'packing',
        message: `正在打包 ${zipName}（${files.length} 个文件 · ${formatByteSize(totalBytes)}）…`,
        bytes: totalBytes
    });
    // 先让首条「正在打包」画出来，再进同步压缩的分片循环
    await nextFrame();

    try {
        const zipped = await zipSettingsArchive(packedJson, files, {
            onProgress: ({ done, total, bytes }) => report({
                phase: 'packing',
                message: `正在打包 ${zipName} ${done}/${total} · ${formatByteSize(bytes)}`,
                done,
                total,
                bytes
            }),
            signal
        });
        downloadBlobAsFile(zipped, zipName);
        report({
            phase: 'packing',
            message: `已生成 ${zipName}（${formatByteSize(zipped.size)}）`,
            bytes: zipped.size
        });
        return { ok: true };
    } catch (err) {
        if (signal?.aborted) {
            return { ok: false, cancelled: true, message: SAVE_CANCELLED_MESSAGE };
        }
        const message = err instanceof Error ? err.message : String(err);
        return { ok: false, message: message.startsWith('无法') ? message : `打包 zip 失败: ${message}` };
    }
}

/**
 * 「只保存 settings.json」的 payload：与本地 zip 内那份保持一致（写入包内主场景相对路径 `content/...`），
 * 推导不出主场景（空入口 / 非可打包场景）时保留原 `content`，不因缺少主场景让导出失败。
 * @param global - Viewer 全局态
 * @param settings - 已物化用户上传相对路径的 settings
 * @returns 待导出的 settings
 */
function withPackedContentForSettingsOnly(global: Global, settings: ExperienceSettings): ExperienceSettings {
    const relativePath = resolvePackedContentRelativePath(global.config.contentUrl);
    return relativePath ? writePackedContentField(settings, relativePath) : settings;
}

/**
 * 只下载 settings.json：不拉主场景、不打 zip、不上传缩略图，只把当前 settings 落成单个 JSON 文件。
 * 包内相对路径的用户资产（`assets/...`）不会一起下载，与 universe 分支语义一致（保留相对路径引用）。
 * @param global - Viewer 全局态
 * @param settings - 已物化用户上传相对路径的 settings
 * @param report - 进度上报
 * @returns 结果
 */
function downloadLocalSettingsFile(
    global: Global,
    settings: ExperienceSettings,
    report: ProjectSaveProgressReporter
): SettingsSavePipelineResult {
    report({ phase: 'packing', message: `正在生成 ${SETTINGS_JSON_NAME}…` });
    const payload = withPackedContentForSettingsOnly(global, settings);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    downloadBlobAsFile(blob, SETTINGS_JSON_NAME);
    report({
        phase: 'packing',
        message: `已生成 ${SETTINGS_JSON_NAME}（${formatByteSize(blob.size)}）`,
        bytes: blob.size
    });
    return { ok: true };
}

async function buildHostSavePayload(
    global: Global,
    settings: ExperienceSettings,
    relativePaths: string[],
    report: ProjectSaveProgressReporter,
    signal?: AbortSignal
): Promise<SettingsSavePipelineResult> {
    const contentChanged = isMainSceneModifiedForHostSave(global.config);
    const packedScene = await packMainSceneContent(global, report, signal);
    if (packedScene.ok === false) {
        return packedScene;
    }
    const nextSettings = writePackedContentField(settings, packedScene.relativePath);
    const files: HostSaveFile[] = [
        { path: packedScene.relativePath, file: toHostFile(packedScene.relativePath, packedScene.blob) }
    ];
    for (const extra of packedScene.extraFiles) {
        if (files.some(entry => entry.path === extra.path)) continue;
        files.push({ path: extra.path, file: toHostFile(extra.path, extra.blob) });
    }

    for (const path of relativePaths) {
        if (files.some(entry => entry.path === path)) continue;
        const blob = global.userUploadFiles?.get(path);
        if (!blob) {
            return { ok: false, message: `无法读取用户上传文件: ${path}` };
        }
        files.push({ path, file: toHostFile(path, blob) });
    }

    const totalBytes = files.reduce((sum, entry) => sum + entry.file.size, 0);
    report({
        phase: 'packing',
        message: `已准备 ${files.length} 个文件（${formatByteSize(totalBytes)}），交回外层打包`,
        bytes: totalBytes
    });
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

/**
 * 保存项目统一入口。全过程通过 `global.events` 的 `projectSave:progress` 上报进度。
 * @param global - Viewer 全局态
 * @param destination - local 下载 zip / local-settings 只下载 settings.json / host 交回父级 / universe 上传
 * @param options - `signal` 可中途取消
 * @returns 结果（host 成功时带产物；取消时 `cancelled: true`）
 */
export async function saveExperienceProject(
    global: Global,
    destination: SettingsSaveDestination = 'universe',
    options?: SettingsSaveOptions
): Promise<SettingsSavePipelineResult> {
    const signal = options?.signal;
    const cancelled = (): SettingsSavePipelineResult => ({
        ok: false,
        cancelled: true,
        message: SAVE_CANCELLED_MESSAGE
    });
    if (signal?.aborted) return cancelled();

    const report = createSaveProgressReporter(global);
    const serialized = serializeExperienceSettings(global);
    const materialized = await materializeUserUploadRelativeFiles(global, serialized);
    if (!materialized.ok) return materialized;
    const relativePaths = collectUserUploadRelativePaths(materialized.settings);
    if (signal?.aborted) return cancelled();

    if (destination === 'local') {
        return downloadLocalProject(global, materialized.settings, relativePaths, report, signal);
    }
    if (destination === 'local-settings') {
        return downloadLocalSettingsFile(global, materialized.settings, report);
    }
    if (destination === 'host') {
        return buildHostSavePayload(global, materialized.settings, relativePaths, report, signal);
    }

    const universeSettings = stripPackedContentField(materialized.settings);
    const universeJson = JSON.stringify(universeSettings, null, 2);

    const projectId = global.config.projectId;
    const token = global.config.token;

    if (hasPendingProjectThumbnail()) {
        if (projectId == null || projectId === '' || !token) {
            return { ok: false, message: '缺少 projectId 或 token，无法上传项目缩略图' };
        }
        report({ phase: 'uploading', message: '正在上传项目缩略图…' });
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
        if (signal?.aborted) return cancelled();
        report({ phase: 'uploading', message: `正在上传 ${sidecarFiles.length} 个附件…` });
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

    if (signal?.aborted) return cancelled();
    report({ phase: 'uploading', message: '正在上传 settings.json…' });
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
