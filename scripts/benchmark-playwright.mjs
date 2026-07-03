#!/usr/bin/env node
/**
 * Playwright runner for Scene Profile benchmark suite (profile axis).
 *
 * Usage:
 *   npm run develop          # 终端 1：http://localhost:3000
 *   npm i -D playwright      # 首次
 *   node scripts/benchmark-playwright.mjs [suite.json] [baseUrl]
 *
 * 默认使用本机 Google Chrome（channel: chrome），无需 npx playwright install chromium。
 * 可选：BENCHMARK_BROWSER_CHANNEL=chromium|chrome|msedge
 *
 * Cold start (default): each measured case launches a fresh Chromium with HTTP cache
 * disabled (CDP + zero disk cache). Closer to first-visit load timing.
 *
 * Warm start (opt-in): suite `"warmup": true` or `BENCHMARK_WARM_START=1` — first case
 * discarded warmup, then measured case(s) in the same browser context (HTTP cache warm).
 */
import { readFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const suitePath = process.argv[2] ?? join(__dirname, '../public/benchmark-suites/scene-profiles.json');

let playwright;
try {
    playwright = await import('playwright');
} catch {
    console.error('playwright 未安装。请先执行：npm i -D playwright');
    process.exit(1);
}

/** settings 相对路径 → public 下绝对 URL 路径 */
function resolveSettingsPath(settings) {
    if (!settings) {
        return undefined;
    }
    if (/^https?:\/\//i.test(settings) || settings.startsWith('/')) {
        return settings;
    }
    const name = settings.replace(/^\.\//, '').replace(/^assets\/settings\//, '');
    if (name.startsWith('settings-') || name.endsWith('.json')) {
        return `/assets/settings/${name.replace(/^settings\//, '')}`;
    }
    return settings;
}

function resolveContentPath(content) {
    if (!content) {
        return undefined;
    }
    if (/^https?:\/\//i.test(content) || content.startsWith('/')) {
        return content;
    }
    return content;
}

const suite = JSON.parse(readFileSync(suitePath, 'utf8'));
const cases = suite.cases ?? [];
const fixed = suite.fixed ?? {};
const defaultFlags = suite.defaults?.benchmarkFlags ?? ['noui', 'nofx', 'noreveal', 'noanim', 'benchmark'];
const defaultRenderer = suite.defaults?.renderer;
const fixedSettings = resolveSettingsPath(fixed.settings);
const baseUrl = (process.argv[3] ?? process.env.BENCHMARK_BASE_URL ?? suite.baseUrl ?? 'http://localhost:3000/').replace(/\/?$/, '/');

function applyRendererParam(params, renderer) {
    if (!renderer || renderer === 'auto' || renderer === 'webgl') {
        return false;
    }
    if (renderer === 'webgpu') {
        params.set('webgpu', '');
        return true;
    }
    if (renderer === 'compute' || renderer === 'gpu-sort' || renderer === 'cpu-sort') {
        params.set(renderer, '');
        return true;
    }
    return false;
}

const wantsWebGpu =
    defaultRenderer === 'webgpu' ||
    defaultRenderer === 'compute' ||
    defaultRenderer === 'gpu-sort' ||
    cases.some((c) => c.renderer === 'webgpu' || c.renderer === 'compute' || c.renderer === 'gpu-sort');

const warmStart =
    process.env.BENCHMARK_WARM_START === '1' ||
    process.env.BENCHMARK_WARM_START === 'true' ||
    suite.warmup === true;

const coldStart = !warmStart;
const warmupEnabled = warmStart && cases.length > 0;

function chromiumLaunchArgs({ cold }) {
    const args = [];
    if (cold) {
        args.push(
            '--disk-cache-size=0',
            '--media-cache-size=0',
            '--disable-application-cache'
        );
    }
    if (wantsWebGpu) {
        args.push('--enable-unsafe-webgpu', '--enable-features=WebGPU');
    }
    return args;
}

/** 默认本机 Chrome；设 BENCHMARK_BROWSER_CHANNEL=chromium 可回退 Playwright 自带 Chromium */
const browserChannel = process.env.BENCHMARK_BROWSER_CHANNEL || 'chrome';

function launchBrowser({ cold }) {
    const options = {
        headless: !wantsWebGpu,
        args: chromiumLaunchArgs({ cold })
    };
    if (browserChannel && browserChannel !== 'chromium') {
        options.channel = browserChannel;
    }
    return playwright.chromium.launch(options);
}

/** 冷启动会话：新 context + 禁用并清空 Chromium HTTP 缓存 */
async function openColdSession() {
    const browser = await launchBrowser({ cold: true });
    const context = await browser.newContext({ serviceWorkers: 'block' });
    const page = await context.newPage();
    page.setDefaultTimeout(600_000);
    page.setDefaultNavigationTimeout(120_000);

    try {
        const cdp = await context.newCDPSession(page);
        await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
        await cdp.send('Network.clearBrowserCache');
    } catch (err) {
        console.warn('[benchmark] CDP cache disable/clear failed (continuing):', err?.message ?? err);
    }

    return { browser, context, page };
}

async function closeSession({ browser, context }) {
    await context?.close().catch(() => {});
    await browser?.close().catch(() => {});
}

function sanitizeFileSlug(value) {
    return String(value).replace(/[^a-zA-Z0-9._-]+/g, '_') || 'item';
}

/** 将 waypoint 内嵌 base64 落盘为 JPEG，写入 screenshotPath 并剔除 base64 */
function persistWaypointScreenshots(caseResult, outDir) {
    const waypoints = caseResult.interactionWaypoints ?? [];
    if (!waypoints.length) {
        return [];
    }

    const caseSlug = sanitizeFileSlug(caseResult.label);
    const saved = [];

    for (const w of waypoints) {
        if (!w.screenshotJpegBase64) {
            continue;
        }
        const rel = `screenshots/${caseSlug}/${sanitizeFileSlug(w.label)}.jpg`;
        const abs = join(outDir, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, Buffer.from(w.screenshotJpegBase64, 'base64'));
        w.screenshotPath = rel;
        delete w.screenshotJpegBase64;
        saved.push({ label: w.label, path: rel });
    }

    const keyframes = caseResult.animTrackBenchmark?.keyframes;
    if (keyframes?.length) {
        for (let i = 0; i < keyframes.length; i++) {
            const kf = keyframes[i];
            const wp = waypoints[i];
            if (wp?.screenshotPath) {
                kf.screenshotPath = wp.screenshotPath;
                delete kf.screenshotJpegBase64;
            }
        }
    }

    return saved;
}

function buildCaseUrl(c) {
    const params = new URLSearchParams();
    for (const flag of defaultFlags) {
        params.set(flag, '');
    }
    params.set('benchmarkLabel', c.label ?? 'case');

    const caseSettings = resolveSettingsPath(c.settings ?? fixedSettings);
    if (caseSettings) {
        params.set('settings', caseSettings);
    }

    const content = resolveContentPath(c.content ?? fixed.content);
    if (content) {
        params.set('content', content);
    }

    if (c.preset) {
        params.set('preset', c.preset);
    }
    if (c.budget !== undefined) {
        params.set('budget', String(c.budget));
    }
    if (c.lodMode) {
        params.set('lodMode', c.lodMode);
    }
    if (c.nearJumpLadder === true) {
        params.set('nearJumpLadder', '1');
    } else if (c.nearJumpLadder === false) {
        params.set('nearJumpLadder', '0');
    }
    if (c.lodBaseDistance !== undefined) {
        params.set('lodBaseDistance', String(c.lodBaseDistance));
    }
    if (c.lodRuntime) {
        params.set('lodRuntime', c.lodRuntime);
    }
    if (c.refinementPolicy) {
        params.set('refinementPolicy', c.refinementPolicy);
    }
    if (c.instances !== undefined) {
        params.set('instances', String(c.instances));
    }

    applyRendererParam(params, c.renderer ?? defaultRenderer);

    return `${baseUrl}?${params.toString()}`;
}

async function runBenchmarkCase(page, c, { phase = 'measure' } = {}) {
    const url = buildCaseUrl(c);
    const tag = phase === 'warmup' ? `[warmup:${c.label}]` : `[${c.label}]`;
    console.log(`\n${tag} ${url}`);

    page.removeAllListeners('console');
    page.on('console', (msg) => {
        if (msg.type() === 'error') {
            console.error(`${tag} console`, msg.text());
        }
    });

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 120_000 });

    const result = await page
        .waitForFunction(() => window.__sceneProfileBenchmark?.cases?.[0], undefined, {
            timeout: 1_800_000
        })
        .then(() => page.evaluate(() => window.__sceneProfileBenchmark?.cases?.[0]));

    if (phase === 'warmup') {
        console.log(`${tag} discarded (${Math.round(result.firstFrameMs ?? 0)}ms firstFrame)`);
    } else {
        console.log('Done', JSON.stringify(result, null, 2));
    }

    return result;
}

