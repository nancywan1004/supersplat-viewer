import type { Global } from '../../types';
import { updatePointLightsFromSettings, setPointLightsVisualVisible } from '../../light';
import type { PointLightConfig, DirectionalLightConfig, SpotLightConfig } from '../../schemas/v2';

const LIGHTING_PANEL_HTML = `
<div class="lightingPanel">
  <div class="settingsRow">
    <label for="nightFadeSlider" class="lightingLabel">Dark ← 0 → Bright:</label>
    <div class="lightingSliderWrap">
      <input type="range" id="nightFadeSlider" min="-1" max="1" step="0.01" value="0" class="lightingSlider">
      <span id="nightFadeValue" class="lightingSliderValue">0.00</span>
    </div>
  </div>
  <div class="settingsRow">
    <div id="showLightsInSceneCheck" class="checkMark">✓</div>
    <div id="showLightsInSceneOption" class="lightingOption">Show lights in scene</div>
  </div>
  <div class="lightingSectionLabel">Lights</div>
  <div id="pointLightsList" class="pointLightsList"></div>
  <div class="settingsRow" style="flex-wrap:wrap;gap:6px;">
    <button id="addPointLight" type="button" class="settingsButton">+ Point</button>
    <button id="addSpotLight" type="button" class="settingsButton">+ Spot</button>
  </div>
</div>
`.trim();

const MAX_POINT_LIGHTS = 10;

const isDirectional = (l: PointLightConfig | DirectionalLightConfig | SpotLightConfig): l is DirectionalLightConfig =>
    (l as any).type === 'directional';
