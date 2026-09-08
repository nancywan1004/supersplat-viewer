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
    type CollisionJobProgress
} from '../universe/collision-mesh-service';
import { setUniverseAuthContext } from '../universe/service';
import type { Global } from '../types';
import type { SceneMeshLoadIntent } from './scene-mesh-load-intent';

export const SCENE_COLLISION_CHANGED = 'sceneCollision:changed';
/** Universe 转换任务排队/运行进度（出站 `SCENE_MESH_LOAD_PROGRESS`）。 */
export const SCENE_MESH_GENERATE_PROGRESS = 'sceneMesh:generateProgress';

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

/** 高斯 modelUrl，供 `POST /conversion/voxel-collision/jobs` 使用。 */
export function resolveModelUrlForVoxelCollision(global: Global): string | undefined {
    return trimUrl(global.config.contentUrl);
}

/** 是否具备生成凭证（projectId + token + contentUrl）。`upload: false` 时 projectId 仍用于网关鉴权。 */
export function hasCollisionGenerateCredentials(global: Global): boolean {
    if (!trimUrl(global.config.token)) {
        return false;
    }
    if (!resolveModelUrlForVoxelCollision(global)) {
        return false;
    }
    const projectId = global.config.projectId;
    if (projectId == null || projectId === '') {
        return false;
    }
    return Number.isFinite(Number(projectId));
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
 * 否则用 `contentUrl` 调 Universe `voxel-collision/jobs` 并轮询。默认 `{ projectId, upload: false }`：
 * 鉴权带项目 ID，文件不登记到项目。GLB 写入会话表；若下载失败则写返回的 `data.url`。
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
        return {
            ok: false,
            message: forceRegenerate
                ? 'collision URL 不可用，且无法重新生成（需 projectId、token、contentUrl）'
                : '缺少 collision URL，且无法生成（需 projectId、token、contentUrl）'
        };
    }

    const modelUrl = resolveModelUrlForVoxelCollision(global)!;
    const token = global.config.token!;
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
                upload: DEFAULT_COLLISION_MESH_UPLOAD,
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
