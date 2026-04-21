import type { AppBase } from 'playcanvas';
import * as pc from 'playcanvas';
import { Vec3, Quat, StandardMaterial, CULLFACE_NONE, Color, BLEND_NONE } from 'playcanvas';
import type { Global } from './types';
import type { AssetLibraryItem, AssetLibraryType, ScenePlacedItem } from './types';
import { getSelectedSceneEntity } from './state-selectors';
import { Entity } from 'playcanvas';
import { loadGsplatAsset } from './loaders/gsplat-asset-loader';
import { pickWorldFromClientXY } from './picker';

const PLACED_ASSETS_NAME = 'placedAssets';

export type AssetPlacementHandlerDeps = {
    pushEditHistory?: (global: Global, label?: string) => void;
};

type SceneAssetsRestoreOptions = {
    reason?: 'startup' | 'edit-enter' | 'edit-discard' | 'history-restore';
    deferUntilRevealComplete?: boolean;
    clearBeforeRestore?: boolean;
};

type SceneAssetsRestoreController = {
    version: number;
    activePromise: Promise<void>;
};

/** 新场景放置实体 id（ASSET_COPY 的 copyId 等与内部复制共用） */
export function nextSceneEntityId(): string {
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

/** 相机前方距离，用于兜底放置位置 */
const CAMERA_FRONT_DISTANCE = 5;

function getSceneAssetsRestoreController(global: Global): SceneAssetsRestoreController {
    const anyGlobal = global as Global & { __sceneAssetsRestoreController?: SceneAssetsRestoreController };
    if (!anyGlobal.__sceneAssetsRestoreController) {
        anyGlobal.__sceneAssetsRestoreController = {
            version: 0,
            activePromise: Promise.resolve()
        };
    }
    return anyGlobal.__sceneAssetsRestoreController;
}

/**
 * 计算相机前方某距离处的世界坐标（用于兜底放置）
 */
export function getPositionInFrontOfCamera(global: Global, distance: number = CAMERA_FRONT_DISTANCE): Vec3 {
    const cam = global.camera;
    const pos = cam.getPosition().clone();
    const zAxis = cam.getWorldTransform().getZ().clone();
    zAxis.mulScalar(-distance);
    pos.add(zAxis);
    return pos;
}

/**
 * 仅根据相机在 XZ 平面上的方位设置「航向角」（本地欧拉 yaw / Y），不改变 pitch(X)、roll(Z)。
 */
function computeYawDegToFaceCameraHorizontal(entityPos: Vec3, camPos: Vec3): number {
    const dx = camPos.x - entityPos.x;
    const dz = camPos.z - entityPos.z;
    return Math.atan2(dx, dz) * pc.math.RAD_TO_DEG;
}

/**
 * 放置后只调整 yaw，使水平面上指向相机；保留原有 pitch/roll。
 * 图片：维持原立屏姿态 pitch=-90、roll=180，仅改 Y。
 * 高斯：unified 需 Z=180，但与航向若写进同一组 intrinsic XYZ 欧拉会耦合成「左右镜像」体感；
 * 改用四元数先 Rz(180) 再绕世界 Y 转航向（mul2(yaw, fix)）。
 */
function applyPlacedEntityYawToFaceCamera(entity: Entity, global: Global, assetType: AssetLibraryType) {
    const camPos = global.camera.getPosition();
    const pos = entity.getPosition();
    const yawDeg = computeYawDegToFaceCameraHorizontal(pos, camPos);

    if (assetType === 'image') {
        entity.setLocalEulerAngles(-90, yawDeg, 180);
        return;
    }

    if (assetType === 'gaussian') {
        const qFix = new Quat().setFromEulerAngles(0, 0, 180);
        const qYaw = new Quat().setFromAxisAngle(Vec3.UP, yawDeg);
        const q = new Quat().mul2(qYaw, qFix);
        entity.setRotation(q);
        return;
    }

    const e = entity.getLocalEulerAngles();
    entity.setLocalEulerAngles(e.x, yawDeg, e.z);
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
            // 图片资产使用近似 unlit 卡片：不受场景光照/天空盒影响，保持亮度稳定。
            mat.useLighting = false;
            // 关闭 diffuse 贡献，避免其常量项盖过 emissive 调节效果。
            mat.diffuse.set(0, 0, 0);
            mat.emissiveMap = texture;
            mat.emissive.set(1, 1, 1);
            mat.opacityMap = texture;
            mat.opacityMapChannel = 'a';
            // 图片与 gsplat 叠加时，透明混合路径（BLEND_NORMAL）会带来排序/遮挡错误；
            // 改用 alpha-test cutout + 不透明通道，确保深度写入，前后关系稳定。
            mat.blendType = BLEND_NONE;
            mat.alphaTest = 0.5;
            mat.cull = CULLFACE_NONE;
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
    const resource = asset?.resource as { instantiateRenderEntity?: (opts: object) => Entity } | undefined;
    if (!resource?.instantiateRenderEntity) {
        throw new Error('mesh asset not ready');
    }
    const entity = resource.instantiateRenderEntity({
        castShadows: true,
        receiveShadows: true
    });
    entity.setPosition(position);
    return entity;
}

/**
 * 对放置的 mesh 层级做一次材质侧统一配置（当前：StandardMaterial 关闭 scene 级 IBL，便于弱 env 下仍靠光+ambient 可读）。
 */
function configurePlacedMeshMaterials(root: Entity): void {
    const visit = (node: Entity) => {
        const render = node.render;
        const instances = render?.meshInstances;
        if (instances?.length) {
            for (const mi of instances as any[]) {
                const mat = mi?.material;
                if (mat instanceof StandardMaterial) {
                    mat.useSkybox = false;
                    mat.update();
                }
            }
        }
        for (const child of node.children as Entity[]) {
            visit(child);
        }
    };
    visit(root);
}

async function instantiateGaussian(app: AppBase, item: AssetLibraryItem, position: Vec3): Promise<Entity> {
    const asset = item.asset;
    if (!asset) throw new Error('gaussian asset not ready');
    const entity = new Entity(item.name || 'gsplat');
    entity.addComponent('gsplat', { unified: true, asset, castShadows: true });
    const material = entity.gsplat!.unified ? app.scene.gsplat.material : entity.gsplat!.material;
    // 尽量与主场景 gsplat 的配置保持一致，开启 AA 并设置 alphaClip
    material.setDefine('GSPLAT_AA', true);
    material.setParameter('alphaClip', 1 / 255);
    entity.setPosition(position);
    return entity;
}

export function computeEntityWorldCenter(entity: Entity): Vec3 | null {
    const anyEntity = entity as any;
    let worldCenter: Vec3 | null = null;

    // 1) 普通 mesh / image：扫 entity 及子节点上的 render.meshInstances，合并 world-space AABB
    const meshInstances: any[] = [];
    const collectMeshInstances = (node: any) => {
        const r = node.render;
        if (r && r.meshInstances && r.meshInstances.length > 0) {
            for (const mi of r.meshInstances) {
                meshInstances.push(mi);
            }
        }
        const children = node.children as any[] | undefined;
        if (children && children.length) {
            for (const child of children) collectMeshInstances(child);
        }
    };
    collectMeshInstances(anyEntity);

    if (meshInstances.length > 0) {
        const min = new Vec3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
        const max = new Vec3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
        for (const mi of meshInstances) {
            const aabb = mi.aabb;
            if (!aabb) continue;
            const miMin = aabb.getMin ? aabb.getMin() : aabb.center.clone().sub(aabb.halfExtents);
            const miMax = aabb.getMax ? aabb.getMax() : aabb.center.clone().add(aabb.halfExtents);
            min.min(miMin);
            max.max(miMax);
        }
        worldCenter = min.add(max).mulScalar(0.5);
    }

    // 2) 高斯：使用 gsplat 的 AABB
    if (!worldCenter && anyEntity.gsplat) {
        const gs = anyEntity.gsplat;
        const aabb = gs.customAabb || gs.aabb;
        if (aabb && aabb.center) {
            const modelCenter = aabb.center.clone();
            worldCenter = entity.getWorldTransform().transformPoint(modelCenter);
        }
    }

    return worldCenter;
}

export async function placeAsset(global: Global, item: AssetLibraryItem, worldPos: Vec3, alignCenterToCameraHeight: boolean = false): Promise<ScenePlacedItem | null> {
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

    if (item.type === 'mesh') {
        configurePlacedMeshMaterials(entity);
    }

    applyPlacedEntityYawToFaceCamera(entity, global, item.type);

    if (alignCenterToCameraHeight) {
        const center = computeEntityWorldCenter(entity);
        if (center) {
            const camY = global.camera.getPosition().y;
            const dy = camY - center.y;
            if (Math.abs(dy) > 1e-3) {
                const pos = entity.getPosition();
                pos.y += dy;
                entity.setPosition(pos);
            }
        }
    }
    const entry: ScenePlacedItem = {
        id: nextSceneEntityId(),
        name: item.name || entity.name || '资产',
        entity,
        visible: true,
        assetType: item.type,
        assetId: item.id,
        filename: item.filename,
        url: item.url,
        thumbnailUrl: item.thumbnailUrl
    };
    state.scenePlacedEntities.push(entry);
    events.fire('sceneAssets:added', entry);
    return entry;
}

/**
 * 协议放置时，父级常只传 url/name/type，不会携带已加载的 PlayCanvas asset 实例。
 * 这里补齐 mesh/gaussian 的 asset，保证 ASSET_PLACE 只传 URL 也可放置。
 */
async function hydrateProtocolPlaceItem(global: Global, item: AssetLibraryItem): Promise<AssetLibraryItem | null> {
    if (item.type === 'image') return item;

    if (item.asset) return item;

    const url = item.url || item.filename;
    if (!url) {
        console.warn('[AssetPlacement] protocol place missing url for', item.type);
        return null;
    }

    const app = global.app;
    try {
        if (item.type === 'gaussian') {
            const asset = await loadGsplatAsset(app, {
                url,
                filename: item.filename ?? url
            } as any);
            return { ...item, asset, filename: item.filename ?? url, url };
        }

        if (item.type === 'mesh') {
            const asset = await new Promise<any>((resolve, reject) => {
                (app.assets as any).loadFromUrl(url, 'container', (err: Error | null, loadedAsset: any) => {
                    if (err || !loadedAsset) {
                        reject(err ?? new Error('container asset missing'));
                        return;
                    }
                    resolve(loadedAsset);
                });
            });
            return { ...item, asset, filename: item.filename ?? url, url };
        }
    } catch (err) {
        console.warn('[AssetPlacement] protocol asset hydrate failed:', item.type, url, err);
        return null;
    }

    return item;
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
                    thumbnailUrl: sa.thumbnailUrl,
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
                    thumbnailUrl: sa.thumbnailUrl,
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
                url,
                thumbnailUrl: sa.thumbnailUrl
            };
        } else {
            continue;
        }

        const pos = new Vec3(posArr[0] ?? 0, posArr[1] ?? 0, posArr[2] ?? 0);
        const entry = await placeAsset(global, item, pos, false);
        if (!entry) continue;

        if (sa.id) {
            entry.id = sa.id;
        }
        if (typeof sa.thumbnailUrl === 'string' && sa.thumbnailUrl.length > 0) {
            entry.thumbnailUrl = sa.thumbnailUrl;
        }

        // 应用保存时记录的旋转、缩放与可见性
        entry.entity.setEulerAngles(rotArr[0] ?? 0, rotArr[1] ?? 0, rotArr[2] ?? 0);
        entry.entity.setLocalScale(scaleArr[0] ?? 1, scaleArr[1] ?? 1, scaleArr[2] ?? 1);
        const visible = sa.visible !== false;
        entry.visible = visible;
        entry.entity.enabled = visible;
    }
}

