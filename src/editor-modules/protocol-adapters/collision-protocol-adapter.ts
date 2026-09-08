import { collisionEnabled, getCameraCollisionManager } from '../../collision/camera-collision-manager';
import type { SceneMeshLoadIntent } from '../../collision/scene-mesh-load-intent';
import { ensureSceneMeshForIntent } from '../../collision/scene-mesh-load-orchestrator';
import { isShadowSystemEnabled } from '../../vfx/shadow/shadow-policy';
import { MESSAGE_BRIDGE_MODULE } from '../modules-types';
import {
    resolveCollisionUrl,
    setCollisionUrl,
    type SceneMeshGenerateProgressPayload
} from '../../collision/scene-collision-source';
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

export type SceneMeshLoadBridgeModule =
    | typeof MESSAGE_BRIDGE_MODULE.camera
    | typeof MESSAGE_BRIDGE_MODULE.environment;

export type SceneMeshLoadFinishedPayload = {
    module: SceneMeshLoadBridgeModule;
    collisionUrl?: string;
};

export type SceneMeshLoadFailedPayload = {
    module: SceneMeshLoadBridgeModule;
    collisionUrl?: string;
    message?: string;
};

export type SceneMeshLoadProgressPayload = {
    module: SceneMeshLoadBridgeModule;
    jobId: string;
    status: 'queued' | 'running';
    queuePosition: number;
    queuedMs: number;
    runningElapsedMs: number;
    elapsedMs: number;
    timeoutMs: number;
    etaMs: number;
    /** 0–100 估算，不是 GPU 真实百分比。 */
    progress: number;
};

/** 按加载 intent 决定出站 `module`；双 intent 时返回两项，由 message-bridge 各发一条。 */
export function resolveSceneMeshLoadOutboundModules(
    global: Global,
    intent?: SceneMeshLoadIntent
): SceneMeshLoadBridgeModule[] {
    const hasExplicitIntent = intent?.wantCollision === true || intent?.wantShadow === true;
    const wantCollision = hasExplicitIntent
        ? intent?.wantCollision === true
        : collisionEnabled(global);
    const wantShadow = hasExplicitIntent
        ? intent?.wantShadow === true
        : isShadowSystemEnabled(global);
    const modules: SceneMeshLoadBridgeModule[] = [];
    if (wantCollision) {
        modules.push(MESSAGE_BRIDGE_MODULE.camera);
    }
    if (wantShadow) {
        modules.push(MESSAGE_BRIDGE_MODULE.environment);
    }
    if (modules.length === 0) {
        modules.push(MESSAGE_BRIDGE_MODULE.camera);
    }
    return modules;
}

const collisionLoadErrorMessage = (error: unknown): string | undefined => {
    if (error === undefined) {
        return undefined;
    }
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
};

export function buildSceneMeshLoadFinishedPayload(
    global: Global,
    module: SceneMeshLoadBridgeModule
): SceneMeshLoadFinishedPayload {
    const collisionUrl = resolveCollisionUrl(global)?.url;
    return {
        module,
        ...(collisionUrl ? { collisionUrl } : {})
    };
}

export function buildSceneMeshLoadFailedPayload(
    global: Global,
    module: SceneMeshLoadBridgeModule,
    error?: unknown
): SceneMeshLoadFailedPayload {
    const collisionUrl = resolveCollisionUrl(global)?.url;
    const message = collisionLoadErrorMessage(error);
    return {
        module,
        ...(collisionUrl ? { collisionUrl } : {}),
        ...(message ? { message } : {})
    };
}

export function buildSceneMeshLoadProgressPayload(
    module: SceneMeshLoadBridgeModule,
    payload: SceneMeshGenerateProgressPayload
): SceneMeshLoadProgressPayload {
    return {
        module,
        jobId: payload.jobId,
        status: payload.status,
        queuePosition: payload.queuePosition,
        queuedMs: payload.queuedMs,
        runningElapsedMs: payload.runningElapsedMs,
        elapsedMs: payload.elapsedMs,
        timeoutMs: payload.timeoutMs,
        etaMs: payload.etaMs,
        progress: payload.progress
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
