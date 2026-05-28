/**
 * 场景 settings 重置：优先云端初始 transform.json，否则保留当前相机路径。
 * 不修改天空盒（`background` 含 `skyboxUrl` 原样保留）。
 */
import { requestSceneAssetsRestore } from './scene-assets/asset-placement-handler';
import {
    restoreAnnotationsFromSettings,
    restoreLightingFromSettings,
    restorePostEffectsFromSettings,
    restoreSkyboxFromSettings
} from './edit-history';
import { importSettings } from './settings';
import type { ExperienceSettings } from './schemas/v2';
import { serializeExperienceSettings, applySettingsSnapshot } from './settings-serialize/settings-serialize';
import {
    DEFAULT_BLOOM,
    DEFAULT_EFFECTS,
    DEFAULT_LIGHTING_ROOT,
    DEFAULT_NIGHT_MODE,
    DEFAULT_REVEAL_EFFECT,
    DEFAULT_SCENE_MEDIA_HOTSPOT,
    DEFAULT_SHADOW
} from './settings-serialize/settings-serialize-configs';
import {
    ensureBloom,
    ensureBloomEditorSession,
    ensureLighting,
    ensureRevealEffect,
    ensureSceneMediaHotspot,
    ensureTorchLight,
    normalizeBloomAfterImport,
    normalizeBloomLocalLightRegions
} from './settings-serialize/settings-serialize-helper';
import {
    getRevealActiveType,
    hasRevealInSettings,
    normalizeEffectsOnImport,
    syncEffectsRuntimeStateFromSettings
} from './settings-serialize/effects-sync';
import { clearPendingProjectThumbnail } from './render/project-thumbnail';
import { fetchOriginalTransform } from './universe/service';
import type { Global } from './types';

/** 相机路径来源：`original` 初始 transform；`current` 保留现有 anim/initial */
export type ResetPathFrom = 'original' | 'current';

export type ResetResult =
    | { ok: true; pathFrom: ResetPathFrom }
    | { ok: false; message: string };

function settingsFromTransform(transformJson: unknown, noReveal?: boolean): ExperienceSettings {
    let settings = importSettings(transformJson);
    if (noReveal) {
        settings.revealEffect = undefined;
        delete (settings as Record<string, unknown>).effects;
    } else {
        ensureRevealEffect(settings);
        normalizeEffectsOnImport(settings);
    }
    return settings;
}

/** 无 transform 时：保留 anim/initial，其余恢复默认编辑态 */
function settingsKeepCamera(global: Global, noReveal?: boolean): ExperienceSettings {
    const src = serializeExperienceSettings(global);
    const snapshot = JSON.parse(JSON.stringify(src)) as ExperienceSettings;

    snapshot.animTracks = JSON.parse(JSON.stringify(src.animTracks ?? []));
    snapshot.cameras = JSON.parse(JSON.stringify(src.cameras ?? []));
    if (src.startMode != null) {
        snapshot.startMode = src.startMode;
    }
    if (src.hasStartPose != null) {
        snapshot.hasStartPose = src.hasStartPose;
    }
    if (src.initialCameraMode != null) {
        snapshot.initialCameraMode = src.initialCameraMode;
    }

    snapshot.sceneAssets = [];
    snapshot.annotations = [];
    snapshot.lighting = JSON.parse(JSON.stringify(DEFAULT_LIGHTING_ROOT));
    snapshot.nightMode = { ...DEFAULT_NIGHT_MODE };
    snapshot.sceneMediaHotspot = JSON.parse(JSON.stringify(DEFAULT_SCENE_MEDIA_HOTSPOT));
    snapshot.postEffectSettings = {
        sharpness: { enabled: false, amount: 0 },
        bloom: {
            ...DEFAULT_BLOOM,
            localLightRegions: []
        },
        grading: {
            enabled: false,
            brightness: 0,
            contrast: 1,
            saturation: 1,
            tint: [1, 1, 1]
        },
        vignette: {
            enabled: false,
            intensity: 0.5,
            inner: 0.3,
            outer: 0.75,
            curvature: 1
        },
        fringing: { enabled: false, intensity: 0.5 },
        shadow: { ...DEFAULT_SHADOW }
    };
    if (noReveal) {
        snapshot.revealEffect = undefined;
        delete (snapshot as Record<string, unknown>).effects;
    } else {
        snapshot.revealEffect = { ...DEFAULT_REVEAL_EFFECT };
        snapshot.effects = JSON.parse(JSON.stringify(DEFAULT_EFFECTS));
        ensureRevealEffect(snapshot);
        normalizeEffectsOnImport(snapshot);
    }

    ensureLighting(snapshot);
    ensureTorchLight(snapshot);
    ensureBloom(snapshot);
    ensureBloomEditorSession(snapshot);
    normalizeBloomAfterImport(snapshot);
    normalizeBloomLocalLightRegions(snapshot);
    ensureSceneMediaHotspot(snapshot);

    return snapshot;
}

async function applyReset(global: Global, snapshot: ExperienceSettings): Promise<void> {
    applySettingsSnapshot(global, snapshot);
    (global as { __originalSettings?: ExperienceSettings }).__originalSettings =
        JSON.parse(JSON.stringify(snapshot)) as ExperienceSettings;

    global.state.hasRevealEffect = hasRevealInSettings(snapshot);
    syncEffectsRuntimeStateFromSettings(global.state, snapshot);

    await requestSceneAssetsRestore(global, { reason: 'settings-reset' });
    restoreAnnotationsFromSettings(global);
    restoreLightingFromSettings(global);
    restorePostEffectsFromSettings(global);
    restoreSkyboxFromSettings(global);

    clearPendingProjectThumbnail();

    global.state.selectedSceneEntityId = null;
    global.state.selectedAnnotationId = null;
    global.state.selectedLightId = null;
    global.events.fire('sceneAsset:selected');
    global.events.fire('annotation:deselected');

    const cam = (global.app as unknown as {
        viewer?: { cameraManager?: { reloadAnimFromSettings?: () => void } };
    }).viewer?.cameraManager;
    cam?.reloadAnimFromSettings?.();
    global.events.fire('camera:syncPrimaryInitial');

    const activeReveal = getRevealActiveType(global.state);
    if (activeReveal !== 'none') {
        global.events.fire('vfxExit');
        global.events.fire('revealRestart', false);
    }
    global.events.fire('hasRevealEffect:changed', global.state.hasRevealEffect);
}

export async function resetSceneSettings(global: Global): Promise<ResetResult> {
    const { projectId, token, noreveal: noReveal } = global.config;
    let pathFrom: ResetPathFrom = 'current';
    let snapshot: ExperienceSettings;

    if (projectId != null && projectId !== '' && token) {
        const fetchResult = await fetchOriginalTransform(projectId, token);
        if (fetchResult.ok === false) {
            return fetchResult;
        }
        if (fetchResult.found) {
            pathFrom = 'original';
            snapshot = settingsFromTransform(fetchResult.transform, noReveal);
        } else {
            snapshot = settingsKeepCamera(global, noReveal);
        }
    } else {
        snapshot = settingsKeepCamera(global, noReveal);
    }

    const current = global.settings as ExperienceSettings;
    if (current.background && typeof current.background === 'object') {
        snapshot.background = JSON.parse(JSON.stringify(current.background));
    }

    await applyReset(global, snapshot);
    return { ok: true, pathFrom };
}
