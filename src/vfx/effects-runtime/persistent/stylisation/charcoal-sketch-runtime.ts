import type { Entity } from 'playcanvas';

import type { ExperienceSettings } from '../../../../settings';
import { readPersistentTrackEffects } from '../../../../settings-serialize/effects-sync';
import { getMountedPersistentGsplatScript } from '../../gsplat-effect-script-registry';
import { DEFAULT_CHARCOAL_SKETCH_SETTINGS } from './charcoal-sketch';

/** viewer 侧：脚本已挂载且 settings 仍启用时才应用纸色清屏。 */
export function isCharcoalSketchRuntimeActive(
    settings: ExperienceSettings,
    gsplatEntity: Entity | null | undefined
): boolean {
    const script = getMountedPersistentGsplatScript(gsplatEntity, 'charcoal-sketch') as { enabled?: boolean } | null;
    if (!gsplatEntity || !script || script.enabled === false) {
        return false;
    }
    return readPersistentTrackEffects(settings, 'stylization').some(
        e => e.type === 'charcoal-sketch' && e.enabled !== false
    );
}

export function readCharcoalSketchEffectParams(settings: ExperienceSettings): unknown {
    const entry = readPersistentTrackEffects(settings, 'stylization', { includeDisabled: true })
        .find(e => e.type === 'charcoal-sketch');
    return entry?.effectParams ?? DEFAULT_CHARCOAL_SKETCH_SETTINGS;
}
