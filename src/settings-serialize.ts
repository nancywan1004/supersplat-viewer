import type { Global } from './types';
import type { ExperienceSettings } from './schemas/v2';
import type { ScenePlacedItem } from './types';

const defaultPostEffectShadow = () => ({
    enabled: true,
    darken: 0,
    debugVisual: false,
    castShadows: false
});

const defaultPostEffectSettings = () => ({
    sharpness: { enabled: false, amount: 0 },
    bloom: {
        enabled: false,
        intensity: 1,
        blurLevel: 2,
        threshold: 0.2,
        bloomDebug: false,
        bloomBrush: false,
        bloomBrushSize: 30,
        bloomBrushBrightness: 0
    },
    grading: {
        enabled: false,
        brightness: 0,
        contrast: 1,
        saturation: 1,
        tint: [1, 1, 1] as [number, number, number]
    },
    vignette: {
        enabled: false,
        intensity: 0.5,
        inner: 0.3,
        outer: 0.75,
        curvature: 1
    },
    fringing: { enabled: false, intensity: 0.5 },
    shadow: defaultPostEffectShadow()
});

/**
 * 将当前 global.settings 序列化为符合 v2 的 ExperienceSettings，
 * 深拷贝并补齐必填字段与默认值，便于 JSON.stringify 后保存或 postMessage。
 */
export function serializeExperienceSettings(global: Global): ExperienceSettings {
    const src = global.settings as Record<string, unknown>;
    const out: Record<string, unknown> = JSON.parse(JSON.stringify(src));

    if (out.version !== 2) {
        out.version = 2;
    }
    if (out.tonemapping == null) out.tonemapping = 'none';
    if (out.highPrecisionRendering == null) out.highPrecisionRendering = false;
    if (!out.background || typeof out.background !== 'object') {
        out.background = { color: [0, 0, 0] as [number, number, number] };
    }
    const bg = out.background as Record<string, unknown>;
    if (!Array.isArray(bg.color) || bg.color.length !== 3) {
        bg.color = [0, 0, 0];
    }
    if (!out.postEffectSettings || typeof out.postEffectSettings !== 'object') {
        out.postEffectSettings = defaultPostEffectSettings();
    } else {
        const pes = out.postEffectSettings as Record<string, unknown>;
        if (!pes.shadow || typeof pes.shadow !== 'object') {
            pes.shadow = defaultPostEffectShadow();
        }
    }
    if (!Array.isArray(out.animTracks)) out.animTracks = [];
    if (!Array.isArray(out.cameras)) out.cameras = [];
    if (!Array.isArray(out.annotations)) out.annotations = [];
    if (out.startMode == null) out.startMode = 'default';

    // 将当前场景中的可编辑资产列表序列化到 settings.sceneAssets
    const sceneItems = (global.state.scenePlacedEntities ?? []) as ScenePlacedItem[];
    out.sceneAssets = sceneItems.map((entry) => {
        const pos = entry.entity.getPosition();
        const rot = entry.entity.getEulerAngles();
        const scale = entry.entity.getLocalScale();

        return {
            id: entry.id,
            type: entry.assetType ?? 'gaussian',
            name: entry.name,
            visible: entry.visible,
            source: {
                assetId: entry.assetId,
                filename: entry.filename,
                url: entry.url
            },
            transform: {
                position: [pos.x, pos.y, pos.z] as [number, number, number],
                rotation: [rot.x, rot.y, rot.z] as [number, number, number],
                scale: [scale.x, scale.y, scale.z] as [number, number, number]
            }
        };
    });

    return out as ExperienceSettings;
}
