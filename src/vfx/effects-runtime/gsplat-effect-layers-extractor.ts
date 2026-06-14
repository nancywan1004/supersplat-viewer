import type { GsplatShaderBlockLayer, GsplatShaderBlockLayerWgsl, GsplatShaderBlocks } from './gsplat-contribution';

/** PlayCanvas gsplatModifyVS 整段源码中拆出 composer 用 layered 片段（与引擎外壳函数名约定一致）。 */
function findParamCloseThenBrace(src: string, sigStart: number): number {
    const openParen = src.indexOf('(', sigStart);
    if (openParen < 0) return -1;
    let depth = 1;
    let i = openParen + 1;
    for (; i < src.length && depth > 0; i++) {
        const c = src[i];
        if (c === '(') depth++;
        else if (c === ')') depth--;
    }
    if (depth !== 0) return -1;
    const brace = src.indexOf('{', i);
    return brace >= 0 ? brace : -1;
}

function extractBracedBody(src: string, openBrace: number): string {
    let depth = 0;
    for (let i = openBrace; i < src.length; i++) {
        const c = src[i];
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                return src.slice(openBrace + 1, i).trim();
            }
        }
    }
    return '';
}

function extractGlslFunctionBody(full: string, signaturePrefix: string): string {
    const sig = full.indexOf(signaturePrefix);
    if (sig < 0) return '';
    const brace = findParamCloseThenBrace(full, sig);
    if (brace < 0) return '';
    return extractBracedBody(full, brace);
}

function extractWgslFunctionBody(full: string, signaturePrefix: string): string {
    const sig = full.indexOf(signaturePrefix);
    if (sig < 0) return '';
    const brace = findParamCloseThenBrace(full, sig);
    if (brace < 0) return '';
    return extractBracedBody(full, brace);
}

function glslHeaderBeforeModify(full: string): string {
    const idx = full.indexOf('void modifySplatCenter');
    if (idx < 0) {
        throw new Error('[gsplat-effect-layers-extractor] GLSL: void modifySplatCenter not found');
    }
    return full.slice(0, idx).trimEnd();
}

function wgslHeaderBeforeModify(full: string): string {
    const idx = full.indexOf('fn modifySplatCenter');
    if (idx < 0) {
        throw new Error('[gsplat-effect-layers-extractor] WGSL: fn modifySplatCenter not found');
    }
    return full.slice(0, idx).trimEnd();
}

/**
 * 将单文件 `gsplatModifyVS`（含 modifySplatCenter / RotationScale / Color）拆为 composer layered 块。
 * 与 NightMode、GsplatRevealPerlinWave 等 PlayCanvas gsplat 自定义着色约定一致。
 */
export function extractGlslWgslModifyBlocks(glslFull: string, wgslFull: string): GsplatShaderBlocks {
    const glsl: GsplatShaderBlockLayer = {
        header: glslHeaderBeforeModify(glslFull),
        applyPosition: extractGlslFunctionBody(glslFull, 'void modifySplatCenter'),
        applyRotationScale: extractGlslFunctionBody(glslFull, 'void modifySplatRotationScale'),
        applyColor: extractGlslFunctionBody(glslFull, 'void modifySplatColor')
    };
    const wgsl: GsplatShaderBlockLayerWgsl = {
        header: wgslHeaderBeforeModify(wgslFull),
        applyPosition: extractWgslFunctionBody(wgslFull, 'fn modifySplatCenter'),
        applyRotationScale: extractWgslFunctionBody(wgslFull, 'fn modifySplatRotationScale'),
        applyColor: extractWgslFunctionBody(wgslFull, 'fn modifySplatColor')
    };
    return { glsl, wgsl };
}

/** persistent perlin 在 GsplatEffectComposer 中的 id（与 effect id 对齐） */
export const PERLIN_WAVE_COMPOSER_ID = 'perlin-wave';

export const OVERALL_WAVE_COMPOSER_ID = 'overall-wave';

export const POINTILLISM_STIPPLE_COMPOSER_ID = 'pointillism-stipple';
