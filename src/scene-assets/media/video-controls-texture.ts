/**
 * 视频播控条绘制在 video 纹理底部（Canvas 合成到同一 emissiveMap），非屏幕空间 DOM。
 * 暂停时默认显示播控；播放中 hover 显示，离开一段时间后隐藏。
 */

import { type CameraComponent, type Entity, Mat4, Vec3 } from 'playcanvas';

import { hitSceneGizmoAtClient } from '../../gizmo-handler';
import type { Global, ScenePlacedItem } from '../../types';
import { readViewMediaMuted } from '../../view-settings';
import { intersectRayLocalVideoMesh } from './curved-billboard-mesh';
import { ensureScenePlacedMediaRuntime, getPlacedMediaRuntime, type PlacedVideoRuntime } from './media-runtime';
import { isMediaConsumptionMode } from './media-hotspot-params';
import { userPauseSceneMedia, userPlaySceneMedia } from './scene-media-playback';
import {
    initPlacedVideoTextureUploadFlush,
    requestPlacedVideoTextureUpload,
    syncPlacedVideoTextureBinding
} from './video-texture';

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
 * 播控点击排查日志。默认关闭；开启：`localStorage.setItem('debugVideoControls', '1')`
 * 关闭：`localStorage.removeItem('debugVideoControls')` 或设为 `'0'`
 */
