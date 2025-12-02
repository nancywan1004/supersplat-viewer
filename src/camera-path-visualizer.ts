import {
    type AppBase,
    Color,
    Entity,
    StandardMaterial,
    Vec3,
    MeshInstance,
    Mesh
} from 'playcanvas';

import { AnimTrack } from './settings';
import { CubicSpline } from './core/spline';

interface VisualizerOptions {
    pathColor?: Color;
    keyframeColor?: Color;
    directionColor?: Color;
    pathWidth?: number;
    keyframeSize?: number;
    directionLength?: number;
    showPath?: boolean;
    showKeyframes?: boolean;
    showDirections?: boolean;
    pathResolution?: number;
}

class CameraPathVisualizer {
    private app: AppBase;
    private rootEntity: Entity;
    private pathEntity: Entity | null = null;
    private keyframeEntities: Entity[] = [];
    private directionEntities: Entity[] = [];
    private options: Required<VisualizerOptions>;

    constructor(app: AppBase, options: VisualizerOptions = {}) {
        this.app = app;
        
        // Default options
        this.options = {
            pathColor: options.pathColor || new Color(0, 1, 1, 1),
            keyframeColor: options.keyframeColor || new Color(1, 0.5, 0, 1),
            directionColor: options.directionColor || new Color(1, 1, 0, 1),
            pathWidth: options.pathWidth || 0.05,
            keyframeSize: options.keyframeSize || 0.2,
            directionLength: options.directionLength || 1.0,
            showPath: options.showPath !== false,
            showKeyframes: options.showKeyframes !== false,
            showDirections: options.showDirections !== false,
            pathResolution: options.pathResolution || 100
        };

        // Create root entity
        this.rootEntity = new Entity('CameraPathVisualizer');
        this.app.root.addChild(this.rootEntity);
    }

    visualize(animTrack: AnimTrack) {
        this.clear();

        const { keyframes, duration, frameRate, smoothness } = animTrack;
        const { times, values } = keyframes;
        const { position, target } = values;

        // Build spline for smooth path
        const points: number[] = [];
        for (let i = 0; i < times.length; i++) {
            points.push(position[i * 3], position[i * 3 + 1], position[i * 3 + 2]);
            points.push(target[i * 3], target[i * 3 + 1], target[i * 3 + 2]);
        }

        const extra = (duration === times[times.length - 1] / frameRate) ? 1 : 0;
        const spline = CubicSpline.fromPointsLooping(
            (duration + extra) * frameRate,
            times,
            points,
            smoothness
        );

        // Visualize path
        if (this.options.showPath) {
            this.createPathLine(spline, duration * frameRate);
        }

        // Visualize keyframes
        if (this.options.showKeyframes) {
            for (let i = 0; i < times.length; i++) {
                const pos = new Vec3(
                    position[i * 3],
                    position[i * 3 + 1],
                    position[i * 3 + 2]
                );
                this.createKeyframeMarker(pos, i);
            }
        }

        // Visualize directions
        if (this.options.showDirections) {
            for (let i = 0; i < times.length; i++) {
                const pos = new Vec3(
                    position[i * 3],
                    position[i * 3 + 1],
                    position[i * 3 + 2]
                );
                const tgt = new Vec3(
                    target[i * 3],
                    target[i * 3 + 1],
                    target[i * 3 + 2]
                );
                this.createDirectionArrow(pos, tgt, i);
            }
        }
    }

    private createPathLine(spline: CubicSpline, totalFrames: number) {
        const resolution = this.options.pathResolution;
        const positions: number[] = [];
        const result: number[] = [];

        for (let i = 0; i <= resolution; i++) {
            const t = (i / resolution) * totalFrames;
            spline.evaluate(t, result);
            
            if (result.every(isFinite)) {
                positions.push(result[0], result[1], result[2]);
            }
        }

        // Create line mesh
        const mesh = this.createLineMesh(positions);
        
        // Create material
        const material = new StandardMaterial();
        material.diffuse = this.options.pathColor;
        material.emissive = this.options.pathColor;
        material.emissiveIntensity = 0.5;
        material.update();

        // Create entity
        this.pathEntity = new Entity('CameraPath');
        this.pathEntity.addComponent('render', {
            type: 'asset',
            meshInstances: [new MeshInstance(mesh, material)]
        });
        
        this.rootEntity.addChild(this.pathEntity);
    }

