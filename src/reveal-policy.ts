import type { RevealEffectType } from './reveal';
import type { State } from './types';

/** 不触发 revealComplete、与路径动画并行的类型（在此追加即可） */
export const PERSISTENT_VFX: ReadonlySet<RevealEffectType> = new Set(['perlin-wave']);

export function isPersistentVfx(type: State['vfxType']): boolean {
    return type !== 'none' && PERSISTENT_VFX.has(type as RevealEffectType);
}

/** 是否应暂停路径动画并等待 revealComplete（persistent 不阻塞） */
export function revealBlocksAnim(state: Pick<State, 'hasRevealEffect' | 'vfxType'>): boolean {
    return state.hasRevealEffect && !isPersistentVfx(state.vfxType);
}

/** 首帧不写 night（交给 reveal 管线：revealComplete 或 persistent 即时回调） */
export function nightDeferredByReveal(state: Pick<State, 'hasRevealEffect'>): boolean {
    return state.hasRevealEffect;
}
