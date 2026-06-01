import {
    collisionActive,
    collisionEnabled,
    getCameraCollisionManager
} from '../../collision/camera-collision-manager';
import { ensureSceneMeshForIntent } from '../../collision/scene-mesh-load-orchestrator';
import { resolveCollisionUrl, setCollisionUrl } from '../../collision/scene-collision-source';
import {
    patchSceneAssetCollisionRuntimeState,
    readSceneAssetCollisionRuntimeState,
    syncSceneAssetCollisionRuntime
} from '../../scene-assets/collision/scene-asset-collision';
import {
    normalizeSceneAssetCollisionScale,
    type SceneAssetCollisionScaleInput
} from '../../scene-assets/collision/scene-asset-collision-state';
import type { SceneCollisionSettingsPatch } from '../../schemas/v2-custom';
import type { Global } from '../../types';

export type SceneMeshLoadFinishedPayload = {
    module: 'camera';
    collisionUrl?: string;
};

export type SceneMeshLoadFailedPayload = {
    module: 'camera';
    collisionUrl?: string;
    message?: string;
};

export type CollisionSystemReadyPayload = {
    module: 'camera';
    enabled: boolean;
    active: boolean;
    collisionUrl?: string;
};

export type ShadowSystemReadyPayload = {
    module: 'camera';
    enabled: boolean;
    outputActive: boolean;
};

const collisionLoadErrorMessage = (error: unknown): string | undefined => {
    if (error === undefined) {
        return undefined;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
};

export function buildSceneMeshLoadFinishedPayload(global: Global): SceneMeshLoadFinishedPayload {
    const collisionUrl = resolveCollisionUrl(global)?.url;
    return {
        module: 'camera',
        ...(collisionUrl ? { collisionUrl } : {})
    };
}

export function buildSceneMeshLoadFailedPayload(
    global: Global,
    error?: unknown
): SceneMeshLoadFailedPayload {
    const collisionUrl = resolveCollisionUrl(global)?.url;
    const message = collisionLoadErrorMessage(error);
    return {
        module: 'camera',
        ...(collisionUrl ? { collisionUrl } : {}),
        ...(message ? { message } : {})
    };
}

export function buildCollisionSystemReadyPayload(global: Global): CollisionSystemReadyPayload {
    const collisionUrl = resolveCollisionUrl(global)?.url;
    return {
        module: 'camera',
        enabled: collisionEnabled(global),
        active: collisionActive(global),
        ...(collisionUrl ? { collisionUrl } : {})
    };
}

export function buildShadowSystemReadyPayload(
    global: Global,
    outputActive: boolean
): ShadowSystemReadyPayload {
    const shadow = global.settings.postEffectSettings?.shadow as { enabled?: boolean } | undefined;
    return {
        module: 'camera',
        enabled: shadow?.enabled !== false,
        outputActive
    };
}

export function applyCollisionEnabledFromHost(global: Global, enabled: boolean): void {
    getCameraCollisionManager(global).setEnabled(!!enabled);
}

export async function applyCollisionSetFromHost(global: Global, enabled: boolean): Promise<void> {
    if (!enabled) {
        applyCollisionEnabledFromHost(global, false);
        return;
    }

    const meshResult = await ensureSceneMeshForIntent(global, { wantCollision: true });
    if (meshResult.ok === false) {
        console.warn('[Collision] COLLISION_SET enable failed:', meshResult.message);
        return;
    }

    applyCollisionEnabledFromHost(global, true);
}

export async function applyCollisionPatchFromHost(
    global: Global,
    patch: SceneCollisionSettingsPatch
): Promise<void> {
    const enabling = patch.enabled === true;
    const urlChanging = typeof patch.url === 'string' && patch.url.trim().length > 0;

    if (urlChanging) {
        setCollisionUrl(global, patch.url!.trim());
    }

    const scaleInput: SceneAssetCollisionScaleInput | undefined = patch.scale;
    if (scaleInput !== undefined) {
        const current = readSceneAssetCollisionRuntimeState(global);
        patchSceneAssetCollisionRuntimeState(global, {
            scale: normalizeSceneAssetCollisionScale({ ...current.scale, ...scaleInput })
        });
        syncSceneAssetCollisionRuntime(global);
        global.events.fire('sceneAssetCollision:changed');
    }

    if (typeof patch.enabled === 'boolean') {
        if (patch.enabled) {
            await applyCollisionSetFromHost(global, true);
        } else {
            applyCollisionEnabledFromHost(global, false);
        }
        return;
    }

    if (enabling || urlChanging) {
        const meshResult = await ensureSceneMeshForIntent(global, { wantCollision: true });
        if (meshResult.ok === false) {
            console.warn('[Collision] COLLISION_PATCH mesh ensure failed:', meshResult.message);
        }
    }
}
