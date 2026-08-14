/**
 * View 模式 Scene Content 显隐调试面板（Phase 0.5）。
 * 走与父级相同的入站协议，便于对照回包契约与画面。
 */
import { applyLightToggle, applyLightToggleAll } from '../../editor-modules/protocol-adapters/environment-protocol-adapter';
import { applyViewerLightToggle, applyViewerLightToggleAll } from '../../scene-visibility/lighting-visibility-facade';
import {
    canToggleLightingShadowSession,
    setLightingSessionAspectVisible
} from '../../scene-visibility/lighting-session-visibility';
import { getSceneContentVisibilityRegistry } from '../../scene-visibility/registry';
import type { VisibilityDebugSnapshot } from '../../scene-visibility/visibility-debug-snapshot';
import {
    SCENE_CONTENT_CATEGORY_IDS,
    type SceneContentCategoryId
} from '../../scene-visibility/types';
import type { Global } from '../../types';
import {
    readContentCategoryVisible,
    readLightingVisibility,
    readSessionLightVisible,
    type LightingVisibilityKey
} from '../../view-settings';
import { getEditUiTransport, sendEditProtocolMessage } from '../edit-ui-transport';

const PANEL_ID = 'viewSceneContentDebugPanel';

const CATEGORY_LABELS: Record<SceneContentCategoryId, string> = {
    assets: '资产',
    annotations: '标注',
    lights: '光源',
    reveal: 'Reveal',
    persistent: 'Persistent',
    stylization: '风格化'
};

const LIGHTING_LABELS: Record<LightingVisibilityKey, string> = {
    brightness: '亮度',
    bloom: '辉光',
    shadow: '阴影'
};

type UserLightRow = { id: string; type: string; enabled: boolean; sessionVisible: boolean };

const isUserLight = (light: { id?: string; type?: string } | null | undefined): light is { id: string; type?: string } => {
    if (!light || typeof light.id !== 'string' || !light.id) {
        return false;
    }
    return light.type === 'point' || light.type === 'spot' || light.type === undefined;
};

const listUserLights = (global: Global): UserLightRow[] => {
    const lighting = (global.settings as { lighting?: { lights?: Array<{ id?: string; type?: string; enabled?: boolean }> } } | undefined)?.lighting;
    const lights = lighting?.lights;
    if (!Array.isArray(lights)) {
        return [];
    }
    const out: UserLightRow[] = [];
    for (const light of lights) {
        if (!isUserLight(light)) {
            continue;
        }
        out.push({
            id: light.id,
            type: light.type === 'spot' ? 'spot' : 'point',
            enabled: light.enabled !== false,
            sessionVisible: readSessionLightVisible(global, light.id)
        });
    }
    return out;
};

const sendOrApply = (global: Global, message: { type: string; [k: string]: unknown }): void => {
    const transport = getEditUiTransport(global);
    if (transport === 'message-bridge') {
        sendEditProtocolMessage(message);
        return;
    }
    const registry = getSceneContentVisibilityRegistry(global);
    switch (message.type) {
        case 'SCENE_CONTENT_CATEGORY_SET':
            if (typeof message.category === 'string' && typeof message.value === 'boolean') {
                registry?.setCategoryVisible(message.category as SceneContentCategoryId, message.value);
            }
            break;
        case 'SCENE_CONTENT_ALL_SET':
            if (typeof message.value === 'boolean') {
                registry?.setAllCategoriesVisible(message.value);
            }
            break;
        case 'LIGHTING_BRIGHTNESS_SHOW_HIDE_SET':
            if (typeof message.value === 'boolean') {
                setLightingSessionAspectVisible(global, 'brightness', message.value);
            }
            break;
        case 'LIGHTING_BLOOM_SHOW_HIDE_SET':
            if (typeof message.value === 'boolean') {
                setLightingSessionAspectVisible(global, 'bloom', message.value);
            }
            break;
        case 'LIGHTING_SHADOW_SHOW_HIDE_SET':
            if (typeof message.value === 'boolean') {
                setLightingSessionAspectVisible(global, 'shadow', message.value);
            }
            break;
        case 'LIGHT_TOGGLE':
            if (typeof message.id === 'string' && typeof message.value === 'boolean') {
                if (global.state?.editMode === true) {
                    applyLightToggle(global, message.id, message.value);
                } else {
                    applyViewerLightToggle(global, message.id, message.value);
                }
            }
            break;
        case 'LIGHT_TOGGLE_ALL':
            if (typeof message.value === 'boolean') {
                if (global.state?.editMode === true) {
                    applyLightToggleAll(global, message.value);
                } else {
                    applyViewerLightToggleAll(global, message.value);
                }
            }
            break;
        default:
            break;
    }
};

const makeCheck = (
    id: string,
    label: string,
    checked: boolean,
    disabled = false,
    extraClass = ''
): HTMLLabelElement => {
    const wrap = document.createElement('label');
    wrap.className = extraClass ? `sc-debug-check ${extraClass}` : 'sc-debug-check';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.id = id;
    input.checked = checked;
    input.disabled = disabled;
    const text = document.createElement('span');
    text.textContent = label;
    wrap.appendChild(input);
    wrap.appendChild(text);
    return wrap;
};

