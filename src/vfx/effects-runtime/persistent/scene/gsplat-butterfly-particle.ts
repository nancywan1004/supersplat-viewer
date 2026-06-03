import {
    BLEND_ADDITIVE,
    Color,
    CULLFACE_NONE,
    Entity,
    Layer,
    Mat4,
    Mesh,
    MeshInstance,
    PRIMITIVE_TRIANGLES,
    Quat,
    Script,
    SEMANTIC_POSITION,
    SEMANTIC_TEXCOORD0,
    SEMANTIC_TEXCOORD1,
    SEMANTIC_TEXCOORD2,
    SEMANTIC_TEXCOORD3,
    ShaderMaterial,
    Vec3,
    type AppBase,
    type BoundingBox,
    type Keyboard,
    type Mouse
} from 'playcanvas';
import { fragmentShaderGLSL, shaderGLSL } from './gsplat-butterfly-particle-shaders';
import type { Global } from '../../../../types';

const BUTTERFLY_LAYER_NAME = 'ButterflyAfterGsplat';
const OVERLAY_ROOT_NAME = 'butterflyParticleOverlay';
const SPARKLE_TRAIL_ROOT_NAME = 'butterflySparkleTrail';
const GS_LIGHT_NAME = 'butterflyGsLight';
/** 移动时沿路径洒落、闪烁下坠的魔法粒子�?*/
const SPARKLE_MAX = 1400;
const SPARKLE_EMIT_DIST = 0.006;
/** 静止 / idle 扇翅（移�?blend=0）�?*/
const WING_FLAP_IDLE_SPEED = 1.5;
const WING_FLAP_IDLE_AMP = 0.25;
/** 持续移动满速扇翅（blend=1；WASD 恒速故�?blend 缓入而非瞬时拉满）�?*/
const WING_FLAP_MOVE_SPEED = 15;
const WING_FLAP_MOVE_AMP = 1.05;
/** 开始移动缓升至满速、停止后缓回 idle 的大致时长（秒，�?95% 到位）�?*/
const WING_FLAP_BLEND_UP_SEC = 5;
const WING_FLAP_BLEND_DOWN_SEC =1;
/** exp 平滑：rate �?-ln(0.05) / T */
const WING_FLAP_BLEND_UP_RATE = 2.996 / WING_FLAP_BLEND_UP_SEC;
const WING_FLAP_BLEND_DOWN_RATE = 2.996 / WING_FLAP_BLEND_DOWN_SEC;
const WING_FLAP_MOVE_EPS = 1e-6;
const SPARKLE_BURST_MIN = 8;
const SPARKLE_BURST_MAX = 15;
const SPARKLE_PATH_STEPS_MAX = 5;
const SPARKLE_LIFETIME = 0.88;
const SPARKLE_GRAVITY = 0.52;
const SPARKLE_DRIFT = 0.1;
/** 躯干头尾弦长（与粒子模板 abdomen→head 一致），拖尾总长度对齐身长�?*/
const BUTTERFLY_BODY_CHORD = 0.57;
/** 尾部洒落区：身后深度、翅展横向、头尾纵向（× meshScale）�?*/
const SPARKLE_TAIL_BACK_MAX = BUTTERFLY_BODY_CHORD * 0.28;
const SPARKLE_TAIL_LATERAL = 0.72;
const SPARKLE_TAIL_VERT = 0.22;
/** 沿身后深度收窄：1 = 完全线性收�?0 宽�?*/
const SPARKLE_TAIL_TAPER = 0.86;
const SCENE_REF_RADIUS = 25;
const BUTTERFLY_PARTICLE_COUNT = 5200;
const BUTTERFLY_TEMPLATE_VERSION = 27;
/** 前翅：大三角 + 波浪外缘；后翅：圆扇 + 波浪外缘（参考帝王蝶俯视）�?*/
const FORE_WING_SPAN = 0.62;
/** 弦向（头↔尾）展宽�?*/
const FORE_WING_CHORD = 1.5;
const HIND_WING_SPAN = 0.5;
const HIND_WING_CHORD = 1.5;
/** 弦向：外缘相对铰链向�?尾延伸倍率�?*/
const FORE_CHORD_HEAD_GAIN = 1.06;
const FORE_CHORD_TAIL_GAIN = 0.22;
const HIND_CHORD_HEAD_GAIN = 0.06;
const HIND_CHORD_TAIL_GAIN = 1.08;
/** 外缘波浪幅度�?*/
const WING_EDGE_SCALLOP = 0.034;
const WING_EDGE_SCALLOP_FREQ = 5.2;
/** 靠近身体：小圆角；外缘：大圆角�?*/
const WING_CORNER_ROUND_BODY = 0.04;
const WING_CORNER_ROUND_OUTER = 0.12;
/** �?后翅铰链靠近，缩小两翅之间的缝隙�?*/
const FORE_HINGE_Y = 0.01;
const HIND_HINGE_Y = 0.1;
/** 粒子噪波位移：振幅与速度�?*/
const PARTICLE_JITTER_AMP = 0.015;
const PARTICLE_JITTER_SPEED = 5.4;
/** 蝴蝶在相机视线前方的距离（米）�?*/
const CAMERA_FOLLOW_DISTANCE = 3;
/** 沿相机“向下”偏移（相对前方距离的比例），便于俯瞰蝴蝶�?*/
const CAMERA_SCREEN_DOWN_RATIO = 0.5;
/** 整体缩放倍率�?.2 = 在默认自适应尺寸上再缩至 20%，相对原 0.4 再小 50%）�?*/
const BUTTERFLY_SIZE_SCALE = 0.2;
/** 相对「正前方」头部左右偏转上限（仅绕世界 Y，不改变位置）�?*/
const BUTTERFLY_HEAD_YAW_LIMIT_RAD = (40 * Math.PI) / 180;
/** A/D 平移时头部转向速率（弧�?秒）�?*/
const BUTTERFLY_AD_HEAD_YAW_SPEED = 2.4;
/** 松开 A/D 或停止鼠标旋转后头部回正速率（exp 平滑，越大越快）�?*/
const BUTTERFLY_HEAD_YAW_RETURN_RATE = 5;
/** 左键拖拽旋转，右键平移（�?keyboard-mouse 一致）�?*/
const MOUSE_BUTTON_LEFT = 0;
const MOUSE_BUTTON_RIGHT = 2;
const KEY_CODE_A = 65;
const KEY_CODE_D = 68;
const KEY_CODE_LEFT = 37;
const KEY_CODE_RIGHT = 39;

const QUAD_CORNERS: ReadonlyArray<readonly [number, number]> = [
    [-1, -1],
    [1, -1],
    [1, 1],
    [-1, 1]
];

const _invWorld = new Mat4();
const _worldPos = new Vec3();
const _camPos = new Vec3();
const _camFwd = new Vec3();
const _orient = new Quat();
const _modelForwardFix = new Quat().setFromEulerAngles(-90, 0, 0);
const _lookAt = new Mat4();
const _spawnFwd = new Vec3();
const _camUp = new Vec3();
const _lookTarget = new Vec3();
const _parentWorldRot = new Quat();
const _invParentWorldRot = new Quat();
const _butterflyWorldOrient = new Quat();
const _flatCamFwd = new Vec3();
const _sparkleBack = new Vec3();
const _sparkleRight = new Vec3();

let butterflyLayerId: number | null = null;

type AppWithExtras = AppBase & {
    keyboard?: Keyboard;
    mouse?: Mouse;
    viewer?: {
        cameraFrame?: { enabled?: boolean; update: () => void };
    };
    __global?: Global;
};

type GsplatBboxSource = {
    customAabb?: BoundingBox;
    resource?: { aabb?: BoundingBox };
} | null | undefined;

type CameraLayers = { layers: number[] };

type SparkleParticle = {
    x: number;
    y: number;
    z: number;
    vx: number;
    vy: number;
    vz: number;
    age: number;
    phase: number;
    colorMix: number;
    /** 生成时沿身后深度 0（贴近蝴蝶）�?1（拖尾末端）�?*/
    behindT: number;
};

/** part: 0=body 1=forewing 2=hindwing 3=antenna 4=leg */
type ButterflyParticle = {
    lx: number;
    ly: number;
    lz: number;
    part: number;
    side: number;
    wingCoord: number;
    phase: number;
    colorMix: number;
};

/** 铰链贴胸节，四翅从窄铰链向外展开�?*/
const HINGE_FORE_X = 0.052;
const HINGE_HIND_X = 0.048;
const HINGE_FORE_Z = 0.01;
const HINGE_HIND_Z = 0.006;
/** 翅尖铰链转角�? = 与躯干平行，π/2 = 与躯干垂直（单侧 90° 行程）�?*/
const WING_FLAP_TIP_SPAN_RAD = Math.PI / 2;
/** 沿翅面参与扇动的权重（翅根也随动，避免仅翅尖在转）�?*/
const WING_FLAP_ROOT_WEIGHT = 0.32;
/** 躯干/附肢轻微上下起伏（叠加多�?sin + 每粒�?phase，避免整齐同步）�?*/
const BODY_BOB_AMP = 0.02;
const BODY_BOB_SPEED = 3.1;
let butterflyTemplateCache: { version: number; particles: ButterflyParticle[] } | null = null;

