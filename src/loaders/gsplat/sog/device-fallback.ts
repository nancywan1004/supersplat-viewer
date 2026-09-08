import type { Config } from '../../../types';
import { contentFilenameFromUrl } from '../content-filename';

/**
 * 主场景 content 指向单文件 .sog（unified instance 路径，非 octree lod-meta）。
 * @param contentUrl - 主场景 URL
 * @returns 是否为 unified 单文件 .sog
 */
export const isSogUnifiedContentUrl = (contentUrl: string | undefined): boolean => {
    if (!contentUrl) {
        return false;
    }
    const filename = contentFilenameFromUrl(contentUrl).toLowerCase();
    return filename.endsWith('.sog');
};

const isWindowsHost = (): boolean => {
    if (typeof navigator === 'undefined') {
        return false;
    }
    const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
    const uaPlatform = nav.userAgentData?.platform ?? nav.platform ?? nav.userAgent ?? '';
    const isIPad = nav.maxTouchPoints > 1 && /Mac/i.test(nav.platform || '');
    return !isIPad && /Win/i.test(uaPlatform);
};

/**
 * Windows + WebGPU + SOG unified：D3D12 splat depth readback 易 TDR，启动时直接用 WebGL2。
 * LOD/octree（lod-meta 等）不在此列，仍可走 WebGPU。
 * @param config - Viewer 启动配置
 * @returns 是否应强制 WebGL2
 */
export const shouldForceWebGlForSogUnified = (config: Config): boolean => {
    if (config.renderer === 'webgl') {
        return false;
    }
    if (!isSogUnifiedContentUrl(config.contentUrl)) {
        return false;
    }
    return isWindowsHost();
};
