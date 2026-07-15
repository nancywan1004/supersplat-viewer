import type { GsplatBufferUploadMetrics } from './benchmark-refinement';

/** frame-profiler 样本（只取分析所需字段） */
export type BufferUploadProfileSample = {
    frameMs?: number;
    drawCalls?: number;
    gsplatsM?: number;
    jsHeapMb?: number;
    cpu?: { gsplatBufferCopyPct?: number; renderMs?: number };
    gpu?: { totalMs?: number };
    refinement?: { gapMs?: number };
    bufferUpload?: Partial<GsplatBufferUploadMetrics>;
};

export type StatSummary = { n: number; p50: number; p90: number; max: number; avg: number };

export type BufferUploadSegmentRow = {
    label: string;
    frames: number;
    pctOfAll: number;
    frameMs: StatSummary;
    gapMs: StatSummary;
    uploadMbEst: StatSummary;
    drawCalls: StatSummary;
    gsplatsM: StatSummary;
    activeSlotsM: StatSummary;
    blocksUp: StatSummary;
    blocksTotal: StatSummary;
    copyPct: StatSummary;
    bakePasses: StatSummary;
    frag: StatSummary;
    engineFullRebuild: number;
    inferredFullRebuild: number;
};

export type BufferUploadCapacityRow = {
    splatBudgetM: number;
    capacityMinM: number;
    capacityMaxM: number;
    capacityGrew: boolean;
    usedMinM: number;
    usedMaxM: number;
    hardCapM: number;
    textureSize: number;
    maxTextureSize: number;
};

export type BufferUploadHistogramRow = {
    bucket: string;
    frames: number;
    pct: number;
    frameMsP50: number;
    gapMsP50: number;
};

export type BufferUploadProfileReport = {
    meta: { sampleCount: number; hasBufferUpload: boolean; exportedAt?: string; scene?: string };
    storageLayers: { layer: string; location: string; role: string; countedIn: string }[];
    capacity: BufferUploadCapacityRow;
    segments: BufferUploadSegmentRow[];
    histogram: BufferUploadHistogramRow[];
    markdown: string;
};