function smoothExpToward(current: number, target: number, dt: number, rate: number): number {
    if (dt <= 0) {
        return current;
    }
    const t = 1 - Math.exp(-rate * dt);
    return current + (target - current) * t;
}

function lerpScalar(a: number, b: number, t: number): number {
    return a + (b - a) * t;
}

function splatHash(x: number, y: number, z: number): number {
    const d = x * 127.1 + y * 311.7 + z * 74.7;
    const v = Math.sin(d) * 43758.5453;
    return v - Math.floor(v);
}

function getOrCreateButterflyLayer(app: AppBase): number {
    if (butterflyLayerId != null) {
        return butterflyLayerId;
    }
    const layers = app.scene.layers;
    let layer = layers.getLayerByName(BUTTERFLY_LAYER_NAME);
    if (!layer) {
        const world = layers.getLayerByName('World');
        layer = new Layer({ name: BUTTERFLY_LAYER_NAME });
        if (world) {
            layers.insert(layer, layers.getTransparentIndex(world) + 1);
        } else {
            layers.push(layer);
        }
    }
    butterflyLayerId = layer.id;
    return butterflyLayerId;
}

/** 确保 Butterfly 渲染层在相机列表中；有变更时触发 CameraFrame 重建 */
function syncButterflyRenderLayer(app: AppBase): number {
    const layerId = getOrCreateButterflyLayer(app);
    let patched = false;

    const addLayer = (cam: CameraLayers) => {
        if (cam.layers.indexOf(layerId) >= 0) {
            return;
        }
        cam.layers = [...cam.layers, layerId];
        patched = true;
    };

    const mainCam = (app as AppWithExtras).__global?.camera?.camera as CameraLayers | undefined;
    if (mainCam) {
        addLayer(mainCam);
    } else {
        const found = app.root.findComponent('camera') as { camera?: CameraLayers } | null;
        if (found?.camera) {
            addLayer(found.camera);
        }
    }
    for (const { camera } of app.scene.layers.cameras) {
        addLayer(camera);
    }

    if (patched) {
        const cf = (app as AppWithExtras).viewer?.cameraFrame;
        if (cf?.enabled) {
            cf.update();
            app.renderNextFrame = true;
        }
    }
    return layerId;
}

function readSceneBboxRadius(gsplat: GsplatBboxSource): number {
    const aabb = gsplat?.customAabb ?? gsplat?.resource?.aabb;
    if (!aabb?.halfExtents) {
        return SCENE_REF_RADIUS;
    }
    const h = aabb.halfExtents;
    let radius = Math.max(h.x, h.y, h.z);
    if (!Number.isFinite(radius) || radius < 1e-6) {
        radius = h.length();
    }
    return Number.isFinite(radius) && radius > 1e-6 ? radius : SCENE_REF_RADIUS;
}

function worldPointToOverlayLocal(gsplatEntity: Entity, world: Vec3, out: Vec3): void {
    _invWorld.copy(gsplatEntity.getWorldTransform()).invert();
    _invWorld.transformPoint(world, out);
}

function worldRotToOverlayLocal(gsplatEntity: Entity, worldRot: Quat, out: Quat): void {
    _parentWorldRot.setFromMat4(gsplatEntity.getWorldTransform());
    _invParentWorldRot.copy(_parentWorldRot).invert();
    out.mul2(_invParentWorldRot, worldRot);
}

function normalizeAngleRad(a: number): number {
    let x = a;
    while (x > Math.PI) {
        x -= Math.PI * 2;
    }
    while (x < -Math.PI) {
        x += Math.PI * 2;
    }
    return x;
}

/** 更新水平相机视线；俯视时沿用 lastFlatFwd�?*/
function updateLastFlatCamFwd(camFwd: Vec3, lastFlatFwd: Vec3, outFlat: Vec3): void {
    outFlat.set(camFwd.x, 0, camFwd.z);
    const flatLen = outFlat.length();
    if (flatLen > 1e-4) {
        outFlat.mulScalar(1 / flatLen);
        lastFlatFwd.copy(outFlat);
    } else {
        outFlat.copy(lastFlatFwd);
    }
}

/** 仅绕世界 Y：头�?flatFwd（已归一化），Up 为世�?+Y，腹足朝下�?*/
function computeButterflyWorldOrientFromFlatFwd(flatFwd: Vec3, out: Quat): void {
    _lookTarget.set(flatFwd.x, 0, flatFwd.z);
    _lookAt.setLookAt(Vec3.ZERO, _lookTarget, Vec3.UP);
    out.setFromMat4(_lookAt);
    out.mul(_modelForwardFix);
}

/** Uniform random point inside unit sphere (rejection). */
function sampleUnitSphere(i: number, seedA: number, seedB: number): { x: number; y: number; z: number } {
    for (let attempt = 0; attempt < 8; attempt++) {
        const u = splatHash(i + attempt * 3.1, seedA, seedB) * 2 - 1;
        const v = splatHash(seedA, i + attempt, seedB) * 2 - 1;
        const w = splatHash(seedB, seedA, i + attempt) * 2 - 1;
        const len2 = u * u + v * v + w * w;
        if (len2 <= 1 && len2 > 1e-6) {
            const inv = 1 / Math.sqrt(len2);
            return { x: u * inv, y: v * inv, z: w * inv };
        }
    }
    const t = splatHash(i, seedA, seedB) * Math.PI * 2;
    const p = splatHash(seedB, i, seedA) * 2 - 1;
    const s = Math.sqrt(1 - p * p);
    return { x: Math.cos(t) * s, y: Math.sin(t) * s, z: p };
}

function smoothstep01(x: number): number {
    const t = Math.max(0, Math.min(1, x));
    return t * t * (3 - 2 * t);
}

function wingOuterScallop(along: number, depth: number): number {
    const wave =
        Math.sin(along * Math.PI * WING_EDGE_SCALLOP_FREQ) * WING_EDGE_SCALLOP +
        Math.sin(along * Math.PI * (WING_EDGE_SCALLOP_FREQ * 1.7) + 0.6) * WING_EDGE_SCALLOP * 0.45;
    return wave * depth;
}

/**
 * 前翅：u=0 外缘、u=1 翅根；v=0 前缘（头侧）、v=1 后缘（腹侧）�?
 */
function forewingSpanChord(
    side: number,
    u: number,
    v: number
): { lx: number; ly: number; lz: number; wingCoord: number } | null {
    if (u < 0 || v < 0 || u > 1 || v > 1) {
        return null;
    }

    const depth = u;
    const along = WING_CORNER_ROUND_BODY + v * (1 - 2 * WING_CORNER_ROUND_BODY);
    const outerBlend = 1 - depth;
    const rootX = side * HINGE_FORE_X;

    const leadingSpan = FORE_WING_SPAN * (0.92 + (1 - along) * 0.08);
    const trailingSpan = FORE_WING_SPAN * (0.78 + along * 0.12);
    const span = leadingSpan + (trailingSpan - leadingSpan) * along;

    const leadingLy = FORE_HINGE_Y + FORE_WING_CHORD * FORE_CHORD_HEAD_GAIN;
    const trailingLy = FORE_HINGE_Y - FORE_WING_CHORD * FORE_CHORD_TAIL_GAIN;
    const rootLeadingLy = FORE_HINGE_Y + FORE_WING_CHORD * 0.12;
    const rootTrailingLy = FORE_HINGE_Y - FORE_WING_CHORD * 0.08;

    const outerLy = leadingLy + (trailingLy - leadingLy) * along;
    const rootLy = rootLeadingLy + (rootTrailingLy - rootLeadingLy) * along;
    const outerLx = rootX + side * span;
    const attach = smoothstep01((depth - 0.42) / 0.58);
    const rootBias = Math.pow(depth, 0.82);

    let lx = rootX + (outerLx - rootX) * (1 - rootBias);
    let ly = outerLy + (rootLy - outerLy) * rootBias;

    if (outerBlend > 0.06) {
        lx += side * wingOuterScallop(along, outerBlend);
    }

    const lift = Math.sin(outerBlend * Math.PI) * 0.07 * (0.35 + along * 0.65);
    const lz =
        HINGE_FORE_Z +
        lift +
        (along - 0.5) * 0.035 * outerBlend +
        (1 - attach) * 0.012;

    return { lx, ly, lz, wingCoord: Math.min(1, outerBlend * 0.55 + along * 0.35) };
}

