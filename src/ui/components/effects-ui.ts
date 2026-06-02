import type { Global, PersistentEffectType, RevealEffectType } from '../../types';
import { PERSISTENT_EFFECT_TYPE_VALUES, REVEAL_EFFECT_TYPE_VALUES } from '../../types';
import { pushEditHistory } from '../../edit-history';
import { DEFAULT_VFX_TOTAL_DURATION } from '../../schemas/v2-custom';
import { SCENE_GSPLAT_REVEAL_EFFECT_ID } from '../../vfx/effects-runtime/effects-runtime';
import { persistentEffectIdForBucket, persistentEffectBucketForType } from '../../vfx/effects-runtime/effect-types';
import {
    getRevealTotalDuration,
    readRevealParams,
    getRevealStatus,
    getRevealActiveType,
    readPersistentSettingsPack
} from '../../settings-serialize/effects-sync';
import { isPersistentVfx } from '../../vfx/effects-runtime/reveal/reveal-policy';
import {
    DEFAULT_PALETTE_PIXEL_SETTINGS,
    PALETTE_PIXEL_SIZE_STEPS
} from '../../vfx/stylisation/palette-pixel';
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
        <option value="nostalgic-comic">Nostalgic Comic</option>
        <option value="yiyun-dianran">意韵点染</option>
        <option value="palette-pixel">像素色板</option>
      </select>
    </div>
    <div id="persistentPetalsControls" class="hidden" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
      <div class="settingsRow">
        <label for="petalsTextureUrl">Petal Texture:</label>
        <input type="text" id="petalsTextureUrl" class="settingsInput" value="/textures/petal-atlas.png">
      </div>
      <div class="settingsRow">
        <label for="petalsDensity">Petal Density:</label>
        <input type="number" id="petalsDensity" class="settingsInput" min="0.05" max="2" step="0.05" value="1">
      </div>
      <div class="settingsRow">
        <label>Petal Box XYZ:</label>
        <input type="number" id="petalsExtentX" class="settingsInput" min="1" max="120" step="1" value="36" style="width:64px">
        <input type="number" id="petalsExtentY" class="settingsInput" min="1" max="120" step="1" value="24" style="width:64px">
        <input type="number" id="petalsExtentZ" class="settingsInput" min="1" max="120" step="1" value="72" style="width:64px">
      </div>
    </div>
    <div id="persistentWeatherControls" class="hidden" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
      <div class="settingsRow">
        <label for="weatherDensity">Density:</label>
        <input type="range" id="weatherDensity" class="settingsInput" min="0.1" max="4" step="0.1" value="1.5">
        <span id="weatherDensityValue" class="settingsValue">1.5</span>
      </div>
      <div class="settingsRow">
        <label for="weatherSpeed">Speed:</label>
        <input type="range" id="weatherSpeed" class="settingsInput" min="0" max="30" step="0.1" value="2">
        <span id="weatherSpeedValue" class="settingsValue">2.0</span>
      </div>
      <div class="settingsRow">
        <label for="weatherOpacity">Opacity:</label>
        <input type="range" id="weatherOpacity" class="settingsInput" min="0" max="1" step="0.01" value="0.85">
        <span id="weatherOpacityValue" class="settingsValue">0.85</span>
      </div>
      <div class="settingsRow">
        <label for="weatherGlobalOpacity">Global Opacity:</label>
        <input type="range" id="weatherGlobalOpacity" class="settingsInput" min="0" max="1" step="0.01" value="1">
        <span id="weatherGlobalOpacityValue" class="settingsValue">1.00</span>
      </div>
      <div class="settingsRow">
        <label for="weatherFarOpacity">Far Opacity:</label>
        <input type="range" id="weatherFarOpacity" class="settingsInput" min="0" max="1" step="0.01" value="0.4">
        <span id="weatherFarOpacityValue" class="settingsValue">0.40</span>
      </div>
      <div class="settingsRow">
        <label for="weatherDrift">Drift:</label>
        <input type="range" id="weatherDrift" class="settingsInput" min="0" max="2" step="0.01" value="0.4">
        <span id="weatherDriftValue" class="settingsValue">0.40</span>
      </div>
      <div class="settingsRow">
        <label>Weather Box XYZ:</label>
        <input type="number" id="weatherExtentX" class="settingsInput" min="1" max="80" step="1" value="12" style="width:64px">
        <input type="number" id="weatherExtentY" class="settingsInput" min="1" max="80" step="1" value="12" style="width:64px">
        <input type="number" id="weatherExtentZ" class="settingsInput" min="1" max="80" step="1" value="24" style="width:64px">
      </div>
      <div class="settingsRow">
        <label>Size Min/Max:</label>
        <input type="number" id="weatherMinSize" class="settingsInput" min="0.001" max="0.1" step="0.001" value="0.006" style="width:72px">
        <input type="number" id="weatherMaxSize" class="settingsInput" min="0.001" max="0.1" step="0.001" value="0.012" style="width:72px">
      </div>
      <div class="settingsRow">
        <label for="weatherElongate">Elongate:</label>
        <input type="range" id="weatherElongate" class="settingsInput" min="1" max="30" step="0.1" value="1">
        <span id="weatherElongateValue" class="settingsValue">1.0</span>
      </div>
      <div class="settingsRow hidden" id="weatherAngleRow">
        <label for="weatherAngle" title="雨丝倾斜角度（天气盒绕局部 X 轴旋转，单位：度）">Angle:</label>
        <input type="range" id="weatherAngle" class="settingsInput" min="-75" max="75" step="1" value="0">
        <span id="weatherAngleValue" class="settingsValue">0</span>
      </div>
      <div class="settingsRow">
        <label for="weatherFogDensity">Fog Density:</label>
        <input type="range" id="weatherFogDensity" class="settingsInput" min="0" max="0.05" step="0.0005" value="0.03">
        <span id="weatherFogDensityValue" class="settingsValue">0.0300</span>
      </div>
      <div class="settingsRow">
        <label for="weatherExposure">Exposure:</label>
        <input type="range" id="weatherExposure" class="settingsInput" min="0" max="1.5" step="0.01" value="0.8">
        <span id="weatherExposureValue" class="settingsValue">0.80</span>
      </div>
      <div class="settingsRow">
        <label for="weatherUseFog">Use Fog:</label>
        <input type="checkbox" id="weatherUseFog" class="settingsCheckbox" checked>
      </div>
      <div class="settingsRow">
        <label for="weatherBgColor">Camera BG:</label>
        <input type="color" id="weatherBgColor" class="settingsInput" value="#99a6bf">
      </div>
      <div class="settingsRow">
        <label for="weatherUseCameraClearColor">Use BG Color:</label>
        <input type="checkbox" id="weatherUseCameraClearColor" class="settingsCheckbox" checked>
      </div>
    </div>
    <div id="persistentYiyunDianranControls" class="hidden" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
      <div class="settingsRow">
        <label for="yiyunDianranPostEffectEnabled">相机后处理:</label>
        <input type="checkbox" id="yiyunDianranPostEffectEnabled" class="settingsCheckbox" checked>
      </div>
      <div class="settingsRow">
        <label for="yiyunDianranSaturation" class="postEffectLabel">基础点色彩饱和度:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="yiyunDianranSaturation" class="postEffectSlider" min="1" max="1.6" step="0.01" value="1.2">
          <span id="yiyunDianranSaturationVal" class="postEffectSliderValue">1.20</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="yiyunDianranGlowIntensity" class="postEffectLabel">全局发光强度:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="yiyunDianranGlowIntensity" class="postEffectSlider" min="0" max="0.1" step="0.001" value="0.05">
          <span id="yiyunDianranGlowIntensityVal" class="postEffectSliderValue">0.050</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="yiyunDianranGlowColor" class="postEffectLabel">发光颜色:</label>
        <input type="color" id="yiyunDianranGlowColor" class="settingsInput" value="#002fa7">
      </div>
    </div>
    <div id="persistentPalettePixelControls" class="hidden" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
      <div class="settingsRow">
        <label for="palettePixelSize" class="postEffectLabel">马赛克大小:</label>
        <select id="palettePixelSize" class="settingsSelect">
          <option value="300">300</option>
          <option value="400">400</option>
          <option value="500">500</option>
          <option value="600">600</option>
          <option value="700">700</option>
          <option value="800">800</option>
          <option value="900">900</option>
        </select>
      </div>
      <div class="settingsRow">
        <label for="palettePixelPalette" class="postEffectLabel">色板选择:</label>
        <select id="palettePixelPalette" class="settingsSelect">
          <option value="1">1. 碧空跃金</option>
          <option value="2">2. 墨雅灰绿</option>
          <option value="3">3. 鲜活绿动</option>
          <option value="4">4. 暖暮霞光</option>
          <option value="5">5. 活力撞色</option>
          <option value="6">6. 火山灰岩</option>
          <option value="7">7. 夜色霓虹</option>
        </select>
      </div>
      <div class="settingsRow">
        <label for="palettePixelLevels" class="postEffectLabel">明度分阶数量:</label>
        <input type="number" id="palettePixelLevels" class="settingsInput" min="2" max="20" step="1" value="12">
      </div>
      <div class="settingsRow">
        <label for="palettePixelLevelRange" class="postEffectLabel">色阶映射域:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="palettePixelLevelRange" class="postEffectSlider" min="0" max="2" step="0.01" value="1">
          <span id="palettePixelLevelRangeVal" class="postEffectSliderValue">1.00</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="palettePixelNoise" class="postEffectLabel">噪波:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="palettePixelNoise" class="postEffectSlider" min="0" max="0.08" step="0.001" value="0.05">
          <span id="palettePixelNoiseVal" class="postEffectSliderValue">0.050</span>
        </div>
      </div>
    </div>
    <div id="persistentNostalgicComicControls" class="hidden" style="margin-top:8px;padding-top:8px;border-top:1px solid rgba(255,255,255,0.08)">
      <div class="settingsRow">
        <label for="nostalgicComicLevelCount" class="postEffectLabel">明度分阶数量:</label>
        <input type="number" id="nostalgicComicLevelCount" class="settingsInput" min="3" max="7" step="1" value="5">
      </div>
      <div class="settingsRow">
        <label for="nostalgicComicEdgeThreshold" class="postEffectLabel">线稿边缘敏感度:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="nostalgicComicEdgeThreshold" class="postEffectSlider" min="0.3" max="3" step="0.05" value="0.5">
          <span id="nostalgicComicEdgeThresholdVal" class="postEffectSliderValue">0.50</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="nostalgicComicPaperColor" class="postEffectLabel">背景/纸张颜色:</label>
        <input type="color" id="nostalgicComicPaperColor" class="settingsInput" value="#f5f0e3">
      </div>
      <div class="settingsRow">
        <label for="nostalgicComicLightColor" class="postEffectLabel">物体亮部颜色:</label>
        <input type="color" id="nostalgicComicLightColor" class="settingsInput" value="#d9d9d9">
      </div>
      <div class="settingsRow">
        <label for="nostalgicComicStrokeColor" class="postEffectLabel">物体暗部/线稿颜色:</label>
        <input type="color" id="nostalgicComicStrokeColor" class="settingsInput" value="#262626">
      </div>
    </div>
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
    const persistentYiyunDianranControls = container.querySelector('#persistentYiyunDianranControls') as HTMLElement | null;
    const persistentPalettePixelControls = container.querySelector('#persistentPalettePixelControls') as HTMLElement | null;
    const persistentNostalgicComicControls = container.querySelector('#persistentNostalgicComicControls') as HTMLElement | null;
    const petalsTextureUrl = container.querySelector('#petalsTextureUrl') as HTMLInputElement | null;
    const petalsDensity = container.querySelector('#petalsDensity') as HTMLInputElement | null;
    const petalsExtentX = container.querySelector('#petalsExtentX') as HTMLInputElement | null;
    const petalsExtentY = container.querySelector('#petalsExtentY') as HTMLInputElement | null;
    const petalsExtentZ = container.querySelector('#petalsExtentZ') as HTMLInputElement | null;
    const weatherDensity = container.querySelector('#weatherDensity') as HTMLInputElement | null;
    const weatherDensityValue = container.querySelector('#weatherDensityValue') as HTMLElement | null;
    const weatherSpeed = container.querySelector('#weatherSpeed') as HTMLInputElement | null;
    const weatherSpeedValue = container.querySelector('#weatherSpeedValue') as HTMLElement | null;
    const weatherOpacity = container.querySelector('#weatherOpacity') as HTMLInputElement | null;
    const weatherOpacityValue = container.querySelector('#weatherOpacityValue') as HTMLElement | null;
    const weatherGlobalOpacity = container.querySelector('#weatherGlobalOpacity') as HTMLInputElement | null;
    const weatherGlobalOpacityValue = container.querySelector('#weatherGlobalOpacityValue') as HTMLElement | null;
    const weatherFarOpacity = container.querySelector('#weatherFarOpacity') as HTMLInputElement | null;
    const weatherFarOpacityValue = container.querySelector('#weatherFarOpacityValue') as HTMLElement | null;
    const weatherDrift = container.querySelector('#weatherDrift') as HTMLInputElement | null;
    const weatherDriftValue = container.querySelector('#weatherDriftValue') as HTMLElement | null;
    const weatherExtentX = container.querySelector('#weatherExtentX') as HTMLInputElement | null;
    const weatherExtentY = container.querySelector('#weatherExtentY') as HTMLInputElement | null;
    const weatherExtentZ = container.querySelector('#weatherExtentZ') as HTMLInputElement | null;
    const weatherMinSize = container.querySelector('#weatherMinSize') as HTMLInputElement | null;
    const weatherMaxSize = container.querySelector('#weatherMaxSize') as HTMLInputElement | null;
    const weatherElongate = container.querySelector('#weatherElongate') as HTMLInputElement | null;
    const weatherElongateValue = container.querySelector('#weatherElongateValue') as HTMLElement | null;
    const weatherAngleRow = container.querySelector('#weatherAngleRow') as HTMLElement | null;
    const weatherAngle = container.querySelector('#weatherAngle') as HTMLInputElement | null;
    const weatherAngleValue = container.querySelector('#weatherAngleValue') as HTMLElement | null;
    const weatherFogDensity = container.querySelector('#weatherFogDensity') as HTMLInputElement | null;
    const weatherFogDensityValue = container.querySelector('#weatherFogDensityValue') as HTMLElement | null;
    const weatherExposure = container.querySelector('#weatherExposure') as HTMLInputElement | null;
    const weatherExposureValue = container.querySelector('#weatherExposureValue') as HTMLElement | null;
    const weatherUseFog = container.querySelector('#weatherUseFog') as HTMLInputElement | null;
    const weatherBgColor = container.querySelector('#weatherBgColor') as HTMLInputElement | null;
    const weatherUseCameraClearColor = container.querySelector('#weatherUseCameraClearColor') as HTMLInputElement | null;
    const yiyunDianranPostEffectEnabled = container.querySelector('#yiyunDianranPostEffectEnabled') as HTMLInputElement | null;
    const yiyunDianranSaturation = container.querySelector('#yiyunDianranSaturation') as HTMLInputElement | null;
    const yiyunDianranSaturationVal = container.querySelector('#yiyunDianranSaturationVal') as HTMLElement | null;
    const yiyunDianranGlowIntensity = container.querySelector('#yiyunDianranGlowIntensity') as HTMLInputElement | null;
    const yiyunDianranGlowIntensityVal = container.querySelector('#yiyunDianranGlowIntensityVal') as HTMLElement | null;
    const yiyunDianranGlowColor = container.querySelector('#yiyunDianranGlowColor') as HTMLInputElement | null;
    const palettePixelSize = container.querySelector('#palettePixelSize') as HTMLSelectElement | null;
    const palettePixelPalette = container.querySelector('#palettePixelPalette') as HTMLSelectElement | null;
    const palettePixelLevels = container.querySelector('#palettePixelLevels') as HTMLInputElement | null;
    const palettePixelLevelRange = container.querySelector('#palettePixelLevelRange') as HTMLInputElement | null;
    const palettePixelLevelRangeVal = container.querySelector('#palettePixelLevelRangeVal') as HTMLElement | null;
    const palettePixelNoise = container.querySelector('#palettePixelNoise') as HTMLInputElement | null;
    const palettePixelNoiseVal = container.querySelector('#palettePixelNoiseVal') as HTMLElement | null;
    const nostalgicComicLevelCount = container.querySelector('#nostalgicComicLevelCount') as HTMLInputElement | null;
    const nostalgicComicEdgeThreshold = container.querySelector('#nostalgicComicEdgeThreshold') as HTMLInputElement | null;
    const nostalgicComicEdgeThresholdVal = container.querySelector('#nostalgicComicEdgeThresholdVal') as HTMLElement | null;
    const nostalgicComicPaperColor = container.querySelector('#nostalgicComicPaperColor') as HTMLInputElement | null;
    const nostalgicComicLightColor = container.querySelector('#nostalgicComicLightColor') as HTMLInputElement | null;
    const nostalgicComicStrokeColor = container.querySelector('#nostalgicComicStrokeColor') as HTMLInputElement | null;
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
        type: 'EFFECT_ADD' | 'EFFECT_PARAMS_PATCH' | 'EFFECT_DELETE' | 'EFFECT_TOGGLE' | 'EFFECT_REPLAY',
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

    const refreshControlsAfterEffectsCommand = () => {
        if (getEditUiTransport(global) === 'message-bridge') {
            window.setTimeout(() => updateRevealControls(), 0);
            return;
        }
        updateRevealControls();
    };

    const readPersistentPack = (): Record<string, unknown> | undefined => {
        const pack = readPersistentSettingsPack(global.settings);
        return pack && typeof pack.type === 'string' && isPersistentType(pack.type) ? pack : undefined;
    };

    const getPersistentSelection = (): string => {
        const pack = readPersistentPack();
        return pack && typeof pack.type === 'string' ? pack.type : 'none';
    };

    const getPersistentEnabled = (): boolean => {
        const pack = readPersistentPack();
        const pType = getPersistentSelection();
        if (pType === 'none') {
            return false;
        }
        if (pack?.enabled === false) {
            return false;
        }
        // settings.effects.persistent.enabled 未写入时默认 true
        return global.settings.effects?.persistent?.enabled ?? true;
    };

    let updateRevealControls = () => {};

    const getDefaultPersistentEffectParams = (type: string): Record<string, unknown> => {
        if (type === 'falling-petals') {
            return {
                petalTextureUrl: '/textures/petal-atlas.png',
                density: 1,
                extents: [36, 24, 72]
            };
        }
        if (type === 'falling-rain') {
            return {
                density: 1.5,
                speed: 10,
                opacity: 0.65,
                globalOpacity: 1,
                farOpacity: 0.4,
                drift: 0.02,
                extents: [12, 12, 24],
                particleMinSize: 0.003,
                particleMaxSize: 0.003,
                elongate: 20,
                angle: 0,
                fogDensity: 0.010,
                exposure: 0.5,
                useFog: true,
                cameraClearColor: [0.8, 0.8, 0.8],
                useCameraClearColor: true
            };
        }
        if (type === 'falling-snow') {
            return {
                density: 1.5,
                speed: 2,
                opacity: 0.85,
                globalOpacity: 1,
                farOpacity: 0.4,
                drift: 0.4,
                extents: [12, 12, 24],
                particleMinSize: 0.006,
                particleMaxSize: 0.012,
                elongate: 1,
                fogDensity: 0.010,
                exposure: 0.5,
                useFog: true,
                cameraClearColor: [0.8, 0.8, 0.8],
                useCameraClearColor: true
            };
        }
        if (type === 'nostalgic-comic') {
            return {
                levelCount: 5,
                edgeThreshold: 0.5,
                paperColor: [0.96, 0.94, 0.89],
                lightColor: [0.85, 0.85, 0.85],
                strokeColor: [0.15, 0.15, 0.15]
            };
        }
        if (type === 'yiyun-dianran') {
            return {
                postEffectEnabled: true,
                saturation: 1.2,
                glowIntensity: 0.05,
                glowColor: [0.0, 0.184, 0.655]
            };
        }
        if (type === 'palette-pixel') {
            return {
                pixelSize: DEFAULT_PALETTE_PIXEL_SETTINGS.pixelSize,
                paletteIndex: DEFAULT_PALETTE_PIXEL_SETTINGS.paletteIndex,
                levels: DEFAULT_PALETTE_PIXEL_SETTINGS.levels,
                levelRange: DEFAULT_PALETTE_PIXEL_SETTINGS.levelRange,
                ditherSpread: DEFAULT_PALETTE_PIXEL_SETTINGS.ditherSpread
            };
        }
        return {};
    };

    const getPersistentEffectParams = (): Record<string, unknown> => {
        const pack = readPersistentPack();
        const effectParams = pack?.effectParams;
        return effectParams && typeof effectParams === 'object' ? effectParams as Record<string, unknown> : {};
    };

    const getPersistentProtocolEffectId = (): string => {
        const type = getPersistentSelection();
        return persistentEffectIdForBucket(persistentEffectBucketForType(type));
    };

    const patchPersistentEffectParams = (effectParams: Record<string, unknown>) => {
        routeEffectsCommand('EFFECT_PARAMS_PATCH', {
            effectId: getPersistentProtocolEffectId(),
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

    const writeSlider = (
        input: HTMLInputElement | null,
        valueEl: HTMLElement | null,
        value: unknown,
        fallback: number,
        decimals: number
    ) => {
        const next = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
        if (input) input.value = next.toString();
        if (valueEl) valueEl.textContent = decimals > 0 ? next.toFixed(decimals) : Math.round(next).toString();
    };

    const syncSliderValue = (input: HTMLInputElement | null, valueEl: HTMLElement | null, decimals: number) => {
        if (!input || !valueEl) return;
        const next = Number.parseFloat(input.value);
        valueEl.textContent = Number.isFinite(next) ? (decimals > 0 ? next.toFixed(decimals) : Math.round(next).toString()) : '';
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

    const rgbTripleToHex = (value: unknown, fallback: [number, number, number]): string => {
        const triple = Array.isArray(value) && value.length >= 3 ? value : fallback;
        const toHex = (channel: unknown, fallbackChannel: number) => {
            const normalized = typeof channel === 'number' && Number.isFinite(channel) ? channel : fallbackChannel;
            const byte = Math.min(255, Math.max(0, Math.round(normalized * 255)));
            return byte.toString(16).padStart(2, '0');
        };
        return `#${toHex(triple[0], fallback[0])}${toHex(triple[1], fallback[1])}${toHex(triple[2], fallback[2])}`;
    };

    const hexToRgbTriple = (value: string | undefined, fallback: [number, number, number]): [number, number, number] => {
        const match = /^#?([0-9a-f]{6})$/i.exec(value ?? '');
        if (!match) return fallback;
        const hex = match[1];
        return [
            Number.parseInt(hex.slice(0, 2), 16) / 255,
            Number.parseInt(hex.slice(2, 4), 16) / 255,
            Number.parseInt(hex.slice(4, 6), 16) / 255
        ];
    };

    const updatePersistentParamControls = () => {
        const pType = getPersistentSelection();
        const params = getPersistentEffectParams();
        persistentPetalsControls?.classList[pType === 'falling-petals' ? 'remove' : 'add']('hidden');
        const showWeatherControls = pType === 'falling-rain' || pType === 'falling-snow';
        persistentWeatherControls?.classList[showWeatherControls ? 'remove' : 'add']('hidden');
        persistentYiyunDianranControls?.classList[pType === 'yiyun-dianran' ? 'remove' : 'add']('hidden');
        persistentPalettePixelControls?.classList[pType === 'palette-pixel' ? 'remove' : 'add']('hidden');
        persistentNostalgicComicControls?.classList[pType === 'nostalgic-comic' ? 'remove' : 'add']('hidden');

        writeTextInput(petalsTextureUrl, params.petalTextureUrl, '/textures/petal-atlas.png');
        const legacyPetalCount = typeof params.petalParticleCount === 'number' ? params.petalParticleCount : undefined;
        const petalDensity = typeof params.density === 'number' ? params.density : legacyPetalCount !== undefined ? legacyPetalCount / 6000 : 1;
        writeNumberInput(petalsDensity, petalDensity, 1);
        writeTriple([petalsExtentX, petalsExtentY, petalsExtentZ], params.extents, [36, 24, 72]);

        const isRain = pType === 'falling-rain';
        writeSlider(weatherDensity, weatherDensityValue, params.density, 1.5, 1);
        writeSlider(weatherSpeed, weatherSpeedValue, params.speed, isRain ? 10 : 2, 1);
        writeSlider(weatherOpacity, weatherOpacityValue, params.opacity, isRain ? 0.65 : 0.85, 2);
        writeSlider(weatherGlobalOpacity, weatherGlobalOpacityValue, params.globalOpacity, 1, 2);
        writeSlider(weatherFarOpacity, weatherFarOpacityValue, params.farOpacity, 0.4, 2);
        writeSlider(weatherDrift, weatherDriftValue, params.drift, isRain ? 0.02 : 0.4, 2);
        writeTriple([weatherExtentX, weatherExtentY, weatherExtentZ], params.extents, [12, 12, 24]);
        writeNumberInput(weatherMinSize, params.particleMinSize, isRain ? 0.003 : 0.006);
        writeNumberInput(weatherMaxSize, params.particleMaxSize, isRain ? 0.003 : 0.012);
        writeSlider(weatherElongate, weatherElongateValue, params.elongate, isRain ? 20 : 1, 1);
        weatherAngleRow?.classList.toggle('hidden', !isRain);
        writeSlider(weatherAngle, weatherAngleValue, params.angle, 0, 0);
        writeSlider(weatherFogDensity, weatherFogDensityValue, params.fogDensity, 0.010, 4);
        writeSlider(weatherExposure, weatherExposureValue, params.exposure, 0.5, 2);
        if (weatherBgColor) {
            weatherBgColor.value = rgbTripleToHex(params.cameraClearColor, [0.8, 0.8, 0.8]);
        }
        if (weatherUseFog) {
            weatherUseFog.checked = typeof params.useFog === 'boolean' ? params.useFog : true;
        }
        if (weatherUseCameraClearColor) {
            weatherUseCameraClearColor.checked = typeof params.useCameraClearColor === 'boolean' ? params.useCameraClearColor : true;
        }

        if (yiyunDianranPostEffectEnabled) {
            yiyunDianranPostEffectEnabled.checked = typeof params.postEffectEnabled === 'boolean'
                ? params.postEffectEnabled
                : true;
        }

        writeSlider(yiyunDianranSaturation, yiyunDianranSaturationVal, params.saturation, 1.2, 2);
        writeSlider(yiyunDianranGlowIntensity, yiyunDianranGlowIntensityVal, params.glowIntensity, 0.05, 3);
        if (yiyunDianranGlowColor) {
            yiyunDianranGlowColor.value = rgbTripleToHex(params.glowColor, [0.0, 0.184, 0.655]);
        }

        if (palettePixelSize) {
            const pixelSize = typeof params.pixelSize === 'number' && Number.isFinite(params.pixelSize)
                ? params.pixelSize
                : DEFAULT_PALETTE_PIXEL_SETTINGS.pixelSize;
            const snapped = (PALETTE_PIXEL_SIZE_STEPS as readonly number[]).includes(pixelSize)
                ? pixelSize
                : DEFAULT_PALETTE_PIXEL_SETTINGS.pixelSize;
            palettePixelSize.value = String(snapped);
        }
        if (palettePixelPalette) {
            const idx = typeof params.paletteIndex === 'number' && Number.isFinite(params.paletteIndex)
                ? Math.min(7, Math.max(1, Math.floor(params.paletteIndex)))
                : DEFAULT_PALETTE_PIXEL_SETTINGS.paletteIndex;
            palettePixelPalette.value = String(idx);
        }
        writeNumberInput(
            palettePixelLevels,
            params.levels,
            DEFAULT_PALETTE_PIXEL_SETTINGS.levels
        );
        writeSlider(
            palettePixelLevelRange,
            palettePixelLevelRangeVal,
            params.levelRange,
            DEFAULT_PALETTE_PIXEL_SETTINGS.levelRange,
            2
        );
        writeSlider(
            palettePixelNoise,
            palettePixelNoiseVal,
            params.ditherSpread,
            DEFAULT_PALETTE_PIXEL_SETTINGS.ditherSpread,
            3
        );

        writeNumberInput(nostalgicComicLevelCount, params.levelCount, 5);
        writeSlider(nostalgicComicEdgeThreshold, nostalgicComicEdgeThresholdVal, params.edgeThreshold, 0.5, 2);
        if (nostalgicComicPaperColor) {
            nostalgicComicPaperColor.value = rgbTripleToHex(params.paperColor, [0.96, 0.94, 0.89]);
        }
        if (nostalgicComicLightColor) {
            nostalgicComicLightColor.value = rgbTripleToHex(params.lightColor, [0.85, 0.85, 0.85]);
        }
        if (nostalgicComicStrokeColor) {
            nostalgicComicStrokeColor.value = rgbTripleToHex(params.strokeColor, [0.15, 0.15, 0.15]);
        }
    };

    const onPetalsParamsChange = () => {
        patchPersistentEffectParams({
            petalTextureUrl: petalsTextureUrl?.value || '/textures/petal-atlas.png',
            density: readNumberInput(petalsDensity, 1),
            extents: readTriple(petalsExtentX, petalsExtentY, petalsExtentZ, [36, 24, 72])
        });
    };

    const onWeatherParamsChange = () => {
        const isRain = getPersistentSelection() === 'falling-rain';
        patchPersistentEffectParams({
            density: readNumberInput(weatherDensity, 1.5),
            speed: readNumberInput(weatherSpeed, isRain ? 10 : 2),
            opacity: readNumberInput(weatherOpacity, isRain ? 0.65 : 0.85),
            globalOpacity: readNumberInput(weatherGlobalOpacity, 1),
            farOpacity: readNumberInput(weatherFarOpacity, 0.4),
            drift: readNumberInput(weatherDrift, isRain ? 0.02 : 0.4),
            extents: readTriple(weatherExtentX, weatherExtentY, weatherExtentZ, [12, 12, 24]),
            particleMinSize: readNumberInput(weatherMinSize, isRain ? 0.003 : 0.006),
            particleMaxSize: readNumberInput(weatherMaxSize, isRain ? 0.003 : 0.012),
            elongate: readNumberInput(weatherElongate, isRain ? 20 : 1),
            ...(isRain ? { angle: readNumberInput(weatherAngle, 0) } : {}),
            fogDensity: readNumberInput(weatherFogDensity, 0.010),
            exposure: readNumberInput(weatherExposure, 0.5),
            useFog: weatherUseFog?.checked ?? true,
            cameraClearColor: hexToRgbTriple(weatherBgColor?.value, [0.8, 0.8, 0.8]),
            useCameraClearColor: weatherUseCameraClearColor?.checked ?? true
        });
    };

    const onWeatherSliderInput = () => {
        syncSliderValue(weatherDensity, weatherDensityValue, 1);
        syncSliderValue(weatherSpeed, weatherSpeedValue, 1);
        syncSliderValue(weatherOpacity, weatherOpacityValue, 2);
        syncSliderValue(weatherGlobalOpacity, weatherGlobalOpacityValue, 2);
        syncSliderValue(weatherFarOpacity, weatherFarOpacityValue, 2);
        syncSliderValue(weatherDrift, weatherDriftValue, 2);
        syncSliderValue(weatherElongate, weatherElongateValue, 1);
        syncSliderValue(weatherAngle, weatherAngleValue, 0);
        syncSliderValue(weatherFogDensity, weatherFogDensityValue, 4);
        syncSliderValue(weatherExposure, weatherExposureValue, 2);
        onWeatherParamsChange();
    };

    const onYiyunDianranParamsChange = () => {
        patchPersistentEffectParams({
            postEffectEnabled: yiyunDianranPostEffectEnabled?.checked ?? true,
            saturation: readNumberInput(yiyunDianranSaturation, 1.2),
            glowIntensity: readNumberInput(yiyunDianranGlowIntensity, 0.05),
            glowColor: hexToRgbTriple(yiyunDianranGlowColor?.value, [0.0, 0.184, 0.655])
        });
    };

    const onYiyunDianranSliderInput = () => {
        syncSliderValue(yiyunDianranSaturation, yiyunDianranSaturationVal, 2);
        syncSliderValue(yiyunDianranGlowIntensity, yiyunDianranGlowIntensityVal, 3);
        onYiyunDianranParamsChange();
    };

    const onPalettePixelParamsChange = () => {
        const paletteRaw = palettePixelPalette ? Number.parseInt(palettePixelPalette.value, 10) : NaN;
        const paletteIndex = Number.isFinite(paletteRaw)
            ? Math.min(7, Math.max(1, paletteRaw))
            : DEFAULT_PALETTE_PIXEL_SETTINGS.paletteIndex;
        const pixelRaw = palettePixelSize ? Number.parseInt(palettePixelSize.value, 10) : NaN;
        const pixelSize = Number.isFinite(pixelRaw) ? pixelRaw : DEFAULT_PALETTE_PIXEL_SETTINGS.pixelSize;
        patchPersistentEffectParams({
            pixelSize,
            paletteIndex,
            levels: readNumberInput(palettePixelLevels, DEFAULT_PALETTE_PIXEL_SETTINGS.levels),
            levelRange: readNumberInput(palettePixelLevelRange, DEFAULT_PALETTE_PIXEL_SETTINGS.levelRange),
            ditherSpread: readNumberInput(palettePixelNoise, DEFAULT_PALETTE_PIXEL_SETTINGS.ditherSpread)
        });
    };

    const onPalettePixelLevelRangeInput = () => {
        syncSliderValue(palettePixelLevelRange, palettePixelLevelRangeVal, 2);
        onPalettePixelParamsChange();
    };

    const onPalettePixelNoiseInput = () => {
        syncSliderValue(palettePixelNoise, palettePixelNoiseVal, 3);
        onPalettePixelParamsChange();
    };

    const onNostalgicComicParamsChange = () => {
        patchPersistentEffectParams({
            levelCount: readNumberInput(nostalgicComicLevelCount, 5),
            edgeThreshold: readNumberInput(nostalgicComicEdgeThreshold, 0.5),
            paperColor: hexToRgbTriple(nostalgicComicPaperColor?.value, [0.96, 0.94, 0.89]),
            lightColor: hexToRgbTriple(nostalgicComicLightColor?.value, [0.85, 0.85, 0.85]),
            strokeColor: hexToRgbTriple(nostalgicComicStrokeColor?.value, [0.15, 0.15, 0.15])
        });
    };

    const onNostalgicComicSliderInput = () => {
        syncSliderValue(nostalgicComicEdgeThreshold, nostalgicComicEdgeThresholdVal, 2);
        onNostalgicComicParamsChange();
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
        const oldType = getPersistentSelection();
        const type = target.value;
        if (type === 'none') {
            const deleteType = isPersistentType(oldType) ? oldType : 'perlin-wave';
            routeEffectsCommand('EFFECT_DELETE', {
                effectId: persistentEffectIdForBucket(persistentEffectBucketForType(deleteType)),
                effectType: deleteType
            });
        } else {
            routeEffectsCommand('EFFECT_ADD', {
                effectId: persistentEffectIdForBucket(persistentEffectBucketForType(type)),
                effectType: type,
                params: getDefaultPersistentEffectParams(type)
            });
        }
        pushEditHistorySafe();
        refreshControlsAfterEffectsCommand();
    };

    const onPersistentEnabledChange = (event: Event) => {
        const enabled = (event.target as HTMLInputElement).checked;
        routeEffectsCommand('EFFECT_TOGGLE', {
            effectId: getPersistentProtocolEffectId(),
            value: enabled
        });
        pushEditHistorySafe();
        refreshControlsAfterEffectsCommand();
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
    petalsDensity?.addEventListener('change', onPetalsParamsChange);
    petalsExtentX?.addEventListener('change', onPetalsParamsChange);
    petalsExtentY?.addEventListener('change', onPetalsParamsChange);
    petalsExtentZ?.addEventListener('change', onPetalsParamsChange);
    weatherDensity?.addEventListener('input', onWeatherSliderInput);
    weatherSpeed?.addEventListener('input', onWeatherSliderInput);
    weatherOpacity?.addEventListener('input', onWeatherSliderInput);
    weatherGlobalOpacity?.addEventListener('input', onWeatherSliderInput);
    weatherFarOpacity?.addEventListener('input', onWeatherSliderInput);
    weatherDrift?.addEventListener('change', onWeatherParamsChange);
    weatherDrift?.addEventListener('input', onWeatherSliderInput);
    weatherExtentX?.addEventListener('change', onWeatherParamsChange);
    weatherExtentY?.addEventListener('change', onWeatherParamsChange);
    weatherExtentZ?.addEventListener('change', onWeatherParamsChange);
    weatherMinSize?.addEventListener('change', onWeatherParamsChange);
    weatherMaxSize?.addEventListener('change', onWeatherParamsChange);
    weatherElongate?.addEventListener('input', onWeatherSliderInput);
    weatherAngle?.addEventListener('input', onWeatherSliderInput);
    weatherFogDensity?.addEventListener('input', onWeatherSliderInput);
    weatherExposure?.addEventListener('input', onWeatherSliderInput);
    weatherUseFog?.addEventListener('change', onWeatherParamsChange);
    weatherBgColor?.addEventListener('input', onWeatherParamsChange);
    weatherUseCameraClearColor?.addEventListener('change', onWeatherParamsChange);
    yiyunDianranPostEffectEnabled?.addEventListener('change', onYiyunDianranParamsChange);
    yiyunDianranSaturation?.addEventListener('input', onYiyunDianranSliderInput);
    yiyunDianranGlowIntensity?.addEventListener('input', onYiyunDianranSliderInput);
    yiyunDianranGlowColor?.addEventListener('input', onYiyunDianranParamsChange);
    palettePixelSize?.addEventListener('change', onPalettePixelParamsChange);
    palettePixelPalette?.addEventListener('change', onPalettePixelParamsChange);
    palettePixelLevels?.addEventListener('change', onPalettePixelParamsChange);
    palettePixelLevelRange?.addEventListener('input', onPalettePixelLevelRangeInput);
    palettePixelNoise?.addEventListener('input', onPalettePixelNoiseInput);
    nostalgicComicLevelCount?.addEventListener('change', onNostalgicComicParamsChange);
    nostalgicComicEdgeThreshold?.addEventListener('input', onNostalgicComicSliderInput);
    nostalgicComicPaperColor?.addEventListener('input', onNostalgicComicParamsChange);
    nostalgicComicLightColor?.addEventListener('input', onNostalgicComicParamsChange);
    nostalgicComicStrokeColor?.addEventListener('input', onNostalgicComicParamsChange);
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
        petalsDensity?.removeEventListener('change', onPetalsParamsChange);
        petalsExtentX?.removeEventListener('change', onPetalsParamsChange);
        petalsExtentY?.removeEventListener('change', onPetalsParamsChange);
        petalsExtentZ?.removeEventListener('change', onPetalsParamsChange);
        weatherDensity?.removeEventListener('input', onWeatherSliderInput);
        weatherSpeed?.removeEventListener('input', onWeatherSliderInput);
        weatherOpacity?.removeEventListener('input', onWeatherSliderInput);
        weatherGlobalOpacity?.removeEventListener('input', onWeatherSliderInput);
        weatherFarOpacity?.removeEventListener('input', onWeatherSliderInput);
        weatherDrift?.removeEventListener('change', onWeatherParamsChange);
        weatherDrift?.removeEventListener('input', onWeatherSliderInput);
        weatherExtentX?.removeEventListener('change', onWeatherParamsChange);
        weatherExtentY?.removeEventListener('change', onWeatherParamsChange);
        weatherExtentZ?.removeEventListener('change', onWeatherParamsChange);
        weatherMinSize?.removeEventListener('change', onWeatherParamsChange);
        weatherMaxSize?.removeEventListener('change', onWeatherParamsChange);
        weatherElongate?.removeEventListener('input', onWeatherSliderInput);
        weatherAngle?.removeEventListener('input', onWeatherSliderInput);
        weatherFogDensity?.removeEventListener('input', onWeatherSliderInput);
        weatherExposure?.removeEventListener('input', onWeatherSliderInput);
        weatherUseFog?.removeEventListener('change', onWeatherParamsChange);
        weatherBgColor?.removeEventListener('input', onWeatherParamsChange);
        weatherUseCameraClearColor?.removeEventListener('change', onWeatherParamsChange);
        yiyunDianranPostEffectEnabled?.removeEventListener('change', onYiyunDianranParamsChange);
        yiyunDianranSaturation?.removeEventListener('input', onYiyunDianranSliderInput);
        yiyunDianranGlowIntensity?.removeEventListener('input', onYiyunDianranSliderInput);
        yiyunDianranGlowColor?.removeEventListener('input', onYiyunDianranParamsChange);
        palettePixelSize?.removeEventListener('change', onPalettePixelParamsChange);
        palettePixelPalette?.removeEventListener('change', onPalettePixelParamsChange);
        palettePixelLevels?.removeEventListener('change', onPalettePixelParamsChange);
        palettePixelLevelRange?.removeEventListener('input', onPalettePixelLevelRangeInput);
        palettePixelNoise?.removeEventListener('input', onPalettePixelNoiseInput);
        nostalgicComicLevelCount?.removeEventListener('change', onNostalgicComicParamsChange);
        nostalgicComicEdgeThreshold?.removeEventListener('input', onNostalgicComicSliderInput);
        nostalgicComicPaperColor?.removeEventListener('input', onNostalgicComicParamsChange);
        nostalgicComicLightColor?.removeEventListener('input', onNostalgicComicParamsChange);
        nostalgicComicStrokeColor?.removeEventListener('input', onNostalgicComicParamsChange);
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
