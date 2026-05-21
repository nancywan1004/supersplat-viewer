import {
    Asset,
    BLEND_NORMAL,
    Curve,
    CurveSet,
    EMITTERSHAPE_BOX,
    Entity,
    Layer,
    PARTICLESORT_NONE,
    Script,
    Texture,
    Vec3,
    type AppBase
} from 'playcanvas';

export interface GsplatFallingPetalsOptions {
    enabled?: boolean;
    followEntity?: Entity | null;
    continuousRender?: boolean;
    petalTexture?: Texture | null;
    petalTextureUrl?: string;
    petalParticleCount?: number;
    opacity?: number;
    color?: [number, number, number];
    extents?: [number, number, number];
}

const PETAL_PRESET = {
    opacity: 0.95,
    color: [1, 1, 1] as [number, number, number],
    extents: [36, 42, 32] as [number, number, number],
    petalParticleCount: 3600
};

export class GsplatFallingPetals extends Script {
    static scriptName = 'gsplatFallingPetals';

    followEntity: Entity | null = null;

    continuousRender = true;

    opacity = PETAL_PRESET.opacity;

    color: [number, number, number] = [...PETAL_PRESET.color];

    extents = new Vec3(...PETAL_PRESET.extents);

    private _petalEntity: Entity | null = null;

    private _emitterEntities: Entity[] = [];

    private _petalTexture: Texture | null = null;

    private _petalTextureAsset: Asset | null = null;

    private _petalParticleCount = PETAL_PRESET.petalParticleCount;

    private _coverageExtents = new Vec3();

    private _emitterExtents = new Vec3();

    private _emitterWrapBounds = new Vec3();

    private _petalLayer: Layer | null = null;

    private _cameraEntity: Entity | null = null;

    private _savedAppAutoRender: boolean | undefined;

    private _autoRenderOverridden = false;

    initialize() {
        this.on('enable', () => this.syncContinuousRender());
        this.on('disable', () => this.disarmContinuousRender());
        this.app.on('update', this._onAppUpdate);
        this.syncContinuousRender();
    }

    setOptions(options: GsplatFallingPetalsOptions = {}) {
        if (options.followEntity !== undefined) this.followEntity = options.followEntity;
        if (options.continuousRender !== undefined) this.continuousRender = options.continuousRender;
        if (options.petalTexture !== undefined) this.setPetalTexture(options.petalTexture);
        if (options.petalTextureUrl) this.loadPetalTexture(options.petalTextureUrl);
        if (options.petalParticleCount !== undefined) this._petalParticleCount = options.petalParticleCount;
        if (options.opacity !== undefined) this.opacity = options.opacity;
        if (options.color) this.color = [...options.color];
        if (options.extents) this.extents.set(options.extents[0], options.extents[1], options.extents[2]);
        if (options.enabled !== undefined) this.enabled = options.enabled;

        this.syncCameraLayer();
        this.syncRenderer();
        this.syncContinuousRender();
    }

    show(options: GsplatFallingPetalsOptions = {}) {
        this.setOptions({
            ...PETAL_PRESET,
            ...options,
            enabled: options.enabled ?? true
        });
    }

    hide() {
        this.enabled = false;
        this.syncRenderer();
        this.syncContinuousRender();
    }

    setPetalTexture(texture: Texture | null | undefined) {
        this._petalTexture = texture ?? null;
        for (const emitter of this._emitterEntities) {
            const ps = emitter.particlesystem;
            if (ps && this._petalTexture) {
                ps.colorMap = this._petalTexture;
                this.applyPetalMaterialState(ps);
                ps.reset();
                ps.play();
            }
        }
    }

    loadPetalTexture(url: string) {
        const normalizedUrl = url.replace(/^\/assets\/(petal[^/]*)\.png$/i, '/textures/$1.png');
        if (this._petalTextureAsset) {
            this.app.assets.remove(this._petalTextureAsset);
            this._petalTextureAsset = null;
        }

        const asset = new Asset('gsplat-petal-texture', 'texture', { url: normalizedUrl });
        this._petalTextureAsset = asset;
        asset.once('load', () => {
            this.setPetalTexture(asset.resource as Texture);
        });
        asset.once('error', (err) => {
            console.warn('[GsplatFallingPetals] failed to load petal texture:', normalizedUrl, err);
        });
        this.app.assets.add(asset);
        this.app.assets.load(asset);
    }

