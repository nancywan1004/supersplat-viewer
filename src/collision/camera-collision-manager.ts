import type { Entity } from 'playcanvas';

import type { Collision } from './collision';
import { loadVoxelCollision } from './voxel-collision';
import { isSceneMeshGlbUrl, loadSceneMesh, sceneMeshUrl } from '../loaders/gltf/scene-mesh-loader';
import {
    canGenerateCollision,
    ensureCollisionUrl,
    hasCollisionGenerateCredentials,
    resolveCollisionUrl,
    SCENE_COLLISION_CHANGED
} from './scene-collision-source';
import {
    patchSceneAssetCollisionRuntimeState,
    SCENE_ASSET_COLLISION_APPLY_RUNTIME_STATE
} from '../scene-assets/collision/scene-asset-collision-state';
import { isShadowSystemEnabled } from '../vfx/shadow/shadow-policy';
import type { SceneMeshLoadIntent } from './scene-mesh-load-intent';
import type { ExperienceSettings } from '../schemas/v2';
import type { Global } from '../types';

/** Viewer 内部事件；出站协议名为 `COLLISION_SYSTEM_READY`（见 message-bridge）。 */
export const COLLISION_SYSTEM_READY = 'collisionSystem:ready';

/** 将门控后的 collision 写入 walk / fly / input / nav */
export type CameraCollisionConsumers = {
    applyUrlCollision: (collision: Collision | null) => void;
};

export type CollisionLoadState = 'idle' | 'loading' | 'ready' | 'failed';

export type CollisionLoadPayload = {
    state: CollisionLoadState;
    error?: unknown;
    /** `ready` / `failed` 时携带，供出站按 collision / shadow intent 选择 `module`。 */
    intent?: SceneMeshLoadIntent;
};

export type SceneMeshReadyPayload = {
    sceneMeshEntity: Entity;
};

/** 物理碰撞总开关（`settings.collision.enabled` → runtime state） */
export function collisionEnabled(global: Global): boolean {
    return global.state.sceneAssetCollisionRuntimeState?.enabled === true;
}

function collisionContext(global: Global): boolean {
    const { state } = global;
    if (!state.editMode) {
        return true;
    }
    return state.previewMode === true;
}

/** 总开关 + 可挡相机上下文 */
export function collisionActive(global: Global): boolean {
    return collisionEnabled(global) && collisionContext(global);
}

/**
 * 相机 collision + scene mesh（GLB 接影与 mesh 物理碰撞同源）统一调度。
 */
export class CameraCollisionManager {
    private urlCollision: Collision | null = null;

    private sceneMeshEntity: Entity | null = null;

    /** GLB 加载时缓存的物理网体；与是否立刻 apply 解耦（shadow 先载、collision 后开可直接挂上）。 */
    private meshCollisionCache: Collision | null = null;

    private loadState: CollisionLoadState = 'idle';

    private loadPromise: Promise<void> | null = null;

    /** 当前或最近一次 in-flight scene mesh 加载所合并的 intent（出站用 / 实际加载 plan）。 */
    private activeLoadIntent: SceneMeshLoadIntent | null = null;

    private consumers: CameraCollisionConsumers | null = null;

    private started = false;

    private readonly onContextOrToggleChanged = () => {
        this.syncConsumers();
        this.scheduleSceneMeshLoad();
    };

    constructor(private readonly global: Global) {}

    configure(): void {
        this.syncHasCollision();
    }

    /** URL 参数 / settings 解析出的 collision 资源（GLB 或 voxel 包；参数优先） */
    getCollisionUrl(): string | undefined {
        return resolveCollisionUrl(this.global)?.url;
    }

    private syncHasCollision(): void {
        this.global.state.hasCollision =
            !!resolveCollisionUrl(this.global) || canGenerateCollision(this.global);
    }

    getLoadState(): CollisionLoadState {
        return this.loadState;
    }

