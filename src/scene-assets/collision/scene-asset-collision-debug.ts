import {
    BLEND_NORMAL,
    BoundingBox,
    Color,
    Entity,
    Layer,
    Mesh,
    MeshInstance,
    PRIMITIVE_LINES,
    StandardMaterial,
    type AppBase
} from 'playcanvas';

import type { Global } from '../../types';
import { getSceneAssetCollisionRuntime, readSceneAssetCollisionRuntimeState } from './scene-asset-collision';

const DEBUG_BOX_COLOR = new Color(0.2, 0.95, 0.45);

const CORNERS_PER_BOX = 8;

function buildBoxCornerPositions(bbox: BoundingBox): number[] {
    const min = bbox.getMin();
    const max = bbox.getMax();
    return [
        min.x, min.y, min.z,
        max.x, min.y, min.z,
        max.x, min.y, max.z,
        min.x, min.y, max.z,
        min.x, max.y, min.z,
        max.x, max.y, min.z,
        max.x, max.y, max.z,
        min.x, max.y, max.z
    ];
}

const BOX_LINE_INDICES = [
    0, 1, 1, 2, 2, 3, 3, 0,
    4, 5, 5, 6, 6, 7, 7, 4,
    0, 4, 1, 5, 2, 6, 3, 7
];

function buildMultiBoxLineMesh(boxes: BoundingBox[]): { positions: number[]; indices: number[] } {
    const positions: number[] = [];
    const indices: number[] = [];
    for (let i = 0; i < boxes.length; i++) {
        const vertexBase = i * CORNERS_PER_BOX;
        positions.push(...buildBoxCornerPositions(boxes[i]));
        for (const index of BOX_LINE_INDICES) {
            indices.push(vertexBase + index);
        }
    }
    return { positions, indices };
}

function mergeBoundingBoxes(boxes: BoundingBox[]): BoundingBox | null {
    if (boxes.length === 0) return null;
    const min = boxes[0].getMin().clone();
    const max = boxes[0].getMax().clone();
    for (let i = 1; i < boxes.length; i++) {
        min.min(boxes[i].getMin());
        max.max(boxes[i].getMax());
    }
    const center = min.clone().add(max).mulScalar(0.5);
    const half = max.clone().sub(min).mulScalar(0.5);
    return new BoundingBox(center, half);
}

function ensureDebugBoundsLayer(app: AppBase, cameraEntity: Entity | null): number {
    const layers = app.scene.layers;
    let layer = layers.getLayerByName('DebugBounds');
    if (!layer) {
        layer = new Layer({ name: 'DebugBounds' });
        layers.push(layer);
    }

    const cam = cameraEntity?.camera;
    if (cam && cam.layers.indexOf(layer.id) < 0) {
        cam.layers = [...cam.layers, layer.id];
    }

    return layer.id;
}

/**
 * 放置资产碰撞 AABB 线框（DebugBounds 层），用于核对碰撞体与穿模问题。
 */
export class SceneAssetCollisionDebugVisual {
    private lineEntity: Entity | null = null;

    private mesh: Mesh | null = null;

    private layerId: number | null = null;

    constructor(private readonly global: Global) {}

    setVisible(visible: boolean): void {
        if (this.lineEntity) {
            this.lineEntity.enabled = visible;
        }
        if (visible) {
            this.sync();
        }
    }

    isVisible(): boolean {
        return readSceneAssetCollisionRuntimeState(this.global).debugVisual;
    }

    sync(): void {
        const { app } = this.global;
        const wantVisible = readSceneAssetCollisionRuntimeState(this.global).debugVisual;
        const runtime = getSceneAssetCollisionRuntime(this.global);
        const boxes = runtime.getDebugBoundingBoxes();

        if (!wantVisible || boxes.length === 0) {
            if (this.lineEntity) {
                this.lineEntity.enabled = false;
            }
            return;
        }

        this.ensureEntity(app);
        this.updateMesh(boxes);
        if (this.lineEntity) {
            this.lineEntity.enabled = true;
        }
    }

