import {
    DEFAULT_BLOOM,
    DEFAULT_BLOOM_EDITOR_SESSION,
    DEFAULT_LIGHTING_ROOT,
    DEFAULT_NIGHT_MODE,
    DEFAULT_REVEAL_EFFECT,
    DEFAULT_SCENE_MEDIA_HOTSPOT,
    DEFAULT_SHADOW
} from './settings-serialize-configs';
import { normalizeAnnotationMediaFields } from '../annotation-toolbar/media-fields';
import { euclideanDistanceM, viewAxisDepthM } from '../scene-assets/media/media-view-depth';
import type { Global } from '../types';
import type {
    Annotation,
    Camera,
    BloomEditorSession,
    ExperienceSettings,
    PointLightConfig,
    DirectionalLightConfig,
    SpotLightConfig,
    SceneMediaHotspotSettings
} from '../schemas/v2';

/** 光源配置项在运行时应带稳定 id（列表 / Gizmo / 协议共用） */
export type LightWithId = (PointLightConfig | DirectionalLightConfig | SpotLightConfig) & { id?: string };

export function ensureSceneMediaHotspot(settings: ExperienceSettings): SceneMediaHotspotSettings {
    const root = settings as Record<string, unknown>;
    if (!root.sceneMediaHotspot || typeof root.sceneMediaHotspot !== 'object') {
        root.sceneMediaHotspot = { ...DEFAULT_SCENE_MEDIA_HOTSPOT };
    }
    const sm = root.sceneMediaHotspot as Record<string, unknown>;
    if (typeof sm.videoTriggerDistanceM !== 'number' || !Number.isFinite(sm.videoTriggerDistanceM)) {
        sm.videoTriggerDistanceM = DEFAULT_SCENE_MEDIA_HOTSPOT.videoTriggerDistanceM;
    }
    if (typeof sm.audioTriggerDistanceM !== 'number' || !Number.isFinite(sm.audioTriggerDistanceM)) {
        sm.audioTriggerDistanceM = DEFAULT_SCENE_MEDIA_HOTSPOT.audioTriggerDistanceM;
    }
    if (typeof sm.coneHalfDeg !== 'number' || !Number.isFinite(sm.coneHalfDeg)) {
        sm.coneHalfDeg = DEFAULT_SCENE_MEDIA_HOTSPOT.coneHalfDeg;
    }
    // 旧版曾持久化以下字段，不再进入 settings；导入时剥离
    delete sm.minToggleIntervalMs;
    delete sm.hysteresisM;
    delete sm.showAudioIcon;
    return root.sceneMediaHotspot as SceneMediaHotspotSettings;
}

export function ensureBackground(settings: ExperienceSettings): ExperienceSettings['background'] {
    const root = settings as Record<string, unknown>;
    if (!root.background || typeof root.background !== 'object') {
        root.background = { color: [0, 0, 0] as [number, number, number] };
    }
    const bg = root.background as Record<string, unknown>;
    if (!Array.isArray(bg.color) || bg.color.length !== 3) {
        bg.color = [0, 0, 0];
    }
    return root.background as ExperienceSettings['background'];
}

/** 读取存盘天空盒 URL；空字符串视为未设置 */
export function readSkyboxUrlFromSettings(settings: ExperienceSettings): string | undefined {
    const bg = settings.background;
    if (!bg || typeof bg !== 'object') return undefined;
    const url = (bg as { skyboxUrl?: unknown }).skyboxUrl;
    if (typeof url !== 'string') return undefined;
    const trimmed = url.trim();
    return trimmed || undefined;
}

/** 写入或清除 `settings.background.skyboxUrl` */
export function setSkyboxUrlInSettings(settings: ExperienceSettings, url: string | null | undefined): void {
    const bg = ensureBackground(settings) as Record<string, unknown>;
    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (trimmed) {
        bg.skyboxUrl = trimmed;
    } else {
        delete bg.skyboxUrl;
    }
}

/**
 * 启动时解析天空盒：优先 settings，其次 URL 参数；若仅有 URL 参数则回写 settings 便于存盘。
 */
export function resolveInitialSkyboxUrl(settings: ExperienceSettings, configSkyboxUrl?: string): string | undefined {
    const fromSettings = readSkyboxUrlFromSettings(settings);
    if (fromSettings) return fromSettings;
    const fromConfig = typeof configSkyboxUrl === 'string' ? configSkyboxUrl.trim() : '';
    if (fromConfig) {
        setSkyboxUrlInSettings(settings, fromConfig);
        return fromConfig;
    }
    return undefined;
}

