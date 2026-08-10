import { Vec3 } from 'playcanvas';

import type { Global } from '../types';
import { Camera } from '../cameras/camera';
import {
    accumulateBufferUploadSession,
    createBufferUploadSessionStats,
    percentile,
    readDrawCalls,
    readGsplatBufferUploadMetrics,
    readGsplatsM,
    readAssetGsplatsM,
    pollGpuFrustumGsplatsM,
    readJsHeapUsedMB,
    readVramTexMB,
    readRefinementSnapshot,
    readRefinementTickMetrics,
    readRuntimeLodPlacement,
    formatRuntimeLodPlacement,
    readGsplatBudgetFill,
    formatGsplatBudgetFill,
    formatGsplatCenterFill,
    formatGsplatEdgeFill,
    formatGsplatOutOfViewFill,
    renderRefinementTickMetricsHtml,
    type RefinementTickPayload
} from './benchmark-refinement';
import type { OctreeRefinementController } from '../loaders/gsplat/lod/octree/refinement-controller';

export const BENCHMARK_HUD_ID = 'benchmark-hud';
const HUD_ID = BENCHMARK_HUD_ID;
const FPS_WINDOW = 120;
const POSE_DECIMALS = 2;
/** 观测 HUD 刷新间隔；避免每帧重写 DOM 污染 FPS */
const HUD_REFRESH_MS = 250;
const COLLAPSED_STORAGE_KEY = 'benchmark-hud-collapsed';

type ViewerLike = {
    octreeRefinementController?: OctreeRefinementController | null;
    cameraManager?: { camera: Camera };
};

export type BenchmarkCameraPoseClipboard = {
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
    animTimeSec?: number;
};

type KeyframeBlurRecord = {
    label: string;
    blurToClearMs: number | null;
    pendingPeakNodes: number;
    timedOut: boolean;
};

const round = (n: number) => Number(n.toFixed(POSE_DECIMALS));

function readCurrentCameraPose(global: Global): BenchmarkCameraPoseClipboard | null {
    const viewer = (global.app as { viewer?: ViewerLike }).viewer;
    const camera = viewer?.cameraManager?.camera;
    if (!camera) {
        return null;
    }

    const focus = new Vec3();
    camera.calcFocusPoint(focus);
    const pose: BenchmarkCameraPoseClipboard = {
        position: [round(camera.position.x), round(camera.position.y), round(camera.position.z)],
        target: [round(focus.x), round(focus.y), round(focus.z)],
        fov: round(camera.fov)
    };

    if (global.state.hasAnimation && global.state.animationDuration > 0) {
        pose.animTimeSec = round(global.state.animationTime);
    }

    return pose;
}

async function copyCameraPose(global: Global): Promise<boolean> {
    const pose = readCurrentCameraPose(global);
    if (!pose) {
        return false;
    }
    try {
        await navigator.clipboard.writeText(JSON.stringify(pose, null, 2));
        return true;
    } catch {
        return false;
    }
}

function readMemoryInfo(): { usedMB: number; totalMB: number; limitMB: number } | null {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number; jsHeapSizeLimit: number } }).memory;
    if (!mem) {
        return null;
    }
    const toMb = (n: number) => n / (1024 * 1024);
    const used = readJsHeapUsedMB();
    if (used === null) {
        return null;
    }
    return {
        usedMB: used,
        totalMB: toMb(mem.totalJSHeapSize),
        limitMB: toMb(mem.jsHeapSizeLimit)
    };
}

function readRefinementLight(global: Global): {
    pending: number;
    ratio: number;
    ready: boolean;
    centerBehind: number;
    centerClear: number;
    centerTarget: number;
    activityActive: boolean;
    refinePhase: string;
} | null {
    const controller = (global.app as { viewer?: ViewerLike }).viewer?.octreeRefinementController;
    if (!controller) {
        const snapshot = readRefinementSnapshot(global);
        if (snapshot.pendingNodes === 0 && snapshot.ready) {
            return null;
        }
        return {
            pending: snapshot.pendingNodes,
            ratio: snapshot.refinementRatio,
            ready: snapshot.ready,
            centerBehind: 0,
            centerClear: 0,
            centerTarget: 0,
            activityActive: false,
            refinePhase: snapshot.refinePhase ?? 'polish'
        };
    }
    const status = controller.getStreamingRefinementStatus();
    return {
        pending: status.pendingNodes,
        ratio: status.refinementRatio,
        ready: status.ready,
        centerBehind: status.centerEngineBehindNodes ?? 0,
        centerClear: status.centerClearNodes ?? 0,
        centerTarget: status.centerTargetNodes ?? 0,
        activityActive: controller.getActivity().active,
        refinePhase: status.refinePhase ?? controller.getRefinePhase?.() ?? 'polish'
    };
}