/**
 * 后翅：s=0 翅根、s=1 外缘；t=0 前缘、t=1 后缘�?
 */
function hindwingSpanChord(
    side: number,
    s: number,
    t: number
): { lx: number; ly: number; lz: number; wingCoord: number } | null {
    if (s < 0 || t < 0 || s > 1 || t > 1) {
        return null;
    }

    const depth = 1 - s;
    const along =
        depth > 0.42
            ? WING_CORNER_ROUND_OUTER + t * (1 - 2 * WING_CORNER_ROUND_OUTER)
            : WING_CORNER_ROUND_BODY + t * (1 - 2 * WING_CORNER_ROUND_BODY);
    const outerBlend = 1 - depth;
    const rootX = side * HINGE_HIND_X;

    const spanFactor = 0.55 + 0.45 * Math.sin(along * Math.PI);
    const span = HIND_WING_SPAN * spanFactor * (0.88 + outerBlend * 0.12);

    const leadingLy = HIND_HINGE_Y - HIND_WING_CHORD * HIND_CHORD_HEAD_GAIN;
    const trailingLy = HIND_HINGE_Y - HIND_WING_CHORD * HIND_CHORD_TAIL_GAIN;
    const rootLeadingLy = HIND_HINGE_Y - HIND_WING_CHORD * 0.04;
    const rootTrailingLy = HIND_HINGE_Y - HIND_WING_CHORD * HIND_CHORD_TAIL_GAIN * 0.18;

    const outerLy = leadingLy + (trailingLy - leadingLy) * along;
    const rootLy = rootLeadingLy + (rootTrailingLy - rootLeadingLy) * along;
    const outerLx = rootX + side * span;
    const rootBias = Math.pow(depth, 0.84);

    let lx = rootX + (outerLx - rootX) * (1 - rootBias);
    let ly = outerLy + (rootLy - outerLy) * rootBias;

    if (outerBlend > 0.06) {
        const scallop = wingOuterScallop(along, outerBlend);
        lx += side * scallop;
        ly -= Math.abs(scallop) * 0.18;
    }

    const lift = Math.sin(outerBlend * Math.PI) * 0.065 * (0.4 + along * 0.6);
    const lz =
        HINGE_HIND_Z +
        lift -
        (along - 0.5) * 0.03 * outerBlend;

    return { lx, ly, lz, wingCoord: Math.min(1, outerBlend * 0.55 + along * 0.35) };
}

function wingColorMix(part: number, s: number, t: number, edgeDist: number, seed: number): number {
    const border = edgeDist < 0.045 ? 0.06 : edgeDist < 0.09 ? 0.16 : 0;
    if (border > 0) {
        return border + (edgeDist < 0.03 && splatHash(s, t, seed) > 0.88 ? 0.88 : 0);
    }
    const nearRoot = part === 2 ? (1 - s) * 0.42 : s * 0.42;
    if (nearRoot > 0.62) {
        return 0.34 + splatHash(s * 3, t, seed) * 0.12;
    }
    const glowCore = 0.68 + (1 - s) * 0.2 + splatHash(s, t * 2, seed + part) * 0.18;
    return Math.min(0.96, glowCore);
}

function generateButterflyParticles(): ButterflyParticle[] {
    if (butterflyTemplateCache?.version === BUTTERFLY_TEMPLATE_VERSION) {
        return butterflyTemplateCache.particles;
    }

    const out: ButterflyParticle[] = [];
    const target = BUTTERFLY_PARTICLE_COUNT;

    const pushParticle = (p: Omit<ButterflyParticle, 'phase'> & { phase?: number }) => {
        out.push({
            phase: p.phase ?? splatHash(p.lx, p.ly, p.lz) * Math.PI * 2,
            lx: p.lx,
            ly: p.ly,
            lz: p.lz,
            part: p.part,
            side: p.side,
            wingCoord: p.wingCoord,
            colorMix: Math.min(1, Math.max(0, p.colorMix))
        });
    };

    const addInBodyVolume = (
        cx: number,
        cy: number,
        cz: number,
        rx: number,
        ry: number,
        rz: number,
        count: number,
        colorBase: number
    ) => {
        for (let i = 0; i < count; i++) {
            const s = sampleUnitSphere(i, cy * 9, cz * 13);
            const radial = Math.pow(splatHash(i, rx, ry), 0.62);
            const lx = cx + s.x * rx * radial;
            const ly = cy + s.y * ry * radial;
            const lz = cz + s.z * rz * radial;
            const belly = Math.max(0, -s.y) * 0.18;
            pushParticle({
                lx,
                ly,
                lz,
                part: 0,
                side: 0,
                wingCoord: 0,
                colorMix: colorBase + belly + (splatHash(lx, ly, lz) - 0.5) * 0.12
            });
        }
    };

    const addThinCurve = (
        part: number,
        side: number,
        count: number,
        sample: (t: number, i: number) => { lx: number; ly: number; lz: number },
        colorBase: number
    ) => {
        for (let i = 0; i < count; i++) {
            const t = count > 1 ? i / (count - 1) : 0;
            const p = sample(t, i);
            const j = 0.004;
            const lx = p.lx + (splatHash(i, part, side) - 0.5) * j;
            const ly = p.ly + (splatHash(side, i, part) - 0.5) * j;
            const lz = p.lz + (splatHash(part, side, i) - 0.5) * j;
            pushParticle({
                lx,
                ly,
                lz,
                part,
                side,
                wingCoord: 0,
                colorMix: colorBase + splatHash(lx, ly, lz) * 0.08
            });
        }
    };

    const fillForeWing = (side: number, count: number) => {
        const cols = Math.max(18, Math.ceil(Math.sqrt(count * 1.08)));
        const rows = Math.max(12, Math.ceil(count / cols));
        let placed = 0;
        for (let si = 0; si < cols && placed < count; si++) {
            for (let ti = 0; ti < rows && placed < count; ti++) {
                const u =
                    (si + 0.5 + (splatHash(si, ti, side + 1) - 0.5) * 0.88) / cols;
                const v =
                    (ti + 0.5 + (splatHash(ti, si, side + 2) - 0.5) * 0.88) / rows;
                const pt = forewingSpanChord(side, u, v);
                if (!pt) {
                    continue;
                }
                const edgeDist = Math.min(1 - u, u, v, 1 - v);
                const j = 0.005;
                pushParticle({
                    lx: pt.lx + (splatHash(placed, u, v) - 0.5) * j * side,
                    ly: pt.ly + (splatHash(v, placed, side) - 0.5) * j,
                    lz: pt.lz + (splatHash(side, v, placed) - 0.5) * j,
                    part: 1,
                    side,
                    wingCoord: pt.wingCoord,
                    colorMix: wingColorMix(1, u, v, edgeDist, placed)
                });
                placed++;
            }
        }
        for (let i = 0; placed < count && i < count * 3; i++) {
            const u = splatHash(i, side, 60);
            const v = splatHash(side, i, 61);
            const pt = forewingSpanChord(side, u, v);
            if (!pt) {
                continue;
            }
            const edgeDist = Math.min(1 - u, u, v, 1 - v);
            pushParticle({
                lx: pt.lx,
                ly: pt.ly,
                lz: pt.lz,
                part: 1,
                side,
                wingCoord: pt.wingCoord,
                colorMix: wingColorMix(1, u, v, edgeDist, placed + i)
            });
            placed++;
        }
    };

    const fillHindWing = (side: number, count: number) => {
        const cols = Math.max(18, Math.ceil(Math.sqrt(count * 1.08)));
        const rows = Math.max(12, Math.ceil(count / cols));
        let placed = 0;
        for (let si = 0; si < cols && placed < count; si++) {
            for (let ti = 0; ti < rows && placed < count; ti++) {
                const s =
                    (si + 0.5 + (splatHash(si, ti, side + 3) - 0.5) * 0.88) / cols;
                const t =
                    (ti + 0.5 + (splatHash(ti, si, side + 4) - 0.5) * 0.88) / rows;
                const pt = hindwingSpanChord(side, s, t);
                if (!pt) {
                    continue;
                }
                const edgeDist = Math.min(1 - s, s, t, 1 - t);
                const j = 0.005;
                pushParticle({
                    lx: pt.lx + (splatHash(placed, s, t) - 0.5) * j * side,
                    ly: pt.ly + (splatHash(t, placed, side) - 0.5) * j,
                    lz: pt.lz + (splatHash(side, t, placed) - 0.5) * j,
                    part: 2,
                    side,
                    wingCoord: pt.wingCoord,
                    colorMix: wingColorMix(2, s, t, edgeDist, placed)
                });
                placed++;
            }
        }
        for (let i = 0; placed < count && i < count * 3; i++) {
            const s = splatHash(i, side, 62);
            const t = splatHash(side, i, 63);
            const pt = hindwingSpanChord(side, s, t);
            if (!pt) {
                continue;
            }
            const edgeDist = Math.min(1 - s, s, t, 1 - t);
            pushParticle({
                lx: pt.lx,
                ly: pt.ly,
                lz: pt.lz,
                part: 2,
                side,
                wingCoord: pt.wingCoord,
                colorMix: wingColorMix(2, s, t, edgeDist, placed + i)
            });
            placed++;
        }
    };

    const abdomenCount = Math.floor(target * 0.036);
    const thoraxCount = Math.floor(target * 0.032);
    const headCount = Math.floor(target * 0.018);
    const antennaCount = Math.floor(target * 0.026);
    const legCount = Math.floor(target * 0.032);
    const foreFillEach = Math.floor(target * 0.375);
    const hindFillEach = Math.floor(target * 0.375);
    const foreBorderEach = Math.floor(target * 0.028);
    const hindBorderEach = Math.floor(target * 0.028);

    addInBodyVolume(0, -0.12, 0.008, 0.048, 0.14, 0.07, abdomenCount, 0.42);
    addInBodyVolume(0, 0.09, 0.03, 0.055, 0.09, 0.07, thoraxCount, 0.5);
    addInBodyVolume(0, 0.26, 0.05, 0.038, 0.045, 0.04, headCount, 0.56);

    for (const side of [1, -1] as const) {
        addThinCurve(3, side, Math.floor(antennaCount / 2), (t) => {
            const ly = 0.28 + t * 0.18;
            const lx = side * (0.014 + t * 0.032 + Math.sin(t * 3.1) * 0.01);
            const lz = 0.05 + t * 0.022 + Math.cos(t * 2.4) * 0.006;
            return { lx, ly, lz };
        }, 0.52);
    }

    const legOffsets = [
        { sx: 0.048, sy: 0.05, sz: -0.022 },
        { sx: 0.064, sy: 0.02, sz: -0.03 },
        { sx: 0.036, sy: 0.07, sz: -0.02 }
    ];
    const perLeg = Math.max(14, Math.floor(legCount / (legOffsets.length * 2)));
    for (const side of [1, -1] as const) {
        for (const off of legOffsets) {
            addThinCurve(4, side, perLeg, (t) => ({
                lx: side * off.sx + (splatHash(t, off.sx, side) - 0.5) * 0.01,
                ly: off.sy - t * 0.12,
                lz: off.sz - t * 0.085 - t * t * 0.028
            }), 0.38);
        }
    }

    for (const side of [1, -1] as const) {
        fillForeWing(side, foreFillEach);
        fillHindWing(side, hindFillEach);

        for (let i = 0; i < foreBorderEach; i++) {
            const v = (i + 0.5 + (splatHash(i, side, 70) - 0.5) * 0.85) / foreBorderEach;
            const pt = forewingSpanChord(side, 0, v);
            if (!pt) {
                continue;
            }
            pushParticle({
                lx: pt.lx,
                ly: pt.ly,
                lz: pt.lz,
                part: 1,
                side,
                wingCoord: pt.wingCoord,
                colorMix: splatHash(v, i, side) > 0.45 ? 0.92 : 0.1
            });
        }

        for (let i = 0; i < hindBorderEach; i++) {
            const along = (i + 0.5 + (splatHash(i, side, 71) - 0.5) * 0.85) / hindBorderEach;
            const pt = hindwingSpanChord(side, 1, along);
            if (!pt) {
                continue;
            }
            pushParticle({
                lx: pt.lx,
                ly: pt.ly,
                lz: pt.lz,
                part: 2,
                side,
                wingCoord: pt.wingCoord,
                colorMix: splatHash(1, i, side) > 0.45 ? 0.9 : 0.12
            });
        }
    }

    butterflyTemplateCache = { version: BUTTERFLY_TEMPLATE_VERSION, particles: out };
    return out;
}

