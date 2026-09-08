// 用户上传文件：存盘写成相对 settings.json 的路径；会话表 relativePath→Blob；加载时解析。
// blob: / data: 不入库。绝对 http(s) URL 不改写、不打包。
import {
    canonicalizeSlashPath,
    extensionFromMime,
    normalizePackPath
} from './pack';
import {
    annotationDataToSettings,
    annotationMediaFromUnknown,
    annotationSlotsFromUrls,
    writeAnnotationMediaToSettingsRecord,
    type AnnotationMediaFields
} from '../annotation-toolbar/media-fields';
import type { AnnotationData } from '../annotation-toolbar/types';
import { asUserFile, fetchFileFromUrl, isEphemeralAssetUrl, userUploadBasename } from '../loaders/asset-file';
import type { Annotation as SettingsAnnotation, Camera, ExperienceSettings } from '../schemas/v2';
import type { SceneAsset } from '../schemas/v2-custom';
import type { AssetLibraryItem, Global, ScenePlacedItem } from '../types';
import { fetchLatestProjectFiles, setUniverseAuthContext } from '../universe/service';

export type UserUploadPathContext = {
    usedPaths: Set<string>;
    pathByKey: Map<string, string>;
};

const objectUrlsByGlobal = new WeakMap<Global, Map<string, string>>();
const pathCtxByGlobal = new WeakMap<Global, UserUploadPathContext>();

export function createUserUploadPathContext(): UserUploadPathContext {
    return { usedPaths: new Set(), pathByKey: new Map() };
}

function pathContextFor(global: Global): UserUploadPathContext {
    let ctx = pathCtxByGlobal.get(global);
    if (!ctx) {
        ctx = createUserUploadPathContext();
        pathCtxByGlobal.set(global, ctx);
    }
    for (const key of ensureUserUploadFiles(global).keys()) {
        ctx.usedPaths.add(key);
    }
    return ctx;
}

/**
 * 无 scheme、非站点根路径：视为相对 settings.json 的用户文件路径。
 * @param value
 */
export function isUserUploadRelativePath(value: string | undefined | null): value is string {
    if (typeof value !== 'string') return false;
    const s = value.trim();
    if (!s) return false;
    if (s.startsWith('/') || s.startsWith('\\')) return false;
    if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return false;
    return true;
}

/**
 * 含目录的相对路径（如 `assets/foo.glb`）；纯 basename 不算打包路径。
 * @param value
 */
export function isPackedUserUploadPath(value: string | undefined | null): boolean {
    if (typeof value !== 'string' || !isUserUploadRelativePath(value)) return false;
    return canonicalizeSlashPath(value).includes('/');
}

export function normalizeUserUploadRelativePath(value: string): string {
    return normalizePackPath(value) ?? canonicalizeSlashPath(value);
}

export function relativeUserUploadPath(
    file: File,
    assetId: string | undefined,
    ctx: UserUploadPathContext,
    fallbackName?: string
): string {
    let key = `${file.name}:${file.size}:${file.lastModified}`;
    if (typeof assetId === 'string' && assetId.trim().length > 0) {
        key = assetId.trim();
    }
    const cached = ctx.pathByKey.get(key);
    if (cached) return cached;

    const basename = userUploadBasename(file, fallbackName);
    let path = `assets/${basename}`;
    if (ctx.usedPaths.has(path)) {
        const prefix = (typeof assetId === 'string' && assetId.trim().length > 0) ? assetId.trim() : 'asset';
        path = `assets/${prefix}-${basename}`;
    }
    let n = 2;
    const stem = path;
    while (ctx.usedPaths.has(path)) {
        const dot = stem.lastIndexOf('.');
        const slash = stem.lastIndexOf('/');
        if (dot > slash) {
            path = `${stem.slice(0, dot)}-${n}${stem.slice(dot)}`;
        } else {
            path = `${stem}-${n}`;
        }
        n += 1;
    }
    ctx.usedPaths.add(path);
    ctx.pathByKey.set(key, path);
    return path;
}

function fileFromSessionTable(global: Global, value: string | undefined): File | null {
    if (!isUserUploadRelativePath(value)) return null;
    const path = normalizeUserUploadRelativePath(value);
    const blob = global.userUploadFiles?.get(path);
    if (!blob) return null;
    const base = path.split('/').pop() || 'asset';
    return fileFromBlob(blob, base);
}

