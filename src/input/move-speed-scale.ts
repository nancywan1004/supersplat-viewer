/**
 * 相机移动步长系数：乘在场景尺寸自适应速度之上。
 * 大场景默认 `sceneSize * 0.05` 会过快，可用小于 1 的系数做小步移动。
 */

export const DEFAULT_MOVE_SPEED_SCALE = 1;
export const MIN_MOVE_SPEED_SCALE = 0.001;
export const MAX_MOVE_SPEED_SCALE = 10;

/** 本地滑条范围（协议仍允许 [0.001, 10]） */
export const MOVE_SPEED_SCALE_UI_MIN = 0.05;
export const MOVE_SPEED_SCALE_UI_MAX = 2;
export const MOVE_SPEED_SCALE_UI_STEP = 0.05;

const SCENE_MOVE_SPEED_FACTOR = 0.05;
const SCENE_MIN_PAN_DISTANCE_FACTOR = 0.1;
const MIN_ADAPTIVE = 1;
const MIN_FINAL = 0.01;

export type AdaptiveMoveSpeed = {
    moveSpeed: number;
    minPanDistance: number;
};

/** 非法值返回 null；合法值夹到 [0.001, 10]。 */
export function parseMoveSpeedScale(value: unknown): number | null {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        return null;
    }
    return Math.min(MAX_MOVE_SPEED_SCALE, Math.max(MIN_MOVE_SPEED_SCALE, value));
}

type SettingsWithCameras = {
    cameras?: Array<{ moveSpeedScale?: unknown }>;
};

export function readMoveSpeedScale(settings: SettingsWithCameras | null | undefined): number {
    return parseMoveSpeedScale(settings?.cameras?.[0]?.moveSpeedScale) ?? DEFAULT_MOVE_SPEED_SCALE;
}

/** 写入 `cameras[0].moveSpeedScale`；无主相机时返回 false（运行时仍可单独派发事件）。 */
export function writeMoveSpeedScale(settings: SettingsWithCameras, scale: number): boolean {
    const cameras = settings.cameras;
    if (!Array.isArray(cameras) || !cameras[0]) {
        return false;
    }
    cameras[0].moveSpeedScale = scale;
    return true;
}

/**
 * 自适应速度 = max(1, sceneSize * 0.05)，再乘系数。
 * Orbit 近距平移下限同理：max(1, sceneSize * 0.1) * scale。
 */
export function computeAdaptiveMoveSpeed(sceneSize: number, scale: number): AdaptiveMoveSpeed {
    const safeSize = Number.isFinite(sceneSize) && sceneSize > 0 ? sceneSize : 0;
    const safeScale = parseMoveSpeedScale(scale) ?? DEFAULT_MOVE_SPEED_SCALE;
    const adaptiveSpeed = Math.max(MIN_ADAPTIVE, safeSize * SCENE_MOVE_SPEED_FACTOR);
    const adaptiveMinPan = Math.max(MIN_ADAPTIVE, safeSize * SCENE_MIN_PAN_DISTANCE_FACTOR);
    return {
        moveSpeed: Math.max(MIN_FINAL, adaptiveSpeed * safeScale),
        minPanDistance: Math.max(MIN_FINAL, adaptiveMinPan * safeScale)
    };
}
