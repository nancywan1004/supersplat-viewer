/**
 * 物体特效 internal / message-bridge UI（`settings.effects.asset` + `EFFECT_*` 协议）。
 */

import type { Global } from '../../types';
import { pushEditHistory } from '../../edit-history';
import { ASSET_GSPLAT_EFFECT_ID, ASSET_EFFECT_TYPE_VALUES } from '../../vfx/effects-runtime/effect-types';
import { readAssetInstanceParams } from '../../settings-serialize/effects-sync';
import {
    getScenePlacedItemByTargetId,
    isPlacedGaussianItem,
    resolvePlacedGaussianSourceUrl
} from '../../vfx/effects-runtime/asset/asset-scene-target';
import { dispatchEffectsModuleCommand } from '../../editor-modules/effects-facade';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';
import { getSelectedScenePlacedItem } from '../../state-selectors';

const MORPH_TYPE = ASSET_EFFECT_TYPE_VALUES[0];
const WOBBLE_TYPE = ASSET_EFFECT_TYPE_VALUES[1];

const ASSET_EFFECT_LABEL: Record<string, string> = {
    [MORPH_TYPE]: 'GS变形',
    [WOBBLE_TYPE]: '静物活化'
};

export const ASSET_EFFECTS_PANEL_HTML = `
<fieldset id="assetEffectsFieldset" class="effectsTrackFieldset effectsTrackAsset" style="border:1px solid rgba(255,255,255,0.12);border-radius:8px;padding:10px 12px;margin-bottom:10px">
  <legend style="padding:0 6px;font-size:13px;font-weight:600">Asset（物体）— GSplat 特效</legend>
  <p class="effectsTrackHint" style="font-size:11px;opacity:0.8;margin:0 0 8px;line-height:1.35">
    配置存于 <code>settings.effects.asset</code>（<code>targetId</code>=配置键）；执行绑定 <code>effectParams.entityId</code> / <code>keyframeEntityIds</code>（与 bridge <code>ASSET_PLACE.sceneEntityId</code> 一致）。Internal 列表选择仅写入 id，经同一 <code>EFFECT_*</code> 协议。
  </p>
  <div class="settingsRow" style="flex-direction:column;align-items:stretch;gap:4px">
    <label style="font-size:12px;font-weight:600">Entity 绑定</label>
    <p id="assetEffectEntityHint" class="effectsTrackHint" style="font-size:11px;opacity:0.82;margin:0;line-height:1.4">—</p>
  </div>
  <div class="settingsRow">
    <label>目标资产 <span style="font-weight:400;opacity:0.75">(targetId)</span>:</label>
    <span id="assetEffectTargetLabel" style="font-size:12px;opacity:0.9">（未选中）</span>
  </div>
  <div class="settingsRow hidden" id="assetEffectEntityRow">
    <label>场景 Entity:</label>
    <span id="assetEffectEntityLabel" style="font-size:11px;opacity:0.85;font-family:monospace">—</span>
  </div>
  <div class="settingsRow">
    <label for="assetEffectType">特效类型:</label>
    <select id="assetEffectType" class="settingsSelect">
      <option value="gsplat-morph">GS变形</option>
      <option value="gsplat-wobble">静物活化</option>
    </select>
  </div>
  <div id="assetMorphParams" class="assetEffectParamsBlock">
    <p class="effectsTrackHint" style="font-size:11px;opacity:0.75;margin:0 0 6px;line-height:1.4">
      步骤：① 上方列表点选 ≥2 个已放置的 <strong>Gaussian</strong>（绿边 = 已加入关键帧）② 点播放。变形在场景中<strong>新建</strong>实体，不驱动列表里那颗 GS。
    </p>
    <div class="settingsRow" style="flex-direction:column;align-items:stretch;gap:4px">
      <label style="font-size:12px">关键帧序列（按顺序，≥2）:</label>
      <ol id="assetMorphKeyframeList" class="asset-morph-keyframe-list" style="margin:0;padding:0 0 0 18px;font-size:12px;min-height:1.2em"></ol>
      <p id="assetMorphKeyframeEmpty" class="effectsTrackHint" style="font-size:11px;opacity:0.7;margin:0">（尚未选择 — 在上方场景资产列表点击 Gaussian）</p>
    </div>
    <div class="settingsRow" style="gap:6px;flex-wrap:wrap">
      <button id="assetMorphAddFromSelection" class="settingsButton" type="button" style="font-size:11px">加入当前选中</button>
      <button id="assetMorphRemoveLast" class="settingsButton" type="button" style="font-size:11px">移除最后一帧</button>
      <button id="assetMorphMoveUp" class="settingsButton" type="button" style="font-size:11px">上移</button>
      <button id="assetMorphMoveDown" class="settingsButton" type="button" style="font-size:11px">下移</button>
      <button id="assetMorphClearKeyframes" class="settingsButton" type="button" style="font-size:11px">清空</button>
    </div>
    <details style="font-size:11px;margin:4px 0 6px">
      <summary style="cursor:pointer;opacity:0.8">高级：手动 URL（可选，覆盖场景选择）</summary>
      <div class="settingsRow" style="flex-direction:column;align-items:stretch;margin-top:6px">
        <textarea id="assetMorphKeyframeUrls" class="settingsInput" rows="2" style="width:100%;resize:vertical" placeholder="每行一个 URL，≥2"></textarea>
      </div>
    </details>
    <div class="settingsRow">
      <label for="assetMorphSegmentDuration">段时长 (s):</label>
      <input type="number" id="assetMorphSegmentDuration" class="settingsInput" min="0.1" max="120" step="0.1" value="2">
    </div>
    <div class="settingsRow">
      <label for="assetMorphLoop">循环:</label>
      <input type="checkbox" id="assetMorphLoop" class="settingsCheckbox" checked>
    </div>
    <details style="font-size:11px;margin:4px 0 6px" open>
      <summary style="cursor:pointer;opacity:0.8">点云过渡</summary>
      <div class="settingsRow">
        <label for="assetMorphPointCloudEffect">启用:</label>
        <input type="checkbox" id="assetMorphPointCloudEffect" class="settingsCheckbox" checked>
      </div>
      <div class="settingsRow">
        <label for="assetMorphPointCloudPointSize" class="postEffectLabel">点大小:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphPointCloudPointSize" class="postEffectSlider" min="0.0005" max="0.02" step="0.0005" value="0.001">
          <span id="assetMorphPointCloudPointSizeVal" class="postEffectSliderValue">0.001</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="assetMorphPointCloudStrength" class="postEffectLabel">点云强度:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphPointCloudStrength" class="postEffectSlider" min="0" max="2" step="0.05" value="1.5">
          <span id="assetMorphPointCloudStrengthVal" class="postEffectSliderValue">1.50</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="assetMorphPointCloudGlowStrength" class="postEffectLabel">辉光强度:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphPointCloudGlowStrength" class="postEffectSlider" min="0" max="2" step="0.05" value="1.7">
          <span id="assetMorphPointCloudGlowStrengthVal" class="postEffectSliderValue">1.70</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="assetMorphPointCloudOpacity" class="postEffectLabel">点不透明度:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphPointCloudOpacity" class="postEffectSlider" min="0.05" max="1" step="0.01" value="0.88">
          <span id="assetMorphPointCloudOpacityVal" class="postEffectSliderValue">0.88</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="assetMorphPointCloudDensity" class="postEffectLabel">可见点比例:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphPointCloudDensity" class="postEffectSlider" min="0.05" max="1" step="0.01" value="0.32">
          <span id="assetMorphPointCloudDensityVal" class="postEffectSliderValue">0.32</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="assetMorphPointCloudScatterDistance" class="postEffectLabel">散开距离:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphPointCloudScatterDistance" class="postEffectSlider" min="0" max="5" step="0.05" value="0">
          <span id="assetMorphPointCloudScatterDistanceVal" class="postEffectSliderValue">自动</span>
        </div>
      </div>
      <div class="settingsRow" style="align-items:center;gap:8px">
        <label for="assetMorphPointCloudTint">辉光颜色:</label>
        <input type="color" id="assetMorphPointCloudTint" value="#0091ff" title="变形中途点云辉光色调">
      </div>
    </details>
  </div>
  <div id="assetWobbleParams" class="assetEffectParamsBlock hidden">
    <p class="effectsTrackHint" style="font-size:11px;opacity:0.75;margin:0 0 6px">仅支持已放置的 <strong>Gaussian</strong> 资产；拖动滑条实时预览（需已播放）。</p>
    <div class="settingsRow">
      <label for="assetWobbleAmplitude" class="postEffectLabel">扭动幅度:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleAmplitude" class="postEffectSlider" min="0" max="2" step="0.05" value="0.3">
        <span id="assetWobbleAmplitudeVal" class="postEffectSliderValue">0.30</span>
      </div>
    </div>
    <div class="settingsRow">
      <label for="assetWobbleFrequency" class="postEffectLabel">扭动频率:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleFrequency" class="postEffectSlider" min="0" max="30" step="0.5" value="5">
        <span id="assetWobbleFrequencyVal" class="postEffectSliderValue">5.0</span>
      </div>
    </div>
    <div class="settingsRow">
      <label for="assetWobbleAnchorLiftPct" class="postEffectLabel" title="扭动时从视觉底部向上、该比例高度内不横向扭动（高斯 Y 大=靠下）">底部固定高度:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleAnchorLiftPct" class="postEffectSlider" min="0" max="50" step="1" value="15">
        <span id="assetWobbleAnchorLiftPctVal" class="postEffectSliderValue">15%</span>
      </div>
    </div>
    <div class="settingsRow">
      <label for="assetWobbleBounceAmplitude" class="postEffectLabel" title="世界单位峰值高度，与物体大小无关">跳动高度:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleBounceAmplitude" class="postEffectSlider" min="0" max="3" step="0.05" value="0.6">
        <span id="assetWobbleBounceAmplitudeVal" class="postEffectSliderValue">0.60</span>
      </div>
    </div>
    <div class="settingsRow">
      <label for="assetWobbleBounceStretch" class="postEffectLabel">Y轴拉伸:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleBounceStretch" class="postEffectSlider" min="0" max="1.5" step="0.05" value="0.75">
        <span id="assetWobbleBounceStretchVal" class="postEffectSliderValue">0.75</span>
      </div>
    </div>
    <div class="settingsRow">
      <label for="assetWobbleHaloEnabled">光圈:</label>
      <input type="checkbox" id="assetWobbleHaloEnabled" class="settingsCheckbox" checked>
      <span style="font-size:11px;opacity:0.75">开启辉光（关闭后仅保留跳动/扭动与拉伸）</span>
    </div>
    <div class="settingsRow" style="align-items:center;gap:8px" id="assetWobbleHaloColorRow">
      <label for="assetWobbleHaloColor">光圈颜色:</label>
      <input type="color" id="assetWobbleHaloColor" value="#ffd900" title="跳动/扭动时高斯辉光色调">
    </div>
  </div>
  <div class="settingsRow" style="gap:8px;margin-top:8px">
    <button id="assetEffectStart" class="settingsButton" type="button">播放物体特效</button>
    <button id="assetEffectStop" class="settingsButton" type="button">停止</button>
  </div>
  <div class="settingsRow">
    <span id="assetEffectStatus" style="font-size:11px;opacity:0.85">状态: —</span>
  </div>
</fieldset>
`.trim();

