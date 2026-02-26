import type { AppBase, Asset } from 'playcanvas';
import { Asset as AssetCtor, GSplatResource } from 'playcanvas';
import { loadSplat } from './splat-loader';
import type { AssetSource } from './asset-source';

/**
 * 加载 gsplat Asset（.splat / .ply / .sog 等）
 * 用于资产库上传与放置时实例化 gaussian 实体
 */
export async function loadGsplatAsset(app: AppBase, assetSource: AssetSource): Promise<Asset> {
    const filename = (assetSource.filename || assetSource.url || '').toLowerCase();
    let asset: Asset;

    if (filename.endsWith('.splat')) {
        const gsplatData = await loadSplat(assetSource);
        asset = new AssetCtor(assetSource.filename || assetSource.url, 'gsplat', {
            url: assetSource.contents ? `local-asset-${Date.now()}` : assetSource.url ?? assetSource.filename,
            filename: assetSource.filename
        });
        app.assets.add(asset);
        asset.resource = new GSplatResource(app.graphicsDevice, gsplatData);
        asset.loaded = true;
        asset.fire('load', asset);
    } else {
        const c = assetSource.contents ? await assetSource.contents.arrayBuffer() : undefined;
        asset = new AssetCtor(assetSource.filename || assetSource.url, 'gsplat', {
            url: assetSource.url ?? assetSource.filename,
            filename: assetSource.filename,
            contents: c
        });
        app.assets.add(asset);
        app.assets.load(asset);
    }

    return asset;
}
