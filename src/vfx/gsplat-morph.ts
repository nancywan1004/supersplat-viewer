import {
    Asset,
    Entity,
    GSplatData,
    GSplatResource,
    WORKBUFFER_UPDATE_ALWAYS,
    WORKBUFFER_UPDATE_ONCE,
    type AppBase
} from 'playcanvas';

import type { AssetSource } from '../loaders/asset-source';

type MorphSource = string | AssetSource;

interface SplatArrays {
    count: number;
    x: Float32Array;
    y: Float32Array;
    z: Float32Array;
    opacity: Float32Array;
    rot0: Float32Array;
    rot1: Float32Array;
    rot2: Float32Array;
    rot3: Float32Array;
    fdc0: Float32Array;
    fdc1: Float32Array;
    fdc2: Float32Array;
    scale0: Float32Array;
    scale1: Float32Array;
    scale2: Float32Array;
    rest: Float32Array[];
}

interface LoadedMorphModel {
    name: string;
    asset: Asset;
    resource: GSplatResource;
    data: GSplatData;
    splats: SplatArrays;
}

interface PairCorrespondence {
    /** 长度恒为 `max(|A|,|B|)`，两侧下标均合法，无 leftover。 */
    matchedA: Uint32Array;
    matchedB: Uint32Array;
}

export interface GsplatMorphOptions {
    segmentDuration?: number;
    loop?: boolean;
    autoPlay?: boolean;
    /**
     * 为 true（默认）时，在 `playing` 且存在 morph 段期间临时将 `app.autoRender = true`（每帧都走完整 render，最稳但最费 GPU）。
     * 为 false 时只靠 `renderNextFrame` + `gsplat:sorted` 补帧（更省电）；若仍遇偶发停更可改回 true。
     */
    continuousAppRender?: boolean;
    unified?: boolean;
    layers?: number[];
    entityName?: string;
    fadeLogMin?: number; /** 仅用于输出缓冲大于本段 `max(|A|,|B|)` 时的尾部占位（极小高斯），不参与段内配对。 */
    recenterModels?: boolean;
    normalizeScales?: boolean;
    targetScale?: number;
}

const MAX_MORPH_MODELS = 4;
const MAX_SH_REST_PROPS = 45;
const DEFAULT_SEGMENT_DURATION = 1.5;
const DEFAULT_FADE_LOG_MIN = -6.0;
const DEFAULT_TARGET_SCALE = 10.0;
const VALID_REST_PROP_COUNTS = [0, 9, 24, 45] as const;

const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));

const safeFilenameFromUrl = (url: string) => {
    try {
        const pathname = new URL(url, location.href).pathname;
        return pathname.split('/').pop() || `morph-${Date.now()}.ply`;
    } catch {
        return url.split('/').pop() || `morph-${Date.now()}.ply`;
    }
};

const resolveMorphSource = (source: MorphSource, index: number) => {
    if (typeof source === 'string') {
        return {
            url: new URL(source, location.href).href,
            filename: safeFilenameFromUrl(source),
            cleanupUrl: null as string | null
        };
    }

    if (source.contents) {
        const objectUrl = URL.createObjectURL(source.contents);
        return {
            url: objectUrl,
            filename: source.filename || source.contents.name || `morph-${index + 1}.ply`,
            cleanupUrl: objectUrl
        };
    }

    const url = source.url ?? source.filename;
    if (!url) {
        throw new Error(`Morph source #${index + 1} 缺少 url/filename/contents`);
    }

    return {
        url: new URL(url, location.href).href,
        filename: source.filename || safeFilenameFromUrl(url),
        cleanupUrl: null as string | null
    };
};

const getRequiredProp = (data: GSplatData, name: string) => {
    const prop = data.getProp(name) as ArrayLike<number> | null;
    if (!prop) {
        throw new Error(`GSplat 缺少必要属性: ${name}`);
    }
    return Float32Array.from(prop);
};

const getRestPropCount = (data: GSplatData) => {
    let count = 0;
    for (let i = 0; i < MAX_SH_REST_PROPS; i++) {
        if (!data.getProp(`f_rest_${i}`)) {
            break;
        }
        count++;
    }
    return count;
};

