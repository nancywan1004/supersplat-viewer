// 本地项目包：settings.json + content/<场景文件> + assets/。
// 普通加载：URL ?content= 优先于包内主场景。导入刷新：pending 包内 content/ 优先。
import { contentFilenameFromUrl } from '../loaders/gsplat/content-filename';
import { isLodMetaFile } from '../loaders/gsplat/lod/custom-loader';
import { ViewerLoadError } from './host-protocol';
import type { Config, Global } from '../types';
import {
    guessPackedContentPath,
    hasExplicitContentQueryParam,
    isPackedSceneFilename,
    packedContentRelativePath
} from './project-pack-parse';
import {
    normalizeUserUploadRelativePath,
    resolveAgainstSettingsUrl,
    toUserUploadFetchUrl
} from './user-files';
import type { ExperienceSettings } from '../schemas/v2';

export {
    PACKED_CONTENT_DIR,
    findProjectSettingsPath,
    guessPackedContentPath,
    hasExplicitContentQueryParam,
    isPackedSceneFilename,
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

export async function packMainSceneContent(global: Global): Promise<
    { ok: true; relativePath: string; blob: Blob } | { ok: false; message: string }
> {
    const contentUrl = typeof global.config.contentUrl === 'string' ? global.config.contentUrl.trim() : '';
    if (!contentUrl) {
        return { ok: false, message: '缺少主场景 content，无法写入项目包' };
    }
    if (isLodMetaFile(contentUrl)) {
        return { ok: false, message: 'LOD 场景（lod-meta.json）不能打进本地项目包，请用 ?content= 加载' };
    }
    const filename = contentFilenameFromUrl(contentUrl);
    if (!isPackedSceneFilename(filename)) {
        return { ok: false, message: '主场景不是可打包的 .sog / .splat / .ply' };
    }
    const relativePath = packedContentRelativePath(filename);
    try {
        const response = await fetch(toUserUploadFetchUrl(contentUrl));
        if (!response.ok) {
            return { ok: false, message: `下载主场景失败，状态码: ${response.status}` };
        }
        const blob = await response.blob();
        if (blob.size <= 0) {
            return { ok: false, message: '主场景文件为空' };
        }
        return { ok: true, relativePath, blob };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return { ok: false, message: `下载主场景失败: ${message}` };
    }
}

export function applyPackedSceneToConfig(
    config: Config,
    pack: { settings: unknown; files?: Map<string, Blob> },
    search: string = location.search,
    opts?: { preferPackedContent?: boolean }
): void {
    if (hasExplicitContentQueryParam(search) && !opts?.preferPackedContent) return;
    const path = guessPackedContentPath(pack.files?.keys() ?? [], pack.settings);
    if (!path) return;
    if (!isPackedSceneFilename(path)) return;
    const blob = pack.files?.get(path) ?? pack.files?.get(normalizeUserUploadRelativePath(path));
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
