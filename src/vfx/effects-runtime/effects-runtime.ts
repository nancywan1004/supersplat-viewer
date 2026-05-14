/**
 * **EffectsRuntime 模块**：
 *
 * 1. **`EffectsRuntime` 类**：特效运行时入口（registry、composer），以及为 `RevealController`（`src/vfx/effects-runtime/reveal/reveal-effect.ts`）
 *    提供的轻量「快照」能力（`notifyRevealScriptApplied` / `getRevealTrackSnapshot`）。
 * 2. **场景 GSplat reveal 旁路数据**（仅本运行时使用 + 少量模块直接 import 常量）；
 *    persistent 在 `EffectRegistry` 上的工厂表与同步见 **`persistent/persistent-gsplat-registry-factory.ts`**。
 * 3. **旁路数据细节**：
 *    - `SCENE_GSPLAT_REVEAL_EFFECT_ID` / `SCENE_GSPLAT_PERSISTENT_EFFECT_ID`：
 *      协议 `EFFECT_*` 与 `settings.effects` 对齐的场景轨道包 id；
 *    - `PERSISTENT_EFFECT_TYPES`：持续型 id 集合（**定义于** `effect-types.ts`），本文件 import 供内置 persistent 轨 provider；
 *    - `REVEAL_EFFECT_TYPES`（**定义于** `effect-types.ts`）：一次性开场 reveal 类型集合，供内置 reveal 轨判定；
 *    - `BuiltinReveal*TrackProvider`：把「当前 effectType 算 reveal 轨还是 persistent 轨」封装成可测小类；
 *    - `RevealRuntimeTrackSnapshot`：调试 / 后续协议用的轨活跃快照。
 *
 * 若只关心「协议里 scene reveal 的 effectId」，看 **`SCENE_GSPLAT_REVEAL_EFFECT_ID`** 即可。
 */
import type { Material } from 'playcanvas';
import type { ExperienceSettings } from '../../settings';
import type { Global } from '../../types';
import { EffectRegistry } from './effect-registry';
import { GsplatEffectComposer } from './gsplat-effect-composer';
import type { GsplatContribution } from './gsplat-contribution';
import type { ComposedGsplatModifyResult } from './composer-diagnostics';
import { PERSISTENT_EFFECT_TYPES, REVEAL_EFFECT_TYPES } from './effect-types';
import { syncPersistentGsplatRegistryFactories } from './persistent/persistent-gsplat-registry-factory';

// --- 场景 GSplat reveal：协议 id、持久型集合、内置 reveal/persistent 轨判定 ---

export { SCENE_GSPLAT_PERSISTENT_EFFECT_ID, SCENE_GSPLAT_REVEAL_EFFECT_ID } from './effect-types';

/** 与 `settings.effects.reveal` / `persistent` 两轨对齐的槽位名（非通用 `EffectLifecycle`） */
export type RevealRuntimeTrackKind = 'reveal' | 'persistent';

/** 当前 gsplat 上挂载的 reveal 脚本所对应的轨快照（供调试 / 后续协议） */
export interface RevealRuntimeTrackSnapshot {
    lastScriptEffectType: string;
    revealTrackActive: boolean;
    persistentTrackActive: boolean;
}

export const BUILTIN_REVEAL_TRACK_PROVIDER_ID = 'builtin.reveal.track';
export const BUILTIN_REVEAL_PERSISTENT_PROVIDER_ID = 'builtin.reveal.persistent';

/** 开场 / 一次性类 reveal：`effectType` 在 `REVEAL_EFFECT_TYPES` 内（与 `RevealController` reveal 分派一致） */
export class BuiltinRevealTrackProvider {
    readonly id = BUILTIN_REVEAL_TRACK_PROVIDER_ID;
    readonly kind: RevealRuntimeTrackKind = 'reveal';
    matches(effectType: string): boolean {
        return REVEAL_EFFECT_TYPES.has(effectType);
    }
}

