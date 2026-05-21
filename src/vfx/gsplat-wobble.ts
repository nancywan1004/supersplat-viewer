import { Vec3, type Entity } from 'playcanvas';

import { GsplatShaderEffect } from './effects-runtime/gsplat-shader-effect';

export interface GsplatWobbleOptions {
    enabled?: boolean;
    continuousRender?: boolean;
    amplitude?: number;
    frequency?: number;
    heightScale?: number;
    /** 弹跳强度系数，最终位移 ≈ bounceAmplitude × 模型包围盒尺度 */
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
    colorMix?: number;
    colorBandStart?: number;
    colorBandEnd?: number;
    goldColor?: [number, number, number];
}

const DEFAULT_GOLD: [number, number, number] = [1.0, 0.85, 0.0];
const TAU = Math.PI * 2;

const shaderGLSL = /* glsl */`
uniform float uTime;
uniform float uWobbleAmplitude;
uniform float uWobbleFrequency;
uniform float uWobbleHeightScale;
uniform float uWobbleBounceShape;
uniform float uWobbleStrength;
uniform float uWobbleLocalTime;
uniform float uWobbleColorMix;
uniform float uWobbleColorBandStart;
uniform float uWobbleColorBandEnd;
uniform vec3 uWobbleGoldColor;

void modifySplatCenter(inout vec3 center) {
    float heightIntensity = center.y * uWobbleHeightScale;
    float wobblePhase = uWobbleLocalTime * uWobbleFrequency + center.y;
    center.x += sin(wobblePhase) * uWobbleAmplitude * heightIntensity * uWobbleStrength;
}

void modifySplatRotationScale(vec3 originalCenter, vec3 modifiedCenter, inout vec4 rotation, inout vec3 scale) {
    float squash = 1.0 - uWobbleBounceShape * 0.22;
    float stretch = 1.0 + uWobbleBounceShape * 0.14;
    scale.y *= squash;
    scale.x *= stretch;
    scale.z *= stretch;
}

void modifySplatColor(vec3 center, inout vec4 clr) {
    float sineValue = abs(sin(uWobbleLocalTime * uWobbleFrequency + center.y));
    float blend = smoothstep(uWobbleColorBandStart, uWobbleColorBandEnd, sineValue) * uWobbleColorMix * uWobbleStrength;
    clr.xyz = mix(clr.xyz, uWobbleGoldColor, blend);
}
`;

const shaderWGSL = /* wgsl */`
uniform uTime: f32;
uniform uWobbleAmplitude: f32;
uniform uWobbleFrequency: f32;
uniform uWobbleHeightScale: f32;
uniform uWobbleBounceShape: f32;
uniform uWobbleStrength: f32;
uniform uWobbleLocalTime: f32;
uniform uWobbleColorMix: f32;
uniform uWobbleColorBandStart: f32;
uniform uWobbleColorBandEnd: f32;
uniform uWobbleGoldColor: vec3f;

fn modifySplatCenter(center: ptr<function, vec3f>) {
    let heightIntensity = (*center).y * uniform.uWobbleHeightScale;
    let wobblePhase = uniform.uWobbleLocalTime * uniform.uWobbleFrequency + (*center).y;
    (*center).x += sin(wobblePhase) * uniform.uWobbleAmplitude * heightIntensity * uniform.uWobbleStrength;
}

fn modifySplatRotationScale(originalCenter: vec3f, modifiedCenter: vec3f, rotation: ptr<function, vec4f>, scale: ptr<function, vec3f>) {
    let squash = 1.0 - uniform.uWobbleBounceShape * 0.22;
    let stretch = 1.0 + uniform.uWobbleBounceShape * 0.14;
    (*scale).y *= squash;
    (*scale).x *= stretch;
    (*scale).z *= stretch;
}

fn modifySplatColor(center: vec3f, clr: ptr<function, vec4f>) {
    let sineValue = abs(sin(uniform.uWobbleLocalTime * uniform.uWobbleFrequency + center.y));
    let blend = smoothstep(uniform.uWobbleColorBandStart, uniform.uWobbleColorBandEnd, sineValue) *
        uniform.uWobbleColorMix * uniform.uWobbleStrength;
    (*clr) = vec4f(mix((*clr).xyz, uniform.uWobbleGoldColor, blend), (*clr).a);
}
`;

