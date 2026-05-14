import type { Global } from '../../types';
import type { GsplatContribution } from './gsplat-contribution';

/**
 * 构造场景级 gsplat contribution 时的上下文（`revision` 参与 composer signature，仅结构/源码变更时递增）。
 */
export type EffectGsplatContributionFactoryContext = {
    global: Global;
    revision?: number;
};

/**
 * 由注册项构造场景级 gsplat contribution（返回 null 表示当前上下文不适用，不写入 composer）。
 */
export type EffectGsplatContributionFactory = (ctx: EffectGsplatContributionFactoryContext) => GsplatContribution | null;

/**
 * 单条注册：协议 `effectId` 或内部 `effectType`（如 `perlin-wave`）均可作为 key，由调用方约定唯一性。
 */
export interface EffectRegistryEntry {
    id: string;
    /** 可选：供 composer 路径从注册表拉取 contribution 模板 */
    createSceneGsplatContribution?: EffectGsplatContributionFactory;
}

/**
 * 按 effectId / effectType 注册条目，供 **registry + composer** 渐进迁移（替换原先恒 false 的占位实现）。
 */
export class EffectRegistry {
    private readonly entries = new Map<string, EffectRegistryEntry>();

    constructor(private readonly global: Global) {}

    register(entry: EffectRegistryEntry): void {
        this.entries.set(entry.id, entry);
    }

    unregister(id: string): void {
        this.entries.delete(id);
    }

    has(effectId: string): boolean {
        return this.entries.has(effectId);
    }

    get(effectId: string): EffectRegistryEntry | undefined {
        return this.entries.get(effectId);
    }

    getRegisteredIds(): string[] {
        return [...this.entries.keys()];
    }

    clear(): void {
        this.entries.clear();
    }

    tryCreateSceneGsplatContribution(effectId: string, options?: { revision?: number }): GsplatContribution | null {
        const e = this.entries.get(effectId);
        const fn = e?.createSceneGsplatContribution;
        if (!fn) return null;
        return fn({ global: this.global, revision: options?.revision });
    }
}
