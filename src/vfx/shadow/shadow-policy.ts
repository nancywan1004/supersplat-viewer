import { canGenerateCollision, resolveCollisionUrl } from '../../collision/scene-collision-source';
import { sceneMeshUrl } from '../../loaders/gltf/scene-mesh-loader';
import type { Global } from '../../types';

type ShadowEnableInputs = Pick<Global, 'config' | 'settings'>;

/** 已配置 scene mesh GLB，或可经 Universe 生成后得到 GLB。 */
export function hasShadowSceneMesh(global: ShadowEnableInputs): boolean {
    const resolved = resolveCollisionUrl(global as Global);
    if (sceneMeshUrl(resolved?.url)) {
        return true;
    }
    return canGenerateCollision(global as Global);
}

/** 阴影系统总开关：手动开关 + scene mesh 前置能力。 */
export function isShadowSystemEnabled(global: ShadowEnableInputs): boolean {
    if (!hasShadowSceneMesh(global)) {
        return false;
    }
    const enabled = (global.settings.postEffectSettings?.shadow as { enabled?: boolean } | undefined)?.enabled;
    return enabled !== false;
}
