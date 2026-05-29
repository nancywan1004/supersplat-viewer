import { BoundingBox, Entity, Vec3 } from 'playcanvas';

import type { Collision, PushOut, RayHit } from '../../collision';
import { PENETRATION_EPSILON, resolveIterative } from '../../collision/collision';
import type { ExperienceSettings } from '../../schemas/v2';
import type {
    SceneAssetCollisionAxisScale,
    SceneAssetCollisionScale,
    SceneAssetCollisionSettings,
    SceneAssetCollisionSettingsPatch
} from '../../schemas/v2-custom';
import { getCameraCollisionManager } from '../../collision/camera-collision-manager';
import type { AssetLibraryType, Global, SceneAssetCollisionRuntimeState, ScenePlacedItem } from '../../types';

export type {
    SceneAssetCollisionAxisScale,
    SceneAssetCollisionScale,
    SceneAssetCollisionSettings,
    SceneAssetCollisionSettingsPatch
};
export type { SceneAssetCollisionRuntimeState } from '../../types';

/** 设置面板 / state 写入时可接受的缩放参数（含历史标量） */
export type SceneAssetCollisionScaleInput = NonNullable<SceneAssetCollisionSettingsPatch['scale']>;

/** 相机与放置资产 AABB 碰撞时使用的球体半径（米） */
export const SCENE_ASSET_CAMERA_COLLISION_RADIUS = 0.3;

/** 默认 AABB 相对实体包围盒的各向缩放（1 = 与渲染 AABB 一致） */
export const DEFAULT_SCENE_ASSET_COLLISION_AXIS_SCALE: SceneAssetCollisionAxisScale = {
    x: 1,
    y: 1,
    z: 1
};

export const DEFAULT_SCENE_ASSET_COLLISION_SCALE = {
    gaussian: { x: 0.85, y: 0.85, z: 0.85 },
    mesh: { x: 0.57, y: 0.85, z: 0.85 },
    autoFit: false
} as const;

const AXIS_SCALE_MIN = 0.5;
const AXIS_SCALE_MAX = 1.5;
const AUTO_FIT_AXIS_MIN = 0.55;
const AUTO_FIT_AXIS_MAX = 1;

function clampAxisScale(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(AXIS_SCALE_MAX, Math.max(AXIS_SCALE_MIN, value));
}

function clampAutoFitFactor(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(AUTO_FIT_AXIS_MAX, Math.max(AUTO_FIT_AXIS_MIN, value));
}

/** 将历史标量缩放迁移为各向缩放 */
export function normalizeAxisScale(
    value: number | SceneAssetCollisionAxisScale | undefined,
    fallback: SceneAssetCollisionAxisScale
): SceneAssetCollisionAxisScale {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const s = clampAxisScale(value);
        return { x: s, y: s, z: s };
    }
    if (value && typeof value === 'object') {
        return {
            x: clampAxisScale(value.x ?? fallback.x),
            y: clampAxisScale(value.y ?? fallback.y),
            z: clampAxisScale(value.z ?? fallback.z)
        };
    }
    return { ...fallback };
}

export function normalizeSceneAssetCollisionScale(
    scale: SceneAssetCollisionScaleInput | SceneAssetCollisionScale | undefined
): SceneAssetCollisionScale {
    const def = DEFAULT_SCENE_ASSET_COLLISION_SCALE;
    const raw = scale;
    return {
        gaussian: normalizeAxisScale(raw?.gaussian, def.gaussian),
        mesh: normalizeAxisScale(raw?.mesh, def.mesh),
        autoFit: raw?.autoFit ?? def.autoFit
    };
}

export function createDefaultSceneAssetCollisionRuntimeState(): SceneAssetCollisionRuntimeState {
    return {
        enabled: false,
        scale: normalizeSceneAssetCollisionScale(DEFAULT_SCENE_ASSET_COLLISION_SCALE),
        debugVisual: false
    };
}

export function normalizeSceneAssetCollisionRuntimeState(
    value: Partial<SceneAssetCollisionRuntimeState> | undefined
): SceneAssetCollisionRuntimeState {
    const def = createDefaultSceneAssetCollisionRuntimeState();
    if (!value) return def;
    return {
        enabled: typeof value.enabled === 'boolean' ? value.enabled : def.enabled,
        scale: normalizeSceneAssetCollisionScale(value.scale ?? def.scale),
        debugVisual: typeof value.debugVisual === 'boolean' ? value.debugVisual : def.debugVisual
    };
}