/**
 * 统一调度 sceneAssets → scenePlacedEntities 的恢复链路：
 * - startup 可选择 defer 到 revealComplete；
 * - 后续 edit/discard/history restore 会提升 version，使旧的 startup defer 自动失效；
 * - 所有实际恢复都串行执行，避免与其他 restore 链并发交错。
 */
export async function requestSceneAssetsRestore(global: Global, options: SceneAssetsRestoreOptions = {}): Promise<void> {
    const controller = getSceneAssetsRestoreController(global);
    const version = controller.version + 1;
    controller.version = version;

    const invoke = async (): Promise<void> => {
        const previousTask = controller.activePromise;
        const task = (async (): Promise<void> => {
            await previousTask.catch((): void => undefined);
            if (controller.version !== version) return;
            if (options.clearBeforeRestore !== false) {
                clearScenePlacedEntities(global);
            }
            await restoreSceneAssetsFromSettings(global);
        })();
        controller.activePromise = task;
        await task;
    };

    if (options.deferUntilRevealComplete) {
        global.events.once('revealComplete', () => {
            void invoke().catch((err) => {
                console.warn('[SceneAssets] deferred restore failed:', options.reason ?? 'unknown', err);
            });
        });
        return;
    }

    await invoke();
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

export function initAssetPlacementHandler(
    global: Global,
    canvas: HTMLCanvasElement,
    planeY: number = 0,
    deps: AssetPlacementHandlerDeps = {}
): () => void {
    const { app, state, events, camera } = global;
    const width = () => app.graphicsDevice.width;
    const height = () => app.graphicsDevice.height;

    let sceneAssetPicker: any = null;
    let pendingPlacement: { value: AssetLibraryItem; sceneEntityId?: string } | null = null;
    let pendingPlacementInFlight = false;

    const clearPendingPlacement = () => {
        pendingPlacement = null;
        pendingPlacementInFlight = false;
    };

    const onPointerDown = (e: PointerEvent) => {
        if (!state.editMode || state.editLeftModule !== 'asset' || e.button !== 0) return;
        // Gizmo 正在处理该指针会话时，屏蔽资产拾取，避免轴与实体重合时误选中实体。
        if (state.cameraControlsEnabled === false) return;

        e.stopPropagation();
        e.preventDefault();

        const rect = canvas.getBoundingClientRect();
        const offsetX = e.clientX - rect.left;
        const offsetY = e.clientY - rect.top;
        if (offsetX < 0 || offsetY < 0 || offsetX > rect.width || offsetY > rect.height) return;

        if (pendingPlacement) {
            if (pendingPlacementInFlight) return;
            pendingPlacementInFlight = true;
            void (async () => {
                try {
                    const worldPos = await pickWorldFromClientXY(global, e.clientX, e.clientY);
                    if (!worldPos) return;
                    const payload = pendingPlacement;
                    if (!payload) return;
                    const hydrated = await hydrateProtocolPlaceItem(global, payload.value);
                    if (!hydrated) return;
                    const entry = await placeAsset(global, hydrated, worldPos, false);
                    if (!entry) return;
                    if (typeof payload.sceneEntityId === 'string' && payload.sceneEntityId.trim().length > 0) {
                        entry.id = payload.sceneEntityId;
                    }
                    state.selectedSceneEntityId = entry.id;
                    events.fire('sceneAsset:selected');
                    events.fire('sceneAsset:placed', { id: entry.id, source: 'scene' });
                    requestAnimationFrame(() => {
                        events.fire('inputEvent', 'frame', { focusTarget: 'asset' as const });
                    });
                    deps.pushEditHistory?.(global, 'place asset');
                    clearPendingPlacement();
                } finally {
                    pendingPlacementInFlight = false;
                }
            })();
            return;
        }

        const list = state.scenePlacedEntities ?? [];
        if (list.length === 0) return;

        const pickerScale = 0.5;
        const pickW = Math.max(1, Math.floor(width() * pickerScale));
        const pickH = Math.max(1, Math.floor(height() * pickerScale));
        const pickX = Math.floor((offsetX / rect.width) * pickW);
        const pickY = Math.floor((offsetY / rect.height) * pickH);

        if ((app.scene as any).gsplat) {
            (app.scene as any).gsplat.enableIds = true;
        }
        // depth=false：实体选中只需 ID 缓冲；深度拾取由标注 Picker 用 pc.Picker(..., true) + getWorldPointAsync 单独处理。
        if (!sceneAssetPicker) {
            sceneAssetPicker = new (pc as any).Picker(app, pickW, pickH, false);
        }
        sceneAssetPicker.resize(pickW, pickH);
        const worldLayer = app.scene.layers.getLayerByName('World');
        sceneAssetPicker.prepare(camera.camera, app.scene, worldLayer ? [worldLayer] : undefined);

        sceneAssetPicker.getSelectionAsync(pickX, pickY, 1, 1).then((selection: any[]) => {
            if (selection.length === 0) return;
            const picked = selection[0];
            // Unified 模式下拾取 gsplat 返回 GSplatComponent（有 .entity）；拾取 mesh / plane 返回 MeshInstance（有 .node）
            const entity = picked.entity ?? picked.node ?? null;
            if (!entity) return;
            // 对于 mesh，MeshInstance.node 可能是挂在 ScenePlacedItem.entity 下的子节点，这里同时兼容「自身」与「子层级命中」
            const entry = list.find((item) => {
                if (item.entity === entity) return true;
                const anyEntity = entity as any;
                return typeof anyEntity.isDescendantOf === 'function' && anyEntity.isDescendantOf(item.entity);
            });
            if (!entry) return;
            const prevSelectedId = state.selectedSceneEntityId;
            state.selectedSceneEntityId = entry.id;
            events.fire('sceneAsset:selected', { source: 'scene' });
            // 仅当场景点击导致“选中对象变化”时，才触发聚焦。
            if (prevSelectedId === entry.id) return;
            // 统一走资产 frame 链路（camera-manager 内会按选中资产 bbox 做 framing）。
            events.fire('inputEvent', 'frame', { focusTarget: 'asset' as const });
        }).catch(() => {});
    };

    const onCopy = (payload?: { copyId?: string }) => {
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
        if (entry.assetType === 'mesh') {
            configurePlacedMeshMaterials(clone);
        }
        const copiedId = (typeof payload?.copyId === 'string' && payload.copyId.trim().length > 0)
            ? payload.copyId
            : nextSceneEntityId();
        const newEntry: ScenePlacedItem = {
            id: copiedId,
            name: entry.name + ' (副本)',
            entity: clone,
            visible: true,
            assetType: entry.assetType,
            assetId: entry.assetId,
            filename: entry.filename,
            url: entry.url,
            thumbnailUrl: entry.thumbnailUrl
        };
        state.scenePlacedEntities!.push(newEntry);
        state.selectedSceneEntityId = newEntry.id;
        events.fire('sceneAssets:added', newEntry);
        events.fire('sceneAsset:selected');
        // 复制成功后聚焦到新副本，避免仍停留在原资产视角。
        requestAnimationFrame(() => {
            events.fire('inputEvent', 'frame', { focusTarget: 'asset' as const });
        });
        deps.pushEditHistory?.(global, 'copy asset');
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
        deps.pushEditHistory?.(global, 'delete asset');
    };

    canvas.addEventListener('pointerdown', onPointerDown);
    const onPlaceStart = (payload: { value: AssetLibraryItem; sceneEntityId?: string }) => {
        pendingPlacement = payload;
        pendingPlacementInFlight = false;
    };

    events.on('assetEdit:copy', onCopy);
    events.on('assetEdit:delete', onDelete);
    events.on('assetPlacement:start', onPlaceStart);
    events.on('assetFacade:exit', clearPendingPlacement);
    events.on('assetFacade:editModeExit', clearPendingPlacement);

    return () => {
        canvas.removeEventListener('pointerdown', onPointerDown);
        if (sceneAssetPicker) {
            sceneAssetPicker.destroy();
            sceneAssetPicker = null;
        }
        events.off('assetEdit:copy', onCopy);
        events.off('assetEdit:delete', onDelete);
        events.off('assetPlacement:start', onPlaceStart);
        events.off('assetFacade:exit', clearPendingPlacement);
        events.off('assetFacade:editModeExit', clearPendingPlacement);
    };
}
