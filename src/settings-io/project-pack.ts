// 本地项目包：settings.json + content/<场景文件> + assets/。
// 普通加载：URL ?content= 优先于包内主场景。导入刷新：pending 包内 content/ 优先。
// LOD：content/lod-meta.json + content/<分块文件>（meta 的 filenames 保持相对 meta 解析）。
import { contentFilenameFromUrl } from '../loaders/gsplat/content-filename';
import { isLodMetaFile } from '../loaders/gsplat/lod/custom-loader';
import { ViewerLoadError } from './host-protocol';
import { normalizePackPath } from './pack';
import type { Config, Global } from '../types';
import {
    LOD_META_FILENAME,
    PACKED_CONTENT_DIR,
    guessPackedContentPath,
    hasExplicitContentQueryParam,
    isLodMetaFilename,
    isPackedContentFilename,
    isPackedSceneFilename,
    lodChunkBasenameFromUrl,
    lodChunkPackRelativePath,
    packedContentRelativePath
} from './project-pack-parse';
import {
    normalizeUserUploadRelativePath,
    resolveAgainstSettingsUrl,
    toUserUploadFetchUrl
} from './user-files';
import type { ExperienceSettings } from '../schemas/v2';

export {
    LOD_META_FILENAME,
    PACKED_CONTENT_DIR,
    findProjectSettingsPath,
    guessPackedContentPath,
    hasExplicitContentQueryParam,
    isLodMetaFilename,
    isPackedContentFilename,
    isPackedSceneFilename,
    lodChunkBasenameFromUrl,
    lodChunkPackRelativePath,
    packedContentRelativePath,
    parseProjectBlobs,
    parseProjectFileList,
    readPackedContentPath,
    type ParsedProjectPack
} from './project-pack-parse';

export type ProjectPackFile = {
    path: string;
    blob: Blob;
};

export type PackedSceneSource = {
    contentUrl: string;
    contents: Promise<Response>;
};

export type PackedMainScene = {
    /** 写入 `settings.content` 的包内路径，如 `content/lod-meta.json` */
    relativePath: string;
    /** 主场景本体；LOD 为（必要时重写过的）lod-meta.json */
    blob: Blob;
    /** 需要一并放入包内的附属文件；LOD 为各分块 */
    extraFiles: ProjectPackFile[];
};

export type PackMainSceneResult =
    | ({ ok: true } & PackedMainScene)
    | { ok: false; message: string; cancelled?: boolean };

/** 取消保存时的统一文案 */
export const SAVE_CANCELLED_MESSAGE = '已取消保存';

/** 项目保存进度阶段 */
export type ProjectSavePhase = 'mainScene' | 'lodContent' | 'packing' | 'uploading';

export type ProjectSaveProgress = {
    phase: ProjectSavePhase;
    /** 可直接展示的一句话（含已完成/总数/体积） */
    message: string;
    /** 分块下载：已完成 / 总数 */
    done?: number;
    total?: number;
    /** 分块下载：累计字节 */
    bytes?: number;
};

export type ProjectSaveProgressReporter = (progress: ProjectSaveProgress) => void;

// 包内 lod-meta 注入时 filenames 会改写成 blob URL；记录原始相对名，便于再次保存还原。
const lodMetaOriginalFilenames = new Map<string, string[]>();

const LOD_CHUNK_FETCH_CONCURRENCY = 4;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/**
 * 人类可读字节数。
 * @param bytes - 字节数
 * @returns 例如 `1.2 GB`
 */