/** 从 global.state 读取并归一化（真源在 state；碰撞 Runtime 类为派生缓存） */
export function readSceneAssetCollisionRuntimeState(global: Global): SceneAssetCollisionRuntimeState {
    return normalizeSceneAssetCollisionRuntimeState(global.state.sceneAssetCollisionRuntimeState);
}

/** 整体替换 state 上的运行态（observe 会触发 sceneAssetCollisionRuntimeState:changed） */
export function writeSceneAssetCollisionRuntimeState(
    global: Global,
    next: SceneAssetCollisionRuntimeState
): SceneAssetCollisionRuntimeState {
    const normalized = normalizeSceneAssetCollisionRuntimeState(next);
    global.state.sceneAssetCollisionRuntimeState = normalized;
    return normalized;
}

export function patchSceneAssetCollisionRuntimeState(
    global: Global,
    patch: Partial<SceneAssetCollisionRuntimeState> & { scale?: SceneAssetCollisionScaleInput }
): SceneAssetCollisionRuntimeState {
    const current = readSceneAssetCollisionRuntimeState(global);
    return writeSceneAssetCollisionRuntimeState(global, {
        ...current,
        ...patch,
        scale: patch.scale !== undefined
            ? normalizeSceneAssetCollisionScale({ ...current.scale, ...patch.scale })
            : current.scale
    });
}

export function syncSceneAssetCollisionRuntime(global: Global): void {
    const rs = readSceneAssetCollisionRuntimeState(global);
    writeSceneAssetCollisionRuntimeState(global, rs);
    const runtime = getSceneAssetCollisionRuntime(global);
    runtime.setEnabled(rs.enabled);
    runtime.setScale(rs.scale);
}

export function sceneAssetCollisionSettingsFromRuntimeState(
    rs: SceneAssetCollisionRuntimeState
): SceneAssetCollisionSettings {
    return {
        enabled: rs.enabled,
        scale: normalizeSceneAssetCollisionScale(rs.scale)
    };
}

/** 从 settings 恢复碰撞配置到 state（保留当前 debugVisual，不写入 settings） */
export function applySceneAssetCollisionFromSettings(global: Global): void {
    const persisted = (global.settings as ExperienceSettings).sceneAssetCollision;
    if (!persisted) {
        return;
    }
    const current = readSceneAssetCollisionRuntimeState(global);
    writeSceneAssetCollisionRuntimeState(global, {
        enabled: typeof persisted.enabled === 'boolean' ? persisted.enabled : current.enabled,
        scale: normalizeSceneAssetCollisionScale(persisted.scale ?? current.scale),
        debugVisual: current.debugVisual
    });
}

/** 将当前 state 碰撞配置写入 global.settings，供存盘序列化 */
export function persistSceneAssetCollisionToSettings(global: Global): void {
    const settings = global.settings as ExperienceSettings;
    settings.sceneAssetCollision = sceneAssetCollisionSettingsFromRuntimeState(
        readSceneAssetCollisionRuntimeState(global)
    );
}

const COLLIDABLE_ASSET_TYPES: ReadonlySet<AssetLibraryType> = new Set(['mesh', 'gaussian']);

const CAPSULE_SAMPLE_COUNT = 5;

const tmpCenter = new Vec3();
const tmpHalf = new Vec3();
const scratchPush: PushOut = { x: 0, y: 0, z: 0 };

function isCollidablePlacedItem(entry: ScenePlacedItem): boolean {
    if (!entry?.entity || entry.visible === false || !entry.entity.enabled) {
        return false;
    }
    const type = entry.assetType;
    return type !== undefined && COLLIDABLE_ASSET_TYPES.has(type);
}

/** 场景中所有可见、可碰撞的 mesh / gaussian 放置项 */
export function listSceneAssetCollidableItems(global: Global): ScenePlacedItem[] {
    const list = global.state.scenePlacedEntities ?? [];
    return list.filter(isCollidablePlacedItem);
}

/**
 * 合并 entity 层级 mesh render 与高斯组件，得到 world-space AABB。
 */
