import type { Global } from './types';

/** 通知各模块按当前 state 重新同步编辑调试可视化（Gizmo、光源线框等） */
export function syncDebugVisualPolicy(global: Global): void {
    global.events.fire('debugVisualPolicy:changed');
}

/**
 * 截图等「干净视口」采集前临时关闭 debugVisual，完成后恢复。
 * 语义与预览模式一致，但不改动 previewMode 及其副作用。
 */
export async function runWithDebugVisualsSuppressed<T>(
    global: Global,
    fn: () => Promise<T>
): Promise<T> {
    const { state } = global;
    if (state.suppressDebugVisualsForCapture) {
        return fn();
    }

    state.suppressDebugVisualsForCapture = true;
    syncDebugVisualPolicy(global);
    try {
        return await fn();
    } finally {
        state.suppressDebugVisualsForCapture = false;
        syncDebugVisualPolicy(global);
    }
}
