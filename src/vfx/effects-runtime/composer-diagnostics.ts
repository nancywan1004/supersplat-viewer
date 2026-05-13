export const ComposerDiagnosticCode = {
    OK: 'COMPOSER_OK',
    CONFLICT_REDUCED: 'COMPOSER_CONFLICT_REDUCED',
    SCENE_CAP_DEGRADED: 'COMPOSER_SCENE_CAP_DEGRADED',
    ASSET_CAP_DEGRADED: 'COMPOSER_ASSET_CAP_DEGRADED',
    COMPOSE_ERROR: 'COMPOSER_COMPOSE_ERROR'
} as const;

export type ComposerDiagnosticCodeType = (typeof ComposerDiagnosticCode)[keyof typeof ComposerDiagnosticCode];

export interface ComposerDiagnostic {
    code: ComposerDiagnosticCodeType;
    message?: string;
    contributionId?: string;
}

export interface ComposedGsplatModifyResult {
    compositionSignature: string;
    gsplatModifyGlsl: string;
    gsplatModifyWgsl: string;
    /** 合并后按 priority 升序参与合成的贡献者 id */
    activeContributionIds: string[];
    /** 合并后的 uniform 平面表（键名含贡献域，避免碰撞；M3+ 再与材质绑定） */
    mergedUniforms: Record<string, number | number[] | Float32Array>;
    diagnostics: ComposerDiagnostic[];
    /** 相对上一次 compose，signature 是否变化（用于后续材质增量更新） */
    signatureChanged: boolean;
}
