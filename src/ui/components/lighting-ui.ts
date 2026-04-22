import type { Global } from '../../types';
import type { ExperienceSettings } from '../../schemas/v2';
import { spotApexToHalfDeg, updatePointLightsFromSettings } from '../../light';
import type { PointLightConfig, DirectionalLightConfig, SpotLightConfig } from '../../schemas/v2';
import { pushEditHistory } from '../../edit-history';
import { ensureNightMode, ensureLighting } from '../../settings-serialize/settings-serialize-helper';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';
import { applyEnvironmentPreviewVisualPolicy } from '../../editor-modules/environment-facade';

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

const isDirectional = (
    l: PointLightConfig | DirectionalLightConfig | SpotLightConfig | undefined | null
): l is DirectionalLightConfig =>
    !!l && (l as any).type === 'directional';
const isSpot = (
    l: PointLightConfig | DirectionalLightConfig | SpotLightConfig | undefined | null
): l is SpotLightConfig =>
    !!l && (l as any).type === 'spot';

/** 输入为存库整锥顶角（度）；在引擎半角空间约束 inner<outer 后，再写回顶角。 */
const normalizeSpotConeAngles = (inner: number, outer: number): { inner: number; outer: number } => {
    const outerH = spotApexToHalfDeg(Number.isFinite(outer) ? outer : 90);
    const innerH = spotApexToHalfDeg(Number.isFinite(inner) ? inner : 50);
    const safeOuter = Math.max(0.01, Math.min(89.9, outerH));
    const maxInner = Math.max(0, safeOuter - 1);
    const safeInner = Math.max(0, Math.min(maxInner, innerH));
    return { inner: safeInner * 2, outer: safeOuter * 2 };
};

/**
 * 初始化 Lighting 面板 UI（夜间模式、强度滑块、场景光源可视化、点光源列表）。
 * 挂载到 #lightingPanelContainer；若无容器则跳过。
 * @returns 清理函数
 */
