/**
 * 放置高斯 shadow-apply（B 管线）排除 mask。
 * 专用相机（priority 1）只渲染 PlacedMeshExclude 层到离屏 RT；
 * 放置高斯：gsplatPS 输出绿色（G=1，轮廓与 splat 一致）。
 * 放置 mesh / image / video 的 B 遮挡由 ShadowReceiverOccluder 深度预写处理，不再挂本层。
 * 主相机 layers 不含 PlacedMeshExclude。
 */
import {
    ADDRESS_CLAMP_TO_EDGE,
    Color,
    FILTER_NEAREST,
    Layer,
    PIXELFORMAT_DEPTH,
    PIXELFORMAT_RGBA8,
    RenderTarget,
    Texture,
    Entity,
    type AppBase,
    type Camera,
    type CameraComponent,
    type GraphicsDevice,
    type Material
} from 'playcanvas';

import type { Global } from '../../types';
import { applyGsplatExcludeMaskShaderToMaterial } from './gsplat-exclude-mask-shader';

const PLACED_MESH_EXCLUDE_LAYER_NAME = 'PlacedMeshExclude';

/** B 管线离屏 pass 共用的可采样深度纹理（与主相机同投影，深度值可比）。 */
export const createShadowPassDepthTexture = (
    device: GraphicsDevice,
    width: number,
    height: number,
    name: string
): Texture =>
    new Texture(device, {
        name,
        width,
        height,
        format: PIXELFORMAT_DEPTH,
        mipmaps: false,
        minFilter: FILTER_NEAREST,
        magFilter: FILTER_NEAREST,
        addressU: ADDRESS_CLAMP_TO_EDGE,
        addressV: ADDRESS_CLAMP_TO_EDGE
    });

let excludeLayerSingleton: Layer | null = null;

export function getPlacedMeshExcludeLayer(app: AppBase): Layer {
    if (excludeLayerSingleton) {
        return excludeLayerSingleton;
    }
    const layers = app.scene.layers;
    let layer = layers.getLayerByName(PLACED_MESH_EXCLUDE_LAYER_NAME) as Layer | null;
    if (!layer) {
        layer = new Layer({ name: PLACED_MESH_EXCLUDE_LAYER_NAME });
        layers.insert(layer, layers.layerList.length);
    }
    excludeLayerSingleton = layer;
    return layer;
}

export function countPlacedMeshes(global: Global): number {
    return (global.state.scenePlacedEntities ?? []).filter(
        (e) => e.assetType === 'mesh' && e.entity
    ).length;
}

export function countPlacedGaussians(global: Global): number {
    return (global.state.scenePlacedEntities ?? []).filter(
        (e) => e.assetType === 'gaussian' && e.entity
    ).length;
}

/** 需要 exclude mask 相机的放置资产（仅放置高斯）。 */
export function countPlacedExcludeAssets(global: Global): number {
    return countPlacedGaussians(global);
}

/**
 * 为放置高斯追加 PlacedMeshExclude 层，并从 render 资产上移除该层（避免历史残留）。
 * 主相机 layers 不含此层。
 */
export function syncPlacedMeshExcludeLayers(global: Global): void {
    const layer = getPlacedMeshExcludeLayer(global.app);
    const layerId = layer.id;

    const stripRenderExcludeLayer = (node: Entity) => {
        if (node.render) {
            const current = [...(node.render.layers as number[])];
            const filtered = current.filter((id) => id !== layerId);
            if (filtered.length !== current.length) {
                node.render.layers = filtered;
            }
        }
        node.children.forEach((child) => stripRenderExcludeLayer(child as Entity));
    };

    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (!entry.entity) continue;
        if (entry.assetType === 'mesh' || entry.assetType === 'image' || entry.assetType === 'video') {
            stripRenderExcludeLayer(entry.entity);
        } else if (entry.assetType === 'gaussian' && entry.entity.gsplat) {
            const current = [...(entry.entity.gsplat.layers as number[])];
            if (!current.includes(layerId)) {
                entry.entity.gsplat.layers = [...current, layerId];
            }
        }
    }
}

export class PlacedMeshExcludeMask {
    private _excludeTex: Texture | null = null;

    private _excludeDepthTex: Texture | null = null;

    private _excludeRt: RenderTarget | null = null;

    private _excludeCameraEntity: Entity | null = null;

    private _excludeCamComp: CameraComponent | null = null;

    private _excludeLayer: Layer | null = null;

    private _global: Global | null = null;

    private _inited = false;

    private _onGsplatMaterialCreated: ((material: Material, camera: Camera, layer: Layer) => void) | null =
        null;

    constructor(private readonly device: GraphicsDevice) {}

