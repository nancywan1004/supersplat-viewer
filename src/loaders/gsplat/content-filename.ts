/**
 * 从 content URL 取文件名；blob: 可用 `#flower.sog` 保留扩展名。
 * @param contentUrl - 主场景 URL（可含 blob hash）
 * @param baseHref - 解析相对 URL 的基址；缺省用当前页或 localhost
 * @returns 文件名（含扩展名）
 */
export function contentFilenameFromUrl(contentUrl: string, baseHref?: string): string {
    try {
        const u = new URL(contentUrl, baseHref ?? (typeof location !== 'undefined' ? location.href : 'http://localhost/'));
        const fromHash = u.hash.replace(/^#/, '').split('?')[0];
        if (fromHash) return decodeURIComponent(fromHash);
        const fromPath = (u.pathname.split('/').pop() || '').split('?')[0];
        return decodeURIComponent(fromPath);
    } catch {
        return (contentUrl || '').split('?')[0].split('/').pop() || '';
    }
}
