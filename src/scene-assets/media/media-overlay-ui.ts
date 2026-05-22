/**
 * 场景 **audio** 标注式 DOM 浮层（video 播控见 `video-controls-texture.ts`，合成在纹理上）。
 */

import { Vec3 } from 'playcanvas';

import type { Global, ScenePlacedItem } from '../../types';
import { readViewMediaMuted } from '../../view-settings';
import {
    ensureScenePlacedMediaRuntime,
    getPlacedMediaRuntime,
    type PlacedAudioRuntime
} from './media-runtime';

const PROJ_VEC = new Vec3();
const AUDIO_CALLOUT_OFFSET_Y = -8;

type AudioOverlayDom = {
    root: HTMLDivElement;
    playBtn: HTMLButtonElement;
    nameEl: HTMLSpanElement;
};

type RegisteredAudioOverlay = {
    entryId: string;
    root: HTMLDivElement;
    audio: AudioOverlayDom;
};

function stopDomPointerBubble(el: HTMLElement): void {
    const stop = (e: Event) => e.stopPropagation();
    el.addEventListener('pointerdown', stop);
    el.addEventListener('pointerup', stop);
    el.addEventListener('click', stop);
}

function projectWorldToScreen(
    global: Global,
    worldPos: Vec3,
    screenOffsetY: number
): { x: number; y: number; visible: boolean } {
    const cam = global.camera.camera;
    const screenPos = cam.worldToScreen(worldPos);
    cam.viewMatrix.transformPoint(worldPos, PROJ_VEC);
    if (PROJ_VEC.z >= 0) {
        return { x: 0, y: 0, visible: false };
    }
    return {
        x: screenPos.x,
        y: screenPos.y + screenOffsetY,
        visible: true
    };
}

function shouldShowAudioCallout(_global: Global, entry: ScenePlacedItem): boolean {
    return !!(entry.entity?.enabled && entry.visible !== false);
}

function isAudioVisuallyPlaying(global: Global, _entry: ScenePlacedItem, m: PlacedAudioRuntime): boolean {
    if (readViewMediaMuted(global)) return false;
    return !m.audioEl.paused && m.audioEl.volume > 0;
}

function createAudioOverlayDom(
    global: Global,
    entry: ScenePlacedItem,
    m: PlacedAudioRuntime
): AudioOverlayDom {
    const root = document.createElement('div');
    root.className = 'pc-media-overlay pc-media-audio-callout';

    const labelRow = document.createElement('div');
    labelRow.className = 'pc-media-audio-label-row';

    const arrow = document.createElement('span');
    arrow.className = 'pc-media-audio-arrow';
    arrow.setAttribute('aria-hidden', 'true');

    const nameEl = document.createElement('span');
    nameEl.className = 'pc-media-audio-name';
    nameEl.textContent = entry.name || '音频';

    labelRow.append(arrow, nameEl);

    const playBtn = document.createElement('button');
    playBtn.type = 'button';
    playBtn.className = 'pc-media-audio-play-btn';
    playBtn.setAttribute('aria-label', '播放/暂停');
    playBtn.textContent = '▶';

    root.append(labelRow, playBtn);
    stopDomPointerBubble(root);

    playBtn.addEventListener('click', () => {
        global.events.fire('mediaOverlay:userPlayback');
        global.events.fire('mediaHotspot:userActivate');
        if (readViewMediaMuted(global)) return;

        const a = m.audioEl;
        const rt = ensureScenePlacedMediaRuntime(entry);
        if (a.paused || a.volume === 0) {
            rt.userPaused = false;
            a.volume = 1;
            a.play().catch(() => {
                // ignore
            });
        } else {
            rt.userPaused = true;
            try {
                a.pause();
            } catch {
                // ignore
            }
            a.volume = 0;
        }
        updateAudioPlayingClass(global, entry, m, root);
    });

    return { root, playBtn, nameEl };
}