export function fileForPlacedEntry(global: Global, entry: ScenePlacedItem): File | null {
    const direct = asUserFile(entry.file);
    if (direct) return direct;
    const assetId = typeof entry.assetId === 'string' ? entry.assetId.trim() : '';
    if (!assetId) return null;
    const lib = global.state.uploadedAssets?.find(a => a.id === assetId);
    return asUserFile(lib?.src) ?? fileFromSessionTable(global, typeof lib?.src === 'string' ? lib.src : entry.url);
}

export function persistScenePlacedItemSource(
    global: Global,
    entry: ScenePlacedItem,
    sa: SceneAsset,
    pathCtx: UserUploadPathContext
): SceneAsset {
    const file = fileForPlacedEntry(global, entry);
    const next: SceneAsset = {
        ...sa,
        source: { ...sa.source }
    };
    if (file) {
        const rel = relativeUserUploadPath(file, entry.assetId, pathCtx, entry.filename);
        next.source.url = rel;
        next.source.filename = userUploadBasename(file, entry.filename);
    } else if (isEphemeralAssetUrl(next.source.url) || isEphemeralAssetUrl(entry.url)) {
        delete next.source.url;
        if (isEphemeralAssetUrl(next.source.filename)) {
            delete next.source.filename;
        }
    }
    if (isEphemeralAssetUrl(next.thumbnailUrl)) {
        delete next.thumbnailUrl;
    }
    return next;
}

export function ensureUserUploadFiles(global: Global): Map<string, Blob> {
    if (!global.userUploadFiles) {
        global.userUploadFiles = new Map();
    }
    return global.userUploadFiles;
}

export function rememberUserUploadFile(global: Global, relativePath: string, blob: Blob): void {
    const path = normalizeUserUploadRelativePath(relativePath);
    const files = ensureUserUploadFiles(global);
    const prev = files.get(path);
    if (prev && prev !== blob) {
        const urls = objectUrlsByGlobal.get(global);
        const oldUrl = urls?.get(path);
        if (oldUrl && urls) {
            URL.revokeObjectURL(oldUrl);
            urls.delete(path);
        }
    }
    files.set(path, blob);
}

function objectUrlForRelativePath(global: Global, relativePath: string): string | null {
    const path = normalizeUserUploadRelativePath(relativePath);
    const blob = global.userUploadFiles?.get(path);
    if (!blob) return null;
    let urls = objectUrlsByGlobal.get(global);
    if (!urls) {
        urls = new Map();
        objectUrlsByGlobal.set(global, urls);
    }
    const existing = urls.get(path);
    if (existing) return existing;
    const url = URL.createObjectURL(blob);
    urls.set(path, url);
    return url;
}

function isLocalDevelopment(): boolean {
    const hostname = window.location.hostname;
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0';
}

function getLocalDevProxyBase(): string {
    const params = new URLSearchParams(window.location.search);
    const proxyServer = params.get('proxyServer');
    if (proxyServer) {
        return `${proxyServer.replace(/\/$/, '')}/api/proxy?url=`;
    }
    const proxyPort = params.get('proxyPort') || '3001';
    return `http://localhost:${proxyPort}/api/proxy?url=`;
}

/**
 * 拉用户文件字节：同源直连；本地跨域走 /api/proxy；unicity-cdn 生产走 /proxy/cdn。
 * @param url
 */
export function toUserUploadFetchUrl(url: string): string {
    let abs: URL;
    try {
        abs = new URL(url, location.href);
    } catch {
        return url;
    }
    if (abs.origin === location.origin) return abs.href;
    if (abs.hostname === 'unicity-cdn.bdnrc.org.cn') {
        if (isLocalDevelopment()) {
            return `${getLocalDevProxyBase()}${encodeURIComponent(abs.href)}`;
        }
        return `/proxy/cdn${abs.pathname}${abs.search}`;
    }
    if (isLocalDevelopment() && (abs.protocol === 'http:' || abs.protocol === 'https:')) {
        if (abs.href.includes('/api/proxy?url=')) return abs.href;
        return `${getLocalDevProxyBase()}${encodeURIComponent(abs.href)}`;
    }
    return abs.href;
}

