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

export function revealBlocksAnim(state: Pick<State, 'hasRevealEffect' | 'effectsRuntimeState'>): boolean {
    if (!state.hasRevealEffect) return false;
    const revealType = state.effectsRuntimeState?.reveal?.activeType ?? 'none';
    if (isPersistentVfx(revealType)) return false;
    return revealType !== 'none';
}

export function nightDeferredByReveal(state: Pick<State, 'hasRevealEffect'>): boolean {
    return state.hasRevealEffect;
}