function bodyBobOffset(effectTime: number, p: ButterflyParticle, ampMul: number): number {
    const ph = p.phase;
    const t = effectTime;
    const a = BODY_BOB_AMP * ampMul;
    return (
        Math.sin(t * BODY_BOB_SPEED + ph * 4.17 + p.lx * 11.3) * a +
        Math.sin(t * BODY_BOB_SPEED * 1.71 + ph * 6.83 + p.lz * 8.7) * a * 0.42 +
        Math.sin(t * BODY_BOB_SPEED * 0.89 + ph * 2.41 + p.ly * 14.5) * a * 0.28
    );
}

/** 多频 sin 叠加的噪波式位移，翅尖幅度更大，并随扇翅轻微跳动�?*/
function particleJitterOffset(
    effectTime: number,
    flapPhase: number,
    p: ButterflyParticle
): { dx: number; dy: number; dz: number } {
    const ph = p.phase;
    const t = effectTime;
    const isWing = p.part === 1 || p.part === 2;
    const partScale =
        p.part === 0 ? 0.32 : isWing ? 0.72 + p.wingCoord * 0.42 : p.part === 3 ? 0.48 : 0.4;
    const amp = PARTICLE_JITTER_AMP * partScale;
    const hop = isWing
        ? Math.sin(flapPhase * 2 + ph * 3.1) * amp * 0.38
        : Math.sin(flapPhase + ph * 2.7) * amp * 0.24;

    const sx = p.lx * 19.7 + ph;
    const sy = p.ly * 27.3 + ph * 1.7;
    const sz = p.lz * 21.1 + ph * 0.9;

    const dx =
        (Math.sin(t * PARTICLE_JITTER_SPEED + sx) * 0.52 +
            Math.sin(t * PARTICLE_JITTER_SPEED * 1.91 + sy * 0.83) * 0.31 +
            Math.cos(t * PARTICLE_JITTER_SPEED * 0.61 + sz * 1.37) * 0.17) *
        amp;
    const dy =
        (Math.cos(t * PARTICLE_JITTER_SPEED * 1.13 + sy) * 0.48 +
            Math.sin(t * PARTICLE_JITTER_SPEED * 2.07 + sx * 0.67) * 0.34 +
            Math.sin(t * PARTICLE_JITTER_SPEED * 0.79 + ph * 5.3) * 0.18) *
            amp +
        hop;
    const dz =
        (Math.sin(t * PARTICLE_JITTER_SPEED * 0.97 + sz) * 0.5 +
            Math.cos(t * PARTICLE_JITTER_SPEED * 1.67 + sx * 1.11) * 0.32 +
            Math.sin(t * PARTICLE_JITTER_SPEED * 2.23 + sy * 0.49) * 0.18) *
        amp;
    return { dx, dy, dz };
}

function applyWingFlap(
    template: ButterflyParticle[],
    flapPhase: number,
    flapAmp: number,
    effectTime: number,
    outX: Float32Array,
    outY: Float32Array,
    outZ: Float32Array
): void {
    const amp = Math.max(0, flapAmp);

    for (let i = 0; i < template.length; i++) {
        const p = template[i];
        let lx = p.lx;
        let ly = p.ly;
        let lz = p.lz;
        if (p.part === 1 || p.part === 2) {
            const wingStrength = p.part === 1 ? 1 : 0.9;
            const spanWeight = WING_FLAP_ROOT_WEIGHT + (1 - WING_FLAP_ROOT_WEIGHT) * p.wingCoord;
            /** 0 �?贴身平行�? �?垂直于躯干（翅尖�?90°）�?*/
            const envelope = 0.5 + 0.5 * Math.sin(flapPhase);
            const flapAngle =
                WING_FLAP_TIP_SPAN_RAD * amp * wingStrength * spanWeight * envelope;
            const ripple =
                Math.sin(flapPhase * 2 - p.wingCoord * 2.8) *
                WING_FLAP_TIP_SPAN_RAD *
                0.07 *
                amp *
                wingStrength *
                spanWeight;
            const hingeX = p.side * (p.part === 1 ? HINGE_FORE_X : HINGE_HIND_X);
            const hingeZ = p.part === 1 ? HINGE_FORE_Z : HINGE_HIND_Z;
            const angle = p.side * (flapAngle + ripple);
            const c = Math.cos(angle);
            const s = Math.sin(angle);
            const relX = lx - hingeX;
            const relZ = lz - hingeZ;
            lx = hingeX + relX * c - relZ * s;
            lz = hingeZ + relX * s + relZ * c;
        }
        if (p.part === 0) {
            ly += bodyBobOffset(effectTime, p, 1);
        } else if (p.part === 3) {
            ly += bodyBobOffset(effectTime, p, 0.55);
        } else if (p.part === 4) {
            ly += bodyBobOffset(effectTime, p, 0.45);
        }
        const jitter = particleJitterOffset(effectTime, flapPhase, p);
        lx += jitter.dx;
        ly += jitter.dy;
        lz += jitter.dz;
        outX[i] = lx;
        outY[i] = ly;
        outZ[i] = lz;
    }
}