export function computeEntityWorldBoundingBox(entity: Entity): BoundingBox | null {
    const meshInstances: Array<{ aabb?: BoundingBox }> = [];
    const collectMeshInstances = (node: Entity) => {
        const renderComp = (node as Entity & { render?: { meshInstances?: Array<{ aabb?: BoundingBox }> } }).render;
        const instances = renderComp?.meshInstances;
        if (instances && instances.length > 0) {
            for (const mi of instances) meshInstances.push(mi);
        }
        const children = node.children;
        if (children && children.length > 0) {
            for (const child of children) collectMeshInstances(child as Entity);
        }
    };
    collectMeshInstances(entity);

    if (meshInstances.length > 0) {
        const min = new Vec3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
        const max = new Vec3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
        let hasValidAabb = false;
        for (const mi of meshInstances) {
            const aabb = mi.aabb;
            if (!aabb) continue;
            hasValidAabb = true;
            min.min(aabb.getMin());
            max.max(aabb.getMax());
        }
        if (hasValidAabb) {
            const center = min.clone().add(max).mulScalar(0.5);
            const half = max.clone().sub(min).mulScalar(0.5);
            return new BoundingBox(center, half);
        }
    }

    const gsplat = (entity as Entity & { gsplat?: { customAabb?: BoundingBox | null; aabb?: BoundingBox } }).gsplat;
    const gsAabb = gsplat?.customAabb ?? gsplat?.aabb;
    if (gsAabb) {
        const worldAabb = new BoundingBox();
        worldAabb.setFromTransformedAabb(gsAabb, entity.getWorldTransform());
        return worldAabb;
    }
    return null;
}

function userAxisScaleForAssetType(
    assetType: AssetLibraryType | undefined,
    scale: SceneAssetCollisionScale
): SceneAssetCollisionAxisScale {
    if (assetType === 'gaussian') return scale.gaussian;
    if (assetType === 'mesh') return scale.mesh;
    return DEFAULT_SCENE_ASSET_COLLISION_AXIS_SCALE;
}

function applyAxisScaleToBoundingBox(box: BoundingBox, axisScale: SceneAssetCollisionAxisScale): BoundingBox {
    tmpCenter.copy(box.center);
    tmpHalf.set(
        box.halfExtents.x * axisScale.x,
        box.halfExtents.y * axisScale.y,
        box.halfExtents.z * axisScale.z
    );
    return new BoundingBox(tmpCenter.clone(), tmpHalf.clone());
}

/**
 * 高斯：局部 gsplat AABB × 实体缩放，与世界 AABB 对比后收紧明显偏大的轴（旋转场景有效）。
 * Mesh：各轴半轴与几何平均半轴对比，收紧明显偏长的轴（世界渲染 AABB 无单独局部盒时的启发式）。
 */
function computeAutoAxisScaleForEntity(
    entity: Entity,
    assetType: AssetLibraryType | undefined,
    raw: BoundingBox
): SceneAssetCollisionAxisScale {
    const wh = raw.halfExtents;
    let fitX = 1;
    let fitY = 1;
    let fitZ = 1;

    if (assetType === 'gaussian') {
        const gsplat = (entity as Entity & { gsplat?: { customAabb?: BoundingBox | null; aabb?: BoundingBox } }).gsplat;
        const local = gsplat?.customAabb ?? gsplat?.aabb;
        if (local) {
            const localScale = entity.getLocalScale();
            const lx = Math.abs(localScale.x);
            const ly = Math.abs(localScale.y);
            const lz = Math.abs(localScale.z);
            const lh = local.halfExtents;
            const predX = Math.max(lh.x * lx, 1e-6);
            const predY = Math.max(lh.y * ly, 1e-6);
            const predZ = Math.max(lh.z * lz, 1e-6);
            fitX = clampAutoFitFactor(predX / Math.max(wh.x, 1e-6));
            fitY = clampAutoFitFactor(predY / Math.max(wh.y, 1e-6));
            fitZ = clampAutoFitFactor(predZ / Math.max(wh.z, 1e-6));
        }
    } else if (assetType === 'mesh') {
        const hx = Math.max(wh.x, 1e-6);
        const hy = Math.max(wh.y, 1e-6);
        const hz = Math.max(wh.z, 1e-6);
        const geomMean = Math.cbrt(hx * hy * hz);
        fitX = clampAutoFitFactor(geomMean / hx);
        fitY = clampAutoFitFactor(geomMean / hy);
        fitZ = clampAutoFitFactor(geomMean / hz);
    }

    return {
        x: clampAxisScale(fitX),
        y: clampAxisScale(fitY),
        z: clampAxisScale(fitZ)
    };
}

