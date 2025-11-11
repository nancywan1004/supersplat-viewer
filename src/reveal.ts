import type { Entity, BoundingBox } from 'playcanvas';
import { GsplatRevealRadial } from './gsplat-reveal-radial';
import { GsplatRevealRain } from './gsplat-reveal-rain';
import { Global } from './types';
import { RevealEffect as RevealConfig } from './settings';
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
        const { app, settings, events } = global;
        this.gsplatEntity = gsplatEntity;
        this.config = {
            enabled: (settings.revealEffect as any).enabled ?? true,
            type: (settings.revealEffect as any).type ?? 'radial',
            duration: (settings.revealEffect as any).duration ?? 3.0,
            center: (settings.revealEffect as any).center ?? [0, 0, 0],
            radius: (settings.revealEffect as any).radius ?? 10,
            autoStart: (settings.revealEffect as any).autoStart ?? true
        };

        if (!this.config) {
            console.log('No reveal effect specified, default to none.')
            return;
        }

        console.log('RevealController initialized with config:', this.config);

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

        this.setRevealCenter(bbox.center.toArray());
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
                script.center.set(this.config.center[0], this.config.center[1], this.config.center[2]);
                script.speed = 5;
                script.acceleration = 0;
                script.delay = 0.5; // 减少延迟以便更快看到效果
                script.dotTint.set(0, 1, 1); // Cyan
                script.waveTint.set(1, 0.5, 0); // Orange
                script.oscillationIntensity = 0.2;
                script.endRadius = this.config.radius;
                
                // 初始状态设为禁用，等待手动启动
                script.enabled = false;
                
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
                script.center.set(this.config.center[0], this.config.center[1], this.config.center[2]);
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
                script.enabled = false;
                
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
     * 创建grid reveal script - 预留给未来实现
     */
    private createGridScript() {
        console.warn('Grid reveal script not implemented yet');
        // 回退到radial
        return this.createRadialScript();
    }

    /**
     * 创建指定类型的reveal效果 - 类似原始实现中的createEffect函数
     */
    private createEffect(effectName: 'radial' | 'rain' | 'grid') {
        if (!this.gsplatEntity || !this.config.enabled) {
            console.log('Cannot create effect - entity not ready or disabled');
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
            case 'grid':
                script = this.createGridScript();
                break;
            default:
                console.warn('Unknown effect type:', effectName);
                script = this.createRadialScript();
        }

        this.currentScript = script;

        // 如果script创建成功且配置为自动启动，则启用script
        if (script && this.config.autoStart) {
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
        }
    }

    /**
     * 销毁所有reveal scripts - 类似原始实现
     */
    private destroyAllRevealScripts() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            return;
        }

        console.log('Destroying all reveal scripts');

        try {
            // 销毁所有类型的reveal scripts
            this.gsplatEntity.script.destroy(typeof GsplatRevealRadial);
            this.gsplatEntity.script.destroy(typeof GsplatRevealRain);
            // 未来可以添加更多类型
        } catch (error) {
            console.warn('Error destroying reveal scripts:', error);
        }

        this.currentScript = null;
    }

    updateConfig(newConfig: Partial<RevealConfig>) {
        const oldType = this.config.type;
        const wasEnabled = this.config.enabled;
        
        Object.assign(this.config, newConfig);
        
        console.log('Updated reveal config:', this.config);

        // 如果类型改变，重新创建效果
        if (newConfig.type && newConfig.type !== oldType) {
            this.createEffect(newConfig.type);
        }
        // 如果启用状态改变，重新创建效果
        else if (newConfig.enabled !== undefined && newConfig.enabled !== wasEnabled) {
            if (newConfig.enabled) {
                this.createEffect(this.config.type);
            } else {
                this.destroyAllRevealScripts();
            }
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
            if (newConfig.center) {
                this.currentScript.setCenter?.(newConfig.center) || 
                this.currentScript.center?.copy(newConfig.center);
            }
            if (newConfig.radius !== undefined) {
                this.currentScript.setRadius?.(newConfig.radius) || 
                (this.currentScript.radius = newConfig.radius);
            }
            if (newConfig.duration !== undefined) {
                this.currentScript.duration = newConfig.duration;
            }
            if (newConfig.enabled !== undefined) {
                this.currentScript.revealEnabled = newConfig.enabled;
            }
        } catch (error) {
            console.warn('Error updating script config:', error);
        }
    }

    // 公共方法 - 启动和停止效果
    startReveal() {
        console.log('Manual start reveal requested');
        if (!this.config.enabled || !this.currentScript) {
            console.log('Cannot start reveal - not enabled or no script');
            return;
        }

        try {
            // 启用script来开始效果
            this.currentScript.enabled = true;
            console.log('Script enabled manually');
        } catch (error) {
            console.error('Failed to start reveal:', error);
        }
    }

    stopReveal() {
        console.log('Manual stop reveal requested');
        if (!this.currentScript) return;

        try {
            // 禁用script来停止效果
            this.currentScript.enabled = false;
            console.log('Script disabled manually');
        } catch (error) {
            console.error('Failed to stop reveal:', error);
        }
    }

    restart() {
        console.log('Manual restart reveal requested - recreating effect');
        // 类似原始实现的restart - 重新创建效果
        this.createEffect(this.config.type);
    }

    // 公共方法
    isRevealActive(): boolean {
        return this.currentScript?.enabled || false;
    }

    getProgress(): number {
        if (!this.currentScript) {
            return this.config.enabled ? 1 : 0;
        }
        
        try {
            return this.currentScript.getProgress?.() || 0;
        } catch (error) {
            return 0;
        }
    }

    setRevealCenter(center: number[]) {
        this.config.center = [...center];
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