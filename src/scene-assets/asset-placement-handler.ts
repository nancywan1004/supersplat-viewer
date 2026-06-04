import type { AppBase } from 'playcanvas';
import * as pc from 'playcanvas';
import {
    Entity,
    Vec3,
    Quat,
    Color,
    StandardMaterial,
    CULLFACE_NONE,
    BLEND_NONE,
    Texture,
    PIXELFORMAT_RGBA8,
    FILTER_LINEAR,
    ADDRESS_CLAMP_TO_EDGE,
    MeshInstance
} from 'playcanvas';
import type { SceneAsset } from '../schemas/v2-custom';
import type { Global, AssetLibraryItem, AssetLibraryType, ScenePlacedItem } from '../types';
import {
    getSelectedSceneEntity,
    isAssetScenePickEventOnlyMode,
    isMorphAssetAddPickMode,
    isSceneAssetPickableInViewerMode
} from '../state-selectors';
import {
    DEFAULT_ASSET_LOAD_TIMEOUT_MS,
    hydrateAssetLibraryItem,
    loadSceneAssetLibraryItem,
    withTimeout
} from '../loaders/asset-loader';
import { hitSceneGizmoAtClient } from '../gizmo-hit-test';
import type { InputArbiter } from '../input-arbiter';
import {
    ensureEffectsSettings,
    findAssetMorphOwnerTargetId,
    readAssetInstanceParams
} from '../settings-serialize/effects-sync';
import { readMorphKeyframeEntityIds } from '../vfx/effects-runtime/asset/asset-effect-entity';
import { getDefaultWobbleEffectParams } from '../vfx/effects-runtime/asset/wobble-effect-params';
import { ASSET_EFFECT_TYPE_VALUES } from '../vfx/effects-runtime/effect-types';
import {
    clampVideoHorizontalCurvature,
    createCurvedBillboardMesh,
    rebuildVideoRenderMesh
} from './media/curved-billboard-mesh';
import { defaultTriggerDistanceMForAssetType } from './media/media-hotspot-params';
import {
    getPlacedMediaRuntime,
    setPlacedMediaRuntime,
    type PlacedMediaRuntime,
    type PlacedVideoRuntime
} from './media/media-runtime';
import { setPlacementCursorActive } from '../placement-cursor';
import {
    acquirePlacedVideoForPlacement,
    cancelVideoPlacementPreload,
    startVideoPlacementPreload,
    type VideoPlacementPreloadHandle
} from './media/video-placement-preload';
import {
    createPlacedVideoTextureFromVideo,
    initPlacedVideoTexture,
    PLACED_VIDEO_INITIAL_LOAD_TIMEOUT_MS,
    PLACED_VIDEO_PLACEMENT_TIMEOUT_MS,
    unmountPlacedVideoFromDom
} from './media/video-texture';
import { AUDIO_CALLOUT_WORLD_H, findAudioCalloutSelectHitFromClient } from './media/audio-callout';
import { getSceneAssetPickLayer } from './scene-asset-pick-layer';
import { configurePlacedGaussianPickLayer, pickScenePlacedEntryAtScreen } from './scene-asset-selection-pick';
import { removeSceneAssetFromSettings } from '../settings-serialize/settings-serialize';
import { suspendShadowPipelineForGsplatLoad, syncGsplatShadowCastingFromSettings } from '../vfx/shadow';
import type { ExperienceSettings } from '../settings';

const PLACED_ASSETS_NAME = 'placedAssets';
const ASSET_LOAD_TIMEOUT_MS = DEFAULT_ASSET_LOAD_TIMEOUT_MS;
const GSPLAT_WOBBLE_TYPE = ASSET_EFFECT_TYPE_VALUES[1];

export type AssetPlacementHandlerDeps = {
    pushEditHistory?: (global: Global, label?: string) => void;
};

