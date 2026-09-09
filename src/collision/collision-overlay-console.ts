import {
    BLEND_NORMAL,
    Color,
    Entity,
    Mesh,
    MeshInstance,
    PRIMITIVE_LINES,
    StandardMaterial,
    Vec3
} from 'playcanvas';

import type { Global } from '../types';
import { readSceneAssetCollisionRuntimeState } from '../scene-assets/collision/scene-asset-collision';
import type { PushOut } from './collision';
import { MeshCollision } from './mesh-collision';
import { VoxelCollision } from './voxel-collision';
import { getCameraCollisionManager } from './camera-collision-manager';

export type CollisionOverlayConsoleResult = {
    enabled: boolean;
    ready: boolean;
    kind: 'voxel' | 'mesh' | 'none';
    message: string;
};

export type CollisionProbeResult = {
    kind: 'voxel' | 'mesh' | 'none';
    url?: string;
    radius: number;
    camera: { x: number; y: number; z: number };
    penetrating: boolean;
    pushOut?: { x: number; y: number; z: number; length: number };
    /** 沿相机朝前，球心首次触碰 collision 的距离（米）；null=前方无碰撞 */
    forwardClearanceM: number | null;
    mesh?: {
        triangleCount: number;
        aabb: { min: number[]; max: number[]; size: number[] };
    };
    notes: string[];
};

declare global {
    interface Window {
        toggleCollisionOverlay?: (force?: boolean) => Promise<CollisionOverlayConsoleResult>;
        getCollisionOverlay?: () => CollisionOverlayConsoleResult;
        probeCollision?: () => Promise<CollisionProbeResult>;
        toggleCollisionProbe?: (force?: boolean) => boolean;
        regenerateSceneMesh?: () => Promise<SceneMeshRegenerateConsoleResult>;
    }
}

export type SceneMeshRegenerateConsoleResult =
    | { ok: true; url: string; message: string }
    | { ok: false; message: string };

const probePush: PushOut = { x: 0, y: 0, z: 0 };
const tmpForward = new Vec3();
const tmpProbe = new Vec3();

function detectKind(global: Global): 'voxel' | 'mesh' | 'none' {
    const collision = getCameraCollisionManager(global).getCollision();
    if (collision instanceof VoxelCollision) return 'voxel';
    if (collision instanceof MeshCollision) return 'mesh';
    return global.state.hasCollisionOverlay ? 'mesh' : 'none';
}

function snapshot(global: Global, message: string): CollisionOverlayConsoleResult {
    return {
        enabled: !!global.state.collisionOverlayEnabled,
        ready: !!global.state.hasCollisionOverlay,
        kind: detectKind(global),
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
            if (value) finish(true);
        };
        const timer = window.setTimeout(() => finish(false), timeoutMs);
        events.on('hasCollisionOverlay:changed', onChanged);
        if (global.state.hasCollisionOverlay) finish(true);
    });
}

function meshAabb(collision: MeshCollision): {
    triangleCount: number;
    aabb: { min: number[]; max: number[]; size: number[] };
} {
    const tris = collision.triangles;
    let minX = Infinity;
    let minY = Infinity;
    let minZ = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    let maxZ = -Infinity;
    for (let i = 0; i < tris.count; i++) {
        minX = Math.min(minX, tris.v0x[i], tris.v1x[i], tris.v2x[i]);
        minY = Math.min(minY, tris.v0y[i], tris.v1y[i], tris.v2y[i]);
        minZ = Math.min(minZ, tris.v0z[i], tris.v1z[i], tris.v2z[i]);
        maxX = Math.max(maxX, tris.v0x[i], tris.v1x[i], tris.v2x[i]);
        maxY = Math.max(maxY, tris.v0y[i], tris.v1y[i], tris.v2y[i]);
        maxZ = Math.max(maxZ, tris.v0z[i], tris.v1z[i], tris.v2z[i]);
    }
    return {
        triangleCount: tris.count,
        aabb: {
            min: [minX, minY, minZ],
            max: [maxX, maxY, maxZ],
            size: [maxX - minX, maxY - minY, maxZ - minZ]
        }
    };
}

type GraphicsDeviceLike = ConstructorParameters<typeof Mesh>[0];

