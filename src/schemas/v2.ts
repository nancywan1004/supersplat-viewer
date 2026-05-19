import type {
    LodSettings,
    LodPreset,
    LodPlatform,
    LegacyRevealEffect,
    TransformFrame,
    PointLightConfig,
    DirectionalLightConfig,
    SpotLightConfig,
    LightingSettings,
    SceneAsset,
    LocalLightRegion,
    WorldSpaceBloomRegionJSON,
    EffectsSettings
} from './v2-custom';
import {
    assertObject,
    assertNumber,
    assertString,
    assertBoolean,
    assertEnum,
    assertArray,
    assertNumberArray,
    assertTuple3
} from './validate-utils';

type AnimTrack = {
    name: string,
    duration: number,
    frameRate: number,
    loopMode: 'none' | 'repeat' | 'pingpong',
    interpolation: 'step' | 'spline',
    smoothness: number,
    keyframes: {
        times: number[],
        values: {
            position: number[],
            target: number[],
            fov: number[],
        }
    },
    fl_loop?: boolean,
    fl_loopTimeSeconds?: number,
};

type CameraPose = {
    position: [number, number, number],
    target: [number, number, number],
    fov: number
};

type Camera = {
    initial: CameraPose,
    pitchRange?: [number, number];
};

type Annotation = {
    id: string,
    position: [number, number, number],
    title: string,
    text: string,
    imageUrl?: string,
    videoUrl?: string,
    showTitleWhenCollapsed: boolean,
    collapsed: boolean,
    extras?: any,
    camera: Camera;
};

type BloomEditorSession = {
    bloomBrush: boolean;
    activeLocalLightRegionId: string | null;
    draftLightRegionCenter: [number, number, number] | null;
};

type PostEffectSettings = {
    sharpness: {
        enabled: boolean,
        amount: number,
    },
    bloom: {
        enabled: boolean,
        intensity: number,
        blurLevel: number,
        threshold: number,
        bloomDebug: boolean,
        bloomScope?: 'global' | 'local';
        bloomBrushSize: number,
        bloomBrushBrightness?: number,
        localLightRegions?: LocalLightRegion[];
    },
    bloomEditorSession?: BloomEditorSession,
    grading: {
        enabled: boolean,
        brightness: number,
        contrast: number,
        saturation: number,
        tint: [number, number, number],
    },
    vignette: {
        enabled: boolean,
        intensity: number,
        inner: number,
        outer: number,
        curvature: number,
    },
    fringing: {
        enabled: boolean,
        intensity: number
    },
    shadow: {
        enabled: boolean,
        darken: number,
        debugRt?: boolean,
        debugVisual?: boolean,
        castShadows?: boolean,
        lightPitch?: number,
        lightYaw?: number,
        shadowBias?: number,
        sphereRadius?: number
    }
};

type ExperienceSettings = {
    version: 2,
    tonemapping: 'none' | 'linear' | 'filmic' | 'hejl' | 'aces' | 'aces2' | 'neutral',
    highPrecisionRendering: boolean,
    soundUrl?: string,
    background: {
        color: [number, number, number],
        skyboxUrl?: string
    },
    postEffectSettings: PostEffectSettings,
    animTracks: AnimTrack[],
    cameras: Camera[],
    annotations: Annotation[],
    startMode: 'default' | 'animTrack' | 'annotation',
    hasStartPose?: boolean,
    /**
     * @deprecated 仅导入旧 JSON 与内存读兼容；**编辑/协议写入口**为 `settings.effects.reveal`（`syncLegacyRevealEffectShadow` 对齐本字段）。
     */
    revealEffect?: LegacyRevealEffect,
    /** 三轨特效持久化；scene reveal 以 **`effects.reveal` 为真源**；`revealEffect` 仅旧数据导入读兼容 */
    effects?: EffectsSettings,
    lodSettings?: LodSettings,
    lighting?: LightingSettings,
    nightMode?: {
        fade?: number;
        enabled?: boolean;
    };
    /**
     * 可选：相机边界策略（不影响旧 settings.json）
     * - enabled: 是否启用相机移动限制（默认 true）
     * - animScaleX: X 轴方向的缩放系数（可选，仅在有动画路径时生效）
     *   可以是单个数值（左右相同）或数组 [left, right]（分别设置左右缩放，默认 1.5）
     * - animScaleY: Y 轴方向的缩放系数（可选，仅在有动画路径时生效）
     *   可以是单个数值（上下相同）或数组 [top, bottom]（分别设置上下缩放，默认 1.5）
     * - animScaleZ: Z 轴方向的缩放系数（可选，仅在有动画路径时生效）
     *   可以是单个数值（前后/两侧相同）或数组 [负 Z 侧, 正 Z 侧]（沿 min.z / max.z 分别缩放 halfExtents.z，默认与未写 X/Y 时一致为 1.5）
     */
    cameraBounds?: {
        enabled?: boolean;
        animScaleX?: number | [number, number];
        animScaleY?: number | [number, number];
        animScaleZ?: number | [number, number];
    };
    initialCameraMode?: 'orbit' | 'fly';
    sceneAssets?: SceneAsset[];
};