    destroy(): void {
        if (this.lineEntity) {
            this.lineEntity.destroy();
            this.lineEntity = null;
        }
        this.mesh = null;
        this.layerId = null;
    }

    private ensureEntity(app: AppBase): void {
        if (this.lineEntity && this.mesh) return;

        this.layerId = ensureDebugBoundsLayer(app, this.global.camera ?? null);

        const positions = buildBoxCornerPositions(new BoundingBox());
        const mesh = new Mesh(app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setIndices(BOX_LINE_INDICES);
        mesh.update(PRIMITIVE_LINES);
        this.mesh = mesh;

        const material = new StandardMaterial();
        material.diffuse = DEBUG_BOX_COLOR;
        material.emissive = DEBUG_BOX_COLOR;
        material.emissiveIntensity = 0.85;
        material.opacity = 0.95;
        material.blendType = BLEND_NORMAL;
        material.depthWrite = false;
        material.depthTest = false;
        material.update();

        const lineEntity = new Entity('sceneAssetCollisionAabbDebug');
        lineEntity.addComponent('render', {
            type: 'asset',
            layers: [this.layerId],
            meshInstances: [new MeshInstance(mesh, material)]
        });
        const renderComponent = lineEntity.render;
        if (renderComponent) {
            renderComponent.castShadows = false;
            renderComponent.receiveShadows = false;
        }

        app.root.addChild(lineEntity);
        this.lineEntity = lineEntity;
    }

    private updateMesh(boxes: BoundingBox[]): void {
        if (!this.mesh) return;
        const { positions, indices } = buildMultiBoxLineMesh(boxes);
        this.mesh.setPositions(positions);
        this.mesh.setIndices(indices);
        this.mesh.update(PRIMITIVE_LINES);
        const instances = this.lineEntity?.render?.meshInstances;
        const merged = mergeBoundingBoxes(boxes);
        if (instances?.[0] && merged) {
            instances[0].aabb = merged;
        }
    }
}

const DEBUG_KEY = '__sceneAssetCollisionDebugVisual';

export function getSceneAssetCollisionDebugVisual(global: Global): SceneAssetCollisionDebugVisual {
    const g = global as Global & { [DEBUG_KEY]?: SceneAssetCollisionDebugVisual };
    if (!g[DEBUG_KEY]) {
        g[DEBUG_KEY] = new SceneAssetCollisionDebugVisual(global);
    }
    return g[DEBUG_KEY];
}

export function initSceneAssetCollisionDebug(global: Global): () => void {
    const visual = getSceneAssetCollisionDebugVisual(global);
    const { events, app } = global;

    const sync = () => visual.sync();
    const onUpdate = () => {
        if (visual.isVisible()) {
            visual.sync();
        }
    };

    events.on('sceneAssetCollision:changed', sync);
    events.on('sceneAssetCollisionDebugVisual:changed', sync);
    events.on('sceneAssetCollisionRuntimeState:changed', sync);
    events.on('sceneAssets:added', sync);
    events.on('sceneAssets:removed', sync);
    events.on('sceneAssets:cleared', sync);
    events.on('sceneAsset:selected', sync);
    events.on('sceneAsset:collisionDirty', sync);
    events.on('editMode:changed', sync);
    events.on('previewMode:changed', sync);

    app.on('update', onUpdate);
    sync();

    return () => {
        events.off('sceneAssetCollision:changed', sync);
        events.off('sceneAssetCollisionDebugVisual:changed', sync);
        events.off('sceneAssetCollisionRuntimeState:changed', sync);
        events.off('sceneAssets:added', sync);
        events.off('sceneAssets:removed', sync);
        events.off('sceneAssets:cleared', sync);
        events.off('sceneAsset:selected', sync);
        events.off('sceneAsset:collisionDirty', sync);
        events.off('editMode:changed', sync);
        events.off('previewMode:changed', sync);
        app.off('update', onUpdate);
        visual.destroy();
        const g = global as Global & { [DEBUG_KEY]?: SceneAssetCollisionDebugVisual };
        delete g[DEBUG_KEY];
    };
}
