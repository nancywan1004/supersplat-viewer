import { Vec3 } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform vec3 uCenter;
uniform float uBottomY;
uniform float uTopY;
uniform float uCurrentHeight;
uniform float uFadeWidth;
uniform float uGrowthSpeed;
uniform float uEndRadius;
uniform vec3 uAabbMin;
uniform vec3 uAabbMax;
uniform float uEdgeScaleFactor;

// Shared globals
float g_dist;
float g_splatY;

void initShared(vec3 center) {
    g_dist = length(center - uCenter);
    g_splatY = center.y;
}

void modifyCenter(inout vec3 center) {
    initShared(center);
    // 不修改中心点位置
}

void modifyCovariance(vec3 originalCenter, vec3 modifiedCenter, inout vec3 covA, inout vec3 covB) {
    initShared(modifiedCenter);
    
    // AABB crop 效果：检查 splat 是否在 AABB 内
    bool insideAABB = all(greaterThanEqual(modifiedCenter, uAabbMin)) && all(lessThanEqual(modifiedCenter, uAabbMax));
    
    // 如果不在 AABB 内，隐藏
    if (!insideAABB) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // 【临时测试：从顶部向下生长】
    // currentGrowY 表示当前生长到的 Y 坐标位置（从 topY 开始向下）
    float currentGrowY = uTopY - uCurrentHeight;
    
    // 从顶部向下生长：只显示 Y 坐标大于等于当前生长高度的点
    // 如果 splat 的 Y 坐标低于当前生长高度，隐藏它
    if (g_splatY < currentGrowY) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // AABB 边缘裁剪：如果启用了精确裁剪，缩放边缘的 splats
    #ifdef GSPLAT_PRECISE_CROP
    // Conservative bound: use length(scale) * 3.0 (3 sigma)
    float maxRadius = length(vec3(covA.x, covB.x, covB.y)) * 3.0;
    
    // Find minimum distance to any AABB face
    vec3 distToMin = modifiedCenter - uAabbMin;
    vec3 distToMax = uAabbMax - modifiedCenter;
    float minDist = min(
        min(min(distToMin.x, distToMin.y), distToMin.z),
        min(min(distToMax.x, distToMax.y), distToMax.z)
    );
    
    // Scale if splat would exceed boundary
    if (maxRadius > minDist) {
        float s = (minDist / maxRadius) * uEdgeScaleFactor;
        // 缩放 covariance 以减小 splat 大小
        covA *= s;
        covB *= s;
    }
    #endif
    
    // 计算渐变区域的起始位置（当前生长高度的上方，因为是从上向下生长）
    float fadeStart = currentGrowY + uFadeWidth;
    
    // 如果 splat 在渐变区域内（currentGrowY 到 fadeStart 之间），保持原始形状
    // 透明度渐变在 modifyColor 中处理
    if (g_splatY >= currentGrowY && g_splatY < fadeStart) {
        // 在渐变区域内，保持原始形状，只在 modifyColor 中调整透明度
    }
    
    // 如果 splat 在完全显示区域（g_splatY >= fadeStart），保持原始大小和形状
}

