/**
 * 视频播控条绘制在 video 纹理底部（Canvas 合成到同一 emissiveMap），非屏幕空间 DOM。
 * 暂停时默认显示播控；播放中 hover 显示，离开一段时间后隐藏。
 */

import { type CameraComponent, type Entity, Mat4, Vec3 } from 'playcanvas';

import { hitSceneGizmoAtClient } from '../../gizmo-handler';
import type { Global, ScenePlacedItem } from '../../types';
import { readViewMediaMuted } from '../../view-settings';
import { ensureScenePlacedMediaRuntime, getPlacedMediaRuntime, type PlacedVideoRuntime } from './media-runtime';
import { userPauseSceneMedia, userPlaySceneMedia } from './scene-media-playback';

const PROJ_VEC = new Vec3();
const CANVAS_MAX_EDGE = 1920;

/** 底部播控区占画面高度比例（与绘制/命中共用） */
const CHROME_HEIGHT_RATIO = 0.14;
const SIDE_PAD_RATIO = 0.03;
const PLAY_BTN_SIZE_RATIO = 0.045;
/** 进度条距纹理底边的比例（另见 {@link TRACK_BOTTOM_MARGIN_MIN_PX} 像素下限） */
const TRACK_BOTTOM_MARGIN_RATIO = 0.038;
/** 进度条距纹理底边的最小像素 */
const TRACK_BOTTOM_MARGIN_MIN_PX = 16;
/** 时间码行与进度条之间的间距（像素） */
const TIME_LABEL_ABOVE_TRACK_GAP_PX = 6;
/** 鼠标离开视频后仍显示控件的时长（毫秒） */
const CONTROLS_IDLE_HIDE_MS = 3000;

/**
 * 播控点击排查日志。默认开启；关闭：`localStorage.setItem('debugVideoControls', '0')`
 * 再开：`localStorage.removeItem('debugVideoControls')` 或设为 `'1'`
 */
function vcDebugEnabled(): boolean {
    try {
        return localStorage.getItem('debugVideoControls') !== '0';
    } catch {
        return true;
    }
}

function vcLog(stage: string, detail?: Record<string, unknown>): void {
    if (!vcDebugEnabled()) return;
    if (detail) {
        console.log('[VideoControls]', stage, detail);
    } else {
        console.log('[VideoControls]', stage);
    }
}

/** 纹理像素坐标下的播控布局（绘制与命中真源） */
type VideoControlsLayout = {
    chromeTop: number;
    timeY: number;
    trackY: number;
    trackLeft: number;
    trackRight: number;
    trackH: number;
    playLeft: number;
    playTop: number;
    playSize: number;
    fontSize: number;
};

type VideoControlHit = 'play' | 'seek' | 'surface';

type VideoChromeState = {
    lastHoverMs: number;
    hoverAction: VideoControlHit | null;
};

const chromeStateByEntryId = new Map<string, VideoChromeState>();
const HIT_WORLD = new Vec3();
const SCRATCH_SCREEN = new Vec3();
const RAY_FAR = new Vec3();
const RAY_DIR = new Vec3();
const TO_PLANE = new Vec3();
const PLANE_NORMAL_LOCAL = new Vec3(0, 1, 0);
const PLANE_NORMAL_WORLD = new Vec3();
const INV_WORLD = new Mat4();

type ScreenBounds = { minX: number; minY: number; maxX: number; maxY: number };

let dragSeekEntryId: string | null = null;
let interactionCanvas: HTMLCanvasElement | null = null;
let interactionGlobal: Global | null = null;
let hoveredVideoEntryId: string | null = null;

type CanvasMetrics = {
    left: number;
    top: number;
    cw: number;
    ch: number;
    scaleX: number;
    scaleY: number;
};

function getCanvasMetrics(global: Global, canvas: HTMLCanvasElement): CanvasMetrics {
    const r = canvas.getBoundingClientRect();
    const { width: cw, height: ch } = global.app.graphicsDevice.clientRect;
    const safeW = Math.max(1, r.width);
    const safeH = Math.max(1, r.height);
    return {
        left: r.left,
        top: r.top,
        cw: cw || canvas.clientWidth || safeW,
        ch: ch || canvas.clientHeight || safeH,
        scaleX: (cw || canvas.clientWidth || safeW) / safeW,
        scaleY: (ch || canvas.clientHeight || safeH) / safeH
    };
}

function clientToCanvas(metrics: CanvasMetrics, clientX: number, clientY: number): { x: number; y: number } {
    return {
        x: (clientX - metrics.left) * metrics.scaleX,
        y: (clientY - metrics.top) * metrics.scaleY
    };
}