const normalizeRestPropCount = (count: number) => {
    if (VALID_REST_PROP_COUNTS.includes(count as typeof VALID_REST_PROP_COUNTS[number])) {
        return count;
    }

    throw new Error(`Unsupported SH rest property count: ${count}`);
};

const readSplatArrays = (data: GSplatData): SplatArrays => {
    const restCount = normalizeRestPropCount(getRestPropCount(data));
    const rest = Array.from({ length: restCount }, (_, index) => getRequiredProp(data, `f_rest_${index}`));

    return {
        count: data.numSplats,
        x: getRequiredProp(data, 'x'),
        y: getRequiredProp(data, 'y'),
        z: getRequiredProp(data, 'z'),
        opacity: getRequiredProp(data, 'opacity'),
        rot0: getRequiredProp(data, 'rot_0'),
        rot1: getRequiredProp(data, 'rot_1'),
        rot2: getRequiredProp(data, 'rot_2'),
        rot3: getRequiredProp(data, 'rot_3'),
        fdc0: getRequiredProp(data, 'f_dc_0'),
        fdc1: getRequiredProp(data, 'f_dc_1'),
        fdc2: getRequiredProp(data, 'f_dc_2'),
        scale0: getRequiredProp(data, 'scale_0'),
        scale1: getRequiredProp(data, 'scale_1'),
        scale2: getRequiredProp(data, 'scale_2'),
        rest
    };
};

const recenterPointCloud = (model: SplatArrays) => {
    if (model.count === 0) {
        return;
    }

    let cx = 0;
    let cy = 0;
    let cz = 0;

    for (let i = 0; i < model.count; i++) {
        cx += model.x[i];
        cy += model.y[i];
        cz += model.z[i];
    }

    cx /= model.count;
    cy /= model.count;
    cz /= model.count;

    for (let i = 0; i < model.count; i++) {
        model.x[i] -= cx;
        model.y[i] -= cy;
        model.z[i] -= cz;
    }
};

const normalizeScale = (model: SplatArrays, targetScale: number) => {
    if (model.count === 0) {
        return;
    }

    let minX = model.x[0];
    let minY = model.y[0];
    let minZ = model.z[0];
    let maxX = model.x[0];
    let maxY = model.y[0];
    let maxZ = model.z[0];

    for (let i = 1; i < model.count; i++) {
        minX = Math.min(minX, model.x[i]);
        minY = Math.min(minY, model.y[i]);
        minZ = Math.min(minZ, model.z[i]);
        maxX = Math.max(maxX, model.x[i]);
        maxY = Math.max(maxY, model.y[i]);
        maxZ = Math.max(maxZ, model.z[i]);
    }

    const extentX = maxX - minX;
    const extentY = maxY - minY;
    const extentZ = maxZ - minZ;
    const maxExtent = Math.max(extentX, extentY, extentZ);

    if (!(Number.isFinite(maxExtent) && maxExtent > 0)) {
        return;
    }

    const scaleFactor = targetScale / maxExtent;
    const logScaleFactor = Math.log(scaleFactor);

    for (let i = 0; i < model.count; i++) {
        model.x[i] *= scaleFactor;
        model.y[i] *= scaleFactor;
        model.z[i] *= scaleFactor;
        model.scale0[i] += logScaleFactor;
        model.scale1[i] += logScaleFactor;
        model.scale2[i] += logScaleFactor;
    }
};

// 去中心+尺度归一化
const preprocessModel = (model: SplatArrays, options: GsplatMorphOptions) => {
    if (options.recenterModels ?? true) {
        recenterPointCloud(model);
    }

    if (options.normalizeScales ?? true) {
        normalizeScale(model, options.targetScale ?? DEFAULT_TARGET_SCALE);
    }
};

