import type { Global } from '../../types';
import { updatePointLightsFromSettings, setPointLightsVisualVisible } from '../../light';
import type { PointLightConfig } from '../../schemas/v2';

const LIGHTING_PANEL_HTML = `
<div class="lightingPanel">
  <div class="settingsRow">
    <div id="nightModeCheck" class="checkMark">✓</div>
    <div id="nightModeOption" class="lightingOption">Night Mode</div>
  </div>
  <div class="settingsRow">
    <label for="nightFadeSlider" class="lightingLabel">Intensity:</label>
    <div class="lightingSliderWrap">
      <input type="range" id="nightFadeSlider" min="0" max="1" step="0.01" value="0" class="lightingSlider" disabled>
      <span id="nightFadeValue" class="lightingSliderValue">0.00</span>
    </div>
  </div>
  <div class="settingsRow">
    <div id="showLightsInSceneCheck" class="checkMark">✓</div>
    <div id="showLightsInSceneOption" class="lightingOption">Show lights in scene</div>
  </div>
  <div class="lightingSectionLabel">Point Lights</div>
  <div id="pointLightsList" class="pointLightsList"></div>
  <div class="settingsRow">
    <button id="addPointLight" type="button" class="settingsButton">+ Add Light</button>
  </div>
</div>
`.trim();

const MAX_POINT_LIGHTS = 10;

/**
 * 初始化 Lighting 面板 UI（夜间模式、强度滑块、场景光源可视化、点光源列表）。
 * 挂载到 #lightingPanelContainer；若无容器则跳过。
 * @returns 清理函数
 */
