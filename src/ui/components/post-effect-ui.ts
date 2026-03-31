import type { Global } from '../../types';
import type { ExperienceSettings } from '../../schemas/v2';
import { updatePointLightsFromSettings } from '../../light';
import { pushEditHistory } from '../../edit-history';
import {
    ensureBloom as ensureBloomFromAdapter,
    ensureBloomEditorSession,
    ensureShadow as ensureShadowFromAdapter,
    ensureLighting as ensureLightingForLighting,
    applyShadowDirectionSet
} from '../../protocol-settings-adapter';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';

const POST_EFFECT_PANEL_HTML = `
<div class="postEffectPanel">
  <div class="postEffectSectionLabel collapsible" id="bloomSectionLabel" title="Click to expand/collapse">Bloom</div>
  <div id="bloomSectionContent" class="postEffectSectionContent">
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
      <input type="range" id="bloomBlurLevelSlider" min="0" max="10" step="1" value="4" class="postEffectSlider">
      <span id="bloomBlurLevelValue" class="postEffectSliderValue">4</span>
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
    <div id="bloomScopeCheck" class="checkMark">✓</div>
    <div id="bloomScopeOption" class="postEffectOption" title="勾选=仅局部亮灯区域管线，不勾选=全局 Bloom">仅局部亮灯区域</div>
  </div>
  <div class="settingsRow" style="align-items:center;gap:6px;">
    <span class="postEffectLabel" style="flex:1;">新建亮灯区域</span>
    <button type="button" id="bloomNewRegionBtn" class="postEffectOption" style="padding:2px 8px;font-size:14px;line-height:1;" title="新建亮灯区域">+</button>
  </div>
  <div id="bloomDrawModeBar" class="bloomDrawModeBar" style="display:none;margin-top:6px;padding:6px;background:var(--panel-bg, #2a2a2a);border-radius:4px;">
    <div class="settingsRow" style="align-items:center;gap:8px;margin-bottom:6px;">
      <span class="postEffectLabel" style="flex:1;">绘制亮灯区域</span>
      <button type="button" id="bloomDrawModeCompleteBtn" class="postEffectOption" style="padding:4px 10px;">完成</button>
      <button type="button" id="bloomDrawModeAbandonBtn" class="postEffectOption" style="padding:4px 10px;">放弃</button>
    </div>
    <div class="settingsRow" style="align-items:center;gap:6px;flex-wrap:wrap;">
      <button type="button" id="bloomDrawModeBrushBtn" class="postEffectOption" style="padding:4px 10px;" title="笔刷">笔刷</button>
      <button type="button" id="bloomDrawModeEraserBtn" class="postEffectOption" style="padding:4px 10px;" title="擦除">擦除</button>
    </div>
  </div>
  <div id="bloomLocalLightRegionsList" class="bloomRegionsList" style="margin-top:4px;"></div>
  </div>
  <div class="postEffectSectionLabel collapsible collapsed" id="shadowSectionLabel" title="Click to expand/collapse">Shadow</div>
  <div id="shadowSectionContent" class="postEffectSectionContent collapsed">
  <div class="settingsRow">
    <div id="shadowEnableCheck" class="checkMark">✓</div>
    <div id="shadowEnableOption" class="postEffectOption">Enable</div>
  </div>
  <div class="settingsRow">
    <div id="shadowCastCheck" class="checkMark">✓</div>
    <div id="shadowCastOption" class="postEffectOption">Mesh Cast Shadows (接影几何投射阴影/自阴影)</div>
  </div>
  <div class="settingsRow">
    <label for="shadowDarkenSlider" class="postEffectLabel">Darken (0=不压暗 1=最深):</label>
    <div class="postEffectSliderWrap">
      <input type="range" id="shadowDarkenSlider" min="0" max="1" step="0.05" value="0" class="postEffectSlider">
      <span id="shadowDarkenValue" class="postEffectSliderValue">0.00</span>
    </div>
  </div>
  <div class="settingsRow">
    <label for="shadowYawSlider" class="postEffectLabel">Light Yaw (°):</label>
    <div class="postEffectSliderWrap">
      <input type="range" id="shadowYawSlider" min="0" max="360" step="1" value="45" class="postEffectSlider">
      <span id="shadowYawValue" class="postEffectSliderValue">45</span>
    </div>
  </div>
  <div class="settingsRow">
    <div id="shadowDebugVisualCheck" class="checkMark">✓</div>
    <div id="shadowDebugVisualOption" class="postEffectOption">Show shadow plane (调试接影平面)</div>
  </div>
  <div class="settingsRow">
    <label for="shadowSphereRadiusSlider" class="postEffectLabel">Sphere Radius:</label>
    <div class="postEffectSliderWrap">
      <input type="range" id="shadowSphereRadiusSlider" min="0.1" max="5" step="0.1" value="0.5" class="postEffectSlider">
      <span id="shadowSphereRadiusValue" class="postEffectSliderValue">0.50</span>
    </div>
  </div>
  <div class="settingsRow">
    <button type="button" id="shadowSpawnSphereBtn" class="postEffectOption" style="flex:1;text-align:center;cursor:pointer;padding:4px 8px;">Spawn Test Sphere</button>
    <button type="button" id="shadowClearSpheresBtn" class="postEffectOption" style="flex:1;text-align:center;cursor:pointer;padding:4px 8px;">Clear Spheres</button>
  </div>
  <div class="settingsRow">
    <button type="button" id="shadowSpawnSplatBtn" class="postEffectOption" style="flex:1;text-align:center;cursor:pointer;padding:4px 8px;">Spawn Test Splat (biker)</button>
    <button type="button" id="shadowClearSplatsBtn" class="postEffectOption" style="flex:1;text-align:center;cursor:pointer;padding:4px 8px;">Clear Splats</button>
  </div>
  </div>
</div>
`.trim();