    getSceneMeshEntity(): Entity | null {
        return this.sceneMeshEntity;
    }

    setEnabled(enabled: boolean): void {
        patchSceneAssetCollisionRuntimeState(this.global, { enabled: !!enabled });
        const settings = this.global.settings as ExperienceSettings;
        if (!settings.collision) settings.collision = {};
        settings.collision.enabled = !!enabled;
        this.global.events.fire(SCENE_ASSET_COLLISION_APPLY_RUNTIME_STATE);
        this.global.events.fire('cameraCollision:changed');
        this.global.events.fire('sceneAssetCollision:changed');
        this.scheduleSceneMeshLoad();
        if (enabled) {
            this.syncConsumers();
            if (this.isSceneMeshReady({ wantCollision: true })) {
                this.emitCollisionSystemReadyIfApplicable();
            }
        }
    }

    isSceneMeshReady(intent?: SceneMeshLoadIntent): boolean {
        if (this.loadState !== 'ready') {
            return false;
        }
        return this.isLoadSatisfied(intent);
    }

    needsSceneMeshLoad(intent?: SceneMeshLoadIntent): boolean {
        if (this.shouldLoadSceneMesh(intent)) {
            return !this.isSceneMeshReady(intent);
        }
        return false;
    }

    /** 按需加载 scene mesh（GLB）与/或 voxel collision。 */
    async ensureSceneMeshLoaded(intent?: SceneMeshLoadIntent): Promise<void> {
        this.mergeActiveLoadIntent(intent);
        if (!this.shouldLoadSceneMesh(intent)) {
            return;
        }

        // 等待他人 in-flight 完成后再按本 intent 检查；不把「只为 shadow 的加载」当成 collision 已就绪。
        if (this.loadState === 'loading' && this.loadPromise) {
            await this.loadPromise;
        }

        this.tryApplyCachedMeshCollision(intent);
        if (this.isSceneMeshReady(intent)) {
            return;
        }

        // 等待期间可能又有并发加载启动
        if (this.loadState === 'loading' && this.loadPromise) {
            await this.loadPromise;
            this.tryApplyCachedMeshCollision(intent);
            if (this.isSceneMeshReady(intent)) {
                return;
            }
        }

        if (this.loadState === 'failed') {
            this.loadState = 'idle';
        }

        const loadIntent = this.activeLoadIntent ?? intent;
        let collisionUrl = this.getCollisionUrl();
        if (!collisionUrl && this.shouldFetchCollisionFromUniverse(loadIntent)) {
            const result = await ensureCollisionUrl(this.global);
            this.syncHasCollision();
            if (result.ok === false) {
                console.warn('[CameraCollision] collision URL:', result.message);
            } else {
                collisionUrl = result.url;
            }
        }

        const initialPlan = this.sceneMeshLoadPlan(collisionUrl, loadIntent);
        if (!initialPlan.loadSceneMesh && !initialPlan.loadVoxelCollision) {
            // 已有 entity，仅缺物理：尽量用缓存补齐
            this.tryApplyCachedMeshCollision(intent);
            if (this.isLoadSatisfied(intent ?? loadIntent)) {
                this.loadState = 'ready';
                this.emitLoadState('ready');
                this.emitCollisionSystemReadyIfApplicable();
                this.syncConsumers();
            } else if (this.shouldLoadSceneMesh(intent ?? loadIntent)) {
                // 典型：需要 Universe 生成但 URL 仍空，或 shadow/collision intent 尚未落到资源
                this.loadState = 'failed';
                this.emitLoadState('failed');
                this.syncConsumers();
            }
            return;
        }

        // 只需物理 collision 且 GLB entity 已在（典型：shadow 先载完）— 不必重下 GLB
        if (
            initialPlan.applySceneMeshCollision &&
            this.sceneMeshEntity &&
            this.meshCollisionCache &&
            !initialPlan.loadVoxelCollision
        ) {
            this.urlCollision = this.meshCollisionCache;
            this.loadState = 'ready';
            this.emitLoadState('ready');
            this.emitCollisionSystemReadyIfApplicable();
            this.syncConsumers();
            return;
        }

        if (this.loadState === 'loading' && this.loadPromise) {
            await this.loadPromise;
            this.tryApplyCachedMeshCollision(intent);
            if (this.isSceneMeshReady(intent)) {
                return;
            }
        }

        this.loadState = 'loading';
        this.emitLoadState('loading');
        this.syncConsumers();

        const { app } = this.global;
        this.loadPromise = (async () => {
            try {
                let url = collisionUrl;
                let allowRegenerate = true;

                while (true) {
                    // 用合并后的 activeLoadIntent，避免 shadow 先跑时把后续 collision 需求丢掉
                    const planIntent = this.activeLoadIntent ?? loadIntent;
                    const plan = this.sceneMeshLoadPlan(url, planIntent);
                    if (!plan.loadSceneMesh && !plan.loadVoxelCollision) {
                        this.tryApplyCachedMeshCollision(planIntent);
                        if (this.isLoadSatisfied(planIntent)) {
                            this.loadState = 'ready';
                            this.emitLoadState('ready');
                            this.emitCollisionSystemReadyIfApplicable();
                            this.syncConsumers();
                            return;
                        }
                        this.loadState = 'failed';
                        this.emitLoadState('failed');
                        this.syncConsumers();
                        return;
                    }

                    let sceneMeshOk = !plan.loadSceneMesh;
                    let voxelOk = !plan.loadVoxelCollision;
                    let loadError: unknown;

                    try {
                        if (plan.loadSceneMesh && plan.sceneMeshUrl) {
                            const result = await loadSceneMesh(app, plan.sceneMeshUrl);
                            if (result) {
                                this.sceneMeshEntity = result.sceneMeshEntity;
                                this.meshCollisionCache = result.meshCollision;
                                if (plan.applySceneMeshCollision) {
                                    this.urlCollision = result.meshCollision;
                                }
                                this.global.events.fire('sceneMesh:ready', {
                                    sceneMeshEntity: result.sceneMeshEntity
                                } satisfies SceneMeshReadyPayload);
                                sceneMeshOk = true;
                            } else {
                                sceneMeshOk = false;
                            }
                        } else if (plan.applySceneMeshCollision && this.meshCollisionCache) {
                            this.urlCollision = this.meshCollisionCache;
                        }

                        if (plan.loadVoxelCollision && url) {
                            const voxel = await loadVoxelCollision(url);
                            if (voxel) {
                                this.urlCollision = voxel;
                                voxelOk = true;
                            } else {
                                voxelOk = false;
                            }
                        }
                    } catch (err) {
                        loadError = err;
                        sceneMeshOk = false;
                        voxelOk = false;
                    }

                    if (sceneMeshOk && voxelOk) {
                        this.tryApplyCachedMeshCollision(planIntent);
                        this.loadState = 'ready';
                        this.emitLoadState('ready');
                        this.emitCollisionSystemReadyIfApplicable();
                        this.syncConsumers();
                        return;
                    }

                    if (allowRegenerate && hasCollisionGenerateCredentials(this.global)) {
                        allowRegenerate = false;
                        console.warn(
                            '[CameraCollision] collision/shadow mesh URL 不可用，尝试重新生成',
                            { url, error: loadError }
                        );
                        this.sceneMeshEntity = null;
                        this.urlCollision = null;
                        this.meshCollisionCache = null;
                        const regenerated = await ensureCollisionUrl(this.global, {
                            forceRegenerate: true
                        });
                        this.syncHasCollision();
                        if (regenerated.ok === false) {
                            console.warn('[CameraCollision] regenerate failed:', regenerated.message);
                        } else {
                            url = regenerated.url;
                            continue;
                        }
                    }

                    this.loadState = 'failed';
                    this.emitLoadState('failed', loadError);
                    this.syncConsumers();
                    return;
                }
            } catch (err) {
                this.loadState = 'failed';
                this.emitLoadState('failed', err);
                this.syncConsumers();
            } finally {
                this.loadPromise = null;
            }
        })();

        await this.loadPromise;
        this.tryApplyCachedMeshCollision(intent);
    }