function createButterflyBillboardMaterial(uniqueName: string): ShaderMaterial {
    const material = new ShaderMaterial();
    material.cull = CULLFACE_NONE;
    material.blendType = BLEND_ADDITIVE;
    material.depthWrite = false;
    material.depthTest = false;
    material.shaderDesc = {
        uniqueName,
        vertexGLSL: shaderGLSL,
        fragmentGLSL: fragmentShaderGLSL,
        attributes: {
            vertex_position: SEMANTIC_POSITION,
            corner: SEMANTIC_TEXCOORD0,
            aPhase: SEMANTIC_TEXCOORD1,
            aColorMix: SEMANTIC_TEXCOORD2,
            aWeight: SEMANTIC_TEXCOORD3
        }
    };
    material.update();
    return material;
}

function buildButterflyBodyMesh(
    device: AppBase['graphicsDevice'],
    x: Float32Array,
    y: Float32Array,
    z: Float32Array,
    phases: Float32Array,
    colorMix: Float32Array
): Mesh | null {
    const n = x.length;
    if (n < 1) {
        return null;
    }
    const vertCount = n * 4;
    const positions = new Float32Array(vertCount * 3);
    const corners = new Float32Array(vertCount * 2);
    const phaseAttr = new Float32Array(vertCount);
    const mixAttr = new Float32Array(vertCount);
    const weightAttr = new Float32Array(vertCount);
    const indices = new Uint32Array(n * 6);

    for (let i = 0; i < n; i++) {
        const base = i * 4;
        for (let c = 0; c < 4; c++) {
            const vi = base + c;
            positions[vi * 3] = x[i];
            positions[vi * 3 + 1] = y[i];
            positions[vi * 3 + 2] = z[i];
            corners[vi * 2] = QUAD_CORNERS[c][0];
            corners[vi * 2 + 1] = QUAD_CORNERS[c][1];
            phaseAttr[vi] = phases[i];
            mixAttr[vi] = colorMix[i];
            weightAttr[vi] = 1;
        }
        indices[i * 6] = base;
        indices[i * 6 + 1] = base + 1;
        indices[i * 6 + 2] = base + 2;
        indices[i * 6 + 3] = base;
        indices[i * 6 + 4] = base + 2;
        indices[i * 6 + 5] = base + 3;
    }

    const mesh = new Mesh(device);
    mesh.setPositions(positions);
    mesh.setUvs(0, corners, 2);
    mesh.setVertexStream(SEMANTIC_TEXCOORD1, phaseAttr, 1);
    mesh.setVertexStream(SEMANTIC_TEXCOORD2, mixAttr, 1);
    mesh.setVertexStream(SEMANTIC_TEXCOORD3, weightAttr, 1);
    mesh.setIndices(indices);
    mesh.update(PRIMITIVE_TRIANGLES);
    return mesh;
}

/** 脚本初始属性默认值（�?settings `effectParams` 未指定时一致） */
export const BUTTERFLY_PARTICLE_DEFAULTS = {
    center: [0, 0, 0] as [number, number, number],
    pointSize: 0.004,
    twinkleSpeed: 4.5,
    twinkleMin: 0,
    twinkleSharpness: 3,
    brightness: 2.2,
    baseColor: [0.28, 0.52, 0.98] as [number, number, number],
    cycleColor1: [22 / 255, 184 / 255, 156 / 255] as [number, number, number],
    cycleColor2: [91 / 255, 114 / 255, 164 / 255] as [number, number, number],
    colorCycleEnabled: false,
    colorCycleSpeed: 1,
    sparkleTrailStrength: 1,
    gsLightEnabled: true,
    gsLightIntensity: 1,
    gsLightRange: 5,
    gsLightColor: [1, 1, 1] as [number, number, number]
} as const;

/**
 * 琉光飞蝶：相机前�?billboard 蝴蝶 + 移动拖尾光屑 + 可选点光源（不�?gsplat shader composer）�?
 */
class GsplatPersistentButterflyParticle extends Script {
    static scriptName = 'gsplatPersistentButterflyParticle';

    effectTime = 0;
    isPaused = false;
    center = new Vec3(...BUTTERFLY_PARTICLE_DEFAULTS.center);
    pointSize = BUTTERFLY_PARTICLE_DEFAULTS.pointSize;
    twinkleSpeed = BUTTERFLY_PARTICLE_DEFAULTS.twinkleSpeed;
    twinkleMin = BUTTERFLY_PARTICLE_DEFAULTS.twinkleMin;
    twinkleSharpness = BUTTERFLY_PARTICLE_DEFAULTS.twinkleSharpness;
    brightness = BUTTERFLY_PARTICLE_DEFAULTS.brightness;
    baseColor = new Color(...BUTTERFLY_PARTICLE_DEFAULTS.baseColor);
    cycleColor1 = new Color(...BUTTERFLY_PARTICLE_DEFAULTS.cycleColor1);
    cycleColor2 = new Color(...BUTTERFLY_PARTICLE_DEFAULTS.cycleColor2);
    colorCycleEnabled = BUTTERFLY_PARTICLE_DEFAULTS.colorCycleEnabled;
    colorCycleSpeed = BUTTERFLY_PARTICLE_DEFAULTS.colorCycleSpeed;
    sparkleTrailStrength = BUTTERFLY_PARTICLE_DEFAULTS.sparkleTrailStrength;
    gsLightEnabled = BUTTERFLY_PARTICLE_DEFAULTS.gsLightEnabled;
    gsLightIntensity = BUTTERFLY_PARTICLE_DEFAULTS.gsLightIntensity;
    gsLightRange = BUTTERFLY_PARTICLE_DEFAULTS.gsLightRange;
    gsLightColor = new Color(...BUTTERFLY_PARTICLE_DEFAULTS.gsLightColor);

    private overlayEntity: Entity | null = null;
    private sparkleTrailEntity: Entity | null = null;
    private gsLightEntity: Entity | null = null;
    private butterflyMaterial: ShaderMaterial | null = null;
    private sparkleTrailMaterial: ShaderMaterial | null = null;
    private butterflyMesh: Mesh | null = null;
    private sparkleTrailMesh: Mesh | null = null;
    private sparkleTrailMeshInstance: MeshInstance | null = null;
    private template: ButterflyParticle[] = [];
    private animX = new Float32Array(0);
    private animY = new Float32Array(0);
    private animZ = new Float32Array(0);
    private phases = new Float32Array(0);
    private colorMix = new Float32Array(0);
    private flapPhase = 0;
    /** 0 = idle 扇翅�? = 满速移动扇翅；按键开始缓升、停止缓降�?*/
    private moveFlapBlend = 0;
    private currentWingFlapSpeed = WING_FLAP_IDLE_SPEED;
    /** 1 = 翅尖完整 90° 行程（平行躯�?�?垂直躯干）�?*/
    private currentWingFlapAmplitude = WING_FLAP_IDLE_AMP;
    private worldPos = new Vec3();
    /** 相机近乎垂直俯视时沿用上次的水平视线方向�?*/
    private readonly lastFlatCamFwd = new Vec3(0, 0, -1);
    /** 「正前方」水平朝向（offset=0）；重置时与当前相机水平视线对齐�?*/
    private headForwardYawRef = 0;
    private headForwardYawRefActive = false;
    /** A/D 驱动的左右偏角（弧度）�?*/
    private headYawOffset = 0;
    /** 当前鼠标拖拽会话内累计偏角（自按下起总量 �?40°）�?*/
    private mouseDragYawOffset = 0;
    private mouseDragActive = false;
    private mouseDragStartCamYaw = 0;
    private prevCamYawForHead = 0;
    private prevCamYawForHeadValid = false;
    private readonly prevFrameButterflyPos = new Vec3();
    private readonly prevFrameCamPos = new Vec3();
    private sparkleParticles: SparkleParticle[] = [];
    private sparkleHasPrevFrame = false;
    private mounted = false;
    private cameraEntity: Entity | null = null;
    private cachedPointSize = -1;
    private readonly _cameraPos = new Vec3();
    private meshPositionScratch = new Float32Array(0);

    initialize() {
        this.effectTime = 0;
        this.template = generateButterflyParticles();
        const n = this.template.length;
        this.meshPositionScratch = new Float32Array(Math.max(1, n * 4 * 3));
        this.animX = new Float32Array(n);
        this.animY = new Float32Array(n);
        this.animZ = new Float32Array(n);
        this.phases = new Float32Array(n);
        this.colorMix = new Float32Array(n);
        for (let i = 0; i < n; i++) {
            this.phases[i] = this.template[i].phase;
            this.colorMix[i] = this.template[i].colorMix;
        }

        this.on('enable', () => {
            this.effectTime = 0;
            syncButterflyRenderLayer(this.app as AppBase);
            this.resetMotionState();
            this.mountOverlay();
        });
        this.on('disable', () => this.destroyOverlay());
        if (this.enabled) {
            syncButterflyRenderLayer(this.app as AppBase);
            this.resetMotionState();
            this.mountOverlay();
        }
    }