function num(v: unknown): number | null {
    return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function pct(arr: number[], p: number): number {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

export function statSummary(arr: number[]): StatSummary {
    if (!arr.length) {
        return { n: 0, p50: 0, p90: 0, max: 0, avg: 0 };
    }
    const sum = arr.reduce((a, b) => a + b, 0);
    return {
        n: arr.length,
        p50: pct(arr, 50),
        p90: pct(arr, 90),
        max: Math.max(...arr),
        avg: sum / arr.length
    };
}

function fmtMs(v: number, digits = 1): string {
    return v > 0 ? v.toFixed(digits) : '—';
}

function fmtMb(v: number, digits = 1): string {
    if (!Number.isFinite(v)) return '—';
    return v.toFixed(digits);
}

function fmtBlocksPair(up: StatSummary, tot: StatSummary): string {
    if (!up.n && !tot.n) return '—';
    const u = up.n ? up.p50.toFixed(0) : '—';
    const t = tot.n ? tot.p50.toFixed(0) : '—';
    return `${u}/${t}`;
}

function fmtM(v: number, digits = 2): string {
    return v > 0 ? v.toFixed(digits) : '—';
}

function fmtStatMs(s: StatSummary, digits = 1): string {
    if (!s.n) return '—';
    return `${fmtMs(s.p50, digits)} / ${fmtMs(s.p90, digits)} / ${fmtMs(s.max, digits)}`;
}

function fmtStatMb(s: StatSummary): string {
    if (!s.n) return '—';
    return `${fmtMb(s.p50)} / ${fmtMb(s.p90)} / ${fmtMb(s.max)}`;
}

function fmtStatN(s: StatSummary, digits = 0): string {
    if (!s.n) return '—';
    return `${s.p50.toFixed(digits)} / ${s.p90.toFixed(digits)} / ${s.max.toFixed(digits)}`;
}

function readCopyPct(s: BufferUploadProfileSample): number {
    return num(s.cpu?.gsplatBufferCopyPct) ?? num(s.bufferUpload?.copyPct) ?? 0;
}

function isSlow(s: BufferUploadProfileSample): boolean {
    const f = num(s.frameMs) ?? 0;
    return f >= 140 && f <= 200;
}

function isFast(s: BufferUploadProfileSample): boolean {
    const f = num(s.frameMs) ?? 0;
    return f >= 40 && f <= 70;
}

function isUploadFrame(s: BufferUploadProfileSample): boolean {
    const bu = s.bufferUpload;
    if ((bu?.uploadedBlocks ?? 0) > 0) return true;
    return readCopyPct(s) >= 99 && (num(s.drawCalls) ?? 0) >= 10;
}

function buildSegment(
    label: string,
    frames: BufferUploadProfileSample[],
    total: number
): BufferUploadSegmentRow {
    const pick = <T>(fn: (s: BufferUploadProfileSample) => T | null | undefined) =>
        frames.map(fn).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));

    const engineFull = frames.filter(
        (s) => s.bufferUpload?.fullRebuild && s.bufferUpload.fullRebuildSource === 'engine'
    ).length;
    const inferredFull = frames.filter(
        (s) => s.bufferUpload?.fullRebuild && s.bufferUpload.fullRebuildSource === 'inferred'
    ).length;

    return {
        label,
        frames: frames.length,
        pctOfAll: total > 0 ? (frames.length / total) * 100 : 0,
        frameMs: statSummary(pick((s) => num(s.frameMs))),
        gapMs: statSummary(pick((s) => num(s.refinement?.gapMs))),
        uploadMbEst: statSummary(pick((s) => num(s.bufferUpload?.uploadMbEst))),
        drawCalls: statSummary(pick((s) => num(s.drawCalls))),
        gsplatsM: statSummary(pick((s) => num(s.gsplatsM))),
        activeSlotsM: statSummary(pick((s) => (num(s.bufferUpload?.activeSplatSlots) ?? 0) / 1e6)),
        blocksUp: statSummary(pick((s) => num(s.bufferUpload?.uniqueUploadBlocksEst ?? s.bufferUpload?.uploadedBlocks))),
        blocksTotal: statSummary(pick((s) => num(s.bufferUpload?.totalBlocks))),
        copyPct: statSummary(pick(readCopyPct)),
        bakePasses: statSummary(pick((s) => num(s.bufferUpload?.bakePassesEst))),
        frag: statSummary(pick((s) => num(s.bufferUpload?.fragmentation))),
        engineFullRebuild: engineFull,
        inferredFullRebuild: inferredFull
    };
}

function uploadMbBucket(mb: number): string {
    if (mb <= 0) return '0（无上传）';
    if (mb < 5) return '0–5 MB';
    if (mb < 20) return '5–20 MB';
    if (mb < 40) return '20–40 MB';
    if (mb < 60) return '40–60 MB';
    return '≥60 MB';
}

function buildStorageLayersTable(): BufferUploadProfileReport['storageLayers'] {
    return [
        {
            layer: 'SOG / RAD 解码 Resource',
            location: 'CPU 堆（JS + 解码缓冲）',
            role: '磁盘 LOD 文件解码后的 splat 源数据',
            countedIn: 'jsHeapMb、下载 pin 文件'
        },
        {
            layer: 'Work Buffer（GPU 纹理）',
            location: 'GPU VRAM（WebGPU Texture）',
            role: '本帧要参与 compaction/绘制的 unified splat 布局',
            countedIn: 'vramTexMb、bufferUpload.activeSplatSlots'
        },
        {
            layer: 'Bake Staging',
            location: 'CPU 主线程临时数组（render 内）',
            role: '从 Resource 读 position/color 等再 writeBuffer',
            countedIn: 'bufferUpload.bakeCpuMs / writeBufferMs（≠ gapMs 残差）'
        },
        {
            layer: 'Compaction / Sort 缓冲',
            location: 'GPU VRAM',
            role: '可见 splat 索引、radix sort 等',
            countedIn: 'gpu.totalMs'
        }
    ];
}

