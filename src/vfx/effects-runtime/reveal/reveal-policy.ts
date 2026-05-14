import type { RevealEffectType, PersistentEffectType, State } from '../../../types';
import { PERSISTENT_EFFECT_TYPES } from '../effect-types';

/**
 * 与 `effect-types.ts` 中 **`PERSISTENT_EFFECT_TYPES`**（`index` 再导出为 **`PERSISTENT_REVEAL_EFFECT_TYPES`**）同一 `Set` 引用（单一真源）。
 * 与一次性开场 `RevealEffectType` 解耦：可持续类型（如 `perlin-wave`）不在 `reveal-controller.ts` 的 union 中声明。
 */
export const PERSISTENT_VFX: ReadonlySet<string> = PERSISTENT_EFFECT_TYPES;

/**
 * 与 `RevealController` 首帧 `hasRevealEffect` 判定一致；供 Bloom 等在 Viewer 构造阶段
 *（控制器尚未创建）推断是否应锁定 bloom 栈，避免首帧前整屏 Bloom/局部亮灯一闪。
 *
 * @param {{ type?: string } | null | undefined} revealEffect - `settings.revealEffect` 或等价对象。
 * @returns {boolean} 是否视为存在开场 / VFX reveal（`type === 'none'` 或空对象则为 false）。
 */
export function hasRevealEffectFromSettings(revealEffect: { type?: string } | null | undefined): boolean {
    return !!(
        revealEffect &&
        typeof revealEffect === 'object' &&
        Object.keys(revealEffect).length > 0 &&
        revealEffect.type !== 'none'
    );
}

/**
 * @param {string} type - 当前 VFX 类型。
 * @returns {boolean} 是否为持续型 VFX（不触发 revealComplete）。
 */
export function isPersistentVfx(type: string): boolean {
    return type !== 'none' && PERSISTENT_VFX.has(type as string);
}

/**
 * 一次性开场（非 `none`、非 persistent）统一视为 Timed VFX：共享 `totalDuration`、时间轴与 `RevealController` 计时管线。
 * 与 {@link isPersistentVfx} 互补，避免维护独立 type 列表。
 */
export function isRevealTimedVfxType(type: string): boolean {
    return type !== 'none' && !isPersistentVfx(type);
}

/**
 * 是否应暂停路径动画并等待 revealComplete（persistent 不阻塞）。
 *
 * @param {Pick<State, 'hasRevealEffect' | 'effectsRuntimeState'>} state - 当前状态子集。
 * @returns {boolean} 是否阻塞路径动画。
 */
export function revealBlocksAnim(state: Pick<State, 'hasRevealEffect' | 'effectsRuntimeState'>): boolean {
    if (!state.hasRevealEffect) return false;
    const revealType = state.effectsRuntimeState?.reveal?.activeType ?? 'none';
    if (isPersistentVfx(revealType)) return false;
    return revealType !== 'none';
}

/**
 * 首帧不写 night（交给 reveal 管线：revealComplete 或 persistent 即时回调）。
 *
 * @param {Pick<State, 'hasRevealEffect'>} state - 当前状态子集。
 * @returns {boolean} 是否延后 NightMode 首帧应用。
 */
export function nightDeferredByReveal(state: Pick<State, 'hasRevealEffect'>): boolean {
    return state.hasRevealEffect;
}
