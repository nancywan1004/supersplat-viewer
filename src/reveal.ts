import type { Entity, BoundingBox } from 'playcanvas';
import { Vec3 } from 'playcanvas';
import { GsplatRevealRadial } from './vfx/reveal/gsplat-reveal-radial';
import { GsplatRevealRain } from './vfx/reveal/gsplat-reveal-rain';
import { Global } from './types';
import { RevealEffect as RevealConfig, AnimTrack } from './settings';
import { GsplatRevealSmooth } from './vfx/reveal/gsplat-reveal-smooth';
import { GsplatRevealPiecesRecover } from './vfx/gsplat-pieces-recover';
import { GsplatRevealPerlinWave } from './vfx/gsplat-perlin-wave';
import { GsplatIntegrate } from './vfx/gsplat-integrate';
import type { CameraManager } from './camera-manager';
// import { GsplatRevealRadial } from 'playcanvas/scripts/esm/gsplat/reveal-radial.mjs';
// import { GsplatRevealRain } from 'playcanvas/scripts/esm/gsplat/reveal-rain.mjs';

/**
 * Script-based Reveal Controller - 基于原始reveal.example.mjs的实现
 * 使用createRadialScript等方法来创建和管理reveal scripts
 */
/**
 * Reveal effect type (including VFX effects)
 */
export type RevealEffectType = 'radial' | 'rain' | 'smooth' | 'pieces-recover' | 'perlin-wave' | 'integrate' | 'none';

export class RevealController {
    private gsplatEntity: Entity | null = null;
    private config: RevealConfig;
    private currentScript: any = null;
    private revealCenter: number[] = [0, 0, 0];
    private bbox: BoundingBox | null = null;
    private cameraManager: CameraManager | null = null;

    global: Global;

    constructor(global: Global, bbox: BoundingBox, gsplatEntity: Entity, cameraManager?: CameraManager | null) {
        this.global = global;
        const { settings, events, state } = global;
        this.gsplatEntity = gsplatEntity;
        this.bbox = bbox;
        this.cameraManager = cameraManager || null;
        
        // Check if revealEffect is empty or has no type
        const hasRevealEffect = settings.revealEffect && 
                                Object.keys(settings.revealEffect).length > 0 && 
                                settings.revealEffect.type;
        
        // Always initialize (VFX effects don't require revealEffect in settings)
        this.config = {
            type: (settings.revealEffect?.type as RevealEffectType) ?? 'none',
            radius: settings.revealEffect?.radius ?? 10,
            autoStart: settings.revealEffect?.autoStart ?? true
        };

        console.log('RevealController initialized with config:', this.config);
        
        // Set state to indicate reveal effect is available
        state.hasRevealEffect = !!hasRevealEffect || true; // Always available for VFX effects
        state.vfxType = this.config.type;
        state.vfxActive = false;

        // 统一监听配置变化（包括类型切换和启用状态）
        events.on('revealConfigChanged', (newConfig: Partial<RevealConfig>) => {
            console.log('Reveal config changed:', newConfig);
            this.updateConfig(newConfig);
        });

        // 统一监听重启请求（所有效果类型）
        events.on('revealRestart', () => {
            console.log('Reveal restart requested via event');
            this.restart();
        });

        // 使用相机的 look target 作为默认 reveal center，如果没有则使用 bbox.center
        const cameraTarget = settings.cameras?.[0]?.initial?.target;
        this.revealCenter = cameraTarget ? cameraTarget : bbox.center.toArray();
        
        // 触发事件以更新 UI（确保 UI 显示当前类型）
        events.fire('revealType:changed', this.config.type);
        
        // 创建初始效果（如果类型不是 none）
        if (this.config.type !== 'none') {
            this.createEffect(this.config.type);
        }
    }

