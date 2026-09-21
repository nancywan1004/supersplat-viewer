// settings.json / 项目 zip 共用：路径规范化、MIME、zip 编码。
import { Zip, ZipDeflate, ZipPassThrough } from 'fflate';

export const SETTINGS_JSON_NAME = 'settings.json';
export const PROJECT_ZIP_NAME = 'project.zip';

/** settings.json 压缩级别；分块 / 资产已是压缩格式，原样存（level 0） */
const SETTINGS_JSON_LEVEL = 6;
/** 打包时两次让出事件循环的最小间隔（ms）：既刷新进度又不浪费帧 */
const ZIP_YIELD_INTERVAL_MS = 16;
/** 打包被取消时抛出的文案（save 层按 signal 判定，不比对文案） */
const ZIP_ABORTED_MESSAGE = '已取消保存';

/**
 * 本地下载 zip 文件名：`project-{projectId}.zip`；无 projectId 时为 `project.zip`。
 * @param projectId - Viewer config.projectId
 * @returns 可作 a.download 的文件名
 */
export function localProjectZipFilename(projectId?: string | number): string {
    const raw = projectId == null ? '' : String(projectId).trim();
    const safe = raw.replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '-');
    return safe ? `project-${safe}.zip` : PROJECT_ZIP_NAME;
}

export function canonicalizeSlashPath(raw: string): string {
    return raw.trim().replace(/\\/g, '/').replace(/^\.\//, '');
}

/** 包内相对路径：去掉前导 /、拒绝 `..` / 目录项 / __MACOSX。 */
export function normalizePackPath(raw: string): string | null {
    const path = canonicalizeSlashPath(raw).replace(/^\/+/, '');
    if (!path || path.endsWith('/')) return null;
    const parts = path.split('/');
    if (parts.some((p) => p === '..' || p === '.' || p === '')) return null;
    if (path.toLowerCase().startsWith('__macosx/')) return null;
    return path;
}

export function extensionFromMime(mime: string, fallback: string): string {
    const m = (mime || '').toLowerCase();
    if (m.includes('png')) return '.png';
    if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
    if (m.includes('webp')) return '.webp';
    if (m.includes('gif')) return '.gif';
    if (m.includes('mp4')) return '.mp4';
    if (m.includes('webm')) return '.webm';
    if (m.includes('mp3') || m.includes('mpeg') || m.includes('m4a')) return '.mp3';
    if (m.includes('wav')) return '.wav';
    if (m.includes('ogg')) return '.ogg';
    if (m.includes('hdr')) return '.hdr';
    if (m.includes('gltf')) return '.glb';
    return fallback.startsWith('.') ? fallback : `.${fallback}`;
}

export type ZipArchiveProgress = {
    /** 已处理文件数 / 总数（含 settings.json） */
    done: number;
    total: number;
    /** 累计写入字节（原始大小） */
    bytes: number;
};

export type ZipArchiveOptions = {
    /** 逐文件进度回调 */
    onProgress?: (progress: ZipArchiveProgress) => void;
    /** 中途取消：每个文件之间检查，aborted 时抛错 */
    signal?: AbortSignal;
};

/**
 * 让出一次事件循环（打包的压缩仍是同步的，靠它刷新进度 / 保持响应）。
 * @returns 下一个宏任务
 */
function yieldToEventLoop(): Promise<void> {
    return new Promise<void>((resolve) => {
        setTimeout(resolve, 0);
    });
}

/**
 * 把 fflate 输出的分片重包成 `ArrayBuffer` 视图（**不复制字节**），
 * 只为满足 `BlobPart` 对 `ArrayBuffer` 视图的要求（fflate 用 `new Uint8Array()` 分配，不是 SAB）。
 * @param chunk - fflate 回调给的分片
 * @returns 同一段字节的视图
 */
function asBlobChunk(chunk: Uint8Array): Uint8Array<ArrayBuffer> {
    return new Uint8Array(chunk.buffer as ArrayBuffer, chunk.byteOffset, chunk.byteLength);
}

/**
 * 流式打 zip：逐文件读字节 → 分片写 Blob，避免 `zipSync` 的一次性大 `Uint8Array`。
 * 文件之间（按 {@link ZIP_YIELD_INTERVAL_MS} 节流）让出事件循环，进度可刷新、页面不假死。
 * @param jsonString - settings.json 内容（由本函数写入，勿在 `files` 里重复传）
 * @param files - 包内条目 `[path, blob]`
 * @param options - 进度回调
 * @returns 可下载的 zip Blob
 */
export async function zipSettingsArchive(
    jsonString: string,
    files: Iterable<[string, Blob]>,
    options?: ZipArchiveOptions
): Promise<Blob> {
    const entries: Array<[string, Blob]> = [
        [SETTINGS_JSON_NAME, new Blob([jsonString], { type: 'application/json' })]
    ];
    for (const [rawPath, blob] of files) {
        const path = normalizePackPath(rawPath);
        if (!path || path === SETTINGS_JSON_NAME) {
            throw new Error(`无法打包用户上传文件: ${rawPath}`);
        }
        entries.push([path, blob]);
    }

    // fflate 的 Zip 回调拿到的都是新分配的分片（store 用我们 push 的 buffer，deflate 是新 u8），
    // 直接持有引用即可，不需要再整包复制。
    const chunks: Array<Uint8Array<ArrayBuffer>> = [];
    const zipState: { error: Error | null } = { error: null };
    const zip = new Zip((err, data) => {
        if (err) {
            zipState.error = err instanceof Error ? err : new Error(String(err));
            return;
        }
        if (data && data.byteLength > 0) chunks.push(asBlobChunk(data));
    });

    const total = entries.length;
    let done = 0;
    let bytes = 0;
    let lastYieldAt = Date.now();
    options?.onProgress?.({ done, total, bytes });

    // 递归而非 for：fflate 的 Zip 要求逐条串行 push，递归天然串行且不触发 no-await-in-loop
    const appendEntry = async (index: number): Promise<void> => {
        if (index >= entries.length) return;
        if (options?.signal?.aborted) throw new Error(ZIP_ABORTED_MESSAGE);
        const [path, blob] = entries[index];
        const data = new Uint8Array(await blob.arrayBuffer());
        const entry = path === SETTINGS_JSON_NAME ?
            new ZipDeflate(path, { level: SETTINGS_JSON_LEVEL }) :
            new ZipPassThrough(path);
        zip.add(entry);
        entry.push(data, true);
        if (zipState.error) throw zipState.error;

        done += 1;
        bytes += data.byteLength;
        options?.onProgress?.({ done, total, bytes });

        if (Date.now() - lastYieldAt >= ZIP_YIELD_INTERVAL_MS) {
            lastYieldAt = Date.now();
            await yieldToEventLoop();
        }
        await appendEntry(index + 1);
    };
    await appendEntry(0);

    zip.end();
    if (zipState.error) throw zipState.error;
    const blob = new Blob(chunks, { type: 'application/zip' });
    // Blob 构造已复制字节，这里放掉分片引用，避免 JS 侧多留一份
    chunks.length = 0;
    return blob;
}