export function initLightingUI(global: Global): () => void {
    const { events } = global;
    const editUiTransport = getEditUiTransport(global);

    const container = document.getElementById('lightingPanelContainer');
    if (!container) return () => {};

    container.innerHTML = LIGHTING_PANEL_HTML;

    // 当鼠标在 Lighting UI 上滚动时，阻止事件向下传给画布，避免触发相机缩放
    container.addEventListener('wheel', (e) => {
        e.stopPropagation();
        // 允许在列表内部滚动，但不让事件冒到 canvas 去驱动相机
    }, { passive: true });

    const nightFadeSlider = container.querySelector('#nightFadeSlider') as HTMLInputElement | null;
    const nightFadeValue = container.querySelector('#nightFadeValue') as HTMLElement | null;
    const showLightsInSceneCheck = container.querySelector('#showLightsInSceneCheck') as HTMLElement | null;
    const showLightsInSceneOption = container.querySelector('#showLightsInSceneOption') as HTMLElement | null;
    const pointLightsList = container.querySelector('#pointLightsList') as HTMLElement | null;
    const addPointLight = container.querySelector('#addPointLight') as HTMLButtonElement | null;
    let onEnvironmentLifecycle: (() => void) | null = null;
    // 环境模块内部「Show lights in scene」开关的逻辑状态；默认打开
    let lightsVisualVisible = (global.app as any).__lightsVisualToggle;
    if (lightsVisualVisible == null) {
        lightsVisualVisible = true;
        (global.app as any).__lightsVisualToggle = true;
    }

    const ensureLightingLocal = (): { lights: (PointLightConfig | DirectionalLightConfig | SpotLightConfig)[] } => {
        const lighting = ensureLighting(global.settings as ExperienceSettings);
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
        return lighting as { lights: (PointLightConfig | DirectionalLightConfig | SpotLightConfig)[] };
    };

    // 为新建光源生成一个不会与现有 light.id 冲突的 id（light-<n> 形式）
    const generateNextLightId = (): string => {
        const lighting = ensureLightingLocal();
        const existingIds = (lighting.lights as any[])
            .map((l) => (l && typeof l === 'object' ? (l as any).id as string | undefined : undefined))
            .filter((id) => typeof id === 'string') as string[];
        let maxIndex = -1;
        for (const id of existingIds) {
            const m = /^light-(\d+)$/.exec(id);
            if (m) {
                const n = parseInt(m[1], 10);
                if (Number.isFinite(n) && n > maxIndex) maxIndex = n;
            }
        }
        return `light-${maxIndex + 1}`;
    };
    const ensureNightModeSettings = (): { fade?: number } => {
        return ensureNightMode(global.settings as ExperienceSettings);
    };
    const rgbToHex = (r: number, g: number, b: number) => {
        const to = (x: number) => Math.max(0, Math.min(255, Math.round(x * 255))).toString(16).padStart(2, '0');
        return '#' + to(r) + to(g) + to(b);
    };
    const hexToRgb = (hex: string): [number, number, number] => {
        const n = parseInt(hex.slice(1), 16);
        return [((n >> 16) & 0xff) / 255, ((n >> 8) & 0xff) / 255, (n & 0xff) / 255];
    };

    const pushEditHistorySafe = () => {
        if ((global.state as any).editMode) {
            pushEditHistory(global, 'lighting');
        }
    };

    const emitLightSelect = (id: string | null, focus = false) => {
        if (editUiTransport === 'message-bridge') {
            // 本地先同步一次，避免依赖 postMessage 往返导致列表瞬态不同步
            (global.state as any).selectedLightId = id;
            global.events.fire('sceneLight:selected', { id, source: 'host' });
            sendEditProtocolMessage({ type: 'LIGHT_SELECT', id });
            return;
        }
        (global.state as any).selectedLightId = id;
        global.events.fire('sceneLight:selected', { id, source: 'host' });
        if (focus) {
            global.events.fire('inputEvent', 'frame', { focusTarget: 'light' as const });
        }
    };

    // Scene brightness (Dark ← 0 → Bright), slider always active
    if (nightFadeSlider && nightFadeValue) {
        // 仅更新滑块/数值显示，不写回 settings（用户拖滑块时才写回）
        const setSliderDisplay = (value: number) => {
            nightFadeSlider.value = value.toString();
            nightFadeValue.textContent = value.toFixed(2);
        };
        nightFadeSlider.addEventListener('input', (e) => {
            const value = parseFloat((e.target as HTMLInputElement).value);
            setSliderDisplay(value);
            ensureNightModeSettings();
            (global.settings as any).nightMode.fade = value;
            //events.fire('nightFade:set', value);
            global.app.fire('nightFade:set', value);
        });
        nightFadeSlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
        global.app.on('nightFade:changedDetailed', (payload: { value: number }) => {
            if (payload && typeof payload.value === 'number' && Number.isFinite(payload.value)) {
                setSliderDisplay(payload.value);
            }
        });
        ensureNightModeSettings();
        const nmInit = (global.settings as any).nightMode;
        const initialFade = typeof nmInit.fade === 'number' && Number.isFinite(nmInit.fade)
            ? Math.max(-1, Math.min(1, nmInit.fade))
            : 0;
        setSliderDisplay(initialFade);
        // 初始值已从 settings 读取；firstFrame 时 viewer 会 applyFromSettings 并触发 nightFade:changedDetailed，无需再 request
    }

    // Show lights in scene
    const updateLightsVisualCheck = () => {
        if (showLightsInSceneCheck) {
            showLightsInSceneCheck.classList[lightsVisualVisible ? 'remove' : 'add']('hidden');
            showLightsInSceneCheck.classList[lightsVisualVisible ? 'add' : 'remove']('active');
        }
    };
    if (showLightsInSceneCheck && showLightsInSceneOption) {
        onEnvironmentLifecycle = () => {
            applyEnvironmentPreviewVisualPolicy(global);
        };
        const toggleLightsVisual = () => {
            lightsVisualVisible = !lightsVisualVisible;
            (global.app as any).__lightsVisualToggle = lightsVisualVisible;
            applyEnvironmentPreviewVisualPolicy(global);
            updateLightsVisualCheck();
        };
        showLightsInSceneCheck.addEventListener('click', toggleLightsVisual);
        showLightsInSceneOption.addEventListener('click', toggleLightsVisual);
        // 初始化一次显隐状态（依赖当前 editMode / editLeftModule）
        applyEnvironmentPreviewVisualPolicy(global);
        updateLightsVisualCheck();
        // 模块生命周期改由 environment facade 驱动，避免多处监听重复刷新
        global.events.on('environmentFacade:enter', onEnvironmentLifecycle);
        global.events.on('environmentFacade:exit', onEnvironmentLifecycle);
        global.events.on('environmentFacade:editModeExit', onEnvironmentLifecycle);
    }

    // Lights list: 平行光主光源（首条，不可删）+ 点光/聚光
    const renderPointLightsList = () => {
        if (!pointLightsList) return;
        const lighting = ensureLightingLocal();
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
            // 记录配置索引与内部 id（若存在），用于选中与场景联动
            (row.dataset as any).index = String(index);
            const lightId = (light as any).id as string | undefined;
            if (lightId) {
                (row.dataset as any).lightId = lightId;
            }

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
                const innerCone = s.innerConeAngle ?? 50;
                const outerCone = s.outerConeAngle ?? 90;
                const range = typeof s.range === 'number' ? s.range : 1;
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
                    <span class="pointLightLabel" title="内锥整顶角(°)，0–180">Inner</span><input type="number" step="1" min="0" max="180" data-index="${index}" data-field="innerConeAngle" value="${innerCone}" title="内锥整顶角(°)">
                    <span class="pointLightLabel" title="外锥整顶角(°)，0–180">Outer</span><input type="number" step="1" min="0" max="180" data-index="${index}" data-field="outerConeAngle" value="${outerCone}" title="外锥整顶角(°)">
                    <span class="pointLightLabel">Range</span><input type="number" step="0.1" min="0" data-index="${index}" data-field="range" value="${range}">
                    <button type="button" class="pointLightRemove" data-index="${index}" aria-label="Remove">✕</button>
                `;
            } else {
                const p = light as PointLightConfig;
                const [x, y, z] = p.position ?? [0, 0, 0];
                const ptRange = typeof p.range === 'number' ? p.range : 1;
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
                    <div class="pointLightRangeRow">
                        <span class="pointLightLabel" title="影响距离（世界单位）">Range</span>
                        <div class="lightingSliderWrap pointLightRangeSliderWrap">
                            <input type="range" class="lightingSlider" min="0" max="20" step="0.1" data-index="${index}" data-field="range" value="${ptRange}">
                            <span class="lightingSliderValue pointLightRangeValue">${ptRange.toFixed(1)}</span>
                        </div>
                    </div>
                    <button type="button" class="pointLightRemove" data-index="${index}" aria-label="Remove">✕</button>
                `;
            }
            pointLightsList.appendChild(row);
        });

        pointLightsList.querySelectorAll('input[type="range"][data-field="range"]').forEach((input) => {
            input.addEventListener('input', () => {
                const idx = parseInt((input as HTMLElement).dataset.index!, 10);
                const field = (input as HTMLElement).dataset.field!;
                const lighting = ensureLightingLocal();
                const light = lighting.lights[idx];
                if (!light || isDirectional(light) || isSpot(light) || field !== 'range') return;
                const p = light as PointLightConfig;
                let v = parseFloat((input as HTMLInputElement).value);
                if (!Number.isFinite(v)) v = 1;
                v = Math.max(0, Math.min(20, v));
                (input as HTMLInputElement).value = String(v);
                p.range = v;
                const rowEl = (input as HTMLElement).closest('.pointLightRow');
                const disp = rowEl?.querySelector('.pointLightRangeValue');
                if (disp) disp.textContent = v.toFixed(1);
                updatePointLightsFromSettings(global);
                events.fire('lighting:changed');
            });
        });

        pointLightsList.querySelectorAll('input').forEach((input) => {
            const liveField = (input as HTMLElement).dataset.field;
            if (liveField === 'innerConeAngle' || liveField === 'outerConeAngle') {
                input.addEventListener('input', () => {
                    const idx = parseInt((input as HTMLElement).dataset.index!, 10);
                    const field = (input as HTMLElement).dataset.field!;
                    const lighting = ensureLightingLocal();
                    const light = lighting.lights[idx];
                    if (!light || !isSpot(light)) return;
                    const s = light as SpotLightConfig;
                    if (field === 'innerConeAngle') {
                        s.innerConeAngle = parseFloat((input as HTMLInputElement).value) ?? 50;
                    } else {
                        s.outerConeAngle = parseFloat((input as HTMLInputElement).value) ?? 90;
                    }
                    const normalized = normalizeSpotConeAngles(
                        Number(s.innerConeAngle ?? 50),
                        Number(s.outerConeAngle ?? 90)
                    );
                    s.innerConeAngle = normalized.inner;
                    s.outerConeAngle = normalized.outer;
                    const rowEl = (input as HTMLElement).closest('.pointLightRow');
                    const innerInput = rowEl?.querySelector<HTMLInputElement>('input[data-field="innerConeAngle"]');
                    const outerInput = rowEl?.querySelector<HTMLInputElement>('input[data-field="outerConeAngle"]');
                    if (innerInput) innerInput.value = String(normalized.inner);
                    if (outerInput) outerInput.value = String(normalized.outer);
                    updatePointLightsFromSettings(global);
                    events.fire('lighting:changed');
                });
            }
            input.addEventListener('change', () => {
                const idx = parseInt((input as HTMLElement).dataset.index!, 10);
                const field = (input as HTMLElement).dataset.field!;
                const lighting = ensureLightingLocal();
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
                    else if (field === 'innerConeAngle') s.innerConeAngle = parseFloat((input as HTMLInputElement).value) ?? 50;
                    else if (field === 'outerConeAngle') s.outerConeAngle = parseFloat((input as HTMLInputElement).value) ?? 90;
                    else if (field === 'range') s.range = parseFloat((input as HTMLInputElement).value) ?? 1;
                    const normalized = normalizeSpotConeAngles(
                        Number(s.innerConeAngle ?? 50),
                        Number(s.outerConeAngle ?? 90)
                    );
                    s.innerConeAngle = normalized.inner;
                    s.outerConeAngle = normalized.outer;
                    const rowEl = (input as HTMLElement).closest('.pointLightRow');
                    const innerInput = rowEl?.querySelector<HTMLInputElement>('input[data-field="innerConeAngle"]');
                    const outerInput = rowEl?.querySelector<HTMLInputElement>('input[data-field="outerConeAngle"]');
                    if (innerInput) innerInput.value = String(normalized.inner);
                    if (outerInput) outerInput.value = String(normalized.outer);
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
                    else if (field === 'range' && (input as HTMLInputElement).type === 'range') {
                        let v = parseFloat((input as HTMLInputElement).value);
                        if (!Number.isFinite(v)) v = 1;
                        v = Math.max(0, Math.min(20, v));
                        (input as HTMLInputElement).value = String(v);
                        p.range = v;
                        const rowEl = (input as HTMLElement).closest('.pointLightRow');
                        const disp = rowEl?.querySelector('.pointLightRangeValue');
                        if (disp) disp.textContent = v.toFixed(1);
                    } else if (field === 'enabled') {
                        p.enabled = (input as HTMLInputElement).checked;
                        (input as HTMLElement).closest('.pointLightRow')?.classList.toggle('pointLightRow--disabled', !p.enabled);
                    }
                }
                updatePointLightsFromSettings(global);
                events.fire('lighting:changed');
                pushEditHistorySafe();
            });
        });

        pointLightsList.querySelectorAll('.pointLightRemove').forEach((btn) => {
            btn.addEventListener('click', () => {
                const idx = parseInt((btn as HTMLElement).dataset.index!, 10);
                const lighting = ensureLightingLocal();
                const light = lighting.lights[idx];
                if (isDirectional(light)) return;
                lighting.lights.splice(idx, 1);
                renderPointLightsList();
                updatePointLightsFromSettings(global);
                events.fire('lighting:changed');
                pushEditHistorySafe();
                // 若删除的是当前选中的光源，清空选中
                const currentId = (global.state as any).selectedLightId ?? null;
                if (currentId) {
                    const removedId = (light as any).id as string | undefined;
                    if (removedId && removedId === currentId) {
                        emitLightSelect(null, false);
                    }
                }
            });
        });

        // 若当前还没有选中的光源，默认选中第一盏非 directional 光源，便于直接使用底部 Gizmo 按钮
        let currentSelectedId = (global.state as any).selectedLightId as string | null | undefined;
        if (!currentSelectedId) {
            const firstNonDirectional = lights.find((l) => !isDirectional(l));
            const firstId = firstNonDirectional ? (firstNonDirectional as any).id as string | undefined : undefined;
            if (firstId) {
                currentSelectedId = firstId;
                emitLightSelect(firstId, false);
            }
        }

        // 同步行选中样式（基于 currentSelectedId）
        pointLightsList.querySelectorAll<HTMLElement>('.pointLightRow').forEach((row) => {
            const rowId = row.dataset.lightId;
            const selected = currentSelectedId && rowId && rowId === currentSelectedId;
            row.classList.toggle('pointLightRow--selected', !!selected);
        });

        // 行点击：选中光源（列表 → 场景）
        pointLightsList.querySelectorAll<HTMLElement>('.pointLightRow').forEach((row) => {
            row.addEventListener('click', (ev) => {
                // 避免点击输入控件/删除按钮触发选中
                const target = ev.target as HTMLElement;
                if (target.closest('input') || target.closest('button')) return;
                const idx = parseInt((row.dataset.index as string) ?? '-1', 10);
                if (!Number.isFinite(idx) || idx < 0) return;
                const lighting = ensureLightingLocal();
                const light = lighting.lights[idx];
                if (!light || isDirectional(light)) return;

                const id = (light as any).id as string | undefined;
                // 光源列表点击后立即聚焦到该光源（不依赖 F 键）
                emitLightSelect(id ?? null, true);
            });
        });
    };

    const addPointLightBtn = container.querySelector('#addPointLight') as HTMLButtonElement | null;
    const addSpotLightBtn = container.querySelector('#addSpotLight') as HTMLButtonElement | null;
    if (addPointLightBtn && pointLightsList) {
        addPointLightBtn.addEventListener('click', () => {
            const lighting = ensureLightingLocal();
            const pointCount = lighting.lights.filter((l: any) => !isDirectional(l) && !isSpot(l)).length;
            if (pointCount >= MAX_POINT_LIGHTS) return;
            const nextId = generateNextLightId();
            sendEditProtocolMessage({ type: 'LIGHT_ADD', id: nextId, isThreeSixty: true });
        });
    }
    if (addSpotLightBtn && pointLightsList) {
        addSpotLightBtn.addEventListener('click', () => {
            const nextId = generateNextLightId();
            sendEditProtocolMessage({ type: 'LIGHT_ADD', id: nextId, isThreeSixty: false });
        });
    }
    if (pointLightsList) {
        renderPointLightsList();
        // 当场景光源选中变化时，同步列表高亮
        events.on('sceneLight:selected', ({ id }: { id: string | null }) => {
            if (!pointLightsList) return;
            const currentSelectedId = id;
            pointLightsList.querySelectorAll<HTMLElement>('.pointLightRow').forEach((row) => {
                const rowId = row.dataset.lightId;
                const selected = currentSelectedId && rowId && rowId === currentSelectedId;
                row.classList.toggle('pointLightRow--selected', !!selected);
            });
        });
        // 外部（如 message-bridge）直接改 state.selectedLightId 时也能初始化一次样式
        const initialId = (global.state as any).selectedLightId as string | null | undefined;
        if (initialId) {
            events.fire('sceneLight:selected', { id: initialId, source: 'host' });
        }

        // 监听 lighting:changed（包括由亮灯区域联动触发的删灯），实时重建列表
        events.on('lighting:changed', () => {
            if (!document.body.contains(pointLightsList)) return;
            renderPointLightsList();
        });

        // 底部工具栏触发的删除光源
        events.on('lighting:deleteLight', ({ id }: { id: string | null }) => {
            const lighting = ensureLightingLocal();
            const lightsAny = (lighting.lights as any[]) ?? [];
            const targetId = id ?? ((global.state as any).selectedLightId as string | null | undefined);
            if (!targetId) return;
            const idx = lightsAny.findIndex((l) => l && (l as any).id === targetId);
            if (idx < 0) return;
            const light = lightsAny[idx];
            // 不允许删除主方向光
            if (isDirectional(light)) return;
            lightsAny.splice(idx, 1);
            emitLightSelect(null, false);
            renderPointLightsList();
            updatePointLightsFromSettings(global);
            events.fire('lighting:changed');
            pushEditHistorySafe();
        });
    }

    return () => {
        if (onEnvironmentLifecycle) {
            global.events.off('environmentFacade:enter', onEnvironmentLifecycle);
            global.events.off('environmentFacade:exit', onEnvironmentLifecycle);
            global.events.off('environmentFacade:editModeExit', onEnvironmentLifecycle);
        }
        container.innerHTML = '';
    };
}
