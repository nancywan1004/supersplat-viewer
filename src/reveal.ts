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
import { GsplatRainV2 } from './vfx/gsplat-rain';
import { GsplatRevealGrowthWave } from './vfx/gsplat-growth-wave';
import { GsplatSketch } from './vfx/gsplat-sketch';
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
export type RevealEffectType = 'radial' | 'rain' | 'rain_v2' | 'smooth' | 'pieces-recover' | 'perlin-wave' | 'integrate' | 'growth-wave' | 'sketch' | 'none';

export class RevealController {
    private gsplatEntity: Entity | null = null;
    private config: RevealConfig;
    private currentScript: any = null;
    private revealCenter: number[] = [0, 0, 0];
    private bbox: BoundingBox | null = null;
    private cameraManager: CameraManager | null = null;
    /** unified 渲染模式标记（shader 接收 world-space 坐标） */
    private isUnified: boolean = false;
    
    // 计时相关
    private effectStartTime: number | null = null;
    private effectEndTime: number | null = null;
    private isTiming: boolean = false;
    private timedEffects = ['rain_v2', 'pieces-recover', 'integrate', 'growth-wave', 'sketch'];
    
    // 时间轴控制相关（唯一来源：state.effectPaused）
    private get effectPaused(): boolean {
        return (this.global.state as any).effectPaused ?? false;
    }
    private set effectPaused(v: boolean) {
        (this.global.state as any).effectPaused = v;
    }

    global: Global;