/** 世界空间 Bloom 区域 JSON，与 WorldSpaceBloomData.toJSON 兼容 */
type WorldSpaceBloomRegionJSON = {
    points: Array<{ position: [number, number, number]; radius: number; intensity: number }>;
    committed: Array<{ position: [number, number, number]; radius: number; intensity: number }>;
    committedBrightness?: number;
};

/** 局部亮灯区域（与 schemas/v2 LocalLightRegion 一致） */
type LocalLightRegion = {
    id: string;
    name: string;
    worldSpace: WorldSpaceBloomRegionJSON;
    /** 局部颜色亮度 -1～1 */
    localBrightness: number;
    /** 颜色调制（sRGB [0,1]），与 nightFade 混合原理一致 */
    tintColor?: [number, number, number];
    /** 颜色混合系数 0～1 */
    tintBlend?: number;
    /** （可选）与该局部亮灯区域绑定的光源 ID，用于删除/颜色联动 */
    linkedLightId?: string | null;
};

type BloomSettings = {
    enabled: boolean;
    intensity: number;
    blurLevel: number;
    threshold: number;
    bloomDebug: boolean;
    bloomBrushSize: number;
    bloomBrushBrightness: number;
    localLightRegions?: LocalLightRegion[];
};

const ensureBloom = (settings: Global['settings']): BloomSettings => {
    return ensureBloomFromAdapter(settings as ExperienceSettings) as BloomSettings;
};

type ShadowSettings = {
    enabled: boolean;
    darken: number;
    castShadows?: boolean;
    debugVisual?: boolean;
    sphereRadius?: number;
};

const ensureShadow = (settings: Global['settings']): ShadowSettings => {
    return ensureShadowFromAdapter(settings as ExperienceSettings) as ShadowSettings;
};

/**
 * 渲染「局部亮灯区域」列表：每个区域可展开/折叠，展开时显示局部亮度滑块。
 * 点击标题切换展开并设为当前激活区域。
 */