function formatBlurMs(ms: number | null, timedOut: boolean): string {
    if (ms === null) {
        return timedOut ? 'timeout' : '—';
    }
    return `${ms.toFixed(0)} ms`;
}

function formatGsplatRenderer(value: unknown): string {
    return value === undefined || value === null ? '—' : String(value);
}

function formatSplatBudget(value: unknown): string {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return '—';
    }
    return value <= 0 ? '0 / uncapped' : `${(value / 1_000_000).toFixed(2)}M`;
}

function formatWbBlocks(uploadedBlocks: number, totalBlocks: number, copyPct: number): string {
    if (totalBlocks <= 0 && uploadedBlocks <= 0) {
        return '—';
    }
    const pctSuffix = totalBlocks > 0 || uploadedBlocks > 0 ? ` · ${copyPct.toFixed(0)}%` : '';
    return `${uploadedBlocks}/${totalBlocks}${pctSuffix}`;
}

type HudWaypoint = {
    label: string;
    position: [number, number, number];
    target: [number, number, number];
    fov: number;
    /** 有 animTrack 时带上，便于 scrub；无动画点位为 undefined */
    animTimeSec?: number;
};

/** 优先 animTracks[0] 关键帧；否则 settings.cameras[].initial（非 LOD / 无路径场景） */
function readHudWaypoints(global: Global): HudWaypoint[] {
    const track = global.settings?.animTracks?.[0];
    const times = track?.keyframes?.times;
    const values = track?.keyframes?.values;
    if (Array.isArray(times) && times.length > 0 && values?.position && values?.target) {
        const frameRate = track.frameRate || 30;
        const defaultFov = global.settings?.cameras?.[0]?.initial?.fov ?? 60;
        const out: HudWaypoint[] = [];
        for (let i = 0; i < times.length; i++) {
            const pi = i * 3;
            const fov =
                Array.isArray(values.fov) && typeof values.fov[i] === 'number'
                    ? values.fov[i]
                    : defaultFov;
            out.push({
                label: `kf-${i}`,
                position: [
                    values.position[pi],
                    values.position[pi + 1],
                    values.position[pi + 2]
                ],
                target: [values.target[pi], values.target[pi + 1], values.target[pi + 2]],
                fov,
                animTimeSec: times[i] / frameRate
            });
        }
        return out;
    }

    const cameras = global.settings?.cameras;
    if (!Array.isArray(cameras) || cameras.length === 0) {
        return [];
    }
    const out: HudWaypoint[] = [];
    for (let i = 0; i < cameras.length; i++) {
        const initial = cameras[i]?.initial;
        if (!initial?.position || !initial?.target) {
            continue;
        }
        out.push({
            label: cameras.length === 1 ? 'cam-0' : `cam-${i}`,
            position: [
                initial.position[0],
                initial.position[1],
                initial.position[2]
            ],
            target: [initial.target[0], initial.target[1], initial.target[2]],
            fov: initial.fov ?? 60
        });
    }
    return out;
}

function findWaypointIndex(
    waypoints: HudWaypoint[],
    state: Global['state'],
    manualIndex: number | null
): number {
    if (waypoints.length === 0) {
        return -1;
    }
    if (manualIndex !== null && manualIndex >= 0 && manualIndex < waypoints.length) {
        return manualIndex;
    }
    const withTime = waypoints.filter((w) => w.animTimeSec !== undefined);
    if (withTime.length === waypoints.length && state.hasAnimation) {
        const t = state.animationTime ?? 0;
        let best = 0;
        let bestDist = Math.abs((waypoints[0].animTimeSec ?? 0) - t);
        for (let i = 1; i < waypoints.length; i++) {
            const d = Math.abs((waypoints[i].animTimeSec ?? 0) - t);
            if (d < bestDist) {
                best = i;
                bestDist = d;
            }
        }
        return best;
    }
    return 0;
}

/**
 * 暂停并跳到下一机位（到末则回到 0）。
 * animTrack / cameras[] 均可；LOD 与非 LOD 通用。
 */