export function unwrapSettingsFetchUrl(url: string): string {
    try {
        const u = new URL(url, typeof location !== 'undefined' ? location.href : undefined);
        const inner = u.searchParams.get('url');
        if (inner && (u.pathname === '/api/proxy' || u.pathname.endsWith('/api/proxy'))) {
            return inner;
        }
        if (u.pathname.startsWith('/proxy/cdn/')) {
            return `https://unicity-cdn.bdnrc.org.cn${u.pathname.slice('/proxy/cdn'.length)}${u.search}`;
        }
        return u.href;
    } catch {
        return url;
    }
}

/**
 * settings.json 的文件 URL 才能当相对路径基址；Viewer 页面本身不行。
 * @param url
 */
export function isUsableSettingsFileUrl(url: string | undefined | null): boolean {
    if (typeof url !== 'string' || !url.trim()) return false;
    try {
        const u = new URL(unwrapSettingsFetchUrl(url.trim()), location.href);
        const path = u.pathname.toLowerCase();
        if (!path.endsWith('.json')) return false;
        if (u.origin === location.origin && (path === '/' || path === '/index.html')) {
            return false;
        }
        return true;
    } catch {
        return false;
    }
}

export function resolveAgainstSettingsUrl(settingsUrl: string | undefined, rel: string): string | null {
    if (!isUsableSettingsFileUrl(settingsUrl)) return null;
    try {
        return new URL(rel, unwrapSettingsFetchUrl(settingsUrl as string)).href;
    } catch {
        return null;
    }
}

/**
 * 加载用 URL：相对路径优先会话表 object URL，否则相对 settings.json 所在目录。
 * 不把 blob: 写回 settings。相对路径解析失败返回 null（不要再相对 Viewer 页面去拼）。
 * @param global
 * @param value
 */
export function resolveUserUploadResourceUrl(
    global: Global,
    value: string | undefined | null
): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    if (!trimmed) return null;
    if (isEphemeralAssetUrl(trimmed)) return trimmed;
    if (!isUserUploadRelativePath(trimmed)) return toUserUploadFetchUrl(trimmed);
    const path = normalizeUserUploadRelativePath(trimmed);
    const fromTable = objectUrlForRelativePath(global, path);
    if (fromTable) return fromTable;
    const href = resolveAgainstSettingsUrl(global.config.settingsUrl, path);
    return href ? toUserUploadFetchUrl(href) : null;
}

/**
 * 缺基址时从 ?settings= 或项目版本列表补上 settings.json 的文件 URL。
 * @param global
 */
export async function ensureSettingsFileUrl(global: Global): Promise<void> {
    const needed = collectUserUploadRelativePaths(global.settings);
    if (needed.length === 0) return;
    const missing = needed.filter(p => !global.userUploadFiles?.has(normalizeUserUploadRelativePath(p)));
    if (missing.length === 0) return;
    if (isUsableSettingsFileUrl(global.config.settingsUrl)) return;

    const fromQuery = new URLSearchParams(location.search).get('settings')?.trim() || '';
    if (fromQuery && isUsableSettingsFileUrl(fromQuery)) {
        try {
            global.config.settingsUrl = new URL(fromQuery, location.href).href;
        } catch {
            global.config.settingsUrl = fromQuery;
        }
        return;
    }

    const projectId = global.config.projectId;
    const token = global.config.token;
    if (projectId == null || projectId === '' || !token) return;

    try {
        setUniverseAuthContext({ token });
        const files = await fetchLatestProjectFiles(projectId);
        const entry = files.find((f) => {
            const base = (f.fileName || '').replace(/\\/g, '/').split('/').pop()?.toLowerCase() ?? '';
            return base === 'settings.json';
        });
        if (entry?.fileUrl?.trim()) {
            global.config.settingsUrl = entry.fileUrl.trim();
        }
    } catch {
        // 基址补齐失败时保持原值，相对路径加载会跳过而不是打到 Viewer 源站
    }
}

