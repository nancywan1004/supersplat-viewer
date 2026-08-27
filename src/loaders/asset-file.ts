// 用户上传 File：会话内 createObjectURL 供 loader 用；blob: 不入库。
import type { AssetLibraryItem, Global } from '../types';

const fileObjectUrls = new WeakMap<File, string>();

export function isEphemeralAssetUrl(url: string | undefined | null): boolean {
    if (typeof url !== 'string') return false;
    const s = url.trim().toLowerCase();
    return s.startsWith('blob:') || s.startsWith('data:');
}

export function asUserFile(value: unknown): File | null {
    if (typeof File !== 'undefined' && value instanceof File) return value;
    if (typeof Blob !== 'undefined' && value instanceof Blob) {
        return new File([value], 'asset.bin', { type: value.type || 'application/octet-stream' });
    }
    return null;
}

export function userUploadBasename(file: File, fallback?: string): string {
    const raw = String(file.name || fallback || 'asset').replace(/\\/g, '/');
    const base = raw.split('/').pop()?.trim();
    return base && base.length > 0 ? base : 'asset';
}

function objectUrlForFile(file: File): string {
    const existing = fileObjectUrls.get(file);
    if (existing) return existing;
    const url = URL.createObjectURL(file);
    fileObjectUrls.set(file, url);
    return url;
}

/** loader 用的字符串 href：File → object URL；否则 src / extra / filename。 */
export function assetLibraryHref(
    item: Pick<AssetLibraryItem, 'src' | 'filename'>,
    extra?: string
): string {
    const file = asUserFile(item.src);
    if (file) return objectUrlForFile(file);
    if (typeof item.src === 'string' && item.src.trim()) return item.src.trim();
    if (typeof extra === 'string' && extra.trim()) return extra.trim();
    if (typeof item.filename === 'string' && item.filename.trim()) return item.filename.trim();
    return '';
}

export async function fetchFileFromUrl(url: string, filenameHint?: string): Promise<File | null> {
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const blob = await res.blob();
        const name = (filenameHint && filenameHint.trim()) || 'asset.bin';
        return new File([blob], name, { type: blob.type || 'application/octet-stream' });
    } catch {
        return null;
    }
}

// 有 File 则留在 src 上供后续 ingest；仅有跨 document 的 blob: 字符串则尝试 fetch 成 File。失败返回 null。
export async function prepareAssetLibraryItemForPlacement(
    item: AssetLibraryItem
): Promise<AssetLibraryItem | null> {
    let file = asUserFile(item.src);
    const incomingUrl = typeof item.src === 'string' ? item.src.trim() : '';

    if (!file && isEphemeralAssetUrl(incomingUrl) && incomingUrl.toLowerCase().startsWith('blob:')) {
        file = await fetchFileFromUrl(incomingUrl, item.filename);
        if (!file) {
            console.warn('[AssetPlace] blob URL 无法在 Viewer 内 fetch，放置失败');
            return null;
        }
    }

    if (!file) return item;

    let filename = userUploadBasename(file, item.name);
    if (typeof item.filename === 'string' && item.filename.trim().length > 0) {
        filename = item.filename.trim();
    }
    return {
        ...item,
        filename,
        src: file
    };
}

export function upsertUploadedAsset(global: Global, item: AssetLibraryItem): void {
    if (!global.state.uploadedAssets) {
        global.state.uploadedAssets = [];
    }
    const list = global.state.uploadedAssets;
    const id = typeof item.id === 'string' ? item.id.trim() : '';
    if (!id) {
        list.push(item);
        global.events.fire('assetLibrary:added', [item]);
        return;
    }
    const idx = list.findIndex(a => a.id === id);
    if (idx >= 0) {
        const prev = list[idx];
        list[idx] = {
            ...prev,
            ...item,
            id,
            src: asUserFile(item.src) ?? item.src ?? prev.src,
            asset: item.asset ?? prev.asset
        };
        return;
    }
    list.push(item);
    global.events.fire('assetLibrary:added', [item]);
}
