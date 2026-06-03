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
import {
    getDefaultWobbleEffectParams,
    mergeWobbleEffectParams
} from '../../vfx/effects-runtime/asset/wobble-effect-params';

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
      <input type="number" id="assetMorphSegmentDuration" class="settingsInput" min="0.1" max="120" step="0.1" value="10">
    </div>
    <div class="settingsRow">
      <label for="assetMorphLoop">循环:</label>
      <input type="checkbox" id="assetMorphLoop" class="settingsCheckbox" checked>
    </div>
    <details style="font-size:11px;margin:4px 0 6px" open>
      <summary style="cursor:pointer;opacity:0.8" title="控制 A→B 变形时各粒子起飞/到达的时间差">粒子飞行时序</summary>
      <p class="effectsTrackHint" style="font-size:10px;opacity:0.7;margin:0 0 6px">飞行窗口越小，相邻粒子间隔越大；配对错峰越大，越按配对顺序依次飞行。</p>
      <div class="settingsRow">
        <label for="assetMorphFlightWindow" class="postEffectLabel" title="单粒子在整段变形 globalT 上的飞行时长；越小则相邻粒子起飞间隔越大">飞行重叠窗口:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphFlightWindow" class="postEffectSlider" min="0.12" max="1" step="0.01" value="0.12">
          <span id="assetMorphFlightWindowVal" class="postEffectSliderValue">0.12</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="assetMorphFlightStagger" class="postEffectLabel" title="配对索引相位权重；越大越按配对顺序依次飞，越小越按空间位置（A 侧先散、B 侧先生）">配对错峰:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphFlightStagger" class="postEffectSlider" min="0" max="1" step="0.01" value="1">
          <span id="assetMorphFlightStaggerVal" class="postEffectSliderValue">1.00</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="assetMorphFlightEase" class="postEffectLabel" title="控制 A 消散 / B 生成的进度曲线（goneA、presentB）">飞行缓动:</label>
        <select id="assetMorphFlightEase" class="settingsSelect">
          <option value="smoothstep">smoothstep（默认）</option>
          <option value="linear">linear</option>
          <option value="easeIn">easeIn</option>
          <option value="easeOut">easeOut</option>
          <option value="easeInOut">easeInOut</option>
        </select>
      </div>
      <div class="settingsRow">
        <label for="assetMorphFlightPosEase" class="postEffectLabel" title="位置插值 posT 专用；选「同飞行缓动」则与上一项一致">位置缓动:</label>
        <select id="assetMorphFlightPosEase" class="settingsSelect">
          <option value="">同飞行缓动</option>
          <option value="smoothstep">smoothstep</option>
          <option value="linear">linear</option>
          <option value="easeIn">easeIn</option>
          <option value="easeOut">easeOut</option>
          <option value="easeInOut">easeInOut</option>
        </select>
      </div>
    </details>
    <details style="font-size:11px;margin:4px 0 6px" open>
      <summary style="cursor:pointer;opacity:0.8" title="v2：A→B 平放沙漏形 GS 通道">沙漏通道（变形中途）</summary>
      <p class="effectsTrackHint" style="font-size:10px;opacity:0.7;margin:0 0 6px">A 形体各点飞向 B；中间向轴线收束成细腰，两端保持原 GS 散开形状。</p>
      <div class="settingsRow">
        <label for="assetMorphPointCloudPointSize" class="postEffectLabel" title="通道段 splat 目标直径 = A→B 间距 × 该比例（0.2%～2%）；仅在变形中途通道生效">通道粒子/间距:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphPointCloudPointSize" class="postEffectSlider" min="0.002" max="0.02" step="0.001" value="0.006">
          <span id="assetMorphPointCloudPointSizeVal" class="postEffectSliderValue">0.6%</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="assetMorphPointCloudStrength" class="postEffectLabel" title="通道收束/扰动/粒子形态的总强度">通道贴合:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphPointCloudStrength" class="postEffectSlider" min="0" max="2" step="0.05" value="1">
          <span id="assetMorphPointCloudStrengthVal" class="postEffectSliderValue">1.00</span>
        </div>
      </div>
      <div class="settingsRow">
        <label for="assetMorphHourglassPerturb" class="postEffectLabel" title="通道飞行中的位移扰动 = A→B 间距 × 该比例">通道扰动幅度:</label>
        <div class="postEffectSliderWrap">
          <input type="range" id="assetMorphHourglassPerturb" class="postEffectSlider" min="0" max="0.15" step="0.002" value="0.048">
          <span id="assetMorphHourglassPerturbVal" class="postEffectSliderValue">4.8%</span>
        </div>
      </div>
    </details>
  </div>
  <div id="assetWobbleParams" class="assetEffectParamsBlock hidden">
    <p class="effectsTrackHint" style="font-size:11px;opacity:0.75;margin:0 0 6px">仅支持已放置的 <strong>Gaussian</strong> 资产；拖动滑条实时预览（需已播放）。</p>
    <div class="settingsRow" id="assetWobbleAmplitudeRow">
      <label for="assetWobbleAmplitude" id="assetWobbleAmplitudeLabel" class="postEffectLabel" title="统一幅度（默认 0.7）。扭动映射更柔和；摇头晃脑/瞌睡虫自动映射。">动作幅度:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleAmplitude" class="postEffectSlider" min="0" max="2" step="0.05" value="0.7">
        <span id="assetWobbleAmplitudeVal" class="postEffectSliderValue">0.70</span>
      </div>
    </div>
    <div class="settingsRow" id="assetWobbleAxisRow">
      <label for="assetWobbleAxis" class="postEffectLabel">变形轴:</label>
      <select id="assetWobbleAxis" class="settingsSelect">
        <option value="x">X轴</option>
        <option value="z">Z轴</option>
      </select>
    </div>
    <div class="settingsRow" id="assetWobbleMotionModeRow">
      <label for="assetWobbleMotionMode" class="postEffectLabel">动作模式:</label>
      <select id="assetWobbleMotionMode" class="settingsSelect">
        <option value="wobble">扭动</option>
        <option value="electronic">摇头晃脑</option>
        <option value="deepMeditation">瞌睡虫</option>
      </select>
    </div>
    <div class="settingsRow" id="assetWobbleFrequencyRow">
      <label for="assetWobbleFrequency" class="postEffectLabel">扭动频率:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleFrequency" class="postEffectSlider" min="0" max="30" step="0.5" value="5">
        <span id="assetWobbleFrequencyVal" class="postEffectSliderValue">5.0</span>
      </div>
    </div>
    <div class="settingsRow" id="assetWobbleAnchorLiftPctRow">
      <label for="assetWobbleAnchorLiftPct" class="postEffectLabel" title="扭动时从视觉底部向上、该比例高度内不横向扭动（高斯 Y 大=靠下）">底部固定高度:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleAnchorLiftPct" class="postEffectSlider" min="0" max="50" step="1" value="15">
        <span id="assetWobbleAnchorLiftPctVal" class="postEffectSliderValue">15%</span>
      </div>
    </div>
    <div class="settingsRow" id="assetWobbleBounceAmplitudeRow">
      <label for="assetWobbleBounceAmplitude" class="postEffectLabel" title="世界单位峰值高度，与物体大小无关">跳动高度:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleBounceAmplitude" class="postEffectSlider" min="0" max="3" step="0.05" value="0.6">
        <span id="assetWobbleBounceAmplitudeVal" class="postEffectSliderValue">0.60</span>
      </div>
    </div>
    <div class="settingsRow" id="assetWobbleBounceStretchRow">
      <label for="assetWobbleBounceStretch" class="postEffectLabel">Y轴拉伸:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleBounceStretch" class="postEffectSlider" min="0" max="1.5" step="0.05" value="0.75">
        <span id="assetWobbleBounceStretchVal" class="postEffectSliderValue">0.75</span>
      </div>
    </div>
    <div class="settingsRow" id="assetWobbleHaloEnabledRow">
      <label for="assetWobbleHaloEnabled">光圈:</label>
      <input type="checkbox" id="assetWobbleHaloEnabled" class="settingsCheckbox" checked>
      <span style="font-size:11px;opacity:0.75">开启辉光（关闭后仅保留跳动/扭动与拉伸）</span>
    </div>
    <div class="settingsRow" style="align-items:center;gap:8px" id="assetWobbleHaloColorRow">
      <label for="assetWobbleHaloColor">光圈颜色/透明度:</label>
      <input type="color" id="assetWobbleHaloColor" value="#ffd900" title="跳动/扭动时高斯辉光色调">
      <div class="postEffectSliderWrap" style="min-width:180px">
        <input type="range" id="assetWobbleHaloOpacity" class="postEffectSlider" min="0" max="1" step="0.01" value="1">
        <span id="assetWobbleHaloOpacityVal" class="postEffectSliderValue">1.00</span>
      </div>
    </div>
    <div class="settingsRow" id="assetWobbleHaloWidthRow">
      <label for="assetWobbleHaloWidth" class="postEffectLabel">光圈宽度:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleHaloWidth" class="postEffectSlider" min="0.01" max="1" step="0.01" value="0.1">
        <span id="assetWobbleHaloWidthVal" class="postEffectSliderValue">0.10</span>
      </div>
    </div>
    <div class="settingsRow" id="assetWobbleHaloSpeedRow">
      <label for="assetWobbleHaloSpeed" class="postEffectLabel">光圈速度:</label>
      <div class="postEffectSliderWrap">
        <input type="range" id="assetWobbleHaloSpeed" class="postEffectSlider" min="0" max="4" step="0.05" value="1">
        <span id="assetWobbleHaloSpeedVal" class="postEffectSliderValue">1.00</span>
      </div>
    </div>
  </div>
  <div class="settingsRow" style="gap:8px;margin-top:8px">
    <button id="assetEffectStart" class="settingsButton" type="button">播放物体特效</button>
    <button id="assetEffectStop" class="settingsButton" type="button">停止</button>
    <button id="assetEffectDelete" class="settingsButton" type="button">删除配置</button>
  </div>
  <div class="settingsRow">
    <span id="assetEffectStatus" style="font-size:11px;opacity:0.85">状态: —</span>
  </div>
