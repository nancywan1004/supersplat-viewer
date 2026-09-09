import type { Entity, BoundingBox } from 'playcanvas';
import { Vec3 } from 'playcanvas';

import type { CameraManager } from '../../../camera-manager';
import { isRevealTimedVfxType, isPersistentVfx } from './reveal-policy';
import {
    getPersistentEffectPaused,
    readActivePersistentEffects,
    readRevealParams,
    hasRevealInSettings,
    hasEnabledPersistentEffects,
    patchRevealRuntimeMirror,
    patchPersistentRuntimeMirror,
    syncEffectsRuntimeStateFromSettings
} from '../../../settings-serialize/effects-sync';
import { getEffectsReadSource } from '../../../view-settings';
import { invalidateLightingVisibility } from '../../../scene-visibility/lighting-visibility-coordinator';
import { DEFAULT_VFX_TOTAL_DURATION } from '../../../schemas/v2-custom';
import { LegacyRevealEffect as RevealConfig } from '../../../settings';
import { Global, type RevealEffectType } from '../../../types';
import { PERSISTENT_EFFECT_TYPE_VALUES, persistentEffectUsesGsplatMaterialShader } from '../effect-types';
import { hasEnabledPersistentGsplatMaterialShaderEffect } from '../effects-pipeline-policy';
import type { ExperienceSettings } from '../../../schemas/v2';
import type { EffectsRuntime } from '..';
import {
    destroyAllPersistentGsplatScriptsOnEntity,
    forEachMountedPersistentGsplatScript,
    getMountedPersistentGsplatScript
} from '../gsplat-effect-script-registry';
import { destroyAllRevealGsplatScriptsOnEntity } from '../gsplat-effect-script-registry';
import {
    getPersistentGsplatEffectsRuntimeScriptType,
    rebindPersistentGsplatTimelineFromSettings
} from '../persistent/persistent-effect';
import { shouldRequestPersistentGsplatRemount } from './effects-orchestrator';
import { applyPersistentEffectParamsToScript } from '../persistent/persistent-effect-params';
import { applyRevealEffectParamsToScript } from './reveal-effect-params';
import type { RevealParticipationSyncContext } from '../gsplat-shader-effect';
import { RevealPersistentGsplatController } from '../persistent/reveal-persistent-controller';
import { GsplatRevealGrowthWave } from './gsplat-growth-wave';
import { GsplatIntegrate } from './gsplat-integrate';
import { GsplatRevealPiecesRecover } from './gsplat-pieces-recover';
import { GsplatRainV2 } from './gsplat-rain';
import { GsplatSketch } from './gsplat-sketch';
import { GsplatRevealRadial } from './gsplat-reveal-radial';
import { GsplatRevealRain } from './gsplat-reveal-rain';
import { GsplatRevealSmooth } from './gsplat-reveal-smooth';
// import { GsplatRevealRadial } from 'playcanvas/scripts/esm/gsplat/reveal-radial.mjs';
// import { GsplatRevealRain } from 'playcanvas/scripts/esm/gsplat/reveal-rain.mjs';

/**
 * 一次性 reveal 在 gsplat 实体上的脚本 teardown 策略。
 * - `replaceOneShot`：`createEffect` 前清空 RC 时间轴
 * - `stopOneShotRebindPersistentIfConfigured`：`vfxExit` 等，拆一次性后按 settings 重绑已挂载 persistent
 * - `stopOneShotKeepPersistent`：会话显隐关开场——只拆一次性，不碰 persistent 挂载/时间轴
 */
type OneShotRevealGsplatTeardown =
    | 'replaceOneShot'
    | 'stopOneShotRebindPersistentIfConfigured'
    | 'stopOneShotKeepPersistent';

/**
 * 场景 GSplat **一次性开场** reveal 主路径（Timed、Reveal 等会阻塞到 `revealComplete`）。
 *
 * **职责**：开场脚本时序与挂载、与 NightMode 首帧互斥、导出门控；基于 `reveal.example.mjs`。
 * **可持续型**（如 `perlin-wave`）：实体挂载由 **`persistent-gsplat-lifecycle.ts`** 经 **`runPersistentGsplatEntityLifecycle`** 驱动；与一次性轨的 Night/时间轴衔接由 **`RevealPersistentGsplatController`**（本类组合）承担。
 */

/** clipPadding: 建议扩展 far；nearMax: 建议 near 的上限。均为可选提示，不是强制值。 */
export type RevealCameraClipHint = { clipPadding?: number; nearMax?: number };

/** 与 viewer 中 NightMode 首帧 / afterReveal 解析一致；用于 VFX 进入时快照，避免早于 firstFrame 的 currentNightFade 仍为 0 */
function getNightFadeFromSettings(settings: { nightMode?: { enabled?: boolean; fade?: number } }): number {
    const nightCfg = settings.nightMode;
    if (typeof nightCfg?.fade === 'number' && Number.isFinite(nightCfg.fade)) {
        return Math.max(-1, Math.min(1, nightCfg.fade));
    }
    return nightCfg?.enabled ? -0.95 : 0;
}

function debugExportNight(...args: unknown[]) {
    let enabled = (globalThis as any).__DEBUG_EXPORT_NIGHT_MODE__ === true;
    if (!enabled && typeof window !== 'undefined') {
        try {
            enabled = new URLSearchParams(window.location.search).get('debugExportNight') === '1' ||
                window.localStorage.getItem('__DEBUG_EXPORT_NIGHT_MODE__') === '1';
        } catch {
            // ignore
        }
    }
    if (enabled) {
        console.log('[ExportNightDebug][Reveal]', ...args);
    }
}

export class RevealController {
    private gsplatEntity: Entity | null = null;
    private config: RevealConfig;
    private currentScript: any = null;
    /** 可持续 GSplat 与 RC 的衔接（Night / 时间轴 / inVfx）；实体 remount 由 viewer → {@link runPersistentGsplatEntityLifecycle}。 */
    private readonly _persistentGsplat!: RevealPersistentGsplatController;
    private revealCenter: number[] = [0, 0, 0];
    private bbox: BoundingBox | null = null;
    private cameraManager: CameraManager | null = null;
    /** unified 渲染模式标记（shader 接收 world-space 坐标） */
    private isUnified: boolean = false;
    
    // 计时相关
    private effectStartTime: number | null = null;
    private effectEndTime: number | null = null;
    private isTiming: boolean = false;
    private readonly endRadiusBboxPaddingScale = 0.65;
    /** 半径放大后对传播速度的补偿系数（0~1，越大越接近“完全按半径等比提速”） */
    private readonly radiusSpeedCompensation = 0.7;
    
