import {
    hasExplicitContentQueryParam,
    parseProjectFileList,
    type ParsedProjectPack
} from './project-pack';
import { requestSceneAssetsRestore } from '../scene-assets/asset-placement-handler';
import type { ExperienceSettings } from '../schemas/v2';
import { importSettings } from '../settings';
import { applySettingsSnapshot } from '../settings-serialize/settings-serialize';
import type { Global } from '../types';
import { savePendingProjectPack } from './project-pack-store';
import { rememberUserUploadFile } from './user-files';

export type ProjectImportResult =
    | { ok: true; mode: 'reload' }
    | { ok: true; mode: 'settings-only' }
    | { ok: false; message: string };

function isZipFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

export async function parseProjectImportInput(input: FileList | File[] | File): Promise<ParsedProjectPack> {
    const files = input instanceof File ? [input] : Array.from(input as ArrayLike<File>);
    if (files.length === 0) {
        throw new Error('项目文件夹为空');
    }
    const onlyBareZip = files.length === 1 &&
        isZipFile(files[0]) &&
        !files[0].webkitRelativePath?.includes('/');
    if (onlyBareZip) {
        throw new Error('请导入项目文件夹，不支持 zip');
    }
    return await parseProjectFileList(files);
}

export async function applyProjectPackSettingsOnly(global: Global, pack: ParsedProjectPack): Promise<void> {
    for (const [path, blob] of pack.files) {
        rememberUserUploadFile(global, path, blob);
    }
    const snapshot = importSettings(pack.settings);
    applySettingsSnapshot(global, snapshot);
    (global as { __originalSettings?: ExperienceSettings }).__originalSettings =
        JSON.parse(JSON.stringify(global.settings)) as ExperienceSettings;
    await requestSceneAssetsRestore(global, { reason: 'startup' });
}

export async function importLocalProject(
    global: Global,
    input: FileList | File[] | File,
    search: string = location.search
): Promise<ProjectImportResult> {
    let pack: ParsedProjectPack;
    try {
        pack = await parseProjectImportInput(input);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, message };
    }

    if (hasExplicitContentQueryParam(search)) {
        try {
            await applyProjectPackSettingsOnly(global, pack);
            return { ok: true, mode: 'settings-only' };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            return { ok: false, message };
        }
    }

    try {
        await savePendingProjectPack({
            settings: pack.settings,
            files: [...pack.files.entries()].map(([path, blob]) => ({ path, blob }))
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, message: `缓存项目包失败: ${message}` };
    }
    location.reload();
    return { ok: true, mode: 'reload' };
}