function isVideoControlsEligible(entry: ScenePlacedItem): boolean {
    return !!(entry.entity?.enabled && entry.visible !== false && entry.assetType === 'video');
}

function getChromeState(entryId: string): VideoChromeState {
    let st = chromeStateByEntryId.get(entryId);
    if (!st) {
        st = { lastHoverMs: 0, hoverAction: null };
        chromeStateByEntryId.set(entryId, st);
    }
    return st;
}

function isVideoActivelyPlaying(m: PlacedVideoRuntime): boolean {
    return m.isLive && !m.videoEl.paused && !m.videoEl.ended;
}

function pruneChromeState(global: Global): void {
    const live = new Set(
        (global.state.scenePlacedEntities ?? [])
            .filter((e) => e.assetType === 'video')
            .map((e) => e.id)
    );
    for (const id of chromeStateByEntryId.keys()) {
        if (!live.has(id)) chromeStateByEntryId.delete(id);
    }
}

/** 暂停/海报：始终绘制；播放中：hover 后一段时间内保持可见 */
function shouldPaintControlsChrome(entryId: string, m: PlacedVideoRuntime): boolean {
    if (dragSeekEntryId === entryId) return true;
    if (!isVideoActivelyPlaying(m)) return true;
    const st = chromeStateByEntryId.get(entryId);
    if (!st) return false;
    return performance.now() - st.lastHoverMs < CONTROLS_IDLE_HIDE_MS;
}

function touchChromeHover(entryId: string): void {
    getChromeState(entryId).lastHoverMs = performance.now();
}

function setChromeHoverAction(entryId: string, action: VideoControlHit | null): void {
    getChromeState(entryId).hoverAction = action;
}

function computeVideoControlsLayout(w: number, h: number): VideoControlsLayout {
    const chromeH = Math.max(36, Math.floor(h * CHROME_HEIGHT_RATIO));
    const chromeTop = h - chromeH;
    const sidePad = Math.max(8, Math.floor(w * SIDE_PAD_RATIO));
    const playSize = Math.max(14, Math.floor(Math.min(w, h) * PLAY_BTN_SIZE_RATIO));
    const playLeft = w - sidePad - playSize;
    const playTop = chromeTop + Math.floor(chromeH * 0.22);
    const fontSize = Math.max(11, Math.floor(h * 0.028));
    const trackH = Math.max(2, Math.floor(h * 0.003));
    const trackY = h - Math.max(TRACK_BOTTOM_MARGIN_MIN_PX, Math.floor(h * TRACK_BOTTOM_MARGIN_RATIO));
    const timeY = trackY - fontSize - TIME_LABEL_ABOVE_TRACK_GAP_PX;
    const trackLeft = sidePad;
    const trackRight = playLeft - Math.max(8, Math.floor(w * 0.02));

    return {
        chromeTop,
        timeY,
        trackY,
        trackLeft,
        trackRight: Math.max(trackLeft + 20, trackRight),
        trackH,
        playLeft,
        playTop,
        playSize,
        fontSize
    };
}

function videoTexturePixelSize(m: PlacedVideoRuntime): { w: number; h: number } {
    return {
        w: (m.compositeCanvas?.width ?? m.videoEl.videoWidth) || 1280,
        h: (m.compositeCanvas?.height ?? m.videoEl.videoHeight) || 720
    };
}