/** 父级 `MEDIA_HOTSPOT_SET`：仅合并传入的有限数值字段 */
export function patchSceneMediaHotspot(
    settings: ExperienceSettings,
    patch: Partial<SceneMediaHotspotSettings>
): SceneMediaHotspotSettings {
    const sm = ensureSceneMediaHotspot(settings);
    if (typeof patch.videoTriggerDistanceM === 'number' && Number.isFinite(patch.videoTriggerDistanceM)) {
        sm.videoTriggerDistanceM = patch.videoTriggerDistanceM;
    }
    if (typeof patch.audioTriggerDistanceM === 'number' && Number.isFinite(patch.audioTriggerDistanceM)) {
        sm.audioTriggerDistanceM = patch.audioTriggerDistanceM;
    }
    if (typeof patch.coneHalfDeg === 'number' && Number.isFinite(patch.coneHalfDeg)) {
        sm.coneHalfDeg = patch.coneHalfDeg;
    }
    return sm;
}

export type MediaHotspotBaselineResult =
    | { ok: true; target: 'video' | 'audio'; distanceM: number; settings: SceneMediaHotspotSettings }
    | { ok: false; reason: string };

export type ApplySceneMediaHotspotBaselineOptions = {
    /** 场景已放置资产 id（`scenePlacedEntities[].id`） */
    sceneEntityId: string;
    target: 'video' | 'audio';
};

/**
 * 将当前相机到锚点的距离写入对应触发半径：video = 视轴深度，audio = 欧氏距离。
 * 协议须传 `id` + `target`；内置 UI 用当前 `selectedSceneEntityId`。
 */
export function applySceneMediaHotspotBaselineFromView(
    global: Global,
    opts: ApplySceneMediaHotspotBaselineOptions
): MediaHotspotBaselineResult {
    const list = global.state.scenePlacedEntities ?? [];
    const sel = list.find((e) => e.id === opts.sceneEntityId) ?? null;
    if (!sel?.entity) {
        return { ok: false, reason: 'asset_not_found' };
    }

    const assetType = sel.assetType;
    if (assetType !== 'video' && assetType !== 'audio') {
        return { ok: false, reason: 'asset_not_video_or_audio' };
    }
    if (assetType !== opts.target) {
        return { ok: false, reason: 'target_mismatch_selected_asset' };
    }

    const distanceM =
        opts.target === 'video'
            ? viewAxisDepthM(global.camera, sel.entity.getPosition())
            : euclideanDistanceM(global.camera.getPosition(), sel.entity.getPosition());
    if (!Number.isFinite(distanceM) || distanceM <= 0) {
        return { ok: false, reason: 'invalid_distance' };
    }

    const sm = ensureSceneMediaHotspot(global.settings as ExperienceSettings);
    if (opts.target === 'video') {
        sm.videoTriggerDistanceM = distanceM;
    } else {
        sm.audioTriggerDistanceM = distanceM;
    }

    return { ok: true, target: opts.target, distanceM, settings: sm };
}

export function ensureNightMode(settings: ExperienceSettings): { fade?: number } {
    if (!settings.nightMode || typeof settings.nightMode !== 'object') {
        (settings as Record<string, unknown>).nightMode = { ...DEFAULT_NIGHT_MODE };
    }
    return settings.nightMode!;
}

export function ensureLighting(settings: ExperienceSettings): { lights: LightWithId[] } {
    if (!(settings as Record<string, unknown>).lighting) {
        (settings as Record<string, unknown>).lighting = { lights: [...DEFAULT_LIGHTING_ROOT.lights] };
    }
    const lighting = (settings as Record<string, unknown>).lighting as { lights: LightWithId[] };
    if (!Array.isArray(lighting.lights)) lighting.lights = [];
    lighting.lights.forEach((light, index) => {
        if (!light.id) {
            (light as LightWithId).id = `light-${index}`;
        }
    });
    return lighting;
}

export function ensurePostEffectSettings(settings: ExperienceSettings): NonNullable<ExperienceSettings['postEffectSettings']> {
    if (!settings.postEffectSettings || typeof settings.postEffectSettings !== 'object') {
        (settings as Record<string, unknown>).postEffectSettings = {};
    }
    return settings.postEffectSettings!;
}