function inferBottleneckHint(result) {
    const waypoints = result.interactionWaypoints ?? [];
    const pendingPeak = waypoints.reduce((max, w) => Math.max(max, w.pendingPeakNodes ?? 0), 0);
    const guardActive = (result.fpsGuardTier ?? 0) > 0;
    const blocked = result.priorityBlocked === true;
    if (pendingPeak >= 8 && !guardActive && !blocked) {
        return 'asset-http';
    }
    if (blocked && pendingPeak >= 4) {
        return 'scheduler';
    }
    if (pendingPeak >= 8) {
        return 'mixed';
    }
    return 'scheduler';
}

function blurKeyframes(waypoints) {
    return (waypoints ?? []).filter(w => (w.blurToClearMs ?? 0) > 0);
}

function blurP90(waypoints) {
    const values = blurKeyframes(waypoints).map(w => w.blurToClearMs).filter(Number.isFinite);
    if (!values.length) {
        return null;
    }
    values.sort((a, b) => a - b);
    const idx = Math.min(values.length - 1, Math.floor(0.9 * values.length));
    return values[idx];
}

function pctDelta(base, next) {
    if (!Number.isFinite(base) || base === 0 || !Number.isFinite(next)) {
        return null;
    }
    return ((next - base) / base) * 100;
}

