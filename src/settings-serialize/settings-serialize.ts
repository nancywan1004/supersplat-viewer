import type { Global, ScenePlacedItem } from '../types';
import type { ExperienceSettings } from '../schemas/v2';
import type { SceneAsset } from '../schemas/v2-custom';
import type { AnnotationManager } from '../annotation-toolbar/annotation-manager';
import { DEFAULT_BLOOM, DEFAULT_SHADOW } from './settings-serialize-configs';
import {
    applySceneAssetCollisionFromSettings,
    persistCollisionToSettings,
    syncSceneAssetCollisionRuntime
} from '../scene-assets/collision/scene-asset-collision';
import { serializeSceneMediaHotspotForPersistence } from './settings-serialize-helper';
import {
    flushRevealIntoEffectsForExport,
    normalizeEffectsOnImport,
    readRevealParams,
    syncEffectsRuntimeStateFromSettings
} from './effects-sync';
import { filterAssetEffectParams } from '../vfx/effects-runtime/asset/asset-effect-params';

const defaultPostEffectShadow = () => ({
    darken: DEFAULT_SHADOW.darken,
    debugVisual: DEFAULT_SHADOW.debugVisual,
    castShadows: false
});

const defaultPostEffectSettings = () => ({
    sharpness: { enabled: false, amount: 0 },
    bloom: {
        enabled: false,
        intensity: 0,
        blurLevel: 10,
        threshold: 0,
        bloomDebug: false,
        bloomScope: 'global' as const,
        bloomBrushSize: 30,
        bloomBrushBrightness: 1,
        localLightRegions: [] as any[]
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

/** 存盘/出站 payload：省略 bloomEditorSession；兼容旧扁平字段；过滤 draft-* 区域 */
function stripBloomSessionFieldsForPersistence(root: Record<string, unknown>): void {
    const pes = root.postEffectSettings as Record<string, unknown> | undefined;
    if (!pes || typeof pes !== 'object') return;
    delete pes.bloomEditorSession;
    const bloom = pes.bloom as Record<string, unknown> | undefined;
    if (!bloom || typeof bloom !== 'object') return;
    delete bloom.bloomBrush;
    delete bloom.draftLightRegionCenter;
    delete bloom.activeLocalLightRegionId;
    delete bloom.localLightsEnabled;
    if (Array.isArray(bloom.localLightRegions)) {
        bloom.localLightRegions = (bloom.localLightRegions as any[]).filter(
            (r) => r && typeof r === 'object' && typeof (r as { id?: string }).id === 'string'
                && !(r as { id: string }).id.startsWith('draft-')
        );
    }
}

function stripAssetEffectFieldsForPersistence(root: Record<string, unknown>): void {
    const effects = root.effects as Record<string, unknown> | undefined;
    const asset = effects?.asset as Record<string, unknown> | undefined;
    if (!asset || typeof asset !== 'object') return;

    delete asset.defaultParamsById;

    const instances = asset.instancesByTargetId as Record<string, unknown> | undefined;
    if (!instances || typeof instances !== 'object') return;
    for (const inst of Object.values(instances)) {
        if (!inst || typeof inst !== 'object' || Array.isArray(inst)) continue;
        const record = inst as Record<string, unknown>;
        const type = typeof record.type === 'string' ? record.type : typeof record.effectId === 'string' ? record.effectId : '';
        if (record.effectParams && typeof record.effectParams === 'object' && !Array.isArray(record.effectParams)) {
            const params = filterAssetEffectParams(type, record.effectParams as Record<string, unknown>);
            if (Object.keys(params).length > 0) {
                record.effectParams = params;
            } else {
                delete record.effectParams;
            }
        }
    }
}

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
    if (typeof bg.skyboxUrl === 'string' && !bg.skyboxUrl.trim()) {
        delete bg.skyboxUrl;
    }
    if (!out.postEffectSettings || typeof out.postEffectSettings !== 'object') {
        out.postEffectSettings = defaultPostEffectSettings();
    } else {
        const pes = out.postEffectSettings as Record<string, unknown>;
        if (!pes.shadow || typeof pes.shadow !== 'object') {
            pes.shadow = defaultPostEffectShadow();
        }

        // 补齐 bloom 的 LocalLightRegion 默认值，保证序列化结构稳定
        const bloom = pes.bloom as any;
        if (bloom && typeof bloom === 'object') {
            if (!Array.isArray(bloom.localLightRegions)) {
                bloom.localLightRegions = [];
            }
            bloom.localLightRegions = bloom.localLightRegions.filter(
                (r: any) => r && typeof r.id === 'string' && !String(r.id).startsWith('draft-')
            );

            // 持久化约束：localLightRegions[*].worldSpace 只保存 committed + committedBrightness，
            // 不保留 points 草稿，避免保存过程中把未完成的笔刷轨迹写死到配置里。
            if (Array.isArray(bloom.localLightRegions)) {
                bloom.localLightRegions = bloom.localLightRegions.map((r: any) => {
                    if (!r || typeof r !== 'object') return r;
                    const ws = r.worldSpace;
                    if (ws && typeof ws === 'object') {
                        // 始终清空 points，仅保留 committed（已提交区域）与 committedBrightness
                        if (!Array.isArray(ws.committed)) {
                            ws.committed = [];
                        }
                        ws.points = [];

                        // 将有效亮度写回 committedBrightness，保证重新加载时 WorldSpaceBloomData 有一致的快照：
                        // 目前仅根据局部颜色亮度 localBrightness 计算，不再使用每区域 Bloom 强度 slider
                        const colorBrightness =
                            typeof r.localBrightness === 'number'
                                ? Math.max(-1, Math.min(1, r.localBrightness))
                                : 0;
                        const effectiveBrightness = colorBrightness;
                        ws.committedBrightness = effectiveBrightness;
                    }
                    return r;
                });
            }
        }
    }
    if (!Array.isArray(out.animTracks)) out.animTracks = [];
    if (!Array.isArray(out.cameras)) out.cameras = [];
    if (out.startMode == null) out.startMode = 'default';

    // 将 AnnotationManager 中的标注序列化到 settings.annotations
    const annotationManager = (global as any).annotationManager as AnnotationManager | undefined;
    if (annotationManager) {
        const annotationsData = annotationManager.getAllAnnotations().map((a) => a.serialize());
        out.annotations = annotationsData;
    } else if (!Array.isArray(out.annotations)) {
        out.annotations = [];
    }

    out.sceneAssets = buildSceneAssetsForPersistence(global);

    delete (out as Record<string, unknown>).sceneAssetCollision;

    persistCollisionToSettings(global);
    const collision = (global.settings as ExperienceSettings).collision;
    if (collision && typeof collision === 'object') {
        out.collision = JSON.parse(JSON.stringify(collision));
        const url = typeof collision.url === 'string' ? collision.url.trim() : '';
        if (url) {
            (out.collision as { url?: string }).url = url;
        } else {
            delete (out.collision as { url?: string }).url;
        }
    } else {
        delete (out as Record<string, unknown>).collision;
    }

    out.sceneMediaHotspot = serializeSceneMediaHotspotForPersistence(global.settings as ExperienceSettings);

    stripBloomSessionFieldsForPersistence(out);

    if (out.version === 2) {
        flushRevealIntoEffectsForExport(out as ExperienceSettings);
        stripAssetEffectFieldsForPersistence(out);
        delete (out as Record<string, unknown>).revealEffect;
    }

    return out as ExperienceSettings;
}

/** 将运行态已放置实体序列化为 settings.sceneAssets 条目 */
export function serializeScenePlacedItem(entry: ScenePlacedItem): SceneAsset {
    const pos = entry.entity.getPosition();
    const rot = entry.entity.getEulerAngles();
    const rotQuat = entry.entity.getLocalRotation();
    const scale = entry.entity.getLocalScale();
    const mirrorX: 1 | -1 = scale.x < 0 ? -1 : 1;
    const mirrorY: 1 | -1 = scale.y < 0 ? -1 : 1;
    const mirrorZ: 1 | -1 = scale.z < 0 ? -1 : 1;

    const transform: SceneAsset['transform'] = {
        position: [pos.x, pos.y, pos.z] as [number, number, number],
        rotation: [rot.x, rot.y, rot.z] as [number, number, number],
        rotationQuat: [rotQuat.x, rotQuat.y, rotQuat.z, rotQuat.w] as [number, number, number, number],
        scale: [scale.x, scale.y, scale.z] as [number, number, number],
        mirror: [mirrorX, mirrorY, mirrorZ]
    };
    if (
        entry.assetType === 'video'
        && typeof entry.horizontalCurvature === 'number'
        && entry.horizontalCurvature > 0
    ) {
        transform.horizontalCurvature = entry.horizontalCurvature;
    }

    const assetType = entry.assetType ?? 'gaussian';
    const out: SceneAsset = {
        id: entry.id,
        type: assetType,
        name: entry.name,
        visible: entry.visible,
        thumbnailUrl: entry.thumbnailUrl,
        source: {
            assetId: entry.assetId,
            filename: entry.filename,
            url: entry.url
        },
        transform
    };
    if (assetType === 'video' || assetType === 'audio') {
        const dist = entry.triggerDistanceM;
        if (typeof dist === 'number' && Number.isFinite(dist) && dist > 0) {
            out.triggerDistanceM = dist;
        }
    }
    return out;
}

/**
 * 持久化 sceneAssets：以运行态为准，并保留 settings 中尚未恢复进场景的条目
 *（例如 video 因 CORS/超时未 place 成功时，避免保存把 JSON 里的配置抹掉）。
 */
export function buildSceneAssetsForPersistence(global: Global): SceneAsset[] {
    const sceneItems = (global.state.scenePlacedEntities ?? []) as ScenePlacedItem[];
    const runtimeSerialized = sceneItems.map(serializeScenePlacedItem);
    const runtimeIds = new Set(runtimeSerialized.map((s) => s.id));
    const settings = global.settings as ExperienceSettings;
    const preserved = (settings.sceneAssets ?? []).filter(
        (sa): sa is SceneAsset => typeof sa?.id === 'string' && sa.id.length > 0 && !runtimeIds.has(sa.id)
    );
    return [...runtimeSerialized, ...preserved];
}

/** 用户从场景删除资产时，同步剔除 settings.sceneAssets，避免下次保存被 merge 复活 */
export function removeSceneAssetFromSettings(global: Global, id: string): void {
    const settings = global.settings as ExperienceSettings;
    if (!Array.isArray(settings.sceneAssets)) return;
    settings.sceneAssets = settings.sceneAssets.filter((a) => a.id !== id);
}

/** 递归按 key 排序对象，用于生成可比较的字符串（避免 key 顺序导致误判） */
function sortKeysForCompare(obj: unknown): unknown {
    if (obj === null || typeof obj !== 'object') return obj;
    if (Array.isArray(obj)) return obj.map(sortKeysForCompare);
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
        sorted[key] = sortKeysForCompare((obj as Record<string, unknown>)[key]);
    }
    return sorted;
}

/** 返回与序列化结果一致的可比较字符串，用于判断 settings 是否有改动 */
export function getComparableSettingsString(global: Global): string {
    const settings = serializeExperienceSettings(global);
    return getComparableSettingsStringFromSnapshot(settings);
}

/** 对任意快照生成稳定可比较字符串，避免 key 顺序导致误判。 */
export function getComparableSettingsStringFromSnapshot(snapshot: ExperienceSettings): string {
    const settings = JSON.parse(JSON.stringify(snapshot)) as ExperienceSettings;
    return JSON.stringify(sortKeysForCompare(settings));
}

/**
 * 将 global.settings 恢复为快照内容（原地替换属性），用于「不保存并退出」时回退。
 */
export function applySettingsSnapshot(global: Global, snapshot: ExperienceSettings): void {
    const hadRevealOrEffects = snapshot.revealEffect != null || snapshot.effects != null;
    const gs = global.settings as Record<string, unknown>;
    for (const k of Object.keys(gs)) delete gs[k];
    Object.assign(gs, snapshot);
    if ((snapshot as { version?: number }).version === 2 && hadRevealOrEffects) {
        normalizeEffectsOnImport(global.settings as ExperienceSettings);
    }
    syncEffectsRuntimeStateFromSettings(global.state, global.settings as ExperienceSettings);
    const es = global.settings as ExperienceSettings;
    global.events.fire('revealConfigChanged', readRevealParams(es) ?? { type: 'none', enable: false });
    global.events.fire('persistentGsplatEffectRemountRequested', false);
    applySceneAssetCollisionFromSettings(global);
    syncSceneAssetCollisionRuntime(global);
    global.events.fire('cameraCollision:changed');
}