function fileFromBlob(blob: Blob, fallbackName: string): File {
    if (blob instanceof File && blob.name) return blob;
    const extMatch = fallbackName.match(/\.[a-z0-9]+$/i);
    const ext = extMatch ? extMatch[0] : extensionFromMime(blob.type, '.bin');
    const stem = fallbackName.replace(/\.[a-z0-9]+$/i, '') || 'asset';
    const name = `${stem}${ext.startsWith('.') ? ext : `.${ext}`}`;
    return new File([blob], name, { type: blob.type || 'application/octet-stream' });
}

async function blobFromUrl(url: string): Promise<Blob | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        return await res.blob();
    } catch {
        return null;
    }
}

/**
 * 把用户 File 写入会话表，返回相对 settings.json 的路径（如 `assets/foo.hdr`）。
 * @param global
 * @param file
 * @param opts
 * @param opts.id
 * @param opts.fallbackName
 */
export function ingestUserUploadFile(
    global: Global,
    file: File,
    opts?: { id?: string; fallbackName?: string }
): string {
    const ctx = pathContextFor(global);
    const path = relativeUserUploadPath(file, opts?.id, ctx, opts?.fallbackName);
    rememberUserUploadFile(global, path, file);
    return path;
}

/**
 * AssetLibraryItem.src 为 File 时入库，并把 src 改成相对路径。
 * @param global
 * @param item
 */
export function ingestAssetLibraryItemFile(global: Global, item: AssetLibraryItem): AssetLibraryItem {
    const file = asUserFile(item.src);
    if (!file) return item;
    const src = ingestUserUploadFile(global, file, {
        id: item.id,
        fallbackName: item.filename || item.name
    });
    return { ...item, src };
}

/**
 * 协议 `value`：File 或 URL 字符串（空串视为清除）。
 * @param value
 */
export function splitInboundUrlOrFile(value: unknown): { url?: string | null; file?: File } {
    const file = asUserFile(value);
    if (file) return { file };
    if (typeof value === 'string') return { url: value };
    return { url: null };
}

/**
 * 协议入站：有 File 则入库并返回相对路径；blob:/data: 尝试取回字节后再入库；
 * http(s) 或已是相对路径则原样返回。空则 undefined。
 * @param global
 * @param input
 * @param input.file
 * @param input.url
 * @param opts
 * @param opts.id
 * @param opts.fallbackName
 */
export async function resolveInboundUserFileUrl(
    global: Global,
    input: { file?: unknown; url?: string | null },
    opts: { id?: string; fallbackName: string }
): Promise<string | undefined> {
    let file = asUserFile(input.file);
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!file && url && isEphemeralAssetUrl(url)) {
        file = await fetchFileFromUrl(url, opts.fallbackName);
        if (!file) {
            const blob = await blobFromUrl(url);
            if (blob) file = fileFromBlob(blob, opts.fallbackName);
        }
    }
    if (file) {
        return ingestUserUploadFile(global, file, opts);
    }
    return url || undefined;
}

export async function resolveAnnotationMediaInput(
    global: Global,
    value: {
        image?: unknown;
        video?: unknown;
    } | undefined,
    annotationId?: string
): Promise<{ image?: string; video?: string }> {
    if (!value) return {};
    const id = typeof annotationId === 'string' && annotationId.trim() ? annotationId.trim() : undefined;
    const videoUrl = await resolveInboundUserFileUrl(
        global,
        splitInboundUrlOrFile(value.video),
        { id, fallbackName: `annotation-${id ?? 'video'}.mp4` }
    );
    const imageUrl = await resolveInboundUserFileUrl(
        global,
        splitInboundUrlOrFile(value.image),
        { id, fallbackName: `annotation-${id ?? 'image'}.png` }
    );
    if (videoUrl) return { video: videoUrl };
    if (imageUrl) return { image: imageUrl };
    return {};
}

/**
 * 标注图片/视频：File 入库会话表并改成相对路径；已是字符串则保留。
 * @param global - Viewer 全局态
 * @param data - 运行态 image/video 槽
 * @param data.image - 图片 URL 或 File
 * @param annotationId - 标注 id，用于相对路径去重
 * @param data.video - 视频 URL 或 File
 * @returns settings 用的 imageUrl/videoUrl
 */
