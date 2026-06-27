import { Vec3 } from 'playcanvas';

import type { Global } from '../types';
import { Camera } from '../cameras/camera';
import {
    percentile,
    readGsplatsM,
    readJsHeapUsedMB,
    readVramTexMB,
    readRefinementSnapshot,
    type RefinementTickPayload
} from './benchmark-refinement';
import type { OctreeRefinementController } from '../loaders/gsplat/lod/octree/refinement-controller';

const HUD_ID = 'benchmark-hud';
const FPS_WINDOW = 120;
const POSE_DECIMALS = 2;
/** 观测 HUD 刷新间隔；避免每帧重写 DOM 污染 FPS */
const HUD_REFRESH_MS = 250;

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
    activityActive: boolean;
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
            activityActive: false
        };
    }
    const status = controller.getStreamingRefinementStatus();
    return {
        pending: status.pendingNodes,
        ratio: status.refinementRatio,
        ready: status.ready,
        activityActive: controller.getActivity().active
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

function ensureStyles() {
    if (document.getElementById('benchmark-hud-style')) {
        return;
    }
    const style = document.createElement('style');
    style.id = 'benchmark-hud-style';
    style.textContent = `
#${HUD_ID} {
    position: fixed;
    top: 12px;
    right: 12px;
    z-index: 100000;
    min-width: 240px;
    max-width: 360px;
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
#${HUD_ID} .benchmark-hud-title { font-weight: 600; margin-bottom: 6px; color: #fff; }
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
#${HUD_ID} .benchmark-hud-actions { margin-top: 8px; pointer-events: auto; }
#${HUD_ID} .benchmark-hud-copy-pose {
    width: 100%; padding: 5px 8px;
    border: 1px solid rgba(255, 255, 255, 0.2); border-radius: 6px;
    background: rgba(255, 255, 255, 0.08); color: #e8ecf1; font: inherit; cursor: pointer;
}
#${HUD_ID} .benchmark-hud-copy-pose:hover { background: rgba(255, 255, 255, 0.14); }
#${HUD_ID} .benchmark-hud-copy-pose:disabled { opacity: 0.45; cursor: not-allowed; }
#${HUD_ID} .benchmark-hud-copy-toast {
    margin-top: 4px; text-align: center; color: #86efac; font-size: 11px;
}
`;
    document.head.appendChild(style);
}

export function initBenchmarkHud(global: Global): () => void {
    const { app, config, state, events } = global;
    ensureStyles();

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

    root.innerHTML = `
        <div class="benchmark-hud-title">${title}</div>
        <div class="benchmark-hud-progress"><div class="benchmark-hud-progress-bar" id="benchmark-hud-progress-bar"></div></div>
        <div id="benchmark-hud-rows"></div>
        <div id="benchmark-hud-blur-section"></div>
        <div class="benchmark-hud-actions">
            <button type="button" class="benchmark-hud-copy-pose" id="benchmark-hud-copy-pose">复制相机位姿</button>
            <div class="benchmark-hud-copy-toast" id="benchmark-hud-copy-toast" hidden></div>
        </div>
    `;

    const progressBar = root.querySelector('#benchmark-hud-progress-bar') as HTMLDivElement;
    const rowsEl = root.querySelector('#benchmark-hud-rows') as HTMLDivElement;
    const blurSectionEl = root.querySelector('#benchmark-hud-blur-section') as HTMLDivElement;
    const copyPoseBtn = root.querySelector('#benchmark-hud-copy-pose') as HTMLButtonElement;
    const copyToastEl = root.querySelector('#benchmark-hud-copy-toast') as HTMLDivElement;

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
    let phase = config.benchmark ? 'loading' : 'idle';
    let currentKeyframe = '—';
    let refineTick: RefinementTickPayload | null = null;
    const keyframeBlurHistory: KeyframeBlurRecord[] = [];
    let cachedRowsHtml = '';
    let cachedBlurHtml = '';

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
        const gsplatsM = readGsplatsM(app);
        const vramMb = readVramTexMB(app);
        const mem = readMemoryInfo();
        const refine = readRefinementLight(global);

        const lines: string[] = [];
        lines.push(row('Progress', `${progress.toFixed(0)}%`));

        if (config.benchmark) {
            lines.push(row('Phase', phase));
            if (phase === 'anim') {
                lines.push(row('Keyframe', currentKeyframe));
            }
        }

        lines.push(row('FPS', `${fpsNow} (P50 ${fpsP50?.toFixed?.(0) ?? '—'})`));
        lines.push(row('FPS P95', fpsP95?.toFixed?.(0) ?? '—'));

        if (mem) {
            lines.push(row('JS Heap', `${mem.usedMB.toFixed(0)} / ${mem.totalMB.toFixed(0)} MB`));
        } else {
            lines.push(row('JS Heap', 'N/A (non-Chromium)'));
        }

        lines.push(row('GPU VRAM', vramMb !== null ? `${vramMb.toFixed(0)} MB` : '—'));
        lines.push(row('Gsplats', gsplatsM !== null ? `${gsplatsM.toFixed(2)}M` : '—'));

        const gsplat = app.scene.gsplat as { currentRenderer?: unknown; renderer?: unknown; splatBudget?: unknown };
        lines.push(row('Renderer', formatGsplatRenderer(gsplat.currentRenderer ?? gsplat.renderer)));
        lines.push(row('SplatBudget', formatSplatBudget(gsplat.splatBudget)));

        if (refine) {
            const activityHint = refine.activityActive ? ' · dl' : '';
            lines.push(row(
                'Refine',
                `${(refine.ratio * 100).toFixed(0)}% · pending ${refine.pending}${activityHint}`
            ));
        }

        if (refineTick && refineTick.pendingPeakNodes > 0) {
            lines.push(row('Pending peak', String(refineTick.pendingPeakNodes)));
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

        const blurHtml = renderBlurSectionHtml();
        if (blurHtml !== cachedBlurHtml) {
            blurSectionEl.innerHTML = blurHtml;
            cachedBlurHtml = blurHtml;
        }
    };

    const hudTimer = window.setInterval(refreshHud, HUD_REFRESH_MS);
    refreshHud();

    return () => {
        window.clearInterval(hudTimer);
        if (copyToastTimer) {
            clearTimeout(copyToastTimer);
        }
        root?.remove();
    };
}

export function shouldShowBenchmarkHud(config: { benchmark?: boolean; benchmarkHud?: boolean }): boolean {
    return !!config.benchmarkHud;
}
