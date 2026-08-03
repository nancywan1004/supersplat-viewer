import {
    DEFAULT_BLOOM,
    DEFAULT_BLOOM_EDITOR_SESSION,
    DEFAULT_LIGHTING_ROOT,
    DEFAULT_NIGHT_MODE,
    DEFAULT_REVEAL_EFFECT,
    DEFAULT_SCENE_MEDIA_HOTSPOT,
    DEFAULT_SHADOW,
    DEFAULT_TORCH_LIGHT,
    TORCH_RANGE_MAX
} from './settings-serialize-configs';
import { normalizeAnnotationMediaFields } from '../annotation-toolbar/media-fields';
import { defaultTriggerDistanceMForAssetType } from '../scene-assets/media/media-hotspot-params';
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
    SceneMediaHotspotSettings,
    SceneMediaHotspotPatch
} from '../schemas/v2';
import type { SceneAsset, TorchLightSettings } from '../schemas/v2-custom';

/** 把任意输入收敛为 sRGB [0,1] 三分量；非法分量退回 fallback。 */
function normalizeTorchColor(input: unknown, fallback: [number, number, number]): [number, number, number] {
    if (!Array.isArray(input)) return fallback;
    const clamp01 = (v: unknown, fb: number) => {
        if (typeof v !== 'number' || !Number.isFinite(v)) return fb;
        return Math.max(0, Math.min(1, v));
    };
    return [clamp01(input[0], fallback[0]), clamp01(input[1], fallback[1]), clamp01(input[2], fallback[2])];
}

/** 光源配置项在运行时应带稳定 id（列表 / Gizmo / 协议共用） */
export type LightWithId = (PointLightConfig | DirectionalLightConfig | SpotLightConfig) & { id?: string };

export function readGlobalVideoHotspotAutoplayEnabled(settings: ExperienceSettings): boolean {
    const sm = settings.sceneMediaHotspot;
    if (!sm || typeof sm !== 'object') return true;
    return sm.video?.hotspotAutoplayEnabled !== false;
}

export function readGlobalAudioHotspotAutoplayEnabled(settings: ExperienceSettings): boolean {
    const sm = settings.sceneMediaHotspot;
    if (!sm || typeof sm !== 'object') return true;
    return sm.audio?.hotspotAutoplayEnabled !== false;
}

/** 浏览模式下是否显示音频 callout；缺省 true（仅显式 false 入库） */
export function readGlobalShowAudioCalloutInViewer(settings: ExperienceSettings): boolean {
    const sm = settings.sceneMediaHotspot;
    if (!sm || typeof sm !== 'object') return true;
    return sm.audio?.showCalloutInViewer !== false;
}

export function readGlobalVideoConeHalfDeg(settings: ExperienceSettings): number {
    const v = settings.sceneMediaHotspot?.video?.coneHalfDeg;
    if (typeof v === 'number' && Number.isFinite(v)) {
        return v;
    }
    return DEFAULT_SCENE_MEDIA_HOTSPOT.video.coneHalfDeg;
}

/** 存盘用：展开热区全局参数为完整字段（含默认值） */
export function serializeSceneMediaHotspotForPersistence(
    settings: ExperienceSettings
): SceneMediaHotspotSettings {
    ensureSceneMediaHotspot(settings);
    return {
        video: {
            coneHalfDeg: readGlobalVideoConeHalfDeg(settings),
            hotspotAutoplayEnabled: readGlobalVideoHotspotAutoplayEnabled(settings)
        },
        audio: {
            hotspotAutoplayEnabled: readGlobalAudioHotspotAutoplayEnabled(settings),
            showCalloutInViewer: readGlobalShowAudioCalloutInViewer(settings)
        }
    };
}

/**
 * 嵌套子节点 `ensure`：必填字段缺失则补默认；可选 boolean 字段按「仅非默认值入库」清洗。
 * - `hotspotAutoplayEnabled`：默认 true，仅显式 false 入库；
 * - `audio.showCalloutInViewer`：默认 true，仅显式 false 入库。
 */
