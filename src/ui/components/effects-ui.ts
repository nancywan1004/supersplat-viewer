import type { Global, PersistentEffectType, RevealEffectType } from '../../types';
import { PERSISTENT_EFFECT_TYPE_VALUES, REVEAL_EFFECT_TYPE_VALUES } from '../../types';
import { pushEditHistory } from '../../edit-history';
import { DEFAULT_VFX_TOTAL_DURATION } from '../../schemas/v2-custom';
import { SCENE_GSPLAT_PERSISTENT_EFFECT_ID, SCENE_GSPLAT_REVEAL_EFFECT_ID } from '../../vfx/effects-runtime/effects-runtime';
import {
    getRevealTotalDuration,
    readRevealParams,
    getRevealStatus,
    getRevealActiveType
} from '../../settings-serialize/effects-sync';
import { isPersistentVfx } from '../../vfx/effects-runtime/reveal/reveal-policy';
import { dispatchEffectsModuleCommand } from '../../editor-modules/effects-facade';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';

const REVEAL_EFFECTS = REVEAL_EFFECT_TYPE_VALUES;
const PERSISTENT_EFFECTS = PERSISTENT_EFFECT_TYPE_VALUES;

const isRevealType = (type: string): boolean => (REVEAL_EFFECTS as readonly string[]).includes(type);
const isPersistentType = (type: string): boolean => (PERSISTENT_EFFECTS as readonly string[]).includes(type);

export type RevealType = RevealEffectType | PersistentEffectType;

/** 当前 reveal 类型（仅 reveal 轨；不受 persistent 轨影响） */
export const getCurrentVfxType = (global: Global): string => {
    const stateType = getRevealActiveType(global.state);
    const settingsType = readRevealParams(global.settings)?.type;
    return (stateType || settingsType || 'none') as string;
};