type SceneAssetsRestoreOptions = {
    reason?: 'startup' | 'edit-enter' | 'edit-discard' | 'history-restore' | 'settings-reset';
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

/** image / video 平面默认立屏（PlayCanvas plane 在 XZ）；仅实例化时写入，放置时只改 yaw（与 mesh 一致） */
const PLANE_CARD_DEFAULT_EULER = { x: -90, y: 0, z: 180 };

function applyDefaultPlaneCardOrientation(entity: Entity): void {
    entity.setLocalEulerAngles(PLANE_CARD_DEFAULT_EULER.x, PLANE_CARD_DEFAULT_EULER.y, PLANE_CARD_DEFAULT_EULER.z);
}

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
 * 场景资产还原后的 idle 预览（瞌睡 wobble / `deepMeditation`）：
 * - 存盘 `gsplat-morph`：只给 morph owner 挂 idle，不播 morph 时间轴；
 * - 存盘 `gsplat-wobble`（含扭动/电子等非瞌睡模式）：启动后同样先播 idle，用户显式「开始」再走存盘参数。
 * 不改写 settings，仅 `assetEffect:start` 运行态。
 */
function startRestoredAssetDefaultEffectIfConfigured(global: Global, entry: ScenePlacedItem): void {
    if (entry.assetType !== 'gaussian' || !entry.entity.gsplat) {
        return;
    }

    const settings = global.settings as ExperienceSettings;
    const storageTargetId = findAssetMorphOwnerTargetId(settings, entry.id) ?? entry.id;
    const inst = readAssetInstanceParams(settings, storageTargetId);
    if (!inst || inst.enabled === false || inst.autoStart !== true) {
        return;
    }

    let shouldStartIdle = false;
    if (inst.type === 'gsplat-morph') {
        shouldStartIdle = entry.id === storageTargetId;
    } else if (inst.type === GSPLAT_WOBBLE_TYPE) {
        shouldStartIdle = entry.id === storageTargetId;
    }
    if (!shouldStartIdle) {
        return;
    }

    global.events.fire('assetEffect:start', {
        targetId: entry.id,
        type: GSPLAT_WOBBLE_TYPE,
        params: {
            effectParams: getDefaultWobbleEffectParams('deepMeditation')
        },
        entities: {
            primary: entry.entity
        }
    });
}

/** Edit → View：重新启动 autoStart 物体的 idle 瞌睡 wobble（进编辑时 vfxExit 会拆掉特效）。 */
export function restartViewerIdleAssetEffects(global: Global): void {
    if (global.state.editMode === true) {
        return;
    }
    for (const entry of global.state.scenePlacedEntities ?? []) {
        startRestoredAssetDefaultEffectIfConfigured(global, entry);
    }
}

/**
 * Viewer 资产恢复完成后的 morph 源物体展示策略：
 * 只保留 morph owner，可见性只改运行态，不回写 settings.sceneAssets。
 * @param global - Viewer global context.
 */
function hideRestoredMorphSourceEntitiesInViewer(global: Global): void {
    const settings = global.settings as ExperienceSettings;
    const instances = ensureEffectsSettings(settings).asset.instancesByTargetId ?? {};
    const placed = global.state.scenePlacedEntities ?? [];
    const placedById = new Map<string, ScenePlacedItem>();
    for (const entry of placed) {
        if (entry?.id) {
            placedById.set(entry.id, entry);
        }
    }

    for (const ownerTargetId of Object.keys(instances)) {
        const inst = readAssetInstanceParams(settings, ownerTargetId);
        if (inst?.type !== 'gsplat-morph') {
            continue;
        }
        const keyframeIds = readMorphKeyframeEntityIds(inst.effectParams ?? {});
        if (!keyframeIds) {
            continue;
        }
        for (const keyframeId of keyframeIds) {
            if (keyframeId === ownerTargetId) {
                continue;
            }
            const entry = placedById.get(keyframeId);
            if (!entry) {
                continue;
            }
            entry.entity.enabled = false;
        }
    }
}

/**
 * Edit 模式需要看到 morph 的所有关键帧实体，方便选择和调整。
 * 同时修复旧 viewer 运行态隐藏曾污染到 `entry.visible=false` 的场景。
 */
function showRestoredMorphKeyframeEntitiesInEditMode(global: Global): void {
    const settings = global.settings as ExperienceSettings;
    const instances = ensureEffectsSettings(settings).asset.instancesByTargetId ?? {};
    const placed = global.state.scenePlacedEntities ?? [];
    const placedById = new Map<string, ScenePlacedItem>();
    for (const entry of placed) {
        if (entry?.id) {
            placedById.set(entry.id, entry);
        }
    }

    for (const ownerTargetId of Object.keys(instances)) {
        const inst = readAssetInstanceParams(settings, ownerTargetId);
        if (inst?.type !== 'gsplat-morph') {
            continue;
        }
        const keyframeIds = readMorphKeyframeEntityIds(inst.effectParams ?? {});
        if (!keyframeIds) {
            continue;
        }
        for (const keyframeId of keyframeIds) {
            const entry = placedById.get(keyframeId);
            if (!entry) {
                continue;
            }
            entry.visible = true;
            entry.entity.enabled = true;
        }
    }
}

/**
 * 按当前 Viewer/Edit 模式统一应用 morph 关键帧显隐（仅运行态，不写 settings）。
 * restore 收尾与 `editMode` 切换后都应调用，避免 edit-enter 时 restore 早于 `editMode=true` 导致关键帧仍被隐藏。
 */
export function applyMorphKeyframeVisibilityPolicy(global: Global): void {
    if (global.state.editMode === true) {
        showRestoredMorphKeyframeEntitiesInEditMode(global);
    } else {
        hideRestoredMorphSourceEntitiesInViewer(global);
    }
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
 * 放置后只调整水平航向 yaw，使实体在 XZ 平面上朝向相机；保留既有 pitch/roll（与 mesh 一致）。
 * image/video 的 pitch/roll 已在实例化时由 `applyDefaultPlaneCardOrientation` 写好，此处仅改 Y。
 * 高斯：unified 需额外 Z=180，用 mul2(yaw, Rz180) 与航向解耦。
 */
function applyPlacedEntityYawToFaceCamera(entity: Entity, global: Global, assetType: AssetLibraryType) {
    const camPos = global.camera.getPosition();
    const pos = entity.getPosition();
    const yawDeg = computeYawDegToFaceCameraHorizontal(pos, camPos);

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
        let settled = false;
        const timer = window.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(`[AssetPlacement] image load timeout (${ASSET_LOAD_TIMEOUT_MS}ms): ${url}`));
        }, ASSET_LOAD_TIMEOUT_MS);
        (app.assets as any).loadFromUrl(url, 'texture', (err: Error | null, asset: any) => {
            if (settled) return;
            settled = true;
            window.clearTimeout(timer);
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
                receiveShadows: false
            });
            entity.setPosition(position);
            const s = 2;
            entity.setLocalScale(s, s, 1);
            applyDefaultPlaneCardOrientation(entity);
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
// ==================== PBR 材质配置常量 ====================

/** 高反光 PBR 检测阈值 */
const PBR_DETECT_THRESHOLDS = {
    /** 高金属度阈值 */
    metalness: 0.3,
    /** 高光泽度阈值 */
    shininess: 60,
    /** 极高光泽度阈值（用于额外提升） */
    highShininess: 80,
    /** 需要降低 metalness 的阈值 */
    reduceMetalness: 0.8,
    /** 降低后的 metalness 最小值 */
    reducedMetalnessMin: 0.6,
    /** 降低 metalness 的乘数 */
    reducedMetalnessScale: 0.7
} as const;

