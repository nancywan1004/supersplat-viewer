/**
 * **一次性 reveal 轨** 与 **persistent GSplat 轨** 的编排约定（读侧真源：`settings.effects`）。
 *
 * - **独立**：两轨各自 `type` / `enable`；`RevealController` 只直接驱动一次性脚本；persistent 由 `viewer` 挂载。
 * - **串联**：仅当配置里仍需要 persistent，且当前不会在「本轮一次性 reveal 播完前」误抢 shader 时，才在
 *   `revealComplete` 之后发 `persistentGsplatEffectRemountRequested`（与协议层语义对齐）。
 *
 * 新增「关 reveal / 关 persistent / 重播」分支时，优先改本文件或 `persistent-effect.ts` 的挂载管线，
 * 避免在 `RevealController` 内再堆散落的 persistent 读侧条件。
 */
import type { ExperienceSettings } from '../../../schemas/v2';
import { hasEnabledPersistentSceneEffects } from '../../../settings-serialize/effects-sync';
import { isPersistentVfx } from './reveal-policy';

export type PersistentGsplatRemountSchedulingReason =
    /** `restart` 等：本轮一次性 reveal 结束后由 viewer 再挂 persistent（createEffect 已拆掉旧实例） */
    | 'afterOneShotRevealCompletes'
    /** `updateConfig` 切到 `none`：无一次性轨，若 persistent 仍开则立即 remount */
    | 'revealTrackExplicitlyNone';

/**
 * 是否应在后续时机请求 `persistentGsplatEffectRemountRequested`（由调用方决定 once/immediate）。
 */
export function shouldRequestPersistentGsplatRemount(
    reason: PersistentGsplatRemountSchedulingReason,
    revealTrackType: string,
    settings: ExperienceSettings
): boolean {
    if (!hasEnabledPersistentSceneEffects(settings)) {
        return false;
    }
    if (reason === 'revealTrackExplicitlyNone') {
        return revealTrackType === 'none';
    }
    const t = revealTrackType;
    return t !== 'none' && !isPersistentVfx(t);
}
