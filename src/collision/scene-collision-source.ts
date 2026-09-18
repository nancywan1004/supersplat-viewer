import { isEphemeralAssetUrl } from '../loaders/asset-file';
import type { ExperienceSettings } from '../schemas/v2';
import {
    ingestUserUploadFile,
    isUserUploadRelativePath,
    normalizeUserUploadRelativePath,
    rememberUserUploadFile,
    resolveUserUploadResourceUrl
} from '../settings-io/user-files';
import {
    DEFAULT_COLLISION_MESH_UPLOAD,
    generateCollisionMesh,
    VOXEL_COLLISION_JOBS_PATH,
    type CollisionJobProgress
} from '../universe/collision-mesh-service';
import { setUniverseAuthContext } from '../universe/service';
import type { Global } from '../types';
import type { SceneMeshLoadIntent } from './scene-mesh-load-intent';

export const SCENE_COLLISION_CHANGED = 'sceneCollision:changed';
/** Universe 转换任务排队/运行进度（出站 `SCENE_MESH_LOAD_PROGRESS`）。 */
export const SCENE_MESH_GENERATE_PROGRESS = 'sceneMesh:generateProgress';

/** 仅「本机页面 + internal 驱动方式」使用本机转换服务；其余（含线上）一律走云端 Universe。 */
const INTERNAL_COLLISION_API_BASE_URL = 'http://localhost:4001';

// 页面是否由本机访问（dev server / 本地联调）。SSR 或取不到 location 时视为非本机。
function isLocalHostPage(): boolean {
    if (typeof window === 'undefined' || !window.location) {
        return false;
    }
    const host = window.location.hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
}

// 是否走本机 4001 转换服务：要求**同时**满足
// 1. editUiTransport 为 internal（message-bridge 走云端；缺省按 internal 处理，与
//    src/ui/edit-ui-transport.ts 的归一化一致）；
// 2. 页面本身在本机。
//
// 只判 transport 是不够的：editUiTransport 的缺省值本就是 internal（见 src/index.html），
// 线上不带 ?editUiTransport=message-bridge 时同样命中，会把线上请求打到 localhost:4001。
function shouldUseLocalCollisionService(config: Global['config']): boolean {
    const transport = config.editUiTransport ?? 'internal';
    return transport !== 'message-bridge' && isLocalHostPage();
}

/** 本地 dev 反代端口（`scripts/proxy-server.js` / `npm run proxy`）。 */
const LOCAL_DEV_PROXY_PORT = 3001;

/** 反代可用性探测结果（一次会话只探一次）。 */
let collisionProxyProbe: Promise<boolean> | null = null;

/**
 * 探测某基址下是否挂着 `/conversion/**` 反向代理（线上 nginx / 本地 dev proxy）。
 *
 * 探针取一个不存在的 jobId：有反代时拿到的是网关或服务的 JSON 信封（`{` 开头），
 * 没反代时会命中 SPA 的 `try_files ... /index.html` 而拿到 HTML —— 以此区分。
 * 幂等 GET，不会创建转换任务；失败一律视为「没有反代」。
 */
function probeCollisionProxy(base: string): Promise<boolean> {
    if (!collisionProxyProbe) {
        collisionProxyProbe = fetch(`${base}${VOXEL_COLLISION_JOBS_PATH}/__probe__`)
            .then(async (response) => (await response.text()).trimStart().startsWith('{'))
            .catch(() => false);
    }
    return collisionProxyProbe;
}

/**
 * 反代基址（无需 URL 参数，按环境自动判定）：
 * - 本机页面 → 本地 dev proxy（`scripts/proxy-server.js`，端口与页面不同故跨域，
 *   但它的 CORS 只发一个 `Access-Control-Allow-Origin`，不会触发重复头问题）；
 * - 其余（线上 / 本地带 `?editUiTransport=message-bridge`）→ 页面自身域名
 *   （nginx `location /conversion/`，同源，见 `scripts/nginx-full-example.conf`）。
 * 非 http(s) 页面返回 undefined，直接回退平台域名。
 */
function resolveCollisionProxyBase(): string | undefined {
    if (typeof window === 'undefined' || !window.location) {
        return undefined;
    }
    const { protocol, hostname, origin } = window.location;
    if (protocol !== 'http:' && protocol !== 'https:') {
        return undefined;
    }
    return isLocalHostPage() ? `${protocol}//${hostname}:${LOCAL_DEV_PROXY_PORT}` : origin;
}

/**
 * 碰撞接口的调用方式：基址 + 是否登记项目文件（`upload`）。
 *
 * 基址优先级：本机转换服务（不经网关）→ 探测到的反代 → 平台域名（历史行为，兜底）。
 * 反代能让取 GLB 的请求变成同源/单值 CORS，绕开网关 `Access-Control-Allow-Origin`
 * 重复值导致的 `TypeError: Failed to fetch`。
 */