    constructor(global: Global, bbox: BoundingBox, gsplatEntity: Entity, cameraManager?: CameraManager | null) {
        this.global = global;
        const { settings, events, state } = global;
        this.gsplatEntity = gsplatEntity;
        this.bbox = bbox;
        this.cameraManager = cameraManager || null;
        this.isUnified = gsplatEntity.gsplat?.unified ?? false;
        
        // Check if revealEffect is empty or has no type
        const hasRevealEffect = settings.revealEffect && 
                                Object.keys(settings.revealEffect).length > 0 && 
                                settings.revealEffect.type;
        
        // Always initialize (VFX effects don't require revealEffect in settings)
        this.config = {
            type: (settings.revealEffect?.type as RevealEffectType) ?? 'none',
            radius: settings.revealEffect?.radius ?? 10,
            autoStart: settings.revealEffect?.autoStart ?? true,
            totalDuration: settings.revealEffect?.totalDuration ?? 20.0 // 默认 15 秒
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
        events.on('revealRestart', (restartAnimTrack?: boolean) => {
            console.log('Reveal restart requested via event', restartAnimTrack ? '(with animTrack)' : '(without animTrack)');
            this.restart(restartAnimTrack ?? false);
        });

        // 监听时间轴控制事件（交互用：会驱动 UI slider）
        events.on('effectTimeline:set', (time: number) => {
            this.setEffectTime(time);
        });

        // 监听导出专用时间轴事件（离线导出用：不会驱动 UI slider）
        events.on('effectTimeline:setForExport', (time: number) => {
            this.setEffectTimeForExport(time);
        });

        events.on('effectPlayPause:toggle', () => {
            this.togglePlayPause();
        });

        events.on('effectPlayPause:set', (paused: boolean) => {
            this.setPlayPause(paused);
        });

        // 使用相机的 look target 作为默认 reveal center，如果没有则使用 bbox.center
        // revealCenter 统一存储 world-space 坐标。
        // bbox 已按 unified 模式选好坐标空间（viewer.ts 中处理），所以：
        //   - unified=true  → bbox 是 world space，center 可直接用
        //   - unified=false → bbox 是 model space，center 需要转为 world space（取反 X/Y）
        const cameraTarget = settings.cameras?.[0]?.initial?.target;
        if (cameraTarget) {
            this.revealCenter = cameraTarget;
        } else {
            const bc = bbox.center;
            this.revealCenter = this.isUnified
                ? bc.toArray()                      // bbox already world space
                : [-bc.x, -bc.y, bc.z];            // model → world
        }
        
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
     * 创建rain_v2 reveal script - 简化版本的rain效果
     */
    private createRainV2Script() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create rain_v2 script - entity or script component not ready');
            return null;
        }

        console.log('Creating rain_v2 reveal script');
        
        try {
            const script = this.gsplatEntity.script.create(GsplatRainV2) as any;
            if (script) {
                // 配置script属性
                script.intensity = 1.0;
                
                // 根据场景包围盒设置底部Y和高度
                let maxDist2D = 10.0; // 默认最大距离
                if (this.bbox) {
                    const minY = this.bbox.getMin().y;
                    const maxY = this.bbox.getMax().y;
                    // 底部位置：场景底部减去场景高度的10%作为缓冲区
                    script.bottomY = minY - (maxY - minY) * 0.1;
                    // 高度范围：从底部到顶部，再加上一些额外的范围
                    script.rainHeight = maxY - script.bottomY;
                    
                    // 计算最大 2D 距离（从 center 到 bbox 最远角的 xz 平面距离）
                    // 设置 reveal center 后，计算 bbox 在 xz 平面的最大距离
                    this.updateScriptCenter(script);
                    const centerX = script.center.x;
                    const centerZ = script.center.z;
                    const bboxMin = this.bbox.getMin();
                    const bboxMax = this.bbox.getMax();
                    
                    // 计算 bbox 四个角到 center 的 xz 平面距离，取最大值
                    const corners = [
                        [bboxMin.x, bboxMin.z],
                        [bboxMax.x, bboxMin.z],
                        [bboxMin.x, bboxMax.z],
                        [bboxMax.x, bboxMax.z]
                    ];
                    maxDist2D = Math.max(...corners.map(([x, z]) => {
                        const dx = x - centerX;
                        const dz = z - centerZ;
                        return Math.sqrt(dx * dx + dz * dz);
                    }));
                    
                    script.maxDist2D = maxDist2D;
                    
                    console.log('Rain V2 configured with bbox:', {
                        bboxMinY: minY,
                        bboxMaxY: maxY,
                        bottomY: script.bottomY,
                        rainHeight: script.rainHeight,
                        maxDist2D: maxDist2D
                    });
                } else {
                    // 如果没有包围盒，使用默认值
                    script.bottomY = -10.0;
                    script.rainHeight = 15.0;
                    script.maxDist2D = maxDist2D;
                    console.warn('No bbox available, using default bottomY and rainHeight');
                }
                
                // 根据 totalDuration 调整时间参数
                const totalDuration = this.config.totalDuration ?? 20.0;
                // 根据 shader 逻辑计算实际完成时间
                // rawProgress = uTime^2 * 0.1 - dist2D*2.0 + 1.0 >= 5
                // uTime >= sqrt((4 + maxDist2D*2.0) / 0.1)
                const rawProgressThreshold = 5.0;
                const constant = 1.0;
                const timeCoeff = 0.1;
                const distCoeff = 2.0;
                const requiredScaledTime = Math.sqrt(
                    (rawProgressThreshold - constant + maxDist2D * distCoeff) / timeCoeff
                );
                // 通过 timeScale 来适配 totalDuration
                script.timeScale = requiredScaledTime / totalDuration;
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Rain V2 script created with config:', {
                    center: script.center,
                    intensity: script.intensity,
                    bottomY: script.bottomY,
                    rainHeight: script.rainHeight,
                    totalDuration,
                    timeScale: script.timeScale,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create rain_v2 script:', error);
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
                // 默认配置
                const defaultScatterDuration = 7.5;
                const defaultRecoverDuration = 7.5;
                const defaultWaveSpeed = 6.0;
                const defaultEndRadius = 25.0;
                
                // 根据 totalDuration 自动调整时间参数
                const totalDuration = this.config.totalDuration ?? 20.0;
                // 计算默认总时长：maxScatterStartTime + scatterDuration + recoverDuration
                const maxScatterStartTime = defaultEndRadius / defaultWaveSpeed;
                const defaultTotalDuration = maxScatterStartTime + defaultScatterDuration + defaultRecoverDuration;
                
                // 计算缩放比例
                const scale = totalDuration / defaultTotalDuration;
                
                // 按比例调整参数
                script.scatterDistance = 4.0;
                script.scatterDuration = defaultScatterDuration * scale;
                script.holdDuration = 0;
                script.recoverDuration = defaultRecoverDuration * scale;
                script.noiseIntensity = 0.3;
                script.scatterDirection.set(1, 1, 1);
                script.maxScatterRadius = 4.0;
                script.waveSpeed = defaultWaveSpeed * scale;
                script.endRadius = defaultEndRadius;
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Pieces-recover script created with config:', {
                    center: script.center,
                    scatterDistance: script.scatterDistance,
                    scatterDuration: script.scatterDuration,
                    recoverDuration: script.recoverDuration,
                    waveSpeed: script.waveSpeed,
                    totalDuration,
                    scale,
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
                // 配置script属性（波长 world 单位：越大波越疏；拱起用 waveAmplitude）
                script.intensity = 0.8;
                script.waveAmplitude = 0.2;
                script.wavelength = 2.5;      // 波长（世界单位），2=较疏，0 则用 waveFrequency
                script.waveSpeed = 0.5;
                script.scaleBlend = 0.75;
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Perlin-wave script created with config:', {
                    center: script.center,
                    intensity: script.intensity,
                    waveAmplitude: script.waveAmplitude,
                    wavelength: script.wavelength,
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
     * 创建 growth-wave 效果脚本
     */
    private createGrowthWaveScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create growth-wave script - entity or script component not ready');
            return null;
        }

        console.log('Creating growth-wave reveal script');

        try {
            const script = this.gsplatEntity.script.create(GsplatRevealGrowthWave) as any;
            if (script) {
                // 默认配置：Phase 1 生长固定约 7s，Phase 2 光圈复原固定 1.5s，互不干扰
                const defaultGrowthSpeed = 5.0;
                const defaultGrowthDuration = 7.0;
                const defaultRecoverDuration = 7.0;
                const defaultGrowthPhaseTime = 7.0; // Phase 1 目标时长，不随 totalDuration 拉长
                
                // 基于 Phase 1 目标时长计算 scale，避免缩短 Phase 2 时把 Phase 1 拉长
                // topParticleGrowthEnd ≈ growthDuration/growthSpeed + 1（默认 verticalSpread 下）
                const defaultTopParticleGrowthEnd = defaultGrowthDuration / defaultGrowthSpeed + 1.0;
                const scale = defaultGrowthPhaseTime / defaultTopParticleGrowthEnd;
                
                script.growthSpeed = defaultGrowthSpeed * scale;
                script.growthDuration = defaultGrowthDuration * scale;
                script.recoverDuration = defaultRecoverDuration; // 固定 1.5s，不参与 scale
                script.noiseIntensity = 2.8;
                script.scatterDistance = 4.0;
                script.minSize = 0.15;
                // Phase 2 光圈半径：优先用 config.radius；若有 bbox 则至少为 bbox 外接球半径，保证光圈覆盖全场景
                const defaultEndRadius = 50;
                let endRadius = this.config.radius ?? defaultEndRadius;
                script.endRadius = endRadius;
                
                // 设置 topY 和 bottomY（基于 bbox 或默认值）
                // 注意：growth-wave 是从 bottom 到 top 传播，shader 期望 bottomY > topY
                // 所以将 integrate 的 topY 和 bottomY 对调
                if (this.bbox) {
                    // 基于 bbox 计算：与 integrate 效果使用相同的计算方式，但赋值顺序相反
                    script.bottomY = this.bbox.center.y - this.bbox.halfExtents.y * 0.68; // 底部（更接近 center，数值更大）
                    script.topY = this.bbox.center.y - this.bbox.halfExtents.y;            // 顶部（更远离 center，数值更小）
                } else {
                    // 默认值：bottomY > topY（与 shader 期望一致）
                    script.bottomY = 10.0;
                    script.topY = -10.0;
                }
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                // Phase 2 开始时用当前帧相机 target 再更新一次 center
                script.onPhase2Start = () => this.updateScriptCenter(script);
                
                // 根据 Phase 1 目标时长计算 verticalSpread，使 topParticleGrowthEnd = defaultGrowthPhaseTime
                // verticalSpread = (defaultGrowthPhaseTime * growthSpeed - growthDuration) / maxYOffset
                const heightRange = Math.abs(script.topY - script.bottomY);
                if (heightRange > 0.001) {
                    const maxYOffset = heightRange;
                    if (script.growthSpeed > 0) {
                        script.verticalSpread = (defaultGrowthPhaseTime * script.growthSpeed - script.growthDuration) / maxYOffset;
                        script.verticalSpread = Math.max(0.01, script.verticalSpread);
                    } else {
                        script.verticalSpread = script.growthSpeed / heightRange;
                    }
                } else {
                    script.verticalSpread = script.growthSpeed / Math.max(heightRange, 0.001);
                }
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                const maxYOffset = heightRange;
                const topParticleGrowthEnd = (script.growthDuration + maxYOffset * script.verticalSpread) / script.growthSpeed;
                const actualTotalDuration = topParticleGrowthEnd + script.recoverDuration;
                
                console.log('Growth-wave script created with config:', {
                    center: script.center,
                    growthSpeed: script.growthSpeed,
                    growthDuration: script.growthDuration,
                    recoverDuration: script.recoverDuration,
                    endRadius: script.endRadius,
                    noiseIntensity: script.noiseIntensity,
                    scatterDistance: script.scatterDistance,
                    minSize: script.minSize,
                    topY: script.topY,
                    bottomY: script.bottomY,
                    heightRange,
                    verticalSpread: script.verticalSpread,
                    topParticleGrowthEnd,
                    actualTotalDuration,
                    phase1Target: defaultGrowthPhaseTime,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create growth-wave script:', error);
            return null;
        }
    }

    /**
     * 创建 sketch 效果脚本
     */
    private createSketchScript() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create sketch script - entity or script component not ready');
            return null;
        }

        console.log('Creating sketch reveal script');

        try {
            const script = this.gsplatEntity.script.create(GsplatSketch) as any;
            if (script) {
                // 默认配置
                const defaultWaveSpeed = 10.0;
                const defaultSketchDuration = 1.5;  // 素描到上色间隔，缩短以加快上色
                const defaultColorizeDuration = 5.0;
                
                // 根据 totalDuration 自动调整时间参数
                const totalDuration = this.config.totalDuration ?? 20.0;
                // 计算默认总时长：maxSketchStart + sketchDuration + colorizeDuration
                const defaultEndRadius = 200.0;
                const defaultMaxSketchStart = defaultEndRadius / defaultWaveSpeed;
                const defaultTotalDuration = defaultMaxSketchStart + defaultSketchDuration + defaultColorizeDuration;
                
                // 计算缩放比例（用于 sketchDuration 和 colorizeDuration）
                const scale = totalDuration / defaultTotalDuration;
                
                // 计算调整后的 waveSpeed，使得总时长正好是 totalDuration
                // 总时长 = endRadius / waveSpeed + sketchDuration + colorizeDuration
                // 因此：waveSpeed = endRadius / (totalDuration - sketchDuration - colorizeDuration)
                script.sketchDuration = defaultSketchDuration * scale;
                script.colorizeDuration = defaultColorizeDuration * scale;
                const remainingTime = totalDuration - script.sketchDuration - script.colorizeDuration;
                script.waveSpeed = defaultEndRadius / Math.max(remainingTime, 0.1); // 确保不为0或负数
                script.endRadius = defaultEndRadius;
                script.fadeWidthRatio = 0.18;
                script.sketchIntensity = 1.0;
                script.sketchContrast = 1.2;
                script.draftFeel = 0.65;
                script.shadeLevels = 5.0;
                script.hatchDensity = 8.0;
                script.hatchStrength = 0.65;
                script.paperTintAmount = 0.4;
                script.paperTint = [0.97, 0.95, 0.90];
                script.colorizeSpread = 0.08;
                script.colorizeDensity = 0.25;
                script.colorizeAlphaGrain = 0.5;
                script.grainFreq = 25.0;
                script.grainAmp = 0.06;
                script.colorizeSharpness = 0.3;
                
                // 启用基于相机距离的上色（从相机视角由近至远上色）
                script.useCameraDistance = true;
                
                // 设置相机实体引用（用于获取上色时的相机位置）
                script.camera = this.global.camera;
                
                // 设置 reveal center
                this.updateScriptCenter(script);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Sketch script created with config:', {
                    center: script.center,
                    waveSpeed: script.waveSpeed,
                    sketchDuration: script.sketchDuration,
                    colorizeDuration: script.colorizeDuration,
                    endRadius: script.endRadius,
                    totalDuration,
                    scale,
                    enabled: script.enabled
                });
            }
            return script;
        } catch (error) {
            console.error('Failed to create sketch script:', error);
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
                // 与 growth-wave 保持一致的约定：
                //   - bottomY 为视觉上的底部，对应更大的 Y 值
                //   - topY 为视觉上的顶部，对应更小的 Y 值
                if (this.bbox) {
                    // bbox 底部：center.y - halfExtents.y（数值更小）
                    // 为了让 bottomY 更「靠下」（数值更大），取靠近中心的一层作为 bottomY
                    script.topY = this.bbox.center.y - this.bbox.halfExtents.y;          // 顶部（更小的 Y）
                    script.bottomY = this.bbox.center.y - this.bbox.halfExtents.y * 0.68; // 底部（更大的 Y）
                } else {
                    // 默认：bottomY > topY
                    script.topY = -10.0;
                    script.bottomY = 10.0;
                }

                const heightRange = Math.abs(script.topY - script.bottomY);
                console.log('topY: ', script.topY, 'bottomY: ', script.bottomY);
                console.log('heightRange: ', heightRange);
                
                // 根据 totalDuration 计算 verticalSpread
                const totalDuration = this.config.totalDuration ?? 20.0;
                if (heightRange > 0.001 && totalDuration * script.speed > 1.0) {
                    script.verticalSpread = (totalDuration * script.speed - 1.0) / heightRange;
                    script.verticalSpread = Math.max(0.01, script.verticalSpread);
                } else {
                    script.verticalSpread = 0.5;
                    console.warn('Cannot calculate verticalSpread from totalDuration, using default:', script.verticalSpread);
                }
                
                console.log('totalDuration: ', totalDuration, 'verticalSpread: ', script.verticalSpread);
                
                // 初始状态和 effectTime
                script.enabled = this.config.autoStart;
                script.effectTime = 0;
                
                console.log('Integrate script created with config:', {
                    intensity: script.intensity,
                    speed: script.speed,
                    verticalSpread: script.verticalSpread,
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

        // Reveal 即将接管 gsplatModifyVS，通知 NightMode 退出（互斥关系）
        this.global.app.fire('nightMode:exit');

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
            case 'rain_v2':
                script = this.createRainV2Script();
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
            case 'growth-wave':
                script = this.createGrowthWaveScript();
                break;
            case 'sketch':
                script = this.createSketchScript();
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

        // 如果script创建成功，设置效果播放结束的回调（用于在 reveal 播完后再开始动画等）
        if (script) {
            (script as any).onRevealComplete = () => {
                this.global.events.fire('revealComplete');
            };
        }

        // 如果script创建成功
        if (script) {
            // 重置 effectTime
            script.effectTime = 0;
            script.isPaused = false;
            this.effectPaused = false;

            // 根据 autoStart 配置设置启用状态
            script.enabled = this.config.autoStart;
            
            // 如果是需要计时的特效，设置计时监听
            if (this.timedEffects.includes(effectName)) {
                this.setupTiming(script);
            }
            
            // 触发事件更新 UI
            this.global.events.fire('effectTime:changed', 0);
            this.global.events.fire('effectPlayPause:changed', false);
        }
        
        // 触发事件以更新 UI（统一使用 revealType:changed）
        this.global.events.fire('revealType:changed', effectName);
        this.global.state.vfxType = effectName as any;
    }

    /**
     * 设置计时功能
     */
    private setupTiming(script: any) {
        // 重置计时状态
        this.effectStartTime = null;
        this.effectEndTime = null;
        this.isTiming = false;
        
        // 监听 enable 事件，开始计时
        script.on('enable', () => {
            if (!this.isTiming) {
                this.effectStartTime = performance.now() / 1000; // 转换为秒
                this.isTiming = true;
                this.effectEndTime = null;
                console.log(`[Timing] ${this.config.type} effect started at ${this.effectStartTime.toFixed(3)}s`);
            }
        });
        
        // 监听 disable 事件，停止计时
        script.on('disable', () => {
            if (this.isTiming && this.effectStartTime !== null) {
                this.effectEndTime = performance.now() / 1000;
                const actualDuration = this.effectEndTime - this.effectStartTime;
                const expectedDuration = this.config.totalDuration ?? 20.0;
                const difference = actualDuration - expectedDuration;
                
                console.log(`[Timing] ${this.config.type} effect completed:`);
                console.log(`  - Start time: ${this.effectStartTime.toFixed(3)}s`);
                console.log(`  - End time: ${this.effectEndTime.toFixed(3)}s`);
                console.log(`  - Actual duration: ${actualDuration.toFixed(3)}s`);
                console.log(`  - Expected duration: ${expectedDuration.toFixed(3)}s`);
                console.log(`  - Difference: ${difference > 0 ? '+' : ''}${difference.toFixed(3)}s (${((difference / expectedDuration) * 100).toFixed(2)}%)`);
                
                // 触发事件，让外部可以监听
                this.global.events.fire('effectTimingComplete', {
                    type: this.config.type,
                    startTime: this.effectStartTime,
                    endTime: this.effectEndTime,
                    actualDuration,
                    expectedDuration,
                    difference
                });
                
                this.isTiming = false;
            }
        });
        
        // 如果脚本已经启用，立即开始计时
        if (script.enabled) {
            this.effectStartTime = performance.now() / 1000;
            this.isTiming = true;
            console.log(`[Timing] ${this.config.type} effect started (already enabled) at ${this.effectStartTime.toFixed(3)}s`);
        }
    }

    /**
     * 更新计时（每帧调用，检查特效是否完成）
     */
    updateTiming(dt: number) {
        // 如果是 timed effect 且脚本存在且未暂停，定期触发时间更新事件（用于 UI 更新）
        if (this.currentScript && this.timedEffects.includes(this.config.type) && !this.effectPaused) {
            const currentTime = this.currentScript.effectTime;
            this.global.events.fire('effectTime:changed', currentTime);
        }
        
        if (!this.isTiming || !this.currentScript || this.effectStartTime === null) {
            return;
        }
        
        // 检查特效是否完成
        if (this.timedEffects.includes(this.config.type) && 
            this.currentScript.isEffectComplete && 
            this.currentScript.isEffectComplete()) {
            
            // 特效完成，停止计时
            if (this.effectEndTime === null) {
                this.effectEndTime = performance.now() / 1000;
                const actualDuration = this.effectEndTime - this.effectStartTime;
                const expectedDuration = this.config.totalDuration ?? 20.0;
                const difference = actualDuration - expectedDuration;
                
                console.log(`[Timing] ${this.config.type} effect completed (detected via isEffectComplete):`);
                console.log(`  - Start time: ${this.effectStartTime.toFixed(3)}s`);
                console.log(`  - End time: ${this.effectEndTime.toFixed(3)}s`);
                console.log(`  - Actual duration: ${actualDuration.toFixed(3)}s`);
                console.log(`  - Expected duration: ${expectedDuration.toFixed(3)}s`);
                console.log(`  - Difference: ${difference > 0 ? '+' : ''}${difference.toFixed(3)}s (${((difference / expectedDuration) * 100).toFixed(2)}%)`);
                
                // 触发事件
                this.global.events.fire('effectTimingComplete', {
                    type: this.config.type,
                    startTime: this.effectStartTime,
                    endTime: this.effectEndTime,
                    actualDuration,
                    expectedDuration,
                    difference
                });
                
                this.isTiming = false;
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
            this.gsplatEntity.script.destroy('gsplatRainV2');
            this.gsplatEntity.script.destroy('gsplatRevealSmooth');
            this.gsplatEntity.script.destroy('gsplatRevealPiecesRecover');
            this.gsplatEntity.script.destroy('gsplatRevealPerlinWave');
            this.gsplatEntity.script.destroy('gsplatIntegrate');
            this.gsplatEntity.script.destroy('gsplatRevealGrowthWave');
            this.gsplatEntity.script.destroy('gsplatSketch');
            // 未来可以添加更多类型
        } catch (error) {
            console.warn('Error destroying reveal scripts:', error);
        }

        this.currentScript = null;
    }

    updateConfig(newConfig: Partial<RevealConfig>) {
        const oldType = this.config.type;
        const oldTotalDuration = this.config.totalDuration;
        
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
        // 如果 totalDuration 改变且当前特效是需要 totalDuration 的特效，重新创建效果
        else if (newConfig.totalDuration !== undefined && 
                 newConfig.totalDuration !== oldTotalDuration &&
                 ['rain_v2', 'pieces-recover', 'integrate', 'growth-wave'].includes(this.config.type)) {
            this.createEffect(this.config.type);
            console.log('Recreated effect due to totalDuration change');
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

    restart(restartAnimTrack: boolean = false) {
        if (!this.config || this.config.type === 'none') {
            console.log('No reveal effect active, cannot restart');
            return;
        }
        
        console.log('Restarting reveal effect:', this.config.type, restartAnimTrack ? '(with animTrack)' : '(without animTrack)');
        
        // 先禁用当前效果（如果存在），确保清理状态
        if (this.currentScript) {
            this.currentScript.enabled = false;
        }
        
        // 重置暂停状态
        this.effectPaused = false;

        // 重新创建效果（会自动根据 autoStart 配置启用，并重置 effectTime）
        this.createEffect(this.config.type);
        
        // 如果启用了重启 animTrack，触发重置动画事件
        if (restartAnimTrack) {
            this.global.events.fire('inputEvent', 'resetAnim');
        }
    }

    /**
     * 设置特效时间（用于时间轴拖动）
     */
    setEffectTime(time: number) {
        if (!this.currentScript || !this.timedEffects.includes(this.config.type)) {
            return;
        }
        
        const totalDuration = this.config.totalDuration ?? 20.0;
        const clampedTime = Math.max(0, Math.min(time, totalDuration));
        
        // 如果脚本被禁用了（特效完成），需要重新启用它以便回放
        if (!this.currentScript.enabled) {
            this.currentScript.enabled = true;
            // 重置计时状态，以便可以重新开始
            this.effectStartTime = null;
            this.effectEndTime = null;
            this.isTiming = false;
        }
        
        this.currentScript.setEffectTime(clampedTime);
        
        // 触发事件更新 UI（交互用）
        this.global.events.fire('effectTime:changed', clampedTime);
    }

    /**
     * 设置特效时间（用于离线导出）
     * 与 setEffectTime 的差异：
     * - 不触发 effectTime:changed，避免驱动 UI slider / 播放控制
     */
    setEffectTimeForExport(time: number) {
        if (!this.currentScript || typeof this.currentScript.setEffectTime !== 'function') {
            return;
        }
        const totalDuration = this.config.totalDuration ?? 20.0;
        const clampedTime = Math.max(0, Math.min(time, totalDuration));
        
        if (!this.currentScript.enabled) {
            this.currentScript.enabled = true;
            this.effectStartTime = null;
            this.effectEndTime = null;
            this.isTiming = false;
        }
        
        // 导出时暂停脚本，防止 update 方法中的 effectTime += dt 覆盖我们设置的值
        // 注意：setEffectTime 会立即调用 updateEffect，所以即使 paused，uniforms 也会更新
        if (!this.currentScript.isPaused) {
            this.currentScript.isPaused = true;
            this.effectPaused = true;
        }
        
        this.currentScript.setEffectTime(clampedTime);
        
        // 不再 fire effectTime:changed，保持 UI 不动
    }

    /**
     * 切换播放/暂停状态
     */
    togglePlayPause() {
        this.setPlayPause(!this.effectPaused);
    }

    /**
     * 设置播放/暂停状态（唯一来源：state.effectPaused）
     */
    setPlayPause(paused: boolean) {
        if (!this.currentScript || !this.timedEffects.includes(this.config.type)) {
            return;
        }
        this.effectPaused = paused;
        this.currentScript.isPaused = paused;

        // 触发事件更新 UI
        this.global.events.fire('effectPlayPause:changed', paused);
    }

    /**
     * 获取当前特效时间
     */
    getEffectTime(): number {
        if (!this.currentScript) {
            return 0;
        }
        return this.currentScript.effectTime;
    }

    /**
     * 获取特效总时长
     */
    getTotalDuration(): number {
        return this.config.totalDuration ?? 20.0;
    }

    /**
     * 检查当前特效是否为 timed effect
     */
    isTimedEffect(): boolean {
        return this.timedEffects.includes(this.config.type);
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

    /**
     * 设置 reveal center（输入为 world-space 坐标）。
     * 内部根据 unified 模式决定是否需要坐标转换再传给 shader。
     */
    setRevealCenter(center: number[]) {
        if (!this.config) {
            console.warn('Cannot set reveal center - no config');
            return;
        }
        
        // 保存 world-space 坐标到实例变量
        this.revealCenter = center;
        console.log('Reveal center set to (world):', center);
        
        // 更新当前 script 的中心点
        if (this.currentScript) {
            try {
                // unified: shader 在 world space → 直接使用
                // non-unified: shader 在 model space → 翻转 X/Y
                const sx = this.isUnified ? center[0] : -center[0];
                const sy = this.isUnified ? center[1] : -center[1];
                const sz = center[2];
                if (this.currentScript.setCenter) {
                    this.currentScript.setCenter(new Vec3(sx, sy, sz));
                } else if (this.currentScript.center) {
                    this.currentScript.center.set(sx, sy, sz);
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
     * 更新脚本的 center（统一处理坐标转换：world space → shader space）
     *
     * Reveal shader 中 modifySplatCenter(inout vec3 center) 接收的坐标空间取决于 unified 模式：
     *   - unified=true:  center 是 world space（engine 已在 CopyToWorkbuffer 中做了 matrix_model * modelCenter）
     *   - unified=false: center 是 model space（engine 直接传入 getCenter()）
     *
     * 相机 target / revealCenter 均为 world space。
     * gsplat Entity 有 setLocalEulerAngles(0, 0, 180) → model X = -world X, model Y = -world Y。
     * 因此：
     *   - unified=true:  直接使用 world-space 值（不转换）
     *   - unified=false: 取反 X/Y（world → model）
     */
    private updateScriptCenter(script: any) {
        if (!script || !script.center) {
            return;
        }

        if (this.cameraManager) {
            const camera = this.cameraManager.camera;
            const targetPoint = new Vec3();
            camera.calcFocusPoint(targetPoint);
            if (this.isUnified) {
                script.center.set(targetPoint.x, targetPoint.y, targetPoint.z);
            } else {
                // world → model: 翻转 X 和 Y
                script.center.set(-targetPoint.x, -targetPoint.y, targetPoint.z);
            }
        } else if (this.revealCenter) {
            if (this.isUnified) {
                script.center.set(this.revealCenter[0], this.revealCenter[1], this.revealCenter[2]);
            } else {
                script.center.set(-this.revealCenter[0], -this.revealCenter[1], this.revealCenter[2]);
            }
        }
    }

    destroy() {
        console.log('Destroying RevealController');
        this.destroyAllRevealScripts();
    }
}