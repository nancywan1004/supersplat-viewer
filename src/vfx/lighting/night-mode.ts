import { Script, Color, Entity, Vec3, Mat4 } from 'playcanvas';
import { GsplatShaderEffect } from '../gsplat-shader-effect';
import { collectPointLights } from '../../light';
import type { Texture } from 'playcanvas';

const shaderGLSL = /* glsl */`
uniform vec3 uSpherePositions[10];
uniform vec3 uSphereColors[10];
uniform float uNightFade;
uniform vec3 uNightAmbient;
uniform mat4 uModelMatrix;

vec3 l2g(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
vec3 g2l(vec3 c) { return pow(c, vec3(2.2)); }

void modifySplatCenter(inout vec3 center) {
    // Night mode doesn't modify center position
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    // Night mode doesn't modify rotation/scale
}

void modifySplatColor(vec3 center, inout vec4 color) {
    if (uNightFade == 0.0) {
        return;
    }

    // Calculate world position from model center
    vec4 worldPos = uModelMatrix * vec4(center, 1.0);
    worldPos /= worldPos.w;

    // Calculate lighting from spheres
    vec3 sum = vec3(0.0);
    for (int i = 0; i < 10; ++i) {
        vec3 pos = uSpherePositions[i];
        vec3 clr = uSphereColors[i];
        if (length(pos) > 0.001) {
            float dist = length(pos - worldPos.xyz);
            if (dist > 0.001) {
                sum += g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }

    vec3 linearColor = g2l(color.rgb);
    vec3 nightColor = g2l(uNightAmbient) + sum;
    color.rgb = l2g(linearColor * mix(vec3(1.0), nightColor, uNightFade));
}
`;

// Night Mode + Bloom Brush 合成：涂抹区域内亮部不应用 night mode（参与 bloom），暗部应用 night mode
const shaderGLSLBloomBrush = /* glsl */`
uniform vec3 uSpherePositions[10];
uniform vec3 uSphereColors[10];
uniform float uNightFade;
uniform vec3 uNightAmbient;
uniform mat4 uModelMatrix;
uniform mat4 uModelViewProj;
uniform sampler2D uBloomMask;
uniform float uBloomThreshold;
uniform float uBloomBrushActive;

vec3 l2g(vec3 c) { return pow(c, vec3(1.0 / 2.2)); }
vec3 g2l(vec3 c) { return pow(c, vec3(2.2)); }

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

void modifySplatColor(vec3 center, inout vec4 color) {
    if (uNightFade == 0.0) {
        return;
    }

    // Bloom Brush 模式：涂抹区域内亮部跳过 night mode（参与 bloom），暗部应用 night mode
    // NDC：y=-1 底部，y=1 顶部；mask 纹理 v=0 底部 v=1 顶部（与 BloomBrushPainter 绘制一致），无需 Y 翻转
    if (uBloomBrushActive > 0.5) {
        vec4 clipPos = uModelViewProj * vec4(center, 1.0);
        vec3 ndc = clipPos.xyz / clipPos.w;
        vec2 uv = ndc.xy * 0.5 + 0.5;
        if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            float maskVal = texture2D(uBloomMask, uv).r;
            float lum = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
            if (maskVal > 0.5 && lum >= uBloomThreshold) {
                return;
            }
        }
    }

    vec4 worldPos = uModelMatrix * vec4(center, 1.0);
    worldPos /= worldPos.w;

    vec3 sum = vec3(0.0);
    for (int i = 0; i < 10; ++i) {
        vec3 pos = uSpherePositions[i];
        vec3 clr = uSphereColors[i];
        if (length(pos) > 0.001) {
            float dist = length(pos - worldPos.xyz);
            if (dist > 0.001) {
                sum += g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }

    vec3 linearColor = g2l(color.rgb);
    vec3 nightColor = g2l(uNightAmbient) + sum;
    color.rgb = l2g(linearColor * mix(vec3(1.0), nightColor, uNightFade));
}
`;

