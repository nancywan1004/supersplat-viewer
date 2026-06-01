import {
    SHADERLANGUAGE_GLSL,
    SHADERLANGUAGE_WGSL,
    ShaderChunks,
    type GraphicsDevice,
    type Material
} from 'playcanvas';

const patchedMaterials = new WeakSet<Material>();

const safeChunkReplace = (s: string, find: string | RegExp, repl: string) => {
    const out = s.replace(find, repl);
    if (out === s) {
        throw new Error('gsplat exclude mask: engine gsplatPS chunk patch failed (engine version mismatch?)');
    }
    return out;
};

/** 通过 alpha 测试的 splat 片元输出绿色，和 render 资产的红色 mask 区分。 */
export const patchGsplatExcludeMaskGlsl = (chunk: string) =>
    safeChunkReplace(
        chunk,
        'gl_FragColor = vec4(gaussianColor.xyz * alpha, alpha);',
        'gl_FragColor = vec4(0.0, 1.0, 0.0, 1.0);'
    );

export const patchGsplatExcludeMaskWgsl = (chunk: string) =>
    safeChunkReplace(
        chunk,
        'output.color = vec4f(vec3f(gaussianColor.xyz * alpha), f32(alpha));',
        'output.color = vec4f(0.0, 1.0, 0.0, 1.0);'
    );

const resolveGsplatPsChunk = (device: GraphicsDevice, material: Material, lang: string) => {
    const matChunks = material.getShaderChunks(lang);
    const fromMat = matChunks.get('gsplatPS');
    if (fromMat) return fromMat;
    return ShaderChunks.get(device, lang).get('gsplatPS');
};

/**
 * 仅 patch exclude 相机 + PlacedMeshExclude 层对应的 unified gsplat 材质；
 * 主相机 World 层材质不受影响。
 */
export const applyGsplatExcludeMaskShaderToMaterial = (material: Material, device: GraphicsDevice) => {
    if (patchedMaterials.has(material)) return;

    const glslBase = resolveGsplatPsChunk(device, material, SHADERLANGUAGE_GLSL);
    const wgslBase = resolveGsplatPsChunk(device, material, SHADERLANGUAGE_WGSL);
    if (!glslBase || !wgslBase) return;

    material.getShaderChunks(SHADERLANGUAGE_GLSL).set(
        'gsplatPS',
        patchGsplatExcludeMaskGlsl(glslBase)
    );
    material.getShaderChunks(SHADERLANGUAGE_WGSL).set(
        'gsplatPS',
        patchGsplatExcludeMaskWgsl(wgslBase)
    );
    material.clearVariants();
    patchedMaterials.add(material);
};
