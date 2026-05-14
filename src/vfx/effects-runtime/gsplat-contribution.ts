/**
 * gsplat 顶点阶段贡献者协议（与 plan「GsplatContribution」对齐；M2 落类型与合成骨架）。
 */

export type GsplatContributionScope = 'scene' | 'asset';

/**
 * - `layered`：由 composer 将 header / apply* 拼进统一 modifySplat* 外壳（M2 默认）。
 * - `full`：贡献者提供**完整** `gsplatModifyVS` 文本；与 layered **不可混排**（混排时丢弃 layered 并告警）。
 *   与运行时产品约定对齐：**整段** `gsplatModifyVS` 由 `GsplatShaderEffect` 写入的路径，**仅**在播放**一次性开场 reveal** 时占主导；其余场景以 composer  layered 合成为主（见 `effects-pipeline-policy.ts`）。
 */
export type GsplatContributionSource = 'layered' | 'full';

/** 与引擎 gsplatModifyVS 中 modifySplat* 语义对齐的分层片段 */
export interface GsplatShaderBlockLayer {
    /** 函数外层的 uniform/辅助函数声明等 */
    header?: string;
    /** 写入 `modifySplatCenter` 体内的 GLSL 片段（可用 `center`） */
    applyPosition?: string;
    /** 写入 `modifySplatRotationScale` 体内的 GLSL 片段 */
    applyRotationScale?: string;
    /** 写入 `modifySplatColor` 体内的 GLSL 片段（可用 `center`、`color`） */
    applyColor?: string;
}

/** WGSL：片段写在 `modifySplat*` 体内，约定使用 `center` / `rotation` / `scale` / `color` 等 ptr 形参名与引擎 chunk 一致 */
export interface GsplatShaderBlockLayerWgsl {
    header?: string;
    applyPosition?: string;
    applyRotationScale?: string;
    applyColor?: string;
}

export interface GsplatShaderBlocks {
    glsl: GsplatShaderBlockLayer;
    wgsl: GsplatShaderBlockLayerWgsl;
}

export interface GsplatContributionCapabilities {
    /** 需要占用 gsplat 自定义槽位（占位，runtime 仲裁用） */
    requiresGsplatShaderSlot?: boolean;
    /** 与「光照类」独占语义冲突时参与互斥裁决（如多个 night-like） */
    exclusiveWithLighting?: boolean;
    /** 是否允许与主场景 persistent 贡献者并行存在（由 runtime 预审） */
    allowConcurrentWithPersistent?: boolean;
}

export interface GsplatContribution {
    id: string;
    /** 合成顺序：数值小的先应用，大的后应用（后到者覆盖感更强） */
    priority: number;
    scope: GsplatContributionScope;
    enabled: boolean;
    /** 参与 signature：结构/shader 变体变更时递增；uniform 每帧变化勿依赖此字段以免无意义重编译 */
    version: number;
    /** 与 scope=asset 搭配；M2 仅占位 */
    targetId?: string;
    /** 由 composer 合并后下发材质（可选）；NightMode 仍自管 setUniform 时可留空 */
    uniforms?: Record<string, number | number[] | Float32Array>;
    shaderBlocks: GsplatShaderBlocks;
    capabilities?: GsplatContributionCapabilities;
    /** 默认 layered；`full` 时需同时提供 fullModifyGlsl / fullModifyWgsl */
    source?: GsplatContributionSource;
    /** `source==='full'` 时：整段 gsplatModifyVS（GLSL） */
    fullModifyGlsl?: string;
    /** `source==='full'` 时：整段 gsplatModifyVS（WGSL） */
    fullModifyWgsl?: string;
}

export function emptyShaderBlocks(): GsplatShaderBlocks {
    return {
        glsl: {},
        wgsl: {}
    };
}
