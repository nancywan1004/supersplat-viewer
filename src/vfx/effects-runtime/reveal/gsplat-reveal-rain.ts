import { Vec3, Color } from 'playcanvas';
import { GsplatShaderEffect } from '../gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform vec3 uCenter;
uniform float uDistance;
uniform float uSpeed;
uniform float uAcceleration;
uniform float uFlightTime;
uniform float uRainSize;
uniform float uRotation;
uniform vec3 uFallTint;
uniform float uFallTintIntensity;
uniform vec3 uHitTint;
uniform float uHitDuration;
uniform float uEndRadius;

// Shared globals (initialized once per vertex)
float g_dist2D;
float g_dist3D;
float g_tStart;
float g_tLand;

// Solve: distance = speed * t + 0.5 * acceleration * t²
float solveWaveTime(float dist) {
    if (uAcceleration == 0.0) {
        return dist / uSpeed;
    } else {
        // Quadratic formula: t = (-v + sqrt(v² + 2ad)) / a
        float discriminant = uSpeed * uSpeed + 2.0 * uAcceleration * dist;
        return (-uSpeed + sqrt(max(discriminant, 0.0))) / uAcceleration;
    }
}

void initShared(vec3 center) {
    vec2 center2D = center.xz;
    vec2 origin2D = uCenter.xz;
    g_dist2D = length(center2D - origin2D);
    g_dist3D = length(center - uCenter);
    g_tStart = solveWaveTime(g_dist2D);
    g_tLand = g_tStart + uFlightTime;
}

void modifySplatCenter(inout vec3 center) {
    vec3 originalCenter = center;
    initShared(center);
    
    float timeSinceLanding = uTime - g_tLand;
    if (timeSinceLanding >= 0.5) return;
    if (g_dist3D > uEndRadius) return;
    if (uTime < g_tStart) return;
    
    if (uTime < g_tLand) {
        float fallProgress = (uTime - g_tStart) / (g_tLand - g_tStart);
        center.y += uDistance * (1.0 - fallProgress);
        float angle = fallProgress * uRotation * 6.283185;
        float cosAngle = cos(angle);
        float sinAngle = sin(angle);
        float ox = originalCenter.x - uCenter.x;
        float oz = originalCenter.z - uCenter.z;
        center.x = uCenter.x + ox * cosAngle - oz * sinAngle;
        center.z = uCenter.z + ox * sinAngle + oz * cosAngle;
    }
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float timeSinceLanding = uTime - g_tLand;
    if (timeSinceLanding >= 0.5) return;
    if (g_dist3D > uEndRadius) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
    if (uTime < g_tStart) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
    if (timeSinceLanding < 0.5) {
        float originalSize = gsplatGetSizeFromScale(scale);
        if (timeSinceLanding < 0.0) {
            gsplatMakeSpherical(scale, min(uRainSize, originalSize));
        } else {
            float t = timeSinceLanding * 2.0;
            float size = mix(uRainSize, originalSize, t);
            gsplatMakeSpherical(scale, size);
        }
    }
}

