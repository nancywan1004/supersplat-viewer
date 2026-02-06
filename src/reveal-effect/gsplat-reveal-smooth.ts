import { Vec3, Color } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform vec3 uCenter;
uniform float uCurrentLightRadius;
uniform float uFadeWidth;
uniform int uTransitionEffect;
uniform vec2 uViewport;
uniform mat4 uModelViewMatrix;
uniform mat4 uProjectionMatrix;

// Hash function for per-splat randomization
float hash(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453);
}

void modifySplatCenter(inout vec3 center) {
    // 平滑过渡效果不修改中心点位置
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float distanceToCenter = length(originalCenter - uCenter);
    float fadeStart = uCurrentLightRadius - uFadeWidth;
    
    if (distanceToCenter >= uCurrentLightRadius) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
    // 完全显示或过渡区域：保持原始形状，透明度在 modifySplatColor 中处理
}

void modifySplatColor(vec3 center, inout vec4 color) {
    // 计算到过渡中心的距离
    float distanceToCenter = length(center - uCenter);
    
    // 计算渐变区域
    float fadeStart = uCurrentLightRadius - uFadeWidth;
    
    if (distanceToCenter >= uCurrentLightRadius) {
        // 完全隐藏
        color.a = 0.0;
    } else if (distanceToCenter >= fadeStart) {
        // 过渡区域：应用平滑透明度渐变
        float fadeProgress = (distanceToCenter - fadeStart) / uFadeWidth;
        color.a *= (1.0 - smoothstep(0.0, 1.0, fadeProgress));
    }
    // 完全显示区域：保持原始颜色和透明度
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uCurrentLightRadius: f32;
uniform uFadeWidth: f32;
uniform uTransitionEffect: i32;
uniform uViewport: vec2f;
uniform uModelViewMatrix: mat4x4f;
uniform uProjectionMatrix: mat4x4f;

// Hash function for per-splat randomization
fn hash(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    // 平滑过渡效果不修改中心点位置
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let distanceToCenter = length(originalCenter - uniform.uCenter);
    let fadeStart = uniform.uCurrentLightRadius - uniform.uFadeWidth;
    
    if (distanceToCenter >= uniform.uCurrentLightRadius) {
        gsplatMakeSpherical(scale, 0.0);
        return;
    }
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    // 计算到过渡中心的距离
    let distanceToCenter = length(center - uniform.uCenter);
    
    // 计算渐变区域
    let fadeStart = uniform.uCurrentLightRadius - uniform.uFadeWidth;
    
    if (distanceToCenter >= uniform.uCurrentLightRadius) {
        // 完全隐藏
        (*color).a = 0.0;
    } else if (distanceToCenter >= fadeStart) {
        // 过渡区域：应用平滑透明度渐变
        let fadeProgress = (distanceToCenter - fadeStart) / uniform.uFadeWidth;
        (*color).a *= (1.0 - smoothstep(0.0, 1.0, fadeProgress));
    }
    // 完全显示区域：保持原始颜色和透明度
}
`;

/**
 * 平滑过渡显示效果，用于 Gaussian Splats
 * 从中心点向外扩散，创建一个圆形的平滑过渡边界
 * 
 * 基于 SplatVertex.glsl 中的 transitionEffect == 1 实现
 * 
 * @example
 * // 添加脚本到 gsplat entity
 * const smoothEffect = new GsplatRevealSmooth();
 * smoothEffect.center = new Vector3(0, 0, 0);
 * smoothEffect.currentLightRadius = 10;
 * smoothEffect.fadeWidthRatio = 0.1;
 * smoothEffect.applyToMaterial(splatMaterial);
 */
class GsplatRevealSmooth extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealSmooth';

    // 可重用数组用于 uniform 更新
    _centerArray = [0, 0, 0];

    /**
     * 过渡效果的中心点
     * @attribute
     */
    center = new Vec3(0, 0, 0);

    /**
     * 当前可见半径
     * @attribute
     * @range [0, 100]
     */
    currentLightRadius = 10;

    /**
     * 渐变宽度比例（相对于 currentLightRadius）
     * @attribute
     * @range [0, 1]
     */
    fadeWidthRatio = 0.1;

    /**
     * 过渡效果类型
     * 1: 圆形扩散（默认）
     * 2: 从中心向外
     * 3: 水平扩散
     * 4: 垂直扩散
     * @attribute
     * @range [1, 4]
     */
    transitionEffect = 1;

    /**
     * 半径增长速度（单位/秒）
     * @attribute
     * @range [0, 50]
     */
    growthSpeed = 5;

    /**
     * 最大半径（效果完成时的半径）
     * @attribute
     * @range [0, 500]
     */
    maxRadius = 50;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // 根据时间自动增长半径
        if (this.growthSpeed > 0) {
            this.currentLightRadius = Math.min(
                effectTime * this.growthSpeed,
                this.maxRadius
            );
        }

        // 更新 uniforms
        this.setUniform('uTime', effectTime);

        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        this.setUniform('uCurrentLightRadius', this.currentLightRadius);
        
        // 计算渐变宽度
        const fadeWidth = this.currentLightRadius * this.fadeWidthRatio;
        this.setUniform('uFadeWidth', fadeWidth);
        
        this.setUniform('uTransitionEffect', this.transitionEffect);

        // 检查效果是否完成
        if (this.isEffectComplete()) {
            console.log('Smooth transition effect completed, disabling');
            this.enabled = false;
            return;
        }
    }

    /**
     * 计算效果完成时间
     * @returns {number} 效果完成的时间（秒）
     */
    getCompletionTime() {
        if (this.growthSpeed === 0) {
            return Infinity;
        }
        return this.maxRadius / this.growthSpeed;
    }

    /**
     * 检查过渡效果是否完成
     * @returns {boolean} 如果效果完成返回 true
     */
    isEffectComplete() {
        return this.currentLightRadius >= this.maxRadius;
    }
}

export { GsplatRevealSmooth };