const isSpot = (l: PointLightConfig | DirectionalLightConfig | SpotLightConfig): l is SpotLightConfig =>
    (l as any).type === 'spot';

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

    const nightFadeSlider = container.querySelector('#nightFadeSlider') as HTMLInputElement | null;
    const nightFadeValue = container.querySelector('#nightFadeValue') as HTMLElement | null;
    const showLightsInSceneCheck = container.querySelector('#showLightsInSceneCheck') as HTMLElement | null;
    const showLightsInSceneOption = container.querySelector('#showLightsInSceneOption') as HTMLElement | null;
    const pointLightsList = container.querySelector('#pointLightsList') as HTMLElement | null;
    const addPointLight = container.querySelector('#addPointLight') as HTMLButtonElement | null;
    let lightsVisualVisible = !!(global.app as any).__pointLightsVisualVisible;

    const ensureLighting = (): { lights: (PointLightConfig | DirectionalLightConfig | SpotLightConfig)[] } => {
        if (!(global.settings as any).lighting) (global.settings as any).lighting = { lights: [] };
        if (!Array.isArray((global.settings as any).lighting.lights)) (global.settings as any).lighting.lights = [];
        const lighting = (global.settings as any).lighting;
        if (!lighting.lights.some((l: any) => (l as any).type === 'directional')) {
            lighting.lights.unshift({
                type: 'directional',
                position: [0, 8, 8],
                color: [1, 1, 1],
                intensity: 1.5,
                pitch: 35,
                yaw: 45,
                castShadows: true,
                enabled: true
            } as DirectionalLightConfig);
        }
        const dirIdx = lighting.lights.findIndex((l: any) => (l as any).type === 'directional');
        if (dirIdx > 0) {
            const [dir] = lighting.lights.splice(dirIdx, 1);
            lighting.lights.unshift(dir);
        }
        return lighting;
    };
    const ensureNightModeSettings = (): { fade?: number } => {
        if (!(global.settings as any).nightMode) {
            (global.settings as any).nightMode = { fade: 0 };
        }
        return (global.settings as any).nightMode;
    };
    const rgbToHex = (r: number, g: number, b: number) => {
        const to = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0');
        return '#' + to(r) + to(g) + to(b);
    };
    const hexToRgb = (hex: string): [number, number, number] => {
        const n = parseInt(hex.slice(1), 16);
        return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
    };

    // Scene brightness (Dark ← 0 → Bright), slider always active
    if (nightFadeSlider && nightFadeValue) {
        const updateSliderDisplay = (value: number) => {
            nightFadeSlider.value = value.toString();
            nightFadeValue.textContent = value.toFixed(2);
            ensureNightModeSettings();
            (global.settings as any).nightMode.fade = value;
        };
        nightFadeSlider.addEventListener('input', (e) => {
            const value = parseFloat((e.target as HTMLInputElement).value);
            updateSliderDisplay(value);
            events.fire('nightFade:set', value);
            global.app.fire('nightFade:set', value);
        });
        events.on('nightFade:changed', updateSliderDisplay);
        global.app.on('nightFade:changed', updateSliderDisplay);
        ensureNightModeSettings();
        const nmInit = (global.settings as any).nightMode;
        const initialFade = typeof nmInit.fade === 'number' && Number.isFinite(nmInit.fade)
            ? Math.max(-1, Math.min(1, nmInit.fade))
            : 0;
        updateSliderDisplay(initialFade);
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

    // Lights list: 平行光主光源（首条，不可删）+ 点光/聚光
    const renderPointLightsList = () => {
        if (!pointLightsList) return;
        const lighting = ensureLighting();
        const lights = lighting.lights;
        pointLightsList.innerHTML = '';
        let spotOrdinal = 0;
        lights.forEach((light, index) => {
            const isDir = isDirectional(light);
            const isSpotLight = isSpot(light);
            const [r, g, b] = light.color ?? [1, 1, 1];
            const intensity = typeof light.intensity === 'number' ? light.intensity : 1;
            const enabled = light.enabled !== false;
            const hex = rgbToHex(r, g, b);

            const row = document.createElement('div');
            row.className = 'pointLightRow' + (enabled ? '' : ' pointLightRow--disabled')
                + (isSpotLight ? ' pointLightRow--spot' : '')
                + (isDir ? ' pointLightRow--directional' : '');

            if (isDir) {
                const d = light as DirectionalLightConfig;
                const pitch = d.pitch ?? 35;
                const yaw = d.yaw ?? 45;
                row.innerHTML = `
                    <div class="pointLightVisual" title="主光源（不可删除）">
                        <span class="pointLightSwatch" style="background:${hex}; box-shadow:0 0 6px ${hex};"></span>
                        <span class="pointLightNum">Directional</span>
                    </div>
                    <label class="pointLightEnableWrap"><input type="checkbox" class="pointLightEnable" data-index="${index}" data-field="enabled" ${enabled ? 'checked' : ''}><span class="pointLightEnableLabel">On</span></label>
                    <span class="pointLightLabel">I</span><input type="number" step="0.1" min="0" data-index="${index}" data-field="dirIntensity" value="${intensity}" title="亮度">
                    <span class="pointLightLabel">Pitch</span><input type="number" step="1" min="-90" max="90" data-index="${index}" data-field="dirPitch" value="${pitch}">
                    <span class="pointLightLabel">Yaw</span><input type="number" step="1" min="0" max="360" data-index="${index}" data-field="dirYaw" value="${yaw}">
                `;
            } else if (isSpotLight) {
                spotOrdinal += 1;
                const s = light as SpotLightConfig;
                const [sx, sy, sz] = s.position ?? [0, 2, 0];
                const pitch = s.pitch ?? -45;
                const yaw = s.yaw ?? 0;
                const innerCone = s.innerConeAngle ?? 25;
                const outerCone = s.outerConeAngle ?? 45;
                const range = typeof s.range === 'number' ? s.range : 10;
                row.innerHTML = `
                    <div class="pointLightVisual" title="Spot ${spotOrdinal}">
                        <span class="pointLightSwatch" style="background:${hex}; box-shadow:0 0 6px ${hex};"></span>
                        <span class="pointLightNum">Spot ${spotOrdinal}</span>
                    </div>
                    <label class="pointLightEnableWrap"><input type="checkbox" class="pointLightEnable" data-index="${index}" data-field="enabled" ${enabled ? 'checked' : ''}><span class="pointLightEnableLabel">On</span></label>
                    <span class="pointLightLabel">X</span><input type="number" step="any" data-index="${index}" data-field="spPx" value="${sx}">
                    <span class="pointLightLabel">Y</span><input type="number" step="any" data-index="${index}" data-field="spPy" value="${sy}">
                    <span class="pointLightLabel">Z</span><input type="number" step="any" data-index="${index}" data-field="spPz" value="${sz}">
                    <input type="color" data-index="${index}" data-field="color" value="${hex}" title="Color">
                    <span class="pointLightLabel">I</span><input type="number" step="0.1" min="0" data-index="${index}" data-field="intensity" value="${intensity}">
                    <span class="pointLightLabel">Pitch</span><input type="number" step="1" min="-90" max="90" data-index="${index}" data-field="pitch" value="${pitch}">
                    <span class="pointLightLabel">Yaw</span><input type="number" step="1" min="0" max="360" data-index="${index}" data-field="yaw" value="${yaw}">
                    <span class="pointLightLabel" title="内锥角(°)">Inner</span><input type="number" step="1" min="0" max="90" data-index="${index}" data-field="innerConeAngle" value="${innerCone}" title="内锥角(°)">
                    <span class="pointLightLabel" title="外锥角(°)">Outer</span><input type="number" step="1" min="0" max="90" data-index="${index}" data-field="outerConeAngle" value="${outerCone}" title="外锥角(°)">
                    <span class="pointLightLabel">Range</span><input type="number" step="0.1" min="0" data-index="${index}" data-field="range" value="${range}">
                    <button type="button" class="pointLightRemove" data-index="${index}" aria-label="Remove">✕</button>
                `;
            } else {
                const p = light as PointLightConfig;
                const [x, y, z] = p.position ?? [0, 0, 0];
                row.innerHTML = `
                    <div class="pointLightVisual" title="Point ${index + 1}">
                        <span class="pointLightSwatch" style="background:${hex}; box-shadow:0 0 6px ${hex};"></span>
                        <span class="pointLightNum">Point ${index + 1}</span>
                    </div>
                    <label class="pointLightEnableWrap"><input type="checkbox" class="pointLightEnable" data-index="${index}" data-field="enabled" ${enabled ? 'checked' : ''}><span class="pointLightEnableLabel">On</span></label>
                    <span class="pointLightLabel">X</span><input type="number" step="any" data-index="${index}" data-field="px" value="${x}">
                    <span class="pointLightLabel">Y</span><input type="number" step="any" data-index="${index}" data-field="py" value="${y}">
                    <span class="pointLightLabel">Z</span><input type="number" step="any" data-index="${index}" data-field="pz" value="${z}">
                    <input type="color" data-index="${index}" data-field="color" value="${hex}" title="Color">
                    <span class="pointLightLabel">I</span><input type="number" step="0.1" min="0" data-index="${index}" data-field="intensity" value="${intensity}">
                    <button type="button" class="pointLightRemove" data-index="${index}" aria-label="Remove">✕</button>
                `;
            }
            pointLightsList.appendChild(row);
        });

        pointLightsList.querySelectorAll('input').forEach((input) => {
            input.addEventListener('change', () => {
                const idx = parseInt((input as HTMLElement).dataset.index!, 10);
                const field = (input as HTMLElement).dataset.field!;
                const lighting = ensureLighting();
                const light = lighting.lights[idx];
                if (!light) return;
                if (isDirectional(light)) {
                    const d = light as DirectionalLightConfig;
                    if (field === 'enabled') d.enabled = (input as HTMLInputElement).checked;
                    else if (field === 'dirIntensity') d.intensity = parseFloat((input as HTMLInputElement).value) || 1;
                    else if (field === 'dirPitch') d.pitch = parseFloat((input as HTMLInputElement).value) ?? 35;
                    else if (field === 'dirYaw') d.yaw = parseFloat((input as HTMLInputElement).value) ?? 45;
                    (input as HTMLElement).closest('.pointLightRow')?.classList.toggle('pointLightRow--disabled', !d.enabled);
                } else if (isSpot(light)) {
                    const s = light as SpotLightConfig;
                    if (!s.position) s.position = [0, 2, 0];
                    if (field === 'enabled') s.enabled = (input as HTMLInputElement).checked;
                    else if (field === 'spPx') s.position = [parseFloat((input as HTMLInputElement).value) || 0, s.position[1], s.position[2]];
                    else if (field === 'spPy') s.position = [s.position[0], parseFloat((input as HTMLInputElement).value) || 0, s.position[2]];
                    else if (field === 'spPz') s.position = [s.position[0], s.position[1], parseFloat((input as HTMLInputElement).value) || 0];
                    else if (field === 'color') {
                        s.color = hexToRgb((input as HTMLInputElement).value);
                        const hex = (input as HTMLInputElement).value;
                        const rowEl = (input as HTMLElement).closest('.pointLightRow');
                        const swatch = rowEl?.querySelector('.pointLightSwatch') as HTMLElement;
                        if (swatch) { swatch.style.background = hex; swatch.style.boxShadow = `0 0 6px ${hex}`; }
                    } else if (field === 'intensity') s.intensity = parseFloat((input as HTMLInputElement).value) || 1;
                    else if (field === 'pitch') s.pitch = parseFloat((input as HTMLInputElement).value) ?? -45;
                    else if (field === 'yaw') s.yaw = parseFloat((input as HTMLInputElement).value) ?? 0;
                    else if (field === 'innerConeAngle') s.innerConeAngle = parseFloat((input as HTMLInputElement).value) ?? 25;
                    else if (field === 'outerConeAngle') s.outerConeAngle = parseFloat((input as HTMLInputElement).value) ?? 45;
                    else if (field === 'range') s.range = parseFloat((input as HTMLInputElement).value) ?? 10;
                    (input as HTMLElement).closest('.pointLightRow')?.classList.toggle('pointLightRow--disabled', !s.enabled);
                } else {
                    const p = light as PointLightConfig;
                    if (field === 'px') p.position = [parseFloat((input as HTMLInputElement).value) || 0, p.position[1], p.position[2]];
                    else if (field === 'py') p.position = [p.position[0], parseFloat((input as HTMLInputElement).value) || 0, p.position[2]];
                    else if (field === 'pz') p.position = [p.position[0], p.position[1], parseFloat((input as HTMLInputElement).value) || 0];
                    else if (field === 'color') {
                        p.color = hexToRgb((input as HTMLInputElement).value);
                        const hex = (input as HTMLInputElement).value;
                        const rowEl = (input as HTMLElement).closest('.pointLightRow');
                        const swatch = rowEl?.querySelector('.pointLightSwatch') as HTMLElement;
                        if (swatch) { swatch.style.background = hex; swatch.style.boxShadow = `0 0 6px ${hex}`; }
                    } else if (field === 'intensity') p.intensity = parseFloat((input as HTMLInputElement).value) || 1;
                    else if (field === 'enabled') {
                        p.enabled = (input as HTMLInputElement).checked;
                        (input as HTMLElement).closest('.pointLightRow')?.classList.toggle('pointLightRow--disabled', !p.enabled);
                    }
                }
                updatePointLightsFromSettings(global);
                events.fire('lighting:changed');
            });
        });

        pointLightsList.querySelectorAll('.pointLightRemove').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt((btn as HTMLElement).dataset.index!, 10);
                const lighting = ensureLighting();
                const light = lighting.lights[idx];
                if (isDirectional(light)) return;
                lighting.lights.splice(idx, 1);
                renderPointLightsList();
                updatePointLightsFromSettings(global);
                events.fire('lighting:changed');
            });
        });
    };

    const addPointLightBtn = container.querySelector('#addPointLight') as HTMLButtonElement | null;
    const addSpotLightBtn = container.querySelector('#addSpotLight') as HTMLButtonElement | null;
    if (addPointLightBtn && pointLightsList) {
        addPointLightBtn.addEventListener('click', () => {
            const lighting = ensureLighting();
            const pointCount = lighting.lights.filter((l: any) => !isDirectional(l) && !isSpot(l)).length;
            if (pointCount >= MAX_POINT_LIGHTS) return;
            lighting.lights.push({ position: [0, 1, 0], color: [1, 1, 1], intensity: 1, enabled: true });
            renderPointLightsList();
            updatePointLightsFromSettings(global);
            events.fire('lighting:changed');
        });
    }
    if (addSpotLightBtn && pointLightsList) {
        addSpotLightBtn.addEventListener('click', () => {
            const lighting = ensureLighting();
            lighting.lights.push({
                type: 'spot',
                position: [0, 2, 0],
                color: [1, 1, 1],
                intensity: 1,
                pitch: -45,
                yaw: 0,
                innerConeAngle: 25,
                outerConeAngle: 45,
                range: 10,
                enabled: true
            });
            renderPointLightsList();
            updatePointLightsFromSettings(global);
            events.fire('lighting:changed');
        });
    }
    if (pointLightsList) renderPointLightsList();

    return () => {
        container.innerHTML = '';
    };
}