function formatMediaTime(sec: number): string {
    if (!Number.isFinite(sec) || sec < 0) return '00:00';
    const total = Math.floor(sec);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

function ensureCompositeCanvas(m: PlacedVideoRuntime, video: HTMLVideoElement): CanvasRenderingContext2D {
    if (!m.compositeCanvas) {
        m.compositeCanvas = document.createElement('canvas');
        m.compositeCtx = m.compositeCanvas.getContext('2d') ?? undefined;
    }
    const vw = Math.min(CANVAS_MAX_EDGE, Math.max(2, video.videoWidth || 1280));
    const vh = Math.min(CANVAS_MAX_EDGE, Math.max(2, video.videoHeight || 720));
    if (m.compositeCanvas.width !== vw || m.compositeCanvas.height !== vh) {
        m.compositeCanvas.width = vw;
        m.compositeCanvas.height = vh;
    }
    return m.compositeCtx!;
}

function drawPlayIcon(
    ctx: CanvasRenderingContext2D,
    x: number,
    y: number,
    size: number,
    paused: boolean
): void {
    ctx.fillStyle = '#ffffff';
    if (paused) {
        const cx = x + size * 0.38;
        const cy = y + size * 0.5;
        ctx.beginPath();
        ctx.moveTo(cx, cy - size * 0.32);
        ctx.lineTo(cx + size * 0.42, cy);
        ctx.lineTo(cx, cy + size * 0.32);
        ctx.closePath();
        ctx.fill();
        return;
    }
    const barW = Math.max(2, size * 0.12);
    const gap = Math.max(2, size * 0.1);
    const h = size * 0.5;
    const top = y + (size - h) * 0.5;
    ctx.fillRect(x + size * 0.28, top, barW, h);
    ctx.fillRect(x + size * 0.28 + barW + gap, top, barW, h);
}

function drawControlsOverlay(
    ctx: CanvasRenderingContext2D,
    w: number,
    h: number,
    video: HTMLVideoElement,
    layout: VideoControlsLayout,
    hoverAction: VideoControlHit | null
): void {
    const grad = ctx.createLinearGradient(0, layout.chromeTop, 0, h);
    grad.addColorStop(0, 'rgba(0, 0, 0, 0)');
    grad.addColorStop(0.45, 'rgba(0, 0, 0, 0.35)');
    grad.addColorStop(1, 'rgba(0, 0, 0, 0.55)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, layout.chromeTop, w, h - layout.chromeTop);

    const dur = video.duration;
    const t = Number.isFinite(dur) && dur > 0 ? Math.max(0, Math.min(1, video.currentTime / dur)) : 0;
    const trackW = layout.trackRight - layout.trackLeft;

    ctx.font = `${layout.fontSize}px system-ui, -apple-system, sans-serif`;
    ctx.fillStyle = '#ffffff';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText(formatMediaTime(video.currentTime), layout.trackLeft, layout.timeY);

    ctx.textAlign = 'right';
    ctx.fillText(formatMediaTime(dur), layout.playLeft - 6, layout.timeY);

    const trackHover = hoverAction === 'seek';
    const trackDrawH = trackHover ? Math.max(layout.trackH + 2, 4) : layout.trackH;
    const trackDrawY = layout.trackY - (trackDrawH - layout.trackH) * 0.5;

    ctx.textAlign = 'left';
    ctx.fillStyle = trackHover ? 'rgba(255, 255, 255, 0.62)' : 'rgba(255, 255, 255, 0.45)';
    ctx.fillRect(layout.trackLeft, trackDrawY, trackW, trackDrawH);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(layout.trackLeft, trackDrawY, trackW * t, trackDrawH);

    if (trackHover && trackW > 0) {
        const thumbX = layout.trackLeft + trackW * t;
        const thumbR = Math.max(4, trackDrawH * 2.2);
        ctx.beginPath();
        ctx.arc(thumbX, trackDrawY + trackDrawH * 0.5, thumbR, 0, Math.PI * 2);
        ctx.fill();
    }

    const playHover = hoverAction === 'play';
    if (playHover) {
        const pad = Math.max(4, layout.playSize * 0.18);
        ctx.fillStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.beginPath();
        ctx.arc(
            layout.playLeft + layout.playSize * 0.5,
            layout.playTop + layout.playSize * 0.5,
            layout.playSize * 0.5 + pad,
            0,
            Math.PI * 2
        );
        ctx.fill();
    }
    drawPlayIcon(ctx, layout.playLeft, layout.playTop, layout.playSize, video.paused);
}

function drawVideoComposite(m: PlacedVideoRuntime, entryId: string, paintChrome: boolean): void {
    const video = m.videoEl;
    const ctx = ensureCompositeCanvas(m, video);
    const w = m.compositeCanvas!.width;
    const h = m.compositeCanvas!.height;

    if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        ctx.drawImage(video, 0, 0, w, h);
    } else {
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, w, h);
    }
    if (paintChrome) {
        const hoverAction = chromeStateByEntryId.get(entryId)?.hoverAction ?? null;
        drawControlsOverlay(ctx, w, h, video, computeVideoControlsLayout(w, h), hoverAction);
    }
}

/**
 * 视频可见时始终参与播控逻辑；仅 hover/交互时在纹理上绘制控件条。
 */
export function shouldShowVideoControls(_global: Global, entry: ScenePlacedItem): boolean {
    return isVideoControlsEligible(entry);
}