async function resolveCollisionEndpoint(config: Global['config']): Promise<{
    apiBaseUrl?: string;
    upload: boolean;
}> {
    if (shouldUseLocalCollisionService(config)) {
        // 本机转换服务：不登记项目文件，GLB 由任务级端点直出
        return { apiBaseUrl: INTERNAL_COLLISION_API_BASE_URL, upload: false };
    }

    const proxyBase = resolveCollisionProxyBase();
    if (proxyBase && await probeCollisionProxy(proxyBase)) {
        console.info(`[CollisionProxy] 碰撞接口走反代 ${proxyBase}`);
        return { apiBaseUrl: proxyBase, upload: DEFAULT_COLLISION_MESH_UPLOAD };
    }

    return { upload: DEFAULT_COLLISION_MESH_UPLOAD };
}

export type SceneMeshGenerateProgressPayload = CollisionJobProgress & {
    intent?: SceneMeshLoadIntent;
};

/** 会话表 / 相对路径稳定 id，便于重新生成时覆盖同一文件。 */
const COLLISION_FILE_ID = 'scene-collision';
const COLLISION_FILE_NAME = 'collision.glb';

export type CollisionUrlSource = 'settings' | 'config';

export type CollisionUrlResolved = {
    url: string;
    source: CollisionUrlSource;
};

export type CollisionUrlResult =
    | { ok: true; url: string }
    | { ok: false; message: string };

const trimUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
};

/** 已有碰撞资源：URL 参数 `?collision=` / `?voxel=` 优先于 settings.collision.url。 */
export function resolveCollisionUrl(global: Global): CollisionUrlResolved | undefined {
    const fromConfig = trimUrl(global.config.collisionUrl);
    if (fromConfig) {
        return { url: fromConfig, source: 'config' };
    }

    const fromSettings = trimUrl((global.settings as ExperienceSettings).collision?.url);
    if (fromSettings) {
        return { url: fromSettings, source: 'settings' };
    }

    return undefined;
}

/**
 * 加载用 URL：相对路径走会话表 / settings.json 基址；绝对 http(s) 原样（本地开发会套代理）。
 */
export function resolveCollisionFetchUrl(global: Global, stored?: string): string | undefined {
    const raw = trimUrl(stored) ?? resolveCollisionUrl(global)?.url;
    if (!raw) return undefined;
    return resolveUserUploadResourceUrl(global, raw) ?? undefined;
}

/**
 * 转成服务端可 fetch 的绝对 http(s) 地址。
 *
 * 相对路径（如默认 `./scene.sog`、项目包内 `content/x.sog`）按页面基址绝对化——
 * 转换服务在服务端，相对地址它无从解析。
 * `blob:` / `data:`（本地导入的 File）返回 undefined：字节只在浏览器里，服务端取不到。
 *
 * @param value - 原始 contentUrl（相对路径 / blob: / data: / 绝对 http(s) 均可）
 * @returns 可用的绝对 http(s) 地址；不可用时 undefined
 */
function toServiceFetchableUrl(value: string | undefined): string | undefined {
    if (!value) {
        return undefined;
    }
    const trimmed = value.trim();
    if (!trimmed || isEphemeralAssetUrl(trimmed)) {
        return undefined;
    }
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    try {
        return new URL(trimmed, typeof location !== 'undefined' ? location.href : undefined).href;
    } catch {
        return undefined;
    }
}

/** 主场景 modelUrl，供 `POST /conversion/voxel-collision/jobs` 使用；不可用时返回 undefined。 */
export function resolveModelUrlForVoxelCollision(global: Global): string | undefined {
    return toServiceFetchableUrl(trimUrl(global.config.contentUrl));
}

/**
 * 主场景是否为浏览器本地文件（`blob:` / `data:`）——服务端无法读取。
 *
 * @param global - Viewer 全局上下文
 * @returns 是本地文件时为 true
 */
export function isLocalContentAsset(global: Global): boolean {
    return isEphemeralAssetUrl(global.config.contentUrl);
}

/**
 * 无法生成碰撞网格时的原因文案；可生成时返回 undefined。
 * 用于「缺少 collision URL」这类笼统报错的补充，避免 blob: / 相对路径场景排查困难。
 *
 * @param global - Viewer 全局上下文
 * @returns 原因文案；可生成时为 undefined
 */
export function describeCollisionGenerateBlocker(global: Global): string | undefined {
    if (isLocalContentAsset(global)) {
        return '主场景是本地文件，转换服务无法读取';
    }
    if (!resolveModelUrlForVoxelCollision(global)) {
        return '缺少可访问的主场景 content 地址';
    }
    return undefined;
}

/**
 * 是否具备生成条件：**只需 contentUrl**。
 *
 * 凭证要求分两层，别混：
 * - **服务端**（`parseConvertRequest`）只在 `upload: true` 时校验 projectId 与 Authorization；
 * - **网关**对 `/conversion` 下每个请求（提交 / 轮询 / 取 GLB）都要 `Authorization`，
 *   与 `upload` 取值无关；`projectId` 则不需要（本机 4001 直连两者都不校验）。
 *
 * 所以这里只判 contentUrl，缺什么由 `describeCollisionGenerateBlocker` 说明。
 */