const DEFAULT_WOBBLE_HALO_RGB: [number, number, number] = [1, 0.85, 0];
const DEFAULT_MORPH_POINT_CLOUD_TINT_RGB: [number, number, number] = [0, 145 / 255, 1];
/** 与 gsplat-morph DEFAULT_MORPH_POINT_CLOUD_POINT_SIZE 一致。 */
const DEFAULT_MORPH_POINT_CLOUD_POINT_SIZE = 0.001;

function rgb01ToHex(rgb: [number, number, number]): string {
    const c = (v: number) =>
        Math.round(Math.min(1, Math.max(0, v)) * 255)
            .toString(16)
            .padStart(2, '0');
    return `#${c(rgb[0])}${c(rgb[1])}${c(rgb[2])}`;
}

function formatSliderValue(value: number, decimals: number): string {
    return value.toFixed(decimals);
}

function bindSliderLive(
    slider: HTMLInputElement,
    valueEl: HTMLElement | null,
    decimals: number,
    onLive: () => void,
    onCommit?: () => void
): () => void {
    const syncLabel = () => {
        if (valueEl) {
            valueEl.textContent = formatSliderValue(Number(slider.value), decimals);
        }
    };
    const onInput = () => {
        syncLabel();
        onLive();
    };
    const onChange = () => {
        if (onCommit) {
            onCommit();
        } else {
            onLive();
        }
    };
    slider.addEventListener('input', onInput);
    slider.addEventListener('change', onChange);
    syncLabel();
    return () => {
        slider.removeEventListener('input', onInput);
        slider.removeEventListener('change', onChange);
    };
}

function hexToRgb01(hex: string): [number, number, number] | null {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) {
        return null;
    }
    const n = parseInt(m[1], 16);
    return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

function getSelectedTargetId(global: Global): string | null {
    const id = global.state.selectedSceneEntityId;
    return typeof id === 'string' && id.length > 0 ? id : null;
}

function parseManualMorphUrls(morphUrls: HTMLTextAreaElement | null): string[] {
    const raw = morphUrls?.value ?? '';
    return raw
        .split(/\r?\n/)
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
}

