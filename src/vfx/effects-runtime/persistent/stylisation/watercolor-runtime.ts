import type { Entity } from 'playcanvas';

import type { ExperienceSettings } from '../../../../settings';
import { readPersistentTrackEffects } from '../../../../settings-serialize/effects-sync';
import { getMountedPersistentGsplatScript } from '../../gsplat-effect-script-registry';
import { DEFAULT_WATERCOLOR_SETTINGS } from './watercolor';

/** viewer 侧：脚本已挂载且 settings 仍启用时才应用纸色清屏。 */
export function isWatercolorRuntimeActive(
    settings: ExperienceSettings,
    gsplatEntity: Entity | null | undefined
): boolean {
    const script = getMountedPersistentGsplatScript(gsplatEntity, 'watercolor') as { enabled?: boolean } | null;
    if (!gsplatEntity || !script || script.enabled === false) {
        return false;
    }
    return readPersistentTrackEffects(settings, 'stylization').some(
        e => e.type === 'watercolor' && e.enabled !== false
    );
}

export function readWatercolorEffectParams(settings: ExperienceSettings): unknown {
    const entry = readPersistentTrackEffects(settings, 'stylization', { includeDisabled: true })
        .find(e => e.type === 'watercolor');
    return entry?.effectParams ?? DEFAULT_WATERCOLOR_SETTINGS;
}
