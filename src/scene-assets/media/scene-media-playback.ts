/**
 * 场景已放置 video/audio 的**统一播控策略**（执行层）。
 *
 * ## 职责边界
 *
 * - **本文件**：play/pause 与"出声"的分轨互斥、用户意图（`userPaused`）、UI 事件。
 * - **`media-hotspot-controller.ts`**：是否「该由热区自动播」——触发距离/视锥、赢家、冷却、
 *   `userUnlocked`、编辑非预览门；满足后调用 `ensureSceneVideoFramePlaying` / `playSceneMediaEntry`。
 * - **`video-controls-texture.ts` / `audio-callout.ts`**：命中与绘制；用户点击走
 *   `userPlaySceneMedia` / `userPauseSceneMedia`。
 *
 * ## 核心不变量
 *
 * 1. **出声唯一**：`activeSceneMediaEntryId` 指当前出声的 entry；视频赢家优先于音频。
 * 2. **画面非互斥**：热区内的视频允许同时推帧 + 静音（仅赢家不静音）。音频没有画面，
 *    非赢家直接 pause。
 * 3. **用户意图**：`userPaused === true` 阻止热区评估 play 本条；被静音的其它视频不会
 *    被自动写 `userPaused`，离开热区或赢家变更后仍可继续/不再发声。
 * 4. **UI**：`mediaRuntime.hotspotPlaying` 与 `mediaOverlay:playbackChanged` 仅经
 *    `syncEntryPlaybackUi` 更新（手动播 / 热区播共用）。
 *
 * ## 调用关系（简图）
 *
 *   控制器视频循环  → ensureSceneVideoFramePlaying(entry, { muted })
 *   控制器音频循环  → playSceneMediaEntry(audio, 'hotspot')
 *   用户点击播放钮  → userPlaySceneMedia → playSceneMediaEntry(entry, 'user')
 *   赢家收尾        → setActiveSceneMediaSoundId(videoOwner ?? audioOwner)
 */

import type { Global, ScenePlacedItem } from '../../types';
import {
    ensureScenePlacedMediaRuntime,
    getPlacedMediaRuntime,
    type PlacedAudioRuntime,
    type PlacedVideoRuntime
} from './media-runtime';
import { pausePlacedVideoTexture, playPlacedVideoTexture } from './video-texture';

/**
 * 播放入口来源。仅影响副作用，不改变互斥规则：
 * - `user`：视频会设 `manualLatch`（播控条保持可见）
 * - `hotspot`：由热区赢家逻辑触发，不写 manualLatch
 */
export type SceneMediaPlaySource = 'hotspot' | 'user';

/** 当前占用「唯一出声槽」的 scene 条目 id；null 表示无活跃媒体 */
let activeSceneMediaEntryId: string | null = null;

/** 供热区控制器在编辑非预览下保留手动播放条（pausePostersExceptActiveUserSlot） */
export function getActiveSceneMediaEntryId(): string | null {
    return activeSceneMediaEntryId;
}

/**
 * 由热区控制器在每帧评估收尾时统一更新出声槽。
 * 单独暴露（不在 play/pause 内部修改）以避免循环中间状态被外部观察到。
 */
export function setActiveSceneMediaSoundId(id: string | null): void {
    activeSceneMediaEntryId = id;
}

// --- 底层 pause / UI 同步（不对外导出，避免绕过互斥与事件） ---

function pausePlacedAudio(m: PlacedAudioRuntime): void {
    try {
        m.audioEl.pause();
    } catch {
        // ignore
    }
    m.audioEl.volume = 0;
}

/** 更新 runtime 标记并通知 callout / 视频播控条重绘 */
function syncEntryPlaybackUi(
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

/**
 * @param releaseActiveSlot 为 true 且本条即 activeSceneMediaEntryId 时清空互斥槽。
 *   批量 pause 其它条时传 false，避免误释放「正在播」那条的槽位。
 */
function pauseSceneMediaEntryInternal(
    global: Global,
    entry: ScenePlacedItem,
    releaseActiveSlot: boolean
): void {
    const entity = entry.entity;
    if (!entity) return;
    const m = getPlacedMediaRuntime(entity);
    if (!m) return;

    if (m.kind === 'video') {
        pausePlacedVideoTexture(m);
        syncEntryPlaybackUi(global, entry, 'video', false);
    } else if (m.kind === 'audio') {
        pausePlacedAudio(m);
        syncEntryPlaybackUi(global, entry, 'audio', false);
    }

    if (releaseActiveSlot && activeSceneMediaEntryId === entry.id) {
        activeSceneMediaEntryId = null;
    }
}

/** 把除赢家外、当前 isLive 的视频静音；不停止推帧。 */
function muteOtherPlacedVideosKeepFrame(global: Global, exceptEntryId: string | null): void {
    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (exceptEntryId && entry.id === exceptEntryId) continue;
        const entity = entry.entity;
        if (!entity) continue;
        const m = getPlacedMediaRuntime(entity);
        if (!m || m.kind !== 'video') continue;
        if (m.isLive) {
            m.videoEl.muted = true;
        }
    }
}

/** 暂停除指定 id 之外的所有 audio（audio 无静音概念，直接 pause）。 */
function pauseOtherPlacedAudios(global: Global, exceptEntryId: string | null): void {
    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (exceptEntryId && entry.id === exceptEntryId) continue;
        const entity = entry.entity;
        if (!entity) continue;
        const m = getPlacedMediaRuntime(entity);
        if (!m || m.kind !== 'audio') continue;
        pauseSceneMediaEntryInternal(global, entry, false);
    }
}

// --- 对外播控 API（热区与用户入口均应经此） ---

