import type { Global, PersistentEffectType, RevealEffectType } from '../../types';
import { PERSISTENT_EFFECT_TYPE_VALUES, REVEAL_EFFECT_TYPE_VALUES } from '../../types';
import { pushEditHistory } from '../../edit-history';
import { DEFAULT_VFX_TOTAL_DURATION } from '../../schemas/v2-custom';
import {
    SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_EFFECT_ID,
    SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID,
    SCENE_GSPLAT_REVEAL_EFFECT_ID
} from '../../vfx/effects-runtime/effects-runtime';
import type { LegacyRevealEffect } from '../../schemas/v2';
import {
    buildPersistentProtocolParams,
    buildRevealProtocolParams,
    getRevealTotalDuration,
    readPersistentTrackEffects,
    persistentTrackNameForType,
    type PersistentTrackName,
    readRevealParams,
    getRevealStatus,
    getRevealActiveType
} from '../../settings-serialize/effects-sync';
import { isPersistentVfx } from '../../vfx/effects-runtime/reveal/reveal-policy';
import { dispatchEffectsModuleCommand } from '../../editor-modules/effects-facade';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';
import { getPersistentParamSpecs, getRevealParamSpecs } from './effect-params-ui-schema';
import { mountEffectParamsPanel, type EffectParamsPanelHandle } from './effect-params-panel';

const REVEAL_EFFECTS = REVEAL_EFFECT_TYPE_VALUES;
const PERSISTENT_EFFECTS = PERSISTENT_EFFECT_TYPE_VALUES;

const isRevealType = (type: string): boolean => (REVEAL_EFFECTS as readonly string[]).includes(type);
const isPersistentType = (type: string): boolean => (PERSISTENT_EFFECTS as readonly string[]).includes(type);