    update(dt: number) {
        if (!this.enabled) {
            return;
        }
        syncButterflyRenderLayer(this.app as AppBase);

        if (!this.mounted) {
            this.mountOverlay();
            return;
        }

        this.updateCameraFollow(dt);
        this.updateMovementWingFlap(dt);
        this.syncGsLight();
        if (!this.isPaused) {
            this.effectTime += dt;
            this.flapPhase += dt * this.currentWingFlapSpeed;
            this.updateMeshPositions();
            this.updateSparkleTrail(dt);
        } else {
            this.syncSparkleTrailPrevFrame();
        }
        this.pushUniforms();
    }

    destroy() {
        this.destroyOverlay();
    }

    requestRebuild() {
        this.destroyOverlay();
        if (this.enabled) {
            this.resetMotionState();
            this.mountOverlay();
        }
    }

    private resetMotionState() {
        this.sparkleParticles = [];
        this.sparkleHasPrevFrame = false;
        this.moveFlapBlend = 0;
        this.currentWingFlapSpeed = WING_FLAP_IDLE_SPEED;
        this.currentWingFlapAmplitude = WING_FLAP_IDLE_AMP;
        this.headForwardYawRefActive = false;
        this.headYawOffset = 0;
        this.mouseDragYawOffset = 0;
        this.mouseDragActive = false;
        this.prevCamYawForHeadValid = false;
        this.updateCameraFollow(0);
        this.prevFrameButterflyPos.copy(this.worldPos);
        const cam = this.resolveCameraEntity();
        if (cam) {
            this.prevFrameCamPos.copy(cam.getPosition());
        }
        this.rebuildSparkleMesh();
    }

    private updateCameraFollow(dt: number) {
        const cam = this.resolveCameraEntity();
        const camFwdForYaw = _camFwd;
        if (!cam) {
            this.worldPos.copy(this.center);
            camFwdForYaw.set(0, 0, -1);
        } else {
            const wt = cam.getWorldTransform();
            wt.getTranslation(_camPos);
            camFwdForYaw.set(-wt.data[8], -wt.data[9], -wt.data[10]);
            _camUp.set(wt.data[4], wt.data[5], wt.data[6]);
            _spawnFwd.copy(camFwdForYaw).mulScalar(CAMERA_FOLLOW_DISTANCE);
            const screenDown = CAMERA_FOLLOW_DISTANCE * CAMERA_SCREEN_DOWN_RATIO;
            this.worldPos.copy(_camPos).add(_spawnFwd).addScaled(_camUp, -screenDown);
        }

        this.updateButterflyHeadYaw(camFwdForYaw, dt);

        if (this.overlayEntity) {
            worldPointToOverlayLocal(this.entity, this.worldPos, _worldPos);
            this.overlayEntity.setLocalPosition(_worldPos.x, _worldPos.y, _worldPos.z);
            worldRotToOverlayLocal(this.entity, _butterflyWorldOrient, _orient);
            this.overlayEntity.setLocalRotation(_orient);
        }
    }

    private updateButterflyHeadYaw(camFwd: Vec3, dt: number) {
        updateLastFlatCamFwd(camFwd, this.lastFlatCamFwd, _flatCamFwd);
        const camYaw = Math.atan2(_flatCamFwd.x, _flatCamFwd.z);
        if (!this.headForwardYawRefActive) {
            this.headForwardYawRef = camYaw;
            this.headYawOffset = 0;
            this.mouseDragYawOffset = 0;
            this.mouseDragActive = false;
            this.headForwardYawRefActive = true;
            this.prevCamYawForHead = camYaw;
            this.prevCamYawForHeadValid = true;
        }

        let dCamYaw = 0;
        if (this.prevCamYawForHeadValid) {
            dCamYaw = normalizeAngleRad(camYaw - this.prevCamYawForHead);
        }
        this.prevCamYawForHead = camYaw;
        this.prevCamYawForHeadValid = true;
        const camRotating = Math.abs(dCamYaw) > 1e-4;

        const limit = BUTTERFLY_HEAD_YAW_LIMIT_RAD;
        const strafe = this.readAdKeyAxis();
        const viewDragHeld = this.isViewRotateDragHeld();

        if (strafe !== 0 && dt > 0) {
            this.headYawOffset += strafe * BUTTERFLY_AD_HEAD_YAW_SPEED * dt;
            this.headYawOffset = Math.max(-limit, Math.min(limit, this.headYawOffset));
        } else if (dt > 0 && !viewDragHeld) {
            this.headYawOffset = smoothExpToward(
                this.headYawOffset,
                0,
                dt,
                BUTTERFLY_HEAD_YAW_RETURN_RATE
            );
        }

        let butterflyYaw: number;

        if (viewDragHeld) {
            if (!this.mouseDragActive) {
                this.mouseDragActive = true;
                this.mouseDragStartCamYaw = camYaw;
                this.mouseDragYawOffset = 0;
            }
            const dragTotal = normalizeAngleRad(camYaw - this.mouseDragStartCamYaw);
            this.mouseDragYawOffset = Math.max(-limit, Math.min(limit, dragTotal));
            const combinedOffset = Math.max(
                -limit,
                Math.min(limit, this.mouseDragYawOffset + this.headYawOffset)
            );
            butterflyYaw = camYaw + combinedOffset;
        } else {
            if (this.mouseDragActive) {
                this.mouseDragActive = false;
            }
            if (dt > 0) {
                this.mouseDragYawOffset = smoothExpToward(
                    this.mouseDragYawOffset,
                    0,
                    dt,
                    BUTTERFLY_HEAD_YAW_RETURN_RATE
                );
            }
            if (Math.abs(this.mouseDragYawOffset) > 1e-4) {
                butterflyYaw = camYaw + this.mouseDragYawOffset + this.headYawOffset;
            } else {
                butterflyYaw = this.headForwardYawRef + this.headYawOffset;
            }

            const fullyRecentered =
                !camRotating &&
                strafe === 0 &&
                Math.abs(this.headYawOffset) < 0.002 &&
                Math.abs(this.mouseDragYawOffset) < 0.002;
            if (fullyRecentered) {
                this.headYawOffset = 0;
                this.mouseDragYawOffset = 0;
                this.headForwardYawRef = camYaw;
                butterflyYaw = camYaw;
            }
        }

        _lookTarget.set(Math.sin(butterflyYaw), 0, Math.cos(butterflyYaw));
        computeButterflyWorldOrientFromFlatFwd(_lookTarget, _butterflyWorldOrient);
    }

    private isViewRotateDragHeld(): boolean {
        const canvas = this.app.graphicsDevice.canvas as HTMLCanvasElement | undefined;
        if (canvas && document.pointerLockElement === canvas) {
            return true;
        }
        const mouse = (this.app as AppWithExtras).mouse;
        if (!mouse) {
            return false;
        }
        return (
            mouse.isPressed(MOUSE_BUTTON_LEFT) && !mouse.isPressed(MOUSE_BUTTON_RIGHT)
        );
    }

    private readAdKeyAxis(): number {
        const keyboard = (this.app as AppWithExtras).keyboard;
        if (!keyboard) {
            return 0;
        }
        const left =
            keyboard.isPressed(KEY_CODE_A) || keyboard.isPressed(KEY_CODE_LEFT) ? 1 : 0;
        const right =
            keyboard.isPressed(KEY_CODE_D) || keyboard.isPressed(KEY_CODE_RIGHT) ? 1 : 0;
        return left - right;
    }

    private readMotionDeltas(): { butterflyDelta: number; camDelta: number } {
        const cam = this.resolveCameraEntity();
        if (cam) {
            cam.getWorldTransform().getTranslation(this._cameraPos);
        }
        const camPos = cam ? this._cameraPos : null;
        const butterflyDelta = this.sparkleHasPrevFrame
            ? this.prevFrameButterflyPos.distance(this.worldPos)
            : 0;
        const camDelta =
            camPos && this.sparkleHasPrevFrame
                ? this.prevFrameCamPos.distance(camPos)
                : 0;
        return { butterflyDelta, camDelta };
    }

    private updateMovementWingFlap(dt: number) {
        const { butterflyDelta, camDelta } = this.readMotionDeltas();
        const isMoving =
            butterflyDelta > WING_FLAP_MOVE_EPS || camDelta > WING_FLAP_MOVE_EPS;
        const targetBlend = isMoving ? 1 : 0;
        const rate = isMoving ? WING_FLAP_BLEND_UP_RATE : WING_FLAP_BLEND_DOWN_RATE;
        this.moveFlapBlend = smoothExpToward(this.moveFlapBlend, targetBlend, dt, rate);
        const b = this.moveFlapBlend;
        this.currentWingFlapSpeed = lerpScalar(WING_FLAP_IDLE_SPEED, WING_FLAP_MOVE_SPEED, b);
        this.currentWingFlapAmplitude = lerpScalar(WING_FLAP_IDLE_AMP, WING_FLAP_MOVE_AMP, b);
    }

