import type {
    SceneAssetCollisionAxisScale,
    SceneAssetCollisionScale,
    SceneAssetCollisionSettingsPatch
} from '../../schemas/v2-custom';
import type { Global, SceneAssetCollisionRuntimeState } from '../../types';

/** 设置面板 / state 写入时可接受的缩放参数（含历史标量） */
export type SceneAssetCollisionScaleInput = NonNullable<SceneAssetCollisionSettingsPatch['scale']>;

export const DEFAULT_SCENE_ASSET_COLLISION_AXIS_SCALE: SceneAssetCollisionAxisScale = {
    x: 1,
    y: 1,
    z: 1
};

export const DEFAULT_SCENE_ASSET_COLLISION_SCALE = {
    gaussian: { x: 0.85, y: 0.85, z: 0.85 },
    mesh: { x: 0.57, y: 0.85, z: 0.85 },
    autoFit: false
} as const;

const AXIS_SCALE_MIN = 0.5;
const AXIS_SCALE_MAX = 1.5;
const AUTO_FIT_AXIS_MIN = 0.55;
const AUTO_FIT_AXIS_MAX = 1;

export function clampAxisScale(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(AXIS_SCALE_MAX, Math.max(AXIS_SCALE_MIN, value));
}

export function clampAutoFitFactor(value: number): number {
    if (!Number.isFinite(value) || value <= 0) return 1;
    return Math.min(AUTO_FIT_AXIS_MAX, Math.max(AUTO_FIT_AXIS_MIN, value));
}

export function normalizeAxisScale(
    value: number | SceneAssetCollisionAxisScale | undefined,
    fallback: SceneAssetCollisionAxisScale
): SceneAssetCollisionAxisScale {
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
        const s = clampAxisScale(value);
        return { x: s, y: s, z: s };
    }
    if (value && typeof value === 'object') {
        return {
            x: clampAxisScale(value.x ?? fallback.x),
            y: clampAxisScale(value.y ?? fallback.y),
            z: clampAxisScale(value.z ?? fallback.z)
        };
    }
    return { ...fallback };
}

export function normalizeSceneAssetCollisionScale(
    scale: SceneAssetCollisionScaleInput | SceneAssetCollisionScale | undefined
): SceneAssetCollisionScale {
    const def = DEFAULT_SCENE_ASSET_COLLISION_SCALE;
    const raw = scale;
    return {
        gaussian: normalizeAxisScale(raw?.gaussian, def.gaussian),
        mesh: normalizeAxisScale(raw?.mesh, def.mesh),
        autoFit: raw?.autoFit ?? def.autoFit
    };
}

export function createDefaultSceneAssetCollisionRuntimeState(): SceneAssetCollisionRuntimeState {
    return {
        enabled: false,
        scale: normalizeSceneAssetCollisionScale(DEFAULT_SCENE_ASSET_COLLISION_SCALE),
        debugVisual: false
    };
}

export function normalizeSceneAssetCollisionRuntimeState(
    value: Partial<SceneAssetCollisionRuntimeState> | undefined
): SceneAssetCollisionRuntimeState {
    const def = createDefaultSceneAssetCollisionRuntimeState();
    if (!value) return def;
    return {
        enabled: typeof value.enabled === 'boolean' ? value.enabled : def.enabled,
        scale: normalizeSceneAssetCollisionScale(value.scale ?? def.scale),
        debugVisual: typeof value.debugVisual === 'boolean' ? value.debugVisual : def.debugVisual
    };
}

export function readSceneAssetCollisionRuntimeState(global: Global): SceneAssetCollisionRuntimeState {
    return normalizeSceneAssetCollisionRuntimeState(global.state.sceneAssetCollisionRuntimeState);
}

export function writeSceneAssetCollisionRuntimeState(
    global: Global,
    next: SceneAssetCollisionRuntimeState
): SceneAssetCollisionRuntimeState {
    const normalized = normalizeSceneAssetCollisionRuntimeState(next);
    global.state.sceneAssetCollisionRuntimeState = normalized;
    return normalized;
}

export function patchSceneAssetCollisionRuntimeState(
    global: Global,
    patch: Partial<SceneAssetCollisionRuntimeState> & { scale?: SceneAssetCollisionScaleInput }
): SceneAssetCollisionRuntimeState {
    const current = readSceneAssetCollisionRuntimeState(global);
    return writeSceneAssetCollisionRuntimeState(global, {
        ...current,
        ...patch,
        scale: patch.scale !== undefined
            ? normalizeSceneAssetCollisionScale({ ...current.scale, ...patch.scale })
            : current.scale
    });
}

/** Manager / UI 写入 state 后发出，由 initSceneAssetCollision 订阅并同步 Runtime */
export const SCENE_ASSET_COLLISION_APPLY_RUNTIME_STATE = 'sceneAssetCollision:applyRuntimeState';
