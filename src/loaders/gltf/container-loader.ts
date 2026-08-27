import { Asset, type AppBase } from 'playcanvas';

import { getGltfParserOptions } from './meshopt-gltf';

const resolveContainerUrl = (url: string): string => {
    if (url.startsWith('blob:') || url.startsWith('data:')) return url;
    try {
        const parsed = new URL(url);
        if (parsed.protocol === 'http:' || parsed.protocol === 'https:') {
            return parsed.href;
        }
    } catch {
        // relative — 必须先由 resolveUserUploadResourceUrl 相对 settings.json 解析，不能再对 Viewer 页面取基址
    }
    return url;
};

const containerAssetName = (url: string): string => {
    try {
        const pathname = new URL(url).pathname;
        const base = pathname.split('/').pop() ?? 'container';
        return decodeURIComponent(base.split('?')[0] || 'container');
    } catch {
        return 'container';
    }
};

// 加载 glTF / GLB container，并注入 KTX2 + meshopt 等解析扩展配置。
export function loadContainerAsset(app: AppBase, url: string, filename?: string): Promise<Asset> {
    const resolvedUrl = resolveContainerUrl(url);
    const name = (filename && filename.trim()) || containerAssetName(resolvedUrl);

    return new Promise((resolve, reject) => {
        const asset = new Asset(name, 'container', { url: resolvedUrl, filename: name });
        (asset as Asset & { options: Record<string, unknown> }).options = getGltfParserOptions();

        const cleanup = () => {
            asset.off('load');
            asset.off('error');
        };

        asset.once('load', () => {
            cleanup();
            resolve(asset);
        });

        asset.once('error', (err: string) => {
            cleanup();
            reject(new Error(typeof err === 'string' ? err : String(err)));
        });

        app.assets.add(asset);
        app.assets.load(asset);
    });
}
