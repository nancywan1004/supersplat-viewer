import { MeshoptDecoder } from 'meshoptimizer/decoder';

type MeshoptCompressionExt = {
    buffer: number;
    byteOffset: number;
    byteLength: number;
    byteStride?: number;
    count: number;
    mode: string;
    filter?: string;
};

type GltfBufferView = {
    byteLength: number;
    byteStride?: number;
    extensions?: {
        EXT_meshopt_compression?: MeshoptCompressionExt;
    };
};

type BufferSource = ArrayBuffer | ArrayBufferView;

let meshoptInitStarted = false;

/** 预热 meshoptimizer WASM（glTF `EXT_meshopt_compression` 解压依赖）。 */
export function initializeMeshoptDecoder(): void {
    if (meshoptInitStarted) return;
    meshoptInitStarted = true;
    void MeshoptDecoder.ready;
}

/**
 * PlayCanvas `GlbParser` 的 `asset.options`：对 meshopt 压缩的 bufferView 先解压再读几何。
 */
export function getGltfParserOptions(): Record<string, unknown> {
    return {
        bufferView: {
            processAsync(
                gltfBufferView: GltfBufferView,
                buffers: Promise<BufferSource>[],
                callback: (err: Error | string | null, result: Uint8Array | null) => void
            ): void {
                const ext = gltfBufferView.extensions?.EXT_meshopt_compression;
                if (!ext) {
                    callback(null, null);
                    return;
                }

                const decode = async () => {
                    await MeshoptDecoder.ready;
                    const sourceBuffer = await buffers[ext.buffer];
                    const src: Uint8Array = sourceBuffer instanceof Uint8Array
                        ? sourceBuffer
                        : new Uint8Array(sourceBuffer as ArrayBuffer);
                    const source = src.subarray(ext.byteOffset, ext.byteOffset + ext.byteLength);
                    const byteStride = ext.byteStride ?? gltfBufferView.byteStride ?? 4;
                    const decoded = await MeshoptDecoder.decodeGltfBufferAsync(
                        ext.count,
                        byteStride,
                        source,
                        ext.mode,
                        ext.filter
                    );
                    callback(null, decoded);
                };

                decode().catch((error: unknown) => {
                    callback(error instanceof Error ? error : new Error(String(error)), null);
                });
            }
        }
    };
}