function vcDebugEnabled(): boolean {
    try {
        return localStorage.getItem('debugVideoControls') === '1';
    } catch {
        return false;
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

type VideoControlHit = 'play' | 'seek';

type VideoChromeState = {
    lastHoverMs: number;
    hoverAction: VideoControlHit | null;
};

const chromeStateByEntryId = new Map<string, VideoChromeState>();
const HIT_WORLD = new Vec3();
const SCRATCH_SCREEN = new Vec3();
const RAY_FAR = new Vec3();
const RAY_DIR = new Vec3();
const INV_WORLD = new Mat4();
const LOCAL_RAY_ORIGIN = new Vec3();
const LOCAL_RAY_DIR = new Vec3();
const LOCAL_HIT = new Vec3();

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

function isVideoControlsEligible(entry: ScenePlacedItem, global?: Global): boolean {
    if (!entry.entity?.enabled || entry.visible === false || entry.assetType !== 'video') {
        return false;
    }
    if (global && isMediaConsumptionMode(global)) {
        return entry.mediaRuntime?.inHotspotZone === true;
    }
    return true;
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
 * Viewer/预览：仅在热区内的视频参与播控（绘制 + 命中）；编辑非预览不受热区限制。
 */
export function shouldShowVideoControls(global: Global, entry: ScenePlacedItem): boolean {
    return isVideoControlsEligible(entry, global);
}

export function syncVideoTextureWithControls(
    global: Global,
    entry: ScenePlacedItem,
    m: PlacedVideoRuntime
): void {
    if (!isVideoControlsEligible(entry, global)) {
        if (m.controlsOverlayActive) {
            m.controlsOverlayActive = false;
            syncPlacedVideoTextureBinding(m);
            requestPlacedVideoTextureUpload(m);
        }
        return;
    }

    const paintChrome = shouldPaintControlsChrome(entry.id, m);

    if (!paintChrome) {
        if (m.controlsOverlayActive) {
            m.controlsOverlayActive = false;
            syncPlacedVideoTextureBinding(m);
            requestPlacedVideoTextureUpload(m);
        }
        return;
    }

    drawVideoComposite(m, entry.id, true);
    if (!m.controlsOverlayActive) {
        m.controlsOverlayActive = true;
    }
    syncPlacedVideoTextureBinding(m);
    requestPlacedVideoTextureUpload(m);
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

/** 局部命中点是否在相机前方（view 空间 z < 0） */
function isEntityLocalPointVisible(entity: Entity, cam: CameraComponent, localPt: Vec3): boolean {
    HIT_WORLD.copy(localPt);
    entity.getWorldTransform().transformPoint(HIT_WORLD, HIT_WORLD);
    cam.viewMatrix.transformPoint(HIT_WORLD, PROJ_VEC);
    return PROJ_VEC.z < 0;
}

/** 屏幕点 → 实体局部空间的单位射线 */
function castCanvasRayToEntityLocal(
    global: Global,
    cam: CameraComponent,
    entity: Entity,
    canvasX: number,
    canvasY: number
): { origin: Vec3; dir: Vec3 } | null {
    const rayOrigin = global.camera.getPosition();
    cam.screenToWorld(canvasX, canvasY, cam.farClip, RAY_FAR);
    RAY_DIR.sub2(RAY_FAR, rayOrigin);
    const rayLen = RAY_DIR.length();
    if (rayLen < 1e-5) return null;
    RAY_DIR.mulScalar(1 / rayLen);

    INV_WORLD.invert(entity.getWorldTransform());
    LOCAL_RAY_ORIGIN.copy(rayOrigin);
    INV_WORLD.transformPoint(LOCAL_RAY_ORIGIN, LOCAL_RAY_ORIGIN);
    LOCAL_RAY_DIR.copy(RAY_DIR);
    INV_WORLD.transformVector(LOCAL_RAY_DIR, LOCAL_RAY_DIR);
    const localLen = LOCAL_RAY_DIR.length();
    if (localLen < 1e-8) return null;
    LOCAL_RAY_DIR.mulScalar(1 / localLen);
    return { origin: LOCAL_RAY_ORIGIN, dir: LOCAL_RAY_DIR };
}

/** 曲度 0：射线 ↔ 局部 XZ 平面（y = 0，法线 +Y） */
function pickViaRayPlaneLocal(
    entity: Entity,
    cam: CameraComponent,
    localRay: { origin: Vec3; dir: Vec3 },
    texW: number,
    texH: number,
    debugEntryId?: string,
    lySlack = 0.12
): { px: number; py: number } | null {
    const denom = localRay.dir.y;
    if (Math.abs(denom) < 1e-5) return null;

    const t = -localRay.origin.y / denom;
    if (t < 0) return null;

    const lx = localRay.origin.x + localRay.dir.x * t;
    const ly = localRay.origin.y + localRay.dir.y * t;
    const lz = localRay.origin.z + localRay.dir.z * t;
    if (!isEntityLocalPointVisible(entity, cam, LOCAL_HIT.set(lx, ly, lz))) {
        return null;
    }
    if (Math.abs(lx) > 0.52 || Math.abs(lz) > 0.52 || Math.abs(ly) > lySlack) {
        vcLog('pick:fail', {
            entryId: debugEntryId,
            reason: 'localBounds',
            local: [lx, ly, lz],
            lySlack
        });
        return null;
    }

    const px = (0.5 - lx) * texW;
    const py = (0.5 - lz) * texH;
    if (px < 0 || py < 0 || px > texW || py > texH) return null;

    if (debugEntryId) {
        vcLog('pick:ok', { entryId: debugEntryId, via: 'rayPlane', px, py });
    }
    return { px, py };
}

/** 平面或横向弧面求交（曲屏与 mesh 几何一致，避免平面近似导致边缘点不上） */
function pickViaRayVideoSurface(
    global: Global,
    cam: CameraComponent,
    entity: Entity,
    canvasX: number,
    canvasY: number,
    texW: number,
    texH: number,
    horizontalCurvature: number,
    debugEntryId?: string
): { px: number; py: number } | null {
    const localRay = castCanvasRayToEntityLocal(global, cam, entity, canvasX, canvasY);
    if (!localRay) return null;

    const curved = horizontalCurvature > 0.01;
    if (!curved) {
        return pickViaRayPlaneLocal(entity, cam, localRay, texW, texH, debugEntryId);
    }

    const meshHit = intersectRayLocalVideoMesh(localRay.origin, localRay.dir, horizontalCurvature);
    if (meshHit && isEntityLocalPointVisible(entity, cam, meshHit.point)) {
        const px = (0.5 - meshHit.gx) * texW;
        const py = (0.5 - meshHit.gz) * texH;
        if (px >= -4 && py >= -4 && px <= texW + 4 && py <= texH + 4) {
            if (debugEntryId) {
                vcLog('pick:ok', {
                    entryId: debugEntryId,
                    via: 'rayMesh',
                    px,
                    py,
                    gx: meshHit.gx,
                    gz: meshHit.gz,
                    canvasX,
                    canvasY
                });
            }
            return { px, py };
        }
    }

    // 曲度越大、弧端按钮屏幕投影越小，jitter 步长按曲度线性放宽
    const j1 = 3 + Math.round(horizontalCurvature * 5);
    const j2 = 2 + Math.round(horizontalCurvature * 4);
    const jitter: ReadonlyArray<readonly [number, number]> = [
        [-j1, 0], [j1, 0], [0, -j1], [0, j1],
        [-j2, -j2], [j2, j2], [-j2, j2], [j2, -j2]
    ];
    for (const [dx, dy] of jitter) {
        const jr = castCanvasRayToEntityLocal(global, cam, entity, canvasX + dx, canvasY + dy);
        if (!jr) continue;
        const jhit = intersectRayLocalVideoMesh(jr.origin, jr.dir, horizontalCurvature);
        if (!jhit || !isEntityLocalPointVisible(entity, cam, jhit.point)) continue;
        const px = (0.5 - jhit.gx) * texW;
        const py = (0.5 - jhit.gz) * texH;
        if (px >= -4 && py >= -4 && px <= texW + 4 && py <= texH + 4) {
            if (debugEntryId) {
                vcLog('pick:ok', { entryId: debugEntryId, via: 'rayMeshJitter', dx, dy, px, py });
            }
            return { px, py };
        }
    }

    const planeFallback = pickViaRayPlaneLocal(entity, cam, localRay, texW, texH, debugEntryId, 0.55);
    if (planeFallback) {
        if (debugEntryId) {
            vcLog('pick:ok', { entryId: debugEntryId, via: 'rayPlaneFallback', ...planeFallback });
        }
        return planeFallback;
    }

    if (debugEntryId) {
        vcLog('pick:fail', { entryId: debugEntryId, reason: 'rayMesh', canvasX, canvasY, horizontalCurvature });
    }
    return null;
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
    horizontalCurvature: number,
    debugEntryId?: string
): { px: number; py: number; action: VideoControlHit } | null {
    const bounds = buildEntityScreenBounds(cam, entity);
    // 曲度越大、按钮在弧端的屏幕投影越小：粗筛 pad 随曲度线性放宽
    const screenPad = horizontalCurvature > 0.01
        ? 14 + Math.round(horizontalCurvature * 30)
        : 6;
    if (!bounds || !isCanvasPointInScreenBounds(canvasX, canvasY, bounds, screenPad)) {
        return null;
    }

    const layout = computeVideoControlsLayout(texW, texH);
    const pick = pickViaRayVideoSurface(
        global,
        cam,
        entity,
        canvasX,
        canvasY,
        texW,
        texH,
        horizontalCurvature,
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

    // 纹理空间命中容差随曲度放大：弧最右端 px≈texW，差几像素就漏
    const playPad = 12 + Math.round(horizontalCurvature * 24);
    for (const c of cands) {
        const action = hitTestTextureControls(c.px, c.py, layout, texH, debugEntryId, playPad);
        if (action !== 'play' && action !== 'seek') continue;
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
    return null;
}

/** 纹理像素坐标 → 播控命中（与绘制布局一致） */
function hitTestTextureControls(
    px: number,
    py: number,
    layout: VideoControlsLayout,
    texH: number,
    debugEntryId?: string,
    playPad: number = 12
): VideoControlHit | null {
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
    return null;
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
    const eligible = (global.state.scenePlacedEntities ?? []).filter((e) => isVideoControlsEligible(e, global));
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
        const layout = computeVideoControlsLayout(w, h);
        const resolved = resolveControlHitAtCanvas(
            global,
            cam,
            entry.entity,
            canvasX,
            canvasY,
            w,
            h,
            m.horizontalCurvature,
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

function clearVideoHoverState(global: Global): void {
    if (hoveredVideoEntryId) {
        setChromeHoverAction(hoveredVideoEntryId, null);
        const prev = global.state.scenePlacedEntities?.find((e) => e.id === hoveredVideoEntryId);
        if (prev?.entity) {
            const pm = getPlacedMediaRuntime(prev.entity);
            if (pm?.kind === 'video') syncVideoTextureWithControls(global, prev, pm);
        }
        hoveredVideoEntryId = null;
    }
    if (interactionCanvas) {
        interactionCanvas.style.cursor = '';
    }
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
    if (!hit) {
        if (interactionCanvas) {
            interactionCanvas.style.cursor = '';
        }
        return;
    }

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

    dragSeekEntryId = hit.entry.id;
    seekFromTextureX(hit.px, hit.layout, hit.m.videoEl);
    vcLog('pointerdown:seek', { entryId: hit.entry.id, px: hit.px, currentTime: hit.m.videoEl.currentTime });
    syncVideoTextureWithControls(global, hit.entry, hit.m);
    return true;
}

function handlePointerMove(global: Global, e: PointerEvent): void {
    const ptr = resolvePointerOnCanvas(e);
    if (!ptr) {
        clearVideoHoverState(global);
        return;
    }

    applyHoverFromPointer(global, ptr.x, ptr.y);

    if (!dragSeekEntryId) return;
    const entry = global.state.scenePlacedEntities?.find((x) => x.id === dragSeekEntryId);
    if (!entry?.entity) return;
    const m = getPlacedMediaRuntime(entry.entity);
    if (m?.kind !== 'video') return;
    const cam = global.camera.camera;
    const { w, h } = videoTexturePixelSize(m);
    const layout = computeVideoControlsLayout(w, h);
    const resolved = resolveControlHitAtCanvas(
        global,
        cam,
        entry.entity,
        ptr.x,
        ptr.y,
        w,
        h,
        m.horizontalCurvature
    );
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
        if (!isVideoControlsEligible(entry, global) || !entry.entity) continue;
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
    if (vcDebugEnabled()) {
        const metrics = getCanvasMetrics(global, canvas);
        const videoCount = (global.state.scenePlacedEntities ?? []).filter((e) => e.assetType === 'video').length;
        vcLog('init', {
            canvasId: canvas.id,
            metrics,
            videoCount,
            hasInputArbiter: !!(global as Global & { __inputArbiter?: unknown }).__inputArbiter
        });
    }

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
        if (!interactionGlobal) return;
        clearVideoHoverState(interactionGlobal);
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
    const cleanupTextureUploadFlush = initPlacedVideoTextureUploadFlush(app);

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
        cleanupTextureUploadFlush();
        app.off('update', onUpdate);
        events.off('mediaOverlay:playbackChanged', onPlaybackChanged);
        events.off('sceneAssets:added', onUpdate);
        events.off('sceneAssets:removed', onUpdate);
        chromeStateByEntryId.clear();
    };
}
