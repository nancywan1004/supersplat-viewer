import {
    Color,
    Entity,
    Layer,
    Mesh,
    MeshInstance,
    PRIMITIVE_LINES,
    StandardMaterial,
    TEXTUREPROJECTION_CUBE,
    Vec3
} from 'playcanvas';
import type { GraphicsDevice } from 'playcanvas';
import type { Global } from './types';
import type { DirectionalLightConfig, SpotLightConfig } from './schemas/v2';

const MAX_POINT_LIGHTS = 10;
const MAX_SPOT_LIGHTS = 10;
// 光源可视化与真实 range 1:1 对齐（不再做额外视觉缩放）
const LIGHT_VISUAL_SCALE = 1;
// 实验性收紧真实聚光照明锥角，让主亮区更容易主观收敛到可视锥体内。
// 仅影响实际 light / gsplat 打光，不改 settings 与 gizmo 展示。
const EFFECTIVE_SPOT_CONE_ANGLE_SCALE = 0.5;

/** 点光中心 / 聚光锥尖：小拾取球线框半径（世界单位） */
const LIGHT_PICK_HANDLE_VISUAL_RADIUS = 0.24;
/** 世界空间点击判定略大于视觉球，便于边缘命中 */
const LIGHT_PICK_HANDLE_WORLD_HIT_RADIUS = 0.42;
/** 屏幕空间兜底：投影点半径（像素），点光与聚光统一 */
const LIGHT_PICK_HANDLE_SCREEN_PX = 36;

const isDirectionalLightConfig = (cfg: any): cfg is DirectionalLightConfig =>
    cfg && cfg.type === 'directional';

const isSpotLightConfig = (cfg: any): cfg is SpotLightConfig =>
    cfg && cfg.type === 'spot';

/** 平行光实体默认位置（用于主方向光） */
const DIRECTIONAL_DEFAULT_POSITION: [number, number, number] = [0, 8, 8];

/**
 * 同步 Light 颜色到引擎内部（clustered / 标准 mesh 光照读 scene Light 的 _colorLinear）。
 * 仅调用 LightComponent.color.set 不会触发 light.setColor，mesh 侧光色会停留在初值；gsplat/NightMode 若从 settings 另读颜色则会表现为「splat 有色、mesh 无色」。
 */
function applyLightColorRgb(lightComp: NonNullable<Entity['light']>, r: number, g: number, b: number): void {
    lightComp.color.set(r, g, b);
    lightComp.light.setColor(r, g, b);
}

function getEffectiveSpotConeAngles(innerConeDeg: number, outerConeDeg: number) {
    const safeOuterDeg = Math.max(0, Math.min(89.9, Number.isFinite(outerConeDeg) ? outerConeDeg : 45));
    const safeInnerDeg = Math.max(0, Math.min(safeOuterDeg, Number.isFinite(innerConeDeg) ? innerConeDeg : 25));
    const effectiveOuterDeg = Math.max(0.01, safeOuterDeg * EFFECTIVE_SPOT_CONE_ANGLE_SCALE);
    const effectiveInnerDeg = Math.min(effectiveOuterDeg, safeInnerDeg * EFFECTIVE_SPOT_CONE_ANGLE_SCALE);
    return {
        effectiveInnerDeg,
        effectiveOuterDeg
    };
}

// ─── 线框 Mesh 工厂 & 材质 ───────────────────────────────────────────

const ensureLightVisualLayer = (app: any): number => {
    if (app.__lightVisualLayerId != null) return app.__lightVisualLayerId as number;

    const layers = app.scene.layers;
    let layer = layers.getLayerByName('LightVisual');
    if (!layer) {
        layer = new Layer({ name: 'LightVisual' });
        // 放到最后渲染，避免与 gsplat/透明队列排序互相影响
        layers.push(layer);
    }
    app.__lightVisualLayerId = layer.id;

    // 确保主相机渲染该 layer
    const camEntity = app.root.findComponent('camera')?.entity as Entity | undefined;
    const cam = camEntity?.camera;
    if (cam && cam.layers.indexOf(layer.id) < 0) {
        cam.layers = [...cam.layers, layer.id];
    }

    return layer.id;
};

/**
 * 创建球体线框 Mesh：3 个正交单位圆环（XY / XZ / YZ 平面），半径 = 1。
 * 使用时通过 entity.setLocalScale(range, range, range) 映射到实际 range。
 */
const createSphereWireframeMesh = (device: GraphicsDevice, segments = 64): Mesh => {
    const totalVerts = 3 * segments;
    const totalIndices = 3 * 2 * segments;
    const positions = new Float32Array(totalVerts * 3);
    const indices = new Uint16Array(totalIndices);

    let vi = 0; // vertex write cursor
    let ii = 0; // index write cursor
    const step = (2 * Math.PI) / segments;

    const writeCircle = (ax1: 0 | 1 | 2, ax2: 0 | 1 | 2, ax3: 0 | 1 | 2) => {
        const base = vi / 3;
        for (let s = 0; s < segments; s++) {
            const angle = s * step;
            const p = [0, 0, 0];
            p[ax1] = Math.cos(angle);
            p[ax2] = Math.sin(angle);
            p[ax3] = 0;
            positions[vi++] = p[0];
            positions[vi++] = p[1];
            positions[vi++] = p[2];
            indices[ii++] = base + s;
            indices[ii++] = base + ((s + 1) % segments);
        }
    };

    writeCircle(0, 1, 2); // XY plane
    writeCircle(0, 2, 1); // XZ plane
    writeCircle(1, 2, 0); // YZ plane

    const mesh = new Mesh(device);
    mesh.setPositions(Array.from(positions));
    mesh.setIndices(Array.from(indices));
    mesh.update(PRIMITIVE_LINES);
    return mesh;
};

