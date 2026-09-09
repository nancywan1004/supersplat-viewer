import { Script, Entity, Material, Camera, Layer, Vec3, CameraComponent } from 'playcanvas';

/** 子类可选的参与半径字段（基类无此属性，运行时由 `hasOwnProperty` 判定）。 */
interface GsplatParticipationRadiusHost {
    endRadius?: number;
    maxEndRadius?: number;
}

/** RevealController 注入的场景几何；参与半径与速度在脚本内完成。 */
export type RevealParticipationSyncContext = {
    /** 省略时沿用 `participationRadiusRequest` / 当前 `endRadius` */
    requestedRadius?: number;
    sceneBboxRadius: number;
    bboxPaddingScale: number;
    totalDuration: number;
    effectParams?: Record<string, unknown> | null;
    /** 无 `syncSpeedToTotalDuration` 的脚本用于 bbox 放大后的速度补偿 */
    radiusSpeedCompensation?: number;
};

/**
 * Base class for gsplat shader effects.
 * Handles common functionality like material management, shader application,
 * time tracking, and uniform updates.
 *
 * **Usage:**
 * Attach this script to an entity with a gsplat component. The script automatically detects
 * whether the gsplat is in unified or non-unified mode and handles material access accordingly.
 *
 * **Non-Unified Mode (`unified=false`):**
 * Each gsplat component has its own material. The script accesses the material directly via
 * `entity.gsplat.material` and applies shader customizations immediately or when the asset loads.
 *
 * **Unified Mode (`unified=true`):**
 * Multiple gsplat components share materials per camera/layer combination. Materials are created
 * during the first frame render. The script listens to the 'material:created' event for immediate
 * notification and retries each frame as fallback to ensure materials are applied.
 *
 * **Enable/Disable:**
 * When enabled, the shader effect is applied and effectTime starts tracking from 0.
 * When disabled, the custom shader is removed and materials revert to default rendering.
 *
 * Subclasses must implement:
 * - getShaderGLSL(): Return GLSL shader string
 * - getShaderWGSL(): Return WGSL shader string
 * - updateEffect(effectTime, dt): Update effect each frame
 *
 * @abstract
 */
class GsplatShaderEffect extends Script {
    static scriptName = 'gsplatShaderEffect';

    initialized: boolean = false;
    shadersNeedApplication: boolean = false;
    needsRetry: boolean = false;

    /**
     * Center of the gsplat shader effect
     * @type {Vec3}
     */
    center: Vec3 = null;

    /**
     * Radius of the gsplat shader effect
     * @type {number}
     */
    radius: number = 0;

    /**
     * Optional camera entity to target in unified mode. If not set, applies to all cameras.
     *
     * @attribute
     * @type {import('playcanvas').Entity | null}
     */
    camera: Entity = null;

    /**
     * Time since effect was enabled
     * @type {number}
     */
    effectTime: number = 0;

    /**
     * Whether the effect time is paused (not updating automatically)
     * @type {boolean}
     */
    isPaused: boolean = false;

    /**
     * Set of materials with applied shader
     * @type {Set<import('playcanvas').Material>}
     */
    materialsApplied: Set<Material> = new Set();

    /**
     * Optional callback when the reveal effect has finished playing.
     * Set by RevealController to fire 'revealComplete' event.
     */
    onRevealComplete?: () => void;

    /**
     * Whether we have already fired the completion callback (only fire once).
     */
    private _revealCompleteFired: boolean = false;

    /**
     * Material created handler
     * @type {any}
     * @private
     */
    _materialCreatedHandler: any;

    /**
     * Material layer map
     * @type {Map<Material, number>}
     * @private
     */
    _materialLayers: Map<Material, number>;

    /**
     * 场景 bbox 外接球半径（由上层注入，用于统一 endRadius 自适应）。
     * @type {number}
     */
    sceneBboxRadius: number = 0;

    /**
     * bbox 半径补偿系数（默认 0.65，给边界留少量余量）。
     * @type {number}
     */
    sceneBboxPaddingScale: number = 0.65;