/** 可持续 reveal 轨（现仅 perlin-wave） */
export class BuiltinRevealPersistentTrackProvider {
    readonly id = BUILTIN_REVEAL_PERSISTENT_PROVIDER_ID;
    readonly kind: RevealRuntimeTrackKind = 'persistent';
    matches(effectType: string): boolean {
        return PERSISTENT_EFFECT_TYPES.has(effectType);
    }
}

// --- EffectsRuntime ---

export class EffectsRuntime {
    readonly registry: EffectRegistry;
    readonly composer: GsplatEffectComposer;
    readonly revealTrackProvider = new BuiltinRevealTrackProvider();
    readonly revealPersistentProvider = new BuiltinRevealPersistentTrackProvider();

    private readonly _global: Global;

    private _lastRevealScriptEffectType = 'none';

    constructor(global: Global) {
        this._global = global;
        this.registry = new EffectRegistry(global);
        this.composer = new GsplatEffectComposer(global);
    }

    /**
     * 按 `global.settings` 中 persistent 真源同步 `EffectRegistry` 内置工厂（按需注册/卸载）。
     * 应在挂载/卸载 persistent 脚本路径上调用（如 `viewer.syncPersistentRevealGsplat`）；波纹在 `applySceneGsplatFromRegistry` 前也会调用以防漏配。
     */
    syncPersistentGsplatRegistryFromSettings(): void {
        syncPersistentGsplatRegistryFactories(this._global.settings as ExperienceSettings, this.registry);
    }

    /**
     * 由 `RevealController` 在 `createEffect` 末尾或等价路径调用，保持运行时与真实挂载脚本一致。
     */
    notifyRevealScriptApplied(effectType: string): void {
        this._lastRevealScriptEffectType = effectType;
    }

    getRevealTrackSnapshot(): RevealRuntimeTrackSnapshot {
        const t = this._lastRevealScriptEffectType;
        return {
            lastScriptEffectType: t,
            revealTrackActive: this.revealTrackProvider.matches(t),
            persistentTrackActive: this.revealPersistentProvider.matches(t)
        };
    }

    getDebugSnapshot() {
        return {
            revealTrack: this.getRevealTrackSnapshot(),
            composer: this.composer.getDebugSnapshot()
        };
    }

    /**
     * 写入一条场景级 gsplat contribution 并 compose，再应用到给定材质集合（M11：避免业务脚本直接 `composer.setContribution`）。
     */
    applySceneGsplatContribution(contribution: GsplatContribution, materials: Set<Material>): ComposedGsplatModifyResult {
        this.composer.setContribution(contribution);
        const result = this.composer.compose();
        if (materials.size > 0) {
            this.composer.applyComposedToMaterials(materials, result);
        }
        return result;
    }

    /**
     * 按 contribution `id` 从合成器移除并 compose，再应用到材质（无活跃贡献时会 delete chunk）。
     */
    removeSceneGsplatContribution(contributionId: string, materials: Set<Material>): ComposedGsplatModifyResult {
        this.composer.removeContribution(contributionId);
        const result = this.composer.compose();
        if (materials.size > 0) {
            this.composer.applyComposedToMaterials(materials, result);
        }
        return result;
    }

    /**
     * 从 `EffectRegistry` 拉取工厂产物并 `applySceneGsplatContribution`；未注册时返回 null。
     */
    applySceneGsplatFromRegistry(effectId: string, materials: Set<Material>, options?: { revision?: number }): ComposedGsplatModifyResult | null {
        const contrib = this.registry.tryCreateSceneGsplatContribution(effectId, options);
        if (!contrib) return null;
        return this.applySceneGsplatContribution(contrib, materials);
    }

    dispose(): void {
        this.composer.dispose();
    }
}

export function createEffectsRuntime(global: Global): EffectsRuntime {
    return new EffectsRuntime(global);
}