function renderBloomLocalLightRegionsList(
    global: Global,
    container: HTMLElement | null,
    b: BloomSettings,
    firePostEffectChanged: () => void,
    pushEditHistorySafe: () => void,
    onSelectRegion: (regionId: string | null) => void,
    editUiTransport: 'internal' | 'message-bridge',
    refreshList?: () => void
): void {
    if (!container) return;
    const ses = ensureBloomEditorSession(global.settings as ExperienceSettings);
    const regions = b.localLightRegions ?? [];
    const activeId = ses.activeLocalLightRegionId ?? null;

    container.innerHTML = '';
    for (const region of regions) {
        const item = document.createElement('div');
        item.className = 'bloomRegionItem';
        item.dataset.regionId = region.id;
        const expanded = region.id === activeId;

        const header = document.createElement('div');
        header.className = 'bloomRegionItemHeader settingsRow';
        header.style.cursor = 'pointer';
        header.style.alignItems = 'center';
        header.style.gap = '4px';
        const arrow = document.createElement('span');
        arrow.className = 'bloomRegionItemArrow';
        arrow.textContent = expanded ? '▼' : '▶';
        arrow.style.fontSize = '10px';
        const nameSpan = document.createElement('span');
        nameSpan.className = 'bloomRegionItemName postEffectOption';
        nameSpan.textContent = region.name;
        nameSpan.style.flex = '1';
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'postEffectOption bloomRegionDeleteBtn';
        deleteBtn.textContent = '×';
        deleteBtn.title = '删除该亮灯区域';
        deleteBtn.style.padding = '2px 6px';
        deleteBtn.style.fontSize = '14px';
        deleteBtn.style.cursor = 'pointer';
        header.appendChild(arrow);
        header.appendChild(nameSpan);
        header.appendChild(deleteBtn);

        deleteBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            if (editUiTransport === 'message-bridge') {
                // 走协议：由 message-bridge 统一删除并触发 listChanged 刷新
                sendEditProtocolMessage({ type: 'LIGHT_BRUSH_DELETE', id: region.id });
                return;
            }

            const list = b.localLightRegions ?? [];
            let linkedLightId: string | null = null;
            const remaining = list.filter((r) => {
                if (r && r.id === region.id) {
                    linkedLightId = (r as any).linkedLightId ?? null;
                    return false;
                }
                return !!r;
            });
            (b as any).localLightRegions = remaining;
            if (ses.activeLocalLightRegionId === region.id) {
                ses.activeLocalLightRegionId = (b as any).localLightRegions.length > 0
                    ? (b as any).localLightRegions[0].id
                    : null;
            }
            // internal 模式下：若该区域绑定了光源，则同步删除对应 light
            if (linkedLightId) {
                try {
                    const settingsAny = global.settings as ExperienceSettings;
                    const lighting = ensureLightingForLighting(settingsAny);
                    if (Array.isArray((lighting as any).lights)) {
                        const lightsAny = (lighting as any).lights as any[];
                        const idx = lightsAny.findIndex((l) => l && (l as any).id === linkedLightId);
                        if (idx >= 0) {
                            lightsAny.splice(idx, 1);
                            updatePointLightsFromSettings(global);
                            global.events.fire('lighting:changed');
                            // 若当前选中的光源就是被联动删除的那一盏，则清空选中状态
                            const currentId = (global.state as any).selectedLightId ?? null;
                            if (currentId && currentId === linkedLightId) {
                                (global.state as any).selectedLightId = null;
                                global.events.fire('sceneLight:selected', { id: null, source: 'host' });
                            }
                        }
                    }
                } catch {
                    // 若联动失败，不影响区域本身的删除
                }
            }
            pushEditHistorySafe();
            firePostEffectChanged();
            // 通知 BloomController 与其他监听方：局部亮灯区域列表发生变化
            global.events.fire('bloomLocalLightRegion:listChanged');
            if (refreshList) refreshList();
        });

        const body = document.createElement('div');
        body.className = 'bloomRegionItemBody';
        body.style.display = expanded ? 'block' : 'none';
        body.style.paddingLeft = '12px';
        body.style.marginBottom = '4px';
        const brightness = Math.max(-1, Math.min(1, region.localBrightness ?? 1));
        const tint = region.tintColor ?? [1, 1, 1];
        const tintHex = '#' + [tint[0], tint[1], tint[2]].map(x => Math.round(Math.max(0, Math.min(1, x)) * 255).toString(16).padStart(2, '0')).join('');
        const tintBlend = Math.max(0, Math.min(1, region.tintBlend ?? 0));

        // 若该区域已绑定光源，则查一次当前光源配置（用于显示强度/角度/Range）
        let linkedLightType: 'point' | 'spot' | null = null;
        let linkedLightIntensity = 1;
        let linkedInner = 25;
        let linkedOuter = 45;
        let linkedRange = 10;
        const linkedIdForUI = (region as any).linkedLightId as string | null | undefined;
        if (linkedIdForUI) {
            try {
                const lighting = ensureLightingForLighting((global as any).settings as ExperienceSettings);
                const light = (lighting as any).lights?.find?.((l: any) => l && l.id === linkedIdForUI) as any | undefined;
                if (light) {
                    linkedLightIntensity = typeof light.intensity === 'number' ? light.intensity : 1;
                    if (light.type === 'spot') {
                        linkedLightType = 'spot';
                        linkedInner = typeof light.innerConeAngle === 'number' ? light.innerConeAngle : 25;
                        linkedOuter = typeof light.outerConeAngle === 'number' ? light.outerConeAngle : 45;
                        linkedRange = typeof light.range === 'number' ? light.range : 10;
                    } else {
                        linkedLightType = 'point';
                    }
                }
            } catch {
                // 若查光源失败，不影响区域自身 UI
            }
        }

        body.innerHTML = `
          <div class="settingsRow">
            <label class="postEffectLabel">局部亮度:</label>
            <div class="postEffectSliderWrap">
              <input type="range" class="bloomRegionBrightnessSlider postEffectSlider" min="-1" max="1" step="0.05" value="${brightness}">
              <span class="bloomRegionBrightnessValue postEffectSliderValue">${brightness.toFixed(2)}</span>
            </div>
          </div>
          <div class="settingsRow">
            <label class="postEffectLabel">颜色调制:</label>
            <input type="color" class="bloomRegionTintColor postEffectOption" value="${tintHex}" title="参与混合的颜色">
          </div>
          <div class="settingsRow">
            <label class="postEffectLabel">颜色混合:</label>
            <div class="postEffectSliderWrap">
              <input type="range" class="bloomRegionTintBlendSlider postEffectSlider" min="0" max="1" step="0.05" value="${tintBlend}">
              <span class="bloomRegionTintBlendValue postEffectSliderValue">${tintBlend.toFixed(2)}</span>
            </div>
          </div>
          ${
              linkedLightType
                  ? `
          <div class="settingsRow">
            <label class="postEffectLabel">光照强度:</label>
            <div class="postEffectSliderWrap">
              <input type="range" class="bloomRegionLinkedLightIntensitySlider postEffectSlider" min="0" max="10" step="0.1" value="${linkedLightIntensity}">
              <span class="bloomRegionLinkedLightIntensityValue postEffectSliderValue">${linkedLightIntensity.toFixed(1)}</span>
            </div>
          </div>
          ${
              linkedLightType === 'spot'
                  ? `
          <div class="settingsRow">
            <label class="postEffectLabel">Inner角:</label>
            <div class="postEffectSliderWrap">
              <input type="range" class="bloomRegionLinkedLightInnerSlider postEffectSlider" min="0" max="180" step="1" value="${linkedInner}">
              <span class="bloomRegionLinkedLightInnerValue postEffectSliderValue">${linkedInner.toFixed(0)}</span>
            </div>
          </div>
          <div class="settingsRow">
            <label class="postEffectLabel">Outer角:</label>
            <div class="postEffectSliderWrap">
              <input type="range" class="bloomRegionLinkedLightOuterSlider postEffectSlider" min="0" max="180" step="1" value="${linkedOuter}">
              <span class="bloomRegionLinkedLightOuterValue postEffectSliderValue">${linkedOuter.toFixed(0)}</span>
            </div>
          </div>
          <div class="settingsRow">
            <label class="postEffectLabel">Range:</label>
            <div class="postEffectSliderWrap">
              <input type="range" class="bloomRegionLinkedLightRangeSlider postEffectSlider" min="0" max="20" step="0.1" value="${linkedRange}">
              <span class="bloomRegionLinkedLightRangeValue postEffectSliderValue">${linkedRange.toFixed(1)}</span>
            </div>
          </div>
          `
                  : ''
          }
          `
                  : ''
          }
        `;
        const brightnessSlider = body.querySelector('.bloomRegionBrightnessSlider') as HTMLInputElement;
        const brightnessValueSpan = body.querySelector('.bloomRegionBrightnessValue') as HTMLElement;
        const tintColorInput = body.querySelector('.bloomRegionTintColor') as HTMLInputElement;
        const tintBlendSlider = body.querySelector('.bloomRegionTintBlendSlider') as HTMLInputElement;
        const tintBlendValueSpan = body.querySelector('.bloomRegionTintBlendValue') as HTMLElement;
        const linkedIntensitySlider = body.querySelector('.bloomRegionLinkedLightIntensitySlider') as HTMLInputElement | null;
        const linkedIntensityValueSpan = body.querySelector('.bloomRegionLinkedLightIntensityValue') as HTMLElement | null;
        const linkedInnerSlider = body.querySelector('.bloomRegionLinkedLightInnerSlider') as HTMLInputElement | null;
        const linkedInnerValueSpan = body.querySelector('.bloomRegionLinkedLightInnerValue') as HTMLElement | null;
        const linkedOuterSlider = body.querySelector('.bloomRegionLinkedLightOuterSlider') as HTMLInputElement | null;
        const linkedOuterValueSpan = body.querySelector('.bloomRegionLinkedLightOuterValue') as HTMLElement | null;
        const linkedRangeSlider = body.querySelector('.bloomRegionLinkedLightRangeSlider') as HTMLInputElement | null;
        const linkedRangeValueSpan = body.querySelector('.bloomRegionLinkedLightRangeValue') as HTMLElement | null;

        header.addEventListener('click', (e) => {
            // 若点击的是删除按钮，由 deleteBtn 自己处理，不切换展开
            if ((e.target as Node)?.parentElement === deleteBtn || (e.target as HTMLElement) === deleteBtn) return;
            const nextActiveId = expanded ? null : region.id;
            onSelectRegion(nextActiveId);
            if (refreshList) refreshList();
        });

        if (brightnessSlider && brightnessValueSpan) {
            brightnessSlider.addEventListener('input', () => {
                const val = Math.max(-1, Math.min(1, parseFloat(brightnessSlider.value) || 0));
                region.localBrightness = val;
                brightnessValueSpan.textContent = val.toFixed(2);
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({ type: 'LIGHT_BRUSH_BLOOM_UPDATE', id: region.id, value: val });
                }
                firePostEffectChanged();
                (global.app as any).renderNextFrame = true;
            });
            brightnessSlider.addEventListener('change', () => pushEditHistorySafe());
        }
        if (tintColorInput) {
            tintColorInput.addEventListener('input', () => {
                const hex = tintColorInput.value;
                const r = parseInt(hex.slice(1, 3), 16) / 255;
                const g = parseInt(hex.slice(3, 5), 16) / 255;
                const b = parseInt(hex.slice(5, 7), 16) / 255;
                region.tintColor = [r, g, b];
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({
                        type: 'LIGHT_BRUSH_COLOR_UPDATE',
                        id: region.id,
                        value: { tintColor: [r, g, b], tintBlend: Math.max(0, Math.min(1, region.tintBlend ?? 0)) }
                    });
                } else {
                    // internal 模式下：若该区域绑定了光源，则同步更新对应 light 颜色
                    const linkedId = (region as any).linkedLightId as string | null | undefined;
                    if (linkedId) {
                        try {
                            const settingsAny = global.settings as ExperienceSettings;
                            const lighting = ensureLightingForLighting(settingsAny);
                            if (Array.isArray((lighting as any).lights)) {
                                const lightsAny = (lighting as any).lights as any[];
                                const light = lightsAny.find((l) => l && (l as any).id === linkedId);
                                if (light) {
                                    (light as any).color = [
                                        Math.max(0, Math.min(1, r)),
                                        Math.max(0, Math.min(1, g)),
                                        Math.max(0, Math.min(1, b))
                                    ];
                                    updatePointLightsFromSettings(global);
                                }
                            }
                        } catch {
                            // 若联动失败，不影响 Bloom 自身颜色调制
                        }
                    }
                }
                firePostEffectChanged();
            });
            tintColorInput.addEventListener('change', () => pushEditHistorySafe());
        }
        if (tintBlendSlider && tintBlendValueSpan) {
            tintBlendSlider.addEventListener('input', () => {
                const val = Math.max(0, Math.min(1, parseFloat(tintBlendSlider.value) || 0));
                region.tintBlend = val;
                tintBlendValueSpan.textContent = val.toFixed(2);
                if (editUiTransport === 'message-bridge') {
                    const tc = region.tintColor ?? [1, 1, 1];
                    sendEditProtocolMessage({
                        type: 'LIGHT_BRUSH_COLOR_UPDATE',
                        id: region.id,
                        value: { tintColor: [tc[0], tc[1], tc[2]], tintBlend: val }
                    });
                }
                firePostEffectChanged();
            });
            tintBlendSlider.addEventListener('change', () => pushEditHistorySafe());
        }

        // 绑定光源的调节（强度 / 角度 / Range）
        const linkedIdRuntime = linkedIdForUI;
        if (linkedIdRuntime && linkedIntensitySlider && linkedIntensityValueSpan) {
            linkedIntensitySlider.addEventListener('input', () => {
                const raw = parseFloat(linkedIntensitySlider.value);
                const v = Math.max(0, Math.min(10, Number.isFinite(raw) ? raw : 0));
                linkedIntensityValueSpan.textContent = v.toFixed(1);
                if (editUiTransport === 'message-bridge') {
                    sendEditProtocolMessage({
                        type: 'LIGHT_BRUSH_INTENSITY_UPDATE',
                        id: region.id,
                        value: v
                    });
                } else {
                    try {
                        const settingsAny = global.settings as ExperienceSettings;
                        const lighting = ensureLightingForLighting(settingsAny);
                        const lightsAny = (lighting as any).lights as any[];
                        const light = lightsAny.find((l) => l && (l as any).id === linkedIdRuntime);
                        if (light) {
                            (light as any).intensity = v;
                            updatePointLightsFromSettings(global);
                            global.events.fire('lighting:changed');
                        }
                    } catch {
                        // 忽略联动失败，不影响 UI
                    }
                }
            });
            linkedIntensitySlider.addEventListener('change', () => pushEditHistorySafe());
        }

        const attachSpotSlider = (
            slider: HTMLInputElement | null,
            valueSpan: HTMLElement | null,
            min: number,
            max: number,
            step: number,
            type: 'inner' | 'outer' | 'range'
        ) => {
            if (!slider || !valueSpan || !linkedIdRuntime) return;
            const clamp = (val: number) => Math.max(min, Math.min(max, val));
            slider.addEventListener('input', () => {
                const raw = parseFloat(slider.value);
                const v = clamp(Number.isFinite(raw) ? raw : min);
                valueSpan.textContent = type === 'range' ? v.toFixed(1) : v.toFixed(0);
                if (editUiTransport === 'message-bridge') {
                    const msgType =
                        type === 'inner'
                            ? 'LIGHT_BRUSH_INNER_ANGLE_SET'
                            : type === 'outer'
                            ? 'LIGHT_BRUSH_OUTER_ANGLE_SET'
                            : 'LIGHT_BRUSH_RANGE_SET';
                    sendEditProtocolMessage({
                        type: msgType as any,
                        id: region.id,
                        value: v
                    });
                } else {
                    try {
                        const settingsAny = global.settings as ExperienceSettings;
                        const lighting = ensureLightingForLighting(settingsAny);
                        const lightsAny = (lighting as any).lights as any[];
                        const light = lightsAny.find(
                            (l) => l && (l as any).id === linkedIdRuntime && (l as any).type === 'spot'
                        );
                        if (light) {
                            if (type === 'inner') (light as any).innerConeAngle = v;
                            else if (type === 'outer') (light as any).outerConeAngle = v;
                            else (light as any).range = v;
                            updatePointLightsFromSettings(global);
                            global.events.fire('lighting:changed');
                        }
                    } catch {
                        // 忽略联动失败，不影响 UI
                    }
                }
            });
            slider.addEventListener('change', () => pushEditHistorySafe());
        };

        attachSpotSlider(linkedInnerSlider, linkedInnerValueSpan, 0, 180, 1, 'inner');
        attachSpotSlider(linkedOuterSlider, linkedOuterValueSpan, 0, 180, 1, 'outer');
        attachSpotSlider(linkedRangeSlider, linkedRangeValueSpan, 0, 20, 0.1, 'range');

        item.appendChild(header);
        item.appendChild(body);
        container.appendChild(item);
    }
}

