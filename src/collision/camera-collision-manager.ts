import type { Entity } from 'playcanvas';

import type { Collision } from './collision';
import { loadVoxelCollision } from './voxel-collision';
import {
    isGlbUrl,
    loadSceneMesh,
    resolveSceneMeshUrl
} from '../loaders/scene-mesh-loader';
import {
    isCameraCollisionEditContextActive,
    isCameraCollisionRuntimeActive,
    readSceneAssetCollisionEnabled
} from './camera-collision-gate';
import {
    patchSceneAssetCollisionRuntimeState,
    SCENE_ASSET_COLLISION_APPLY_RUNTIME_STATE
} from '../scene-assets/collision/scene-asset-collision-state';
import { isShadowSystemEnabled } from '../vfx/shadow/shadow-policy';
import type { Global } from '../types';

/** 将门控后的 urlParam 碰撞写入 walk / fly / input / nav */
export type CameraCollisionConsumers = {
    applyUrlCollision: (collision: Collision | null) => void;
};

/** `cameraCollision:load` 载荷：urlParam 场景 mesh / voxel 懒加载状态 */
export type CollisionLoadState = 'idle' | 'loading' | 'ready' | 'failed';

export type CollisionLoadPayload = {
    state: CollisionLoadState;
    error?: unknown;
};

export type SceneMeshReadyPayload = {
    meshEntity: Entity;
};

/**
 * 相机物理碰撞 + 场景 GLB（阴影接影与 collision 共用 mesh）统一调度。
 */
export class CameraCollisionManager {
    private urlCollision: Collision | null = null;

    private meshEntity: Entity | null = null;

    private collisionUrl: string | undefined;

    private loadState: CollisionLoadState = 'idle';

    private loadPromise: Promise<void> | null = null;

    private consumers: CameraCollisionConsumers | null = null;

    private started = false;

    private readonly onContextOrToggleChanged = () => {
        this.syncConsumers();
        void this.maybeEnsureSceneMeshResourcesLoaded();
    };

    constructor(private readonly global: Global) {}

    /** 登记 urlParam（不触发下载） */
    configure(opts: { collisionUrl?: string }): void {
        const collision = typeof opts.collisionUrl === 'string' ? opts.collisionUrl.trim() : '';
        this.collisionUrl = collision || undefined;
        if (this.collisionUrl) {
            this.global.state.hasCollision = true;
        }
    }

    getCollisionUrl(): string | undefined {
        return this.collisionUrl;
    }

    getSceneMeshUrl(): string | undefined {
        return resolveSceneMeshUrl(this.collisionUrl);
    }

    getLoadState(): CollisionLoadState {
        return this.loadState;
    }

    getShadowMeshEntity(): Entity | null {
        return this.meshEntity;
    }

    readEnabled(): boolean {
        return readSceneAssetCollisionEnabled(this.global);
    }

    isEditContextActive(): boolean {
        return isCameraCollisionEditContextActive(this.global);
    }

    isRuntimeActive(): boolean {
        return isCameraCollisionRuntimeActive(this.global);
    }

    setEnabled(enabled: boolean): void {
        patchSceneAssetCollisionRuntimeState(this.global, { enabled: !!enabled });
        this.global.events.fire(SCENE_ASSET_COLLISION_APPLY_RUNTIME_STATE);
        this.global.events.fire('cameraCollision:changed');
        this.global.events.fire('sceneAssetCollision:changed');
        void this.maybeEnsureSceneMeshResourcesLoaded();
    }

    /** @deprecated 使用 ensureSceneMeshResourcesLoaded */
    ensureUrlCollisionLoaded(): Promise<void> {
        return this.ensureSceneMeshResourcesLoaded();
    }

    /**
     * 按需加载：GLB（接影 + MeshCollision 单次请求）、voxel 碰撞包。
     * 触发条件：物理碰撞总开关且 Viewer/预览，或阴影系统已开启且存在 GLB URL。
     */
    async ensureSceneMeshResourcesLoaded(): Promise<void> {
        if (!this.shouldLoadSceneResources()) {
            return;
        }
        if (this.loadState === 'ready' && this.isLoadSatisfied()) {
            return;
        }
        if (this.loadState === 'loading' && this.loadPromise) {
            return this.loadPromise;
        }
        if (this.loadState === 'failed') {
            this.loadState = 'idle';
        }

        const plan = this.buildLoadPlan();
        if (!plan.loadGlb && !plan.loadVoxel) {
            return;
        }

        this.loadState = 'loading';
        this.emitLoadState('loading');
        this.syncConsumers();

        const { app } = this.global;
        this.loadPromise = (async () => {
            let glbOk = !plan.loadGlb;
            let voxelOk = !plan.loadVoxel;

            try {
                if (plan.loadGlb && plan.glbUrl) {
                    const result = await loadSceneMesh(app, plan.glbUrl);
                    if (result) {
                        this.meshEntity = result.meshEntity;
                        if (plan.applyGlbCollision) {
                            this.urlCollision = result.meshCollision;
                        }
                        this.global.events.fire('sceneMesh:ready', {
                            meshEntity: result.meshEntity
                        } satisfies SceneMeshReadyPayload);
                        glbOk = true;
                    } else {
                        glbOk = false;
                    }
                }

                if (plan.loadVoxel && this.collisionUrl) {
                    const voxel = await loadVoxelCollision(this.collisionUrl);
                    if (voxel) {
                        this.urlCollision = voxel;
                        voxelOk = true;
                    } else {
                        voxelOk = false;
                    }
                }

                if (glbOk && voxelOk) {
                    this.loadState = 'ready';
                    this.emitLoadState('ready');
                } else {
                    this.loadState = 'failed';
                    this.emitLoadState('failed');
                }
                this.syncConsumers();
            } catch (err) {
                this.loadState = 'failed';
                this.emitLoadState('failed', err);
                this.syncConsumers();
            } finally {
                this.loadPromise = null;
            }
        })();

        return this.loadPromise;
    }

