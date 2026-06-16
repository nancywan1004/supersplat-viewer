import { Asset, type AppBase } from 'playcanvas';

import { getGltfParserOptions } from './meshopt-gltf';

const resolveContainerUrl = (url: string): string =>
    typeof location !== 'undefined' && location?.href
        ? new URL(url, location.href).href
        : url;

const containerAssetName = (url: string): string => {
    try {
        const pathname = new URL(url).pathname;
        const base = pathname.split('/').pop() ?? 'container';
        return decodeURIComponent(base.split('?')[0] || 'container');
    } catch {
        return 'container';
    }
};

/**
 * 加载 glTF / GLB container，并注入 KTX2 + meshopt 等解析扩展配置。
 */
export function loadContainerAsset(app: AppBase, url: string): Promise<Asset> {
    const resolvedUrl = resolveContainerUrl(url);
    const name = containerAssetName(resolvedUrl);

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