/**
 * 创建锥体线框 Mesh：锥尖 (0,0,0)，底面圆心 (0,-1,0)，底面半径 = 1。
 * 使用时通过 setLocalScale(outerRadius, range, outerRadius) 映射到实际尺寸。
 */
const createConeWireframeMesh = (device: GraphicsDevice, segments = 64, edges = 4): Mesh => {
    const baseVerts = segments;
    const tipVert = 1;
    const totalVerts = baseVerts + tipVert;
    const baseLineIndices = segments * 2;
    const edgeLineIndices = edges * 2;
    const totalIndices = baseLineIndices + edgeLineIndices;

    const positions = new Float32Array(totalVerts * 3);
    const indices = new Uint16Array(totalIndices);

    let vi = 0;
    let ii = 0;
    const step = (2 * Math.PI) / segments;

    // 底面圆顶点 (y = -1)
    for (let s = 0; s < segments; s++) {
        const angle = s * step;
        positions[vi++] = Math.cos(angle); // x
        positions[vi++] = -1;              // y
        positions[vi++] = Math.sin(angle); // z
    }

    // 锥尖顶点
    const tipIndex = segments;
    positions[vi++] = 0;
    positions[vi++] = 0;
    positions[vi++] = 0;

    // 底面圆线段
    for (let s = 0; s < segments; s++) {
        indices[ii++] = s;
        indices[ii++] = (s + 1) % segments;
    }

    // 边缘线：从锥尖到底面均匀分布的点
    const edgeStep = Math.floor(segments / edges);
    for (let e = 0; e < edges; e++) {
        indices[ii++] = tipIndex;
        indices[ii++] = e * edgeStep;
    }

    const mesh = new Mesh(device);
    mesh.setPositions(Array.from(positions));
    mesh.setIndices(Array.from(indices));
    mesh.update(PRIMITIVE_LINES);
    return mesh;
};

/**
 * 创建单位圆环 Mesh：位于 y = -1 平面，半径 = 1，用于在锥体底面上表示 innerAngle。
 */
const createCircleWireframeMesh = (device: GraphicsDevice, segments = 64): Mesh => {
    const positions = new Float32Array(segments * 3);
    const indices = new Uint16Array(segments * 2);

    let vi = 0;
    let ii = 0;
    const step = (2 * Math.PI) / segments;

    for (let s = 0; s < segments; s++) {
        const angle = s * step;
        positions[vi++] = Math.cos(angle); // x
        positions[vi++] = -1;             // y
        positions[vi++] = Math.sin(angle); // z

        indices[ii++] = s;
        indices[ii++] = (s + 1) % segments;
    }

    const mesh = new Mesh(device);
    mesh.setPositions(Array.from(positions));
    mesh.setIndices(Array.from(indices));
    mesh.update(PRIMITIVE_LINES);
    return mesh;
};

/**
 * 创建单位圆盘调试网格：位于 y = -1 平面，半径 = 1。
 * 用多圈圆环 + 辐射线强调“聚光灯底面截面”所在平面，便于和真实受光足迹对照。
 */
const createDiscWireMesh = (device: GraphicsDevice, segments = 64, rings = 4, spokes = 8): Mesh => {
    const positions: number[] = [];
    const indices: number[] = [];

    const pushLine = (ax: number, az: number, bx: number, bz: number) => {
        const base = positions.length / 3;
        positions.push(ax, -1, az, bx, -1, bz);
        indices.push(base, base + 1);
    };

    for (let ring = 1; ring <= rings; ring++) {
        const radius = ring / rings;
        for (let s = 0; s < segments; s++) {
            const angle0 = (s / segments) * Math.PI * 2;
            const angle1 = ((s + 1) / segments) * Math.PI * 2;
            pushLine(
                Math.cos(angle0) * radius,
                Math.sin(angle0) * radius,
                Math.cos(angle1) * radius,
                Math.sin(angle1) * radius
            );
        }
    }

    for (let spoke = 0; spoke < spokes; spoke++) {
        const angle = (spoke / spokes) * Math.PI * 2;
        pushLine(0, 0, Math.cos(angle), Math.sin(angle));
    }

    const mesh = new Mesh(device);
    mesh.setPositions(positions);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_LINES);
    return mesh;
};

/**
 * 创建白色线框材质，用于光源可视化 gizmo。
 * emissive 纯白保证颜色恒定；depthWrite=false 避免遮挡场景；depthTest=true 保持正确遮挡关系。
 */