function updateAudioPlayingClass(
    global: Global,
    entry: ScenePlacedItem,
    m: PlacedAudioRuntime,
    root: HTMLDivElement
): void {
    const playing = isAudioVisuallyPlaying(global, entry, m);
    root.classList.toggle('is-playing', playing);
    const btn = root.querySelector('.pc-media-audio-play-btn') as HTMLButtonElement | null;
    if (btn) {
        btn.textContent = playing ? '❚❚' : '▶';
    }
}

function registerAudioOverlay(
    global: Global,
    parent: HTMLElement,
    registry: Map<string, RegisteredAudioOverlay>,
    entry: ScenePlacedItem
): void {
    if (registry.has(entry.id)) return;
    const entity = entry.entity;
    if (!entity) return;
    const m = getPlacedMediaRuntime(entity);
    if (m?.kind !== 'audio') return;

    const audio = createAudioOverlayDom(global, entry, m);
    parent.append(audio.root);
    registry.set(entry.id, { entryId: entry.id, root: audio.root, audio });
}

function unregisterAudioOverlay(registry: Map<string, RegisteredAudioOverlay>, entryId: string): void {
    const reg = registry.get(entryId);
    if (!reg) return;
    reg.root.remove();
    registry.delete(entryId);
}

function syncAudioOverlayRegistry(
    global: Global,
    parent: HTMLElement,
    registry: Map<string, RegisteredAudioOverlay>
): void {
    const list = global.state.scenePlacedEntities ?? [];
    const liveIds = new Set<string>();

    for (const entry of list) {
        if (!entry?.entity) continue;
        const m = getPlacedMediaRuntime(entry.entity);
        if (m?.kind !== 'audio') continue;
        liveIds.add(entry.id);
        if (!registry.has(entry.id)) {
            registerAudioOverlay(global, parent, registry, entry);
        } else {
            registry.get(entry.id)!.audio.nameEl.textContent = entry.name || '音频';
        }
    }

    for (const id of [...registry.keys()]) {
        if (!liveIds.has(id)) unregisterAudioOverlay(registry, id);
    }
}

function updateAudioOverlayPositions(global: Global, registry: Map<string, RegisteredAudioOverlay>): void {
    for (const entry of global.state.scenePlacedEntities ?? []) {
        const reg = registry.get(entry.id);
        if (!reg || !entry.entity) continue;

        const worldPos = entry.entity.getPosition();
        const proj = projectWorldToScreen(global, worldPos, AUDIO_CALLOUT_OFFSET_Y);
        const show = proj.visible && shouldShowAudioCallout(global, entry);

        reg.root.classList.toggle('is-visible', show);
        if (!show) continue;

        reg.root.style.left = `${proj.x}px`;
        reg.root.style.top = `${proj.y}px`;

        const m = getPlacedMediaRuntime(entry.entity);
        if (m?.kind === 'audio') {
            updateAudioPlayingClass(global, entry, m, reg.root);
        }
    }
}

/**
 * 初始化场景 **audio** DOM 浮层。
 */
export function initMediaOverlayUi(global: Global): () => void {
    const { app, events } = global;
    const uiEl = document.getElementById('ui');
    let parent = document.getElementById('sceneMediaOverlays');
    if (!parent && uiEl) {
        parent = document.createElement('div');
        parent.id = 'sceneMediaOverlays';
        uiEl.appendChild(parent);
    }
    if (!parent) {
        return () => {};
    }

    const registry = new Map<string, RegisteredAudioOverlay>();
    const parentEl = parent;

    const refreshRegistry = () => {
        syncAudioOverlayRegistry(global, parentEl, registry);
    };

    const onUpdate = () => {
        refreshRegistry();
        updateAudioOverlayPositions(global, registry);
    };

    app.on('update', onUpdate);
    events.on('sceneAssets:added', refreshRegistry);
    events.on('viewMediaMuted:changed', onUpdate);
    events.on('mediaOverlay:playbackChanged', onUpdate);

    refreshRegistry();

    return () => {
        app.off('update', onUpdate);
        events.off('sceneAssets:added', refreshRegistry);
        events.off('viewMediaMuted:changed', onUpdate);
        events.off('mediaOverlay:playbackChanged', onUpdate);
        for (const id of [...registry.keys()]) {
            unregisterAudioOverlay(registry, id);
        }
    };
}
