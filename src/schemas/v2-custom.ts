/** Timed VFX 默认总时长（秒），唯一默认值来源，修改此处即可全局生效 */
export const DEFAULT_VFX_TOTAL_DURATION = 10;

/**
 * @deprecated legacy 单轨 reveal 字段（仅导入兼容读取，不再作为持久化写入真源）
 */
type LegacyRevealEffect = {
    type?: 'radial' | 'rain' | 'rain-v2' | 'smooth' | 'pieces-recover' | 'perlin-wave' | 'integrate' | 'growth-wave' | 'sketch' | 'none',
    /** 为 `false` 时保留 `type` 与专参于 settings，但不在场景中挂载/播放 */
    enable?: boolean,
    autoStart?: boolean,
    totalDuration?: number, // 总时长（秒）：**仅一次性 reveal 轨**（Timed VFX 等）；**persistent 轨 `paramsById` 不持久化此字段**。默认见 DEFAULT_VFX_TOTAL_DURATION
    /**
     * 按当前 `type` 生效的脚本级参数（扁平 key→值）；协议见 `EFFECT_PARAMS_PATCH.params.[type]`。
     * **reveal 轨**：白名单见 `reveal-effect-params.ts`；**persistent 轨**（如 `perlin-wave`）：白名单见 `persistent-effect-params.ts`。
     */
    effectParams?: Record<string, unknown>
}

type LodPlatform = 'desktop-max' | 'desktop' | 'mobile-max' | 'mobile'

type LodPreset = {
    range: [number, number],
    lodDistances: number[],
    splatBudget?: number
}

type LodSettings = {
    presets?: Record<LodPlatform, LodPreset>,
    lodUpdateDistance?: number, // 0.5
    lodUnderfillLimit?: number, // 5
    cameraPosition?: number[], // [[10.3, 2, -10]
    eulerAngles?: number[], // [-90, 0, 0]
    moveSpeed?: number, // 4
    moveFastSpeed?: number, // 15
    enableOrbit?: boolean, // false
    enablePan?: boolean, // false
    focusPoint?: number[], // [12, 3, 0]
    [key: string]: any;
}

type TransformFrame = {
    id: number,
    img_name: string,
    width: number,
    height: number,
    position: [number, number, number],
    rotation: [[number, number, number], [number, number, number], [number, number, number]],
    fy: number,
    fx: number
}

/**
 * Lighting 配置（自定义扩展字段）
 * - 用于 settings.json 中配置点光源、平行光等
 */
type PointLightConfig = {
    type: 'point',
    id?: string,
    /** 光源显示名称（用于 UI 列表展示），例如「点光源01」 */
    name?: string,
    position: [number, number, number],
    color: [number, number, number],
    intensity: number,
    /** 点光影响距离（世界单位），与引擎 Light.range 及编辑线框球半径一致，默认 10 */
    range?: number,
    /** 是否启用该光源，默认 true */
    enabled?: boolean
};

/** 平行光配置（主方向光/太阳，无位置概念，仅方向；用于阴影等）。阴影由 `shadow.enabled` 控制，URL `?splatMesh=` 仅作前置条件。 */
type DirectionalLightConfig = {
    type: 'directional',
    id?: string,
    /** 光源显示名称（用于 UI 列表展示），例如「主光源」 */
    name?: string,
    /** 仅用于锥体可视化与阴影相机参考，默认 [0, 8, 8] */
    position?: [number, number, number],
    color: [number, number, number],
    intensity: number,
    pitch?: number,
    yaw?: number,
    shadowBias?: number,
    enabled?: boolean
};

/** 聚光灯配置：有位置 + 方向，局部锥形照明 */
type SpotLightConfig = {
    type: 'spot',
    id?: string,
    /** 光源显示名称（用于 UI 列表展示），例如「聚光灯01」 */
    name?: string,
    position: [number, number, number],
    color: [number, number, number],
    intensity: number,
    /** 俯仰角（度），默认 -45 */
    pitch?: number,
    /** 偏航角（度），默认 0 */
    yaw?: number,
    /** 内锥整顶角（度，0–180），默认 50（等效引擎半角约 25°） */
    innerConeAngle?: number,
    /** 外锥整顶角（度，0–180），默认 90（等效引擎半角约 45°） */
    outerConeAngle?: number,
    /** 照射范围（世界单位），默认 10 */
    range?: number,
    enabled?: boolean
};

/**
 * 全局「手电筒」配置（单例，**不进入** `lights[]`）：
 * - 运行时为跟随光标的 PointLight，位置由 `Picker.pickSurface` 拾取得到的世界落点决定
 * - 拾取未命中时回退到相机前方常量距离（见 controller 内 `TORCH_FALLBACK_DISTANCE`）
 * - 仅参数持久化，开关与运行态在 `ViewSettings.torch`（不入库）
 * - 全局最多一份，因此挂在 `LightingSettings.torch` 而非数组项
 */
type TorchLightSettings = {
    /** sRGB [0,1] 三分量 */
    color: [number, number, number];
    /** 光强（与点光语义一致） */
    intensity: number;
    /** PointLight 有效作用半径（世界单位，clamp 0–20）；光源贴在拾取表面 */
    range: number;
};

type LightingSettings = {
    /** 点光源 + 平行光（最多一个） + 聚光灯 */
    lights: (PointLightConfig | DirectionalLightConfig | SpotLightConfig)[],
    /** 全局手电筒（单例）；缺失时由 `ensureTorchLight` 补齐默认 */
    torch?: TorchLightSettings
};

/**
 * 世界空间 Bloom 区域的序列化结构，
 * 需与 WorldSpaceBloomData.toJSON() 保持兼容。
 */
