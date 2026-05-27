import { Color, Vec3, type Material } from 'playcanvas';
import { GsplatShaderEffect } from '../gsplat-shader-effect';
import { extractGlslWgslModifyBlocks, OVERALL_WAVE_COMPOSER_ID } from '../gsplat-effect-layers-extractor';
import { nightModeUsesComposerPath } from '../../lighting/night-mode';
import { OVERALL_WAVE_REGISTRY_EFFECT_ID } from '../effect-types';
import {
    isOneShotRevealPlayingExclusiveGsplat,
    perlinWaveUsesRegistryComposerPath
} from '../effects-pipeline-policy';
import { shaderGLSL, shaderWGSL } from './gsplat-overall-wave-shaders';

/** 初始属性默认值 */
export const OVERALL_WAVE_DEFAULTS = {
    noiseType: 0,
    waveAmplitude: 0.35,
    wavelength: 5,
    waveSpeed: 1,
    intensity: 0.5,
    crestTint: [1.12, 1.08, 1.02] as [number, number, number],
    troughTint: [0.72, 0.76, 0.82] as [number, number, number],
    waveDirection: [0, 0, 1] as [number, number, number],
    center: [0, 0, 0] as [number, number, number]
} as const;

const NOISE_TYPE_MAX = 1;

export function clampOverallWaveNoiseType(v: number): number {
    return Math.max(0, Math.min(NOISE_TYPE_MAX, Math.floor(v)));
}

/**
 * 整体波动：全场景有机噪波位移 + 波峰/波谷明暗着色。
 * 夜间模式走 {@link GsplatEffectComposer}；`perlinRegistry=0` 时回退脚本内联 contribution（与 perlin-wave 一致）。
 */
class GsplatPersistentOverallWave extends GsplatShaderEffect {
    static scriptName = 'gsplatPersistentOverallWave';

    /** shader 变更时递增，触发 composer 重编译 */
    private _composerRev = 4;
    /** 一次性 reveal 独占 `gsplatModifyVS` 时，已从合成器摘掉本 contribution */
    private _composerSuppressed = false;

    _centerArray = [...OVERALL_WAVE_DEFAULTS.center];
    _waveDirArray = [...OVERALL_WAVE_DEFAULTS.waveDirection];
    _crestTintArray = [...OVERALL_WAVE_DEFAULTS.crestTint];
    _troughTintArray = [...OVERALL_WAVE_DEFAULTS.troughTint];

    center = new Vec3(...OVERALL_WAVE_DEFAULTS.center);
    noiseType = OVERALL_WAVE_DEFAULTS.noiseType;
    waveDirection = new Vec3(...OVERALL_WAVE_DEFAULTS.waveDirection);
    waveAmplitude = OVERALL_WAVE_DEFAULTS.waveAmplitude;
    wavelength = OVERALL_WAVE_DEFAULTS.wavelength;
    waveSpeed = OVERALL_WAVE_DEFAULTS.waveSpeed;
    intensity = OVERALL_WAVE_DEFAULTS.intensity;
    crestTint = new Color(...OVERALL_WAVE_DEFAULTS.crestTint);
    troughTint = new Color(...OVERALL_WAVE_DEFAULTS.troughTint);

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    private usesComposerPath(): boolean {
        return nightModeUsesComposerPath() && !!(this.app as any).effectsRuntime?.composer;
    }

    private getEffectsRuntime(): any {
        return (this.app as any).effectsRuntime ?? null;
    }

    private shouldSuppressComposerForOneShotReveal(): boolean {
        return isOneShotRevealPlayingExclusiveGsplat((this.app as any).__global?.state);
    }

    applyShaderToMaterial(material: Material) {
        if (this.usesComposerPath()) return;
        super.applyShaderToMaterial(material);
    }

    applyShaders() {
        if (!this.usesComposerPath()) {
            super.applyShaders();
            return;
        }
        if (this.entity.gsplat?.unified) {
            this.applyToUnifiedMaterials();
        } else {
            this.applyToComponentMaterial();
        }
        if (this.shouldSuppressComposerForOneShotReveal()) {
            this.suppressComposerContribution();
            return;
        }
        this._composerSuppressed = false;
        this.syncComposerContribution();
    }