function createWireSphereMesh(device: GraphicsDeviceLike, segments = 24): Mesh {
    const rings = [
        { axis: 'xy' as const },
        { axis: 'xz' as const },
        { axis: 'yz' as const }
    ];
    const positions: number[] = [];
    const indices: number[] = [];
    let base = 0;
    for (const ring of rings) {
        for (let i = 0; i < segments; i++) {
            const a0 = (i / segments) * Math.PI * 2;
            const a1 = ((i + 1) / segments) * Math.PI * 2;
            const c0 = Math.cos(a0);
            const s0 = Math.sin(a0);
            const c1 = Math.cos(a1);
            const s1 = Math.sin(a1);
            if (ring.axis === 'xy') {
                positions.push(c0, s0, 0, c1, s1, 0);
            } else if (ring.axis === 'xz') {
                positions.push(c0, 0, s0, c1, 0, s1);
            } else {
                positions.push(0, c0, s0, 0, c1, s1);
            }
            indices.push(base, base + 1);
            base += 2;
        }
    }
    const mesh = new Mesh(device as never);
    mesh.setPositions(new Float32Array(positions));
    mesh.setIndices(new Uint16Array(indices));
    mesh.update(PRIMITIVE_LINES);
    return mesh;
}

/**
 * 安装控制台 API：
 * - toggleCollisionOverlay / getCollisionOverlay
 * - probeCollision：对照「看见的面」与球碰撞
 * - toggleCollisionProbe：画出相机碰撞球（半径 = Fly/Orbit 实际半径）
 */