function buildComparisonSection(results, cases) {
    const groups = new Map();
    for (let i = 0; i < results.length; i++) {
        const group = cases[i]?.comparisonGroup ?? 'default';
        if (!groups.has(group)) {
            groups.set(group, []);
        }
        groups.get(group).push(results[i]);
    }
    const lines = ['', '## 优化前 vs 优化后', ''];
    for (const [group, groupResults] of groups) {
        const baseline = groupResults[0];
        lines.push(`### ${group}（基线 \`${baseline.label}\`）`, '');
        lines.push(
            '| case | lodMode | lodRuntime | firstFrameMs | kf-1 blur | kf-2 blur | blur P90 | vramPeak | poolEvictions |',
            '|------|---------|------------|--------------|-----------|-----------|----------|----------|---------------|'
        );
        for (const r of groupResults) {
            const kf1 = r.interactionWaypoints?.find(w => w.label === 'kf-1');
            const kf2 = r.interactionWaypoints?.find(w => w.label === 'kf-2');
            const dFirst = r === baseline ? '—' : `${pctDelta(baseline.firstFrameMs, r.firstFrameMs)?.toFixed?.(1) ?? '-'}%`;
            const baseKf1 = baseline.interactionWaypoints?.find(w => w.label === 'kf-1');
            const dKf1 = r === baseline ? '—' : `${pctDelta(baseKf1?.blurToClearMs, kf1?.blurToClearMs)?.toFixed?.(1) ?? '-'}%`;
            const runtime = r.lodRuntime ?? 'refinement';
            lines.push(
                `| ${r.label} | ${r.lodMode ?? '-'} | ${runtime} | ${r.firstFrameMs?.toFixed?.(0) ?? '-'} (${dFirst}) | ${kf1?.blurToClearMs?.toFixed?.(0) ?? '-'} (${dKf1}) | ${kf2?.blurToClearMs?.toFixed?.(0) ?? '-'} | ${blurP90(r.interactionWaypoints)?.toFixed?.(0) ?? '-'} | ${r.vramTexPeakMb?.toFixed?.(0) ?? '-'} | ${r.poolEvictions ?? '-'} |`
            );
        }
        lines.push('');
    }
    return lines;
}

/** @type {{ enabled: boolean; discarded: boolean; caseLabel?: string; durationMs?: number; skippedReason?: string }} */
const warmupMeta = { enabled: warmupEnabled, discarded: warmupEnabled };

const results = [];

