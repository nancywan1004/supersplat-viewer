import type { Global } from '../types';
import { MeshCollision } from './mesh-collision';
import { VoxelCollision } from './voxel-collision';
import { getCameraCollisionManager } from './camera-collision-manager';

export type CollisionOverlayConsoleResult = {
    enabled: boolean;
    ready: boolean;
    kind: 'voxel' | 'mesh' | 'none';
    message: string;
};

type CollisionOverlayConsoleApi = {
    /** 切换或强制设置场景 collision debug overlay（voxel / mesh） */
    toggleCollisionOverlay: (force?: boolean) => Promise<CollisionOverlayConsoleResult>;
    /** 只读状态 */
    getCollisionOverlay: () => CollisionOverlayConsoleResult;
};

declare global {
    interface Window {
        toggleCollisionOverlay?: CollisionOverlayConsoleApi['toggleCollisionOverlay'];
        getCollisionOverlay?: CollisionOverlayConsoleApi['getCollisionOverlay'];
    }
}

function detectOverlayKind(global: Global): 'voxel' | 'mesh' | 'none' {
    const collision = getCameraCollisionManager(global).getCollision();
    if (collision instanceof VoxelCollision) {
        return 'voxel';
    }
    if (collision instanceof MeshCollision) {
        return 'mesh';
    }
    return global.state.hasCollisionOverlay ? 'mesh' : 'none';
}

function snapshot(global: Global, message: string): CollisionOverlayConsoleResult {
    return {
        enabled: !!global.state.collisionOverlayEnabled,
        ready: !!global.state.hasCollisionOverlay,
        kind: detectOverlayKind(global),
        message
    };
}

function waitForOverlayReady(global: Global, timeoutMs = 60000): Promise<boolean> {
    if (global.state.hasCollisionOverlay) {
        return Promise.resolve(true);
    }
    return new Promise((resolve) => {
        const { events } = global;
        let done = false;
        const finish = (ok: boolean) => {
            if (done) return;
            done = true;
            window.clearTimeout(timer);
            events.off('hasCollisionOverlay:changed', onChanged);
            resolve(ok);
        };
        const onChanged = (value: boolean) => {
            if (value) {
                finish(true);
            }
        };
        const timer = window.setTimeout(() => finish(false), timeoutMs);
        events.on('hasCollisionOverlay:changed', onChanged);
        if (global.state.hasCollisionOverlay) {
            finish(true);
        }
    });
}

/**
 * 安装控制台 API：
 * - `toggleCollisionOverlay()` / `toggleCollisionOverlay(true|false)`
 * - `getCollisionOverlay()`
 * 有 collision mesh/voxel 时用现有 PlayCanvas 风格 overlay（VoxelDebugOverlay / MeshDebugOverlay）。
 */
export function installCollisionOverlayConsole(global: Global): void {
    const getCollisionOverlay = (): CollisionOverlayConsoleResult => {
        if (!global.state.hasCollision) {
            return snapshot(global, '无 collision URL / 不可生成，无可视化数据');
        }
        if (!global.state.hasCollisionOverlay) {
            return snapshot(
                global,
                'collision 资源尚未就绪（请先开物理碰撞或等待加载）；加载后可用 toggleCollisionOverlay()'
            );
        }
        return snapshot(
            global,
            global.state.collisionOverlayEnabled
                ? `已开启（${detectOverlayKind(global)}）`
                : `已关闭（${detectOverlayKind(global)}，调用 toggleCollisionOverlay() 开启）`
        );
    };

    const toggleCollisionOverlay = async (
        force?: boolean
    ): Promise<CollisionOverlayConsoleResult> => {
        const mgr = getCameraCollisionManager(global);
        const next =
            typeof force === 'boolean' ? force : !global.state.collisionOverlayEnabled;

        if (!next) {
            global.state.collisionOverlayEnabled = false;
            global.app.renderNextFrame = true;
            const result = snapshot(global, '已关闭 collision overlay');
            console.info('[CollisionOverlay]', result.message, result);
            return result;
        }

        if (!global.state.hasCollision && !mgr.getCollisionUrl() && !mgr.getCollision()) {
            const result = snapshot(global, '无法开启：没有 collision URL，也未加载到 collision 数据');
            console.warn('[CollisionOverlay]', result.message, result);
            return result;
        }

        try {
            await mgr.ensureSceneMeshLoaded({ wantCollision: true });
        } catch (err) {
            console.warn('[CollisionOverlay] ensureSceneMeshLoaded failed:', err);
        }

        const ready = await waitForOverlayReady(global);
        if (!ready) {
            const result = snapshot(
                global,
                '等待 overlay 超时：可能是 GLB/voxel 加载失败，或 WebGL 下 voxel overlay 不可用'
            );
            console.warn('[CollisionOverlay]', result.message, result);
            return result;
        }

        global.state.collisionOverlayEnabled = true;
        global.app.renderNextFrame = true;
        const kind = detectOverlayKind(global);
        const result = snapshot(
            global,
            kind === 'voxel'
                ? '已开启 voxel overlay（PlayCanvas 风格射线步进线框）'
                : kind === 'mesh'
                    ? '已开启 mesh overlay（三角面半透明 + 线框；当前 collision 为 GLB）'
                    : '已开启 overlay'
        );
        console.info('[CollisionOverlay]', result.message, result);
        return result;
    };

    window.toggleCollisionOverlay = toggleCollisionOverlay;
    window.getCollisionOverlay = getCollisionOverlay;

    const sse = (window as Window & { sse?: Record<string, unknown> }).sse;
    if (sse && typeof sse === 'object') {
        sse.toggleCollisionOverlay = toggleCollisionOverlay;
        sse.getCollisionOverlay = getCollisionOverlay;
    }

    console.info(
        '[CollisionOverlay] 控制台可用：toggleCollisionOverlay() / toggleCollisionOverlay(true|false) / getCollisionOverlay()'
    );
}
