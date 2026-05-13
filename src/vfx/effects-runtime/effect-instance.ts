/**
 * 单个已挂载特效实例（M1：仅类型骨架；后续与 provider / 材质写入对齐）。
 */
export interface EffectInstance {
    readonly effectId: string;
    dispose(): void;
}