    initialize() {
        console.log('GsplatShaderEffect initialize() called for entity:', this.entity.name);
        // this.initialized = false;
        this.effectTime = 0;
        this.materialsApplied.clear();
        // this.shadersNeedApplication = false;

        // Listen to enable/disable events
        this.on('enable', () => {
            //console.log('GsplatShaderEffect enabled for entity:', this.entity.name);
            // Reset effect time and completion flag when enabling
            this.effectTime = 0;
            this._revealCompleteFired = false;

            // Ensure we're initialized
            if (!this.initialized && this.entity.gsplat) {
                this.initialized = true;
                //console.log('GsplatShaderEffect initialized');
            }

            // Apply shaders if initialized, otherwise flag for application
            if (this.initialized) {
                this.applyShaders();
            } else {
                this.shadersNeedApplication = true;
            }
        });

        this.on('disable', () => {
            // Remove shaders when disabling
            this.removeShaders();
        });

        // Register event listener immediately for unified mode to catch materials created on first frame
        // This is safe to call even if the gsplat component doesn't exist yet
        this.setupUnifiedEventListener();

        if (!this.entity.gsplat) {
            // gsplat component not yet available, will retry each frame
            return;
        }

        this.initialized = true;

        // Apply shaders immediately since we're enabled by default
        if (this.enabled) {
            this.applyShaders();
        }
    }

    applyShaders() {
        // console.log('GsplatShaderEffect applyShaders() called. GSplat unified:', this.entity.gsplat?.unified);
        if (this.entity.gsplat?.unified) {
            // Unified mode: Apply to specified camera (or all cameras if not specified)
            // console.log('Applying to unified materials');
            this.applyToUnifiedMaterials();
        } else {
            // Non-unified mode: Apply to component's material
            // console.log('Applying to component material');
            this.applyToComponentMaterial();
        }
        // console.log('Materials applied count:', this.materialsApplied.size);
    }

    removeShaders() {
        if (this.materialsApplied.size === 0) return;

        const device = this.app.graphicsDevice;
        const shaderLanguage = device?.isWebGPU ? 'wgsl' : 'glsl';

        // Remove custom shader chunk from all materials
        this.materialsApplied.forEach((material) => {
            material.getShaderChunks(shaderLanguage).delete('gsplatModifyVS');
            material.update();
        });

        // Clear the set and stop tracking
        this.materialsApplied.clear();
    }

    setupUnifiedEventListener() {
        // Only set up once
        if (this._materialCreatedHandler) return;

        // @ts-ignore - gsplat system exists at runtime
        const gsplatSystem = this.app.systems.gsplat;

        // Set up event listener
        this._materialCreatedHandler = (material: Material, camera: Camera, layer: Layer) => {
            // Only apply if enabled
            if (!this.enabled) return;

            // Apply shader immediately when material is created
            // The gsplat component may not be fully initialized yet, so we can't check it here
            if (!this.materialsApplied.has(material)) {
                // Check camera filter if specified
                if (this.camera && this.camera.camera && this.camera.camera.camera !== camera) {
                    return;
                }

                this.applyShaderToMaterial(material);
                this.materialsApplied.add(material);

                // Store layer info for potential validation later
                if (!this._materialLayers) {
                    this._materialLayers = new Map();
                }
                this._materialLayers.set(material, layer.id);
            }
        };

        gsplatSystem.on('material:created', this._materialCreatedHandler);
    }

    applyToComponentMaterial() {
        // console.log('applyToComponentMaterial called');
        const applyShader = () => {
            const material = this.entity.gsplat?.material;
            // console.log('Attempting to apply shader to material:', material);
            if (!material) {
                console.error(`${this.constructor.name}: gsplat material not available.`);
                return;
            }
            this.applyShaderToMaterial(material);
            this.materialsApplied.add(material);
            // console.log('Material added to applied set. Total materials:', this.materialsApplied.size);
        };

        if (this.entity.gsplat?.material) {
            // console.log('GSplat material available immediately');
            applyShader();
        } else {
            // console.log('GSplat material not available, waiting for load event');
            // Listen for when the gsplat component is ready
            this.entity.gsplat?.once('load', applyShader);
        }
    }

    applyToUnifiedMaterials() {
        // Try to apply immediately to any existing materials
        this.updateUnifiedMaterials();

        // If no materials yet, set retry flag (event listener is already set up)
        if (this.materialsApplied.size === 0) {
            this.needsRetry = true;
        }
    }

