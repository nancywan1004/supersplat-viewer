import { parseProjectFileList } from './project-pack';
import { savePendingProjectPack } from './project-pack-store';

export type ProjectImportResult =
    | { ok: true }
    | { ok: false; message: string };

function isZipFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
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