    global: Global;
    /** 进入 VFX 前的 nightFade 快照；仅在从非 none 切入特效时记录，用于结束/切回 none 时恢复全局亮度。
     *  若用户在 VFX 播放中手动调了 nightFade，此值会同步更新为最新值，保证 VFX 结束时恢复到用户期望的亮度。 */
    private originalNightFade: number | null = null;
    /** 当前运行时的 nightFade（由 NightMode 通过 nightFade:changedDetailed 事件持续更新），用于拍快照 */
    private currentNightFade: number = 0;
    /** VFX 正在播放中 */
    private inVfx: boolean = false;
    /** 导出时间轴内，该轮 reveal 是否已完成（用于阻止后续帧误重启脚本） */
    private exportRevealCompleted: boolean = false;
    /** 等待 reveal disable 收尾后再恢复 NightMode（避免同帧 shader chunk 互删） */
    private pendingDeferredNightRestore = false;

    /** 与 `EffectsRuntime` 同步当前已挂载 reveal 脚本类型（M4：双轨 provider 快照；不改变 revealComplete 语义） */
    private syncEffectsRuntimeRevealScriptType(effectType: string): void {
        const rt = (this.global.app as any).effectsRuntime as EffectsRuntime | undefined;
        rt?.notifyRevealScriptApplied(effectType);
    }

