/**
 * 场景已放置 video/audio 的**热区评估**（距离、视锥、赢家、冷却）。
 * 实际 play/pause / 互斥 / 用户意图见 {@link ./scene-media-playback.ts}。
 */

import * as pc from 'playcanvas';

import { ensureSceneMediaHotspot } from '../../settings-serialize/settings-serialize-helper';
import type { ExperienceSettings } from '../../schemas/v2';
import type { Global, ScenePlacedItem } from '../../types';
import { readViewMediaMuted } from '../../view-settings';
import {
    ensureScenePlacedMediaRuntime,
    getPlacedMediaRuntime,
    type PlacedVideoRuntime
} from './media-runtime';
import {
    isHotspotGateOpen,
    readEntryTriggerDistanceM,
    readGlobalAudioHotspotAutoplayEnabledFromSettings,
    readGlobalVideoHotspotAutoplayEnabledFromSettings
} from './media-hotspot-params';
import {
    cameraForwardWorld,
    evaluateAudioHotspotAnchor,
    evaluateMediaHotspotAnchor
} from './media-view-depth';
import {
    clearAllSceneMediaPlaybackFlags,
    ensureSceneVideoFramePlaying,
    getActiveSceneMediaEntryId,
    pauseAllSceneMedia,
    pauseSceneMediaEntry,
    playSceneMediaEntry,
    resetAllSceneMediaToInitial,
    setActiveSceneMediaSoundId
} from './scene-media-playback';
import { initPlacedVideoTextureUploadFlush, tickPlacedVideoTextureUploads } from './video-texture';

const EVAL_INTERVAL_MS = 120;
/** 不写入 settings：有声赢家切换冷却（毫秒） */
const MEDIA_HOTSPOT_MIN_TOGGLE_INTERVAL_MS = 500;

function isPlacedAssetsRootEnabled(global: Global): boolean {
    const root = global.app.root.findByName('placedAssets') as { enabled?: boolean } | null;
    if (!root || typeof root.enabled !== 'boolean') return true;
    return root.enabled;
}

function isPlacedMediaVisible(entry: ScenePlacedItem): boolean {
    if (!entry?.entity || entry.visible === false || entry.entity.enabled === false) {
        return false;
    }
    const media = getPlacedMediaRuntime(entry.entity);
    return !!media && (media.kind === 'video' || media.kind === 'audio');
}

function pickQualifiedSoundId(
    desiredId: string | null,
    qualified: QualifiedMedia[]
): string | null {
    if (!desiredId) return null;
    return qualified.some((q) => q.id === desiredId) ? desiredId : null;
}

type QualifiedMedia = {
    id: string;
    depthM: number;
    entry: ScenePlacedItem;
};

type SceneHotspotParams = {
    eye: pc.Vec3;
    forward: pc.Vec3;
    cosCone: number;
    settings: ExperienceSettings;
};

function readSceneHotspotParams(global: Global): SceneHotspotParams {
    const sm = ensureSceneMediaHotspot(global.settings as ExperienceSettings);
    const halfRad = sm.video.coneHalfDeg * pc.math.DEG_TO_RAD;
    return {
        eye: global.camera.getPosition(),
        forward: cameraForwardWorld(global.camera),
        cosCone: Math.cos(halfRad),
        settings: global.settings as ExperienceSettings
    };
}

type HotspotZoneEval = { inZone: boolean; depthM?: number };

function evaluateEntryHotspotZone(
    entry: ScenePlacedItem,
    kind: 'video' | 'audio',
    params: SceneHotspotParams
): HotspotZoneEval {
    if (!isPlacedMediaVisible(entry)) {
        return { inZone: false };
    }
    const media = getPlacedMediaRuntime(entry.entity!);
    if (!media || media.kind !== kind) {
        return { inZone: false };
    }

    const anchor = entry.entity!.getPosition();
    const maxDepthM = readEntryTriggerDistanceM(entry, kind, params.settings);
    const evalResult =
        kind === 'audio'
            ? evaluateAudioHotspotAnchor(params.eye, anchor, maxDepthM)
            : evaluateMediaHotspotAnchor(
                params.eye,
                params.forward,
                anchor,
                maxDepthM,
                params.cosCone
            );
    if (!evalResult.ok) {
        return { inZone: false };
    }
    return { inZone: true, depthM: evalResult.depthM };
}