export function persistAnnotationMedia(
    global: Global,
    data: { image?: unknown; video?: unknown },
    annotationId?: string
): AnnotationMediaFields {
    const id = typeof annotationId === 'string' && annotationId.trim() ? annotationId.trim() : undefined;
    const videoFile = asUserFile(data.video);
    const imageFile = asUserFile(data.image);
    let videoUrl: string | undefined;
    let imageUrl: string | undefined;
    if (videoFile) {
        videoUrl = ingestUserUploadFile(global, videoFile, {
            id,
            fallbackName: `annotation-${id ?? 'video'}.mp4`
        });
    } else if (typeof data.video === 'string') {
        videoUrl = data.video.trim() || undefined;
    }
    if (!videoUrl) {
        if (imageFile) {
            imageUrl = ingestUserUploadFile(global, imageFile, {
                id,
                fallbackName: `annotation-${id ?? 'image'}.png`
            });
        } else if (typeof data.image === 'string') {
            imageUrl = data.image.trim() || undefined;
        }
    }
    return annotationMediaFromUnknown({ imageUrl, videoUrl });
}

/**
 * 把运行态标注写成 settings.annotations 条目（imageUrl/videoUrl + 会话表字节）。
 * @param global - Viewer 全局态
 * @param annotation - 运行态标注
 * @param annotation.id - 标注 id
 * @param annotation.serialize - 运行态序列化
 * @param annotation.settingsExtras - settings extras
 * @param annotation.settingsCamera - 观察机位
 * @returns settings 标注
 */
export function annotationEntityToSettings(
    global: Global,
    annotation: {
        id: string;
        serialize: () => AnnotationData;
        settingsExtras?: SettingsAnnotation['extras'];
        settingsCamera?: Camera;
    }
): SettingsAnnotation {
    const data = annotation.serialize();
    const media = persistAnnotationMedia(global, data, annotation.id);
    return annotationDataToSettings(
        { ...data, ...annotationSlotsFromUrls(media) },
        { extras: annotation.settingsExtras, camera: annotation.settingsCamera }
    );
}

async function fetchBlobFromSettingsBase(global: Global, path: string): Promise<Blob | null> {
    const href = resolveAgainstSettingsUrl(global.config.settingsUrl, path);
    if (!href) return null;
    try {
        const res = await fetch(toUserUploadFetchUrl(href));
        if (!res.ok) return null;
        return await res.blob();
    } catch {
        return null;
    }
}

function fileForSerializedSceneAsset(global: Global, sa: SceneAsset): File | null {
    const id = typeof sa.id === 'string' ? sa.id.trim() : '';
    if (id) {
        const entry = global.state.scenePlacedEntities?.find(e => e.id === id);
        if (entry) {
            const fromEntry = fileForPlacedEntry(global, entry);
            if (fromEntry) return fromEntry;
        }
    }
    const assetId = typeof sa.source?.assetId === 'string' ? sa.source.assetId.trim() : '';
    if (!assetId) return null;
    const lib = global.state.uploadedAssets?.find(a => a.id === assetId);
    return asUserFile(lib?.src) ??
        fileFromSessionTable(global, typeof lib?.src === 'string' ? lib.src : sa.source?.url);
}

function collectExistingRelativePaths(settings: ExperienceSettings, used: Set<string>): void {
    const add = (value: string | undefined) => {
        if (!isUserUploadRelativePath(value)) return;
        used.add(normalizeUserUploadRelativePath(value));
    };
    for (const sa of settings.sceneAssets ?? []) {
        add(sa?.source?.url);
        if (isPackedUserUploadPath(sa?.source?.filename)) add(sa.source?.filename);
        if (isUserUploadRelativePath(sa?.thumbnailUrl)) add(sa.thumbnailUrl);
    }
    const skybox = settings.background?.skybox;
    add(skybox?.currentUrl);
    for (const url of skybox?.uploadUrls ?? []) add(url);
    for (const ann of settings.annotations ?? []) {
        const media = annotationMediaFromUnknown(ann);
        add(media.imageUrl);
        add(media.videoUrl);
    }
    add(settings.soundUrl);
    add(settings.collision?.url);
}

/**
 * 物化后 settings 中需要随包附带的相对路径（去重）。
 * @param settings
 */
export function collectUserUploadRelativePaths(settings: ExperienceSettings): string[] {
    const used = new Set<string>();
    collectExistingRelativePaths(settings, used);
    return [...used];
}

export type SettingsResourceReference = {
    path: string;
    field: string;
};

