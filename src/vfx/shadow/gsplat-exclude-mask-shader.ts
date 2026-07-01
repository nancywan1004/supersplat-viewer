import {
    SHADERLANGUAGE_GLSL,
    SHADERLANGUAGE_WGSL,
    type GraphicsDevice,
    type Material
} from 'playcanvas';

/** 写入 gsplatModifyPS 供 idempotent 检测。 */
const EXCLUDE_MASK_MARKER = 'GSPLAT_EXCLUDE_MASK';

/**
 * 通过 modifySplatColor 将 splat 输出强制为绿色 mask（G=1），保留 gsplatPS 内 alpha discard。
 * 不 patch gsplatPS 整段，避免引擎升级后片元输出语句变化导致 patch 失败。
 */
export const gsplatExcludeMaskModifyPsGlsl = /* glsl */ `
// ${EXCLUDE_MASK_MARKER}
void modifySplatColor(vec2 gaussianUV, inout vec4 color) {
    color = vec4(0.0, 1.0, 0.0, 1.0);
}
`;

export const gsplatExcludeMaskModifyPsWgsl = /* wgsl */ `
// ${EXCLUDE_MASK_MARKER}
fn modifySplatColor(gaussianUV: vec2f, color: ptr<function, vec4f>) {
    *color = vec4f(0.0, 1.0, 0.0, 1.0);
}
`;

const isExcludeMaskPatched = (material: Material, lang: string): boolean => {
    const chunk = material.getShaderChunks(lang).get('gsplatModifyPS');
    return typeof chunk === 'string' && chunk.includes(EXCLUDE_MASK_MARKER);
};

/**
 * 仅 patch exclude 相机 + PlacedMeshExclude 层对应的 unified gsplat 材质；
 * 主相机 World 层材质不受影响。
 */
export const applyGsplatExcludeMaskShaderToMaterial = (material: Material, _device: GraphicsDevice) => {
    if (
        isExcludeMaskPatched(material, SHADERLANGUAGE_GLSL)
        && isExcludeMaskPatched(material, SHADERLANGUAGE_WGSL)
    ) {
        return;
    }

    material.getShaderChunks(SHADERLANGUAGE_GLSL).set('gsplatModifyPS', gsplatExcludeMaskModifyPsGlsl);
    material.getShaderChunks(SHADERLANGUAGE_WGSL).set('gsplatModifyPS', gsplatExcludeMaskModifyPsWgsl);
    material.clearVariants();
};