function resolveCollisionAxisScale(
    entity: Entity,
    assetType: AssetLibraryType | undefined,
    raw: BoundingBox,
    scale: SceneAssetCollisionScale
): SceneAssetCollisionAxisScale {
    if (scale.autoFit) {
        return computeAutoAxisScaleForEntity(entity, assetType, raw);
    }
    return userAxisScaleForAssetType(assetType, scale);
}

export function buildScaledSceneAssetBoundingBox(
    entity: Entity,
    assetType: AssetLibraryType | undefined,
    scale: SceneAssetCollisionScale
): BoundingBox | null {
    const raw = computeEntityWorldBoundingBox(entity);
    if (!raw) return null;
    const normalized = normalizeSceneAssetCollisionScale(scale);
    const axisScale = resolveCollisionAxisScale(entity, assetType, raw, normalized);
    return applyAxisScaleToBoundingBox(raw, axisScale);
}

function sphereAabbPenetration(
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    minX: number,
    minY: number,
    minZ: number,
    maxX: number,
    maxY: number,
    maxZ: number,
    out: PushOut
): boolean {
    const closestX = Math.max(minX, Math.min(cx, maxX));
    const closestY = Math.max(minY, Math.min(cy, maxY));
    const closestZ = Math.max(minZ, Math.min(cz, maxZ));

    const dx = cx - closestX;
    const dy = cy - closestY;
    const dz = cz - closestZ;
    const distSq = dx * dx + dy * dy + dz * dz;
    const r = Math.max(radius, 0);

    if (distSq >= r * r - PENETRATION_EPSILON * PENETRATION_EPSILON) {
        return false;
    }

    if (distSq > 1e-12) {
        const dist = Math.sqrt(distSq);
        const pushLen = r - dist;
        const inv = pushLen / dist;
        out.x = dx * inv;
        out.y = dy * inv;
        out.z = dz * inv;
        return true;
    }

    const penPosX = maxX - cx;
    const penNegX = cx - minX;
    const penPosY = maxY - cy;
    const penNegY = cy - minY;
    const penPosZ = maxZ - cz;
    const penNegZ = cz - minZ;

    let best = penPosX;
    out.x = best + r;
    out.y = 0;
    out.z = 0;

    if (penNegX < best) {
        best = penNegX;
        out.x = -(best + r);
        out.y = 0;
        out.z = 0;
    }
    if (penPosY < best) {
        best = penPosY;
        out.x = 0;
        out.y = best + r;
        out.z = 0;
    }
    if (penNegY < best) {
        best = penNegY;
        out.x = 0;
        out.y = -(best + r);
        out.z = 0;
    }
    if (penPosZ < best) {
        best = penPosZ;
        out.x = 0;
        out.y = 0;
        out.z = best + r;
    }
    if (penNegZ < best) {
        out.x = 0;
        out.y = 0;
        out.z = -(penNegZ + r);
    }

    return true;
}

/**
 * 单个 world-space AABB 的碰撞体；实现 `Collision` 供 fly/walk 推开，不参与 ray 地面探测。
 */
export class SceneAssetAabbCollision implements Collision {
    private readonly minX: number;

    private readonly minY: number;

    private readonly minZ: number;

    private readonly maxX: number;

    private readonly maxY: number;

    private readonly maxZ: number;