const yn = (on: boolean): string => (on ? '开' : '关');

/** 画面是否亮：gate × 配置 enabled × 会话 overlay（大类只提供缺省，不覆盖） */
const lightOnScreen = (
    light: UserLightRow,
    gateOn: boolean,
    snap: VisibilityDebugSnapshot | undefined
): boolean => {
    if (!gateOn || !light.enabled || !light.sessionVisible) {
        return false;
    }
    const rootOn = light.type === 'spot' ? snap?.actual.spotRootEnabled : snap?.actual.pointRootEnabled;
    if (rootOn === false) {
        return false;
    }
    const componentOn = snap?.actual.lightComponents[light.id];
    return componentOn !== false;
};

const makeBtn = (label: string, onClick: () => void): HTMLButtonElement => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'sc-debug-btn';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
};

/**
 * 挂载 View 模式 Scene Content 调试面板。
 *
 * @param {Global} global - Viewer 全局对象
 * @returns {void}
 */
export function initViewSceneContentDebugUI(global: Global): void {
    const toggleBtn = document.getElementById('viewSceneContentDebugBtn') as HTMLButtonElement | null;
    if (!toggleBtn) {
        return;
    }

    let panel = document.getElementById(PANEL_ID) as HTMLDivElement | null;
    if (!panel) {
        panel = document.createElement('div');
        panel.id = PANEL_ID;
        panel.className = 'sc-debug-panel hidden';
        const ui = document.getElementById('ui');
        (ui ?? document.body).appendChild(panel);
    }

    const setOpen = (open: boolean) => {
        panel.classList.toggle('hidden', !open);
        toggleBtn.classList.toggle('active', open);
        toggleBtn.setAttribute('aria-pressed', open ? 'true' : 'false');
    };

    const syncChrome = () => {
        const inView = global.state.editMode !== true;
        toggleBtn.classList.toggle('hidden', !inView);
        if (!inView) {
            setOpen(false);
        }
    };

    const applyMsg = (message: { type: string; [k: string]: unknown }): void => {
        sendOrApply(global, message);
        requestAnimationFrame(() => {
            if (!panel.classList.contains('hidden')) {
                render();
            }
        });
    };

    const render = () => {
        const registry = getSceneContentVisibilityRegistry(global);
        const snap = registry?.getDebugSnapshot('sc-debug-panel');
        const shadowOk = canToggleLightingShadowSession(global);
        const lights = listUserLights(global);
        const lightsCategoryOn = readContentCategoryVisible(global, 'lights');
        const gateOn = snap?.runtimeGateOpen !== false;

        panel.replaceChildren();

        const title = document.createElement('div');
        title.className = 'sc-debug-title';
        title.textContent = 'Scene Content 调试';
        panel.appendChild(title);

        const allRow = document.createElement('div');
        allRow.className = 'sc-debug-row';
        allRow.appendChild(makeBtn('全部显示', () => {
            applyMsg({ type: 'SCENE_CONTENT_ALL_SET', value: true });
        }));
        allRow.appendChild(makeBtn('全部隐藏', () => {
            applyMsg({ type: 'SCENE_CONTENT_ALL_SET', value: false });
        }));
        panel.appendChild(allRow);

        const catLabel = document.createElement('div');
        catLabel.className = 'sc-debug-section';
        catLabel.textContent = '大类 SCENE_CONTENT_CATEGORY_SET';
        panel.appendChild(catLabel);

        for (const id of SCENE_CONTENT_CATEGORY_IDS) {
            const checked = readContentCategoryVisible(global, id);
            const row = makeCheck(`sc-debug-cat-${id}`, `${CATEGORY_LABELS[id]} (${id})`, checked);
            const input = row.querySelector('input');
            input?.addEventListener('change', () => {
                applyMsg({
                    type: 'SCENE_CONTENT_CATEGORY_SET',
                    category: id,
                    value: input.checked
                });
            });
            panel.appendChild(row);
        }

        const lightLabel = document.createElement('div');
        lightLabel.className = 'sc-debug-section';
        lightLabel.textContent = '光照子项 LIGHTING_*_SHOW_HIDE_SET';
        panel.appendChild(lightLabel);

        for (const key of ['brightness', 'bloom', 'shadow'] as const) {
            const disabled = key === 'shadow' && !shadowOk;
            const row = makeCheck(
                `sc-debug-lit-${key}`,
                `${LIGHTING_LABELS[key]} (${key})${disabled ? ' · 无 sceneMesh' : ''}`,
                readLightingVisibility(global, key),
                disabled
            );
            const input = row.querySelector('input');
            input?.addEventListener('change', () => {
                const type =
                    key === 'brightness' ? 'LIGHTING_BRIGHTNESS_SHOW_HIDE_SET' :
                        key === 'bloom' ? 'LIGHTING_BLOOM_SHOW_HIDE_SET' :
                            'LIGHTING_SHADOW_SHOW_HIDE_SET';
                applyMsg({ type, value: input.checked });
            });
            panel.appendChild(row);
        }

        const toggleAllLabel = document.createElement('div');
        toggleAllLabel.className = 'sc-debug-section';
        toggleAllLabel.textContent = 'LIGHT_TOGGLE / LIGHT_TOGGLE_ALL';
        panel.appendChild(toggleAllLabel);

        const lightMeta = document.createElement('div');
        lightMeta.className = 'sc-debug-meta';
        lightMeta.textContent =
            `画面根 point=${yn(snap?.actual.pointRootEnabled === true)}  spot=${yn(snap?.actual.spotRootEnabled === true)}` +
            ` · 大类=${yn(lightsCategoryOn)} · gate=${yn(gateOn)}`;
        panel.appendChild(lightMeta);
        const lightHint = document.createElement('div');
        lightHint.className = 'sc-debug-hint';
        lightHint.textContent = '勾选是 settings.enabled（配置），全部隐藏不会改它；画面看右侧「画面」列。';
        panel.appendChild(lightHint);

        const toggleAllRow = document.createElement('div');
        toggleAllRow.className = 'sc-debug-row';
        toggleAllRow.appendChild(makeBtn('全部开灯', () => {
            applyMsg({ type: 'LIGHT_TOGGLE_ALL', value: true });
        }));
        toggleAllRow.appendChild(makeBtn('全部关灯', () => {
            applyMsg({ type: 'LIGHT_TOGGLE_ALL', value: false });
        }));
        panel.appendChild(toggleAllRow);

        if (lights.length === 0) {
            const empty = document.createElement('div');
            empty.className = 'sc-debug-empty';
            empty.textContent = '无用户点光/聚光';
            panel.appendChild(empty);
        } else {
            for (const light of lights) {
                const onScreen = snap ?
                    snap.projection.lights[light.id] === true :
                    lightOnScreen(light, gateOn, snap);
                const row = makeCheck(
                    `sc-debug-light-${light.id}`,
                    `${light.id} (${light.type})  配置${yn(light.enabled)} · 会话${yn(light.sessionVisible)} · 画面${yn(onScreen)}`,
                    light.sessionVisible,
                    false,
                    onScreen ? '' : 'is-screen-off'
                );
                const input = row.querySelector('input');
                input?.addEventListener('change', () => {
                    applyMsg({
                        type: 'LIGHT_TOGGLE',
                        id: light.id,
                        value: input.checked
                    });
                });
                panel.appendChild(row);
            }
        }

        const cascadeLabel = document.createElement('div');
        cascadeLabel.className = 'sc-debug-section';
        cascadeLabel.textContent = '父级级联序列';
        panel.appendChild(cascadeLabel);
        const cascadeRow = document.createElement('div');
        cascadeRow.className = 'sc-debug-row';
        cascadeRow.appendChild(makeBtn('先逐灯关再关大类', () => {
            for (const light of listUserLights(global)) {
                applyMsg({ type: 'LIGHT_TOGGLE', id: light.id, value: false });
            }
            applyMsg({ type: 'SCENE_CONTENT_CATEGORY_SET', category: 'lights', value: false });
        }));
        cascadeRow.appendChild(makeBtn('再开大类', () => {
            applyMsg({ type: 'SCENE_CONTENT_CATEGORY_SET', category: 'lights', value: true });
        }));
        panel.appendChild(cascadeRow);

        const snapLabel = document.createElement('div');
        snapLabel.className = 'sc-debug-section';
        snapLabel.textContent = 'Debug Snapshot（只读）';
        panel.appendChild(snapLabel);
        const pre = document.createElement('pre');
        pre.className = 'sc-debug-snap';
        pre.textContent = snap ? JSON.stringify({
            revision: snap.revision,
            mode: snap.mode,
            runtimeGateOpen: snap.runtimeGateOpen,
            intents: snap.intents,
            configuredLightEnabled: snap.configuredLightEnabled,
            sessionLightVisible: snap.sessionLightVisible,
            effective: snap.effective,
            projection: snap.projection,
            actual: snap.actual,
            capability: snap.capability
        }, null, 2) : 'registry 未初始化';
        panel.appendChild(pre);
    };

    toggleBtn.addEventListener('click', () => {
        if (global.state.editMode === true) {
            return;
        }
        setOpen(panel.classList.contains('hidden'));
        if (!panel.classList.contains('hidden')) {
            render();
        }
    });

    const refreshIfOpen = () => {
        syncChrome();
        if (!panel.classList.contains('hidden')) {
            render();
        }
    };

    global.events.on('editMode:changed', refreshIfOpen);
    global.events.on('previewMode:changed', refreshIfOpen);
    global.events.on('sceneContentVisibility:changed', refreshIfOpen);
    global.events.on('sceneContentVisibility:allChanged', refreshIfOpen);
    global.events.on('lightingSessionVisibility:changed', refreshIfOpen);
    global.events.on('lighting:changed', refreshIfOpen);
    global.events.on('postEffect:changed', refreshIfOpen);

    syncChrome();
}