const createWireframeMaterial = (): StandardMaterial => {
    const mat = new StandardMaterial();
    mat.diffuse.set(0, 0, 0);
    mat.emissive.set(1, 1, 1);
    mat.emissiveIntensity = 1;
    mat.depthWrite = false;
    // 与 gsplat（半透明/自定义 pass）混合时，depthTest 可能导致线框“时隐时现”
    mat.depthTest = false;
    mat.useLighting = false;
    mat.update();
    return mat;
};

/** 拾取小球线框材质，与 range 大线框区分 */
const createPickHandleWireMaterial = (): StandardMaterial => {
    const mat = new StandardMaterial();
    mat.diffuse.set(0, 0, 0);
    mat.emissive.set(0.35, 0.95, 1);
    mat.emissiveIntensity = 1;
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.useLighting = false;
    mat.update();
    return mat;
};

const ensureLightPickHandleWireMesh = (app: any): Mesh => {
    const cached = app.__lightPickHandleWireMesh as Mesh | undefined;
    if (cached) return cached;
    const mesh = createSphereWireframeMesh(app.graphicsDevice, 40);
    app.__lightPickHandleWireMesh = mesh;
    return mesh;
};

/**
 * 在点光/聚光实体原点挂一个小球线框，表示「锥尖 / 灯心」拾取触发区（与 setPointLightsVisualVisible 联动显隐）。
 */
const ensureLightPickHandle = (global: Global, hostEntity: Entity): void => {
    if ((hostEntity as any).__lightPickHandleEntity) return;
    const app = global.app;
    const layerId = ensureLightVisualLayer(app);
    const mesh = ensureLightPickHandleWireMesh(app);
    const material = createPickHandleWireMaterial();
    const handle = new Entity('light_pick_handle');
    handle.addComponent('render', {
        type: 'asset',
        layers: [layerId],
        meshInstances: [new MeshInstance(mesh, material)]
    });
    const rc = handle.render;
    if (rc) {
        rc.castShadows = false;
        rc.receiveShadows = false;
        rc.enabled = !!(app as any).__pointLightsVisualVisible;
    }
    const r = Math.max(0.05, LIGHT_PICK_HANDLE_VISUAL_RADIUS);
    handle.setLocalScale(r, r, r);
    hostEntity.addChild(handle);
    (hostEntity as any).__lightPickHandleEntity = handle;
};

/**
 * 创建用于聚光灯底面验证的调试圆盘材质。
 */
const createDebugDiscMaterial = (): StandardMaterial => {
    const mat = new StandardMaterial();
    mat.diffuse.set(0, 0, 0);
    mat.emissive.set(0.2, 1.0, 0.55);
    mat.emissiveIntensity = 1;
    mat.depthWrite = false;
    mat.depthTest = false;
    mat.opacity = 0.85;
    mat.useLighting = false;
    mat.update();
    return mat;
};

// ─────────────────────────────────────────────────────────────────────

export type PointLightInfo = {
    position: Vec3;
    color: Color;
    intensity: number;
    range: number;
};

export type SpotLightInfo = {
    position: Vec3;
    direction: Vec3;  // 归一化，照射方向（与引擎一致：实体 -Y 轴）
    color: Color;
    intensity: number;
    innerConeAngle: number;  // 弧度
    outerConeAngle: number;  // 弧度
    range: number;
};

/**
 * 从场景中收集点光源信息（Light 组件 type === 'point'），上限 10 个。
 * 无额外点光源时返回空数组。
 */
const collectPointLights = (global: Global): PointLightInfo[] => {
    const { app } = global;
    const result: PointLightInfo[] = [];
    const visit = (e: Entity) => {
        if (result.length >= MAX_POINT_LIGHTS) return;
        if (e.light && (e.light as any).type === 'point' && e.light.enabled) {
            const pos = e.getPosition();
            result.push({
                position: new Vec3(pos.x, pos.y, pos.z),
                color: new Color(e.light.color.r, e.light.color.g, e.light.color.b),
                intensity: e.light.intensity ?? 1,
                range: (e.light as any).range ?? 1
            });
        }
        e.children.forEach(visit);
    };
    app.root.children.forEach(visit);
    return result;
};

/**
 * 从场景中收集聚光灯信息（spotLights 容器下 type === 'spot' 的实体），上限 10 个。
 * 供 night-mode 等 shader 对高斯施加聚光照明。
 */
/**
 * 聚光方向须与引擎一致：PlayCanvas 聚光沿实体 -Y 轴照射（forward-renderer 用 getY().mulScalar(-1)），
 * 此处也用 -Y，这样高斯与 mesh 的锥体方向一致。
 */
