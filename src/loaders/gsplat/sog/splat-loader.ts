import type { AppBase, Asset } from 'playcanvas';
import { Asset as AssetCtor, GSplatResource } from 'playcanvas';
import { loadSplat } from './splat-deserialize';
import type { AssetSource } from '../../shared/asset-source';
import { loadSpzAsset } from '../spz/spz-loader';

/**
 * 加载 gsplat Asset（.splat / .spz / .ply / .sog 等）
 * 用于资产库上传与放置时实例化 gaussian 实体
 */
export async function loadGsplatAsset(app: AppBase, assetSource: AssetSource): Promise<Asset> {
    const filename = (assetSource.filename || assetSource.url || '').toLowerCase().split('?')[0];
    let asset: Asset;

    if (filename.endsWith('.spz')) {
        // .spz 需要 zstd 解码，走专用 loader（引擎 GSplatHandler 不认识该扩展名）
        asset = await loadSpzAsset(app, assetSource);
    } else if (filename.endsWith('.splat')) {
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
