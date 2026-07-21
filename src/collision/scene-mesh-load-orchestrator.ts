import {
    canGenerateCollision,
    ensureCollisionUrl,
    resolveCollisionUrl
} from './scene-collision-source';
import {
    collisionEnabled,
    getCameraCollisionManager
} from './camera-collision-manager';
import type { SceneMeshLoadIntent } from './scene-mesh-load-intent';
import { hasShadowSceneMesh } from '../vfx/shadow/shadow-policy';
import type { Global } from '../types';

export type SceneMeshEnsureResult =
    | { ok: true }
    | { ok: false; message: string };

const ensureCollisionUrlIfNeeded = async (
    global: Global,
    intent: SceneMeshLoadIntent
): Promise<SceneMeshEnsureResult> => {
    if (resolveCollisionUrl(global)) {
        return { ok: true };
    }
    const needsUrl = intent.wantShadow === true || intent.wantCollision === true;
    if (!needsUrl) {
        return { ok: true };
    }
    if (!canGenerateCollision(global)) {
        return { ok: false, message: '缺少 collision URL，且无法从项目生成' };
    }
    const urlResult = await ensureCollisionUrl(global);
    if (urlResult.ok === false) {
        return { ok: false, message: urlResult.message };
    }
    return { ok: true };
};

/** 在开启 collision / shadow 前确保 scene mesh（及 voxel）资源已加载。 */
export const ensureSceneMeshForIntent = async (
    global: Global,
    intent: SceneMeshLoadIntent
): Promise<SceneMeshEnsureResult> => {
    if (!intent.wantCollision && !intent.wantShadow) {
        return { ok: true };
    }

    if (intent.wantShadow && !hasShadowSceneMesh(global)) {
        const urlResult = await ensureCollisionUrlIfNeeded(global, { wantShadow: true });
        if (!urlResult.ok) {
            return urlResult;
        }
        if (!hasShadowSceneMesh(global)) {
            return { ok: false, message: '阴影需要 scene mesh GLB，但当前无可用 collision URL' };
        }
    }

    const urlResult = await ensureCollisionUrlIfNeeded(global, intent);
    if (!urlResult.ok) {
        return urlResult;
    }

    const mgr = getCameraCollisionManager(global);
    if (!mgr.needsSceneMeshLoad(intent)) {
        // needs=false 可能是「空 plan 被误判满足」或「完全无能力加载」；按 intent 再验资源
        if (intent.wantCollision && !mgr.getCollision()) {
            return { ok: false, message: 'collision 资源未就绪' };
        }
        if (intent.wantShadow && !mgr.getSceneMeshEntity()) {
            return { ok: false, message: 'scene mesh 未就绪' };
        }
        return { ok: true };
    }

    await mgr.ensureSceneMeshLoaded(intent);
    if (mgr.getLoadState() === 'failed') {
        return { ok: false, message: 'scene mesh 加载失败' };
    }
    if (mgr.needsSceneMeshLoad(intent)) {
        return { ok: false, message: 'scene mesh 未就绪' };
    }
    if (intent.wantCollision && !mgr.getCollision()) {
        return { ok: false, message: 'collision 资源未就绪' };
    }
    if (intent.wantShadow && !mgr.getSceneMeshEntity()) {
        return { ok: false, message: 'scene mesh 未就绪' };
    }
    return { ok: true };
};
