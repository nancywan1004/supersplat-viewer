import { Vec3, type Material } from 'playcanvas';
import { GsplatShaderEffect } from '../gsplat-shader-effect';
import { extractGlslWgslModifyBlocks, PERLIN_WAVE_COMPOSER_ID } from '../gsplat-effect-layers-extractor';
import { nightModeUsesComposerPath } from '../../lighting/night-mode';
import { PERLIN_WAVE_REGISTRY_EFFECT_ID } from '../effect-types';
import {
    isOneShotRevealPlayingExclusiveGsplat,
    perlinWaveUsesRegistryComposerPath
} from '../effects-pipeline-policy';
import { shaderGLSL, shaderWGSL } from './gsplat-perlin-wave-shaders';

/**
 * Perlin Wave reveal effect for gaussian splats.
 * Creates a wave-like motion effect using Perlin noise, with color modulation via 3D sine waves.
 *
 * @example
 * // Add the script to a gsplat entity
 * entity.addComponent('script');
 * const perlinWaveScript = entity.script.create(GsplatRevealPerlinWave);
 * perlinWaveScript.center.set(0, 0, 0);
 * perlinWaveScript.intensity = 0.5;
 * perlinWaveScript.waveAmplitude = 0.1;
 * perlinWaveScript.wavelength = 2.0;  // 波长（世界单位），优先于 waveFrequency；0 则用 waveFrequency
 * perlinWaveScript.waveSpeed = 1.0;
 * perlinWaveScript.scaleBlend = 1.0;
 */
class GsplatRevealPerlinWave extends GsplatShaderEffect {
    static scriptName = 'gsplatRevealPerlinWave';

    /** 仅当 shader 源码变更时需递增以触发 composer 重编译 */
    private _perlinComposerRev = 0;

    /** 一次性开场 reveal 独占整段 `gsplatModifyVS` 时，已主动从合成器摘掉波纹 contribution */
    private _perlinComposerSuppressed = false;

    // Reusable arrays for uniform updates
    _centerArray = [0, 0, 0];

    /**
     * Origin point for the effect (used for distance culling)
     * @attribute
     */
    center = new Vec3(0, 0, 0);

    /**
     * Intensity of the color effect (0-1)
     * @attribute
     * @range [0, 1]
     */
    intensity = 0.5;

    /**
     * Amplitude of the Perlin wave motion
     * @attribute
     * @range [0, 2]
     */
    waveAmplitude = 0.1;

    /**
     * Frequency of the Perlin wave (used only when wavelength <= 0)
     * @attribute
     * @range [0, 10]
     */
    waveFrequency = 1.0;

    /**
     * 波长（世界单位）。当 > 0 时优先使用：uWaveFrequency = 1.0 / wavelength，调大波长 = 波更疏、周期更长
     * @attribute
     * @range [0, 100]
     */
    wavelength = 0;

    /**
     * Speed of the wave animation
     * @attribute
     * @range [0, 5]
     */
    waveSpeed = 1.0;

    /**
     * Scale blend factor (0-1). Values < 0.1 will hide splats
     * @attribute
     * @range [0, 1]
     */
    scaleBlend = 0;

    getShaderGLSL() {
        return shaderGLSL;
    }

    getShaderWGSL() {
        return shaderWGSL;
    }

    private usesPerlinComposerPath(): boolean {
        return nightModeUsesComposerPath() && !!(this.app as any).effectsRuntime?.composer;
    }

    private getEffectsRuntime(): any {
        return (this.app as any).effectsRuntime ?? null;
    }

    private getAppState() {
        return (this.app as any).__global?.state;
    }

    /** 开场一次性 reveal 正在播：整段 `gsplatModifyVS` 由 reveal 脚本独占，波纹不参与合成器 */
    private shouldSuppressPerlinComposerForOneShotReveal(): boolean {
        return isOneShotRevealPlayingExclusiveGsplat(this.getAppState());
    }

    applyShaderToMaterial(material: Material) {
        if (this.usesPerlinComposerPath()) {
            return;
        }
        super.applyShaderToMaterial(material);
    }

