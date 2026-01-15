import type { Entity, BoundingBox } from 'playcanvas';
import { Vec3 } from 'playcanvas';
import { Global } from './types';
import { GsplatRevealGrow } from './vfx/gsplat-grow';
import { GsplatRevealPiecesRecover } from './vfx/gsplat-pieces-recover';
import { GsplatRevealPerlinWave } from './vfx/gsplat-perlin-wave';
import { GsplatDisintegrate } from './vfx/gsplat-disintegrate';
import type { CameraManager } from './camera-manager';

/**
 * VFX effect type
 */
export type VfxEffectType = 'grow' | 'pieces-recover' | 'perlin-wave' | 'disintegrate' | 'none';

/**
 * VFX configuration
 */
export interface VfxConfig {
    type: VfxEffectType;
    enabled?: boolean;
    // 未来视频导出相关配置
    recordForExport?: boolean;
    exportDuration?: number;
}

/**
 * VFX Controller - 管理 VFX shader 效果的加载、控制和切换
 * 
 * 支持的效果：
 * - grow: 垂直生长效果
 * - pieces-recover: 碎片恢复效果
 * - perlin-wave: Perlin 波浪效果
 * - disintegrate: 分解效果
 * 
 * 架构设计考虑：
 * - 支持未来视频导出功能（记录时间、状态等）
 * - 可以记录效果的时间线数据用于导出
 * - 支持暂停/恢复效果用于视频录制
 */
export class VfxController {
    private gsplatEntity: Entity | null = null;
    private config: VfxConfig;
    private currentScript: any = null;
    private vfxCenter: number[] = [0, 0, 0];
    private bbox: BoundingBox | null = null;
    private cameraManager: CameraManager | null = null;
    
    // 视频导出相关状态（未来扩展）
    private isRecording: boolean = false;
    private recordingStartTime: number = 0;
    private recordingFrames: any[] = []; // 用于存储录制帧数据
    
    global: Global;

    constructor(global: Global, bbox: BoundingBox, gsplatEntity: Entity, cameraManager?: CameraManager | null) {
        this.global = global;
        const { settings, events, state } = global;
        this.gsplatEntity = gsplatEntity;
        this.bbox = bbox;
        this.cameraManager = cameraManager || null;
        
        // 初始化配置（可以从 settings 中读取，或使用默认值）
        this.config = {
            type: 'none',
            enabled: false,
            recordForExport: false,
            exportDuration: 0
        };
        
        // 使用相机的 look target 作为默认 vfx center，如果没有则使用 bbox.center
        const cameraTarget = settings.cameras?.[0]?.initial?.target;
        this.vfxCenter = cameraTarget ? cameraTarget : bbox.center.toArray();
        
        // 监听配置变化
        events.on('vfxConfigChanged', (newConfig: Partial<VfxConfig>) => {
            console.log('VFX config changed:', newConfig);
            this.updateConfig(newConfig);
        });
        
        // 监听切换请求
        events.on('vfxSwitch', (effectType: VfxEffectType) => {
            console.log('VFX switch requested:', effectType);
            this.switchEffect(effectType);
        });
        
        // 监听启用/禁用请求
        events.on('vfxToggle', (enabled: boolean) => {
            console.log('VFX toggle requested:', enabled);
            this.setEnabled(enabled);
        });
        
        // 监听重启请求
        events.on('vfxRestart', () => {
            console.log('VFX restart requested via event');
            this.restart();
        });
        
        // 监听视频录制相关事件（未来扩展）
        events.on('vfxStartRecording', () => {
            this.startRecording();
        });
        
        events.on('vfxStopRecording', () => {
            this.stopRecording();
        });
    }