export class GsplatWobbleEffect extends GsplatShaderEffect {
    static scriptName = 'gsplatWobbleEffect';

    amplitude = 0.3;

    frequency = 5.0;

    heightScale = 0.2;

    /** 相对模型尺寸的弹跳倍率（默认约 3 × 包围盒最大半轴的 35%） */
    bounceAmplitude = 3.0;

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

    colorMix = 1.0;

    colorBandStart = 0.9;

    colorBandEnd = 1.0;

    goldColor = [...DEFAULT_GOLD];

    continuousRender = true;

    private _savedAppAutoRender: boolean | undefined;

    private _autoRenderOverridden = false;

    private readonly _baseLocalPosition = new Vec3();

    private _hasBaseLocalPosition = false;

    private _bounceWorldScale = 0.5;

    private _bounceScaleResolved = false;

    initialize() {
        super.initialize();

        this.on('enable', () => {
            this._hasBaseLocalPosition = false;
            this._bounceScaleResolved = false;
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

    setOptions(options: GsplatWobbleOptions = {}) {
        if (options.continuousRender !== undefined) this.continuousRender = options.continuousRender;
        if (options.amplitude !== undefined) this.amplitude = options.amplitude;
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
        if (options.colorMix !== undefined) this.colorMix = options.colorMix;
        if (options.colorBandStart !== undefined) this.colorBandStart = options.colorBandStart;
        if (options.colorBandEnd !== undefined) this.colorBandEnd = options.colorBandEnd;
        if (options.goldColor) this.goldColor = [...options.goldColor];
        if (options.enabled !== undefined) this.enabled = options.enabled;
        this.syncContinuousRender();
        this.updateEffect(this.effectTime);
    }

    updateEffect(effectTime: number, _dt?: number) {
        this.ensureBounceWorldScale();
        const cycle = this.computeCycleState(effectTime);
        this.applyEntityBounce(cycle.bounceShape);

        this.setUniform('uTime', effectTime);
        this.setUniform('uWobbleAmplitude', this.amplitude);
        this.setUniform('uWobbleFrequency', this.frequency);
        this.setUniform('uWobbleHeightScale', this.heightScale);
        this.setUniform('uWobbleBounceShape', cycle.bounceShape);
        this.setUniform('uWobbleStrength', cycle.wobbleStrength);
        this.setUniform('uWobbleLocalTime', cycle.wobbleLocalTime);
        this.setUniform('uWobbleColorMix', this.colorMix);
        this.setUniform('uWobbleColorBandStart', this.colorBandStart);
        this.setUniform('uWobbleColorBandEnd', this.colorBandEnd);
        this.setUniform('uWobbleGoldColor', this.goldColor);
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

    private ensureBounceWorldScale() {
        if (this._bounceScaleResolved) {
            return;
        }

        const gsplat = this.entity.gsplat as { aabb?: { halfExtents: Vec3 }; resource?: { aabb?: { halfExtents: Vec3 } } } | null;
        const half = gsplat?.aabb?.halfExtents ?? gsplat?.resource?.aabb?.halfExtents;
        if (half) {
            this._bounceWorldScale = Math.max(half.x, half.y, half.z, 0.01) * 0.35;
            this._bounceScaleResolved = true;
            return;
        }

        // gsplat 尚未就绪时先用保守默认值，就绪后下一帧会重算
        this._bounceWorldScale = 2.0;
    }

    private applyEntityBounce(bounceShape: number) {
        if (!this._hasBaseLocalPosition) {
            this._baseLocalPosition.copy(this.entity.getLocalPosition());
            this._hasBaseLocalPosition = true;
        }

        const offset = bounceShape * this.bounceAmplitude * this._bounceWorldScale;
        this.entity.setLocalPosition(
            this._baseLocalPosition.x,
            this._baseLocalPosition.y + offset,
            this._baseLocalPosition.z
        );
    }

    private restoreEntityPosition() {
        if (!this._hasBaseLocalPosition) {
            return;
        }
        this.entity.setLocalPosition(this._baseLocalPosition);
        this._hasBaseLocalPosition = false;
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