export function installCollisionOverlayConsole(global: Global): void {
    let probeEntity: Entity | null = null;
    let probeUpdateHandler: (() => void) | null = null;

    const destroyProbe = () => {
        if (probeUpdateHandler) {
            global.app.off('update', probeUpdateHandler);
            probeUpdateHandler = null;
        }
        if (probeEntity) {
            probeEntity.destroy();
            probeEntity = null;
        }
    };

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
                ? `已开启（${detectKind(global)}）`
                : `已关闭（${detectKind(global)}，调用 toggleCollisionOverlay() 开启）`
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

        // shadow 先载、collision 后挂缓存时，可能已有 getCollision() 但从未发过 load ready → overlay 未创建
        const collision = mgr.getCollision();
        if (collision && !global.state.hasCollisionOverlay) {
            global.events.fire('cameraCollision:load', {
                state: 'ready',
                intent: { wantCollision: true }
            });
            global.app.renderNextFrame = true;
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
        const kind = detectKind(global);
        const result = snapshot(
            global,
            kind === 'voxel'
                ? '已开启 voxel overlay（PlayCanvas 风格射线步进线框）'
                : kind === 'mesh'
                    ? '已开启 mesh overlay（当前 collision 为 GLB，不是 sparse voxel 包）'
                    : '已开启 overlay'
        );
        console.info('[CollisionOverlay]', result.message, result);
        return result;
    };

    const probeCollision = async (): Promise<CollisionProbeResult> => {
        const mgr = getCameraCollisionManager(global);
        try {
            await mgr.ensureSceneMeshLoaded({ wantCollision: true });
        } catch {
            /* ignore */
        }

        const radius = readSceneAssetCollisionRuntimeState(global).cameraRadius;
        const collision = mgr.getCollision();
        const cam = global.camera;
        const pos = cam.getPosition();
        const notes: string[] = [];
        const kind = detectKind(global);

        if (!collision) {
            const empty: CollisionProbeResult = {
                kind: 'none',
                url: mgr.getCollisionUrl(),
                radius,
                camera: { x: pos.x, y: pos.y, z: pos.z },
                penetrating: false,
                forwardClearanceM: null,
                notes: ['collision 未加载']
            };
            console.warn('[CollisionProbe]', empty);
            return empty;
        }

        if (kind === 'mesh') {
            notes.push(
                '本场景 collision URL 是 .glb → MeshCollision + MeshDebugOverlay；不是 sparse voxel 可视化。'
            );
            notes.push(
                'overlay 与 querySphere 共用同一份三角数据；若能「穿过看见的面」，通常是零厚度面 + 离散推开穿模，不是两套 mesh。'
            );
            notes.push(
                `Fly/Orbit 球半径=${radius}m：球心应被挡在面外约 ${radius}m；若你贴着半透明面还能继续钻，才是穿模。`
            );
        } else if (kind === 'voxel') {
            notes.push('当前为 VoxelCollision + VoxelDebugOverlay。');
        }

        const penetrating = !!collision.querySphere(pos.x, pos.y, pos.z, radius, probePush);
        const pushOut = penetrating
            ? {
                x: probePush.x,
                y: probePush.y,
                z: probePush.z,
                length: Math.hypot(probePush.x, probePush.y, probePush.z)
            }
            : undefined;

        cam.getWorldTransform().getZ(tmpForward).mulScalar(-1);
        let forwardClearanceM: number | null = null;
        const step = Math.max(0.05, radius * 0.25);
        const maxDist = 20;
        for (let d = step; d <= maxDist; d += step) {
            tmpProbe.set(
                pos.x + tmpForward.x * d,
                pos.y + tmpForward.y * d,
                pos.z + tmpForward.z * d
            );
            if (collision.querySphere(tmpProbe.x, tmpProbe.y, tmpProbe.z, radius, probePush)) {
                forwardClearanceM = d;
                break;
            }
        }
        if (forwardClearanceM == null) {
            notes.push(`沿朝前 ${maxDist}m 内球心路径未碰到 collision（可能朝空处或有大洞）。`);
        } else {
            notes.push(
                `沿朝前约 ${forwardClearanceM.toFixed(2)}m 处球开始碰到面；球心前方 clearance≈${forwardClearanceM.toFixed(2)}m（表面约再近 ${radius}m）。`
            );
        }

        const result: CollisionProbeResult = {
            kind,
            url: mgr.getCollisionUrl(),
            radius,
            camera: { x: pos.x, y: pos.y, z: pos.z },
            penetrating,
            pushOut,
            forwardClearanceM,
            notes
        };

        if (collision instanceof MeshCollision) {
            result.mesh = meshAabb(collision);
            notes.push(
                `mesh 三角数=${result.mesh.triangleCount}；若 GLB 有节点变换但未烘焙进顶点，collision/overlay 会相对 sog 整体偏位（此时两者仍彼此一致）。`
            );

            // 对照 instantiateRenderEntity 后的世界包围盒：若差很大，说明节点变换未进 collision 顶点
            const sceneEnt = mgr.getSceneMeshEntity();
            if (sceneEnt) {
                const miList =
                    (sceneEnt.render?.meshInstances as Array<{ aabb?: { center: { x: number; y: number; z: number }; halfExtents: { x: number; y: number; z: number } } }> | undefined) ??
                    [];
                let sMinX = Infinity;
                let sMinY = Infinity;
                let sMinZ = Infinity;
                let sMaxX = -Infinity;
                let sMaxY = -Infinity;
                let sMaxZ = -Infinity;
                let any = false;
                const stack: Array<{ render?: { meshInstances?: typeof miList }; children?: unknown[] }> = [sceneEnt as never];
                while (stack.length) {
                    const e = stack.pop()!;
                    const instances = e.render?.meshInstances;
                    if (instances) {
                        for (const mi of instances) {
                            const a = mi.aabb;
                            if (!a) continue;
                            any = true;
                            sMinX = Math.min(sMinX, a.center.x - a.halfExtents.x);
                            sMinY = Math.min(sMinY, a.center.y - a.halfExtents.y);
                            sMinZ = Math.min(sMinZ, a.center.z - a.halfExtents.z);
                            sMaxX = Math.max(sMaxX, a.center.x + a.halfExtents.x);
                            sMaxY = Math.max(sMaxY, a.center.y + a.halfExtents.y);
                            sMaxZ = Math.max(sMaxZ, a.center.z + a.halfExtents.z);
                        }
                    }
                    const kids = e.children;
                    if (Array.isArray(kids)) {
                        for (const c of kids) stack.push(c as never);
                    }
                }
                if (any) {
                    const c = result.mesh.aabb;
                    const centerDelta = Math.hypot(
                        (c.min[0] + c.max[0]) * 0.5 - (sMinX + sMaxX) * 0.5,
                        (c.min[1] + c.max[1]) * 0.5 - (sMinY + sMaxY) * 0.5,
                        (c.min[2] + c.max[2]) * 0.5 - (sMinZ + sMaxZ) * 0.5
                    );
                    notes.push(
                        `sceneMeshEntity 世界 AABB center 与 collision AABB center 差 ${centerDelta.toFixed(3)}m` +
                            (centerDelta > 0.5
                                ? '（偏大：疑似 GLB 节点变换未烘焙进 MeshCollision）'
                                : '（基本对齐）')
                    );
                }
            }
        }

        console.info('[CollisionProbe]', result);
        return result;
    };

    const toggleCollisionProbe = (force?: boolean): boolean => {
        const want = typeof force === 'boolean' ? force : !probeEntity;
        if (!want) {
            destroyProbe();
            global.app.renderNextFrame = true;
            console.info('[CollisionProbe] 已关闭相机碰撞球可视化');
            return false;
        }

        destroyProbe();
        const radius = readSceneAssetCollisionRuntimeState(global).cameraRadius;
        const device = global.app.graphicsDevice;
        const mesh = createWireSphereMesh(device);
        const material = new StandardMaterial();
        material.useLighting = false;
        material.useSkybox = false;
        material.diffuse = new Color(0, 1, 0.4);
        material.emissive = new Color(0, 1, 0.4);
        material.opacity = 0.9;
        material.blendType = BLEND_NORMAL;
        material.depthTest = true;
        material.depthWrite = false;
        material.update();

        const mi = new MeshInstance(mesh, material);
        const entity = new Entity('CollisionCameraProbe');
        entity.addComponent('render', {
            meshInstances: [mi]
        });
        entity.setLocalScale(radius, radius, radius);
        global.app.root.addChild(entity);
        probeEntity = entity;

        probeUpdateHandler = () => {
            if (!probeEntity) return;
            const p = global.camera.getPosition();
            probeEntity.setPosition(p.x, p.y, p.z);
        };
        global.app.on('update', probeUpdateHandler);
        global.app.renderNextFrame = true;
        console.info(
            `[CollisionProbe] 已开启绿色线框球（半径 ${radius}m = Fly/Orbit 实际碰撞球）。对照半透明 collision 面：球应贴在面外侧，不应整球钻进面另一侧。`
        );
        return true;
    };

    const regenerateSceneMesh = async (): Promise<SceneMeshRegenerateConsoleResult> => {
        const mgr = getCameraCollisionManager(global);
        console.info('[SceneMesh] regenerateSceneMesh() 开始：强制 Universe generate 并替换当前 mesh…');
        const result = await mgr.regenerateSceneMesh();
        if (result.ok === false) {
            console.warn('[SceneMesh] regenerate failed:', result.message);
            return { ok: false, message: result.message };
        }
        // 若 overlay 开着，确保绑定到新 collision
        const collision = mgr.getCollision();
        if (collision && !global.state.hasCollisionOverlay) {
            global.events.fire('cameraCollision:load', {
                state: 'ready',
                intent: { wantCollision: true, wantShadow: true }
            });
            global.app.renderNextFrame = true;
        }
        const message = `已重新生成并加载 scene mesh：${result.url}`;
        console.info('[SceneMesh]', message);
        return { ok: true, url: result.url, message };
    };

    window.toggleCollisionOverlay = toggleCollisionOverlay;
    window.getCollisionOverlay = getCollisionOverlay;
    window.probeCollision = probeCollision;
    window.toggleCollisionProbe = toggleCollisionProbe;
    window.regenerateSceneMesh = regenerateSceneMesh;

    const sse = (window as Window & { sse?: Record<string, unknown> }).sse;
    if (sse && typeof sse === 'object') {
        sse.toggleCollisionOverlay = toggleCollisionOverlay;
        sse.getCollisionOverlay = getCollisionOverlay;
        sse.probeCollision = probeCollision;
        sse.toggleCollisionProbe = toggleCollisionProbe;
        sse.regenerateSceneMesh = regenerateSceneMesh;
    }

    console.info(
        '[CollisionOverlay] 控制台：toggleCollisionOverlay() / getCollisionOverlay() / probeCollision() / toggleCollisionProbe() / regenerateSceneMesh()'
    );
}
