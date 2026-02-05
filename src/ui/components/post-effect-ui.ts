import type { Global } from '../../types';

const POST_EFFECT_PANEL_HTML = `
<div class="postEffectPanel">
  <div class="postEffectSectionLabel">Bloom</div>
  <div class="settingsRow">
    <div id="bloomEnableCheck" class="checkMark">✓</div>
    <div id="bloomEnableOption" class="postEffectOption">Enable</div>
  </div>
  <div class="settingsRow">
    <label for="bloomIntensitySlider" class="postEffectLabel">Intensity:</label>
    <div class="postEffectSliderWrap">
      <input type="range" id="bloomIntensitySlider" min="0" max="0.2" step="0.01" value="0.1" class="postEffectSlider">
      <span id="bloomIntensityValue" class="postEffectSliderValue">0.10</span>
    </div>
  </div>
  <div class="settingsRow">
    <label for="bloomBlurLevelSlider" class="postEffectLabel">BlurLevel:</label>
    <div class="postEffectSliderWrap">
      <input type="range" id="bloomBlurLevelSlider" min="1" max="16" step="1" value="2" class="postEffectSlider">
      <span id="bloomBlurLevelValue" class="postEffectSliderValue">2</span>
    </div>
  </div>
  <div class="settingsRow">
    <label for="bloomThresholdSlider" class="postEffectLabel">Threshold (HDR):</label>
    <div class="postEffectSliderWrap">
      <input type="range" id="bloomThresholdSlider" min="0" max="5" step="0.1" value="0.2" class="postEffectSlider">
      <span id="bloomThresholdValue" class="postEffectSliderValue">0.20</span>
    </div>
  </div>
  <div class="settingsRow">
    <div id="bloomDebugCheck" class="checkMark">✓</div>
    <div id="bloomDebugOption" class="postEffectOption">Bloom Debug</div>
  </div>
  <div class="settingsRow">
    <div id="bloomBrushCheck" class="checkMark">✓</div>
    <div id="bloomBrushOption" class="postEffectOption">Bloom Brush (局部)</div>
  </div>
  <div id="bloomBrushOptionsRow" class="settingsRow hidden">
    <label for="bloomBrushSizeSlider" class="postEffectLabel">Brush Size:</label>
    <div class="postEffectSliderWrap">
      <input type="range" id="bloomBrushSizeSlider" min="1" max="200" step="1" value="30" class="postEffectSlider">
      <span id="bloomBrushSizeValue" class="postEffectSliderValue">30</span>
    </div>
    <button type="button" id="bloomBrushClearBtn" class="postEffectOption">Clear mask</button>
  </div>
</div>
`.trim();

type BloomSettings = {
    enabled: boolean;
    intensity: number;
    blurLevel: number;
    threshold: number;
    bloomDebug: boolean;
    bloomBrush: boolean;
    bloomBrushSize: number;
};

const ensureBloom = (settings: Global['settings']): BloomSettings => {
    if (!settings.postEffectSettings) (settings as any).postEffectSettings = {};
    const b = settings.postEffectSettings.bloom;
    if (!b) {
        (settings.postEffectSettings as any).bloom = {
            enabled: false,
            intensity: 0.1,
            blurLevel: 2,
            threshold: 0.2,
            bloomDebug: false,
            bloomBrush: false,
            bloomBrushSize: 30
        };
    } else {
        if ((b as any).threshold === undefined) (b as any).threshold = 0.2;
        if ((b as any).bloomDebug === undefined) (b as any).bloomDebug = false;
        if ((b as any).bloomBrush === undefined) (b as any).bloomBrush = false;
        if ((b as any).bloomBrushSize === undefined) (b as any).bloomBrushSize = 30;
    }
    return settings.postEffectSettings.bloom as BloomSettings;
};

/**
 * 初始化 Post Effect 面板 UI（Bloom：Enable、Intensity、BlurLevel、Threshold、Debug、Brush）。
 * 挂载到 #postEffectPanelContainer；若无容器则跳过。
 * @returns 清理函数
 */