    update(_dt: number) {
    }

    destroy() {
        this.app.off('update', this._onAppUpdate);
        this.disarmContinuousRender();
        this.removePetalLayer();
        if (this._petalEntity) {
            this._petalEntity.destroy();
            this._petalEntity = null;
        }
        this._emitterEntities.length = 0;
        if (this._petalTextureAsset) {
            this.app.assets.remove(this._petalTextureAsset);
            this._petalTextureAsset = null;
        }
    }

    private _onAppUpdate = () => {
        if (!this.enabled || !this._petalEntity) {
            return;
        }

        this.syncPetalBox(this.followEntity ?? this.entity);
    };

    private ensurePetalSystem() {
        const emitterCount = this.getEmitterCount();
        if (this._petalEntity) {
            if (this._emitterEntities.length === emitterCount) {
                return;
            }
            this._petalEntity.destroy();
            this._petalEntity = null;
            this._emitterEntities.length = 0;
        }

        this._petalEntity = new Entity('falling petal particles');
        this.entity.addChild(this._petalEntity);
        const layerId = this.ensurePetalLayer().id;

        const particlesPerEmitter = Math.max(1, Math.floor(this._petalParticleCount / emitterCount));
        const lifetime = this.getLifetime();
        const rate = this.getSpawnRate(particlesPerEmitter);
        for (let i = 0; i < emitterCount; i++) {
            const emitter = new Entity(`falling petal emitter ${i + 1}`);
            this._petalEntity.addChild(emitter);
            emitter.addComponent('particlesystem', {
                numParticles: particlesPerEmitter,
                lifetime,
                rate: rate * 0.88,
                rate2: rate * 1.12,
                startAngle: 0,
                startAngle2: 360,
                loop: true,
                preWarm: true,
                lighting: false,
                intensity: this.opacity,
                depthWrite: false,
                noFog: false,
                sort: PARTICLESORT_NONE,
                blendType: BLEND_NORMAL,
                emitterShape: EMITTERSHAPE_BOX,
                emitterExtents: this.getEmitterExtents(),
                emitterExtentsInner: new Vec3(0, 0, 0),
                layers: [layerId],
                initialVelocity: 0,
                wrap: true,
                wrapBounds: this.getEmitterWrapBounds(),
                localSpace: true,
                scaleGraph: new Curve([0, 0.24, 0.18, 0.4, 0.46, 0.28, 0.72, 0.44, 1, 0.26]),
                scaleGraph2: new Curve([0, 0.42, 0.2, 0.68, 0.52, 0.38, 0.76, 0.72, 1, 0.38]),
                colorGraph: new CurveSet([
                    [0, this.color[0], 1, this.color[0]],
                    [0, this.color[1], 1, this.color[1]],
                    [0, this.color[2], 1, this.color[2]]
                ]),
                alphaGraph: new Curve([0, 0, 0.015, this.opacity, 0.86, this.opacity, 0.96, this.opacity * 0.92, 1, 0]),
                velocityGraph: new CurveSet([
                    [0, -0.46, 0.22, 0.62, 0.52, -0.36, 0.78, 0.48, 1, -0.25],
                    [0, -2.9, 0.45, -3.6, 1, -4.4],
                    [0, 0.08, 0.32, -0.16, 0.68, 0.14, 1, -0.06]
                ]),
                velocityGraph2: new CurveSet([
                    [0, 0.66, 0.2, -0.56, 0.52, 0.5, 0.82, -0.45, 1, 0.28],
                    [0, -3.6, 0.52, -4.3, 1, -5.2],
                    [0, -0.16, 0.3, 0.18, 0.7, -0.12, 1, 0.08]
                ]),
                rotationSpeedGraph: new Curve([0, -620, 0.25, -420, 0.55, -760, 1, -360]),
                rotationSpeedGraph2: new Curve([0, 620, 0.25, 420, 0.55, 760, 1, 360])
            } as any);

            if (this._petalTexture) {
                emitter.particlesystem!.colorMap = this._petalTexture;
            }
            this.applyPetalMaterialState(emitter.particlesystem);
            this._emitterEntities.push(emitter);
        }
        this.syncPetalBox(this.followEntity ?? this.entity);
    }