const collectSpotLights = (global: Global): SpotLightInfo[] => {
    const { app } = global;
    const result: SpotLightInfo[] = [];
    const container = app.root.findByName('spotLights') as Entity | null;
    if (!container) return result;
    const yAxis = new Vec3();
    for (let i = 0; i < container.children.length && result.length < MAX_SPOT_LIGHTS; i++) {
        const e = container.children[i] as Entity;
        if (!e.name.startsWith('spotLight_') || e.name === 'spotLight_visual') continue;
        if (!e.light || (e.light as any).type !== 'spot' || !e.light.enabled) continue;
        const position = e.getPosition().clone();
        e.getWorldTransform().getY(yAxis);
        const direction = new Vec3(-yAxis.x, -yAxis.y, -yAxis.z).normalize();
        let innerRad = ((e.light as any).innerConeAngle ?? 25) * (Math.PI / 180);
        let outerRad = ((e.light as any).outerConeAngle ?? 45) * (Math.PI / 180);
        if (innerRad > outerRad) {
            [innerRad, outerRad] = [outerRad, innerRad];
        }
        const range = (e.light as any).range ?? 1;
        result.push({
            position,
            direction,
            color: new Color(e.light.color.r, e.light.color.g, e.light.color.b),
            intensity: e.light.intensity ?? 1,
            innerConeAngle: innerRad,
            outerConeAngle: outerRad,
            range
        });
    }
    return result;
};

/**
 * 为点光源实体添加场景内可视化线框球（子实体）。
 * 使用 PRIMITIVE_LINES 绘制 3 个正交圆环，后续通过 range 缩放体现影响范围。
 * @param global - Global，用于读取 app 与 state（后续可在此挂接 pointer 事件）
 */
const addLightVisual = (global: Global, lightEntity: Entity, r: number, g: number, b: number): void => {
    const app = global.app;
    const device = app.graphicsDevice;
    const layerId = ensureLightVisualLayer(app);

    const mesh = createSphereWireframeMesh(device);
    const material = createWireframeMaterial();
    const visual = new Entity('pointLight_visual');

    visual.addComponent('render', {
        type: 'asset',
        layers: [layerId],
        meshInstances: [new MeshInstance(mesh, material)]
    });

    // 初始为单位半径，具体范围由 updatePointLightRangeVisual 控制
    visual.setLocalScale(1, 1, 1);
    const rc = visual.render;
    if (rc) {
        rc.castShadows = false;
        rc.receiveShadows = false;
        rc.enabled = !!(app as any).__pointLightsVisualVisible;
    }
    lightEntity.addChild(visual);
    (lightEntity as any).__lightVisualEntity = visual;
    (lightEntity as any).__lightRangeWireframe = visual;
};

/**
 * 根据点光源的 range 更新线框球的缩放，单位球半径为 1。
 */
const updatePointLightRangeVisual = (lightEntity: Entity, range: number): void => {
    const visual = (lightEntity as any).__lightRangeWireframe as Entity | undefined;
    if (!visual) return;
    const r = Math.max(0.01, Number.isFinite(range) ? range : 1);
    const s = r * LIGHT_VISUAL_SCALE;
    visual.setLocalScale(s, s, s);
};

/**
 * 为聚光灯实体添加锥体可视化。锥尖指向照射方向（实体 -Y，与引擎与 collectSpotLights 一致），
 * 与「Show lights in scene」联动。几何本身不携带业务含义，具体形状由 createSpotLightsFromSettings 按
 * range / outerConeAngle 进行缩放。
 */
const addSpotLightVisual = (global: Global, spotEntity: Entity, r: number, g: number, b: number): void => {
    const app = global.app;
    const device = app.graphicsDevice;
    const layerId = ensureLightVisualLayer(app);
    let visual = spotEntity.findByName('spotLight_visual') as Entity | null;
    if (visual) return;
    const mesh = createConeWireframeMesh(device);
    const innerMesh = createCircleWireframeMesh(device);
    const discMesh = createDiscWireMesh(device);
    const material = createWireframeMaterial();
    const discMaterial = createDebugDiscMaterial();
    visual = new Entity('spotLight_visual');
    visual.addComponent('render', {
        type: 'asset',
        layers: [layerId],
        meshInstances: [new MeshInstance(mesh, material)]
    });
    const rc = visual.render;
    if (rc) {
        rc.castShadows = false;
        rc.receiveShadows = false;
        rc.enabled = !!(app as any).__pointLightsVisualVisible;
    }
    // 初始局部变换留给 createSpotLightsFromSettings 计算
    visual.setLocalPosition(0, 0, 0);
    visual.setLocalEulerAngles(0, 0, 0);
    visual.setLocalScale(1, 1, 1);
    spotEntity.addChild(visual);
    (spotEntity as any).__spotVisualEntity = visual;

    // 内圈：用于可视化 innerConeAngle，对应锥体底面上的内圆
    const innerRing = new Entity('spotLight_innerRing');
    innerRing.addComponent('render', {
        type: 'asset',
        layers: [layerId],
        meshInstances: [new MeshInstance(innerMesh, material)]
    });
    const innerRc = innerRing.render;
    if (innerRc) {
        innerRc.castShadows = false;
        innerRc.receiveShadows = false;
        innerRc.enabled = !!(app as any).__pointLightsVisualVisible;
    }
    innerRing.setLocalPosition(0, 0, 0);
    innerRing.setLocalEulerAngles(0, 0, 0);
    innerRing.setLocalScale(1, 1, 1);
    spotEntity.addChild(innerRing);
    (spotEntity as any).__spotInnerRingEntity = innerRing;

    // const debugDisc = new Entity('spotLight_debugDisc');
    // debugDisc.addComponent('render', {
    //     type: 'asset',
    //     layers: [layerId],
    //     meshInstances: [new MeshInstance(discMesh, discMaterial)]
    // });
    // const discRc = debugDisc.render;
    // if (discRc) {
    //     discRc.castShadows = false;
    //     discRc.receiveShadows = false;
    //     discRc.enabled = !!(app as any).__pointLightsVisualVisible;
    // }
    // debugDisc.setLocalPosition(0, 0, 0);
    // debugDisc.setLocalEulerAngles(0, 0, 0);
    // debugDisc.setLocalScale(1, 1, 1);
    // spotEntity.addChild(debugDisc);
    // (spotEntity as any).__spotDebugDiscEntity = debugDisc;
};