export function syncVideoTextureWithControls(
    global: Global,
    entry: ScenePlacedItem,
    m: PlacedVideoRuntime
): void {
    if (!isVideoControlsEligible(entry)) {
        if (m.controlsOverlayActive) {
            m.texture.setSource(m.videoEl);
            m.controlsOverlayActive = false;
            try {
                m.texture.upload();
            } catch {
                // ignore
            }
        }
        return;
    }

    const paintChrome = shouldPaintControlsChrome(entry.id, m);

    if (!paintChrome) {
        if (m.controlsOverlayActive) {
            m.texture.setSource(m.videoEl);
            m.controlsOverlayActive = false;
            try {
                m.texture.upload();
            } catch {
                // ignore
            }
        }
        return;
    }

    drawVideoComposite(m, entry.id, true);
    if (!m.controlsOverlayActive) {
        m.texture.setSource(m.compositeCanvas!);
        m.controlsOverlayActive = true;
    }
    try {
        m.texture.upload();
    } catch {
        // ignore
    }
}

/** mesh AABB 投影到 canvas 的包围盒（与 worldToScreen 同坐标系，曲屏/旋转均适用） */
function buildEntityScreenBounds(cam: CameraComponent, entity: Entity): ScreenBounds | null {
    const anyEntity = entity as Entity & { render?: { meshInstances?: { aabb?: { getMin?: () => Vec3; getMax?: () => Vec3; center: Vec3; halfExtents: Vec3 } }[] } };
    const meshInstances = anyEntity.render?.meshInstances ?? [];
    if (meshInstances.length === 0) return null;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let anyVisible = false;

    for (const mi of meshInstances) {
        const aabb = mi.aabb;
        if (!aabb) continue;
        const miMin = aabb.getMin?.() ?? new Vec3().copy(aabb.center).sub(aabb.halfExtents);
        const miMax = aabb.getMax?.() ?? new Vec3().copy(aabb.center).add(aabb.halfExtents);
        const corners = [
            new Vec3(miMin.x, miMin.y, miMin.z),
            new Vec3(miMax.x, miMin.y, miMin.z),
            new Vec3(miMin.x, miMax.y, miMin.z),
            new Vec3(miMax.x, miMax.y, miMin.z),
            new Vec3(miMin.x, miMin.y, miMax.z),
            new Vec3(miMax.x, miMin.y, miMax.z),
            new Vec3(miMin.x, miMax.y, miMax.z),
            new Vec3(miMax.x, miMax.y, miMax.z)
        ];
        for (const c of corners) {
            cam.viewMatrix.transformPoint(c, PROJ_VEC);
            if (PROJ_VEC.z >= 0) continue;
            cam.worldToScreen(c, SCRATCH_SCREEN);
            minX = Math.min(minX, SCRATCH_SCREEN.x);
            minY = Math.min(minY, SCRATCH_SCREEN.y);
            maxX = Math.max(maxX, SCRATCH_SCREEN.x);
            maxY = Math.max(maxY, SCRATCH_SCREEN.y);
            anyVisible = true;
        }
    }

    if (!anyVisible || maxX <= minX || maxY <= minY) return null;
    return { minX, minY, maxX, maxY };
}

function isCanvasPointInScreenBounds(
    canvasX: number,
    canvasY: number,
    bounds: ScreenBounds,
    pad = 6
): boolean {
    return (
        canvasX >= bounds.minX - pad
        && canvasX <= bounds.maxX + pad
        && canvasY >= bounds.minY - pad
        && canvasY <= bounds.maxY + pad
    );
}