    updateUnifiedMaterials() {
        // @ts-ignore - gsplat system exists at runtime
        const gsplatSystem = this.app.systems.gsplat;
        const scene = this.app.scene;
        const composition = scene.layers;

        // Get all layers this component is on
        const componentLayers = this.entity.gsplat?.layers;
        if (!componentLayers) return;

        // Determine which cameras to target
        let targetCameras: Camera[];
        if (this.camera?.camera) {
            // Entity → CameraComponent → .camera 才是 getGSplatMaterial 所需的 Camera 实例（误传 Component 会查不到材质）
            const inner = this.camera.camera.camera;
            targetCameras = inner ? [inner] : composition.cameras.map((c) => c.camera);
        } else {
            targetCameras = composition.cameras.map((cameraComponent) => cameraComponent.camera);
        }

        // Iterate through target cameras（Camera 实例）
        targetCameras.forEach((camera) => {
            // For each layer this component is on
            componentLayers.forEach((layerId) => {
                // Check if this camera renders this layer
                if (camera.layers.indexOf(layerId) >= 0) {
                    const layer = composition.getLayerById(layerId);
                    if (layer) {
                        const material = gsplatSystem.getGSplatMaterial(camera as Camera, layer);
                        if (material && !this.materialsApplied.has(material)) {
                            this.applyShaderToMaterial(material);
                            this.materialsApplied.add(material);
                        }
                    }
                }
            });
        });

        if (this.materialsApplied.size > 0) {
            this.needsRetry = false;
            // Keep event listener active to catch any new materials created later
        }
    }

    /**
     * 将子类返回的整段顶点修改 shader 写入材质 `gsplatModifyVS`。
     * 产品约定：与 `GsplatEffectComposer` 分层合成相对，此「整段写入」路径**仅**在播放**一次性开场 reveal** 时作为主导；
     * 夜间 / 持续波纹等走合成器时，子类应短路本方法（参见 `GsplatRevealPerlinWave.applyShaderToMaterial`）。
     */
    applyShaderToMaterial(material: Material) {
        const device = this.app.graphicsDevice;
        const shaderLanguage = device?.isWebGPU ? 'wgsl' : 'glsl';
        const customShader = shaderLanguage === 'wgsl' ? this.getShaderWGSL() : this.getShaderGLSL();

        // console.log('Applying shader to material:', material.name, 'Language:', shaderLanguage);
        // console.log('Custom shader length:', customShader.length);

        material.getShaderChunks(shaderLanguage).set('gsplatModifyVS', customShader);
        material.update();
        
        // console.log('Shader applied and material updated');
    }

    update(dt: number) {
        // If not initialized, try to complete initialization
        if (!this.initialized) {
            if (this.entity.gsplat) {
                this.initialized = true;
                // Apply shaders now if we're enabled and they're needed
                if (this.enabled && this.shadersNeedApplication) {
                    this.applyShaders();
                    this.shadersNeedApplication = false;
                }
            }
            return; // Don't proceed with updates until initialized
        }

        // Apply shaders if they're needed (can happen if enabled after initialization)
        if (this.shadersNeedApplication) {
            this.applyShaders();
            this.shadersNeedApplication = false;
        }

        // Retry applying to unified materials if needed
        if (this.entity.gsplat?.unified && this.needsRetry) {
            this.updateUnifiedMaterials();
        }

        if (this.materialsApplied.size === 0) return;

        // Update time only if not paused
        if (!this.isPaused) {
            this.effectTime += dt;
        }

        // Let subclass update the effect (always call, even when paused, to allow manual time updates)
        this.updateEffect(this.effectTime, dt);
        
        // Request render on next frame when effect is active
        // This ensures the reveal effect updates even when camera is not moving
        if (this.enabled && this.materialsApplied.size > 0) {
            this.app.renderNextFrame = true;
        }
    }

    destroy() {
        // Remove shaders if they're still applied
        this.removeShaders();

        // Clean up event listener
        if (this._materialCreatedHandler) {
            // @ts-ignore - gsplat system exists at runtime
            this.app.systems.gsplat.off('material:created', this._materialCreatedHandler);
            this._materialCreatedHandler = null;
        }
    }

    /**
     * Get the GLSL shader string.
     * Must be implemented by subclasses.
     * @returns {string} GLSL shader code
     * @abstract
     */
    getShaderGLSL(): any {
        throw new Error(`${this.constructor.name} must implement getShaderGLSL()`);
    }

    /**
     * Get the WGSL shader string.
     * Must be implemented by subclasses.
     * @returns {string} WGSL shader code
     * @abstract
     */
    getShaderWGSL(): any {
        throw new Error(`${this.constructor.name} must implement getShaderWGSL()`);
    }

    /**
     * Set a uniform value on all applied materials.
     * @param {string} name - The uniform name
     * @param {*} value - The uniform value
     */
    setUniform(name: string, value: any) {
        this.materialsApplied.forEach((material) => {
            material.setParameter(name, value);
        });
        
        // Request render on next frame when uniforms change
        this.app.renderNextFrame = true;
    }