    private readonly _constraintNormals: { x: number; y: number; z: number }[] = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
    ];

    private readonly _push: PushOut = { x: 0, y: 0, z: 0 };

    private readonly _normalResult = { nx: 0, ny: 1, nz: 0 };

    constructor(box: BoundingBox) {
        const min = box.getMin();
        const max = box.getMax();
        this.minX = min.x;
        this.minY = min.y;
        this.minZ = min.z;
        this.maxX = max.x;
        this.maxY = max.y;
        this.maxZ = max.z;
    }

    queryRay(
        _ox: number,
        _oy: number,
        _oz: number,
        _dx: number,
        _dy: number,
        _dz: number,
        _maxDist: number
    ): RayHit | null {
        return null;
    }

    querySphere(
        cx: number,
        cy: number,
        cz: number,
        radius: number,
        out: PushOut
    ): boolean {
        return resolveIterative(
            cx,
            cy,
            cz,
            (rx, ry, rz, push) => this._deepestSpherePenetration(rx, ry, rz, radius, push),
            this._constraintNormals,
            this._push,
            out
        );
    }

    queryCapsule(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: PushOut
    ): boolean {
        return resolveIterative(
            cx,
            cy,
            cz,
            (rx, ry, rz, push) => this._deepestCapsulePenetration(rx, ry, rz, halfHeight, radius, push),
            this._constraintNormals,
            this._push,
            out
        );
    }

    querySurfaceNormal(
        x: number,
        y: number,
        z: number,
        _rdx: number,
        _rdy: number,
        _rdz: number
    ): { nx: number; ny: number; nz: number } {
        const closestX = Math.max(this.minX, Math.min(x, this.maxX));
        const closestY = Math.max(this.minY, Math.min(y, this.maxY));
        const closestZ = Math.max(this.minZ, Math.min(z, this.maxZ));
        const nx = x - closestX;
        const ny = y - closestY;
        const nz = z - closestZ;
        const lenSq = nx * nx + ny * ny + nz * nz;
        if (lenSq < 1e-12) {
            this._normalResult.nx = 0;
            this._normalResult.ny = 1;
            this._normalResult.nz = 0;
            return this._normalResult;
        }
        const inv = 1 / Math.sqrt(lenSq);
        this._normalResult.nx = nx * inv;
        this._normalResult.ny = ny * inv;
        this._normalResult.nz = nz * inv;
        return this._normalResult;
    }

    private _deepestSpherePenetration(
        cx: number,
        cy: number,
        cz: number,
        radius: number,
        out: PushOut
    ): boolean {
        return sphereAabbPenetration(
            cx,
            cy,
            cz,
            radius,
            this.minX,
            this.minY,
            this.minZ,
            this.maxX,
            this.maxY,
            this.maxZ,
            out
        );
    }

    private _deepestCapsulePenetration(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: PushOut
    ): boolean {
        const half = Math.max(0, halfHeight);
        let found = false;
        let bestLenSq = 0;
        out.x = 0;
        out.y = 0;
        out.z = 0;

        for (let i = 0; i < CAPSULE_SAMPLE_COUNT; i++) {
            const t = (i / (CAPSULE_SAMPLE_COUNT - 1)) * 2 - 1;
            const sy = cy + t * half;
            if (
                !sphereAabbPenetration(
                    cx,
                    sy,
                    cz,
                    radius,
                    this.minX,
                    this.minY,
                    this.minZ,
                    this.maxX,
                    this.maxY,
                    this.maxZ,
                    scratchPush
                )
            ) {
                continue;
            }
            const lenSq = scratchPush.x * scratchPush.x + scratchPush.y * scratchPush.y + scratchPush.z * scratchPush.z;
            if (!found || lenSq > bestLenSq) {
                found = true;
                bestLenSq = lenSq;
                out.x = scratchPush.x;
                out.y = scratchPush.y;
                out.z = scratchPush.z;
            }
        }

        return found;
    }
}

const multiScratchPush: PushOut = { x: 0, y: 0, z: 0 };

/**
 * 多个放置资产 AABB 的复合碰撞体；相机推开时对每个盒子取最深穿透并迭代消解。
 */
export class SceneAssetMultiAabbCollision implements Collision {
    private readonly parts: SceneAssetAabbCollision[];

