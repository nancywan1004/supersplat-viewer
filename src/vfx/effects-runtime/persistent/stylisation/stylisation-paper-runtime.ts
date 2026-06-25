import type { Entity } from 'playcanvas';

import type { ExperienceSettings } from '../../../../settings';
import { readPersistentTrackEffects } from '../../../../settings-serialize/effects-sync';
import { getMountedPersistentGsplatScript } from '../../gsplat-effect-script-registry';
import { DEFAULT_CHARCOAL_SKETCH_SETTINGS } from './charcoal-sketch';
import { DEFAULT_PEN_SKETCH_SETTINGS } from './pen-sketch';
import { DEFAULT_WATERCOLOR_SETTINGS } from './watercolor';

type PaperStylisationEffectType = 'charcoal-sketch' | 'pen-sketch' | 'watercolor';

const PAPER_STYLISATION_DEFAULTS = {
    'charcoal-sketch': DEFAULT_CHARCOAL_SKETCH_SETTINGS,
    'pen-sketch': DEFAULT_PEN_SKETCH_SETTINGS,
    watercolor: DEFAULT_WATERCOLOR_SETTINGS
} as const;

function isPaperStylisationRuntimeActive(
    settings: ExperienceSettings,
    gsplatEntity: Entity | null | undefined,
    effectType: PaperStylisationEffectType
): boolean {
    const script = getMountedPersistentGsplatScript(gsplatEntity, effectType) as { enabled?: boolean } | null;
    if (!gsplatEntity || !script || script.enabled === false) {
        return false;
    }
    return readPersistentTrackEffects(settings, 'stylization').some(
        e => e.type === effectType && e.enabled !== false
    );
}

function readPaperStylisationEffectParams(
    settings: ExperienceSettings,
    effectType: PaperStylisationEffectType
): unknown {
    const entry = readPersistentTrackEffects(settings, 'stylization', { includeDisabled: true })
        .find(e => e.type === effectType);
    return entry?.effectParams ?? PAPER_STYLISATION_DEFAULTS[effectType];
}

export const isCharcoalSketchRuntimeActive = (
    settings: ExperienceSettings,
    gsplatEntity: Entity | null | undefined
): boolean => isPaperStylisationRuntimeActive(settings, gsplatEntity, 'charcoal-sketch');

export const readCharcoalSketchEffectParams = (settings: ExperienceSettings): unknown =>
    readPaperStylisationEffectParams(settings, 'charcoal-sketch');

export const isPenSketchRuntimeActive = (
    settings: ExperienceSettings,
    gsplatEntity: Entity | null | undefined
): boolean => isPaperStylisationRuntimeActive(settings, gsplatEntity, 'pen-sketch');

export const readPenSketchEffectParams = (settings: ExperienceSettings): unknown =>
    readPaperStylisationEffectParams(settings, 'pen-sketch');

export const isWatercolorRuntimeActive = (
    settings: ExperienceSettings,
    gsplatEntity: Entity | null | undefined
): boolean => isPaperStylisationRuntimeActive(settings, gsplatEntity, 'watercolor');

export const readWatercolorEffectParams = (settings: ExperienceSettings): unknown =>
    readPaperStylisationEffectParams(settings, 'watercolor');
