import type { Global } from '../../types';

type ShadowEnableInputs = Pick<Global, 'config' | 'settings'>;

/** URL `?splatMesh=` 仅作为阴影系统前置能力条件。 */
export function hasShadowCapability(global: Pick<Global, 'config'>): boolean {
    const url = typeof global.config.splatMeshUrl === 'string' ? global.config.splatMeshUrl.trim() : '';
    return url.length > 0;
}

/** 阴影系统总开关：手动开关 + URL 前置能力。 */
export function isShadowSystemEnabled(global: ShadowEnableInputs): boolean {
    if (!hasShadowCapability(global)) {
        return false;
    }
    const enabled = (global.settings.postEffectSettings?.shadow as { enabled?: boolean } | undefined)?.enabled;
    return enabled !== false;
}