function qualifyPlacedMedia(
    global: Global,
    params: SceneHotspotParams,
    options: { globalVideoAutoplay: boolean; globalAudioAutoplay: boolean }
): { videos: QualifiedMedia[]; audios: QualifiedMedia[] } {
    const videos: QualifiedMedia[] = [];
    const audios: QualifiedMedia[] = [];
    const list = global.state.scenePlacedEntities ?? [];

    for (const entry of list) {
        const media = entry.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (!media) continue;
        const kind = media.kind;
        if (kind !== 'video' && kind !== 'audio') continue;
        if (entry.mediaRuntime?.userPaused === true) continue;

        const zone = evaluateEntryHotspotZone(entry, kind, params);
        if (!zone.inZone || zone.depthM === undefined) continue;

        if (kind === 'video') {
            if (!options.globalVideoAutoplay) continue;
            videos.push({ id: entry.id, depthM: zone.depthM, entry });
        } else {
            if (!options.globalAudioAutoplay) continue;
            audios.push({ id: entry.id, depthM: zone.depthM, entry });
        }
    }

    videos.sort((a, b) => a.depthM - b.depthM);
    audios.sort((a, b) => a.depthM - b.depthM);
    return { videos, audios };
}

type HotspotEvalState = {
    lastEvalMs: number;
    lastVideoSoundId: string | null;
    lastAudioSoundId: string | null;
    lastSwitchMs: number;
    userUnlocked: boolean;
    pageHidden: boolean;
};

function isEditModeWithoutPreview(global: Global): boolean {
    const { state } = global;
    return state.editMode === true && state.previewMode !== true;
}

/** 离开热区后清除 userPaused，下次进入可再次热区自动播放 */
function clearUserPausedAfterHotspotExit(entry: ScenePlacedItem): void {
    if (!entry.mediaRuntime?.userPaused) return;
    entry.mediaRuntime.userPaused = false;
}

function syncHotspotZoneTransition(entry: ScenePlacedItem, inZone: boolean): void {
    const wasInZone = entry.mediaRuntime?.inHotspotZone === true;
    if (wasInZone && !inZone) {
        clearUserPausedAfterHotspotExit(entry);
    }
    if (entry.mediaRuntime || inZone) {
        ensureScenePlacedMediaRuntime(entry).inHotspotZone = inZone;
    }
}

/**
 * 出声赢家选取：
 * 1. 当前 `activeSceneMediaEntryId` 仍在候选集中 → 沿用（尊重用户手动偏好 / 上一帧赢家）。
 * 2. 否则取距离最近者。
 */
function pickPreferredSoundId(candidates: QualifiedMedia[], preferred: string | null): string | null {
    if (preferred && candidates.some(c => c.id === preferred)) return preferred;
    return candidates[0]?.id ?? null;
}