/**
 * settings 字段路径 ↔ 相对资源路径，供 host 保存把文件交回外层。
 * @param settings - 物化后的 ExperienceSettings
 * @returns 路径与字段对应关系（可重复 path）
 */
export function collectSettingsResourceReferences(settings: ExperienceSettings): SettingsResourceReference[] {
    const refs: SettingsResourceReference[] = [];
    const add = (field: string, value: string | undefined) => {
        if (!isUserUploadRelativePath(value)) return;
        refs.push({ path: normalizeUserUploadRelativePath(value), field });
    };
    (settings.sceneAssets ?? []).forEach((sa, i) => {
        add(`sceneAssets[${i}].source.url`, sa?.source?.url);
        if (isPackedUserUploadPath(sa?.source?.filename)) {
            add(`sceneAssets[${i}].source.filename`, sa.source?.filename);
        }
        add(`sceneAssets[${i}].thumbnailUrl`, sa?.thumbnailUrl);
    });
    add('background.skybox.currentUrl', settings.background?.skybox?.currentUrl);
    (settings.background?.skybox?.uploadUrls ?? []).forEach((url, i) => {
        add(`background.skybox.uploadUrls[${i}]`, url);
    });
    (settings.annotations ?? []).forEach((ann, i) => {
        const media = annotationMediaFromUnknown(ann);
        add(`annotations[${i}].imageUrl`, media.imageUrl);
        add(`annotations[${i}].videoUrl`, media.videoUrl);
    });
    add('soundUrl', settings.soundUrl);
    add('collision.url', settings.collision?.url);
    add('content', settings.content);
    return refs;
}

function seedTableFromRuntimeFiles(
    global: Global,
    settings: ExperienceSettings
): void {
    for (const sa of settings.sceneAssets ?? []) {
        const url = sa?.source?.url;
        if (typeof url !== 'string' || !isUserUploadRelativePath(url)) continue;
        const file = fileForSerializedSceneAsset(global, sa);
        if (!file) continue;
        rememberUserUploadFile(global, url, file);
    }
}

type MaterializeOneResult =
    | { ok: true; value: string | undefined }
    | { ok: false; message: string };

async function materializeOne(
    global: Global,
    value: string | undefined,
    ctx: UserUploadPathContext,
    opts: { id?: string; fallbackName: string; relativeOnly?: boolean }
): Promise<MaterializeOneResult> {
    if (typeof value !== 'string') return { ok: true, value };
    const trimmed = value.trim();
    if (!trimmed) return { ok: true, value: undefined };

    if (isUserUploadRelativePath(trimmed)) {
        const path = normalizeUserUploadRelativePath(trimmed);
        const existing = global.userUploadFiles?.get(path);
        const blob = existing ?? await fetchBlobFromSettingsBase(global, path);
        if (!blob) {
            return { ok: false, message: `无法读取用户上传文件: ${path}` };
        }
        rememberUserUploadFile(global, path, blob);
        ctx.usedPaths.add(path);
        return { ok: true, value: path };
    }

    if (opts.relativeOnly) {
        return { ok: true, value: trimmed };
    }

    if (isEphemeralAssetUrl(trimmed)) {
        const blob = await blobFromUrl(trimmed);
        if (!blob) {
            return { ok: false, message: `无法读取用户上传文件: ${opts.fallbackName}` };
        }
        const file = fileFromBlob(blob, opts.fallbackName);
        const path = relativeUserUploadPath(file, opts.id, ctx, opts.fallbackName);
        rememberUserUploadFile(global, path, file);
        return { ok: true, value: path };
    }

    return { ok: true, value: trimmed };
}

async function assignMaterialized(
    global: Global,
    holder: Record<string, unknown>,
    key: string,
    ctx: UserUploadPathContext,
    opts: { id?: string; fallbackName: string; relativeOnly?: boolean }
): Promise<string | null> {
    const current = holder[key];
    const result = await materializeOne(
        global,
        typeof current === 'string' ? current : undefined,
        ctx,
        opts
    );
    if (result.ok === false) return result.message;
    if (result.value === undefined) {
        delete holder[key];
    } else {
        holder[key] = result.value;
    }
    return null;
}

