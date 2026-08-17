import type { State } from '../../../types';
import { PERSISTENT_EFFECT_TYPES } from '../effect-types';

export const PERSISTENT_VFX: ReadonlySet<string> = PERSISTENT_EFFECT_TYPES;

export function isPersistentVfx(type: string): boolean {
    return type !== 'none' && PERSISTENT_VFX.has(type);
}

export function isRevealEffectActiveInScene(
    revealEffect: { type?: string; enabled?: boolean } | null | undefined
): boolean {
    if (!revealEffect || typeof revealEffect !== 'object') return false;
    if (!revealEffect.type || revealEffect.type === 'none') return false;
    return revealEffect.enabled !== false;
}

export function hasRevealEffectFromSettings(
    revealEffect: { type?: string; enabled?: boolean } | null | undefined
): boolean {
    return isRevealEffectActiveInScene(revealEffect);
}

export function isRevealTimedVfxType(type: string): boolean {
    return type !== 'none' && !isPersistentVfx(type);
}

/** `revealBlocksAnim` 的 settings 侧提示（避免把 autoStart:false 当成开场挡 anim） */
export type RevealBlocksAnimHint = {
    autoStart?: boolean;
    type?: string;
};

/**
 * 一次性开场 reveal 是否应冻结 animTrack。
 * autoStart:false / 已 completed 不挡；否则快网下 ensureInitial 早于 firstFrame 起播后会被再暂停。
 */
export function revealBlocksAnim(
    state: Pick<State, 'hasRevealEffect' | 'effectsRuntimeState'>,
    revealHint?: RevealBlocksAnimHint | null
): boolean {
    if (!state.hasRevealEffect) return false;
    const revealType =
        state.effectsRuntimeState?.reveal?.activeType ??
        (typeof revealHint?.type === 'string' ? revealHint.type : 'none');
    if (isPersistentVfx(revealType) || revealType === 'none') return false;
    if (revealHint?.autoStart === false) return false;
    const status = state.effectsRuntimeState?.reveal?.status;
    if (status === 'completed') return false;
    return true;
}

export function nightDeferredByReveal(state: Pick<State, 'hasRevealEffect'>): boolean {
    return state.hasRevealEffect;
}