function applyHotspotPlayback(
    global: Global,
    evalState: HotspotEvalState,
    hotspotParams: SceneHotspotParams,
    videos: QualifiedMedia[],
    audios: QualifiedMedia[],
    now: number
): void {
    const preferred = getActiveSceneMediaEntryId();
    let desiredVideoSound = pickPreferredSoundId(videos, preferred);
    let desiredAudioSound = desiredVideoSound ? null : pickPreferredSoundId(audios, preferred);

    const cooldown = Math.max(0, MEDIA_HOTSPOT_MIN_TOGGLE_INTERVAL_MS);
    const vChanged = desiredVideoSound !== evalState.lastVideoSoundId;
    const aChanged = desiredAudioSound !== evalState.lastAudioSoundId;
    if ((vChanged || aChanged) && (evalState.lastVideoSoundId || evalState.lastAudioSoundId)) {
        if (now - evalState.lastSwitchMs < cooldown) {
            desiredVideoSound =
                pickQualifiedSoundId(evalState.lastVideoSoundId, videos) ?? (videos[0]?.id ?? null);
            desiredAudioSound = desiredVideoSound
                ? null
                : (pickQualifiedSoundId(evalState.lastAudioSoundId, audios) ?? (audios[0]?.id ?? null));
        } else {
            evalState.lastSwitchMs = now;
        }
    } else if (vChanged || aChanged) {
        evalState.lastSwitchMs = now;
    }

    desiredVideoSound = pickQualifiedSoundId(desiredVideoSound, videos) ?? (videos[0]?.id ?? null);
    desiredAudioSound = desiredVideoSound
        ? null
        : (pickQualifiedSoundId(desiredAudioSound, audios) ?? (audios[0]?.id ?? null));

    evalState.lastVideoSoundId = desiredVideoSound;
    evalState.lastAudioSoundId = desiredAudioSound;

    const viewMediaMuted = readViewMediaMuted(global);
    const globalVideoAutoplay = readGlobalVideoHotspotAutoplayEnabledFromSettings(hotspotParams.settings);
    const list = global.state.scenePlacedEntities ?? [];

    let videoSoundOwner: string | null = null;

    for (const entry of list) {
        const m = entry.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (!m || m.kind !== 'video') continue;

        if (!isPlacedMediaVisible(entry)) {
            pauseSceneMediaEntry(global, entry, { releaseActiveSlot: false });
            continue;
        }
        const { inZone: inHotspotZone } = evaluateEntryHotspotZone(entry, 'video', hotspotParams);
        syncHotspotZoneTransition(entry, inHotspotZone);

        if (!inHotspotZone
            || !globalVideoAutoplay
            || entry.mediaRuntime?.userPaused === true
            || !evalState.userUnlocked
        ) {
            pauseSceneMediaEntry(global, entry, { releaseActiveSlot: false });
            continue;
        }

        const wantSound = entry.id === desiredVideoSound && !viewMediaMuted;
        ensureSceneVideoFramePlaying(global, entry, { muted: !wantSound });
        if (wantSound) videoSoundOwner = entry.id;
    }

    let audioSoundOwner: string | null = null;

    for (const entry of list) {
        const m = entry.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (!m || m.kind !== 'audio') continue;

        if (!isPlacedMediaVisible(entry)) {
            pauseSceneMediaEntry(global, entry, { releaseActiveSlot: false });
            continue;
        }
        const { inZone: inHotspotZone } = evaluateEntryHotspotZone(entry, 'audio', hotspotParams);
        syncHotspotZoneTransition(entry, inHotspotZone);

        const shouldPlay =
            inHotspotZone
            && videoSoundOwner === null
            && entry.id === desiredAudioSound
            && entry.mediaRuntime?.userPaused !== true
            && evalState.userUnlocked
            && !viewMediaMuted;

        if (shouldPlay) {
            playSceneMediaEntry(global, entry);
            audioSoundOwner = entry.id;
        } else {
            pauseSceneMediaEntry(global, entry, { releaseActiveSlot: false });
        }
    }

    setActiveSceneMediaSoundId(videoSoundOwner ?? audioSoundOwner);
}

function runMediaHotspotEvaluation(
    global: Global,
    evalState: HotspotEvalState,
    options?: { force?: boolean }
): boolean {
    if (evalState.pageHidden) {
        pauseAllSceneMedia(global);
        return false;
    }
    if (!isPlacedAssetsRootEnabled(global)) {
        pauseAllSceneMedia(global);
        return false;
    }
    if (!isHotspotGateOpen(global)) {
        // 编辑非预览：热区门关闭，不评估也不强制 pause；
        // 进入该模式时已由 onPreviewModeChanged / onEditModeChanged 调
        // resetAllSceneMediaToInitial 统一停 + 归零，之后只允许手动播放。
        return false;
    }

    const now = performance.now();
    if (!options?.force && now - evalState.lastEvalMs < EVAL_INTERVAL_MS) {
        return false;
    }
    evalState.lastEvalMs = now;

    const hotspotParams = readSceneHotspotParams(global);
    const globalVideoAutoplay = readGlobalVideoHotspotAutoplayEnabledFromSettings(hotspotParams.settings);
    const globalAudioAutoplay = readGlobalAudioHotspotAutoplayEnabledFromSettings(hotspotParams.settings);
    const { videos, audios } = qualifyPlacedMedia(global, hotspotParams, {
        globalVideoAutoplay,
        globalAudioAutoplay
    });
    applyHotspotPlayback(global, evalState, hotspotParams, videos, audios, now);
    return true;
}

/**
 * 注册热区评估与用户手势解锁（首次 pointerdown）。
 */
