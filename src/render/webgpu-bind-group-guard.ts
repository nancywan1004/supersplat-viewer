/**
 * WebGPU BindGroup / WorkBuffer bake 恢复竞态防护。
 *
 * playcanvas vendor ESM 不导出 BindGroup / QuadRender / RenderPass，
 * 因此挂在 `device.emptyBindGroup.constructor.prototype` 与 `device.draw` 上。
 *
 * 诊断：`?webgpuBindDiag=1` 或 localStorage `webgpuBindDiag=1`
 */
import type { AppBase, GraphicsDevice } from 'playcanvas';

const SKIP_DRAW = '__webgpuBindGroupSkipDraw';
const LOG = '[webgpu-bind-group-guard]';

type UniformBufferLike = {
    persistent?: boolean;
    impl?: { buffer?: unknown };
    allocation?: { gpuBuffer?: { buffer?: unknown } };
};

type StorageBufferLike = {
    impl?: { buffer?: unknown };
};

type BindGroupDiag = {
    kind: 'uniform' | 'storage';
    index: number;
    persistent?: boolean;
    hasObject: boolean;
    hasImplOrAlloc: boolean;
    hasWgpuBuffer: boolean;
    detail: string;
};

type BindGroupLike = {
    dirty: boolean;
    uniformBuffers?: UniformBufferLike[];
    storageBuffers?: StorageBufferLike[];
    update: () => void;
    [SKIP_DRAW]?: boolean;
};

export type WebgpuBindGroupGuardState = {
    visibility: DocumentVisibilityState | 'unknown';
    hiddenStartedAt: number | null;
    lastHiddenDurationMs: number;
    framesSinceVisible: number;
    renderVersion: number;
    deviceLost: boolean;
    deviceRestoredCount: number;
    skipDrawCount: number;
    lastSkipReason: string | null;
    lastDiag: BindGroupDiag[] | null;
};

const state: WebgpuBindGroupGuardState = {
    visibility: typeof document !== 'undefined' ? document.visibilityState : 'unknown',
    hiddenStartedAt: null,
    lastHiddenDurationMs: 0,
    framesSinceVisible: 999,
    renderVersion: -1,
    deviceLost: false,
    deviceRestoredCount: 0,
    skipDrawCount: 0,
    lastSkipReason: null,
    lastDiag: null
};

let installed = false;
let verbose = false;
let resumeGraceFrames = 0;
const RESUME_GRACE_DEFAULT = 3;
const HIDDEN_MS_FOR_GRACE = 200;

/** BINDGROUP_MESH === 1（PlayCanvas constants） */
const BINDGROUP_MESH = 1;

const isVerboseEnabled = (): boolean => {
    if (typeof location === 'undefined') return false;
    try {
        const qs = new URLSearchParams(location.search);
        if (qs.get('webgpuBindDiag') === '1' || qs.get('webgpuBindDiag') === 'true') return true;
        return localStorage.getItem('webgpuBindDiag') === '1';
    } catch {
        return false;
    }
};

const collectDetachedGpuBuffers = (bindGroup: BindGroupLike): BindGroupDiag[] | null => {
    const invalid: BindGroupDiag[] = [];
    const ubs = bindGroup.uniformBuffers ?? [];
    for (let i = 0; i < ubs.length; i++) {
        const ub = ubs[i];
        if (!ub) continue;
        if (ub.persistent) {
            if (ub.impl && ub.impl.buffer == null) {
                invalid.push({
                    kind: 'uniform',
                    index: i,
                    persistent: true,
                    hasObject: true,
                    hasImplOrAlloc: true,
                    hasWgpuBuffer: false,
                    detail: 'ub.impl.buffer == null (persistent)'
                });
            }
        } else if (ub.allocation?.gpuBuffer && ub.allocation.gpuBuffer.buffer == null) {
            invalid.push({
                kind: 'uniform',
                index: i,
                persistent: false,
                hasObject: true,
                hasImplOrAlloc: true,
                hasWgpuBuffer: false,
                detail: 'ub.allocation.gpuBuffer.buffer == null (dynamic)'
            });
        }
    }
    const sbs = bindGroup.storageBuffers ?? [];
    for (let i = 0; i < sbs.length; i++) {
        const buf = sbs[i];
        if (!buf) continue;
        if (buf.impl && buf.impl.buffer == null) {
            invalid.push({
                kind: 'storage',
                index: i,
                hasObject: true,
                hasImplOrAlloc: true,
                hasWgpuBuffer: false,
                detail: 'storage.impl.buffer == null'
            });
        }
    }
    return invalid.length ? invalid : null;
};

const logSkip = (reason: string, invalid: BindGroupDiag[] | null) => {
    state.skipDrawCount += 1;
    state.lastSkipReason = reason;
    state.lastDiag = invalid;
    if (!verbose && state.skipDrawCount > 5) return;
    // eslint-disable-next-line no-console
    console.warn(LOG, reason, {
        visibility: state.visibility,
        framesSinceVisible: state.framesSinceVisible,
        lastHiddenDurationMs: state.lastHiddenDurationMs,
        renderVersion: state.renderVersion,
        deviceLost: state.deviceLost,
        deviceRestoredCount: state.deviceRestoredCount,
        invalid
    });
};

export const getWebgpuBindGroupGuardState = (): Readonly<WebgpuBindGroupGuardState> => state;