if (warmStart) {
    const browser = await launchBrowser({ cold: false });
    const context = await browser.newContext();
    const page = await context.newPage();
    page.setDefaultTimeout(600_000);
    page.setDefaultNavigationTimeout(120_000);

    if (warmupEnabled) {
        const warmupCase = cases[0];
        const warmupStarted = Date.now();
        await runBenchmarkCase(page, warmupCase, { phase: 'warmup' });
        warmupMeta.caseLabel = warmupCase.label ?? 'case';
        warmupMeta.durationMs = Date.now() - warmupStarted;
        console.log(`\n[warmup] complete in ${warmupMeta.durationMs}ms — measured run(s) follow`);
    }

    for (const c of cases) {
        const measured = await runBenchmarkCase(page, c, { phase: 'measure' });
        results.push({
            ...measured,
            comparisonGroup: c.comparisonGroup,
            bottleneckHint: inferBottleneckHint(measured)
        });
    }

    await closeSession({ browser, context });
} else {
    console.log('[benchmark] cold start: fresh Chromium + disabled HTTP cache per case');

    for (const c of cases) {
        const session = await openColdSession();
        try {
            const measured = await runBenchmarkCase(session.page, c, { phase: 'measure' });
            results.push({
                ...measured,
                instances: c.instances,
                comparisonGroup: c.comparisonGroup,
                bottleneckHint: inferBottleneckHint(measured)
            });
        } finally {
            await closeSession(session);
        }
    }
}

