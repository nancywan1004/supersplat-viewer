import type { Global } from '../../types';

/** 需要 totalDuration / 时间轴 的 VFX 特效类型列表 */
export const TIMED_VFX_EFFECTS = ['rain_v2', 'pieces-recover', 'integrate', 'growth-wave', 'sketch'] as const;

export type RevealType = 'radial' | 'rain' | 'rain_v2' | 'smooth' | 'pieces-recover' | 'perlin-wave' | 'integrate' | 'growth-wave' | 'sketch' | 'none';

/**
 * 初始化 Reveal / VFX 与效果时间轴相关 UI。
 * 包括：特效类型选择、总时长、重播时是否同步动画轨道、重播按钮、效果时间轴（播放/暂停、拖动）。
 * @returns 清理函数，调用后解除所有事件订阅与 DOM 监听，便于组件卸载或重建。
 */
export function initRevealUI(global: Global): () => void {
    const { events, state } = global;

    const revealPanel = document.getElementById('revealPanel');
    const revealType = document.getElementById('revealType') as HTMLSelectElement | null;
    const revealRestart = document.getElementById('revealRestart');
    const totalDurationRow = document.getElementById('totalDurationRow');
    const totalDuration = document.getElementById('totalDuration') as HTMLInputElement | null;
    const effectTimelineRow = document.getElementById('effectTimelineRow');
    const effectTimeline = document.getElementById('effectTimeline') as HTMLInputElement | null;
    const effectPlayPause = document.getElementById('effectPlayPause') as HTMLButtonElement | null;
    const effectTimeDisplay = document.getElementById('effectTimeDisplay');
    const restartAnimTrackCheck = document.getElementById('restartAnimTrackCheck');
    const restartAnimTrackOption = document.getElementById('restartAnimTrackOption');

    let restartAnimTrackEnabled = false;

    const toggleRestartAnimTrack = () => {
        restartAnimTrackEnabled = !restartAnimTrackEnabled;
        restartAnimTrackCheck?.classList[restartAnimTrackEnabled ? 'add' : 'remove']('active');
        state.syncAnimTrackOnExport = restartAnimTrackEnabled;
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
        if (revealPanel) {
            revealPanel.classList.remove('hidden');
        }
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

    // DOM 监听
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

    // 事件订阅
    events.on('effectTime:changed', onEffectTimeChanged);
    events.on('effectPlayPause:changed', onEffectPlayPauseChanged);
    events.on('revealConfigChanged', onRevealConfigChangedForTimeline);
    events.on('hasRevealEffect:changed', onHasRevealEffectChanged);
    events.on('revealType:changed', onRevealTypeChanged);
    events.on('revealConfigChanged', onRevealConfigChangedForControls);

    updateRevealControls(); // 初始同步 UI

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
    };
}