    private readonly _constraintNormals: { x: number; y: number; z: number }[] = [
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 },
        { x: 0, y: 0, z: 0 }
    ];

    private readonly _push: PushOut = { x: 0, y: 0, z: 0 };

    private readonly _normalResult = { nx: 0, ny: 1, nz: 0 };

    constructor(boxes: BoundingBox[]) {
        this.parts = boxes.map((box) => new SceneAssetAabbCollision(box));
    }

    queryRay(
        _ox: number,
        _oy: number,
        _oz: number,
        _dx: number,
        _dy: number,
        _dz: number,
        _maxDist: number
    ): RayHit | null {
        return null;
    }

    querySphere(
        cx: number,
        cy: number,
        cz: number,
        radius: number,
        out: PushOut
    ): boolean {
        return resolveIterative(
            cx,
            cy,
            cz,
            (rx, ry, rz, push) => this._deepestSpherePenetration(rx, ry, rz, radius, push),
            this._constraintNormals,
            this._push,
            out
        );
    }

    queryCapsule(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: PushOut
    ): boolean {
        return resolveIterative(
            cx,
            cy,
            cz,
            (rx, ry, rz, push) => this._deepestCapsulePenetration(rx, ry, rz, halfHeight, radius, push),
            this._constraintNormals,
            this._push,
            out
        );
    }

    querySurfaceNormal(
        x: number,
        y: number,
        z: number,
        rdx: number,
        rdy: number,
        rdz: number
    ): { nx: number; ny: number; nz: number } {
        for (const part of this.parts) {
            const n = part.querySurfaceNormal(x, y, z, rdx, rdy, rdz);
            if (n.nx !== 0 || n.ny !== 1 || n.nz !== 0) {
                return n;
            }
        }
        return this._normalResult;
    }

    private _deepestSpherePenetration(
        cx: number,
        cy: number,
        cz: number,
        radius: number,
        out: PushOut
    ): boolean {
        let found = false;
        let bestLenSq = 0;
        out.x = 0;
        out.y = 0;
        out.z = 0;

        for (const part of this.parts) {
            if (!part.querySphere(cx, cy, cz, radius, multiScratchPush)) {
                continue;
            }
            const lenSq =
                multiScratchPush.x * multiScratchPush.x
                + multiScratchPush.y * multiScratchPush.y
                + multiScratchPush.z * multiScratchPush.z;
            if (!found || lenSq > bestLenSq) {
                found = true;
                bestLenSq = lenSq;
                out.x = multiScratchPush.x;
                out.y = multiScratchPush.y;
                out.z = multiScratchPush.z;
            }
        }

        return found;
    }

    private _deepestCapsulePenetration(
        cx: number,
        cy: number,
        cz: number,
        halfHeight: number,
        radius: number,
        out: PushOut
    ): boolean {
        let found = false;
        let bestLenSq = 0;
        out.x = 0;
        out.y = 0;
        out.z = 0;

        for (const part of this.parts) {
            if (!part.queryCapsule(cx, cy, cz, halfHeight, radius, multiScratchPush)) {
                continue;
            }
            const lenSq =
                multiScratchPush.x * multiScratchPush.x
                + multiScratchPush.y * multiScratchPush.y
                + multiScratchPush.z * multiScratchPush.z;
            if (!found || lenSq > bestLenSq) {
                found = true;
                bestLenSq = lenSq;
                out.x = multiScratchPush.x;
                out.y = multiScratchPush.y;
                out.z = multiScratchPush.z;
            }
        }

        return found;
    }
}

export function isSceneAssetCollisionRuntimeActive(global: Global, enabled: boolean): boolean {
    if (!enabled) return false;
    return getCameraCollisionManager(global).isRuntimeActive();
}

/**
 * 管理场景中所有可碰撞放置资产的 AABB 碰撞体构建与缓存失效。
 */
export class SceneAssetCollisionRuntime {
    private collision: Collision | null = null;

    private debugBoxes: BoundingBox[] = [];

    private dirty = true;

    private enabled = false;

    private scale: SceneAssetCollisionScale = normalizeSceneAssetCollisionScale(DEFAULT_SCENE_ASSET_COLLISION_SCALE);

    constructor(private readonly global: Global) {}

    setEnabled(enabled: boolean): void {
        if (this.enabled === enabled) return;
        this.enabled = enabled;
        this.markDirty();
    }

    getEnabled(): boolean {
        return this.enabled;
    }

