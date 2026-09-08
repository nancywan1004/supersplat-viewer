// ?settings= 只读 settings.json。相对路径相对该文件所在目录解析。
import { ViewerLoadError } from './host-protocol';
import { isUsableSettingsFileUrl, unwrapSettingsFetchUrl } from './user-files';

export type LoadedExperienceSettings = {
    settings: unknown;
    settingsUrl: string;
    userUploadFiles: Map<string, Blob>;
};

function parseJsonBytes(bytes: Uint8Array): unknown {
    let text = new TextDecoder('utf-8').decode(bytes);
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    try {
        return JSON.parse(text);
    } catch {
        throw new ViewerLoadError('settings.json 不是有效的 JSON', { stage: 'settings' });
    }
}

function loadSettingsFromBytes(
    bytes: Uint8Array,
    sourceUrl: string | undefined,
    responseUrl?: string
): LoadedExperienceSettings {
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
        throw new ViewerLoadError(`加载 settings 失败: HTTP ${response.status}`, {
            stage: 'settings',
            status: response.status,
            url: sourceUrl || response.url
        });
    }
    const bytes = new Uint8Array(await response.arrayBuffer());
    return loadSettingsFromBytes(bytes, sourceUrl, response.url);
}

export async function loadSettingsFromUrl(
    fetchUrl: string,
    sourceUrl?: string
): Promise<LoadedExperienceSettings> {
    const response = await fetch(fetchUrl);
    return loadSettingsFromResponse(response, sourceUrl ?? fetchUrl);
}
