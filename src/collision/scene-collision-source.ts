import type { ExperienceSettings } from '../schemas/v2';
import { setUniverseAuthContext } from '../universe/service';
import { generateCollisionMesh } from '../universe/collision-mesh-service';
import type { Global } from '../types';

export const SCENE_COLLISION_CHANGED = 'sceneCollision:changed';

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

/** 已有碰撞资源：settings.collision.url 或 URL 参数 `?collision=` / `?voxel=`。 */
export function resolveCollisionUrl(global: Global): CollisionUrlResolved | undefined {
    const fromSettings = trimUrl((global.settings as ExperienceSettings).collision?.url);
    if (fromSettings) {
        return { url: fromSettings, source: 'settings' };
    }

    const fromConfig = trimUrl(global.config.collisionUrl);
    if (fromConfig) {
        return { url: fromConfig, source: 'config' };
    }

    return undefined;
}

/** 高斯 modelUrl，供 `POST /conversion/voxel-collision` 使用。 */
export function resolveModelUrlForVoxelCollision(global: Global): string | undefined {
    return trimUrl(global.config.contentUrl);
}

/** 是否具备 Universe 生成凭证（projectId + token + contentUrl），与是否已有 URL 无关。 */
export function hasCollisionGenerateCredentials(global: Global): boolean {
    const projectId = global.config.projectId;
    if (projectId == null || projectId === '') {
        return false;
    }
    if (!trimUrl(global.config.token)) {
        return false;
    }
    return !!resolveModelUrlForVoxelCollision(global);
}

/** 无现成 collision URL 时，是否具备 Universe 生成条件（projectId + token + contentUrl）。 */
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

const inflightEnsure = new Map<string, Promise<CollisionUrlResult>>();

export type EnsureCollisionUrlOptions = {
    /** 忽略已有 URL，强制走 Universe 重新生成（用于旧地址不可访问时）。 */
    forceRegenerate?: boolean;
};

/**
 * 确保 `settings.collision.url` 可用：已有 settings / URL 参数则直接返回；
 * 否则用 `contentUrl` 调 Universe `voxel-collision` 生成 GLB（不拉项目文件列表）。
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
    const key = `${forceRegenerate ? 'regen:' : ''}${global.config.projectId ?? ''}:${global.config.token ?? ''}:${modelUrl}`;
    const inflight = inflightEnsure.get(key);
    if (inflight) {
        return inflight;
    }

    const promise = (async (): Promise<CollisionUrlResult> => {
        try {
            const projectId = global.config.projectId!;
            const token = global.config.token!;
            setUniverseAuthContext({ token });

            const generated = await generateCollisionMesh(projectId, token, modelUrl);
            if (generated.ok === false) {
                return { ok: false, message: generated.message };
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
