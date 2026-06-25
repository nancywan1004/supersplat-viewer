import { BoundingBox, Mat4, Vec3, type Entity } from 'playcanvas';

import { GsplatShaderEffect } from '../gsplat-shader-effect';

/** GLSL/WGSL 列主序 mat4（与 night-mode 一致） */
function mat4ToShaderArray(m: Mat4): number[] {
    const d = m.data;
    return [
        d[0], d[4], d[8], d[12],
        d[1], d[5], d[9], d[13],
        d[2], d[6], d[10], d[14],
        d[3], d[7], d[11], d[15]
    ];
}

export interface GsplatWobbleOptions {
    enabled?: boolean;
    continuousRender?: boolean;
    amplitude?: number;
    /**
     * @deprecated 已合并到 `amplitude`；若仅传此字段，会映射为 `amplitude = electronicYawAmplitude * 0.3`。
     */
    electronicYawAmplitude?: number;
    wobbleAxis?: 'x' | 'z';
    motionMode?: 'wobble' | 'electronic' | 'deepMeditation';
    frequency?: number;
    heightScale?: number;
    /** 弹跳峰值高度（世界单位），与模型 bbox 无关：jumpY = bounceShape × bounceAmplitude */
    bounceAmplitude?: number;
    bounceFrequency?: number;
    springOscillation?: number;
    springDamping?: number;
    springBlend?: number;
    /** 一次「连跳 N 下 + 扭」总时长（秒） */
    cycleDuration?: number;
    /** 单次弹跳时长（秒） */
    bounceDuration?: number;
    /** 每个周期连跳次数，默认 3 */
    bounceCount?: number;
    colorMix?: boolean;
    colorBandStart?: number;
    colorBandEnd?: number;
    goldColor?: [number, number, number];
    haloWidth?: number;
    haloSpeed?: number;
    haloOpacity?: number;
    /** 跳动时沿 Y 轴拉伸强度（0~1 推荐 0.2~0.5） */
    bounceStretch?: number;
    /**
     * 扭动时从视觉底部向上、占模型全高的固定比例 [0,1]（如 0.15 = 15%）。
     * 高斯数据 Y 轴倒置（local.y 大 = 靠下）；不影响跳动。
     */
    wobbleAnchorLift?: number;
    /** @deprecated 使用 wobbleAnchorLift */
    anchorLift?: number;
}

const DEFAULT_GOLD: [number, number, number] = [1.0, 0.85, 0.0];
const TAU = Math.PI * 2;

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform float uWobbleAmplitude;
uniform float uWobbleAxis;
uniform float uWobbleMotionMode;
uniform float uWobbleFrequency;
uniform float uWobbleHeightScale;
uniform float uWobbleBounceShape;
uniform float uWobbleStrength;
uniform float uWobbleLocalTime;
uniform float uWobbleColorMix;
uniform float uWobbleColorBandStart;
uniform float uWobbleColorBandEnd;
uniform vec3 uWobbleGoldColor;
uniform float uWobbleHaloWidth;
uniform float uWobbleHaloSpeed;
uniform float uWobbleHaloOpacity;
uniform float uWobbleBounceStretch;
uniform float uWobbleWorldSpace;
uniform mat4 uWobbleInvModelWorld;
uniform mat4 uWobbleModelWorld;
uniform float uWobbleMinRelLocal;
uniform float uWobbleWorldBottomY;
uniform float uWobbleWorldHeight;
uniform vec3 uWobbleWorldCenter;
uniform vec3 uWobbleLocalCenter;
uniform vec3 uWobbleLocalHalfExtents;

float wobbleHash13(vec3 p) {
    return fract(sin(dot(p, vec3(127.1, 311.7, 74.7))) * 43758.5453123);
}

mat2 wobbleRot2(float a) {
    float s = sin(a);
    float c = cos(a);
    return mat2(c, -s, s, c);
}