function ensureHotspotSubtree(
    sm: Record<string, unknown>,
    key: 'video' | 'audio'
): Record<string, unknown> {
    if (!sm[key] || typeof sm[key] !== 'object') {
        sm[key] = { ...DEFAULT_SCENE_MEDIA_HOTSPOT[key] };
    }
    const node = sm[key] as Record<string, unknown>;
    if (key === 'video') {
        if (typeof node.coneHalfDeg !== 'number' || !Number.isFinite(node.coneHalfDeg)) {
            node.coneHalfDeg = DEFAULT_SCENE_MEDIA_HOTSPOT.video.coneHalfDeg;
        }
    }
    if (node.hotspotAutoplayEnabled !== false) {
        delete node.hotspotAutoplayEnabled;
    }
    if (key === 'audio') {
        if (node.showCalloutInViewer !== false) {
            delete node.showCalloutInViewer;
        }
    }
    return node;
}

export function ensureSceneMediaHotspot(settings: ExperienceSettings): SceneMediaHotspotSettings {
    const root = settings as Record<string, unknown>;
    if (!root.sceneMediaHotspot || typeof root.sceneMediaHotspot !== 'object') {
        root.sceneMediaHotspot = {
            video: { ...DEFAULT_SCENE_MEDIA_HOTSPOT.video },
            audio: { ...DEFAULT_SCENE_MEDIA_HOTSPOT.audio }
        };
    }
    const sm = root.sceneMediaHotspot as Record<string, unknown>;
    ensureHotspotSubtree(sm, 'video');
    ensureHotspotSubtree(sm, 'audio');
    return root.sceneMediaHotspot as SceneMediaHotspotSettings;
}

function normalizeSkyboxUrlList(input: unknown): string[] {
    if (!Array.isArray(input)) return [];
    const seen = new Set<string>();
    const result: string[] = [];
    input.forEach((entry) => {
        if (typeof entry !== 'string') return;
        const trimmed = entry.trim();
        if (!trimmed || seen.has(trimmed)) return;
        seen.add(trimmed);
        result.push(trimmed);
    });
    return result;
}

function ensureSkyboxRecord(bg: Record<string, unknown>): Record<string, unknown> {
    if (!bg.skybox || typeof bg.skybox !== 'object') {
        bg.skybox = {};
    }
    return bg.skybox as Record<string, unknown>;
}

/** 导入时将历史字段收敛到 `background.skybox.{ currentUrl, uploadUrls }` */
function hoistLegacySkyboxFields(bg: Record<string, unknown>): void {
    const skybox = ensureSkyboxRecord(bg);

    const legacyCurrent =
        (typeof bg.skyboxUrl === 'string' ? bg.skyboxUrl.trim() : '') ||
        (typeof skybox.url === 'string' ? skybox.url.trim() : '') ||
        (typeof skybox.currentUrl === 'string' ? skybox.currentUrl.trim() : '');
    if (legacyCurrent) {
        skybox.currentUrl = legacyCurrent;
    }
    delete bg.skyboxUrl;
    delete skybox.url;

    const legacyUploadUrls = normalizeSkyboxUrlList([
        ...(Array.isArray(bg.skyboxUrls) ? bg.skyboxUrls : []),
        ...(Array.isArray(skybox.urls) ? skybox.urls : []),
        ...(Array.isArray(skybox.userUrls) ? skybox.userUrls : []),
        ...(Array.isArray(skybox.uploadUrls) ? skybox.uploadUrls : [])
    ]);
    delete bg.skyboxUrls;
    delete skybox.urls;
    delete skybox.userUrls;
    if (legacyUploadUrls.length > 0) {
        skybox.uploadUrls = legacyUploadUrls;
    } else {
        delete skybox.uploadUrls;
    }
}

