import { Mat4 } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';
import type { Texture } from 'playcanvas';
import type { Entity } from 'playcanvas';

const MAX_POINTS = 256;

const shaderGLSL = /* glsl */ `
uniform mat4 uModelViewProj;
uniform sampler2D uBloomMask;
uniform float uBloomThreshold;
uniform int uBloomMode;
uniform vec4 uBloomPoints[` + MAX_POINTS + `];
uniform int uBloomPointCount;
uniform float uBloomBrushLocalBrightness;

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

// Bloom Brush：主场景不做任何裁剪，保持正常高斯渲染（不置黑）。
// 笔刷 mask 仅用于后处理阶段限制 bloom 叠加（见 viewer 中 bloom 与 mask 的合成）。
// 世界空间模式下基于世界坐标距离判断，不考虑可见性/遮挡，
// 因此被遮挡的 bloom 点仍然影响该位置的 splat（Requirement 7.3）。
void modifySplatColor(vec3 center, inout vec4 color) {
    if (uBloomMode == 1) {
        // World space mode: check if splat center is within any bloom point's influence
        float bloomMask = 0.0;
        for (int i = 0; i < uBloomPointCount; i++) {
            vec3 bloomPos = uBloomPoints[i].xyz;
            float bloomRadius = uBloomPoints[i].w;
            float dist = distance(center, bloomPos);
            if (dist < bloomRadius) {
                // Smooth transition using smoothstep
                float t = 1.0 - smoothstep(bloomRadius * 0.5, bloomRadius, dist);
                bloomMask = max(bloomMask, t);
                // Early exit: if bloomMask is already at max (1.0), no need to check more points
                if (bloomMask >= 1.0) break;
            }
        }
        // Boost brightness of splats within bloom regions so they feed into
        // the bloom pass. The projected 2D mask in compose stage limits where
        // bloom glow actually appears on screen.
        // uBloomBrushLocalBrightness: -1~1, 0=no change, <0 darken, >0 brighten (persisted on Set).
        if (bloomMask > 0.0) {
            color.rgb *= 1.0 + bloomMask * 0.5;
            color.rgb *= 1.0 + uBloomBrushLocalBrightness * bloomMask;
        }
    }
}
`;

const shaderWGSL = /* wgsl */ `
uniform uModelViewProj: mat4x4f;
var uBloomMask: texture_2d<f32>;
var uBloomMaskSampler: sampler;
uniform uBloomThreshold: f32;
uniform uBloomMode: i32;
uniform uBloomPoints: array<vec4f, ` + MAX_POINTS + `>;
uniform uBloomPointCount: i32;
uniform uBloomBrushLocalBrightness: f32;

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

// 世界空间模式下基于世界坐标距离判断，不考虑可见性/遮挡，
// 因此被遮挡的 bloom 点仍然影响该位置的 splat（Requirement 7.3）。
fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    if (uniform.uBloomMode == 1) {
        // World space mode: check if splat center is within any bloom point's influence
        var bloomMask: f32 = 0.0;
        for (var i: i32 = 0; i < uniform.uBloomPointCount; i = i + 1) {
            let bloomPos = uniform.uBloomPoints[i].xyz;
            let bloomRadius = uniform.uBloomPoints[i].w;
            let dist = distance(center, bloomPos);
            if (dist < bloomRadius) {
                // Smooth transition using smoothstep
                let t = 1.0 - smoothstep(bloomRadius * 0.5, bloomRadius, dist);
                bloomMask = max(bloomMask, t);
                // Early exit: if bloomMask is already at max (1.0), no need to check more points
                if (bloomMask >= 1.0) { break; }
            }
        }
        // Boost brightness of splats within bloom regions so they feed into
        // the bloom pass. The projected 2D mask in compose stage limits where
        // bloom glow actually appears on screen.
        // uBloomBrushLocalBrightness: -1~1, 0=no change, <0 darken, >0 brighten (persisted on Set).
        if (bloomMask > 0.0) {
            (*color).r *= 1.0 + bloomMask * 0.5;
            (*color).g *= 1.0 + bloomMask * 0.5;
            (*color).b *= 1.0 + bloomMask * 0.5;
            let localBright = 1.0 + uniform.uBloomBrushLocalBrightness * bloomMask;
            (*color).r *= localBright;
            (*color).g *= localBright;
            (*color).b *= localBright;
        }
    }
}
`;

/**
 * Bloom Brush：用 2D mask 纹理控制哪些屏幕区域参与 bloom；mask 在顶点阶段按 splat 中心投影到屏幕 UV 采样。
 * 可选 threshold 只保留「在 mask 内且亮度 ≥ threshold」的片元。与 BloomDebugFilter 互斥（同写 gsplatModifyVS）。
 */
class BloomBrushFilter extends GsplatShaderEffect {
    static scriptName = 'bloomBrushFilter';

    /** 亮度阈值（线性 HDR），与 bloom-debug 一致；仅 mask 内且 luminance >= 此值才保留 */
    threshold: number = 0.2;

    /** Mask 纹理（由 BloomBrushPainter 提供） */
    maskTexture: Texture | null = null;

    /** 相机实体（用于每帧计算 modelViewProj） */
    cameraEntity: Entity | null = null;

    /** Bloom mode: 0 = screen space, 1 = world space */
    bloomMode: number = 0;

    /** World space bloom points (vec4: xyz=position, w=radius) */
    bloomPoints: Float32Array = new Float32Array(MAX_POINTS * 4);

    /** Number of active bloom points */
    bloomPointCount: number = 0;

    /** Local brightness for selected region: -1~1, 0=no change (set from settings.bloom.bloomBrushBrightness) */
    bloomBrushLocalBrightness: number = 0;

    private _modelViewProj: Mat4 = new Mat4();

    getShaderGLSL(): string {
        return shaderGLSL;
    }

    getShaderWGSL(): string {
        return shaderWGSL;
    }

    updateEffect(_effectTime: number, _dt: number) {
        if (this.materialsApplied.size === 0) return;
        const cam = this.cameraEntity?.camera;
        if (cam) {
            // unified 模式下 center 已是 world space → MVP 只需 projection * view（不含 model）
            const isUnified = (this.entity as any).gsplat?.unified ?? false;
            if (isUnified) {
                this._modelViewProj.mul2(cam.projectionMatrix, cam.viewMatrix);
            } else {
                this._modelViewProj.mul2(cam.viewMatrix, this.entity.getWorldTransform());
                this._modelViewProj.mul2(cam.projectionMatrix, this._modelViewProj);
            }
            this.setUniform('uModelViewProj', this._modelViewProj.data);
        }
        if (this.maskTexture) {
            this.materialsApplied.forEach((material) => {
                material.setParameter('uBloomMask', this.maskTexture!);
            });
            this.app.renderNextFrame = true;
        }
        this.setUniform('uBloomThreshold', this.threshold);
        
        // Set world space bloom uniforms
        this.setUniform('uBloomMode', this.bloomMode);
        this.setUniform('uBloomPoints', this.bloomPoints);
        this.setUniform('uBloomPointCount', this.bloomPointCount);
        this.setUniform('uBloomBrushLocalBrightness', Math.max(-1, Math.min(1, this.bloomBrushLocalBrightness)));
    }
}

export { BloomBrushFilter, MAX_POINTS };
