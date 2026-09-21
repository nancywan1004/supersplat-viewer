// 项目包路径与文件夹解析（不依赖 universe / user-files，便于 Node 单测）。
// parseProjectZipBytes 只用于校验本地下载的 zip，导入不走 zip。
import { unzipSync } from 'fflate';

import { SETTINGS_JSON_NAME, normalizePackPath } from './pack';

export const PACKED_CONTENT_DIR = 'content';

/** LOD 场景入口文件名（分块按 filenames 相对本文件解析）。 */
export const LOD_META_FILENAME = 'lod-meta.json';

const SCENE_FILE_RE = /\.(?:sog|splat|ply)$/i;
const EPHEMERAL_URL_RE = /^(?:blob|data):/i;

export type ParsedProjectPack = {
    settings: unknown;
    files: Map<string, Blob>;
};

export function hasExplicitContentQueryParam(search: string): boolean {
    return new URLSearchParams(search).has('content');
}

/**
 * 文件名是否为 LOD 入口 `lod-meta.json`。
 * @param name - 文件名或包内路径
 * @returns 是否 LOD meta
 */
export function isLodMetaFilename(name: string | undefined): boolean {
    const base = (name ?? '').split('/').pop()?.toLowerCase() ?? '';
    return base === LOD_META_FILENAME;
}

/**
 * 单文件导入可识别的场景名（不含 lod-meta.json：单独一份 meta 没有分块）。
 * @param name - 文件名
 * @returns 是否单文件场景
 */
export function isPackedSceneFilename(name: string): boolean {
    if (isLodMetaFilename(name)) return false;
    const base = (name.split('/').pop() ?? name).toLowerCase();
    return SCENE_FILE_RE.test(base);
}

/**
 * 项目包 `content/` 下可作为主场景的文件：`.sog` / `.splat` / `.ply` 或 `lod-meta.json`。
 * @param name - 包内路径
 * @returns 是否可作为主场景
 */
export function isPackedContentFilename(name: string): boolean {
    return isLodMetaFilename(name) || isPackedSceneFilename(name);
}

export function packedContentRelativePath(filename: string): string {
    const base = (filename.split('/').pop() || 'scene.sog').replace(/\\/g, '/');
    return `${PACKED_CONTENT_DIR}/${base}`;
}

/**
 * lod-meta.json `filenames[]` 条目 → 包内路径 `content/<相对名>`。
 * 仅接受相对文件名；绝对 URL / blob: / data: 返回 null（沿用原引用或另用登记表还原）。
 * @param filename - meta 里的一项
 * @returns 包内路径，或 null
 */
export function lodChunkPackRelativePath(filename: string): string | null {
    if (typeof filename !== 'string' || !isRelativePackPath(filename)) return null;
    const normalized = normalizePackPath(filename.trim());
    if (!normalized) return null;
    return `${PACKED_CONTENT_DIR}/${normalized}`;
}

/**
 * 非相对 filenames（绝对 URL / blob: / data:）在包内可用的落盘 basename。
 * @param url - filenames 里的一项
 * @returns basename，或 null
 */
export function lodChunkBasenameFromUrl(url: string): string | null {
    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (!trimmed) return null;
    if (EPHEMERAL_URL_RE.test(trimmed)) return null;
    try {
        const base = decodeURIComponent(new URL(trimmed).pathname.split('/').pop() || '');
        return normalizePackPath(base) || null;
    } catch {
        return null;
    }
}

function isRelativePackPath(value: string): boolean {
    const s = value.trim();
    if (!s || s.startsWith('/') || s.startsWith('\\')) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
    return true;
}

export function readPackedContentPath(settings: unknown): string | undefined {
    if (!settings || typeof settings !== 'object') return undefined;
    const raw = (settings as { content?: unknown }).content;
    if (typeof raw !== 'string') return undefined;
    const trimmed = raw.trim();
    if (!isRelativePackPath(trimmed)) return undefined;
    return normalizePackPath(trimmed) || undefined;
}

