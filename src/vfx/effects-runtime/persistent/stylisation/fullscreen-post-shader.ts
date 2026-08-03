import {
    SEMANTIC_POSITION,
    ShaderUtils,
    type GraphicsDevice,
    type Shader
} from 'playcanvas';

/** 全屏四边形默认 VS（与各风格化 PostEffect 一致）
 * WebGPU 必须经 getImageEffectUV，否则 RT 采样上下颠倒。
 */
export const FULLSCREEN_POST_VERTEX_GLSL = /* glsl */ `
attribute vec2 aPosition;
varying vec2 vUv0;
void main(void) {
    gl_Position = vec4(aPosition, 0.0, 1.0);
    vUv0 = getImageEffectUV((aPosition.xy + 1.0) * 0.5);
}
`;

/**
 * 创建可用于 WebGL / WebGPU 的全屏后处理 shader。
 *
 * 不可用裸 `new Shader({ vshader, fshader })`：在 WebGPU 上缺少引擎 preamble，
 * glslang 转译会失败（`GLSL compilation failed` / 黑屏）。
 * 走 {@link ShaderUtils.createShader}，与 ShaderMaterial 路径一致。
 */
export function createFullscreenPostShader(
    device: GraphicsDevice,
    options: {
        uniqueName: string;
        fragmentGLSL: string;
        vertexGLSL?: string;
        vertexWGSL?: string;
        fragmentWGSL?: string;
    }
): Shader {
    return ShaderUtils.createShader(device, {
        uniqueName: options.uniqueName,
        attributes: { aPosition: SEMANTIC_POSITION },
        vertexGLSL: options.vertexGLSL ?? FULLSCREEN_POST_VERTEX_GLSL,
        fragmentGLSL: options.fragmentGLSL,
        ...(options.vertexWGSL ? { vertexWGSL: options.vertexWGSL } : {}),
        ...(options.fragmentWGSL ? { fragmentWGSL: options.fragmentWGSL } : {})
    });
}