/**
 * 根据聚光灯的 range / outerConeAngle 更新可视化锥体的形状（仅用于编辑时的 gizmo）
 */
const updateSpotGizmoShape = (spotEntity: Entity, range: number, outerConeAngleDeg: number): void => {
    const visual = (spotEntity as any).__spotVisualEntity as Entity | undefined;
    const innerRing = (spotEntity as any).__spotInnerRingEntity as Entity | undefined;
    const debugDisc = (spotEntity as any).__spotDebugDiscEntity as Entity | undefined;
    if (!visual) return;
    const r = Math.max(0.1, Number.isFinite(range) ? range : 1);
    const outerDeg = Math.max(0, Math.min(180, Number.isFinite(outerConeAngleDeg) ? outerConeAngleDeg : 45));
    const outerRad = outerDeg * Math.PI / 180;
    const outerRadius = r * Math.tan(outerRad * 0.5);
    // 单位锥体：锥尖(0,0,0) → 底面y=-1，底面半径=1
    visual.setLocalPosition(0, 0, 0);
    visual.setLocalScale(
        Math.max(outerRadius * LIGHT_VISUAL_SCALE, 0.01),
        r * LIGHT_VISUAL_SCALE,
        Math.max(outerRadius * LIGHT_VISUAL_SCALE, 0.01)
    );
    if (debugDisc) {
        debugDisc.setLocalPosition(0, 0, 0);
        debugDisc.setLocalScale(
            Math.max(outerRadius * LIGHT_VISUAL_SCALE, 0.01),
            r * LIGHT_VISUAL_SCALE,
            Math.max(outerRadius * LIGHT_VISUAL_SCALE, 0.01)
        );
    }

    // 内圈半径来源：light.innerConeAngle，若无则退化为 outerAngle
    if (innerRing) {
        const lightAny = spotEntity.light as any | undefined;
        let innerDeg = typeof lightAny?.innerConeAngle === 'number' ? lightAny.innerConeAngle : outerDeg;
        innerDeg = Math.max(0, Math.min(innerDeg, outerDeg));
        const innerRad = innerDeg * Math.PI / 180;
        const innerRadius = r * Math.tan(innerRad * 0.5);
        innerRing.setLocalPosition(0, 0, 0);
        innerRing.setLocalScale(
            Math.max(innerRadius * LIGHT_VISUAL_SCALE, 0.01),
            r * LIGHT_VISUAL_SCALE,
            Math.max(innerRadius * LIGHT_VISUAL_SCALE, 0.01)
        );
    }
};

/**
 * 从 settings.lighting.lights 应用平行光到主方向光实体（name='light'）。
 * 若有 type==='directional' 的项则用其配置；否则用默认值。
 */