export function initPostEffectUI(global: Global): () => void {
    const { settings, events } = global;

    const container = document.getElementById('postEffectPanelContainer');
    if (!container) return () => {};

    container.innerHTML = POST_EFFECT_PANEL_HTML;

    const bloomEnableCheck = container.querySelector('#bloomEnableCheck') as HTMLElement | null;
    const bloomEnableOption = container.querySelector('#bloomEnableOption') as HTMLElement | null;
    const bloomIntensitySlider = container.querySelector('#bloomIntensitySlider') as HTMLInputElement | null;
    const bloomIntensityValue = container.querySelector('#bloomIntensityValue') as HTMLElement | null;
    const bloomBlurLevelSlider = container.querySelector('#bloomBlurLevelSlider') as HTMLInputElement | null;
    const bloomBlurLevelValue = container.querySelector('#bloomBlurLevelValue') as HTMLElement | null;
    const bloomThresholdSlider = container.querySelector('#bloomThresholdSlider') as HTMLInputElement | null;
    const bloomThresholdValue = container.querySelector('#bloomThresholdValue') as HTMLElement | null;
    const bloomDebugCheck = container.querySelector('#bloomDebugCheck') as HTMLElement | null;
    const bloomDebugOption = container.querySelector('#bloomDebugOption') as HTMLElement | null;
    const bloomBrushCheck = container.querySelector('#bloomBrushCheck') as HTMLElement | null;
    const bloomBrushOption = container.querySelector('#bloomBrushOption') as HTMLElement | null;
    const bloomBrushOptionsRow = container.querySelector('#bloomBrushOptionsRow') as HTMLElement | null;
    const bloomBrushSizeSlider = container.querySelector('#bloomBrushSizeSlider') as HTMLInputElement | null;
    const bloomBrushSizeValue = container.querySelector('#bloomBrushSizeValue') as HTMLElement | null;
    const bloomBrushClearBtn = container.querySelector('#bloomBrushClearBtn') as HTMLButtonElement | null;

    const syncFromSettings = () => {
        const b = ensureBloom(settings);
        if (bloomEnableCheck) bloomEnableCheck.classList.toggle('active', b.enabled);
        const intensity = Math.min(0.2, Math.max(0, Number(b.intensity)));
        if (bloomIntensitySlider) bloomIntensitySlider.value = String(intensity);
        if (bloomIntensityValue) bloomIntensityValue.textContent = intensity.toFixed(2);
        if (bloomBlurLevelSlider) bloomBlurLevelSlider.value = String(b.blurLevel);
        if (bloomBlurLevelValue) bloomBlurLevelValue.textContent = String(b.blurLevel);
        const th = Math.max(0, Math.min(5, Number(b.threshold ?? 0.2)));
        if (bloomThresholdSlider) bloomThresholdSlider.value = String(th);
        if (bloomThresholdValue) bloomThresholdValue.textContent = th.toFixed(2);
        if (bloomDebugCheck) bloomDebugCheck.classList.toggle('active', b.bloomDebug ?? false);
        if (bloomBrushCheck) bloomBrushCheck.classList.toggle('active', b.bloomBrush ?? false);
        if (bloomBrushOptionsRow) bloomBrushOptionsRow.classList.toggle('hidden', !(b.bloomBrush ?? false));
        const brushSize = Math.max(1, Math.min(200, Number(b.bloomBrushSize ?? 30)));
        if (bloomBrushSizeSlider) bloomBrushSizeSlider.value = String(brushSize);
        if (bloomBrushSizeValue) bloomBrushSizeValue.textContent = String(brushSize);
    };

    const firePostEffectChanged = () => events.fire('postEffect:changed');

    if (bloomEnableOption && bloomEnableCheck) {
        const toggleBloom = () => {
            const b = ensureBloom(settings);
            b.enabled = !b.enabled;
            syncFromSettings();
            firePostEffectChanged();
        };
        bloomEnableOption.addEventListener('click', toggleBloom);
        bloomEnableCheck.addEventListener('click', toggleBloom);
    }

    if (bloomIntensitySlider && bloomIntensityValue) {
        bloomIntensitySlider.addEventListener('input', () => {
            const b = ensureBloom(settings);
            b.intensity = Math.min(0.2, Math.max(0, parseFloat(bloomIntensitySlider.value) || 0));
            bloomIntensityValue.textContent = b.intensity.toFixed(2);
            firePostEffectChanged();
        });
    }

    if (bloomBlurLevelSlider && bloomBlurLevelValue) {
        bloomBlurLevelSlider.addEventListener('input', () => {
            const b = ensureBloom(settings);
            b.blurLevel = Math.max(1, Math.min(16, parseInt(bloomBlurLevelSlider!.value, 10)));
            bloomBlurLevelValue!.textContent = String(b.blurLevel);
            firePostEffectChanged();
        });
    }

    if (bloomThresholdSlider && bloomThresholdValue) {
        bloomThresholdSlider.addEventListener('input', () => {
            const b = ensureBloom(settings);
            (b as any).threshold = Math.max(0, Math.min(5, parseFloat(bloomThresholdSlider!.value) || 0));
            bloomThresholdValue!.textContent = (b as any).threshold.toFixed(2);
            firePostEffectChanged();
        });
    }

    if (bloomDebugOption && bloomDebugCheck) {
        const toggleBloomDebug = () => {
            const b = ensureBloom(settings);
            (b as any).bloomDebug = !(b as any).bloomDebug;
            if ((b as any).bloomDebug) (b as any).bloomBrush = false;
            syncFromSettings();
            firePostEffectChanged();
        };
        bloomDebugOption.addEventListener('click', toggleBloomDebug);
        bloomDebugCheck.addEventListener('click', toggleBloomDebug);
    }

    if (bloomBrushOption && bloomBrushCheck) {
        const toggleBloomBrush = () => {
            const b = ensureBloom(settings);
            (b as any).bloomBrush = !(b as any).bloomBrush;
            if ((b as any).bloomBrush) (b as any).bloomDebug = false;
            syncFromSettings();
            firePostEffectChanged();
        };
        bloomBrushOption.addEventListener('click', toggleBloomBrush);
        bloomBrushCheck.addEventListener('click', toggleBloomBrush);
    }

    if (bloomBrushSizeSlider && bloomBrushSizeValue) {
        bloomBrushSizeSlider.addEventListener('input', () => {
            const b = ensureBloom(settings);
            (b as any).bloomBrushSize = Math.max(1, Math.min(200, parseInt(bloomBrushSizeSlider!.value, 10) || 30));
            bloomBrushSizeValue!.textContent = String((b as any).bloomBrushSize);
            firePostEffectChanged();
        });
    }

    if (bloomBrushClearBtn) {
        bloomBrushClearBtn.addEventListener('click', () => {
            events.fire('bloomBrush:clear');
            firePostEffectChanged();
        });
    }

    events.on('firstFrame', syncFromSettings);
    syncFromSettings();

    return () => {
        container.innerHTML = '';
    };
}