function dirnamePath(path: string): string {
    const i = path.lastIndexOf('/');
    return i <= 0 ? '' : path.slice(0, i);
}

function relativizeToBase(path: string, baseDir: string): string | null {
    if (!baseDir) return path;
    const prefix = `${baseDir}/`;
    if (path === baseDir) return null;
    if (!path.startsWith(prefix)) return null;
    return path.slice(prefix.length);
}

/**
 * 在条目里找最浅的 settings.json，作为包根。
 * @param paths - 包内路径列表
 * @returns settings.json 的规范化路径
 */
export function findProjectSettingsPath(paths: string[]): string | undefined {
    const matches = paths.map(raw => normalizePackPath(raw)).filter((path): path is string => {
        if (!path) return false;
        const lower = path.toLowerCase();
        return lower === SETTINGS_JSON_NAME || lower.endsWith(`/${SETTINGS_JSON_NAME}`);
    });
    if (matches.length === 0) return undefined;
    matches.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    return matches[0];
}

export function guessPackedContentPath(files: Iterable<string>, settings?: unknown): string | undefined {
    const fromSettings = readPackedContentPath(settings);
    if (fromSettings) return fromSettings;
    const candidates: string[] = [];
    for (const raw of files) {
        const path = normalizePackPath(raw);
        if (!path || !isPackedSceneFilename(path)) continue;
        const dir = dirnamePath(path);
        if (dir === '' || dir === PACKED_CONTENT_DIR) {
            candidates.push(path);
        }
    }
    if (candidates.length === 1) return candidates[0];
    const preferred = candidates.find(p => p.startsWith(`${PACKED_CONTENT_DIR}/`));
    return preferred ?? candidates[0];
}

async function parseSettingsBlob(blob: Blob): Promise<unknown> {
    const text = await blob.text();
    const trimmed = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
    try {
        return JSON.parse(trimmed);
    } catch {
        throw new Error('settings.json 不是有效的 JSON');
    }
}

export async function parseProjectFileList(fileList: ArrayLike<File>): Promise<ParsedProjectPack> {
    const entries: Array<{ path: string; blob: Blob }> = [];
    for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        const rel = (file.webkitRelativePath || file.name).replace(/\\/g, '/');
        entries.push({ path: rel, blob: file });
    }
    return await parseProjectBlobs(entries);
}

export async function parseProjectBlobs(entries: Array<{ path: string; blob: Blob }>): Promise<ParsedProjectPack> {
    const normalized: Array<{ path: string; blob: Blob }> = [];
    for (const entry of entries) {
        const path = normalizePackPath(entry.path);
        if (!path) continue;
        normalized.push({ path, blob: entry.blob });
    }
    const settingsPath = findProjectSettingsPath(normalized.map(e => e.path));
    if (!settingsPath) {
        throw new Error('项目包中没有 settings.json');
    }
    const baseDir = dirnamePath(settingsPath);
    const files = new Map<string, Blob>();
    let settingsBlob: Blob | undefined;
    for (const entry of normalized) {
        const rel = relativizeToBase(entry.path, baseDir);
        if (!rel) continue;
        if (rel.toLowerCase() === SETTINGS_JSON_NAME) {
            settingsBlob = entry.blob;
            continue;
        }
        files.set(rel, entry.blob);
    }
    if (!settingsBlob) {
        throw new Error('项目包中没有 settings.json');
    }
    const settings = await parseSettingsBlob(settingsBlob);
    return { settings, files };
}

export async function parseProjectZipBytes(bytes: Uint8Array): Promise<ParsedProjectPack> {
    let unzipped: Record<string, Uint8Array>;
    try {
        unzipped = unzipSync(bytes);
    } catch {
        throw new Error('无法解压 zip');
    }
    const entries: Array<{ path: string; blob: Blob }> = [];
    for (const [rawPath, data] of Object.entries(unzipped)) {
        const path = normalizePackPath(rawPath);
        if (!path) continue;
        entries.push({ path, blob: new Blob([new Uint8Array(data)]) });
    }
    return await parseProjectBlobs(entries);
}
