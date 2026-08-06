import { canGenerateCollision, resolveCollisionUrl } from '../../collision/scene-collision-source';
import { sceneMeshUrl } from '../../loaders/gltf/scene-mesh-loader';
import type { Global } from '../../types';

type ShadowEnableInputs = Pick<Global, 'config' | 'settings'>;

/**
 * 配置中**已有** scene mesh GLB URL。
 * 不含「可 Universe 生成」；观看态阴影会话显隐 / postEffect 懒挂载只认此项，避免误跑 generate。
 */
export function hasConfiguredShadowSceneMesh(global: ShadowEnableInputs): boolean {
    const resolved = resolveCollisionUrl(global as Global);
    return !!sceneMeshUrl(resolved?.url);
}

/** 已配置 scene mesh GLB，或可经 Universe 生成后得到 GLB（供 `SHADOW_SET` 等显式开影路径）。 */
export function hasShadowSceneMesh(global: ShadowEnableInputs): boolean {
    if (hasConfiguredShadowSceneMesh(global)) {
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