void modifyColor(vec3 center, inout vec4 color) {
    initShared(center);
    
    // AABB crop 效果：检查 splat 是否在 AABB 内
    bool insideAABB = all(greaterThanEqual(center, uAabbMin)) && all(lessThanEqual(center, uAabbMax));
    if (!insideAABB) {
        color.a = 0.0;
        return;
    }
    
    // 【临时测试：从顶部向下生长】
    // 计算当前生长高度（从 topY 开始向下）
    float currentGrowY = uTopY - uCurrentHeight;
    
    // 如果 splat 的 Y 坐标低于当前生长高度，完全隐藏
    if (g_splatY < currentGrowY) {
        color.a = 0.0;
        return;
    }
    
    // 计算渐变区域（当前生长高度的上方）
    float fadeStart = currentGrowY + uFadeWidth;
    
    // 如果 splat 在渐变区域内，应用平滑透明度渐变
    if (g_splatY >= currentGrowY && g_splatY < fadeStart) {
        float fadeProgress = (fadeStart - g_splatY) / uFadeWidth;
        // 使用 smoothstep 创建平滑过渡：从顶部（fadeStart）到底部（currentGrowY）
        // fadeProgress 从 0（顶部）到 1（底部）
        // 我们希望顶部完全不透明，底部逐渐透明
        float fadeFactor = 1.0 - smoothstep(0.0, 1.0, fadeProgress);
        color.a *= fadeFactor;
    }
    
    // 如果 splat 在完全显示区域（g_splatY >= fadeStart），保持原始透明度
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uCenter: vec3f;
uniform uBottomY: f32;
uniform uTopY: f32;
uniform uCurrentHeight: f32;
uniform uFadeWidth: f32;
uniform uGrowthSpeed: f32;
uniform uEndRadius: f32;
uniform uAabbMin: vec3f;
uniform uAabbMax: vec3f;
uniform uEdgeScaleFactor: f32;

// Shared globals
var<private> g_dist: f32;
var<private> g_splatY: f32;

fn initShared(center: vec3f) {
    g_dist = length(center - uniform.uCenter);
    g_splatY = center.y;
}

fn modifyCenter(center: ptr<function, vec3f>) {
    initShared(*center);
    // 不修改中心点位置
}

fn modifyCovariance(originalCenter: vec3f, modifiedCenter: vec3f, covA: ptr<function, vec3f>, covB: ptr<function, vec3f>) {
    initShared(modifiedCenter);
    
    // AABB crop 效果：检查 splat 是否在 AABB 内
    let insideAABB = all(modifiedCenter >= uniform.uAabbMin) && all(modifiedCenter <= uniform.uAabbMax);
    
    // 如果不在 AABB 内，隐藏
    if (!insideAABB) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // 【临时测试：从顶部向下生长】
    // currentGrowY 表示当前生长到的 Y 坐标位置（从 topY 开始向下）
    let currentGrowY = uniform.uTopY - uniform.uCurrentHeight;
    
    // 从顶部向下生长：只显示 Y 坐标大于等于当前生长高度的点
    // 如果 splat 的 Y 坐标低于当前生长高度，隐藏它
    if (g_splatY < currentGrowY) {
        gsplatMakeRound(covA, covB, 0.0);
        return;
    }
    
    // AABB 边缘裁剪：如果启用了精确裁剪，缩放边缘的 splats
    #if GSPLAT_PRECISE_CROP
    // Conservative bound: use length(scale) * 3.0 (3 sigma)
    let maxRadius = length(vec3f((*covA).x, (*covB).x, (*covB).y)) * 3.0;
    
    // Find minimum distance to any AABB face
    let distToMin = modifiedCenter - uniform.uAabbMin;
    let distToMax = uniform.uAabbMax - modifiedCenter;
    let minDist = min(
        min(min(distToMin.x, distToMin.y), distToMin.z),
        min(min(distToMax.x, distToMax.y), distToMax.z)
    );
    
    // Scale if splat would exceed boundary
    if (maxRadius > minDist) {
        let s = (minDist / maxRadius) * uniform.uEdgeScaleFactor;
        // 缩放 covariance 以减小 splat 大小
        *covA = (*covA) * s;
        *covB = (*covB) * s;
    }
    #endif
    
    // 计算渐变区域的起始位置（当前生长高度的上方，因为是从上向下生长）
    let fadeStart = currentGrowY + uniform.uFadeWidth;
    
    // 如果 splat 在渐变区域内（currentGrowY 到 fadeStart 之间），保持原始形状
    if (g_splatY >= currentGrowY && g_splatY < fadeStart) {
        // 在渐变区域内，保持原始形状，只在 modifyColor 中调整透明度
    }
    
    // 如果 splat 在完全显示区域（g_splatY >= fadeStart），保持原始大小和形状
}

fn modifyColor(center: vec3f, color: ptr<function, vec4f>) {
    initShared(center);
    
    // AABB crop 效果：检查 splat 是否在 AABB 内
    let insideAABB = all(center >= uniform.uAabbMin) && all(center <= uniform.uAabbMax);
    if (!insideAABB) {
        (*color).a = 0.0;
        return;
    }
    
    // 【临时测试：从顶部向下生长】
    // 计算当前生长高度（从 topY 开始向下）
    let currentGrowY = uniform.uTopY - uniform.uCurrentHeight;
    
    // 如果 splat 的 Y 坐标低于当前生长高度，完全隐藏
    if (g_splatY < currentGrowY) {
        (*color).a = 0.0;
        return;
    }
    
    // 计算渐变区域（当前生长高度的上方）
    let fadeStart = currentGrowY + uniform.uFadeWidth;
    
    // 如果 splat 在渐变区域内，应用平滑透明度渐变
    if (g_splatY >= currentGrowY && g_splatY < fadeStart) {
        let fadeProgress = (fadeStart - g_splatY) / uniform.uFadeWidth;
        // 使用 smoothstep 创建平滑过渡：从顶部（fadeStart）到底部（currentGrowY）
        // fadeProgress 从 0（顶部）到 1（底部）
        // 我们希望顶部完全不透明，底部逐渐透明
        let fadeFactor = 1.0 - smoothstep(0.0, 1.0, fadeProgress);
        (*color).a *= fadeFactor;
    }
    
    // 如果 splat 在完全显示区域（g_splatY >= fadeStart），保持原始透明度
}
`;

/**
 * Grow reveal effect for gaussian splats.
 * Creates a vertical growth effect from bottom to top.
 * Splats below the current growth height are visible, with a smooth fade transition at the top edge.
 * Also includes AABB crop functionality to clip splats outside the bounding box.
 *
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const growScript = entity.script.create(GsplatRevealGrow);
 * growScript.center.set(0, 0, 0);
 * growScript.bottomY = -5.0;
 * growScript.topY = 5.0;
 * growScript.growthSpeed = 2.0;
 * growScript.fadeWidthRatio = 0.1;
 * growScript.aabbMin.set(-10, -10, -10);
 * growScript.aabbMax.set(10, 10, 10);
 */
class GsplatRevealGrow extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealGrow';

    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];
    _aabbMinArray = [0, 0, 0];
    _aabbMaxArray = [0, 0, 0];

    /**
     * Origin point for the effect (used for distance culling)
     * @attribute
     */
    center = new Vec3(0, 0, 0);

    /**
     * Bottom Y coordinate where growth starts
     * @attribute
     */
    bottomY = 0.0;

    /**
     * Top Y coordinate where growth ends
     * @attribute
     */
    topY = 10.0;

    /**
     * Current growth height (automatically calculated based on time)
     * @attribute
     */
    currentHeight = 0.0;

    /**
     * Fade width ratio (relative to total height)
     * @attribute
     * @range [0, 1]
     */
    fadeWidthRatio = 0.1;

    /**
     * Growth speed in units/second
     * @attribute
     * @range [0, 50]
     */
    growthSpeed = 5.0;

    /**
     * Distance at which to disable effect for performance
     * @attribute
     * @range [0, 500]
     */
    endRadius = 50.0;

    /**
     * Minimum corner of AABB in world space
     * @attribute
     */
    aabbMin = new Vec3(-0.5, -0.5, -0.5);

    /**
     * Maximum corner of AABB in world space
     * @attribute
     */
    aabbMax = new Vec3(0.5, 0.5, 0.5);

    /**
     * Scale factor for edge splats (lower = more aggressive scaling)
     * @attribute
     */
    edgeScaleFactor = 0.5;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    updateEffect(effectTime: number, dt: number) {
        // 确保 bottomY < topY（如果反了则交换）
        let actualBottomY = this.bottomY;
        let actualTopY = this.topY;
        const wasSwapped = actualBottomY > actualTopY;
        if (wasSwapped) {
            console.warn('⚠️ Warning: bottomY > topY, swapping values. Original:', {
                bottomY: this.bottomY,
                topY: this.topY
            });
            [actualBottomY, actualTopY] = [actualTopY, actualBottomY];
        }
        
        // Calculate current growth height based on time
        const totalHeight = actualTopY - actualBottomY;
        if (this.growthSpeed > 0 && totalHeight > 0) {
            this.currentHeight = Math.min(
                effectTime * this.growthSpeed,
                totalHeight
            );
        } else {
            this.currentHeight = 0;
        }

        // Calculate currentGrowY for debugging
        // 【临时测试：从顶部向下】currentGrowY 从 actualTopY 开始，减少到 actualBottomY
        const currentGrowY = actualTopY - this.currentHeight;
        
        // 每 0.5 秒打印一次调试信息（避免打印太频繁）
        // if (!this._lastDebugTime || effectTime - this._lastDebugTime >= 0.5) {
        //     console.log('🌱 Grow Effect Debug:', {
        //         effectTime: effectTime.toFixed(2) + 's',
        //         '原始值': { bottomY: this.bottomY.toFixed(2), topY: this.topY.toFixed(2) },
        //         '修正后': { bottomY: actualBottomY.toFixed(2), topY: actualTopY.toFixed(2) },
        //         wasSwapped: wasSwapped ? '⚠️ 已交换' : '✓ 正常',
        //         currentHeight: this.currentHeight.toFixed(2),
        //         currentGrowY: currentGrowY.toFixed(2),
        //         totalHeight: totalHeight.toFixed(2),
        //         growthSpeed: this.growthSpeed,
        //         progress: totalHeight > 0 ? ((this.currentHeight / totalHeight) * 100).toFixed(1) + '%' : '0%',
        //         '显示范围': `Y >= ${currentGrowY.toFixed(2)} (从 ${actualTopY.toFixed(2)} 向下到 ${actualBottomY.toFixed(2)})`
        //     });
        //     this._lastDebugTime = effectTime;
        // }
        
        // 使用修正后的值更新 uniforms
        this.setUniform('uBottomY', actualBottomY);
        this.setUniform('uTopY', actualTopY);

        // Update uniforms
        this.setUniform('uTime', effectTime);

        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        // uBottomY 和 uTopY 已经在上面设置了
        this.setUniform('uCurrentHeight', this.currentHeight);
        
        // Calculate fade width
        const fadeWidth = totalHeight * this.fadeWidthRatio;
        this.setUniform('uFadeWidth', fadeWidth);
        
        this.setUniform('uGrowthSpeed', this.growthSpeed);
        this.setUniform('uEndRadius', this.endRadius);

        // Set AABB uniforms
        this._aabbMinArray[0] = this.aabbMin.x;
        this._aabbMinArray[1] = this.aabbMin.y;
        this._aabbMinArray[2] = this.aabbMin.z;
        this.setUniform('uAabbMin', this._aabbMinArray);

        this._aabbMaxArray[0] = this.aabbMax.x;
        this._aabbMaxArray[1] = this.aabbMax.y;
        this._aabbMaxArray[2] = this.aabbMax.z;
        this.setUniform('uAabbMax', this._aabbMaxArray);

        // Set edge scale factor
        this.setUniform('uEdgeScaleFactor', this.edgeScaleFactor);

        // Check if effect is complete
        if (this.isEffectComplete()) {
            console.log('Grow effect completed, disabling');
            this.enabled = false;
            return;
        }
    }
    
    private _lastDebugTime: number = 0;

    /**
     * Calculate when the effect is complete.
     * Effect completes when growth reaches topY.
     * @returns {boolean} True if effect is complete
     */
    isEffectComplete() {
        const totalHeight = this.topY - this.bottomY;
        return this.currentHeight >= totalHeight;
    }

    /**
     * Get the completion time.
     * @returns {number} Time in seconds when the effect completes
     */
    getCompletionTime() {
        if (this.growthSpeed === 0) {
            return Infinity;
        }
        const totalHeight = this.topY - this.bottomY;
        return totalHeight / this.growthSpeed;
    }
}

export { GsplatRevealGrow };