const createMutableGSplatData = (numSplats: number, restPropCount: number) => {
    const makeFloatProp = (name: string) => ({
        type: 'float' as const,
        name,
        storage: new Float32Array(numSplats),
        byteSize: 4
    });

    const properties = [
        makeFloatProp('x'),
        makeFloatProp('y'),
        makeFloatProp('z'),
        makeFloatProp('opacity'),
        makeFloatProp('rot_0'),
        makeFloatProp('rot_1'),
        makeFloatProp('rot_2'),
        makeFloatProp('rot_3'),
        makeFloatProp('f_dc_0'),
        makeFloatProp('f_dc_1'),
        makeFloatProp('f_dc_2'),
        makeFloatProp('scale_0'),
        makeFloatProp('scale_1'),
        makeFloatProp('scale_2')
    ];

    for (let i = 0; i < restPropCount; i++) {
        properties.push(makeFloatProp(`f_rest_${i}`));
    }

    const data = new GSplatData([{
        name: 'vertex',
        count: numSplats,
        properties
    }]);

    return {
        data,
        arrays: {
            count: numSplats,
            x: data.getProp('x') as Float32Array,
            y: data.getProp('y') as Float32Array,
            z: data.getProp('z') as Float32Array,
            opacity: data.getProp('opacity') as Float32Array,
            rot0: data.getProp('rot_0') as Float32Array,
            rot1: data.getProp('rot_1') as Float32Array,
            rot2: data.getProp('rot_2') as Float32Array,
            rot3: data.getProp('rot_3') as Float32Array,
            fdc0: data.getProp('f_dc_0') as Float32Array,
            fdc1: data.getProp('f_dc_1') as Float32Array,
            fdc2: data.getProp('f_dc_2') as Float32Array,
            scale0: data.getProp('scale_0') as Float32Array,
            scale1: data.getProp('scale_1') as Float32Array,
            scale2: data.getProp('scale_2') as Float32Array,
            rest: Array.from({ length: restPropCount }, (_, i) => data.getProp(`f_rest_${i}`) as Float32Array)
        } satisfies SplatArrays
    };
};

const normalizeQuat = (x: number, y: number, z: number, w: number) => {
    const length = Math.hypot(x, y, z, w);
    if (length <= 1e-8) {
        return { x: 0, y: 0, z: 0, w: 1 };
    }

    return {
        x: x / length,
        y: y / length,
        z: z / length,
        w: w / length
    };
};

const slerpQuat = (
    ax: number, ay: number, az: number, aw: number,
    bx: number, by: number, bz: number, bw: number,
    t: number
) => {
    let qa = normalizeQuat(ax, ay, az, aw);
    let qb = normalizeQuat(bx, by, bz, bw);

    let dot = qa.x * qb.x + qa.y * qb.y + qa.z * qb.z + qa.w * qb.w;
    if (dot < 0) {
        qb = { x: -qb.x, y: -qb.y, z: -qb.z, w: -qb.w };
        dot = -dot;
    }

    if (dot > 0.9995) {
        return normalizeQuat(
            qa.x + (qb.x - qa.x) * t,
            qa.y + (qb.y - qa.y) * t,
            qa.z + (qb.z - qa.z) * t,
            qa.w + (qb.w - qa.w) * t
        );
    }

    const theta0 = Math.acos(clamp(dot, -1, 1));
    const sinTheta0 = Math.sin(theta0);
    if (Math.abs(sinTheta0) < 1e-6) {
        return qa;
    }

    const theta = theta0 * t;
    const s1 = Math.sin(theta0 - theta) / sinTheta0;
    const s2 = Math.sin(theta) / sinTheta0;

    return {
        x: qa.x * s1 + qb.x * s2,
        y: qa.y * s1 + qb.y * s2,
        z: qa.z * s1 + qb.z * s2,
        w: qa.w * s1 + qb.w * s2
    };
};
// 构建帧索引对应表
class GaussianInterpolatorRuntime {
    readonly models: LoadedMorphModel[];

    readonly correspondences = new Map<string, PairCorrespondence>();

    readonly fadeLogMin: number;

    constructor(models: LoadedMorphModel[], fadeLogMin: number) {
        this.models = models;
        this.fadeLogMin = fadeLogMin;
        this.buildCorrespondences();
    }

    private pairKey(idxA: number, idxB: number) {
        return `${idxA}:${idxB}`;
    }

    private buildCorrespondences() {
        for (let i = 0; i < this.models.length - 1; i++) {
            const j = i + 1;
            this.correspondences.set(
                this.pairKey(i, j),
                this.correspondMaxResample(this.models[i].splats, this.models[j].splats)
            );
        }
    }

