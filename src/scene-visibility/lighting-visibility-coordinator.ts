/**
 * Lighting 显隐调度：同栈 batch、重建 invalidate 在 prerender 合并。
 * generation 防止过期异步回调在更新后的 intent 上再套一层旧画面。
 */
import type { Global } from '../types';
import { reconcileLightingVisibility } from './lighting-visibility-reconciler';

type AppWithOnce = {
    once?: (event: string, callback: () => void) => void;
    renderNextFrame?: boolean;
};

export class LightingVisibilityCoordinator {
    private readonly global: Global;

    private batchDepth = 0;

    private dirty = false;

    private forcePending = false;

    private flushing = false;

    private prerenderScheduled = false;

    private generation = 0;

    private appliedGeneration = 0;

    constructor(global: Global) {
        this.global = global;
    }

    getGeneration(): number {
        return this.generation;
    }

    beginBatch(): void {
        this.batchDepth += 1;
    }

    endBatch(): void {
        this.batchDepth = Math.max(0, this.batchDepth - 1);
        if (this.batchDepth === 0 && this.dirty) {
            if (this.forcePending) {
                this.scheduleFrameCoalescedFlush();
            } else {
                this.runFlush();
            }
        }
    }

    /**
     * 请求按当前 intent 套用画面。batch 内只记脏；否则同步 flush（用户 TOGGLE / SET）。
     *
     * @param {string} [_reason] - 调用原因（诊断）
     * @returns {void}
     */
    requestReconcile(_reason?: string): void {
        this.bumpGeneration();
        this.dirty = true;
        if (this.batchDepth > 0 || this.flushing) {
            return;
        }
        this.runFlush();
    }

    /**
     * 实体重建 / remount / reveal / shadow ready 后强制套用。
     * 有 `app.once('prerender')` 时合并到绘制前一次；否则立即 flush。
     *
     * @param {string} [_reason] - 调用原因（诊断）
     * @returns {void}
     */
    invalidate(_reason?: string): void {
        this.bumpGeneration();
        this.dirty = true;
        this.forcePending = true;
        if (this.batchDepth > 0 || this.flushing) {
            return;
        }
        this.scheduleFrameCoalescedFlush();
    }

    private bumpGeneration(): void {
        this.generation += 1;
    }

    private scheduleFrameCoalescedFlush(): void {
        const app = this.global.app as AppWithOnce | undefined;
        if (typeof app?.once !== 'function') {
            this.runFlush();
            return;
        }
        if (this.prerenderScheduled) {
            return;
        }
        this.prerenderScheduled = true;
        app.once('prerender', () => {
            this.prerenderScheduled = false;
            if (!this.dirty && this.appliedGeneration === this.generation) {
                return;
            }
            this.runFlush();
        });
        if (app) {
            app.renderNextFrame = true;
        }
    }

    private runFlush(): void {
        if (this.flushing) {
            return;
        }
        this.flushing = true;
        try {
            let skipPostEffect = false;
            while (this.dirty) {
                const force = this.forcePending;
                this.forcePending = false;
                this.dirty = false;
                const registry = (this.global as {
                    __sceneContentVisibility?: { isRuntimeGateOpen?: () => boolean };
                }).__sceneContentVisibility;
                reconcileLightingVisibility(this.global, {
                    force,
                    skipPostEffect,
                    runtimeGateOpen: registry?.isRuntimeGateOpen?.()
                });
                this.appliedGeneration = this.generation;
                skipPostEffect = true;
            }
        } finally {
            this.flushing = false;
        }
    }
}

type GlobalWithCoordinator = Global & {
    __lightingVisibilityCoordinator?: LightingVisibilityCoordinator;
};

export function getLightingVisibilityCoordinator(
    global: Global
): LightingVisibilityCoordinator | undefined {
    return (global as GlobalWithCoordinator).__lightingVisibilityCoordinator;
}

export function ensureLightingVisibilityCoordinator(global: Global): LightingVisibilityCoordinator {
    const g = global as GlobalWithCoordinator;
    if (!g.__lightingVisibilityCoordinator) {
        g.__lightingVisibilityCoordinator = new LightingVisibilityCoordinator(global);
    }
    return g.__lightingVisibilityCoordinator;
}

export function requestLightingVisibilityReconcile(global: Global, reason?: string): void {
    ensureLightingVisibilityCoordinator(global).requestReconcile(reason);
}

/** 重建后强制套用；Coordinator 尚未挂上时 no-op。 */
export function invalidateLightingVisibility(global: Global, reason?: string): void {
    getLightingVisibilityCoordinator(global)?.invalidate(reason);
}
