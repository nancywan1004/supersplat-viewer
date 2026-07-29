import type { ExperienceSettings } from '../../../settings';
import type { Global } from '../../../types';

export type LodRuntime = 'refinement' | 'native';

/** PlayCanvas Billions 示例；引擎默认 1 对大场景路径动画 churn 过高 */
export const DEFAULT_LOD_UPDATE_DISTANCE = 32;

/** 引擎 / refinement 选档默认：档距 5 / 15 / 45…（× lodMultiplier） */
export const DEFAULT_LOD_BASE_DISTANCE = 5;
export const DEFAULT_LOD_MULTIPLIER = 3;
/** 相机后方距离惩罚；与历史硬编码一致 */
export const DEFAULT_LOD_BEHIND_PENALTY = 5;

type SceneProfileObject = {
    lodRuntime?: unknown;
    lodUpdateDistance?: unknown;
    lodBaseDistance?: unknown;
    lodMultiplier?: unknown;
    lodBehindPenalty?: unknown;
    /** false 时关闭 viewer 侧 lod 米制尺对齐；默认开启 */
    lodScaleAlign?: unknown;
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

/**
 * settings.sceneProfile.lodBaseDistance > 默认 5。
 * 未显式配置时与引擎默认一致，行为不变。
 */
export function resolveLodBaseDistance(global: Global): number {
    const fromSettings = readPositiveNumber(readSceneProfile(global.settings)?.lodBaseDistance);
    if (fromSettings !== undefined) {
        return fromSettings;
    }
    return DEFAULT_LOD_BASE_DISTANCE;
}

/** settings.sceneProfile.lodMultiplier > 默认 3 */
export function resolveLodMultiplier(global: Global): number {
    const fromSettings = readPositiveNumber(readSceneProfile(global.settings)?.lodMultiplier);
    if (fromSettings !== undefined) {
        return fromSettings;
    }
    return DEFAULT_LOD_MULTIPLIER;
}

/**
 * settings.sceneProfile.lodBehindPenalty > 默认 5。
 * 写入 `scene.gsplat.lodBehindPenalty`（非 entity 组件）。
 */
export function resolveLodBehindPenalty(global: Global): number {
    const fromSettings = readPositiveNumber(readSceneProfile(global.settings)?.lodBehindPenalty);
    if (fromSettings !== undefined) {
        return fromSettings;
    }
    return DEFAULT_LOD_BEHIND_PENALTY;
}

/**
 * settings.sceneProfile.lodScaleAlign === false 时关闭；缺省 / 其它值均开启。
 * 按场景 AABB / 叶尺度 / 密度缩小有效 lodBaseDistance（AUTO_SCALE 同构）。
 */
export function resolveLodScaleAlignEnabled(global: Global): boolean {
    const flag = readSceneProfile(global.settings)?.lodScaleAlign;
    return flag !== false;
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
    const fromConfig = (global.config as { lodRuntime?: unknown }).lodRuntime;
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