/** 射线 ↔ 局部平面（回退；曲屏时 z 容差放宽） */
function pickViaRayPlane(
    global: Global,
    cam: CameraComponent,
    entity: Entity,
    canvasX: number,
    canvasY: number,
    texW: number,
    texH: number,
    zSlack: number,
    debugEntryId?: string
): { px: number; py: number } | null {
    const rayOrigin = global.camera.getPosition();
    cam.screenToWorld(canvasX, canvasY, cam.farClip, RAY_FAR);
    RAY_DIR.sub2(RAY_FAR, rayOrigin);
    const rayLen = RAY_DIR.length();
    if (rayLen < 1e-5) return null;
    RAY_DIR.mulScalar(1 / rayLen);

    const planePoint = entity.getPosition();
    entity.getWorldTransform().transformVector(PLANE_NORMAL_LOCAL, PLANE_NORMAL_WORLD);
    PLANE_NORMAL_WORLD.normalize();
    TO_PLANE.sub2(planePoint, rayOrigin);
    if (PLANE_NORMAL_WORLD.dot(TO_PLANE) < 0) {
        PLANE_NORMAL_WORLD.mulScalar(-1);
    }

    const denom = RAY_DIR.dot(PLANE_NORMAL_WORLD);
    if (Math.abs(denom) < 1e-5) return null;

    const t = TO_PLANE.dot(PLANE_NORMAL_WORLD) / denom;
    if (t < 0) return null;

    HIT_WORLD.set(
        rayOrigin.x + RAY_DIR.x * t,
        rayOrigin.y + RAY_DIR.y * t,
        rayOrigin.z + RAY_DIR.z * t
    );

    cam.viewMatrix.transformPoint(HIT_WORLD, PROJ_VEC);
    if (PROJ_VEC.z >= 0) return null;

    INV_WORLD.invert(entity.getWorldTransform());
    INV_WORLD.transformPoint(HIT_WORLD, SCRATCH_SCREEN);
    const lx = SCRATCH_SCREEN.x;
    const ly = SCRATCH_SCREEN.y;
    const lz = SCRATCH_SCREEN.z;
    if (Math.abs(lx) > 0.52 || Math.abs(lz) > 0.52 || Math.abs(ly) > zSlack) {
        vcLog('pick:fail', {
            entryId: debugEntryId,
            reason: 'localBounds',
            local: [lx, ly, lz],
            zSlack,
            canvasX,
            canvasY
        });
        return null;
    }

    // geometry 已 mirror 局部 X；纹理与 composite 均为左上原点
    const px = (0.5 - lx) * texW;
    const py = (0.5 - lz) * texH;
    if (px < 0 || py < 0 || px > texW || py > texH) return null;

    if (debugEntryId) {
        vcLog('pick:ok', { entryId: debugEntryId, via: 'rayPlane', px, py, canvasX, canvasY });
    }
    return { px, py };
}

/** 屏幕粗筛 → 射线命中实际 3D quad → 纹理像素播控命中 */
function resolveControlHitAtCanvas(
    global: Global,
    cam: CameraComponent,
    entity: Entity,
    canvasX: number,
    canvasY: number,
    texW: number,
    texH: number,
    zSlack: number,
    debugEntryId?: string
): { px: number; py: number; action: VideoControlHit } | null {
    const bounds = buildEntityScreenBounds(cam, entity);
    if (!bounds || !isCanvasPointInScreenBounds(canvasX, canvasY, bounds)) {
        return null;
    }

    const layout = computeVideoControlsLayout(texW, texH);
    const pick = pickViaRayPlane(
        global,
        cam,
        entity,
        canvasX,
        canvasY,
        texW,
        texH,
        zSlack,
        debugEntryId
    );
    if (!pick) return null;

    type Cand = { px: number; py: number; via: string };
    const seen = new Set<string>();
    const cands: Cand[] = [];
    const add = (px: number, py: number, via: string) => {
        const key = `${Math.round(px * 2)}:${Math.round(py * 2)}`;
        if (seen.has(key)) return;
        seen.add(key);
        cands.push({ px, py, via });
    };

    add(pick.px, pick.py, 'ray');
    add(pick.px, texH - pick.py, 'rayFlipY');

    let surfaceFallback: { px: number; py: number; action: VideoControlHit } | null = null;
    for (const c of cands) {
        const action = hitTestTextureControls(c.px, c.py, layout, texH, debugEntryId);
        if (!action) continue;
        if (action === 'play' || action === 'seek') {
            if (debugEntryId) {
                vcLog('hit:resolved', {
                    entryId: debugEntryId,
                    via: c.via,
                    action,
                    px: c.px,
                    py: c.py
                });
            }
            return { px: c.px, py: c.py, action };
        }
        if (!surfaceFallback) {
            surfaceFallback = { px: c.px, py: c.py, action };
        }
    }
    return surfaceFallback;
}

/** 纹理像素坐标 → 播控命中（与绘制布局一致） */
function hitTestTextureControls(
    px: number,
    py: number,
    layout: VideoControlsLayout,
    texH: number,
    debugEntryId?: string
): VideoControlHit | null {
    const playPad = 12;
    const inPlay =
        px >= layout.playLeft - playPad
        && px <= layout.playLeft + layout.playSize + playPad
        && py >= layout.playTop - playPad
        && py <= layout.playTop + layout.playSize + playPad;

    const inChrome = py >= layout.chromeTop - 4 && py <= texH;
    const inSeekBand =
        inChrome
        && py >= layout.timeY - layout.fontSize - 4
        && py <= layout.trackY + layout.trackH + Math.max(14, layout.fontSize) + 6
        && px >= layout.trackLeft - 8
        && px < layout.playLeft - playPad;

    if (debugEntryId) {
        vcLog('hitTest', {
            entryId: debugEntryId,
            px,
            py,
            chromeTop: layout.chromeTop,
            trackY: layout.trackY,
            playLeft: layout.playLeft,
            playTop: layout.playTop,
            inPlay,
            inSeekBand,
            inChrome
        });
    }

    if (inPlay) return 'play';
    if (inSeekBand) return 'seek';
    if (inChrome) return 'surface';
    return 'surface';
}

