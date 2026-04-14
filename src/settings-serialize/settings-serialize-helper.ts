import type {
    Annotation,
    Camera,
    BloomEditorSession,
    ExperienceSettings,
    PointLightConfig,
    DirectionalLightConfig,
    SpotLightConfig
} from '../schemas/v2';
import {
    DEFAULT_BLOOM,
    DEFAULT_BLOOM_EDITOR_SESSION,
    DEFAULT_LIGHTING_ROOT,
    DEFAULT_NIGHT_MODE,
    DEFAULT_REVEAL_EFFECT,
    DEFAULT_SHADOW
} from './settings-serialize-configs';

/** 光源配置项在运行时应带稳定 id（列表 / Gizmo / 协议共用） */
export type LightWithId = (PointLightConfig | DirectionalLightConfig | SpotLightConfig) & { id?: string };

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
    if (typeof (b as any).localLightsEnabled !== 'boolean') (b as any).localLightsEnabled = false;
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
    return {
        id,
        position: pos,
        title: typeof a.title === 'string' ? a.title : '',
        text: typeof a.text === 'string' ? a.text : '',
        imageUrl: typeof a.imageUrl === 'string' ? a.imageUrl : undefined,
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