</fieldset>
`.trim();

const DEFAULT_WOBBLE_HALO_RGB = getDefaultWobbleEffectParams('wobble').goldColor as [number, number, number];
const DEFAULT_MORPH_SEGMENT_DURATION = 10;
const DEFAULT_MORPH_FLIGHT_WINDOW = 0.12;
const DEFAULT_MORPH_FLIGHT_STAGGER = 1;
const DEFAULT_MORPH_FLIGHT_EASE = 'smoothstep';
const DEFAULT_MORPH_HOURGLASS_PARTICLE_SCALE_FRAC = 0.006;
const MORPH_FLIGHT_EASE_VALUES = ['linear', 'smoothstep', 'easeIn', 'easeOut', 'easeInOut'] as const;

function isMorphFlightEase(value: string): value is (typeof MORPH_FLIGHT_EASE_VALUES)[number] {
    return (MORPH_FLIGHT_EASE_VALUES as readonly string[]).includes(value);
}
/** 与 gsplat-morph-progressive-v2 DEFAULT_MORPH_HOURGLASS_SPARK_INTENSITY 一致。 */
const DEFAULT_MORPH_HOURGLASS_SPARK_INTENSITY = 0.048;
const DEFAULT_MORPH_HOURGLASS_PERTURB_AMP = 0.012;
const DEFAULT_MORPH_HOURGLASS_SPARK_DRIFT = 0.026;
const MORPH_HOURGLASS_PERTURB_AMP_RATIO =
    DEFAULT_MORPH_HOURGLASS_PERTURB_AMP / DEFAULT_MORPH_HOURGLASS_SPARK_INTENSITY;
const MORPH_HOURGLASS_SPARK_DRIFT_RATIO =
    DEFAULT_MORPH_HOURGLASS_SPARK_DRIFT / DEFAULT_MORPH_HOURGLASS_SPARK_INTENSITY;

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

function getMorphOwnerTargetId(global: Global): string | null {
    const ids = global.state.assetEffectsMorphKeyframeIds ?? [];
    const first = ids[0];
    return typeof first === 'string' && first.length > 0 ? first : getSelectedTargetId(global);
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
    morphFlightWindow: HTMLInputElement | null,
    morphFlightStagger: HTMLInputElement | null,
    morphFlightEase: HTMLSelectElement | null,
    morphFlightPosEase: HTMLSelectElement | null,
    morphChannelParticleScale: HTMLInputElement | null,
    morphChannelStrength: HTMLInputElement | null,
    morphHourglassPerturb: HTMLInputElement | null,
    wobbleAmp: HTMLInputElement | null,
    wobbleAxis: HTMLSelectElement | null,
    wobbleMotionMode: HTMLSelectElement | null,
    wobbleFreq: HTMLInputElement | null,
    wobbleBounce: HTMLInputElement | null,
    wobbleStretch: HTMLInputElement | null,
    wobbleAnchorLiftPct: HTMLInputElement | null,
    wobbleHaloEnabled: HTMLInputElement | null,
    wobbleHaloColor: HTMLInputElement | null,
    wobbleHaloWidth: HTMLInputElement | null,
    wobbleHaloSpeed: HTMLInputElement | null,
    wobbleHaloOpacity: HTMLInputElement | null
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
            ep.isLoop = morphLoop.checked;
        }
        if (morphFlightWindow) {
            const v = Number(morphFlightWindow.value);
            if (!Number.isNaN(v) && v >= 0.12 && v <= 1) {
                ep.progressivePairFlightWindow = v;
            }
        }
        if (morphFlightStagger) {
            const v = Number(morphFlightStagger.value);
            if (!Number.isNaN(v) && v >= 0 && v <= 1) {
                ep.progressivePairFlightStagger = v;
            }
        }
        if (morphFlightEase) {
            const v = morphFlightEase.value;
            if (isMorphFlightEase(v)) {
                ep.progressivePairFlightEase = v;
            }
        }
        if (morphFlightPosEase) {
            const v = morphFlightPosEase.value;
            if (v !== '' && isMorphFlightEase(v)) {
                ep.progressivePairFlightPosEase = v;
            }
        }
        if (morphChannelParticleScale) {
            const v = Number(morphChannelParticleScale.value);
            if (!Number.isNaN(v) && v >= 0.002 && v <= 0.02) {
                ep.morphHourglassParticleScaleFrac = v;
            }
        }
        if (morphChannelStrength) {
            const v = Number(morphChannelStrength.value);
            if (!Number.isNaN(v)) {
                ep.morphHourglassStrength = v;
            }
        }
        if (morphHourglassPerturb) {
            const v = Number(morphHourglassPerturb.value);
            if (!Number.isNaN(v) && v >= 0) {
                ep.morphHourglassSparkIntensity = v;
                ep.morphHourglassPerturbAmp = v * MORPH_HOURGLASS_PERTURB_AMP_RATIO;
                ep.morphHourglassSparkDrift = v * MORPH_HOURGLASS_SPARK_DRIFT_RATIO;
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
    if (wobbleAxis?.value === 'x' || wobbleAxis?.value === 'z') {
        ep.wobbleAxis = wobbleAxis.value;
    }
    if (
        wobbleMotionMode?.value === 'wobble' ||
        wobbleMotionMode?.value === 'electronic' ||
        wobbleMotionMode?.value === 'deepMeditation'
    ) {
        ep.motionMode = wobbleMotionMode.value;
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
    if (wobbleHaloWidth) {
        const v = Number(wobbleHaloWidth.value);
        if (!Number.isNaN(v)) ep.haloWidth = v;
    }
    if (wobbleHaloSpeed) {
        const v = Number(wobbleHaloSpeed.value);
        if (!Number.isNaN(v)) ep.haloSpeed = v;
    }
    if (wobbleHaloOpacity) {
        const v = Number(wobbleHaloOpacity.value);
        if (!Number.isNaN(v)) ep.haloOpacity = v;
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
    morphFlightWindow: HTMLInputElement | null,
    morphFlightStagger: HTMLInputElement | null,
    morphFlightEase: HTMLSelectElement | null,
    morphFlightPosEase: HTMLSelectElement | null,
    morphChannelParticleScale: HTMLInputElement | null,
    morphChannelStrength: HTMLInputElement | null,
    morphHourglassPerturb: HTMLInputElement | null,
    wobbleAmp: HTMLInputElement | null,
    wobbleAxis: HTMLSelectElement | null,
    wobbleMotionMode: HTMLSelectElement | null,
    wobbleFreq: HTMLInputElement | null,
    wobbleBounce: HTMLInputElement | null,
    wobbleStretch: HTMLInputElement | null,
    wobbleAnchorLiftPct: HTMLInputElement | null,
    wobbleHaloEnabled: HTMLInputElement | null,
    wobbleHaloColor: HTMLInputElement | null,
    wobbleHaloWidth: HTMLInputElement | null,
    wobbleHaloSpeed: HTMLInputElement | null,
    wobbleHaloOpacity: HTMLInputElement | null
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
        } else if (morphSeg) {
            morphSeg.value = String(DEFAULT_MORPH_SEGMENT_DURATION);
        }
        if (morphLoop) {
            morphLoop.checked =
                typeof ep?.isLoop === 'boolean' ? ep.isLoop :
                    typeof ep?.loop === 'boolean' ? ep.loop :
                        true;
        }
        if (morphFlightWindow) {
            morphFlightWindow.value = String(
                typeof ep?.progressivePairFlightWindow === 'number'
                    ? ep.progressivePairFlightWindow
                    : DEFAULT_MORPH_FLIGHT_WINDOW
            );
        }
        if (morphFlightStagger) {
            morphFlightStagger.value = String(
                typeof ep?.progressivePairFlightStagger === 'number'
                    ? ep.progressivePairFlightStagger
                    : DEFAULT_MORPH_FLIGHT_STAGGER
            );
        }
        if (morphFlightEase) {
            morphFlightEase.value =
                typeof ep?.progressivePairFlightEase === 'string' && isMorphFlightEase(ep.progressivePairFlightEase)
                    ? ep.progressivePairFlightEase
                    : DEFAULT_MORPH_FLIGHT_EASE;
        }
        if (morphFlightPosEase) {
            morphFlightPosEase.value =
                typeof ep?.progressivePairFlightPosEase === 'string' && isMorphFlightEase(ep.progressivePairFlightPosEase)
                    ? ep.progressivePairFlightPosEase
                    : '';
        }
        if (morphChannelParticleScale) {
            const scaleFrac = typeof ep?.morphHourglassParticleScaleFrac === 'number'
                ? ep.morphHourglassParticleScaleFrac
                : DEFAULT_MORPH_HOURGLASS_PARTICLE_SCALE_FRAC;
            morphChannelParticleScale.value = String(Math.min(0.02, Math.max(0.002, scaleFrac)));
        }
        if (morphChannelStrength) {
            const strength = typeof ep?.morphHourglassStrength === 'number'
                ? ep.morphHourglassStrength
                : typeof ep?.morphPointCloudStrength === 'number'
                    ? ep.morphPointCloudStrength
                    : 1;
            morphChannelStrength.value = String(strength);
        }
        if (morphHourglassPerturb) {
            morphHourglassPerturb.value = String(
                typeof ep?.morphHourglassSparkIntensity === 'number'
                    ? ep.morphHourglassSparkIntensity
                    : DEFAULT_MORPH_HOURGLASS_SPARK_INTENSITY
            );
        }
        return;
    }
    const merged = mergeWobbleEffectParams(ep);
    if (wobbleAxis) {
        wobbleAxis.value = merged.wobbleAxis === 'z' ? 'z' : 'x';
    }
    if (wobbleMotionMode) {
        wobbleMotionMode.value =
            merged.motionMode === 'electronic' || merged.motionMode === 'deepMeditation'
                ? (merged.motionMode as string)
                : 'wobble';
    }
    if (wobbleAmp) {
        wobbleAmp.value = String(typeof merged.amplitude === 'number' ? merged.amplitude : 0.7);
    }
    if (wobbleFreq) {
        wobbleFreq.value = String(typeof merged.frequency === 'number' ? merged.frequency : 5);
    }
    if (wobbleBounce) {
        wobbleBounce.value = String(typeof merged.bounceAmplitude === 'number' ? merged.bounceAmplitude : 0.6);
    }
    if (wobbleStretch) {
        wobbleStretch.value = String(typeof merged.bounceStretch === 'number' ? merged.bounceStretch : 0.75);
    }
    if (wobbleAnchorLiftPct) {
        const lift =
            typeof merged.wobbleAnchorLift === 'number'
                ? merged.wobbleAnchorLift
                : typeof merged.anchorLift === 'number'
                  ? merged.anchorLift
                  : 0.15;
        wobbleAnchorLiftPct.value = String(Math.round(Math.min(1, Math.max(0, lift)) * 100));
    }
    if (wobbleHaloEnabled) {
        const mix = merged.colorMix;
        wobbleHaloEnabled.checked = typeof mix !== 'number' || mix > 0;
    }
    if (wobbleHaloColor) {
        const gold = merged.goldColor;
        if (Array.isArray(gold) && gold.length === 3 && gold.every((n) => typeof n === 'number')) {
            wobbleHaloColor.value = rgb01ToHex(gold as [number, number, number]);
        } else {
            wobbleHaloColor.value = rgb01ToHex(DEFAULT_WOBBLE_HALO_RGB);
        }
    }
    if (wobbleHaloWidth) {
        wobbleHaloWidth.value = String(typeof merged.haloWidth === 'number' ? merged.haloWidth : 0.1);
    }
    if (wobbleHaloSpeed) {
        wobbleHaloSpeed.value = String(typeof merged.haloSpeed === 'number' ? merged.haloSpeed : 1);
    }
    if (wobbleHaloOpacity) {
        wobbleHaloOpacity.value = String(typeof merged.haloOpacity === 'number' ? merged.haloOpacity : 1);
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
    const morphFlightWindow = fieldset.querySelector('#assetMorphFlightWindow') as HTMLInputElement | null;
    const morphFlightStagger = fieldset.querySelector('#assetMorphFlightStagger') as HTMLInputElement | null;
    const morphFlightEase = fieldset.querySelector('#assetMorphFlightEase') as HTMLSelectElement | null;
    const morphFlightPosEase = fieldset.querySelector('#assetMorphFlightPosEase') as HTMLSelectElement | null;
    const morphFlightWindowVal = fieldset.querySelector('#assetMorphFlightWindowVal') as HTMLElement | null;
    const morphFlightStaggerVal = fieldset.querySelector('#assetMorphFlightStaggerVal') as HTMLElement | null;
    const morphChannelParticleScale = fieldset.querySelector('#assetMorphPointCloudPointSize') as HTMLInputElement | null;
    const morphChannelStrength = fieldset.querySelector('#assetMorphPointCloudStrength') as HTMLInputElement | null;
    const morphHourglassPerturb = fieldset.querySelector('#assetMorphHourglassPerturb') as HTMLInputElement | null;
    const morphChannelParticleScaleVal = fieldset.querySelector('#assetMorphPointCloudPointSizeVal') as HTMLElement | null;
    const morphChannelStrengthVal = fieldset.querySelector('#assetMorphPointCloudStrengthVal') as HTMLElement | null;
    const morphHourglassPerturbVal = fieldset.querySelector('#assetMorphHourglassPerturbVal') as HTMLElement | null;
    const wobbleAmp = fieldset.querySelector('#assetWobbleAmplitude') as HTMLInputElement | null;
    const wobbleFreq = fieldset.querySelector('#assetWobbleFrequency') as HTMLInputElement | null;
    const wobbleBounce = fieldset.querySelector('#assetWobbleBounceAmplitude') as HTMLInputElement | null;
    const wobbleStretch = fieldset.querySelector('#assetWobbleBounceStretch') as HTMLInputElement | null;
    const wobbleAnchorLiftPct = fieldset.querySelector('#assetWobbleAnchorLiftPct') as HTMLInputElement | null;
    const wobbleAxis = fieldset.querySelector('#assetWobbleAxis') as HTMLSelectElement | null;
    const wobbleAmpVal = fieldset.querySelector('#assetWobbleAmplitudeVal') as HTMLElement | null;
    const wobbleFreqVal = fieldset.querySelector('#assetWobbleFrequencyVal') as HTMLElement | null;
    const wobbleBounceVal = fieldset.querySelector('#assetWobbleBounceAmplitudeVal') as HTMLElement | null;
    const wobbleStretchVal = fieldset.querySelector('#assetWobbleBounceStretchVal') as HTMLElement | null;
    const wobbleAnchorLiftPctVal = fieldset.querySelector('#assetWobbleAnchorLiftPctVal') as HTMLElement | null;
    const wobbleMotionMode = fieldset.querySelector('#assetWobbleMotionMode') as HTMLSelectElement | null;
    const wobbleAmplitudeLabel = fieldset.querySelector('#assetWobbleAmplitudeLabel') as HTMLLabelElement | null;
    const wobbleHaloEnabled = fieldset.querySelector('#assetWobbleHaloEnabled') as HTMLInputElement | null;
    const wobbleHaloColor = fieldset.querySelector('#assetWobbleHaloColor') as HTMLInputElement | null;
    const wobbleHaloColorRow = fieldset.querySelector('#assetWobbleHaloColorRow') as HTMLElement | null;
    const wobbleHaloWidth = fieldset.querySelector('#assetWobbleHaloWidth') as HTMLInputElement | null;
    const wobbleHaloSpeed = fieldset.querySelector('#assetWobbleHaloSpeed') as HTMLInputElement | null;
    const wobbleHaloOpacity = fieldset.querySelector('#assetWobbleHaloOpacity') as HTMLInputElement | null;
    const wobbleHaloWidthVal = fieldset.querySelector('#assetWobbleHaloWidthVal') as HTMLElement | null;
    const wobbleHaloSpeedVal = fieldset.querySelector('#assetWobbleHaloSpeedVal') as HTMLElement | null;
    const wobbleHaloOpacityVal = fieldset.querySelector('#assetWobbleHaloOpacityVal') as HTMLElement | null;
    const wobbleHaloWidthRow = fieldset.querySelector('#assetWobbleHaloWidthRow') as HTMLElement | null;
    const wobbleHaloSpeedRow = fieldset.querySelector('#assetWobbleHaloSpeedRow') as HTMLElement | null;
    const wobbleAmplitudeRow = fieldset.querySelector('#assetWobbleAmplitudeRow') as HTMLElement | null;
    const wobbleHaloEnabledRow = fieldset.querySelector('#assetWobbleHaloEnabledRow') as HTMLElement | null;
    const wobbleAxisRow = fieldset.querySelector('#assetWobbleAxisRow') as HTMLElement | null;
    const wobbleFrequencyRow = fieldset.querySelector('#assetWobbleFrequencyRow') as HTMLElement | null;
    const wobbleAnchorLiftPctRow = fieldset.querySelector('#assetWobbleAnchorLiftPctRow') as HTMLElement | null;
    const wobbleBounceAmplitudeRow = fieldset.querySelector('#assetWobbleBounceAmplitudeRow') as HTMLElement | null;
    const wobbleBounceStretchRow = fieldset.querySelector('#assetWobbleBounceStretchRow') as HTMLElement | null;
    type WobbleMotionModeUi = 'wobble' | 'electronic' | 'deepMeditation';

    const WOBBLE_AMPLITUDE_HINT: Record<WobbleMotionModeUi, string> = {
        wobble: '扭动：幅度 × 1/3（同一滑条值下更柔和）',
        electronic: '摇头晃脑：幅度 ÷ 0.3 映射左右摆头与轻微前俯',
        deepMeditation: '瞌睡虫：幅度 ÷ 0.4 映射呼吸形变'
    };

    const resolveWobbleMotionModeUi = (): WobbleMotionModeUi => {
        const raw = wobbleMotionMode?.value;
        if (raw === 'electronic' || raw === 'deepMeditation') {
            return raw;
        }
        return 'wobble';
    };

    const setWobbleParamRowVisible = (row: HTMLElement | null, visible: boolean) => {
        row?.classList.toggle('hidden', !visible);
    };

    const syncWobbleModeUi = () => {
        const mode = resolveWobbleMotionModeUi();
        const hint = WOBBLE_AMPLITUDE_HINT[mode];
        if (wobbleAmplitudeLabel) {
            wobbleAmplitudeLabel.title = hint;
        }
        if (wobbleAmp) {
            wobbleAmp.title = hint;
        }
        const isWobble = mode === 'wobble';
        const isElectronic = mode === 'electronic';
        const isDeepMeditation = mode === 'deepMeditation';
        setWobbleParamRowVisible(wobbleAmplitudeRow, true);
        setWobbleParamRowVisible(wobbleHaloEnabledRow, true);
        setWobbleParamRowVisible(wobbleHaloColorRow, true);
        setWobbleParamRowVisible(wobbleHaloWidthRow, true);
        setWobbleParamRowVisible(wobbleHaloSpeedRow, true);
        setWobbleParamRowVisible(wobbleAxisRow, isWobble || isDeepMeditation);
        setWobbleParamRowVisible(wobbleFrequencyRow, isWobble || isElectronic);
        setWobbleParamRowVisible(wobbleAnchorLiftPctRow, isWobble || isElectronic);
        setWobbleParamRowVisible(wobbleBounceAmplitudeRow, isWobble);
        setWobbleParamRowVisible(wobbleBounceStretchRow, isWobble);
    };

    const syncWobbleHaloUi = () => {
        const on = wobbleHaloEnabled?.checked !== false;
        if (wobbleHaloColor) {
            wobbleHaloColor.disabled = !on;
        }
        if (wobbleHaloWidth) wobbleHaloWidth.disabled = !on;
        if (wobbleHaloSpeed) wobbleHaloSpeed.disabled = !on;
        if (wobbleHaloOpacity) wobbleHaloOpacity.disabled = !on;
        for (const row of [wobbleHaloColorRow, wobbleHaloWidthRow, wobbleHaloSpeedRow]) {
            if (row) row.style.opacity = on ? '1' : '0.45';
        }
    };
    const btnMorphAdd = fieldset.querySelector('#assetMorphAddFromSelection');
    const btnMorphRemoveLast = fieldset.querySelector('#assetMorphRemoveLast');
    const btnMorphMoveUp = fieldset.querySelector('#assetMorphMoveUp');
    const btnMorphMoveDown = fieldset.querySelector('#assetMorphMoveDown');
    const btnMorphClear = fieldset.querySelector('#assetMorphClearKeyframes');
    const btnStart = fieldset.querySelector('#assetEffectStart');
    const btnStop = fieldset.querySelector('#assetEffectStop');
    const btnDelete = fieldset.querySelector('#assetEffectDelete');
    const statusEl = fieldset.querySelector('#assetEffectStatus');
    const morphCorrespondenceStatusByTarget = new Map<string, string>();

    const { events } = global;

    const routeAssetCommand = (
        cmd: 'EFFECT_ADD' | 'EFFECT_START' | 'EFFECT_STOP' | 'EFFECT_PARAMS_PATCH' | 'EFFECT_DELETE',
        targetId: string,
        type: string,
        effectParams?: Record<string, unknown>
    ) => {
        const stopMessage = {
            type: 'EFFECT_PARAMS_PATCH',
            module: 'effects',
            effectId: ASSET_GSPLAT_EFFECT_ID,
            targetId,
            params: { [type]: { enabled: false } }
        };
        const stopPayload = {
            effectId: ASSET_GSPLAT_EFFECT_ID,
            targetId,
            params: { type, enabled: false }
        };
        const envelope = {
            effectId: ASSET_GSPLAT_EFFECT_ID,
            targetId,
            params: { type, effectParams }
        };
        const addPayload = {
            effectId: ASSET_GSPLAT_EFFECT_ID,
            effectType: type,
            targetId
        };
        const deletePayload = {
            effectId: ASSET_GSPLAT_EFFECT_ID,
            effectType: type,
            targetId
        };
        const message = cmd === 'EFFECT_ADD'
            ? { type: cmd, module: 'effects', ...addPayload }
            : cmd === 'EFFECT_DELETE'
                ? { type: cmd, module: 'effects', ...deletePayload }
                : cmd === 'EFFECT_STOP'
                    ? stopMessage
                    : { type: cmd, module: 'effects', ...envelope };
        const payload = cmd === 'EFFECT_ADD'
            ? addPayload
            : cmd === 'EFFECT_DELETE'
                ? deletePayload
                : cmd === 'EFFECT_STOP'
                    ? stopPayload
                    : envelope;
        const dispatchType = cmd === 'EFFECT_STOP' ? 'EFFECT_PARAMS_PATCH' : cmd;
        if (getEditUiTransport(global) === 'message-bridge') {
            sendEditProtocolMessage(message);
        } else if (
            !dispatchEffectsModuleCommand(global, {
                type: dispatchType,
                payload,
                source: 'host'
            })
        ) {
            console.warn('[asset-effects-ui] command dispatch failed', dispatchType);
        }
    };

    const pushHistorySafe = () => {
        if ((global.state as { editMode?: boolean }).editMode) {
            pushEditHistory(global, 'asset effect');
        }
    };

    const formatMorphCorrespondenceStatus = (payload: Record<string, unknown>) => {
        const strategy = payload.strategy === 'greedy' || payload.strategy === 'resample' ? payload.strategy : 'resample';
        const phase = typeof payload.phase === 'string' ? payload.phase : 'ready';
        if (phase === 'building') {
            const done = typeof payload.done === 'number' ? payload.done : 0;
            const total = typeof payload.total === 'number' ? payload.total : 0;
            return total > 0 ? `greedy 计算中 ${done}/${total}` : 'greedy 计算中';
        }
        if (phase === 'preview') {
            return 'resample 快速预览';
        }
        if (phase === 'failed') {
            return 'greedy 失败，保留 resample';
        }
        return strategy === 'greedy' ? '已切换 greedy' : 'resample';
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
            const configId = getMorphOwnerTargetId(global);
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
                        morphFlightWindow,
                        morphFlightStagger,
                        morphFlightEase,
                        morphFlightPosEase,
                        morphChannelParticleScale,
                        morphChannelStrength,
                        morphHourglassPerturb,
                        wobbleAmp,
                        wobbleAxis,
                        wobbleMotionMode,
                        wobbleFreq,
                        wobbleBounce,
                        wobbleStretch,
                        wobbleAnchorLiftPct,
                        wobbleHaloEnabled,
                        wobbleHaloColor,
                        wobbleHaloWidth,
                        wobbleHaloSpeed,
                        wobbleHaloOpacity
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
        } else if (t === WOBBLE_TYPE) {
            syncWobbleModeUi();
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
        const morphRoute = morphCorrespondenceStatusByTarget.get(targetId);
        statusEl.textContent = `状态: ${label} / ${st}${morphRoute ? ` / 匹配: ${morphRoute}` : ''}`;
    };

    const onMorphCorrespondenceStatus = (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            return;
        }
        const record = payload as Record<string, unknown>;
        const targetId = typeof record.targetId === 'string' ? record.targetId : '';
        if (!targetId) {
            return;
        }
        morphCorrespondenceStatusByTarget.set(targetId, formatMorphCorrespondenceStatus(record));
        refreshStatus();
    };

    const onAssetEffectStopped = (payload: unknown) => {
        if (payload && typeof payload === 'object') {
            const targetId = (payload as Record<string, unknown>).targetId;
            if (typeof targetId === 'string') {
                morphCorrespondenceStatusByTarget.delete(targetId);
            }
        }
        refreshStatus();
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
                morphFlightWindow,
                morphFlightStagger,
                morphFlightEase,
                morphFlightPosEase,
                morphChannelParticleScale,
                morphChannelStrength,
                morphHourglassPerturb,
                wobbleAmp,
                wobbleAxis,
                wobbleMotionMode,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor,
                wobbleHaloWidth,
                wobbleHaloSpeed,
                wobbleHaloOpacity
            );
            syncWobbleModeUi();
            syncWobbleHaloUi();
            syncMorphSliderLabels();
            syncWobbleSliderLabels();
            renderMorphKeyframeList();
        }
        syncTypePanels();
        refreshStatus();
    };

    const onTypeChange = () => {
        syncTypePanels();
        syncWobbleModeUi();
        const targetId = getSelectedTargetId(global);
        if (!targetId || !typeSelect) {
            return;
        }
        patchEffectParams(true);
        refreshStatus();
    };

    const patchEffectParams = (commitHistory: boolean) => {
        const targetId = typeSelect?.value === MORPH_TYPE ? getMorphOwnerTargetId(global) : getSelectedTargetId(global);
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
                morphFlightWindow,
                morphFlightStagger,
                morphFlightEase,
                morphFlightPosEase,
                morphChannelParticleScale,
                morphChannelStrength,
                morphHourglassPerturb,
                wobbleAmp,
                wobbleAxis,
                wobbleMotionMode,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor,
                wobbleHaloWidth,
                wobbleHaloSpeed,
                wobbleHaloOpacity
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

    const syncMorphSliderLabels = () => {
        if (morphFlightWindow && morphFlightWindowVal) {
            morphFlightWindowVal.textContent = formatSliderValue(Number(morphFlightWindow.value), 2);
        }
        if (morphFlightStagger && morphFlightStaggerVal) {
            morphFlightStaggerVal.textContent = formatSliderValue(Number(morphFlightStagger.value), 2);
        }
        if (morphChannelParticleScale && morphChannelParticleScaleVal) {
            const pct = Math.round(Number(morphChannelParticleScale.value) * 10000) / 100;
            morphChannelParticleScaleVal.textContent = `${pct}%`;
        }
        if (morphChannelStrength && morphChannelStrengthVal) {
            morphChannelStrengthVal.textContent = formatSliderValue(Number(morphChannelStrength.value), 2);
        }
        if (morphHourglassPerturb && morphHourglassPerturbVal) {
            const pct = Math.round(Number(morphHourglassPerturb.value) * 1000) / 10;
            morphHourglassPerturbVal.textContent = `${pct}%`;
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
        if (wobbleHaloWidth && wobbleHaloWidthVal) {
            wobbleHaloWidthVal.textContent = formatSliderValue(Number(wobbleHaloWidth.value), 2);
        }
        if (wobbleHaloSpeed && wobbleHaloSpeedVal) {
            wobbleHaloSpeedVal.textContent = formatSliderValue(Number(wobbleHaloSpeed.value), 2);
        }
        if (wobbleHaloOpacity && wobbleHaloOpacityVal) {
            wobbleHaloOpacityVal.textContent = formatSliderValue(Number(wobbleHaloOpacity.value), 2);
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
        const configId = getMorphOwnerTargetId(global);
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
                morphFlightWindow,
                morphFlightStagger,
                morphFlightEase,
                morphFlightPosEase,
                morphChannelParticleScale,
                morphChannelStrength,
                morphHourglassPerturb,
                wobbleAmp,
                wobbleAxis,
                wobbleMotionMode,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor,
                wobbleHaloWidth,
                wobbleHaloSpeed,
                wobbleHaloOpacity
            )
        );
    };

    const onStart = () => {
        const selectedTargetId = getSelectedTargetId(global);
        const targetId = typeSelect?.value === MORPH_TYPE ? getMorphOwnerTargetId(global) : selectedTargetId;
        if (!targetId || !typeSelect) {
            window.alert('请先在上方场景资产列表中选中一个资产');
            return;
        }
        if (typeSelect.value === WOBBLE_TYPE) {
            const item = getScenePlacedItemByTargetId(global, selectedTargetId ?? targetId);
            if (!item || item.assetType !== 'gaussian' || !item.entity?.gsplat) {
                window.alert('静物活化需要已放置的 Gaussian（gsplat）资产');
                return;
            }
        }
        if (typeSelect.value === MORPH_TYPE) {
            const effectParams = readEffectParamsFromDom(
                global,
                typeSelect.value,
                morphUrls,
                morphSeg,
                morphLoop,
                morphFlightWindow,
                morphFlightStagger,
                morphFlightEase,
                morphFlightPosEase,
                morphChannelParticleScale,
                morphChannelStrength,
                morphHourglassPerturb,
                wobbleAmp,
                wobbleAxis,
                wobbleMotionMode,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor,
                wobbleHaloWidth,
                wobbleHaloSpeed,
                wobbleHaloOpacity
            );
            const ep = effectParams;
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
            routeAssetCommand('EFFECT_PARAMS_PATCH', targetId, typeSelect.value, effectParams);
        }
        routeAssetCommand('EFFECT_ADD', targetId, typeSelect.value);
        refreshStatus();
    };

    const onStop = () => {
        const targetId = typeSelect?.value === MORPH_TYPE ? getMorphOwnerTargetId(global) : getSelectedTargetId(global);
        if (!targetId || !typeSelect) {
            return;
        }
        routeAssetCommand('EFFECT_STOP', targetId, typeSelect.value);
        refreshStatus();
    };

    const onDelete = () => {
        const targetId = typeSelect?.value === MORPH_TYPE ? getMorphOwnerTargetId(global) : getSelectedTargetId(global);
        if (!targetId || !typeSelect) {
            return;
        }
        routeAssetCommand('EFFECT_DELETE', targetId, typeSelect.value);
        pushHistorySafe();
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
    morphFlightEase?.addEventListener('change', onParamsBlur);
    morphFlightPosEase?.addEventListener('change', onParamsBlur);
    const unbindMorphSliders: Array<() => void> = [];
    if (morphFlightWindow) {
        unbindMorphSliders.push(bindSliderLive(morphFlightWindow, morphFlightWindowVal, 2, onMorphParamsLive, onParamsBlur));
    }
    if (morphFlightStagger) {
        unbindMorphSliders.push(bindSliderLive(morphFlightStagger, morphFlightStaggerVal, 2, onMorphParamsLive, onParamsBlur));
    }
    if (morphChannelParticleScale) {
        const onChannelScaleInput = () => {
            if (morphChannelParticleScaleVal) {
                const pct = Math.round(Number(morphChannelParticleScale.value) * 10000) / 100;
                morphChannelParticleScaleVal.textContent = `${pct}%`;
            }
            onMorphParamsLive();
        };
        morphChannelParticleScale.addEventListener('input', onChannelScaleInput);
        morphChannelParticleScale.addEventListener('change', onParamsBlur);
        unbindMorphSliders.push(() => {
            morphChannelParticleScale.removeEventListener('input', onChannelScaleInput);
            morphChannelParticleScale.removeEventListener('change', onParamsBlur);
        });
    }
    if (morphChannelStrength) {
        unbindMorphSliders.push(bindSliderLive(morphChannelStrength, morphChannelStrengthVal, 2, onMorphParamsLive, onParamsBlur));
    }
    if (morphHourglassPerturb) {
        const syncPerturbLabel = () => {
            if (morphHourglassPerturbVal) {
                const pct = Math.round(Number(morphHourglassPerturb.value) * 1000) / 10;
                morphHourglassPerturbVal.textContent = `${pct}%`;
            }
        };
        const onPerturbInput = () => {
            syncPerturbLabel();
            onMorphParamsLive();
        };
        const onPerturbChange = () => {
            syncPerturbLabel();
            onParamsBlur();
        };
        morphHourglassPerturb.addEventListener('input', onPerturbInput);
        morphHourglassPerturb.addEventListener('change', onPerturbChange);
        syncPerturbLabel();
        unbindMorphSliders.push(() => {
            morphHourglassPerturb.removeEventListener('input', onPerturbInput);
            morphHourglassPerturb.removeEventListener('change', onPerturbChange);
        });
    }
    const unbindWobbleSliders: Array<() => void> = [];
    if (wobbleAmp) {
        unbindWobbleSliders.push(bindSliderLive(wobbleAmp, wobbleAmpVal, 2, onWobbleParamsLive, onParamsBlur));
    }
    wobbleAxis?.addEventListener('change', onParamsBlur);
    wobbleMotionMode?.addEventListener('change', () => {
        if (wobbleMotionMode?.value === 'deepMeditation') {
            fillDomFromEffectParams(
                global,
                WOBBLE_TYPE,
                getDefaultWobbleEffectParams('deepMeditation'),
                morphUrls,
                morphSeg,
                morphLoop,
                morphFlightWindow,
                morphFlightStagger,
                morphFlightEase,
                morphFlightPosEase,
                morphChannelParticleScale,
                morphChannelStrength,
                morphHourglassPerturb,
                wobbleAmp,
                wobbleAxis,
                wobbleMotionMode,
                wobbleFreq,
                wobbleBounce,
                wobbleStretch,
                wobbleAnchorLiftPct,
                wobbleHaloEnabled,
                wobbleHaloColor,
                wobbleHaloWidth,
                wobbleHaloSpeed,
                wobbleHaloOpacity
            );
            syncWobbleSliderLabels();
            syncWobbleHaloUi();
        }
        syncWobbleModeUi();
        onParamsBlur();
    });
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
    if (wobbleHaloWidth) {
        unbindWobbleSliders.push(bindSliderLive(wobbleHaloWidth, wobbleHaloWidthVal, 2, onWobbleParamsLive, onParamsBlur));
    }
    if (wobbleHaloSpeed) {
        unbindWobbleSliders.push(bindSliderLive(wobbleHaloSpeed, wobbleHaloSpeedVal, 2, onWobbleParamsLive, onParamsBlur));
    }
    if (wobbleHaloOpacity) {
        unbindWobbleSliders.push(bindSliderLive(wobbleHaloOpacity, wobbleHaloOpacityVal, 2, onWobbleParamsLive, onParamsBlur));
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
    btnDelete?.addEventListener('click', onDelete);

    const onSelectionChanged = () => {
        refreshTargetLabel();
        refreshStatus();
    };
    events.on('sceneAsset:selected', onSelectionChanged);
    events.on('assetEffect:started', refreshStatus);
    events.on('assetEffect:stopped', onAssetEffectStopped);
    events.on('assetEffect:error', refreshStatus);
    events.on('assetEffect:configChanged', refreshStatus);
    events.on('assetEffect:morphKeyframesChanged', onMorphKeyframesChanged);
    events.on('assetEffect:morphCorrespondenceStatus', onMorphCorrespondenceStatus);

    syncWobbleModeUi();
    syncWobbleHaloUi();
    syncMorphSliderLabels();
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
        morphFlightEase?.removeEventListener('change', onParamsBlur);
        morphFlightPosEase?.removeEventListener('change', onParamsBlur);
        unbindMorphSliders.forEach((fn) => fn());
        unbindWobbleSliders.forEach((fn) => fn());
        wobbleAxis?.removeEventListener('change', onParamsBlur);
        wobbleMotionMode?.removeEventListener('change', onParamsBlur);
        wobbleHaloEnabled?.removeEventListener('change', onHaloEnabledChange);
        wobbleHaloColor?.removeEventListener('input', onHaloColorLive);
        wobbleHaloColor?.removeEventListener('change', onParamsBlur);
        btnStart?.removeEventListener('click', onStart);
        btnStop?.removeEventListener('click', onStop);
        btnDelete?.removeEventListener('click', onDelete);
        events.off('sceneAsset:selected', onSelectionChanged);
        events.off('assetEffect:started', refreshStatus);
        events.off('assetEffect:stopped', onAssetEffectStopped);
        events.off('assetEffect:error', refreshStatus);
        events.off('assetEffect:configChanged', refreshStatus);
        events.off('assetEffect:morphKeyframesChanged', onMorphKeyframesChanged);
        events.off('assetEffect:morphCorrespondenceStatus', onMorphCorrespondenceStatus);
        global.state.assetEffectUiSubtype = null;
        global.state.assetEffectsMorphKeyframeIds = [];
    };
}
