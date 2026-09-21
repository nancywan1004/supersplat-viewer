import { isPackedContentFilename, packedContentRelativePath, parseProjectFileList } from './project-pack';
import { savePendingProjectPack } from './project-pack-store';

export type ProjectImportResult =
    | { ok: true }
    | { ok: false; message: string };

function isZipFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

/**
 * 单个文件导入：`.sog` / `.splat` / `.ply` / `lod-meta.json` → 默认 settings + 虚拟 `content/`。
 * lod-meta 的分块不在包内时由 applyPackedSceneToConfig 按原 `?content=` 或绝对 URL 解析。
 * @param file - 用户选择的单个文件
 * @returns 项目包，或 undefined（不是可识别的主场景）
 */
async function parseSingleContentFile(file: File) {
    if (!isPackedContentFilename(file.name)) return undefined;
    const relativePath = packedContentRelativePath(file.name);
    const defaultSettingsUrl = (window as Window & {
        sse?: { defaultSettingsUrl?: string }
    }).sse?.defaultSettingsUrl;
    if (!defaultSettingsUrl) {
        throw new Error('无法定位默认 settings 文件');
    }
    const response = await fetch(defaultSettingsUrl);
    if (!response.ok) {
        throw new Error(`加载默认 settings 失败，状态码: ${response.status}`);
    }
    const settings = await response.json() as Record<string, unknown>;
    settings.content = relativePath;
    return {
        settings,
        files: new Map([[relativePath, file as Blob]])
    };
}

export async function parseProjectImportInput(input: FileList | File[] | File) {
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
    if (files.length === 1) {
        const singleContentPack = await parseSingleContentFile(files[0]);
        if (singleContentPack) return singleContentPack;
        // 单文件选择器（非目录遍历）选了既非场景也非 lod-meta 的文件：直接报错，别让空 settings 进刷新
        if (!files[0].webkitRelativePath?.includes('/')) {
            throw new Error('请选择 .sog / .splat / .ply 或 lod-meta.json');
        }
    }
    return await parseProjectFileList(files);
}

/**
 * 解析项目文件夹并写入刷新缓存。调用方在成功出站后再 `location.reload()`。
 */
export async function importLocalProject(
    input: FileList | File[] | File
): Promise<ProjectImportResult> {
    let pack;
    try {
        pack = await parseProjectImportInput(input);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, message };
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
    return { ok: true };
}