float wobbleSmoothstepAny(float edge0, float edge1, float x) {
    float t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

// 统一 UI「动作幅度」（uWobbleAmplitude）在不同动作模式下映射为不同强度区间。
// 校准：与 Electronic 共用同一滑条值时，扭动映射更柔和，避免位移过大。
float wobbleAmpWobble() {
    return uWobbleAmplitude * (1.0 / 3.0);
}

float wobbleAmpElectronic() {
    return min(max(uWobbleAmplitude / 0.3, 0.0), 4.0);
}

float wobbleAmpDeepMeditation() {
    return min(max(uWobbleAmplitude / 0.4, 0.0), 3.0);
}

void modifySplatCenter(inout vec3 center) {
    float b = uWobbleBounceShape;
    if (b > 0.001) {
        float sy = 1.0 + b * uWobbleBounceStretch;
        vec3 worldC = uWobbleWorldSpace > 0.5
            ? center
            : (uWobbleModelWorld * vec4(center, 1.0)).xyz;
        worldC.y = uWobbleWorldBottomY + (worldC.y - uWobbleWorldBottomY) * sy;
        center = uWobbleWorldSpace > 0.5
            ? worldC
            : (uWobbleInvModelWorld * vec4(worldC, 1.0)).xyz;
    }
    if (uWobbleStrength > 0.001) {
        vec3 worldC = uWobbleWorldSpace > 0.5
            ? center
            : (uWobbleModelWorld * vec4(center, 1.0)).xyz;
        float relHw = max(worldC.y - uWobbleWorldBottomY - uWobbleMinRelLocal, 0.0);
        float heightIntensity = relHw * uWobbleHeightScale;
        float wobblePhase = uWobbleLocalTime * uWobbleFrequency + relHw;
        vec3 localC = uWobbleWorldSpace > 0.5
            ? (uWobbleInvModelWorld * vec4(worldC, 1.0)).xyz
            : center;
        if (uWobbleMotionMode < 0.5) {
            float ampRand = mix(0.8, 1.2, wobbleHash13(localC * 17.0 + vec3(0.37, 1.79, 2.41)));
            float wave = sin(wobblePhase) * ampRand * uWobbleStrength;
            float offset = wave * wobbleAmpWobble() * heightIntensity;
            localC.x += offset * (1.0 - uWobbleAxis);
            localC.z += offset * uWobbleAxis;
        } else if (uWobbleMotionMode < 1.5) {
            float ampScale = wobbleAmpElectronic();
            float height01 = clamp((worldC.y - uWobbleWorldBottomY) / max(uWobbleWorldHeight, 0.001), 0.0, 1.0);
            float fixedHeight01 = clamp(uWobbleMinRelLocal / max(uWobbleWorldHeight, 0.001), 0.0, 0.95);
            float active01 = clamp((height01 - fixedHeight01) / max(1.0 - fixedHeight01, 0.001), 0.0, 1.0);
            float anchor = smoothstep(0.0, 0.18, active01);
            float upperBody = smoothstep(0.08, 0.85, active01);
            float phase = uWobbleLocalTime * max(uWobbleFrequency, 0.001) * 0.4;
            float side = sin(phase);
            float bow = 0.65 + 0.35 * sin(phase - 0.9);
            float motionMask = anchor * upperBody;
            vec3 yawWorldC = worldC;
            float yawAngle = 0.22 * side * ampScale * uWobbleStrength * motionMask;
            yawWorldC.xz = uWobbleWorldCenter.xz + wobbleRot2(yawAngle) * (yawWorldC.xz - uWobbleWorldCenter.xz);
            float bowAngle = -0.06 * bow * ampScale * uWobbleStrength * motionMask;
            vec2 bowPivot = vec2(uWobbleWorldBottomY + uWobbleWorldHeight * (fixedHeight01 + 0.18), uWobbleWorldCenter.z);
            yawWorldC.yz = wobbleRot2(bowAngle) * (yawWorldC.yz - bowPivot) + bowPivot;
            localC = (uWobbleInvModelWorld * vec4(yawWorldC, 1.0)).xyz;
        } else {
            float ampScale = wobbleAmpDeepMeditation();
            float b = sin(uWobbleLocalTime * 1.5) * ampScale * uWobbleStrength;
            vec3 halfExt = max(uWobbleLocalHalfExtents, vec3(0.001));
            float height01 = clamp((worldC.y - uWobbleWorldBottomY) / max(uWobbleWorldHeight, 0.001), 0.0, 1.0);
            vec3 refPos = (localC - uWobbleLocalCenter) / halfExt;
            refPos.y = mix(-1.0, -3.0, height01);
            vec3 refBase = refPos;
            float breathe = wobbleSmoothstepAny(-1.0, -3.0, refPos.y) * 0.15 * -b;
            mat2 rot = wobbleRot2(breathe);
            if (uWobbleAxis < 0.5) {
                refPos.xy = rot * refPos.xy;
                refPos.x += 0.3;
                refPos.y += 1.2;
                refPos *= 1.0 + exp(-3.0 * length(refPos)) * b;
                refPos.x -= 0.3;
                refPos.y -= 1.2;
            } else {
                refPos.yz = rot * refPos.yz;
                refPos.z += 0.3;
                refPos.y += 1.2;
                refPos *= 1.0 + exp(-3.0 * length(refPos)) * b;
                refPos.z -= 0.3;
                refPos.y -= 1.2;
            }
            localC += (refPos - refBase) * halfExt;
        }

        center = uWobbleWorldSpace > 0.5
            ? (uWobbleModelWorld * vec4(localC, 1.0)).xyz
            : localC;
    }
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float b = uWobbleBounceShape;
    if (b > 0.001) {
        vec3 worldC = uWobbleWorldSpace > 0.5
            ? originalCenter
            : (uWobbleModelWorld * vec4(originalCenter, 1.0)).xyz;
        float relH = max(worldC.y - uWobbleWorldBottomY, 0.0);
        float height01 = clamp(relH / max(uWobbleWorldHeight, 0.001), 0.0, 1.0);
        float stretchY = 1.0 + b * uWobbleBounceStretch * height01;
        float squashXZ = 1.0 / max(pow(stretchY, 0.4), 0.5);
        scale.y *= stretchY;
        scale.x *= squashXZ;
        scale.z *= squashXZ;
    }
}

float wobbleRelHeight(vec3 center) {
    vec3 worldC = uWobbleWorldSpace > 0.5
        ? center
        : (uWobbleModelWorld * vec4(center, 1.0)).xyz;
    return max(worldC.y - uWobbleWorldBottomY - uWobbleMinRelLocal, 0.0);
}

void modifySplatColor(vec3 center, inout vec4 clr) {
    float relH = wobbleRelHeight(center);
    float sineValue = abs(sin(uWobbleLocalTime * uWobbleHaloSpeed + relH));
    float activity = uWobbleStrength;
    float bandStart = max(0.0, 1.0 - uWobbleHaloWidth);
    float blend = smoothstep(bandStart, 1.0, sineValue) * uWobbleColorMix * uWobbleHaloOpacity * activity;
    clr.xyz = mix(clr.xyz, uWobbleGoldColor, blend);
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uWobbleAmplitude: f32;
uniform uWobbleAxis: f32;
uniform uWobbleMotionMode: f32;
uniform uWobbleFrequency: f32;
uniform uWobbleHeightScale: f32;
uniform uWobbleBounceShape: f32;
uniform uWobbleStrength: f32;
uniform uWobbleLocalTime: f32;
uniform uWobbleColorMix: f32;
uniform uWobbleColorBandStart: f32;
uniform uWobbleColorBandEnd: f32;
uniform uWobbleGoldColor: vec3f;
uniform uWobbleHaloWidth: f32;
uniform uWobbleHaloSpeed: f32;
uniform uWobbleHaloOpacity: f32;
uniform uWobbleBounceStretch: f32;
uniform uWobbleWorldSpace: f32;
uniform uWobbleInvModelWorld: mat4x4<f32>;
uniform uWobbleModelWorld: mat4x4<f32>;
uniform uWobbleMinRelLocal: f32;
uniform uWobbleWorldBottomY: f32;
uniform uWobbleWorldHeight: f32;
uniform uWobbleWorldCenter: vec3f;
uniform uWobbleLocalCenter: vec3f;
uniform uWobbleLocalHalfExtents: vec3f;

fn wobbleHash13(p: vec3f) -> f32 {
    return fract(sin(dot(p, vec3f(127.1, 311.7, 74.7))) * 43758.5453123);
}

fn wobbleRot2(v: vec2f, a: f32) -> vec2f {
    let s = sin(a);
    let c = cos(a);
    return vec2f(c * v.x - s * v.y, s * v.x + c * v.y);
}

fn wobbleSmoothstepAny(edge0: f32, edge1: f32, x: f32) -> f32 {
    let t = clamp((x - edge0) / (edge1 - edge0), 0.0, 1.0);
    return t * t * (3.0 - 2.0 * t);
}

fn wobbleAmpWobble() -> f32 {
    return uniform.uWobbleAmplitude * (1.0 / 3.0);
}

fn wobbleAmpElectronic() -> f32 {
    return min(max(uniform.uWobbleAmplitude / 0.3, 0.0), 4.0);
}

fn wobbleAmpDeepMeditation() -> f32 {
    return min(max(uniform.uWobbleAmplitude / 0.4, 0.0), 3.0);
}

fn wobbleRelHeight(center: vec3f) -> f32 {
    let worldC = select(
        (uniform.uWobbleModelWorld * vec4f(center, 1.0)).xyz,
        center,
        uniform.uWobbleWorldSpace > 0.5
    );
    return max(worldC.y - uniform.uWobbleWorldBottomY - uniform.uWobbleMinRelLocal, 0.0);
}

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let b = uniform.uWobbleBounceShape;
    if (b > 0.001) {
        let sy = 1.0 + b * uniform.uWobbleBounceStretch;
        var stretchWorldC = select(
            (uniform.uWobbleModelWorld * vec4f(*center, 1.0)).xyz,
            *center,
            uniform.uWobbleWorldSpace > 0.5
        );
        stretchWorldC.y = uniform.uWobbleWorldBottomY + (stretchWorldC.y - uniform.uWobbleWorldBottomY) * sy;
        *center = select(
            (uniform.uWobbleInvModelWorld * vec4f(stretchWorldC, 1.0)).xyz,
            stretchWorldC,
            uniform.uWobbleWorldSpace > 0.5
        );
    }
    if (uniform.uWobbleStrength > 0.001) {
        let worldC = select(
            (uniform.uWobbleModelWorld * vec4f(*center, 1.0)).xyz,
            *center,
            uniform.uWobbleWorldSpace > 0.5
        );
        let relHw = max(worldC.y - uniform.uWobbleWorldBottomY - uniform.uWobbleMinRelLocal, 0.0);
        let heightIntensity = relHw * uniform.uWobbleHeightScale;
        let wobblePhase = uniform.uWobbleLocalTime * uniform.uWobbleFrequency + relHw;
        var localC = select(
            *center,
            (uniform.uWobbleInvModelWorld * vec4f(worldC, 1.0)).xyz,
            uniform.uWobbleWorldSpace > 0.5
        );
        if (uniform.uWobbleMotionMode < 0.5) {
            let ampRand = mix(0.8, 1.2, wobbleHash13(localC * 17.0 + vec3f(0.37, 1.79, 2.41)));
            let wave = sin(wobblePhase) * ampRand * uniform.uWobbleStrength;
            let offset = wave * wobbleAmpWobble() * heightIntensity;
            localC.x += offset * (1.0 - uniform.uWobbleAxis);
            localC.z += offset * uniform.uWobbleAxis;
        } else if (uniform.uWobbleMotionMode < 1.5) {
            let ampScale = wobbleAmpElectronic();
            let height01 = clamp((worldC.y - uniform.uWobbleWorldBottomY) / max(uniform.uWobbleWorldHeight, 0.001), 0.0, 1.0);
            let fixedHeight01 = clamp(uniform.uWobbleMinRelLocal / max(uniform.uWobbleWorldHeight, 0.001), 0.0, 0.95);
            let active01 = clamp((height01 - fixedHeight01) / max(1.0 - fixedHeight01, 0.001), 0.0, 1.0);
            let anchor = smoothstep(0.0, 0.18, active01);
            let upperBody = smoothstep(0.08, 0.85, active01);
            let phase = uniform.uWobbleLocalTime * max(uniform.uWobbleFrequency, 0.001) * 0.4;
            let side = sin(phase);
            let bow = 0.65 + 0.35 * sin(phase - 0.9);
            let motionMask = anchor * upperBody;
            var yawWorldC = worldC;
            let yawAngle = 0.22 * side * ampScale * uniform.uWobbleStrength * motionMask;
            let yawXz = uniform.uWobbleWorldCenter.xz + wobbleRot2(yawWorldC.xz - uniform.uWobbleWorldCenter.xz, yawAngle);
            yawWorldC.x = yawXz.x;
            yawWorldC.z = yawXz.y;
            let bowAngle = -0.06 * bow * ampScale * uniform.uWobbleStrength * motionMask;
            let bowPivot = vec2f(
                uniform.uWobbleWorldBottomY + uniform.uWobbleWorldHeight * (fixedHeight01 + 0.18),
                uniform.uWobbleWorldCenter.z
            );
            let bowYz = wobbleRot2(yawWorldC.yz - bowPivot, bowAngle) + bowPivot;
            yawWorldC.y = bowYz.x;
            yawWorldC.z = bowYz.y;
            localC = (uniform.uWobbleInvModelWorld * vec4f(yawWorldC, 1.0)).xyz;
        } else {
            let ampScale = wobbleAmpDeepMeditation();
            let b = sin(uniform.uWobbleLocalTime * 1.5) * ampScale * uniform.uWobbleStrength;
            let halfExt = max(uniform.uWobbleLocalHalfExtents, vec3f(0.001));
            let height01 = clamp((worldC.y - uniform.uWobbleWorldBottomY) / max(uniform.uWobbleWorldHeight, 0.001), 0.0, 1.0);
            var refPos = (localC - uniform.uWobbleLocalCenter) / halfExt;
            refPos.y = mix(-1.0, -3.0, height01);
            let refBase = refPos;
            let breathe = wobbleSmoothstepAny(-1.0, -3.0, refPos.y) * 0.15 * -b;
            if (uniform.uWobbleAxis < 0.5) {
                let xy = wobbleRot2(refPos.xy, breathe);
                refPos.x = xy.x;
                refPos.y = xy.y;
                refPos.x += 0.3;
                refPos.y += 1.2;
                refPos *= 1.0 + exp(-3.0 * length(refPos)) * b;
                refPos.x -= 0.3;
                refPos.y -= 1.2;
            } else {
                let yz = wobbleRot2(refPos.yz, breathe);
                refPos.y = yz.x;
                refPos.z = yz.y;
                refPos.z += 0.3;
                refPos.y += 1.2;
                refPos *= 1.0 + exp(-3.0 * length(refPos)) * b;
                refPos.z -= 0.3;
                refPos.y -= 1.2;
            }
            localC += (refPos - refBase) * halfExt;
        }

        *center = select(
            localC,
            (uniform.uWobbleModelWorld * vec4f(localC, 1.0)).xyz,
            uniform.uWobbleWorldSpace > 0.5
        );
    }
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let b = uniform.uWobbleBounceShape;
    if (b > 0.001) {
        let worldC = select(
            (uniform.uWobbleModelWorld * vec4f(originalCenter, 1.0)).xyz,
            originalCenter,
            uniform.uWobbleWorldSpace > 0.5
        );
        let relH = max(worldC.y - uniform.uWobbleWorldBottomY, 0.0);
        let height01 = clamp(relH / max(uniform.uWobbleWorldHeight, 0.001), 0.0, 1.0);
        let stretchY = 1.0 + b * uniform.uWobbleBounceStretch * height01;
        let squashXZ = 1.0 / max(pow(stretchY, 0.4), 0.5);
        (*scale).y *= stretchY;
        (*scale).x *= squashXZ;
        (*scale).z *= squashXZ;
    }
}

fn modifySplatColor(center: vec3f, clr: ptr<function, vec4f>) {
    let relH = wobbleRelHeight(center);
    let sineValue = abs(sin(uniform.uWobbleLocalTime * uniform.uWobbleHaloSpeed + relH));
    let activity = uniform.uWobbleStrength;
    let bandStart = max(0.0, 1.0 - uniform.uWobbleHaloWidth);
    let blend = smoothstep(bandStart, 1.0, sineValue) *
        uniform.uWobbleColorMix * uniform.uWobbleHaloOpacity * activity;
    (*clr) = vec4f(mix((*clr).xyz, uniform.uWobbleGoldColor, blend), (*clr).a);
}
`;

export class GsplatWobbleEffect extends GsplatShaderEffect {
    static scriptName = 'gsplatWobbleEffect';

    amplitude = 0.7;

    wobbleAxis: 'x' | 'z' = 'x';

    motionMode: 'wobble' | 'electronic' | 'deepMeditation' = 'wobble';

    frequency = 5.0;

    heightScale = 0.2;

    /** 弹跳峰值高度（世界单位），所有物体共用 */
    bounceAmplitude = 0.6;

    /** @deprecated 仅兼容旧参数；节奏由 cycleDuration / bounceDuration 控制 */
    bounceFrequency = 4.5;

    /** 每个周期：连跳 bounceCount 次 → 扭（秒） */
    cycleDuration = 3.2;

    /** 单次弹跳时长（秒） */
    bounceDuration = 0.5;

    bounceCount = 3;

    springOscillation = 2.6;

    springDamping = 5.5;

    springBlend = 1.0;

    colorMix = true;

    colorBandStart = 0.9;

    colorBandEnd = 1.0;

    goldColor = [...DEFAULT_GOLD];

    haloWidth = 0.1;

    haloSpeed = 5.0;

    haloOpacity = 1.0;

    /** 跳动 Y 轴拉伸强度（实体 scale + 高斯 scale/center） */
    bounceStretch = 0.75;

    /** 扭动底端固定区：相对模型高度的比例，仅扭动阶段生效 */
    wobbleAnchorLift = 0.15;

    continuousRender = true;

    private _minRelLocal = 0;

    private readonly _modelWorld = new Mat4();

    private readonly _invModelWorld = new Mat4();

    private _savedAppAutoRender: boolean | undefined;

    private _autoRenderOverridden = false;

    private readonly _baseLocalPosition = new Vec3();

    private readonly _baseLocalScale = new Vec3(1, 1, 1);

    private _hasBaseLocalTransform = false;

    private readonly _localAabb = new BoundingBox(Vec3.ZERO, new Vec3(0.5, 0.5, 0.5));

    private readonly _worldAabb = new BoundingBox(Vec3.ZERO, new Vec3(0.5, 0.5, 0.5));

    private _worldBottomY = -0.5;

    private _worldHeight = 1.0;

    private _bounceAnchorResolved = false;

    /** unified：与 engine lod-instances 示例一致，用 setWorkBufferModifier + setParameter */
    private _unifiedWobble = false;

    initialize() {
        super.initialize();

        this.on('enable', () => {
            this._hasBaseLocalTransform = false;
            this._bounceAnchorResolved = false;
            this.syncContinuousRender();
        });

        this.on('disable', () => {
            this.restoreEntityPosition();
            this.disarmContinuousRender();
        });

        this.syncContinuousRender();
    }

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    setupUnifiedEventListener() {
        if (this.entity.gsplat?.unified) {
            return;
        }
        super.setupUnifiedEventListener();
    }

    applyShaders() {
        const gsplat = this.entity.gsplat as {
            unified?: boolean;
            setWorkBufferModifier?: (v: { glsl?: string; wgsl?: string } | null) => void;
            workBufferUpdate?: number;
        } | null;
        if (gsplat?.unified && gsplat.setWorkBufferModifier) {
            gsplat.setWorkBufferModifier({ glsl: this.getShaderGLSL(), wgsl: this.getShaderWGSL() });
            gsplat.workBufferUpdate = 2;
            this._unifiedWobble = true;
            this.initialized = true;
            this.updateEffect(this.effectTime);
            return;
        }
        super.applyShaders();
    }

    removeShaders() {
        if (this._unifiedWobble) {
            const gsplat = this.entity.gsplat as {
                setWorkBufferModifier?: (v: null) => void;
                workBufferUpdate?: number;
            } | null;
            gsplat?.setWorkBufferModifier?.(null);
            if (gsplat) {
                gsplat.workBufferUpdate = 0;
            }
            this._unifiedWobble = false;
            return;
        }
        super.removeShaders();
    }

    update(dt: number) {
        if (this._unifiedWobble) {
            if (!this.isPaused) {
                this.effectTime += dt;
            }
            this.updateEffect(this.effectTime, dt);
            if (this.enabled) {
                this.app.renderNextFrame = true;
            }
            return;
        }
        super.update(dt);
    }

    setUniform(name: string, value: unknown) {
        if (this._unifiedWobble) {
            const gsplat = this.entity.gsplat as { setParameter?: (n: string, v: unknown) => void } | null;
            gsplat?.setParameter?.(name, value);
            this.app.renderNextFrame = true;
            return;
        }
        super.setUniform(name, value);
    }

    setOptions(options: GsplatWobbleOptions = {}) {
        if (options.continuousRender !== undefined) this.continuousRender = options.continuousRender;
        if (options.amplitude !== undefined) {
            this.amplitude = options.amplitude;
        } else if (options.electronicYawAmplitude !== undefined) {
            // 向后兼容旧配置：旧参数 1.0 对应统一幅度 0.3
            this.amplitude = Math.max(0, options.electronicYawAmplitude) * 0.3;
        }
        if (options.wobbleAxis === 'x' || options.wobbleAxis === 'z') this.wobbleAxis = options.wobbleAxis;
        if (options.motionMode === 'wobble' || options.motionMode === 'electronic' || options.motionMode === 'deepMeditation') {
            this.motionMode = options.motionMode;
        }
        if (options.frequency !== undefined) this.frequency = options.frequency;
        if (options.heightScale !== undefined) this.heightScale = options.heightScale;
        if (options.bounceAmplitude !== undefined) this.bounceAmplitude = options.bounceAmplitude;
        if (options.bounceFrequency !== undefined) this.bounceFrequency = options.bounceFrequency;
        if (options.cycleDuration !== undefined) this.cycleDuration = options.cycleDuration;
        if (options.bounceDuration !== undefined) this.bounceDuration = options.bounceDuration;
        if (options.bounceCount !== undefined) this.bounceCount = Math.max(1, Math.floor(options.bounceCount));
        if (options.springOscillation !== undefined) this.springOscillation = options.springOscillation;
        if (options.springDamping !== undefined) this.springDamping = options.springDamping;
        if (options.springBlend !== undefined) this.springBlend = options.springBlend;
        if (typeof options.colorMix === 'boolean') {
            this.colorMix = options.colorMix;
        }
        if (options.colorBandStart !== undefined) this.colorBandStart = options.colorBandStart;
        if (options.colorBandEnd !== undefined) this.colorBandEnd = options.colorBandEnd;
        if (options.goldColor) this.goldColor = [...options.goldColor];
        if (options.haloWidth !== undefined) this.haloWidth = Math.max(0.001, options.haloWidth);
        if (options.haloSpeed !== undefined) {
            this.haloSpeed = Math.min(20, Math.max(0, options.haloSpeed));
        }
        if (options.haloOpacity !== undefined) this.haloOpacity = Math.max(0, Math.min(1, options.haloOpacity));
        if (options.bounceStretch !== undefined) this.bounceStretch = Math.max(0, options.bounceStretch);
        if (options.wobbleAnchorLift !== undefined) {
            this.wobbleAnchorLift = Math.min(1, Math.max(0, options.wobbleAnchorLift));
        }
        // @deprecated 旧字段 anchorLift
        if (options.anchorLift !== undefined) {
            this.wobbleAnchorLift = Math.min(1, Math.max(0, options.anchorLift));
        }
        if (options.enabled !== undefined) this.enabled = options.enabled;
        this.syncContinuousRender();
        this.updateEffect(this.effectTime);
    }

    updateEffect(effectTime: number, _dt?: number) {
        this.ensureBounceAnchorFromAabb();
        const cycle = this.computeCycleState(effectTime);
        this.applyEntityBounce(cycle.bounceShape);
        this.syncWobbleModelUniforms();

        this.setUniform('uTime', effectTime);
        this.setUniform('uWobbleAmplitude', this.amplitude);
        this.setUniform('uWobbleAxis', this.wobbleAxis === 'z' ? 1 : 0);
        this.setUniform(
            'uWobbleMotionMode',
            this.motionMode === 'deepMeditation' ? 2 : this.motionMode === 'electronic' ? 1 : 0
        );
        this.setUniform('uWobbleFrequency', this.frequency);
        this.setUniform('uWobbleHeightScale', this.heightScale);
        this.setUniform('uWobbleBounceShape', cycle.bounceShape);
        this.setUniform('uWobbleStrength', cycle.wobbleStrength);
        this.setUniform('uWobbleLocalTime', cycle.wobbleLocalTime);
        this.setUniform('uWobbleColorMix', this.colorMix ? 1 : 0);
        this.setUniform('uWobbleColorBandStart', this.colorBandStart);
        this.setUniform('uWobbleColorBandEnd', this.colorBandEnd);
        this.setUniform('uWobbleGoldColor', this.goldColor);
        this.setUniform('uWobbleHaloWidth', this.haloWidth);
        this.setUniform('uWobbleHaloSpeed', this.haloSpeed);
        this.setUniform('uWobbleHaloOpacity', this.haloOpacity);
        this.setUniform('uWobbleBounceStretch', this.bounceStretch);
        this.setUniform('uWobbleWorldSpace', this.usesWorldSpaceShader() ? 1 : 0);
        this.setUniform('uWobbleMinRelLocal', this._minRelLocal);
        this.setUniform('uWobbleWorldBottomY', this._worldBottomY);
        this.setUniform('uWobbleWorldHeight', this._worldHeight);
        this.setUniform('uWobbleWorldCenter', [
            this._worldAabb.center.x,
            this._worldAabb.center.y,
            this._worldAabb.center.z
        ]);
    }

    destroy() {
        this.restoreEntityPosition();
        this.disarmContinuousRender();
        super.destroy();
    }

    /**
     * 周期状态：连跳 bounceCount 下（仅弹跳），再扭动一段（仅扭动）。
     */
    computeCycleState(effectTime: number) {
        if (this.motionMode !== 'wobble') {
            return {
                bounceShape: 0,
                wobbleStrength: 1,
                wobbleLocalTime: effectTime
            };
        }
        const cycleLen = Math.max(this.cycleDuration, 0.01);
        const hopLen = Math.max(this.bounceDuration, 0.05);
        const hops = Math.max(1, Math.floor(this.bounceCount));
        const bouncePhaseLen = Math.min(hopLen * hops, cycleLen - 0.05);
        const cycleT = effectTime % cycleLen;

        if (cycleT < bouncePhaseLen) {
            const hopIndex = Math.min(Math.floor(cycleT / hopLen), hops - 1);
            const hopLocalT = (cycleT - hopIndex * hopLen) / hopLen;
            return {
                bounceShape: this.computeBounceShapeFromHopT(hopLocalT),
                wobbleStrength: 0,
                wobbleLocalTime: 0
            };
        }

        return {
            bounceShape: 0,
            wobbleStrength: 1,
            wobbleLocalTime: cycleT - bouncePhaseLen
        };
    }

    /** 将 [0,1] 归一化时间映射为弹簧跳跃曲线 */
    computeBounceShapeFromHopT(hopT: number): number {
        const t = Math.min(1, Math.max(0, hopT));
        const baseHop = Math.sin(t * Math.PI);
        const springWave = Math.sin(t * TAU * this.springOscillation) * Math.exp(-this.springDamping * t);
        const springHop = Math.max(baseHop + springWave * 0.45, 0);
        const blend = Math.min(1, Math.max(0, this.springBlend));
        return baseHop * (1 - blend) + springHop * blend;
    }

    private ensureBounceAnchorFromAabb() {
        if (this._bounceAnchorResolved) {
            return;
        }

        const gsplat = this.entity.gsplat as {
            customAabb?: { center?: Vec3; halfExtents: Vec3 };
            aabb?: { center?: Vec3; halfExtents: Vec3 };
            resource?: { aabb?: { center?: Vec3; halfExtents: Vec3 } };
            instance?: { resource?: { aabb?: { center?: Vec3; halfExtents: Vec3 } } };
        } | null;
        const aabb = gsplat?.customAabb ?? gsplat?.aabb ?? gsplat?.resource?.aabb ?? gsplat?.instance?.resource?.aabb;
        const half = aabb?.halfExtents;
        if (half) {
            this._localAabb.center.copy(aabb?.center ?? Vec3.ZERO);
            this._localAabb.halfExtents.copy(half);
            this._bounceAnchorResolved = true;
            return;
        }

        // gsplat 尚未就绪时先用保守默认值，就绪后下一帧会重算
        this._localAabb.center.copy(Vec3.ZERO);
        this._localAabb.halfExtents.set(0.5, 0.5, 0.5);
    }

    /** unified 时 shader 为世界空间；非 unified 为模型空间（与 RevealController 一致） */
    private usesWorldSpaceShader(): boolean {
        if (this._unifiedWobble) {
            return true;
        }
        const gsplat = this.entity.gsplat as { unified?: boolean } | null;
        return gsplat?.unified === true;
    }

    /**
     * unified 的 center 为世界坐标；扭动须先变回模型空间（与 multi-splat 吉他 center.x/y 一致）。
     */
    private syncWobbleModelUniforms() {
        const wt = this.entity.getWorldTransform();
        this._modelWorld.copy(wt);
        this._invModelWorld.copy(wt).invert();
        this._worldAabb.setFromTransformedAabb(this._localAabb, wt);
        this._worldBottomY = this._worldAabb.center.y - this._worldAabb.halfExtents.y;
        this._worldHeight = Math.max(this._worldAabb.halfExtents.y * 2, 0.01);

        const lift = Math.min(1, Math.max(0, this.wobbleAnchorLift));
        this._minRelLocal = lift * this._worldHeight;
        this.setUniform('uWobbleInvModelWorld', mat4ToShaderArray(this._invModelWorld));
        this.setUniform('uWobbleModelWorld', mat4ToShaderArray(this._modelWorld));
        this.setUniform('uWobbleWorldCenter', [
            this._worldAabb.center.x,
            this._worldAabb.center.y,
            this._worldAabb.center.z
        ]);
        this.setUniform('uWobbleLocalCenter', [this._localAabb.center.x, this._localAabb.center.y, this._localAabb.center.z]);
        this.setUniform('uWobbleLocalHalfExtents', [
            this._localAabb.halfExtents.x,
            this._localAabb.halfExtents.y,
            this._localAabb.halfExtents.z
        ]);
    }

    private applyEntityBounce(bounceShape: number) {
        if (!this._hasBaseLocalTransform) {
            this._baseLocalPosition.copy(this.entity.getLocalPosition());
            this._baseLocalScale.copy(this.entity.getLocalScale());
            this._hasBaseLocalTransform = true;
        }

        // 仅「跳动高度」驱动实体位移；Y 轴拉伸在 shader 中按 world AABB 底面锚定。
        const jumpY = bounceShape * this.bounceAmplitude;
        this.entity.setLocalPosition(
            this._baseLocalPosition.x,
            this._baseLocalPosition.y + jumpY,
            this._baseLocalPosition.z
        );
        this.entity.setLocalScale(this._baseLocalScale);
    }

    private restoreEntityPosition() {
        if (!this._hasBaseLocalTransform) {
            return;
        }
        this.entity.setLocalPosition(this._baseLocalPosition);
        this.entity.setLocalScale(this._baseLocalScale);
        this._hasBaseLocalTransform = false;
    }

    private syncContinuousRender() {
        const wantContinuous = this.enabled && this.continuousRender;
        if (wantContinuous && !this._autoRenderOverridden) {
            this._savedAppAutoRender = this.app.autoRender;
            this.app.autoRender = true;
            this._autoRenderOverridden = true;
            return;
        }

        if (!wantContinuous && this._autoRenderOverridden) {
            this.disarmContinuousRender();
        }
    }

    private disarmContinuousRender() {
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

export function createGsplatWobbleEffect(entity: Entity, options: GsplatWobbleOptions = {}) {
    if (!entity.script) {
        entity.addComponent('script');
    }

    let script = entity.script!.get(GsplatWobbleEffect.scriptName) as unknown as GsplatWobbleEffect | null;
    if (!script) {
        script = entity.script!.create(GsplatWobbleEffect) as unknown as GsplatWobbleEffect;
    }

    script.setOptions({ enabled: true, ...options });
    return script;
}

export function removeGsplatWobbleEffect(entity: Entity) {
    const script = entity.script?.get(GsplatWobbleEffect.scriptName) as unknown as GsplatWobbleEffect | null;
    if (!script) {
        return;
    }

    script.enabled = false;
    entity.script!.destroy(GsplatWobbleEffect.scriptName);
}