function seekFromTextureX(px: number, layout: VideoControlsLayout, video: HTMLVideoElement): void {
    const dur = video.duration;
    if (!Number.isFinite(dur) || dur <= 0) return;
    const trackW = Math.max(1, layout.trackRight - layout.trackLeft);
    const clamped = Math.max(layout.trackLeft, Math.min(layout.trackRight, px));
    video.currentTime = ((clamped - layout.trackLeft) / trackW) * dur;
}

function findVideoHitAtClient(
    global: Global,
    canvasX: number,
    canvasY: number,
    debug = false
): {
    entry: ScenePlacedItem;
    m: PlacedVideoRuntime;
    layout: VideoControlsLayout;
    action: VideoControlHit;
    px: number;
} | null {
    let best: {
        entry: ScenePlacedItem;
        m: PlacedVideoRuntime;
        layout: VideoControlsLayout;
        action: VideoControlHit;
        px: number;
        depth: number;
    } | null = null;

    const cam = global.camera.camera;
    const eye = global.camera.getPosition();
    const eligible = (global.state.scenePlacedEntities ?? []).filter((e) => isVideoControlsEligible(e));
    if (debug) {
        vcLog('findHit:start', {
            canvasX,
            canvasY,
            eligibleCount: eligible.length,
            eligibleIds: eligible.map((e) => e.id)
        });
    }

    for (const entry of eligible) {
        if (!entry.entity) continue;
        const m = getPlacedMediaRuntime(entry.entity);
        if (m?.kind !== 'video') continue;

        const { w, h } = videoTexturePixelSize(m);
        const zSlack = m.horizontalCurvature > 0.01 ? 0.55 : 0.12;
        const layout = computeVideoControlsLayout(w, h);
        const resolved = resolveControlHitAtCanvas(
            global,
            cam,
            entry.entity,
            canvasX,
            canvasY,
            w,
            h,
            zSlack,
            debug ? entry.id : undefined
        );
        if (!resolved) continue;

        if (debug) {
            vcLog('findHit:candidate', {
                entryId: entry.id,
                action: resolved.action,
                px: resolved.px,
                py: resolved.py,
                texW: w,
                texH: h,
                chromeTop: layout.chromeTop,
                trackY: layout.trackY,
                playLeft: layout.playLeft
            });
        }

        const depth = eye.distance(entry.entity.getPosition());
        if (!best || depth < best.depth) {
            best = {
                entry,
                m,
                layout,
                action: resolved.action,
                px: resolved.px,
                depth
            };
        }
    }
    if (debug) {
        vcLog('findHit:result', best
            ? { entryId: best.entry.id, action: best.action, px: best.px, depth: best.depth }
            : { hit: null });
    }
    return best;
}

function toggleVideoPlay(global: Global, entry: ScenePlacedItem, m: PlacedVideoRuntime): void {
    if (readViewMediaMuted(global)) {
        vcLog('toggle:blocked', { entryId: entry.id, reason: 'viewMediaMuted' });
        return;
    }

    touchChromeHover(entry.id);
    const video = m.videoEl;
    if (video.paused) {
        userPlaySceneMedia(global, entry);
        vcLog('toggle:play', { entryId: entry.id });
    } else {
        userPauseSceneMedia(global, entry);
        vcLog('toggle:pause', { entryId: entry.id });
    }
    syncVideoTextureWithControls(global, entry, m);
}

function resolvePointerOnCanvas(
    e: PointerEvent,
    debug = false
): { x: number; y: number; metrics: CanvasMetrics } | null {
    const canvas = interactionCanvas;
    const global = interactionGlobal;
    if (!canvas || !global) {
        if (debug) vcLog('resolve:fail', { reason: 'noCanvasOrGlobal', hasCanvas: !!canvas, hasGlobal: !!global });
        return null;
    }
    const metrics = getCanvasMetrics(global, canvas);
    const { x, y } = clientToCanvas(metrics, e.clientX, e.clientY);
    if (x < 0 || y < 0 || x > metrics.cw || y > metrics.ch) {
        if (debug) {
            vcLog('resolve:fail', {
                reason: 'outsideCanvas',
                client: [e.clientX, e.clientY],
                canvas: [x, y],
                metrics
            });
        }
        return null;
    }
    if (debug) {
        vcLog('resolve:ok', {
            client: [e.clientX, e.clientY],
            canvas: [x, y],
            metrics,
            target: (e.target as Element)?.id ?? (e.target as Element)?.tagName
        });
    }
    return { x, y, metrics };
}