/**
 * 让指定视频「保持画面推帧 + 受控静音」。不修改 `activeSceneMediaEntryId`，
 * 由调用方在循环收尾通过 {@link setActiveSceneMediaSoundId} 决定出声归属。
 */
export function ensureSceneVideoFramePlaying(
    global: Global,
    entry: ScenePlacedItem,
    options: { muted: boolean }
): boolean {
    const entity = entry.entity;
    if (!entity) return false;
    const m = getPlacedMediaRuntime(entity);
    if (!m || m.kind !== 'video') return false;

    playPlacedVideoTexture(entity, m);
    m.videoEl.muted = options.muted;
    if (m.videoEl.paused) {
        m.videoEl.play().catch(() => {
            // ignore autoplay / decode errors
        });
    }
    syncEntryPlaybackUi(global, entry, 'video', true);
    return true;
}

/**
 * 让指定 media 出声：
 * - video：本条非静音播放；其它视频静音但继续推帧；所有 audio 暂停。
 * - audio：本条出声播放；其它 audio 暂停；所有视频静音（保持画面）。
 *
 * 不修改其它条目的 `userPaused`。
 */
export function playSceneMediaEntry(
    global: Global,
    entry: ScenePlacedItem,
    source: SceneMediaPlaySource
): boolean {
    const entity = entry.entity;
    if (!entity) return false;
    const m = getPlacedMediaRuntime(entity);
    if (!m || (m.kind !== 'video' && m.kind !== 'audio')) return false;

    activeSceneMediaEntryId = entry.id;

    if (m.kind === 'video') {
        muteOtherPlacedVideosKeepFrame(global, entry.id);
        pauseOtherPlacedAudios(global, null);
        playPlacedVideoTexture(entity, m);
        m.videoEl.muted = false;
        m.videoEl.play().catch(() => {
            // ignore autoplay / decode errors
        });
        if (source === 'user') {
            ensureScenePlacedMediaRuntime(entry).manualLatch = true;
        }
        syncEntryPlaybackUi(global, entry, 'video', true);
        return true;
    }

    muteOtherPlacedVideosKeepFrame(global, null);
    pauseOtherPlacedAudios(global, entry.id);
    m.audioEl.volume = 1;
    m.audioEl.play().catch(() => {
        // ignore autoplay / decode errors
    });
    syncEntryPlaybackUi(global, entry, 'audio', true);
    return true;
}

/**
 * 暂停指定条目。
 * `releaseActiveSlot` 默认为 true：用户暂停或热区不再播放时应释放槽位；
 * 设为 false 用于「只停海报、不清槽」（少见，热区批量停其它条时用 internal 路径）。
 */
export function pauseSceneMediaEntry(
    global: Global,
    entry: ScenePlacedItem,
    options?: { releaseActiveSlot?: boolean }
): void {
    pauseSceneMediaEntryInternal(global, entry, options?.releaseActiveSlot !== false);
}

/** 页面隐藏、placedAssets 禁用、退出编辑等：停全部并清空互斥槽 */
export function pauseAllSceneMedia(global: Global): void {
    activeSceneMediaEntryId = null;
    for (const entry of global.state.scenePlacedEntities ?? []) {
        pauseSceneMediaEntryInternal(global, entry, false);
    }
}

/**
 * 进入预览或退出编辑到 Viewer：重置用户会话标记，使热区行为与观看模式一致。
 * 不主动 pause 元素（由随后热区评估或 pauseAll 负责）。
 */
export function clearSceneMediaUserSession(global: Global): void {
    activeSceneMediaEntryId = null;
    for (const entry of global.state.scenePlacedEntities ?? []) {
        const rt = entry.mediaRuntime;
        if (!rt) continue;
        rt.userPaused = false;
        rt.manualLatch = false;
    }
}

/** 控制器 teardown：仅清 UI 标记并广播 playing:false，不操作 HTMLMediaElement */
export function clearAllSceneMediaPlaybackFlags(global: Global): void {
    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!entry.mediaRuntime?.hotspotPlaying) continue;
        ensureScenePlacedMediaRuntime(entry).hotspotPlaying = false;
        const kind =
            entry.assetType === 'video' ? 'video' : entry.assetType === 'audio' ? 'audio' : null;
        if (kind) {
            global.events.fire('mediaOverlay:playbackChanged', { id: entry.id, kind, playing: false });
        }
    }
}

// --- 用户手势入口（video-controls / audio-callout 专用） ---

/** 播放钮：清除 userPaused → play → 通知热区（解锁 userUnlocked） */
export function userPlaySceneMedia(global: Global, entry: ScenePlacedItem): void {
    ensureScenePlacedMediaRuntime(entry).userPaused = false;
    playSceneMediaEntry(global, entry, 'user');
    notifySceneMediaUserGesture(global);
}

/** 暂停钮：userPaused 阻止热区再播 → pause 并释放互斥槽 */
export function userPauseSceneMedia(global: Global, entry: ScenePlacedItem): void {
    ensureScenePlacedMediaRuntime(entry).userPaused = true;
    pauseSceneMediaEntry(global, entry, { releaseActiveSlot: true });
    notifySceneMediaUserGesture(global);
}

/**
 * 用户与媒体 UI 交互后广播（须在 play/pause 完成之后调用）。
 * - `mediaOverlay:userPlayback`：热区控制器置 userUnlocked
 * - `mediaHotspot:userActivate`：非编辑预览模式下触发一次热区重算
 */
export function notifySceneMediaUserGesture(global: Global): void {
    global.events.fire('mediaOverlay:userPlayback');
    global.events.fire('mediaHotspot:userActivate');
}