    /**
     * `max(|A|,|B|)` 条输出对应关系，**无 leftover、无 fade**：
     * - 点数多的一侧：输出槽 `i` 直接用该侧下标 `i`；
     * - 少的一侧：`floor(i * smallCount / largeCount)`（多对一，例如 A=200w、B=100w 时约两个输出槽共用同一个 `B[j]`，但各自与不同的 `A[i]` 做完整属性 lerp）。
     */
    private correspondMaxResample(a: SplatArrays, b: SplatArrays): PairCorrespondence {
        const na = a.count;
        const nb = b.count;
        const outN = Math.max(na, nb);
        if (outN === 0 || na === 0 || nb === 0) {
            return {
                matchedA: new Uint32Array(0),
                matchedB: new Uint32Array(0)
            };
        }

        const matchedA = new Uint32Array(outN);
        const matchedB = new Uint32Array(outN);

        if (na >= nb) {
            for (let i = 0; i < outN; i++) {
                matchedA[i] = i;
                matchedB[i] = nb <= 1 ? 0 : Math.min(Math.floor((i * nb) / na), nb - 1);
            }
        } else {
            for (let i = 0; i < outN; i++) {
                matchedB[i] = i;
                matchedA[i] = na <= 1 ? 0 : Math.min(Math.floor((i * na) / nb), na - 1);
            }
        }

        return { matchedA, matchedB };
    }

    /**
     * 按当前 `correspondMaxResample` 配对表，抽样统计两端中心距（`pair.matchedA[i]` 与 `pair.matchedB[i]`）。
     * mean 很大说明按该映射几何仍差得远；若需与「语义最近邻」对齐，应在外部先做重排序/重采样再喂 morph。
     */
    getIndexPairingDiagnostics(idxA: number, idxB: number, sampleStride: number) {
        const pair = this.correspondences.get(this.pairKey(idxA, idxB));
        if (!pair) {
            return null;
        }

        const a = this.models[idxA].splats;
        const b = this.models[idxB].splats;
        const n = pair.matchedA.length;
        let sum = 0;
        let sumSq = 0;
        let cnt = 0;

        for (let i = 0; i < n; i += sampleStride) {
            const ia = pair.matchedA[i];
            const ib = pair.matchedB[i];
            const dx = a.x[ia] - b.x[ib];
            const dy = a.y[ia] - b.y[ib];
            const dz = a.z[ia] - b.z[ib];
            const d = Math.sqrt(dx * dx + dy * dy + dz * dz);
            sum += d;
            sumSq += d * d;
            cnt++;
        }

        const mean = sum / Math.max(1, cnt);
        const rms = Math.sqrt(sumSq / Math.max(1, cnt));

        return {
            pairCount: n,
            sampleStride,
            samplesUsed: cnt,
            meanCenterDist: mean,
            rmsCenterDist: rms
        };
    }