    private getCoverageExtents() {
        const camera = this.followEntity?.camera;
        const aspect = Math.max(0.5, this.app.graphicsDevice.width / Math.max(1, this.app.graphicsDevice.height));
        const fov = camera ? camera.fov : 60;
        const halfFov = fov * Math.PI / 360;
        const depth = Math.max(this.extents.z, 24);
        const farDistance = depth * 0.5;
        const height = Math.max(this.extents.y, Math.tan(halfFov) * farDistance * 2 + 14);
        const width = Math.max(this.extents.x, height * aspect + 4);

        return this._coverageExtents.set(width, height, depth).clone();
    }

    private getEmitterCount() {
        return 18;
    }

    private getLifetime() {
        return 10.5;
    }

    private getSpawnRate(particlesPerEmitter: number) {
        return this.getLifetime() / Math.max(1, particlesPerEmitter);
    }

    private getEmitterExtents() {
        const extents = this.getCoverageExtents();
        const stripeWidth = extents.x / this.getEmitterCount() * 1.35;
        return this._emitterExtents.set(stripeWidth, 0.12, extents.z).clone();
    }

    private getEmitterWrapBounds() {
        const extents = this.getCoverageExtents();
        const stripeWidth = extents.x / this.getEmitterCount() * 1.35;
        return this._emitterWrapBounds.set(stripeWidth, extents.y, extents.z).clone();
    }

    private getWrapCenterYOffset() {
        const extents = this.getCoverageExtents();
        return extents.y * 0.06;
    }

    private syncPetalBox(target: Entity) {
        if (!this._petalEntity) {
            return;
        }

        const pos = target.getPosition();
        const forward = target.forward;
        const yaw = Math.atan2(-forward.x, -forward.z) * 180 / Math.PI;

        this._petalEntity.setPosition(pos.x, pos.y + this.getWrapCenterYOffset(), pos.z);
        this._petalEntity.setEulerAngles(0, yaw, 0);
        this.syncCameraLayer();

        const extents = this.getCoverageExtents();
        const emitterCount = Math.max(1, this._emitterEntities.length);
        for (let i = 0; i < this._emitterEntities.length; i++) {
            const u = emitterCount === 1 ? 0.5 : i / (emitterCount - 1);
            this._emitterEntities[i].setLocalPosition((u - 0.5) * extents.x, 0, 0);
            this._emitterEntities[i].setLocalEulerAngles(0, 0, 0);
        }
    }

    private syncRenderer() {
        if (this.enabled) {
            this.ensurePetalSystem();
        }

        if (!this._petalEntity) {
            return;
        }

        this._petalEntity.enabled = this.enabled;
        const layerId = this.ensurePetalLayer().id;
        const particlesPerEmitter = Math.max(1, Math.floor(this._petalParticleCount / this.getEmitterCount()));
        const lifetime = this.getLifetime();
        const rate = this.getSpawnRate(particlesPerEmitter);
        for (const emitter of this._emitterEntities) {
            emitter.enabled = this.enabled;
            const ps = emitter.particlesystem;
            if (!ps) {
                continue;
            }
            ps.numParticles = particlesPerEmitter;
            ps.lifetime = lifetime;
            ps.rate = rate * 0.88;
            ps.rate2 = rate * 1.12;
            ps.emitterExtents = this.getEmitterExtents();
            ps.wrapBounds = this.getEmitterWrapBounds();
            ps.layers = [layerId];
            ps.wrap = true;
            ps.intensity = this.opacity;
            this.applyPetalMaterialState(ps);
            ps.colorGraph = new CurveSet([
                [0, this.color[0], 1, this.color[0]],
                [0, this.color[1], 1, this.color[1]],
                [0, this.color[2], 1, this.color[2]]
            ]);
            ps.alphaGraph = new Curve([0, 0, 0.015, this.opacity, 0.86, this.opacity, 0.96, this.opacity * 0.92, 1, 0]);
            if (this.enabled) {
                ps.reset();
                ps.play();
            } else {
                ps.stop();
            }
        }
        this.syncPetalBox(this.followEntity ?? this.entity);
    }