function pruneEmptySkybox(bg: Record<string, unknown>): void {
    const skybox = bg.skybox;
    if (!skybox || typeof skybox !== 'object') return;
    const rec = skybox as Record<string, unknown>;
    const currentUrl = typeof rec.currentUrl === 'string' ? rec.currentUrl.trim() : '';
    const uploadUrls = normalizeSkyboxUrlList(rec.uploadUrls);
    if (currentUrl) {
        rec.currentUrl = currentUrl;
    } else {
        delete rec.currentUrl;
    }
    if (uploadUrls.length > 0) {
        rec.uploadUrls = uploadUrls;
    } else {
        delete rec.uploadUrls;
    }
    if (!rec.currentUrl && !rec.uploadUrls) {
        delete bg.skybox;
    }
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
    hoistLegacySkyboxFields(bg);
    pruneEmptySkybox(bg);
    return root.background as ExperienceSettings['background'];
}

/** 读取当前使用的天空盒 URL；空字符串视为未设置 */
export function readSkyboxCurrentUrlFromSettings(settings: ExperienceSettings): string | undefined {
    const bg = ensureBackground(settings);
    const skybox = (bg as { skybox?: unknown }).skybox;
    if (!skybox || typeof skybox !== 'object') return undefined;
    const url = (skybox as { currentUrl?: unknown }).currentUrl;
    if (typeof url !== 'string') return undefined;
    const trimmed = url.trim();
    return trimmed || undefined;
}

/** 读取上传/外部传入的天空盒 URL 列表（SKYBOX_ADD 等）；去重并去掉空值 */
export function readSkyboxUploadUrlsFromSettings(settings: ExperienceSettings): string[] {
    const bg = ensureBackground(settings);
    const skybox = (bg as { skybox?: unknown }).skybox;
    if (!skybox || typeof skybox !== 'object') return [];
    return normalizeSkyboxUrlList((skybox as { uploadUrls?: unknown }).uploadUrls);
}

/** 写入上传天空盒 URL 列表；空列表会删除 `skybox.uploadUrls` */
export function setSkyboxUploadUrlsInSettings(settings: ExperienceSettings, urls: unknown): void {
    const bg = ensureBackground(settings) as Record<string, unknown>;
    const skybox = ensureSkyboxRecord(bg);
    const normalized = normalizeSkyboxUrlList(urls);
    if (normalized.length > 0) {
        skybox.uploadUrls = normalized;
    } else {
        delete skybox.uploadUrls;
    }
    pruneEmptySkybox(bg);
}

/** 登记上传天空盒 URL 并去重；返回规范化后的 URL，非法则返回 undefined */
export function addSkyboxUploadUrlToSettings(settings: ExperienceSettings, url: string | null | undefined): string | undefined {
    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (!trimmed) return undefined;
    const urls = readSkyboxUploadUrlsFromSettings(settings);
    if (!urls.includes(trimmed)) {
        urls.push(trimmed);
    }
    setSkyboxUploadUrlsInSettings(settings, urls);
    return trimmed;
}

/** 写入或清除 `settings.background.skybox.currentUrl` */
export function setSkyboxCurrentUrlInSettings(settings: ExperienceSettings, url: string | null | undefined): void {
    const bg = ensureBackground(settings) as Record<string, unknown>;
    const skybox = ensureSkyboxRecord(bg);
    const trimmed = typeof url === 'string' ? url.trim() : '';
    if (trimmed) {
        skybox.currentUrl = trimmed;
    } else {
        delete skybox.currentUrl;
    }
    pruneEmptySkybox(bg);
}

/** 序列化前规范化 `background.skybox`（currentUrl + uploadUrls） */
export function normalizeSkyboxForPersistence(settings: ExperienceSettings): void {
    const bg = ensureBackground(settings) as Record<string, unknown>;
    pruneEmptySkybox(bg);
}