const date = new Date().toISOString().slice(0, 10);
const suiteSlug = suitePath.replace(/^.*\//, '').replace(/\.json$/, '');
const outDir = join(__dirname, '../benchmark-reports', date, suiteSlug);
mkdirSync(outDir, { recursive: true });

/** @type {Map<string, { label: string; path: string }[]>} */
const screenshotsByCase = new Map();
for (const r of results) {
    screenshotsByCase.set(r.label, persistWaypointScreenshots(r, outDir));
}

const runConditions = {
    coldStart,
    browserSession: warmStart ? 'shared-context-per-script' : 'fresh-chromium-per-case',
    chromiumHttpCache: warmStart
        ? 'enabled-shared-after-warmup'
        : 'disabled-cdp-clearBrowserCache-zero-disk-cache',
    warmup: warmStart
        ? warmupMeta
        : { enabled: false, discarded: false, skippedReason: 'cold-start-default' },
    notes: [
        warmStart
            ? 'Warm start: measured case(s) share one browser context; optional discarded warmup preloads HTTP cache.'
            : 'Cold start (default): each case launches a new Chromium, blocks service workers, disables HTTP cache via CDP, clears browser cache, and uses --disk-cache-size=0.',
        'Playwright uses an ephemeral profile (not your daily Chrome); no cookies/storage persist after browser.close().',
        'OS page cache, DNS, and GPU shader/pipeline cache are NOT reset by this script — cross-run comparisons on one machine may still drift.'
    ]
};

const report = {
    benchmarkAxis: suite.benchmarkAxis ?? 'profile',
    suite: suitePath,
    baseUrl,
    renderer: defaultRenderer ?? 'webgl',
    runConditions,
    cases: results
};
writeFileSync(join(outDir, 'results.json'), JSON.stringify(report, null, 2));

const warmupLine = warmStart
    ? warmupEnabled
        ? `Warm start: discarded warmup \`${warmupMeta.caseLabel}\` (${warmupMeta.durationMs}ms), then measured in same context`
        : 'Warm start: shared browser context (no discarded warmup run)'
    : 'Cold start (default): fresh Chromium per case, HTTP cache disabled';

const lines = [
    `# Scene Profile Benchmark — ${date}`,
    '',
    `## 本轮维度: ${report.benchmarkAxis}`,
    '',
    `Suite: \`${suitePath}\``,
    '',
    `Renderer: \`${report.renderer}\``,
    '',
    '## 运行条件',
    '',
    `- Cold start: ${coldStart ? 'yes' : 'no'}`,
    `- Browser session: ${runConditions.browserSession}`,
    `- Chromium HTTP cache: ${runConditions.chromiumHttpCache}`,
    `- ${warmupLine}`,
    '- OS 页缓存 / GPU 编译缓存：脚本不控制，跨次运行可能仍有差异',
    '',
    '| label | presetId | budget | lodMode | lodRuntime | firstFrameMs | jsHeap@1st | vram@1st | jsHeapPeak | vramPeak | fpsP50 | fpsP95 | gsplatsAvgM |',
    '|-------|----------|--------|---------|------------|--------------|------------|----------|------------|----------|--------|--------|-------------|'
];
for (const r of results) {
    const runtime = r.lodRuntime ?? 'refinement';
    lines.push(
        `| ${r.label} | ${r.presetId} | ${r.budget ?? '-'} | ${r.lodMode ?? '-'} | ${runtime} | ${r.firstFrameMs ?? '-'} | ${r.jsHeapAtFirstFrameMb?.toFixed?.(0) ?? '-'} | ${r.vramTexAtFirstFrameMb?.toFixed?.(0) ?? '-'} | ${r.jsHeapPeakMb?.toFixed?.(0) ?? '-'} | ${r.vramTexPeakMb?.toFixed?.(0) ?? '-'} | ${r.fpsP50?.toFixed?.(1) ?? '-'} | ${r.fpsP95?.toFixed?.(1) ?? '-'} | ${r.gsplatsAvgM?.toFixed?.(2) ?? '-'} |`
    );
}

lines.push('', '## 交互巡检（糊→清晰）', '');
for (const r of results) {
    lines.push(`### ${r.label}`, '');
    if (r.animTrackBenchmark?.keyframes?.length) {
        lines.push(
            `播放段 FPS: P50=${r.animTrackBenchmark.fpsP50DuringPlayback?.toFixed?.(1) ?? '-'}, P95=${r.animTrackBenchmark.fpsP95DuringPlayback?.toFixed?.(1) ?? '-'}, min=${r.animTrackBenchmark.fpsMinDuringPlayback?.toFixed?.(1) ?? '-'}, 总播放=${r.animTrackBenchmark.totalPlaybackMs?.toFixed?.(0) ?? '-'}ms`,
            ''
        );
    }
    if (!r.interactionWaypoints?.length) {
        lines.push('- （无交互数据）', '');
        continue;
    }
    lines.push(
        '| waypoint | animTimeSec | moveMs | pendingPeak | blurToClearMs | fpsP50(refine) | fpsP95(refine) | fpsMin | gsplatsAtClearM | jsHeap@clear | vram@clear | jsHeapPeak | vramPeak | timeout |',
        '|----------|-------------|--------|-------------|---------------|----------------|----------------|--------|-----------------|--------------|------------|------------|----------|---------|'
    );
    for (const w of r.interactionWaypoints) {
        lines.push(
            `| ${w.label} | ${w.animTimeSec?.toFixed?.(2) ?? '-'} | ${w.moveMs?.toFixed?.(0) ?? '-'} | ${w.pendingPeakNodes ?? w.pendingNodesAtArrival ?? '-'} | ${w.blurToClearMs?.toFixed?.(0) ?? '-'} | ${w.fpsP50DuringRefine?.toFixed?.(1) ?? '-'} | ${w.fpsP95DuringRefine?.toFixed?.(1) ?? '-'} | ${w.fpsMinDuringRefine?.toFixed?.(1) ?? '-'} | ${w.gsplatsAtClearM?.toFixed?.(2) ?? '-'} | ${w.jsHeapAtClearMb?.toFixed?.(0) ?? '-'} | ${w.vramTexAtClearMb?.toFixed?.(0) ?? '-'} | ${w.jsHeapPeakDuringRefineMb?.toFixed?.(0) ?? '-'} | ${w.vramTexPeakDuringRefineMb?.toFixed?.(0) ?? '-'} | ${w.refineTimedOut ? 'Y' : 'N'} |`
        );
    }

    const shots = screenshotsByCase.get(r.label) ?? [];
    if (shots.length) {
        lines.push('', '变清晰截图（480×270 JPEG）：', '');
        for (const shot of shots) {
            lines.push(`**${shot.label}**`, '', `![${shot.label}](./${shot.path})`, '');
        }
    }

    lines.push('');
}
lines.push(...buildComparisonSection(results, cases));
lines.push('', '## 结论', '', '- 见上方对比表；`bottleneckHint` 见 `results.json`（scheduler / asset-http / mixed）');
writeFileSync(join(outDir, 'summary.md'), lines.join('\n'));
console.log('\nWrote', outDir);