    /**
     * 创建radial reveal script - 类似原始实现中的createRadialScript
     */
    private createRadialScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create radial script - entity or script component not ready');
            return null;
        }

        console.log('Creating radial reveal script');
        
        try {
            const script = this.gsplatEntity.script.create(GsplatRevealRadial) as any;
            if (script) {
                // 配置script属性 - 类似原始实现
                script.speed = 5;
                script.acceleration = 0;
                script.delay = 0.5;
                script.dotTint.set(0, 1, 1); // Cyan
                script.waveTint.set(1, 0.5, 0); // Orange
                script.oscillationIntensity = 0.2;
                script.endRadius = this.config.radius;
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Radial script created with config:', {
                    center: script.center,
                    endRadius: script.endRadius,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create radial script:', error);
            return null;
        }
    }

    /**
     * 创建rain reveal script - 类似原始实现中的createRainScript
     */
    private createRainScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create rain script - entity or script component not ready');
            return null;
        }

        console.log('Creating rain reveal script');
        
        try {
            const script = this.gsplatEntity.script.create(GsplatRevealRain) as any;
            if (script) {
                // 配置script属性 - 类似原始实现
                script.distance = 30;
                script.speed = 3;
                script.acceleration = 0;
                script.flightTime = 2;
                script.rainSize = 0.015;
                script.rotation = 0.9; // 90% of full circle rotation during fall
                script.fallTint.set(0, 1, 1); // Cyan tint during fall
                script.fallTintIntensity = 0.2;
                script.hitTint.set(2, 0, 0); // Bright red flash on landing
                script.hitDuration = 0.5;
                script.endRadius = this.config.radius;
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Rain script created with config:', {
                    center: script.center,
                    endRadius: script.endRadius,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create rain script:', error);
            return null;
        }
    }

    /**
     * 创建smooth reveal script
     */
    private createSmoothScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create smooth script - entity or script component not ready');
            return null;
        }

        console.log('Creating smooth reveal script');

        try {
            const script = this.gsplatEntity.script.create(GsplatRevealSmooth) as any;
            if (script) {
                // 配置script属性
                script.maxRadius = this.config.radius;
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Smooth script created with config:', {
                    center: script.center,
                    maxRadius: script.maxRadius
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create smooth script:', error);
            return null;
        }

    }


    /**
     * 创建 pieces-recover 效果脚本
     */
    private createPiecesRecoverScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create pieces-recover script - entity or script component not ready');
            return null;
        }

        console.log('Creating pieces-recover reveal script');

        try {
            const script = this.gsplatEntity.script.create(GsplatRevealPiecesRecover) as any;
            if (script) {
                // 配置script属性
                script.scatterDistance = 4.0;
                script.scatterDuration = 7.5;
                script.holdDuration = 0;
                script.recoverDuration = 7.5;
                script.noiseIntensity = 0.3;
                script.scatterDirection.set(1, 1, 1);
                script.maxScatterRadius = 4.0;
                script.waveSpeed = 5.0;
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Pieces-recover script created with config:', {
                    center: script.center,
                    scatterDistance: script.scatterDistance,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create pieces-recover script:', error);
            return null;
        }
    }

    /**
     * 创建 perlin-wave 效果脚本
     */
    private createPerlinWaveScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create perlin-wave script - entity or script component not ready');
            return null;
        }

        console.log('Creating perlin-wave reveal script');

        try {
            const script = this.gsplatEntity.script.create(GsplatRevealPerlinWave) as any;
            if (script) {
                // 配置script属性
                script.intensity = 0.5;
                script.waveAmplitude = 0.1;
                script.waveFrequency = 1.0;
                script.waveSpeed = 1.0;
                script.scaleBlend = 1.0;
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Perlin-wave script created with config:', {
                    center: script.center,
                    intensity: script.intensity,
                    waveAmplitude: script.waveAmplitude,
                    waveFrequency: script.waveFrequency,
                    waveSpeed: script.waveSpeed,
                    scaleBlend: script.scaleBlend,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create perlin-wave script:', error);
            return null;
        }
    }

    /**
     * 创建 integrate 效果脚本
     */
    private createIntegrateScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create integrate script - entity or script component not ready');
            return null;
        }

        console.log('Creating integrate reveal script');

        try {
            const script = this.gsplatEntity.script.create(GsplatIntegrate) as any;
            if (script) {
                // 配置script属性
                script.intensity = 0.5;
                script.speed = 0.8;
                script.waveSpeed = 1.0;
                script.waveFrequency = 3.0;
                
                // 设置 AABB（如果 bbox 存在）
                if (this.bbox) {
                    script.aabbMin = new Vec3(
                        this.bbox.center.x - this.bbox.halfExtents.x,
                        this.bbox.center.y - this.bbox.halfExtents.y,
                        this.bbox.center.z - this.bbox.halfExtents.z
                    );
                    script.aabbMax = new Vec3(
                        this.bbox.center.x + this.bbox.halfExtents.x,
                        this.bbox.center.y + this.bbox.halfExtents.y,
                        this.bbox.center.z + this.bbox.halfExtents.z
                    );
                } else {
                    // 默认 AABB
                    script.aabbMin = new Vec3(-0.5, -0.5, -0.5);
                    script.aabbMax = new Vec3(0.5, 0.5, 0.5);
                }
                
                // 设置 topY 和 bottomY（基于 bbox 或默认值）
                if (this.bbox) {
                    script.topY = this.bbox.center.y + this.bbox.halfExtents.y * 0.35;
                    script.bottomY = this.bbox.center.y - this.bbox.halfExtents.y;
                } else {
                    script.topY = 10.0;
                    script.bottomY = -10.0;
                }
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Integrate script created with config:', {
                    intensity: script.intensity,
                    speed: script.speed,
                    aabbMin: script.aabbMin,
                    aabbMax: script.aabbMax,
                    topY: script.topY,
                    bottomY: script.bottomY,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create integrate script:', error);
            return null;
        }
    }

    /**
     * 创建指定类型的reveal效果 - 类似原始实现中的createEffect函数
     */
    private createEffect(effectName: RevealEffectType) {
        if (!this.gsplatEntity || !this.config) {
            console.log('Cannot create effect - entity not ready or config not set');
            return;
        }

        console.log('Creating effect:', effectName, 'for entity:', this.gsplatEntity.name);
        console.log('GSplat entity details:', {
            hasGsplat: !!this.gsplatEntity.gsplat,
            hasScript: !!this.gsplatEntity.script,
            gsplatMaterial: this.gsplatEntity.gsplat?.material,
            gsplatUnified: (this.gsplatEntity.gsplat as any)?.unified
        });

        // 确保实体有script组件
        if (!this.gsplatEntity.script) {
            this.gsplatEntity.addComponent('script');
            console.log('Added script component to gsplat entity');
        }

        // 销毁现有的reveal scripts - 类似原始实现
        this.destroyAllRevealScripts();

        // 根据类型创建对应的script
        let script = null;
        switch (effectName) {
            case 'radial':
                script = this.createRadialScript();
                break;
            case 'rain':
                script = this.createRainScript();
                break;
            case 'smooth':
                script = this.createSmoothScript();
                break;
            case 'pieces-recover':
                script = this.createPiecesRecoverScript();
                break;
            case 'perlin-wave':
                script = this.createPerlinWaveScript();
                break;
            case 'integrate':
                script = this.createIntegrateScript();
                break;
            case 'none':
                // 不创建任何效果
                script = null;
                break;
            default:
                console.warn('Unknown effect type:', effectName);
                script = this.createRadialScript();
        }

        this.currentScript = script;
        this.config.type = effectName;

        // 如果script创建成功，设置初始状态
        if (script) {
            // 重置 effectTime
            script.effectTime = 0;
            
            // 根据 autoStart 配置设置启用状态
            script.enabled = this.config.autoStart;
        }
        
        // 触发事件以更新 UI（统一使用 revealType:changed）
        this.global.events.fire('revealType:changed', effectName);
        this.global.state.vfxType = effectName as any;
    }

    /**
     * 销毁所有reveal scripts
     */
    private destroyAllRevealScripts() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            return;
        }

        console.log('Destroying all reveal scripts');

        try {
            // 销毁所有类型的reveal scripts
            this.gsplatEntity.script.destroy('gsplatRevealRadial');
            this.gsplatEntity.script.destroy('gsplatRevealRain');
            this.gsplatEntity.script.destroy('gsplatRevealSmooth');
            this.gsplatEntity.script.destroy('gsplatRevealPiecesRecover');
            this.gsplatEntity.script.destroy('gsplatRevealPerlinWave');
            this.gsplatEntity.script.destroy('gsplatIntegrate');
            // 未来可以添加更多类型
        } catch (error) {
            console.warn('Error destroying reveal scripts:', error);
        }

        this.currentScript = null;
    }

    updateConfig(newConfig: Partial<RevealConfig>) {
        const oldType = this.config.type;
        
        Object.assign(this.config, newConfig);
        
        // Also update the settings object so UI can read it
        if (this.global.settings.revealEffect) {
            Object.assign(this.global.settings.revealEffect, newConfig);
        }
        
        console.log('Updated reveal config:', this.config);

        // 如果类型改变，重新创建效果并重置动画
        if (newConfig.type && newConfig.type !== oldType) {
            this.createEffect(newConfig.type);
            // 触发事件以更新 UI（统一使用 revealType:changed）
            this.global.events.fire('revealType:changed', newConfig.type);
            // 重置播放动画
            this.global.events.fire('inputEvent', 'resetAnim');
        }

        // 更新现有script的配置
        else if (this.currentScript) {
            this.updateCurrentScriptConfig(newConfig as Partial<RevealConfig>);
        }
    }

    /**
     * 更新当前script的配置
     */
    private updateCurrentScriptConfig(newConfig: Partial<RevealConfig>) {
        if (!this.currentScript) return;

        console.log('Updating current script config');

        try {
            if (newConfig.radius !== undefined) {
                this.currentScript.setRadius?.(newConfig.radius) || 
                (this.currentScript.radius = newConfig.radius);
            }
        } catch (error) {
            console.warn('Error updating script config:', error);
        }
    }

    restart() {
        if (!this.config || this.config.type === 'none') {
            console.log('No reveal effect active, cannot restart');
            return;
        }
        
        console.log('Restarting reveal effect:', this.config.type);
        
        // 先禁用当前效果（如果存在），确保清理状态
        if (this.currentScript) {
            this.currentScript.enabled = false;
        }
        
        // 重新创建效果（会自动根据 autoStart 配置启用，并重置 effectTime）
        this.createEffect(this.config.type);
    }

    // 公共方法
    isRevealActive(): boolean {
        return this.currentScript?.enabled || false;
    }

    getProgress(): number {
        if (!this.currentScript || !this.config) {
            return this.config ? 1 : 0;
        }
        
        try {
            return this.currentScript.getProgress?.() || 0;
        } catch (error) {
            return 0;
        }
    }

    setRevealCenter(center: number[]) {
        if (!this.config) {
            console.warn('Cannot set reveal center - no config');
            return;
        }
        
        // 保存到实例变量
        this.revealCenter = center;
        console.log('Reveal center set to:', center);
        
        // 更新当前script的中心点
        if (this.currentScript) {
            try {
                if (this.currentScript.setCenter) {
                    // setCenter 需要 Vec3 对象
                    const centerVec3 = new Vec3(center[0], center[1], center[2]);
                    this.currentScript.setCenter(centerVec3);
                } else if (this.currentScript.center) {
                    // 直接设置 center 属性
                    this.currentScript.center.set(center[0], center[1], center[2]);
                }
            } catch (error) {
                console.warn('Error setting reveal center:', error);
            }
        }
    }

    getCurrentScript() {
        return this.currentScript;
    }

    /**
     * 更新脚本的 center（统一处理坐标转换）
     * 优先使用当前相机 target，如果没有则使用 revealCenter
     */
    private updateScriptCenter(script: any) {
        if (!script || !script.center) {
            return;
        }

        // 优先使用相机当前 target 点（如果可用）
        if (this.cameraManager) {
            const camera = this.cameraManager.camera;
            const targetPoint = new Vec3();
            camera.calcFocusPoint(targetPoint);
            // CRITICAL: 坐标转换 - gsplat 坐标系需要翻转 X 和 Y 轴
            script.center.set(-targetPoint.x, -targetPoint.y, targetPoint.z);
        } else if (this.revealCenter) {
            // 使用默认 reveal center
            script.center.set(-this.revealCenter[0], -this.revealCenter[1], this.revealCenter[2]);
        }
    }

    destroy() {
        console.log('Destroying RevealController');
        this.destroyAllRevealScripts();
    }
}