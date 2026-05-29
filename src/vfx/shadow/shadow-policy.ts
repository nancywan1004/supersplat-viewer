import { resolveSceneMeshUrl } from '../../loaders/scene-mesh-loader';
import type { Global } from '../../types';

type ShadowEnableInputs = Pick<Global, 'config' | 'settings'>;

/** 已配置 GLB 型 `?collision=`（接影与物理碰撞共用）。 */
export function hasShadowCapability(global: Pick<Global, 'config'>): boolean {
    return !!resolveSceneMeshUrl(global.config.collisionUrl);
}

/** 阴影系统总开关：手动开关 + URL 前置能力。 */
export function isShadowSystemEnabled(global: ShadowEnableInputs): boolean {
    if (!hasShadowCapability(global)) {
        return false;
    }
    const enabled = (global.settings.postEffectSettings?.shadow as { enabled?: boolean } | undefined)?.enabled;
    return enabled !== false;
}