/**
 * 启动时解析天空盒：优先 settings，其次 URL 参数；若仅有 URL 参数则回写 settings 便于存盘。
 */
export function resolveInitialSkyboxUrl(settings: ExperienceSettings, configSkyboxUrl?: string): string | undefined {
    const fromSettings = readSkyboxCurrentUrlFromSettings(settings);
    if (fromSettings) return fromSettings;
    const fromConfig = typeof configSkyboxUrl === 'string' ? configSkyboxUrl.trim() : '';
    if (fromConfig) {
        addSkyboxUploadUrlToSettings(settings, fromConfig);
        setSkyboxCurrentUrlInSettings(settings, fromConfig);
        return fromConfig;
    }
    return undefined;
}

/** 父级 `MEDIA_HOTSPOT_SET`：嵌套 patch，仅合并 video / audio 子节点的全局热区字段 */
export function patchSceneMediaHotspot(
    settings: ExperienceSettings,
    patch: SceneMediaHotspotPatch
): SceneMediaHotspotSettings {
    const sm = ensureSceneMediaHotspot(settings);
    if (patch.video && typeof patch.video === 'object') {
        const vRec = sm.video as Record<string, unknown>;
        if (patch.video.hotspotAutoplayEnabled === false) {
            vRec.hotspotAutoplayEnabled = false;
        } else if (patch.video.hotspotAutoplayEnabled === true) {
            delete vRec.hotspotAutoplayEnabled;
        }
        if (typeof patch.video.coneHalfDeg === 'number' && Number.isFinite(patch.video.coneHalfDeg)) {
            sm.video.coneHalfDeg = patch.video.coneHalfDeg;
        }
    }
    if (patch.audio && typeof patch.audio === 'object') {
        const aRec = sm.audio as Record<string, unknown>;
        if (patch.audio.hotspotAutoplayEnabled === false) {
            aRec.hotspotAutoplayEnabled = false;
        } else if (patch.audio.hotspotAutoplayEnabled === true) {
            delete aRec.hotspotAutoplayEnabled;
        }
        if (patch.audio.showCalloutInViewer === false) {
            aRec.showCalloutInViewer = false;
        } else if (patch.audio.showCalloutInViewer === true) {
            delete aRec.showCalloutInViewer;
        }
    }
    return sm;
}

export type MediaHotspotBaselineResult =
    | { ok: true; id: string; assetType: 'video' | 'audio'; triggerDistanceM: number }
    | { ok: false; reason: string };

export type ApplySceneMediaHotspotBaselineOptions = {
    /** 场景已放置资产 id（`scenePlacedEntities[].id` / `sceneAssets[].id`） */
    sceneEntityId: string;
};

function resolveSceneMediaAsset(
    global: Global,
    sceneEntityId: string
): { sa: SceneAsset; entry: NonNullable<typeof global.state.scenePlacedEntities>[number] } | null {
    const settings = global.settings as ExperienceSettings;
    if (!Array.isArray(settings.sceneAssets)) settings.sceneAssets = [];
    const entry = global.state.scenePlacedEntities?.find((e) => e.id === sceneEntityId);
    if (!entry) return null;

    let sa = settings.sceneAssets.find((a) => a.id === sceneEntityId);
    const assetType = entry.assetType;
    if (!sa && (assetType === 'video' || assetType === 'audio')) {
        const pos = entry.entity.getPosition();
        const scale = entry.entity.getLocalScale();
        const distDefault = defaultTriggerDistanceMForAssetType(assetType)!;
        sa = {
            id: entry.id,
            type: assetType,
            name: entry.name,
            visible: entry.visible !== false,
            source: {
                assetId: entry.assetId,
                filename: entry.filename,
                url: entry.url
            },
            transform: {
                position: [pos.x, pos.y, pos.z],
                rotation: [0, 0, 0],
                scale: [scale.x, scale.y, scale.z]
            },
            triggerDistanceM:
                typeof entry.triggerDistanceM === 'number' && entry.triggerDistanceM > 0
                    ? entry.triggerDistanceM
                    : distDefault
        };
        if (
            assetType === 'video'
            && typeof entry.horizontalCurvature === 'number'
            && entry.horizontalCurvature > 0
        ) {
            sa.transform.horizontalCurvature = entry.horizontalCurvature;
        }
        settings.sceneAssets.push(sa);
    }
    if (!sa) return null;
    return { sa, entry };
}