const TONEMAPPING = ['none', 'linear', 'filmic', 'hejl', 'aces', 'aces2', 'neutral'] as const;
const LOOP_MODES = ['none', 'repeat', 'pingpong'] as const;
const INTERPOLATIONS = ['step', 'spline'] as const;
const START_MODES = ['default', 'animTrack', 'annotation'] as const;

const validateAnimTrack = (data: unknown, path: string): AnimTrack => {
    const obj = assertObject(data, path);
    assertString(obj.name, `${path}.name`);
    assertNumber(obj.duration, `${path}.duration`);
    assertNumber(obj.frameRate, `${path}.frameRate`);
    assertEnum(obj.loopMode, LOOP_MODES, `${path}.loopMode`);
    assertEnum(obj.interpolation, INTERPOLATIONS, `${path}.interpolation`);
    assertNumber(obj.smoothness, `${path}.smoothness`);

    const kf = assertObject(obj.keyframes, `${path}.keyframes`);
    assertNumberArray(kf.times, `${path}.keyframes.times`);
    const vals = assertObject(kf.values, `${path}.keyframes.values`);
    assertNumberArray(vals.position, `${path}.keyframes.values.position`);
    assertNumberArray(vals.target, `${path}.keyframes.values.target`);
    assertNumberArray(vals.fov, `${path}.keyframes.values.fov`);

    return data as AnimTrack;
};

const validateCamera = (data: unknown, path: string): Camera => {
    const obj = assertObject(data, path);
    const initial = assertObject(obj.initial, `${path}.initial`);
    assertTuple3(initial.position, `${path}.initial.position`);
    assertTuple3(initial.target, `${path}.initial.target`);
    assertNumber(initial.fov, `${path}.initial.fov`);
    if (obj.pitchRange !== undefined) {
        const pitchRange = assertNumberArray(obj.pitchRange, `${path}.pitchRange`);
        if (pitchRange.length !== 2) {
            throw new Error(`${path}.pitchRange must have exactly 2 elements`);
        }
    }
    return data as Camera;
};

const validateAnnotation = (data: unknown, path: string): Annotation => {
    const obj = assertObject(data, path);
    assertString(obj.id, `${path}.id`);
    assertTuple3(obj.position, `${path}.position`);
    assertString(obj.title, `${path}.title`);
    assertString(obj.text, `${path}.text`);
    if (obj.imageUrl !== undefined) assertString(obj.imageUrl, `${path}.imageUrl`);
    if (obj.videoUrl !== undefined) assertString(obj.videoUrl, `${path}.videoUrl`);
    assertBoolean(obj.showTitleWhenCollapsed, `${path}.showTitleWhenCollapsed`);
    assertBoolean(obj.collapsed, `${path}.collapsed`);
    validateCamera(obj.camera, `${path}.camera`);
    return data as Annotation;
};