    interpolateBetween(idxA: number, idxB: number, t: number, output: SplatArrays) {
        if (!(t >= 0 && t <= 1)) {
            throw new Error(`Interpolation t must be in [0, 1], got ${t}`);
        }

        const a = this.models[idxA].splats;
        const b = this.models[idxB].splats;
        const correspondence = this.correspondences.get(this.pairKey(idxA, idxB));

        if (!correspondence) {
            throw new Error(`Failed to build correspondence for pair (${idxA}, ${idxB})`);
        }

        let write = 0;

        for (let i = 0; i < correspondence.matchedA.length; i++, write++) {
            const src = correspondence.matchedA[i];
            const dst = correspondence.matchedB[i];

            output.x[write] = a.x[src] * (1 - t) + b.x[dst] * t;
            output.y[write] = a.y[src] * (1 - t) + b.y[dst] * t;
            output.z[write] = a.z[src] * (1 - t) + b.z[dst] * t;

            output.fdc0[write] = a.fdc0[src] * (1 - t) + b.fdc0[dst] * t;
            output.fdc1[write] = a.fdc1[src] * (1 - t) + b.fdc1[dst] * t;
            output.fdc2[write] = a.fdc2[src] * (1 - t) + b.fdc2[dst] * t;

            output.scale0[write] = a.scale0[src] * (1 - t) + b.scale0[dst] * t;
            output.scale1[write] = a.scale1[src] * (1 - t) + b.scale1[dst] * t;
            output.scale2[write] = a.scale2[src] * (1 - t) + b.scale2[dst] * t;
            output.opacity[write] = a.opacity[src] * (1 - t) + b.opacity[dst] * t;

            const q = slerpQuat(
                a.rot1[src], a.rot2[src], a.rot3[src], a.rot0[src],
                b.rot1[dst], b.rot2[dst], b.rot3[dst], b.rot0[dst],
                t
            );

            output.rot0[write] = q.w;
            output.rot1[write] = q.x;
            output.rot2[write] = q.y;
            output.rot3[write] = q.z;

            for (let restIndex = 0; restIndex < output.rest.length; restIndex++) {
                const av = restIndex < a.rest.length ? a.rest[restIndex][src] : 0;
                const bv = restIndex < b.rest.length ? b.rest[restIndex][dst] : 0;
                output.rest[restIndex][write] = av * (1 - t) + bv * t;
            }
        }

        const fallback = a.count > 0 ? a : b;
        for (; write < output.count; write++) {
            output.x[write] = fallback.count > 0 ? fallback.x[0] : 0;
            output.y[write] = fallback.count > 0 ? fallback.y[0] : 0;
            output.z[write] = fallback.count > 0 ? fallback.z[0] : 0;
            output.fdc0[write] = fallback.count > 0 ? fallback.fdc0[0] : 0;
            output.fdc1[write] = fallback.count > 0 ? fallback.fdc1[0] : 0;
            output.fdc2[write] = fallback.count > 0 ? fallback.fdc2[0] : 0;
            output.rot0[write] = fallback.count > 0 ? fallback.rot0[0] : 1;
            output.rot1[write] = fallback.count > 0 ? fallback.rot1[0] : 0;
            output.rot2[write] = fallback.count > 0 ? fallback.rot2[0] : 0;
            output.rot3[write] = fallback.count > 0 ? fallback.rot3[0] : 0;
            output.scale0[write] = this.fadeLogMin;
            output.scale1[write] = this.fadeLogMin;
            output.scale2[write] = this.fadeLogMin;
            output.opacity[write] = this.fadeLogMin;

            for (let restIndex = 0; restIndex < output.rest.length; restIndex++) {
                output.rest[restIndex][write] = 0;
            }
        }
    }
}

const loadMorphModel = async (
    app: AppBase,
    source: MorphSource,
    index: number,
    options: GsplatMorphOptions
) => {
    const resolved = resolveMorphSource(source, index);
    const asset = new Asset(resolved.filename, 'gsplat', {
        url: resolved.url,
        filename: resolved.filename
    }, {
        reorder: false
    });

    app.assets.add(asset);

    try {
        const loaded = await new Promise<Asset>((resolve, reject) => {
            asset.once('load', () => resolve(asset));
            asset.once('error', (err: unknown) => reject(err));
            app.assets.load(asset);
        });

        const resource = loaded.resource as GSplatResource | null;
        if (!resource) {
            throw new Error(`加载 ${resolved.filename} 失败: resource 为空`);
        }

        const data = resource.gsplatData as GSplatData | undefined;
        if (!data) {
            throw new Error(`加载 ${resolved.filename} 失败: gsplatData 不存在`);
        }

        const splats = readSplatArrays(data);
        preprocessModel(splats, options);

        return {
            name: resolved.filename,
            asset: loaded,
            resource,
            data,
            splats
        } satisfies LoadedMorphModel;
    } finally {
        if (resolved.cleanupUrl) {
            URL.revokeObjectURL(resolved.cleanupUrl);
        }
    }
};

export class GsplatMorphController {
    readonly app: AppBase;

    readonly entity: Entity;

    readonly asset: Asset;

    readonly resource: GSplatResource;

    readonly outputData: GSplatData;

    readonly output: SplatArrays;

    readonly models: LoadedMorphModel[];

    readonly interpolator: GaussianInterpolatorRuntime;

    private readonly _centers: Float32Array;

    private readonly _morphOptions: GsplatMorphOptions;

    /** 在 `application.update` 之前执行，保证本帧 GSplat unified 读到的已是当帧 morph 数据。 */
    private readonly _onFrameUpdate: (ms: number) => void;

    /**
     * Viewer 在 `framerender` 里若 `!readyToRender` 会把 `renderNextFrame` 清掉；
     * morph 在更早的 `frameupdate` 里设的真值会被覆盖。本回调挂在 Viewer 之后执行，在判定需要时再拉高。
     */
    private readonly _onAfterFrameRender: () => void;