    /** mesh 实体已在、物理尚未挂上时，从 GLB 缓存补齐 collision。 */
    private tryApplyCachedMeshCollision(intent?: SceneMeshLoadIntent): void {
        const plan = this.sceneMeshLoadPlan(undefined, intent);
        if (!plan.applySceneMeshCollision || this.urlCollision || !this.meshCollisionCache) {
            return;
        }
        this.urlCollision = this.meshCollisionCache;
        if (this.sceneMeshEntity && this.loadState === 'ready') {
            this.emitCollisionSystemReadyIfApplicable();
            this.syncConsumers();
        }
    }

    private shouldFetchCollisionFromUniverse(intent?: SceneMeshLoadIntent): boolean {
        if (!canGenerateCollision(this.global)) {
            return false;
        }
        const wantCollision = intent?.wantCollision ?? collisionActive(this.global);
        const wantShadow = intent?.wantShadow ?? isShadowSystemEnabled(this.global);
        return wantCollision || wantShadow;
    }

    emitCollisionSystemReadyIfApplicable(): void {
        if (!collisionEnabled(this.global)) {
            return;
        }
        // 必须已有可查询 collision；禁止「无 URL / 空 plan」时空就绪误报
        if (this.loadState !== 'ready' || !this.urlCollision) {
            return;
        }
        this.global.events.fire(COLLISION_SYSTEM_READY);
    }

