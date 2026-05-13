import { GsplatShaderEffect } from '../effects-runtime/gsplat-shader-effect';

const shaderGLSL = /* glsl */ `
uniform float uBloomThreshold;

void modifySplatCenter(inout vec3 center) {
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
}

// 线性亮度（支持 HDR，>1 为高光）；threshold 为线性 luminance 阈值，仅保留高于该值的片元
void modifySplatColor(vec3 center, inout vec4 color) {
    float luminance = dot(color.rgb, vec3(0.2126, 0.7152, 0.0722));
    if (luminance < uBloomThreshold) {
        color = vec4(0.0, 0.0, 0.0, 0.0);
    }
}
`;

const shaderWGSL = /* wgsl */ `
uniform uBloomThreshold: f32;

fn modifySplatCenter(center: ptr<function, vec3f>) {
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
}

// 线性亮度（支持 HDR，>1 为高光）；threshold 为线性 luminance 阈值
fn modifySplatColor(center: vec3f, color: ptr<function, vec4f>) {
    let luminance = dot((*color).rgb, vec3f(0.2126, 0.7152, 0.0722));
    if (luminance < uniform.uBloomThreshold) {
        *color = vec4f(0.0, 0.0, 0.0, 0.0);
    }
}
`;

/**
 * Bloom Debug 过滤：在 Gsplat 顶点/片元阶段按亮度阈值过滤，只保留高于 threshold 的亮部参与绘制。
 * 开启时场景 RT 为「仅亮部」，后处理 Bloom 在该 RT 上执行，便于调试参与 bloom 的区域。
 * 与 night-mode 同机制（GsplatShaderEffect + gsplatModifyVS），不修改 downsample 等后处理。
 */
class BloomDebugFilter extends GsplatShaderEffect {
    static scriptName = 'bloomDebugFilter';

    /** 亮度阈值（线性 HDR），低于此值的片元输出黑/透明；>1 可只保留高光。由 viewer 从 settings 同步。 */
    threshold: number = 0.2;

    getShaderGLSL(): string {
        return shaderGLSL;
    }

    getShaderWGSL(): string {
        return shaderWGSL;
    }

    updateEffect(_effectTime: number, _dt: number) {
        if (this.materialsApplied.size === 0) return;
        this.setUniform('uBloomThreshold', this.threshold);
    }
}

export { BloomDebugFilter };
