import type { ExperienceSettings } from '../../../settings';
import type { Global } from '../../../types';
import {
    DEFAULT_LOD_RENDER_SCALE,
    DEFAULT_LOD_RENDER_SCALE_FOVEATION,
    type LodRenderScaleFoveationParams,
    type LodSelectMode
} from './octree/lod-render-scale';

export type LodRuntime = 'refinement' | 'native';

export type { LodSelectMode, LodRenderScaleFoveationParams };

/** PlayCanvas Billions 示例；引擎默认 1 对大场景路径动画 churn 过高 */
export const DEFAULT_LOD_UPDATE_DISTANCE = 32;

/** 引擎 / refinement 选档默认：档距 5 / 15 / 45…（× lodMultiplier） */
export const DEFAULT_LOD_BASE_DISTANCE = 5;
export const DEFAULT_LOD_MULTIPLIER = 3;
/** 相机后方距离惩罚；与历史硬编码一致 */
export const DEFAULT_LOD_BEHIND_PENALTY = 5;

/** scale-align 质量偏置别名（与已删除的全局 lodMode 无关） */
export type LodScaleQuality = 'performance' | 'balanced' | 'quality';

export const LOD_SCALE_QUALITY_FACTORS: Record<LodScaleQuality, number> = {
    performance: 1.0,
    balanced: 1.4,
    quality: 1.8
};

type SceneProfileObject = {
    lodRuntime?: unknown;
    lodUpdateDistance?: unknown;
    lodBaseDistance?: unknown;
    lodMultiplier?: unknown;
    lodBehindPenalty?: unknown;
    /** false 时关闭 viewer 侧 lod 米制尺对齐；默认开启 */
    lodScaleAlign?: unknown;
    /** 正数：直接指定 R95 自适应 qualityFactor；缺省 1.4 */
    lodScaleQualityFactor?: unknown;
    /** 'performance'|'balanced'|'quality' → 1.0/1.4/1.8；可被 lodScaleQualityFactor 覆盖 */
    lodScaleQuality?: unknown;
    /** 'distance'（默认）| 'renderScale'：屏幕尺寸选档，见 lodRenderScale机制说明.md */
    lodSelectMode?: unknown;
    /** 中央目标屏上直径（px）；仅 lodSelectMode=renderScale */
    lodRenderScale?: unknown;
    coneFov0?: unknown;
    coneFov?: unknown;
    coneFoveate?: unknown;
    behindFoveate?: unknown;
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

/** settings.sceneProfile 是否显式写了正数 lodBaseDistance（含写成默认值 5） */
export function hasExplicitLodBaseDistance(global: Global): boolean {
    return readPositiveNumber(readSceneProfile(global.settings)?.lodBaseDistance) !== undefined;
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
 * 是否跑 viewer 侧 R95+金字塔 scale-align（可能改写 entity.lodBaseDistance）。
 *
 * - `lodScaleAlign: false` → 关
 * - `lodScaleAlign: true` → 开（即使显式写了 lodBaseDistance，仍以配置值为上限做自适应）
 * - 未写 → **默认关**（避免把 d0 拧到 0.2m 量级、budgetScale 爆炸、opt 虚高）
 */
export function resolveLodScaleAlignEnabled(global: Global): boolean {
    const flag = readSceneProfile(global.settings)?.lodScaleAlign;
    return flag === true;
}

/**
 * R95 自适应质量系数：lodScaleQualityFactor > lodScaleQuality 别名 > 默认 1.4。
 */
export function resolveLodScaleQualityFactor(global: Global): number {
    const profile = readSceneProfile(global.settings);
    const fromNumber = readPositiveNumber(profile?.lodScaleQualityFactor);
    if (fromNumber !== undefined) {
        return fromNumber;
    }
    const alias = profile?.lodScaleQuality;
    if (alias === 'performance' || alias === 'balanced' || alias === 'quality') {
        return LOD_SCALE_QUALITY_FACTORS[alias];
    }
    return LOD_SCALE_QUALITY_FACTORS.balanced;
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

/**
 * 选档模式：URL/config `lodSelectMode` > settings.sceneProfile.lodSelectMode。
 * 若 URL 只给了 `lodRenderScale`/`renderScale` 且未写 mode → 视为 `renderScale`。
 * 默认 `distance`（米制 + budget）。
 */
export function resolveLodSelectMode(global: Global): LodSelectMode {
    const fromConfig = (global.config as { lodSelectMode?: unknown }).lodSelectMode;
    if (fromConfig === 'renderScale' || fromConfig === 'distance') {
        return fromConfig;
    }
    if (readPositiveNumber((global.config as { lodRenderScale?: unknown }).lodRenderScale) !== undefined) {
        return 'renderScale';
    }
    const mode = readSceneProfile(global.settings)?.lodSelectMode;
    if (mode === 'renderScale' || mode === 'distance') {
        return mode;
    }
    return 'distance';
}

/**
 * 中央目标屏上直径（px）。
 * URL/config `lodRenderScale`/`renderScale` > settings.sceneProfile.lodRenderScale > 缺省 1.0。
 */
export function resolveLodRenderScale(global: Global): number {
    const fromConfig = readPositiveNumber((global.config as { lodRenderScale?: unknown }).lodRenderScale);
    if (fromConfig !== undefined) {
        return fromConfig;
    }
    const fromSettings = readPositiveNumber(readSceneProfile(global.settings)?.lodRenderScale);
    if (fromSettings !== undefined) {
        return fromSettings;
    }
    return DEFAULT_LOD_RENDER_SCALE;
}

function readUnitIntervalOrPositive(value: unknown, fallback: number): number {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return fallback;
    }
    return value;
}

/** foveation 锥参数；角度单位度 */
export function resolveLodRenderScaleFoveation(global: Global): LodRenderScaleFoveationParams {
    const profile = readSceneProfile(global.settings);
    const d = DEFAULT_LOD_RENDER_SCALE_FOVEATION;
    return {
        coneFov0Deg: readUnitIntervalOrPositive(profile?.coneFov0, d.coneFov0Deg),
        coneFovDeg: readUnitIntervalOrPositive(profile?.coneFov, d.coneFovDeg),
        coneFoveate: readUnitIntervalOrPositive(profile?.coneFoveate, d.coneFoveate),
        behindFoveate: readUnitIntervalOrPositive(profile?.behindFoveate, d.behindFoveate)
    };
}