const persistentEffectIdForType = (type: string): string => {
    const track = persistentTrackNameForType(type);
    if (track === 'camera') return SCENE_GSPLAT_PERSISTENT_CAMERA_EFFECT_ID;
    if (track === 'stylization') return SCENE_GSPLAT_PERSISTENT_STYLIZATION_EFFECT_ID;
    return SCENE_GSPLAT_PERSISTENT_EFFECT_ID;
};

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
  <div id="revealEnableRow" class="settingsRow hidden">
    <label style="display:inline-flex;align-items:center;gap:6px">
      <input type="checkbox" id="revealEnable" class="settingsCheckbox" checked> 启用
    </label>
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
  <div id="revealEffectParamsPanel" class="effectParamsPanel hidden"></div>
  </fieldset>
  <fieldset class="effectsTrackFieldset" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;margin-bottom:10px">
    <legend style="padding:0 6px;font-size:13px;font-weight:600">Scene（GSplat）— Persistent</legend>
    <p class="effectsTrackHint" style="font-size:11px;opacity:0.8;margin:0 0 8px;line-height:1.35">可持续特效（可多选）；与 <code>settings.effects.persistent.scene</code> 对应。</p>
    <div id="persistentTypeMultiselect" data-persistent-multiselect="scene" class="settingsRow" style="flex-wrap:wrap;gap:8px 12px">
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="perlin-wave" data-persistent-enable class="settingsCheckbox"> Perlin Wave</label>
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="sparkle-twinkle" data-persistent-enable class="settingsCheckbox"> 亮光细闪</label>
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="overall-wave" data-persistent-enable class="settingsCheckbox"> 整体波动</label>
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="butterfly-particle" data-persistent-enable class="settingsCheckbox"> 琉光飞蝶</label>
    </div>
  </fieldset>
  <fieldset class="effectsTrackFieldset" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;margin-bottom:10px">
    <legend style="padding:0 6px;font-size:13px;font-weight:600">Camera — Persistent</legend>
    <p class="effectsTrackHint" style="font-size:11px;opacity:0.8;margin:0 0 8px;line-height:1.35">镜头/天气类可持续特效；同轨新增会替换旧类型。</p>
    <div data-persistent-multiselect="camera" class="settingsRow" style="flex-wrap:wrap;gap:8px 12px">
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="falling-petals" data-persistent-enable class="settingsCheckbox"> Falling Petals</label>
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="falling-rain" data-persistent-enable class="settingsCheckbox"> Falling Rain</label>
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="falling-snow" data-persistent-enable class="settingsCheckbox"> Falling Snow</label>
    </div>
  </fieldset>
  <fieldset class="effectsTrackFieldset" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;margin-bottom:10px">
    <legend style="padding:0 6px;font-size:13px;font-weight:600">Stylization — Persistent</legend>
    <p class="effectsTrackHint" style="font-size:11px;opacity:0.8;margin:0 0 8px;line-height:1.35">风格化可持续特效；同轨新增会替换旧类型。</p>
    <div data-persistent-multiselect="stylization" class="settingsRow" style="flex-wrap:wrap;gap:8px 12px">
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="nostalgic-comic" data-persistent-enable class="settingsCheckbox"> Nostalgic Comic</label>
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="yiyun-dianran" data-persistent-enable class="settingsCheckbox"> 意韵点染</label>
      <label style="display:inline-flex;align-items:center;gap:4px"><input type="checkbox" data-persistent-type="palette-pixel" data-persistent-enable class="settingsCheckbox"> 像素色板</label>
    </div>
  </fieldset>
  <fieldset class="effectsTrackFieldset" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;margin-bottom:10px">
    <legend style="padding:0 6px;font-size:13px;font-weight:600">Persistent Params</legend>
    <div id="persistentEffectParamsPanels" class="effectParamsPanel hidden"></div>
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
    const { events, state } = global;

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
            'font-size:10px;opacity:0.88;max-height:140px;overflow:auto;margin:8px 0 0;padding:8px;'
            + 'background:rgba(0,0,0,0.35);border-radius:6px;white-space:pre-wrap;word-break:break-all';
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
    const revealEnableRow = container.querySelector('#revealEnableRow') as HTMLElement | null;
    const revealEnable = container.querySelector('#revealEnable') as HTMLInputElement | null;
    const persistentMultiselectRoots = Array.from(container.querySelectorAll<HTMLElement>('[data-persistent-multiselect]'));
    const revealRestart = container.querySelector('#revealRestart');
    const totalDurationRow = container.querySelector('#totalDurationRow') as HTMLElement | null;
    const totalDuration = container.querySelector('#totalDuration') as HTMLInputElement | null;
    const effectTimelineRow = container.querySelector('#effectTimelineRow') as HTMLElement | null;
    const effectTimeline = container.querySelector('#effectTimeline') as HTMLInputElement | null;
    const effectTimeDisplay = container.querySelector('#effectTimeDisplay');
    const restartAnimTrackCheck = container.querySelector('#restartAnimTrackCheck');
    const restartAnimTrackOption = container.querySelector('#restartAnimTrackOption');
    const revealEffectParamsPanelEl = container.querySelector('#revealEffectParamsPanel') as HTMLElement | null;
    const persistentEffectParamsPanelsEl = container.querySelector('#persistentEffectParamsPanels') as HTMLElement | null;

    let revealParamsPanel: EffectParamsPanelHandle | null = null;
    const persistentParamsPanels = new Map<string, EffectParamsPanelHandle>();
    /** 各 persistent 面板当前 spec 键签名；`noiseType` 等条件字段变化时需重建控件 */
    const persistentPanelSpecSigs = new Map<string, string>();
    let revealParamsPanelType = '';

    const persistentPanelSpecSignature = (type: string, params: Record<string, unknown>): string =>
        getPersistentParamSpecs(type, params)
            .map(s => s.key)
            .join('|');

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

    const routeEffectsCommand = (
        type:
            | 'EFFECT_PARAMS_PATCH'
            | 'EFFECT_TOGGLE'
            | 'EFFECT_REPLAY'
            | 'EFFECT_ADD'
            | 'EFFECT_DELETE',
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

    const currentRevealType = (): string => (readRevealParams(global.settings)?.type ?? 'none') as string;

    const revealProtocolParams = (patch: Partial<LegacyRevealEffect>): Record<string, unknown> =>
        buildRevealProtocolParams(patch, currentRevealType());

    const readPersistentEffectParamsForType = (type: string): Record<string, unknown> => {
        const entry = readPersistentTrackEffects(
            global.settings,
            persistentTrackNameForType(type),
            { includeDisabled: true }
        ).find(e => e.type === type);
        const ep = entry?.effectParams;
        if (ep && typeof ep === 'object' && !Array.isArray(ep)) {
            return { ...(ep as Record<string, unknown>) };
        }
        return {};
    };

    const persistentProtocolParams = (
        patchByType: Record<string, { enable?: boolean; autoStart?: boolean; effectParams?: Record<string, unknown> }>
    ): Record<string, unknown> => buildPersistentProtocolParams(patchByType);

    const readRevealEffectParams = (): Record<string, unknown> => {
        const ep = readRevealParams(global.settings)?.effectParams;
        if (ep && typeof ep === 'object' && !Array.isArray(ep)) {
            return { ...(ep as Record<string, unknown>) };
        }
        return {};
    };

    const patchRevealEffectParams = (partial: Record<string, unknown>) => {
        if (Object.keys(partial).length === 0) return;
        routeEffectsCommand('EFFECT_PARAMS_PATCH', {
            effectId: SCENE_GSPLAT_REVEAL_EFFECT_ID,
            params: revealProtocolParams({ effectParams: partial })
        });
        pushEditHistorySafe();
    };

    const patchPersistentEffectParamsForType = (type: string, partial: Record<string, unknown>) => {
        if (Object.keys(partial).length === 0 || !isPersistentType(type)) return;
        routeEffectsCommand('EFFECT_PARAMS_PATCH', {
            effectId: persistentEffectIdForType(type),
            params: persistentProtocolParams({ [type]: { effectParams: partial } })
        });
        pushEditHistorySafe();
        if (type === 'overall-wave' && Object.prototype.hasOwnProperty.call(partial, 'noiseType')) {
            syncPersistentParamsPanels();
        }
        if (type === 'butterfly-particle' && Object.prototype.hasOwnProperty.call(partial, 'colorCycleEnabled')) {
            syncPersistentParamsPanels();
        }
    };

    const ensureRevealParamsPanel = (effectType: string) => {
        if (!revealEffectParamsPanelEl) return;
        if (effectType === 'none' || !isRevealType(effectType)) {
            revealParamsPanel?.destroy();
            revealParamsPanel = null;
            revealParamsPanelType = '';
            revealEffectParamsPanelEl.classList.add('hidden');
            return;
        }
        if (revealParamsPanelType !== effectType) {
            revealParamsPanel?.destroy();
            revealParamsPanel = mountEffectParamsPanel({
                container: revealEffectParamsPanelEl,
                specs: getRevealParamSpecs(effectType),
                onPatch: patchRevealEffectParams
            });
            revealParamsPanelType = effectType;
        }
        revealParamsPanel?.syncFromValues(readRevealEffectParams());
        revealParamsPanel?.setVisible(true);
    };

    const patchPersistentEnableForType = (type: string, enable: boolean) => {
        if (!isPersistentType(type)) return;
        routeEffectsCommand('EFFECT_PARAMS_PATCH', {
            effectId: persistentEffectIdForType(type),
            params: persistentProtocolParams({ [type]: { enable } })
        });
        pushEditHistorySafe();
        updateRevealControls();
    };

    const syncPersistentParamsPanels = () => {
        if (!persistentEffectParamsPanelsEl) return;
        const all = (['scene', 'camera', 'stylization'] as PersistentTrackName[]).flatMap(track =>
            readPersistentTrackEffects(global.settings, track, { includeDisabled: true })
        );
        const configuredSet = new Set(all.map(e => e.type));

        for (const [type, panel] of persistentParamsPanels) {
            if (!configuredSet.has(type)) {
                panel.destroy();
                persistentParamsPanels.delete(type);
                persistentPanelSpecSigs.delete(type);
            }
        }

        if (all.length === 0) {
            persistentEffectParamsPanelsEl.replaceChildren();
            persistentEffectParamsPanelsEl.classList.add('hidden');
            return;
        }

        persistentEffectParamsPanelsEl.classList.remove('hidden');
        for (const entry of all) {
            const type = entry.type;
            const params = readPersistentEffectParamsForType(type);
            const specSig = persistentPanelSpecSignature(type, params);
            let section = persistentEffectParamsPanelsEl.querySelector(
                `[data-persistent-params-type="${type}"]`
            ) as HTMLElement | null;
            if (section && persistentPanelSpecSigs.get(type) !== specSig) {
                persistentParamsPanels.get(type)?.destroy();
                persistentParamsPanels.delete(type);
                persistentPanelSpecSigs.delete(type);
                section.remove();
                section = null;
            }
            if (!section) {
                section = document.createElement('div');
                section.dataset.persistentParamsType = type;
                section.style.marginBottom = '10px';
                const title = document.createElement('div');
                title.style.cssText =
                    'font-size:12px;font-weight:600;margin-bottom:6px;opacity:0.9;display:flex;align-items:center;gap:8px';
                const enableInput = document.createElement('input');
                enableInput.type = 'checkbox';
                enableInput.className = 'settingsCheckbox';
                enableInput.dataset.persistentParamsEnable = type;
                enableInput.checked = entry.enable;
                const titleText = document.createElement('span');
                titleText.textContent = type;
                title.appendChild(enableInput);
                title.appendChild(titleText);
                const enableLabel = document.createElement('span');
                enableLabel.style.cssText = 'font-size:11px;font-weight:400;opacity:0.75';
                enableLabel.textContent = '启用';
                title.appendChild(enableLabel);
                section.appendChild(title);
                const inner = document.createElement('div');
                inner.className = 'effectParamsPanelInner';
                section.appendChild(inner);
                const panel = mountEffectParamsPanel({
                    container: inner,
                    specs: getPersistentParamSpecs(type, params),
                    onPatch: (partial) => patchPersistentEffectParamsForType(type, partial)
                });
                persistentParamsPanels.set(type, panel);
                persistentPanelSpecSigs.set(type, specSig);
                panel.syncFromValues(params);
                persistentEffectParamsPanelsEl.appendChild(section);
            } else {
                const enableInput = section.querySelector<HTMLInputElement>(
                    `input[data-persistent-params-enable="${type}"]`
                );
                if (enableInput) {
                    enableInput.checked = entry.enable;
                }
                const panel = persistentParamsPanels.get(type);
                panel?.syncFromValues(params);
            }
        }

        for (const child of Array.from(persistentEffectParamsPanelsEl.children)) {
            const t = (child as HTMLElement).dataset.persistentParamsType;
            if (t && !configuredSet.has(t)) {
                persistentParamsPanels.get(t)?.destroy();
                persistentParamsPanels.delete(t);
                persistentPanelSpecSigs.delete(t);
                child.remove();
            }
        }
    };

    const syncEffectParamsPanels = () => {
        const revealTrackType = (readRevealParams(global.settings)?.type ?? 'none') as string;
        ensureRevealParamsPanel(revealTrackType);
        syncPersistentParamsPanels();
    };

    const syncRevealEnableCheckbox = () => {
        if (!revealEnable) return;
        const revealTrackType = (readRevealParams(global.settings)?.type ?? 'none') as string;
        const show = revealTrackType !== 'none' && isRevealType(revealTrackType);
        if (revealEnableRow) {
            revealEnableRow.classList.toggle('hidden', !show);
        }
        if (show) {
            const rp = readRevealParams(global.settings);
            revealEnable.checked = rp?.enable !== false;
        }
    };

    const syncPersistentTypeCheckboxes = () => {
        const all = (['scene', 'camera', 'stylization'] as PersistentTrackName[]).flatMap(track =>
            readPersistentTrackEffects(global.settings, track, { includeDisabled: true })
        );
        const activeSet = new Set(all.filter(e => e.enable).map(e => e.type));
        const configuredSet = new Set(all.map(e => e.type));
        container.querySelectorAll<HTMLInputElement>('input[data-persistent-type]').forEach((input) => {
            const t = input.dataset.persistentType ?? '';
            input.checked = activeSet.has(t);
            input.indeterminate = configuredSet.has(t) && !activeSet.has(t);
        });
    };

    const onRevealEnableChange = (event: Event) => {
        const target = event.target as HTMLInputElement;
        routeEffectsCommand('EFFECT_PARAMS_PATCH', {
            effectId: SCENE_GSPLAT_REVEAL_EFFECT_ID,
            params: revealProtocolParams({ enable: target.checked })
        });
        pushEditHistorySafe();
    };

    const onRevealTypeChange = (event: Event) => {
        const target = (event.target as HTMLSelectElement);
        const type = target.value as RevealType;
        routeEffectsCommand('EFFECT_ADD', {
            effectId: SCENE_GSPLAT_REVEAL_EFFECT_ID,
            effectType: type
        });
        pushEditHistorySafe();
    };

    const onPersistentTypeCheckboxChange = (event: Event) => {
        const target = event.target as HTMLInputElement;
        const type = target.dataset.persistentType ?? '';
        if (!isPersistentType(type)) return;
        if (target.checked) {
            routeEffectsCommand('EFFECT_ADD', {
                effectId: persistentEffectIdForType(type),
                effectType: type
            });
        } else {
            const configured = readPersistentTrackEffects(
                global.settings,
                persistentTrackNameForType(type),
                { includeDisabled: true }
            ).some(e => e.type === type);
            if (!configured) return;
            routeEffectsCommand('EFFECT_DELETE', {
                effectId: persistentEffectIdForType(type),
                effectType: type
            });
        }
        pushEditHistorySafe();
        updateRevealControls();
    };

    const onPersistentParamsEnableChange = (event: Event) => {
        const target = event.target as HTMLInputElement;
        const type = target.dataset.persistentParamsEnable ?? '';
        if (!isPersistentType(type)) return;
        patchPersistentEnableForType(type, target.checked);
    };

    const onTotalDurationChange = (event: Event) => {
        const target = event.target as HTMLInputElement;
        const totalDurationVal = parseFloat(target.value);
        if (!isNaN(totalDurationVal) && totalDurationVal > 0) {
            routeEffectsCommand('EFFECT_PARAMS_PATCH', {
                effectId: SCENE_GSPLAT_REVEAL_EFFECT_ID,
                params: revealProtocolParams({ totalDuration: totalDurationVal })
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

    const updateRevealControls = () => {
        revealPanel.classList.remove('hidden');
        if (revealType) {
            const revealTrackType = (readRevealParams(global.settings)?.type ?? 'none') as string;
            if (revealType.value !== revealTrackType && isRevealType(revealTrackType)) {
                revealType.value = revealTrackType;
            }
            if (!isRevealType(revealTrackType) && revealType.value !== 'none') {
                revealType.value = 'none';
            }
            syncRevealEnableCheckbox();
            syncPersistentTypeCheckboxes();
            if (persistentMultiselectRoots.length > 0) {
                const oneShotRevealPlaying =
                    getRevealStatus(global.state) === 'playing' &&
                    revealTrackType !== 'none' &&
                    !isPersistentVfx(revealTrackType);
                container.querySelectorAll<HTMLInputElement>('input[data-persistent-type]').forEach(
                    (input) => {
                        input.disabled = oneShotRevealPlaying;
                    }
                );
                for (const root of persistentMultiselectRoots) {
                    root.title = oneShotRevealPlaying ? 'reveal 播放中不可切换，待 revealComplete 后可操作' : '';
                }
            }
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
            syncEffectParamsPanels();
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
        if (revealEnable && typeof newConfig?.enable === 'boolean') {
            revealEnable.checked = newConfig.enable;
        }
        updateRevealControls();
        if (newConfig?.effectParams && revealParamsPanel) {
            revealParamsPanel.syncFromValues(readRevealEffectParams());
        }
    };

    const syncPersistentEffectsUiFromSettings = () => {
        syncPersistentTypeCheckboxes();
        syncPersistentParamsPanels();
    };

    const onPersistentSceneEffectsChanged = () => {
        syncPersistentEffectsUiFromSettings();
    };

    const onPersistentRevealConfigChanged = () => {
        syncPersistentEffectsUiFromSettings();
    };

    if (restartAnimTrackCheck && restartAnimTrackOption) {
        restartAnimTrackOption.addEventListener('click', toggleRestartAnimTrack);
        restartAnimTrackCheck.addEventListener('click', toggleRestartAnimTrack);
    }
    revealType?.addEventListener('change', onRevealTypeChange);
    revealEnable?.addEventListener('change', onRevealEnableChange);
    for (const root of persistentMultiselectRoots) {
        root.addEventListener('change', onPersistentTypeCheckboxChange);
    }
    persistentEffectParamsPanelsEl?.addEventListener('change', onPersistentParamsEnableChange);
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
    events.on('persistentSceneEffectsChanged', onPersistentSceneEffectsChanged);
    events.on('persistentRevealConfigChanged', onPersistentRevealConfigChanged);
    events.on('revealComplete', scheduleRevealControlsRefresh);
    events.on('revealRestart', scheduleRevealControlsRefresh);

    for (const panelEl of [revealEffectParamsPanelEl, persistentEffectParamsPanelsEl]) {
        panelEl?.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
    }

    updateRevealControls();

    return function cleanupRevealUI() {
        if (restartAnimTrackCheck && restartAnimTrackOption) {
            restartAnimTrackOption.removeEventListener('click', toggleRestartAnimTrack);
            restartAnimTrackCheck.removeEventListener('click', toggleRestartAnimTrack);
        }
        revealType?.removeEventListener('change', onRevealTypeChange);
        revealEnable?.removeEventListener('change', onRevealEnableChange);
        for (const root of persistentMultiselectRoots) {
            root.removeEventListener('change', onPersistentTypeCheckboxChange);
        }
        persistentEffectParamsPanelsEl?.removeEventListener('change', onPersistentParamsEnableChange);
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
        events.off('persistentSceneEffectsChanged', onPersistentSceneEffectsChanged);
        events.off('persistentRevealConfigChanged', onPersistentRevealConfigChanged);
        events.off('revealComplete', scheduleRevealControlsRefresh);
        events.off('revealRestart', scheduleRevealControlsRefresh);

        revealParamsPanel?.destroy();
        for (const panel of persistentParamsPanels.values()) {
            panel.destroy();
        }
        persistentParamsPanels.clear();

        if (effectsDebugTimer !== undefined) clearInterval(effectsDebugTimer);
        effectsDebugEl?.remove();

        container.replaceChildren();
    };
}
