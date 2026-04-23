import type { RevealEffectType } from './reveal';
import type { State } from './types';

/**
 * 与 RevealController 首帧 `hasRevealEffect` 判定一致；供 Bloom 等在 Viewer 构造阶段
 *（RevealController 尚未创建）推断是否应锁定 bloom 栈，避免首帧前整屏 Bloom/局部亮灯一闪。
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

/** 不触发 revealComplete、与路径动画并行的类型（在此追加即可） */
export const PERSISTENT_VFX: ReadonlySet<RevealEffectType> = new Set(['perlin-wave']);

/**
 * @param {State['vfxType']} type - 当前 VFX 类型。
 * @returns {boolean} 是否为持续型 VFX（不触发 revealComplete）。
 */
export function isPersistentVfx(type: State['vfxType']): boolean {
    return type !== 'none' && PERSISTENT_VFX.has(type as RevealEffectType);
}

/**
 * 是否应暂停路径动画并等待 revealComplete（persistent 不阻塞）。
 *
 * @param {Pick<State, 'hasRevealEffect' | 'vfxType'>} state - 当前状态子集。
 * @returns {boolean} 是否阻塞路径动画。
 */
export function revealBlocksAnim(state: Pick<State, 'hasRevealEffect' | 'vfxType'>): boolean {
    return state.hasRevealEffect && !isPersistentVfx(state.vfxType);
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