/** Reveal 面板的 HTML 模板（挂载到 #revealPanelContainer，内含 #vfxVideoExportContainer 供 video-export-ui 挂载） */
const REVEAL_PANEL_HTML = (() => {
    const defaultDuration = DEFAULT_VFX_TOTAL_DURATION;
    return `
<div id="revealPanel" class="hidden">
  <fieldset class="effectsTrackFieldset" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;margin-bottom:10px">
    <legend style="padding:0 6px;font-size:13px;font-weight:600">Scene（GSplat）— Reveal</legend>
    <p class="effectsTrackHint" style="font-size:11px;opacity:0.8;margin:0 0 8px;line-height:1.35">一次性开场特效；与 <code>settings.effects.reveal</code> 对应。reveal 默认按统一时长/时间轴处理。</p>
  <div class="settingsRow">
    <label for="revealType">Reveal:</label>
    <select id="revealType" class="settingsSelect">
      <option value="none">None</option>
      <option value="radial">Radial</option>
      <option value="rain">Rain</option>
      <option value="rain-v2">Rain v2</option>
      <option value="smooth">Smooth</option>
      <option value="pieces-recover">Pieces Recover</option>
      <option value="integrate">Integrate</option>
      <option value="growth-wave">Growth Wave</option>
      <option value="sketch">Sketch</option>
    </select>
  </div>
  <div id="totalDurationRow" class="settingsRow hidden">
    <label for="totalDuration">Reveal 时长 (s):</label>
    <input type="number" id="totalDuration" class="settingsInput" min="1" max="60" step="0.5" value="${defaultDuration}" title="仅控制 Timed VFX 效果的快慢/时长，与导出视频长度无关">
  </div>
  <div id="effectTimelineRow" class="settingsRow hidden">
    <div class="effectTimelineInner">
      <input type="range" id="effectTimeline" min="0" max="200" step="1" value="0" class="effectTimelineRange" title="reveal 仅 scrub，不支持暂停">
      <span id="effectTimeDisplay" class="effectTimeDisplay">0.0s</span>
    </div>
  </div>
  </fieldset>
  <fieldset class="effectsTrackFieldset" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;margin-bottom:10px">
    <legend style="padding:0 6px;font-size:13px;font-weight:600">Scene（GSplat）— Persistent</legend>
    <p class="effectsTrackHint" style="font-size:11px;opacity:0.8;margin:0 0 8px;line-height:1.35">可持续特效配置；与 <code>settings.effects.persistent</code> 对应。</p>
    <div class="settingsRow">
      <label for="persistentEnabled">Persistent Enabled:</label>
      <input type="checkbox" id="persistentEnabled" class="settingsCheckbox" checked>
    </div>
    <div class="settingsRow">
      <label for="persistentType">Persistent:</label>
      <select id="persistentType" class="settingsSelect">
        <option value="none">None</option>
        <option value="perlin-wave">Perlin Wave</option>
        <option value="falling-petals">Falling Petals</option>
        <option value="falling-rain">Falling Rain</option>
        <option value="falling-snow">Falling Snow</option>
      </select>
    </div>
    <div id="persistentPetalsControls" class="hidden" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
      <div class="settingsRow">
        <label for="petalsTextureUrl">Petal Texture:</label>
        <input type="text" id="petalsTextureUrl" class="settingsInput" value="/textures/petal.png">
      </div>
      <div class="settingsRow">
        <label for="petalsCount">Petal Count:</label>
        <input type="number" id="petalsCount" class="settingsInput" min="100" max="12000" step="100" value="3600">
      </div>
      <div class="settingsRow">
        <label for="petalsOpacity">Petal Opacity:</label>
        <input type="number" id="petalsOpacity" class="settingsInput" min="0" max="1" step="0.05" value="0.95">
      </div>
      <div class="settingsRow">
        <label>Petal Box XYZ:</label>
        <input type="number" id="petalsExtentX" class="settingsInput" min="1" max="120" step="1" value="36" style="width:64px">
        <input type="number" id="petalsExtentY" class="settingsInput" min="1" max="120" step="1" value="42" style="width:64px">
        <input type="number" id="petalsExtentZ" class="settingsInput" min="1" max="120" step="1" value="32" style="width:64px">
      </div>
    </div>
    <div id="persistentWeatherControls" class="hidden" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
      <div class="settingsRow">
        <label for="weatherDensity">Density:</label>
        <input type="number" id="weatherDensity" class="settingsInput" min="0.1" max="8" step="0.1" value="1.5">
      </div>
      <div class="settingsRow">
        <label for="weatherSpeed">Speed:</label>
        <input type="number" id="weatherSpeed" class="settingsInput" min="0" max="30" step="0.1" value="2">
      </div>
      <div class="settingsRow">
        <label for="weatherOpacity">Opacity:</label>
        <input type="number" id="weatherOpacity" class="settingsInput" min="0" max="1" step="0.05" value="0.85">
      </div>
      <div class="settingsRow">
        <label for="weatherDrift">Drift:</label>
        <input type="number" id="weatherDrift" class="settingsInput" min="0" max="4" step="0.01" value="0.4">
      </div>
      <div class="settingsRow">
        <label>Weather Box XYZ:</label>
        <input type="number" id="weatherExtentX" class="settingsInput" min="1" max="80" step="1" value="12" style="width:64px">
        <input type="number" id="weatherExtentY" class="settingsInput" min="1" max="80" step="1" value="12" style="width:64px">
        <input type="number" id="weatherExtentZ" class="settingsInput" min="1" max="80" step="1" value="12" style="width:64px">
      </div>
      <div class="settingsRow">
        <label>Size Min/Max:</label>
        <input type="number" id="weatherMinSize" class="settingsInput" min="0.001" max="0.1" step="0.001" value="0.006" style="width:72px">
        <input type="number" id="weatherMaxSize" class="settingsInput" min="0.001" max="0.1" step="0.001" value="0.012" style="width:72px">
      </div>
      <div class="settingsRow">
        <label for="weatherElongate">Elongate:</label>
        <input type="number" id="weatherElongate" class="settingsInput" min="0.1" max="40" step="0.1" value="1">
      </div>
      <div class="settingsRow">
        <label for="weatherUseFog">Use Fog:</label>
        <input type="checkbox" id="weatherUseFog" class="settingsCheckbox" checked>
      </div>
    </div>
  </fieldset>
  <fieldset class="effectsTrackFieldset effectsTrackAsset" style="border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 12px;margin-bottom:10px;opacity:0.85">
    <legend style="padding:0 6px;font-size:13px;font-weight:600">Asset 特效</legend>
    <p class="effectsTrackHint" style="font-size:11px;opacity:0.75;margin:0;line-height:1.35">占位：<code>settings.effects.asset</code> 与资产轨协议尚未接 UI。</p>
  </fieldset>
  <div class="settingsRow">
    <button id="revealRestart" class="settingsButton" type="button">Restart Effect</button>
  </div>
  <div class="settingsRow">
    <div id="restartAnimTrackCheck" class="checkMark">✓</div>
    <div id="restartAnimTrackOption">Restart AnimTrack</div>
  </div>
</div>
`.trim();
})();