function applyHoverFromPointer(global: Global, canvasX: number, canvasY: number): void {
    const hit = findVideoHitAtClient(global, canvasX, canvasY, false);
    const nextId = hit?.entry.id ?? null;
    if (hoveredVideoEntryId && hoveredVideoEntryId !== nextId) {
        setChromeHoverAction(hoveredVideoEntryId, null);
        const prev = global.state.scenePlacedEntities?.find((e) => e.id === hoveredVideoEntryId);
        if (prev?.entity) {
            const pm = getPlacedMediaRuntime(prev.entity);
            if (pm?.kind === 'video') syncVideoTextureWithControls(global, prev, pm);
        }
    }
    hoveredVideoEntryId = nextId;
    if (!hit) return;

    touchChromeHover(hit.entry.id);
    const hoverUi = hit.action === 'play' || hit.action === 'seek' ? hit.action : null;
    setChromeHoverAction(hit.entry.id, hoverUi);
    if (interactionCanvas) {
        interactionCanvas.style.cursor = hoverUi ? 'pointer' : '';
    }
    syncVideoTextureWithControls(global, hit.entry, hit.m);
}

/** 由 InputArbiter 在相机 pointerdown 之前调用；命中视频则 claim。 */
export function tryClaimVideoControlsPointerDown(global: Global, e: PointerEvent): boolean {
    if (global.state.gizmoPointerActive || hitSceneGizmoAtClient(global, e.clientX, e.clientY)) {
        return false;
    }
    vcLog('pointerdown:received', {
        isPrimary: e.isPrimary,
        button: e.button,
        client: [e.clientX, e.clientY],
        target: (e.target as Element)?.id ?? (e.target as Element)?.tagName
    });
    if (!e.isPrimary || e.button !== 0) {
        vcLog('pointerdown:ignored', { reason: 'notPrimaryOrNotLeft' });
        return false;
    }
    const ptr = resolvePointerOnCanvas(e, true);
    if (!ptr) return false;

    const hit = findVideoHitAtClient(global, ptr.x, ptr.y, true);
    if (!hit) return false;

    vcLog('pointerdown:hit', {
        entryId: hit.entry.id,
        action: hit.action,
        px: hit.px,
        paused: hit.m.videoEl.paused,
        isLive: hit.m.isLive
    });

    touchChromeHover(hit.entry.id);
    syncVideoTextureWithControls(global, hit.entry, hit.m);

    if (hit.action === 'play') {
        toggleVideoPlay(global, hit.entry, hit.m);
        return true;
    }

    if (hit.action === 'surface') {
        toggleVideoPlay(global, hit.entry, hit.m);
        return true;
    }

    dragSeekEntryId = hit.entry.id;
    seekFromTextureX(hit.px, hit.layout, hit.m.videoEl);
    vcLog('pointerdown:seek', { entryId: hit.entry.id, px: hit.px, currentTime: hit.m.videoEl.currentTime });
    syncVideoTextureWithControls(global, hit.entry, hit.m);
    return true;
}

function handlePointerMove(global: Global, e: PointerEvent): void {
    const ptr = resolvePointerOnCanvas(e);
    if (!ptr) return;

    applyHoverFromPointer(global, ptr.x, ptr.y);

    if (!dragSeekEntryId) return;
    const entry = global.state.scenePlacedEntities?.find((x) => x.id === dragSeekEntryId);
    if (!entry?.entity) return;
    const m = getPlacedMediaRuntime(entry.entity);
    if (m?.kind !== 'video') return;
    const cam = global.camera.camera;
    const { w, h } = videoTexturePixelSize(m);
    const layout = computeVideoControlsLayout(w, h);
    const zSlack = m.horizontalCurvature > 0.01 ? 0.55 : 0.12;
    const resolved = resolveControlHitAtCanvas(global, cam, entry.entity, ptr.x, ptr.y, w, h, zSlack);
    if (!resolved) return;
    seekFromTextureX(resolved.px, layout, m.videoEl);
    touchChromeHover(entry.id);
    syncVideoTextureWithControls(global, entry, m);
}

function handlePointerUp(global: Global): void {
    dragSeekEntryId = null;
}