    setScale(scale: SceneAssetCollisionScaleInput): void {
        const prev = this.scale;
        const next = normalizeSceneAssetCollisionScale({
            gaussian: scale.gaussian !== undefined
                ? normalizeAxisScale(scale.gaussian as number | SceneAssetCollisionAxisScale, prev.gaussian)
                : prev.gaussian,
            mesh: scale.mesh !== undefined
                ? normalizeAxisScale(scale.mesh as number | SceneAssetCollisionAxisScale, prev.mesh)
                : prev.mesh,
            autoFit: scale.autoFit !== undefined ? !!scale.autoFit : prev.autoFit
        });
        const changed =
            next.gaussian.x !== prev.gaussian.x
            || next.gaussian.y !== prev.gaussian.y
            || next.gaussian.z !== prev.gaussian.z
            || next.mesh.x !== prev.mesh.x
            || next.mesh.y !== prev.mesh.y
            || next.mesh.z !== prev.mesh.z
            || next.autoFit !== prev.autoFit;
        if (changed) {
            this.scale = next;
            this.markDirty();
        }
    }

    getScale(): SceneAssetCollisionScale {
        return normalizeSceneAssetCollisionScale(this.scale);
    }

    isActive(): boolean {
        return isSceneAssetCollisionRuntimeActive(this.global, this.enabled);
    }

    markDirty(): void {
        this.dirty = true;
    }

    /** 当前帧用于相机推开的碰撞体；未激活或无有效目标时返回 null。 */
    getCollision(): Collision | null {
        if (!this.isActive()) {
            return null;
        }
        if (this.dirty) {
            this.rebuild();
        }
        return this.collision;
    }

    /**
     * 调试用：与碰撞推开相同的最终 world AABB（autoFit 与手动 XYZ 二选一）。
     */
    getDebugBoundingBoxes(): BoundingBox[] {
        if (this.dirty) {
            this.rebuild();
        }
        return this.debugBoxes;
    }

    private rebuild(): void {
        this.dirty = false;
        this.collision = null;
        this.debugBoxes = [];

        const boxes: BoundingBox[] = [];
        for (const target of listSceneAssetCollidableItems(this.global)) {
            if (!target.entity) continue;
            const box = buildScaledSceneAssetBoundingBox(target.entity, target.assetType, this.scale);
            if (box) {
                boxes.push(box);
            }
        }

        if (boxes.length === 0) {
            return;
        }

        this.debugBoxes = boxes;
        if (!this.isActive()) {
            return;
        }

        if (boxes.length === 1) {
            this.collision = new SceneAssetAabbCollision(boxes[0]);
        } else {
            this.collision = new SceneAssetMultiAabbCollision(boxes);
        }
    }
}

const RUNTIME_KEY = '__sceneAssetCollisionRuntime';

export function getSceneAssetCollisionRuntime(global: Global): SceneAssetCollisionRuntime {
    const g = global as Global & { [RUNTIME_KEY]?: SceneAssetCollisionRuntime };
    if (!g[RUNTIME_KEY]) {
        g[RUNTIME_KEY] = new SceneAssetCollisionRuntime(global);
    }
    return g[RUNTIME_KEY];
}

/**
 * 在已有 scene collision 推开之后叠加 sceneAsset AABB 推开（仅 sphere）。
 */
export function applySceneAssetSpherePushOut(
    collision: Collision | null,
    cx: number,
    cy: number,
    cz: number,
    radius: number,
    out: PushOut
): boolean {
    if (!collision) return false;
    return collision.querySphere(cx, cy, cz, radius, out);
}

/**
 * 注册放置/选中/模式切换等事件，在包围盒变化时标记缓存失效。
 */
export function initSceneAssetCollision(global: Global): () => void {
    const runtime = getSceneAssetCollisionRuntime(global);
    const { events, state } = global;

    syncSceneAssetCollisionRuntime(global);

    const markDirty = () => runtime.markDirty();

    events.on('sceneAssets:added', markDirty);
    events.on('sceneAssets:removed', markDirty);
    events.on('sceneAssets:cleared', markDirty);
    events.on('sceneAsset:selected', markDirty);
    events.on('editMode:changed', markDirty);
    events.on('previewMode:changed', markDirty);
    events.on('sceneAsset:collisionDirty', markDirty);

    return () => {
        events.off('sceneAssets:added', markDirty);
        events.off('sceneAssets:removed', markDirty);
        events.off('sceneAssets:cleared', markDirty);
        events.off('sceneAsset:selected', markDirty);
        events.off('editMode:changed', markDirty);
        events.off('previewMode:changed', markDirty);
        events.off('sceneAsset:collisionDirty', markDirty);
        const g = global as Global & { [RUNTIME_KEY]?: SceneAssetCollisionRuntime };
        delete g[RUNTIME_KEY];
    };
}
