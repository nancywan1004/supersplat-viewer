/**
 * 特效（Reveal / VFX）协议映射：`VFX_TYPE_SET` / `VFX_EXIT` 对 settings、state 的写入及事件派发。
 * 由 EffectsFacade 调用。
 */

import { ensureRevealEffect } from '../../settings-serialize/settings-serialize-helper';
import type { Global } from '../../types';

/** VFX_TYPE_SET：写 settings.revealEffect.type、state.vfxType，并触发 revealConfigChanged */
export function applyVfxTypeSet(global: Global, value: string): void {
    const settings = global.settings;
    const rev = ensureRevealEffect(settings);
    (rev as Record<string, unknown>).type = value;
    (global.state as Record<string, unknown>).vfxType = value;
    global.events.fire('revealConfigChanged', { type: value });
}

/** VFX_EXIT：强制停止当前特效播放，但保留配置（不改 settings.revealEffect.type）。 */
export function applyVfxExit(global: Global): void {
    (global.state as Record<string, unknown>).vfxActive = false;
    global.events.fire('vfxExit');
}
