import { Mat4 } from 'playcanvas';
import { GsplatShaderEffect } from './gsplat-shader-effect';
import type { Texture } from 'playcanvas';
import type { Entity } from 'playcanvas';

const shaderGLSL = /* glsl */ `
uniform mat4 uModelViewProj;
uniform sampler2D uBloomMask;
uniform float uBloomThreshold;

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

// Bloom Brush：主场景不做任何裁剪，保持正常高斯渲染（不置黑）。
// 笔刷 mask 仅用于后处理阶段限制 bloom 叠加（见 viewer 中 bloom 与 mask 的合成）。
void modifySplatColor(vec3 center, inout vec4 color) {
}
`;

const shaderWGSL = /* wgsl */ `
uniform uModelViewProj: mat4x4f;
var uBloomMask: texture_2d<f32>;
var uBloomMaskSampler: sampler;
uniform uBloomThreshold: f32;

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
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
    }
}

export { BloomBrushFilter };
