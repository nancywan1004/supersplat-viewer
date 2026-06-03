import { getPersistentEffectPaused } from '../../../settings-serialize/effects-sync';
import type { Global } from '../../../types';

/**
 * **可持续 GSplat 与一次性 Reveal 的衔接控制器（M20）**
 *
 * 负责：viewer 挂载 persistent 实体脚本前后的 **Night / inVfx / currentScript 时间轴绑定**，
 * 与 `remountPersistentGsplatOnEntity` 注入的回调一一对应。
 * 一次性 reveal 脚本创建、Timed 轴、`createEffect` 分派仍留在 {@link RevealController}。
 */
export type RevealPersistentGsplatCallbacks = {
    global: Global;
    /** 对应原 `prepareExternalPersistentScriptMount`：inVfx、nightFade 快照、legacy 路径 `nightMode:exit` */
    beforePersistentScriptMount: () => void;
    /** `bindPersistentTimelineScript(null)` 之后：恢复 Night、退出 inVfx（不含 `notifyRevealScriptApplied`） */
    afterPersistentScriptUnmount: () => void;
    applyShaderScriptCenter: (script: any) => void;
    setCurrentScript: (script: any | null) => void;
    notifyRevealScriptType: (effectType: string) => void;
};

export class RevealPersistentGsplatController {
    private persistentTimelineBound = false;

    constructor(private readonly c: RevealPersistentGsplatCallbacks) {}

    isPersistentTimelineBound(): boolean {
        return this.persistentTimelineBound;
    }

    resetPersistentTimelineBound(): void {
        this.persistentTimelineBound = false;
    }

    prepareExternalPersistentScriptMount(): void {
        this.c.beforePersistentScriptMount();
    }

    finishPersistentGsplatExternalUnmount(): void {
        this.bindPersistentTimelineScript(null);
        this.c.afterPersistentScriptUnmount();
        this.c.notifyRevealScriptType('none');
    }

    applyGsplatShaderScriptCenter(script: any): void {
        this.c.applyShaderScriptCenter(script);
    }

    bindPersistentTimelineScript(script: any | null): void {
        this.c.setCurrentScript(script);
        this.persistentTimelineBound = !!script;
        if (script && typeof script.isPaused === 'boolean') {
            script.isPaused = getPersistentEffectPaused(this.c.global.state);
        }
    }
}
