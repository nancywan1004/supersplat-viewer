/**
 * bootstrap 相机门槛 / 叶尺度调试快照（供 HUD / 诊断只读）。
 */

export type CameraLodScaleDebugSnapshot = {
    medianLeafExtent: number | null;
    lodBaseDistance: number;
    lodMultiplier: number;
    moveThr: number;
    zoomThr: number;
    movedMeters: number;
    movedSinceTriggerMeters: number;
    turnedDegrees: number;
    distDelta: number;
    fovDelta: number;
    moved: boolean;
    rotated: boolean;
    zoomed: boolean;
    inMotion: boolean;
    triggered: boolean;
    triggerReasons: string[];
    streamingUnlocked: boolean;
};

type GlobalWithDebug = typeof globalThis & {
    __cameraLodScaleDebug?: CameraLodScaleDebugSnapshot;
};

export function publishCameraLodScaleDebug(snapshot: CameraLodScaleDebugSnapshot): void {
    (globalThis as GlobalWithDebug).__cameraLodScaleDebug = snapshot;
}

export function readCameraLodScaleDebug(): CameraLodScaleDebugSnapshot | null {
    return (globalThis as GlobalWithDebug).__cameraLodScaleDebug ?? null;
}