const applyDirectionalLightFromSettings = (global: Global): void => {
    const { app, settings } = global;
    const configs = settings.lighting?.lights;
    let cfg = configs && Array.isArray(configs) ? configs.find(isDirectionalLightConfig) : undefined;
    const shadow = (settings as any).postEffectSettings?.shadow;
    if (!cfg && shadow && (typeof shadow.lightPitch === 'number' || typeof shadow.lightYaw === 'number')) {
        cfg = {
            type: 'directional',
            position: DIRECTIONAL_DEFAULT_POSITION,
            color: [1, 1, 1],
            intensity: 1.5,
            pitch: typeof shadow.lightPitch === 'number' ? shadow.lightPitch : 35,
            yaw: typeof shadow.lightYaw === 'number' ? shadow.lightYaw : 45,
            shadowBias: typeof shadow.shadowBias === 'number' ? shadow.shadowBias : 0.05,
            enabled: true
        };
    }

    let lightEntity = app.root.findByName('light') as Entity | null;
    if (!lightEntity) {
        lightEntity = new Entity('light');
        lightEntity.addComponent('light', {
            type: 'directional',
            color: new Color(1, 1, 1),
            intensity: 1.5,
            castShadows: true,
            shadowBias: 0.05,
            normalOffsetBias: 0.05
        });
        lightEntity.tags.add('light');
        app.root.addChild(lightEntity);
    }
    if (!lightEntity.light) {
        lightEntity.addComponent('light', {
            type: 'directional',
            color: new Color(1, 1, 1),
            intensity: 1.5,
            castShadows: true,
            shadowBias: 0.05,
            normalOffsetBias: 0.05
        });
    }

    const pitch = cfg?.pitch ?? 35;
    const yaw = cfg?.yaw ?? 45;
    const pos = cfg?.position ?? DIRECTIONAL_DEFAULT_POSITION;
    const [r, g, b] = cfg?.color ?? [1, 1, 1];
    const intensity = typeof cfg?.intensity === 'number' ? cfg.intensity : 1.5;
    const shadowBias = typeof cfg?.shadowBias === 'number' ? cfg.shadowBias : 0.05;
    const enabled = cfg?.enabled !== false;
    // 平行光是否投射阴影由 postEffectSettings.shadow.enabled 统一控制
    const castShadows = (settings as any).postEffectSettings?.shadow?.enabled === true;

    lightEntity.setPosition(pos[0], pos[1], pos[2]);
    lightEntity.setEulerAngles(pitch, yaw, 0);
    if (lightEntity.light) {
        lightEntity.light.enabled = enabled;
        applyLightColorRgb(lightEntity.light, r, g, b);
        lightEntity.light.intensity = intensity;
        lightEntity.light.castShadows = castShadows;
        lightEntity.light.shadowBias = shadowBias;
        lightEntity.light.shadowDistance = lightEntity.light.shadowDistance ?? 200;
        lightEntity.light.shadowResolution = lightEntity.light.shadowResolution ?? 2048;
    }
};


/**
 * 根据 settings.lighting 创建聚光灯实体（type==='spot'），最多 MAX_SPOT_LIGHTS 个
 */
const createSpotLightsFromSettings = (global: Global): void => {
    const { app, settings } = global;
    const configs = settings.lighting?.lights;
    if (!configs || !Array.isArray(configs)) return;

    const spotConfigs = configs.filter((c: any) => isSpotLightConfig(c)).slice(0, MAX_SPOT_LIGHTS);
    if (spotConfigs.length === 0) return;

    let container = app.root.findByName('spotLights') as Entity | null;
    if (!container) {
        container = new Entity('spotLights');
        app.root.addChild(container);
    }

    spotConfigs.forEach((cfg: SpotLightConfig, i: number) => {
        const [x, y, z] = cfg.position ?? [0, 2, 0];
        const [r, g, b] = cfg.color ?? [1, 1, 1];
        const intensity = typeof cfg.intensity === 'number' ? cfg.intensity : 1;
        const pitch = cfg.pitch ?? -45;
        const yaw = cfg.yaw ?? 0;
        const innerCone = cfg.innerConeAngle ?? 25;
        const outerCone = cfg.outerConeAngle ?? 45;
        const range = typeof cfg.range === 'number' ? cfg.range : 1;
        const enabled = cfg.enabled !== false;
        const { effectiveInnerDeg, effectiveOuterDeg } = getEffectiveSpotConeAngles(innerCone, outerCone);

        let entity = container!.findByName(`spotLight_${i}`) as Entity | undefined;
        if (!entity) {
            entity = new Entity(`spotLight_${i}`);
            entity.addComponent('light', {
                type: 'spot',
                color: new Color(r, g, b),
                intensity,
                innerConeAngle: effectiveInnerDeg,
                outerConeAngle: effectiveOuterDeg,
                range,
                castShadows: false
            });
            entity.tags.add('spotLight');
            (entity as any).__lightConfig = cfg;
            addSpotLightVisual(global, entity, r, g, b);
            container!.addChild(entity);
        }
        (entity as any).__lightConfig = cfg;
        entity.setPosition(x, y, z);
        entity.setEulerAngles(pitch, yaw, 0);
        if (entity.light) {
            entity.light.enabled = enabled;
            applyLightColorRgb(entity.light, r, g, b);
            entity.light.intensity = intensity;
            entity.light.castShadows = false;
            (entity.light as any).innerConeAngle = effectiveInnerDeg;
            (entity.light as any).outerConeAngle = effectiveOuterDeg;
            (entity.light as any).range = range;
        }
        updateSpotGizmoShape(entity, range, outerCone);
        ensureLightPickHandle(global, entity);
    });

    const existing = container!.children.filter(c => c.name.startsWith('spotLight_'));
    existing.forEach((child, i) => {
        if (i >= spotConfigs.length) (child as Entity).destroy();
    });
};

/**
 * 根据 settings.lighting 创建点光源实体（仅处理无 type 或 type 非 directional/spot 的项），最多 10 个
 */
