import type { Entity, BoundingBox } from 'playcanvas';
import { GsplatRevealRadial } from './reveal-effect/gsplat-reveal-radial';
import { GsplatRevealRain } from './reveal-effect/gsplat-reveal-rain';
import { Global } from './types';
import { RevealEffect as RevealConfig } from './settings';
import { GsplatRevealSmooth } from './reveal-effect/gsplat-reveal-smooth';
// import { GsplatRevealRadial } from 'playcanvas/scripts/esm/gsplat/reveal-radial.mjs';
// import { GsplatRevealRain } from 'playcanvas/scripts/esm/gsplat/reveal-rain.mjs';

/**
 * Script-based Reveal Controller - 基于原始reveal.example.mjs的实现
 * 使用createRadialScript等方法来创建和管理reveal scripts
 */
export class RevealController {
    private gsplatEntity: Entity | null = null;
    private config: RevealConfig;
    private currentScript: any = null;

    global: Global;

    constructor(global: Global, bbox: BoundingBox, gsplatEntity: Entity) {
        this.global = global;
        const { settings, events, state } = global;
        this.gsplatEntity = gsplatEntity;
        
        // Check if revealEffect is empty or has no type
        const hasRevealEffect = settings.revealEffect && 
                                Object.keys(settings.revealEffect).length > 0 && 
                                settings.revealEffect.type;
        
        if (!hasRevealEffect) {
            console.log('No reveal effect specified, skipping reveal initialization.');
            state.hasRevealEffect = false;
            return;
        }

        this.config = {
            type: settings.revealEffect.type ?? 'radial',
            radius: settings.revealEffect.radius ?? 10,
            autoStart: settings.revealEffect.autoStart ?? true
        };

        console.log('RevealController initialized with config:', this.config);
        
        // Set state to indicate reveal effect is available
        state.hasRevealEffect = true;

        // 监听配置变化
        events.on('revealConfigChanged', (newConfig: Partial<RevealConfig>) => {
            console.log('Reveal config changed:', newConfig);
            this.updateConfig(newConfig);
        });

        // 监听重启请求
        events.on('revealRestart', () => {
            console.log('Reveal restart requested via event');
            this.restart();
        });

        // 使用相机的 look target 作为默认 reveal center，如果没有则使用 bbox.center
        const cameraTarget = settings.cameras?.[0]?.initial?.target;
        const revealCenter = cameraTarget ? cameraTarget : bbox.center.toArray();
        this.setRevealCenter(revealCenter);
        
        // 创建初始效果
        this.createEffect(this.config.type);
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
                
                // 初始状态设为禁用，等待手动启动
                script.enabled = true;
                
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
                
                // 初始状态设为禁用，等待手动启动
                script.enabled = true;
                
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
                
                // 初始状态设为禁用，等待手动启动
                script.enabled = true;
                
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
     * 创建指定类型的reveal效果 - 类似原始实现中的createEffect函数
     */
    private createEffect(effectName: 'radial' | 'rain' | 'smooth') {
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
            default:
                console.warn('Unknown effect type:', effectName);
                script = this.createRadialScript();
        }

        this.currentScript = script;

        // 如果script创建成功
        if (script) {
            if (this.config.autoStart) {
                console.log('Auto-starting reveal effect by enabling script');
                setTimeout(() => {
                    if (script) {
                        script.enabled = true;
                        console.log('Script enabled, effect should start. Script details:', {
                            enabled: script.enabled,
                            initialized: script.initialized,
                            materialsApplied: script.materialsApplied?.size || 0
                        });
                    }
                }, 1000); // 增加延迟确保gsplat完全加载
            } else {
                console.log('Reveal effect created but not auto-started. Click "Start Reveal" button to begin.');
                script.enabled = false;
            }
        }
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

        // 如果类型改变，重新创建效果
        if (newConfig.type && newConfig.type !== oldType) {
            this.createEffect(newConfig.type);
        }

        // 更新现有script的配置
        else if (this.currentScript) {
            this.updateCurrentScriptConfig(newConfig);
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
        if (!this.config) {
            console.log('No reveal config, cannot start reveal');
            return;
        }
        
        console.log('Manual start/restart reveal requested - recreating effect');
        // 临时设置 autoStart 为 true 以启动效果
        const originalAutoStart = this.config.autoStart;
        this.config.autoStart = true;
        
        // 重新创建效果
        this.createEffect(this.config.type);
        
        // 恢复原始设置
        this.config.autoStart = originalAutoStart;
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
        console.log('Reveal center set to:', center);
        
        // 更新当前script的中心点
        if (this.currentScript) {
            try {
                if (this.currentScript.setCenter) {
                    this.currentScript.setCenter(center);
                } else if (this.currentScript.center) {
                    this.currentScript.center.copy(center);
                }
            } catch (error) {
                console.warn('Error setting reveal center:', error);
            }
        }
    }

    getCurrentScript() {
        return this.currentScript;
    }

    destroy() {
        console.log('Destroying RevealController');
        this.destroyAllRevealScripts();
    }
}