export function formatByteSize(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    let value = bytes;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value.toFixed(unit === 0 || value >= 100 ? 0 : 1)} ${units[unit]}`;
}

/**
 * 主场景在项目包内的相对路径（只按启动 `config.contentUrl` 推导，不下载任何字节）。
 * 与打包时写入的路径一致，供「只保存 settings.json」写 `content` 字段用。
 * @param contentUrl - `config.contentUrl`
 * @returns `content/<场景文件>` / `content/lod-meta.json`；无法推导时为 null
 */
export function resolvePackedContentRelativePath(contentUrl: string | undefined): string | null {
    const url = typeof contentUrl === 'string' ? contentUrl.trim() : '';
    if (!url) return null;
    if (isLodMetaFile(url)) return `${PACKED_CONTENT_DIR}/${LOD_META_FILENAME}`;
    const filename = contentFilenameFromUrl(url);
    if (!isPackedSceneFilename(filename)) return null;
    return packedContentRelativePath(filename);
}

/**
 * 把当前主场景打成项目包内容。
 * `.sog` / `.splat` / `.ply` 单文件；`lod-meta.json` 会连同 filenames 列出的分块一起打包。
 * @param global - Viewer 全局态
 * @param onProgress - 进度回调（分块下载逐项上报）
 * @param signal - 取消信号（中止分块 / 主场景下载）
 * @returns 主场景相对路径 + 字节；失败返回文案，取消时 `cancelled: true`
 */
export async function packMainSceneContent(
    global: Global,
    onProgress?: ProjectSaveProgressReporter,
    signal?: AbortSignal
): Promise<PackMainSceneResult> {
    const contentUrl = typeof global.config.contentUrl === 'string' ? global.config.contentUrl.trim() : '';
    if (!contentUrl) {
        return { ok: false, message: '缺少主场景 content，无法写入项目包' };
    }
    if (signal?.aborted) {
        return { ok: false, cancelled: true, message: SAVE_CANCELLED_MESSAGE };
    }
    if (isLodMetaFile(contentUrl)) {
        return await packLodMetaContent(contentUrl, onProgress, signal);
    }
    const relativePath = resolvePackedContentRelativePath(contentUrl);
    if (!relativePath) {
        return { ok: false, message: '主场景不是可打包的 .sog / .splat / .ply / lod-meta.json' };
    }
    const filename = contentFilenameFromUrl(contentUrl);
    onProgress?.({ phase: 'mainScene', message: `正在下载主场景 ${filename}…` });
    try {
        const response = await fetch(toUserUploadFetchUrl(contentUrl), { signal });
        if (!response.ok) {
            return { ok: false, message: `下载主场景失败，状态码: ${response.status}` };
        }
        const blob = await response.blob();
        if (blob.size <= 0) {
            return { ok: false, message: '主场景文件为空' };
        }
        onProgress?.({
            phase: 'mainScene',
            message: `主场景已就绪 ${filename}（${formatByteSize(blob.size)}）`,
            bytes: blob.size
        });
        return { ok: true, relativePath, blob, extraFiles: [] };
    } catch (error) {
        if (signal?.aborted) {
            return { ok: false, cancelled: true, message: SAVE_CANCELLED_MESSAGE };
        }
        return { ok: false, message: `下载主场景失败: ${errorMessage(error)}` };
    }
}

type LodChunkPlan = {
    index: number;
    raw: string;
    fetchUrl: string;
    packPath: string;
    /** 拉取失败时是否保留原引用继续（绝对 URL 为 true；包内相对路径为 false） */
    optional: boolean;
};

function readLodMetaFilenames(meta: unknown): string[] | null {
    if (!meta || typeof meta !== 'object') return null;
    const raw = (meta as { filenames?: unknown }).filenames;
    if (!Array.isArray(raw)) return null;
    return raw.map(value => (typeof value === 'string' ? value.trim() : ''));
}

/**
 * 相对 filenames 按 meta 自身 URL 解析；meta 是 blob/data 时无法解析相对路径。
 * @param metaUrl - lod-meta.json 自身 URL
 * @param raw - filenames 里的一项
 * @returns 可抓取的绝对 URL，或 null
 */
function resolveLodChunkFetchUrl(metaUrl: string, raw: string): string | null {
    try {
        const baseHref = typeof location !== 'undefined' ? location.href : 'http://localhost/';
        const base = new URL(metaUrl, baseHref);
        if (base.protocol === 'blob:' || base.protocol === 'data:') return null;
        return new URL(raw, base).href;
    } catch {
        return null;
    }
}

/**
 * 取分块字节；blob:/data: 直接读，其余走代理判定。
 * @param url - 分块 URL
 * @param signal - 取消信号
 * @returns 非空 Blob，或 null（含被取消）
 */
async function fetchLodChunkBlob(url: string, signal?: AbortSignal): Promise<Blob | null> {
    try {
        const target = /^(?:blob|data):/i.test(url) ? url : toUserUploadFetchUrl(url);
        const response = await fetch(target, signal ? { signal } : undefined);
        if (!response.ok) return null;
        const blob = await response.blob();
        return blob.size > 0 ? blob : null;
    } catch {
        return null;
    }
}

/**
 * 分批并发执行，避免同时发起过多分块请求。
 * @param items - 待执行项
 * @param batchSize - 每批并发数
 * @param run - 单项执行函数
 * @returns 全部完成
 */
async function runLimitedBatch<T>(
    items: T[],
    batchSize: number,
    run: (item: T) => Promise<void>
): Promise<void> {
    if (items.length === 0) return;
    const size = Math.max(1, batchSize);
    await Promise.all(items.slice(0, size).map(run));
    await runLimitedBatch(items.slice(size), size, run);
}

/**
 * 包内名去重：撞名时加 `-2`、`-3` 后缀。
 * @param candidate - 期望的包内路径
 * @param used - 已占用路径集合（就地更新）
 * @returns 未占用的包内路径
 */
function uniquePackPath(candidate: string, used: Set<string>): string {
    if (!used.has(candidate)) {
        used.add(candidate);
        return candidate;
    }
    const slash = candidate.lastIndexOf('/');
    const dir = slash >= 0 ? candidate.slice(0, slash + 1) : '';
    const file = slash >= 0 ? candidate.slice(slash + 1) : candidate;
    const dot = file.lastIndexOf('.');
    const stem = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '';
    let n = 2;
    let next = `${dir}${stem}-${n}${ext}`;
    while (used.has(next)) {
        n += 1;
        next = `${dir}${stem}-${n}${ext}`;
    }
    used.add(next);
    return next;
}

/**
 * 打包 LOD 主场景：lod-meta.json + filenames 列出的分块。
 * @param contentUrl - lod-meta.json URL
 * @param onProgress - 进度回调
 * @param signal - 取消信号
 * @returns 主场景结果（取消时 `cancelled: true`）
 */
async function packLodMetaContent(
    contentUrl: string,
    onProgress?: ProjectSaveProgressReporter,
    signal?: AbortSignal
): Promise<PackMainSceneResult> {
    onProgress?.({ phase: 'lodContent', message: '正在下载 lod-meta.json…' });
    let metaText: string;
    try {
        const response = await fetch(toUserUploadFetchUrl(contentUrl), signal ? { signal } : undefined);
        if (!response.ok) {
            return { ok: false, message: `下载 lod-meta.json 失败，状态码: ${response.status}` };
        }
        metaText = await response.text();
    } catch (error) {
        if (signal?.aborted) {
            return { ok: false, cancelled: true, message: SAVE_CANCELLED_MESSAGE };
        }
        return { ok: false, message: `下载 lod-meta.json 失败: ${errorMessage(error)}` };
    }

    let meta: unknown;
    try {
        meta = JSON.parse(metaText);
    } catch {
        return { ok: false, message: 'lod-meta.json 不是有效的 JSON' };
    }

    const filenames = readLodMetaFilenames(meta);
    if (!filenames || filenames.length === 0) {
        return { ok: false, message: 'lod-meta.json 缺少 filenames，无法打包分块文件' };
    }

    const remembered = lodMetaOriginalFilenames.get(contentUrl);
    const used = new Set<string>([`${PACKED_CONTENT_DIR}/${LOD_META_FILENAME}`]);
    const plans: LodChunkPlan[] = [];

    for (let index = 0; index < filenames.length; index++) {
        const raw = filenames[index];
        if (!raw) {
            return { ok: false, message: `lod-meta.json filenames[${index}] 为空` };
        }
        const relative = lodChunkPackRelativePath(raw);
        if (relative) {
            const fetchUrl = resolveLodChunkFetchUrl(contentUrl, raw);
            if (!fetchUrl) {
                return { ok: false, message: `lod-meta.json 分块路径无法解析: ${raw}` };
            }
            plans.push({
                index,
                raw,
                fetchUrl,
                packPath: uniquePackPath(relative, used),
                optional: false
            });
            continue;
        }
        if (/^(?:blob|data):/i.test(raw)) {
            // 从项目包导入后 filenames 已内联成 blob/data URL：用登记表还原原相对名
            const name = normalizePackPath(remembered?.[index] ?? '');
            if (!name) {
                return { ok: false, message: `无法还原 lod-meta.json 分块文件名: ${raw}` };
            }
            plans.push({
                index,
                raw,
                fetchUrl: raw,
                packPath: uniquePackPath(`${PACKED_CONTENT_DIR}/${name}`, used),
                optional: false
            });
            continue;
        }
        // 绝对 URL：尽量拉回本地；失败保留原引用，不整单失败
        const basename = lodChunkBasenameFromUrl(raw);
        if (!basename) continue;
        plans.push({
            index,
            raw,
            fetchUrl: raw,
            packPath: uniquePackPath(`${PACKED_CONTENT_DIR}/${basename}`, used),
            optional: true
        });
    }

    const nextFilenames = [...filenames];
    const extraFiles: ProjectPackFile[] = [];
    const failures: string[] = [];
    const total = plans.length;
    let finished = 0;
    let bytes = 0;

    const reportChunks = () => {
        onProgress?.({
            phase: 'lodContent',
            message: total > 0 ?
                `正在下载分块 ${finished}/${total}（${Math.floor((finished / total) * 100)}%）· ${formatByteSize(bytes)}` :
                'lod-meta.json 分块沿用原 URL，无需下载',
            done: finished,
            total,
            bytes
        });
    };
    reportChunks();

    await runLimitedBatch(plans, LOD_CHUNK_FETCH_CONCURRENCY, async (plan) => {
        // 取消后不再发起新请求（在飞请求由 signal 中止）
        if (signal?.aborted) return;
        const blob = await fetchLodChunkBlob(plan.fetchUrl, signal);
        finished += 1;
        if (!blob) {
            if (!plan.optional && !signal?.aborted) failures.push(`下载 lod-meta 分块失败: ${plan.raw}`);
        } else {
            bytes += blob.size;
            extraFiles.push({ path: plan.packPath, blob });
            nextFilenames[plan.index] = plan.packPath.slice(PACKED_CONTENT_DIR.length + 1);
        }
        reportChunks();
    });

    if (signal?.aborted) {
        return { ok: false, cancelled: true, message: SAVE_CANCELLED_MESSAGE };
    }
    if (failures.length > 0) {
        return { ok: false, message: failures[0] };
    }

    const unchanged = nextFilenames.every((name, index) => name === filenames[index]);
    const blob = unchanged ?
        new Blob([metaText], { type: 'application/json' }) :
        new Blob(
            [JSON.stringify({ ...(meta as Record<string, unknown>), filenames: nextFilenames }, null, 2)],
            { type: 'application/json' }
        );

    extraFiles.sort((a, b) => a.path.localeCompare(b.path));
    return {
        ok: true,
        relativePath: `${PACKED_CONTENT_DIR}/${LOD_META_FILENAME}`,
        blob,
        extraFiles
    };
}

/**
 * 原启动场景本身是 lod-meta 时，用它的 URL 给包外分块做 rebase 基址。
 * @param config - Viewer 启动配置（apply 阶段 contentUrl 仍是启动 URL）
 * @returns lod-meta URL，否则 undefined
 */
function lodChunkExternalBaseUrl(config: Config): string | undefined {
    const url = typeof config.contentUrl === 'string' ? config.contentUrl.trim() : '';
    return isLodMetaFile(url) ? url : undefined;
}

/**
 * 包内 lod-meta：分块按相对 meta 的路径解析。
 * 有包内 meta 字节时把 filenames 逐项改写成可解析的绝对引用后注入：
 * 分块在包内 → object URL；不在包内 → 若原启动场景也是 lod-meta 则按它 rebase 成绝对 URL；
 * 都没有则报错（不再退回 settingsUrl，避免指到站点根 `content/` 去 404）。
 * 没有包内 meta 时（只有 settings.json，如解压后托管在服务器上的项目包）按 settings.json 目录解析。
 * @param config - Viewer 启动配置（就地改写 contentUrl / contents）
 * @param path - 包内 lod-meta 路径
 * @param metaBlob - 包内 meta 字节
 * @param files - 包内文件表
 * @param externalBaseUrl - 包外分块的 rebase 基址（原启动 lod-meta URL）
 * @returns 注入完成
 */
async function applyPackedLodMetaToConfig(
    config: Config,
    path: string,
    metaBlob: Blob | undefined,
    files: Map<string, Blob> | undefined,
    externalBaseUrl: string | undefined
): Promise<void> {
    if (metaBlob) {
        const baseDir = path.slice(0, path.lastIndexOf('/') + 1);
        const inline = await buildInlineLodMeta(metaBlob, baseDir, files, externalBaseUrl);
        if (inline.ok === false) {
            throw new ViewerLoadError(`无法读取主场景: ${path}（${inline.message}）`, {
                stage: 'content',
                url: path
            });
        }
        if (inline.rebased > 0) {
            console.info(
                `[SuperSplat][projectPack] ${inline.rebased}/${inline.originalFilenames.length} 个 LOD 分块不在包内，按启动 lod-meta 解析: ${externalBaseUrl}`
            );
        }
        lodMetaOriginalFilenames.set(inline.url, inline.originalFilenames);
        config.contentUrl = inline.url;
        config.contents = Promise.resolve(new Response(inline.blob));
        return;
    }
    const href = resolveAgainstSettingsUrl(config.settingsUrl, path);
    if (!href) {
        throw new ViewerLoadError(
            `无法读取主场景: ${path}（LOD 项目包需通过 ?settings= 从服务器目录加载，或整包导入）`,
            { stage: 'content', url: path }
        );
    }
    config.contentUrl = href;
    config.contents = fetch(toUserUploadFetchUrl(href));
}

/**
 * 把包内 lod-meta 的 filenames 改写成可解析的绝对引用。
 * @param metaBlob - 包内 lod-meta 字节
 * @param baseDir - meta 在包内的目录（含结尾 `/`），用于定位包内分块
 * @param files - 包内文件表
 * @param externalBaseUrl - 分块不在包内时用的原 lod-meta URL（只换 meta 的场景）
 * @returns blob URL + 重写后的 meta + 原始相对 filenames（供再次保存还原），或错误文案
 */
async function buildInlineLodMeta(
    metaBlob: Blob,
    baseDir: string,
    files: Map<string, Blob> | undefined,
    externalBaseUrl: string | undefined
): Promise<
    | { ok: true; url: string; blob: Blob; originalFilenames: string[]; rebased: number }
    | { ok: false; message: string }
> {
    let meta: unknown;
    try {
        meta = JSON.parse(await metaBlob.text());
    } catch {
        return { ok: false, message: 'lod-meta.json 不是有效的 JSON' };
    }
    const filenames = readLodMetaFilenames(meta);
    if (!filenames || filenames.length === 0) {
        return { ok: false, message: 'lod-meta.json 缺少 filenames' };
    }

    const rewritten: string[] = [];
    const missing: string[] = [];
    let rebased = 0;
    for (const raw of filenames) {
        const packPath = raw ? normalizePackPath(`${baseDir}${raw}`) : null;
        const blob = packPath ?
            (files?.get(packPath) ?? files?.get(normalizeUserUploadRelativePath(packPath))) :
            undefined;
        if (blob && packPath) {
            // 必须带 `#<文件名>`：引擎 GSplatHandler 按 URL basename 的扩展名选解析器，
            // 而分块 Asset 由 GSplatAssetLoader 建（`new Asset(url, 'gsplat', { url })`，
            // 没有 filename → 只能用 URL 本身），无扩展名会落到 PLY 兜底报 Invalid ply header。
            // 引擎 `_getUrlWithoutParams` 只截 `?`，所以扩展名必须放 `#`。
            const name = packPath.slice(packPath.lastIndexOf('/') + 1);
            rewritten.push(`${URL.createObjectURL(blob)}#${name}`);
            continue;
        }
        if (lodChunkPackRelativePath(raw) && externalBaseUrl) {
            const rebasedUrl = resolveLodChunkFetchUrl(externalBaseUrl, raw);
            if (rebasedUrl) {
                rebased += 1;
                rewritten.push(rebasedUrl);
                continue;
            }
        }
        if (/^https?:/i.test(raw)) {
            rewritten.push(raw);
            continue;
        }
        missing.push(raw || '(空)');
    }

    if (missing.length > 0) {
        const head = missing.slice(0, 3).join(', ');
        const more = missing.length > 3 ? ` 等 ${missing.length} 个` : '';
        return {
            ok: false,
            message: `分块不在包内且无法定位: ${head}${more}；请用「导入文件夹」连同分块导入，或从原 ?content= 场景导入`
        };
    }

    const blob = new Blob(
        [JSON.stringify({ ...(meta as Record<string, unknown>), filenames: rewritten })],
        { type: 'application/json' }
    );
    return {
        ok: true,
        url: `${URL.createObjectURL(blob)}#${LOD_META_FILENAME}`,
        blob,
        originalFilenames: filenames,
        rebased
    };
}

