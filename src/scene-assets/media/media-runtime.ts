import type { Entity, Texture } from 'playcanvas';

import type { ScenePlacedItem, ScenePlacedMediaRuntime } from '../../types';

/** 挂在已放置音/视频实体上的运行时句柄（不入库） */
export const PLACED_MEDIA_RUNTIME_KEY = '__placedMediaRuntime' as const;

export type PlacedVideoRuntime = {
    kind: 'video';
    videoEl: HTMLVideoElement;
    texture: Texture;
    /** 热区内为 true：由 `tickPlacedVideoTextureUploads` 轮询 `texture.upload()` */
    isLive: boolean;
    /** 横向曲度 [0,1]，0 为平面 */
    horizontalCurvature: number;
    /** 播控条合成 canvas（绘制在纹理底部） */
    compositeCanvas?: HTMLCanvasElement;
    compositeCtx?: CanvasRenderingContext2D;
    /** texture 当前是否以 compositeCanvas 为源 */
    controlsOverlayActive?: boolean;
};

export type PlacedAudioRuntime = {
    kind: 'audio';
    audioEl: HTMLAudioElement;
};

export type PlacedMediaRuntime = PlacedVideoRuntime | PlacedAudioRuntime;

export function setPlacedMediaRuntime(entity: Entity, data: PlacedMediaRuntime): void {
    (entity as unknown as Record<string, unknown>)[PLACED_MEDIA_RUNTIME_KEY] = data;
}

export function getPlacedMediaRuntime(entity: Entity): PlacedMediaRuntime | undefined {
    return (entity as unknown as Record<string, unknown>)[PLACED_MEDIA_RUNTIME_KEY] as
        | PlacedMediaRuntime
        | undefined;
}

/** 确保 ScenePlacedItem 上存在可写的 mediaRuntime 对象 */
export function ensureScenePlacedMediaRuntime(entry: ScenePlacedItem): ScenePlacedMediaRuntime {
    if (!entry.mediaRuntime) {
        entry.mediaRuntime = {};
    }
    return entry.mediaRuntime;
}