    constructor(global: Global, bbox: BoundingBox, gsplatEntity: Entity, cameraManager?: CameraManager | null) {
        this.global = global;
        const { settings, events, state, app } = global;
        this.gsplatEntity = gsplatEntity;
        this.bbox = bbox;
        this.cameraManager = cameraManager || null;
        this.isUnified = gsplatEntity.gsplat?.unified ?? false;
        
        // 确定性区分来源：优先监听带 source 的详细事件；避免用“0 值猜测/冷却期”等不确定方案
        app.on('nightFade:changedDetailed', (payload: { value: number; source: string }) => {
            const value = payload?.value;
            const source = payload?.source;
            if (typeof value === 'number' && isFinite(value)) {
                this.currentNightFade = Math.max(-1, Math.min(1, value));
                // VFX 播放中：只有显式 nightFade:set（UI / 外部指令）才更新恢复目标；exit/request/forceReapply 等都不算用户调节
                if (this.inVfx && this.originalNightFade !== null && source === 'set') {
                    this.originalNightFade = this.currentNightFade;
                }
            }
        });

        // 不再监听旧的 nightFade:changed(number)，只接受带 source 的 detailed 事件，避免 0 值误判
        
        const hasReveal = hasRevealInSettings(settings as ExperienceSettings);

        // Always initialize (VFX effects don't require legacy revealEffect in settings)
        const revealParams = readRevealParams(settings as ExperienceSettings);
        this.config = {
            type: (revealParams?.type as RevealConfig['type']) ?? 'none',
            enabled: revealParams?.enabled !== false,
            autoStart: revealParams?.autoStart ?? true,
            totalDuration: revealParams?.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION,
            effectParams:
                revealParams?.effectParams &&
                typeof revealParams.effectParams === 'object' &&
                !Array.isArray(revealParams.effectParams)
                    ? { ...(revealParams.effectParams as Record<string, unknown>) }
                    : undefined
        };

        console.log('RevealController initialized with config:', this.config);

        // 与 settings 对齐的 reveal 开关（hasReveal）与当前 reveal 类型（effectsRuntimeState.reveal.activeType）。
        // - `index.ts` 在 import 后通常会已按 `hasRevealInSettings` 写过 `state.hasRevealEffect`；
        //   此处再写一次，保证「仅加载场景、未走 main」或后续重构时仍以 settings 为真源。
        // - `observe` 在赋**相同**布尔值时不会触发 `hasRevealEffect:changed`，因此下面用手动 `events.fire`
        //   通知只订阅了 `events`、不读 state 的模块（如 Bloom 构造前已注册的路径）。
        // - 仅在布尔值**发生变化**时 fire：避免与 index 首轮 `false→true` 已派发的事件重复，减少无意义回调。
        const prevHasReveal = state.hasRevealEffect;
        state.hasRevealEffect = hasReveal;
        patchRevealRuntimeMirror(state, {
            activeType: this.config.type as RevealEffectType,
            status: 'inactive'
        });
        if (state.hasRevealEffect !== prevHasReveal) {
            events.fire('hasRevealEffect:changed', state.hasRevealEffect);
        }

        // 参数 / enabled；类型切换由 revealSceneEffect:add|delete 驱动
        events.on('revealConfigChanged', (newConfig: Partial<RevealConfig>) => {
            this.updateConfig(newConfig);
        });

        events.on('revealSceneEffect:delete', () => {
            this.teardownRevealSceneEffectForSwitch();
        });

        events.on('revealSceneEffect:terminalCleanup', () => {
            this.finalizeRevealSceneEffectDelete();
        });

        events.on('revealSceneEffect:add', () => {
            this.mountRevealSceneEffect();
        });

        events.on('persistentRevealConfigChanged', (pack: { type?: string; effectParams?: Record<string, unknown> }) => {
            const t = pack?.type;
            if (!t || !isPersistentVfx(t as any)) {
                return;
            }
            const script = getMountedPersistentGsplatScript(this.gsplatEntity, t) as any;
            if (script) {
                const keys = pack.effectParams ? Object.keys(pack.effectParams) : [];
                applyPersistentEffectParamsToScript(script, t, pack.effectParams ?? undefined);
                if (
                    (t === 'yiyun-dianran' || t === 'pointillism-stipple') &&
                    keys.length === 1 &&
                    keys[0] === 'postEffectEnabled'
                ) {
                    script.applyPostEffectConfig?.();
                } else {
                    script.applyConfig?.();
                }
            }
        });

        // 协议 / UI：强制结束「一次性 reveal」播放；persistent **实体脚本**不由此处创建/销毁，仅可能重绑指针（见 `teardownOneShotRevealGsplatScripts`）。
        events.on('vfxExit', () => {
            this.forceStopVfx('EFFECT_DISABLE');
        });

        /** 场景内容容器：关开场会话显隐——拆一次性、不 remount persistent、仍解锁 deferred/bloom */
        events.on('revealSessionHide', () => {
            this.suppressOneShotForSessionHide();
        });

        // settings 已按快照恢复为真源：丢弃 View/VFX 期 nightFade 快照，避免事后写回造成假脏
        events.on('settingsSnapshotApplied', () => {
            this.originalNightFade = null;
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

        // 导出结束后恢复：仅 Timed 恢复特效时间；非 Timed 不碰特效时间（保持导出最后一帧状态，避免设回 t=0 导致黑屏）
        events.on('effectTimeline:restoreAfterExport', (time: number) => {
            if (isRevealTimedVfxType(this.config.type)) {
                this.setEffectTime(time);
            }
        });

        // 监听导出专用时间轴事件（离线导出用：不会驱动 UI slider）
        events.on('effectTimeline:setForExport', (time: number) => {
            this.setEffectTimeForExport(time);
        });

        events.on('effectPlayPause:toggle', () => {
            this.togglePersistentPlayPause();
        });

        events.on('effectPlayPause:set', (paused: boolean) => {
            this.setPersistentPlayPause(paused);
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
        
        // 创建初始效果（如果类型不是 none）：
        // 主路径：Viewer 在 `readyToRender=true` 之前调用 {@link ensureInitialEffectCreatedBeforeFirstDisplay}，
        // 避免首帧已上屏却无 VFX 的一帧偏色/蓝光闪。此处仍注册 firstFrame 作为材质晚就绪时的兜底。
        if (
            this.config.type !== 'none' &&
            this.config.enabled !== false &&
            !isPersistentVfx(this.config.type as any)
        ) {
            const createInitial = () => {
                if (this.currentScript) return;
                this.mountRevealSceneEffect();
            };
            if (state.loaded) {
                createInitial();
            } else {
                events.once('firstFrame', createInitial);
            }
        }

        this._persistentGsplat = new RevealPersistentGsplatController({
            global: this.global,
            beforePersistentScriptMount: () => {
                this.inVfx = true;
                if (this.originalNightFade === null) {
                    this.originalNightFade = getNightFadeFromSettings(this.global.settings);
                }
                if (hasEnabledPersistentGsplatMaterialShaderEffect(this.global.settings as ExperienceSettings)) {
                    this.global.app.fire('nightMode:exit');
                }
            },
            afterPersistentScriptUnmount: () => {
                this.restoreNightModeIfNeeded('persistentGsplatUnmount');
                this.inVfx = false;
            },
            applyShaderScriptCenter: (script: any) => {
                this.updateScriptCenter(script);
            },
            setCurrentScript: (script: any | null) => {
                this.currentScript = script;
            },
            notifyRevealScriptType: (effectType: string) => {
                this.syncEffectsRuntimeRevealScriptType(effectType);
            }
        });
    }

    getGsplatEntity(): Entity | null {
        return this.gsplatEntity;
    }

    /**
     * 在首次允许画布绘制（`state.readyToRender=true`）之前创建开场 VFX，避免出现无 shader 的一帧。
     * 若脚本已存在则 no-op；`firstFrame` 上的兜底仍会尝试创建。
     */
    ensureInitialEffectCreatedBeforeFirstDisplay(): void {
        if (
            this.config.type === 'none' ||
            this.config.enabled === false ||
            this.currentScript ||
            isPersistentVfx(this.config.type as any)
        ) {
            return;
        }
        this.mountRevealSceneEffect();
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
                this.applyAdaptiveEndRadius(script, 0);
                
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
                this.applyAdaptiveEndRadius(script, 0);
                
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
     * 创建 rain-v2 reveal script - 简化版本的 rain 效果
     */
    private createRainV2Script() {
        if (!this.gsplatEntity || !this.gsplatEntity.script) {
            console.warn('Cannot create rain-v2 script - entity or script component not ready');
            return null;
        }

        console.log('Creating rain-v2 reveal script');
        
        try {
            const script = this.gsplatEntity.script.create(GsplatRainV2) as any;
            if (script) {
                // 配置script属性
                script.intensity = 1.0;
                script.rainSize = 0.05;
                script.riseTint.set(0, 1, 1);
                script.riseTintIntensity = 0.2;

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
                const totalDuration = this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
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
            console.error('Failed to create rain-v2 script:', error);
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
                const totalDuration = this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
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
                this.applyAdaptiveEndRadius(
                    script,
                    defaultEndRadius
                );
                
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
                // 默认配置：Phase 1 目标约 7s（由 scale + verticalSpread 保证）；Phase 2 时长由 totalDuration 扣减 Phase1，避免整体超出公共 totalDuration
                const defaultGrowthSpeed = 5.0;
                const defaultGrowthDuration = 7.0;
                const defaultGrowthPhaseTime = 7.0; // Phase 1 目标时长，不随 totalDuration 拉长
                const minRecoverDuration = 0.5; // 与 `GsplatRevealGrowthWave.recoverDuration` @range 下限一致

                // 基于 Phase 1 目标时长计算 scale，避免缩短 Phase 2 时把 Phase 1 拉长
                // topParticleGrowthEnd ≈ growthDuration/growthSpeed + 1（默认 verticalSpread 下）
                const defaultTopParticleGrowthEnd = defaultGrowthDuration / defaultGrowthSpeed + 1.0;
                const scale = defaultGrowthPhaseTime / defaultTopParticleGrowthEnd;

                script.growthSpeed = defaultGrowthSpeed * scale;
                script.growthDuration = defaultGrowthDuration * scale;
                script.noiseIntensity = 2.8;
                script.scatterDistance = 4.0;
                script.minSize = 0.15;
                const defaultEndRadius = 50;
                this.applyAdaptiveEndRadius(
                    script,
                    defaultEndRadius
                );
                
                // 设置 topY 和 bottomY（基于 bbox 或默认值）
                // 注意：growth-wave 是从 bottom 到 top 传播，shader 期望 bottomY > topY
                // 所以将 integrate 的 topY 和 bottomY 对调
                if (this.bbox) {
                    // 基于 bbox 计算：与 integrate 效果使用相同的计算方式，但赋值顺序相反
                    script.bottomY = this.bbox.center.y - this.bbox.halfExtents.y;
                    script.topY = this.bbox.center.y + this.bbox.halfExtents.y;
                } else {
                    script.bottomY = -10.0;
                    script.topY = 10.0;
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

                const totalDuration = this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
                const phase1End =
                    script.growthSpeed > 1e-6
                        ? (script.growthDuration + heightRange * script.verticalSpread) / script.growthSpeed
                        : defaultGrowthPhaseTime;
                const actualTotalDuration = phase1End + (script.recoverDuration ?? minRecoverDuration);
                
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
                    phase1End,
                    actualTotalDuration,
                    phase1Target: defaultGrowthPhaseTime,
                    totalDuration,
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
                const totalDuration = this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
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
                // 请求半径用 0：有效外沿 = max(bbox 自适应, maxEndRadius 上界)，不再硬编码 200 抬高下限
                this.applyAdaptiveEndRadius(script, 0);
                script.fadeWidthRatio = 0.55;
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
                script.colorizeSharpness = 0.35;                
                
                // 与 rain-v2 一致：素描+上色按 xz 到相机焦点（updateScriptCenter）由内向外，不用相机 eye 球面距
                script.useCameraDistance = true;
                
                // 材质/统一管线目标相机（非上色距离；上色距离已随 uCenter 与 xz 度量对齐 rain-v2）
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
                script.waveAmplitude = 0.5;
                
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
                    script.topY = this.bbox.center.y + this.bbox.halfExtents.y;
                    script.bottomY = this.bbox.center.y - this.bbox.halfExtents.y;
                } else {
                    script.topY = 10.0;
                    script.bottomY = -10.0;
                }

                const heightRange = Math.abs(script.topY - script.bottomY);
                console.log('topY: ', script.topY, 'bottomY: ', script.bottomY);
                console.log('heightRange: ', heightRange);
                
                // 根据 totalDuration 计算 verticalSpread
                const totalDuration = this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
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

    private mountRevealSceneEffect() {
        const effectName = this.config.type as string;
        if (!effectName || effectName === 'none' || this.config.enabled === false) {
            return;
        }
        if (isPersistentVfx(effectName as any)) {
            return;
        }

        this.suspendPersistentSceneForOneShotReveal();

        patchRevealRuntimeMirror(this.global.state, {
            activeType: effectName as RevealEffectType,
            status: 'playing'
        });

        this.exportRevealCompleted = false;
        this.mountRevealSceneEffectByName(effectName);
        this.schedulePersistentGsplatRemountAfterRevealCompleteIfWanted();
    }

    private teardownRevealSceneEffectForSwitch() {
        if (!this.gsplatEntity) {
            return;
        }
        this.teardownOneShotRevealGsplatScripts('replaceOneShot');
        this.suspendPersistentSceneForOneShotReveal();
        this.currentScript = null;
        this.isTiming = false;
        this.effectStartTime = null;
        this.effectEndTime = null;
        this.inVfx = false;
        patchRevealRuntimeMirror(this.global.state, { status: 'inactive' });
        this.syncEffectsRuntimeRevealScriptType(
            getPersistentGsplatEffectsRuntimeScriptType(this.gsplatEntity, this.global.settings as ExperienceSettings)
        );
    }

    private finalizeRevealSceneEffectDelete() {
        if (!this.gsplatEntity) {
            return;
        }
        this.restoreNightModeIfNeeded('revealSceneEffectDelete');
        this.global.events.fire('revealComplete');
    }

    private createEffect(effectName: string) {
        if (!this.gsplatEntity || !this.config) {
            return;
        }

        if (isPersistentVfx(effectName as any)) {
            return;
        }

        if (effectName === 'none') {
            this.teardownRevealSceneEffectForSwitch();
            this.finalizeRevealSceneEffectDelete();
            return;
        }

        this.teardownOneShotRevealGsplatScripts('replaceOneShot');
        this.mountRevealSceneEffectByName(effectName);
    }

    private mountRevealSceneEffectByName(effectName: string) {
        if (!this.gsplatEntity || !this.config) {
            return;
        }

        if (!this.gsplatEntity.script) {
            this.gsplatEntity.addComponent('script');
        }

        this.inVfx = true;
        if (this.originalNightFade === null) {
            this.originalNightFade = getNightFadeFromSettings(this.global.settings);
        }
        this.global.app.fire('nightMode:exit');

        let script = null;
        switch (effectName) {
            case 'radial':
                script = this.createRadialScript();
                break;
            case 'rain':
                script = this.createRainScript();
                break;
            case 'rain-v2':
                script = this.createRainV2Script();
                break;
            case 'smooth':
                script = this.createSmoothScript();
                break;
            case 'pieces-recover':
                script = this.createPiecesRecoverScript();
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

        if (script) {
            applyRevealEffectParamsToScript(script, effectName, this.config.effectParams);
            this.syncRevealParticipation(script);
        }

        this.currentScript = script;
        this._persistentGsplat.resetPersistentTimelineBound();
        this.config.type = effectName as RevealConfig['type'];
        this.exportRevealCompleted = false;
        (this as any).__exportCompletionLogged = false;

        // 如果script创建成功，设置效果播放结束的回调（用于在 reveal 播完后再开始动画等）
        if (script) {
            (script as any).onRevealComplete = () => {
                this.exportRevealCompleted = true;
                debugExportNight('onRevealComplete fired', {
                    type: this.config.type,
                    effectTime: Number((this.currentScript as any)?.effectTime ?? -1).toFixed?.(3) ?? -1,
                    isExporting: !!(this.global.state as any).isExportingVfxVideo,
                    inVfx: this.inVfx,
                    originalNightFade: this.originalNightFade
                });
                // revealComplete 当帧里，reveal 脚本仍可能继续执行 enabled=false -> removeShaders。
                // 若立即 forceReapply，可能被同帧 removeShaders 覆盖，出现一帧黑闪（compute 路径更明显）。
                // 统一延后一帧到 frameend 再恢复 NightMode，保证 removeShaders 先结束。
                if (
                    !this.pendingDeferredNightRestore
                    && this.inVfx
                    && this.originalNightFade !== null
                    && !hasEnabledPersistentGsplatMaterialShaderEffect(this.global.settings as ExperienceSettings)
                ) {
                    this.pendingDeferredNightRestore = true;
                    this.global.app.once('frameend', () => {
                        this.pendingDeferredNightRestore = false;
                        this.restoreNightModeIfNeeded('revealScriptComplete:deferred');
                    });
                }
                // 须在 revealComplete 之前写入 completed：否则 UI 等监听器仍读到 playing，且 frameend 后无二次刷新会卡住（如 persistent toggle 禁用不解除）。
                patchRevealRuntimeMirror(this.global.state, {
                    status: this.config.type === 'none' ? 'inactive' : 'completed'
                });
                syncEffectsRuntimeStateFromSettings(this.global.state, this.global.settings as ExperienceSettings);
                this.global.events.fire('revealComplete');
            };
        }

        // 如果script创建成功
        if (script) {
            // 重置 effectTime
            script.effectTime = 0;
            script.isPaused = false;

            // 根据 autoStart 配置设置启用状态
            script.enabled = this.config.autoStart;
            
            // 如果是需要计时的特效，设置计时监听
            if (isRevealTimedVfxType(effectName)) {
                this.setupTiming(script);
            }
            
            // 触发事件更新 UI
            this.global.events.fire('effectTime:changed', 0);
        }
        else {
            // type='none' 或创建失败：视为当前无特效在运行
            this.inVfx = false;
        }

        patchRevealRuntimeMirror(this.global.state, {
            activeType: effectName as RevealEffectType,
            status: (!!script && effectName !== 'none') ? 'playing' : (effectName === 'none' ? 'inactive' : 'completed')
        });
        
        // 触发事件以更新 UI（统一使用 revealType:changed）
        this.global.events.fire('revealType:changed', effectName);

        this.syncEffectsRuntimeRevealScriptType(effectName);
    }

    /**
     * 在特效结束或类型切回 none 时恢复进入特效前记录的 nightFade。
     * 仅当快照 fade 与 settings 真源不一致时才写回 settings，避免 edit-enter remount/vfxExit
     * 凭空 materialize `nightMode` 造成 EXIT_NEEDS_SAVE 假脏；运行时始终 forceReapply。
     */
    private restoreNightModeIfNeeded(reason: string) {
        const settings = this.global.settings as ExperienceSettings;
        if (hasEnabledPersistentGsplatMaterialShaderEffect(settings)) {
            debugExportNight('restoreNightModeIfNeeded skipped (gsplat material shader persistent active)', {
                reason,
                type: this.config.type,
                inVfx: this.inVfx
            });
            this.global.app.fire('nightMode:exit');
            this.requestPersistentGsplatMaterialShaderReapply(settings);
            return;
        }
        // 点彩等 mount 可能未走 prepareExternalPersistentScriptMount；无快照时回退 settings.nightMode.fade
        let fade = this.originalNightFade ?? getNightFadeFromSettings(settings);
        this.originalNightFade = null;
        this.inVfx = false;
        patchRevealRuntimeMirror(this.global.state, { status: this.config.type === 'none' ? 'inactive' : 'completed' });

        const currentFade = getNightFadeFromSettings(settings);
        if (Math.abs(fade - currentFade) > 1e-6) {
            const settingsAny = this.global.settings as any;
            if (!settingsAny.nightMode || typeof settingsAny.nightMode !== 'object') {
                settingsAny.nightMode = {};
            }
            settingsAny.nightMode.fade = fade;
        }

        // 观看态亮度 overlay 由 Reconciler 在 prerender invalidate 时套用（含 forceReapply）。
        console.log('[RevealController] Restoring nightFade to', fade, 'due to', reason);
        debugExportNight('restoreNightModeIfNeeded invalidate lighting visibility', {
            reason,
            fade,
            type: this.config.type,
            isExporting: !!(this.global.state as any).isExportingVfxVideo
        });
        invalidateLightingVisibility(this.global, `revealRestore:${reason}`);
    }

    /**
     * persistent remount / 单类型 enable-disable 后：占用 gsplat 材质 shader 的特效仍 enabled 则挂起 night；
     * 否则按 mount 前快照恢复 night-mode。
     */
    syncNightModeAfterPersistentGsplatChange(): void {
        const settings = this.global.settings as ExperienceSettings;
        if (hasEnabledPersistentGsplatMaterialShaderEffect(settings)) {
            if (this.originalNightFade === null) {
                this.originalNightFade = getNightFadeFromSettings(settings);
            }
            // `prepareExternalPersistentScriptMount` 已 fire `nightMode:exit`；此处再 exit 会在点彩挂载后
            // 触发 composer applyComposedToMaterials，覆盖直连 gsplatModifyVS → 大黑片。
            this.requestPersistentGsplatMaterialShaderReapply(settings);
            return;
        }
        this.restoreNightModeIfNeeded('persistentGsplatSync');
    }

    /** composer 误写材质后，让已挂载的点彩/忆韵等 re-apply 直连 chunk。 */
    private requestPersistentGsplatMaterialShaderReapply(settings: ExperienceSettings): void {
        if (!this.gsplatEntity) {
            return;
        }
        for (const entry of readActivePersistentEffects(settings)) {
            if (!entry.enabled || !persistentEffectUsesGsplatMaterialShader(entry.type)) {
                continue;
            }
            const script = getMountedPersistentGsplatScript(this.gsplatEntity, entry.type) as {
                applyConfig?: () => void;
                applyShaders?: () => void;
            } | null;
            script?.applyConfig?.() ?? script?.applyShaders?.();
        }
    }

    /** 强制停止「一次性 reveal」播放，但不改 this.config.type。persistent 实体由 viewer remount；此处仅 teardown 一次性脚本并按 settings 重绑 persistent 指针（若有）。 */
    private forceStopVfx(reason: string) {
        this.teardownOneShotRevealGsplatScripts('stopOneShotRebindPersistentIfConfigured');
        this.isTiming = false;
        this.effectStartTime = null;
        this.effectEndTime = null;

        // 若之前进入过 VFX，则恢复进入前的 nightFade（或 VFX 中用户 set 的值）
        this.restoreNightModeIfNeeded(reason);

        // 标记：当前不在播放中
        this.inVfx = false;
        patchRevealRuntimeMirror(this.global.state, { status: this.config.type === 'none' ? 'inactive' : 'completed' });
        // 强制停播视作「当前 reveal 生命周期已完成」：
        // 统一解锁 deferred editing layers / bloom stack，避免 persistent 或中途停播后资产、标注继续隐藏。
        this.global.events.fire('revealComplete');
        // 注意：不改 config.type / settings.effects.reveal / effectsRuntimeState.reveal.activeType
        this.syncEffectsRuntimeRevealScriptType(
            getPersistentGsplatEffectsRuntimeScriptType(this.gsplatEntity, this.global.settings as ExperienceSettings)
        );
    }

    /**
     * 场景内容会话显隐：关闭开场。
     * - 只拆一次性脚本，保留已挂载 persistent（不 remount）
     * - `revealComplete` 带 `skipPersistentRemount`，避免误把可持续特效拉回
     * - 仍解锁 deferred layers / bloom
     */
    private suppressOneShotForSessionHide(): void {
        this.teardownOneShotRevealGsplatScripts('stopOneShotKeepPersistent');
        this.isTiming = false;
        this.effectStartTime = null;
        this.effectEndTime = null;
        this.restoreNightModeIfNeeded('SESSION_HIDE');
        this.inVfx = false;
        patchRevealRuntimeMirror(this.global.state, {
            status: this.config.type === 'none' ? 'inactive' : 'completed'
        });
        this.global.events.fire('revealComplete', { skipPersistentRemount: true });
        this.syncEffectsRuntimeRevealScriptType(
            getPersistentGsplatEffectsRuntimeScriptType(
                this.gsplatEntity,
                getEffectsReadSource(this.global) as ExperienceSettings
            )
        );
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
                const expectedDuration = this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
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
     * 仅针对「一次性 reveal」脚本自然 disable：恢复 Night。不得用于 persistent 时间轴脚本。
     */
    private tryRestoreNightAfterOneShotScriptNaturalDisable(): void {
        if (
            this.currentScript &&
            !this.currentScript.enabled &&
            !this._persistentGsplat.isPersistentTimelineBound() &&
            this.inVfx &&
            this.originalNightFade !== null &&
            !this.pendingDeferredNightRestore
        ) {
            this.restoreNightModeIfNeeded('effectScriptDisabled');
        }
    }

    /**
     * 更新计时（每帧调用，检查特效是否完成）
     */
    updateTiming(dt: number) {
        this.tryRestoreNightAfterOneShotScriptNaturalDisable();

        // 一次性 reveal Timed：脚本存在且未暂停时定期触发时间更新（驱动 UI 滑条）
        if (this.currentScript && !this._persistentGsplat.isPersistentTimelineBound() && isRevealTimedVfxType(this.config.type)) {
            const currentTime = this.currentScript.effectTime;
            this.global.events.fire('effectTime:changed', currentTime);
        }
        
        if (!this.isTiming || !this.currentScript || this.effectStartTime === null) {
            return;
        }
        
        // 检查特效是否完成
        if (isRevealTimedVfxType(this.config.type) &&
            this.currentScript.isEffectComplete &&
            this.currentScript.isEffectComplete()) {
            
            // 特效完成，停止计时
            if (this.effectEndTime === null) {
                this.effectEndTime = performance.now() / 1000;
                const actualDuration = this.effectEndTime - this.effectStartTime;
                const expectedDuration = this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
                const difference = actualDuration - expectedDuration;
                
                // console.log(`[Timing] ${this.config.type} effect completed (detected via isEffectComplete):`);
                // console.log(`  - Start time: ${this.effectStartTime.toFixed(3)}s`);
                // console.log(`  - End time: ${this.effectEndTime.toFixed(3)}s`);
                // console.log(`  - Actual duration: ${actualDuration.toFixed(3)}s`);
                // console.log(`  - Expected duration: ${expectedDuration.toFixed(3)}s`);
                // console.log(`  - Difference: ${difference > 0 ? '+' : ''}${difference.toFixed(3)}s (${((difference / expectedDuration) * 100).toFixed(2)}%)`);
                
                // 触发事件
                this.global.events.fire('effectTimingComplete', {
                    type: this.config.type,
                    startTime: this.effectStartTime,
                    endTime: this.effectEndTime,
                    actualDuration,
                    expectedDuration,
                    difference
                });

                // Timed VFX 播放完成后，将全局亮度恢复到进入特效前的 nightFade，避免长留在「特效接管后的亮度」状态
                this.restoreNightModeIfNeeded('timedEffectComplete');

                this.isTiming = false;
            }
        }
    }

    /**
     * 仅销毁 gsplat 上的一次性 reveal 脚本；persistent 实体脚本由 `viewer` / `persistent-effect` 管理。
     *
     * @param mode `replaceOneShot`：`createEffect` 前清空 RC 时间轴；`stopOneShotRebindPersistentIfConfigured`：`vfxExit` 等，拆一次性后仅重绑已存在的 persistent；`stopOneShotKeepPersistent`：会话关开场，不碰 persistent。
     */
    private teardownOneShotRevealGsplatScripts(mode: OneShotRevealGsplatTeardown) {
        if (!this.gsplatEntity?.script) {
            return;
        }

        if (mode === 'stopOneShotKeepPersistent') {
            console.log('Teardown one-shot reveal scripts (keep persistent mounts)');
            destroyAllRevealGsplatScriptsOnEntity(this.gsplatEntity);
            // 时间轴若仍指向已毁的一次性脚本，按当前 read source 重绑到已挂载 persistent（不 remount）
            rebindPersistentGsplatTimelineFromSettings(
                this.gsplatEntity,
                getEffectsReadSource(this.global) as ExperienceSettings,
                (s) => this.bindPersistentTimelineScript(s)
            );
            return;
        }

        const rebindPersistent = mode === 'stopOneShotRebindPersistentIfConfigured';
        console.log(
            rebindPersistent
                ? 'Teardown one-shot reveal scripts (rebind persistent timeline if configured on entity)'
                : 'Teardown one-shot reveal scripts (clear timeline; persistent remount is viewer-owned)'
        );

        destroyAllRevealGsplatScriptsOnEntity(this.gsplatEntity);

        if (rebindPersistent) {
            rebindPersistentGsplatTimelineFromSettings(
                this.gsplatEntity,
                this.global.settings as ExperienceSettings,
                (s) => this.bindPersistentTimelineScript(s)
            );
        } else {
            this.bindPersistentTimelineScript(null);
        }
    }

    updateConfig(newConfig: Partial<RevealConfig>) {
        const effectsSettings = getEffectsReadSource(this.global);
        const rp = readRevealParams(effectsSettings);
        if (rp) {
            this.config.type = (rp.type as RevealConfig['type']) ?? 'none';
            this.config.enabled = rp.enabled !== false;
            this.config.autoStart = rp.autoStart ?? true;
            this.config.totalDuration = rp.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
            this.config.effectParams =
                rp.effectParams && typeof rp.effectParams === 'object' && !Array.isArray(rp.effectParams)
                    ? { ...(rp.effectParams as Record<string, unknown>) }
                    : undefined;
        }
        syncEffectsRuntimeStateFromSettings(this.global.state, effectsSettings);

        const hasReveal = hasRevealInSettings(effectsSettings);
        if (this.global.state.hasRevealEffect !== hasReveal) {
            this.global.state.hasRevealEffect = hasReveal;
            this.global.events.fire('hasRevealEffect:changed', hasReveal);
        }

        if (this.currentScript && this.config.enabled !== false && this.config.type !== 'none') {
            this.updateCurrentScriptConfig(newConfig as Partial<RevealConfig>);
        }
    }

    /**
     * 更新当前script的配置
     */
    private updateCurrentScriptConfig(newConfig: Partial<RevealConfig>) {
        if (!this.currentScript) return;
        if (this._persistentGsplat.isPersistentTimelineBound()) return;

        console.log('Updating current script config');

        try {
            applyRevealEffectParamsToScript(this.currentScript, this.config.type as string, this.config.effectParams);
            this.syncRevealParticipation(this.currentScript);
        } catch (error) {
            console.warn('Error updating script config:', error);
        }
    }

    private buildRevealParticipationContext(requestedRadius?: number): RevealParticipationSyncContext {
        return {
            requestedRadius,
            sceneBboxRadius: this.getSceneBboxRadius(),
            bboxPaddingScale: this.endRadiusBboxPaddingScale,
            totalDuration: this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION,
            effectParams: this.config.effectParams,
            radiusSpeedCompensation: this.radiusSpeedCompensation
        };
    }

    /** 将场景 bbox / config 交给脚本，由脚本自行同步参与半径与速度。 */
    private syncRevealParticipation(script: any, requestedRadius?: number): void {
        if (typeof script?.syncRevealParticipation !== 'function') {
            return;
        }
        script.syncRevealParticipation(this.buildRevealParticipationContext(requestedRadius));
    }

    private getSceneBboxRadius(): number {
        if (!this.bbox) return 0;
        const radius = this.bbox.halfExtents.length();
        return Number.isFinite(radius) && radius > 1e-6 ? radius : 0;
    }

    private applyAdaptiveEndRadius(script: any, requestedRadius: number) {
        this.syncRevealParticipation(script, requestedRadius);
    }

    /** 一次性开场重播前卸 persistent（composer + 实体脚本）；播完由 {@link schedulePersistentGsplatRemountAfterRevealCompleteIfWanted} 挂回。 */
    private suspendPersistentSceneForOneShotReveal(): void {
        const settings = this.global.settings as ExperienceSettings;
        if (!hasEnabledPersistentEffects(settings) || !this.gsplatEntity) {
            return;
        }
        destroyAllPersistentGsplatScriptsOnEntity(this.gsplatEntity);
        this._persistentGsplat.finishPersistentGsplatExternalUnmount();
        this.bindPersistentTimelineScript(null);
        // 批量销毁不走 lifecycle.destroyPersistentSceneEffectByType，需显式刷新相机清屏/后处理。
        this.global.events?.fire('postEffect:changed');

        const rt = (this.global.app as any).effectsRuntime as EffectsRuntime | undefined;
        if (rt?.composer) {
            for (const id of PERSISTENT_EFFECT_TYPE_VALUES) {
                rt.composer.removeContribution(id);
            }
            rt.composer.compose();
        }
    }

    private schedulePersistentGsplatRemountAfterRevealCompleteIfWanted(): void {
        const rt = this.config.type as string;
        if (
            !shouldRequestPersistentGsplatRemount(
                'afterOneShotRevealCompletes',
                rt,
                this.global.settings as ExperienceSettings
            )
        ) {
            return;
        }
        this.global.events.once('revealComplete', (payload?: { skipPersistentRemount?: boolean }) => {
            if (payload?.skipPersistentRemount) return;
            this.global.events.fire('persistentGsplatEffectRemountRequested', false);
        });
    }

    restart(restartAnimTrack: boolean = false) {
        if (!this.config || this.config.type === 'none' || this.config.enabled === false) {
            console.log('No reveal effect active, cannot restart');
            return;
        }

        if (isPersistentVfx(this.config.type as any)) {
            console.log('Restarting persistent effect (viewer remount):', this.config.type);
            if (this.currentScript) {
                this.currentScript.enabled = false;
            }
            destroyAllPersistentGsplatScriptsOnEntity(this.gsplatEntity);
            destroyAllRevealGsplatScriptsOnEntity(this.gsplatEntity);
            this.currentScript = null;
            this._persistentGsplat.resetPersistentTimelineBound();
            patchPersistentRuntimeMirror(this.global.state, { status: 'playing' });
            this.exportRevealCompleted = false;
            this.global.events.fire('persistentGsplatEffectRemountRequested', restartAnimTrack);
            return;
        }

        console.log('Restarting reveal effect:', this.config.type, restartAnimTrack ? '(with animTrack)' : '(without animTrack)');

        this.suspendPersistentSceneForOneShotReveal();

        patchRevealRuntimeMirror(this.global.state, {
            activeType: this.config.type as RevealEffectType,
            status: 'playing'
        });

        // 先禁用当前效果（如果存在），确保清理状态
        if (this.currentScript) {
            this.currentScript.enabled = false;
        }

        this.exportRevealCompleted = false;

        // 重新创建效果（会自动根据 autoStart 配置启用，并重置 effectTime）
        this.createEffect(this.config.type as string);

        this.schedulePersistentGsplatRemountAfterRevealCompleteIfWanted();

        // 如果启用了重启 animTrack，触发重置动画事件
        if (restartAnimTrack) {
            this.global.events.fire('inputEvent', 'resetAnim');
        }
    }

    /**
     * 设置特效时间（用于时间轴拖动；一次性 reveal 均为 Timed，persistent 无 scrub）
     */
    setEffectTime(time: number) {
        if (!this.currentScript || this._persistentGsplat.isPersistentTimelineBound() || !isRevealTimedVfxType(this.config.type)) {
            return;
        }
        const totalDuration = this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
        const clampedTime = Math.max(0, Math.min(time, totalDuration));

        if (!this.currentScript.enabled) {
            this.currentScript.enabled = true;
            this.effectStartTime = null;
            this.effectEndTime = null;
            this.isTiming = false;
        }

        this.currentScript.setEffectTime(clampedTime);
        this.global.events.fire('effectTime:changed', clampedTime);
    }

    /**
     * 设置特效时间（用于离线导出）
     * 与 setEffectTime 的差异：
     * - 不触发 effectTime:changed，避免驱动 UI slider / 播放控制
     */
    setEffectTimeForExport(time: number) {
        const settings = this.global.settings as ExperienceSettings;
        const enabledPersistent = readActivePersistentEffects(settings);
        const persistentExportUnbounded =
            isPersistentVfx(this.config.type as any) || enabledPersistent.length > 0;

        const baseDuration = this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
        const completionT = Number(this.getPostRevealContentThresholdSec());
        const completionCeiling =
            isRevealTimedVfxType(this.config.type) && Number.isFinite(completionT) && completionT >= 0
                ? completionT
                : baseDuration;
        const exportCeiling = Math.max(baseDuration, completionCeiling);
        const exportTime = persistentExportUnbounded
            ? Math.max(0, time)
            : Math.max(0, Math.min(time, exportCeiling));

        // 导出 scrub：所有已挂载 persistent 脚本都需同步 effectTime（如 perlin-wave 的 uTime），
        // 不能仅更新 bindPersistentTimelineScript 绑定的 primary。
        if (this.gsplatEntity && enabledPersistent.length > 0) {
            for (const entry of enabledPersistent) {
                const script = getMountedPersistentGsplatScript(this.gsplatEntity, entry.type) as {
                    enabled?: boolean;
                    isPaused?: boolean;
                    setEffectTime?: (t: number) => void;
                } | null;
                if (!script?.setEffectTime) {
                    continue;
                }
                if (!script.enabled) {
                    script.enabled = true;
                }
                if (!script.isPaused) {
                    script.isPaused = true;
                }
                script.setEffectTime(exportTime);
            }
        }

        if (!this.currentScript || typeof this.currentScript.setEffectTime !== 'function') {
            return;
        }
        if (this._persistentGsplat.isPersistentTimelineBound()) {
            return;
        }

        const completionReached = Number.isFinite(completionT) && completionT >= 0 && exportTime + 1e-4 >= completionT;
        if (!(this as any).__exportCompletionLogged && completionReached) {
            (this as any).__exportCompletionLogged = true;
            debugExportNight('export completion threshold reached', {
                type: this.config.type,
                exportTime: Number(exportTime.toFixed(3)),
                completionT: Number(completionT.toFixed(3)),
                scriptEnabled: !!this.currentScript.enabled,
                isEffectComplete: !!this.currentScript?.isEffectComplete?.(),
                inVfx: this.inVfx,
                originalNightFade: this.originalNightFade
            });
        }
        
        if (!this.currentScript.enabled && this.exportRevealCompleted) {
            debugExportNight('skip re-enable after reveal completed in export', {
                type: this.config.type,
                exportTime: Number(exportTime.toFixed(3)),
                inVfx: this.inVfx,
                originalNightFade: this.originalNightFade
            });
            return;
        }

        if (!this.currentScript.enabled) {
            debugExportNight('re-enabling script in export tick', {
                type: this.config.type,
                exportTime: Number(exportTime.toFixed(3)),
                completionT: Number.isFinite(completionT) ? Number(completionT.toFixed(3)) : null,
                completionReached,
                inVfx: this.inVfx,
                originalNightFade: this.originalNightFade
            });
            this.currentScript.enabled = true;
            this.effectStartTime = null;
            this.effectEndTime = null;
            this.isTiming = false;
        }
        
        // 导出时暂停脚本，防止 update 方法中的 effectTime += dt 覆盖我们设置的值
        // 注意：setEffectTime 会立即调用 updateEffect，所以即使 paused，uniforms 也会更新
        if (!this.currentScript.isPaused) {
            this.currentScript.isPaused = true;
        }
        
        this.currentScript.setEffectTime(exportTime);
        
        // 不再 fire effectTime:changed，保持 UI 不动
    }

    /**
     * 仅 **persistent** 可持续特效：切换脚本 `isPaused` 与 `persistent.status`（`playing` ↔ `paused`）。
     */
    togglePersistentPlayPause() {
        if (readActivePersistentEffects(this.global.settings as ExperienceSettings).length === 0) {
            return;
        }
        this.setPersistentPlayPause(!getPersistentEffectPaused(this.global.state));
    }

    /**
     * 仅 **persistent**：`persistent.status` 与全部已挂载脚本 `isPaused` 对齐，并 `effectPlayPause:changed`（供 persistent UI）。
     */
    setPersistentPlayPause(paused: boolean) {
        const enabled = readActivePersistentEffects(this.global.settings as ExperienceSettings);
        if (enabled.length === 0) {
            return;
        }
        forEachMountedPersistentGsplatScript(this.gsplatEntity, enabled.map(e => e.type), (_t, script) => {
            (script as { isPaused?: boolean }).isPaused = paused;
        });
        if (this.currentScript && this._persistentGsplat.isPersistentTimelineBound()) {
            (this.currentScript as { isPaused?: boolean }).isPaused = paused;
        }
        patchPersistentRuntimeMirror(this.global.state, { status: paused ? 'paused' : 'playing' });
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
        return this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
    }

    /**
     * 是否为「一次性 reveal」Timed VFX（与 {@link isRevealTimedVfxType} 一致；persistent 为 false）。
     */
    isTimedEffect(): boolean {
        return isRevealTimedVfxType(this.config.type);
    }

    /**
     * 导出时间轴上与「首访 revealComplete」对齐的时刻（秒）：此前应隐藏编辑添加的资产/标注/附加光源；
     * 局部亮灯（Bloom 体积）由 revealRestart 锁定 _bloomStackUnlocked，在越过该时刻后通过 synthetic revealComplete 解锁。
     * 与 viewer.ts 中 hasRevealEffect 时 defer initAnnotations/initSceneAssets 至 revealComplete 的语义一致。
     *
     * 优先级：
     * 1. `currentScript.getCompletionTime()`（若存在且为有效非负数）——integrate / growth-wave / rain-v2 / sketch 等与 `isEffectComplete` 一致；
     * 2. 一次性 reveal（`isRevealTimedVfxType`）与 persistent：回退 `config.totalDuration`。
     */
    getPostRevealContentThresholdSec(): number {
        const { state } = this.global;
        if (!state.hasRevealEffect || this.config.type === 'none') {
            return 0;
        }
        const script = this.currentScript;
        if (script && typeof script.getCompletionTime === 'function') {
            const t = Number(script.getCompletionTime());
            if (Number.isFinite(t) && t >= 0) {
                return t;
            }
        }
        return this.config.totalDuration ?? DEFAULT_VFX_TOTAL_DURATION;
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
     * 统一查询当前特效对相机裁剪面的提示（可选能力）。
     * Viewer 不关心具体特效类型，只消费这一层抽象。
     * 这样新增/调整特效时只改脚本侧，避免在 viewer 中不断堆 if-else 补丁。
     */
    getCameraClipHint(): RevealCameraClipHint | null {
        const script = this.currentScript as {
            enabled?: boolean;
            getCameraClipHint?: () => unknown;
        } | null | undefined;
        if (!script?.enabled || typeof script.getCameraClipHint !== 'function') return null;
        const raw = script.getCameraClipHint();
        if (!raw || typeof raw !== 'object') return null;
        const hint = raw as Record<string, unknown>;
        const out: RevealCameraClipHint = {};
        if (typeof hint.clipPadding === 'number' && Number.isFinite(hint.clipPadding)) {
            out.clipPadding = Math.max(0, hint.clipPadding);
        }
        if (typeof hint.nearMax === 'number' && Number.isFinite(hint.nearMax)) {
            out.nearMax = Math.max(0.001, hint.nearMax);
        }
        if (out.clipPadding === undefined && out.nearMax === undefined) return null;
        return out;
    }

    /**
     * Viewer 在挂载 persistent GSplat 脚本前调用：标记 inVfx、快照 nightFade；若即将挂载占用 gsplat 材质 shader 的 persistent 则 `nightMode:exit`。
     * scene 轨 perlin/overall-wave 与 night composer 合成不变；纯后处理 stylization 不触发 exit。
     * 不得写 `effectsRuntimeState.reveal.status = 'playing'`：一次性 reveal 已结束时该位应保持 `completed`，
     * 否则 `syncEffectsRuntimeStateFromSettings` 会粘住 `playing`，导致关闭 persistent 时误判「reveal 仍在播」而跳过 `vfxExit`。
     */
    prepareExternalPersistentScriptMount(): void {
        this._persistentGsplat.prepareExternalPersistentScriptMount();
    }

    /**
     * 配置关闭 persistent 且实体上脚本已销毁后由 Viewer 调用：解除时间轴绑定、退出 inVfx、按快照恢复 NightMode。
     */
    finishPersistentGsplatExternalUnmount(): void {
        this._persistentGsplat.finishPersistentGsplatExternalUnmount();
    }

    /** 供 `viewer` 挂载 persistent 脚本时对齐中心（与 reveal 脚本 world/model 规则一致） */
    applyGsplatShaderScriptCenter(script: any): void {
        this._persistentGsplat.applyGsplatShaderScriptCenter(script);
    }

    /** 将 `currentScript` 与 viewer 挂载的 persistent 脚本对齐，供导出时间轴与 `getEffectTime` 使用 */
    bindPersistentTimelineScript(script: any | null): void {
        this._persistentGsplat.bindPersistentTimelineScript(script);
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
        destroyAllRevealGsplatScriptsOnEntity(this.gsplatEntity);
        destroyAllPersistentGsplatScriptsOnEntity(this.gsplatEntity);
        this.currentScript = null;
        this._persistentGsplat.resetPersistentTimelineBound();
        this.syncEffectsRuntimeRevealScriptType('none');
    }
}