/** PBR 亮度提升系数（轻微提亮，突破1.0限制避免被clamp） */
const PBR_BOOST_FACTORS = {
    /** ambient 绝对值（轻微提亮至1.0） */
    ambient: { r: 0.9, g: 0.9, b: 0.9 },
    /** 极高光泽度时 diffuse 绝对值（轻微提亮至1.1） */
    diffuse: { r: 1.1, g: 1.1, b: 1.1 },
    /** 自发光颜色（轻微补偿） */
    emissive: { r: 0.02, g: 0.02, b: 0.02 },
    /** 自发光强度 */
    emissiveIntensity: 0.4,
    /** 需要自发光的阈值 */
    emissiveIntensityThreshold: 0.05
} as const;

/** 扩展 StandardMaterial 类型，包含 PBR 属性 */
type PBRMaterial = StandardMaterial & {
    metalness?: number;
    useMetalness?: boolean;
    shininess?: number;
    clearCoat?: number;
    useSpecular?: boolean;
    specularMap?: unknown;
    glossMap?: unknown;
    metalnessMap?: unknown;
    emissiveIntensity?: number;
};

/**
 * 检测材质是否为高反光 PBR 材质
 */
function isHighReflectivePBRMaterial(mat: PBRMaterial): boolean {
    const metalness = mat.metalness ?? 0;
    const useMetalness = mat.useMetalness ?? false;
    const shininess = mat.shininess ?? 0;
    const clearCoat = mat.clearCoat ?? 0;
    const useSpecular = mat.useSpecular ?? false;
    const hasSpecularMap = !!mat.specularMap;
    const hasGlossMap = !!mat.glossMap;
    const hasMetalnessMap = !!mat.metalnessMap;

    return (
        (useMetalness && metalness > PBR_DETECT_THRESHOLDS.metalness) ||
        (useSpecular && shininess > PBR_DETECT_THRESHOLDS.shininess) ||
        clearCoat > 0 ||
        hasSpecularMap ||
        hasGlossMap ||
        hasMetalnessMap
    );
}

/**
 * 应用高反光 PBR 材质亮度提升
 */
function applyPBRBrightnessBoost(mat: PBRMaterial): void {
    const { metalness, useMetalness, shininess } = mat;
    const th = PBR_DETECT_THRESHOLDS;
    const boost = PBR_BOOST_FACTORS;

    mat.useSkybox = true;

    // 极高金属度材质：适度降低 metalness 保留漫反射贡献
    if (useMetalness && (metalness ?? 0) > th.reduceMetalness) {
        mat.metalness = Math.max(th.reducedMetalnessMin, (metalness ?? 1) * th.reducedMetalnessScale);
    }

    // 强制设置高 ambient 值（突破1.0限制，不被clamp）
    mat.ambient.set(boost.ambient.r, boost.ambient.g, boost.ambient.b);

    // 极高光泽度：强制设置高 diffuse 值（突破1.0限制）
    if ((shininess ?? 0) > th.highShininess) {
        mat.diffuse.set(boost.diffuse.r, boost.diffuse.g, boost.diffuse.b);
    }

    // 添加自发光补偿（提高基础可见性）
    const currentIntensity = mat.emissiveIntensity ?? 0;
    if (currentIntensity < boost.emissiveIntensityThreshold) {
        mat.emissive.set(boost.emissive.r, boost.emissive.g, boost.emissive.b);
        mat.emissiveIntensity = boost.emissiveIntensity;
    }
}

/**
 * 对放置的 mesh 层级做一次材质侧统一配置。
 * 智能检测高反光 PBR 特征，保留 IBL 反射并提升可读性；
 * 其他材质关闭 skybox，依赖光+ambient 保持可读性。
 */