export function initMediaHotspotController(global: Global): () => void {
    const { app, events } = global;
    const cleanupTextureUploadFlush = initPlacedVideoTextureUploadFlush(app);
    const evalState: HotspotEvalState = {
        lastEvalMs: 0,
        lastVideoSoundId: null,
        lastAudioSoundId: null,
        lastSwitchMs: 0,
        userUnlocked: false,
        pageHidden: typeof document !== 'undefined' && document.hidden
    };
    const onPointerDown = () => {
        evalState.userUnlocked = true;
    };
    window.addEventListener('pointerdown', onPointerDown, { capture: true });

    let uploadToggle = false;

    const collectLiveVideos = (): PlacedVideoRuntime[] => {
        const out: PlacedVideoRuntime[] = [];
        for (const entry of global.state.scenePlacedEntities ?? []) {
            if (!entry?.entity) continue;
            const m = getPlacedMediaRuntime(entry.entity);
            if (m?.kind === 'video' && m.isLive) out.push(m);
        }
        return out;
    };

    const onUpdate = () => {
        if (evalState.pageHidden) {
            pauseAllSceneMedia(global);
            return;
        }
        uploadToggle = !uploadToggle;
        // 编辑非预览模式下不再做热区评估也不强制 pause；
        // 这样用户在编辑模式手动播放的视频可持续推帧而不被打断。
        if (!isEditModeWithoutPreview(global)) {
            runMediaHotspotEvaluation(global, evalState);
        }
        if (uploadToggle) {
            tickPlacedVideoTextureUploads(collectLiveVideos(), uploadToggle);
        }
    };

    const forceHotspotEval = () => {
        runMediaHotspotEvaluation(global, evalState, { force: true });
    };

    const onVisibilityChange = () => {
        evalState.pageHidden = document.hidden;
        if (evalState.pageHidden) {
            pauseAllSceneMedia(global);
        } else {
            forceHotspotEval();
        }
    };

    const onPageHidden = () => {
        evalState.pageHidden = true;
        pauseAllSceneMedia(global);
    };

    const onPageVisible = () => {
        evalState.pageHidden = false;
        forceHotspotEval();
    };

    const onPreviewModeChanged = (previewMode: boolean) => {
        // 任意 preview 切换都按「初始态」处理：停 + 进度归零 + 清 flag。
        // - 进预览：随后 forceHotspotEval 按 settings 决定是否自动播。
        // - 退预览（回编辑非预览）：保持初始态，等待用户手动播放。
        evalState.lastVideoSoundId = null;
        evalState.lastAudioSoundId = null;
        evalState.lastEvalMs = 0;
        if (previewMode) {
            evalState.userUnlocked = true;
        }
        resetAllSceneMediaToInitial(global);
        forceHotspotEval();
    };

    const onHotspotChanged = () => {
        forceHotspotEval();
    };

    const onUserActivate = () => {
        evalState.userUnlocked = true;
        if (!isEditModeWithoutPreview(global)) {
            forceHotspotEval();
        }
    };

    const onEditModeChanged = () => {
        // view ⇄ edit 切换：与 preview 切换一致——统一初始态。
        // 退到 viewer 时把 userUnlocked 重置为 false，让首次 pointerdown 重新解锁声音。
        evalState.lastVideoSoundId = null;
        evalState.lastAudioSoundId = null;
        evalState.lastEvalMs = 0;
        if (!global.state.editMode) {
            evalState.userUnlocked = false;
        }
        resetAllSceneMediaToInitial(global);
        if (evalState.pageHidden) return;
        forceHotspotEval();
    };

    const onViewMediaMutedChanged = () => {
        forceHotspotEval();
    };

    const onOverlayUserPlayback = () => {
        evalState.userUnlocked = true;
    };

    events.on('sceneMediaHotspot:changed', onHotspotChanged);
    events.on('sceneAsset:triggerDistanceChanged', onHotspotChanged);
    events.on('viewMediaMuted:changed', onViewMediaMutedChanged);
    events.on('previewMode:changed', onPreviewModeChanged);
    events.on('mediaHotspot:userActivate', onUserActivate);
    events.on('mediaOverlay:userPlayback', onOverlayUserPlayback);
    events.on('editMode:changed', onEditModeChanged);

    app.on('update', onUpdate);
    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHidden);
    window.addEventListener('pageshow', onPageVisible);

    return () => {
        cleanupTextureUploadFlush();
        window.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('pagehide', onPageHidden);
        window.removeEventListener('pageshow', onPageVisible);
        app.off('update', onUpdate);
        events.off('sceneMediaHotspot:changed', onHotspotChanged);
        events.off('sceneAsset:triggerDistanceChanged', onHotspotChanged);
        events.off('viewMediaMuted:changed', onViewMediaMutedChanged);
        events.off('previewMode:changed', onPreviewModeChanged);
        events.off('mediaHotspot:userActivate', onUserActivate);
        events.off('mediaOverlay:userPlayback', onOverlayUserPlayback);
        events.off('editMode:changed', onEditModeChanged);
        clearAllSceneMediaPlaybackFlags(global);
        pauseAllSceneMedia(global);
    };
}
