import { Script, Color, Entity, Vec3, Mat4 } from 'playcanvas';
import { GsplatShaderEffect } from '../gsplat-shader-effect';
import { collectPointLights, collectSpotLights } from '../../light';
import type { Texture } from 'playcanvas';

const shaderGLSL = /* glsl */`
uniform vec3 uSpherePositions[10];
uniform vec3 uSphereColors[10];
uniform vec3 uSpotPositions[10];
uniform vec3 uSpotDirections[10];
uniform vec3 uSpotColors[10];
uniform vec4 uSpotParams[10];  // x=innerConeRad, y=outerConeRad, z=range, w=enabled
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

    vec4 worldPos = uModelMatrix * vec4(center, 1.0);
    worldPos /= worldPos.w;
    vec3 wpos = worldPos.xyz;

    vec3 sum = vec3(0.0);
    for (int i = 0; i < 10; ++i) {
        vec3 pos = uSpherePositions[i];
        vec3 clr = uSphereColors[i];
        if (length(pos) > 0.001) {
            float dist = length(pos - wpos);
            if (dist > 0.001) {
                sum += g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }
    for (int i = 0; i < 10; ++i) {
        if (uSpotParams[i].w < 0.5) continue;
        vec3 spotPos = uSpotPositions[i];
        vec3 spotDir = uSpotDirections[i];
        vec3 spotClr = uSpotColors[i];
        float range = uSpotParams[i].z;
        float innerCos = cos(uSpotParams[i].x);
        float outerCos = cos(uSpotParams[i].y);
        float cosOuter = min(innerCos, outerCos);
        float cosInner = max(innerCos, outerCos);
        vec3 toPoint = wpos - spotPos;
        float dist = length(toPoint);
        if (dist >= range || dist < 0.001) continue;
        vec3 L = toPoint / dist;
        float cosTheta = dot(L, spotDir);
        if (cosTheta <= cosOuter) continue;
        float spotAtt = (cosTheta >= cosInner) ? 1.0 : smoothstep(cosOuter, cosInner, cosTheta);
        sum += g2l(spotClr) * spotAtt * 1.1 / (dist * dist);
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
uniform vec3 uSpotPositions[10];
uniform vec3 uSpotDirections[10];
uniform vec3 uSpotColors[10];
uniform vec4 uSpotParams[10];
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
    vec3 wpos = worldPos.xyz;

    vec3 sum = vec3(0.0);
    for (int i = 0; i < 10; ++i) {
        vec3 pos = uSpherePositions[i];
        vec3 clr = uSphereColors[i];
        if (length(pos) > 0.001) {
            float dist = length(pos - wpos);
            if (dist > 0.001) {
                sum += g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }
    for (int i = 0; i < 10; ++i) {
        if (uSpotParams[i].w < 0.5) continue;
        vec3 spotPos = uSpotPositions[i];
        vec3 spotDir = uSpotDirections[i];
        vec3 spotClr = uSpotColors[i];
        float range = uSpotParams[i].z;
        float innerCos = cos(uSpotParams[i].x);
        float outerCos = cos(uSpotParams[i].y);
        float cosOuter = min(innerCos, outerCos);
        float cosInner = max(innerCos, outerCos);
        vec3 toPoint = wpos - spotPos;
        float dist = length(toPoint);
        if (dist >= range || dist < 0.001) continue;
        vec3 L = toPoint / dist;
        float cosTheta = dot(L, spotDir);
        if (cosTheta <= cosOuter) continue;
        float spotAtt = (cosTheta >= cosInner) ? 1.0 : smoothstep(cosOuter, cosInner, cosTheta);
        sum += g2l(spotClr) * spotAtt * 1.1 / (dist * dist);
    }

    vec3 linearColor = g2l(color.rgb);
    vec3 nightColor = g2l(uNightAmbient) + sum;
    color.rgb = l2g(linearColor * mix(vec3(1.0), nightColor, uNightFade));
}
`;

const shaderWGSL = /* wgsl */`
uniform uSpherePositions: array<vec3f, 10>;
uniform uSphereColors: array<vec3f, 10>;
uniform uSpotPositions: array<vec3f, 10>;
uniform uSpotDirections: array<vec3f, 10>;
uniform uSpotColors: array<vec3f, 10>;
uniform uSpotParams: array<vec4f, 10>;
uniform uNightFade: f32;
uniform uNightAmbient: vec3f;
uniform uModelMatrix: mat4x4f;

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

    let worldPos = uniform.uModelMatrix * vec4f(center, 1.0);
    let wpos = worldPos.xyz / worldPos.w;

    var sum = vec3f(0.0);
    for (var i = 0u; i < 10u; i++) {
        let pos = uniform.uSpherePositions[i];
        let clr = uniform.uSphereColors[i];
        if (length(pos) > 0.001) {
            let dist = length(pos - wpos);
            if (dist > 0.001) {
                sum = sum + g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }
    for (var i = 0u; i < 10u; i++) {
        if (uniform.uSpotParams[i].w < 0.5) { continue; }
        let spotPos = uniform.uSpotPositions[i];
        let spotDir = uniform.uSpotDirections[i];
        let spotClr = uniform.uSpotColors[i];
        let range = uniform.uSpotParams[i].z;
        let innerCos = cos(uniform.uSpotParams[i].x);
        let outerCos = cos(uniform.uSpotParams[i].y);
        let cosOuter = min(innerCos, outerCos);
        let cosInner = max(innerCos, outerCos);
        let toPoint = wpos - spotPos;
        let dist = length(toPoint);
        if (dist >= range || dist < 0.001) { continue; }
        let L = toPoint / dist;
        let cosTheta = dot(L, spotDir);
        if (cosTheta <= cosOuter) { continue; }
        var spotAtt = 1.0;
        if (cosTheta < cosInner) {
            spotAtt = smoothstep(cosOuter, cosInner, cosTheta);
        }
        sum = sum + g2l(spotClr) * spotAtt * 1.1 / (dist * dist);
    }

    let linearColor = g2l((*color).rgb);
    let nightColor = g2l(uniform.uNightAmbient) + sum;
    (*color).rgb = l2g(linearColor * mix(vec3f(1.0), nightColor, uniform.uNightFade));
}
`;