    applyShaders() {
        if (!this.usesPerlinComposerPath()) {
            super.applyShaders();
            return;
        }
        if (this.entity.gsplat?.unified) {
            this.applyToUnifiedMaterials();
        } else {
            this.applyToComponentMaterial();
        }
        if (this.shouldSuppressPerlinComposerForOneShotReveal()) {
            this.suppressPerlinComposerContribution();
            return;
        }
        this._perlinComposerSuppressed = false;
        this.syncPerlinComposerContribution();
    }

    removeShaders() {
        if (!this.usesPerlinComposerPath()) {
            super.removeShaders();
            return;
        }
        if (this.materialsApplied.size === 0) return;
        const rt = this.getEffectsRuntime();
        const mats = new Set(this.materialsApplied);
        if (rt?.removeSceneGsplatContribution) {
            rt.removeSceneGsplatContribution(PERLIN_WAVE_COMPOSER_ID, mats);
        } else {
            rt?.composer.removeContribution(PERLIN_WAVE_COMPOSER_ID);
            rt?.composer.compose();
            const last = rt?.composer.getLastComposition();
            if (last && mats.size > 0) {
                rt!.composer.applyComposedToMaterials(mats, last);
            }
        }
        this.materialsApplied.clear();
        this._perlinComposerSuppressed = false;
    }

    private suppressPerlinComposerContribution(): void {
        const rt = this.getEffectsRuntime();
        if (!rt?.removeSceneGsplatContribution || this.materialsApplied.size === 0) return;
        if (this._perlinComposerSuppressed) return;
        rt.removeSceneGsplatContribution(PERLIN_WAVE_COMPOSER_ID, new Set(this.materialsApplied));
        this._perlinComposerSuppressed = true;
    }

    private syncPerlinComposerContribution(): void {
        const rt = this.getEffectsRuntime();
        if (!rt?.composer || this.materialsApplied.size === 0) {
            return;
        }
        if (this.shouldSuppressPerlinComposerForOneShotReveal()) {
            this.suppressPerlinComposerContribution();
            return;
        }
        if (perlinWaveUsesRegistryComposerPath()) {
            rt.syncPersistentGsplatRegistryFromSettings?.();
            rt.applySceneGsplatFromRegistry(PERLIN_WAVE_REGISTRY_EFFECT_ID, this.materialsApplied, {
                revision: this._perlinComposerRev
            });
            return;
        }
        const shaderBlocks = extractGlslWgslModifyBlocks(shaderGLSL, shaderWGSL);
        rt.applySceneGsplatContribution(
            {
                id: PERLIN_WAVE_COMPOSER_ID,
                priority: 20,
                scope: 'scene',
                enabled: true,
                version: this._perlinComposerRev,
                shaderBlocks,
                capabilities: { allowConcurrentWithPersistent: true }
            },
            this.materialsApplied
        );
    }

    updateEffect(effectTime: number, dt: number) {
        // Update uniforms
        this.setUniform('uTime', effectTime);

        this._centerArray[0] = this.center.x;
        this._centerArray[1] = this.center.y;
        this._centerArray[2] = this.center.z;
        this.setUniform('uCenter', this._centerArray);

        this.setUniform('uIntensity', this.intensity);
        this.setUniform('uWaveAmplitude', this.waveAmplitude);
        const w = Number(this.wavelength) || 0;
        const effectiveFrequency = w > 0 ? 1.0 / w : this.waveFrequency;
        this.setUniform('uWaveFrequency', effectiveFrequency);
        this.setUniform('uWaveSpeed', this.waveSpeed);
        this.setUniform('uScaleBlend', this.scaleBlend);

        if (this.usesPerlinComposerPath() && this.materialsApplied.size > 0) {
            if (this.shouldSuppressPerlinComposerForOneShotReveal()) {
                this.suppressPerlinComposerContribution();
            } else if (this._perlinComposerSuppressed) {
                this._perlinComposerSuppressed = false;
                this.syncPerlinComposerContribution();
            }
        }
    }
}

export { GsplatRevealPerlinWave };