function readEffectParamsFromDom(
    global: Global,
    type: string,
    morphUrls: HTMLTextAreaElement | null,
    morphSeg: HTMLInputElement | null,
    morphLoop: HTMLInputElement | null,
    morphPointCloudEffect: HTMLInputElement | null,
    morphPointCloudPointSize: HTMLInputElement | null,
    morphPointCloudStrength: HTMLInputElement | null,
    morphPointCloudGlowStrength: HTMLInputElement | null,
    morphPointCloudOpacity: HTMLInputElement | null,
    morphPointCloudDensity: HTMLInputElement | null,
    morphPointCloudScatterDistance: HTMLInputElement | null,
    morphPointCloudTint: HTMLInputElement | null,
    wobbleAmp: HTMLInputElement | null,
    wobbleFreq: HTMLInputElement | null,
    wobbleBounce: HTMLInputElement | null,
    wobbleStretch: HTMLInputElement | null,
    wobbleAnchorLiftPct: HTMLInputElement | null,
    wobbleHaloEnabled: HTMLInputElement | null,
    wobbleHaloColor: HTMLInputElement | null
): Record<string, unknown> {
    if (type === MORPH_TYPE) {
        const keyframeEntityIds = [...(global.state.assetEffectsMorphKeyframeIds ?? [])];
        const manualUrls = parseManualMorphUrls(morphUrls);
        const ep: Record<string, unknown> = { keyframeEntityIds };
        if (manualUrls.length >= 2) {
            ep.keyframeUrls = manualUrls;
        }
        const seg = morphSeg ? Number(morphSeg.value) : NaN;
        if (!Number.isNaN(seg) && seg > 0) {
            ep.segmentDuration = seg;
        }
        if (morphLoop) {
            ep.loop = morphLoop.checked;
        }
        if (morphPointCloudEffect) {
            ep.morphPointCloudEffect = morphPointCloudEffect.checked;
        }
        if (morphPointCloudPointSize) {
            const v = Number(morphPointCloudPointSize.value);
            if (!Number.isNaN(v) && v > 0) ep.morphPointCloudPointSize = v;
        }
        if (morphPointCloudStrength) {
            const v = Number(morphPointCloudStrength.value);
            if (!Number.isNaN(v)) ep.morphPointCloudStrength = v;
        }
        if (morphPointCloudGlowStrength) {
            const v = Number(morphPointCloudGlowStrength.value);
            if (!Number.isNaN(v)) ep.morphPointCloudGlowStrength = v;
        }
        if (morphPointCloudOpacity) {
            const v = Number(morphPointCloudOpacity.value);
            if (!Number.isNaN(v)) ep.morphPointCloudOpacity = v;
        }
        if (morphPointCloudDensity) {
            const v = Number(morphPointCloudDensity.value);
            if (!Number.isNaN(v)) ep.morphPointCloudDensity = v;
        }
        if (morphPointCloudScatterDistance) {
            const v = Number(morphPointCloudScatterDistance.value);
            if (!Number.isNaN(v) && v > 0) ep.morphPointCloudScatterDistance = v;
        }
        if (morphPointCloudTint) {
            const rgb = hexToRgb01(morphPointCloudTint.value);
            if (rgb) {
                ep.morphPointCloudTint = rgb;
            }
        }
        return ep;
    }
    const entityId = global.state.selectedSceneEntityId;
    const ep: Record<string, unknown> = {};
    if (typeof entityId === 'string' && entityId.length > 0) {
        ep.entityId = entityId;
    }
    if (wobbleAmp) {
        const v = Number(wobbleAmp.value);
        if (!Number.isNaN(v)) ep.amplitude = v;
    }
    if (wobbleFreq) {
        const v = Number(wobbleFreq.value);
        if (!Number.isNaN(v)) ep.frequency = v;
    }
    if (wobbleBounce) {
        const v = Number(wobbleBounce.value);
        if (!Number.isNaN(v)) ep.bounceAmplitude = v;
    }
    if (wobbleStretch) {
        const v = Number(wobbleStretch.value);
        if (!Number.isNaN(v)) ep.bounceStretch = v;
    }
    if (wobbleAnchorLiftPct) {
        const pct = Number(wobbleAnchorLiftPct.value);
        if (!Number.isNaN(pct)) {
            ep.wobbleAnchorLift = Math.min(1, Math.max(0, pct / 100));
        }
    }
    const haloOn = wobbleHaloEnabled?.checked !== false;
    ep.colorMix = haloOn ? 1 : 0;
    if (haloOn && wobbleHaloColor) {
        const rgb = hexToRgb01(wobbleHaloColor.value);
        if (rgb) {
            ep.goldColor = rgb;
        }
    }
    return ep;
}