    removeShaders() {
        if (!this.usesComposerPath()) {
            super.removeShaders();
            return;
        }
        if (this.materialsApplied.size === 0) return;
        const rt = this.getEffectsRuntime();
        const mats = new Set(this.materialsApplied);
        if (rt?.removeSceneGsplatContribution) {
            rt.removeSceneGsplatContribution(OVERALL_WAVE_COMPOSER_ID, mats);
        } else {
            rt?.composer.removeContribution(OVERALL_WAVE_COMPOSER_ID);
            rt?.composer.compose();
            const last = rt?.composer.getLastComposition();
            if (last && mats.size > 0) {
                rt!.composer.applyComposedToMaterials(mats, last);
            }
        }
        this.materialsApplied.clear();
        this._composerSuppressed = false;
    }

    private suppressComposerContribution(): void {
        const rt = this.getEffectsRuntime();
        if (!rt?.removeSceneGsplatContribution || this.materialsApplied.size === 0) return;
        if (this._composerSuppressed) return;
        rt.removeSceneGsplatContribution(OVERALL_WAVE_COMPOSER_ID, new Set(this.materialsApplied));
        this._composerSuppressed = true;
    }

    private syncComposerContribution(): void {
        const rt = this.getEffectsRuntime();
        if (!rt?.composer || this.materialsApplied.size === 0) return;
        if (this.shouldSuppressComposerForOneShotReveal()) {
            this.suppressComposerContribution();
            return;
        }
        if (perlinWaveUsesRegistryComposerPath()) {
            rt.syncPersistentGsplatRegistryFromSettings?.();
            rt.applySceneGsplatFromRegistry(OVERALL_WAVE_REGISTRY_EFFECT_ID, this.materialsApplied, {
                revision: this._composerRev
            });
            return;
        }
        const shaderBlocks = extractGlslWgslModifyBlocks(shaderGLSL, shaderWGSL);
        rt.applySceneGsplatContribution(
            {
                id: OVERALL_WAVE_COMPOSER_ID,
                priority: 21,
                scope: 'scene',
                enabled: true,
                version: this._composerRev,
                shaderBlocks,
                capabilities: { allowConcurrentWithPersistent: true }
            },
            this.materialsApplied
        );
    }

    updateEffect(effectTime: number, _dt: number) {
        this.setUniform('uTime', effectTime);

        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        this.setUniform('uNoiseType', clampOverallWaveNoiseType(this.noiseType));
        this.setUniform('uIntensity', this.intensity);
        this.setUniform('uWaveAmplitude', this.waveAmplitude);
        const w = Number(this.wavelength) || 0;
        this.setUniform('uWaveFrequency', w > 0 ? 1.0 / w : 0.2);
        this.setUniform('uWaveSpeed', this.waveSpeed);

        this._crestTintArray[0] = this.crestTint.r;
        this._crestTintArray[1] = this.crestTint.g;
        this._crestTintArray[2] = this.crestTint.b;
        this.setUniform('uCrestTint', this._crestTintArray);

        this._troughTintArray[0] = this.troughTint.r;
        this._troughTintArray[1] = this.troughTint.g;
        this._troughTintArray[2] = this.troughTint.b;
        this.setUniform('uTroughTint', this._troughTintArray);

        this._waveDirArray[0] = this.waveDirection.x;
        this._waveDirArray[1] = this.waveDirection.y;
        this._waveDirArray[2] = this.waveDirection.z;
        this.setUniform('uWaveDirection', this._waveDirArray);

        if (!this.usesComposerPath() || this.materialsApplied.size === 0) return;
        if (this.shouldSuppressComposerForOneShotReveal()) {
            this.suppressComposerContribution();
        } else if (this._composerSuppressed) {
            this._composerSuppressed = false;
            this.syncComposerContribution();
        }
    }
}

export { GsplatPersistentOverallWave };