function buildCapacity(samples: BufferUploadProfileSample[]): BufferUploadCapacityRow {
    const withBu = samples.filter((s) => s.bufferUpload?.allocatorCapacity);
    const caps = withBu.map((s) => num(s.bufferUpload!.allocatorCapacity)!);
    const used = withBu.map((s) => num(s.bufferUpload!.allocatorUsed)!);
    const ref = withBu.find((s) => s.bufferUpload)?.bufferUpload;
    return {
        splatBudgetM: (num(ref?.splatBudget) ?? 0) / 1e6,
        capacityMinM: caps.length ? Math.min(...caps) / 1e6 : 0,
        capacityMaxM: caps.length ? Math.max(...caps) / 1e6 : 0,
        capacityGrew: caps.length > 1 && Math.max(...caps) > Math.min(...caps) + 1,
        usedMinM: used.length ? Math.min(...used) / 1e6 : 0,
        usedMaxM: used.length ? Math.max(...used) / 1e6 : 0,
        hardCapM: (num(ref?.hardCapSlots) ?? 0) / 1e6,
        textureSize: num(ref?.textureSize) ?? 0,
        maxTextureSize: num(ref?.maxTextureSize) ?? 0
    };
}

function renderMarkdown(report: Omit<BufferUploadProfileReport, 'markdown'>): string {
    const lines: string[] = [];
    const { meta, storageLayers, capacity, segments, histogram } = report;

    lines.push('# Work Buffer / 上传量统计表');
    lines.push('');
    lines.push(`> 自动生成 · 样本 **${meta.sampleCount}** 帧 · bufferUpload 字段 ${meta.hasBufferUpload ? '✅' : '❌'}`);
    if (meta.scene) lines.push(`> 场景：\`${meta.scene}\``);
    if (meta.exportedAt) lines.push(`> 导出：${meta.exportedAt}`);
    lines.push('');

    lines.push('## 1. 存储分层（CPU / GPU 是不是一套？）');
    lines.push('');
    lines.push('| 层 | 物理位置 | 作用 | Benchmark 里看哪项 |');
    lines.push('|---|---|---|---|');
    for (const row of storageLayers) {
        lines.push(`| ${row.layer} | ${row.location} | ${row.role} | ${row.countedIn} |`);
    }
    lines.push('');
    lines.push(
        '**结论**：Work Buffer **只有 GPU 侧一份持久纹理**；CPU 在 bake 时读 Resource、写 staging，再 `writeBuffer` 上传。**不是 CPU/GPU 各存一套 work buffer**。' +
            ' jsHeap 主要是 **解码后的 SOG Resource + pin 文件**，和 work buffer **不是同一块内存**。'
    );
    lines.push('');

    lines.push('## 2. Work Buffer 容量');
    lines.push('');
    lines.push('| 项 | 值 | 说明 |');
    lines.push('|---|---:|---|');
    lines.push(`| splatBudget | ${fmtM(capacity.splatBudgetM)} M | URL/场景软预算 |`);
    lines.push(
        `| allocator capacity | ${fmtM(capacity.capacityMinM)} – ${fmtM(capacity.capacityMaxM)} M | ` +
            `${capacity.capacityGrew ? '**本趟发生 grow**' : '本趟未 grow（恒定）'} |`
    );
    lines.push(`| allocator used | ${fmtM(capacity.usedMinM)} – ${fmtM(capacity.usedMaxM)} M | 已分配 slot |`);
    lines.push(`| hardCap (maxTextureSize²) | ${fmtM(capacity.hardCapM)} M | 设备纹理硬顶 |`);
    lines.push(`| textureSize | ${capacity.textureSize || '—'} | ≈√capacity |`);
    lines.push(`| maxTextureSize | ${capacity.maxTextureSize || '—'} | WebGPU 上限 |`);
    lines.push('');

    lines.push('## 3. 分档统计（P50 / P90 / max）');
    lines.push('');
    lines.push(
        '| 分档 | 帧数 | 占比 | frameMs | gapMs | uploadMB | drawCalls | gsplatsM | activeM | blocks↑/tot P50 | copy% P50 | bake× P50 | frag P50 | engFULL | infFULL |'
    );
    lines.push('|---|---:|---:|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|');
    for (const r of segments) {
        lines.push(
            `| ${r.label} | ${r.frames} | ${r.pctOfAll.toFixed(1)}% | ${fmtStatMs(r.frameMs)} | ${fmtStatMs(r.gapMs)} | ` +
                `${fmtStatMb(r.uploadMbEst)} | ${fmtStatN(r.drawCalls)} | ${fmtStatN(r.gsplatsM, 2)} | ${fmtStatN(r.activeSlotsM, 2)} | ` +
                `${fmtBlocksPair(r.blocksUp, r.blocksTotal)} | ${r.copyPct.n ? r.copyPct.p50.toFixed(1) : '—'} | ` +
                `${r.bakePasses.n ? r.bakePasses.p50.toFixed(0) : '—'} | ${r.frag.n ? r.frag.p50.toFixed(3) : '—'} | ` +
                `${r.engineFullRebuild} | ${r.inferredFullRebuild} |`
        );
    }
    lines.push('');
    lines.push(
        '列说明：数值列除帧数/占比外均为 **P50 / P90 / max**；`blocks↑/tot P50` = uniqueUploadBlocks / totalBlocks；`uploadMB` = slot写入次数×40B。'
    );
    lines.push('');

    lines.push('## 4. 上传量分布（uploadMbEst）');
    lines.push('');
    lines.push('| 桶 | 帧数 | 占比 | 该桶 frameMs P50 | gapMs P50 |');
    lines.push('|---|---:|---:|---:|---:|');
    for (const h of histogram) {
        lines.push(
            `| ${h.bucket} | ${h.frames} | ${h.pct.toFixed(1)}% | ${fmtMs(h.frameMsP50)} | ${fmtMs(h.gapMsP50)} |`
        );
    }
    lines.push('');

    return lines.join('\n');
}