    private emitSparkleBurst(spawn: Vec3) {
        const scale = this.resolveButterflyMeshScale();
        const burst =
            SPARKLE_BURST_MIN +
            Math.floor(
                splatHash(this.effectTime * 17.3, spawn.x, spawn.z) *
                    (SPARKLE_BURST_MAX - SPARKLE_BURST_MIN + 1)
            );

        _sparkleBack.set(-this.lastFlatCamFwd.x, 0, -this.lastFlatCamFwd.z);
        const backLen = _sparkleBack.length();
        if (backLen > 1e-4) {
            _sparkleBack.mulScalar(1 / backLen);
        } else {
            _sparkleBack.set(0, 0, 1);
        }
        _sparkleRight.set(-_sparkleBack.z, 0, _sparkleBack.x);

        const backMax = SPARKLE_TAIL_BACK_MAX * scale;
        const lateralHalf = FORE_WING_SPAN * SPARKLE_TAIL_LATERAL * scale;
        const vertHalf = SPARKLE_TAIL_VERT * scale;

        for (let i = 0; i < burst; i++) {
            if (this.sparkleParticles.length >= SPARKLE_MAX) {
                this.sparkleParticles.shift();
            }
            const seed = this.sparkleParticles.length + i * 13.7 + this.effectTime * 41;
            const behindT = splatHash(seed, 1, 0);
            const behind = behindT * backMax;
            const widthScale = Math.max(0.06, 1 - SPARKLE_TAIL_TAPER * behindT);
            const lateral = (splatHash(0, seed, 1) - 0.5) * 2 * lateralHalf * widthScale;
            const vert = (splatHash(1, 0, seed) - 0.5) * 2 * vertHalf * widthScale;
            const lift = (splatHash(seed, 2, 1) - 0.5) * 0.03 * scale * widthScale;

            this.sparkleParticles.push({
                x: spawn.x + _sparkleBack.x * behind + _sparkleRight.x * lateral,
                y: spawn.y + vert + lift,
                z: spawn.z + _sparkleBack.z * behind + _sparkleRight.z * lateral,
                vx: (splatHash(seed, 3, 4) - 0.5) * SPARKLE_DRIFT * scale * widthScale,
                vy: (splatHash(4, seed, 3) - 0.35) * 0.07 * scale,
                vz: (splatHash(3, 4, seed) - 0.5) * SPARKLE_DRIFT * scale * widthScale,
                age: splatHash(seed, 5, 6) * 0.08,
                phase: splatHash(seed, 6, 7) * Math.PI * 2,
                colorMix: 0.5 + splatHash(seed, 7, 8) * 0.45,
                behindT
            });
        }
    }

    private syncSparkleTrailPrevFrame() {
        this.prevFrameButterflyPos.copy(this.worldPos);
        const cam = this.resolveCameraEntity();
        if (cam) {
            cam.getWorldTransform().getTranslation(this.prevFrameCamPos);
        }
        this.sparkleHasPrevFrame = true;
    }

    private updateSparkleTrail(dt: number) {
        const cam = this.resolveCameraEntity();
        let camPos: Vec3 | null = null;
        if (cam) {
            cam.getWorldTransform().getTranslation(this._cameraPos);
            camPos = this._cameraPos;
        }
        const scale = this.resolveButterflyMeshScale();
        const emitDist = SPARKLE_EMIT_DIST * Math.max(0.35, scale);

        let { butterflyDelta, camDelta } = this.readMotionDeltas();
        if (!this.sparkleHasPrevFrame) {
            butterflyDelta = 1;
            camDelta = 1;
        }
        const isMoving =
            !this.sparkleHasPrevFrame || butterflyDelta > 1e-6 || camDelta > 1e-6;

        if (isMoving) {
            const travel = Math.max(butterflyDelta, camDelta);
            const steps = Math.max(
                1,
                Math.min(SPARKLE_PATH_STEPS_MAX, Math.ceil(travel / emitDist))
            );
            for (let s = 0; s < steps; s++) {
                if (this.sparkleHasPrevFrame && steps > 1) {
                    const t = (s + 0.5) / steps;
                    _worldPos.lerp(this.prevFrameButterflyPos, this.worldPos, t);
                } else {
                    _worldPos.copy(this.worldPos);
                }
                this.emitSparkleBurst(_worldPos);
            }
        }

        this.prevFrameButterflyPos.copy(this.worldPos);
        if (camPos) {
            this.prevFrameCamPos.copy(camPos);
        }
        this.sparkleHasPrevFrame = true;

        const gravity = SPARKLE_GRAVITY * Math.max(0.4, scale);
        for (let i = this.sparkleParticles.length - 1; i >= 0; i--) {
            const p = this.sparkleParticles[i];
            p.age += dt;
            if (p.age >= SPARKLE_LIFETIME) {
                this.sparkleParticles.splice(i, 1);
                continue;
            }
            p.vy -= gravity * dt;
            p.x += p.vx * dt;
            p.y += p.vy * dt;
            p.z += p.vz * dt;
            p.vx *= 0.985;
            p.vz *= 0.985;
        }

        this.rebuildSparkleMesh();
    }

    private rebuildSparkleMesh() {
        const overlay = this.overlayEntity;
        if (!overlay) {
            return;
        }

        const render = this.sparkleTrailEntity?.render;
        const n = this.sparkleParticles.length;
        if (n === 0) {
            if (render) {
                render.meshInstances = [];
            }
            this.sparkleTrailMeshInstance = null;
            return;
        }

        _invWorld.copy(overlay.getWorldTransform()).invert();
        const positions = new Float32Array(n * 4 * 3);
        const corners = new Float32Array(n * 4 * 2);
        const phaseAttr = new Float32Array(n * 4);
        const mixAttr = new Float32Array(n * 4);
        const weightAttr = new Float32Array(n * 4);
        const indices = new Uint32Array(n * 6);
        const lifeInv = 1 / SPARKLE_LIFETIME;

        for (let i = 0; i < n; i++) {
            const p = this.sparkleParticles[i];
            const ageT = Math.min(1, p.age * lifeInv);
            const tailTaper = Math.max(0.08, 1 - SPARKLE_TAIL_TAPER * p.behindT);
            const sizeScale = (1 - ageT * 0.62) * (0.42 + 0.58 * tailTaper);
            const fade =
                (1 - ageT * ageT * (0.55 + 0.45 * p.behindT)) *
                this.sparkleTrailStrength *
                (0.55 + 0.45 * tailTaper);
            _worldPos.set(p.x, p.y, p.z);
            _invWorld.transformPoint(_worldPos, _worldPos);
            const base = i * 4;
            for (let c = 0; c < 4; c++) {
                const vi = base + c;
                positions[vi * 3] = _worldPos.x;
                positions[vi * 3 + 1] = _worldPos.y;
                positions[vi * 3 + 2] = _worldPos.z;
                corners[vi * 2] = QUAD_CORNERS[c][0] * sizeScale;
                corners[vi * 2 + 1] = QUAD_CORNERS[c][1] * sizeScale;
                phaseAttr[vi] = this.effectTime * 8 + p.phase;
                mixAttr[vi] = p.colorMix;
                weightAttr[vi] = fade;
            }
            indices[i * 6] = base;
            indices[i * 6 + 1] = base + 1;
            indices[i * 6 + 2] = base + 2;
            indices[i * 6 + 3] = base;
            indices[i * 6 + 4] = base + 2;
            indices[i * 6 + 5] = base + 3;
        }

        const device = (this.app as AppBase).graphicsDevice;
        if (!this.sparkleTrailMesh) {
            this.sparkleTrailMesh = new Mesh(device);
            this.sparkleTrailMeshInstance = null;
        }

        this.sparkleTrailMesh.setPositions(positions);
        this.sparkleTrailMesh.setUvs(0, corners, 2);
        this.sparkleTrailMesh.setVertexStream(SEMANTIC_TEXCOORD1, phaseAttr, 1);
        this.sparkleTrailMesh.setVertexStream(SEMANTIC_TEXCOORD2, mixAttr, 1);
        this.sparkleTrailMesh.setVertexStream(SEMANTIC_TEXCOORD3, weightAttr, 1);
        this.sparkleTrailMesh.setIndices(indices);
        this.sparkleTrailMesh.update(PRIMITIVE_TRIANGLES);

        if (render) {
            this.ensureSparkleTrailMeshInstance(render);
        }
    }