/**
 * 将当前相机到锚点的距离写入该资产的 `triggerDistanceM`：video = 视轴深度，audio = 欧氏距离。
 */
export function applySceneMediaHotspotBaselineFromView(
    global: Global,
    opts: ApplySceneMediaHotspotBaselineOptions
): MediaHotspotBaselineResult {
    const resolved = resolveSceneMediaAsset(global, opts.sceneEntityId);
    if (!resolved) {
        return { ok: false, reason: 'asset_not_found' };
    }
    const { sa, entry } = resolved;
    if (sa.type !== 'video' && sa.type !== 'audio') {
        return { ok: false, reason: 'asset_not_video_or_audio' };
    }
    const anchor = entry.entity?.getPosition();
    if (!anchor) {
        return { ok: false, reason: 'asset_not_found' };
    }

    const distanceM =
        sa.type === 'video'
            ? viewAxisDepthM(global.camera, anchor)
            : euclideanDistanceM(global.camera.getPosition(), anchor);
    if (!Number.isFinite(distanceM) || distanceM <= 0) {
        return { ok: false, reason: 'invalid_distance' };
    }

    const triggerDistanceM = Math.max(0.01, distanceM);
    sa.triggerDistanceM = triggerDistanceM;
    entry.triggerDistanceM = triggerDistanceM;

    return { ok: true, id: sa.id, assetType: sa.type, triggerDistanceM };
}