function jumpToNextHudWaypoint(
    global: Global,
    manualIndex: number | null
): {
    ok: boolean;
    index: number;
    total: number;
    label: string;
    timeSec: number | null;
    reason?: string;
} {
    const waypoints = readHudWaypoints(global);
    if (waypoints.length === 0) {
        return {
            ok: false,
            index: -1,
            total: 0,
            label: '—',
            timeSec: null,
            reason: '无 animTrack 关键帧 / cameras 点位'
        };
    }
    if (waypoints.length === 1 && waypoints[0].animTimeSec === undefined) {
        // 仅一个初始相机：仍跳一次（回到同点），方便统一交互
    }

    const curIdx = findWaypointIndex(waypoints, global.state, manualIndex);
    const nextIdx = (Math.max(0, curIdx) + 1) % waypoints.length;
    const wp = waypoints[nextIdx];

    global.state.animationPaused = true;
    global.events.fire('camera:gotoPose', {
        position: wp.position,
        target: wp.target,
        fov: wp.fov,
        animTimeSec: wp.animTimeSec
    });
    global.app.renderNextFrame = true;
    const viewer = (global.app as { viewer?: ViewerLike }).viewer;
    viewer?.octreeRefinementController?.notifyCameraMoved?.();
    global.events.fire('sceneProfileBenchmark:phase', {
        phase: 'manual-waypoint',
        keyframe: wp.label
    });

    return {
        ok: true,
        index: nextIdx,
        total: waypoints.length,
        label: wp.label,
        timeSec: wp.animTimeSec ?? null
    };
}

export function ensureBenchmarkHudStyles() {
    let style = document.getElementById('benchmark-hud-style') as HTMLStyleElement | null;
    if (!style) {
        style = document.createElement('style');
        style.id = 'benchmark-hud-style';
        document.head.appendChild(style);
    }
    style.textContent = `
#${HUD_ID} {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 100000;
    min-width: 240px;
    max-width: 460px;
    padding: 10px 12px;
    border-radius: 8px;
    background: rgba(8, 10, 14, 0.82);
    border: 1px solid rgba(255, 255, 255, 0.12);
    color: #e8ecf1;
    font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    pointer-events: none;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
    backdrop-filter: blur(6px);
}
#${HUD_ID}.is-collapsed {
    min-width: 0;
    max-width: none;
    padding: 6px 8px;
}
#${HUD_ID} .benchmark-hud-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
    margin-bottom: 6px;
    pointer-events: auto;
}
#${HUD_ID}.is-collapsed .benchmark-hud-header { margin-bottom: 0; }
#${HUD_ID} .benchmark-hud-title {
    flex: 1;
    min-width: 0;
    font-weight: 600;
    color: #fff;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
}
#${HUD_ID} .benchmark-hud-collapse {
    flex: 0 0 auto;
    width: 22px;
    height: 22px;
    padding: 0;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 4px;
    background: rgba(255, 255, 255, 0.08);
    color: #e8ecf1;
    font: 11px/1 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    cursor: pointer;
}
#${HUD_ID} .benchmark-hud-collapse:hover { background: rgba(255, 255, 255, 0.14); }
#${HUD_ID} .benchmark-hud-collapse:focus-visible {
    outline: 1px solid #22d3ee;
    outline-offset: 1px;
}
#${HUD_ID}.is-collapsed .benchmark-hud-body { display: none; }
#${HUD_ID} .benchmark-hud-row { display: flex; justify-content: space-between; gap: 12px; }
#${HUD_ID} .benchmark-hud-label { color: rgba(255, 255, 255, 0.55); }
#${HUD_ID} .benchmark-hud-value { text-align: right; color: #f3f6fa; }
#${HUD_ID} .benchmark-hud-progress {
    margin: 6px 0 8px; height: 4px; border-radius: 2px;
    background: rgba(255, 255, 255, 0.12); overflow: hidden;
}
#${HUD_ID} .benchmark-hud-progress-bar {
    height: 100%; width: 0%;
    background: linear-gradient(90deg, #3b82f6, #22d3ee);
    transition: width 0.15s ease;
}
#${HUD_ID} .benchmark-hud-section-title {
    margin: 8px 0 4px; font-weight: 600; color: rgba(255, 255, 255, 0.75); font-size: 11px;
}
#${HUD_ID} .benchmark-hud-kf-row {
    display: flex; justify-content: space-between; gap: 8px;
    padding: 2px 0; border-bottom: 1px solid rgba(255, 255, 255, 0.06);
}
#${HUD_ID} .benchmark-hud-kf-row:last-child { border-bottom: none; }
#${HUD_ID} .benchmark-hud-kf-label { color: rgba(255, 255, 255, 0.5); }
#${HUD_ID} .benchmark-hud-kf-value { text-align: right; color: #a5f3fc; }
#${HUD_ID} .benchmark-hud-kf-value.live { color: #fde68a; }
#${HUD_ID} .benchmark-hud-actions {
    margin-top: 8px;
    display: flex;
    flex-direction: column;
    gap: 6px;
    pointer-events: auto;
}
#${HUD_ID} .benchmark-hud-actions-row {
    display: flex;
    gap: 6px;
}
#${HUD_ID} .benchmark-hud-copy-pose,
#${HUD_ID} .benchmark-hud-next-kf {
    flex: 1;
    width: 100%;
    padding: 5px 8px;
    border: 1px solid rgba(255, 255, 255, 0.2);
    border-radius: 6px;
    background: rgba(255, 255, 255, 0.08);
    color: #e8ecf1;
    font: inherit;
    cursor: pointer;
}
#${HUD_ID} .benchmark-hud-next-kf {
    border-color: rgba(34, 211, 238, 0.35);
    background: rgba(34, 211, 238, 0.12);
}
#${HUD_ID} .benchmark-hud-copy-pose:hover,
#${HUD_ID} .benchmark-hud-next-kf:hover { background: rgba(255, 255, 255, 0.14); }
#${HUD_ID} .benchmark-hud-next-kf:hover { background: rgba(34, 211, 238, 0.2); }
#${HUD_ID} .benchmark-hud-copy-pose:disabled,
#${HUD_ID} .benchmark-hud-next-kf:disabled { opacity: 0.45; cursor: not-allowed; }
#${HUD_ID} .benchmark-hud-copy-toast {
    margin-top: 0; text-align: center; color: #86efac; font-size: 11px;
}
`;
}