export async function applyPackedSceneToConfig(
    config: Config,
    pack: { settings: unknown; files?: Map<string, Blob> },
    search: string = location.search,
    opts?: { preferPackedContent?: boolean }
): Promise<void> {
    if (hasExplicitContentQueryParam(search) && !opts?.preferPackedContent) return;
    const path = guessPackedContentPath(pack.files?.keys() ?? [], pack.settings);
    if (!path) return;
    if (!isPackedContentFilename(path)) return;
    const blob = pack.files?.get(path) ?? pack.files?.get(normalizeUserUploadRelativePath(path));
    if (isLodMetaFilename(path)) {
        await applyPackedLodMetaToConfig(config, path, blob, pack.files, lodChunkExternalBaseUrl(config));
        return;
    }
    if (blob) {
        const name = path.split('/').pop() || 'scene.sog';
        const url = `${URL.createObjectURL(blob)}#${encodeURIComponent(name)}`;
        config.contentUrl = url;
        config.contents = Promise.resolve(new Response(blob));
        return;
    }
    const href = resolveAgainstSettingsUrl(config.settingsUrl, path);
    if (!href) {
        throw new ViewerLoadError(`无法读取主场景: ${path}`, {
            stage: 'content',
            url: path
        });
    }
    config.contentUrl = href;
    config.contents = fetch(toUserUploadFetchUrl(href));
}

export function writePackedContentField(
    settings: ExperienceSettings,
    relativePath: string
): ExperienceSettings {
    return { ...settings, content: relativePath };
}

export function stripPackedContentField(settings: ExperienceSettings): ExperienceSettings {
    if (!('content' in settings)) return settings;
    const next = { ...settings };
    delete (next as { content?: string }).content;
    return next;
}
