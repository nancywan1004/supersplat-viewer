/**
 * 场景已放置 **video / audio** 的热区自动播控（Viewer 或 **编辑 + 预览模式**）。
 *
 * ## 性能后续迭代（计划 §8，此处仅占位说明）
 * - 将评估由固定间隔节流扩展为「相机移动超阈值再算」。
 * - 锥外 / 热区外对 HTML 媒体 `pause`、可选延迟 `src` 卸载；热区内并发 `play` 路数上限 N。
 * - 同 URL 的 VideoTexture / 元素池化复用；弱网首帧与指标埋点。
 */

import * as pc from 'playcanvas';

import { ensureSceneMediaHotspot } from '../../settings-serialize/settings-serialize-helper';
import type { Global, ScenePlacedItem } from '../../types';
import { readViewMediaMuted } from '../../view-settings';
import {
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
/** 仅编辑态（非预览）显示 speaker icon；Viewer / 预览模式不显示 */
const MEDIA_HOTSPOT_SHOW_AUDIO_ICON_IN_EDIT = true;

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

type QualifiedMedia = {
    id: string;
    /** 视轴深度（米），用于阈值与「最近」排序 */
    depthM: number;
    entry: ScenePlacedItem;
};

function qualifyPlacedMedia(global: Global): { videos: QualifiedMedia[]; audios: QualifiedMedia[] } {
    const sm = ensureSceneMediaHotspot(global.settings as any);
    const cam = global.camera;
    const eye = cam.getPosition();
    const forward = cameraForwardWorld(cam);
    const halfRad = sm.coneHalfDeg * pc.math.DEG_TO_RAD;
    const cosCone = Math.cos(halfRad);
    const videoR = Math.max(0.01, sm.videoTriggerDistanceM);
    const audioR = Math.max(0.01, sm.audioTriggerDistanceM);

    const videos: QualifiedMedia[] = [];
    const audios: QualifiedMedia[] = [];
    const list = global.state.scenePlacedEntities ?? [];

    for (const entry of list) {
        if (!entry?.entity || entry.visible === false || entry.entity.enabled === false) continue;
        const media = getPlacedMediaRuntime(entry.entity);
        if (!media) continue;
        const kind = media.kind;
        if (kind !== 'video' && kind !== 'audio') continue;

        const anchor = entry.entity.getPosition();
        const maxDepthM = kind === 'video' ? videoR : audioR;
        const evalResult = evaluateMediaHotspotAnchor(eye, forward, anchor, maxDepthM, cosCone);
        //console.log('evalResult', evalResult);
        if (!evalResult.ok) continue;

        const { depthM } = evalResult;
        if (kind === 'video') {
            videos.push({ id: entry.id, depthM, entry });
        } else {
            audios.push({ id: entry.id, depthM, entry });
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
    /** 标签页隐藏 / 切后台：禁止热区重新 play */
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

/** 与图片放置卡片一致：立屏平面 + 水平 yaw 朝向相机（比 `lookAt` 更稳） */
function billboardAudioIconEntity(iconEntity: pc.Entity, camPos: pc.Vec3): void {
    const pos = iconEntity.getPosition();
    const dx = camPos.x - pos.x;
    const dz = camPos.z - pos.z;
    const yawDeg = Math.atan2(dx, dz) * pc.math.RAD_TO_DEG;
    iconEntity.setEulerAngles(-90, yawDeg, 180);
}

/**
 * 编辑态（非预览）下单个音频根实体：显示 speaker 并 billboard。
 */
export function syncPlacedAudioIconEditor(global: Global, rootEntity: pc.Entity): void {
    if (!isEditModeWithoutPreview(global)) return;
    const m = getPlacedMediaRuntime(rootEntity);
    if (m?.kind !== 'audio') return;
    m.iconEntity.enabled = MEDIA_HOTSPOT_SHOW_AUDIO_ICON_IN_EDIT;
    billboardAudioIconEntity(m.iconEntity, global.camera.getPosition());
}

function hideAllAudioIcons(global: Global): void {
    for (const entry of global.state.scenePlacedEntities ?? []) {
        const m = entry?.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (m?.kind === 'audio') {
            m.iconEntity.enabled = false;
        }
    }
}

/**
 * 编辑态（非预览）：音频 icon 始终朝向相机，便于辨认放置点。
 */
function updateEditorAudioIconBillboards(global: Global): void {
    if (!isEditModeWithoutPreview(global)) return;
    const camPos = global.camera.getPosition();
    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!entry?.entity || entry.visible === false || entry.entity.enabled === false) continue;
        const m = getPlacedMediaRuntime(entry.entity);
        if (m?.kind !== 'audio') continue;
        m.iconEntity.enabled = MEDIA_HOTSPOT_SHOW_AUDIO_ICON_IN_EDIT;
        billboardAudioIconEntity(m.iconEntity, camPos);
    }
}

/**
 * 编辑非预览等「热区门关闭」：停播；编辑态仍显示并对齐音频 icon。
 * @param global - Viewer 全局
 */
function pauseAudioAndVideoPosters(global: Global): void {
    const keepAudioIcons = isEditModeWithoutPreview(global);
    const list = global.state.scenePlacedEntities ?? [];
    for (const entry of list) {
        const m = entry.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (!m) continue;
        if (m.kind === 'video' && entry.entity) {
            pausePlacedVideoTexture(m);
            continue;
        }
        if (m.kind === 'audio') {
            pausePlacedAudio(m);
            if (!keepAudioIcons) {
                m.iconEntity.enabled = false;
            }
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
        }
        if (m.kind === 'audio') {
            pausePlacedAudio(m);
            m.iconEntity.enabled = false;
        }
    }
}

function applyHotspotPlayback(
    global: Global,
    evalState: HotspotEvalState,
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

    const videoIdSet = new Set(videos.map(v => v.id));
    const audioIdSet = new Set(audios.map(a => a.id));
    const list = global.state.scenePlacedEntities ?? [];

    for (const entry of list) {
        const m = entry.entity ? getPlacedMediaRuntime(entry.entity) : undefined;
        if (!m) continue;

        if (m.kind === 'video') {
            const entity = entry.entity;
            if (!entity) continue;
            if (!videoIdSet.has(entry.id)) {
                pausePlacedVideoTexture(m);
                continue;
            }
            playPlacedVideoTexture(entity, m);
            const winner = entry.id === desiredVideoSound;
            m.videoEl.muted = viewMediaMuted || !(winner && evalState.userUnlocked);
        }

        if (m.kind === 'audio') {
            const a = m.audioEl;
            m.iconEntity.enabled = false;

            if (desiredVideoSound) {
                pausePlacedAudio(m);
                continue;
            }

            if (!audioIdSet.has(entry.id)) {
                pausePlacedAudio(m);
                continue;
            }

            const winner = entry.id === desiredAudioSound;
            if (winner && evalState.userUnlocked && !viewMediaMuted) {
                a.volume = 1;
                a.play().catch(() => {
                    // ignore autoplay / decode errors
                });
            } else {
                pausePlacedAudio(m);
            }
        }
    }
}

/**
 * 执行一轮热区评估（门控关闭时暂停；`force` 跳过节流）。
 * @param global - Viewer 全局
 * @param evalState - 控制器内部状态
 * @param options - 选项
 * @param options.force - 为 true 时跳过节流立即评估
 * @returns 本轮是否执行了播控逻辑
 */
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

    const { videos, audios } = qualifyPlacedMedia(global);
    applyHotspotPlayback(global, evalState, videos, audios, now);
    return true;
}

/**
 * 注册热区评估、音频 icon billboard、用户手势解锁（首次 pointerdown）。
 * @param global - Viewer 全局对象
 * @returns 卸载函数
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
            updateEditorAudioIconBillboards(global);
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
            updateEditorAudioIconBillboards(global);
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
            hideAllAudioIcons(global);
        } else if (isEditModeWithoutPreview(global)) {
            updateEditorAudioIconBillboards(global);
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
            updateEditorAudioIconBillboards(global);
        } else {
            runMediaHotspotEvaluation(global, evalState, { force: true });
        }
    };

    const onSceneAssetsAdded = (entry: ScenePlacedItem) => {
        if (!entry?.entity || entry.assetType !== 'audio') return;
        syncPlacedAudioIconEditor(global, entry.entity);
    };

    const onViewMediaMutedChanged = () => {
        forceHotspotEval();
    };

    events.on('sceneMediaHotspot:changed', onHotspotChanged);
    events.on('viewMediaMuted:changed', onViewMediaMutedChanged);
    events.on('previewMode:changed', onPreviewModeChanged);
    events.on('mediaHotspot:userActivate', onUserActivate);
    events.on('editMode:changed', onEditModeChanged);
    events.on('sceneAssets:added', onSceneAssetsAdded);

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
        events.off('editMode:changed', onEditModeChanged);
        events.off('sceneAssets:added', onSceneAssetsAdded);
        pauseAllMedia(global);
    };
}