/**
 * 每帧刷新可见视频的纹理（含 hover 显隐）。
 */
export function tickVideoControlsTextures(global: Global): void {
    pruneChromeState(global);

    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!isVideoControlsEligible(entry) || !entry.entity) continue;
        const m = getPlacedMediaRuntime(entry.entity);
        if (m?.kind !== 'video') continue;

        const paintChrome = shouldPaintControlsChrome(entry.id, m);
        if (paintChrome || m.controlsOverlayActive || (m.isLive && isVideoActivelyPlaying(m))) {
            syncVideoTextureWithControls(global, entry, m);
        }
    }
}

/**
 * 注册视频纹理播控指针交互（hover 显隐 + 点击 seek/play）。
 */
export function initVideoControlsInteraction(global: Global, canvas: HTMLCanvasElement): () => void {
    interactionCanvas = canvas;
    interactionGlobal = global;
    const metrics = getCanvasMetrics(global, canvas);
    const videoCount = (global.state.scenePlacedEntities ?? []).filter((e) => e.assetType === 'video').length;
    console.warn('[VideoControls] init', {
        canvasId: canvas.id,
        metrics,
        videoCount,
        debugLogs: vcDebugEnabled(),
        hasInputArbiter: !!(global as Global & { __inputArbiter?: unknown }).__inputArbiter
    });

    let detachPointerDown: (() => void) | null = null;
    const arbiter = (global as Global & { __inputArbiter?: import('../../input-arbiter').InputArbiter }).__inputArbiter;
    if (arbiter) {
        detachPointerDown = arbiter.registerPointerDownHandler({
            id: 'media.video-controls',
            priority: 200,
            handle: (ctx) => tryClaimVideoControlsPointerDown(global, ctx.pointerEvent)
        });
    } else {
        console.warn('[VideoControls] init: missing __inputArbiter, pointerdown will not reach video controls');
    }

    const onMove = (e: PointerEvent) => {
        handlePointerMove(global, e);
        tickVideoControlsTextures(global);
    };
    const onUp = () => handlePointerUp(global);
    const onLeave = () => {
        if (!hoveredVideoEntryId || !interactionGlobal) return;
        setChromeHoverAction(hoveredVideoEntryId, null);
        const entry = interactionGlobal.state.scenePlacedEntities?.find((e) => e.id === hoveredVideoEntryId);
        if (entry?.entity) {
            const m = getPlacedMediaRuntime(entry.entity);
            if (m?.kind === 'video') syncVideoTextureWithControls(interactionGlobal, entry, m);
        }
        hoveredVideoEntryId = null;
        if (interactionCanvas) interactionCanvas.style.cursor = '';
    };

    canvas.addEventListener('pointermove', onMove, { passive: true });
    canvas.addEventListener('pointerleave', onLeave);
    window.addEventListener('pointermove', onMove, { passive: true });
    window.addEventListener('pointerup', onUp, { capture: true });
    window.addEventListener('pointercancel', onUp, { capture: true });

    return () => {
        detachPointerDown?.();
        detachPointerDown = null;
        canvas.removeEventListener('pointermove', onMove);
        canvas.removeEventListener('pointerleave', onLeave);
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp, true);
        window.removeEventListener('pointercancel', onUp, true);
        dragSeekEntryId = null;
        hoveredVideoEntryId = null;
        chromeStateByEntryId.clear();
        interactionCanvas = null;
        interactionGlobal = null;
    };
}

/**
 * 初始化视频纹理播控刷新循环。
 */
export function initVideoControlsTexture(global: Global): () => void {
    const { app, events } = global;

    const onUpdate = () => tickVideoControlsTextures(global);
    const onPlaybackChanged = (payload: { id?: string; kind?: string; playing?: boolean }) => {
        if (payload?.kind === 'video' && payload.playing && payload.id) {
            const entry = global.state.scenePlacedEntities?.find((e) => e.id === payload.id);
            if (entry) {
                ensureScenePlacedMediaRuntime(entry).manualLatch = true;
                touchChromeHover(entry.id);
            }
        }
    };

    app.on('update', onUpdate);
    events.on('mediaOverlay:playbackChanged', onPlaybackChanged);
    events.on('sceneAssets:added', onUpdate);
    events.on('sceneAssets:removed', onUpdate);

    return () => {
        app.off('update', onUpdate);
        events.off('mediaOverlay:playbackChanged', onPlaybackChanged);
        events.off('sceneAssets:added', onUpdate);
        events.off('sceneAssets:removed', onUpdate);
        chromeStateByEntryId.clear();
    };
}