const createPointLightsFromSettings = (global: Global): void => {
    const { app, settings } = global;
    const configs = settings.lighting?.lights;
    if (!configs || !Array.isArray(configs)) return;

    const pointConfigs = configs.filter((c: any) => !isDirectionalLightConfig(c) && !isSpotLightConfig(c)).slice(0, MAX_POINT_LIGHTS);
    if (pointConfigs.length === 0) return;

    let container = app.root.findByName('pointLights') as Entity | null;
    if (!container) {
        container = new Entity('pointLights');
        app.root.addChild(container);
    }

    pointConfigs.forEach((cfg: any, i: number) => {
        const [x, y, z] = cfg.position ?? [0, 0, 0];
        const [r, g, b] = cfg.color ?? [1, 1, 1];
        const intensity = typeof cfg.intensity === 'number' ? cfg.intensity : 1;
        const enabled = cfg.enabled !== false;
        const range = typeof cfg.range === 'number' ? cfg.range : 1;

        let entity = container!.findByName(`pointLight_${i}`) as Entity | undefined;
        if (!entity) {
            entity = new Entity(`pointLight_${i}`);
            entity.addComponent('light', {
                type: 'point',
                color: new Color(r, g, b),
                intensity,
                castShadows: false,
                range
            });
            entity.tags.add('pointLight');
            (entity as any).__lightConfig = cfg;
            addLightVisual(global, entity, r, g, b);
            container!.addChild(entity);
        }
        (entity as any).__lightConfig = cfg;
        entity.setPosition(x, y, z);
        if (entity.light) {
            entity.light.enabled = enabled;
            applyLightColorRgb(entity.light, r, g, b);
            entity.light.intensity = intensity;
            entity.light.castShadows = false;
            (entity.light as any).range = range;
            entity.light.shadowDistance = entity.light.shadowDistance ?? 200;
            entity.light.shadowResolution = entity.light.shadowResolution ?? 2048;
        }
        updatePointLightRangeVisual(entity, range);
        ensureLightPickHandle(global, entity);
    });

    const existing = container!.children.filter(c => c.name.startsWith('pointLight_'));
    existing.forEach((child, i) => {
        if (i >= pointConfigs.length) (child as Entity).destroy();
    });
};

/**
 * 低层级：直接控制点光源、聚光灯可视化实体的显示/隐藏。
 * 不关心编辑模式/左侧模块，仅根据 visible 决定是否启用可视化渲染。
 */
const setPointLightsVisualVisible = (global: Global, visible: boolean): void => {
    const { app } = global;
    (app as any).__pointLightsVisualVisible = visible;
    const pointContainer = app.root.findByName('pointLights') as Entity | null;
    if (pointContainer) {
        pointContainer.children.forEach((node) => {
            const entity = node as Entity;
            if (!entity.name.startsWith('pointLight_') || entity.name === 'pointLight_visual') return;
            const visual = (entity as any).__lightVisualEntity as Entity | undefined;
            if (visual?.render) visual.render.enabled = visible;
            const pick = (entity as any).__lightPickHandleEntity as Entity | undefined;
            if (pick?.render) pick.render.enabled = visible;
        });
    }
    const spotContainer = app.root.findByName('spotLights') as Entity | null;
    if (spotContainer) {
        spotContainer.children.forEach((node) => {
            const entity = node as Entity;
            if (!entity.name.startsWith('spotLight_') || entity.name === 'spotLight_visual') return;
            const visual = (entity as any).__spotVisualEntity as Entity | undefined;
            const innerRing = (entity as any).__spotInnerRingEntity as Entity | undefined;
            const debugDisc = (entity as any).__spotDebugDiscEntity as Entity | undefined;
            if (visual?.render) visual.render.enabled = visible;
            if (innerRing?.render) innerRing.render.enabled = visible;
            if (debugDisc?.render) debugDisc.render.enabled = visible;
            const pick = (entity as any).__lightPickHandleEntity as Entity | undefined;
            if (pick?.render) pick.render.enabled = visible;
        });
    }
};

/**
 * 高层级入口：根据「编辑模式 + 左侧环境模块 + Show lights 开关」综合控制光源可视化显隐。
 * - visibleInEnvironment 表示环境模块内部的「Show lights in scene」开关状态；
 * - 实际是否显示还需满足：state.editMode === true 且 state.editLeftModule === 'environment'。
 */
const setLightsVisualVisible = (global: Global, visibleInEnvironment: boolean): void => {
    const { app, state } = global;
    (app as any).__lightsVisualToggle = visibleInEnvironment;
    const inEnvironmentEdit = !!(state.editMode && state.editLeftModule === 'environment');
    setPointLightsVisualVisible(global, visibleInEnvironment && inEnvironmentEdit);
};

/**
 * 根据拾取到的世界坐标（优先）与屏幕点击坐标（兜底），在点光/聚光灯实体中选中最接近的一盏。
 * 仅在编辑模式 + 环境模块下才生效。
 */