function fillDomFromEffectParams(
    global: Global,
    type: string,
    ep: Record<string, unknown> | undefined,
    morphUrls: HTMLTextAreaElement | null,
    morphSeg: HTMLInputElement | null,
    morphLoop: HTMLInputElement | null,
    morphPointCloudEffect: HTMLInputElement | null,
    morphPointCloudPointSize: HTMLInputElement | null,
    morphPointCloudStrength: HTMLInputElement | null,
    morphPointCloudGlowStrength: HTMLInputElement | null,
    morphPointCloudOpacity: HTMLInputElement | null,
    morphPointCloudDensity: HTMLInputElement | null,
    morphPointCloudScatterDistance: HTMLInputElement | null,
    morphPointCloudTint: HTMLInputElement | null,
    wobbleAmp: HTMLInputElement | null,
    wobbleFreq: HTMLInputElement | null,
    wobbleBounce: HTMLInputElement | null,
    wobbleStretch: HTMLInputElement | null,
    wobbleAnchorLiftPct: HTMLInputElement | null,
    wobbleHaloEnabled: HTMLInputElement | null,
    wobbleHaloColor: HTMLInputElement | null
) {
    if (type === MORPH_TYPE) {
        const ids = ep?.keyframeEntityIds ?? ep?.keyframeTargetIds;
        if (Array.isArray(ids) && ids.every((id) => typeof id === 'string')) {
            global.state.assetEffectsMorphKeyframeIds = ids as string[];
        } else {
            global.state.assetEffectsMorphKeyframeIds = [];
        }
        const urls = ep?.keyframeUrls;
        if (morphUrls && Array.isArray(urls)) {
            morphUrls.value = urls.filter((u) => typeof u === 'string').join('\n');
        }
        if (morphSeg && typeof ep?.segmentDuration === 'number') {
            morphSeg.value = String(ep.segmentDuration);
        }
        if (morphLoop) {
            morphLoop.checked = typeof ep?.loop === 'boolean' ? ep.loop : true;
        }
        if (morphPointCloudEffect) {
            morphPointCloudEffect.checked = typeof ep?.morphPointCloudEffect === 'boolean' ? ep.morphPointCloudEffect : true;
        }
        if (morphPointCloudPointSize) {
            morphPointCloudPointSize.value = String(
                typeof ep?.morphPointCloudPointSize === 'number'
                    ? ep.morphPointCloudPointSize
                    : DEFAULT_MORPH_POINT_CLOUD_POINT_SIZE
            );
        }
        if (morphPointCloudStrength) {
            morphPointCloudStrength.value = String(
                typeof ep?.morphPointCloudStrength === 'number' ? ep.morphPointCloudStrength : 1.5
            );
        }
        if (morphPointCloudGlowStrength) {
            morphPointCloudGlowStrength.value = String(
                typeof ep?.morphPointCloudGlowStrength === 'number' ? ep.morphPointCloudGlowStrength : 1.7
            );
        }
        if (morphPointCloudOpacity) {
            morphPointCloudOpacity.value = String(
                typeof ep?.morphPointCloudOpacity === 'number' ? ep.morphPointCloudOpacity : 0.88
            );
        }
        if (morphPointCloudDensity) {
            morphPointCloudDensity.value = String(
                typeof ep?.morphPointCloudDensity === 'number' ? ep.morphPointCloudDensity : 0.32
            );
        }
        if (morphPointCloudScatterDistance) {
            morphPointCloudScatterDistance.value = String(
                typeof ep?.morphPointCloudScatterDistance === 'number' ? ep.morphPointCloudScatterDistance : 0
            );
        }
        if (morphPointCloudTint) {
            const tint = ep?.morphPointCloudTint;
            morphPointCloudTint.value =
                Array.isArray(tint) && tint.length === 3 && tint.every((n) => typeof n === 'number')
                    ? rgb01ToHex(tint as [number, number, number])
                    : rgb01ToHex(DEFAULT_MORPH_POINT_CLOUD_TINT_RGB);
        }
        return;
    }
    if (wobbleAmp && typeof ep?.amplitude === 'number') wobbleAmp.value = String(ep.amplitude);
    if (wobbleFreq && typeof ep?.frequency === 'number') wobbleFreq.value = String(ep.frequency);
    if (wobbleBounce && typeof ep?.bounceAmplitude === 'number') wobbleBounce.value = String(ep.bounceAmplitude);
    if (wobbleStretch && typeof ep?.bounceStretch === 'number') {
        wobbleStretch.value = String(ep.bounceStretch);
    }
    if (wobbleAnchorLiftPct) {
        const lift =
            typeof ep?.wobbleAnchorLift === 'number'
                ? ep.wobbleAnchorLift
                : typeof ep?.anchorLift === 'number'
                  ? ep.anchorLift
                  : 0.15;
        wobbleAnchorLiftPct.value = String(Math.round(Math.min(1, Math.max(0, lift)) * 100));
    }
    if (wobbleHaloEnabled) {
        const mix = ep?.colorMix;
        wobbleHaloEnabled.checked = typeof mix !== 'number' || mix > 0;
    }
    if (wobbleHaloColor) {
        const gold = ep?.goldColor;
        if (Array.isArray(gold) && gold.length === 3 && gold.every((n) => typeof n === 'number')) {
            wobbleHaloColor.value = rgb01ToHex(gold as [number, number, number]);
        } else {
            wobbleHaloColor.value = rgb01ToHex(DEFAULT_WOBBLE_HALO_RGB);
        }
    }
}

const MORPH_ENTITY_HINT =
    'GS变形（internal 调试）：列表点选 Gaussian → 写入 <code>keyframeEntityIds</code>；bridge 直接传同字段。配置键为当前 <code>targetId</code>。';
const WOBBLE_ENTITY_HINT =
    '静物活化：对当前选中 Gaussian 写入 <code>entityId</code> 并播放；bridge 在 <code>effectParams.entityId</code> 传入场景 Entity id。';

/**
 * 初始化物体 VFX 面板：挂载到 `#assetEffectsPanelContainer`（与场景 VFX 并列的子面板）。
 */