/**
 * 初始化 Post Effect 面板 UI（Bloom、Shadow：Enable / Darken）。
 * 挂载到 #postEffectPanelContainer；若无容器则跳过。
 * @returns 清理函数
 */
export function initPostEffectUI(global: Global): () => void {
    const { settings, events } = global;

    const container = document.getElementById('postEffectPanelContainer');
    if (!container) return () => {};

    container.innerHTML = POST_EFFECT_PANEL_HTML;

    // 当鼠标在 PostEffect UI 上滚动时，阻止事件向下传给画布，避免触发相机缩放
    container.addEventListener('wheel', (e) => {
        e.stopPropagation();
    }, { passive: true });

    const bloomIntensitySlider = container.querySelector('#bloomIntensitySlider') as HTMLInputElement | null;
    const bloomIntensityValue = container.querySelector('#bloomIntensityValue') as HTMLElement | null;
    const bloomBlurLevelSlider = container.querySelector('#bloomBlurLevelSlider') as HTMLInputElement | null;
    const bloomBlurLevelValue = container.querySelector('#bloomBlurLevelValue') as HTMLElement | null;
    const bloomThresholdSlider = container.querySelector('#bloomThresholdSlider') as HTMLInputElement | null;
    const bloomThresholdValue = container.querySelector('#bloomThresholdValue') as HTMLElement | null;
    const bloomDebugCheck = container.querySelector('#bloomDebugCheck') as HTMLElement | null;
    const bloomDebugOption = container.querySelector('#bloomDebugOption') as HTMLElement | null;
    const bloomScopeCheck = container.querySelector('#bloomScopeCheck') as HTMLElement | null;
    const bloomScopeOption = container.querySelector('#bloomScopeOption') as HTMLElement | null;
    const bloomNewRegionBtn = container.querySelector('#bloomNewRegionBtn') as HTMLButtonElement | null;
    const bloomDrawModeBar = container.querySelector('#bloomDrawModeBar') as HTMLElement | null;
    const bloomDrawModeCompleteBtn = container.querySelector('#bloomDrawModeCompleteBtn') as HTMLButtonElement | null;
    const bloomDrawModeAbandonBtn = container.querySelector('#bloomDrawModeAbandonBtn') as HTMLButtonElement | null;
    const bloomDrawModeBrushBtn = container.querySelector('#bloomDrawModeBrushBtn') as HTMLButtonElement | null;
    const bloomDrawModeEraserBtn = container.querySelector('#bloomDrawModeEraserBtn') as HTMLButtonElement | null;
    const bloomLocalLightRegionsList = container.querySelector('#bloomLocalLightRegionsList') as HTMLElement | null;
    const bloomSectionLabel = container.querySelector('#bloomSectionLabel') as HTMLElement | null;
    const bloomSectionContent = container.querySelector('#bloomSectionContent') as HTMLElement | null;
    const shadowSectionLabel = container.querySelector('#shadowSectionLabel') as HTMLElement | null;
    const shadowSectionContent = container.querySelector('#shadowSectionContent') as HTMLElement | null;
    const shadowEnableCheck = container.querySelector('#shadowEnableCheck') as HTMLElement | null;
    const shadowEnableOption = container.querySelector('#shadowEnableOption') as HTMLElement | null;
    const shadowCastCheck = container.querySelector('#shadowCastCheck') as HTMLElement | null;
    const shadowCastOption = container.querySelector('#shadowCastOption') as HTMLElement | null;
    const shadowDarkenSlider = container.querySelector('#shadowDarkenSlider') as HTMLInputElement | null;
    const shadowDarkenValue = container.querySelector('#shadowDarkenValue') as HTMLElement | null;
    const shadowYawSlider = container.querySelector('#shadowYawSlider') as HTMLInputElement | null;
    const shadowYawValue = container.querySelector('#shadowYawValue') as HTMLElement | null;
    const shadowDebugVisualCheck = container.querySelector('#shadowDebugVisualCheck') as HTMLElement | null;
    const shadowDebugVisualOption = container.querySelector('#shadowDebugVisualOption') as HTMLElement | null;
    const shadowSphereRadiusSlider = container.querySelector('#shadowSphereRadiusSlider') as HTMLInputElement | null;
    const shadowSphereRadiusValue = container.querySelector('#shadowSphereRadiusValue') as HTMLElement | null;
    const shadowSpawnSphereBtn = container.querySelector('#shadowSpawnSphereBtn') as HTMLButtonElement | null;
    const shadowClearSpheresBtn = container.querySelector('#shadowClearSpheresBtn') as HTMLButtonElement | null;
    const shadowSpawnSplatBtn = container.querySelector('#shadowSpawnSplatBtn') as HTMLButtonElement | null;
    const shadowClearSplatsBtn = container.querySelector('#shadowClearSplatsBtn') as HTMLButtonElement | null;

    const pushEditHistorySafe = () => {
        if ((global.state as any).editMode) {
            pushEditHistory(global, 'postEffect');
        }
    };

    /** 当前正在新建的草稿 ID，非空表示处于绘制模式 */
    let currentDraftId: string | null = null;

    const setDrawModeVisible = (visible: boolean) => {
        if (bloomDrawModeBar) bloomDrawModeBar.style.display = visible ? 'block' : 'none';
    };

    const setDrawModeButtonsState = (hasPoints: boolean) => {
        if (bloomDrawModeEraserBtn) bloomDrawModeEraserBtn.disabled = !hasPoints;
    };

    type DrawTool = 'brush' | 'eraser';
    const setDrawToolActive = (tool: DrawTool) => {
        if (bloomDrawModeBrushBtn) bloomDrawModeBrushBtn.classList.toggle('active', tool === 'brush');
        if (bloomDrawModeEraserBtn) bloomDrawModeEraserBtn.classList.toggle('active', tool === 'eraser');
    };

    const syncFromSettings = () => {
        const b = ensureBloom(settings);
        b.enabled = Number(b.intensity) > 0;
        const intensity = Math.min(0.2, Math.max(0, Number(b.intensity)));
        if (bloomIntensitySlider) bloomIntensitySlider.value = String(intensity);
        if (bloomIntensityValue) bloomIntensityValue.textContent = intensity.toFixed(2);
        if (bloomBlurLevelSlider) bloomBlurLevelSlider.value = String(b.blurLevel);
        if (bloomBlurLevelValue) bloomBlurLevelValue.textContent = String(b.blurLevel);
        const th = Math.max(0, Math.min(5, Number(b.threshold ?? 0.2)));
        if (bloomThresholdSlider) bloomThresholdSlider.value = String(th);
        if (bloomThresholdValue) bloomThresholdValue.textContent = th.toFixed(2);
        if (bloomDebugCheck) bloomDebugCheck.classList.toggle('active', b.bloomDebug ?? false);
        const scope = (b as { bloomScope?: 'global' | 'local' }).bloomScope;
        if (bloomScopeCheck) bloomScopeCheck.classList.toggle('active', scope !== 'global');
        refreshRegionList();
        const activeId = ensureBloomEditorSession(settings as ExperienceSettings).activeLocalLightRegionId ?? null;
        currentDraftId = (typeof activeId === 'string' && activeId.startsWith('draft-')) ? activeId : null;
        if (bloomDrawModeBar) bloomDrawModeBar.style.display = currentDraftId ? 'block' : 'none';
        const sh = ensureShadow(settings);
        if (shadowEnableCheck) shadowEnableCheck.classList.toggle('active', sh.enabled);
        if (shadowCastCheck) shadowCastCheck.classList.toggle('active', sh.castShadows !== false);
        const darken = Math.max(0, Math.min(1, Number(sh.darken ?? 0)));
        if (shadowDarkenSlider) shadowDarkenSlider.value = String(darken);
        if (shadowDarkenValue) shadowDarkenValue.textContent = darken.toFixed(2);
        if (shadowDebugVisualCheck) shadowDebugVisualCheck.classList.toggle('active', sh.debugVisual !== false);
        const sphereRadius = Math.max(0.1, Math.min(5, Number(sh.sphereRadius ?? 0.5)));
        if (shadowSphereRadiusSlider) shadowSphereRadiusSlider.value = String(sphereRadius);
        if (shadowSphereRadiusValue) shadowSphereRadiusValue.textContent = sphereRadius.toFixed(2);

        const yaw = Math.max(0, Math.min(360, Number((sh as any).lightYaw ?? 45)));
        if (shadowYawSlider) shadowYawSlider.value = String(yaw);
        if (shadowYawValue) shadowYawValue.textContent = yaw.toFixed(0);

        // 平行光方向/强度/Bias 已移至 Lighting 面板配置
    };

    const firePostEffectChanged = () => events.fire('postEffect:changed');
    const editUiTransport = getEditUiTransport(global);
    const onSelectRegion = (regionId: string | null) => {
        if (currentDraftId) return;
        ensureBloomEditorSession(settings as ExperienceSettings).activeLocalLightRegionId = regionId;
        firePostEffectChanged();
    };
    const refreshRegionList = () =>
        renderBloomLocalLightRegionsList(
            global,
            bloomLocalLightRegionsList,
            ensureBloom(settings),
            firePostEffectChanged,
            pushEditHistorySafe,
            onSelectRegion,
            editUiTransport,
            refreshRegionList
        );
    const dispatchLightBrushMessage = (type: string, payload?: Record<string, unknown>) => {
        if (editUiTransport === 'message-bridge') {
            sendEditProtocolMessage(payload ? { type, ...payload } as any : { type } as any);
        } else {
            (events as any).fire('messageBridge:lightBrush', { type, payload: payload ?? {} });
        }
    };

    if (bloomIntensitySlider && bloomIntensityValue) {
        bloomIntensitySlider.addEventListener('input', () => {
            const raw = parseFloat(bloomIntensitySlider.value) || 0;
            const value = Math.min(0.2, Math.max(0, raw));
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'BLOOM_INTENSITY_UPDATE', value });
            } else {
                const b = ensureBloom(settings);
                b.intensity = value;
                b.enabled = value > 0;
                firePostEffectChanged();
            }
            bloomIntensityValue.textContent = value.toFixed(2);
        });
        bloomIntensitySlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }

    if (bloomBlurLevelSlider && bloomBlurLevelValue) {
        bloomBlurLevelSlider.addEventListener('input', () => {
            const val = Math.max(0, Math.min(10, parseInt(bloomBlurLevelSlider!.value, 10)));
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'BLOOM_BLUR_SET', value: val });
            } else {
                const b = ensureBloom(settings);
                b.blurLevel = val;
                b.enabled = val > 0 && Number(b.intensity) > 0;
                firePostEffectChanged();
            }
            bloomBlurLevelValue!.textContent = String(val);
        });
        bloomBlurLevelSlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }

    if (bloomThresholdSlider && bloomThresholdValue) {
        bloomThresholdSlider.addEventListener('input', () => {
            const value = Math.max(0, Math.min(5, parseFloat(bloomThresholdSlider!.value) || 0));
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'BLOOM_THRESHOLD_UPDATE', value });
            } else {
                const b = ensureBloom(settings);
                (b as any).threshold = value;
                firePostEffectChanged();
            }
            bloomThresholdValue!.textContent = value.toFixed(2);
        });
        bloomThresholdSlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }

    if (bloomDebugOption && bloomDebugCheck) {
        const toggleBloomDebug = () => {
            const b = ensureBloom(settings);
            (b as any).bloomDebug = !(b as any).bloomDebug;
            if ((b as any).bloomDebug) ensureBloomEditorSession(settings as ExperienceSettings).bloomBrush = false;
            syncFromSettings();
            firePostEffectChanged();
            pushEditHistorySafe();
        };
        bloomDebugOption.addEventListener('click', toggleBloomDebug);
        bloomDebugCheck.addEventListener('click', toggleBloomDebug);
    }

    if (bloomScopeOption && bloomScopeCheck) {
        const toggleBloomScope = () => {
            const b = ensureBloom(settings) as { bloomScope?: 'global' | 'local' };
            const nextIsLocal = !(b.bloomScope === 'local');
            if (editUiTransport === 'message-bridge') {
                // 父级托管模式：由父级通过 BLOOM_IS_LOCAL_SET 驱动 Viewer
                (global as any).postMessage?.({ type: 'BLOOM_IS_LOCAL_SET', value: nextIsLocal });
            } else {
                b.bloomScope = nextIsLocal ? 'local' : 'global';
                syncFromSettings();
                firePostEffectChanged();
                pushEditHistorySafe();
            }
        };
        bloomScopeOption.addEventListener('click', toggleBloomScope);
        bloomScopeCheck.addEventListener('click', toggleBloomScope);
    }

    if (bloomNewRegionBtn) {
        bloomNewRegionBtn.addEventListener('click', () => {
            if (currentDraftId) return;
            dispatchLightBrushMessage('LIGHT_BRUSH_START');
            setDrawModeVisible(true);
            setDrawModeButtonsState(false);
            setDrawToolActive('brush');
            firePostEffectChanged();
        });
    }

    const worldSpaceChangedHandler = (data: { hasPoints?: boolean }) => {
        if (currentDraftId) setDrawModeButtonsState(!!(data as any).hasPoints);
    };
    events.on('bloomLocalLightRegion:worldSpaceChanged', worldSpaceChangedHandler);

    // 仅在区域列表结构变化（增删区域、外部协议操作）时重建列表 DOM，
    // 不监听 postEffect:changed（slider input 也会 fire 该事件，
    // 若在 handler 里 innerHTML='' 重建列表则 slider 被销毁、拖动失效）。
    const regionListChangedHandler = () => {
        refreshRegionList();
        const activeId2 = ensureBloomEditorSession(settings as ExperienceSettings).activeLocalLightRegionId ?? null;
        currentDraftId = (typeof activeId2 === 'string' && activeId2.startsWith('draft-')) ? activeId2 : null;
        setDrawModeVisible(!!currentDraftId);
        if (!currentDraftId) setDrawModeButtonsState(false);
    };
    events.on('bloomLocalLightRegion:listChanged', regionListChangedHandler);

    if (bloomDrawModeCompleteBtn) {
        bloomDrawModeCompleteBtn.addEventListener('click', () => {
            if (!currentDraftId) return;
            dispatchLightBrushMessage('LIGHT_BRUSH_FINISH');
            pushEditHistorySafe();
            firePostEffectChanged();
        });
    }

    if (bloomDrawModeAbandonBtn) {
        bloomDrawModeAbandonBtn.addEventListener('click', () => {
            if (!currentDraftId) return;
            dispatchLightBrushMessage('LIGHT_BRUSH_CLEAR');
            pushEditHistorySafe();
            firePostEffectChanged();
        });
    }

    if (bloomDrawModeBrushBtn) {
        bloomDrawModeBrushBtn.addEventListener('click', () => {
            setDrawToolActive('brush');
            dispatchLightBrushMessage('LIGHT_BRUSH_START');
            firePostEffectChanged();
        });
    }

    if (bloomDrawModeEraserBtn) {
        bloomDrawModeEraserBtn.addEventListener('click', () => {
            setDrawToolActive('eraser');
            dispatchLightBrushMessage('LIGHT_ERASER_START');
            firePostEffectChanged();
        });
    }

    if (bloomSectionLabel && bloomSectionContent) {
        bloomSectionLabel.addEventListener('click', () => {
            bloomSectionContent.classList.toggle('collapsed');
            bloomSectionLabel.classList.toggle('collapsed', bloomSectionContent.classList.contains('collapsed'));
        });
    }
    if (shadowSectionLabel && shadowSectionContent) {
        shadowSectionLabel.addEventListener('click', () => {
            shadowSectionContent.classList.toggle('collapsed');
            shadowSectionLabel.classList.toggle('collapsed', shadowSectionContent.classList.contains('collapsed'));
        });
    }

    if (shadowEnableOption && shadowEnableCheck) {
        const toggleShadow = () => {
            const editUiTransport = getEditUiTransport(global);
            if (editUiTransport === 'message-bridge') {
                const sh = ensureShadow(settings);
                const nextEnabled = !sh.enabled;
                sendEditProtocolMessage({ type: 'SHADOW_SET', value: nextEnabled });
                // 立即本地更新样式，避免父级尚未回写 settings 时勾选状态不变的错觉
                shadowEnableCheck.classList.toggle('active', nextEnabled);
                return;
            }
            const sh = ensureShadow(settings);
            sh.enabled = !sh.enabled;
            syncFromSettings();
            updatePointLightsFromSettings(global);
            firePostEffectChanged();
            pushEditHistorySafe();
        };
        shadowEnableOption.addEventListener('click', toggleShadow);
        shadowEnableCheck.addEventListener('click', toggleShadow);
    }

    if (shadowCastOption && shadowCastCheck) {
        const toggleCast = () => {
            const sh = ensureShadow(settings);
            sh.castShadows = !sh.castShadows;
            syncFromSettings();
            firePostEffectChanged();
            pushEditHistorySafe();
        };
        shadowCastOption.addEventListener('click', toggleCast);
        shadowCastCheck.addEventListener('click', toggleCast);
    }

    if (shadowDarkenSlider && shadowDarkenValue) {
        shadowDarkenSlider.addEventListener('input', () => {
            const raw = parseFloat(shadowDarkenSlider!.value) || 0;
            const v = Math.max(0, Math.min(1, raw));
            const editUiTransport = getEditUiTransport(global);
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'SHADOW_INTENSITY_UPDATE', value: v });
            } else {
                const sh = ensureShadow(settings);
                sh.darken = v;
                firePostEffectChanged();
            }
            shadowDarkenValue!.textContent = v.toFixed(2);
        });
        shadowDarkenSlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }

    if (shadowYawSlider && shadowYawValue) {
        shadowYawSlider.addEventListener('input', () => {
            const raw = parseFloat(shadowYawSlider.value) || 0;
            const v = Math.max(0, Math.min(360, raw));
            const editUiTransport = getEditUiTransport(global);
            if (editUiTransport === 'message-bridge') {
                sendEditProtocolMessage({ type: 'SHADOW_DIRECTION_SET', value: v });
            } else {
                applyShadowDirectionSet(global, v);
            }
            shadowYawValue.textContent = v.toFixed(0);
        });
        shadowYawSlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }

    if (shadowDebugVisualOption && shadowDebugVisualCheck) {
        const toggleDebugVisual = () => {
            const sh = ensureShadow(settings);
            (sh as any).debugVisual = (sh as any).debugVisual === false;
            syncFromSettings();
            firePostEffectChanged();
            pushEditHistorySafe();
        };
        shadowDebugVisualOption.addEventListener('click', toggleDebugVisual);
        shadowDebugVisualCheck.addEventListener('click', toggleDebugVisual);
    }

    if (shadowSphereRadiusSlider && shadowSphereRadiusValue) {
        shadowSphereRadiusSlider.addEventListener('input', () => {
            const sh = ensureShadow(settings);
            sh.sphereRadius = Math.max(0.1, Math.min(5, parseFloat(shadowSphereRadiusSlider.value) || 0.5));
            shadowSphereRadiusValue.textContent = sh.sphereRadius.toFixed(2);
            firePostEffectChanged();
        });
        shadowSphereRadiusSlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }

    if (shadowSpawnSphereBtn) {
        shadowSpawnSphereBtn.addEventListener('click', () => {
            const sh = ensureShadow(settings);
            const radius = sh.sphereRadius ?? 0.5;
            // 获取当前相机位置和前方方向，在相机前方一定距离处生成球体
            const cam = global.camera;
            if (cam) {
                const pos = cam.getPosition();
                const fwd = cam.forward;
                const spawnDist = radius * 6;   // 在相机前方生成
                events.fire('shadow:spawnSphere', {
                    x: pos.x + fwd.x * spawnDist,
                    y: pos.y + fwd.y * spawnDist,
                    z: pos.z + fwd.z * spawnDist,
                    radius
                });
            }
            firePostEffectChanged();
        });
    }

    if (shadowClearSpheresBtn) {
        shadowClearSpheresBtn.addEventListener('click', () => {
            events.fire('shadow:clearSpheres');
            firePostEffectChanged();
        });
    }

    if (shadowSpawnSplatBtn) {
        shadowSpawnSplatBtn.addEventListener('click', () => {
            const cam = global.camera;
            if (cam) {
                const pos = cam.getPosition();
                const fwd = cam.forward;
                const spawnDist = 3;
                events.fire('shadow:spawnSplat', {
                    url: '/assets/gsplat/biker.sog',
                    x: pos.x + fwd.x * spawnDist,
                    y: pos.y + fwd.y * spawnDist,
                    z: pos.z + fwd.z * spawnDist
                });
            }
            firePostEffectChanged();
        });
    }

    if (shadowClearSplatsBtn) {
        shadowClearSplatsBtn.addEventListener('click', () => {
            events.fire('shadow:clearSplats');
            firePostEffectChanged();
        });
    }

    events.on('firstFrame', syncFromSettings);
    syncFromSettings();

    return () => {
        events.off('bloomLocalLightRegion:worldSpaceChanged', worldSpaceChangedHandler);
        events.off('bloomLocalLightRegion:listChanged', regionListChangedHandler);
        container.innerHTML = '';
    };
}