type DeviceHooks = GraphicsDevice & {
    emptyBindGroup?: BindGroupLike;
    wgpu?: {
        createBindGroup: (desc: GPUBindGroupDescriptor) => GPUBindGroup;
    };
    on?: (name: string, fn: (...args: unknown[]) => void) => void;
    renderVersion?: number;
    contextLost?: boolean;
    draw: (...args: unknown[]) => void;
    setBindGroup: (index: number, bindGroup: unknown, offsets?: number[]) => void;
};

export const installWebgpuBindGroupGuard = (app: AppBase, options?: {
    resumeGraceFrames?: number;
}): void => {
    if (installed) return;
    installed = true;
    verbose = isVerboseEnabled();
    const graceN = options?.resumeGraceFrames ?? RESUME_GRACE_DEFAULT;

    const device = app.graphicsDevice as DeviceHooks;
    const empty = device.emptyBindGroup;
    if (!empty?.constructor?.prototype?.update) {
        // eslint-disable-next-line no-console
        console.warn(LOG, 'skip: emptyBindGroup.prototype.update missing');
        return;
    }

    const onVisibility = () => {
        if (typeof document === 'undefined') return;
        state.visibility = document.visibilityState;
        if (document.hidden) {
            state.hiddenStartedAt = performance.now();
        } else {
            if (state.hiddenStartedAt != null) {
                state.lastHiddenDurationMs = performance.now() - state.hiddenStartedAt;
            }
            state.hiddenStartedAt = null;
            state.framesSinceVisible = 0;
            if (state.lastHiddenDurationMs >= HIDDEN_MS_FOR_GRACE) {
                resumeGraceFrames = graceN;
            }
            if (verbose) {
                // eslint-disable-next-line no-console
                console.info(LOG, 'visible', {
                    lastHiddenDurationMs: state.lastHiddenDurationMs,
                    resumeGraceFrames
                });
            }
        }
    };
    document.addEventListener('visibilitychange', onVisibility);
    onVisibility();

    device.on?.('devicelost', () => {
        state.deviceLost = true;
        // eslint-disable-next-line no-console
        console.warn(LOG, 'devicelost');
    });
    device.on?.('devicerestored', () => {
        state.deviceLost = false;
        state.deviceRestoredCount += 1;
        state.framesSinceVisible = 0;
        resumeGraceFrames = Math.max(resumeGraceFrames, graceN);
        // eslint-disable-next-line no-console
        console.warn(LOG, 'devicerestored', {
            deviceRestoredCount: state.deviceRestoredCount
        });
    });

    app.on('frameupdate', () => {
        state.renderVersion = device.renderVersion ?? -1;
        if (typeof document !== 'undefined' && !document.hidden) {
            state.framesSinceVisible += 1;
            if (resumeGraceFrames > 0) resumeGraceFrames -= 1;
        }
    });

    const bindProto = empty.constructor.prototype as BindGroupLike;
    const origBindUpdate = bindProto.update;
    bindProto.update = function patchedBindGroupUpdate(this: BindGroupLike) {
        const bg = this;

        const detached = collectDetachedGpuBuffers(bg);
        if (detached && bg.dirty) {
            bg.dirty = true;
            bg[SKIP_DRAW] = true;
            logSkip('detached-gpu-buffer-before-createBindGroup', detached);
            return;
        }

        if (resumeGraceFrames > 0 && bg.dirty) {
            bg.dirty = true;
            bg[SKIP_DRAW] = true;
            logSkip(`resume-grace-defer-createBindGroup (left=${resumeGraceFrames})`, detached);
            return;
        }

        try {
            origBindUpdate.call(this);
            bg[SKIP_DRAW] = false;
        } catch (err) {
            bg.dirty = true;
            bg[SKIP_DRAW] = true;
            logSkip(
                `createBindGroup-threw: ${(err as Error)?.message ?? String(err)}`,
                collectDetachedGpuBuffers(bg)
            );
        }
    };

    if (device.wgpu?.createBindGroup) {
        const origCreate = device.wgpu.createBindGroup.bind(device.wgpu);
        device.wgpu.createBindGroup = (desc: GPUBindGroupDescriptor) => {
            const entries = desc.entries ?? [];
            for (let i = 0; i < entries.length; i++) {
                const resource = entries[i].resource as { buffer?: unknown } | unknown;
                if (
                    resource &&
                    typeof resource === 'object' &&
                    'buffer' in resource &&
                    (resource as { buffer?: unknown }).buffer == null
                ) {
                    const err = new Error(
                        `GUARD: GPUBindGroupEntry[${i}].resource.buffer is null/undefined`
                    );
                    (err as Error & { code?: string }).code = 'WEBGPU_BINDGROUP_INVALID_BUFFER';
                    throw err;
                }
            }
            return origCreate(desc);
        };
    }

    let meshBindGroup: BindGroupLike | null = null;
    const origSetBindGroup = device.setBindGroup.bind(device);
    device.setBindGroup = (index: number, bindGroup: unknown, offsets?: number[]) => {
        if (index === BINDGROUP_MESH) {
            meshBindGroup = bindGroup as BindGroupLike | null;
        }
        return origSetBindGroup(index, bindGroup, offsets);
    };

    const origDraw = device.draw.bind(device);
    device.draw = (...args: unknown[]) => {
        if (meshBindGroup?.[SKIP_DRAW]) {
            return;
        }
        return origDraw(...args);
    };

    app.on('frameend', () => {
        meshBindGroup = null;
    });

    // eslint-disable-next-line no-console
    console.info(LOG, 'installed', { verbose, graceN });
};
