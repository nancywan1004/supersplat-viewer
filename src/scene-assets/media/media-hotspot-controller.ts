/**
 * 场景已放置 **video / audio** 的热区自动播控（Viewer 或 **编辑 + 预览模式**）。
 */

import * as pc from 'playcanvas';

import { ensureSceneMediaHotspot } from '../../settings-serialize/settings-serialize-helper';
import type { Global, ScenePlacedItem } from '../../types';
import { readViewMediaMuted } from '../../view-settings';
import {
    ensureScenePlacedMediaRuntime,
    getPlacedMediaRuntime,
    type PlacedAudioRuntime,
    type PlacedVideoRuntime
} from './media-runtime';
import { cameraForwardWorld, evaluateMediaHotspotAnchor } from './media-view-depth';
import {
    pausePlacedVideoTexture,
    playPlacedVideoTexture,
    tickPlacedVideoTextureUploads
} from './video-texture';

const EVAL_INTERVAL_MS = 120;
/** 不写入 settings：有声赢家切换冷却（毫秒） */
const MEDIA_HOTSPOT_MIN_TOGGLE_INTERVAL_MS = 500;

function isHotspotGateOpen(global: Global): boolean {
    const { state } = global;
    if (!state.editMode) return true;
    return state.previewMode === true;
}

function isPlacedAssetsRootEnabled(global: Global): boolean {
    const root = global.app.root.findByName('placedAssets') as { enabled?: boolean } | null;
    if (!root || typeof root.enabled !== 'boolean') return true;
    return root.enabled;
}

function isHotspotAutoplayEnabled(entry: ScenePlacedItem): boolean {
    return entry.hotspotAutoplay !== false;
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
    videoTriggerDistanceM: number;
    audioTriggerDistanceM: number;
};

function readSceneHotspotParams(global: Global): SceneHotspotParams {
    const sm = ensureSceneMediaHotspot(global.settings as any);
    const halfRad = sm.coneHalfDeg * pc.math.DEG_TO_RAD;
    return {
        eye: global.camera.getPosition(),
        forward: cameraForwardWorld(global.camera),
        cosCone: Math.cos(halfRad),
        videoTriggerDistanceM: Math.max(0.01, sm.videoTriggerDistanceM),
        audioTriggerDistanceM: Math.max(0.01, sm.audioTriggerDistanceM)
    };
}

type HotspotZoneEval = { inZone: boolean; depthM?: number };

/**
 * 单条目是否处于热区：视轴深度 ≤ 触发半径，且锚点在视锥锥内（与 settings.sceneMediaHotspot 一致）。
 */
