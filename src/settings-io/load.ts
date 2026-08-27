// ?settings= 支持 settings.json 或 zip。zip 内存解压后根目录取 settings.json，其余条目进会话表。
import {
    ZIP_VIRTUAL_SETTINGS_URL,
    unzipSettingsArchive
} from './pack';
import { isUsableSettingsFileUrl, unwrapSettingsFetchUrl } from './user-files';

export type LoadedExperienceSettings = {
    settings: unknown;
    settingsUrl: string;
    userUploadFiles: Map<string, Blob>;
};

function hasZipMagic(bytes: Uint8Array): boolean {
    if (bytes.length < 4) return false;
    if (bytes[0] !== 0x50 || bytes[1] !== 0x4b) return false;
    const a = bytes[2];
    const b = bytes[3];
    return (a === 0x03 && b === 0x04) || (a === 0x05 && b === 0x06) || (a === 0x07 && b === 0x08);
}

function urlLooksLikeZip(url: string | undefined | null): boolean {
    if (typeof url !== 'string' || !url.trim()) return false;
    try {
        const path = new URL(url, location.href).pathname.toLowerCase();
        return path.endsWith('.zip');
    } catch {
        return url.toLowerCase().split('?')[0].endsWith('.zip');
    }
}

function contentTypeLooksLikeZip(contentType: string | null | undefined): boolean {
    if (!contentType) return false;
    const t = contentType.toLowerCase();
    return t.includes('application/zip')
        || t.includes('application/x-zip')
        || t.includes('application/x-zip-compressed');
}

function parseJsonBytes(bytes: Uint8Array): unknown {
    let text = new TextDecoder('utf-8').decode(bytes);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    try {
        return JSON.parse(text);
    } catch {
        throw new Error('settings.json 不是有效的 JSON');
    }
}

function unzipProjectSettings(bytes: Uint8Array): LoadedExperienceSettings {
    const { settingsJson, files } = unzipSettingsArchive(bytes);
    return {
        settings: parseJsonBytes(settingsJson),
        settingsUrl: ZIP_VIRTUAL_SETTINGS_URL,
        userUploadFiles: files
    };
}

function loadSettingsFromBytes(
    bytes: Uint8Array,
    sourceUrl: string | undefined,
    contentType: string | null | undefined,
    responseUrl?: string
): LoadedExperienceSettings {
    const asZip = hasZipMagic(bytes) || urlLooksLikeZip(sourceUrl) || urlLooksLikeZip(responseUrl) || contentTypeLooksLikeZip(contentType);
    if (asZip) {
        if (!hasZipMagic(bytes)) {
            throw new Error('settings 不是有效的 zip');
        }
        return unzipProjectSettings(bytes);
    }
    const fromSource = sourceUrl?.trim() ? unwrapSettingsFetchUrl(sourceUrl.trim()) : '';
    const fromResponse = responseUrl?.trim() ? unwrapSettingsFetchUrl(responseUrl.trim()) : '';
    let settingsUrl = isUsableSettingsFileUrl(fromSource) ? fromSource : fromResponse;
    if (!isUsableSettingsFileUrl(settingsUrl) && fromSource) settingsUrl = fromSource;
    if (settingsUrl) {
        try {
            settingsUrl = new URL(settingsUrl, location.href).href;
        } catch {
            // keep raw
        }
    }
    return {
        settings: parseJsonBytes(bytes),
        settingsUrl,
        userUploadFiles: new Map()
    };
}

export async function loadSettingsFromResponse(
    response: Response,
    sourceUrl?: string
): Promise<LoadedExperienceSettings> {
    if (!response.ok) {
        throw new Error(`加载 settings 失败: HTTP ${response.status}`);
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return loadSettingsFromBytes(bytes, sourceUrl, response.headers.get('content-type'), response.url);
}

export async function loadSettingsFromUrl(
    fetchUrl: string,
    sourceUrl?: string
): Promise<LoadedExperienceSettings> {
    const response = await fetch(fetchUrl);
    return loadSettingsFromResponse(response, sourceUrl ?? fetchUrl);
}
