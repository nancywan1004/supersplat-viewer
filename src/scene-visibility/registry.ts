import type { Global } from '../types';
import {
    ensureViewSettings,
    readContentCategoryVisible,
    writeContentCategoryVisible
} from '../view-settings';
import {
    isContentVisibilityOverlayActive,
    restoreEditSceneContentVisibility,
    SCENE_CONTENT_ALL_SET_HIDE_ORDER,
    SCENE_CONTENT_ALL_SET_SHOW_ORDER
} from './adapters';
import { applyLightingSessionAspects } from './lighting-session-visibility';
import {
    SCENE_CONTENT_CATEGORY_IDS,
    SCENE_CONTENT_DEFER_CATEGORY_IDS,
    categoryParticipatesInRuntimeGate,
    type SceneContentCategoryId,
    type SceneContentVisibilityAdapter,
    type SceneContentVisibilityMap
} from './types';

/**
 * 场景内容显隐容器：
 * - intent 只写 `viewSettings.contentVisibility`（不入库）
 * - 仅纯 Viewer apply 到画面；编辑态（含预览）不套用、不改编辑态
 * - runtimeGate（reveal/导出）仍叠加在 defer 大类上
 */
export class SceneContentVisibilityRegistry {
    private readonly global: Global;

    private readonly adapters = new Map<SceneContentCategoryId, SceneContentVisibilityAdapter>();

    /** true = 解锁（允许显示）；false = reveal/导出门控隐藏 defer 类 */
    private runtimeGateOpen = true;

    constructor(global: Global) {
        this.global = global;
        ensureViewSettings(global);
    }

    register(adapter: SceneContentVisibilityAdapter): void {
        this.adapters.set(adapter.id, adapter);
    }

    unregister(id: SceneContentCategoryId): void {
        this.adapters.delete(id);
    }

    getCategoryVisible(category: SceneContentCategoryId): boolean {
        return readContentCategoryVisible(this.global, category);
    }

    getSnapshot(): SceneContentVisibilityMap {
        const out: SceneContentVisibilityMap = {};
        for (const id of SCENE_CONTENT_CATEGORY_IDS) {
            out[id] = this.getCategoryVisible(id);
        }
        return out;
    }

    isRuntimeGateOpen(): boolean {
        return this.runtimeGateOpen;
    }

    /**
     * 写 `viewSettings.contentVisibility`。
     * 纯 Viewer：立即 apply；编辑态（含预览）：只记账，不改编辑态画面。
     * @returns 是否发生 intent 变更
     */
    setCategoryVisible(category: SceneContentCategoryId, visible: boolean): boolean {
        const next = !!visible;
        const prev = this.getCategoryVisible(category);
        if (prev === next) return false;
        writeContentCategoryVisible(this.global, category, next);
        if (isContentVisibilityOverlayActive(this.global)) {
            this.applyCategory(category);
        }
        this.global.events.fire('sceneContentVisibility:changed', { category, value: next });
        return true;
    }

    /**
     * `SCENE_CONTENT_ALL_SET`：完全由入参 `visible` 决定，全部大类统一写成该值并 apply。
     * 不是逐类取反；intent 已是目标值时仍强制 reapply，保证画面一致。
     * @returns 本次目标覆盖到的全部 category（与 apply 顺序一致）
     */
    setAllCategoriesVisible(visible: boolean): SceneContentCategoryId[] {
        const next = !!visible;
        const order = next ? SCENE_CONTENT_ALL_SET_SHOW_ORDER : SCENE_CONTENT_ALL_SET_HIDE_ORDER;
        for (const id of order) {
            writeContentCategoryVisible(this.global, id, next);
        }
        if (isContentVisibilityOverlayActive(this.global)) {
            for (const id of order) {
                this.applyCategory(id);
            }
            // reveal/persistent 可能 forceReapply settings.fade；lights 已置末仍再套一次会话亮度，防异步 remount 覆盖
            if (order.includes('lights')) {
                applyLightingSessionAspects(this.global);
            }
        }
        const categories = [...order];
        this.global.events.fire('sceneContentVisibility:allChanged', { value: next, categories });
        for (const category of categories) {
            this.global.events.fire('sceneContentVisibility:changed', { category, value: next });
        }
        return categories;
    }

    /** 是否任一大类为开（调试 Toggle 仅用来计算要传给 ALL_SET 的 value） */
    isAnyCategoryVisible(): boolean {
        return SCENE_CONTENT_CATEGORY_IDS.some((id) => this.getCategoryVisible(id));
    }

    /**
     * Reveal / 导出门控：只改 gate，不改 intent；仅刷新 defer 大类的 gate 叠加。
     */
    applyRuntimeGate(open: boolean): void {
        const next = !!open;
        const changed = this.runtimeGateOpen !== next;
        this.runtimeGateOpen = next;
        for (const id of SCENE_CONTENT_DEFER_CATEGORY_IDS) {
            this.applyGateOnly(id);
        }
        if (changed) {
            this.global.events.fire('sceneContentRuntimeGate:changed', { open: next });
        }
    }

    /** intent + gate 全量重放某一类（编辑态时 intent 在 adapter 内视为 true） */
    applyCategory(category: SceneContentCategoryId): void {
        const adapter = this.adapters.get(category);
        if (!adapter) return;
        const intent = this.getCategoryVisible(category);
        try {
            adapter.applyCategoryIntent(this.global, intent);
            if (categoryParticipatesInRuntimeGate(category) && adapter.applyRuntimeGate) {
                adapter.applyRuntimeGate(this.global, this.runtimeGateOpen, intent);
            }
        } catch (err) {
            console.warn(`[SceneContentVisibility] category "${category}" apply failed`, err);
        }
    }

    private applyGateOnly(category: SceneContentCategoryId): void {
        const adapter = this.adapters.get(category);
        if (!adapter?.applyRuntimeGate) return;
        const intent = this.getCategoryVisible(category);
        try {
            adapter.applyRuntimeGate(this.global, this.runtimeGateOpen, intent);
        } catch (err) {
            console.warn(`[SceneContentVisibility] category "${category}" applyRuntimeGate failed`, err);
        }
    }

    reapplyAll(): void {
        for (const id of this.adapters.keys()) {
            this.applyCategory(id);
        }
    }

    /**
     * 编辑 ⇄ 纯 Viewer 切换：
     * - 进入编辑（含预览）：恢复编辑真源，保留 viewSettings 记账
     * - 回到纯 Viewer：按 contentVisibility 重放
     */
    syncAfterEditingContextChanged(): void {
        if (isContentVisibilityOverlayActive(this.global)) {
            this.reapplyAll();
            return;
        }
        restoreEditSceneContentVisibility(this.global);
        // defer 根节点仅受 reveal/导出门控；忽略 contentVisibility
        for (const id of SCENE_CONTENT_DEFER_CATEGORY_IDS) {
            this.applyGateOnly(id);
        }
    }
}

export function getSceneContentVisibilityRegistry(
    global: Global
): SceneContentVisibilityRegistry | undefined {
    return (global as { __sceneContentVisibility?: SceneContentVisibilityRegistry }).__sceneContentVisibility;
}