export function analyzeBufferUploadProfile(
    samples: BufferUploadProfileSample[],
    meta: BufferUploadProfileReport['meta'] = { sampleCount: samples.length, hasBufferUpload: false }
): BufferUploadProfileReport {
    const hasBufferUpload = samples.some((s) => s.bufferUpload && Object.keys(s.bufferUpload).length > 0);
    const total = samples.length;

    const segments = [
        buildSegment('全部', samples, total),
        buildSegment('慢档 140–200ms', samples.filter(isSlow), total),
        buildSegment('快档 40–70ms', samples.filter(isFast), total),
        buildSegment('上传帧', samples.filter(isUploadFrame), total),
        buildSegment('fullRebuild（任意）', samples.filter((s) => s.bufferUpload?.fullRebuild), total),
        buildSegment(
            'fullRebuild engine',
            samples.filter((s) => s.bufferUpload?.fullRebuild && s.bufferUpload.fullRebuildSource === 'engine'),
            total
        ),
        buildSegment(
            'fullRebuild inferred',
            samples.filter((s) => s.bufferUpload?.fullRebuild && s.bufferUpload.fullRebuildSource === 'inferred'),
            total
        )
    ];

    const histMap = new Map<string, BufferUploadProfileSample[]>();
    for (const s of samples) {
        const mb = num(s.bufferUpload?.uploadMbEst) ?? 0;
        const b = uploadMbBucket(mb);
        if (!histMap.has(b)) histMap.set(b, []);
        histMap.get(b)!.push(s);
    }
    const bucketOrder = ['0（无上传）', '0–5 MB', '5–20 MB', '20–40 MB', '40–60 MB', '≥60 MB'];
    const histogram: BufferUploadHistogramRow[] = bucketOrder
        .filter((b) => histMap.has(b))
        .map((bucket) => {
            const g = histMap.get(bucket)!;
            return {
                bucket,
                frames: g.length,
                pct: total > 0 ? (g.length / total) * 100 : 0,
                frameMsP50: statSummary(g.map((s) => num(s.frameMs) ?? 0)).p50,
                gapMsP50: statSummary(g.map((s) => num(s.refinement?.gapMs) ?? 0)).p50
            };
        });

    const partial = {
        meta: { ...meta, sampleCount: total, hasBufferUpload },
        storageLayers: buildStorageLayersTable(),
        capacity: buildCapacity(samples),
        segments,
        histogram
    };

    return { ...partial, markdown: renderMarkdown(partial) };
}

/** 控制台 ASCII 表（frame-profiler stop 用） */
export function logBufferUploadProfileTable(report: BufferUploadProfileReport): void {
    console.info('\n[buffer-upload-table]\n' + report.markdown + '\n');
}