type WorldSpaceBloomRegionJSON = {
    points: Array<{
        position: [number, number, number],
        radius: number,
        intensity: number,
    }>,
    committed: Array<{
        position: [number, number, number],
        radius: number,
        intensity: number,
    }>,
    committedBrightness?: number,
};

/**
 * 单个局部亮灯区域配置。
 */
type LocalLightRegion = {
    /** 稳定 ID，用于内部引用与父级托管 */
    id: string;
    /** 列表显示名称，例如「亮灯区域01」 */
    name: string;
    /** 世界空间 Bloom 区域数据（与 WorldSpaceBloomData.toJSON 兼容） */
    worldSpace: WorldSpaceBloomRegionJSON;
    /**
     * 区域局部亮度 -1～1：
     * - 0 不变
     * - <0 调暗
     * - >0 调亮
     */
    localBrightness: number;
    /**
     * 颜色调制：参与混合的颜色（sRGB [0,1]），与 nightFade 调暗时的颜色混合原理一致。
     * 默认 [1,1,1] 表示无着色。
     */
    tintColor?: [number, number, number];
    /**
     * 颜色混合系数 0～1：0 不混合，1 完全使用 tintColor 参与混合。
     */
    tintBlend?: number;
    /**
     * （可选）与该局部亮灯区域绑定的光源 ID：
     * - 当通过该区域的 draftLightRegionCenter 创建点光源 / 聚光灯时，写入对应 light.id；
     * - 删除该区域时，可用于同步删除对应光源；
     * - 调整区域 tintColor 时，可用于同步更新对应光源的颜色。
     */
    linkedLightId?: string | null;
};

/** 场景音视频热区全局参数（持久化于 settings 根；触发距离在 sceneAssets[]） */
type SceneMediaHotspotSettings = {
    /** 视频热区全局参数 */
    video: {
        /** 是否由热区自动播放；缺省 true，显式 false 时入库 */
        hotspotAutoplayEnabled?: boolean;
        /** 视锥半角（度）；总锥约 `2 × coneHalfDeg` */
        coneHalfDeg: number;
    };
    /** 音频热区全局参数（音频用纯欧氏距离，无视锥） */
    audio: {
        /** 是否由热区自动播放；缺省 true，显式 false 时入库 */
        hotspotAutoplayEnabled?: boolean;
        /**
         * 浏览模式（Viewer / 编辑预览）下是否显示音频 callout 与播放按钮；
         * 缺省 true（浏览模式可见且可手动 toggle），显式 false 时入库。
         */
        showCalloutInViewer?: boolean;
    };
};

/** 父级 `MEDIA_HOTSPOT_SET` 入站 payload；video / audio 子节点字段均可部分提供 */
type SceneMediaHotspotPatch = {
    video?: Partial<SceneMediaHotspotSettings['video']>;
    audio?: Partial<SceneMediaHotspotSettings['audio']>;
};

type SceneAsset = {
    id: string,
    type: 'image' | 'mesh' | 'gaussian' | 'video' | 'audio',
    name: string,
    visible: boolean,
    /** 对应源资产库条目的缩略图 URL（可选，持久化到 settings.sceneAssets） */
    thumbnailUrl?: string,
    source: {
        assetId?: string,
        filename?: string,
        url?: string
    },
    /** video / audio：热区触发距离（米）；video 用视轴深度，audio 用欧氏距离 */
    triggerDistanceM?: number,
    transform: {
        position: [number, number, number],
        /** 兼容字段：旧数据使用欧拉角 */
        rotation: [number, number, number],
        /** 推荐字段：四元数旋转 [x, y, z, w]，用于规避欧拉角多解 */
        rotationQuat?: [number, number, number, number],
        scale: [number, number, number],
        /** 每轴镜像符号：-1=镜像翻转，1=正常；用于显式持久化 scale 镜像状态 */
        mirror?: [1 | -1, 1 | -1, 1 | -1],
        /** 仅 video：0 平面，(0,1] 横向曲度（绕竖直轴 / 屏幕宽度方向） */
        horizontalCurvature?: number
    }
}

/** 三轨特效持久化：reveal / persistent / asset；`enable` 出现在 reveal / persistent 类型块 */
type EffectsRevealTrack = {
    activeEffectId: string;
    paramsById: Record<string, Record<string, unknown>>;
};

type EffectsPersistentSceneTrack = {
    activeEffectId: string;
    paramsById: Record<string, Record<string, unknown>>;
};

type EffectsAssetTrack = {
    defaultParamsById: Record<string, Record<string, unknown>>;
};

type EffectsSettings = {
    reveal: EffectsRevealTrack;
    persistent: {
        scene: EffectsPersistentSceneTrack;
    };
    asset: EffectsAssetTrack;
};

/** scene persistent 单类型配置（`paramsById[id]` 内 `{ [type]: { enable, …专参 } }` 的一项） */
type PersistentSceneEffectEntry = {
    type: string;
    enable: boolean;
    autoStart: boolean;
    effectParams?: Record<string, unknown>;
};

export type {
    LegacyRevealEffect,
    LodSettings,
    LodPreset,
    LodPlatform,
    TransformFrame,
    PointLightConfig,
    DirectionalLightConfig,
    SpotLightConfig,
    TorchLightSettings,
    LightingSettings,
    SceneAsset,
    SceneMediaHotspotSettings,
    SceneMediaHotspotPatch,
    LocalLightRegion,
    WorldSpaceBloomRegionJSON,
    EffectsSettings,
    EffectsRevealTrack,
    EffectsPersistentSceneTrack,
    EffectsAssetTrack,
    PersistentSceneEffectEntry
};