/** 写入单条 video/audio 的触发距离（settings + 运行态） */
export function applySceneAssetTriggerDistanceM(
    global: Global,
    sceneAssetId: string,
    valueM: number
): boolean {
    if (!Number.isFinite(valueM) || valueM <= 0) return false;
    const resolved = resolveSceneMediaAsset(global, sceneAssetId);
    if (!resolved) return false;
    const { sa, entry } = resolved;
    if (sa.type !== 'video' && sa.type !== 'audio') return false;

    const triggerDistanceM = Math.max(0.01, valueM);
    sa.triggerDistanceM = triggerDistanceM;
    if (entry) {
        entry.triggerDistanceM = triggerDistanceM;
    }
    global.events.fire('sceneAsset:triggerDistanceChanged', { id: sceneAssetId, triggerDistanceM });
    return true;
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

/**
 * 是否已将手电筒加入场景配置（`settings.lighting.torch` 存在）。
 * 仅 `TORCH_ADD` 或已保存 JSON 会为 true；运行时 `TORCH_TOGGLE` 不改变此状态。
 */
export function hasTorchLight(settings: ExperienceSettings): boolean {
    const lighting = (settings as Record<string, unknown>).lighting as { torch?: unknown } | undefined;
    return !!(lighting && typeof lighting === 'object' && lighting.torch && typeof lighting.torch === 'object');
}

/** 规范化已有 torch 对象字段（不写入 settings）。 */
function normalizeTorchFields(raw: Record<string, unknown>): TorchLightSettings {
    const color = normalizeTorchColor(raw.color, [...DEFAULT_TORCH_LIGHT.color] as [number, number, number]);
    let intensity = DEFAULT_TORCH_LIGHT.intensity;
    if (typeof raw.intensity === 'number' && Number.isFinite(raw.intensity)) {
        intensity = Math.max(0, raw.intensity);
    }
    let range = DEFAULT_TORCH_LIGHT.range;
    if (typeof raw.range === 'number' && Number.isFinite(raw.range)) {
        range = Math.max(0, Math.min(TORCH_RANGE_MAX, raw.range));
    }
    return { color, intensity, range };
}

/**
 * 读取已入库的手电筒配置；未 `TORCH_ADD` 时返回 null（不补写 settings）。
 */
export function readTorchLight(settings: ExperienceSettings): TorchLightSettings | null {
    if (!hasTorchLight(settings)) return null;
    const lighting = (settings as Record<string, unknown>).lighting as { torch: Record<string, unknown> };
    const normalized = normalizeTorchFields(lighting.torch);
    lighting.torch = normalized as unknown as Record<string, unknown>;
    return normalized;
}

/**
 * 运行时解析手电筒参数：已入库则用 settings，否则用默认值；**绝不**写入 settings。
 */
export function resolveTorchLight(settings: ExperienceSettings): TorchLightSettings {
    return readTorchLight(settings) ?? { ...DEFAULT_TORCH_LIGHT, color: [...DEFAULT_TORCH_LIGHT.color] as [number, number, number] };
}

/**
 * 导入时：仅当 JSON 已有 `lighting.torch` 时规范化字段；缺失则保持缺失（不自动 ADD）。
 */
export function normalizeTorchLightOnImport(settings: ExperienceSettings): TorchLightSettings | null {
    return readTorchLight(settings);
}

/**
 * `TORCH_ADD`：将手电筒写入 `settings.lighting.torch`（可带 partial 覆盖默认）。
 * 已存在时合并 partial 并规范化。不改变 `viewSettings.torch.active`（保持关）。
 */
export function addTorchLight(
    settings: ExperienceSettings,
    partial?: Partial<TorchLightSettings> | null
): TorchLightSettings {
    ensureLighting(settings);
    const lighting = (settings as Record<string, unknown>).lighting as { torch?: TorchLightSettings };
    const base: Record<string, unknown> = lighting.torch && typeof lighting.torch === 'object'
        ? { ...(lighting.torch as unknown as Record<string, unknown>) }
        : { ...DEFAULT_TORCH_LIGHT, color: [...DEFAULT_TORCH_LIGHT.color] };
    if (partial && typeof partial === 'object') {
        if (Array.isArray((partial as Record<string, unknown>).color)) {
            base.color = (partial as Record<string, unknown>).color;
        }
        if ((partial as Record<string, unknown>).intensity !== undefined) {
            base.intensity = (partial as Record<string, unknown>).intensity;
        }
        if ((partial as Record<string, unknown>).range !== undefined) {
            base.range = (partial as Record<string, unknown>).range;
        }
    }
    const next = normalizeTorchFields(base);
    lighting.torch = next;
    return next;
}

/**
 * `TORCH_DELETE`：从 `settings.lighting.torch` 移除；无 torch 时为 no-op。
 * 返回是否实际删除。
 */
export function removeTorchLight(settings: ExperienceSettings): boolean {
    const lighting = (settings as Record<string, unknown>).lighting as { torch?: unknown } | undefined;
    if (!lighting || typeof lighting !== 'object' || lighting.torch == null) return false;
    delete lighting.torch;
    return true;
}

/**
 * `TORCH_PARAMS_SET`：仅在已 `TORCH_ADD` 时合并 partial；未 ADD 返回 null（不隐式入库）。
 */
export function patchTorchLight(
    settings: ExperienceSettings,
    partial: Partial<TorchLightSettings>
): TorchLightSettings | null {
    if (!hasTorchLight(settings)) return null;
    if (!partial || typeof partial !== 'object') return readTorchLight(settings);
    return addTorchLight(settings, partial);
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
        if (typeof sh.enabled !== 'boolean') sh.enabled = DEFAULT_SHADOW.enabled;
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
        visible: typeof a.visible === 'boolean' ? a.visible : true,
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
