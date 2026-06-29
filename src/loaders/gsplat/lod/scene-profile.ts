import type { ExperienceSettings } from '../../../settings';
import type { Global } from '../../../types';

export type LodRuntime = 'refinement' | 'native';

/** PlayCanvas Billions 示例；引擎默认 1 对大场景路径动画 churn 过高 */
export const DEFAULT_LOD_UPDATE_DISTANCE = 32;

type SceneProfileObject = {
    lodRuntime?: unknown;
    lodUpdateDistance?: unknown;
};

function readSceneProfile(settings: ExperienceSettings): SceneProfileObject | undefined {
    const sceneProfile = (settings as { sceneProfile?: unknown }).sceneProfile;
    if (!sceneProfile || typeof sceneProfile !== 'object') {
        return undefined;
    }
    return sceneProfile as SceneProfileObject;
}

function readPositiveNumber(value: unknown): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return undefined;
    }
    return value;
}

/** settings.sceneProfile.lodUpdateDistance > DEFAULT (32) */
export function resolveLodUpdateDistance(global: Global): number {
    const fromSettings = readPositiveNumber(readSceneProfile(global.settings)?.lodUpdateDistance);
    if (fromSettings !== undefined) {
        return fromSettings;
    }
    return DEFAULT_LOD_UPDATE_DISTANCE;
}

function readSettingsLodRuntime(settings: ExperienceSettings): LodRuntime | undefined {
    const runtime = readSceneProfile(settings)?.lodRuntime;
    if (runtime === 'native' || runtime === 'refinement') {
        return runtime;
    }
    return undefined;
}

/** URL `?lodRuntime=` > settings.sceneProfile.lodRuntime > refinement */
export function resolveLodRuntime(global: Global): LodRuntime {
    const fromConfig = global.config.lodRuntime;
    if (fromConfig === 'native' || fromConfig === 'refinement') {
        return fromConfig;
    }
    const fromSettings = readSettingsLodRuntime(global.settings);
    if (fromSettings) {
        return fromSettings;
    }
    return 'refinement';
}

export function isNativeLodRuntime(global: Global): boolean {
    return resolveLodRuntime(global) === 'native';
}
