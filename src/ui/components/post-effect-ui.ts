import type { Global } from '../../types';
import { updatePointLightsFromSettings } from '../../light';
import { pushEditHistory } from '../../edit-history';

const POST_EFFECT_PANEL_HTML = `
<div class="postEffectPanel">
  <div class="postEffectSectionLabel collapsible collapsed" id="bloomSectionLabel" title="Click to expand/collapse">Bloom</div>
  <div id="bloomSectionContent" class="postEffectSectionContent collapsed">
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
  <div id="bloomBrushOptionsRow" class="settingsRow hidden" style="display:flex;flex-wrap:wrap;align-items:center;gap:6px;font-size:12px;">
    <label for="bloomBrushSizeSlider" class="postEffectLabel" style="min-width:auto;">Brush:</label>
    <input type="range" id="bloomBrushSizeSlider" min="1" max="200" step="1" value="30" class="postEffectSlider" style="width:60px;">
    <span id="bloomBrushSizeValue" class="postEffectSliderValue" style="min-width:24px;">30</span>
    <button type="button" id="bloomBrushSetBtn" class="postEffectOption" style="padding:2px 6px;font-size:11px;">Set</button>
    <button type="button" id="bloomBrushClearBtn" class="postEffectOption" style="padding:2px 6px;font-size:11px;">Clear</button>
    <button type="button" id="bloomBrushResetBtn" class="postEffectOption" style="padding:2px 6px;font-size:11px;">Reset</button>
  </div>
  <div id="bloomBrushBrightnessRow" class="settingsRow hidden">
    <label for="bloomBrushBrightnessSlider" class="postEffectLabel">Dark ← 0 → Bright:</label>
    <div class="postEffectSliderWrap">
      <input type="range" id="bloomBrushBrightnessSlider" min="-1" max="1" step="0.05" value="0" class="postEffectSlider">
      <span id="bloomBrushBrightnessValue" class="postEffectSliderValue">0.00</span>
    </div>
  </div>
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
    <label for="shadowDarkenSlider" class="postEffectLabel">Darken (0=最暗 1=不压暗):</label>
    <div class="postEffectSliderWrap">
      <input type="range" id="shadowDarkenSlider" min="0" max="1" step="0.05" value="0" class="postEffectSlider">
      <span id="shadowDarkenValue" class="postEffectSliderValue">0.00</span>
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

type BloomSettings = {
    enabled: boolean;
    intensity: number;
    blurLevel: number;
    threshold: number;
    bloomDebug: boolean;
    bloomBrush: boolean;
    bloomBrushSize: number;
    /** 选中区域局部亮度 -1～1，0 不变，<0 调暗，>0 调亮；Set 时写入 bloomBrushCommittedBrightness */
    bloomBrushBrightness: number;
    /** 已提交区域亮度，与 worldSpacePoints.committed 在 shader 中每帧应用 */
    bloomBrushCommittedBrightness?: number;
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
            bloomBrushSize: 30,
            bloomBrushBrightness: 0
        };
    } else {
        if ((b as any).threshold === undefined) (b as any).threshold = 0.2;
        if ((b as any).bloomDebug === undefined) (b as any).bloomDebug = false;
        if ((b as any).bloomBrush === undefined) (b as any).bloomBrush = false;
        if ((b as any).bloomBrushSize === undefined) (b as any).bloomBrushSize = 30;
        if (typeof (b as any).bloomBrushBrightness !== 'number') (b as any).bloomBrushBrightness = 0;
        if (typeof (b as any).bloomBrushCommittedBrightness !== 'number') (b as any).bloomBrushCommittedBrightness = 0;
    }
    return settings.postEffectSettings.bloom as BloomSettings;
};

type ShadowSettings = {
    enabled: boolean;
    darken: number;
    castShadows?: boolean;
    debugVisual?: boolean;
    sphereRadius?: number;
};

const ensureShadow = (settings: Global['settings']): ShadowSettings => {
    if (!settings.postEffectSettings) (settings as any).postEffectSettings = {};
    const s = (settings.postEffectSettings as any).shadow;
    if (!s) {
        (settings.postEffectSettings as any).shadow = {
            enabled: true,
            darken: 0,
            castShadows: true,
            debugVisual: false,
            sphereRadius: 0.5
        };
    } else {
        if (typeof (s as any).darken !== 'number') (s as any).darken = 0;
        if ((s as any).castShadows === undefined) (s as any).castShadows = true;
        if ((s as any).debugVisual === undefined) (s as any).debugVisual = false;
        if (typeof (s as any).sphereRadius !== 'number') (s as any).sphereRadius = 0.5;
    }
    return (settings.postEffectSettings as any).shadow as ShadowSettings;
};

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
    const bloomBrushSetBtn = container.querySelector('#bloomBrushSetBtn') as HTMLButtonElement | null;
    const bloomBrushClearBtn = container.querySelector('#bloomBrushClearBtn') as HTMLButtonElement | null;
    const bloomBrushResetBtn = container.querySelector('#bloomBrushResetBtn') as HTMLButtonElement | null;
    const bloomBrushBrightnessRow = container.querySelector('#bloomBrushBrightnessRow') as HTMLElement | null;
    const bloomBrushBrightnessSlider = container.querySelector('#bloomBrushBrightnessSlider') as HTMLInputElement | null;
    const bloomBrushBrightnessValue = container.querySelector('#bloomBrushBrightnessValue') as HTMLElement | null;
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
        if (bloomBrushBrightnessRow) bloomBrushBrightnessRow.classList.toggle('hidden', !(b.bloomBrush ?? false));
        const brushSize = Math.max(1, Math.min(200, Number(b.bloomBrushSize ?? 30)));
        if (bloomBrushSizeSlider) bloomBrushSizeSlider.value = String(brushSize);
        if (bloomBrushSizeValue) bloomBrushSizeValue.textContent = String(brushSize);
        const brightness = Math.max(-1, Math.min(1, Number((b as any).bloomBrushBrightness ?? 0)));
        if (bloomBrushBrightnessSlider) bloomBrushBrightnessSlider.value = String(brightness);
        if (bloomBrushBrightnessValue) bloomBrushBrightnessValue.textContent = brightness.toFixed(2);
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

        // 平行光方向/强度/Bias 已移至 Lighting 面板配置
    };

    const firePostEffectChanged = () => events.fire('postEffect:changed');

    if (bloomEnableOption && bloomEnableCheck) {
        const toggleBloom = () => {
            const b = ensureBloom(settings);
            b.enabled = !b.enabled;
            syncFromSettings();
            firePostEffectChanged();
            pushEditHistorySafe();
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
        bloomIntensitySlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }

    if (bloomBlurLevelSlider && bloomBlurLevelValue) {
        bloomBlurLevelSlider.addEventListener('input', () => {
            const b = ensureBloom(settings);
            b.blurLevel = Math.max(1, Math.min(16, parseInt(bloomBlurLevelSlider!.value, 10)));
            bloomBlurLevelValue!.textContent = String(b.blurLevel);
            firePostEffectChanged();
        });
        bloomBlurLevelSlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }

    if (bloomThresholdSlider && bloomThresholdValue) {
        bloomThresholdSlider.addEventListener('input', () => {
            const b = ensureBloom(settings);
            (b as any).threshold = Math.max(0, Math.min(5, parseFloat(bloomThresholdSlider!.value) || 0));
            bloomThresholdValue!.textContent = (b as any).threshold.toFixed(2);
            firePostEffectChanged();
        });
        bloomThresholdSlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }

    if (bloomDebugOption && bloomDebugCheck) {
        const toggleBloomDebug = () => {
            const b = ensureBloom(settings);
            (b as any).bloomDebug = !(b as any).bloomDebug;
            if ((b as any).bloomDebug) (b as any).bloomBrush = false;
            syncFromSettings();
            firePostEffectChanged();
            pushEditHistorySafe();
        };
        bloomDebugOption.addEventListener('click', toggleBloomDebug);
        bloomDebugCheck.addEventListener('click', toggleBloomDebug);
    }

    if (bloomBrushOption && bloomBrushCheck) {
        const toggleBloomBrush = () => {
            const b = ensureBloom(settings);
            const wasOn = !!(b as any).bloomBrush;
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
        bloomBrushSizeSlider.addEventListener('change', () => {
            pushEditHistorySafe();
        });
    }
    if (bloomBrushBrightnessSlider && bloomBrushBrightnessValue) {
        bloomBrushBrightnessSlider.addEventListener('input', () => {
            const b = ensureBloom(settings);
            const val = parseFloat(bloomBrushBrightnessSlider!.value);
            (b as any).bloomBrushBrightness = Math.max(-1, Math.min(1, val));
            bloomBrushBrightnessValue!.textContent = (Math.max(-1, Math.min(1, val))).toFixed(2);
            firePostEffectChanged();
        });
        bloomBrushBrightnessSlider.addEventListener('change', () => {
            pushEditHistorySafe();
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

    if (bloomBrushSetBtn) {
        bloomBrushSetBtn.addEventListener('click', () => {
            events.fire('bloomBrush:set');
            firePostEffectChanged();
        });
    }

    if (bloomBrushClearBtn) {
        bloomBrushClearBtn.addEventListener('click', () => {
            events.fire('bloomBrush:clear');
            firePostEffectChanged();
        });
    }
    if (bloomBrushResetBtn) {
        bloomBrushResetBtn.addEventListener('click', () => {
            events.fire('bloomBrush:reset');
            firePostEffectChanged();
        });
    }

    if (shadowEnableOption && shadowEnableCheck) {
        const toggleShadow = () => {
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
            const sh = ensureShadow(settings);
            sh.darken = Math.max(0, Math.min(1, parseFloat(shadowDarkenSlider!.value) || 0));
            shadowDarkenValue!.textContent = sh.darken.toFixed(2);
            firePostEffectChanged();
        });
        shadowDarkenSlider.addEventListener('change', () => {
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
        container.innerHTML = '';
    };
}