/**
 * 序列化之后：把用户上传改写成相对路径，并填满会话表 relativePath→Blob。
 * 已是相对路径的从会话表或 settingsUrl 基址取回字节；失败则整次保存失败。
 * @param global
 * @param settings
 */
export async function materializeUserUploadRelativeFiles(
    global: Global,
    settings: ExperienceSettings
): Promise<{ ok: true; settings: ExperienceSettings } | { ok: false; message: string }> {
    const ctx = createUserUploadPathContext();
    collectExistingRelativePaths(settings, ctx.usedPaths);
    seedTableFromRuntimeFiles(global, settings);

    const sceneAssets = settings.sceneAssets ?? [];
    for (const sa of sceneAssets) {
        if (!sa || typeof sa !== 'object') continue;
        if (!sa.source || typeof sa.source !== 'object') sa.source = {};
        const src = sa.source as Record<string, unknown>;
        const id = typeof sa.id === 'string' ? sa.id : typeof sa.source.assetId === 'string' ? sa.source.assetId : undefined;
        const fallbackName = (typeof sa.source.filename === 'string' && sa.source.filename) || sa.name || 'asset';
        const urlErr = await assignMaterialized(global, src, 'url', ctx, { id, fallbackName });
        if (urlErr) return { ok: false, message: urlErr };
        if (isPackedUserUploadPath(typeof src.filename === 'string' ? src.filename : undefined)) {
            const fnErr = await assignMaterialized(global, src, 'filename', ctx, {
                id,
                fallbackName,
                relativeOnly: true
            });
            if (fnErr) return { ok: false, message: fnErr };
        }
        const thumbErr = await assignMaterialized(global, sa as unknown as Record<string, unknown>, 'thumbnailUrl', ctx, {
            id,
            fallbackName: 'thumbnail',
            relativeOnly: true
        });
        if (thumbErr) return { ok: false, message: thumbErr };
    }

    const skybox = settings.background?.skybox as Record<string, unknown> | undefined;
    if (skybox && typeof skybox === 'object') {
        const skyErr = await assignMaterialized(global, skybox, 'currentUrl', ctx, { fallbackName: 'skybox' });
        if (skyErr) return { ok: false, message: skyErr };
        const uploads = Array.isArray(skybox.uploadUrls) ? skybox.uploadUrls : [];
        const nextUploads: string[] = [];
        for (let i = 0; i < uploads.length; i++) {
            const raw = uploads[i];
            const result = await materializeOne(
                global,
                typeof raw === 'string' ? raw : undefined,
                ctx,
                { fallbackName: `skybox-${i + 1}` }
            );
            if (result.ok === false) return { ok: false, message: result.message };
            if (result.value) nextUploads.push(result.value);
        }
        if (nextUploads.length > 0) {
            skybox.uploadUrls = nextUploads;
        } else {
            delete skybox.uploadUrls;
        }
    }

    const annotations = settings.annotations ?? [];
    for (const ann of annotations) {
        if (!ann || typeof ann !== 'object') continue;
        const rec = ann as unknown as Record<string, unknown>;
        writeAnnotationMediaToSettingsRecord(rec);
        const id = typeof ann.id === 'string' ? ann.id : undefined;
        const imgErr = await assignMaterialized(global, rec, 'imageUrl', ctx, {
            id,
            fallbackName: `annotation-${id ?? 'image'}.png`
        });
        if (imgErr) return { ok: false, message: imgErr };
        const vidErr = await assignMaterialized(global, rec, 'videoUrl', ctx, {
            id,
            fallbackName: `annotation-${id ?? 'video'}.mp4`
        });
        if (vidErr) return { ok: false, message: vidErr };
    }

    const soundErr = await assignMaterialized(
        global,
        settings as unknown as Record<string, unknown>,
        'soundUrl',
        ctx,
        { fallbackName: 'sound.mp3' }
    );
    if (soundErr) return { ok: false, message: soundErr };

    const collision = settings.collision as Record<string, unknown> | undefined;
    if (collision && typeof collision === 'object') {
        const collisionErr = await assignMaterialized(global, collision, 'url', ctx, {
            id: 'scene-collision',
            fallbackName: 'collision.glb'
        });
        if (collisionErr) return { ok: false, message: collisionErr };
    }

    return { ok: true, settings };
}