const shaderWGSL = /* wgsl */`
uniform uSpherePositions: array<vec3f, 10>;
uniform uSphereColors: array<vec3f, 10>;
uniform uNightFade: f32;
uniform uNightAmbient: vec3f;
uniform uModelMatrix: mat4x4f;

// linear/gamma conversion
fn l2g(c: vec3f) -> vec3f {
    return pow(c, vec3f(1.0 / 2.2));
}

fn g2l(c: vec3f) -> vec3f {
    return pow(c, vec3f(2.2));
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    // Night mode doesn't modify center position
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    // Night mode doesn't modify rotation/scale
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    if (uniform.uNightFade == 0.0) {
        return;
    }

    // Calculate world position from model center
    // Use the model matrix uniform to transform to world space
    let worldPos = uniform.uModelMatrix * vec4f(center, 1.0);
    let worldPos3 = worldPos.xyz / worldPos.w;

    // Calculate lighting from spheres
    var sum = vec3f(0.0);
    for (var i = 0u; i < 10u; i++) {
        let pos = uniform.uSpherePositions[i];
        let clr = uniform.uSphereColors[i];
        if (length(pos) > 0.001) { // Only process valid spheres
            let dist = length(pos - worldPos3);
            if (dist > 0.001) {
                sum = sum + g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }

    // Blend in linear space
    let linearColor = g2l((*color).rgb);
    let nightColor = g2l(uniform.uNightAmbient) + sum;
    (*color).rgb = l2g(linearColor * mix(vec3f(1.0), nightColor, uniform.uNightFade));
}
`;

// Night Mode + Bloom Brush 合成：涂抹区域内亮部不应用 night mode（参与 bloom），暗部应用 night mode
const shaderWGSLBloomBrush = /* wgsl */`
uniform uSpherePositions: array<vec3f, 10>;
uniform uSphereColors: array<vec3f, 10>;
uniform uNightFade: f32;
uniform uNightAmbient: vec3f;
uniform uModelMatrix: mat4x4f;
uniform uModelViewProj: mat4x4f;
var uBloomMask: texture_2d<f32>;
var uBloomMaskSampler: sampler;
uniform uBloomThreshold: f32;
uniform uBloomBrushActive: f32;

fn l2g(c: vec3f) -> vec3f { return pow(c, vec3f(1.0 / 2.2)); }
fn g2l(c: vec3f) -> vec3f { return pow(c, vec3f(2.2)); }

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    if (uniform.uNightFade == 0.0) {
        return;
    }

    if (uniform.uBloomBrushActive > 0.5) {
        let clipPos = uniform.uModelViewProj * vec4f(center, 1.0);
        let ndc = clipPos.xyz / clipPos.w;
        let uv = ndc.xy * 0.5 + 0.5;
        if (uv.x >= 0.0 && uv.x <= 1.0 && uv.y >= 0.0 && uv.y <= 1.0) {
            let maskVal = textureSample(uBloomMask, uBloomMaskSampler, uv).r;
            let lum = dot((*color).rgb, vec3f(0.2126, 0.7152, 0.0722));
            if (maskVal > 0.5 && lum >= uniform.uBloomThreshold) {
                return;
            }
        }
    }

    let worldPos = uniform.uModelMatrix * vec4f(center, 1.0);
    let worldPos3 = worldPos.xyz / worldPos.w;

    var sum = vec3f(0.0);
    for (var i = 0u; i < 10u; i++) {
        let pos = uniform.uSpherePositions[i];
        let clr = uniform.uSphereColors[i];
        if (length(pos) > 0.001) {
            let dist = length(pos - worldPos3);
            if (dist > 0.001) {
                sum = sum + g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }

    let linearColor = g2l((*color).rgb);
    let nightColor = g2l(uniform.uNightAmbient) + sum;
    (*color).rgb = l2g(linearColor * mix(vec3f(1.0), nightColor, uniform.uNightFade));
}
`;

/**
 * Night mode effect for gaussian splats.
 * Creates a night mode lighting effect with ambient lighting and sphere-based lighting.
 * 
 * @example
 * // Add the script to root entity
 * app.root.addComponent('script');
 * const nightModeScript = app.root.script.create(NightMode);
 * nightModeScript.light = lightEntity;
 * nightModeScript.camera = cameraEntity;
 * nightModeScript.splat = gsplatEntity;
 */
class NightMode extends GsplatShaderEffect {
    static scriptName = 'nightMode';

    /**
     * Light entity to control intensity
     * @attribute
     * @type {Entity | null}
     */
    light: Entity | null = null;

    /**
     * Camera entity for bloom effects
     * @attribute
     * @type {Entity | null}
     */
    camera: Entity | null = null;

    /**
     * Gsplat entity to apply night mode to
     * @attribute
     * @type {Entity | null}
     */
    splat: Entity | null = null;

    /** Bloom Brush 合成：开启时涂抹区域内亮部不应用 night mode（参与 bloom），暗部应用 night mode */
    bloomBrushActive: boolean = false;
    bloomBrushMask: Texture | null = null;
    bloomBrushThreshold: number = 0.2;
    private _bloomBrushModelViewProj: Mat4 = new Mat4();

