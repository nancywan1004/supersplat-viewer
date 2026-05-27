/**
 * 放置 mesh 的 shadow-apply 排除 mask。
 * 专用相机（priority 1，主相机之后）只渲染 PlacedMeshExclude 层到离屏 RT；
 * 通过 scene prerender:layer / postrender:layer 仅在 exclude 层绘制时临时白模，主相机 World 层不受影响。
 */
import {
    BLEND_NONE,
    Color,
    Layer,
    PIXELFORMAT_RGBA8,
    RenderTarget,
    StandardMaterial,
    Texture,
    Entity,
    type AppBase,
    type CameraComponent,
    type GraphicsDevice,
    type MeshInstance
} from 'playcanvas';

import type { Global } from '../../types';

const PLACED_MESH_EXCLUDE_LAYER_NAME = 'PlacedMeshExclude';

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

/** 为放置 mesh 追加 PlacedMeshExclude 层；主相机 layers 不含此层。 */
export function syncPlacedMeshExcludeLayers(global: Global): void {
    const layer = getPlacedMeshExcludeLayer(global.app);
    const layerId = layer.id;

    const visit = (node: Entity) => {
        if (node.render) {
            const current = [...(node.render.layers as number[])];
            if (!current.includes(layerId)) {
                node.render.layers = [...current, layerId];
            }
        }
        node.children.forEach((child) => visit(child as Entity));
    };

    for (const entry of global.state.scenePlacedEntities ?? []) {
        if (entry.assetType !== 'mesh' || !entry.entity) continue;
        visit(entry.entity);
    }
}

function createMaskWriteMaterial(): StandardMaterial {
    const mat = new StandardMaterial();
    mat.useLighting = false;
    mat.useSkybox = false;
    mat.useFog = false;
    mat.useTonemap = false;
    mat.emissive.set(1, 1, 1);
    mat.diffuse.set(0, 0, 0);
    mat.specular.set(0, 0, 0);
    mat.blendType = BLEND_NONE;
    mat.depthWrite = true;
    mat.depthTest = true;
    mat.update();
    return mat;
}

export class PlacedMeshExcludeMask {
    private readonly _whiteMat: StandardMaterial;

    private readonly _savedMaterials = new WeakMap<object, object>();

    private _excludeTex: Texture | null = null;

    private _excludeRt: RenderTarget | null = null;

    private _excludeCameraEntity: Entity | null = null;

    private _excludeCamComp: CameraComponent | null = null;

    private _excludeLayer: Layer | null = null;

    private _global: Global | null = null;

    private _inited = false;

    constructor(private readonly device: GraphicsDevice) {
        this._whiteMat = createMaskWriteMaterial();
    }

    private readonly _onPrerenderLayer = (
        cam: CameraComponent,
        layer: Layer,
        _transparent: boolean
    ) => {
        if (!this._global || cam !== this._excludeCamComp || layer !== this._excludeLayer) {
            return;
        }
        this.setPlacedMeshMaterials(this._global, true);
    };

    private readonly _onPostrenderLayer = (
        cam: CameraComponent,
        layer: Layer,
        _transparent: boolean
    ) => {
        if (!this._global || cam !== this._excludeCamComp || layer !== this._excludeLayer) {
            return;
        }
        this.setPlacedMeshMaterials(this._global, false);
    };

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

        app.scene.on('prerender:layer', this._onPrerenderLayer);
        app.scene.on('postrender:layer', this._onPostrenderLayer);
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
            this._excludeRt = new RenderTarget({
                colorBuffer: this._excludeTex,
                depth: true
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

    /** 本帧 exclude RT 已由专用相机写入，postrender 直接采样即可。 */
    isMaskReady(global: Global): boolean {
        return (
            this._inited
            && countPlacedMeshes(global) > 0
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
        this._excludeCameraEntity.enabled = outputEnabled && countPlacedMeshes(global) > 0;
    }

    private setPlacedMeshMaterials(global: Global, useMaskMaterial: boolean): void {
        const visit = (node: Entity) => {
            const instances = node.render?.meshInstances as MeshInstance[] | undefined;
            if (instances?.length) {
                for (const mi of instances) {
                    if (useMaskMaterial) {
                        if (!this._savedMaterials.has(mi)) {
                            this._savedMaterials.set(mi, mi.material);
                        }
                        mi.material = this._whiteMat;
                    } else {
                        const orig = this._savedMaterials.get(mi);
                        if (orig) {
                            mi.material = orig as MeshInstance['material'];
                        }
                    }
                }
            }
            node.children.forEach((child) => visit(child as Entity));
        };

        for (const entry of global.state.scenePlacedEntities ?? []) {
            if (entry.assetType !== 'mesh' || !entry.entity) continue;
            visit(entry.entity);
        }
    }
}
