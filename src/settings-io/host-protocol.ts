// Viewer ↔ 外层 Controller 的加载/保存出站（不依赖 message-bridge，bootstrap 失败时也能发）。

export type ViewerLoadStage = 'settings' | 'content' | 'resource';

export type SettingsSaveDestination = 'local' | 'universe' | 'host';

/**
 * postMessage 协议：本地保存一律 `host`（交回父级，不下载不上传）。
 * Viewer 内部直连下载 zip 请直接调 `saveExperienceProject(..., 'local')`，不要走本函数。
 * @param value - 入站 destination
 * @returns 规范化后的保存去向
 */
export function resolveSettingsSaveDestination(value: unknown): SettingsSaveDestination {
    if (value === 'host' || value === 'local') return 'host';
    return 'universe';
}

export type HostContentConfig = {
    contentUrl?: string;
    originalContentUrl?: string;
};

/**
 * host 保存：仅当 Viewer 持有主模型字节（blob/data）或运行期替换了启动 URL 时才带回文件。
 * 仍是原来的 http(s) `?content=` / CDN 地址时，外层保留原输入即可。
 * @param config - 当前与启动时的主场景 URL
 * @returns 是否需要把主模型文件交回外层
 */
export function isMainSceneModifiedForHostSave(config: HostContentConfig): boolean {
    const current = typeof config.contentUrl === 'string' ? config.contentUrl.trim() : '';
    if (!current) return false;
    if (current.startsWith('blob:') || current.startsWith('data:')) return true;
    const original = typeof config.originalContentUrl === 'string' ? config.originalContentUrl.trim() : '';
    return Boolean(original) && current !== original;
}

export class ViewerLoadError extends Error {
    readonly stage: ViewerLoadStage;

    readonly status?: number;

    readonly url?: string;

    constructor(
        message: string,
        opts: { stage: ViewerLoadStage; status?: number; url?: string }
    ) {
        super(message);
        this.name = 'ViewerLoadError';
        this.stage = opts.stage;
        if (typeof opts.status === 'number' && Number.isFinite(opts.status)) {
            this.status = opts.status;
        }
        if (typeof opts.url === 'string' && opts.url.trim()) {
            this.url = opts.url.trim();
        }
    }
}

let loadFailedPosted = false;

/**
 * 从 Viewer URL 读取外层本次加载 id。
 * @param search - `location.search`
 * @returns 非空 requestId
 */
export function readHostRequestId(search: string = location.search): string | undefined {
    const value = new URLSearchParams(search).get('requestId')?.trim();
    return value || undefined;
}

/**
 * 从入站 postMessage 读取 requestId。
 * @param payload - 入站消息
 * @returns 非空 requestId
 */
export function readInboundRequestId(payload: { requestId?: unknown } | null | undefined): string | undefined {
    if (typeof payload?.requestId !== 'string') return undefined;
    const value = payload.requestId.trim();
    return value || undefined;
}

/**
 * 从 Error / 文案里解析 HTTP 状态码。
 * @param err - 原始错误
 * @returns 401/403/404 等，无法解析则为 undefined
 */
export function httpStatusFromUnknown(err: unknown): number | undefined {
    if (err instanceof ViewerLoadError && typeof err.status === 'number') return err.status;
    if (err && typeof err === 'object' && 'status' in err) {
        const status = (err as { status?: unknown }).status;
        if (typeof status === 'number' && Number.isFinite(status)) return status;
    }
    const message = errorMessage(err, '');
    const match = message.match(/\b(401|403|404|410|500|502|503|504)\b/);
    return match ? Number(match[1]) : undefined;
}

/**
 * 把未知错误收成可读文案。
 * @param err - 原始错误
 * @param fallback - 空文案时的兜底
 * @returns 错误文案
 */
export function errorMessage(err: unknown, fallback: string): string {
    if (err instanceof Error && err.message.trim()) return err.message;
    if (typeof err === 'string' && err.trim()) return err;
    return fallback;
}

/**
 * 统一打上加载阶段，便于出站 VIEWER_LOAD_FAILED。
 * @param err - 原始错误
 * @param fallbackStage - 未标注时的阶段
 * @param extra - 可选补充
 * @param extra.url - 失败资源 URL
 * @returns ViewerLoadError
 */
export function toViewerLoadError(
    err: unknown,
    fallbackStage: ViewerLoadStage,
    extra?: { url?: string }
): ViewerLoadError {
    if (err instanceof ViewerLoadError) {
        if (extra?.url && !err.url) {
            return new ViewerLoadError(err.message, {
                stage: err.stage,
                status: err.status,
                url: extra.url
            });
        }
        return err;
    }
    return new ViewerLoadError(errorMessage(err, '加载失败'), {
        stage: fallbackStage,
        status: httpStatusFromUnknown(err),
        url: extra?.url
    });
}

/**
 * 向父页 postMessage（bootstrap 阶段 message-bridge 尚未挂载时也能用）。
 * @param type - 事件名
 * @param data - 顶层字段
 */
export function postToHost(type: string, data?: Record<string, unknown>): void {
    const message = (data ? { type, ...data } : { type }) as Record<string, unknown>;
    window.parent.postMessage(message, '*');
}

/**
 * 出站 VIEWER_LOAD_FAILED；同一 iframe 加载最多一次。
 * @param opts - 出站字段
 * @param opts.stage - settings / content / resource
 * @param opts.message - 错误原因
 * @param opts.status - HTTP 状态码
 * @param opts.url - 失败资源 URL
 * @param opts.requestId - 本次加载请求 id
 */
export function postViewerLoadFailed(opts: {
    stage: ViewerLoadStage;
    message: string;
    status?: number;
    url?: string;
    requestId?: string;
}): void {
    if (loadFailedPosted) return;
    loadFailedPosted = true;
    const requestId = opts.requestId ?? readHostRequestId();
    const data: Record<string, unknown> = {
        stage: opts.stage,
        message: opts.message
    };
    if (requestId) data.requestId = requestId;
    if (typeof opts.status === 'number') data.status = opts.status;
    if (opts.url) data.url = opts.url;
    postToHost('VIEWER_LOAD_FAILED', data);
}

/**
 * 把捕获的异常转成 VIEWER_LOAD_FAILED 出站。
 * @param err - 原始错误
 * @param fallbackStage - 未标注时的阶段
 * @param extra - 可选补充
 * @param extra.url - 失败资源 URL
 * @param extra.requestId - 本次加载请求 id
 */
export function postViewerLoadFailedFromError(
    err: unknown,
    fallbackStage: ViewerLoadStage,
    extra?: { url?: string; requestId?: string }
): void {
    const tagged = toViewerLoadError(err, fallbackStage, extra);
    console.error('[SuperSplat] VIEWER_LOAD_FAILED', tagged);
    postViewerLoadFailed({
        stage: tagged.stage,
        message: tagged.message,
        status: tagged.status,
        url: tagged.url ?? extra?.url,
        requestId: extra?.requestId
    });
}