export function ensureBloomEditorSession(settings: ExperienceSettings): BloomEditorSession {
    const pe = ensurePostEffectSettings(settings);
    if (!pe.bloomEditorSession || typeof pe.bloomEditorSession !== 'object') {
        (pe as Record<string, unknown>).bloomEditorSession = { ...DEFAULT_BLOOM_EDITOR_SESSION };
    }
    const s = pe.bloomEditorSession as Record<string, unknown>;
    if (typeof s.bloomBrush !== 'boolean') s.bloomBrush = false;
    if (s.activeLocalLightRegionId === undefined) s.activeLocalLightRegionId = null;
    if (s.draftLightRegionCenter === undefined) s.draftLightRegionCenter = null;
    return pe.bloomEditorSession;
}

export function ensureBloom(settings: ExperienceSettings): NonNullable<ExperienceSettings['postEffectSettings']>['bloom'] {
    const pe = ensurePostEffectSettings(settings);
    if (!pe.bloom || typeof pe.bloom !== 'object') {
        (pe as Record<string, unknown>).bloom = { ...DEFAULT_BLOOM };
    }
    const b = pe.bloom as Record<string, unknown>;
    if (b.threshold === undefined) b.threshold = DEFAULT_BLOOM.threshold;
    if (b.bloomDebug === undefined) b.bloomDebug = DEFAULT_BLOOM.bloomDebug;
    if (b.bloomScope !== 'global' && b.bloomScope !== 'local') b.bloomScope = DEFAULT_BLOOM.bloomScope;
    if (b.bloomBrushSize === undefined) b.bloomBrushSize = DEFAULT_BLOOM.bloomBrushSize;
    if (typeof b.bloomBrushBrightness !== 'number') b.bloomBrushBrightness = DEFAULT_BLOOM.bloomBrushBrightness;
    if (typeof b.blurLevel !== 'number') b.blurLevel = DEFAULT_BLOOM.blurLevel;
    if (typeof b.intensity !== 'number') b.intensity = DEFAULT_BLOOM.intensity;
    if (!Array.isArray(b.localLightRegions)) b.localLightRegions = [];
    if (Number(b.intensity) === 1) {
        b.intensity = DEFAULT_BLOOM.intensity;
        if (Number(b.blurLevel) === 2) {
            b.blurLevel = DEFAULT_BLOOM.blurLevel;
        }
        if (Number(b.bloomBrushBrightness) === 0) {
            b.bloomBrushBrightness = DEFAULT_BLOOM.bloomBrushBrightness;
        }
    }
    return pe.bloom!;
}

/**
 * 导入归一：在 `ensureBloom` 之后调用，从 bloom 上剥离已废弃、不参与读数的持久化字段（与导出 strip 对齐）。
 */
export function normalizeBloomAfterImport(settings: ExperienceSettings): void {
    const pe = settings.postEffectSettings;
    if (!pe?.bloom || typeof pe.bloom !== 'object') return;
    const b = pe.bloom as Record<string, unknown>;
    if (Object.prototype.hasOwnProperty.call(b, 'localLightsEnabled')) {
        delete b.localLightsEnabled;
    }
}

export function ensureShadow(settings: ExperienceSettings): NonNullable<ExperienceSettings['postEffectSettings']>['shadow'] {
    const pe = ensurePostEffectSettings(settings);
    const s = (pe as Record<string, unknown>).shadow;
    if (!s || typeof s !== 'object') {
        (pe as Record<string, unknown>).shadow = { ...DEFAULT_SHADOW };
    } else {
        const sh = (pe as Record<string, unknown>).shadow as Record<string, unknown>;
        if (typeof sh.darken !== 'number') sh.darken = DEFAULT_SHADOW.darken;
        if (sh.castShadows === undefined) sh.castShadows = DEFAULT_SHADOW.castShadows;
        if (sh.debugVisual === undefined) sh.debugVisual = DEFAULT_SHADOW.debugVisual;
        if (typeof sh.sphereRadius !== 'number') sh.sphereRadius = DEFAULT_SHADOW.sphereRadius;
    }
    return (pe as Record<string, unknown>).shadow as NonNullable<ExperienceSettings['postEffectSettings']>['shadow'];
}

/** 若缺整条 `revealEffect` 则补默认对象；与 `settings.effects.reveal` 对齐由 `syncLegacyRevealEffectShadow`（effects-sync）在写 effects 后统一执行（M16）。 */
export function ensureRevealEffect(settings: ExperienceSettings): NonNullable<ExperienceSettings['revealEffect']> {
    if (!settings.revealEffect || typeof settings.revealEffect !== 'object') {
        (settings as Record<string, unknown>).revealEffect = { ...DEFAULT_REVEAL_EFFECT };
    }
    return settings.revealEffect!;
}

