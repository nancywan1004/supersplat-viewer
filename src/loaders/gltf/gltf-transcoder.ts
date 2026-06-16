import { basisInitialize } from 'playcanvas';

import { initializeMeshoptDecoder } from './meshopt-gltf';

const BASIS_VENDOR_DIR = 'vendor/basis';

const resolveBasisVendorUrl = (filename: string): string =>
    new URL(`${BASIS_VENDOR_DIR}/${filename}`, document.baseURI).href;

let configured = false;

/**
 * 为 glTF / GLB 加载注册 KTX2（`KHR_texture_basisu`）与 Basis 贴图转码器。
 *
 * PlayCanvas 在解析 container 资产时会按需调用 Basis worker；此处仅配置 WASM 路径。
 * `lazyInit`：首屏不拉 worker，直到首次遇到压缩贴图再初始化。
 */
export function initializeGltfTranscoder(): void {
    if (configured) return;
    configured = true;

    basisInitialize({
        glueUrl: resolveBasisVendorUrl('basis.wasm.js'),
        wasmUrl: resolveBasisVendorUrl('basis.wasm.wasm'),
        fallbackUrl: resolveBasisVendorUrl('basis.js'),
        lazyInit: true
    });
}

/** 注册 glTF 加载所需的全部运行时解码器（KTX2 / meshopt）。 */
export function initializeGltfRuntime(): void {
    initializeGltfTranscoder();
    initializeMeshoptDecoder();
}
