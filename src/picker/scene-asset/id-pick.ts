/**
 * 编辑态已放置资产 GPU ID 拾取（picker 路径 2，id-pick）。
 * 高斯走 SceneAssetPick 层，mesh 走 World 层；失败时 splat depth + AABB 兜底。
 */
import type { AppBase, CameraComponent, Entity, GSplatComponent, MeshInstance } from 'playcanvas';
import { Vec3 } from 'playcanvas';

import { pickWorldFromClientXY } from '../splat/depth-picker';
import type { Global, ScenePlacedItem } from '../../types';
import { getSceneAssetPickLayer } from './pick-layer';

const ID_PICK_AREA_PX = 5;
const GAUSSIAN_WORLD_PICK_PADDING = 1.15;

type IdPicker = {
    resize: (w: number, h: number) => void;
    prepare: (camera: CameraComponent, scene: AppBase['scene'], layers: unknown[]) => void;
    getSelectionAsync: (x: number, y: number, w?: number, h?: number) => Promise<Array<MeshInstance | GSplatComponent>>;
};

function entityFromPickResult(picked: MeshInstance | GSplatComponent): Entity | null {
    // GSplatComponent（Component）→ entity；MeshInstance → node（多为 Entity）
    if ('entity' in picked) {
        return picked.entity;
    }
    if ('node' in picked) {
        return picked.node as Entity;
    }
    return null;
}

function findEntryForEntity(list: ScenePlacedItem[], entity: Entity): ScenePlacedItem | null {
    return list.find((item) => {
        if (!item.entity.enabled) return false;
        if (item.entity === entity) return true;
        const anyEntity = entity as Entity & { isDescendantOf?: (e: Entity) => boolean };
        return typeof anyEntity.isDescendantOf === 'function' && anyEntity.isDescendantOf(item.entity);
    }) ?? null;
}

function findEntryFromIdSelection(
    selection: Array<MeshInstance | GSplatComponent>,
    list: ScenePlacedItem[]
): ScenePlacedItem | null {
    for (const picked of selection) {
        const entity = entityFromPickResult(picked);
        if (!entity) continue;
        const entry = findEntryForEntity(list, entity);
        if (entry) return entry;
    }
    return null;
}

function withSceneAssetPickLayerOnCamera(cameraEntity: Entity, pickLayerId: number, run: () => void): void {
    const cam = cameraEntity.camera;
    const prevLayers = cam.layers;
    if (prevLayers.includes(pickLayerId)) {
        run();
        return;
    }
    cam.layers = [...prevLayers, pickLayerId];
    try {
        run();
    } finally {
        cam.layers = prevLayers;
    }
}

/** 已放置 unified 高斯：World 可见 + SceneAssetPick 专用于 ID 拾取（避开主场景合成 pick）。 */
export function configurePlacedGaussianPickLayer(app: AppBase, entity: Entity): void {
    const gsplat = entity.gsplat;
    if (!gsplat?.unified) return;

    const world = app.scene.layers.getLayerByName('World');
    const pick = getSceneAssetPickLayer(app);
    if (!world || !pick) return;

    const next = new Set(gsplat.layers);
    next.add(world.id);
    next.add(pick.id);
    gsplat.layers = [...next];
}

function gaussianPickBounds(entity: Entity): { center: Vec3; radius: number } | null {
    const gs = entity.gsplat;
    if (!gs) return null;
    const aabb = gs.customAabb ?? (gs as unknown as { aabb?: { center: Vec3; halfExtents: Vec3 } }).aabb;
    if (!aabb?.center) return null;

    const center = aabb.center.clone();
    entity.getWorldTransform().transformPoint(center, center);
    const scale = entity.getWorldTransform().getScale();
    const scaleMax = Math.max(scale.x, scale.y, scale.z, 1e-3);
    let radius = 0.75 * scaleMax;
    if (aabb.halfExtents) {
        const he = aabb.halfExtents;
        radius = Math.max(radius, Math.max(he.x, he.y, he.z) * scaleMax);
    }
    return { center, radius };
}

