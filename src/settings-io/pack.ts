// settings.json / 项目 zip 共用：路径规范化、MIME、zip 编码。
import { zipSync, strToU8, type Zippable } from 'fflate';

export const SETTINGS_JSON_NAME = 'settings.json';
export const PROJECT_ZIP_NAME = 'project.zip';

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

export function blobFromBytes(data: Uint8Array, type = 'application/octet-stream'): Blob {
    const copy = new Uint8Array(data.byteLength);
    copy.set(data);
    return new Blob([copy], { type });
}

export async function bytesFromBlob(blob: Blob): Promise<Uint8Array> {
    return new Uint8Array(await blob.arrayBuffer());
}

export async function zipSettingsArchive(
    jsonString: string,
    files: Iterable<[string, Blob]>
): Promise<Uint8Array> {
    const zippable: Zippable = {
        [SETTINGS_JSON_NAME]: [strToU8(jsonString), { level: 6 }]
    };
    for (const [rawPath, blob] of files) {
        const path = normalizePackPath(rawPath);
        if (!path || path === SETTINGS_JSON_NAME) {
            throw new Error(`无法打包用户上传文件: ${rawPath}`);
        }
        zippable[path] = [await bytesFromBlob(blob), { level: 0 }];
    }
    return zipSync(zippable);
}