    private createLineMesh(positions: number[]): Mesh {
        const vertexCount = positions.length / 3;
        const indices: number[] = [];
        
        for (let i = 0; i < vertexCount - 1; i++) {
            indices.push(i, i + 1);
        }

        const mesh = new Mesh(this.app.graphicsDevice);
        mesh.setPositions(positions);
        mesh.setIndices(indices);
        mesh.update();

        return mesh;
    }

    private createKeyframeMarker(position: Vec3, index: number) {
        const material = new StandardMaterial();
        material.diffuse = this.options.keyframeColor;
        material.emissive = this.options.keyframeColor;
        material.emissiveIntensity = 0.7;
        material.update();

        const entity = new Entity(`Keyframe_${index}`);
        entity.addComponent('render', {
            type: 'sphere',
            material: material
        });
        
        const size = this.options.keyframeSize;
        entity.setLocalScale(size, size, size);
        entity.setPosition(position);

        this.rootEntity.addChild(entity);
        this.keyframeEntities.push(entity);
    }

    private createDirectionArrow(from: Vec3, to: Vec3, index: number) {
        const direction = new Vec3().sub2(to, from).normalize();
        const length = this.options.directionLength;
        const endPoint = new Vec3().add2(from, direction.mulScalar(length));

        // Create arrow line
        const positions = [
            from.x, from.y, from.z,
            endPoint.x, endPoint.y, endPoint.z
        ];

        const mesh = this.createLineMesh(positions);

        const material = new StandardMaterial();
        material.diffuse = this.options.directionColor;
        material.emissive = this.options.directionColor;
        material.emissiveIntensity = 0.6;
        material.update();

        const entity = new Entity(`Direction_${index}`);
        entity.addComponent('render', {
            type: 'asset',
            meshInstances: [new MeshInstance(mesh, material)]
        });

        this.rootEntity.addChild(entity);
        this.directionEntities.push(entity);

        // Create arrow head (small cone)
        this.createArrowHead(endPoint, direction, material, index);
    }

    private createArrowHead(position: Vec3, direction: Vec3, material: StandardMaterial, index: number) {
        const entity = new Entity(`ArrowHead_${index}`);
        entity.addComponent('render', {
            type: 'cone',
            material: material
        });

        const size = this.options.keyframeSize * 0.5;
        entity.setLocalScale(size, size * 1.5, size);
        entity.setPosition(position);

        // Orient cone to point in direction
        // Cone's default orientation is Y-up, we need to rotate it to point along direction
        const targetPoint = new Vec3().add2(position, direction);
        
        // Use lookAt with world up vector
        // The cone will point from position towards targetPoint
        entity.lookAt(targetPoint);
        
        // Rotate 90 degrees around X axis because cone points up by default
        // but we want it to point forward
        entity.rotateLocal(-90, 0, 0);

        this.rootEntity.addChild(entity);
        this.directionEntities.push(entity);
    }

    setVisible(visible: boolean) {
        this.rootEntity.enabled = visible;
    }

    setPathVisible(visible: boolean) {
        if (this.pathEntity) {
            this.pathEntity.enabled = visible;
        }
    }

    setKeyframesVisible(visible: boolean) {
        this.keyframeEntities.forEach(entity => {
            entity.enabled = visible;
        });
    }

    setDirectionsVisible(visible: boolean) {
        this.directionEntities.forEach(entity => {
            entity.enabled = visible;
        });
    }

    clear() {
        if (this.pathEntity) {
            this.pathEntity.destroy();
            this.pathEntity = null;
        }

        this.keyframeEntities.forEach(entity => entity.destroy());
        this.keyframeEntities = [];

        this.directionEntities.forEach(entity => entity.destroy());
        this.directionEntities = [];
    }

    destroy() {
        this.clear();
        this.rootEntity.destroy();
    }
}

export { CameraPathVisualizer };
export type { VisualizerOptions };