const validatePostEffects = (data: unknown, path: string): PostEffectSettings => {
    const obj = assertObject(data, path);

    const sh = assertObject(obj.sharpness, `${path}.sharpness`);
    assertBoolean(sh.enabled, `${path}.sharpness.enabled`);
    assertNumber(sh.amount, `${path}.sharpness.amount`);

    const bl = assertObject(obj.bloom, `${path}.bloom`);
    assertBoolean(bl.enabled, `${path}.bloom.enabled`);
    assertNumber(bl.intensity, `${path}.bloom.intensity`);
    assertNumber(bl.blurLevel, `${path}.bloom.blurLevel`);
    assertNumber(bl.threshold, `${path}.bloom.threshold`);
    assertBoolean(bl.bloomDebug, `${path}.bloom.bloomDebug`);
    assertNumber(bl.bloomBrushSize, `${path}.bloom.bloomBrushSize`);
    if (bl.bloomScope !== undefined) {
        assertEnum(bl.bloomScope, ['global', 'local'] as const, `${path}.bloom.bloomScope`);
    }
    if (bl.bloomBrushBrightness !== undefined) {
        assertNumber(bl.bloomBrushBrightness, `${path}.bloom.bloomBrushBrightness`);
    }

    const gr = assertObject(obj.grading, `${path}.grading`);
    assertBoolean(gr.enabled, `${path}.grading.enabled`);
    assertNumber(gr.brightness, `${path}.grading.brightness`);
    assertNumber(gr.contrast, `${path}.grading.contrast`);
    assertNumber(gr.saturation, `${path}.grading.saturation`);
    assertTuple3(gr.tint, `${path}.grading.tint`);

    const vi = assertObject(obj.vignette, `${path}.vignette`);
    assertBoolean(vi.enabled, `${path}.vignette.enabled`);
    assertNumber(vi.intensity, `${path}.vignette.intensity`);
    assertNumber(vi.inner, `${path}.vignette.inner`);
    assertNumber(vi.outer, `${path}.vignette.outer`);
    assertNumber(vi.curvature, `${path}.vignette.curvature`);

    const fr = assertObject(obj.fringing, `${path}.fringing`);
    assertBoolean(fr.enabled, `${path}.fringing.enabled`);
    assertNumber(fr.intensity, `${path}.fringing.intensity`);

    const shadow = assertObject(obj.shadow, `${path}.shadow`);
    assertBoolean(shadow.enabled, `${path}.shadow.enabled`);
    assertNumber(shadow.darken, `${path}.shadow.darken`);

    return data as PostEffectSettings;
};

const validateV2 = (data: unknown): ExperienceSettings => {
    const obj = assertObject(data, 'settings');

    if (obj.version !== 2) {
        throw new Error('settings.version must be 2');
    }

    assertEnum(obj.tonemapping, TONEMAPPING, 'settings.tonemapping');
    assertBoolean(obj.highPrecisionRendering, 'settings.highPrecisionRendering');
    if (obj.soundUrl !== undefined) assertString(obj.soundUrl, 'settings.soundUrl');

    const bg = assertObject(obj.background, 'settings.background');
    assertTuple3(bg.color, 'settings.background.color');
    if (bg.skyboxUrl !== undefined) assertString(bg.skyboxUrl, 'settings.background.skyboxUrl');

    validatePostEffects(obj.postEffectSettings, 'settings.postEffectSettings');

    const tracks = assertArray(obj.animTracks, 'settings.animTracks');
    tracks.forEach((t: unknown, i: number) => validateAnimTrack(t, `settings.animTracks[${i}]`));

    const cameras = assertArray(obj.cameras, 'settings.cameras');
    cameras.forEach((c: unknown, i: number) => validateCamera(c, `settings.cameras[${i}]`));

    const annotations = assertArray(obj.annotations, 'settings.annotations');
    annotations.forEach((a: unknown, i: number) => validateAnnotation(a, `settings.annotations[${i}]`));

    assertEnum(obj.startMode, START_MODES, 'settings.startMode');

    if (obj.effects !== undefined) {
        const ef = assertObject(obj.effects, 'settings.effects');
        const reveal = assertObject(ef.reveal, 'settings.effects.reveal');
        assertString(reveal.activeEffectId, 'settings.effects.reveal.activeEffectId');
        if (typeof reveal.paramsById !== 'object' || reveal.paramsById === null) {
            throw new Error('settings.effects.reveal.paramsById must be an object');
        }
        const pers = assertObject(ef.persistent, 'settings.effects.persistent');
        assertString(pers.activeEffectId, 'settings.effects.persistent.activeEffectId');
        assertBoolean(pers.enabled, 'settings.effects.persistent.enabled');
        if (typeof pers.paramsById !== 'object' || pers.paramsById === null) {
            throw new Error('settings.effects.persistent.paramsById must be an object');
        }
        const asset = assertObject(ef.asset, 'settings.effects.asset');
        if (typeof asset.defaultParamsById !== 'object' || asset.defaultParamsById === null) {
            throw new Error('settings.effects.asset.defaultParamsById must be an object');
        }
    }

    return data as ExperienceSettings;
};

export { validateV2 };
export type {
    AnimTrack,
    BloomEditorSession,
    Camera,
    Annotation,
    PostEffectSettings,
    LegacyRevealEffect,
    EffectsSettings,
    LodSettings,
    LodPreset,
    LodPlatform,
    TransformFrame,
    ExperienceSettings,
    PointLightConfig,
    DirectionalLightConfig,
    SpotLightConfig,
    LightingSettings,
    WorldSpaceBloomRegionJSON,
    LocalLightRegion,
};