export function initBenchmarkHud(global: Global): () => void {
    const { app, config, state, events } = global;
    ensureBenchmarkHudStyles();

    let root = document.getElementById(HUD_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = HUD_ID;
        root.setAttribute('aria-live', 'polite');
        document.body.appendChild(root);
    }

    const title = config.benchmark
        ? `Benchmark · ${config.benchmarkLabel ?? 'run'}`
        : 'Perf HUD';

    const readCollapsed = (): boolean => {
        try {
            return sessionStorage.getItem(COLLAPSED_STORAGE_KEY) === '1';
        } catch {
            return false;
        }
    };
    const writeCollapsed = (collapsed: boolean) => {
        try {
            sessionStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? '1' : '0');
        } catch {
            /* ignore quota / private mode */
        }
    };

    root.innerHTML = `
        <div class="benchmark-hud-header">
            <div class="benchmark-hud-title" id="benchmark-hud-title">${title}</div>
            <button type="button" class="benchmark-hud-collapse" id="benchmark-hud-collapse" aria-expanded="true" aria-controls="benchmark-hud-body" title="折叠">▾</button>
        </div>
        <div class="benchmark-hud-body" id="benchmark-hud-body">
            <div class="benchmark-hud-progress"><div class="benchmark-hud-progress-bar" id="benchmark-hud-progress-bar"></div></div>
            <div id="benchmark-hud-rows"></div>
            <div id="benchmark-hud-refinement-section"></div>
            <div id="benchmark-hud-blur-section"></div>
            <div class="benchmark-hud-actions">
                <div class="benchmark-hud-actions-row">
                    <button type="button" class="benchmark-hud-next-kf" id="benchmark-hud-next-kf" title="暂停并跳到 animTrack 下一关键帧（末帧后回到 kf-0）">下一机位</button>
                    <button type="button" class="benchmark-hud-copy-pose" id="benchmark-hud-copy-pose">复制位姿</button>
                </div>
                <div class="benchmark-hud-copy-toast" id="benchmark-hud-copy-toast" hidden></div>
            </div>
        </div>
    `;

    const titleEl = root.querySelector('#benchmark-hud-title') as HTMLDivElement;
    const collapseBtn = root.querySelector('#benchmark-hud-collapse') as HTMLButtonElement;
    const progressBar = root.querySelector('#benchmark-hud-progress-bar') as HTMLDivElement;
    const rowsEl = root.querySelector('#benchmark-hud-rows') as HTMLDivElement;
    const refinementSectionEl = root.querySelector('#benchmark-hud-refinement-section') as HTMLDivElement;
    const blurSectionEl = root.querySelector('#benchmark-hud-blur-section') as HTMLDivElement;
    const nextKfBtn = root.querySelector('#benchmark-hud-next-kf') as HTMLButtonElement;
    const copyPoseBtn = root.querySelector('#benchmark-hud-copy-pose') as HTMLButtonElement;
    const copyToastEl = root.querySelector('#benchmark-hud-copy-toast') as HTMLDivElement;

    const applyCollapsed = (collapsed: boolean) => {
        root.classList.toggle('is-collapsed', collapsed);
        collapseBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
        collapseBtn.setAttribute('aria-label', collapsed ? '展开 Perf HUD' : '折叠 Perf HUD');
        collapseBtn.title = collapsed ? '展开' : '折叠';
        collapseBtn.textContent = collapsed ? '▸' : '▾';
        titleEl.title = collapsed ? `${title}（点击 ▸ 展开）` : title;
        writeCollapsed(collapsed);
    };
    applyCollapsed(readCollapsed());

    const onCollapseClick = () => {
        applyCollapsed(!root.classList.contains('is-collapsed'));
    };
    collapseBtn.addEventListener('click', onCollapseClick);

    let copyToastTimer: ReturnType<typeof setTimeout> | null = null;
    const showCopyToast = (message: string, ok: boolean) => {
        copyToastEl.hidden = false;
        copyToastEl.textContent = message;
        copyToastEl.style.color = ok ? '#86efac' : '#fca5a5';
        if (copyToastTimer) {
            clearTimeout(copyToastTimer);
        }
        copyToastTimer = setTimeout(() => {
            copyToastEl.hidden = true;
            copyToastTimer = null;
        }, 2000);
    };

    copyPoseBtn.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();
        copyPoseBtn.disabled = true;
        const ok = await copyCameraPose(global);
        if (ok) {
            const pose = readCurrentCameraPose(global);
            const animHint = pose?.animTimeSec !== undefined ? ` · anim ${pose.animTimeSec}s` : '';
            showCopyToast(`已复制${animHint}`, true);
        } else {
            showCopyToast('复制失败（相机未就绪或无剪贴板权限）', false);
        }
        copyPoseBtn.disabled = false;
    });

    const fpsSamples: number[] = [];
    const bufferUploadSession = createBufferUploadSessionStats();
    /** 最近一帧 bufferUpload（frameend 采样，避免 250ms HUD 漏计 fullRebuild） */
    let lastBufferUpload = readGsplatBufferUploadMetrics(app);
    /** frameend 采样的上屏 active（避免 tick 开头的 frame.gsplats 滞后/为 0） */
    let lastGsplatsM = readGsplatsM(app);
    /** GPU-sort：视锥 cull + projector 后的绘制点数（异步 readback 缓存） */
    let lastGpuFrustumGsplatsM: number | null = null;
    let phase = config.benchmark ? 'loading' : 'idle';
    let currentKeyframe = '—';
    /** 手动「下一机位」游标；无 anim 时靠它记住当前点 */
    let manualWaypointIndex: number | null = null;
    let refineTick: RefinementTickPayload | null = null;
    const keyframeBlurHistory: KeyframeBlurRecord[] = [];
    let cachedRowsHtml = '';
    let cachedRefinementHtml = '';
    let cachedBlurHtml = '';

    const updateNextKfButtonLabel = () => {
        const waypoints = readHudWaypoints(global);
        if (waypoints.length === 0) {
            nextKfBtn.disabled = true;
            nextKfBtn.textContent = '下一机位';
            nextKfBtn.title = '无 animTrack 关键帧 / cameras 点位';
            return;
        }
        nextKfBtn.disabled = false;
        const cur = findWaypointIndex(waypoints, state, manualWaypointIndex);
        const next = (Math.max(0, cur) + 1) % waypoints.length;
        nextKfBtn.textContent = `下一机位 ${cur + 1}/${waypoints.length}→${next + 1}`;
        nextKfBtn.title =
            `暂停并跳到 ${waypoints[next].label}（当前 ${waypoints[Math.max(0, cur)].label}；末点后回到起点）`;
    };
    updateNextKfButtonLabel();

    const onFrameEndBufferSample = () => {
        lastBufferUpload = readGsplatBufferUploadMetrics(app);
        accumulateBufferUploadSession(bufferUploadSession, lastBufferUpload);
        const g = readGsplatsM(app);
        if (g !== null) {
            lastGsplatsM = g;
        }
        const gpuCull = pollGpuFrustumGsplatsM(app);
        if (gpuCull !== null) {
            lastGpuFrustumGsplatsM = gpuCull;
        }
    };
    app.on('frameend', onFrameEndBufferSample);

    const setPhase = (next: string, keyframe?: string) => {
        phase = next;
        if (keyframe !== undefined) {
            currentKeyframe = keyframe;
        }
    };

    events.on('sceneProfileBenchmark:phase', (payload: { phase?: string; keyframe?: string }) => {
        if (payload?.phase) {
            setPhase(payload.phase, payload.keyframe);
        }
    });
    events.on('sceneProfileBenchmark:refineTick', (payload: RefinementTickPayload) => {
        refineTick = payload;
    });
    events.on('sceneProfileBenchmark:keyframeRefine', (payload: {
        keyframe?: string;
        blurToClearMs?: number | null;
        pendingPeakNodes?: number;
        refineTimedOut?: boolean;
    }) => {
        const label = payload?.keyframe ?? currentKeyframe;
        const entry: KeyframeBlurRecord = {
            label,
            blurToClearMs: payload?.blurToClearMs ?? null,
            pendingPeakNodes: payload?.pendingPeakNodes ?? 0,
            timedOut: payload?.refineTimedOut ?? payload?.blurToClearMs === null
        };
        const existing = keyframeBlurHistory.find((e) => e.label === label);
        if (existing) {
            Object.assign(existing, entry);
        } else {
            keyframeBlurHistory.push(entry);
        }
        refineTick = null;
        if (payload?.keyframe) {
            currentKeyframe = payload.keyframe;
        }
    });
    events.on('sceneProfileBenchmark:complete', () => {
        setPhase('complete');
        refineTick = null;
    });

    const row = (label: string, value: string) =>
        `<div class="benchmark-hud-row"><span class="benchmark-hud-label">${label}</span><span class="benchmark-hud-value">${value}</span></div>`;

    const renderBlurSectionHtml = (): string => {
        const hasLive = refineTick !== null && phase === 'anim';
        const hasHistory = keyframeBlurHistory.length > 0;
        if (!hasLive && !hasHistory) {
            return '';
        }

        const lines: string[] = ['<div class="benchmark-hud-section-title">Blur→Clear (peak→0)</div>'];
        for (const entry of keyframeBlurHistory) {
            const peak = entry.pendingPeakNodes > 0 ? ` peak ${entry.pendingPeakNodes}` : '';
            lines.push(
                `<div class="benchmark-hud-kf-row">` +
                `<span class="benchmark-hud-kf-label">${entry.label}</span>` +
                `<span class="benchmark-hud-kf-value">${formatBlurMs(entry.blurToClearMs, entry.timedOut)}${peak}</span>` +
                `</div>`
            );
        }

        if (hasLive && refineTick) {
            const liveLabel = currentKeyframe;
            const alreadyRecorded = keyframeBlurHistory.some((e) => e.label === liveLabel);
            if (!alreadyRecorded) {
                const liveMs = refineTick.blurToClearMs ?? refineTick.elapsedSincePeakMs;
                const peak = refineTick.pendingPeakNodes > 0 ? ` peak ${refineTick.pendingPeakNodes}` : '';
                lines.push(
                    `<div class="benchmark-hud-kf-row">` +
                    `<span class="benchmark-hud-kf-label">${liveLabel}</span>` +
                    `<span class="benchmark-hud-kf-value live">${liveMs !== null ? `${liveMs.toFixed(0)} ms…` : '…'}${peak}</span>` +
                    `</div>`
                );
            }
        }

        return lines.join('');
    };

    const refreshHud = () => {
        const fps = app.stats.frame.fps;
        if (Number.isFinite(fps) && fps > 0) {
            fpsSamples.push(fps);
            if (fpsSamples.length > FPS_WINDOW) {
                fpsSamples.shift();
            }
        }

        const progress = Math.max(0, Math.min(100, state.progress ?? 0));
        progressBar.style.width = `${progress}%`;

        const fpsNow = Number.isFinite(fps) ? fps.toFixed(0) : '—';
        const fpsP50 = percentile(fpsSamples, 0.5);
        const fpsP95 = percentile(fpsSamples, 0.95);
        const gsplatsM = lastGsplatsM ?? readGsplatsM(app);
        const assetGsplatsM = readAssetGsplatsM(app);
        const drawCalls = readDrawCalls(app);
        const bufferUpload = lastBufferUpload;
        const vramMb = readVramTexMB(app);
        const mem = readMemoryInfo();
        const refine = readRefinementLight(global);
        const tickMetrics = readRefinementTickMetrics(global);

        const lines: string[] = [];
        lines.push(row('Progress', `${progress.toFixed(0)}%`));

        if (config.benchmark) {
            lines.push(row('Phase', phase));
            if (phase === 'anim' || phase === 'manual-waypoint') {
                lines.push(row('Keyframe', currentKeyframe));
            }
        } else if (phase === 'manual-waypoint' || currentKeyframe !== '—') {
            lines.push(row('Keyframe', currentKeyframe));
        }

        lines.push(row('FPS', `${fpsNow} (P50 ${fpsP50?.toFixed?.(0) ?? '—'})`));
        lines.push(row('FPS P95', fpsP95?.toFixed?.(0) ?? '—'));

        if (mem) {
            lines.push(row('JS Heap', `${mem.usedMB.toFixed(0)} / ${mem.totalMB.toFixed(0)} MB`));
        } else {
            lines.push(row('JS Heap', 'N/A (non-Chromium)'));
        }

        lines.push(row('GPU VRAM', vramMb !== null ? `${vramMb.toFixed(0)} MB` : '—'));
        // 行名与引擎字段对齐，便于对照 console：app.stats.frame.gsplats
        lines.push(row('frame.gsplats', gsplatsM !== null ? `${gsplatsM.toFixed(2)}M` : '—'));
        // GPU 视锥/投影后绘制数（GPU-sort）；非 LOD 对照「整包进 WB」的 frame.gsplats
        if (lastGpuFrustumGsplatsM !== null) {
            lines.push(row(
                'GPU frustum',
                `${lastGpuFrustumGsplatsM.toFixed(2)}M`
            ));
        }
        // Asset：文件/chunk 总点数；仅当与上屏 active 不同时显示（便于对照，非 budget）
        if (
            assetGsplatsM !== null &&
            gsplatsM !== null &&
            Math.abs(assetGsplatsM - gsplatsM) > 0.005
        ) {
            lines.push(row('Asset', `${assetGsplatsM.toFixed(2)}M`));
        }
        lines.push(row('DrawCalls', drawCalls !== null ? String(drawCalls) : '—'));

        const gsplat = app.scene.gsplat as { currentRenderer?: unknown; renderer?: unknown; splatBudget?: unknown };
        lines.push(row('Renderer', formatGsplatRenderer(gsplat.currentRenderer ?? gsplat.renderer)));

        const budgetFill = readGsplatBudgetFill(app);
        const hasLodBudget = budgetFill.optimalSplats != null || budgetFill.optimalNodes > 0;
        const hasSplatBudget =
            typeof gsplat.splatBudget === 'number' &&
            Number.isFinite(gsplat.splatBudget) &&
            gsplat.splatBudget > 0;
        // budget / Budget fill 仅 LOD（或显式 splatBudget）有意义；非 LOD 只看上面的 Gsplats
        if (hasLodBudget || hasSplatBudget) {
            lines.push(row('SplatBudget', formatSplatBudget(gsplat.splatBudget)));
            // 全树：与 PlayCanvas evaluateNodeLods / balancer 同口径
            lines.push(row('Budget fill', formatGsplatBudgetFill(budgetFill)));
            // 中央追齐 = 中央叶 cur≈各自 optimal（optimal 已含全局 budget）；≈100%·OK 即中央已追上
            if (budgetFill.center) {
                lines.push(row('Center fill', formatGsplatCenterFill(budgetFill)));
            }
            // 视锥内外围：应对齐、可滞后、不挡完成（真「外围追满」看这一行）
            if (budgetFill.edgeInView) {
                lines.push(row('Edge fill', formatGsplatEdgeFill(budgetFill)));
            }
            // 视锥外：引擎可写细 optimal，refinement 不入队 → 常拖低全树 cur/opt
            if (budgetFill.outOfView && budgetFill.outOfView.optimalSplats > 0) {
                lines.push(row('Out fill', formatGsplatOutOfViewFill(budgetFill)));
            }
        }

        const lodPlacement = readRuntimeLodPlacement(global);
        if (
            lodPlacement.lodBaseDistance !== null ||
            lodPlacement.lodMultiplier !== null ||
            lodPlacement.lodBehindPenalty !== null
        ) {
            lines.push(row('LOD d0/×/behind', formatRuntimeLodPlacement(lodPlacement)));
        }

        const capM = bufferUpload.allocatorCapacity / 1e6;
        const usedM = bufferUpload.allocatorUsed / 1e6;
        const hardM = bufferUpload.hardCapSlots / 1e6;
        const budgetM = bufferUpload.splatBudget > 0 ? bufferUpload.splatBudget / 1e6 : 0;
        lines.push(row(
            'WB Cap',
            bufferUpload.allocatorCapacity > 0
                ? `${usedM.toFixed(2)}/${capM.toFixed(2)}M · hard ${hardM > 0 ? hardM.toFixed(0) : '—'}M`
                : '—'
        ));
        lines.push(row(
            'WB Frag',
            bufferUpload.allocatorCapacity > 0
                ? `${(bufferUpload.fragmentation * 100).toFixed(0)}% · tex ${bufferUpload.textureSize}`
                : '—'
        ));
        lines.push(row(
            'WB Blocks',
            formatWbBlocks(bufferUpload.uploadedBlocks, bufferUpload.totalBlocks, bufferUpload.copyPct)
        ));
        const capPct = bufferUpload.bakeCapacityPct;
        const uploadSlotsM = bufferUpload.uploadSplatSlotsEst / 1e6;
        const uploadLabel = bufferUpload.uploadMbEst > 0
            ? `${bufferUpload.uploadMbEst.toFixed(1)}MB` +
              (bufferUpload.bakePassesEst > 1 ? ` · ×${bufferUpload.bakePassesEst} pass` : '')
            : '—';
        lines.push(row('WB Upload', uploadLabel));
        lines.push(row(
            'WB Bake %',
            bufferUpload.allocatorCapacity > 0
                ? `${capPct.toFixed(1)}% · ${uploadSlotsM.toFixed(2)}/${capM.toFixed(2)}M slots` +
                  ` · peak ${bufferUploadSession.peakBakeCapacityPct.toFixed(1)}%` +
                  (budgetM > 0 ? ` · bud ${budgetM.toFixed(1)}M` : '')
                : '—'
        ));

        const bakeCpu = bufferUpload.bakeCpuMs ?? 0;
        const writeBuf = bufferUpload.writeBufferMs ?? 0;
        const worldUpd = bufferUpload.worldUpdateMs ?? 0;
        const placeMs = bufferUpload.placementIntegrateMs ?? 0;
        const engineBudget = bakeCpu + writeBuf + worldUpd + placeMs;
        if (engineBudget > 0.05 || (bufferUpload.needsUploadBlocks ?? 0) > 0) {
            lines.push(row(
                'Gap bake',
                `cpu ${bakeCpu.toFixed(1)} · write ${writeBuf.toFixed(1)} · world ${worldUpd.toFixed(1)} · place ${placeMs.toFixed(1)}`
            ));
            lines.push(row(
                'NeedsUp',
                `${bufferUpload.needsUploadBlocks ?? 0} blk · ${((bufferUpload.needsUploadSlots ?? 0) / 1e6).toFixed(2)}M slots` +
                    (bufferUpload.engineFrameFullRebuild ? ' · FULL' : '')
            ));
        }

        if (refine) {
            const activityHint = refine.activityActive ? ' · dl' : '';
            const behindHint = refine.centerBehind > 0 ? ` · ctr↓${refine.centerBehind}` : '';
            const fineHint =
                refine.centerTarget > 0
                    ? ` · 细档${refine.centerClear}/${refine.centerTarget}`
                    : '';
            lines.push(row(
                'Refine',
                `${(refine.ratio * 100).toFixed(0)}% · pending ${refine.pending}${fineHint}${behindHint}` +
                    ` · phase=${refine.refinePhase}${activityHint}`
            ));
        }

        if (refineTick && refineTick.pendingPeakNodes > 0) {
            lines.push(row('Pending peak', String(refineTick.pendingPeakNodes)));
        }

        const frameProfiler = (globalThis as { __frameProfiler?: { getState: () => { recording: boolean; sampleCount: number } } }).__frameProfiler;
        if (frameProfiler) {
            const fpState = frameProfiler.getState();
            lines.push(row(
                'FrameProfile',
                fpState.recording ? `REC ${fpState.sampleCount}` : `idle ${fpState.sampleCount}`
            ));
        }

        if (config.benchmark && phase === 'anim' && state.animationDuration > 0) {
            lines.push(row('Anim', `${state.animationTime.toFixed(1)}s / ${state.animationDuration.toFixed(1)}s`));
        } else if (state.hasAnimation && state.animationDuration > 0) {
            lines.push(row('Anim', `${state.animationTime.toFixed(1)}s / ${state.animationDuration.toFixed(1)}s`));
        }

        if (state.loaded) {
            lines.push(row('Loaded', state.readyToRender ? 'yes' : 'warming'));
        }

        const rowsHtml = lines.join('');
        if (rowsHtml !== cachedRowsHtml) {
            rowsEl.innerHTML = rowsHtml;
            cachedRowsHtml = rowsHtml;
        }

        const refinementHtml = tickMetrics ? renderRefinementTickMetricsHtml(tickMetrics) : '';
        if (refinementHtml !== cachedRefinementHtml) {
            refinementSectionEl.innerHTML = refinementHtml;
            cachedRefinementHtml = refinementHtml;
        }

        const blurHtml = renderBlurSectionHtml();
        if (blurHtml !== cachedBlurHtml) {
            blurSectionEl.innerHTML = blurHtml;
            cachedBlurHtml = blurHtml;
        }

        updateNextKfButtonLabel();
    };

    nextKfBtn.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        const result = jumpToNextHudWaypoint(global, manualWaypointIndex);
        if (!result.ok) {
            showCopyToast(result.reason ?? '跳转失败', false);
            updateNextKfButtonLabel();
            return;
        }
        manualWaypointIndex = result.index;
        currentKeyframe = result.label;
        phase = 'manual-waypoint';
        const timeHint =
            result.timeSec !== null ? ` · ${result.timeSec.toFixed(2)}s` : '';
        showCopyToast(`已到 ${result.label}${timeHint}`, true);
        refreshHud();
    });

    const hudTimer = window.setInterval(refreshHud, HUD_REFRESH_MS);
    refreshHud();

    return () => {
        window.clearInterval(hudTimer);
        app.off('frameend', onFrameEndBufferSample);
        collapseBtn.removeEventListener('click', onCollapseClick);
        if (copyToastTimer) {
            clearTimeout(copyToastTimer);
        }
        root?.remove();
    };
}

export function shouldShowBenchmarkHud(config: { benchmark?: boolean; benchmarkHud?: boolean }): boolean {
    return !!config.benchmarkHud;
}