const selectNearestLightAtPosition = (
    global: Global,
    position: Vec3,
    clientX?: number,
    clientY?: number
): void => {
    const { app, state, events } = global;
    if (!state.editMode || state.editLeftModule !== 'environment') return;

    type Candidate = {
        entity: Entity;
        cfg: any;
        dist: number;
        type: 'spot' | 'point';
    };
    const candidates: Candidate[] = [];

    const testContainer = (name: string) => {
        const container = app.root.findByName(name) as Entity | null;
        if (!container) return;
        container.children.forEach((node) => {
            const e = node as Entity;
            if (!e.light || !e.light.enabled) return;
            const cfg = (e as any).__lightConfig as any | undefined;
            if (!cfg || !cfg.id) return;
            const pos = e.getPosition();
            const d = pos.distance(position);
            const type: 'spot' | 'point' = cfg.type === 'spot' ? 'spot' : 'point';
            candidates.push({ entity: e, cfg, dist: d, type });
        });
    };

    testContainer('pointLights');
    testContainer('spotLights');

    if (candidates.length === 0) return;

    const pickNearest = (list: Candidate[]): Candidate | null => {
        if (list.length === 0) return null;
        let best = list[0];
        for (let i = 1; i < list.length; i++) {
            if (list[i].dist < best.dist) best = list[i];
        }
        return best;
    };

    // 1) 世界坐标：点光中心 / 聚光锥尖统一为小球拾取半径（与 light_pick_handle 视觉一致）
    const inPickSphere = candidates.filter((c) => c.dist <= LIGHT_PICK_HANDLE_WORLD_HIT_RADIUS);
    const worldPicked = pickNearest(inPickSphere);
    if (worldPicked) {
        (state as any).selectedLightId = worldPicked.cfg.id;
        events.fire('sceneLight:selected', { id: worldPicked.cfg.id, source: 'scene' });
        return;
    }

    // 2) 屏幕空间兜底：灯心/锥尖投影点附近，阈值与拾取球语义一致
    const cam = global.camera?.camera;
    if (!cam || !Number.isFinite(clientX) || !Number.isFinite(clientY)) return;
    let bestScreenCandidate: Candidate | null = null;
    let bestScore = Infinity;
    candidates.forEach((candidate) => {
        const threshold = LIGHT_PICK_HANDLE_SCREEN_PX;
        const sp = cam.worldToScreen(candidate.entity.getPosition());
        const dx = sp.x - (clientX as number);
        const dy = sp.y - (clientY as number);
        const px = Math.hypot(dx, dy);
        if (px > threshold) return;
        const score = px / threshold;
        if (score < bestScore) {
            bestScore = score;
            bestScreenCandidate = candidate;
        }
    });
    if (!bestScreenCandidate) return;

    (state as any).selectedLightId = bestScreenCandidate.cfg.id;
    events.fire('sceneLight:selected', { id: bestScreenCandidate.cfg.id, source: 'scene' });
};

/**
 * 根据当前 settings.lighting 重新应用平行光并创建/更新点光源实体（供运行时 UI 修改配置后调用）
 */
const updatePointLightsFromSettings = (global: Global): void => {
    const { app } = global;
    applyDirectionalLightFromSettings(global);
    const configs = global.settings.lighting?.lights;
    if (!configs || !Array.isArray(configs)) {
        const c1 = app.root.findByName('pointLights') as Entity | null;
        const c2 = app.root.findByName('spotLights') as Entity | null;
        if (c1) c1.destroy();
        if (c2) c2.destroy();
        return;
    }
    const hasPoint = configs.some((c: any) => !isDirectionalLightConfig(c) && !isSpotLightConfig(c));
    const hasSpot = configs.some((c: any) => isSpotLightConfig(c));
    if (!hasPoint) {
        const c = app.root.findByName('pointLights') as Entity | null;
        if (c) c.destroy();
    } else {
        createPointLightsFromSettings(global);
    }
    if (!hasSpot) {
        const c = app.root.findByName('spotLights') as Entity | null;
        if (c) c.destroy();
    } else {
        createSpotLightsFromSettings(global);
    }
};

/**
 * 初始化场景光照
 * - 主方向光（平行光）由 settings.lighting.lights 中 type==='directional' 的项驱动，若无则用默认
 * - 点光源由 settings.lighting.lights 中非 directional 的项创建，最多 10 个
 */
const initLight = (global: Global): Entity => {
    applyDirectionalLightFromSettings(global);
    const lightEntity = global.app.root.findByName('light') as Entity;
    if (lightEntity?.light) {
        lightEntity.light.shadowDistance = lightEntity.light.shadowDistance ?? 200;
        lightEntity.light.shadowResolution = lightEntity.light.shadowResolution ?? 2048;
    }
    createPointLightsFromSettings(global);
    createSpotLightsFromSettings(global);
    return lightEntity;
};

/**
 * 根据场景包围盒大小动态设置方向光的 shadowDistance。
 * 应在场景加载后、获得 sceneBound 时调用。
 */
const updateShadowDistance = (global: Global, sceneSize: number): void => {
    const lightEntity = global.app.root.findByName('light') as Entity | null;
    if (lightEntity?.light) {
        // shadowDistance 设为场景对角线长度的 1.5 倍，确保覆盖整个场景
        const dist = Math.max(200, sceneSize * 1.5);
        lightEntity.light.shadowDistance = dist;
        console.log(`[Light] shadowDistance updated to ${dist.toFixed(1)} (sceneSize=${sceneSize.toFixed(1)})`);
    }
};

export {
    initLight,
    collectPointLights,
    collectSpotLights,
    updatePointLightsFromSettings,
    setPointLightsVisualVisible,
    setLightsVisualVisible,
    selectNearestLightAtPosition,
    updateShadowDistance
};