    /**
     * Set the center point for the effect.
     * This is a convenience method that subclasses can override for custom behavior.
     * @param {import('playcanvas').Vec3} center - The new center position
     */
    setCenter(center: Vec3) {
        // Default implementation: update center attribute if it exists
        if (this.center) {
            this.center.copy(center);
        }
        
        // Update uniform if materials are applied
        if (this.materialsApplied.size > 0) {
            const centerArray = [center.x, center.y, center.z];
            this.setUniform('uCenter', centerArray);
        }
    }

    /**
     * Set the radius for the effect.
     * This is a convenience method that subclasses can override for custom behavior.
     * @param {number} radius - The new radius value
     */
    /** create / `setRadius` 写入的请求半径，供 `commitEffectiveEndRadius` 在 `maxEndRadius` 更新后重算。 */
    protected participationRadiusRequest = 0;

    /**
     * 在 bbox 自适应半径之上应用 `maxEndRadius` 上界（脚本存在该属性且 > 0 时）。
     */
    protected finalizeParticipationRadius(adaptiveRadius: number): number {
        const cap = (this as GsplatParticipationRadiusHost).maxEndRadius;
        if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) {
            return Math.min(adaptiveRadius, cap);
        }
        return adaptiveRadius;
    }

    /**
     * 按当前 `participationRadiusRequest` 与 `maxEndRadius` 刷新有效 `endRadius`（须在 effectParams 写入 `maxEndRadius` 之后调用）。
     */
    commitEffectiveEndRadius(): void {
        // PlayCanvas 子类字段常在原型链上，hasOwnProperty 会为 false 导致 cap 永不生效
        if (!('endRadius' in this)) {
            return;
        }
        const adaptive = this.resolveAdaptiveEndRadius(this.participationRadiusRequest);
        const effective = this.finalizeParticipationRadius(adaptive);
        (this as GsplatParticipationRadiusHost).endRadius = effective;
        if (this.materialsApplied.size > 0) {
            this.setUniform('uEndRadius', effective);
        }
    }

    setRadius(radius: number) {
        const safeRadius = Number.isFinite(radius) ? Math.max(0, radius) : 0;
        this.participationRadiusRequest = safeRadius;

        // Default implementation: update radius attribute if it exists
        if ('radius' in this) {
            this.radius = safeRadius;
        }

        let adaptiveEndRadius = safeRadius;
        if ('endRadius' in this) {
            adaptiveEndRadius = this.finalizeParticipationRadius(this.resolveAdaptiveEndRadius(safeRadius));
            (this as GsplatParticipationRadiusHost).endRadius = adaptiveEndRadius;
        }
        
        // Update uniform if materials are applied
        if (this.materialsApplied.size > 0) {
            this.setUniform('uRadius', safeRadius);
            if ('endRadius' in this) {
                this.setUniform('uEndRadius', adaptiveEndRadius);
            }
        }
    }

    /**
     * 由上层（RevealController）注入场景 bbox 半径，供 endRadius 自适应逻辑复用。
     * @param {number} radius - bbox 外接球半径
     * @param {number} [paddingScale=0.65] - 半径补偿系数
     */
    setSceneBoundsRadius(radius: number, paddingScale: number = 0.65) {
        this.sceneBboxRadius = Number.isFinite(radius) && radius > 0 ? radius : 0;
        this.sceneBboxPaddingScale = Number.isFinite(paddingScale) && paddingScale > 0
            ? paddingScale
            : 0.65;
    }

    /**
     * 统一 endRadius 语义：请求半径与 bbox 半径（含余量）取最大值。
     * @param {number} requestedRadius - 请求半径（通常来自配置或默认值）
     * @returns {number} 自适应后的 endRadius
     */
    resolveAdaptiveEndRadius(requestedRadius: number): number {
        const safeRequested = Number.isFinite(requestedRadius) ? Math.max(0, requestedRadius) : 0;
        const bboxRadius = Number.isFinite(this.sceneBboxRadius) && this.sceneBboxRadius > 1e-6
            ? this.sceneBboxRadius * this.sceneBboxPaddingScale
            : 0;
        return Math.max(safeRequested, bboxRadius);
    }

    /**
     * bbox 自适应参与半径、可选 `maxEndRadius`、并按 `totalDuration` 对齐传播速度。
     * 子类实现 `syncSpeedToTotalDuration` 时由本方法调用；否则走 legacy 速度补偿。
     */
    syncRevealParticipation(ctx: RevealParticipationSyncContext): void {
        const host = this as GsplatParticipationRadiusHost;

        if ('maxEndRadius' in this && ctx.effectParams) {
            const cap = ctx.effectParams.maxEndRadius;
            if (typeof cap === 'number' && Number.isFinite(cap) && cap > 0) {
                host.maxEndRadius = cap;
            }
        }

        const hasExplicitRequest =
            ctx.requestedRadius !== undefined && Number.isFinite(ctx.requestedRadius);
        const safeRequested = hasExplicitRequest ? Math.max(0, ctx.requestedRadius!) : -1;
        const requestedWithDefault = safeRequested >= 0
            ? safeRequested
            : Math.max(0, this.participationRadiusRequest || Number(host.endRadius) || 0);

        this.setSceneBoundsRadius(ctx.sceneBboxRadius, ctx.bboxPaddingScale);
        this.setRadius(requestedWithDefault);

        const syncSpeed = (this as { syncSpeedToTotalDuration?: (t: number) => void }).syncSpeedToTotalDuration;
        if (typeof syncSpeed === 'function') {
            syncSpeed.call(this, ctx.totalDuration);
            return;
        }

        const compensation = ctx.radiusSpeedCompensation ?? 0.7;
        this.applyRevealRadiusSpeedCompensation(
            requestedWithDefault,
            Number(host.endRadius),
            compensation
        );
    }

    /**
     * bbox 放大 endRadius 后，对 rain / pieces-recover 等未实现 `syncSpeedToTotalDuration` 的脚本做一次性速度补偿。
     */
    private applyRevealRadiusSpeedCompensation(
        requestedRadius: number,
        endRadius: number,
        radiusSpeedCompensation: number
    ): void {
        const script = this as Record<string, unknown>;
        if (!Number.isFinite(requestedRadius) || requestedRadius <= 1e-6) return;
        if (!Number.isFinite(endRadius) || endRadius <= 1e-6) return;

        const rawScale = endRadius / requestedRadius;
        if (!Number.isFinite(rawScale) || rawScale <= 0) return;

        const speedFactor = 1 + (rawScale - 1) * radiusSpeedCompensation;
        const safeFactor = Math.max(1, Math.min(3, speedFactor));

        const baseline = (script.__radiusSpeedBaseline ?? {}) as Record<string, number>;
        if (!script.__radiusSpeedBaseline) {
            baseline.speed = Number((this as { speed?: number }).speed);
            baseline.acceleration = Number((this as { acceleration?: number }).acceleration);
            baseline.waveSpeed = Number((this as { waveSpeed?: number }).waveSpeed);
            baseline.waveSpeedDistScale = Number((this as { waveSpeedDistScale?: number }).waveSpeedDistScale);
            script.__radiusSpeedBaseline = baseline;
        }

        const self = this as {
            speed?: number;
            acceleration?: number;
            waveSpeed?: number;
            waveSpeedDistScale?: number;
        };
        if (Number.isFinite(baseline.speed)) {
            self.speed = Math.max(1e-6, baseline.speed * safeFactor);
        }
        if (Number.isFinite(baseline.acceleration)) {
            self.acceleration = baseline.acceleration * safeFactor;
        }
        if (Number.isFinite(baseline.waveSpeed)) {
            self.waveSpeed = Math.max(1e-6, baseline.waveSpeed * safeFactor);
        }
        if (Number.isFinite(baseline.waveSpeedDistScale)) {
            self.waveSpeedDistScale = baseline.waveSpeedDistScale / safeFactor;
        }
    }

    /**
     * Set the effect time manually (useful for scrubbing/playback control)
     * @param {number} time - The new effect time in seconds
     */
    setEffectTime(time: number) {
        this.effectTime = Math.max(0, time);
        // Force update even if paused
        if (this.materialsApplied.size > 0) {
            this.updateEffect(this.effectTime, 0);
            this.app.renderNextFrame = true;
        }
    }

    /**
     * Update effect each frame.
     * Must be implemented by subclasses if they need to update uniforms or check completion.
     * @param {number} effectTime - Time since effect was enabled in seconds
     * @param {number} dt - Delta time in seconds
     * @abstract
     */
    updateEffect(effectTime: number, dt: number) {
        // Optional to override
    }

    /**
     * Called by subclasses when the reveal effect has completed.
     * 先禁用并 removeShaders，再触发 onRevealComplete（revealComplete 会同步挂载 persistent 等，
     * 若顺序相反，收尾的 delete('gsplatModifyVS') 会清掉刚写上的 persistent chunk）。
     */
    notifyRevealComplete() {
        if (this._revealCompleteFired) return;
        this._revealCompleteFired = true;
        this.enabled = false;
        this.onRevealComplete?.();
    }
}

export { GsplatShaderEffect };