void modifySplatColor(vec3 center, inout vec4 color) {
    // Check if animation is complete
    float timeSinceLanding = uTime - g_tLand;
    if (timeSinceLanding >= uHitDuration) return; // Effect complete, no modifications
    
    // Early exit for distant splats during animation
    if (g_dist3D > uEndRadius) return;
    
    // Before wave reaches: no color change (invisible anyway)
    if (uTime < g_tStart) return;
    
    if (timeSinceLanding < 0.0) {
        // Falling: blend between original and fall tint
        color.rgb = mix(color.rgb, uFallTint, uFallTintIntensity);
    } else if (timeSinceLanding < uHitDuration) {
        // Landing: apply hit tint, fade out
        float fadeOut = 1.0 - (timeSinceLanding / uHitDuration);
        color.rgb += uHitTint * fadeOut;
    }
    // After hit duration: original color (no change)
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uDistance: f32;
uniform uSpeed: f32;
uniform uAcceleration: f32;
uniform uFlightTime: f32;
uniform uRainSize: f32;
uniform uRotation: f32;
uniform uFallTint: vec3f;
uniform uFallTintIntensity: f32;
uniform uHitTint: vec3f;
uniform uHitDuration: f32;
uniform uEndRadius: f32;

// Shared globals (initialized once per vertex)
var<private> g_dist2D: f32;
var<private> g_dist3D: f32;
var<private> g_tStart: f32;
var<private> g_tLand: f32;

// Solve: distance = speed * t + 0.5 * acceleration * t²
fn solveWaveTime(dist: f32) -> f32 {
    if (uniform.uAcceleration == 0.0) {
        return dist / uniform.uSpeed;
    } else {
        // Quadratic formula: t = (-v + sqrt(v² + 2ad)) / a
        let discriminant = uniform.uSpeed * uniform.uSpeed + 2.0 * uniform.uAcceleration * dist;
        return (-uniform.uSpeed + sqrt(max(discriminant, 0.0))) / uniform.uAcceleration;
    }
}

fn initShared(center: vec3f) {
    let center2D = center.xz;
    let origin2D = uniform.uCenter.xz;
    g_dist2D = length(center2D - origin2D);
    g_dist3D = length(center - uniform.uCenter);
    g_tStart = solveWaveTime(g_dist2D);
    g_tLand = g_tStart + uniform.uFlightTime;
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let originalCenter = *center;
    initShared(*center);
    
    let timeSinceLanding = uniform.uTime - g_tLand;
    if (timeSinceLanding >= 0.5) { return; }
    if (g_dist3D > uniform.uEndRadius) { return; }
    if (uniform.uTime < g_tStart) { return; }
    
    if (uniform.uTime < g_tLand) {
        let fallProgress = (uniform.uTime - g_tStart) / (g_tLand - g_tStart);
        (*center).y += uniform.uDistance * (1.0 - fallProgress);
        let angle = fallProgress * uniform.uRotation * 6.283185;
        let cosAngle = cos(angle);
        let sinAngle = sin(angle);
        let offsetX = originalCenter.x - uniform.uCenter.x;
        let offsetZ = originalCenter.z - uniform.uCenter.z;
        (*center).x = uniform.uCenter.x + offsetX * cosAngle - offsetZ * sinAngle;
        (*center).z = uniform.uCenter.z + offsetX * sinAngle + offsetZ * cosAngle;
    }
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let timeSinceLanding = uniform.uTime - g_tLand;
    if (timeSinceLanding >= 0.5) { return; }
    if (g_dist3D > uniform.uEndRadius) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
    if (uniform.uTime < g_tStart) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
    if (timeSinceLanding < 0.5) {
        let originalSize = gsplatGetSizeFromScale(*scale);
        if (timeSinceLanding < 0.0) {
            gsplatMakeSpherical(scale, min(uniform.uRainSize, originalSize));
        } else {
            let t = timeSinceLanding * 2.0;
            let size = mix(uniform.uRainSize, originalSize, t);
            gsplatMakeSpherical(scale, size);
        }
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    // Check if animation is complete
    let timeSinceLanding = uniform.uTime - g_tLand;
    if (timeSinceLanding >= uniform.uHitDuration) {
        return; // Effect complete, no modifications
    }
    
    // Early exit for distant splats during animation
    if (g_dist3D > uniform.uEndRadius) {
        return;
    }
    
    // Before wave reaches: no color change (invisible anyway)
    if (uniform.uTime < g_tStart) {
        return;
    }
    
    if (timeSinceLanding < 0.0) {
        // Falling: blend between original and fall tint
        (*color) = vec4f(mix((*color).rgb, uniform.uFallTint, uniform.uFallTintIntensity), (*color).a);
    } else if (timeSinceLanding < uniform.uHitDuration) {
        // Landing: apply hit tint, fade out
        let fadeOut = 1.0 - (timeSinceLanding / uniform.uHitDuration);
        (*color) = vec4f((*color).rgb + uniform.uHitTint * fadeOut, (*color).a);
    }
    // After hit duration: original color (no change)
}
`;

/**
 * Rain reveal effect for gaussian splats.
 * Splats appear as small dots at an elevated position and fall down to land
 * when an expanding 3D sphere wave reaches them.
 *
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const rainScript = entity.script.create(GsplatRevealRain);
 * rainScript.center.set(0, 0, 0);
 * rainScript.distance = 5;
 * rainScript.speed = 3;
 */
class GsplatRevealRain extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealRain';

    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];

    _fallTintArray = [0, 0, 0];

    _hitTintArray = [0, 0, 0];

    /**
     * Origin point for the wave
     * @attribute
     */
    center = new Vec3(0, 0, 0);

    /**
     * Elevation above target position where splats start
     * @attribute
     * @range [0, 50]
     */
    distance = 30;

    /**
     * Wave speed in units/second
     * @attribute
     * @range [0, 10]
     */
    speed = 2;

    /**
     * Speed increase over time
     * @attribute
     * @range [0, 5]
     */
    acceleration = 0;

    /**
     * Duration of fall in seconds
     * @attribute
     * @range [0.1, 5]
     */
    flightTime = 2;

    /**
     * Size of particles while falling
     * @attribute
     * @range [0, 0.1]
     */
    rainSize = 0.015;

    /**
     * Rotation amount during fall (fraction of full circle, 0.9 = 90%)
     * @attribute
     * @range [0, 2]
     */
    rotation = 0.9;

    /**
     * Color during fall
     * @attribute
     */
    fallTint = new Color(0, 1, 1);

    /**
     * Blend intensity between original color and fall tint (0=original, 1=full tint)
     * @attribute
     * @range [0, 1]
     */
    fallTintIntensity = 0.2;

    /**
     * Additive color on landing (flash)
     * @attribute
     */
    hitTint = new Color(2, 0, 0);

    /**
     * Duration of hit tint flash in seconds
     * @attribute
     * @range [0, 2]
     */
    hitDuration = 0.5;

    /**
     * Distance at which to disable effect for performance
     * @attribute
     * @range [0, 500]
     */
    endRadius = 25;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // Update all uniforms first
        this.setUniform('uTime', effectTime);

        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        this.setUniform('uDistance', this.distance);
        this.setUniform('uSpeed', this.speed);
        this.setUniform('uAcceleration', this.acceleration);
        this.setUniform('uFlightTime', this.flightTime);
        this.setUniform('uRainSize', this.rainSize);
        this.setUniform('uRotation', this.rotation);

        this._fallTintArray[0] = this.fallTint.r;
        this._fallTintArray[1] = this.fallTint.g;
        this._fallTintArray[2] = this.fallTint.b;
        this.setUniform('uFallTint', this._fallTintArray);
        this.setUniform('uFallTintIntensity', this.fallTintIntensity);

        this._hitTintArray[0] = this.hitTint.r;
        this._hitTintArray[1] = this.hitTint.g;
        this._hitTintArray[2] = this.hitTint.b;
        this.setUniform('uHitTint', this._hitTintArray);

        this.setUniform('uHitDuration', this.hitDuration);
        this.setUniform('uEndRadius', this.endRadius);

        // Check if effect is complete after updating uniforms
        // This ensures the last frame is rendered with correct values
        if (this.isEffectComplete()) {
            console.log('Rain effect completed, disabling');
            this.notifyRevealComplete();
            return;
        }
    }

    /**
     * Calculate when the effect is complete.
     * Effect completes when the furthest splat within endRadius has finished animating.
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete() {
        // Calculate time for furthest splat within endRadius
        let maxTStart;
        if (this.acceleration === 0) {
            maxTStart = this.endRadius / this.speed;
        } else {
            // Quadratic formula: t = (-v + sqrt(v² + 2ad)) / a
            const discriminant = this.speed * this.speed + 2.0 * this.acceleration * this.endRadius;
            maxTStart = (-this.speed + Math.sqrt(Math.max(discriminant, 0.0))) / this.acceleration;
        }

        const maxTLand = maxTStart + this.flightTime;
        const maxCompletionTime = maxTLand + Math.max(0.5, this.hitDuration);

        return this.effectTime >= maxCompletionTime;
    }

    /** 与 isEffectComplete 对齐，供导出时间轴与「revealComplete 后再显示编辑内容」门控使用 */
    getCompletionTime(): number {
        let maxTStart: number;
        if (this.acceleration === 0) {
            maxTStart = this.endRadius / this.speed;
        } else {
            const discriminant = this.speed * this.speed + 2.0 * this.acceleration * this.endRadius;
            maxTStart = (-this.speed + Math.sqrt(Math.max(discriminant, 0.0))) / this.acceleration;
        }
        const maxTLand = maxTStart + this.flightTime;
        return maxTLand + Math.max(0.5, this.hitDuration);
    }
}

export { GsplatRevealRain };
