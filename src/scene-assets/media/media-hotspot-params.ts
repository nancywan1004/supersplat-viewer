import {
    DEFAULT_AUDIO_TRIGGER_DISTANCE_M,
    DEFAULT_VIDEO_TRIGGER_DISTANCE_M
} from '../../settings-serialize/settings-serialize-configs';
import type { ExperienceSettings } from '../../schemas/v2';
import type { SceneAsset } from '../../schemas/v2-custom';
import type { Global, ScenePlacedItem } from '../../types';

export { DEFAULT_VIDEO_TRIGGER_DISTANCE_M, DEFAULT_AUDIO_TRIGGER_DISTANCE_M };

/** Viewer 或编辑预览：热区门开启、消费态交互规则生效 */
export function isMediaConsumptionMode(global: Global): boolean {
    const { state } = global;
    return !state.editMode || state.previewMode === true;
}

export function isHotspotGateOpen(global: Global): boolean {
    return isMediaConsumptionMode(global);
}

export function readEntryTriggerDistanceM(
    entry: ScenePlacedItem,
    kind: 'video' | 'audio',
    settings: ExperienceSettings
): number {
    const fromEntry = entry.triggerDistanceM;
    if (typeof fromEntry === 'number' && Number.isFinite(fromEntry) && fromEntry > 0) {
        return Math.max(0.01, fromEntry);
    }
    const sa = settings.sceneAssets?.find((a) => a.id === entry.id);
    const fromSa = sa?.triggerDistanceM;
    if (typeof fromSa === 'number' && Number.isFinite(fromSa) && fromSa > 0) {
        return Math.max(0.01, fromSa);
    }
    return kind === 'video' ? DEFAULT_VIDEO_TRIGGER_DISTANCE_M : DEFAULT_AUDIO_TRIGGER_DISTANCE_M;
}

export function readGlobalVideoHotspotAutoplayEnabledFromSettings(settings: ExperienceSettings): boolean {
    const sm = settings.sceneMediaHotspot;
    if (!sm || typeof sm !== 'object') return true;
    return sm.video?.hotspotAutoplayEnabled !== false;
}

export function readGlobalAudioHotspotAutoplayEnabledFromSettings(settings: ExperienceSettings): boolean {
    const sm = settings.sceneMediaHotspot;
    if (!sm || typeof sm !== 'object') return true;
    return sm.audio?.hotspotAutoplayEnabled !== false;
}

export function defaultTriggerDistanceMForAssetType(type: SceneAsset['type']): number | undefined {
    if (type === 'video') return DEFAULT_VIDEO_TRIGGER_DISTANCE_M;
    if (type === 'audio') return DEFAULT_AUDIO_TRIGGER_DISTANCE_M;
    return undefined;
}