    /** exclude 相机 unified gsplat 材质就绪后 patch 为 mask-only 输出。 */
    refreshGsplatExcludeMaskMaterials(global: Global): void {
        if (!this._excludeCamComp || !this._excludeLayer) return;
        const mat = global.app.systems.gsplat.getMaterial(this._excludeCamComp.camera, this._excludeLayer);
        if (mat) {
            applyGsplatExcludeMaskShaderToMaterial(mat, this.device);
        }
    }

    init(global: Global): void {
        if (this._inited) return;
        this._global = global;
        const app = global.app;
        const layer = getPlacedMeshExcludeLayer(app);
        this._excludeLayer = layer;
        syncPlacedMeshExcludeLayers(global);
        this.ensureRenderTarget(this.device.width, this.device.height);

        const excludeCamEntity = new Entity('placedMeshExcludeCamera');
        excludeCamEntity.addComponent('camera', {
            clearColor: new Color(0, 0, 0, 1),
            projection: global.camera?.camera?.projection ?? 0,
            fov: global.camera?.camera?.fov ?? 45,
            nearClip: global.camera?.camera?.nearClip ?? 0.1,
            farClip: global.camera?.camera?.farClip ?? 1000
        });
        const camComp = excludeCamEntity.camera!;
        camComp.layers = [layer.id];
        camComp.priority = 1;
        camComp.renderTarget = this._excludeRt;
        excludeCamEntity.enabled = false;
        app.root.addChild(excludeCamEntity);
        this._excludeCameraEntity = excludeCamEntity;
        this._excludeCamComp = camComp;

        this._onGsplatMaterialCreated = (material, camera, layer) => {
            if (camera !== this._excludeCamComp?.camera || layer !== this._excludeLayer) return;
            applyGsplatExcludeMaskShaderToMaterial(material, this.device);
        };
        app.systems.gsplat.on('material:created', this._onGsplatMaterialCreated);

        this.refreshGsplatExcludeMaskMaterials(global);
        this._inited = true;
    }

    private ensureRenderTarget(width: number, height: number): RenderTarget {
        if (!this._excludeTex || !this._excludeRt) {
            this._excludeTex = new Texture(this.device, {
                name: 'placedMeshExcludeMask',
                width,
                height,
                format: PIXELFORMAT_RGBA8,
                mipmaps: false
            });
            this._excludeDepthTex = createShadowPassDepthTexture(
                this.device,
                width,
                height,
                'placedMeshExcludeDepth'
            );
            this._excludeRt = new RenderTarget({
                colorBuffer: this._excludeTex,
                depthBuffer: this._excludeDepthTex
            });
            if (this._excludeCamComp) {
                this._excludeCamComp.renderTarget = this._excludeRt;
            }
        } else if (this._excludeRt.width !== width || this._excludeRt.height !== height) {
            this._excludeRt.resize(width, height);
        }
        return this._excludeRt;
    }

    resize(width: number, height: number): void {
        if (this._excludeRt) {
            this.ensureRenderTarget(width, height);
        }
    }

    getTexture(): Texture | null {
        return this._excludeTex;
    }

    getDepthTexture(): Texture | null {
        return this._excludeDepthTex;
    }

    /** 本帧 exclude RT 已由专用相机写入，postrender 直接采样即可。 */
    isMaskReady(global: Global): boolean {
        return (
            this._inited
            && countPlacedExcludeAssets(global) > 0
            && this._excludeCameraEntity?.enabled === true
        );
    }

    syncFromMain(mainCamEntity: Entity): void {
        if (!this._excludeCameraEntity) return;
        this._excludeCameraEntity.setPosition(mainCamEntity.getPosition());
        this._excludeCameraEntity.setRotation(mainCamEntity.getRotation());
        const exCam = this._excludeCameraEntity.camera;
        const mainCam = mainCamEntity.camera;
        if (exCam && mainCam) {
            if (exCam.fov !== mainCam.fov) exCam.fov = mainCam.fov;
            if (exCam.nearClip !== mainCam.nearClip) exCam.nearClip = mainCam.nearClip;
            if (exCam.farClip !== mainCam.farClip) exCam.farClip = mainCam.farClip;
            if (exCam.projection !== mainCam.projection) exCam.projection = mainCam.projection;
        }
    }

    setOutputEnabled(outputEnabled: boolean, global: Global): void {
        if (!this._excludeCameraEntity) return;
        const active = outputEnabled && countPlacedExcludeAssets(global) > 0;
        this._excludeCameraEntity.enabled = active;
        if (active) {
            this.refreshGsplatExcludeMaskMaterials(global);
        }
    }
}
