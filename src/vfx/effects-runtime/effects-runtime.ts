/**
 * **EffectsRuntime 模块**（单文件收敛）：
 *
 * 1. **`EffectsRuntime` 类**：特效运行时入口（registry、composer），以及为 `RevealController`（`src/vfx/effects-runtime/reveal/reveal-effect.ts`）
 *    提供的轻量「快照」能力（`notifyRevealScriptApplied` / `getRevealTrackSnapshot`）。
 * 2. **场景 GSplat reveal 旁路数据**（仅本运行时使用 + 少量模块直接 import 常量）：
 *    - `SCENE_GSPLAT_REVEAL_EFFECT_ID` / `SCENE_GSPLAT_PERSISTENT_EFFECT_ID`：
 *      协议 `EFFECT_*` 与 `settings.effects` 对齐的场景轨道包 id；
 *    - `PERSISTENT_EFFECT_TYPES`：持续型 reveal 类型集合（**定义于** `persistent/persistent-effect.ts`，本文件 import 供内置轨 provider）；
 *    - `REVEAL_EFFECT_TYPES`（**定义于** `reveal/reveal-effect.ts`）：一次性开场 reveal 类型集合，供内置 reveal 轨判定；
 *    - `BuiltinReveal*TrackProvider`：把「当前 effectType 算 reveal 轨还是 persistent 轨」封装成可测小类；
 *    - `RevealRuntimeTrackSnapshot`：调试 / 后续协议用的轨活跃快照。
 *
 * 若只关心「协议里 scene reveal 的 effectId」，看 **`SCENE_GSPLAT_REVEAL_EFFECT_ID`** 即可。
 */
import type { Global } from '../../types';
import { EffectRegistry } from './effect-registry';
import { GsplatEffectComposer } from './gsplat-effect-composer';
import { PERSISTENT_EFFECT_TYPES } from './persistent/persistent-effect';
import { REVEAL_EFFECT_TYPES } from './reveal/reveal-effect';

// --- 场景 GSplat reveal：协议 id、持久型集合、内置 reveal/persistent 轨判定 ---

/** 协议与 `settings.effects.reveal` 共用的场景级 GSplat reveal 包 id */
export const SCENE_GSPLAT_REVEAL_EFFECT_ID = 'scene.gsplat-reveal' as const;
/** 协议与 `settings.effects.persistent` 共用的场景级 GSplat persistent 包 id */
export const SCENE_GSPLAT_PERSISTENT_EFFECT_ID = 'scene.gsplat-persistent' as const;

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

    private _lastRevealScriptEffectType = 'none';

    constructor(global: Global) {
        this.registry = new EffectRegistry(global);
        this.composer = new GsplatEffectComposer(global);
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

    dispose(): void {
        this.composer.dispose();
    }
}

export function createEffectsRuntime(global: Global): EffectsRuntime {
    return new EffectsRuntime(global);
}