    private ensureSparkleTrailMeshInstance(render: { meshInstances: MeshInstance[] }) {
        if (!this.sparkleTrailMesh || !this.sparkleTrailMaterial) {
            return;
        }
        if (!this.sparkleTrailMeshInstance) {
            this.sparkleTrailMeshInstance = new MeshInstance(
                this.sparkleTrailMesh,
                this.sparkleTrailMaterial
            );
            this.sparkleTrailMeshInstance.cull = false;
        } else {
            this.sparkleTrailMeshInstance.mesh = this.sparkleTrailMesh;
        }
        if (render.meshInstances[0] !== this.sparkleTrailMeshInstance) {
            render.meshInstances = [this.sparkleTrailMeshInstance];
        }
    }

    private updateMeshPositions() {
        if (!this.butterflyMesh || this.template.length === 0) {
            return;
        }
        applyWingFlap(
            this.template,
            this.flapPhase,
            this.currentWingFlapAmplitude,
            this.effectTime,
            this.animX,
            this.animY,
            this.animZ
        );
        const n = this.template.length;
        const vertCount = n * 4;
        const needLen = vertCount * 3;
        if (this.meshPositionScratch.length < needLen) {
            this.meshPositionScratch = new Float32Array(needLen);
        }
        const positions = this.meshPositionScratch;
        for (let i = 0; i < n; i++) {
            const base = i * 4;
            for (let c = 0; c < 4; c++) {
                const vi = base + c;
                positions[vi * 3] = this.animX[i];
                positions[vi * 3 + 1] = this.animY[i];
                positions[vi * 3 + 2] = this.animZ[i];
            }
        }
        this.butterflyMesh.setPositions(positions);
        this.butterflyMesh.update(PRIMITIVE_TRIANGLES);
    }

    private resolveCameraEntity(): Entity | null {
        if (this.cameraEntity) {
            return this.cameraEntity;
        }
        const global = (this.app as AppWithExtras).__global;
        if (global?.camera) {
            this.cameraEntity = global.camera;
            return this.cameraEntity;
        }
        const cameras = this.app.root.findComponents('camera') as Array<{ entity?: Entity }>;
        this.cameraEntity = cameras[0]?.entity ?? null;
        return this.cameraEntity;
    }

    private resolveEffectivePointSize(): number {
        const radius = readSceneBboxRadius(this.entity.gsplat as GsplatBboxSource);
        return (
            this.pointSize *
            Math.max(0.6, Math.min(3.5, radius / SCENE_REF_RADIUS)) *
            BUTTERFLY_SIZE_SCALE
        );
    }

    private resolveButterflyMeshScale(): number {
        const radius = readSceneBboxRadius(this.entity.gsplat as GsplatBboxSource);
        return (
            Math.max(0.12, Math.min(2.5, (radius / SCENE_REF_RADIUS) * 0.4)) * BUTTERFLY_SIZE_SCALE
        );
    }

    private resolveGsLightRange(): number {
        const radius = readSceneBboxRadius(this.entity.gsplat as GsplatBboxSource);
        const scale = Math.max(0.5, Math.min(2.5, radius / SCENE_REF_RADIUS));
        return Math.max(0.25, this.gsLightRange * scale);
    }

    private mountGsLight(overlay: Entity): void {
        if (this.gsLightEntity) {
            return;
        }
        const lightEnt = new Entity(GS_LIGHT_NAME);
        lightEnt.addComponent('light', {
            type: 'point',
            color: new Color(this.gsLightColor.r, this.gsLightColor.g, this.gsLightColor.b),
            intensity: this.gsLightIntensity,
            castShadows: false,
            range: this.resolveGsLightRange()
        });
        lightEnt.tags.add('butterflyGsLight');
        overlay.addChild(lightEnt);
        lightEnt.setLocalPosition(0, 0, 0);
        this.gsLightEntity = lightEnt;
        this.syncGsLight();
    }

    private syncGsLight(): void {
        const ent = this.gsLightEntity;
        if (!ent?.light) {
            return;
        }
        ent.light.enabled = this.gsLightEnabled;
        ent.light.intensity = Math.max(0, this.gsLightIntensity);
        ent.light.color.set(this.gsLightColor.r, this.gsLightColor.g, this.gsLightColor.b);
        (ent.light as { range?: number }).range = this.resolveGsLightRange();
    }

    private pushUniforms() {
        const size = this.resolveEffectivePointSize();
        const cam = this.resolveCameraEntity();
        const camPosArr = cam
            ? (this._cameraPos.copy(cam.getPosition()),
              [this._cameraPos.x, this._cameraPos.y, this._cameraPos.z] as [number, number, number])
            : null;

        const colorA = [this.baseColor.r, this.baseColor.g, this.baseColor.b] as [number, number, number];
        const colorB = [this.cycleColor1.r, this.cycleColor1.g, this.cycleColor1.b] as [
            number,
            number,
            number
        ];
        const colorC = [this.cycleColor2.r, this.cycleColor2.g, this.cycleColor2.b] as [
            number,
            number,
            number
        ];

        const applyTo = (
            material: ShaderMaterial | null,
            trailMode: number,
            twinkleMul: number,
            brightnessMul: number
        ) => {
            if (!material) {
                return;
            }
            material.setParameter('uTime', this.effectTime);
            material.setParameter('uTwinkleSpeed', this.twinkleSpeed * twinkleMul);
            material.setParameter('uTwinkleMin', trailMode > 0.5 ? 0 : this.twinkleMin);
            material.setParameter('uTwinkleSharpness', this.twinkleSharpness * (trailMode > 0.5 ? 1.12 : 1));
            material.setParameter('uBrightness', this.brightness * brightnessMul);
            material.setParameter('uColorA', colorA);
            material.setParameter('uColorB', colorB);
            material.setParameter('uColorC', colorC);
            material.setParameter('uColorCycle', this.colorCycleEnabled ? 1 : 0);
            material.setParameter('uColorCycleSpeed', Math.max(0, this.colorCycleSpeed));
            material.setParameter('uTrailFade', 1);
            material.setParameter('uTrailMode', trailMode);
            material.setParameter('uPointSize', size);
            material.setParameter('uViewBias', Math.max(0.001, size * 0.06));
            if (camPosArr) {
                material.setParameter('uCameraPos', camPosArr);
            }
        };

        applyTo(this.butterflyMaterial, 0, 1, 1);
        applyTo(this.sparkleTrailMaterial, 1, 1.25, 1.05);
        if (size !== this.cachedPointSize) {
            this.cachedPointSize = size;
        }
    }

    private mountOverlay() {
        const app = this.app as AppBase;

        applyWingFlap(this.template, 0, this.currentWingFlapAmplitude, 0, this.animX, this.animY, this.animZ);

        const mesh = buildButterflyBodyMesh(
            app.graphicsDevice,
            this.animX,
            this.animY,
            this.animZ,
            this.phases,
            this.colorMix
        );
        if (!mesh) {
            return;
        }
        const material = createButterflyBillboardMaterial('butterflyParticleBillboard');
        const instance = new MeshInstance(mesh, material);
        instance.cull = false;

        const overlay = new Entity(OVERLAY_ROOT_NAME);
        overlay.addComponent('render', {
            meshInstances: [instance],
            layers: [syncButterflyRenderLayer(app)],
            castShadows: false
        });

        const sparkleTrail = new Entity(SPARKLE_TRAIL_ROOT_NAME);
        this.sparkleTrailMaterial = createButterflyBillboardMaterial('butterflySparkleTrailBillboard');
        sparkleTrail.addComponent('render', {
            meshInstances: [],
            layers: [syncButterflyRenderLayer(app)],
            castShadows: false
        });
        overlay.addChild(sparkleTrail);

        this.mountGsLight(overlay);

        this.entity.addChild(overlay);
        this.overlayEntity = overlay;
        this.sparkleTrailEntity = sparkleTrail;
        this.butterflyMaterial = material;
        this.butterflyMesh = mesh;
        this.sparkleTrailMesh = null;
        this.mounted = true;

        const scale = this.resolveButterflyMeshScale();
        overlay.setLocalScale(scale, scale, scale);
        worldPointToOverlayLocal(this.entity, this.worldPos, _worldPos);
        overlay.setLocalPosition(_worldPos.x, _worldPos.y, _worldPos.z);

        this.pushUniforms();
        app.renderNextFrame = true;
    }

    private destroyOverlay() {
        this.mounted = false;
        this.butterflyMaterial = null;
        this.sparkleTrailMaterial = null;
        this.butterflyMesh = null;
        this.sparkleTrailMesh = null;
        this.sparkleTrailMeshInstance = null;
        this.sparkleParticles = [];
        this.sparkleHasPrevFrame = false;
        this.cachedPointSize = -1;
        this.cameraEntity = null;
        this.gsLightEntity = null;
        if (this.overlayEntity) {
            this.overlayEntity.destroy();
            this.overlayEntity = null;
            this.sparkleTrailEntity = null;
        }
    }
}

export { GsplatPersistentButterflyParticle };