function findPlacedGaussianFromWorldPoint(list: ScenePlacedItem[], worldPos: Vec3): ScenePlacedItem | null {
    let best: { entry: ScenePlacedItem; score: number } | null = null;

    for (const entry of list) {
        if (entry.assetType !== 'gaussian' || !entry.entity.enabled) continue;
        const bounds = gaussianPickBounds(entry.entity);
        if (!bounds) continue;

        const dist = bounds.center.distance(worldPos);
        if (dist > bounds.radius * GAUSSIAN_WORLD_PICK_PADDING) continue;

        const score = dist / bounds.radius;
        if (!best || score < best.score) {
            best = { entry, score };
        }
    }

    return best?.entry ?? null;
}

async function pickGaussianEntryOnPickLayer(
    global: Global,
    app: AppBase,
    cameraEntity: Entity,
    picker: IdPicker,
    pickX: number,
    pickY: number,
    clientX: number,
    clientY: number,
    list: ScenePlacedItem[]
): Promise<ScenePlacedItem | null> {
    const gaussians = list.filter((e) => e.assetType === 'gaussian');
    if (gaussians.length === 0) return null;

    for (const entry of gaussians) {
        configurePlacedGaussianPickLayer(app, entry.entity);
    }

    const pickLayer = getSceneAssetPickLayer(app);
    const gsplatScene = (app.scene as { gsplat?: { enableIds: boolean } }).gsplat;
    const prevEnableIds = gsplatScene?.enableIds;
    if (gsplatScene) {
        gsplatScene.enableIds = true;
    }

    try {
        let selection: Array<MeshInstance | GSplatComponent> = [];
        withSceneAssetPickLayerOnCamera(cameraEntity, pickLayer.id, () => {
            picker.prepare(cameraEntity.camera, app.scene, [pickLayer]);
        });
        const half = Math.floor(ID_PICK_AREA_PX / 2);
        selection = await picker.getSelectionAsync(
            Math.max(0, pickX - half),
            Math.max(0, pickY - half),
            ID_PICK_AREA_PX,
            ID_PICK_AREA_PX
        );
        const fromId = findEntryFromIdSelection(selection, gaussians);
        if (fromId) return fromId;
    } finally {
        if (gsplatScene && prevEnableIds !== undefined) {
            gsplatScene.enableIds = prevEnableIds;
        }
    }

    const worldPos = await pickWorldFromClientXY(global, clientX, clientY);
    if (!worldPos) return null;
    return findPlacedGaussianFromWorldPoint(gaussians, worldPos);
}

async function pickMeshEntryOnWorldLayer(
    app: AppBase,
    cameraEntity: Entity,
    picker: IdPicker,
    pickX: number,
    pickY: number,
    list: ScenePlacedItem[]
): Promise<ScenePlacedItem | null> {
    const world = app.scene.layers.getLayerByName('World');
    if (!world) return null;

    picker.prepare(cameraEntity.camera, app.scene, [world]);
    const half = Math.floor(ID_PICK_AREA_PX / 2);
    const selection = await picker.getSelectionAsync(
        Math.max(0, pickX - half),
        Math.max(0, pickY - half),
        ID_PICK_AREA_PX,
        ID_PICK_AREA_PX
    );
    return findEntryFromIdSelection(selection, list);
}

/**
 * 场景资产屏幕点选：高斯走 SceneAssetPick（避免主场景 gsplat 合成 pick 遮挡），mesh 等走 World。
 */
export async function pickScenePlacedEntryAtScreen(
    global: Global,
    app: AppBase,
    cameraEntity: Entity,
    picker: IdPicker,
    pickX: number,
    pickY: number,
    clientX: number,
    clientY: number
): Promise<ScenePlacedItem | null> {
    const list = global.state.scenePlacedEntities ?? [];
    if (list.length === 0) return null;

    const hasGaussian = list.some((e) => e.assetType === 'gaussian');
    if (hasGaussian) {
        const gaussianHit = await pickGaussianEntryOnPickLayer(
            global,
            app,
            cameraEntity,
            picker,
            pickX,
            pickY,
            clientX,
            clientY,
            list
        );
        if (gaussianHit) return gaussianHit;
    }

    return pickMeshEntryOnWorldLayer(app, cameraEntity, picker, pickX, pickY, list);
}