function configurePlacedMeshMaterials(root: Entity): void {
    const visit = (node: Entity) => {
        const render = node.render;
        const instances = render?.meshInstances;
        if (!instances?.length) {
            for (const child of node.children as Entity[]) {
                visit(child);
            }
            return;
        }

        for (const mi of instances as any[]) {
            const mat = mi?.material as PBRMaterial | undefined;
            if (!(mat instanceof StandardMaterial)) continue;

            if (isHighReflectivePBRMaterial(mat)) {
                applyPBRBrightnessBoost(mat);
            } else {
                mat.useSkybox = true;
            }
            mat.update();
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
    entity.addComponent('gsplat', { unified: true, asset, castShadows: false });
    const material = entity.gsplat!.unified ? app.scene.gsplat.material : entity.gsplat!.material;
    // 尽量与主场景 gsplat 的配置保持一致，开启 AA 并设置 alphaClip
    material.setDefine('GSPLAT_AA', true);
    material.setParameter('alphaClip', 1 / 255);
    entity.setPosition(position);
    configurePlacedGaussianPickLayer(app, entity);
    return entity;
}

function resumeShadowAfterStableFrames(global: Global, resume: () => void): void {
    let stableFrames = 0;
    const wait = () => {
        if (!global.state.readyToRender) {
            global.app.once('frameend', wait);
            (global.app as { renderNextFrame?: boolean }).renderNextFrame = true;
            return;
        }
        stableFrames += 1;
        if (stableFrames < 2) {
            global.app.once('frameend', wait);
            (global.app as { renderNextFrame?: boolean }).renderNextFrame = true;
            return;
        }
        resume();
    };
    global.app.once('frameend', wait);
    (global.app as { renderNextFrame?: boolean }).renderNextFrame = true;
}

async function instantiateVideo(
    app: AppBase,
    item: AssetLibraryItem,
    position: Vec3,
    loadMode: 'placement' | 'restore' = 'restore',
    horizontalCurvature: number = 0
): Promise<Entity> {
    const url = item.url || item.filename;
    if (!url) {
        throw new Error('video asset has no url');
    }
    let video: HTMLVideoElement;
    let texture;
    if (loadMode === 'placement') {
        video = await acquirePlacedVideoForPlacement(url, PLACED_VIDEO_PLACEMENT_TIMEOUT_MS);
        texture = createPlacedVideoTextureFromVideo(app, video, `placed-video-${item.id}`);
    } else {
        video = document.createElement('video');
        texture = await initPlacedVideoTexture(
            app,
            video,
            url,
            `placed-video-${item.id}`,
            PLACED_VIDEO_INITIAL_LOAD_TIMEOUT_MS
        );
    }

    const w = Math.max(2, video.videoWidth || 1280);
    const h = Math.max(2, video.videoHeight || 720);
    const aspect = w / h;

    const mat = new StandardMaterial();
    // 与图片资产一致：近似 unlit 卡片 + alpha 通道走 cutout，避免与 gsplat 混合排序问题。
    mat.useLighting = false;
    mat.diffuse.set(0, 0, 0);
    mat.emissiveMap = texture;
    mat.emissive.set(1, 1, 1);
    mat.opacityMap = texture;
    mat.opacityMapChannel = 'a';
    mat.blendType = BLEND_NONE;
    mat.alphaTest = 0.5;
    mat.cull = CULLFACE_NONE;
    mat.update();

    const curvature = clampVideoHorizontalCurvature(horizontalCurvature);
    const mesh = createCurvedBillboardMesh(app.graphicsDevice, curvature);
    const meshInstance = new MeshInstance(mesh, mat);
    meshInstance.cull = false;

    const entity = new Entity(item.name || 'video');
    entity.addComponent('render', {
        meshInstances: [meshInstance],
        castShadows: false,
        receiveShadows: false
    });
    entity.setPosition(position);
    const base = 2;
    entity.setLocalScale(base * aspect, base, 1);
    applyDefaultPlaneCardOrientation(entity);

    const runtime: PlacedMediaRuntime = {
        kind: 'video',
        videoEl: video,
        texture,
        isLive: false,
        horizontalCurvature: curvature
    };
    setPlacedMediaRuntime(entity, runtime);
    // 纹理已 setSource(video) 并停在首帧；热区内 play + texture.upload() 轮询。

    entity.on('destroy', () => {
        unmountPlacedVideoFromDom(video);
        try {
            texture.destroy();
        } catch {
            // ignore
        }
    });

    return entity;
}

async function instantiateAudio(app: AppBase, item: AssetLibraryItem, position: Vec3): Promise<Entity> {
    const url = item.url || item.filename;
    if (!url) {
        throw new Error('audio asset has no url');
    }
    const audio = document.createElement('audio');
    audio.preload = 'auto';
    audio.loop = true;
    audio.src = url;

    const root = new Entity(item.name || 'audio');
    root.setPosition(position);

    // 音频 callout 在 HotspotBase/Overlay；场景 Picker 仅扫 World 层，需不可见拾取体才能选中与挂 Gizmo。
    const pickMat = new StandardMaterial();
    pickMat.useLighting = false;
    pickMat.diffuse = Color.BLACK;
    pickMat.opacity = 0.001;
    pickMat.alphaTest = 0;
    pickMat.depthWrite = false;
    pickMat.blendType = BLEND_NONE;
    pickMat.cull = CULLFACE_NONE;
    pickMat.update();
    const pickRadius = AUDIO_CALLOUT_WORLD_H * 0.45;
    const pickLayer = getSceneAssetPickLayer(app);
    root.addComponent('render', {
        type: 'sphere',
        material: pickMat,
        layers: [pickLayer.id],
        castShadows: false,
        receiveShadows: false
    });
    root.setLocalScale(pickRadius, pickRadius, pickRadius);

    setPlacedMediaRuntime(root, { kind: 'audio', audioEl: audio });
    root.on('destroy', () => {
        try {
            audio.pause();
            audio.removeAttribute('src');
            audio.load();
        } catch {
            // ignore
        }
    });

    return root;
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

/**
 * 更新已放置视频资产的横向曲度（绕竖直轴 / 屏幕宽度方向）。
 * @returns 是否成功找到并更新 video 实例
 */
export function applyVideoHorizontalCurvature(
    global: Global,
    sceneAssetId: string,
    curvature: number,
    deps?: Pick<AssetPlacementHandlerDeps, 'pushEditHistory'>
): boolean {
    const entry = global.state.scenePlacedEntities?.find(
        (it) => it?.id === sceneAssetId && it.assetType === 'video'
    );
    if (!entry?.entity) return false;

    const runtime = getPlacedMediaRuntime(entry.entity);
    if (!runtime || runtime.kind !== 'video') return false;

    const clamped = clampVideoHorizontalCurvature(curvature);
    rebuildVideoRenderMesh(entry.entity, clamped);
    runtime.horizontalCurvature = clamped;
    entry.horizontalCurvature = clamped;
    deps?.pushEditHistory?.(global, 'video curvature');
    return true;
}

export async function placeAsset(
    global: Global,
    item: AssetLibraryItem,
    worldPos: Vec3,
    alignCenterToCameraHeight: boolean = false,
    opts?: { videoLoadMode?: 'placement' | 'restore'; horizontalCurvature?: number }
): Promise<ScenePlacedItem | null> {
    const { app, state, events } = global;
    if (!state.scenePlacedEntities) state.scenePlacedEntities = [];

    const parent = getPlacedAssetsParent(app);
    let entity: Entity;
    let resumeShadowAfterGaussianLoad: (() => void) | null = null;

    try {
        if (item.type === 'image') {
            entity = await instantiateImage(app, item, worldPos);
        } else if (item.type === 'mesh') {
            entity = await instantiateMesh(app, item, worldPos);
        } else if (item.type === 'gaussian') {
            resumeShadowAfterGaussianLoad = suspendShadowPipelineForGsplatLoad(global);
            if (!item.asset?.loaded) {
                const waitAssetLoaded = new Promise<void>((resolve, reject) => {
                    const onLoad = () => {
                        item.asset?.off('error', onError);
                        resolve();
                    };
                    const onError = (err: unknown) => {
                        item.asset?.off('load', onLoad);
                        reject(err);
                    };
                    item.asset!.once('load', onLoad);
                    item.asset!.once('error', onError);
                });
                await withTimeout(waitAssetLoaded, ASSET_LOAD_TIMEOUT_MS, 'gaussian asset load');
            }
            entity = await instantiateGaussian(app, item, worldPos);
        } else if (item.type === 'video') {
            entity = await instantiateVideo(
                app,
                item,
                worldPos,
                opts?.videoLoadMode ?? 'restore',
                opts?.horizontalCurvature ?? 0
            );
        } else if (item.type === 'audio') {
            entity = await instantiateAudio(app, item, worldPos);
        } else {
            return null;
        }
    } catch (err) {
        resumeShadowAfterGaussianLoad?.();
        console.warn('[AssetPlacement] instantiate failed:', err);
        events.fire('assetPlacement:error', { item, error: err });
        return null;
    }

    parent.addChild(entity);

    if (item.type === 'mesh') {
        configurePlacedMeshMaterials(entity);
    }

    if (item.type !== 'audio') {
        applyPlacedEntityYawToFaceCamera(entity, global, item.type);
    }

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
    const videoRuntime =
        item.type === 'video' ? (getPlacedMediaRuntime(entity) as PlacedVideoRuntime | undefined) : undefined;
    const entry: ScenePlacedItem = {
        id: nextSceneEntityId(),
        name: item.name || entity.name || '资产',
        entity,
        visible: true,
        assetType: item.type,
        assetId: item.id,
        filename: item.filename,
        url: item.url,
        thumbnailUrl: item.thumbnailUrl,
        horizontalCurvature: videoRuntime?.horizontalCurvature,
        triggerDistanceM: defaultTriggerDistanceMForAssetType(item.type)
    };
    state.scenePlacedEntities.push(entry);

    if (item.type === 'gaussian' || item.type === 'mesh') {
        syncGsplatShadowCastingFromSettings(global);
    }

    events.fire('sceneAssets:added', entry);
    if (resumeShadowAfterGaussianLoad) {
        resumeShadowAfterStableFrames(global, resumeShadowAfterGaussianLoad);
    }
    return entry;
}

/**
 * 协议放置时，asset-facade 已预加载资产，这里仅做校验和兜底。
 * 对于从 settings 恢复的链路，仍需处理 asset 缺失的情况。
 */
async function hydrateProtocolPlaceItem(global: Global, item: AssetLibraryItem): Promise<AssetLibraryItem | null> {
    const url = item.url || item.filename;
    if (!url && item.type !== 'image') {
        console.warn('[AssetPlacement] protocol place missing url for', item.type);
        return null;
    }
    try {
        return await hydrateAssetLibraryItem(global, item, ASSET_LOAD_TIMEOUT_MS);
    } catch (err) {
        console.warn('[AssetPlacement] protocol asset hydrate failed:', item.type, url ?? '-', err);
        return null;
    }
}

function sceneAssetSourceFingerprint(sa: Pick<SceneAsset, 'source'>): string {
    const s = sa.source ?? {};
    return `${s.assetId ?? ''}|${s.url ?? ''}|${s.filename ?? ''}`;
}

function placedItemSourceFingerprint(entry: ScenePlacedItem): string {
    return `${entry.assetId ?? ''}|${entry.url ?? ''}|${entry.filename ?? ''}`;
}

function canReuseScenePlacedEntry(entry: ScenePlacedItem, sa: SceneAsset): boolean {
    return entry.assetType === sa.type
        && placedItemSourceFingerprint(entry) === sceneAssetSourceFingerprint(sa);
}

/** 将 settings 中记录的变换、可见性、缩略图等应用到已存在的放置实体（不重新加载资产）。 */
function applySceneAssetTransformToEntry(global: Global, entry: ScenePlacedItem, sa: SceneAsset): void {
    const rotArr = (sa.transform?.rotation ?? [0, 0, 0]) as number[];
    const rotQuatArr = sa.transform?.rotationQuat as number[] | undefined;
    const scaleArr = (sa.transform?.scale ?? [1, 1, 1]) as number[];
    const mirrorArr = sa.transform?.mirror as number[] | undefined;

    if (sa.name) {
        entry.name = sa.name;
    }
    if (typeof sa.thumbnailUrl === 'string' && sa.thumbnailUrl.length > 0) {
        entry.thumbnailUrl = sa.thumbnailUrl;
    }

    const hasValidQuat =
        Array.isArray(rotQuatArr)
        && rotQuatArr.length >= 4
        && Number.isFinite(rotQuatArr[0])
        && Number.isFinite(rotQuatArr[1])
        && Number.isFinite(rotQuatArr[2])
        && Number.isFinite(rotQuatArr[3]);
    if (hasValidQuat) {
        entry.entity.setLocalRotation(
            rotQuatArr[0],
            rotQuatArr[1],
            rotQuatArr[2],
            rotQuatArr[3]
        );
    } else {
        entry.entity.setEulerAngles(rotArr[0] ?? 0, rotArr[1] ?? 0, rotArr[2] ?? 0);
    }
    const resolveMirroredScale = (value: number, mirror: number | undefined): number => {
        const numeric = Number.isFinite(value) ? value : 1;
        if (mirror === -1 || mirror === 1) {
            if (numeric === 0) return 0;
            return Math.abs(numeric) * mirror;
        }
        return numeric;
    };
    entry.entity.setLocalScale(
        resolveMirroredScale(scaleArr[0] ?? 1, mirrorArr?.[0]),
        resolveMirroredScale(scaleArr[1] ?? 1, mirrorArr?.[1]),
        resolveMirroredScale(scaleArr[2] ?? 1, mirrorArr?.[2])
    );

    const visible = sa.visible !== false;
    entry.visible = visible;
    const morphOwner = findAssetMorphOwnerTargetId(global.settings as ExperienceSettings, entry.id);
    entry.entity.enabled = visible && (global.state.editMode === true || !morphOwner || morphOwner === entry.id);

    if (sa.type === 'video') {
        const curvature =
            typeof sa.transform?.horizontalCurvature === 'number'
                ? sa.transform.horizontalCurvature
                : 0;
        applyVideoHorizontalCurvature(global, entry.id, curvature);
    }

    if (sa.type === 'video' || sa.type === 'audio') {
        const dist =
            typeof sa.triggerDistanceM === 'number' && Number.isFinite(sa.triggerDistanceM) && sa.triggerDistanceM > 0
                ? sa.triggerDistanceM
                : defaultTriggerDistanceMForAssetType(sa.type);
        if (dist !== undefined) {
            entry.triggerDistanceM = dist;
            sa.triggerDistanceM = dist;
        }
    }
}

export { applySceneAssetTriggerDistanceM } from '../settings-serialize/settings-serialize-helper';

async function loadAndPlaceSceneAssetFromSettings(global: Global, sa: SceneAsset): Promise<void> {
    const posArr = (sa.transform?.position ?? [0, 0, 0]) as number[];

    let item: AssetLibraryItem | null = null;
    try {
        item = await loadSceneAssetLibraryItem(global, sa, nextSceneEntityId, ASSET_LOAD_TIMEOUT_MS);
    } catch (err) {
        console.warn('[SceneAssets] restore asset failed:', sa?.type, err);
        return;
    }
    if (!item) return;

    const pos = new Vec3(posArr[0] ?? 0, posArr[1] ?? 0, posArr[2] ?? 0);
    const savedCurvature =
        sa.type === 'video' && typeof sa.transform?.horizontalCurvature === 'number'
            ? sa.transform.horizontalCurvature
            : 0;
    const entry = await placeAsset(global, item, pos, false, {
        ...(sa.type === 'video' ? { horizontalCurvature: savedCurvature } : {})
    });
    if (!entry) return;

    if (sa.id) {
        entry.id = sa.id;
    }
    applySceneAssetTransformToEntry(global, entry, sa);
    startRestoredAssetDefaultEffectIfConfigured(global, entry);
}

/**
 * View → Edit：按 settings 真源就地同步已放置实体，避免 clear+全量 reload 导致大资产闪灭。
 * 显隐/变换以 settings.sceneAssets 为准，不沿用 view 下仅改 runtime 的状态。
 */
export async function syncScenePlacedEntitiesFromSettings(global: Global): Promise<void> {
    const settings: any = global.settings as any;
    const sceneAssets: SceneAsset[] = Array.isArray(settings?.sceneAssets) ? settings.sceneAssets : [];
    const { state, events } = global;
    if (!state.scenePlacedEntities) state.scenePlacedEntities = [];

    const settingsById = new Map<string, SceneAsset>();
    for (const sa of sceneAssets) {
        if (sa?.id) settingsById.set(sa.id, sa);
    }

    const matchedSettingIds = new Set<string>();
    const toRemove: ScenePlacedItem[] = [];

    for (const entry of [...state.scenePlacedEntities]) {
        const sa = settingsById.get(entry.id);
        if (!sa || !canReuseScenePlacedEntry(entry, sa)) {
            entry.entity.destroy();
            toRemove.push(entry);
            continue;
        }
        matchedSettingIds.add(sa.id);
        const posArr = (sa.transform?.position ?? [0, 0, 0]) as number[];
        entry.entity.setLocalPosition(posArr[0] ?? 0, posArr[1] ?? 0, posArr[2] ?? 0);
        applySceneAssetTransformToEntry(global, entry, sa);
    }

    for (const entry of toRemove) {
        const idx = state.scenePlacedEntities!.indexOf(entry);
        if (idx >= 0) state.scenePlacedEntities!.splice(idx, 1);
        events.fire('sceneAssets:removed', entry);
    }

    if (
        state.selectedSceneEntityId
        && !state.scenePlacedEntities!.some((e) => e.id === state.selectedSceneEntityId)
    ) {
        state.selectedSceneEntityId = null;
        events.fire('sceneAsset:selected');
    }

    for (const sa of sceneAssets) {
        if (!sa?.id || matchedSettingIds.has(sa.id)) continue;
        await loadAndPlaceSceneAssetFromSettings(global, sa);
    }
}

/**
 * 从 settings.sceneAssets 还原场景中的资产实体，并写入 state.scenePlacedEntities。
 * 支持 image / mesh / gaussian，使用 source.url / source.filename 重新加载资产。
 */
export async function restoreSceneAssetsFromSettings(global: Global): Promise<void> {
    const settings: any = global.settings as any;
    const sceneAssets: SceneAsset[] | undefined = settings.sceneAssets;
    if (!Array.isArray(sceneAssets) || sceneAssets.length === 0) return;

    const { state } = global;
    if (!state.scenePlacedEntities) state.scenePlacedEntities = [];

    for (const sa of sceneAssets) {
        await loadAndPlaceSceneAssetFromSettings(global, sa);
    }
}

/**
 * 统一调度 sceneAssets → scenePlacedEntities 的恢复链路：
 * - startup 可选择 defer 到 revealComplete；
 * - edit-enter 默认就地 sync（不 clear），避免大资产闪灭；discard/history 仍全量 clear+restore；
 * - 后续 edit/discard/history restore 会提升 version，使旧的 startup defer 自动失效；
 * - 所有实际恢复都串行执行，避免与其他 restore 链并发交错。
 */
export async function requestSceneAssetsRestore(global: Global, options: SceneAssetsRestoreOptions = {}): Promise<void> {
    const controller = getSceneAssetsRestoreController(global);
    const version = controller.version + 1;
    controller.version = version;

    const clearBeforeRestore =
        options.clearBeforeRestore ?? (options.reason !== 'edit-enter');

    const invoke = async (): Promise<void> => {
        const previousTask = controller.activePromise;
        const task = (async (): Promise<void> => {
            await previousTask.catch((): void => undefined);
            if (controller.version !== version) return;
            if (clearBeforeRestore) {
                clearScenePlacedEntities(global);
                await restoreSceneAssetsFromSettings(global);
            } else {
                await syncScenePlacedEntitiesFromSettings(global);
            }
            applyMorphKeyframeVisibilityPolicy(global);
            syncGsplatShadowCastingFromSettings(global);
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

function applySceneAssetSelectedFromScenePick(
    global: Global,
    entryId: string,
    options: { focusOnChange: boolean }
): void {
    const { state, events } = global;
    const prevSelectedId = state.selectedSceneEntityId;
    state.selectedSceneEntityId = entryId;
    events.fire('sceneAsset:selected', { source: 'scene' });
    if (options.focusOnChange && prevSelectedId !== entryId) {
        requestAnimationFrame(() => {
            events.fire('inputEvent', 'frame', { focusTarget: 'asset' as const });
        });
    }
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
    let videoPreloadHandle: VideoPlacementPreloadHandle | null = null;
    let videoPreloadReady = true;
    let detachPointerClickClaimHandler: (() => void) | null = null;

    const isValidPlacementWorldPos = (pos: Vec3): boolean => {
        if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y) || !Number.isFinite(pos.z)) return false;
        const farClip = Number(camera.camera?.farClip ?? 0);
        if (Number.isFinite(farClip) && farClip > 0) {
            const dist = pos.distance(camera.getPosition());
            // 未命中时 depth pick 常退化到远裁剪面附近点，过滤掉这类“伪命中”。
            if (dist >= farClip * 0.995) {
                console.warn('[AssetPlacement] reject worldPos near farClip', {
                    worldPos: [pos.x, pos.y, pos.z],
                    distance: dist,
                    farClip
                });
                return false;
            }
        }
        return true;
    };

    const syncVideoPlacementCursor = () => {
        if (!pendingPlacement) return;
        if (pendingPlacement.value.type !== 'video') {
            setPlacementCursorActive(global, true, { loading: false });
            return;
        }
        setPlacementCursorActive(global, true, {
            loading: pendingPlacementInFlight || !videoPreloadReady
        });
    };

    const clearPendingPlacement = () => {
        cancelVideoPlacementPreload();
        videoPreloadHandle = null;
        videoPreloadReady = true;
        pendingPlacement = null;
        pendingPlacementInFlight = false;
        setPlacementCursorActive(global, false);
    };

    const handleAssetPointerClickClaim = (clientX: number, clientY: number, worldPos: Vec3 | null): boolean => {
        const pickEventOnly = isAssetScenePickEventOnlyMode(state);
        const morphAssetAdd = isMorphAssetAddPickMode(state);
        const inAssetModule = !pickEventOnly && state.editMode && state.editLeftModule === 'asset';
        const editAsset = inAssetModule && !morphAssetAdd;
        if (!pickEventOnly && !inAssetModule) return false;
        if (state.suppressAssetPointerClick) {
            state.suppressAssetPointerClick = false;
            return false;
        }
        if (state.gizmoPointerActive || hitSceneGizmoAtClient(global, clientX, clientY)) {
            return false;
        }
        const rect = canvas.getBoundingClientRect();
        const offsetX = clientX - rect.left;
        const offsetY = clientY - rect.top;
        if (offsetX < 0 || offsetY < 0 || offsetX > rect.width || offsetY > rect.height) return false;

        if (editAsset && pendingPlacement) {
            if (pendingPlacementInFlight) return true;
            pendingPlacementInFlight = true;
            syncVideoPlacementCursor();
            void (async () => {
                try {
                    if (!worldPos) {
                        console.warn('[AssetPlacement] world pick miss (worldPos=null), ignore placement click');
                        return;
                    }
                    if (!isValidPlacementWorldPos(worldPos)) {
                        console.warn('[AssetPlacement] invalid worldPos, ignore placement click', {
                            worldPos: [worldPos.x, worldPos.y, worldPos.z]
                        });
                        return;
                    }
                    const payload = pendingPlacement;
                    if (!payload) {
                        console.warn('[AssetPlacement] pendingPlacement lost before placement');
                        return;
                    }
                    const hydrated = await hydrateProtocolPlaceItem(global, payload.value);
                    if (!hydrated) {
                        console.warn('[AssetPlacement] hydrateProtocolPlaceItem failed');
                        return;
                    }
                    const entry = await placeAsset(global, hydrated, worldPos, false, {
                        videoLoadMode: hydrated.type === 'video' ? 'placement' : 'restore'
                    });
                    if (!entry) {
                        console.warn('[AssetPlacement] placeAsset returned null');
                        return;
                    }
                    if (typeof payload.sceneEntityId === 'string' && payload.sceneEntityId.trim().length > 0) {
                        entry.id = payload.sceneEntityId;
                    }
                    state.selectedSceneEntityId = entry.id;
                    events.fire('sceneAsset:placed', { id: entry.id, source: 'scene' });
                    console.debug('[AssetPlacement] placed', {
                        id: entry.id,
                        worldPos: [worldPos.x, worldPos.y, worldPos.z],
                        source: 'scene'
                    });
                    applySceneAssetSelectedFromScenePick(global, entry.id, { focusOnChange: true });
                    deps.pushEditHistory?.(global, 'place asset');
                    clearPendingPlacement();
                } catch (error) {
                    console.error('[AssetPlacement] placement flow error', error);
                } finally {
                    pendingPlacementInFlight = false;
                    syncVideoPlacementCursor();
                }
            })();
            return true;
        }

        const list = state.scenePlacedEntities ?? [];
        if (list.length === 0) return inAssetModule;

        const pickableList = pickEventOnly
            ? list.filter((entry) => isSceneAssetPickableInViewerMode(entry.assetType))
            : list;
        if (pickEventOnly && pickableList.length === 0) return false;

        if (editAsset) {
            const audioSelect = findAudioCalloutSelectHitFromClient(global, clientX, clientY);
            if (audioSelect) {
                applySceneAssetSelectedFromScenePick(global, audioSelect.id, { focusOnChange: true });
                return true;
            }
        }

        const gaussianList = morphAssetAdd
            ? list.filter((entry) => entry.assetType === 'gaussian')
            : list;
        if (morphAssetAdd && gaussianList.length === 0) return true;

        const pickerScale = 0.5;
        const pickW = Math.max(1, Math.floor(width() * pickerScale));
        const pickH = Math.max(1, Math.floor(height() * pickerScale));
        const pickX = Math.floor((offsetX / rect.width) * pickW);
        const pickY = Math.floor((offsetY / rect.height) * pickH);

        if (!sceneAssetPicker) {
            sceneAssetPicker = new (pc as any).Picker(app, pickW, pickH, false);
        }
        sceneAssetPicker.resize(pickW, pickH);

        void pickScenePlacedEntryAtScreen(
            global,
            app,
            camera,
            sceneAssetPicker,
            pickX,
            pickY,
            clientX,
            clientY
        ).then((entry) => {
            if (!entry) return;
            if (pickEventOnly && !isSceneAssetPickableInViewerMode(entry.assetType)) return;
            if (morphAssetAdd && entry.assetType !== 'gaussian') return;
            applySceneAssetSelectedFromScenePick(global, entry.id, { focusOnChange: inAssetModule });
        }).catch(() => {});
        return inAssetModule;
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
        if (entry.assetType === 'gaussian') {
            configurePlacedGaussianPickLayer(app, clone);
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
        const resumeShadowAfterGaussianClone = entry.assetType === 'gaussian'
            ? suspendShadowPipelineForGsplatLoad(global)
            : null;
        state.scenePlacedEntities!.push(newEntry);
        state.selectedSceneEntityId = newEntry.id;
        if (entry.assetType === 'gaussian' || entry.assetType === 'mesh') {
            syncGsplatShadowCastingFromSettings(global);
        }
        events.fire('sceneAssets:added', newEntry);
        if (resumeShadowAfterGaussianClone) {
            resumeShadowAfterStableFrames(global, resumeShadowAfterGaussianClone);
        }
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

    const inputArbiter = (global as Global & { __inputArbiter?: InputArbiter }).__inputArbiter;
    if (inputArbiter) {
        detachPointerClickClaimHandler = inputArbiter.registerPointerClickHandler({
            id: 'asset.placement-and-selection',
            priority: 120,
            handle: ({ clientX, clientY, worldPosition }) => handleAssetPointerClickClaim(clientX, clientY, worldPosition)
        });
    }
    const onPlaceStart = (payload: { value: AssetLibraryItem; sceneEntityId?: string }) => {
        cancelVideoPlacementPreload();
        videoPreloadHandle = null;
        videoPreloadReady = true;
        pendingPlacement = payload;
        pendingPlacementInFlight = false;

        const item = payload.value;
        if (item.type === 'video') {
            const url = item.url || item.filename;
            if (!url) {
                setPlacementCursorActive(global, true, { loading: false });
                return;
            }
            videoPreloadReady = false;
            setPlacementCursorActive(global, true, { loading: true });
            videoPreloadHandle = startVideoPlacementPreload(url);
            void videoPreloadHandle.ready
                .then(() => {
                    videoPreloadReady = true;
                    if (pendingPlacement?.value?.id === item.id) {
                        syncVideoPlacementCursor();
                    }
                })
                .catch(() => {
                    videoPreloadReady = true;
                    if (pendingPlacement?.value?.id === item.id) {
                        syncVideoPlacementCursor();
                    }
                });
            return;
        }

        setPlacementCursorActive(global, true, { loading: false });
    };

    const onSceneAssetRemoved = (entry: ScenePlacedItem) => {
        removeSceneAssetFromSettings(global, entry.id);
    };

    const onVideoCurvature = (payload: { id?: string; value?: number }) => {
        if (typeof payload?.id !== 'string' || typeof payload?.value !== 'number') return;
        applyVideoHorizontalCurvature(global, payload.id, payload.value, deps);
    };

    const onMorphAssetAddActiveChanged = (active: boolean) => {
        if (!active || !pendingPlacement) return;
        cancelVideoPlacementPreload();
        videoPreloadHandle = null;
        videoPreloadReady = true;
        pendingPlacement = null;
        pendingPlacementInFlight = false;
    };

    events.on('assetEdit:copy', onCopy);
    events.on('assetEdit:delete', onDelete);
    events.on('assetEdit:videoCurvature', onVideoCurvature);
    events.on('assetPlacement:start', onPlaceStart);
    events.on('assetFacade:exit', clearPendingPlacement);
    events.on('assetFacade:editModeExit', clearPendingPlacement);
    events.on('morphAssetAddActive:changed', onMorphAssetAddActiveChanged);
    events.on('sceneAssets:removed', onSceneAssetRemoved);

    return () => {
        detachPointerClickClaimHandler?.();
        detachPointerClickClaimHandler = null;
        if (sceneAssetPicker) {
            sceneAssetPicker.destroy();
            sceneAssetPicker = null;
        }
        events.off('assetEdit:copy', onCopy);
        events.off('assetEdit:delete', onDelete);
        events.off('assetEdit:videoCurvature', onVideoCurvature);
        events.off('assetPlacement:start', onPlaceStart);
        events.off('assetFacade:exit', clearPendingPlacement);
        events.off('assetFacade:editModeExit', clearPendingPlacement);
        events.off('morphAssetAddActive:changed', onMorphAssetAddActiveChanged);
        events.off('sceneAssets:removed', onSceneAssetRemoved);
    };
}
