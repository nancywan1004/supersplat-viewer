import type { AppBase, Asset } from 'playcanvas';
import { Asset as AssetCtor, GSplatResource } from 'playcanvas';

import { decodeSpz, type SpzDecodeOptions } from './spz-decode';
import type { SpzHeader } from './spz-format';
import { createReadSource, type AssetSource } from '../../shared/asset-source';

export interface SpzAssetInfo {
    header: SpzHeader;
    /** Size of the source .spz file in bytes. */
    fileBytes: number;
}

export type SpzAsset = Asset & {
    spzInfo?: SpzAssetInfo;
};

export type LoadSpzOptions = SpzDecodeOptions & {
    /** 下载进度：已读字节 / 总字节。按 ~100ms 节流。 */
    onDownloadProgress?: (received: number, total: number) => void;
};

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

const formatMb = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`;

const PROGRESS_INTERVAL_MS = 100;
// 单次 pull 的缓冲大小。1 MB 在进度平滑度和调用开销之间比较平衡。
const READ_CHUNK_BYTES = 1024 * 1024;

// 用 ReadSource 的流式读取拿字节，边读边上报进度。
//
// 与 splat-transform / supersplat 的 `readSpz(source: ReadSource, ...)` 同一条路径：
// `fetch → response.body.getReader()` 逐块拉，`readBytes / totalBytes` 即下载进度。
// 关键点是不要用 `arrayBuffer()`——那是一次性读空 body，中间没有任何进度可报。
const readSpzBytes = async (
    assetSource: AssetSource,
    name: string,
    onProgress?: (received: number, total: number) => void
): Promise<Uint8Array> => {
    const source = await createReadSource(assetSource);
    const stream = await source.getReadStream();
    const total = stream.totalBytes;

    // 没有 Content-Length（chunked）时无法算百分比，退回一次性读取
    if (total <= 0) {
        return new Uint8Array(await source.arrayBuffer());
    }

    const target = new Uint8Array(total);
    const buffer = new Uint8Array(Math.min(READ_CHUNK_BYTES, total));
    let written = 0;
    let lastReport = 0;

    for (;;) {
        // eslint-disable-next-line no-await-in-loop
        const count = await stream.pull(buffer);
        if (count <= 0) {
            break;
        }
        if (written + count > total) {
            throw new Error(`SPZ: received more than the declared ${total} bytes`);
        }
        target.set(buffer.subarray(0, count), written);
        written += count;

        const now = performance.now();
        if (onProgress && now - lastReport >= PROGRESS_INTERVAL_MS) {
            lastReport = now;
            onProgress(written, total);
        }
    }

    if (written !== total) {
        throw new Error(`SPZ: failed to read ${name}: truncated (${written}/${total} bytes)`);
    }

    onProgress?.(total, total);
    return target;
};

// Load a .spz file into a PlayCanvas gsplat Asset.
//
// Mirrors the `.splat` branch of loadGsplatAsset: fetch → decode → GSplatResource. The Asset is
// registered before decoding so `progress` events reach listeners, and `error` is fired (plus
// rethrown) with the real reason on failure.
export async function loadSpzAsset(app: AppBase, assetSource: AssetSource, options: LoadSpzOptions = {}): Promise<SpzAsset> {
    const name = assetSource.filename || assetSource.url || 'model.spz';
    const asset = new AssetCtor(name, 'gsplat', {
        url: assetSource.contents ? `local-asset-${Date.now()}` : assetSource.url ?? assetSource.filename,
        filename: assetSource.filename
    }) as SpzAsset;

    app.assets.add(asset);

    try {
        let bytes: Uint8Array | null;
        try {
            bytes = await readSpzBytes(assetSource, name, options.onDownloadProgress);
        } catch (err) {
            throw new Error(`SPZ: failed to read ${name}: ${errorMessage(err)}`);
        }

        const fileBytes = bytes.byteLength;
        const start = performance.now();

        const { data, header } = await decodeSpz(bytes, {
            yieldToMainThread: options.yieldToMainThread,
            onProgress: (done, total) => {
                asset.fire('progress', done, total);
                options.onProgress?.(done, total);
            }
        });

        // release the compressed source before the GPU upload doubles the footprint
        bytes = null;

        const elapsed = Math.round(performance.now() - start);
        console.log(
            `[SPZ] ${header.version >= 4 ? 'NGSP' : `legacy gzip v${header.version}`} ` +
            `points=${header.numPoints} shDegree=${header.shDegree} fractionalBits=${header.fractionalBits} ` +
            `streams=${header.numStreams} antialiased=${header.antialiased}` +
            `${header.hasExtensions ? ' extensions=yes' : ''} | ${formatMb(fileBytes)} decoded in ${elapsed} ms`
        );

        // `asset` is created by this function and not shared until 'load' fires.
        /* eslint-disable require-atomic-updates */
        asset.spzInfo = { header, fileBytes };
        asset.resource = new GSplatResource(app.graphicsDevice, data);
        asset.loaded = true;
        /* eslint-enable require-atomic-updates */
        asset.fire('load', asset);

        return asset;
    } catch (err) {
        app.assets.remove(asset);
        asset.fire('error', err);
        throw err;
    }
}