export function initAssetEffectsUI(global: Global): () => void {
    const container = document.getElementById('assetEffectsPanelContainer');
    if (!container) {
        return () => {};
    }

    container.innerHTML = ASSET_EFFECTS_PANEL_HTML;
    const fieldset = container.querySelector('#assetEffectsFieldset');
    if (!fieldset) {
        return () => {};
    }

    let effectsDebugTimer: ReturnType<typeof setInterval> | undefined;
    let effectsDebugEl: HTMLPreElement | null = null;
    if (typeof location !== 'undefined' && new URLSearchParams(location.search).get('effectsDebug') === '1') {
        effectsDebugEl = document.createElement('pre');
        effectsDebugEl.id = 'assetEffectsDebugStrip';
        effectsDebugEl.style.cssText =
            'font-size:10px;opacity:0.88;max-height:120px;overflow:auto;margin:8px 0 0;padding:8px;' +
            'background:rgba(0,0,0,0.35);border-radius:6px;white-space:pre-wrap;word-break:break-all';
        effectsDebugEl.title = '?effectsDebug=1 — asset runtime + settings.effects.asset';
        fieldset.appendChild(effectsDebugEl);
        const tick = () => {
            const snap = {
                assetRuntime: global.state.effectsRuntimeState?.asset,
                assetSettings: global.settings?.effects?.asset
            };
            effectsDebugEl!.textContent = JSON.stringify(snap, null, 2);
        };
        tick();
        effectsDebugTimer = setInterval(tick, 500);
    }

    const entityHint = fieldset.querySelector('#assetEffectEntityHint');
    const entityRow = fieldset.querySelector('#assetEffectEntityRow') as HTMLElement | null;
    const entityLabel = fieldset.querySelector('#assetEffectEntityLabel');
    const targetLabel = fieldset.querySelector('#assetEffectTargetLabel');
    const typeSelect = fieldset.querySelector('#assetEffectType') as HTMLSelectElement | null;
    const morphBlock = fieldset.querySelector('#assetMorphParams') as HTMLElement | null;
    const wobbleBlock = fieldset.querySelector('#assetWobbleParams') as HTMLElement | null;
    const morphKeyframeList = fieldset.querySelector('#assetMorphKeyframeList') as HTMLOListElement | null;
    const morphKeyframeEmpty = fieldset.querySelector('#assetMorphKeyframeEmpty') as HTMLElement | null;
    const morphUrls = fieldset.querySelector('#assetMorphKeyframeUrls') as HTMLTextAreaElement | null;
    const morphSeg = fieldset.querySelector('#assetMorphSegmentDuration') as HTMLInputElement | null;
    const morphLoop = fieldset.querySelector('#assetMorphLoop') as HTMLInputElement | null;
    const morphPointCloudEffect = fieldset.querySelector('#assetMorphPointCloudEffect') as HTMLInputElement | null;
    const morphPointCloudPointSize = fieldset.querySelector('#assetMorphPointCloudPointSize') as HTMLInputElement | null;
    const morphPointCloudStrength = fieldset.querySelector('#assetMorphPointCloudStrength') as HTMLInputElement | null;
    const morphPointCloudGlowStrength = fieldset.querySelector('#assetMorphPointCloudGlowStrength') as HTMLInputElement | null;
    const morphPointCloudOpacity = fieldset.querySelector('#assetMorphPointCloudOpacity') as HTMLInputElement | null;
    const morphPointCloudDensity = fieldset.querySelector('#assetMorphPointCloudDensity') as HTMLInputElement | null;
    const morphPointCloudScatterDistance = fieldset.querySelector('#assetMorphPointCloudScatterDistance') as HTMLInputElement | null;
    const morphPointCloudTint = fieldset.querySelector('#assetMorphPointCloudTint') as HTMLInputElement | null;
    const morphPointCloudPointSizeVal = fieldset.querySelector('#assetMorphPointCloudPointSizeVal') as HTMLElement | null;
    const morphPointCloudStrengthVal = fieldset.querySelector('#assetMorphPointCloudStrengthVal') as HTMLElement | null;
    const morphPointCloudGlowStrengthVal = fieldset.querySelector('#assetMorphPointCloudGlowStrengthVal') as HTMLElement | null;
    const morphPointCloudOpacityVal = fieldset.querySelector('#assetMorphPointCloudOpacityVal') as HTMLElement | null;
    const morphPointCloudDensityVal = fieldset.querySelector('#assetMorphPointCloudDensityVal') as HTMLElement | null;
    const morphPointCloudScatterDistanceVal = fieldset.querySelector('#assetMorphPointCloudScatterDistanceVal') as HTMLElement | null;
    const wobbleAmp = fieldset.querySelector('#assetWobbleAmplitude') as HTMLInputElement | null;
    const wobbleFreq = fieldset.querySelector('#assetWobbleFrequency') as HTMLInputElement | null;
    const wobbleBounce = fieldset.querySelector('#assetWobbleBounceAmplitude') as HTMLInputElement | null;
    const wobbleStretch = fieldset.querySelector('#assetWobbleBounceStretch') as HTMLInputElement | null;
    const wobbleAnchorLiftPct = fieldset.querySelector('#assetWobbleAnchorLiftPct') as HTMLInputElement | null;
    const wobbleAmpVal = fieldset.querySelector('#assetWobbleAmplitudeVal');
    const wobbleFreqVal = fieldset.querySelector('#assetWobbleFrequencyVal');
    const wobbleBounceVal = fieldset.querySelector('#assetWobbleBounceAmplitudeVal');
    const wobbleStretchVal = fieldset.querySelector('#assetWobbleBounceStretchVal');
    const wobbleAnchorLiftPctVal = fieldset.querySelector('#assetWobbleAnchorLiftPctVal');
    const wobbleHaloEnabled = fieldset.querySelector('#assetWobbleHaloEnabled') as HTMLInputElement | null;
    const wobbleHaloColor = fieldset.querySelector('#assetWobbleHaloColor') as HTMLInputElement | null;
    const wobbleHaloColorRow = fieldset.querySelector('#assetWobbleHaloColorRow') as HTMLElement | null;

    const syncWobbleHaloUi = () => {
        const on = wobbleHaloEnabled?.checked !== false;
        if (wobbleHaloColor) {
            wobbleHaloColor.disabled = !on;
        }
        if (wobbleHaloColorRow) {
            wobbleHaloColorRow.style.opacity = on ? '1' : '0.45';
        }
    };
    const btnMorphAdd = fieldset.querySelector('#assetMorphAddFromSelection');
    const btnMorphRemoveLast = fieldset.querySelector('#assetMorphRemoveLast');
    const btnMorphMoveUp = fieldset.querySelector('#assetMorphMoveUp');
    const btnMorphMoveDown = fieldset.querySelector('#assetMorphMoveDown');
    const btnMorphClear = fieldset.querySelector('#assetMorphClearKeyframes');
    const btnStart = fieldset.querySelector('#assetEffectStart');
    const btnStop = fieldset.querySelector('#assetEffectStop');
    const statusEl = fieldset.querySelector('#assetEffectStatus');

    const { events } = global;

    const routeAssetCommand = (
        cmd: 'EFFECT_START' | 'EFFECT_STOP' | 'EFFECT_PARAMS_PATCH',
        targetId: string,
        type: string,
        effectParams?: Record<string, unknown>
    ) => {
        const envelope = {
            effectId: ASSET_GSPLAT_EFFECT_ID,
            targetId,
            params: { type, effectParams }
        };
        if (getEditUiTransport(global) === 'message-bridge') {
            sendEditProtocolMessage({ type: cmd, module: 'effects', ...envelope });
        } else if (
            !dispatchEffectsModuleCommand(global, {
                type: cmd,
                payload: envelope,
                source: 'host'
            })
        ) {
            console.warn('[asset-effects-ui] command dispatch failed', cmd);
        }
    };

    const pushHistorySafe = () => {
        if ((global.state as { editMode?: boolean }).editMode) {
            pushEditHistory(global, 'asset effect');
        }
    };

    const renderMorphKeyframeList = () => {
        const ids = global.state.assetEffectsMorphKeyframeIds ?? [];
        if (morphKeyframeEmpty) {
            morphKeyframeEmpty.style.display = ids.length > 0 ? 'none' : 'block';
        }
        if (!morphKeyframeList) {
            return;
        }
        morphKeyframeList.innerHTML = '';
        ids.forEach((id, index) => {
            const placed = getScenePlacedItemByTargetId(global, id);
            const li = document.createElement('li');
            const name = placed?.name || id;
            const urlOk = !!resolvePlacedGaussianSourceUrl(global, id);
            li.textContent = `${index + 1}. ${name}${urlOk ? '' : '（无 URL）'}`;
            if (!urlOk) {
                li.style.color = 'rgba(255,180,120,0.95)';
            }
            morphKeyframeList.appendChild(li);
        });
    };

    const setMorphKeyframeIds = (ids: string[], patchSettings: boolean) => {
        global.state.assetEffectsMorphKeyframeIds = [...ids];
        renderMorphKeyframeList();
        events.fire('assetEffect:morphKeyframesChanged', { ids: global.state.assetEffectsMorphKeyframeIds });
        if (patchSettings) {
            const configId = getSelectedTargetId(global);
            if (configId && typeSelect?.value === MORPH_TYPE) {
                routeAssetCommand(
                    'EFFECT_PARAMS_PATCH',
                    configId,
                    MORPH_TYPE,
                    readEffectParamsFromDom(
                        global,
                        MORPH_TYPE,
                        morphUrls,
                        morphSeg,
                        morphLoop,
                        morphPointCloudEffect,
                        morphPointCloudPointSize,
                        morphPointCloudStrength,
                        morphPointCloudGlowStrength,
                        morphPointCloudOpacity,
                        morphPointCloudDensity,
                        morphPointCloudScatterDistance,
                        morphPointCloudTint,
                        wobbleAmp,
                        wobbleFreq,
                        wobbleBounce,
                        wobbleStretch,
                        wobbleAnchorLiftPct,
                        wobbleHaloEnabled,
                        wobbleHaloColor
                    )
                );
                pushHistorySafe();
            }
        }
    };

    const syncTypePanels = () => {
        const t = typeSelect?.value ?? MORPH_TYPE;
        global.state.assetEffectUiSubtype = t;
        morphBlock?.classList.toggle('hidden', t !== MORPH_TYPE);
        wobbleBlock?.classList.toggle('hidden', t !== WOBBLE_TYPE);
        if (entityHint) {
            entityHint.innerHTML = t === WOBBLE_TYPE ? WOBBLE_ENTITY_HINT : MORPH_ENTITY_HINT;
        }
        entityRow?.classList.toggle('hidden', t !== WOBBLE_TYPE);
        if (t === MORPH_TYPE) {
            renderMorphKeyframeList();
            events.fire('assetEffect:morphKeyframesChanged', {
                ids: global.state.assetEffectsMorphKeyframeIds ?? []
            });
        }
    };

    const refreshStatus = () => {
        const targetId = getSelectedTargetId(global);
        if (!statusEl) {
            return;
        }
        if (!targetId) {
            statusEl.textContent = '状态: 请先选中场景资产';
            return;
        }
        const runtime = global.state.effectsRuntimeState?.asset?.instances?.[targetId];
        const inst = readAssetInstanceParams(global.settings, targetId);
        const label = ASSET_EFFECT_LABEL[inst?.type ?? runtime?.activeType ?? ''] ?? inst?.type ?? '—';
        const st = runtime?.status ?? 'inactive';
        statusEl.textContent = `状态: ${label} / ${st}`;
    };

    const refreshTargetLabel = () => {
        const targetId = getSelectedTargetId(global);
        const placed = targetId ? getScenePlacedItemByTargetId(global, targetId) : getSelectedScenePlacedItem(global.state);
        if (targetLabel) {
            if (!placed) {
                targetLabel.textContent = targetId ? targetId : '（未选中 — 请在上方场景资产列表点击）';
            } else {
                const gauss = placed.assetType === 'gaussian' ? ' · Gaussian' : placed.assetType ? ` · ${placed.assetType}` : '';
                targetLabel.textContent = `${placed.name || placed.id}${gauss}`;
            }
        }
        if (entityLabel) {
            const t = typeSelect?.value ?? MORPH_TYPE;
            if (t !== WOBBLE_TYPE) {
                entityLabel.textContent = '—';
            } else if (!placed?.entity) {
                entityLabel.textContent = '（无已放置 Entity）';
            } else {
                const ent = placed.entity;
                const name = ent.name?.trim() || placed.id || 'Entity';
                const ok = placed.assetType === 'gaussian' && !!ent.gsplat;
                entityLabel.textContent = ok ? `${name} ✓ gsplat` : `${name}（非 Gaussian / 无 gsplat）`;
            }
        }
        if (targetId && typeSelect) {
            const inst = readAssetInstanceParams(global.settings, targetId);
            if (inst?.type && (ASSET_EFFECT_TYPE_VALUES as readonly string[]).includes(inst.type)) {
                typeSelect.value = inst.type;
            }
            fillDomFromEffectParams(
                global,
                typeSelect.value,
                inst?.effectParams,
                morphUrls,
                morphSeg,
                morphLoop,
                morphPointCloudEffect,
                morphPointCloudPointSize,
                morphPointCloudStrength,
                morphPointCloudGlowStrength,
                morphPointCloudOpacity,
                morphPointCloudDensity,
                morphPointCloudScatterDistance,
                morphPointCloudTint,
                wobbleAmp,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor
            );
            syncWobbleHaloUi();
            syncMorphPointCloudLabels();
            syncWobbleSliderLabels();
            renderMorphKeyframeList();
        }
        syncTypePanels();
        refreshStatus();
    };

    const onTypeChange = () => {
        syncTypePanels();
        const targetId = getSelectedTargetId(global);
        if (!targetId || !typeSelect) {
            return;
        }
        patchEffectParams(true);
        refreshStatus();
    };

    const patchEffectParams = (commitHistory: boolean) => {
        const targetId = getSelectedTargetId(global);
        if (!targetId || !typeSelect) {
            return;
        }
        routeAssetCommand(
            'EFFECT_PARAMS_PATCH',
            targetId,
            typeSelect.value,
            readEffectParamsFromDom(
                global,
                typeSelect.value,
                morphUrls,
                morphSeg,
                morphLoop,
                morphPointCloudEffect,
                morphPointCloudPointSize,
                morphPointCloudStrength,
                morphPointCloudGlowStrength,
                morphPointCloudOpacity,
                morphPointCloudDensity,
                morphPointCloudScatterDistance,
                morphPointCloudTint,
                wobbleAmp,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor
            )
        );
        if (commitHistory) {
            pushHistorySafe();
        }
    };

    const onWobbleParamsLive = () => {
        if (typeSelect?.value !== WOBBLE_TYPE) {
            return;
        }
        patchEffectParams(false);
    };

    const onMorphParamsLive = () => {
        if (typeSelect?.value !== MORPH_TYPE) {
            return;
        }
        patchEffectParams(false);
    };

    const onParamsBlur = () => {
        patchEffectParams(true);
    };

    const syncMorphPointCloudLabels = () => {
        if (morphPointCloudPointSize && morphPointCloudPointSizeVal) {
            morphPointCloudPointSizeVal.textContent = formatSliderValue(Number(morphPointCloudPointSize.value), 3);
        }
        if (morphPointCloudStrength && morphPointCloudStrengthVal) {
            morphPointCloudStrengthVal.textContent = formatSliderValue(Number(morphPointCloudStrength.value), 2);
        }
        if (morphPointCloudGlowStrength && morphPointCloudGlowStrengthVal) {
            morphPointCloudGlowStrengthVal.textContent = formatSliderValue(Number(morphPointCloudGlowStrength.value), 2);
        }
        if (morphPointCloudOpacity && morphPointCloudOpacityVal) {
            morphPointCloudOpacityVal.textContent = formatSliderValue(Number(morphPointCloudOpacity.value), 2);
        }
        if (morphPointCloudDensity && morphPointCloudDensityVal) {
            morphPointCloudDensityVal.textContent = formatSliderValue(Number(morphPointCloudDensity.value), 2);
        }
        if (morphPointCloudScatterDistance && morphPointCloudScatterDistanceVal) {
            const v = Number(morphPointCloudScatterDistance.value);
            morphPointCloudScatterDistanceVal.textContent = v > 0 ? formatSliderValue(v, 2) : '自动';
        }
    };

    const syncWobbleSliderLabels = () => {
        if (wobbleAmp && wobbleAmpVal) {
            wobbleAmpVal.textContent = formatSliderValue(Number(wobbleAmp.value), 2);
        }
        if (wobbleFreq && wobbleFreqVal) {
            wobbleFreqVal.textContent = formatSliderValue(Number(wobbleFreq.value), 1);
        }
        if (wobbleBounce && wobbleBounceVal) {
            wobbleBounceVal.textContent = formatSliderValue(Number(wobbleBounce.value), 1);
        }
        if (wobbleStretch && wobbleStretchVal) {
            wobbleStretchVal.textContent = formatSliderValue(Number(wobbleStretch.value), 2);
        }
        if (wobbleAnchorLiftPct && wobbleAnchorLiftPctVal) {
            wobbleAnchorLiftPctVal.textContent = `${Math.round(Number(wobbleAnchorLiftPct.value))}%`;
        }
    };

    const appendMorphKeyframe = (entityId: string) => {
        const item = getScenePlacedItemByTargetId(global, entityId);
        if (!isPlacedGaussianItem(item)) {
            window.alert('仅支持已放置的 Gaussian（含 gsplat）资产');
            return;
        }
        if (!resolvePlacedGaussianSourceUrl(global, entityId)) {
            window.alert('该 Gaussian 没有可用的源 URL（放置时需带 url 或关联资产库条目）');
            return;
        }
        const ids = [...(global.state.assetEffectsMorphKeyframeIds ?? [])];
        if (!ids.includes(entityId)) {
            ids.push(entityId);
        }
        setMorphKeyframeIds(ids, true);
    };

    const onMorphAddFromSelection = () => {
        const targetId = getSelectedTargetId(global);
        if (!targetId) {
            window.alert('请先在上方场景资产列表中选中一个 Gaussian 资产');
            return;
        }
        appendMorphKeyframe(targetId);
    };

    const onMorphRemoveLast = () => {
        const ids = [...(global.state.assetEffectsMorphKeyframeIds ?? [])];
        if (ids.length === 0) {
            return;
        }
        ids.pop();
        setMorphKeyframeIds(ids, true);
    };

    const onMorphMoveUp = () => {
        const sel = getSelectedTargetId(global);
        const ids = [...(global.state.assetEffectsMorphKeyframeIds ?? [])];
        if (!sel) {
            return;
        }
        const idx = ids.indexOf(sel);
        if (idx <= 0) {
            return;
        }
        [ids[idx - 1], ids[idx]] = [ids[idx], ids[idx - 1]];
        setMorphKeyframeIds(ids, true);
    };

    const onMorphMoveDown = () => {
        const sel = getSelectedTargetId(global);
        const ids = [...(global.state.assetEffectsMorphKeyframeIds ?? [])];
        if (!sel) {
            return;
        }
        const idx = ids.indexOf(sel);
        if (idx < 0 || idx >= ids.length - 1) {
            return;
        }
        [ids[idx], ids[idx + 1]] = [ids[idx + 1], ids[idx]];
        setMorphKeyframeIds(ids, true);
    };

    const onMorphClear = () => {
        setMorphKeyframeIds([], true);
        if (morphUrls) {
            morphUrls.value = '';
        }
    };

    const onMorphKeyframesChanged = () => {
        renderMorphKeyframeList();
        const configId = getSelectedTargetId(global);
        if (!configId || typeSelect?.value !== MORPH_TYPE) {
            return;
        }
        routeAssetCommand(
            'EFFECT_PARAMS_PATCH',
            configId,
            MORPH_TYPE,
            readEffectParamsFromDom(
                global,
                MORPH_TYPE,
                morphUrls,
                morphSeg,
                morphLoop,
                morphPointCloudEffect,
                morphPointCloudPointSize,
                morphPointCloudStrength,
                morphPointCloudGlowStrength,
                morphPointCloudOpacity,
                morphPointCloudDensity,
                morphPointCloudScatterDistance,
                morphPointCloudTint,
                wobbleAmp,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor
            )
        );
    };

    const onStart = () => {
        const targetId = getSelectedTargetId(global);
        if (!targetId || !typeSelect) {
            window.alert('请先在上方场景资产列表中选中一个资产');
            return;
        }
        if (typeSelect.value === WOBBLE_TYPE) {
            const item = getScenePlacedItemByTargetId(global, targetId);
            if (!item || item.assetType !== 'gaussian' || !item.entity?.gsplat) {
                window.alert('静物活化需要已放置的 Gaussian（gsplat）资产');
                return;
            }
        }
        if (typeSelect.value === MORPH_TYPE) {
            const ep = readEffectParamsFromDom(
                global,
                MORPH_TYPE,
                morphUrls,
                morphSeg,
                morphLoop,
                morphPointCloudEffect,
                morphPointCloudPointSize,
                morphPointCloudStrength,
                morphPointCloudGlowStrength,
                morphPointCloudOpacity,
                morphPointCloudDensity,
                morphPointCloudScatterDistance,
                morphPointCloudTint,
                wobbleAmp,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor
            );
            const ids = ep.keyframeEntityIds ?? ep.keyframeTargetIds;
            const urls = ep.keyframeUrls;
            const hasSceneKeyframes =
                Array.isArray(ids) && ids.length >= 2 && ids.every((id) => typeof id === 'string');
            const hasManualUrls = Array.isArray(urls) && urls.length >= 2;
            if (!hasSceneKeyframes && !hasManualUrls) {
                window.alert('GS变形需要至少 2 个关键帧：在上方场景资产列表点击 Gaussian，或使用高级 URL');
                return;
            }
            if (hasSceneKeyframes) {
                for (const id of ids as string[]) {
                    if (!resolvePlacedGaussianSourceUrl(global, id)) {
                        window.alert(`关键帧「${getScenePlacedItemByTargetId(global, id)?.name ?? id}」无法解析 GS 源 URL`);
                        return;
                    }
                }
            }
        }
        routeAssetCommand(
            'EFFECT_START',
            targetId,
            typeSelect.value,
            readEffectParamsFromDom(
                global,
                typeSelect.value,
                morphUrls,
                morphSeg,
                morphLoop,
                morphPointCloudEffect,
                morphPointCloudPointSize,
                morphPointCloudStrength,
                morphPointCloudGlowStrength,
                morphPointCloudOpacity,
                morphPointCloudDensity,
                morphPointCloudScatterDistance,
                morphPointCloudTint,
                wobbleAmp,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor
            )
        );
        refreshStatus();
    };

    const onStop = () => {
        const targetId = getSelectedTargetId(global);
        if (!targetId || !typeSelect) {
            return;
        }
        routeAssetCommand('EFFECT_STOP', targetId, typeSelect.value);
        refreshStatus();
    };

    typeSelect?.addEventListener('change', onTypeChange);
    btnMorphAdd?.addEventListener('click', onMorphAddFromSelection);
    btnMorphRemoveLast?.addEventListener('click', onMorphRemoveLast);
    btnMorphMoveUp?.addEventListener('click', onMorphMoveUp);
    btnMorphMoveDown?.addEventListener('click', onMorphMoveDown);
    btnMorphClear?.addEventListener('click', onMorphClear);
    morphUrls?.addEventListener('change', onParamsBlur);
    morphSeg?.addEventListener('change', onParamsBlur);
    morphLoop?.addEventListener('change', onParamsBlur);
    morphPointCloudEffect?.addEventListener('change', onParamsBlur);
    morphPointCloudTint?.addEventListener('input', onMorphParamsLive);
    morphPointCloudTint?.addEventListener('change', onParamsBlur);
    const unbindMorphSliders: Array<() => void> = [];
    if (morphPointCloudPointSize) {
        unbindMorphSliders.push(bindSliderLive(morphPointCloudPointSize, morphPointCloudPointSizeVal, 3, onMorphParamsLive, onParamsBlur));
    }
    if (morphPointCloudStrength) {
        unbindMorphSliders.push(bindSliderLive(morphPointCloudStrength, morphPointCloudStrengthVal, 2, onMorphParamsLive, onParamsBlur));
    }
    if (morphPointCloudGlowStrength) {
        unbindMorphSliders.push(bindSliderLive(morphPointCloudGlowStrength, morphPointCloudGlowStrengthVal, 2, onMorphParamsLive, onParamsBlur));
    }
    if (morphPointCloudOpacity) {
        unbindMorphSliders.push(bindSliderLive(morphPointCloudOpacity, morphPointCloudOpacityVal, 2, onMorphParamsLive, onParamsBlur));
    }
    if (morphPointCloudDensity) {
        unbindMorphSliders.push(bindSliderLive(morphPointCloudDensity, morphPointCloudDensityVal, 2, onMorphParamsLive, onParamsBlur));
    }
    if (morphPointCloudScatterDistance) {
        unbindMorphSliders.push(bindSliderLive(morphPointCloudScatterDistance, morphPointCloudScatterDistanceVal, 2, onMorphParamsLive, onParamsBlur));
    }
    const unbindWobbleSliders: Array<() => void> = [];
    if (wobbleAmp) {
        unbindWobbleSliders.push(bindSliderLive(wobbleAmp, wobbleAmpVal, 2, onWobbleParamsLive, onParamsBlur));
    }
    if (wobbleFreq) {
        unbindWobbleSliders.push(bindSliderLive(wobbleFreq, wobbleFreqVal, 1, onWobbleParamsLive, onParamsBlur));
    }
    if (wobbleBounce) {
        unbindWobbleSliders.push(bindSliderLive(wobbleBounce, wobbleBounceVal, 1, onWobbleParamsLive, onParamsBlur));
    }
    if (wobbleStretch) {
        unbindWobbleSliders.push(bindSliderLive(wobbleStretch, wobbleStretchVal, 2, onWobbleParamsLive, onParamsBlur));
    }
    if (wobbleAnchorLiftPct) {
        const syncAnchorLiftPctLabel = () => {
            if (wobbleAnchorLiftPctVal) {
                wobbleAnchorLiftPctVal.textContent = `${Math.round(Number(wobbleAnchorLiftPct.value))}%`;
            }
        };
        const onAnchorLiftInput = () => {
            syncAnchorLiftPctLabel();
            onWobbleParamsLive();
        };
        const onAnchorLiftChange = () => {
            syncAnchorLiftPctLabel();
            onParamsBlur();
        };
        wobbleAnchorLiftPct.addEventListener('input', onAnchorLiftInput);
        wobbleAnchorLiftPct.addEventListener('change', onAnchorLiftChange);
        syncAnchorLiftPctLabel();
        unbindWobbleSliders.push(() => {
            wobbleAnchorLiftPct.removeEventListener('input', onAnchorLiftInput);
            wobbleAnchorLiftPct.removeEventListener('change', onAnchorLiftChange);
        });
    }
    const onHaloEnabledChange = () => {
        syncWobbleHaloUi();
        onWobbleParamsLive();
    };
    const onHaloColorLive = () => {
        if (typeSelect?.value === WOBBLE_TYPE) {
            onWobbleParamsLive();
        } else {
            onParamsBlur();
        }
    };
    wobbleHaloEnabled?.addEventListener('change', onHaloEnabledChange);
    wobbleHaloColor?.addEventListener('input', onHaloColorLive);
    wobbleHaloColor?.addEventListener('change', onParamsBlur);
    btnStart?.addEventListener('click', onStart);
    btnStop?.addEventListener('click', onStop);

    const onSelectionChanged = () => refreshTargetLabel();
    events.on('sceneAsset:selected', onSelectionChanged);
    events.on('assetEffect:started', refreshStatus);
    events.on('assetEffect:stopped', refreshStatus);
    events.on('assetEffect:error', refreshStatus);
    events.on('assetEffect:configChanged', refreshStatus);
    events.on('assetEffect:morphKeyframesChanged', onMorphKeyframesChanged);

    syncWobbleHaloUi();
    syncMorphPointCloudLabels();
    refreshTargetLabel();

    return () => {
        if (effectsDebugTimer !== undefined) {
            clearInterval(effectsDebugTimer);
        }
        effectsDebugEl?.remove();
        container.replaceChildren();
        typeSelect?.removeEventListener('change', onTypeChange);
        btnMorphAdd?.removeEventListener('click', onMorphAddFromSelection);
        btnMorphRemoveLast?.removeEventListener('click', onMorphRemoveLast);
        btnMorphMoveUp?.removeEventListener('click', onMorphMoveUp);
        btnMorphMoveDown?.removeEventListener('click', onMorphMoveDown);
        btnMorphClear?.removeEventListener('click', onMorphClear);
        morphUrls?.removeEventListener('change', onParamsBlur);
        morphSeg?.removeEventListener('change', onParamsBlur);
        morphLoop?.removeEventListener('change', onParamsBlur);
        morphPointCloudEffect?.removeEventListener('change', onParamsBlur);
        morphPointCloudTint?.removeEventListener('input', onMorphParamsLive);
        morphPointCloudTint?.removeEventListener('change', onParamsBlur);
        unbindMorphSliders.forEach((fn) => fn());
        unbindWobbleSliders.forEach((fn) => fn());
        wobbleHaloEnabled?.removeEventListener('change', onHaloEnabledChange);
        wobbleHaloColor?.removeEventListener('input', onHaloColorLive);
        wobbleHaloColor?.removeEventListener('change', onParamsBlur);
        btnStart?.removeEventListener('click', onStart);
        btnStop?.removeEventListener('click', onStop);
        events.off('sceneAsset:selected', onSelectionChanged);
        events.off('assetEffect:started', refreshStatus);
        events.off('assetEffect:stopped', refreshStatus);
        events.off('assetEffect:error', refreshStatus);
        events.off('assetEffect:configChanged', refreshStatus);
        events.off('assetEffect:morphKeyframesChanged', onMorphKeyframesChanged);
        global.state.assetEffectUiSubtype = null;
        global.state.assetEffectsMorphKeyframeIds = [];
    };
}