// Night Mode + Bloom Brush 合成：涂抹区域内亮部不应用 night mode（参与 bloom），暗部应用 night mode
const shaderWGSLBloomBrush = /* wgsl */`
uniform uSpherePositions: array<vec3f, 10>;
uniform uSphereColors: array<vec3f, 10>;
uniform uSpotPositions: array<vec3f, 10>;
uniform uSpotDirections: array<vec3f, 10>;
uniform uSpotColors: array<vec3f, 10>;
uniform uSpotParams: array<vec4f, 10>;
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
    let wpos = worldPos.xyz / worldPos.w;

    var sum = vec3f(0.0);
    for (var i = 0u; i < 10u; i++) {
        let pos = uniform.uSpherePositions[i];
        let clr = uniform.uSphereColors[i];
        if (length(pos) > 0.001) {
            let dist = length(pos - wpos);
            if (dist > 0.001) {
                sum = sum + g2l(clr) * 1.1 / (dist * dist);
            }
        }
    }
    for (var i = 0u; i < 10u; i++) {
        if (uniform.uSpotParams[i].w < 0.5) { continue; }
        let spotPos = uniform.uSpotPositions[i];
        let spotDir = uniform.uSpotDirections[i];
        let spotClr = uniform.uSpotColors[i];
        let range = uniform.uSpotParams[i].z;
        let innerCos = cos(uniform.uSpotParams[i].x);
        let outerCos = cos(uniform.uSpotParams[i].y);
        let cosOuter = min(innerCos, outerCos);
        let cosInner = max(innerCos, outerCos);
        let toPoint = wpos - spotPos;
        let dist = length(toPoint);
        if (dist >= range || dist < 0.001) { continue; }
        let L = toPoint / dist;
        let cosTheta = dot(L, spotDir);
        if (cosTheta <= cosOuter) { continue; }
        var spotAtt = 1.0;
        if (cosTheta < cosInner) {
            spotAtt = smoothstep(cosOuter, cosInner, cosTheta);
        }
        sum = sum + g2l(spotClr) * spotAtt * 1.1 / (dist * dist);
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

        // 注意：不调用 setupUnifiedEventListener()。
        // NightMode 不应在材质创建时自动应用 shader，否则会覆盖 reveal 效果的 gsplatModifyVS。
        // NightMode 仅在 nightMode 被切换为 true 时才通过 updateEffect() 中的重试机制应用 shader。

        // 监听 reveal 等互斥效果接管 gsplatModifyVS 的信号，立即退出 nightMode
        this.app.on('nightMode:exit', () => {
            if (!this.nightMode) return;
            this.nightMode = false;
            this.nightFade = 0;
            this.manualFadeControl = false;
            this.materialsApplied.clear(); // 不删除 shader chunk，由接管方负责
            this.app.fire('nightMode:changed', false);
            this.app.fire('nightFade:changed', 0);
        });

        // Try to initialize if splat is already available
        if (this.splat?.gsplat) {
            this.initialized = true;
            // 只在 nightMode 已开启时才应用 shader，避免覆盖 reveal
            if (this.enabled && this.nightMode) {
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
            // this.camera = Entity, this.camera.camera = CameraComponent
            // this.camera.camera.camera = Camera 实例（内部渲染对象）
            // getGSplatMaterial() 需要 Camera 实例作为 key，传 CameraComponent 会查找失败
            targetCameras = [this.camera.camera.camera];
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
        
        // 当 nightMode 关闭且 fade 回 0 时，只清空 materialsApplied 追踪集，
        // 不删除 gsplatModifyVS shader chunk。原因：
        // 1. NightMode shader 自带 `if (uNightFade == 0.0) return;`，nightFade=0 时完全透明
        // 2. 删除 gsplatModifyVS 会连带破坏其他使用同一 chunk 的效果（如 reveal）
        // 3. 清空 materialsApplied 以便下次切换 nightMode 时重新 applyShaders()
        if (!this.nightMode && this.nightFade < 1e-6 && this.materialsApplied.size > 0) {
            this.materialsApplied.clear();
            this.app.renderNextFrame = true;
        }

        if (this.nightMode && this.materialsApplied.size === 0 && this.splat?.gsplat) {
            this.applyShaders();
            if (!this.manualFadeControl) {
                this.app.fire('nightFade:changed', this.nightFade);
            }
        }

        // 从场景中的 Light 实体收集点光源与聚光灯，上限各 10 个（供高斯 night mode 打光）
        const global = (this.app as any).__global;
        const pointLights = global ? collectPointLights(global) : [];
        const spotLights = global ? collectSpotLights(global) : [];
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

        const spotPositions: number[] = [];
        const spotDirections: number[] = [];
        const spotColors: number[] = [];
        const spotParams: number[] = [];
        for (let i = 0; i < 10; ++i) {
            const sl = spotLights[i];
            if (!sl) {
                spotPositions.push(0, 0, 0);
                spotDirections.push(0, 0, -1);
                spotColors.push(0, 0, 0);
                spotParams.push(0, 0, 0, 0);
            } else {
                spotPositions.push(sl.position.x, sl.position.y, sl.position.z);
                spotDirections.push(sl.direction.x, sl.direction.y, sl.direction.z);
                spotColors.push(
                    sl.color.r * sl.intensity * scale,
                    sl.color.g * sl.intensity * scale,
                    sl.color.b * sl.intensity * scale
                );
                spotParams.push(sl.innerConeAngle, sl.outerConeAngle, sl.range, 1);
            }
        }

        // ── 关键：根据 unified 模式选择 uModelMatrix ──
        // modifySplatColor(vec3 center, …) 中用 uModelMatrix * center 来算世界位置。
        //   - unified=false: engine 传 model-space center → 需要 model→world 变换
        //   - unified=true:  engine 传 world-space center → 不需要变换（用单位矩阵）
        const isUnified = this.splat?.gsplat?.unified ?? false;
        let modelMatrix: number[] = [];
        if (isUnified) {
            // unified: center 已是 world space，不再变换
            modelMatrix = [
                1, 0, 0, 0,
                0, 1, 0, 0,
                0, 0, 1, 0,
                0, 0, 0, 1
            ];
        } else if (this.splat) {
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
            this.setUniform('uSpotPositions[0]', spotPositions);
            this.setUniform('uSpotDirections[0]', spotDirections);
            this.setUniform('uSpotColors[0]', spotColors);
            this.setUniform('uSpotParams[0]', spotParams);
            this.setUniform('uNightFade', this.nightFade);
            this.setUniform('uNightAmbient', [
                this.nightAmbient.r,
                this.nightAmbient.g,
                this.nightAmbient.b
            ]);
            this.setUniform('uModelMatrix', modelMatrix);
            if (this.bloomBrushActive && this.bloomBrushMask && this.camera?.camera && this.splat) {
                const cam = this.camera.camera;
                if (isUnified) {
                    // unified: center 已是 world space → 只需 view * projection（不含 model）
                    this._bloomBrushModelViewProj.mul2(cam.projectionMatrix, cam.viewMatrix);
                } else {
                    // non-unified: center 是 model space → 需要 projection * view * model
                    this._bloomBrushModelViewProj.copy(cam.viewMatrix);
                    this._bloomBrushModelViewProj.mul2(this._bloomBrushModelViewProj, this.splat.getWorldTransform());
                    this._bloomBrushModelViewProj.mul2(cam.projectionMatrix, this._bloomBrushModelViewProj);
                }
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

    /**
     * Set night fade (0–1). Enables manual control so fade is not auto-animated.
     */
    setNightFade(value: number) {
        const clamped = Math.max(0, Math.min(1, value));
        this.manualFadeControl = true;
        this.nightFade = clamped;
        if (this.materialsApplied.size > 0) {
            this.updateEffect(this.effectTime, 0);
        }
        this.app.fire('nightFade:changed', this.nightFade);
    }

    /**
     * Apply night mode state from settings (e.g. after load). Fires events so UI syncs.
     */
    applyFromSettings(config: { enabled: boolean; fade?: number }) {
        console.log('applyFromSettings', config);
        if (!config || typeof config.enabled !== 'boolean') return;
        this.nightMode = config.enabled;
        this.enabled = config.enabled;
        if (this.nightMode) {
            this.manualFadeControl = true;
            const fade = typeof config.fade === 'number' ? Math.max(0, Math.min(1, config.fade)) : 0.95;
            this.nightFade = fade;
            if (this.splat?.gsplat && this.materialsApplied.size === 0) {
                this.applyShaders();
            }
            if (this.materialsApplied.size > 0) {
                this.updateEffect(this.effectTime, 0);
            }
        } else {
            this.nightFade = 0;
            this.manualFadeControl = false;
        }
        this.app.fire('nightMode:changed', this.nightMode);
        this.app.fire('nightFade:changed', this.nightFade);
    }

    /** 是否开启夜间模式（供 Viewer 判断是否需与 Bloom Brush 合成） */
    get isNightModeEnabled(): boolean {
        return this.nightMode;
    }
}

export { NightMode };