    private applyPetalMaterialState(ps: Entity['particlesystem']) {
        const emitter = (ps as any)?.emitter;
        const material = emitter?.material;
        if (material) {
            material.depthTest = false;
            material.depthWrite = false;
            material.update?.();
        }

        const meshMaterial = emitter?.meshInstance?.material;
        if (meshMaterial && meshMaterial !== material) {
            meshMaterial.depthTest = false;
            meshMaterial.depthWrite = false;
            meshMaterial.update?.();
        }
    }

    private ensurePetalLayer() {
        if (this._petalLayer) {
            return this._petalLayer;
        }

        const layers = this.app.scene.layers;
        const worldLayer = layers.getLayerByName('World');
        const layer = new Layer({
            name: 'FallingPetalsOverlay',
            clearColorBuffer: false,
            clearDepthBuffer: false
        });

        if (worldLayer) {
            layers.insert(layer, layers.getTransparentIndex(worldLayer) + 1);
        } else {
            layers.push(layer);
        }

        this._petalLayer = layer;
        this.syncCameraLayer();
        return layer;
    }

    private syncCameraLayer() {
        const layer = this._petalLayer;
        const cameraEntity = this.followEntity?.camera ? this.followEntity : null;
        if (!layer || !cameraEntity?.camera) {
            return;
        }

        if (this._cameraEntity && this._cameraEntity !== cameraEntity && this._cameraEntity.camera) {
            this._cameraEntity.camera.layers = this._cameraEntity.camera.layers.filter(id => id !== layer.id);
        }

        if (!cameraEntity.camera.layers.includes(layer.id)) {
            cameraEntity.camera.layers = [...cameraEntity.camera.layers, layer.id];
        }
        this._cameraEntity = cameraEntity;
    }

    private removePetalLayer() {
        const layer = this._petalLayer;
        if (!layer) {
            return;
        }

        if (this._cameraEntity?.camera) {
            this._cameraEntity.camera.layers = this._cameraEntity.camera.layers.filter(id => id !== layer.id);
        }
        this.app.scene.layers.remove(layer);
        this._petalLayer = null;
        this._cameraEntity = null;
    }

    private syncContinuousRender() {
        const wantContinuous = this.enabled && this.continuousRender;
        if (wantContinuous && !this._autoRenderOverridden) {
            this._savedAppAutoRender = this.app.autoRender;
            this.app.autoRender = true;
            this._autoRenderOverridden = true;
            return;
        }

        if (!wantContinuous && this._autoRenderOverridden) {
            this.disarmContinuousRender();
        }
    }

    private disarmContinuousRender() {
        if (!this._autoRenderOverridden) {
            return;
        }
        if (this._savedAppAutoRender !== undefined) {
            this.app.autoRender = this._savedAppAutoRender;
        }
        this._savedAppAutoRender = undefined;
        this._autoRenderOverridden = false;
    }
}

export function createGsplatFallingPetals(app: AppBase, options: GsplatFallingPetalsOptions = {}) {
    const entity = new Entity('gsplat falling petals');
    entity.addComponent('script');
    app.root.addChild(entity);

    const script = entity.script!.create(GsplatFallingPetals) as unknown as GsplatFallingPetals;
    script.setOptions({ enabled: false, ...options });
    if (options.enabled) {
        script.show(options);
    }
    return script;
}

export function destroyGsplatFallingPetals(script: GsplatFallingPetals | null | undefined) {
    const entity = script?.entity;
    if (!entity) {
        return;
    }
    entity.destroy();
}

export { PETAL_PRESET as GSPLAT_FALLING_PETALS_PRESET };