    /**
     * Night ambient color
     * @attribute
     * @type {Color}
     */
    nightAmbient: Color = new Color(0, 0, 0);

    /**
     * Emissive intensity for spheres
     * @attribute
     */
    emissiveIntensity: number = 10;

    /**
     * Lighting intensity for spheres
     * @attribute
     */
    lightingIntensity: number = 1.23;

    /**
     * Emissive bloom intensity
     * @attribute
     */
    emissiveBloom: number = 0.05;

    private nightMode: boolean = false;
    private nightFade: number = 0;
    private manualFadeControl: boolean = false; // Flag to indicate manual control via slider

    initialize() {
        // Override initialization to work with external gsplat entity
        this.initialized = false;
        this.effectTime = 0;
        this.materialsApplied.clear();
        
        this.nightMode = false;
        this.nightFade = 0;

        // Listen for toggle event
        this.app.on('toggle:night-mode', () => {
            // Disable manual control when toggling (allow automatic transition)
            this.manualFadeControl = false;
            this.nightMode = !this.nightMode;
            // Keep script enabled so update() continues to be called
            // We control shader application through nightMode, not enabled
            // Only trigger enable/disable events for shader management
            if (this.nightMode && !this.enabled) {
                this.enabled = true;
            }
            // Fire event to update UI toggle state
            this.app.fire('nightMode:changed', this.nightMode);
            // When enabling night mode, sync slider with current nightFade value
            if (this.nightMode) {
                this.app.fire('nightFade:changed', this.nightFade);
            }
        });

        // Listen for nightFade set event from UI slider
        this.app.on('nightFade:set', (value: number) => {
            // Only allow slider control when night mode is enabled
            if (!this.nightMode) {
                console.warn('NightMode: Cannot set nightFade when night mode is disabled');
                return;
            }
            // Clamp value to [0, 1]
            const clampedValue = Math.max(0, Math.min(1, value));
            // Enable manual control mode
            this.manualFadeControl = true;
            // Directly set nightFade
            this.nightFade = clampedValue;
            // Ensure shaders are applied when slider is used
            if (this.materialsApplied.size === 0 && this.splat?.gsplat) {
                this.applyShaders();
            }
            // Force update uniforms immediately
            if (this.materialsApplied.size > 0) {
                this.updateEffect(this.effectTime, 0);
            }
            // Fire event to update UI
            this.app.fire('nightFade:changed', this.nightFade);
        });

        // Listen to enable/disable events
        this.on('enable', () => {
            this.effectTime = 0;
            if (this.splat?.gsplat) {
                this.initialized = true;
                // Apply shaders immediately when enabling and nightMode is true
                if (this.nightMode && this.materialsApplied.size === 0) {
                    this.applyShaders();
                }
            } else {
                this.shadersNeedApplication = true;
            }
        });

        this.on('disable', () => {
        });

        // Setup unified event listener if needed
        this.setupUnifiedEventListener();

        // Try to initialize if splat is already available
        if (this.splat?.gsplat) {
            this.initialized = true;
            if (this.enabled) {
                this.applyShaders();
            }
        }
        
        // Listen for nightFade request from UI (to sync initial slider value)
        this.app.on('nightFade:request', () => {
            this.app.fire('nightFade:changed', this.nightFade);
            this.app.fire('nightMode:changed', this.nightMode);
        });
    }

    applyShaders() {
        if (!this.splat?.gsplat) {
            console.warn('NightMode: splat entity not available');
            return;
        }

        if (this.splat.gsplat.unified) {
            this.applyToUnifiedMaterials();
        } else {
            this.applyToComponentMaterial();
        }
    }

    applyToComponentMaterial() {
        const material = this.splat?.gsplat?.material;
        if (!material) {
            // Wait for material to be available
            this.splat?.gsplat?.once('load', () => {
                const mat = this.splat?.gsplat?.material;
                if (mat) {
                    this.applyShaderToMaterial(mat);
                    this.materialsApplied.add(mat);
                }
            });
            return;
        }
        this.applyShaderToMaterial(material);
        this.materialsApplied.add(material);
    }

    applyToUnifiedMaterials() {
        this.updateUnifiedMaterials();
        if (this.materialsApplied.size === 0) {
            this.needsRetry = true;
        }
    }