export function initLightingUI(global: Global): () => void {
    const { events } = global;

    const container = document.getElementById('lightingPanelContainer');
    if (!container) return () => {};

    container.innerHTML = LIGHTING_PANEL_HTML;

    const nightModeCheck = container.querySelector('#nightModeCheck') as HTMLElement | null;
    const nightModeOption = container.querySelector('#nightModeOption') as HTMLElement | null;
    const nightFadeSlider = container.querySelector('#nightFadeSlider') as HTMLInputElement | null;
    const nightFadeValue = container.querySelector('#nightFadeValue') as HTMLElement | null;
    const showLightsInSceneCheck = container.querySelector('#showLightsInSceneCheck') as HTMLElement | null;
    const showLightsInSceneOption = container.querySelector('#showLightsInSceneOption') as HTMLElement | null;
    const pointLightsList = container.querySelector('#pointLightsList') as HTMLElement | null;
    const addPointLight = container.querySelector('#addPointLight') as HTMLButtonElement | null;

    let nightModeEnabled = false;
    let lightsVisualVisible = !!(global.app as any).__pointLightsVisualVisible;

    const ensureLighting = (): { lights: PointLightConfig[] } => {
        if (!(global.settings as any).lighting) (global.settings as any).lighting = { lights: [] };
        if (!Array.isArray((global.settings as any).lighting.lights)) (global.settings as any).lighting.lights = [];
        return (global.settings as any).lighting;
    };
    const rgbToHex = (r: number, g: number, b: number) => {
        const to = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0');
        return '#' + to(r) + to(g) + to(b);
    };
    const hexToRgb = (hex: string): [number, number, number] => {
        const n = parseInt(hex.slice(1), 16);
        return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
    };

    // Night Mode
    if (nightModeCheck && nightModeOption) {
        const toggleNightMode = () => {
            nightModeEnabled = !nightModeEnabled;
            nightModeCheck.classList[nightModeEnabled ? 'remove' : 'add']('hidden');
            nightModeCheck.classList[nightModeEnabled ? 'add' : 'remove']('active');
            if (nightFadeSlider) nightFadeSlider.disabled = !nightModeEnabled;
            events.fire('toggle:night-mode');
            global.app.fire('toggle:night-mode');
        };
        nightModeOption.addEventListener('click', toggleNightMode);
        nightModeCheck.addEventListener('click', toggleNightMode);
    }

    if (nightFadeSlider && nightFadeValue) {
        const updateSliderDisplay = (value: number) => {
            nightFadeSlider.value = value.toString();
            nightFadeValue.textContent = value.toFixed(2);
        };
        nightFadeSlider.addEventListener('input', (e) => {
            const value = parseFloat((e.target as HTMLInputElement).value);
            updateSliderDisplay(value);
            events.fire('nightFade:set', value);
            global.app.fire('nightFade:set', value);
        });
        events.on('nightFade:changed', updateSliderDisplay);
        global.app.on('nightFade:changed', updateSliderDisplay);
        global.app.on('nightMode:changed', (enabled: boolean) => {
            nightModeEnabled = enabled;
            if (nightModeCheck) {
                nightModeCheck.classList[enabled ? 'remove' : 'add']('hidden');
                nightModeCheck.classList[enabled ? 'add' : 'remove']('active');
            }
            if (nightFadeSlider) nightFadeSlider.disabled = !enabled;
        });
        updateSliderDisplay(0);
        setTimeout(() => global.app.fire('nightFade:request'), 100);
    }

    // Show lights in scene
    const updateLightsVisualCheck = () => {
        if (showLightsInSceneCheck) {
            showLightsInSceneCheck.classList[lightsVisualVisible ? 'remove' : 'add']('hidden');
            showLightsInSceneCheck.classList[lightsVisualVisible ? 'add' : 'remove']('active');
        }
    };
    if (showLightsInSceneCheck && showLightsInSceneOption) {
        const toggleLightsVisual = () => {
            lightsVisualVisible = !lightsVisualVisible;
            setPointLightsVisualVisible(global, lightsVisualVisible);
            updateLightsVisualCheck();
        };
        showLightsInSceneCheck.addEventListener('click', toggleLightsVisual);
        showLightsInSceneOption.addEventListener('click', toggleLightsVisual);
        updateLightsVisualCheck();
    }

    // Point lights list
    const renderPointLightsList = () => {
        if (!pointLightsList) return;
        const lighting = ensureLighting();
        const lights = lighting.lights;
        pointLightsList.innerHTML = '';
        lights.forEach((light, index) => {
            const [x, y, z] = light.position ?? [0, 0, 0];
            const [r, g, b] = light.color ?? [1, 1, 1];
            const intensity = typeof light.intensity === 'number' ? light.intensity : 1;
            const enabled = light.enabled !== false;
            const hex = rgbToHex(r, g, b);
            const row = document.createElement('div');
            row.className = 'pointLightRow' + (enabled ? '' : ' pointLightRow--disabled');
            row.innerHTML = `
                <div class="pointLightVisual" title="Light ${index + 1}">
                    <span class="pointLightSwatch" style="background:${hex}; box-shadow:0 0 6px ${hex};" aria-hidden="true"></span>
                    <span class="pointLightNum">Light ${index + 1}</span>
                </div>
                <label class="pointLightEnableWrap" title="Enable/disable light">
                    <input type="checkbox" class="pointLightEnable" data-index="${index}" data-field="enabled" ${enabled ? 'checked' : ''}>
                    <span class="pointLightEnableLabel">On</span>
                </label>
                <span class="pointLightLabel">X</span><input type="number" step="any" data-index="${index}" data-field="px" value="${x}">
                <span class="pointLightLabel">Y</span><input type="number" step="any" data-index="${index}" data-field="py" value="${y}">
                <span class="pointLightLabel">Z</span><input type="number" step="any" data-index="${index}" data-field="pz" value="${z}">
                <input type="color" data-index="${index}" data-field="color" value="${hex}" title="Color">
                <span class="pointLightLabel">I</span><input type="number" class="pointLightIntensity" step="0.1" min="0" data-index="${index}" data-field="intensity" value="${intensity}">
                <button type="button" class="pointLightRemove" data-index="${index}" aria-label="Remove">✕</button>
            `;
            pointLightsList.appendChild(row);
        });
        pointLightsList.querySelectorAll('input').forEach((input) => {
            input.addEventListener('change', () => {
                const idx = parseInt((input as HTMLElement).dataset.index!, 10);
                const field = (input as HTMLElement).dataset.field!;
                const lighting = ensureLighting();
                const light = lighting.lights[idx];
                if (!light) return;
                if (field === 'px') light.position = [parseFloat((input as HTMLInputElement).value) || 0, light.position[1], light.position[2]];
                else if (field === 'py') light.position = [light.position[0], parseFloat((input as HTMLInputElement).value) || 0, light.position[2]];
                else if (field === 'pz') light.position = [light.position[0], light.position[1], parseFloat((input as HTMLInputElement).value) || 0];
                else if (field === 'color') {
                    light.color = hexToRgb((input as HTMLInputElement).value);
                    const hex = (input as HTMLInputElement).value;
                    const row = (input as HTMLElement).closest('.pointLightRow');
                    const swatch = row?.querySelector('.pointLightSwatch') as HTMLElement;
                    if (swatch) {
                        swatch.style.background = hex;
                        swatch.style.boxShadow = `0 0 6px ${hex}`;
                    }
                } else if (field === 'intensity') light.intensity = parseFloat((input as HTMLInputElement).value) || 1;
                else if (field === 'enabled') {
                    light.enabled = (input as HTMLInputElement).checked;
                    (input as HTMLElement).closest('.pointLightRow')?.classList.toggle('pointLightRow--disabled', !light.enabled);
                }
                updatePointLightsFromSettings(global);
                events.fire('lighting:changed');
            });
        });
        pointLightsList.querySelectorAll('.pointLightRemove').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt((btn as HTMLElement).dataset.index!, 10);
                const lighting = ensureLighting();
                lighting.lights.splice(idx, 1);
                renderPointLightsList();
                updatePointLightsFromSettings(global);
                events.fire('lighting:changed');
            });
        });
    };

    if (addPointLight && pointLightsList) {
        addPointLight.addEventListener('click', () => {
            const lighting = ensureLighting();
            if (lighting.lights.length >= MAX_POINT_LIGHTS) return;
            lighting.lights.push({ position: [0, 1, 0], color: [1, 1, 1], intensity: 1, enabled: true });
            renderPointLightsList();
            updatePointLightsFromSettings(global);
            events.fire('lighting:changed');
        });
        renderPointLightsList();
    }

    return () => {
        container.innerHTML = '';
    };
}
