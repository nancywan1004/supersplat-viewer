import type { AppBase } from 'playcanvas';
import { Ray, Vec3, StandardMaterial } from 'playcanvas';
import type { Global } from './types';
import type { AssetLibraryItem, AssetLibraryType, ScenePlacedItem } from './types';
import { getSelectedSceneEntity } from './state-helpers';
import { Entity } from 'playcanvas';
import { Picker } from './picker';
import { loadGsplatAsset } from './loaders/gsplat-asset-loader';

const PLACED_ASSETS_NAME = 'placedAssets';
const vec = new Vec3();
const ray = new Ray();

// 资产放置使用的 gsplat 拾取器（重用同一个实例，避免反复创建 RenderPass）
let placementPicker: Picker | null = null;

function nextSceneEntityId(): string {
    return `scene-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function getPlacedAssetsParent(app: AppBase): Entity {
    let parent = app.root.findByName(PLACED_ASSETS_NAME) as Entity | undefined;
    if (!parent) {
        parent = new Entity(PLACED_ASSETS_NAME);
        app.root.addChild(parent);
    }
    return parent;
}

/** 从相机和屏幕坐标构建世界空间射线 */
function buildRay(
    camera: Entity,
    clientX: number,
    clientY: number,
    canvas: HTMLCanvasElement,
    width: number,
    height: number
): void {
    const rect = canvas.getBoundingClientRect();
    const nx = (clientX - rect.left) / rect.width;
    const ny = (clientY - rect.top) / rect.height;
    const screenX = nx * width;
    const screenY = (1 - ny) * height;
    const camPos = camera.getPosition();
    camera.camera.screenToWorld(screenX, screenY, 1, vec);
    vec.sub(camPos).normalize();
    ray.set(camPos, vec);
}

/** 射线与平面 y = planeY 的交点 */
function raycastPlane(planeY: number): Vec3 | null {
    const dirY = ray.direction.y;
    if (Math.abs(dirY) < 1e-6) return null;
    const t = (planeY - ray.origin.y) / dirY;
    if (t < 0) return null;
    return ray.origin.clone().add(ray.direction.clone().mulScalar(t));
}

/** 射线与球体相交，返回 t 值；无交返回 null。球心 worldPos，半径 radius */
function raycastSphere(center: Vec3, radius: number): number | null {
    const o = ray.origin;
    const d = ray.direction;
    const oc = new Vec3().sub2(o, center);
    const a = d.dot(d);
    const b = 2 * oc.dot(d);
    const c = oc.dot(oc) - radius * radius;
    const disc = b * b - 4 * a * c;
    if (disc < 0) return null;
    const t = (-b - Math.sqrt(disc)) / (2 * a);
    return t >= 0 ? t : null;
}

const PICK_SPHERE_RADIUS = 3;

/** 从已放置实体中拾取射线击中的第一个（最近）实体 */
function pickPlacedEntity(global: Global): ScenePlacedItem | null {
    const list = global.state.scenePlacedEntities ?? [];
    let best: { entry: ScenePlacedItem; t: number } | null = null;
    for (const entry of list) {
        if (!entry.entity.enabled) continue;
        const pos = entry.entity.getPosition();
        const t = raycastSphere(pos, PICK_SPHERE_RADIUS);
        if (t !== null && (best === null || t < best.t)) {
            best = { entry, t };
        }
    }
    return best?.entry ?? null;
}

async function instantiateImage(app: AppBase, item: AssetLibraryItem, position: Vec3): Promise<Entity> {
    return new Promise((resolve, reject) => {
        const url = item.url || item.thumbnailUrl;
        if (!url) {
            reject(new Error('image asset has no url'));
            return;
        }
        (app.assets as any).loadFromUrl(url, 'texture', (err: Error | null, asset: any) => {
            if (err) {
                reject(err);
                return;
            }
            const texture = asset?.resource;
            if (!texture) {
                reject(new Error('texture load failed'));
                return;
            }
            const mat = new StandardMaterial();
            mat.diffuseMap = texture;
            mat.update();
            const entity = new Entity(item.name || 'image');
            entity.addComponent('render', {
                type: 'plane',
                material: mat,
                castShadows: false,
                receiveShadows: true
            });
            entity.setPosition(position);
            const s = 2;
            entity.setLocalScale(s, s, 1);
            resolve(entity);
        });
    });
}

async function instantiateMesh(app: AppBase, item: AssetLibraryItem, position: Vec3): Promise<Entity> {
    const asset = item.asset;
    if (!asset?.resource?.instantiateRenderEntity) {
        throw new Error('mesh asset not ready');
    }
    const entity = asset.resource.instantiateRenderEntity({
        castShadows: true,
        receiveShadows: true
    });
    entity.setPosition(position);
    return entity;
}

async function instantiateGaussian(app: AppBase, item: AssetLibraryItem, position: Vec3): Promise<Entity> {
    const asset = item.asset;
    if (!asset) throw new Error('gaussian asset not ready');
    const entity = new Entity(item.name || 'gsplat');
    // 与主场景 gsplat 的朝向一致
    entity.setLocalEulerAngles(0, 0, 180);
    entity.addComponent('gsplat', { unified: true, asset, castShadows: true });
    const material = entity.gsplat!.unified ? app.scene.gsplat.material : entity.gsplat!.material;
    // 尽量与主场景 gsplat 的配置保持一致，开启 AA 并设置 alphaClip
    material.setDefine('GSPLAT_AA', true);
    material.setParameter('alphaClip', 1 / 255);
    entity.setPosition(position);
    return entity;
}

export async function placeAsset(global: Global, item: AssetLibraryItem, worldPos: Vec3): Promise<ScenePlacedItem | null> {
    const { app, state, events } = global;
    if (!state.scenePlacedEntities) state.scenePlacedEntities = [];

    const parent = getPlacedAssetsParent(app);
    let entity: Entity;

    try {
        if (item.type === 'image') {
            entity = await instantiateImage(app, item, worldPos);
        } else if (item.type === 'mesh') {
            entity = await instantiateMesh(app, item, worldPos);
        } else if (item.type === 'gaussian') {
            if (!item.asset?.loaded) {
                await new Promise<void>((resolve, reject) => {
                    item.asset!.once('load', () => resolve());
                    item.asset!.on('error', reject);
                });
            }
            entity = await instantiateGaussian(app, item, worldPos);
        } else {
            return null;
        }
    } catch (err) {
        console.warn('[AssetPlacement] instantiate failed:', err);
        events.fire('assetPlacement:error', { item, error: err });
        return null;
    }

    parent.addChild(entity);
    const entry: ScenePlacedItem = {
        id: nextSceneEntityId(),
        name: item.name || entity.name || '资产',
        entity,
        visible: true,
        assetType: item.type,
        assetId: item.id,
        filename: item.filename,
        url: item.url
    };
    state.scenePlacedEntities.push(entry);
    events.fire('sceneAssets:added', entry);
    return entry;
}

/**
 * 从 settings.sceneAssets 还原场景中的资产实体，并写入 state.scenePlacedEntities。
 * 支持 image / mesh / gaussian，使用 source.url / source.filename 重新加载资产。
 */
export async function restoreSceneAssetsFromSettings(global: Global): Promise<void> {
    const settings: any = global.settings as any;
    const sceneAssets: any[] | undefined = settings.sceneAssets;
    if (!Array.isArray(sceneAssets) || sceneAssets.length === 0) return;

    const { app, state } = global;
    if (!state.scenePlacedEntities) state.scenePlacedEntities = [];

    for (const sa of sceneAssets) {
        const type = sa.type as AssetLibraryType;
        const src = sa.source ?? {};
        const posArr = (sa.transform?.position ?? [0, 0, 0]) as number[];
        const rotArr = (sa.transform?.rotation ?? [0, 0, 0]) as number[];
        const scaleArr = (sa.transform?.scale ?? [1, 1, 1]) as number[];

        let item: AssetLibraryItem | null = null;

        if (type === 'gaussian') {
            const url = (src.url ?? src.filename) as string | undefined;
            if (!url) continue;
            try {
                const asset = await loadGsplatAsset(app, {
                    url,
                    filename: src.filename ?? url
                } as any);
                item = {
                    id: src.assetId ?? nextSceneEntityId(),
                    type: 'gaussian',
                    name: sa.name ?? src.filename ?? 'gaussian',
                    filename: src.filename ?? url,
                    url,
                    asset
                };
            } catch (err) {
                console.warn('[SceneAssets] restore gaussian failed:', err);
                continue;
            }
        } else if (type === 'mesh') {
            const url = (src.url ?? src.filename) as string | undefined;
            if (!url) continue;
            try {
                const asset = await new Promise<any>((resolve, reject) => {
                    (app.assets as any).loadFromUrl(url, 'container', (err: Error | null, asset: any) => {
                        if (err || !asset) {
                            reject(err ?? new Error('container asset missing'));
                            return;
                        }
                        resolve(asset);
                    });
                });
                item = {
                    id: src.assetId ?? nextSceneEntityId(),
                    type: 'mesh',
                    name: sa.name ?? src.filename ?? 'mesh',
                    filename: src.filename ?? url,
                    url,
                    asset
                };
            } catch (err) {
                console.warn('[SceneAssets] restore mesh failed:', err);
                continue;
            }
        } else if (type === 'image') {
            const url = (src.url ?? src.filename) as string | undefined;
            if (!url) continue;
            item = {
                id: src.assetId ?? nextSceneEntityId(),
                type: 'image',
                name: sa.name ?? src.filename ?? 'image',
                filename: src.filename ?? url,
                url
            };
        } else {
            continue;
        }

        const pos = new Vec3(posArr[0] ?? 0, posArr[1] ?? 0, posArr[2] ?? 0);
        const entry = await placeAsset(global, item, pos);
        if (!entry) continue;

        // 应用保存时记录的旋转、缩放与可见性
        entry.entity.setEulerAngles(rotArr[0] ?? 0, rotArr[1] ?? 0, rotArr[2] ?? 0);
        entry.entity.setLocalScale(scaleArr[0] ?? 1, scaleArr[1] ?? 1, scaleArr[2] ?? 1);
        const visible = sa.visible !== false;
        entry.visible = visible;
        entry.entity.enabled = visible;
    }
}

/**
 * 清空当前场景中已放置的资产：销毁实体并从 state.scenePlacedEntities 移除，并派发 sceneAssets:cleared。
 */
export function clearScenePlacedEntities(global: Global): void {
    const list = global.state.scenePlacedEntities ?? [];
    for (const entry of list) {
        entry.entity.destroy();
    }
    global.state.scenePlacedEntities = [];
    global.state.selectedSceneEntityId = null;
    global.events.fire('sceneAssets:cleared');
}

export function initAssetPlacementHandler(global: Global, canvas: HTMLCanvasElement, planeY: number = 0): () => void {
    const { app, state, events, camera } = global;
    const width = () => app.graphicsDevice.width;
    const height = () => app.graphicsDevice.height;

    const onPointerDown = (e: PointerEvent) => {
        if (!state.editMode) return;
        if (e.button !== 0) return;
        buildRay(camera, e.clientX, e.clientY, canvas, width(), height());

        // 先尝试拾取已放置实体
        const picked = pickPlacedEntity(global);
        if (picked) {
            const entry = (state.scenePlacedEntities ?? []).find((e) => e.entity === picked.entity);
            state.selectedSceneEntityId = entry?.id ?? null;
            events.fire('sceneAsset:selected');
            return;
        }

        // 旧的「点击画布再选资产」模式已废弃，这里只处理实体拾取，真正的放置通过 assetPlacement:dropOnCanvas 完成
    };

    const onCopy = () => {
        const current = getSelectedSceneEntity(state);
        if (!current) return;
        const list = state.scenePlacedEntities ?? [];
        const entry = list.find((e) => e.entity === current);
        if (!entry) return;
        const parent = getPlacedAssetsParent(app);
        const clone = current.clone();
        clone.setPosition(
            current.getPosition().x + 1,
            current.getPosition().y,
            current.getPosition().z + 1
        );
        parent.addChild(clone);
        const newEntry: ScenePlacedItem = {
            id: nextSceneEntityId(),
            name: entry.name + ' (副本)',
            entity: clone,
            visible: true
        };
        state.scenePlacedEntities!.push(newEntry);
        state.selectedSceneEntityId = newEntry.id;
        events.fire('sceneAssets:added', newEntry);
        events.fire('sceneAsset:selected');
    };

    const onDelete = () => {
        const current = getSelectedSceneEntity(state);
        if (!current) return;
        const list = state.scenePlacedEntities ?? [];
        const idx = list.findIndex((e) => e.entity === current);
        if (idx < 0) return;
        const entry = list[idx];
        entry.entity.destroy();
        list.splice(idx, 1);
        state.selectedSceneEntityId = null;
        events.fire('sceneAssets:removed', entry);
        events.fire('sceneAsset:selected');
    };

    const onDropOnCanvas = async (payload: { item: AssetLibraryItem; clientX: number; clientY: number }) => {
        if (!state.editMode) return;
        const { item, clientX, clientY } = payload;
        const rect = canvas.getBoundingClientRect();
        const offsetX = clientX - rect.left;
        const offsetY = clientY - rect.top;
        if (offsetX < 0 || offsetY < 0 || offsetX > rect.width || offsetY > rect.height) {
            return;
        }

        // 归一化到 [0,1]，与 Picker.pick 的期望一致
        const nx = offsetX / rect.width;
        const ny = offsetY / rect.height;

        // 优先用 gsplat Picker 精确拾取主 gsplat 表面位置；失败时再回退到地平面
        if (!placementPicker) {
            placementPicker = new Picker(app, camera);
        }

        let hit = await placementPicker.pick(nx, ny);
        if (!hit) {
            buildRay(camera, clientX, clientY, canvas, width(), height());
            hit = raycastPlane(planeY);
        }
        if (!hit) return;

        const entry = await placeAsset(global, item, hit);
        if (!entry) return;
        state.selectedSceneEntityId = entry.id;
        events.fire('sceneAsset:selected');
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    events.on('assetEdit:copy', onCopy);
    events.on('assetEdit:delete', onDelete);
    events.on('assetPlacement:dropOnCanvas', onDropOnCanvas);

    return () => {
        canvas.removeEventListener('pointerdown', onPointerDown);
        events.off('assetEdit:copy', onCopy);
        events.off('assetEdit:delete', onDelete);
        events.off('assetPlacement:dropOnCanvas', onDropOnCanvas);

        // 释放 Picker 相关 GPU 资源
        if (placementPicker) {
            placementPicker.release();
            placementPicker = null;
        }
    };
}