    /**
     * Unified GSplat 排序在 Worker 里异步完成，新顺序可能在当前帧 `render()` 之后才落到 mesh；
     * `autoRender=false` 时须再请求一帧才能把排序结果画到画布（否则往往要靠拖相机「碰」出 `renderNextFrame`）。
     */
    private readonly _onGsplatSorted: () => void;

    /** 暂停时单次 seek/stop 等仍会 push，需要至少呈现一帧。 */
    private _needsPresentFrame = false;

    /** `continuousAppRender` 生效时暂存的 Viewer 关闭前的 `app.autoRender`。 */
    private _savedAppAutoRender: boolean | undefined;

    private _autoRenderOverridden = false;

    private _segmentDuration: number;

    private _loop: boolean;

    private _playing: boolean;

    private _time = 0;

    constructor(app: AppBase, models: LoadedMorphModel[], options: GsplatMorphOptions = {}) {
        this._morphOptions = options;
        this.app = app;
        this.models = models;
        this.interpolator = new GaussianInterpolatorRuntime(models, options.fadeLogMin ?? DEFAULT_FADE_LOG_MIN);

        // 构建输出缓冲区
        const maxSplats = Math.max(...models.map(model => model.splats.count));
        const restPropCount = normalizeRestPropCount(Math.max(...models.map(model => model.splats.rest.length)));
        const { data, arrays } = createMutableGSplatData(maxSplats, restPropCount);

        this.outputData = data;
        this.output = arrays;
        // 用这块数据创建可被 gsplat 组件使用的资源。
        this.resource = new GSplatResource(app.graphicsDevice, this.outputData);
        this._centers = this.resource.centers ?? new Float32Array(maxSplats * 3);
        this.resource.centers = this._centers;

        this.asset = new Asset(options.entityName || 'gsplatMorphAsset', 'gsplat', {
            url: `gsplat-morph://${Date.now()}`,
            filename: `${options.entityName || 'gsplatMorph'}.ply`
        });
        this.asset.resource = this.resource;
        this.asset.loaded = true;
        app.assets.add(this.asset);
        this.asset.fire('load', this.asset);

        this.entity = new Entity(options.entityName || 'gsplatMorph');
        this.entity.setLocalEulerAngles(0, 0, 180);
        this.entity.addComponent('gsplat', {
            unified: options.unified ?? true,
            asset: this.asset,
            layers: options.layers
        } as any);
        app.root.addChild(this.entity);

        this._segmentDuration = Math.max(0.001, options.segmentDuration ?? DEFAULT_SEGMENT_DURATION);
        this._loop = options.loop ?? true;
        this._playing = options.autoPlay ?? true;
        this._onFrameUpdate = (ms: number) => {
            let dt = ms / 1000;
            dt = clamp(dt, 0, this.app.maxDeltaTime);
            dt *= this.app.timeScale;
            this.update(dt);
        };
        this._onAfterFrameRender = () => {
            if (this.segmentCount === 0) {
                return;
            }
            this.requestMorphPresentFrame();
            this._needsPresentFrame = false;
        };

        this._onGsplatSorted = () => {
            this.requestMorphPresentFrame();
        };

        this.applyCurrentFrame();
        app.on('frameupdate', this._onFrameUpdate);
        app.on('framerender', this._onAfterFrameRender);
        app.scene.on('gsplat:sorted', this._onGsplatSorted);
        this.syncMorphDrivenAppRender();
    }

    get segmentDuration() {
        return this._segmentDuration;
    }

    set segmentDuration(value: number) {
        this._segmentDuration = Math.max(0.001, value);
        this.applyCurrentFrame();
    }

    get loop() {
        return this._loop;
    }

    set loop(value: boolean) {
        this._loop = value;
    }

    get playing() {
        return this._playing;
    }

    get modelCount() {
        return this.models.length;
    }

    get segmentCount() {
        return Math.max(0, this.modelCount - 1);
    }

    get totalDuration() {
        return this.segmentCount * this._segmentDuration;
    }