export function hasCollisionGenerateCredentials(global: Global): boolean {
    return !!resolveModelUrlForVoxelCollision(global);
}

/** 无现成 collision URL 时，是否具备 Universe 生成条件。 */
export function canGenerateCollision(global: Global): boolean {
    if (resolveCollisionUrl(global)) {
        return false;
    }
    return hasCollisionGenerateCredentials(global);
}

export function setCollisionUrl(global: Global, url: string): void {
    const trimmed = url.trim();
    if (!trimmed) {
        return;
    }

    const settings = global.settings as ExperienceSettings;
    settings.collision = { ...settings.collision, url: trimmed };
    global.events.fire(SCENE_COLLISION_CHANGED);
}

/** 把转换得到的 GLB 写入会话表，settings 写成相对路径；不在此时上传。 */
function ingestGeneratedCollisionGlb(global: Global, blob: Blob): string {
    const file = blob instanceof File && blob.name
        ? blob
        : new File([blob], COLLISION_FILE_NAME, { type: blob.type || 'model/gltf-binary' });
    const existing = trimUrl((global.settings as ExperienceSettings).collision?.url);
    if (existing && isUserUploadRelativePath(existing)) {
        const path = normalizeUserUploadRelativePath(existing);
        rememberUserUploadFile(global, path, file);
        return path;
    }
    return ingestUserUploadFile(global, file, {
        id: COLLISION_FILE_ID,
        fallbackName: COLLISION_FILE_NAME
    });
}

const inflightEnsure = new Map<string, Promise<CollisionUrlResult>>();

export type EnsureCollisionUrlOptions = {
    /** 忽略已有 URL，强制走 Universe 重新生成（用于旧地址不可访问时）。 */
    forceRegenerate?: boolean;
    /** 出站 `SCENE_MESH_LOAD_PROGRESS` 的 module 分流。 */
    intent?: SceneMeshLoadIntent;
};

/**
 * 确保 collision URL 可用：已有 URL 参数 / settings 则直接返回；
 * 否则用 `contentUrl` 调 `voxel-collision/jobs` 并轮询，成功后 GLB 写会话表（返回相对路径）。
 * 基址与 `upload` 由 {@link resolveCollisionEndpoint} 决定：本机（localhost + internal）指向
 * 本机转换服务；其余自动探测 `/conversion/**` 反代，探不到则回退平台网关 + `upload: false`。
 * `forceRegenerate` 时即使已有 URL 也会重新生成并写回。
 */
export async function ensureCollisionUrl(
    global: Global,
    options?: EnsureCollisionUrlOptions
): Promise<CollisionUrlResult> {
    const forceRegenerate = options?.forceRegenerate === true;
    const existing = resolveCollisionUrl(global);
    if (existing && !forceRegenerate) {
        return { ok: true, url: existing.url };
    }

    if (!hasCollisionGenerateCredentials(global)) {
        if (existing && !forceRegenerate) {
            return { ok: true, url: existing.url };
        }
        const blocker = describeCollisionGenerateBlocker(global);
        const head = forceRegenerate ? 'collision URL 不可用，且无法重新生成' : '缺少 collision URL，且无法生成';
        const reason = blocker ?? '需主场景 content 地址';
        return { ok: false, message: `${head}（${reason}）` };
    }

    const modelUrl = resolveModelUrlForVoxelCollision(global)!;
    const token = global.config.token?.trim() ?? '';
    const projectId = global.config.projectId;
    const key = `${forceRegenerate ? 'regen:' : ''}${projectId ?? ''}:${token}:${modelUrl}`;
    const inflight = inflightEnsure.get(key);
    if (inflight) {
        return inflight;
    }

    const promise = (async (): Promise<CollisionUrlResult> => {
        try {
            setUniverseAuthContext({ token });

            const generated = await generateCollisionMesh(modelUrl, token, {
                ...(await resolveCollisionEndpoint(global.config)),
                projectId,
                onProgress: (progress) => {
                    global.events.fire(SCENE_MESH_GENERATE_PROGRESS, {
                        ...progress,
                        intent: options?.intent
                    } satisfies SceneMeshGenerateProgressPayload);
                }
            });
            if (generated.ok === false) {
                return { ok: false, message: generated.message };
            }

            if ('blob' in generated) {
                const relativePath = ingestGeneratedCollisionGlb(global, generated.blob);
                setCollisionUrl(global, relativePath);
                return { ok: true, url: relativePath };
            }

            setCollisionUrl(global, generated.fileUrl);
            return { ok: true, url: generated.fileUrl };
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.error('[SceneCollision] ensureCollisionUrl failed:', error);
            return { ok: false, message };
        }
    })();

    inflightEnsure.set(key, promise);
    try {
        return await promise;
    } finally {
        inflightEnsure.delete(key);
    }
}