function evaluateEntryHotspotZone(
    entry: ScenePlacedItem,
    kind: 'video' | 'audio',
    params: SceneHotspotParams
): HotspotZoneEval {
    if (!entry?.entity || entry.visible === false || entry.entity.enabled === false) {
        return { inZone: false };
    }
    if (!isHotspotAutoplayEnabled(entry)) {
        return { inZone: false };
    }
    const media = getPlacedMediaRuntime(entry.entity);
    if (!media || media.kind !== kind) {
        return { inZone: false };
    }

    const maxDepthM = kind === 'video' ? params.videoTriggerDistanceM : params.audioTriggerDistanceM;
    const evalResult = evaluateMediaHotspotAnchor(
        params.eye,
        params.forward,
        entry.entity.getPosition(),
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
    params: SceneHotspotParams
): { videos: QualifiedMedia[]; audios: QualifiedMedia[] } {
    const videos: QualifiedMedia[] = [];
    const audios: QualifiedMedia[] = [];
    const list = global.state.scenePlacedEntities ?? [];

    for (const entry of list) {
        const media = entry.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (!media) continue;
        const kind = media.kind;
        if (kind !== 'video' && kind !== 'audio') continue;

        const zone = evaluateEntryHotspotZone(entry, kind, params);
        if (!zone.inZone || zone.depthM === undefined) continue;

        if (kind === 'video') {
            videos.push({ id: entry.id, depthM: zone.depthM, entry });
        } else {
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

function pausePlacedAudio(m: PlacedAudioRuntime): void {
    try {
        m.audioEl.pause();
    } catch {
        // ignore
    }
    m.audioEl.volume = 0;
}

function clearAllHotspotPlayingFlags(global: Global): void {
    const { events } = global;
    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!entry.mediaRuntime?.hotspotPlaying) continue;
        ensureScenePlacedMediaRuntime(entry).hotspotPlaying = false;
        const kind = entry.assetType === 'video' ? 'video' : entry.assetType === 'audio' ? 'audio' : null;
        if (kind) {
            events.fire('mediaOverlay:playbackChanged', { id: entry.id, kind, playing: false });
        }
    }
}

function setEntryHotspotPlaying(
    global: Global,
    entry: ScenePlacedItem,
    kind: 'video' | 'audio',
    playing: boolean
): void {
    const rt = ensureScenePlacedMediaRuntime(entry);
    if (rt.hotspotPlaying === playing) return;
    rt.hotspotPlaying = playing;
    global.events.fire('mediaOverlay:playbackChanged', { id: entry.id, kind, playing });
}

/** 离开热区（距离+视锥）后清除手动暂停，下次进入可再次热区自动播放 */
function clearUserPausedAfterHotspotExit(entry: ScenePlacedItem): void {
    if (!entry.mediaRuntime?.userPaused) return;
    entry.mediaRuntime.userPaused = false;
}

/** 检测从热区内 → 热区外的边沿，仅在真正离开距离+视锥时重置 userPaused */
function syncHotspotZoneTransition(entry: ScenePlacedItem, inZone: boolean): void {
    const wasInZone = entry.mediaRuntime?.inHotspotZone === true;
    if (wasInZone && !inZone) {
        clearUserPausedAfterHotspotExit(entry);
    }
    if (entry.mediaRuntime || inZone) {
        ensureScenePlacedMediaRuntime(entry).inHotspotZone = inZone;
    }
}

function pauseAudioAndVideoPosters(global: Global): void {
    const list = global.state.scenePlacedEntities ?? [];
    for (const entry of list) {
        const m = entry.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (!m) continue;
        if (m.kind === 'video' && entry.entity) {
            pausePlacedVideoTexture(m);
            setEntryHotspotPlaying(global, entry, 'video', false);
            continue;
        }
        if (m.kind === 'audio') {
            pausePlacedAudio(m);
            setEntryHotspotPlaying(global, entry, 'audio', false);
        }
    }
}

function pauseAllMedia(global: Global): void {
    const list = global.state.scenePlacedEntities ?? [];
    for (const entry of list) {
        const m = entry.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (!m) continue;
        if (m.kind === 'video' && entry.entity) {
            pausePlacedVideoTexture(m);
            setEntryHotspotPlaying(global, entry, 'video', false);
        }
        if (m.kind === 'audio') {
            pausePlacedAudio(m);
            setEntryHotspotPlaying(global, entry, 'audio', false);
        }
    }
}

function applyHotspotPlayback(
    global: Global,
    evalState: HotspotEvalState,
    hotspotParams: SceneHotspotParams,
    videos: QualifiedMedia[],
    audios: QualifiedMedia[],
    now: number
): void {
    let desiredVideoSound = videos.length > 0 ? videos[0].id : null;
    let desiredAudioSound = desiredVideoSound ? null : (audios.length > 0 ? audios[0].id : null);

    const cooldown = Math.max(0, MEDIA_HOTSPOT_MIN_TOGGLE_INTERVAL_MS);
    const vChanged = desiredVideoSound !== evalState.lastVideoSoundId;
    const aChanged = desiredAudioSound !== evalState.lastAudioSoundId;
    if ((vChanged || aChanged) && (evalState.lastVideoSoundId || evalState.lastAudioSoundId)) {
        if (now - evalState.lastSwitchMs < cooldown) {
            desiredVideoSound = evalState.lastVideoSoundId;
            desiredAudioSound = evalState.lastVideoSoundId ? null : evalState.lastAudioSoundId;
        } else {
            evalState.lastSwitchMs = now;
        }
    } else if (vChanged || aChanged) {
        evalState.lastSwitchMs = now;
    }

    evalState.lastVideoSoundId = desiredVideoSound;
    evalState.lastAudioSoundId = desiredAudioSound;

    const viewMediaMuted = readViewMediaMuted(global);
    const list = global.state.scenePlacedEntities ?? [];

    for (const entry of list) {
        const m = entry.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (!m) continue;

        if (m.kind === 'video') {
            const entity = entry.entity;
            if (!entity) continue;
            const { inZone: inHotspotZone } = evaluateEntryHotspotZone(entry, 'video', hotspotParams);
            syncHotspotZoneTransition(entry, inHotspotZone);
            const winner = entry.id === desiredVideoSound;
            const shouldPlay =
                inHotspotZone
                && winner
                && !entry.mediaRuntime?.userPaused
                && evalState.userUnlocked
                && !viewMediaMuted;

            if (!inHotspotZone) {
                pausePlacedVideoTexture(m);
                setEntryHotspotPlaying(global, entry, 'video', false);
                continue;
            }

            if (shouldPlay) {
                playPlacedVideoTexture(entity, m);
                m.videoEl.muted = false;
                setEntryHotspotPlaying(global, entry, 'video', true);
            } else {
                pausePlacedVideoTexture(m);
                setEntryHotspotPlaying(global, entry, 'video', false);
            }
            continue;
        }

        if (m.kind === 'audio') {
            const a = m.audioEl;
            const { inZone: inHotspotZone } = evaluateEntryHotspotZone(entry, 'audio', hotspotParams);
            syncHotspotZoneTransition(entry, inHotspotZone);

            if (desiredVideoSound) {
                pausePlacedAudio(m);
                setEntryHotspotPlaying(global, entry, 'audio', false);
                continue;
            }

            if (!inHotspotZone) {
                pausePlacedAudio(m);
                setEntryHotspotPlaying(global, entry, 'audio', false);
                continue;
            }

            const winner = entry.id === desiredAudioSound;
            const shouldPlay =
                winner
                && !entry.mediaRuntime?.userPaused
                && evalState.userUnlocked
                && !viewMediaMuted;

            if (shouldPlay) {
                a.volume = 1;
                a.play().catch(() => {
                    // ignore autoplay / decode errors
                });
                setEntryHotspotPlaying(global, entry, 'audio', true);
            } else {
                pausePlacedAudio(m);
                setEntryHotspotPlaying(global, entry, 'audio', false);
            }
        }
    }
}

function runMediaHotspotEvaluation(
    global: Global,
    evalState: HotspotEvalState,
    options?: { force?: boolean }
): boolean {
    if (evalState.pageHidden) {
        pauseAllMedia(global);
        return false;
    }
    if (!isPlacedAssetsRootEnabled(global)) {
        pauseAllMedia(global);
        return false;
    }
    if (!isHotspotGateOpen(global)) {
        pauseAudioAndVideoPosters(global);
        return false;
    }

    const now = performance.now();
    if (!options?.force && now - evalState.lastEvalMs < EVAL_INTERVAL_MS) {
        return false;
    }
    evalState.lastEvalMs = now;

    const hotspotParams = readSceneHotspotParams(global);
    const { videos, audios } = qualifyPlacedMedia(global, hotspotParams);
    applyHotspotPlayback(global, evalState, hotspotParams, videos, audios, now);
    return true;
}

/**
 * 注册热区评估与用户手势解锁（首次 pointerdown）。
 */
export function initMediaHotspotController(global: Global): () => void {
    const { app, events } = global;
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
            pauseAllMedia(global);
            return;
        }
        uploadToggle = !uploadToggle;
        if (isEditModeWithoutPreview(global)) {
            pauseAudioAndVideoPosters(global);
        } else {
            runMediaHotspotEvaluation(global, evalState);
        }
        tickPlacedVideoTextureUploads(collectLiveVideos(), uploadToggle);
    };

    const onPageHidden = () => {
        evalState.pageHidden = true;
        pauseAllMedia(global);
    };

    const onPageVisible = () => {
        evalState.pageHidden = false;
        evalState.lastEvalMs = 0;
        if (isEditModeWithoutPreview(global)) {
            pauseAudioAndVideoPosters(global);
        } else {
            runMediaHotspotEvaluation(global, evalState, { force: true });
        }
    };

    const onVisibilityChange = () => {
        if (document.hidden) onPageHidden();
        else onPageVisible();
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHidden);
    window.addEventListener('pageshow', onPageVisible);

    app.on('update', onUpdate);

    const forceHotspotEval = () => {
        evalState.lastEvalMs = 0;
        runMediaHotspotEvaluation(global, evalState, { force: true });
    };

    const onPreviewModeChanged = (previewMode: boolean) => {
        if (previewMode) {
            evalState.userUnlocked = true;
        }
        forceHotspotEval();
    };

    const onHotspotChanged = () => {
        forceHotspotEval();
    };

    const onUserActivate = () => {
        evalState.userUnlocked = true;
        forceHotspotEval();
    };

    const onEditModeChanged = () => {
        evalState.lastEvalMs = 0;
        if (!global.state.editMode) {
            evalState.userUnlocked = false;
            evalState.lastVideoSoundId = null;
            evalState.lastAudioSoundId = null;
        }
        if (evalState.pageHidden) {
            pauseAllMedia(global);
            return;
        }
        if (isEditModeWithoutPreview(global)) {
            pauseAudioAndVideoPosters(global);
        } else {
            runMediaHotspotEvaluation(global, evalState, { force: true });
        }
    };

    const onViewMediaMutedChanged = () => {
        forceHotspotEval();
    };

    const onOverlayUserPlayback = () => {
        evalState.userUnlocked = true;
    };

    events.on('sceneMediaHotspot:changed', onHotspotChanged);
    events.on('viewMediaMuted:changed', onViewMediaMutedChanged);
    events.on('previewMode:changed', onPreviewModeChanged);
    events.on('mediaHotspot:userActivate', onUserActivate);
    events.on('mediaOverlay:userPlayback', onOverlayUserPlayback);
    events.on('editMode:changed', onEditModeChanged);
    events.on('sceneAsset:hotspotAutoplayChanged', onHotspotChanged);

    return () => {
        window.removeEventListener('pointerdown', onPointerDown, true);
        document.removeEventListener('visibilitychange', onVisibilityChange);
        window.removeEventListener('pagehide', onPageHidden);
        window.removeEventListener('pageshow', onPageVisible);
        app.off('update', onUpdate);
        events.off('sceneMediaHotspot:changed', onHotspotChanged);
        events.off('viewMediaMuted:changed', onViewMediaMutedChanged);
        events.off('previewMode:changed', onPreviewModeChanged);
        events.off('mediaHotspot:userActivate', onUserActivate);
        events.off('mediaOverlay:userPlayback', onOverlayUserPlayback);
        events.off('editMode:changed', onEditModeChanged);
        events.off('sceneAsset:hotspotAutoplayChanged', onHotspotChanged);
        clearAllHotspotPlayingFlags(global);
        pauseAllMedia(global);
    };
}
