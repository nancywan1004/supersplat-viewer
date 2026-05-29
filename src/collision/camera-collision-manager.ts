import type { Collision } from './collision';
import {
    patchSceneAssetCollisionRuntimeState,
    syncSceneAssetCollisionRuntime
} from '../scene-assets/collision/scene-asset-collision';
import type { Global } from '../types';

/** 将门控后的 urlParam 碰撞写入 walk / fly / input / nav */
export type CameraCollisionConsumers = {
    applyUrlCollision: (collision: Collision | null) => void;
};

/**
 * 相机物理碰撞统一调度：
 * - 总开关（`settings.sceneAssetCollision.enabled`）
 * - Viewer / 编辑预览门控
 * - urlParam 加载的 Collision 与运行时消费者绑定
 *
 * 放置资产 AABB 仍由 `SceneAssetCollisionRuntime` 管理，仅共用总开关与门控语义。
 */
export class CameraCollisionManager {
    private urlCollision: Collision | null = null;

    private consumers: CameraCollisionConsumers | null = null;

    private started = false;

    private readonly onContextOrToggleChanged = () => {
        this.syncConsumers();
    };

    constructor(private readonly global: Global) {}

    /** 总开关是否开启（与 settings / state 同步） */
    readEnabled(): boolean {
        const rs = this.global.state.sceneAssetCollisionRuntimeState;
        return rs?.enabled === true;
    }

    /** 当前是否为可挡相机的上下文（Viewer 或编辑预览） */
    isEditContextActive(): boolean {
        const { state } = this.global;
        if (!state.editMode) {
            return true;
        }
        return state.previewMode === true;
    }

    /** 总开关开启且处于可挡相机上下文 */
    isRuntimeActive(): boolean {
        if (!this.readEnabled()) {
            return false;
        }
        return this.isEditContextActive();
    }

    /** 写入总开关并通知 url 绑定与放置资产 AABB 刷新 */
    setEnabled(enabled: boolean): void {
        patchSceneAssetCollisionRuntimeState(this.global, { enabled: !!enabled });
        syncSceneAssetCollisionRuntime(this.global);
        this.global.events.fire('cameraCollision:changed');
        this.global.events.fire('sceneAssetCollision:changed');
    }

    /** 设置 `?collision=` 加载的原始碰撞（与门控无关，供 debug overlay 使用原始引用） */
    setUrlCollisionSource(collision: Collision | null): void {
        this.urlCollision = collision;
        this.syncConsumers();
    }

    getUrlCollisionSource(): Collision | null {
        return this.urlCollision;
    }

    /** 门控后交给 walk / fly / input 的 urlParam 碰撞；无则 `null` */
    resolveActiveUrlCollision(): Collision | null {
        if (!this.urlCollision || !this.global.state.hasCollision) {
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

    /** 订阅编辑/预览与总开关变化；返回卸载函数 */
    start(): () => void {
        if (this.started) {
            return () => this.stop();
        }
        this.started = true;
        const { events } = this.global;
        events.on('editMode:changed', this.onContextOrToggleChanged);
        events.on('previewMode:changed', this.onContextOrToggleChanged);
        events.on('cameraCollision:changed', this.onContextOrToggleChanged);
        this.syncConsumers();
        return () => this.stop();
    }

    stop(): void {
        if (!this.started) return;
        this.started = false;
        const { events } = this.global;
        events.off('editMode:changed', this.onContextOrToggleChanged);
        events.off('previewMode:changed', this.onContextOrToggleChanged);
        events.off('cameraCollision:changed', this.onContextOrToggleChanged);
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
