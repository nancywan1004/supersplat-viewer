import type { Global } from '../../types';

/** 需要 totalDuration / 时间轴 的 VFX 特效类型列表 */
export const TIMED_VFX_EFFECTS = ['rain_v2', 'pieces-recover', 'integrate', 'growth-wave', 'sketch'] as const;

export type RevealType = 'radial' | 'rain' | 'rain_v2' | 'smooth' | 'pieces-recover' | 'perlin-wave' | 'integrate' | 'growth-wave' | 'sketch' | 'none';

/** Reveal 面板的 HTML 模板（挂载到 #revealPanelContainer，内含 #vfxVideoExportContainer 供 video-export-ui 挂载） */
const REVEAL_PANEL_HTML = `
<div id="revealPanel" class="hidden">
  <div class="settingsRow">
    <label for="revealType">Effect:</label>
    <select id="revealType" class="settingsSelect">
      <option value="none">None</option>
      <optgroup label="Reveal Effects">
        <option value="radial">Radial</option>
        <option value="rain">Rain</option>
        <option value="smooth">Smooth</option>
      </optgroup>
      <optgroup label="Timed VFX Effects">
        <option value="rain_v2">Rain_V2</option>
        <option value="pieces-recover">Pieces Recover</option>
        <option value="integrate">Integrate</option>
        <option value="growth-wave">Growth Wave</option>
        <option value="sketch">Sketch</option>
      </optgroup>
      <optgroup label="Continuous VFX Effects">
        <option value="perlin-wave">Perlin Wave</option>
      </optgroup>
    </select>
  </div>
  <div id="totalDurationRow" class="settingsRow hidden">
    <label for="totalDuration">Total Duration (s):</label>
    <input type="number" id="totalDuration" class="settingsInput" min="1" max="60" step="0.5" value="15">
  </div>
  <div id="effectTimelineRow" class="settingsRow hidden">
    <div class="effectTimelineInner">
      <button id="effectPlayPause" class="settingsButton" type="button" aria-label="Play/Pause">⏸</button>
      <input type="range" id="effectTimeline" min="0" max="200" step="1" value="0" class="effectTimelineRange">
      <span id="effectTimeDisplay" class="effectTimeDisplay">0.0s</span>
    </div>
  </div>
  <div id="vfxVideoExportContainer"></div>
  <div class="settingsRow">
    <button id="revealRestart" class="settingsButton" type="button">Restart Effect</button>
  </div>
  <div class="settingsRow">
    <div id="restartAnimTrackCheck" class="checkMark">✓</div>
    <div id="restartAnimTrackOption">Restart AnimTrack</div>
  </div>
</div>
`.trim();

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
    const revealType = container.querySelector('#revealType') as HTMLSelectElement | null;
    const revealRestart = container.querySelector('#revealRestart');
    const totalDurationRow = container.querySelector('#totalDurationRow') as HTMLElement | null;
    const totalDuration = container.querySelector('#totalDuration') as HTMLInputElement | null;
    const effectTimelineRow = container.querySelector('#effectTimelineRow') as HTMLElement | null;
    const effectTimeline = container.querySelector('#effectTimeline') as HTMLInputElement | null;
    const effectPlayPause = container.querySelector('#effectPlayPause') as HTMLButtonElement | null;
    const effectTimeDisplay = container.querySelector('#effectTimeDisplay');
    const restartAnimTrackCheck = container.querySelector('#restartAnimTrackCheck');
    const restartAnimTrackOption = container.querySelector('#restartAnimTrackOption');

    let restartAnimTrackEnabled = false;

    const toggleRestartAnimTrack = () => {
        restartAnimTrackEnabled = !restartAnimTrackEnabled;
        restartAnimTrackCheck?.classList[restartAnimTrackEnabled ? 'add' : 'remove']('active');
        // 不写入 state：state 可能是 Proxy，不允许随意 set 新属性；导出时以 DOM (#restartAnimTrackCheck.active) 为准
    };

    const onRevealTypeChange = (event: Event) => {
        const target = (event.target as HTMLSelectElement);
        const type = target.value as RevealType;
        events.fire('revealConfigChanged', { type });
    };

    const onTotalDurationChange = (event: Event) => {
        const target = event.target as HTMLInputElement;
        const totalDurationVal = parseFloat(target.value);
        if (!isNaN(totalDurationVal) && totalDurationVal > 0) {
            events.fire('revealConfigChanged', { totalDuration: totalDurationVal });
            if (effectTimeline) {
                effectTimeline.max = (totalDurationVal * 10).toString();
            }
        }
    };

    const onRevealRestartClick = () => {
        events.fire('revealRestart', restartAnimTrackEnabled);
    };

    let isDraggingTimeline = false;
    let wasPausedBeforeDrag = false;

    const updatePlayPauseButton = (paused: boolean) => {
        if (effectPlayPause) {
            effectPlayPause.textContent = paused ? '▶' : '⏸';
        }
    };

    const updateTimeline = (time: number, totalDurationVal: number) => {
        if (effectTimeline && !isDraggingTimeline) {
            effectTimeline.value = (time * 10).toString();
            effectTimeline.max = (totalDurationVal * 10).toString();
        }
        if (effectTimeDisplay) {
            effectTimeDisplay.textContent = `${time.toFixed(1)}s`;
        }
    };

    const onEffectPlayPauseClick = () => {
        events.fire('effectPlayPause:toggle');
    };

    const onEffectTimelinePointerDown = () => {
        isDraggingTimeline = true;
        wasPausedBeforeDrag = (state as any).effectPaused ?? false;
        events.fire('effectPlayPause:set', true);
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
        events.fire('effectPlayPause:set', wasPausedBeforeDrag);
    };

    const onEffectTimeChanged = (time: number) => {
        const totalDurationVal = global.settings?.revealEffect?.totalDuration ?? 20.0;
        updateTimeline(time, totalDurationVal);
    };

    const onEffectPlayPauseChanged = (paused: boolean) => {
        updatePlayPauseButton(paused);
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

    const updateRevealControls = () => {
        revealPanel.classList.remove('hidden');
        if (revealType) {
            const currentType = (state as any).vfxType || global.settings?.revealEffect?.type || 'none';
            if (revealType.value !== currentType) {
                revealType.value = currentType;
            }
            const showTotalDuration = TIMED_VFX_EFFECTS.includes(currentType as any);
            if (totalDurationRow) {
                if (showTotalDuration) {
                    totalDurationRow.classList.remove('hidden');
                    const currentTotalDuration = global.settings?.revealEffect?.totalDuration ?? 20.0;
                    if (totalDuration) {
                        totalDuration.value = currentTotalDuration.toString();
                    }
                } else {
                    totalDurationRow.classList.add('hidden');
                }
            }
            const showTimeline = TIMED_VFX_EFFECTS.includes(currentType as any);
            if (effectTimelineRow) {
                if (showTimeline) {
                    effectTimelineRow.classList.remove('hidden');
                    const currentTotalDuration = global.settings?.revealEffect?.totalDuration ?? 20.0;
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
        if (revealType) {
            revealType.value = type;
        }
        updateRevealControls();
    };

    const onRevealConfigChangedForControls = (newConfig: any) => {
        if (revealType && newConfig.type) {
            revealType.value = newConfig.type;
        }
        updateRevealControls();
    };

    if (restartAnimTrackCheck && restartAnimTrackOption) {
        restartAnimTrackOption.addEventListener('click', toggleRestartAnimTrack);
        restartAnimTrackCheck.addEventListener('click', toggleRestartAnimTrack);
    }
    revealType?.addEventListener('change', onRevealTypeChange);
    totalDuration?.addEventListener('change', onTotalDurationChange);
    revealRestart?.addEventListener('click', onRevealRestartClick);
    effectPlayPause?.addEventListener('click', onEffectPlayPauseClick);
    effectTimeline?.addEventListener('pointerdown', onEffectTimelinePointerDown);
    effectTimeline?.addEventListener('input', onEffectTimelineInput);
    effectTimeline?.addEventListener('pointerup', onEffectTimelinePointerUp);

    events.on('effectTime:changed', onEffectTimeChanged);
    events.on('effectPlayPause:changed', onEffectPlayPauseChanged);
    events.on('revealConfigChanged', onRevealConfigChangedForTimeline);
    events.on('hasRevealEffect:changed', onHasRevealEffectChanged);
    events.on('revealType:changed', onRevealTypeChanged);
    events.on('revealConfigChanged', onRevealConfigChangedForControls);

    updateRevealControls();

    return function cleanupRevealUI() {
        if (restartAnimTrackCheck && restartAnimTrackOption) {
            restartAnimTrackOption.removeEventListener('click', toggleRestartAnimTrack);
            restartAnimTrackCheck.removeEventListener('click', toggleRestartAnimTrack);
        }
        revealType?.removeEventListener('change', onRevealTypeChange);
        totalDuration?.removeEventListener('change', onTotalDurationChange);
        revealRestart?.removeEventListener('click', onRevealRestartClick);
        effectPlayPause?.removeEventListener('click', onEffectPlayPauseClick);
        effectTimeline?.removeEventListener('pointerdown', onEffectTimelinePointerDown);
        effectTimeline?.removeEventListener('input', onEffectTimelineInput);
        effectTimeline?.removeEventListener('pointerup', onEffectTimelinePointerUp);

        events.off('effectTime:changed', onEffectTimeChanged);
        events.off('effectPlayPause:changed', onEffectPlayPauseChanged);
        events.off('revealConfigChanged', onRevealConfigChangedForTimeline);
        events.off('hasRevealEffect:changed', onHasRevealEffectChanged);
        events.off('revealType:changed', onRevealTypeChanged);
        events.off('revealConfigChanged', onRevealConfigChangedForControls);

        container.replaceChildren();
    };
}