/**
 * 初始化 Reveal / VFX 与效果时间轴相关 UI。
 * 组件自行创建 DOM 并挂载到 #revealPanelContainer；若无容器则跳过。
 * @returns 清理函数，调用后解除事件并移除创建的 DOM。
 */
export function initRevealUI(global: Global): () => void {
    const { events } = global;

    const container = document.getElementById('revealPanelContainer');
    if (!container) return () => {};

    container.innerHTML = REVEAL_PANEL_HTML;
    const revealPanel = container.querySelector('#revealPanel') as HTMLElement;
    let effectsDebugTimer: ReturnType<typeof setInterval> | undefined;
    let effectsDebugEl: HTMLPreElement | null = null;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('effectsDebug') === '1') {
        effectsDebugEl = document.createElement('pre');
        effectsDebugEl.id = 'effectsDebugStrip';
        effectsDebugEl.style.cssText =
            'font-size:10px;opacity:0.88;max-height:140px;overflow:auto;margin:8px 0 0;padding:8px;' +
            'background:rgba(0,0,0,0.35);border-radius:6px;white-space:pre-wrap;word-break:break-all';
        effectsDebugEl.title = '?effectsDebug=1 — state.effectsRuntimeState + settings.effects';
        revealPanel.appendChild(effectsDebugEl);
        const tick = () => {
            const snap = {
                effectsRuntimeState: (global.state as { effectsRuntimeState?: unknown }).effectsRuntimeState,
                effects: global.settings?.effects
            };
            effectsDebugEl!.textContent = JSON.stringify(snap);
        };
        tick();
        effectsDebugTimer = setInterval(tick, 800);
    }
    const revealType = container.querySelector('#revealType') as HTMLSelectElement | null;
    const persistentType = container.querySelector('#persistentType') as HTMLSelectElement | null;
    const persistentEnabled = container.querySelector('#persistentEnabled') as HTMLInputElement | null;
    const persistentPetalsControls = container.querySelector('#persistentPetalsControls') as HTMLElement | null;
    const persistentWeatherControls = container.querySelector('#persistentWeatherControls') as HTMLElement | null;
    const petalsTextureUrl = container.querySelector('#petalsTextureUrl') as HTMLInputElement | null;
    const petalsCount = container.querySelector('#petalsCount') as HTMLInputElement | null;
    const petalsOpacity = container.querySelector('#petalsOpacity') as HTMLInputElement | null;
    const petalsExtentX = container.querySelector('#petalsExtentX') as HTMLInputElement | null;
    const petalsExtentY = container.querySelector('#petalsExtentY') as HTMLInputElement | null;
    const petalsExtentZ = container.querySelector('#petalsExtentZ') as HTMLInputElement | null;
    const weatherDensity = container.querySelector('#weatherDensity') as HTMLInputElement | null;
    const weatherSpeed = container.querySelector('#weatherSpeed') as HTMLInputElement | null;
    const weatherOpacity = container.querySelector('#weatherOpacity') as HTMLInputElement | null;
    const weatherDrift = container.querySelector('#weatherDrift') as HTMLInputElement | null;
    const weatherExtentX = container.querySelector('#weatherExtentX') as HTMLInputElement | null;
    const weatherExtentY = container.querySelector('#weatherExtentY') as HTMLInputElement | null;
    const weatherExtentZ = container.querySelector('#weatherExtentZ') as HTMLInputElement | null;
    const weatherMinSize = container.querySelector('#weatherMinSize') as HTMLInputElement | null;
    const weatherMaxSize = container.querySelector('#weatherMaxSize') as HTMLInputElement | null;
    const weatherElongate = container.querySelector('#weatherElongate') as HTMLInputElement | null;
    const weatherUseFog = container.querySelector('#weatherUseFog') as HTMLInputElement | null;
    const revealRestart = container.querySelector('#revealRestart');
    const totalDurationRow = container.querySelector('#totalDurationRow') as HTMLElement | null;
    const totalDuration = container.querySelector('#totalDuration') as HTMLInputElement | null;
    const effectTimelineRow = container.querySelector('#effectTimelineRow') as HTMLElement | null;
    const effectTimeline = container.querySelector('#effectTimeline') as HTMLInputElement | null;
    const effectTimeDisplay = container.querySelector('#effectTimeDisplay');
    const restartAnimTrackCheck = container.querySelector('#restartAnimTrackCheck');
    const restartAnimTrackOption = container.querySelector('#restartAnimTrackOption');

    // 默认开启：导出时通常需要重启相机 animTrack（与 message-bridge 的默认 syncAnimTrack=true 对齐）
    let restartAnimTrackEnabled = true;

    const toggleRestartAnimTrack = () => {
        restartAnimTrackEnabled = !restartAnimTrackEnabled;
        restartAnimTrackCheck?.classList[restartAnimTrackEnabled ? 'add' : 'remove']('active');
        // 不写入 state：state 可能是 Proxy，不允许随意 set 新属性；导出时以 DOM (#restartAnimTrackCheck.active) 为准
    };

    // 初始化时同步到 UI（确保“默认开启”）
    restartAnimTrackCheck?.classList.add('active');

    const pushEditHistorySafe = () => {
        if ((global.state as any).editMode) {
            pushEditHistory(global, 'reveal');
        }
    };

    /** M18：internal 与 message-bridge 共用 `EffectsFacade.handleCommand`（bridge 仅多一层 postMessage）。 */
    const routeEffectsCommand = (
        type: 'EFFECT_PARAMS_PATCH' | 'EFFECT_TOGGLE' | 'EFFECT_REPLAY',
        envelope: Record<string, unknown>
    ) => {
        if (getEditUiTransport(global) === 'message-bridge') {
            sendEditProtocolMessage({ type, ...envelope });
        } else if (
            !dispatchEffectsModuleCommand(global, { type, payload: envelope, source: 'host' })
        ) {
            console.warn('[effects-ui] effects command dispatch failed', type);
        }
    };

    const readPersistentPack = (): Record<string, unknown> | undefined => {
        const effects = global.settings.effects;
        const paramsById = effects?.persistent?.paramsById;
        if (!paramsById || typeof paramsById !== 'object') return undefined;
        const byFixedId = paramsById[SCENE_GSPLAT_PERSISTENT_EFFECT_ID] as Record<string, unknown> | undefined;
        if (byFixedId && typeof byFixedId.type === 'string' && isPersistentType(byFixedId.type)) {
            return byFixedId;
        }
        // 兼容旧数据：若 key 非固定 id，也尝试从首个合法 persistent pack 推断默认值。
        for (const value of Object.values(paramsById)) {
            const pack = value as Record<string, unknown> | undefined;
            if (pack && typeof pack.type === 'string' && isPersistentType(pack.type)) {
                return pack;
            }
        }
        return undefined;
    };

    const getPersistentSelection = (): string => {
        const pack = readPersistentPack();
        return pack && typeof pack.type === 'string' ? pack.type : 'none';
    };

    const getPersistentEnabled = (): boolean => {
        const pType = getPersistentSelection();
        if (pType === 'none') {
            return false;
        }
        // settings.effects.persistent.enabled 未写入时默认 true
        return global.settings.effects?.persistent?.enabled ?? true;
    };

    let updateRevealControls = () => {};

    const getDefaultPersistentEffectParams = (type: string): Record<string, unknown> => {
        if (type === 'falling-petals') {
            return {
                petalTextureUrl: '/textures/petal.png',
                petalParticleCount: 3600,
                opacity: 0.95,
                extents: [36, 42, 32]
            };
        }
        if (type === 'falling-rain') {
            return {
                density: 1.5,
                speed: 10,
                opacity: 0.65,
                drift: 0.02,
                extents: [12, 12, 12],
                particleMinSize: 0.003,
                particleMaxSize: 0.003,
                elongate: 20,
                useFog: true
            };
        }
        if (type === 'falling-snow') {
            return {
                density: 1.5,
                speed: 2,
                opacity: 0.85,
                drift: 0.4,
                extents: [12, 12, 12],
                particleMinSize: 0.006,
                particleMaxSize: 0.012,
                elongate: 1,
                useFog: true
            };
        }
        return {};
    };

    const getPersistentEffectParams = (): Record<string, unknown> => {
        const pack = readPersistentPack();
        const effectParams = pack?.effectParams;
        return effectParams && typeof effectParams === 'object' ? effectParams as Record<string, unknown> : {};
    };

    const patchPersistentEffectParams = (effectParams: Record<string, unknown>) => {
        routeEffectsCommand('EFFECT_PARAMS_PATCH', {
            effectId: SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
            params: { effectParams }
        });
        pushEditHistorySafe();
    };

    const readNumberInput = (input: HTMLInputElement | null, fallback: number): number => {
        if (!input) return fallback;
        const value = Number.parseFloat(input.value);
        return Number.isFinite(value) ? value : fallback;
    };

    const writeNumberInput = (input: HTMLInputElement | null, value: unknown, fallback: number) => {
        if (!input) return;
        input.value = (typeof value === 'number' && Number.isFinite(value) ? value : fallback).toString();
    };

    const writeTextInput = (input: HTMLInputElement | null, value: unknown, fallback: string) => {
        if (!input) return;
        input.value = typeof value === 'string' ? value : fallback;
    };

    const readTriple = (
        x: HTMLInputElement | null,
        y: HTMLInputElement | null,
        z: HTMLInputElement | null,
        fallback: [number, number, number]
    ): [number, number, number] => [
        readNumberInput(x, fallback[0]),
        readNumberInput(y, fallback[1]),
        readNumberInput(z, fallback[2])
    ];

    const writeTriple = (
        inputs: [HTMLInputElement | null, HTMLInputElement | null, HTMLInputElement | null],
        value: unknown,
        fallback: [number, number, number]
    ) => {
        const triple = Array.isArray(value) && value.length >= 3 ? value : fallback;
        writeNumberInput(inputs[0], triple[0], fallback[0]);
        writeNumberInput(inputs[1], triple[1], fallback[1]);
        writeNumberInput(inputs[2], triple[2], fallback[2]);
    };

    const updatePersistentParamControls = () => {
        const pType = getPersistentSelection();
        const params = getPersistentEffectParams();
        persistentPetalsControls?.classList[pType === 'falling-petals' ? 'remove' : 'add']('hidden');
        const showWeatherControls = pType === 'falling-rain' || pType === 'falling-snow';
        persistentWeatherControls?.classList[showWeatherControls ? 'remove' : 'add']('hidden');

        writeTextInput(petalsTextureUrl, params.petalTextureUrl, '/textures/petal.png');
        writeNumberInput(petalsCount, params.petalParticleCount, 3600);
        writeNumberInput(petalsOpacity, params.opacity, 0.95);
        writeTriple([petalsExtentX, petalsExtentY, petalsExtentZ], params.extents, [36, 42, 32]);

        const isRain = pType === 'falling-rain';
        writeNumberInput(weatherDensity, params.density, 1.5);
        writeNumberInput(weatherSpeed, params.speed, isRain ? 10 : 2);
        writeNumberInput(weatherOpacity, params.opacity, isRain ? 0.65 : 0.85);
        writeNumberInput(weatherDrift, params.drift, isRain ? 0.02 : 0.4);
        writeTriple([weatherExtentX, weatherExtentY, weatherExtentZ], params.extents, [12, 12, 12]);
        writeNumberInput(weatherMinSize, params.particleMinSize, isRain ? 0.003 : 0.006);
        writeNumberInput(weatherMaxSize, params.particleMaxSize, isRain ? 0.003 : 0.012);
        writeNumberInput(weatherElongate, params.elongate, isRain ? 20 : 1);
        if (weatherUseFog) {
            weatherUseFog.checked = typeof params.useFog === 'boolean' ? params.useFog : true;
        }
    };

    const onPetalsParamsChange = () => {
        patchPersistentEffectParams({
            petalTextureUrl: petalsTextureUrl?.value || '/textures/petal.png',
            petalParticleCount: readNumberInput(petalsCount, 3600),
            opacity: readNumberInput(petalsOpacity, 0.95),
            extents: readTriple(petalsExtentX, petalsExtentY, petalsExtentZ, [36, 42, 32])
        });
    };

    const onWeatherParamsChange = () => {
        const isRain = getPersistentSelection() === 'falling-rain';
        patchPersistentEffectParams({
            density: readNumberInput(weatherDensity, 1.5),
            speed: readNumberInput(weatherSpeed, isRain ? 10 : 2),
            opacity: readNumberInput(weatherOpacity, isRain ? 0.65 : 0.85),
            drift: readNumberInput(weatherDrift, isRain ? 0.02 : 0.4),
            extents: readTriple(weatherExtentX, weatherExtentY, weatherExtentZ, [12, 12, 12]),
            particleMinSize: readNumberInput(weatherMinSize, isRain ? 0.003 : 0.006),
            particleMaxSize: readNumberInput(weatherMaxSize, isRain ? 0.003 : 0.012),
            elongate: readNumberInput(weatherElongate, isRain ? 20 : 1),
            useFog: weatherUseFog?.checked ?? true
        });
    };

    const onRevealTypeChange = (event: Event) => {
        const target = (event.target as HTMLSelectElement);
        const type = target.value as RevealType;
        routeEffectsCommand('EFFECT_PARAMS_PATCH', {
            effectId: SCENE_GSPLAT_REVEAL_EFFECT_ID,
            params: { type }
        });
        pushEditHistorySafe();
    };

    const onPersistentTypeChange = (event: Event) => {
        const target = (event.target as HTMLSelectElement);
        const type = target.value;
        routeEffectsCommand('EFFECT_PARAMS_PATCH', {
            effectId: SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
            params: {
                type: type === 'none' ? 'none' : type,
                enabled: type !== 'none',
                effectParams: getDefaultPersistentEffectParams(type)
            }
        });
        pushEditHistorySafe();
        updateRevealControls();
    };

    const onPersistentEnabledChange = (event: Event) => {
        const enabled = (event.target as HTMLInputElement).checked;
        routeEffectsCommand('EFFECT_TOGGLE', {
            effectId: SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
            value: enabled
        });
        pushEditHistorySafe();
        updateRevealControls();
    };

    const onTotalDurationChange = (event: Event) => {
        const target = event.target as HTMLInputElement;
        const totalDurationVal = parseFloat(target.value);
        if (!isNaN(totalDurationVal) && totalDurationVal > 0) {
            routeEffectsCommand('EFFECT_PARAMS_PATCH', {
                effectId: SCENE_GSPLAT_REVEAL_EFFECT_ID,
                params: { totalDuration: totalDurationVal }
            });
            if (effectTimeline) {
                effectTimeline.max = (totalDurationVal * 10).toString();
            }
            pushEditHistorySafe();
        }
    };

    const onRevealRestartClick = () => {
        routeEffectsCommand('EFFECT_REPLAY', {
            effectId: SCENE_GSPLAT_REVEAL_EFFECT_ID,
            restartAnim: restartAnimTrackEnabled
        });
    };

    let isDraggingTimeline = false;

    const updateTimeline = (time: number, totalDurationVal: number) => {
        if (effectTimeline && !isDraggingTimeline) {
            effectTimeline.value = (time * 10).toString();
            effectTimeline.max = (totalDurationVal * 10).toString();
        }
        if (effectTimeDisplay) {
            effectTimeDisplay.textContent = `${time.toFixed(1)}s`;
        }
    };

    const onEffectTimelinePointerDown = () => {
        isDraggingTimeline = true;
    };

    const onEffectTimelineInput = (event: Event) => {
        const sliderValue = parseFloat((event.target as HTMLInputElement).value);
        const timeValue = sliderValue / 10;
        if (effectTimeDisplay) {
            effectTimeDisplay.textContent = `${timeValue.toFixed(1)}s`;
        }
        events.fire('effectTimeline:set', timeValue);
        events.fire('effectTime:changed', timeValue);
    };

    const onEffectTimelinePointerUp = () => {
        isDraggingTimeline = false;
    };

    const onEffectTimeChanged = (time: number) => {
        const totalDurationVal = getRevealTotalDuration(global.settings);
        updateTimeline(time, totalDurationVal);
    };

    const onRevealConfigChangedForTimeline = (newConfig: any) => {
        if (newConfig.totalDuration !== undefined) {
            const totalDurationVal = newConfig.totalDuration;
            if (effectTimeline) {
                effectTimeline.max = (totalDurationVal * 10).toString();
                const currentValue = parseFloat(effectTimeline.value) / 10;
                if (currentValue > totalDurationVal) {
                    effectTimeline.value = (totalDurationVal * 10).toString();
                    events.fire('effectTimeline:set', totalDurationVal);
                }
            }
        }
    };

    /** revealRestart / revealComplete 与 RevealController 监听顺序不定，延后到微任务再读 effectsRuntimeState。 */
    const scheduleRevealControlsRefresh = () => {
        queueMicrotask(() => updateRevealControls());
    };

    updateRevealControls = () => {
        revealPanel.classList.remove('hidden');
        if (revealType) {
            const revealTrackType = (readRevealParams(global.settings)?.type ?? 'none') as string;
            if (revealType.value !== revealTrackType && isRevealType(revealTrackType)) {
                revealType.value = revealTrackType;
            }
            if (!isRevealType(revealTrackType) && revealType.value !== 'none') {
                revealType.value = 'none';
            }
            if (persistentType) {
                const pType = getPersistentSelection();
                if (persistentType.value !== pType) {
                    persistentType.value = pType;
                }
            }
            if (persistentEnabled) {
                persistentEnabled.checked = getPersistentEnabled();
                // 一次性 reveal 正在播放时禁用 toggle。不得用 persistent 轨 `status===playing` 豁免：
                // reveal 重启会拆掉 persistent 脚本，但 state 里 persistent 仍常为 playing，会误判成「可点 toggle」。
                const oneShotRevealPlaying =
                    getRevealStatus(global.state) === 'playing' &&
                    revealTrackType !== 'none' &&
                    !isPersistentVfx(revealTrackType);
                persistentEnabled.disabled = oneShotRevealPlaying;
                persistentEnabled.title = oneShotRevealPlaying ?
                    'reveal 播放中不可切换，待 revealComplete 后可操作' :
                    '';
            }
            updatePersistentParamControls();
            const showTotalDuration = revealTrackType !== 'none' && isRevealType(revealTrackType);
            if (totalDurationRow) {
                if (showTotalDuration) {
                    totalDurationRow.classList.remove('hidden');
                    const currentTotalDuration = getRevealTotalDuration(global.settings);
                    if (totalDuration) {
                        totalDuration.value = currentTotalDuration.toString();
                    }
                } else {
                    totalDurationRow.classList.add('hidden');
                }
            }
            const showTimeline = revealTrackType !== 'none' && isRevealType(revealTrackType);
            if (effectTimelineRow) {
                if (showTimeline) {
                    effectTimelineRow.classList.remove('hidden');
                    const currentTotalDuration = getRevealTotalDuration(global.settings);
                    if (effectTimeline) {
                        effectTimeline.max = (currentTotalDuration * 10).toString();
                        effectTimeline.value = '0';
                    }
                    if (effectTimeDisplay) {
                        effectTimeDisplay.textContent = '0.0s';
                    }
                } else {
                    effectTimelineRow.classList.add('hidden');
                }
            }
        }
    };

    const onHasRevealEffectChanged = updateRevealControls;

    const onRevealTypeChanged = (type: string) => {
        if (revealType && isRevealType(type)) {
            revealType.value = type;
        }
        updateRevealControls();
    };

    const onRevealConfigChangedForControls = (newConfig: any) => {
        if (revealType && newConfig.type && isRevealType(newConfig.type)) {
            revealType.value = newConfig.type;
        }
        updateRevealControls();
    };

    if (restartAnimTrackCheck && restartAnimTrackOption) {
        restartAnimTrackOption.addEventListener('click', toggleRestartAnimTrack);
        restartAnimTrackCheck.addEventListener('click', toggleRestartAnimTrack);
    }
    revealType?.addEventListener('change', onRevealTypeChange);
    persistentType?.addEventListener('change', onPersistentTypeChange);
    persistentEnabled?.addEventListener('change', onPersistentEnabledChange);
    petalsTextureUrl?.addEventListener('change', onPetalsParamsChange);
    petalsCount?.addEventListener('change', onPetalsParamsChange);
    petalsOpacity?.addEventListener('change', onPetalsParamsChange);
    petalsExtentX?.addEventListener('change', onPetalsParamsChange);
    petalsExtentY?.addEventListener('change', onPetalsParamsChange);
    petalsExtentZ?.addEventListener('change', onPetalsParamsChange);
    weatherDensity?.addEventListener('change', onWeatherParamsChange);
    weatherSpeed?.addEventListener('change', onWeatherParamsChange);
    weatherOpacity?.addEventListener('change', onWeatherParamsChange);
    weatherDrift?.addEventListener('change', onWeatherParamsChange);
    weatherExtentX?.addEventListener('change', onWeatherParamsChange);
    weatherExtentY?.addEventListener('change', onWeatherParamsChange);
    weatherExtentZ?.addEventListener('change', onWeatherParamsChange);
    weatherMinSize?.addEventListener('change', onWeatherParamsChange);
    weatherMaxSize?.addEventListener('change', onWeatherParamsChange);
    weatherElongate?.addEventListener('change', onWeatherParamsChange);
    weatherUseFog?.addEventListener('change', onWeatherParamsChange);
    totalDuration?.addEventListener('change', onTotalDurationChange);
    revealRestart?.addEventListener('click', onRevealRestartClick);
    effectTimeline?.addEventListener('pointerdown', onEffectTimelinePointerDown);
    effectTimeline?.addEventListener('input', onEffectTimelineInput);
    effectTimeline?.addEventListener('pointerup', onEffectTimelinePointerUp);

    events.on('effectTime:changed', onEffectTimeChanged);
    events.on('revealConfigChanged', onRevealConfigChangedForTimeline);
    events.on('hasRevealEffect:changed', onHasRevealEffectChanged);
    events.on('revealType:changed', onRevealTypeChanged);
    events.on('revealConfigChanged', onRevealConfigChangedForControls);
    events.on('revealComplete', scheduleRevealControlsRefresh);
    events.on('revealRestart', scheduleRevealControlsRefresh);

    updateRevealControls();

    return function cleanupRevealUI() {
        if (restartAnimTrackCheck && restartAnimTrackOption) {
            restartAnimTrackOption.removeEventListener('click', toggleRestartAnimTrack);
            restartAnimTrackCheck.removeEventListener('click', toggleRestartAnimTrack);
        }
        revealType?.removeEventListener('change', onRevealTypeChange);
        persistentType?.removeEventListener('change', onPersistentTypeChange);
        persistentEnabled?.removeEventListener('change', onPersistentEnabledChange);
        petalsTextureUrl?.removeEventListener('change', onPetalsParamsChange);
        petalsCount?.removeEventListener('change', onPetalsParamsChange);
        petalsOpacity?.removeEventListener('change', onPetalsParamsChange);
        petalsExtentX?.removeEventListener('change', onPetalsParamsChange);
        petalsExtentY?.removeEventListener('change', onPetalsParamsChange);
        petalsExtentZ?.removeEventListener('change', onPetalsParamsChange);
        weatherDensity?.removeEventListener('change', onWeatherParamsChange);
        weatherSpeed?.removeEventListener('change', onWeatherParamsChange);
        weatherOpacity?.removeEventListener('change', onWeatherParamsChange);
        weatherDrift?.removeEventListener('change', onWeatherParamsChange);
        weatherExtentX?.removeEventListener('change', onWeatherParamsChange);
        weatherExtentY?.removeEventListener('change', onWeatherParamsChange);
        weatherExtentZ?.removeEventListener('change', onWeatherParamsChange);
        weatherMinSize?.removeEventListener('change', onWeatherParamsChange);
        weatherMaxSize?.removeEventListener('change', onWeatherParamsChange);
        weatherElongate?.removeEventListener('change', onWeatherParamsChange);
        weatherUseFog?.removeEventListener('change', onWeatherParamsChange);
        totalDuration?.removeEventListener('change', onTotalDurationChange);
        revealRestart?.removeEventListener('click', onRevealRestartClick);
        effectTimeline?.removeEventListener('pointerdown', onEffectTimelinePointerDown);
        effectTimeline?.removeEventListener('input', onEffectTimelineInput);
        effectTimeline?.removeEventListener('pointerup', onEffectTimelinePointerUp);

        events.off('effectTime:changed', onEffectTimeChanged);
        events.off('revealConfigChanged', onRevealConfigChangedForTimeline);
        events.off('hasRevealEffect:changed', onHasRevealEffectChanged);
        events.off('revealType:changed', onRevealTypeChanged);
        events.off('revealConfigChanged', onRevealConfigChangedForControls);
        events.off('revealComplete', scheduleRevealControlsRefresh);
        events.off('revealRestart', scheduleRevealControlsRefresh);

        if (effectsDebugTimer !== undefined) clearInterval(effectsDebugTimer);
        effectsDebugEl?.remove();

        container.replaceChildren();
    };
}