    private buildLoadPlan(): {
        glbUrl?: string;
        loadGlb: boolean;
        loadVoxel: boolean;
        applyGlbCollision: boolean;
    } {
        const glbUrl = resolveSceneMeshUrl(this.collisionUrl);
        const needCollision = !!this.collisionUrl && this.isRuntimeActive();
        const needShadowGlb = isShadowSystemEnabled(this.global) && !!glbUrl;
        const collisionIsGlb = !!this.collisionUrl && isGlbUrl(this.collisionUrl);
        const collisionIsVoxel = !!this.collisionUrl && !collisionIsGlb;

        const loadGlb = !!glbUrl && (needShadowGlb || (needCollision && collisionIsGlb));
        const loadVoxel = needCollision && collisionIsVoxel;
        const applyGlbCollision = needCollision && collisionIsGlb;

        return { glbUrl, loadGlb, loadVoxel, applyGlbCollision };
    }

    private isLoadSatisfied(): boolean {
        const plan = this.buildLoadPlan();
        if (plan.loadGlb && !this.meshEntity) {
            return false;
        }
        if (plan.applyGlbCollision && !this.urlCollision) {
            return false;
        }
        if (plan.loadVoxel && !this.urlCollision) {
            return false;
        }
        return true;
    }

    private shouldLoadSceneResources(): boolean {
        const glbUrl = resolveSceneMeshUrl(this.collisionUrl);
        const needCollision = !!this.collisionUrl && this.isRuntimeActive();
        const needShadowGlb = isShadowSystemEnabled(this.global) && !!glbUrl;
        return needCollision || needShadowGlb;
    }

    private maybeEnsureSceneMeshResourcesLoaded(): void {
        if (!this.shouldLoadSceneResources()) {
            return;
        }
        void this.ensureSceneMeshResourcesLoaded();
    }

    private emitLoadState(state: CollisionLoadState, error?: unknown): void {
        const payload: CollisionLoadPayload = error !== undefined ? { state, error } : { state };
        this.global.events.fire('cameraCollision:load', payload);
    }

    setUrlCollisionSource(collision: Collision | null): void {
        this.urlCollision = collision;
        this.loadState = collision ? 'ready' : this.collisionUrl ? this.loadState : 'idle';
        this.syncConsumers();
        if (collision) {
            this.emitLoadState('ready');
        }
    }

    getUrlCollisionSource(): Collision | null {
        return this.urlCollision;
    }

    resolveActiveUrlCollision(): Collision | null {
        if (this.loadState !== 'ready' || !this.urlCollision) {
            return null;
        }
        if (!this.isRuntimeActive()) {
            return null;
        }
        return this.urlCollision;
    }

    attachConsumers(consumers: CameraCollisionConsumers): void {
        this.consumers = consumers;
        this.syncConsumers();
    }

    syncConsumers(): void {
        this.consumers?.applyUrlCollision(this.resolveActiveUrlCollision());
    }

    start(): () => void {
        if (this.started) {
            return () => this.stop();
        }
        this.started = true;
        const { events } = this.global;
        events.on('editMode:changed', this.onContextOrToggleChanged);
        events.on('previewMode:changed', this.onContextOrToggleChanged);
        events.on('cameraCollision:changed', this.onContextOrToggleChanged);
        events.on('postEffect:changed', this.onContextOrToggleChanged);
        this.syncConsumers();
        void this.maybeEnsureSceneMeshResourcesLoaded();
        return () => this.stop();
    }

    stop(): void {
        if (!this.started) return;
        this.started = false;
        const { events } = this.global;
        events.off('editMode:changed', this.onContextOrToggleChanged);
        events.off('previewMode:changed', this.onContextOrToggleChanged);
        events.off('cameraCollision:changed', this.onContextOrToggleChanged);
        events.off('postEffect:changed', this.onContextOrToggleChanged);
    }
}

const MANAGER_KEY = '__cameraCollisionManager';

export function getCameraCollisionManager(global: Global): CameraCollisionManager {
    const g = global as Global & { [MANAGER_KEY]?: CameraCollisionManager };
    if (!g[MANAGER_KEY]) {
        g[MANAGER_KEY] = new CameraCollisionManager(global);
    }
    return g[MANAGER_KEY];
}