    get interpolationValue() {
        if (this.modelCount === 0) {
            return 1;
        }

        if (this.segmentCount === 0) {
            return 1;
        }

        if (!this._loop && this._time >= this.totalDuration) {
            return this.modelCount;
        }

        const clampedTime = this.resolvePlaybackTime();

        return clampedTime / this._segmentDuration + 1;
    }

    set interpolationValue(value: number) {
        if (this.segmentCount === 0) {
            this._time = 0;
            this.applyCurrentFrame();
            return;
        }

        const clampedValue = clamp(value, 1, this.modelCount);
        this._time = clampedValue >= this.modelCount
            ? this.totalDuration
            : (clampedValue - 1) * this._segmentDuration;
        this.applyCurrentFrame();
    }

    play() {
        this._playing = true;
        this.syncMorphDrivenAppRender();
        return this;
    }

    pause() {
        this._playing = false;
        this.syncMorphDrivenAppRender();
        return this;
    }

    stop() {
        this._playing = false;
        this._time = 0;
        this.applyCurrentFrame();
        this.syncMorphDrivenAppRender();
        return this;
    }

    seek(timeSeconds: number) {
        this._time = Math.max(0, timeSeconds);
        this.applyCurrentFrame();
        return this;
    }

    /**
     * 打印某一段在当前 `correspondMaxResample` 映射下的中心距抽样统计。
     * 若 Web 观感与离线工具不一致，可对比预处理（recenter/normalize）、配对策略以及 PlayCanvas 渲染（SH 打包、half 精度等）。
     */
    logMorphDiagnostics(segmentIndex = 0, sampleStride = 32) {
        const idxB = segmentIndex + 1;
        if (idxB >= this.modelCount) {
            console.warn('[GsplatMorph] logMorphDiagnostics: segmentIndex 越界');
            return;
        }

        const stats = this.interpolator.getIndexPairingDiagnostics(segmentIndex, idxB, sampleStride);
        if (!stats) {
            console.warn('[GsplatMorph] logMorphDiagnostics: 无配对数据');
            return;
        }

        console.log('[GsplatMorph] index-pairing stats', stats);
        console.log(
            '[GsplatMorph] 插值规则：`max(|A|,|B|)` 条输出；多的一侧连续下标，少的一侧 `floor(i*small/large)` 多对一；' +
            '每条均为两侧全属性 lerp + 四元数 slerp，无 fade。与旧版 min+leftover 的 Python 若要对齐，需改 Python 配对策略。'
        );
    }

    destroy() {
        this.disarmAppAutoRenderOverride();
        this.app.off('frameupdate', this._onFrameUpdate);
        this.app.off('framerender', this._onAfterFrameRender);
        this.app.scene.off('gsplat:sorted', this._onGsplatSorted);
        this.entity.destroy();

        this.asset.unload();
        this.app.assets.remove(this.asset);

        this.models.forEach((model) => {
            model.asset.unload();
            this.app.assets.remove(model.asset);
        });
    }

    update(dt: number) {
        if (!this._playing || this.segmentCount === 0 || !Number.isFinite(dt) || dt <= 0) {
            return;
        }

        const totalDuration = this.totalDuration;
        if (this._loop) {
            const cycleDuration = totalDuration * 2;
            this._time = cycleDuration > 0 ? (this._time + dt) % cycleDuration : 0;
            this.applyCurrentFrame();
            return;
        }

        this._time = Math.min(this._time + dt, totalDuration);
        this.applyCurrentFrame();

        if (this._time >= totalDuration) {
            this._playing = false;
            this.syncMorphDrivenAppRender();
        }
    }
    // 立刻根据当前 _time 算一帧并推到 GPU。
    private applyCurrentFrame() {
        if (this.segmentCount === 0) {
            return;
        }

        const totalDuration = this.totalDuration;
        if (!this._loop && this._time >= totalDuration) {
            this.applyPair(this.segmentCount - 1, 1);
            return;
        }

        const clampedTime = this.resolvePlaybackTime();

        const segmentIndex = Math.min(
            this.segmentCount - 1,
            Math.floor(clampedTime / this._segmentDuration)
        );
        const segmentStart = segmentIndex * this._segmentDuration;
        const localT = clamp((clampedTime - segmentStart) / this._segmentDuration, 0, 1);

        this.applyPair(segmentIndex, localT);
    }