    updateUnifiedMaterials() {
        if (!this.splat?.gsplat) return;

        // @ts-ignore - gsplat system exists at runtime
        const gsplatSystem = this.app.systems.gsplat;
        const scene = this.app.scene;
        const composition = scene.layers;

        const componentLayers = this.splat.gsplat.layers;
        if (!componentLayers) return;

        let targetCameras;
        if (this.camera && this.camera.camera) {
            targetCameras = [this.camera.camera];
        } else {
            targetCameras = composition.cameras.map(cameraComponent => cameraComponent.camera);
        }

        targetCameras.forEach((camera) => {
            componentLayers.forEach((layerId) => {
                if (camera.layers.indexOf(layerId) >= 0) {
                    const layer = composition.getLayerById(layerId);
                    if (layer) {
                        const material = gsplatSystem.getGSplatMaterial(camera as any, layer);
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
        }
    }

    getShaderGLSL() {
        return this.bloomBrushActive ? shaderGLSLBloomBrush : shaderGLSL;
    }

    getShaderWGSL() {
        return this.bloomBrushActive ? shaderWGSLBloomBrush : shaderWGSL;
    }

    /** 设置 Bloom Brush 合成参数；当 active 变更时会重新应用 shader */
    setBloomBrushParams(active: boolean, mask: Texture | null, threshold: number, modelViewProj?: Float32Array) {
        const prevActive = this.bloomBrushActive;
        this.bloomBrushActive = active;
        this.bloomBrushMask = mask;
        this.bloomBrushThreshold = Math.max(0, Math.min(5, threshold));
        if (modelViewProj) {
            this._bloomBrushModelViewProj.data.set(modelViewProj);
        }
        if (prevActive !== active && this.materialsApplied.size > 0) {
            this.removeShaders();
            this.applyShaders();
        }
    }

    update(dt: number) {
        // Override update to handle initialization and material retry
        if (!this.initialized) {
            if (this.splat?.gsplat) {
                this.initialized = true;
                if (this.enabled && this.shadersNeedApplication) {
                    this.applyShaders();
                    this.shadersNeedApplication = false;
                }
            }
            return;
        }

        if (this.shadersNeedApplication) {
            this.applyShaders();
            this.shadersNeedApplication = false;
        }

        if (this.splat?.gsplat?.unified && this.needsRetry) {
            this.updateUnifiedMaterials();
        }

        // Always update effect time and effect state, even if shaders are not applied
        // This ensures nightFade, light intensity, and skybox intensity are properly updated
        this.effectTime += dt;
        this.updateEffect(this.effectTime, dt);

        // Request render if enabled and materials are applied, or if we're transitioning
        if (this.enabled && this.materialsApplied.size > 0) {
            this.app.renderNextFrame = true;
        } else if (this.nightFade > 0 || this.nightFade < 1) {
            // Also request render during fade transitions even if shaders are not applied
            this.app.renderNextFrame = true;
        }
    }

    updateEffect(effectTime: number, dt: number) {
        // Only update night fade with smooth interpolation if not manually controlled
        if (!this.manualFadeControl) {
            const target = this.nightMode ? 0.95 : 0;
            const previousFade = this.nightFade;
            const wasAtTarget = Math.abs(this.nightFade - target) < 1e-6;
            
            if (wasAtTarget) {
                this.nightFade = target;
            } else {
                const damping = 0.98;
                const dampFactor = 1 - Math.pow(damping, dt * 1000);
                const newFade = this.nightFade * (1 - dampFactor) + target * dampFactor;
                this.nightFade = newFade;
            }
        }
        // If manually controlled, keep the current value (already set by slider event)
        // But still update uniforms and other effects
        
        // If we just reached 0 and shaders are still applied, remove them
        // This ensures shaders are removed only after fade completes
        if (!this.nightMode && this.nightFade < 1e-6 && this.materialsApplied.size > 0) {
            // Store materials before clearing
            const materialsToUpdate = Array.from(this.materialsApplied);
            const device = this.app.graphicsDevice;
            const shaderLanguage = device?.isWebGPU ? 'wgsl' : 'glsl';
            
            // Remove shader chunks
            materialsToUpdate.forEach((material) => {
                material.getShaderChunks(shaderLanguage).delete('gsplatModifyVS');
                material.update();
            });
            
            // Clear the set
            this.materialsApplied.clear();
            
            // Force render to ensure changes are visible
            this.app.renderNextFrame = true;
        }
        
        // If we're transitioning to night mode and shaders aren't applied, apply them
        // Apply as soon as nightMode is true, not waiting for fade to start
        if (this.nightMode && this.materialsApplied.size === 0 && this.splat?.gsplat) {
            this.applyShaders();
            // When enabling night mode, if manual control is not active, initialize slider with current fade
            if (!this.manualFadeControl) {
                // Fire event to sync slider with current nightFade value
                this.app.fire('nightFade:changed', this.nightFade);
            }
        }

        // 从场景中的 Light 实体（type='point'）收集点光源，上限 10 个
        const global = (this.app as any).__global;
        const pointLights = global ? collectPointLights(global) : [];
        const positions: number[] = [];
        const colors: number[] = [];
        const scale = this.lightingIntensity;
        for (let i = 0; i < 10; ++i) {
            const pl = pointLights[i];
            if (!pl) {
                positions.push(0, 0, 0);
                colors.push(0, 0, 0);
            } else {
                positions.push(pl.position.x, pl.position.y, pl.position.z);
                colors.push(
                    pl.color.r * pl.intensity * scale,
                    pl.color.g * pl.intensity * scale,
                    pl.color.b * pl.intensity * scale
                );
            }
        }

        // Get model matrix from splat entity
        let modelMatrix: number[] = [];
        if (this.splat) {
            const worldTransform = this.splat.getWorldTransform();
            // Convert Mat4 to array (column-major order for GLSL)
            modelMatrix = [
                worldTransform.data[0], worldTransform.data[4], worldTransform.data[8], worldTransform.data[12],
                worldTransform.data[1], worldTransform.data[5], worldTransform.data[9], worldTransform.data[13],
                worldTransform.data[2], worldTransform.data[6], worldTransform.data[10], worldTransform.data[14],
                worldTransform.data[3], worldTransform.data[7], worldTransform.data[11], worldTransform.data[15]
            ];
        } else {
            // Identity matrix as fallback
            modelMatrix = [
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ];
        }

        // Update uniforms on all applied materials (only if shaders are applied)
        if (this.materialsApplied.size > 0) {
            this.setUniform('uSpherePositions[0]', positions);
            this.setUniform('uSphereColors[0]', colors);
            this.setUniform('uNightFade', this.nightFade);
            this.setUniform('uNightAmbient', [
                this.nightAmbient.r,
                this.nightAmbient.g,
                this.nightAmbient.b
            ]);
            this.setUniform('uModelMatrix', modelMatrix);
            if (this.bloomBrushActive && this.bloomBrushMask && this.camera?.camera && this.splat) {
                const cam = this.camera.camera;
                this._bloomBrushModelViewProj.copy(cam.viewMatrix);
                this._bloomBrushModelViewProj.mul2(this._bloomBrushModelViewProj, this.splat.getWorldTransform());
                this._bloomBrushModelViewProj.mul2(cam.projectionMatrix, this._bloomBrushModelViewProj);
                this.materialsApplied.forEach((material) => {
                    material.setParameter('uBloomMask', this.bloomBrushMask!);
                });
                this.setUniform('uBloomBrushActive', 1);
                this.setUniform('uBloomThreshold', this.bloomBrushThreshold);
                this.setUniform('uModelViewProj', this._bloomBrushModelViewProj.data);
            }
        }

        // Update light intensity (always update, even if shaders are removed)
        if (this.light?.light) {
            const targetIntensity = 1 - this.nightFade;
            this.light.light.intensity = targetIntensity;
        }

        // Update camera bloom
        const cameraScript = this.camera?.script as any;
        if (cameraScript?.cameraEffects?.bloom) {
            cameraScript.cameraEffects.bloom.intensity = this.nightFade * this.emissiveBloom;
        }

        // Update skybox intensity (always update, even if shaders are removed)
        const targetSkyboxIntensity = 1.0 * (1 - this.nightFade) + 0.2 * this.nightFade;
        this.app.scene.skyboxIntensity = targetSkyboxIntensity;

        // Fire events
        this.app.fire('nightFade', this.nightFade);
        this.app.fire('nightFade:changed', this.nightFade);
        
        // Always request render to ensure state changes are visible
        this.app.renderNextFrame = true;
    }

    /**
     * Toggle night mode on/off
     */
    toggle() {
        this.nightMode = !this.nightMode;
        this.enabled = this.nightMode;
    }

    /**
     * Set night mode state
     */
    setNightMode(enabled: boolean) {
        this.nightMode = enabled;
        this.enabled = enabled;
    }

    /** 是否开启夜间模式（供 Viewer 判断是否需与 Bloom Brush 合成） */
    get isNightModeEnabled(): boolean {
        return this.nightMode;
    }
}

export { NightMode };