/** 旧存盘把会话字段写在 bloom 上：导入时迁入 bloomEditorSession */
export function normalizeHoistBloomSessionFields(pes: Record<string, unknown> | null | undefined): void {
    if (!pes || typeof pes !== 'object') return;
    const b = pes.bloom as Record<string, unknown> | undefined;
    if (!b || typeof b !== 'object') return;
    const move = (key: string) => {
        if (!(key in b)) return;
        if (!pes.bloomEditorSession || typeof pes.bloomEditorSession !== 'object') {
            pes.bloomEditorSession = {};
        }
        (pes.bloomEditorSession as Record<string, unknown>)[key] = b[key];
        delete b[key];
    };
    move('bloomBrush');
    move('activeLocalLightRegionId');
    move('draftLightRegionCenter');
}

/** 规范化单个标注数据，确保反序列化所需字段存在 */
export function normalizeImportedAnnotation(ann: unknown): Annotation | null {
    if (!ann || typeof ann !== 'object') return null;
    const a = ann as Record<string, unknown>;
    const id = typeof a.id === 'string' ? a.id : `annotation-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`;
    const pos = Array.isArray(a.position) && a.position.length >= 3
        ? [Number(a.position[0]), Number(a.position[1]), Number(a.position[2])] as [number, number, number]
        : [0, 0, 0] as [number, number, number];
    const camera: Camera = a.camera && typeof a.camera === 'object' && (a.camera as any).initial
        ? (a.camera as Camera)
        : { initial: { position: [0, 0, 0], target: [0, 0, 0], fov: 60 } };
    const media = normalizeAnnotationMediaFields({
        imageUrl: typeof a.imageUrl === 'string' ? a.imageUrl : undefined,
        videoUrl: typeof a.videoUrl === 'string' ? a.videoUrl : undefined
    });
    return {
        id,
        position: pos,
        title: typeof a.title === 'string' ? a.title : '',
        text: typeof a.text === 'string' ? a.text : '',
        ...media,
        showTitleWhenCollapsed: Boolean(a.showTitleWhenCollapsed),
        collapsed: Boolean(a.collapsed),
        extras: a.extras && typeof a.extras === 'object' ? a.extras : {},
        camera
    };
}

export function normalizeBloomLocalLightRegions(settings: ExperienceSettings): void {
    const pes = settings.postEffectSettings as any;
    if (!pes || typeof pes !== 'object') return;
    const bloom = pes.bloom as any;
    if (!bloom || typeof bloom !== 'object') return;

    if (!Array.isArray(bloom.localLightRegions)) {
        bloom.localLightRegions = [];
    } else {
        bloom.localLightRegions = bloom.localLightRegions.map((r: any, index: number) => {
            if (!r || typeof r !== 'object') return r;
            if (typeof r.id !== 'string') r.id = `region-${index + 1}`;
            if (typeof r.name !== 'string') r.name = `亮灯区域${String(index + 1).padStart(2, '0')}`;
            if (!r.worldSpace || typeof r.worldSpace !== 'object') {
                r.worldSpace = { points: [], committed: [], committedBrightness: 0 };
            }
            if (typeof r.localBrightness !== 'number') {
                r.localBrightness = typeof r.worldSpace.committedBrightness === 'number'
                    ? r.worldSpace.committedBrightness
                    : 1;
            }
            if (!Array.isArray(r.tintColor) || r.tintColor.length !== 3) r.tintColor = [1, 1, 1];
            if (typeof r.tintBlend !== 'number') r.tintBlend = 0;
            if (r.linkedLightId === undefined) r.linkedLightId = null;
            return r;
        });
    }

    bloom.localLightRegions = bloom.localLightRegions.filter(
        (r: any) => r && typeof r.id === 'string' && !String(r.id).startsWith('draft-')
    );

    const ses = ensureBloomEditorSession(settings);
    if (ses.activeLocalLightRegionId == null) {
        ses.activeLocalLightRegionId = bloom.localLightRegions.length > 0 ? bloom.localLightRegions[0].id : null;
    }
    const active = ses.activeLocalLightRegionId;
    if (typeof active === 'string') {
        if (active.startsWith('draft-')
            || !bloom.localLightRegions.some((r: any) => r && r.id === active)) {
            ses.activeLocalLightRegionId = bloom.localLightRegions.length > 0 ? bloom.localLightRegions[0].id : null;
        }
    }
    ses.bloomBrush = false;
    ses.draftLightRegionCenter = null;
}