    sceneMeshLoadPlan(collisionUrl?: string, intent?: SceneMeshLoadIntent): {
        sceneMeshUrl?: string;
        loadSceneMesh: boolean;
        loadVoxelCollision: boolean;
        applySceneMeshCollision: boolean;
    } {
        const url = collisionUrl ?? this.getCollisionUrl();
        const meshUrl = sceneMeshUrl(url);
        const wantCollision = intent?.wantCollision ?? collisionActive(this.global);
        const wantShadow = intent?.wantShadow ?? isShadowSystemEnabled(this.global);
        const needCollision = !!url && wantCollision;
        const needShadowSceneMesh = wantShadow && (!!meshUrl || canGenerateCollision(this.global));
        const collisionIsSceneMeshGlb = !!url && isSceneMeshGlbUrl(url);
        const collisionIsVoxel = !!url && !collisionIsSceneMeshGlb;

        const loadSceneMesh = !!meshUrl && (needShadowSceneMesh || (needCollision && collisionIsSceneMeshGlb));
        const loadVoxelCollision = needCollision && collisionIsVoxel;
        const applySceneMeshCollision = needCollision && collisionIsSceneMeshGlb;

        return { sceneMeshUrl: meshUrl, loadSceneMesh, loadVoxelCollision, applySceneMeshCollision };
    }

    private isLoadSatisfied(intent?: SceneMeshLoadIntent): boolean {
        const wantCollision = intent?.wantCollision ?? collisionActive(this.global);
        const wantShadow = intent?.wantShadow ?? isShadowSystemEnabled(this.global);

        // 空 plan（无 URL）不能算满足：否则 shadow 默认开 + 尚未 generate 时会误标 ready，
        // 随后 COLLISION_SET 会立刻 COLLISION_SYSTEM_READY 且跳过真实加载。
        if (wantCollision && !this.urlCollision) {
            return false;
        }
        if (wantShadow && !this.sceneMeshEntity) {
            return false;
        }

        const plan = this.sceneMeshLoadPlan(undefined, intent);
        if (plan.loadSceneMesh && !this.sceneMeshEntity) {
            return false;
        }
        if (plan.applySceneMeshCollision && !this.urlCollision) {
            return false;
        }
        if (plan.loadVoxelCollision && !this.urlCollision) {
            return false;
        }
        return true;
    }

