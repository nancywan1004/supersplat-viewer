import type { ExperienceSettings } from '../schemas/v2';
import {
    fetchLatestProjectFiles,
    fetchOriginalProjectFiles,
    type OriginalProjectFileEntry
} from '../universe/service';
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

const COLLISION_MESH_FILE = /\.collision\.glb$/i;

const trimUrl = (value: unknown): string | undefined => {
    if (typeof value !== 'string') {
        return undefined;
    }
    const trimmed = value.trim();
    return trimmed || undefined;
};

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

export function canGenerateCollision(global: Global): boolean {
    if (resolveCollisionUrl(global)) {
        return false;
    }
    const projectId = global.config.projectId;
    if (projectId == null || projectId === '') {
        return false;
    }
    return !!trimUrl(global.config.token);
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

export async function ensureCollisionUrl(global: Global): Promise<CollisionUrlResult> {
    const existing = resolveCollisionUrl(global);
    if (existing) {
        return { ok: true, url: existing.url };
    }

    if (!canGenerateCollision(global)) {
        return { ok: false, message: '缺少 projectId、token 或已配置碰撞 URL' };
    }

    const key = `${global.config.projectId ?? ''}:${global.config.token ?? ''}`;
    const inflight = inflightEnsure.get(key);
    if (inflight) {
        return inflight;
    }

    const promise = (async (): Promise<CollisionUrlResult> => {
        try {
            const projectId = global.config.projectId!;
            const token = global.config.token!;

            const listFiles = async (): Promise<OriginalProjectFileEntry[]> => {
                try {
                    return await fetchLatestProjectFiles(projectId);
                } catch (err) {
                    console.warn('[SceneCollision] latest project files failed, fallback to original:', err);
                    return fetchOriginalProjectFiles(projectId);
                }
            };

            const files = await listFiles();
            const fromProject = files.find((file) => {
                if (typeof file.fileName !== 'string' || typeof file.fileUrl !== 'string') {
                    return false;
                }
                const base = file.fileName.replace(/\\/g, '/').split('/').pop() ?? '';
                const isMesh = COLLISION_MESH_FILE.test(base) || /collision.*\.glb$/i.test(base);
                return isMesh && !!file.fileUrl.trim();
            })?.fileUrl.trim();

            if (fromProject) {
                setCollisionUrl(global, fromProject);
                return { ok: true, url: fromProject };
            }

            const generated = await generateCollisionMesh(projectId, token);
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
