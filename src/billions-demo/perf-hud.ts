import { Vec3, type AppBase, type Entity, type GSplatComponentSystem } from 'playcanvas';

import { BENCHMARK_HUD_ID, ensureBenchmarkHudStyles } from '../benchmark/benchmark-hud';
import {
    percentile,
    readGsplatsM,
    readJsHeapUsedMB,
    readVramTexMB,
    type RefinementTickPayload
} from '../benchmark/benchmark-refinement';
import type { BillionsBenchmarkConfig } from './benchmark-config';
import { BillionsStreamingObserver } from './benchmark-streaming';

const FPS_WINDOW = 120;
const HUD_REFRESH_MS = 250;
const POSE_DECIMALS = 2;

type KeyframeBlurRecord = {
    label: string;
    blurToClearMs: number | null;
    pendingPeakNodes: number;
    timedOut: boolean;
};

const round = (n: number) => Number(n.toFixed(POSE_DECIMALS));

function readMemoryInfo(): { usedMB: number; totalMB: number } | null {
    const mem = (performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } }).memory;
    if (!mem) {
        return null;
    }
    const used = readJsHeapUsedMB();
    if (used === null) {
        return null;
    }
    return {
        usedMB: used,
        totalMB: mem.totalJSHeapSize / (1024 * 1024)
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

async function copyCameraPose(camera: Entity): Promise<boolean> {
    const cam = camera.camera;
    if (!cam) {
        return false;
    }
    const pos = camera.getPosition();
    const target = new Vec3().copy(camera.forward).mulScalar(10).add(pos);
    const pose = {
        position: [round(pos.x), round(pos.y), round(pos.z)] as [number, number, number],
        target: [round(target.x), round(target.y), round(target.z)] as [number, number, number],
        fov: round(cam.fov)
    };
    try {
        await navigator.clipboard.writeText(JSON.stringify(pose, null, 2));
        return true;
    } catch {
        return false;
    }
}

export type BillionsPerfHudOptions = {
    app: AppBase;
    camera: Entity;
    gsplatSystem: GSplatComponentSystem;
    config: BillionsBenchmarkConfig;
    instances: number;
    numSplatsPerInstance: number;
    streamingReady: () => boolean;
};

export function initBillionsPerfHud(options: BillionsPerfHudOptions): () => void {
    const { app, camera, gsplatSystem, config, instances, numSplatsPerInstance, streamingReady } = options;
    ensureBenchmarkHudStyles();

    const observer = new BillionsStreamingObserver();
    observer.attach(gsplatSystem);

    let root = document.getElementById(BENCHMARK_HUD_ID);
    if (!root) {
        root = document.createElement('div');
        root.id = BENCHMARK_HUD_ID;
        root.setAttribute('aria-live', 'polite');
        document.body.appendChild(root);
    }

    const title = config.benchmark
        ? `Benchmark · ${config.benchmarkLabel ?? 'run'}`
        : 'Perf HUD · Billions';

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
        const ok = await copyCameraPose(camera);
        showCopyToast(ok ? '已复制相机位姿' : '复制失败（无剪贴板权限）', ok);
        copyPoseBtn.disabled = false;
    });

    const fpsSamples: number[] = [];
    let phase = config.benchmark ? 'loading' : 'idle';
    let currentKeyframe = '—';
    let refineTick: RefinementTickPayload | null = null;
    const keyframeBlurHistory: KeyframeBlurRecord[] = [];
    let cachedRowsHtml = '';
    let cachedBlurHtml = '';

    const onPhase = (event: Event) => {
        const payload = (event as CustomEvent<{ phase?: string; keyframe?: string }>).detail;
        if (payload?.phase) {
            phase = payload.phase;
        }
        if (payload?.keyframe !== undefined) {
            currentKeyframe = payload.keyframe;
        }
    };
    const onRefineTick = (event: Event) => {
        refineTick = (event as CustomEvent<RefinementTickPayload>).detail;
    };
    const onKeyframeRefine = (event: Event) => {
        const payload = (event as CustomEvent<{
            keyframe?: string;
            blurToClearMs?: number | null;
            pendingPeakNodes?: number;
            refineTimedOut?: boolean;
        }>).detail;
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
    };
    const onComplete = () => {
        phase = 'complete';
        refineTick = null;
    };

    window.addEventListener('sceneProfileBenchmark:phase', onPhase);
    window.addEventListener('sceneProfileBenchmark:refineTick', onRefineTick);
    window.addEventListener('sceneProfileBenchmark:keyframeRefine', onKeyframeRefine);
    window.addEventListener('sceneProfileBenchmark:complete', onComplete);

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

        const progress = streamingReady() ? 100 : 50;
        progressBar.style.width = `${progress}%`;

        const fpsNow = Number.isFinite(fps) ? fps.toFixed(0) : '—';
        const fpsP50 = percentile(fpsSamples, 0.5);
        const fpsP95 = percentile(fpsSamples, 0.95);
        const gsplatsM = readGsplatsM(app);
        const vramMb = readVramTexMB(app);
        const mem = readMemoryInfo();
        const stream = observer.snapshot();

        const lines: string[] = [];
        lines.push(row('Progress', streamingReady() ? 'ready' : 'streaming'));

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
        lines.push(row('Instances', String(instances)));
        lines.push(row('Total splats', `${(numSplatsPerInstance * instances / 1e9).toFixed(1)}B`));

        const gsplat = app.scene.gsplat as { currentRenderer?: unknown; renderer?: unknown; splatBudget?: unknown };
        lines.push(row('Renderer', formatGsplatRenderer(gsplat.currentRenderer ?? gsplat.renderer)));
        lines.push(row('SplatBudget', formatSplatBudget(gsplat.splatBudget)));

        if (stream.pendingNodes > 0 || !stream.ready) {
            lines.push(row(
                'Streaming',
                `${(stream.refinementRatio * 100).toFixed(0)}% · pending ${stream.pendingNodes}`
            ));
        }

        if (refineTick && refineTick.pendingPeakNodes > 0) {
            lines.push(row('Pending peak', String(refineTick.pendingPeakNodes)));
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
        window.removeEventListener('sceneProfileBenchmark:phase', onPhase);
        window.removeEventListener('sceneProfileBenchmark:refineTick', onRefineTick);
        window.removeEventListener('sceneProfileBenchmark:keyframeRefine', onKeyframeRefine);
        window.removeEventListener('sceneProfileBenchmark:complete', onComplete);
        root?.remove();
    };
}

export function shouldShowBillionsPerfHud(config: BillionsBenchmarkConfig): boolean {
    return !!config.benchmarkHud;
}