    private shouldLoadSceneMesh(intent?: SceneMeshLoadIntent): boolean {
        const url = this.getCollisionUrl();
        const meshUrl = sceneMeshUrl(url);
        const wantCollision = intent?.wantCollision ?? collisionActive(this.global);
        const wantShadow = intent?.wantShadow ?? isShadowSystemEnabled(this.global);
        const needCollision = !!url && wantCollision;
        const needShadowSceneMesh = wantShadow && (!!meshUrl || canGenerateCollision(this.global));
        const needUniverse = !url && this.shouldFetchCollisionFromUniverse(intent);
        return needCollision || needShadowSceneMesh || needUniverse;
    }

    private scheduleSceneMeshLoad(): void {
        if (!this.shouldLoadSceneMesh()) {
            return;
        }
        void this.ensureSceneMeshLoaded();
    }

    private mergeActiveLoadIntent(intent?: SceneMeshLoadIntent): void {
        if (!intent?.wantCollision && !intent?.wantShadow) {
            return;
        }
        const prev = this.activeLoadIntent ?? {};
        this.activeLoadIntent = {
            wantCollision: prev.wantCollision || intent.wantCollision,
            wantShadow: prev.wantShadow || intent.wantShadow
        };
    }

    private emitLoadState(state: CollisionLoadState, error?: unknown): void {
        const intent =
            state === 'ready' || state === 'failed' ? this.consumeActiveLoadIntentForTerminal(state) : undefined;
        const payload: CollisionLoadPayload =
            error !== undefined ? { state, error, ...(intent ? { intent } : {}) } : { state, ...(intent ? { intent } : {}) };
        this.global.events.fire('cameraCollision:load', payload);
    }

    private consumeActiveLoadIntentForTerminal(state: CollisionLoadState): SceneMeshLoadIntent | undefined {
        const intent = this.activeLoadIntent ?? undefined;
        if (state === 'ready' || state === 'failed') {
            this.activeLoadIntent = null;
        }
        return intent;
    }

    setCollision(collision: Collision | null): void {
        this.urlCollision = collision;
        this.loadState = collision ? 'ready' : this.getCollisionUrl() ? this.loadState : 'idle';
        this.syncConsumers();
        if (collision) {
            this.emitLoadState('ready');
        }
    }

    getCollision(): Collision | null {
        return this.urlCollision;
    }

    activeCollision(): Collision | null {
        if (this.loadState !== 'ready' || !this.urlCollision) {
            return null;
        }
        if (!collisionActive(this.global)) {
            return null;
        }
        return this.urlCollision;
    }

    attachConsumers(consumers: CameraCollisionConsumers): void {
        this.consumers = consumers;
        this.syncConsumers();
    }

    syncConsumers(): void {
        this.consumers?.applyUrlCollision(this.activeCollision());
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
        events.on(SCENE_COLLISION_CHANGED, this.onSceneCollisionChanged);
        this.syncHasCollision();
        this.syncConsumers();
        this.scheduleSceneMeshLoad();
        return () => this.stop();
    }

    private readonly onSceneCollisionChanged = () => {
        this.syncHasCollision();
        this.scheduleSceneMeshLoad();
    };

    stop(): void {
        if (!this.started) return;
        this.started = false;
        const { events } = this.global;
        events.off('editMode:changed', this.onContextOrToggleChanged);
        events.off('previewMode:changed', this.onContextOrToggleChanged);
        events.off('cameraCollision:changed', this.onContextOrToggleChanged);
        events.off('postEffect:changed', this.onContextOrToggleChanged);
        events.off(SCENE_COLLISION_CHANGED, this.onSceneCollisionChanged);
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