    private resolvePlaybackTime() {
        const totalDuration = this.totalDuration;
        if (!this._loop || totalDuration <= 0) {
            return clamp(this._time, 0, totalDuration);
        }

        const cycleDuration = totalDuration * 2;
        const wrappedTime = ((this._time % cycleDuration) + cycleDuration) % cycleDuration;
        return wrappedTime <= totalDuration
            ? wrappedTime
            : cycleDuration - wrappedTime;
    }

    private applyPair(pairIndex: number, t: number) {
        this.interpolator.interpolateBetween(pairIndex, pairIndex + 1, t, this.output);
        this.pushOutputToResource();
    }

    private pushOutputToResource() {
        this.resource.updateColorData(this.outputData);
        this.resource.updateTransformData(this.outputData);

        if (this.output.rest.length > 0) {
            this.resource.updateSHData(this.outputData);
        }

        for (let i = 0; i < this.output.count; i++) {
            const base = i * 3;
            this._centers[base] = this.output.x[i];
            this._centers[base + 1] = this.output.y[i];
            this._centers[base + 2] = this.output.z[i];
        }

        this.resource.centersVersion++;
        this.outputData.calcAabb(this.resource.aabb);
        this.resource.mesh?.aabb.copy(this.resource.aabb);

        // unified gsplat：仅改 resource 纹理时 entity 矩阵未变，AUTO 不会重刷 work buffer。
        // morph 在 `frameupdate` 写数据（早于本帧 `systems.fire('update')`），此处标 ONCE 让本帧 GSplat 刷新 work buffer。
        const gsplat = this.entity.gsplat;
        if (gsplat) {
            gsplat.workBufferUpdate = this._playing ? WORKBUFFER_UPDATE_ALWAYS : WORKBUFFER_UPDATE_ONCE;        }

        // supersplat-viewer：`autoRender=false` 时 Viewer 可能在 `framerender` 清掉 `renderNextFrame`；
        // 连续渲染模式下由 `app.autoRender` 负责每帧 render，此处不必重复拉高。
        this.app.renderNextFrame = true;
    }

    /**
     * 在「非每帧 autoRender」路径下请求下一帧绘制（含 Viewer 清掉 renderNextFrame 后的再拉高，以及 Worker 排序晚到后的补帧）。
     */
    private requestMorphPresentFrame() {
        if (this._playing || this._needsPresentFrame) {
            this.app.renderNextFrame = true;
        }
    }

    /**
     * `continuousAppRender` 打开且正在播放时，临时把 `app.autoRender` 拉高，避免仅依赖 `renderNextFrame`
     * 时被 Viewer 的 `framerender` 链或异步排序「夹掉」一整段连续刷新。
     */
    private syncMorphDrivenAppRender() {
        const wantOverride =
            (this._morphOptions.continuousAppRender ?? true) &&
            this._playing &&
            this.segmentCount > 0;

        if (wantOverride && !this._autoRenderOverridden) {
            this._savedAppAutoRender = this.app.autoRender;
            this.app.autoRender = true;
            this._autoRenderOverridden = true;
            return;
        }

        if (!wantOverride && this._autoRenderOverridden) {
            this.disarmAppAutoRenderOverride();
        }
    }

    private disarmAppAutoRenderOverride() {
        if (!this._autoRenderOverridden) {
            return;
        }
        if (this._savedAppAutoRender !== undefined) {
            this.app.autoRender = this._savedAppAutoRender;
        }
        this._savedAppAutoRender = undefined;
        this._autoRenderOverridden = false;
    }
}

export const loadGsplatMorphSequence = async (
    app: AppBase,
    sources: MorphSource[],
    options: GsplatMorphOptions = {}
) => {
    const clippedSources = sources.slice(0, MAX_MORPH_MODELS);
    if (sources.length > MAX_MORPH_MODELS) {
        console.warn(`[GsplatMorph] 只支持最多 ${MAX_MORPH_MODELS} 个模型，已截断为前 ${MAX_MORPH_MODELS} 个。`);
    }

    if (clippedSources.length < 2) {
        throw new Error('Gsplat morph 至少需要 2 个 PLY 文件。');
    }

    const models = await Promise.all(
        clippedSources.map((source, index) => loadMorphModel(app, source, index, options))
    );

    return new GsplatMorphController(app, models, options);
};
