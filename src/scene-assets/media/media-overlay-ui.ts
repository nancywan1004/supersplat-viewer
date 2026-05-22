/**
 * 场景 **audio** callout：与 Annotation 相同的双层 3D 热点深度（HotspotBase / HotspotOverlay），
 * 纹理绘制 callout 样式；点击播放钮经 InputArbiter 命中屏幕包围盒。
 */

import type { Global } from '../../types';
import {
    initAudioCallout3dSystem,
    initAudioCalloutInteraction,
    syncAudioCallout3dRegistry
} from './media-audio-callout-3d';

/**
 * 初始化场景 audio callout（3D 深度 + 指针交互）。
 */
export function initMediaOverlayUi(global: Global): () => void {
    const { events } = global;
    const canvas = global.app.graphicsDevice.canvas as HTMLCanvasElement | undefined;

    const cleanup3d = initAudioCallout3dSystem(global);
    const cleanupInteraction = canvas ? initAudioCalloutInteraction(global, canvas) : () => {};

    const onRegistry = () => syncAudioCallout3dRegistry(global);
    events.on('sceneAssets:added', onRegistry);

    return () => {
        events.off('sceneAssets:added', onRegistry);
        cleanupInteraction();
        cleanup3d();
    };
}
