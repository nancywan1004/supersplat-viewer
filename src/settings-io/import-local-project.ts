import { isPackedContentFilename, packedContentRelativePath, parseProjectFileList } from './project-pack';
import { savePendingProjectPack } from './project-pack-store';
import { toUserUploadFetchUrl } from './user-files';

export type ProjectImportResult =
    | { ok: true }
    | { ok: false; message: string };

function isZipFile(file: File): boolean {
    const name = file.name.toLowerCase();
    return name.endsWith('.zip') || file.type === 'application/zip' || file.type === 'application/x-zip-compressed';
}

/**
 * 拉一份 settings 当模板（单文件导入只带主场景，其余配置沿用当前项目）。
 * @param url - settings.json URL
 * @param contentPath - 写入 `settings.content` 的虚拟路径
 * @returns settings，或 null（没配 / 拉不到）
 */
async function tryLoadSettingsTemplate(
    url: string | undefined,
    contentPath: string
): Promise<Record<string, unknown> | null> {
    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (!trimmed) return null;
    try {
        const response = await fetch(toUserUploadFetchUrl(trimmed));
        if (!response.ok) return null;
        const settings = await response.json() as Record<string, unknown>;
        return { ...settings, content: contentPath };
    } catch {
        return null;
    }
}

/**
 * 单文件导入的 settings 模板：优先 `?settings=`（保留项目相机 / 特效 / lodSettings / 标注），
 * 其次 viewer 默认 `./settings.json`（dev 只 serve `public/`，该文件不存在是常态），
 * 都拿不到就用最小配置 —— 不要因为缺默认 settings 让导入失败。
 * @param contentPath - 写入 `settings.content` 的虚拟路径
 * @returns settings
 */
async function loadSingleContentTemplate(contentPath: string): Promise<Record<string, unknown>> {
    const sse = (window as Window & {
        sse?: { config?: { settingsUrl?: string }; defaultSettingsUrl?: string }
    }).sse;
    const fromQuery = await tryLoadSettingsTemplate(sse?.config?.settingsUrl, contentPath);
    if (fromQuery) return fromQuery;
    const fromDefault = await tryLoadSettingsTemplate(sse?.defaultSettingsUrl, contentPath);
    if (fromDefault) return fromDefault;
    console.warn(
        '[SuperSplat][projectImport] 单文件导入未取到 settings 模板（?settings= 与 ./settings.json 都不可用），改用最小配置'
    );
    // 与 index.html 空入口的 emptySettings 同形，importSettings 可接受
    return { camera: {}, background: {}, animTracks: [], content: contentPath };
}

/**
 * 单个文件导入：`.sog` / `.splat` / `.ply` / `lod-meta.json` → settings 模板 + 虚拟 `content/`。
 * lod-meta 的分块不在包内时由 applyPackedSceneToConfig 按原 `?content=` 或绝对 URL 解析。
 * @param file - 用户选择的单个文件
 * @returns 项目包，或 undefined（不是可识别的主场景）
 */
async function parseSingleContentFile(file: File) {
    if (!isPackedContentFilename(file.name)) return undefined;
    const relativePath = packedContentRelativePath(file.name);
    const settings = await loadSingleContentTemplate(relativePath);
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