    /**
     * 创建 grow 效果脚本
     */
    private createGrowScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create grow script - entity or script component not ready');
            return null;
        }

        console.log('Creating grow VFX script');

        try {
            const script = this.gsplatEntity.script.create(GsplatRevealGrow) as any;
            if (script) {
                // 配置script属性
                // 优先使用相机移动限制 boxConstraint 的最高点作为 topY（起始位置），否则使用 bbox
                if (this.bbox) {
                    const targetConstraint = this.cameraManager?.getTargetConstraint();
                    
                    if (targetConstraint) {
                        const constraintBbox = targetConstraint.bbox;
                        script.topY = constraintBbox.center.y + constraintBbox.halfExtents.y;
                        console.log('Using targetConstraint bounding box maximum Y as topY:', {
                            topY: script.topY,
                            'bbox topY': this.bbox.center.y + this.bbox.halfExtents.y,
                            'constraint center': constraintBbox.center.y,
                            'constraint halfExtents': constraintBbox.halfExtents.y
                        });
                    } else {
                        script.topY = this.bbox.center.y + this.bbox.halfExtents.y;
                        console.log('Using bbox maximum Y as topY:', script.topY);
                    }
                    
                    script.bottomY = this.bbox.center.y - this.bbox.halfExtents.y;
                    
                    // 设置 AABB 用于 crop 效果
                    script.aabbMin.set(
                        this.bbox.center.x - this.bbox.halfExtents.x,
                        this.bbox.center.y - this.bbox.halfExtents.y,
                        this.bbox.center.z - this.bbox.halfExtents.z
                    );
                    script.aabbMax.set(
                        this.bbox.center.x + this.bbox.halfExtents.x,
                        this.bbox.center.y + this.bbox.halfExtents.y,
                        this.bbox.center.z + this.bbox.halfExtents.z
                    );
                } else {
                    const targetConstraint = this.cameraManager?.getTargetConstraint();
                    
                    if (targetConstraint) {
                        const constraintBbox = targetConstraint.bbox;
                        script.topY = constraintBbox.center.y + constraintBbox.halfExtents.y;
                        script.bottomY = script.topY - 10.0;
                        console.log('Using targetConstraint bounding box maximum Y as topY (no bbox):', {
                            topY: script.topY,
                            bottomY: script.bottomY
                        });
                    } else {
                        script.bottomY = -5.0;
                        script.topY = 5.0;
                    }
                    
                    script.aabbMin.set(-10, -10, -10);
                    script.aabbMax.set(10, 10, 10);
                }
                
                script.growthSpeed = 2.0;
                script.fadeWidthRatio = 0.1;
                script.edgeScaleFactor = 0.5;
                
                // 设置 vfx center
                if (script.center && this.vfxCenter) {
                    script.center.set(-this.vfxCenter[0], -this.vfxCenter[1], this.vfxCenter[2]);
                }
                
                // 初始状态根据配置决定
                script.enabled = this.config.enabled ?? false;
                
                console.log('Grow script created with config:', {
                    center: script.center,
                    bottomY: script.bottomY,
                    topY: script.topY,
                    growthSpeed: script.growthSpeed,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create grow script:', error);
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

        console.log('Creating pieces-recover VFX script');

        try {
            const script = this.gsplatEntity.script.create(GsplatRevealPiecesRecover) as any;
            if (script) {
                // 配置script属性
                script.scatterDistance = 2.0;
                script.scatterDuration = 7.0; // Slow scatter (total 10-15s)
                script.holdDuration = 0;
                script.recoverDuration = 7.0; // Slow recovery (total 10-15s)
                script.noiseIntensity = 0.3;
                script.scatterDirection.set(1, 1, 1);
                script.maxScatterRadius = 2.0; // Small radius for spray effect
                script.waveSpeed = 5.0; // Wave propagation speed
                
                // 设置 vfx center (使用相机当前target点)
                // 每次重启时都根据最新的相机target来设置
                // CRITICAL: 需要坐标转换 - gsplat 坐标系需要翻转 X 和 Y 轴
                if (script.center && this.cameraManager) {
                    const camera = this.cameraManager.camera;
                    const targetPoint = new Vec3();
                    camera.calcFocusPoint(targetPoint);
                    // 坐标转换：翻转 X 和 Y 轴，保持 Z 轴不变（与 reveal.ts 中的处理一致）
                    script.center.set(-targetPoint.x, -targetPoint.y, targetPoint.z);
                    console.log('Pieces-recover center set to current camera target (with coordinate transform):', {
                        originalTarget: targetPoint,
                        transformedCenter: script.center
                    });
                } else if (script.center && this.vfxCenter) {
                    // 如果没有相机管理器，使用备用方案（已经包含坐标转换）
                    script.center.set(-this.vfxCenter[0], -this.vfxCenter[1], this.vfxCenter[2]);
                }
                
                // 初始状态根据配置决定
                script.enabled = this.config.enabled ?? false;
                
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

        console.log('Creating perlin-wave VFX script');

        try {
            const script = this.gsplatEntity.script.create(GsplatRevealPerlinWave) as any;
            if (script) {
                // 配置script属性
                script.intensity = 0.5;
                script.waveAmplitude = 0.1;
                script.waveFrequency = 1.0;
                script.waveSpeed = 1.0;
                script.scaleBlend = 1.0;
                
                // 设置 vfx center
                if (script.center && this.vfxCenter) {
                    script.center.set(-this.vfxCenter[0], -this.vfxCenter[1], this.vfxCenter[2]);
                }
                
                // 初始状态根据配置决定
                script.enabled = this.config.enabled ?? false;
                
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
     * 创建 disintegrate 效果脚本
     */
    private createDisintegrateScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create disintegrate script - entity or script component not ready');
            return null;
        }

        console.log('Creating disintegrate VFX script');

        try {
            const script = this.gsplatEntity.script.create(GsplatDisintegrate) as any;
            if (script) {
                // 配置script属性
                script.intensity = 0.5;
                
                // 初始状态根据配置决定
                script.enabled = this.config.enabled ?? false;
                
                console.log('Disintegrate script created with config:', {
                    intensity: script.intensity,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create disintegrate script:', error);
            return null;
        }
    }

    /**
     * 创建指定类型的 VFX 效果
     */
    private createEffect(effectType: VfxEffectType) {
        if (!this.gsplatEntity) {
            console.log('Cannot create effect - entity not ready');
            return;
        }

        console.log('Creating VFX effect:', effectType, 'for entity:', this.gsplatEntity.name);

        // 确保实体有script组件
        if (!this.gsplatEntity.script) {
            this.gsplatEntity.addComponent('script');
            console.log('Added script component to gsplat entity');
        }

        // 销毁现有的 VFX scripts
        this.destroyAllVfxScripts();

        // 根据类型创建对应的script
        let script = null;
        switch (effectType) {
            case 'grow':
                script = this.createGrowScript();
                break;
            case 'pieces-recover':
                script = this.createPiecesRecoverScript();
                break;
            case 'perlin-wave':
                script = this.createPerlinWaveScript();
                break;
            case 'disintegrate':
                script = this.createDisintegrateScript();
                break;
            case 'none':
                // 不创建任何效果
                script = null;
                break;
            default:
                console.warn('Unknown VFX effect type:', effectType);
                script = null;
        }

        this.currentScript = script;
        this.config.type = effectType;
    }

    /**
     * 销毁所有 VFX scripts
     */
    private destroyAllVfxScripts() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            return;
        }

        console.log('Destroying all VFX scripts');

        try {
            // 销毁所有类型的 VFX scripts
            this.gsplatEntity.script.destroy('gsplatRevealGrow');
            this.gsplatEntity.script.destroy('gsplatRevealPiecesRecover');
            this.gsplatEntity.script.destroy('gsplatRevealPerlinWave');
            this.gsplatEntity.script.destroy('gsplatDisintegrate');
        } catch (error) {
            console.warn('Error destroying VFX scripts:', error);
        }

        this.currentScript = null;
    }

    /**
     * 更新配置
     */
    updateConfig(newConfig: Partial<VfxConfig>) {
        const oldType = this.config.type;
        
        Object.assign(this.config, newConfig);
        
        // 如果类型改变，重新创建效果
        if (newConfig.type && newConfig.type !== oldType) {
            this.createEffect(newConfig.type);
        }
        
        // 更新启用状态
        if (newConfig.enabled !== undefined) {
            this.setEnabled(newConfig.enabled);
        }
    }

    /**
     * 切换效果
     */
    switchEffect(effectType: VfxEffectType) {
        this.config.type = effectType;
        this.createEffect(effectType);
        
        // 更新 state
        this.global.state.vfxType = effectType;
        this.global.events.fire('vfxType:changed', effectType);
        
        // 如果切换后效果不为 none，且当前未启用，则启用它
        if (effectType !== 'none' && !this.config.enabled) {
            this.setEnabled(true);
        } else if (effectType === 'none') {
            // 如果切换到 none，禁用效果
            this.setEnabled(false);
        }
    }

    /**
     * 设置启用/禁用状态
     */
    setEnabled(enabled: boolean) {
        this.config.enabled = enabled;
        
        if (this.currentScript) {
            this.currentScript.enabled = enabled;
            console.log('VFX effect', this.config.type, enabled ? 'enabled' : 'disabled');
        }
        
        // 更新 state
        this.global.state.vfxActive = enabled;
        this.global.events.fire('vfxActive:changed', enabled);
    }

    /**
     * 重启当前效果
     */
    restart() {
        if (this.config.type === 'none') {
            console.log('No VFX effect active, cannot restart');
            return;
        }
        
        console.log('Restarting VFX effect:', this.config.type);
        
        // 重新创建效果
        this.createEffect(this.config.type);
        
        // 如果配置为启用，则启用它
        if (this.config.enabled) {
            setTimeout(() => {
                if (this.currentScript) {
                    // 在启用前再次更新 center（确保使用最新的相机 target）
                    if (this.config.type === 'pieces-recover' && this.cameraManager) {
                        const camera = this.cameraManager.camera;
                        const targetPoint = new Vec3();
                        camera.calcFocusPoint(targetPoint);
                        // CRITICAL: 坐标转换 - gsplat 坐标系需要翻转 X 和 Y 轴（与 reveal.ts 中的处理一致）
                        this.currentScript.center.set(-targetPoint.x, -targetPoint.y, targetPoint.z);
                        
                        // 标记 center 已更新，以便在 updateEffect 中强制更新 uniform
                        if (this.currentScript._centerUpdatedOnEnable !== undefined) {
                            this.currentScript._centerUpdatedOnEnable = true;
                        }
                        
                        console.log('Pieces-recover center updated to current camera target before enabling (with coordinate transform):', {
                            originalTarget: targetPoint,
                            transformedCenter: this.currentScript.center,
                            x: this.currentScript.center.x,
                            y: this.currentScript.center.y,
                            z: this.currentScript.center.z
                        });
                    }
                    this.currentScript.enabled = true;
                    
                    // 在启用后立即更新一次 uniform（确保 materials 已准备好）
                    if (this.config.type === 'pieces-recover' && this.currentScript) {
                        setTimeout(() => {
                            if (this.currentScript && this.currentScript.materialsApplied && this.currentScript.materialsApplied.size > 0) {
                                const centerArray = [
                                    this.currentScript.center.x,
                                    this.currentScript.center.y,
                                    this.currentScript.center.z
                                ];
                                this.currentScript.setUniform('uCenter', centerArray);
                                console.log('Pieces-recover center uniform updated after enabling:', centerArray);
                            }
                        }, 50);
                    }
                    // 确保 effectTime 重置（虽然基类会在 enable 时重置，但这里明确一下）
                    if (this.currentScript.effectTime !== undefined) {
                        this.currentScript.effectTime = 0;
                    }
                }
            }, 100);
        }
    }

    /**
     * 开始录制（用于视频导出）
     */
    startRecording() {
        if (this.isRecording) {
            console.warn('Already recording');
            return;
        }
        
        this.isRecording = true;
        this.recordingStartTime = Date.now();
        this.recordingFrames = [];
        
        console.log('Started recording VFX for export');
        
        // 如果当前效果未启用，启用它
        if (!this.config.enabled && this.config.type !== 'none') {
            this.setEnabled(true);
        }
    }

    /**
     * 停止录制（用于视频导出）
     */
    stopRecording() {
        if (!this.isRecording) {
            console.warn('Not recording');
            return;
        }
        
        this.isRecording = false;
        const duration = (Date.now() - this.recordingStartTime) / 1000;
        
        console.log('Stopped recording VFX. Duration:', duration, 'seconds. Frames:', this.recordingFrames.length);
        
        // 这里可以触发导出事件或保存录制数据
        // this.global.events.fire('vfxRecordingComplete', { duration, frames: this.recordingFrames });
    }

    /**
     * 记录一帧数据（用于视频导出）
     * 这个方法可以在每帧渲染时调用
     */
    recordFrame(frameData: any) {
        if (!this.isRecording) {
            return;
        }
        
        const timestamp = (Date.now() - this.recordingStartTime) / 1000;
        this.recordingFrames.push({
            timestamp,
            effectType: this.config.type,
            enabled: this.config.enabled,
            ...frameData
        });
    }

    /**
     * 公共方法：检查效果是否激活
     */
    isVfxActive(): boolean {
        return this.currentScript?.enabled || false;
    }

    /**
     * 公共方法：获取当前效果类型
     */
    getCurrentEffectType(): VfxEffectType {
        return this.config.type;
    }

    /**
     * 公共方法：获取进度（如果效果支持）
     */
    getProgress(): number {
        if (!this.currentScript || this.config.type === 'none') {
            return 0;
        }
        
        try {
            return this.currentScript.getProgress?.() || 0;
        } catch (error) {
            return 0;
        }
    }

    /**
     * 公共方法：设置 VFX 中心点
     */
    setVfxCenter(center: number[]) {
        this.vfxCenter = center;
        console.log('VFX center set to:', center);
        
        // 更新当前script的中心点
        if (this.currentScript) {
            try {
                if (this.currentScript.setCenter) {
                    const centerVec3 = new Vec3(center[0], center[1], center[2]);
                    this.currentScript.setCenter(centerVec3);
                } else if (this.currentScript.center) {
                    this.currentScript.center.set(center[0], center[1], center[2]);
                }
            } catch (error) {
                console.warn('Error setting VFX center:', error);
            }
        }
    }

    /**
     * 公共方法：获取当前脚本
     */
    getCurrentScript() {
        return this.currentScript;
    }

    /**
     * 销毁 VFX Controller
     */
    destroy() {
        console.log('Destroying VfxController');
        this.destroyAllVfxScripts();
        
        // 清理录制数据
        this.recordingFrames = [];
        this.isRecording = false;
    }
}
