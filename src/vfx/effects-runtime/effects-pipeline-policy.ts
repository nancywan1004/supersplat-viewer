import type { ExperienceSettings } from '../../schemas/v2';
import type { State } from '../../types';
import { getRevealActiveType, getRevealStatus, readActivePersistentEffects } from '../../settings-serialize/effects-sync';
import { persistentEffectUsesGsplatMaterialShader } from './effect-types';
import { isPersistentVfx } from './reveal/reveal-policy';

/** settings 中是否有 enabled 且占用 gsplat 材质 shader chunk 的 persistent 特效 */
export function hasEnabledPersistentGsplatMaterialShaderEffect(settings: ExperienceSettings): boolean {
    return readActivePersistentEffects(settings).some(
        (entry) => entry.enabled && persistentEffectUsesGsplatMaterialShader(entry.type)
    );
}

/**
 * 产品约定（与重构 plan / 宿主语义对齐）：
 * - **仅**在播放「一次性开场 reveal」时，由 `GsplatShaderEffect` **整段**写入 `gsplatModifyVS`（不经 `GsplatEffectComposer` 分层拼接）。
 * - **其余时刻**（夜间模式、持续波纹、无开场特效等）场景级高斯顶点修改走 **合成管线**（composer 收集多段 contribution 后统一写材质）。
 *
 * 用于让 **持续波纹** 在开场 reveal 独占材质期间暂停参与合成，避免与整段 reveal shader 抢同一段 chunk。
 */
export function isOneShotRevealPlayingExclusiveGsplat(state: State | undefined | null): boolean {
    if (!state) return false;
    if (getRevealStatus(state) !== 'playing') return false;
    const t = getRevealActiveType(state);
    return t !== 'none' && !isPersistentVfx(t);
}

/**
 * 回退：与 `nightComposer=0` 类似，关闭「波纹走注册表 + EffectsRuntime 封装」路径，仍用脚本内联 `setContribution`（调试用）。
 */
export function perlinWaveUsesRegistryComposerPath(): boolean {
    if ((globalThis as any).__PERLIN_REGISTRY__ === false) {
        return false;
    }
    if (typeof window !== 'undefined') {
        try {
            const q = new URLSearchParams(window.location.search).get('perlinRegistry');
            if (q === '0' || q === 'false') return false;
        } catch {
            // ignore
        }
    }
    return true;
}
