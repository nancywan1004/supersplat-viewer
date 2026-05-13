import type { Global } from '../../types';

/**
 * 按 effectId 注册/查询 provider 与实例（M1：空实现，不改变现有 reveal/night 路径）。
 */
export class EffectRegistry {
    constructor(_global: Global) {}

    has(_effectId: string): boolean {
        return false;
    }
}
